import { normalizePcmSource, type ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { stagedPcmSource } from '../../stages/chain';
import { timeStretchStage } from '../../stages/time-stretch';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import type { ResolvedFade } from './edit-types';

/** One sound placed on the output timeline; source seconds select the played range. */
export interface AudioLayer {
    readonly source: ReplayablePcmSource;
    readonly start: number;
    readonly end?: number;
    /** Playback rate. */
    readonly speed: number;
    /**
     * A speed other than 1 keeps the pitch by time stretching; otherwise the range is resampled and
     * pitch follows.
     */
    readonly stretch: boolean;
    /**
     * Output frame the layer begins at and the frames it covers; a looping layer repeats its range
     * until then.
     */
    readonly offset: number;
    readonly length: number;
    readonly volume: number;
    readonly fade: ResolvedFade;
    readonly loop: boolean;
}

/** Output frames mixed per work unit. */
const BLOCK_FRAMES = 4096;

/** Seconds the limiter looks ahead (reaching a peak's gain over them) and recovers over. */
const LIMITER_ATTACK = 0.005;
const LIMITER_RELEASE = 0.05;

/**
 * Keeps a mix within full scale without clipping it. The gain each frame needs is held over the
 * 5 ms ahead of it, may rise by its full range over 50 ms at most, and is averaged over the last
 * 5 ms: the average of gains that each look past the frame is never above what the frame needs, and
 * a steady loud passage keeps one gain, so its waveform keeps its shape. One gain for every channel
 * keeps the balance; a mix that stays within full scale passes unchanged.
 */
class MixLimiter {
    private readonly attack: number;
    private readonly release: number;
    /** The last `attack` held gains, as a ring, and their sum. */
    private readonly held: Float64Array;
    private at = 0;
    private sum: number;
    private previous = 1;
    private started = false;

    constructor(sampleRate: number) {
        this.attack = Math.max(1, Math.round(sampleRate * LIMITER_ATTACK));
        this.release = 1 / Math.max(1, Math.round(sampleRate * LIMITER_RELEASE));
        this.held = new Float64Array(this.attack).fill(1);
        this.sum = this.attack;
    }

    /** Limits `block` in place, looking ahead into `next` (none at the end), and returns it. */
    apply(block: Float32Array[], next: Float32Array[] | undefined): Float32Array[] {
        const frames = block[0]!.length;
        const span = frames + Math.min(this.attack, next?.[0]!.length ?? 0);

        // The gain each frame needs: 1 within full scale.
        const need = new Float64Array(span).fill(1);
        let over = false;
        for (let index = 0; index < span; index++) {
            const planes = index < frames ? block : next!;
            const at = index < frames ? index : index - frames;
            let peak = 0;
            for (const plane of planes) peak = Math.max(peak, Math.abs(plane[at]!));
            if (peak > 1) {
                need[index] = 1 / peak;
                over = true;
            }
        }
        if (!over && this.previous === 1 && this.sum === this.attack) {
            this.started = true;
            return block;
        }

        // The lowest need from each frame to `attack` frames past it.
        const hold = (index: number): number => {
            let lowest = 1;
            for (
                let ahead = index, last = Math.min(span - 1, index + this.attack);
                ahead <= last;
                ahead++
            )
                if (need[ahead]! < lowest) lowest = need[ahead]!;
            return lowest;
        };

        // A stream that starts loud starts at the gain its first frames need.
        if (!this.started) {
            this.started = true;
            const first = hold(0);
            this.held.fill(first);
            this.sum = first * this.attack;
            this.previous = first;
        }
        for (let index = 0; index < frames; index++) {
            const held = Math.min(hold(index), this.previous + this.release);
            this.previous = held;
            const gain = (this.sum + held) / (this.attack + 1);
            this.sum += held - this.held[this.at]!;
            this.held[this.at] = held;
            this.at = (this.at + 1) % this.attack;
            if (gain < 1)
                for (const plane of block) {
                    const value = plane[index]! * gain;
                    plane[index] = value > 1 ? 1 : value < -1 ? -1 : value;
                }
        }

        // Rounding of the running sum must not keep a recovered limiter engaged.
        if (this.previous === 1 && this.held.every(value => value === 1)) this.sum = this.attack;
        return block;
    }
}

/** Linear gain envelope of a layer over its own frames: volume shaped by the fades at both ends. */
function envelope(layer: AudioLayer, rate: number): (frame: number) => number {
    const fadeIn = Math.round(layer.fade.in * rate);
    const fadeOut = Math.round(layer.fade.out * rate);
    if (!fadeIn && !fadeOut) return () => layer.volume;
    return frame => {
        let gain = 1;
        if (fadeIn) gain = Math.min(gain, (frame + 0.5) / fadeIn);
        if (fadeOut) gain = Math.min(gain, (layer.length - frame - 0.5) / fadeOut);
        return layer.volume * Math.max(0, gain);
    };
}

/**
 * Pulls one layer's frames in order. The range is resampled to the output rate through the layer's
 * speed; a range shorter than the layer is padded with silence, or repeated when the layer loops.
 */
class LayerReader {
    private iterator: AsyncIterator<readonly Float32Array[]> | undefined;
    private chunk: readonly Float32Array[] | undefined;
    private at = 0;
    private produced = 0;
    private ended = false;
    private readonly gain: (frame: number) => number;
    private readonly stream: ReplayablePcmSource;

    constructor(
        private readonly layer: AudioLayer,
        rate: number,
        channels: number,
        private readonly signal: AbortSignal | undefined,
    ) {
        this.gain = envelope(layer, rate);
        const source = layer.source;
        if (layer.stretch && layer.speed !== 1) {
            // The range at the output rate, then stretched: exactly round(range / speed) frames.
            const head = Math.round(layer.start * rate);
            const valid =
                layer.end === undefined ? 0 : Math.round((layer.end - layer.start) * rate);
            const range = normalizePcmSource(source, rate, channels, { head, valid });
            this.stream = stagedPcmSource(range, [
                { name: 'time-stretch', create: () => timeStretchStage(layer.speed) },
            ]);
            return;
        }
        const speedRate = Math.round(source.sampleRate * layer.speed);
        const played = layer.speed === 1 ? source : { ...source, sampleRate: speedRate };
        const head = Math.round((layer.start * rate) / layer.speed);
        const valid =
            layer.end === undefined
                ? 0
                : Math.round(((layer.end - layer.start) * rate) / layer.speed);
        this.stream = normalizePcmSource(played, rate, channels, { head, valid });
    }

    /** Output frames the layer covers. */
    get offset(): number {
        return this.layer.offset;
    }
    get end(): number {
        return this.layer.offset + this.layer.length;
    }

    private async next(): Promise<boolean> {
        if (this.ended) return false;
        this.iterator ??= this.stream.chunks(this.signal)[Symbol.asyncIterator]();
        for (;;) {
            const step = await this.iterator.next();
            if (step.done) {
                this.iterator = undefined;
                if (!this.layer.loop || this.produced === 0) {
                    this.ended = true;
                    return false;
                }
                this.iterator = this.stream.chunks(this.signal)[Symbol.asyncIterator]();
                continue;
            }
            if (!step.value[0]?.length) continue;
            this.chunk = step.value;
            this.at = 0;
            return true;
        }
    }

    /**
     * Adds the layer's next `count` frames, starting at output frame `from`, into `out` at `into`.
     */
    async mixInto(out: Float32Array[], into: number, from: number, count: number): Promise<void> {
        const local = from - this.layer.offset;
        if (local !== this.produced)
            throw new MediaForgeError('Audio layers must be read in order', 'DECODE');

        let done = 0;
        while (done < count) {
            if (!this.chunk || this.at >= this.chunk[0]!.length) {
                this.chunk = undefined;
                if (!(await this.next())) break;
            }
            const planes = this.chunk!;
            const take = Math.min(count - done, planes[0]!.length - this.at);
            const frame = local + done;
            for (let channel = 0; channel < out.length; channel++) {
                const target = out[channel]!;
                const source = planes[channel]!;
                for (let index = 0; index < take; index++)
                    target[into + done + index] +=
                        source[this.at + index]! * this.gain(frame + index);
            }

            this.at += take;
            done += take;
        }
        this.produced += count;
    }

    async close(): Promise<void> {
        const iterator = this.iterator;
        this.iterator = undefined;
        this.chunk = undefined;
        await iterator?.return?.(undefined);
    }
}

/**
 * The sum of the layers over `frames` output frames at `sampleRate` and `channels`, kept within
 * full scale by a limiter, in work units of at most 4096 frames. Layers decode lazily and again on
 * every replay.
 */
export function mixAudioLayers(
    layers: readonly AudioLayer[],
    sampleRate: number,
    channels: number,
    frames: number,
): ReplayablePcmSource {
    if (!Number.isSafeInteger(frames) || frames < 1)
        throw new MediaForgeError('The edit has no audio to mix', 'FORMAT');
    return {
        sampleRate,
        channels,
        estimatedFrames: frames,
        async *chunks(signal) {
            throwIfAborted(signal);
            const readers = layers.map(
                layer => new LayerReader(layer, sampleRate, channels, signal),
            );
            try {
                // Each block leaves once the next is mixed, which the limiter looks ahead into.
                const limiter = new MixLimiter(sampleRate);
                let pending: Float32Array[] | undefined;
                for (let at = 0; at < frames; at += BLOCK_FRAMES) {
                    throwIfAborted(signal);
                    const count = Math.min(BLOCK_FRAMES, frames - at);
                    const out = Array.from({ length: channels }, () => new Float32Array(count));

                    for (const reader of readers) {
                        const layerStart = Math.max(at, reader.offset);
                        const layerEnd = Math.min(at + count, reader.end);
                        if (layerStart < layerEnd)
                            await reader.mixInto(
                                out,
                                layerStart - at,
                                layerStart,
                                layerEnd - layerStart,
                            );
                    }

                    if (pending) yield limiter.apply(pending, out);
                    pending = out;
                }
                if (pending) yield limiter.apply(pending, undefined);
            } finally {
                await Promise.allSettled(readers.map(reader => reader.close()));
            }
        },
    };
}
