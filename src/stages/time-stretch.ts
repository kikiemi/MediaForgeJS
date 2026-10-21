import { MediaForgeError } from '../core/errors/errors';
import { RealFft } from '../codecs/shared/real-fft';
import type { AudioPlanes, AudioStage, EmitAudio } from '../core/contracts/stage';

/**
 * Pitch-preserving time stretching: a phase vocoder with identity phase locking (each spectral peak
 * advances by its own frequency and the bins around it keep their phase offset to it, which keeps
 * partials coherent) and attack preservation. Attacks are found in the input ahead of the frames;
 * the frames that read the input before an attack stop short of it, and the frames whose output
 * windows hold its mapped time read the input one to one around it from a phase reset, so their
 * overlap rebuilds the attack at its time as it was. The frames after it catch up with the time map
 * a share of the drift at a time.
 */

/**
 * Input frames per energy block of attack detection; a window of two blocks is compared with the 32
 * before it.
 */
const ATTACK_BLOCK = 16;
const ATTACK_HISTORY = 32;

/**
 * How much more energy than the blocks before it a window holds at an attack, and its least energy
 * per sample.
 */
const ATTACK_RISE = 4;
const ATTACK_FLOOR = 1e-6;

/**
 * Share of the time-map error a frame's hop corrects, and the most it changes the hop by, relative
 * to it.
 */
const CATCH_UP = 0.25;
const MAX_CORRECTION = 0.5;

function principal(angle: number): number {
    return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}

/**
 * The analysis and synthesis window for a rate: about 40 ms, a power of two from 512 to 4096
 * samples.
 */
function stretchWindow(sampleRate: number): number {
    let size = 512;
    while (size < 4096 && size < sampleRate * 0.04) size <<= 1;
    return size;
}

/** The vocoder state of one channel. */
interface ChannelState {
    /** Input samples from absolute frame `inputStart`. */
    input: Float32Array;
    /** Overlap-added output from absolute frame `outputStart`. */
    output: Float64Array;
    readonly previousPhase: Float64Array;
    readonly synthesisPhase: Float64Array;
    /**
     * Phase advance per output sample of each bin at the last frame, for frames that do not move in
     * the input.
     */
    readonly frequency: Float64Array;
    readonly magnitude: Float64Array;
    readonly phase: Float64Array;
}

/**
 * A stage that plays sound `speed` times as fast at the same pitch: 0.5 doubles the length, 2
 * halves it. The output holds exactly round(input frames / speed) frames, so it stays in step with
 * pictures retimed by the same speed. Work: two FFTs of the window per channel and synthesis hop (a
 * quarter window at speeds up to 2); memory: a few windows per channel, and the input up to max(1,
 * speed) windows ahead.
 */
export function timeStretchStage(speed: number): AudioStage {
    if (!Number.isFinite(speed) || speed < 0.05 || speed > 20)
        throw new MediaForgeError('Time stretching takes a speed from 0.05 to 20', 'INPUT');
    let size = 0;
    let half = 0;
    let synthesisHop = 0;
    let analysisHop = 0;
    /** Input frames past a frame's planned centre that must be read before it is made. */
    let lookahead = 0;
    let fft: RealFft | undefined;
    let window = new Float64Array(0);
    let channels: ChannelState[] = [];
    let normal = new Float64Array(0);
    let inputStart = 0;
    let received = 0;
    let outputStart = 0;
    let emitted = 0;
    /**
     * The next frame: its output centre is frame × synthesisHop and its input centre
     * round(position).
     */
    let frame = 0;
    let firstFrame = 0;
    let position = 0;
    let previousCentre = 0;
    /** The attack whose frames are being read one to one, or NaN. */
    let anchor = Number.NaN;
    /** Attacks found, in input frames; those from `attackHead` on are not yet reached. */
    let attacks: number[] = [];
    let attackHead = 0;
    /**
     * Energy of the recent blocks, a ring of ATTACK_HISTORY + 2, and the first block not yet
     * measured.
     */
    let blockEnergy = new Float64Array(0);
    let measured = 0;
    let lastAttack = Number.NEGATIVE_INFINITY;
    let frameBuffer = new Float64Array(0);
    let spectrumRe = new Float64Array(0);
    let spectrumIm = new Float64Array(0);
    let peaks = new Int32Array(0);

    const ensureInput = (state: ChannelState, length: number): void => {
        if (state.input.length >= length) return;
        const grown = new Float32Array(Math.max(length, state.input.length * 2));
        grown.set(state.input.subarray(0, received - inputStart));
        state.input = grown;
    };
    const ensureOutput = (end: number): void => {
        const need = end - outputStart;
        if (normal.length >= need) return;
        const capacity = Math.max(need, normal.length * 2);
        const grownNormal = new Float64Array(capacity);
        grownNormal.set(normal);
        normal = grownNormal;
        for (const state of channels) {
            const grown = new Float64Array(capacity);
            grown.set(state.output);
            state.output = grown;
        }
    };

    /**
     * Measures the input blocks received so far: a window of two blocks with ATTACK_RISE times the
     * mean energy of the blocks before it starts an attack, at most one per window length.
     */
    const detect = (): void => {
        const ring = blockEnergy.length;
        for (; (measured + 1) * ATTACK_BLOCK <= received; measured++) {
            let energy = 0;
            const from = measured * ATTACK_BLOCK - inputStart;
            for (const state of channels)
                for (let i = from; i < from + ATTACK_BLOCK; i++)
                    energy += state.input[i]! * state.input[i]!;
            blockEnergy[measured % ring] = energy;
            if (measured < ATTACK_HISTORY + 1) continue;
            let before = 0;
            for (let back = 2; back < ATTACK_HISTORY + 2; back++)
                before += blockEnergy[(measured - back) % ring]!;
            const start = (measured - 1) * ATTACK_BLOCK;
            const current = blockEnergy[(measured - 1) % ring]! + energy;
            const floor = ATTACK_FLOOR * 2 * ATTACK_BLOCK * channels.length;
            if (
                current > floor &&
                current > (ATTACK_RISE * 2 * before) / ATTACK_HISTORY &&
                start - lastAttack >= size
            ) {
                attacks.push(start);
                lastAttack = start;
            }
        }
    };

    /** The magnitudes and phases of every channel's window at `centre`. */
    const analyse = (centre: number): void => {
        const start = centre - half;
        for (const state of channels) {
            for (let i = 0; i < size; i++) {
                const at = start + i;
                frameBuffer[i] =
                    at >= inputStart && at < received
                        ? state.input[at - inputStart]! * window[i]!
                        : 0;
            }
            fft!.forward(frameBuffer, spectrumRe, spectrumIm);
            for (let k = 0; k <= half; k++) {
                const re = spectrumRe[k]!;
                const im = spectrumIm[k]!;
                state.magnitude[k] = Math.hypot(re, im);
                state.phase[k] = Math.atan2(im, re);
            }
        }
    };

    /** The synthesis phases of a channel's frame read `hop` input frames after the last. */
    const advance = (state: ChannelState, hop: number): void => {
        const { magnitude, phase, previousPhase, synthesisPhase, frequency } = state;
        const bins = half + 1;
        if (hop <= 0) {
            // A frame that does not move in the input continues every bin at its last frequency.
            for (let k = 0; k < bins; k++)
                synthesisPhase[k] = synthesisPhase[k]! + frequency[k]! * synthesisHop;
            return;
        }

        let count = 0;
        for (let k = 1; k < half; k++)
            if (magnitude[k]! > magnitude[k - 1]! && magnitude[k]! >= magnitude[k + 1]!)
                peaks[count++] = k;

        const advanced = (k: number): number => {
            const omega = (2 * Math.PI * k) / size;
            const deviation = principal(phase[k]! - previousPhase[k]! - omega * hop);
            frequency[k] = omega + deviation / hop;
            return synthesisPhase[k]! + frequency[k]! * synthesisHop;
        };

        if (!count) {
            for (let k = 0; k < bins; k++) synthesisPhase[k] = advanced(k);
            return;
        }

        let from = 0;
        for (let p = 0; p < count; p++) {
            const peak = peaks[p]!;
            const to = p + 1 < count ? (peak + peaks[p + 1]!) >> 1 : bins - 1;
            const locked = advanced(peak);
            for (let k = from; k <= to; k++) {
                frequency[k] = frequency[peak]!;
                synthesisPhase[k] = locked + phase[k]! - phase[peak]!;
            }
            from = to + 1;
        }
    };

    /**
     * Analyses, resynthesises and overlap-adds the next frame, reading zeros outside the received
     * input.
     */
    const synthesize = (): void => {
        let centre = Math.round(position);
        let reset = frame === firstFrame;

        // The next attack is reached when this frame's output window holds its mapped time.
        const next = attacks[attackHead];
        if (
            Number.isNaN(anchor) &&
            next !== undefined &&
            frame * synthesisHop + half > next / speed
        ) {
            anchor = next;

            // Drops the reached attacks once they fill half the queue.
            if (++attackHead * 2 >= attacks.length) {
                attacks = attacks.slice(attackHead);
                attackHead = 0;
            }
            centre = Math.round(frame * synthesisHop - anchor / speed + anchor);
            reset = true;
        }
        const hop = centre - previousCentre;
        analyse(centre);
        const outputFrom = frame * synthesisHop - half;
        ensureOutput(outputFrom + size);
        const offset = outputFrom - outputStart;
        for (const state of channels) {
            if (reset) state.synthesisPhase.set(state.phase);
            else advance(state, hop);
            state.previousPhase.set(state.phase);
            const { magnitude, synthesisPhase } = state;
            for (let k = 0; k <= half; k++) {
                const angle = principal(synthesisPhase[k]!);
                synthesisPhase[k] = angle;
                spectrumRe[k] = magnitude[k]! * Math.cos(angle);
                spectrumIm[k] = magnitude[k]! * Math.sin(angle);
            }
            spectrumIm[0] = 0;
            spectrumIm[half] = 0;
            fft!.inverse(spectrumRe, spectrumIm, frameBuffer);
            const output = state.output;
            for (let i = 0; i < size; i++)
                output[offset + i] = output[offset + i]! + frameBuffer[i]! * window[i]!;
        }
        for (let i = 0; i < size; i++)
            normal[offset + i] = normal[offset + i]! + window[i]! * window[i]!;
        previousCentre = centre;
        frame++;
        if (!Number.isNaN(anchor) && frame * synthesisHop - half <= anchor / speed)
            position = frame * synthesisHop - anchor / speed + anchor;
        else {
            const error = frame * analysisHop - (position + analysisHop);
            const limit = analysisHop * MAX_CORRECTION;
            position += analysisHop + Math.max(-limit, Math.min(limit, error * CATCH_UP));

            // The first frame after an attack's starts past it, and a frame before the next attack
            // stops short of it: only the attack's own frames show it.
            if (!Number.isNaN(anchor)) position = Math.max(position, anchor + half + ATTACK_BLOCK);
            anchor = Number.NaN;
            const pending = attacks[attackHead];
            if (pending !== undefined)
                position = Math.min(position, Math.max(previousCentre, pending - half));
        }
    };

    /** Emits the finished output before absolute frame `end`. */
    const release = (end: number, emit: EmitAudio): void => {
        const count = end - emitted;
        if (count <= 0) return;
        const from = emitted - outputStart;
        const planes = channels.map(state => {
            const plane = new Float32Array(count);
            for (let i = 0; i < count; i++) {
                const weight = normal[from + i]!;
                plane[i] = weight > 1e-6 ? state.output[from + i]! / weight : 0;
            }
            return plane;
        });
        emitted = end;

        // Drops what is emitted once it fills half the arrays.
        const done = emitted - outputStart;
        if (done > normal.length >> 1) {
            normal.copyWithin(0, done);
            normal.fill(0, normal.length - done);
            for (const state of channels) {
                state.output.copyWithin(0, done);
                state.output.fill(0, state.output.length - done);
            }
            outputStart = emitted;
        }
        emit(planes);
    };

    /**
     * Drops input that neither a later frame nor attack detection reads, once there is enough of
     * it.
     */
    const trimInput = (): void => {
        const keep = Math.min(Math.round(position), previousCentre) - size;
        const drop =
            Math.min(received, keep, (measured - ATTACK_HISTORY - 2) * ATTACK_BLOCK) - inputStart;
        if (drop < 4 * size) return;
        for (const state of channels) state.input.copyWithin(0, drop, received - inputStart);
        inputStart += drop;
    };

    return {
        type: 'audio',
        name: 'time-stretch',
        configure(input) {
            size = stretchWindow(input.sampleRate);
            half = size / 2;

            // Faster speeds use a shorter synthesis hop, so the analysis hop stays within half a
            // window.
            synthesisHop = size / 4;
            while (synthesisHop * speed > half && synthesisHop > size / 32) synthesisHop /= 2;
            analysisHop = synthesisHop * speed;

            // A frame placed at an attack reads up to a synthesis hop past it, which lies up to
            // half a window times the speed past the frame's planned centre; detection needs the
            // blocks around it.
            lookahead =
                Math.ceil(half * Math.max(1, speed) + synthesisHop + half) + 2 * ATTACK_BLOCK;
            fft = new RealFft(size);
            window = Float64Array.from(
                { length: size },
                (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size),
            );
            const bins = half + 1;
            channels = Array.from({ length: input.channels }, () => ({
                input: new Float32Array(size * 8),
                output: new Float64Array(size * 4),
                previousPhase: new Float64Array(bins),
                synthesisPhase: new Float64Array(bins),
                frequency: new Float64Array(bins),
                magnitude: new Float64Array(bins),
                phase: new Float64Array(bins),
            }));
            normal = new Float64Array(size * 4);
            blockEnergy = new Float64Array(ATTACK_HISTORY + 2);
            frameBuffer = new Float64Array(size);
            spectrumRe = new Float64Array(bins);
            spectrumIm = new Float64Array(bins);
            peaks = new Int32Array(bins);

            // The first frame whose window reaches output frame 0.
            firstFrame = frame = -Math.floor(half / synthesisHop) + 1;
            position = frame * analysisHop;
            previousCentre = Math.round(position);
            outputStart = frame * synthesisHop - half;
            return input;
        },
        process(planes: AudioPlanes, emit: EmitAudio) {
            const length = planes[0]?.length ?? 0;
            if (!length) return;
            channels.forEach((state, channel) => {
                ensureInput(state, received + length - inputStart);
                state.input.set(planes[channel]!, received - inputStart);
            });
            received += length;
            detect();
            while (Math.round(position) + lookahead <= received) synthesize();
            // What no later frame adds to; never past the length the input so far gives.
            release(Math.min(frame * synthesisHop - half, Math.floor(received / speed)), emit);
            trimInput();
        },
        flush(emit: EmitAudio) {
            const total = Math.round(received / speed);
            if (!channels.length || total <= emitted) return;
            while (frame * synthesisHop - half < total) synthesize();
            release(total, emit);
        },
        close() {
            channels = [];
            fft = undefined;
        },
    };
}
