import { EncodeError } from '../../core/errors/errors';
import { gcd } from '../../core/bytes/gcd';

const kernelCache = new Map<string, Float32Array>();
let kernelCacheBytes = 0;
const KERNEL_CACHE_LIMIT = 8 * 1024 * 1024;

/**
 * I0(x) of the Kaiser window. It stays apart from besselI0 of codecs/shared/kaiser: that series
 * stops at another term, and the window coefficients, and so every resampled sample, would change
 * in their last bits.
 */
function besselI0(x: number): number {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 32; k++) {
        term *= (x / (2 * k)) * (x / (2 * k));
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

/** Kernel half-length of the final stage, in periods of the lower of the two rates. */
const HALF_TAPS = 48;

/** Longest kernel half-length of a final downsampling stage, in source samples. */
const MAX_HALF_TAPS = 512;

/**
 * One polyphase windowed-sinc stage. A final stage cuts at 0.475 of the lower rate with a Kaiser
 * kernel spanning HALF_TAPS periods of that rate, so passband (flat to 0.9 of the output Nyquist
 * frequency) and stopband (below -90 dB) are the same whichever way the rate changes. An
 * intermediate stage of a large reduction only has to keep the band the final stage passes, and
 * uses a short kernel.
 */
class ResamplingStage {
    private readonly taps: number;
    private readonly halfTaps: number;
    private readonly kernels: Float32Array;
    private readonly den: number;
    private readonly qInc: number;
    private readonly rInc: number;
    /** `length` unconsumed frames per channel, from absolute frame `consumed`. */
    private history: Float32Array[];
    private length = 0;
    private consumed = 0;
    private cursor = 0;
    private phase = 0;
    private sealed = false;
    private readonly phases: number;
    private readonly blended: Float32Array;

    constructor(
        private readonly sourceRate: number,
        private readonly targetRate: number,
        private readonly channels: number,
        final = true,
    ) {
        if (
            ![sourceRate, targetRate].every(
                rate => Number.isInteger(rate) && rate > 0 && rate <= 768000,
            ) ||
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > 8
        ) {
            throw new EncodeError(
                'resampler requires integer sample rates 1..768000 and 1..8 channels',
            );
        }
        const ratio = targetRate / sourceRate;
        const fc = ratio >= 1 ? 0.475 : (final ? 0.475 : 0.46) * ratio;
        this.halfTaps =
            ratio >= 1
                ? HALF_TAPS
                : final
                  ? Math.min(MAX_HALF_TAPS, Math.ceil(HALF_TAPS / ratio))
                  : Math.max(16, Math.min(160, Math.ceil(2.6 / fc)));
        this.taps = this.halfTaps * 2;
        const beta = 9;
        const i0beta = besselI0(beta);
        const g = gcd(sourceRate, targetRate);
        this.den = targetRate / g;
        const num = sourceRate / g;
        this.phases = Math.min(this.den, 2048);
        this.blended = new Float32Array(this.taps);
        this.qInc = Math.floor(num / this.den);
        this.rInc = num % this.den;
        const cacheKey = `${sourceRate / g}:${targetRate / g}:${this.halfTaps}`;
        const cached = kernelCache.get(cacheKey);
        if (cached) {
            kernelCache.delete(cacheKey);
            kernelCache.set(cacheKey, cached);
            this.kernels = cached;
        } else {
            const rows = this.phases + (this.phases < this.den ? 1 : 0);
            this.kernels = new Float32Array(rows * this.taps);
            for (let p = 0; p < rows; p++) {
                const frac = p / this.phases;
                const base = p * this.taps;
                let sum = 0;
                for (let k = 0; k < this.taps; k++) {
                    const t = k - (this.halfTaps - 1) - frac;
                    const sinc = t === 0 ? 2 * fc : Math.sin(Math.PI * 2 * fc * t) / (Math.PI * t);
                    const r = t / this.halfTaps;
                    const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0beta;
                    const v = sinc * w;
                    this.kernels[base + k] = v;
                    sum += v;
                }
                for (let k = 0; k < this.taps; k++) this.kernels[base + k]! /= sum;
            }
            while (
                kernelCacheBytes + this.kernels.byteLength > KERNEL_CACHE_LIMIT &&
                kernelCache.size
            ) {
                const key = kernelCache.keys().next().value!;
                kernelCacheBytes -= kernelCache.get(key)!.byteLength;
                kernelCache.delete(key);
            }
            kernelCache.set(cacheKey, this.kernels);
            kernelCacheBytes += this.kernels.byteLength;
        }
        this.history = Array.from({ length: channels }, () => new Float32Array(0));
    }

    get ratio(): number {
        return this.targetRate / this.sourceRate;
    }

    process(chunk: readonly Float32Array[]): Float32Array[] {
        if (this.sealed) throw new EncodeError('resampler received data after flush');
        if (
            chunk.length !== this.channels ||
            chunk.some(plane => plane.length !== chunk[0]!.length)
        ) {
            throw new EncodeError(
                'resampler channel planes must match the configured count and length',
            );
        }
        return this.run(chunk, false);
    }

    flush(): Float32Array[] {
        if (this.sealed) return Array.from({ length: this.channels }, () => new Float32Array(0));
        this.sealed = true;
        const output = this.run(null, true);
        this.history = this.history.map(() => new Float32Array(0));
        this.length = 0;
        return output;
    }

    /** Appends a chunk to the history, growing its buffers geometrically. */
    private append(chunk: readonly Float32Array[]): void {
        const incoming = chunk[0]!.length;
        if (incoming === 0) return;
        const needed = this.length + incoming;
        if (needed > this.history[0]!.length) {
            const size = Math.max(needed, this.history[0]!.length * 2, 4096);
            this.history = this.history.map(old => {
                const grown = new Float32Array(size);
                grown.set(old.subarray(0, this.length));
                return grown;
            });
        }
        for (let c = 0; c < this.channels; c++) this.history[c]!.set(chunk[c]!, this.length);
        this.length = needed;
    }

    private run(chunk: readonly Float32Array[] | null, final: boolean): Float32Array[] {
        const channels = this.channels;
        if (chunk) this.append(chunk);
        const available = this.consumed + this.length;

        const limit = final ? available : available - this.halfTaps;
        const outputs: Float32Array[] = [];
        const estimate = Math.max(0, Math.ceil((limit - this.cursor) * this.ratio) + 2);
        for (let c = 0; c < channels; c++) outputs.push(new Float32Array(estimate));

        let produced = 0;
        const { taps, halfTaps, kernels, den, qInc, rInc, phases, blended, consumed, length } =
            this;
        const histories = this.history;
        const [left, right] = histories as [Float32Array, Float32Array];
        let cursor = this.cursor;
        let phase = this.phase;
        while (cursor < limit) {
            const localStart = cursor - (halfTaps - 1) - consumed;
            let base = phase * taps;
            let kernel = kernels;
            if (phases < den) {
                const position = (phase * phases) / den;
                const row = Math.floor(position);
                const blend = position - row;
                const left = row * taps;
                for (let k = 0; k < taps; k++) {
                    const low = kernels[left + k]!;
                    blended[k] = low + (kernels[left + taps + k]! - low) * blend;
                }
                kernel = blended;
                base = 0;
            }
            const end = base + taps;
            const inside = localStart >= 0 && localStart + taps <= length;

            // Partial sums in double precision; every output is rounded to float32 once.
            if (inside && channels === 2) {
                let l0 = 0;
                let l1 = 0;
                let r0 = 0;
                let r1 = 0;
                let i = localStart;
                let k = base;
                for (; k + 1 < end; k += 2, i += 2) {
                    const w0 = kernel[k]!;
                    const w1 = kernel[k + 1]!;
                    l0 += left[i]! * w0;
                    r0 += right[i]! * w0;
                    l1 += left[i + 1]! * w1;
                    r1 += right[i + 1]! * w1;
                }
                if (k < end) {
                    l0 += left[i]! * kernel[k]!;
                    r0 += right[i]! * kernel[k]!;
                }
                outputs[0]![produced] = l0 + l1;
                outputs[1]![produced] = r0 + r1;
            } else if (inside) {
                for (let c = 0; c < channels; c++) {
                    const data = histories[c]!;
                    let a0 = 0;
                    let a1 = 0;
                    let a2 = 0;
                    let a3 = 0;
                    let i = localStart;
                    let k = base;
                    for (; k + 3 < end; k += 4, i += 4) {
                        a0 += data[i]! * kernel[k]!;
                        a1 += data[i + 1]! * kernel[k + 1]!;
                        a2 += data[i + 2]! * kernel[k + 2]!;
                        a3 += data[i + 3]! * kernel[k + 3]!;
                    }
                    for (; k < end; k++, i++) a0 += data[i]! * kernel[k]!;
                    outputs[c]![produced] = a0 + a1 + a2 + a3;
                }
            } else {
                for (let c = 0; c < channels; c++) {
                    const data = histories[c]!;
                    let acc = 0;
                    for (let k = 0; k < taps; k++) {
                        const local = Math.max(0, Math.min(length - 1, localStart + k));
                        acc += data[local]! * kernel[base + k]!;
                    }
                    outputs[c]![produced] = acc;
                }
            }
            produced++;
            cursor += qInc;
            phase += rInc;
            if (phase >= den) {
                phase -= den;
                cursor++;
            }
        }
        this.cursor = cursor;
        this.phase = phase;

        // Frames no later output reads move out of the history; the buffers are kept.
        const keepFrom = Math.max(0, this.cursor - (this.halfTaps - 1));
        const drop = Math.max(0, Math.min(keepFrom - this.consumed, this.length));
        if (drop > 0) {
            for (const plane of this.history) plane.copyWithin(0, drop, this.length);
            this.length -= drop;
            this.consumed += drop;
        }
        return outputs.map(buffer => buffer.subarray(0, produced));
    }
}

export class StreamingResampler {
    private readonly stages: ResamplingStage[] = [];
    private inputFrames = 0;
    private outputFrames = 0;
    private sealed = false;

    constructor(
        private readonly sourceRate: number,
        private readonly targetRate: number,
        private readonly channels: number,
    ) {
        if (
            ![sourceRate, targetRate].every(
                rate => Number.isInteger(rate) && rate > 0 && rate <= 768000,
            ) ||
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > 8
        ) {
            throw new EncodeError(
                'resampler requires integer sample rates 1..768000 and 1..8 channels',
            );
        }
        let rate = sourceRate;
        if (rate / targetRate > 28) {
            while (rate / targetRate > 8) {
                const intermediateRate = Math.max(targetRate * 4, Math.ceil(rate / 16));
                this.stages.push(new ResamplingStage(rate, intermediateRate, channels, false));
                rate = intermediateRate;
            }
        }
        this.stages.push(new ResamplingStage(rate, targetRate, channels));
    }

    process(chunk: readonly Float32Array[]): Float32Array[] {
        if (this.sealed) throw new EncodeError('resampler received data after flush');
        let output = this.stages[0]!.process(chunk);
        this.inputFrames += chunk[0]!.length;
        for (let i = 1; i < this.stages.length; i++) output = this.stages[i]!.process(output);
        this.outputFrames += output[0]!.length;
        return output;
    }

    flush(): Float32Array[] {
        if (this.sealed) return Array.from({ length: this.channels }, () => new Float32Array(0));
        this.sealed = true;
        let output = this.stages[0]!.flush();
        for (let i = 1; i < this.stages.length; i++) {
            const stage = this.stages[i]!;
            const head = stage.process(output);
            const tail = stage.flush();
            output = head.map((plane, channel) => {
                const merged = new Float32Array(plane.length + tail[channel]!.length);
                merged.set(plane);
                merged.set(tail[channel]!, plane.length);
                return merged;
            });
        }
        const remaining = Math.max(
            0,
            Math.ceil((this.inputFrames * this.targetRate) / this.sourceRate) - this.outputFrames,
        );
        return output.map(plane => plane.subarray(0, remaining));
    }
}
