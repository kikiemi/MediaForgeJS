import { EncodeError, MediaForgeError } from '../core/errors.js';
import { BitSink } from '../core/binary-writer.js';
import { AAC_SAMPLE_RATES, SWB_OFFSET_1024, SF_HUFF_BITS, SF_HUFF_CODES, SPECTRAL_BOOKS, } from './aac-tables.js';
import { InterleavedPcmQueue } from './streaming-pcm.js';
import { getAdtsConfiguration, getAdtsFrameLength, writeAdtsHeader } from './adts.js';
const FRAME_LEN = 1024;
const WINDOW_LEN = 2048;
const SF_OFFSET = 100;
const MAX_QUANT = 8191;
const SF_MAX_DELTA = 60;
class Fft {
    n;
    wr;
    wi;
    rev;
    constructor(n) {
        this.n = n;
        this.wr = new Float64Array(n / 2);
        this.wi = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            const angle = (-2 * Math.PI * i) / n;
            this.wr[i] = Math.cos(angle);
            this.wi[i] = Math.sin(angle);
        }
        this.rev = new Uint32Array(n);
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1)
                j ^= bit;
            j ^= bit;
            this.rev[i] = j;
        }
    }
    run(re, im) {
        const { n, rev, wr, wi } = this;
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (i < j) {
                const tr = re[i];
                re[i] = re[j];
                re[j] = tr;
                const ti = im[i];
                im[i] = im[j];
                im[j] = ti;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1;
            const step = n / len;
            for (let base = 0; base < n; base += len) {
                for (let j = 0; j < half; j++) {
                    const cr = wr[j * step];
                    const ci = wi[j * step];
                    const a = base + j;
                    const b = a + half;
                    const xr = re[b] * cr - im[b] * ci;
                    const xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
            }
        }
    }
}
class Mdct {
    fft = new Fft(WINDOW_LEN);
    preR = new Float64Array(WINDOW_LEN);
    preI = new Float64Array(WINDOW_LEN);
    postR = new Float64Array(FRAME_LEN);
    postI = new Float64Array(FRAME_LEN);
    re = new Float64Array(WINDOW_LEN);
    im = new Float64Array(WINDOW_LEN);
    constructor() {
        const n0 = WINDOW_LEN / 4 + 0.5;
        for (let n = 0; n < WINDOW_LEN; n++) {
            const angle = (-Math.PI * n) / WINDOW_LEN;
            this.preR[n] = Math.cos(angle);
            this.preI[n] = Math.sin(angle);
        }
        for (let k = 0; k < FRAME_LEN; k++) {
            const angle = (-2 * Math.PI * n0 * (k + 0.5)) / WINDOW_LEN;
            this.postR[k] = Math.cos(angle);
            this.postI[k] = Math.sin(angle);
        }
    }
    run(windowed, out) {
        const { re, im, preR, preI, postR, postI } = this;
        for (let n = 0; n < WINDOW_LEN; n++) {
            re[n] = windowed[n] * preR[n];
            im[n] = windowed[n] * preI[n];
        }
        this.fft.run(re, im);
        for (let k = 0; k < FRAME_LEN; k++)
            out[k] = re[k] * postR[k] - im[k] * postI[k];
    }
}
const SINE_WINDOW = (() => {
    const w = new Float64Array(WINDOW_LEN);
    for (let n = 0; n < WINDOW_LEN; n++)
        w[n] = Math.sin((Math.PI / WINDOW_LEN) * (n + 0.5));
    return w;
})();
function samplingFrequencyIndex(sampleRate) {
    const index = AAC_SAMPLE_RATES.indexOf(sampleRate);
    if (index < 0)
        throw new EncodeError(`encodeAac: unsupported sample rate ${sampleRate}`);
    return index;
}
function bandLayout(srIndex) {
    const offsets = SWB_OFFSET_1024[srIndex];
    return { offsets, count: offsets.length - 1 };
}
function computeThresholds(spectrum, bands, sampleRate, bitrateKbpsPerChannel, energyOut, thresholdOut) {
    const { offsets, count } = bands;
    for (let b = 0; b < count; b++) {
        let energy = 0;
        for (let k = offsets[b]; k < offsets[b + 1]; k++)
            energy += spectrum[k] * spectrum[k];
        energyOut[b] = energy;
    }
    const snrDb = Math.min(33, Math.max(12, 8 + bitrateKbpsPerChannel * 0.24));
    const ratio = Math.pow(10, -snrDb / 10);
    for (let b = 0; b < count; b++) {
        let masked = energyOut[b];
        if (b > 0)
            masked += energyOut[b - 1] * 0.3;
        if (b + 1 < count)
            masked += energyOut[b + 1] * 0.15;
        const width = offsets[b + 1] - offsets[b];
        const centerHz = ((offsets[b] + offsets[b + 1]) / 2) * (sampleRate / (2 * FRAME_LEN));
        const athDb = centerHz > 14000 ? -48 : centerHz > 9000 ? -66 : -78;
        const athEnergy = Math.pow(10, athDb / 10) * width * 1.0e6;
        thresholdOut[b] = Math.max(masked * ratio, athEnergy);
    }
}
function bandBits(book, quant, start, end) {
    const { dim, lav, range, signed, bits } = book;
    const escape = lav === 16;
    let total = 0;
    for (let k = start; k < end; k += dim) {
        let index = 0;
        let signBits = 0;
        let escBits = 0;
        for (let d = 0; d < dim; d++) {
            let v = quant[k + d];
            if (signed) {
                index = index * range + (v + lav);
            }
            else {
                const mag = v < 0 ? -v : v;
                let coded = mag;
                if (escape && mag >= 16) {
                    coded = 16;
                    let pre = 4;
                    while (1 << (pre + 1) <= mag)
                        pre++;
                    escBits += pre - 4 + 1 + pre;
                }
                if (!escape && mag > lav)
                    return Number.POSITIVE_INFINITY;
                index = index * range + coded;
                if (mag !== 0)
                    signBits++;
                v = mag;
            }
        }
        total += bits[index] + signBits + escBits;
    }
    return total;
}
function chooseBook(quant, start, end) {
    let maxAbs = 0;
    let allZero = true;
    for (let k = start; k < end; k++) {
        const v = quant[k] < 0 ? -quant[k] : quant[k];
        if (v > maxAbs)
            maxAbs = v;
        if (v !== 0)
            allZero = false;
    }
    if (allZero)
        return { book: 0, bits: 0 };
    const candidates = maxAbs <= 1
        ? [1, 2]
        : maxAbs <= 2
            ? [3, 4]
            : maxAbs <= 4
                ? [5, 6]
                : maxAbs <= 7
                    ? [7, 8]
                    : maxAbs <= 12
                        ? [9, 10]
                        : [11];
    let bestBook = candidates[0];
    let bestBits = Number.POSITIVE_INFINITY;
    for (const bookIndex of candidates) {
        const book = SPECTRAL_BOOKS[bookIndex];
        const cost = bandBits(book, quant, start, end);
        if (cost < bestBits) {
            bestBits = cost;
            bestBook = bookIndex;
        }
    }
    return { book: bestBook, bits: bestBits };
}
function writeSpectral(sink, bookIndex, quant, start, end) {
    const book = SPECTRAL_BOOKS[bookIndex];
    const { dim, lav, range, signed, codes, bits } = book;
    const escape = lav === 16;
    for (let k = start; k < end; k += dim) {
        let index = 0;
        for (let d = 0; d < dim; d++) {
            const v = quant[k + d];
            if (signed) {
                index = index * range + (v + lav);
            }
            else {
                const mag = v < 0 ? -v : v;
                index = index * range + (escape && mag >= 16 ? 16 : mag);
            }
        }
        sink.writeBits(codes[index], bits[index]);
        if (!signed) {
            for (let d = 0; d < dim; d++) {
                const v = quant[k + d];
                if (v !== 0)
                    sink.writeBits(v < 0 ? 1 : 0, 1);
            }
        }
        if (escape) {
            for (let d = 0; d < dim; d++) {
                const mag = quant[k + d] < 0 ? -quant[k + d] : quant[k + d];
                if (mag >= 16) {
                    let pre = 4;
                    while (1 << (pre + 1) <= mag)
                        pre++;
                    for (let i = 0; i < pre - 4; i++)
                        sink.writeBits(1, 1);
                    sink.writeBits(0, 1);
                    sink.writeBits(mag - (1 << pre), pre);
                }
            }
        }
    }
}
class ChannelCoder {
    bands;
    spectrum = new Float64Array(FRAME_LEN);
    pow34 = new Float64Array(FRAME_LEN);
    energy;
    threshold;
    plan;
    overlap = new Float64Array(FRAME_LEN);
    windowed = new Float64Array(WINDOW_LEN);
    mdct = new Mdct();
    sfFloor;
    constructor(bands) {
        this.bands = bands;
        this.energy = new Float64Array(bands.count);
        this.threshold = new Float64Array(bands.count);
        this.sfFloor = new Int32Array(bands.count);
        this.plan = {
            quant: new Int32Array(FRAME_LEN),
            scalefactors: new Int32Array(bands.count),
            books: new Int32Array(bands.count),
            globalGain: 0,
            maxSfb: bands.count,
            bits: 0,
        };
    }
    analyze(current) {
        const { windowed, overlap } = this;
        for (let n = 0; n < FRAME_LEN; n++) {
            windowed[n] = overlap[n] * SINE_WINDOW[n];
            windowed[FRAME_LEN + n] = current[n] * SINE_WINDOW[FRAME_LEN + n];
        }
        overlap.set(current);
        this.mdct.run(windowed, this.spectrum);
        for (let k = 0; k < FRAME_LEN; k++) {
            const v = this.spectrum[k];
            this.pow34[k] = Math.pow(v < 0 ? -v : v, 0.75);
        }
        const { offsets, count } = this.bands;
        for (let b = 0; b < count; b++) {
            let peak = 0;
            for (let k = offsets[b]; k < offsets[b + 1]; k++) {
                if (this.pow34[k] > peak)
                    peak = this.pow34[k];
            }
            this.sfFloor[b] =
                peak > MAX_QUANT ? Math.min(255, Math.ceil(SF_OFFSET + (16 / 3) * Math.log2(peak / MAX_QUANT))) : 0;
        }
    }
    channelSfFloor() {
        let floor = 0;
        for (let b = 0; b < this.bands.count; b++) {
            if (this.sfFloor[b] > floor)
                floor = this.sfFloor[b];
        }
        return floor;
    }
    quantizeUniform(sf) {
        const { plan, bands } = this;
        plan.scalefactors.fill(sf);
        plan.globalGain = sf;
        this.quantizeBands(0, bands.count);
    }
    quantizeBands(from, to) {
        const { plan, bands, pow34, spectrum } = this;
        const { offsets } = bands;
        for (let b = from; b < to; b++) {
            const sf = plan.scalefactors[b];
            const mult = Math.pow(2, (-3 * (sf - SF_OFFSET)) / 16);
            for (let k = offsets[b]; k < offsets[b + 1]; k++) {
                let q = Math.floor(pow34[k] * mult + 0.4054);
                if (q > MAX_QUANT)
                    q = MAX_QUANT;
                plan.quant[k] = spectrum[k] < 0 ? -q : q;
            }
        }
    }
    bandNoise(b) {
        const { plan, bands, spectrum } = this;
        const { offsets } = bands;
        const step = Math.pow(2, (plan.scalefactors[b] - SF_OFFSET) / 4);
        let noise = 0;
        for (let k = offsets[b]; k < offsets[b + 1]; k++) {
            const q = plan.quant[k] < 0 ? -plan.quant[k] : plan.quant[k];
            const rec = Math.pow(q, 4 / 3) * step;
            const src = spectrum[k] < 0 ? -spectrum[k] : spectrum[k];
            const d = src - rec;
            noise += d * d;
        }
        return noise;
    }
    measureBits() {
        const { plan, bands } = this;
        const { offsets, count } = bands;
        let maxSfb = 0;
        for (let b = count - 1; b >= 0; b--) {
            let nonZero = false;
            for (let k = offsets[b]; k < offsets[b + 1]; k++) {
                if (plan.quant[k] !== 0) {
                    nonZero = true;
                    break;
                }
            }
            if (nonZero) {
                maxSfb = b + 1;
                break;
            }
        }
        plan.maxSfb = maxSfb;
        let spectralBits = 0;
        for (let b = 0; b < maxSfb; b++) {
            const { book, bits } = chooseBook(plan.quant, offsets[b], offsets[b + 1]);
            plan.books[b] = book;
            spectralBits += bits;
        }
        let sectionBits = 0;
        for (let b = 0; b < maxSfb;) {
            let run = 1;
            while (b + run < maxSfb && plan.books[b + run] === plan.books[b])
                run++;
            sectionBits += 4;
            let remaining = run;
            while (remaining >= 31) {
                sectionBits += 5;
                remaining -= 31;
            }
            sectionBits += 5;
            b += run;
        }
        let sfBits = 0;
        let previous = plan.globalGain;
        for (let b = 0; b < maxSfb; b++) {
            if (plan.books[b] === 0)
                continue;
            const dpcm = plan.scalefactors[b] - previous;
            if (dpcm < -SF_MAX_DELTA || dpcm > SF_MAX_DELTA)
                return Number.POSITIVE_INFINITY;
            sfBits += SF_HUFF_BITS[dpcm + SF_MAX_DELTA];
            previous = plan.scalefactors[b];
        }
        plan.bits = 8 + sectionBits + sfBits + 3 + spectralBits;
        return plan.bits;
    }
    computePsy(sampleRate, bitratePerChannel) {
        computeThresholds(this.spectrum, this.bands, sampleRate, bitratePerChannel, this.energy, this.threshold);
    }
}
function writeIcs(sink, coder, bands, writeIcsInfo) {
    const { plan } = coder;
    sink.writeBits(plan.globalGain, 8);
    if (writeIcsInfo)
        writeIcsInfoBits(sink, plan.maxSfb);
    for (let b = 0; b < plan.maxSfb;) {
        let run = 1;
        while (b + run < plan.maxSfb && plan.books[b + run] === plan.books[b])
            run++;
        sink.writeBits(plan.books[b], 4);
        let remaining = run;
        while (remaining >= 31) {
            sink.writeBits(31, 5);
            remaining -= 31;
        }
        sink.writeBits(remaining, 5);
        b += run;
    }
    let previous = plan.globalGain;
    for (let b = 0; b < plan.maxSfb; b++) {
        if (plan.books[b] === 0)
            continue;
        const dpcm = plan.scalefactors[b] - previous;
        sink.writeBits(SF_HUFF_CODES[dpcm + SF_MAX_DELTA], SF_HUFF_BITS[dpcm + SF_MAX_DELTA]);
        previous = plan.scalefactors[b];
    }
    sink.writeBits(0, 1);
    sink.writeBits(0, 1);
    sink.writeBits(0, 1);
    for (let b = 0; b < plan.maxSfb; b++) {
        if (plan.books[b] === 0)
            continue;
        writeSpectral(sink, plan.books[b], plan.quant, bands.offsets[b], bands.offsets[b + 1]);
    }
}
function writeIcsInfoBits(sink, maxSfb) {
    sink.writeBits(0, 1);
    sink.writeBits(0, 2);
    sink.writeBits(0, 1);
    sink.writeBits(maxSfb, 6);
    sink.writeBits(0, 1);
}
class AacLcFrameCore {
    sampleRate;
    channels;
    audioSpecificConfig;
    bands;
    targetBits;
    perChannelRate;
    coders = [];
    block = new Float64Array(FRAME_LEN);
    constructor(sampleRate, channels, bitrateKbps) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        if (channels !== 1 && channels !== 2) {
            throw new EncodeError(`encodeAacLc: unsupported channel count ${channels}`);
        }
        const srIndex = samplingFrequencyIndex(sampleRate);
        this.bands = bandLayout(srIndex);
        const bitrate = Math.max(16 * channels, Math.min(320 * channels, bitrateKbps));
        this.targetBits = Math.floor((bitrate * 1000 * FRAME_LEN) / sampleRate);
        this.perChannelRate = bitrate / channels;
        for (let channel = 0; channel < channels; channel++) {
            this.coders.push(new ChannelCoder(this.bands));
        }
        this.audioSpecificConfig = new Uint8Array(2);
        this.audioSpecificConfig[0] = (2 << 3) | (srIndex >> 1);
        this.audioSpecificConfig[1] = ((srIndex & 1) << 7) | (channels << 3);
    }
    encode(interleaved) {
        if (interleaved.length !== FRAME_LEN * this.channels) {
            throw new EncodeError(`AAC frame needs ${FRAME_LEN * this.channels} PCM samples, got ${interleaved.length}`);
        }
        for (let channel = 0; channel < this.channels; channel++) {
            for (let n = 0; n < FRAME_LEN; n++) {
                this.block[n] = interleaved[n * this.channels + channel] * 65536;
            }
            this.coders[channel].analyze(this.block);
            this.coders[channel].computePsy(this.sampleRate, this.perChannelRate);
        }
        const overhead = this.channels === 1 ? 3 + 4 + 7 + 3 : 3 + 4 + 1 + 8 + 2 + 3 + 7 + 3;
        const payloadTarget = Math.max(200, this.targetBits - overhead);
        let low = 0;
        for (const coder of this.coders)
            low = Math.max(low, coder.channelSfFloor());
        let high = 255;
        if (low > high)
            low = high;
        let fitted = high;
        while (low <= high) {
            const mid = (low + high) >> 1;
            let bits = 0;
            for (const coder of this.coders) {
                coder.quantizeUniform(mid);
                bits += coder.measureBits();
            }
            if (bits <= payloadTarget) {
                fitted = mid;
                high = mid - 1;
            }
            else {
                low = mid + 1;
            }
        }
        for (const coder of this.coders)
            coder.quantizeUniform(fitted);
        for (const coder of this.coders)
            coder.measureBits();
        for (let pass = 0; pass < 24; pass++) {
            let worst = -1;
            let worstRatio = 1.0;
            let worstCoder = null;
            for (const coder of this.coders) {
                for (let band = 0; band < coder.plan.maxSfb; band++) {
                    if (coder.threshold[band] <= 0)
                        continue;
                    const sf = coder.plan.scalefactors[band];
                    if (coder.plan.globalGain - sf >= SF_MAX_DELTA || sf <= 0)
                        continue;
                    if (sf - 2 < coder.sfFloor[band])
                        continue;
                    const ratio = coder.bandNoise(band) / coder.threshold[band];
                    if (ratio > worstRatio) {
                        worstRatio = ratio;
                        worst = band;
                        worstCoder = coder;
                    }
                }
            }
            if (!worstCoder || worst < 0)
                break;
            const plan = worstCoder.plan;
            const savedSf = plan.scalefactors[worst];
            plan.scalefactors[worst] = savedSf - 2;
            worstCoder.quantizeBands(worst, worst + 1);
            let bits = 0;
            for (const coder of this.coders)
                bits += coder.measureBits();
            if (bits > payloadTarget) {
                plan.scalefactors[worst] = savedSf;
                worstCoder.quantizeBands(worst, worst + 1);
                for (const coder of this.coders)
                    coder.measureBits();
                break;
            }
        }
        const sink = new BitSink();
        if (this.channels === 1) {
            sink.writeBits(0, 3);
            sink.writeBits(0, 4);
            writeIcs(sink, this.coders[0], this.bands, true);
        }
        else {
            const maxSfb = Math.max(this.coders[0].plan.maxSfb, this.coders[1].plan.maxSfb);
            for (const coder of this.coders) {
                for (let band = coder.plan.maxSfb; band < maxSfb; band++)
                    coder.plan.books[band] = 0;
                coder.plan.maxSfb = maxSfb;
            }
            sink.writeBits(1, 3);
            sink.writeBits(0, 4);
            sink.writeBits(1, 1);
            writeIcsInfoBits(sink, maxSfb);
            sink.writeBits(0, 2);
            writeIcs(sink, this.coders[0], this.bands, false);
            writeIcs(sink, this.coders[1], this.bands, false);
        }
        sink.writeBits(7, 3);
        sink.alignByte();
        return sink.toUint8Array();
    }
}
export class StreamingAacLcEncoder {
    sampleRate;
    channels;
    options;
    queue;
    core;
    collected = [];
    expectedEncodedFrames;
    inputFrames = 0;
    encodedFrames = 0;
    sealed = false;
    constructor(sampleRate, channels, bitrateKbps, options = {}) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.options = options;
        this.queue = new InterleavedPcmQueue(channels);
        this.core = new AacLcFrameCore(sampleRate, channels, bitrateKbps);
        this.expectedEncodedFrames =
            options.expectedInputFrames === undefined
                ? null
                : Math.ceil(Math.max(0, options.expectedInputFrames) / FRAME_LEN) + 1;
    }
    get framesReceived() {
        return this.inputFrames;
    }
    get framesProduced() {
        return this.encodedFrames;
    }
    get peakBufferedFrames() {
        return this.queue.peakBufferedFrames;
    }
    get audioSpecificConfig() {
        return this.core.audioSpecificConfig.slice();
    }
    pushPlanar(channels) {
        this.assertOpen();
        const frames = channels[0]?.length ?? 0;
        this.queue.pushPlanar(channels);
        this.inputFrames += frames;
        this.drainCompleteFrames();
    }
    pushInterleaved(pcm) {
        this.assertOpen();
        const frames = pcm.length / this.channels;
        this.queue.pushInterleaved(pcm);
        this.inputFrames += frames;
        this.drainCompleteFrames();
    }
    finish() {
        this.assertOpen();
        this.sealed = true;
        if (this.inputFrames === 0)
            throw new EncodeError('encodeAacLc: empty input');
        if (this.queue.bufferedFrames > 0) {
            this.emit(this.queue.takeFrames(FRAME_LEN, true));
        }
        this.emit(new Float32Array(FRAME_LEN * this.channels));
        return {
            frames: this.collected,
            audioSpecificConfig: this.audioSpecificConfig,
            sampleRate: this.sampleRate,
            channels: this.channels,
            samplesPerFrame: FRAME_LEN,
        };
    }
    assertOpen() {
        if (this.sealed)
            throw new EncodeError('AAC encoder received PCM after finish');
    }
    drainCompleteFrames() {
        while (this.queue.bufferedFrames >= FRAME_LEN) {
            this.emit(this.queue.takeFrames(FRAME_LEN));
        }
    }
    emit(pcm) {
        const frame = this.core.encode(pcm);
        const index = this.encodedFrames++;
        this.options.onFrame?.(frame, index);
        if (this.options.collectFrames !== false || !this.options.onFrame)
            this.collected.push(frame);
        this.options.onProgress?.(this.encodedFrames, this.expectedEncodedFrames ?? this.encodedFrames);
    }
}
export async function encodeAacLcAsync(pcm, sampleRate, channels, bitrateKbps, options = {}) {
    const yieldEvery = Math.max(1, options.yieldEvery ?? 8);
    const steps = encodeAacLcSteps(pcm, sampleRate, channels, bitrateKbps, options);
    let frames = 0;
    for (;;) {
        const step = steps.next();
        if (step.done)
            return step.value;
        frames++;
        if (frames % yieldEvery === 0) {
            if (options.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
}
export function encodeAacLc(pcm, sampleRate, channels, bitrateKbps, options = {}) {
    const steps = encodeAacLcSteps(pcm, sampleRate, channels, bitrateKbps, options);
    for (;;) {
        const step = steps.next();
        if (step.done)
            return step.value;
    }
}
function* encodeAacLcSteps(pcm, sampleRate, channels, bitrateKbps, options = {}) {
    if (channels !== 1 && channels !== 2) {
        throw new EncodeError(`encodeAacLc: unsupported channel count ${channels}`);
    }
    const totalSamples = Math.floor(pcm.length / channels);
    if (totalSamples === 0)
        throw new EncodeError('encodeAacLc: empty input');
    const totalFrames = Math.ceil(totalSamples / FRAME_LEN) + 1;
    const core = new AacLcFrameCore(sampleRate, channels, bitrateKbps);
    const block = new Float32Array(FRAME_LEN * channels);
    const frames = [];
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        block.fill(0);
        const sampleStart = frameIndex * FRAME_LEN * channels;
        const sampleEnd = Math.min(sampleStart + block.length, pcm.length);
        if (sampleStart < sampleEnd)
            block.set(pcm.subarray(sampleStart, sampleEnd));
        frames.push(core.encode(block));
        options.onProgress?.(frameIndex + 1, totalFrames);
        yield;
    }
    return {
        frames,
        audioSpecificConfig: core.audioSpecificConfig.slice(),
        sampleRate,
        channels,
        samplesPerFrame: FRAME_LEN,
    };
}
export function wrapAdts(result) {
    const configuration = getAdtsConfiguration(result.sampleRate, result.channels, 'ENCODE');
    let total = 0;
    for (const frame of result.frames)
        total += getAdtsFrameLength(frame, 'ENCODE');
    const out = new Uint8Array(new ArrayBuffer(total));
    let pos = 0;
    for (const frame of result.frames) {
        const frameLength = frame.length + 7;
        writeAdtsHeader(out, pos, frameLength, configuration);
        out.set(frame, pos + 7);
        pos += frameLength;
    }
    return out;
}
