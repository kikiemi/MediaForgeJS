import { EncodeError } from '../../core/errors/errors';
import { BitSink } from '../../core/bytes/binary-writer';
import {
    SWB_OFFSET_1024,
    SF_HUFF_BITS,
    SF_HUFF_CODES,
    SPECTRAL_BOOKS,
    type SpectralBook,
} from '../../core/codec-config/audio/aac-tables';
import { AAC_SAMPLE_RATES } from '../../core/codec-config/audio/aac-sample-rates';
import { InterleavedPcmQueue } from '../pcm/pcm-queue';
import { pow43 } from '../shared/pow43';

const FRAME_LEN = 1024;
const WINDOW_LEN = 2048;
const SF_OFFSET = 100;
const MAX_QUANT = 8191;
const SF_MAX_DELTA = 60;

class Fft {
    private readonly wr: Float64Array;
    private readonly wi: Float64Array;
    private readonly rev: Uint32Array;

    constructor(private readonly n: number) {
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
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            this.rev[i] = j;
        }
    }

    run(re: Float64Array, im: Float64Array): void {
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
    private readonly fft = new Fft(WINDOW_LEN);
    private readonly preR = new Float64Array(WINDOW_LEN);
    private readonly preI = new Float64Array(WINDOW_LEN);
    private readonly postR = new Float64Array(FRAME_LEN);
    private readonly postI = new Float64Array(FRAME_LEN);
    private readonly re = new Float64Array(WINDOW_LEN);
    private readonly im = new Float64Array(WINDOW_LEN);

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

    run(windowed: Float64Array, out: Float64Array): void {
        const { re, im, preR, preI, postR, postI } = this;
        for (let n = 0; n < WINDOW_LEN; n++) {
            re[n] = windowed[n] * preR[n];
            im[n] = windowed[n] * preI[n];
        }
        this.fft.run(re, im);
        for (let k = 0; k < FRAME_LEN; k++) out[k] = re[k] * postR[k] - im[k] * postI[k];
    }
}

const SINE_WINDOW = (() => {
    const w = new Float64Array(WINDOW_LEN);
    for (let n = 0; n < WINDOW_LEN; n++) w[n] = Math.sin((Math.PI / WINDOW_LEN) * (n + 0.5));
    return w;
})();

function samplingFrequencyIndex(sampleRate: number): number {
    const index = AAC_SAMPLE_RATES.indexOf(sampleRate);
    if (index < 0) throw new EncodeError(`encodeAac: unsupported sample rate ${sampleRate}`);
    return index;
}

interface BandInfo {
    readonly offsets: Uint16Array;
    readonly count: number;
}

function bandLayout(srIndex: number): BandInfo {
    const offsets = SWB_OFFSET_1024[srIndex];
    return { offsets, count: offsets.length - 1 };
}

function computeThresholds(
    spectrum: Float64Array,
    bands: BandInfo,
    sampleRate: number,
    bitrateKbpsPerChannel: number,
    energyOut: Float64Array,
    thresholdOut: Float64Array,
): void {
    const { offsets, count } = bands;
    for (let b = 0; b < count; b++) {
        let energy = 0;
        for (let k = offsets[b]; k < offsets[b + 1]; k++) energy += spectrum[k] * spectrum[k];
        energyOut[b] = energy;
    }
    const snrDb = Math.min(33, Math.max(12, 8 + bitrateKbpsPerChannel * 0.24));
    const ratio = Math.pow(10, -snrDb / 10);
    for (let b = 0; b < count; b++) {
        let masked = energyOut[b];
        if (b > 0) masked += energyOut[b - 1] * 0.3;
        if (b + 1 < count) masked += energyOut[b + 1] * 0.15;
        const width = offsets[b + 1] - offsets[b];
        const centerHz = ((offsets[b] + offsets[b + 1]) / 2) * (sampleRate / (2 * FRAME_LEN));
        const athDb = centerHz > 14000 ? -48 : centerHz > 9000 ? -66 : -78;
        const athEnergy = Math.pow(10, athDb / 10) * width * 1.0e6;
        thresholdOut[b] = Math.max(masked * ratio, athEnergy);
    }
}

function bandBits(book: SpectralBook, quant: Int32Array, start: number, end: number): number {
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
            } else {
                const mag = v < 0 ? -v : v;
                let coded = mag;
                if (escape && mag >= 16) {
                    coded = 16;
                    let pre = 4;
                    while (1 << (pre + 1) <= mag) pre++;
                    escBits += pre - 4 + 1 + pre;
                }
                if (!escape && mag > lav) return Number.POSITIVE_INFINITY;
                index = index * range + coded;
                if (mag !== 0) signBits++;
                v = mag;
            }
        }
        total += bits[index] + signBits + escBits;
    }
    return total;
}

let pairBitsSecond = 0;

/**
 * Bit counts of two books sharing dim, lav, range and signedness; the second is left in
 * pairBitsSecond.
 */
function pairBits(
    first: SpectralBook,
    second: SpectralBook,
    quant: Int32Array,
    start: number,
    end: number,
): number {
    const { dim, lav, range, signed } = first;
    const bitsA = first.bits;
    const bitsB = second.bits;
    let totalA = 0;
    let totalB = 0;
    if (dim === 4) {
        for (let k = start; k < end; k += 4) {
            const v0 = quant[k]!;
            const v1 = quant[k + 1]!;
            const v2 = quant[k + 2]!;
            const v3 = quant[k + 3]!;
            let index: number;
            let signBits = 0;
            if (signed)
                index =
                    (((v0 + lav) * range + (v1 + lav)) * range + (v2 + lav)) * range + (v3 + lav);
            else {
                const m0 = v0 < 0 ? -v0 : v0;
                const m1 = v1 < 0 ? -v1 : v1;
                const m2 = v2 < 0 ? -v2 : v2;
                const m3 = v3 < 0 ? -v3 : v3;
                index = ((m0 * range + m1) * range + m2) * range + m3;
                signBits =
                    (m0 !== 0 ? 1 : 0) +
                    (m1 !== 0 ? 1 : 0) +
                    (m2 !== 0 ? 1 : 0) +
                    (m3 !== 0 ? 1 : 0);
            }
            totalA += bitsA[index]! + signBits;
            totalB += bitsB[index]! + signBits;
        }
    } else {
        for (let k = start; k < end; k += 2) {
            const v0 = quant[k]!;
            const v1 = quant[k + 1]!;
            let index: number;
            let signBits = 0;
            if (signed) index = (v0 + lav) * range + (v1 + lav);
            else {
                const m0 = v0 < 0 ? -v0 : v0;
                const m1 = v1 < 0 ? -v1 : v1;
                index = m0 * range + m1;
                signBits = (m0 !== 0 ? 1 : 0) + (m1 !== 0 ? 1 : 0);
            }
            totalA += bitsA[index]! + signBits;
            totalB += bitsB[index]! + signBits;
        }
    }
    pairBitsSecond = totalB;
    return totalA;
}

let chosenBits = 0;

/** Returns the cheapest book for the band and leaves its bit count in chosenBits. */
function chooseBook(quant: Int32Array, start: number, end: number): number {
    let maxAbs = 0;
    for (let k = start; k < end; k++) {
        const v = quant[k]! < 0 ? -quant[k]! : quant[k]!;
        if (v > maxAbs) maxAbs = v;
    }
    if (maxAbs === 0) {
        chosenBits = 0;
        return 0;
    }
    if (maxAbs > 12) {
        chosenBits = bandBits(SPECTRAL_BOOKS[11]!, quant, start, end);
        return 11;
    }
    const first = maxAbs <= 1 ? 1 : maxAbs <= 2 ? 3 : maxAbs <= 4 ? 5 : maxAbs <= 7 ? 7 : 9;
    const bitsFirst = pairBits(
        SPECTRAL_BOOKS[first]!,
        SPECTRAL_BOOKS[first + 1]!,
        quant,
        start,
        end,
    );
    if (pairBitsSecond < bitsFirst) {
        chosenBits = pairBitsSecond;
        return first + 1;
    }
    chosenBits = bitsFirst;
    return first;
}

const SF_GAIN_MULT = new Float64Array(256);
const SF_STEP = new Float64Array(256);
for (let sf = 0; sf < 256; sf++) {
    SF_GAIN_MULT[sf] = Math.pow(2, (-3 * (sf - SF_OFFSET)) / 16);
    SF_STEP[sf] = Math.pow(2, (sf - SF_OFFSET) / 4);
}

function writeSpectral(
    sink: BitSink,
    bookIndex: number,
    quant: Int32Array,
    start: number,
    end: number,
): void {
    const book = SPECTRAL_BOOKS[bookIndex] as SpectralBook;
    const { dim, lav, range, signed, codes, bits } = book;
    const escape = lav === 16;
    for (let k = start; k < end; k += dim) {
        let index = 0;
        for (let d = 0; d < dim; d++) {
            const v = quant[k + d];
            if (signed) {
                index = index * range + (v + lav);
            } else {
                const mag = v < 0 ? -v : v;
                index = index * range + (escape && mag >= 16 ? 16 : mag);
            }
        }
        sink.writeBits(codes[index], bits[index]);
        if (!signed) {
            for (let d = 0; d < dim; d++) {
                const v = quant[k + d];
                if (v !== 0) sink.writeBits(v < 0 ? 1 : 0, 1);
            }
        }
        if (escape) {
            for (let d = 0; d < dim; d++) {
                const mag = quant[k + d] < 0 ? -quant[k + d] : quant[k + d];
                if (mag >= 16) {
                    let pre = 4;
                    while (1 << (pre + 1) <= mag) pre++;
                    for (let i = 0; i < pre - 4; i++) sink.writeBits(1, 1);
                    sink.writeBits(0, 1);
                    sink.writeBits(mag - (1 << pre), pre);
                }
            }
        }
    }
}

interface ChannelPlan {
    readonly quant: Int32Array;
    readonly scalefactors: Int32Array;
    readonly books: Int32Array;
    globalGain: number;
    maxSfb: number;
    bits: number;
}

class ChannelCoder {
    readonly spectrum = new Float64Array(FRAME_LEN);
    /**
     * |x|^0.75 from square roots; within 4e-16 relative of Math.pow, which exact34 holds once
     * computed (NaN before).
     */
    private readonly approx34 = new Float64Array(FRAME_LEN);
    private readonly exact34 = new Float64Array(FRAME_LEN);
    /** -1 for negative spectral lines, 0 otherwise. */
    private readonly signMask = new Int32Array(FRAME_LEN);
    readonly energy: Float64Array;
    readonly threshold: Float64Array;
    readonly plan: ChannelPlan;
    private readonly overlap = new Float64Array(FRAME_LEN);
    private readonly windowed = new Float64Array(WINDOW_LEN);
    private readonly mdct = new Mdct();

    readonly sfFloor: Int32Array;
    /**
     * Per-band noise and book choice of the current quantization; cleared when a band is
     * requantized.
     */
    private readonly noise: Float64Array;
    private readonly noiseValid: Uint8Array;
    private readonly book: Int32Array;
    private readonly bookBits: Float64Array;
    private readonly bookValid: Uint8Array;

    constructor(private readonly bands: BandInfo) {
        this.energy = new Float64Array(bands.count);
        this.threshold = new Float64Array(bands.count);
        this.sfFloor = new Int32Array(bands.count);
        this.noise = new Float64Array(bands.count);
        this.noiseValid = new Uint8Array(bands.count);
        this.book = new Int32Array(bands.count);
        this.bookBits = new Float64Array(bands.count);
        this.bookValid = new Uint8Array(bands.count);
        this.plan = {
            quant: new Int32Array(FRAME_LEN),
            scalefactors: new Int32Array(bands.count),
            books: new Int32Array(bands.count),
            globalGain: 0,
            maxSfb: bands.count,
            bits: 0,
        };
    }

    analyze(current: Float64Array): void {
        const { windowed, overlap } = this;
        for (let n = 0; n < FRAME_LEN; n++) {
            windowed[n] = overlap[n] * SINE_WINDOW[n];
            windowed[FRAME_LEN + n] = current[n] * SINE_WINDOW[FRAME_LEN + n];
        }
        overlap.set(current);
        this.mdct.run(windowed, this.spectrum);
        const { approx34, exact34, spectrum } = this;
        for (let k = 0; k < FRAME_LEN; k++) {
            const v = spectrum[k]!;
            const root = Math.sqrt(v < 0 ? -v : v);
            approx34[k] = root * Math.sqrt(root);
            this.signMask[k] = v < 0 ? -1 : 0;
        }
        exact34.fill(Number.NaN);
        this.noiseValid.fill(0);
        this.bookValid.fill(0);
        const { offsets, count } = this.bands;
        for (let b = 0; b < count; b++) {
            let approxPeak = 0;
            for (let k = offsets[b]!; k < offsets[b + 1]!; k++) {
                if (approx34[k]! > approxPeak) approxPeak = approx34[k]!;
            }
            if (approxPeak <= MAX_QUANT * (1 - 1e-9)) {
                this.sfFloor[b] = 0;
                continue;
            }
            let peak = 0;
            for (let k = offsets[b]!; k < offsets[b + 1]!; k++) {
                const exact = this.exactPow34(k);
                if (exact > peak) peak = exact;
            }
            this.sfFloor[b] =
                peak > MAX_QUANT
                    ? Math.min(255, Math.ceil(SF_OFFSET + (16 / 3) * Math.log2(peak / MAX_QUANT)))
                    : 0;
        }
    }

    private exactPow34(k: number): number {
        let exact = this.exact34[k]!;
        if (exact !== exact) {
            const v = this.spectrum[k]!;
            exact = Math.pow(v < 0 ? -v : v, 0.75);
            this.exact34[k] = exact;
        }
        return exact;
    }

    channelSfFloor(): number {
        let floor = 0;
        for (let b = 0; b < this.bands.count; b++) {
            if (this.sfFloor[b] > floor) floor = this.sfFloor[b];
        }
        return floor;
    }

    quantizeUniform(sf: number): void {
        const { plan, bands } = this;
        plan.scalefactors.fill(sf);
        plan.globalGain = sf;
        this.quantizeBands(0, bands.count);
    }

    quantizeBands(from: number, to: number): void {
        const { plan, bands, approx34, signMask } = this;
        const { offsets } = bands;
        const quant = plan.quant;
        for (let b = from; b < to; b++) {
            const sf = plan.scalefactors[b]!;
            const mult =
                sf >= 0 && sf < 256 ? SF_GAIN_MULT[sf]! : Math.pow(2, (-3 * (sf - SF_OFFSET)) / 16);
            for (let k = offsets[b]!; k < offsets[b + 1]!; k++) {
                const scaled = approx34[k]! * mult + 0.4054;
                let q = Math.floor(scaled);
                const margin = 1e-9 * (scaled + 1);
                if (scaled - q < margin || scaled - q > 1 - margin)
                    q = Math.floor(this.exactPow34(k) * mult + 0.4054);
                if (q > MAX_QUANT) q = MAX_QUANT;
                const sign = signMask[k]!;
                quant[k] = (q ^ sign) - sign;
            }
            this.noiseValid[b] = 0;
            this.bookValid[b] = 0;
        }
    }

    bandNoise(b: number): number {
        if (this.noiseValid[b]) return this.noise[b]!;
        const { plan, bands, spectrum } = this;
        const { offsets } = bands;
        const sf = plan.scalefactors[b]!;
        const step = sf >= 0 && sf < 256 ? SF_STEP[sf]! : Math.pow(2, (sf - SF_OFFSET) / 4);
        let noise = 0;
        for (let k = offsets[b]!; k < offsets[b + 1]!; k++) {
            const q = plan.quant[k]! < 0 ? -plan.quant[k]! : plan.quant[k]!;
            const rec = pow43(q) * step;
            const src = spectrum[k]! < 0 ? -spectrum[k]! : spectrum[k]!;
            const d = src - rec;
            noise += d * d;
        }
        this.noise[b] = noise;
        this.noiseValid[b] = 1;
        return noise;
    }

    measureBits(): number {
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
            if (!this.bookValid[b]) {
                this.book[b] = chooseBook(plan.quant, offsets[b]!, offsets[b + 1]!);
                this.bookBits[b] = chosenBits;
                this.bookValid[b] = 1;
            }
            plan.books[b] = this.book[b]!;
            spectralBits += this.bookBits[b]!;
        }

        let sectionBits = 0;
        for (let b = 0; b < maxSfb;) {
            let run = 1;
            while (b + run < maxSfb && plan.books[b + run] === plan.books[b]) run++;
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
            if (plan.books[b] === 0) continue;
            const dpcm = plan.scalefactors[b] - previous;
            if (dpcm < -SF_MAX_DELTA || dpcm > SF_MAX_DELTA) return Number.POSITIVE_INFINITY;
            sfBits += SF_HUFF_BITS[dpcm + SF_MAX_DELTA];
            previous = plan.scalefactors[b];
        }

        plan.bits = 8 + sectionBits + sfBits + 3 + spectralBits;
        return plan.bits;
    }

    computePsy(sampleRate: number, bitratePerChannel: number): void {
        computeThresholds(
            this.spectrum,
            this.bands,
            sampleRate,
            bitratePerChannel,
            this.energy,
            this.threshold,
        );
    }
}

function writeIcs(
    sink: BitSink,
    coder: ChannelCoder,
    bands: BandInfo,
    writeIcsInfo: boolean,
): void {
    const { plan } = coder;
    sink.writeBits(plan.globalGain, 8);
    if (writeIcsInfo) writeIcsInfoBits(sink, plan.maxSfb);

    for (let b = 0; b < plan.maxSfb;) {
        let run = 1;
        while (b + run < plan.maxSfb && plan.books[b + run] === plan.books[b]) run++;
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
        if (plan.books[b] === 0) continue;
        const dpcm = plan.scalefactors[b] - previous;
        sink.writeBits(SF_HUFF_CODES[dpcm + SF_MAX_DELTA], SF_HUFF_BITS[dpcm + SF_MAX_DELTA]);
        previous = plan.scalefactors[b];
    }

    sink.writeBits(0, 1);
    sink.writeBits(0, 1);
    sink.writeBits(0, 1);

    for (let b = 0; b < plan.maxSfb; b++) {
        if (plan.books[b] === 0) continue;
        writeSpectral(sink, plan.books[b], plan.quant, bands.offsets[b], bands.offsets[b + 1]);
    }
}

function writeIcsInfoBits(sink: BitSink, maxSfb: number): void {
    sink.writeBits(0, 1);
    sink.writeBits(0, 2);
    sink.writeBits(0, 1);
    sink.writeBits(maxSfb, 6);
    sink.writeBits(0, 1);
}

class AacLcFrameCore {
    readonly audioSpecificConfig: Uint8Array;
    private readonly bands: BandInfo;
    private readonly targetBits: number;
    private readonly perChannelRate: number;
    private readonly coders: ChannelCoder[] = [];
    private readonly block = new Float64Array(FRAME_LEN);

    constructor(
        readonly sampleRate: number,
        readonly channels: number,
        bitrateKbps: number,
    ) {
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

    encode(interleaved: Float32Array): Uint8Array {
        if (interleaved.length !== FRAME_LEN * this.channels) {
            throw new EncodeError(
                `AAC frame needs ${FRAME_LEN * this.channels} PCM samples, got ` +
                    `${interleaved.length}`,
            );
        }
        for (let channel = 0; channel < this.channels; channel++) {
            for (let n = 0; n < FRAME_LEN; n++) {
                this.block[n] = interleaved[n * this.channels + channel]! * 65536;
            }
            this.coders[channel]!.analyze(this.block);
            this.coders[channel]!.computePsy(this.sampleRate, this.perChannelRate);
        }

        const overhead = this.channels === 1 ? 3 + 4 + 7 + 3 : 3 + 4 + 1 + 8 + 2 + 3 + 7 + 3;
        const payloadTarget = Math.max(200, this.targetBits - overhead);

        let low = 0;
        for (const coder of this.coders) low = Math.max(low, coder.channelSfFloor());
        let high = 255;
        if (low > high) low = high;
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
            } else {
                low = mid + 1;
            }
        }
        for (const coder of this.coders) coder.quantizeUniform(fitted);
        for (const coder of this.coders) coder.measureBits();

        for (let pass = 0; pass < 24; pass++) {
            let worst = -1;
            let worstRatio = 1.0;
            let worstCoder: ChannelCoder | null = null;
            for (const coder of this.coders) {
                for (let band = 0; band < coder.plan.maxSfb; band++) {
                    if (coder.threshold[band] <= 0) continue;
                    const sf = coder.plan.scalefactors[band];
                    if (coder.plan.globalGain - sf >= SF_MAX_DELTA || sf <= 0) continue;
                    if (sf - 2 < coder.sfFloor[band]) continue;
                    const ratio = coder.bandNoise(band) / coder.threshold[band];
                    if (ratio > worstRatio) {
                        worstRatio = ratio;
                        worst = band;
                        worstCoder = coder;
                    }
                }
            }
            if (!worstCoder || worst < 0) break;
            const plan = worstCoder.plan;
            const savedSf = plan.scalefactors[worst];
            plan.scalefactors[worst] = savedSf - 2;
            worstCoder.quantizeBands(worst, worst + 1);
            let bits = 0;
            for (const coder of this.coders) bits += coder.measureBits();
            if (bits > payloadTarget) {
                plan.scalefactors[worst] = savedSf;
                worstCoder.quantizeBands(worst, worst + 1);
                for (const coder of this.coders) coder.measureBits();
                break;
            }
        }

        const sink = new BitSink();
        if (this.channels === 1) {
            sink.writeBits(0, 3);
            sink.writeBits(0, 4);
            writeIcs(sink, this.coders[0]!, this.bands, true);
        } else {
            const maxSfb = Math.max(this.coders[0]!.plan.maxSfb, this.coders[1]!.plan.maxSfb);
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
            writeIcs(sink, this.coders[0]!, this.bands, false);
            writeIcs(sink, this.coders[1]!, this.bands, false);
        }
        sink.writeBits(7, 3);
        sink.alignByte();
        return sink.toUint8Array();
    }
}

export interface AacEncodeOptions {
    readonly onProgress?: (encodedFrames: number, totalFrames: number) => void;
}

export interface AacEncodeResult {
    readonly frames: Uint8Array[];
    readonly audioSpecificConfig: Uint8Array;
    readonly sampleRate: number;
    readonly channels: number;
    readonly samplesPerFrame: number;
}

interface StreamingAacEncodeOptions extends AacEncodeOptions {
    readonly expectedInputFrames?: number;
    readonly onFrame?: (frame: Uint8Array, frameIndex: number) => void;
    readonly collectFrames?: boolean;
}

/** Incremental AAC-LC encoder retaining at most one partial 1,024-frame block. */
export class StreamingAacLcEncoder {
    private readonly queue: InterleavedPcmQueue;
    private readonly core: AacLcFrameCore;
    private readonly collected: Uint8Array[] = [];
    private readonly expectedEncodedFrames: number | null;
    private inputFrames = 0;
    private encodedFrames = 0;
    private sealed = false;

    constructor(
        readonly sampleRate: number,
        readonly channels: number,
        bitrateKbps: number,
        private readonly options: StreamingAacEncodeOptions = {},
    ) {
        this.queue = new InterleavedPcmQueue(channels);
        this.core = new AacLcFrameCore(sampleRate, channels, bitrateKbps);
        this.expectedEncodedFrames =
            options.expectedInputFrames === undefined
                ? null
                : Math.ceil(Math.max(0, options.expectedInputFrames) / FRAME_LEN) + 1;
    }

    get framesReceived(): number {
        return this.inputFrames;
    }
    get framesProduced(): number {
        return this.encodedFrames;
    }
    get peakBufferedFrames(): number {
        return this.queue.peakBufferedFrames;
    }
    get audioSpecificConfig(): Uint8Array {
        return this.core.audioSpecificConfig.slice();
    }

    pushPlanar(channels: readonly Float32Array[]): void {
        this.assertOpen();
        const frames = channels[0]?.length ?? 0;
        this.queue.pushPlanar(channels);
        this.inputFrames += frames;
        this.drainCompleteFrames();
    }

    finish(): AacEncodeResult {
        this.assertOpen();
        this.sealed = true;
        if (this.inputFrames === 0) throw new EncodeError('encodeAacLc: empty input');
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

    private assertOpen(): void {
        if (this.sealed) throw new EncodeError('AAC encoder received PCM after finish');
    }

    private drainCompleteFrames(): void {
        while (this.queue.bufferedFrames >= FRAME_LEN) {
            this.emit(this.queue.takeFrames(FRAME_LEN));
        }
    }

    private emit(pcm: Float32Array): void {
        const frame = this.core.encode(pcm);
        const index = this.encodedFrames++;
        this.options.onFrame?.(frame, index);
        if (this.options.collectFrames !== false || !this.options.onFrame)
            this.collected.push(frame);
        this.options.onProgress?.(
            this.encodedFrames,
            this.expectedEncodedFrames ?? this.encodedFrames,
        );
    }
}
