import { EncodeError } from '../core/errors.js';
const kernelCache = new Map();
let kernelCacheBytes = 0;
const KERNEL_CACHE_LIMIT = 8 * 1024 * 1024;
function besselI0(x) {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 32; k++) {
        term *= (x / (2 * k)) * (x / (2 * k));
        sum += term;
        if (term < sum * 1e-17)
            break;
    }
    return sum;
}
function gcd(a, b) {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y) {
        const t = x % y;
        x = y;
        y = t;
    }
    return x || 1;
}
class ResamplingStage {
    sourceRate;
    targetRate;
    channels;
    taps;
    halfTaps;
    kernels;
    den;
    qInc;
    rInc;
    history;
    consumed = 0;
    cursor = 0;
    phase = 0;
    sealed = false;
    phases;
    blended;
    constructor(sourceRate, targetRate, channels, precision = 2.6) {
        this.sourceRate = sourceRate;
        this.targetRate = targetRate;
        this.channels = channels;
        if (![sourceRate, targetRate].every(rate => Number.isInteger(rate) && rate > 0 && rate <= 768000) ||
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > 8) {
            throw new EncodeError('resampler requires integer sample rates 1..768000 and 1..8 channels');
        }
        const upsampling = targetRate >= sourceRate;
        const fc = upsampling ? 0.475 : 0.46 * (targetRate / sourceRate);
        this.halfTaps = upsampling ? 48 : Math.max(16, Math.min(160, Math.ceil(precision / fc)));
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
        }
        else {
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
                for (let k = 0; k < this.taps; k++)
                    this.kernels[base + k] /= sum;
            }
            while (kernelCacheBytes + this.kernels.byteLength > KERNEL_CACHE_LIMIT && kernelCache.size) {
                const key = kernelCache.keys().next().value;
                kernelCacheBytes -= kernelCache.get(key).byteLength;
                kernelCache.delete(key);
            }
            kernelCache.set(cacheKey, this.kernels);
            kernelCacheBytes += this.kernels.byteLength;
        }
        this.history = [];
        for (let c = 0; c < channels; c++)
            this.history.push(new Float32Array(0));
    }
    get ratio() {
        return this.targetRate / this.sourceRate;
    }
    process(chunk) {
        if (this.sealed)
            throw new EncodeError('resampler received data after flush');
        if (chunk.length !== this.channels || chunk.some(plane => plane.length !== chunk[0].length)) {
            throw new EncodeError('resampler channel planes must match the configured count and length');
        }
        return this.run(chunk, false);
    }
    flush() {
        if (this.sealed)
            return Array.from({ length: this.channels }, () => new Float32Array(0));
        this.sealed = true;
        const output = this.run(null, true);
        for (let c = 0; c < this.channels; c++)
            this.history[c] = new Float32Array(0);
        return output;
    }
    run(chunk, final) {
        const channels = this.channels;
        for (let c = 0; c < channels; c++) {
            const incoming = chunk?.[c];
            if (!incoming || incoming.length === 0)
                continue;
            const previous = this.history[c];
            const merged = new Float32Array(previous.length + incoming.length);
            merged.set(previous, 0);
            merged.set(incoming, previous.length);
            this.history[c] = merged;
        }
        const available = this.consumed + this.history[0].length;
        const limit = final ? available : available - this.halfTaps;
        const outputs = [];
        const estimate = Math.max(0, Math.ceil((limit - this.cursor) * this.ratio) + 2);
        for (let c = 0; c < channels; c++)
            outputs.push(new Float32Array(estimate));
        let produced = 0;
        while (this.cursor < limit) {
            const start = this.cursor - (this.halfTaps - 1);
            let base = this.phase * this.taps;
            let kernel = this.kernels;
            if (this.phases < this.den) {
                const phase = (this.phase * this.phases) / this.den;
                const row = Math.floor(phase);
                const blend = phase - row;
                base = row * this.taps;
                for (let k = 0; k < this.taps; k++) {
                    const left = this.kernels[base + k];
                    this.blended[k] = left + (this.kernels[base + this.taps + k] - left) * blend;
                }
                kernel = this.blended;
                base = 0;
            }
            for (let c = 0; c < channels; c++) {
                const data = this.history[c];
                let acc = 0;
                const localStart = start - this.consumed;
                if (localStart >= 0 && localStart + this.taps <= data.length) {
                    for (let k = 0; k < this.taps; k++)
                        acc += data[localStart + k] * kernel[base + k];
                }
                else {
                    for (let k = 0; k < this.taps; k++) {
                        const local = Math.max(0, Math.min(data.length - 1, localStart + k));
                        acc += data[local] * kernel[base + k];
                    }
                }
                outputs[c][produced] = acc;
            }
            produced++;
            this.cursor += this.qInc;
            this.phase += this.rInc;
            if (this.phase >= this.den) {
                this.phase -= this.den;
                this.cursor++;
            }
        }
        const keepFrom = Math.max(0, this.cursor - (this.halfTaps - 1));
        const drop = Math.max(0, Math.min(keepFrom - this.consumed, this.history[0].length));
        if (drop > 0) {
            for (let c = 0; c < channels; c++)
                this.history[c] = this.history[c].slice(drop);
            this.consumed += drop;
        }
        return outputs.map(buffer => buffer.subarray(0, produced));
    }
}
export class StreamingResampler {
    sourceRate;
    targetRate;
    channels;
    stages = [];
    inputFrames = 0;
    outputFrames = 0;
    sealed = false;
    constructor(sourceRate, targetRate, channels) {
        this.sourceRate = sourceRate;
        this.targetRate = targetRate;
        this.channels = channels;
        if (![sourceRate, targetRate].every(rate => Number.isInteger(rate) && rate > 0 && rate <= 768000) ||
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > 8) {
            throw new EncodeError('resampler requires integer sample rates 1..768000 and 1..8 channels');
        }
        let rate = sourceRate;
        if (rate / targetRate > 28) {
            while (rate / targetRate > 8) {
                const intermediateRate = Math.max(targetRate * 4, Math.ceil(rate / 16));
                this.stages.push(new ResamplingStage(rate, intermediateRate, channels));
                rate = intermediateRate;
            }
        }
        this.stages.push(new ResamplingStage(rate, targetRate, channels, this.stages.length ? 8 : 2.6));
    }
    get ratio() {
        return this.targetRate / this.sourceRate;
    }
    process(chunk) {
        if (this.sealed)
            throw new EncodeError('resampler received data after flush');
        let output = this.stages[0].process(chunk);
        this.inputFrames += chunk[0].length;
        for (let i = 1; i < this.stages.length; i++)
            output = this.stages[i].process(output);
        this.outputFrames += output[0].length;
        return output;
    }
    flush() {
        if (this.sealed)
            return Array.from({ length: this.channels }, () => new Float32Array(0));
        this.sealed = true;
        let output = this.stages[0].flush();
        for (let i = 1; i < this.stages.length; i++) {
            const stage = this.stages[i];
            const head = stage.process(output);
            const tail = stage.flush();
            output = head.map((plane, channel) => {
                const merged = new Float32Array(plane.length + tail[channel].length);
                merged.set(plane);
                merged.set(tail[channel], plane.length);
                return merged;
            });
        }
        const remaining = Math.max(0, Math.ceil((this.inputFrames * this.targetRate) / this.sourceRate) - this.outputFrames);
        return output.map(plane => plane.subarray(0, remaining));
    }
}
