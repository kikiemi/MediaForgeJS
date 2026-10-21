import { MemorySink } from '../../core/io/sinks/sinks';
import { EncodeError, throwIfAborted } from '../../core/errors/errors';
import type { MpegAudioEncodeOptions } from './types';
import { ANALYSIS_HISTORY, analysisFilterbank } from './analysis-filterbank';
import { FrameSizer, MPEG1_SAMPLE_RATES } from './common';
import { pow43Table } from '../shared/pow43';
import {
    MP3_ENCODER_DELAY,
    MPEG1_LAYER3_BITRATES,
} from '../../core/codec-config/audio/mpeg-audio-header';

/** Bitrates by header index, without the reserved last one. */
const BITRATES = MPEG1_LAYER3_BITRATES.slice(0, 15);
import { InterleavedPcmQueue } from '../pcm/pcm-queue';
import {
    SFB_L,
    SFB_S,
    SFC_SLEN,
    LONG_BLOCK_SCF_BANDS,
    LONG_BLOCK_SCF_SPLIT,
    SHORT_BLOCK_SCF_BANDS,
    SHORT_BLOCK_SCF_SPLIT,
    GLOBAL_GAIN_BIAS,
    HT0,
    HT32,
    HT33,
    HTABLES,
    PAIR_TABLES,
    Bits,
    mdctGranule,
    applyFrequencyInversion,
    applyAntialias,
    tableMaxValue,
} from './mp3-tables';

const MP3_SAMPLES_PER_FRAME = 1152;
const XING_INFO_SIZE = 156;

function mp3GaplessInfoFrameSize(
    sampleRate: number,
    channels: number,
    requestedBitrate: number,
): number {
    const sampleRateIndex = MPEG1_SAMPLE_RATES.indexOf(sampleRate);
    const requestedBitrateIndex = BITRATES.indexOf(requestedBitrate);
    if (sampleRateIndex < 0 || requestedBitrateIndex < 1) {
        throw new EncodeError('encodeMp3: cannot construct gapless Info frame');
    }
    const bytesNeeded = 4 + (channels === 1 ? 17 : 32) + XING_INFO_SIZE;
    for (let index = requestedBitrateIndex; index < BITRATES.length; index++) {
        const size = Math.floor((144000 * BITRATES[index]!) / sampleRate);
        if (size >= bytesNeeded) return size;
    }
    throw new EncodeError('encodeMp3: bitrate is too small for gapless metadata');
}

function writeU32BE(target: Uint8Array, offset: number, value: number): void {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
}

function createGaplessInfoFrame(
    sampleRate: number,
    channels: number,
    requestedBitrate: number,
    audioFrameCount: number,
    audioByteLength: number,
    sourceFrameCount: number,
    vbr = false,
    tocCumulativeBytes: Float64Array | null = null,
): Uint8Array<ArrayBuffer> {
    const sampleRateIndex = MPEG1_SAMPLE_RATES.indexOf(sampleRate);
    const requestedBitrateIndex = BITRATES.indexOf(requestedBitrate);
    if (sampleRateIndex < 0 || requestedBitrateIndex < 1) {
        throw new EncodeError('encodeMp3: cannot construct gapless Info frame');
    }

    const sideInfoLength = channels === 1 ? 17 : 32;
    const infoOffset = 4 + sideInfoLength;
    const infoFrameSize = mp3GaplessInfoFrameSize(sampleRate, channels, requestedBitrate);

    let infoBitrateIndex = requestedBitrateIndex;
    while (Math.floor((144000 * BITRATES[infoBitrateIndex]!) / sampleRate) < infoFrameSize)
        infoBitrateIndex++;

    const frame = new Uint8Array(infoFrameSize);
    frame[0] = 0xff;
    frame[1] = 0xfb;
    frame[2] = (infoBitrateIndex << 4) | (sampleRateIndex << 2);
    frame[3] = (channels === 1 ? 3 : 1) << 6;

    frame.set(vbr ? [0x58, 0x69, 0x6e, 0x67] : [0x49, 0x6e, 0x66, 0x6f], infoOffset);
    writeU32BE(frame, infoOffset + 4, 0x0f);
    writeU32BE(frame, infoOffset + 8, audioFrameCount);
    writeU32BE(frame, infoOffset + 12, infoFrameSize + audioByteLength);
    if (vbr && tocCumulativeBytes?.length === 100 && audioByteLength > 0) {
        const totalBytes = infoFrameSize + audioByteLength;
        for (let i = 0; i < 100; i++) {
            frame[infoOffset + 16 + i] = Math.min(
                255,
                Math.floor((256 * tocCumulativeBytes[i]!) / totalBytes),
            );
        }
    } else {
        for (let i = 0; i < 100; i++) {
            frame[infoOffset + 16 + i] = Math.min(255, Math.floor((256 * i) / 100));
        }
    }
    writeU32BE(frame, infoOffset + 116, 0);

    frame.set(new TextEncoder().encode('LavfFlowC'), infoOffset + 120);
    const endPadding =
        audioFrameCount * MP3_SAMPLES_PER_FRAME - MP3_ENCODER_DELAY - sourceFrameCount;
    if (endPadding < 0 || endPadding >= 1 << 12) {
        throw new EncodeError(`encodeMp3: invalid gapless padding ${endPadding}`);
    }
    const delayAndPadding = (MP3_ENCODER_DELAY << 12) | endPadding;
    frame[infoOffset + 141] = (delayAndPadding >>> 16) & 0xff;
    frame[infoOffset + 142] = (delayAndPadding >>> 8) & 0xff;
    frame[infoOffset + 143] = delayAndPadding & 0xff;
    writeU32BE(frame, infoOffset + 148, infoFrameSize + audioByteLength);

    return frame;
}

const POW2_ISTEP = (() => {
    const t = new Float64Array(512);
    for (let g = 0; g < 512; g++) t[g] = Math.pow(2.0, -0.1875 * (g - 256));
    return t;
})();
const POW2_RECON = (() => {
    const t = new Float64Array(512);
    for (let g = 0; g < 512; g++) t[g] = Math.pow(2.0, 0.25 * (g - 256));
    return t;
})();
// Band multipliers indexed by scalefacScale * 16 + scalefac (scalefactors stay within 0..15).
const SCALEFAC_QUANT_MUL = new Float64Array(32);
const SCALEFAC_RECON_MUL = new Float64Array(32);
for (let scalefacScale = 0; scalefacScale < 2; scalefacScale++) {
    for (let scalefac = 0; scalefac < 16; scalefac++) {
        SCALEFAC_QUANT_MUL[scalefacScale * 16 + scalefac] = Math.pow(
            2.0,
            0.375 * (scalefacScale + 1) * scalefac,
        );
        SCALEFAC_RECON_MUL[scalefacScale * 16 + scalefac] = Math.pow(
            2.0,
            -0.5 * (scalefacScale + 1) * scalefac,
        );
    }
}

interface GranWork {
    readonly abs: Float64Array;
    /** |x|^0.75 from square roots, within 4e-16 relative of Math.pow (0 at or below 1e-20). */
    readonly xr34: Float64Array;
    readonly weight: Float64Array;
    readonly bandXr34Max: Float64Array;
    readonly bandAbsMax: Float64Array;
    readonly bandEnergy: Float64Array;
    readonly bandSumLog: Float64Array;
    readonly bandTonality: Float64Array;
    /** The masking model of the granule being coded (buildBandModel()). */
    readonly model: BandModel;
    /** -1 for negative spectral lines, 0 otherwise. */
    readonly signMask: Int32Array;
    /** Squared reconstruction error of each band from the last quantize(), summed line by line. */
    readonly bandNoise: Float64Array;
    readonly scratch: Int16Array;
    readonly absQ: Int32Array;
    /**
     * A gain search's coding being made, and the codings it keeps (findGainForBudget()) with their
     * values and band noise.
     */
    readonly trial: GranuleCoding;
    readonly under: GranuleCoding;
    readonly over: GranuleCoding;
    readonly underQ: Int16Array;
    readonly overQ: Int16Array;
    readonly underNoise: Float64Array;
    readonly overNoise: Float64Array;
    /** Where the next gain search starts: the gain of the granule's best quantization so far. */
    lastGain: number;
    /** The gain each channel's last granule took, where its next granule's search starts. */
    readonly channelGains: Int32Array;
    /** The gains the current search has made: those whose entry is seenGeneration. */
    readonly seenGain: Int32Array;
    seenGeneration: number;
}

type BlockType = 0 | 1 | 2 | 3;

// A subblock gain of s rebuilds its window 2^-2s smaller, so the window quantizes x^(3/4) times
// 2^1.5s (what the decoder raises to the 4/3 power).
const SBG_Q = [1, 2 ** 1.5, 8, 2 ** 4.5, 64, 2 ** 7.5, 512, 2 ** 10.5];
const SBG_R = [
    1, 0.25, 0.0625, 0.015625, 0.00390625, 0.0009765625, 0.000244140625, 0.00006103515625,
];
const NO_SBG = new Uint8Array(3);

function reorderShortGranule(
    raw: Float64Array,
    out: Float64Array,
    outOff: number,
    sfb_s: number[],
): void {
    let pos = outOff;
    for (let sfb = 0; sfb < sfb_s.length - 1; sfb++) {
        for (let win = 0; win < 3; win++) {
            for (let line = sfb_s[sfb]!; line < sfb_s[sfb + 1]!; line++) {
                const sb = (line / 6) | 0;
                const m = line - sb * 6;
                out[pos++] = raw[sb * 18 + win * 6 + m]!;
            }
        }
    }
}

function buildShortBounds(sfb_s: number[]): number[] {
    const bounds: number[] = [];
    for (let sfb = 0; sfb < sfb_s.length - 1; sfb++) {
        const base = 3 * sfb_s[sfb]!;
        const width = sfb_s[sfb + 1]! - sfb_s[sfb]!;
        for (let win = 0; win < 3; win++) bounds.push(base + win * width);
    }
    bounds.push(576);
    return bounds;
}

function makeGranWork(bandCount: number): GranWork {
    return {
        abs: new Float64Array(576),
        xr34: new Float64Array(576),
        weight: new Float64Array(576),
        bandXr34Max: new Float64Array(bandCount),
        bandAbsMax: new Float64Array(bandCount),
        bandEnergy: new Float64Array(bandCount),
        bandSumLog: new Float64Array(bandCount),
        bandTonality: new Float64Array(bandCount),
        model: { thresholds: new Float64Array(bandCount), peaks: new Float64Array(bandCount) },
        signMask: new Int32Array(576),
        bandNoise: new Float64Array(bandCount),
        scratch: new Int16Array(576),
        absQ: new Int32Array(576),
        trial: new GranuleCoding(),
        under: new GranuleCoding(),
        over: new GranuleCoding(),
        underQ: new Int16Array(576),
        overQ: new Int16Array(576),
        underNoise: new Float64Array(bandCount),
        overNoise: new Float64Array(bandCount),
        lastGain: -1,
        channelGains: new Int32Array(2).fill(-1),
        seenGain: new Int32Array(256),
        seenGeneration: 0,
    };
}

/** The line and band terms of the granule at spec[off..]; frameXr34 holds |spec|^(3/4). */
function prepareGranule(
    spec: Float64Array,
    off: number,
    frameXr34: Float64Array,
    sfb_l: number[],
    work: GranWork,
): void {
    const { abs, xr34, bandXr34Max, bandAbsMax, bandEnergy, bandSumLog, signMask } = work;
    for (let i = 0; i < 576; i++) {
        const value = spec[off + i]!;
        const a = Math.abs(value);
        signMask[i] = value < 0 ? -1 : 0;
        abs[i] = a;
        xr34[i] = a <= 1e-20 ? 0 : frameXr34[off + i]!;
    }
    const bandCount = sfb_l.length - 1;
    for (let sfb = 0; sfb < bandCount; sfb++) {
        let approxMax = 0;
        let absMax = 0;
        let energy = 0;
        // The logarithm of a product of up to 16 lines at a time: about 1e-12 to 1e2 each, the
        // product stays well within the doubles.
        let sumLog = 0;
        let product = 1;
        let factors = 0;
        for (let i = sfb_l[sfb]!; i < sfb_l[sfb + 1]!; i++) {
            const v = abs[i]!;
            if (xr34[i]! > approxMax) approxMax = xr34[i]!;
            if (v > absMax) absMax = v;
            energy += v * v;
            product *= v + 1e-12;
            if (++factors === 16) {
                sumLog += Math.log(product);
                product = 1;
                factors = 0;
            }
        }
        if (factors > 0) sumLog += Math.log(product);
        // The band's largest |x|^0.75 exactly (Math.pow), among the lines the square roots put
        // within their error of the largest.
        let bandMax = 0;
        const candidateFloor = approxMax * (1 - 1e-12);
        for (let i = sfb_l[sfb]!; i < sfb_l[sfb + 1]!; i++) {
            if (xr34[i]! < candidateFloor || xr34[i] === 0) continue;
            const exact = Math.pow(abs[i]!, 0.75);
            if (exact > bandMax) bandMax = exact;
        }
        bandXr34Max[sfb] = bandMax;
        bandAbsMax[sfb] = absMax;
        bandEnergy[sfb] = energy;
        bandSumLog[sfb] = sumLog;
    }
}

/**
 * Quantizes every band of the granule prepareGranule() left in work into q/absQ and returns the
 * weighted reconstruction error, summed line by line; each band's squared error goes to
 * work.bandNoise. It stops after the first band whose running error passes errorCap and returns
 * that error: the quantization is then unfinished.
 */
function quantize(
    gain: number,
    q: Int16Array,
    absQ: Int32Array,
    scalefactors: Uint8Array,
    scalefacScale: 0 | 1,
    sfb_l: number[],
    scfCount: number,
    sbg: Uint8Array,
    work: GranWork,
    errorCap: number,
): number {
    const baseIstep = POW2_ISTEP[gain - GLOBAL_GAIN_BIAS + 256]!;
    const baseReconScale = POW2_RECON[gain - GLOBAL_GAIN_BIAS + 256]!;
    const { abs, xr34, weight, bandAbsMax, bandXr34Max, signMask, bandNoise } = work;
    const POW43 = pow43Table();
    const scaleBase = scalefacScale * 16;
    const bandCount = sfb_l.length - 1;
    let error = 0;
    for (let sfb = 0; sfb < bandCount; sfb++) {
        const scalefac = sfb < scfCount ? scalefactors[sfb]! : 0;
        const win = sbg === NO_SBG ? 0 : sbg[sfb % 3]!;
        const istep = baseIstep * SCALEFAC_QUANT_MUL[scaleBase + scalefac]! * SBG_Q[win]!;
        const reconScale = baseReconScale * SCALEFAC_RECON_MUL[scaleBase + scalefac]! * SBG_R[win]!;
        const start = sfb_l[sfb]!;
        const end = sfb_l[sfb + 1]!;

        // Every line rounds below 1 and the single candidate 1 is never closer than 0 when
        // reconScale >= 2 * |x|.
        let noise = 0;
        if (bandXr34Max[sfb]! * istep - 0.0946 < 0.5 && 2 * bandAbsMax[sfb]! <= reconScale) {
            for (let i = start; i < end; i++) {
                q[i] = 0;
                absQ[i] = 0;
                const absValue = abs[i]!;
                const squared = absValue * absValue;
                noise += squared;
                error += squared * weight[i]!;
            }
            bandNoise[sfb] = noise;
            if (error > errorCap) return error;
            continue;
        }
        // A line takes round(t - 0.0946) for t = xr34 * istep, or one more when that one's
        // reconstruction is nearer |x| by more than 1e-12. The reconstructions q^(4/3) * reconScale
        // rise with q and the nearest changes from q to q + 1 at t a little past q + 1/2 (0.5946
        // past q for q = 0, under 0.53 past for q >= 1), so the rounding is the nearest value or
        // one below it, and below only when t is more than half past it.
        for (let i = start; i < end; i++) {
            const absValue = abs[i]!;
            // The gain search's floor keeps t below 8206.5 * 2^0.375 (the largest table value, a
            // gain step under the floor's rounding and the probe below it): | 0 is the floor and
            // the table holds vq + 1.
            const t = xr34[i]! * istep;
            let vq = (t + 0.4054) | 0;
            let bestErr = Math.abs(absValue - POW43[vq]! * reconScale);
            if (t - vq > 0.5) {
                const err = Math.abs(absValue - POW43[vq + 1]! * reconScale);
                if (err < bestErr - 1e-12) {
                    bestErr = err;
                    vq++;
                }
            }
            const sign = signMask[i]!;
            q[i] = (vq ^ sign) - sign;
            absQ[i] = vq;
            const squared = bestErr * bestErr;
            noise += squared;
            error += squared * weight[i]!;
        }
        bandNoise[sfb] = noise;
        if (error > errorCap) return error;
    }
    return error;
}

function computeRegions(absQ: Int32Array): [number, number, number] {
    let lastNonZero = -1;
    for (let i = 575; i >= 0; i--) {
        if (absQ[i] !== 0) {
            lastNonZero = i;
            break;
        }
    }
    let count1End = lastNonZero + 1;
    if (count1End % 2 === 1) count1End++;
    let bigEnd = count1End;
    while (
        bigEnd >= 4 &&
        absQ[bigEnd - 1] <= 1 &&
        absQ[bigEnd - 2] <= 1 &&
        absQ[bigEnd - 3] <= 1 &&
        absQ[bigEnd - 4] <= 1
    ) {
        bigEnd -= 4;
    }
    return [bigEnd >> 1, bigEnd, count1End];
}

// Pair-table code lengths with both sign bits folded in, stored at tableId * 256 + hx * 16 + hy.
const PAIR_COST = new Uint8Array(32 * 256);
for (const table of PAIR_TABLES) {
    for (let hx = 0; hx < table.xlen; hx++) {
        for (let hy = 0; hy < table.xlen; hy++) {
            PAIR_COST[table.id * 256 + hx * 16 + hy] =
                table.entries[hx * table.xlen + hy][0] + (hx > 0 ? 1 : 0) + (hy > 0 ? 1 : 0);
        }
    }
}
const ESC_COST_16 = 16 * 256;
const ESC_COST_24 = 24 * 256;
const ESC_LINBITS: readonly (readonly number[])[] = [16, 24].map(first => {
    const linbits: number[] = [];
    for (let id = first; id < first + 8; id++) linbits.push(HTABLES[id]!.linbits);
    return linbits;
});
const SMALL_TABLES = PAIR_TABLES.filter(table => table.linbits === 0);
// Index 0..15 lists the linbits-free tables that hold that maximum value; index 16 is empty.
const SMALL_TABLE_IDS: Uint8Array[] = [];
const SMALL_TABLE_COSTS: Int32Array[] = [];
for (let maxVal = 0; maxVal <= 16; maxVal++) {
    const fits = SMALL_TABLES.filter(table => table.maxval >= maxVal);
    SMALL_TABLE_IDS.push(Uint8Array.from(fits, table => table.id));
    SMALL_TABLE_COSTS.push(Int32Array.from(fits, table => table.id * 256));
}
const HT32_LENGTHS = Uint8Array.from(HT32, entry => entry[0]);

/** Pair-table codewords and their lengths at tableId * 256 + hx * 16 + hy, without sign bits. */
const PAIR_CODES = new Uint32Array(32 * 256);
const PAIR_LENGTHS = new Uint8Array(32 * 256);
for (const table of PAIR_TABLES) {
    for (let hx = 0; hx < table.xlen; hx++) {
        for (let hy = 0; hy < table.xlen; hy++) {
            const [length, code] = table.entries[hx * table.xlen + hy]!;
            PAIR_CODES[table.id * 256 + hx * 16 + hy] = code;
            PAIR_LENGTHS[table.id * 256 + hx * 16 + hy] = length;
        }
    }
}
/** count1 codewords (tables A then B) and their lengths at table * 16 + vwxy. */
const QUAD_CODES = Uint32Array.from([...HT32, ...HT33], entry => entry[1]);
const QUAD_LENGTHS = Uint8Array.from([...HT32, ...HT33], entry => entry[0]);

/** Main data bits, most significant first, into a buffer that starts zeroed. */
class MainDataWriter {
    private acc = 0;
    private accBits = 0;
    private at = 0;

    constructor(private readonly buf: Uint8Array) {}

    /** Bits written so far. */
    get pos(): number {
        return this.at * 8 + this.accBits;
    }

    /** The `count` (up to 24) bits of `value`, which fits them. */
    put(value: number, count: number): void {
        const acc = (this.acc << count) | value;
        let accBits = this.accBits + count;
        while (accBits >= 8) {
            accBits -= 8;
            this.buf[this.at++] = acc >>> accBits;
        }
        this.acc = acc & ((1 << accBits) - 1);
        this.accBits = accBits;
    }

    /** Writes the bits that do not fill a byte. */
    finish(): void {
        if (this.accBits > 0) this.buf[this.at] = this.acc << (8 - this.accBits);
    }
}
const REGION_HIST = new Int32Array(256);
const REGION_SUMS = new Int32Array(16);

/**
 * Returns bits * 32 + table id of the cheapest pair table over lines [lineStart, lineEnd), or -1
 * when none holds maxVal.
 */
function cheapestRegionTable(
    absQ: Int32Array,
    lineStart: number,
    lineEnd: number,
    maxVal: number,
): number {
    if (maxVal === 0) return 0;
    const smallIndex = maxVal <= 15 ? maxVal : 16;
    const smallCosts = SMALL_TABLE_COSTS[smallIndex]!;
    const smallCount = smallCosts.length;
    REGION_SUMS.fill(0, 0, smallCount);
    let escBits16 = 0;
    let escBits24 = 0;
    let escCount = 0;
    const width = maxVal + 1;
    if (maxVal <= 15 && width * width * 2 < lineEnd - lineStart) {
        for (let a = 0; a < width; a++) REGION_HIST.fill(0, a * 16, a * 16 + width);
        for (let i = lineStart; i < lineEnd; i += 2) REGION_HIST[absQ[i] * 16 + absQ[i + 1]]++;
        for (let a = 0; a < width; a++) {
            for (let b = 0; b < width; b++) {
                const idx = a * 16 + b;
                const n = REGION_HIST[idx];
                if (n === 0) continue;
                escBits16 += n * PAIR_COST[ESC_COST_16 + idx];
                escBits24 += n * PAIR_COST[ESC_COST_24 + idx];
                if (a === 15) escCount += n;
                if (b === 15) escCount += n;
                for (let k = 0; k < smallCount; k++)
                    REGION_SUMS[k] += n * PAIR_COST[smallCosts[k] + idx];
            }
        }
    } else {
        for (let i = lineStart; i < lineEnd; i += 2) {
            let hx = absQ[i];
            let hy = absQ[i + 1];
            if (hx >= 15) {
                hx = 15;
                escCount++;
            }
            if (hy >= 15) {
                hy = 15;
                escCount++;
            }
            const idx = hx * 16 + hy;
            escBits16 += PAIR_COST[ESC_COST_16 + idx];
            escBits24 += PAIR_COST[ESC_COST_24 + idx];
            for (let k = 0; k < smallCount; k++) REGION_SUMS[k] += PAIR_COST[smallCosts[k] + idx];
        }
    }
    let bestBits = 0x7fffffff;
    let bestId = -1;
    const smallIds = SMALL_TABLE_IDS[smallIndex]!;
    for (let k = 0; k < smallCount; k++) {
        if (REGION_SUMS[k] < bestBits) {
            bestBits = REGION_SUMS[k];
            bestId = smallIds[k];
        }
    }
    for (let group = 0; group < 2; group++) {
        const linbits = ESC_LINBITS[group]!;
        const base = group === 0 ? escBits16 : escBits24;
        for (let j = 0; j < 8; j++) {
            const lb = linbits[j]!;
            if (15 + (1 << lb) - 1 < maxVal) continue;
            const bits = base + lb * escCount;
            if (bits < bestBits) {
                bestBits = bits;
                bestId = 16 + group * 8 + j;
            }
            break;
        }
    }
    return bestId < 0 ? -1 : bestBits * 32 + bestId;
}

function regionBits(
    absQ: Int32Array,
    pairStart: number,
    pairEnd: number,
    tableSelect: Uint8Array,
    region: number,
): number {
    tableSelect[region] = 0;
    if (pairEnd <= pairStart) return 0;
    const lineStart = pairStart * 2;
    const lineEnd = pairEnd * 2;
    let maxVal = 0;
    for (let i = lineStart; i < lineEnd; i++) if (absQ[i] > maxVal) maxVal = absQ[i];
    const choice = cheapestRegionTable(absQ, lineStart, lineEnd, maxVal);
    if (choice < 0) return -1;
    tableSelect[region] = choice & 31;
    return choice >>> 5;
}

function regionPairBoundaries(
    bigValues: number,
    region0Count: number,
    region1Count: number,
    sfb_l: number[],
): [number, number] {
    const r0Band = Math.min(region0Count + 1, sfb_l.length - 1);
    const r1Band = Math.min(region0Count + 1 + region1Count + 1, sfb_l.length - 1);
    const region0Pairs = Math.min(bigValues, sfb_l[r0Band] >> 1);
    const region1Pairs = Math.min(bigValues, sfb_l[r1Band] >> 1);
    return [region0Pairs, region1Pairs];
}

function computeRegionCounts(bigValues: number, sfb_l: number[]): [number, number] {
    const bigEnd = bigValues * 2;
    let bandEnd = 0;
    while (bandEnd < sfb_l.length - 1 && sfb_l[bandEnd + 1] < bigEnd) bandEnd++;
    const region0 = Math.max(0, Math.min(15, Math.floor(bandEnd / 3) - 1));
    const region1 = Math.max(0, Math.min(7, bandEnd - (region0 + 1) - 1));
    return [region0, region1];
}

function selectRegionTables(
    absQ: Int32Array,
    bigValues: number,
    region0Count: number,
    region1Count: number,
    sfb_l: number[],
    tableSelect: Uint8Array,
): number {
    const [region0Pairs, region1Pairs] = regionPairBoundaries(
        bigValues,
        region0Count,
        region1Count,
        sfb_l,
    );
    const bits0 = regionBits(absQ, 0, region0Pairs, tableSelect, 0);
    const bits1 = regionBits(absQ, region0Pairs, region1Pairs, tableSelect, 1);
    const bits2 = regionBits(absQ, region1Pairs, bigValues, tableSelect, 2);
    return bits0 < 0 || bits1 < 0 || bits2 < 0 ? -1 : bits0 + bits1 + bits2;
}

function selectTwoRegionTables(
    absQ: Int32Array,
    bigValues: number,
    boundaryLine: number,
    tableSelect: Uint8Array,
): number {
    const region0Pairs = Math.min(bigValues, boundaryLine >> 1);
    tableSelect[2] = 0;
    const bits0 = regionBits(absQ, 0, region0Pairs, tableSelect, 0);
    const bits1 = regionBits(absQ, region0Pairs, bigValues, tableSelect, 1);
    return bits0 < 0 || bits1 < 0 ? -1 : bits0 + bits1;
}

interface ScaleFactorProfile {
    readonly scalefacCompress: number;
    readonly scalefacScale: 0 | 1;
    readonly part2Length: number;
    readonly scalefactors: Uint8Array;
}

function pickScaleFactorCompress(
    scalefactors: Uint8Array,
    scalefacScale: 0 | 1,
    scfCount: number,
    scfSplit: number,
): ScaleFactorProfile | null {
    let maxSlen1 = 0;
    let maxSlen2 = 0;
    for (let sfb = 0; sfb < scfCount; sfb++) {
        if (sfb < scfSplit) maxSlen1 = Math.max(maxSlen1, scalefactors[sfb]);
        else maxSlen2 = Math.max(maxSlen2, scalefactors[sfb]);
    }
    let best: ScaleFactorProfile | null = null;
    for (let scalefacCompress = 0; scalefacCompress < SFC_SLEN.length; scalefacCompress++) {
        const [slen1, slen2] = SFC_SLEN[scalefacCompress];
        if (maxSlen1 >= 1 << slen1 || maxSlen2 >= 1 << slen2) continue;
        const part2Length = scfSplit * slen1 + (scfCount - scfSplit) * slen2;
        if (!best || part2Length < best.part2Length)
            best = { scalefacCompress, scalefacScale, part2Length, scalefactors };
    }
    return best;
}

/** ln(10) / 10: a power ratio of d dB is exp(d * DB_TO_POWER_LOG). */
const DB_TO_POWER_LOG = Math.LN10 / 10;

/** Masking thresholds and peaks of the scalefactor bands (the first scfCount entries). */
interface BandModel {
    readonly thresholds: Float64Array;
    readonly peaks: Float64Array;
}

/** Signal-independent terms of the band model for one band layout, sample rate and block kind. */
interface BandGeometry {
    readonly widths: Float64Array;
    readonly bark: Float64Array;
    /**
     * Spreading factor from band j into band b at b * count + j; NaN where the slope is below -40
     * dB.
     */
    readonly spread: Float64Array;
    readonly athAmp: Float64Array;
}

const bandGeometries = new WeakMap<number[], Map<string, BandGeometry>>();

function bandGeometry(
    sfb_l: number[],
    scfCount: number,
    sampleRate: number,
    shortBlock: boolean,
): BandGeometry {
    let byKey = bandGeometries.get(sfb_l);
    if (!byKey) {
        byKey = new Map();
        bandGeometries.set(sfb_l, byKey);
    }
    const key = `${scfCount}:${sampleRate}:${shortBlock ? 1 : 0}`;
    const cached = byKey.get(key);
    if (cached) return cached;
    const widths = new Float64Array(scfCount);
    const bark = new Float64Array(scfCount);
    const spread = new Float64Array(scfCount * scfCount);
    const athAmp = new Float64Array(scfCount);
    if (shortBlock) {
        const binHz = sampleRate / 1152;
        for (let sfb = 0; sfb < scfCount; sfb++) {
            const centerHz = Math.max(20, ((sfb_l[sfb]! + sfb_l[sfb + 1]!) / 2) * binHz);
            const khz = centerHz / 1000;
            const athSpl =
                3.64 * Math.pow(khz, -0.8) -
                6.5 * Math.exp(-0.6 * (khz - 3.3) * (khz - 3.3)) +
                1e-3 * Math.pow(khz, 4);
            athAmp[sfb] = Math.pow(10, (Math.min(athSpl, 40) - 96) / 20);
            widths[sfb] = Math.max(1, sfb_l[sfb + 1]! - sfb_l[sfb]!);
        }
    } else {
        const SPREAD_UP = -13;
        const SPREAD_DOWN = -27;
        for (let sfb = 0; sfb < scfCount; sfb++) {
            const start = sfb_l[sfb]!;
            const end = sfb_l[sfb + 1]!;
            widths[sfb] = Math.max(1, end - start);
            const centerHz = Math.max(20, (((start + end) / 2) * (sampleRate * 0.5)) / 576);
            bark[sfb] =
                13 * Math.atan(0.00076 * centerHz) +
                3.5 * Math.atan((centerHz / 7500) * (centerHz / 7500));
            const centerKhz = Math.max(
                0.02,
                (((sfb_l[sfb]! + sfb_l[sfb + 1]!) / 2) * (sampleRate * 0.5)) / 576 / 1000,
            );
            const athSpl =
                3.64 * Math.pow(centerKhz, -0.8) -
                6.5 * Math.exp(-0.6 * (centerKhz - 3.3) * (centerKhz - 3.3)) +
                1e-3 * Math.pow(centerKhz, 4);
            athAmp[sfb] = Math.pow(10, (Math.min(athSpl, 60) - 96) / 20);
        }
        for (let b = 0; b < scfCount; b++) {
            for (let j = 0; j < scfCount; j++) {
                const dz = bark[b]! - bark[j]!;
                const slopeDb = dz >= 0 ? SPREAD_UP * dz : SPREAD_DOWN * -dz;
                spread[b * scfCount + j] = slopeDb < -40 ? Number.NaN : Math.pow(10, slopeDb / 10);
            }
        }
    }
    const geometry = { widths, bark, spread, athAmp };
    byKey.set(key, geometry);
    return geometry;
}

function buildBandModel(
    sfb_l: number[],
    scfCount: number,
    work: GranWork,
    sampleRate: number,
    bitsPerChannelFrame: number,
    blockType: BlockType,
): BandModel {
    const model = work.model;
    const { thresholds, peaks } = model;
    const tonality = work.bandTonality;
    const { abs, weight, bandEnergy, bandAbsMax, bandSumLog } = work;
    const shortBlock = blockType === 2;
    const geometry = bandGeometry(sfb_l, scfCount, sampleRate, shortBlock);
    const { widths, bark, athAmp } = geometry;
    peaks.set(bandAbsMax.subarray(0, scfCount));

    if (shortBlock) {
        for (let sfb = 0; sfb < scfCount; sfb++) {
            const energy = bandEnergy[sfb]!;
            const width = widths[sfb]!;
            const rms = Math.sqrt(energy / width + 1e-30);
            const flatness = Math.exp(bandSumLog[sfb]! / width) / Math.max(rms, 1e-12);
            const ton = Math.min(1, Math.max(0, (0.6 - flatness) / 0.5));
            tonality[sfb] = 6 + ton * 12;
        }
        const rateBonusDb = Math.min(10, Math.max(-4, (bitsPerChannelFrame - 1600) / 220));
        const athScale = Math.pow(10, (-Math.max(0, rateBonusDb) * 1.5) / 10);
        for (let sfb = 0; sfb < scfCount; sfb++) {
            let acc = bandEnergy[sfb]!;
            let gain = 1;
            for (let j = sfb - 1; j >= 0 && gain > 1e-4; j--) {
                gain *= 0.05;
                acc += bandEnergy[j]! * gain;
            }
            gain = 1;
            for (let j = sfb + 1; j < scfCount && gain > 1e-4; j++) {
                gain *= 0.006;
                acc += bandEnergy[j]! * gain;
            }
            const snrDb = tonality[sfb]! + rateBonusDb;
            const masked = acc * Math.exp(-snrDb * DB_TO_POWER_LOG);
            const amp = athAmp[sfb]!;
            thresholds[sfb] = Math.max(masked, amp * amp * widths[sfb]! * 0.5 * athScale, 1e-14);
        }
        let gp = 0;
        for (let i = 0; i < 576; i++) if (abs[i]! > gp) gp = abs[i]!;
        const invPeak = gp > 1e-18 ? 1 / gp : 0;
        for (let sfb = 0; sfb < scfCount; sfb++) {
            const bandBoost = sfb < 8 ? 1.5 : 0;
            for (let i = sfb_l[sfb]!; i < sfb_l[sfb + 1]!; i++) {
                weight[i] = 1 + 8 * abs[i]! * invPeak + bandBoost;
            }
        }
        for (let i = sfb_l[scfCount]!; i < 576; i++) weight[i] = 1;
        return model;
    }

    let globalSumLog = 0;
    let globalEnergy = 0;
    let globalLines = 0;
    for (let sfb = 0; sfb < scfCount; sfb++) {
        const energy = bandEnergy[sfb]!;
        const sumLog = bandSumLog[sfb]!;
        const width = widths[sfb]!;
        globalSumLog += sumLog;
        globalEnergy += energy;
        globalLines += width;
        const rms = Math.sqrt(energy / width + 1e-30);
        const flatness = Math.exp(sumLog / width) / Math.max(rms, 1e-12);
        tonality[sfb] = Math.min(1, Math.max(0, (0.6 - flatness) / 0.5));
    }
    {
        const gRms = Math.sqrt(globalEnergy / Math.max(1, globalLines) + 1e-30);
        const gFlat = Math.exp(globalSumLog / Math.max(1, globalLines)) / Math.max(gRms, 1e-12);
        const gTon = Math.min(1, Math.max(0, (0.6 - gFlat) / 0.5));
        for (let sfb = 0; sfb < scfCount; sfb++) {
            tonality[sfb] = Math.max(tonality[sfb]!, 0.7 * gTon);
        }
    }

    const spreadFactors = geometry.spread;
    const rateBonusDb = Math.min(10, Math.max(-4, (bitsPerChannelFrame - 1600) / 220));
    const athScale = Math.pow(10, (-Math.max(0, rateBonusDb) * 1.5) / 10);
    let refLog = 0;
    for (let sfb = 0; sfb < scfCount; sfb++) {
        let spread = 0;
        const row = sfb * scfCount;
        for (let j = 0; j < scfCount; j++) {
            const factor = spreadFactors[row + j]!;
            if (factor === factor) spread += bandEnergy[j]! * factor;
        }
        const offsetDb =
            tonality[sfb]! * (14.5 + Math.min(16, bark[sfb]!)) +
            (1 - tonality[sfb]!) * 5.5 +
            rateBonusDb;
        const masked = spread * Math.exp(-offsetDb * DB_TO_POWER_LOG);
        const amp = athAmp[sfb]!;
        const threshold = Math.max(masked, amp * amp * widths[sfb]! * 0.5 * athScale, 1e-14);
        thresholds[sfb] = threshold;
        refLog += Math.log(threshold / widths[sfb]!);
    }
    const refT = Math.exp(refLog / Math.max(1, scfCount));
    for (let sfb = 0; sfb < scfCount; sfb++) {
        const perLine = thresholds[sfb]! / widths[sfb]!;
        const w = Math.min(400, Math.max(0.05, refT / perLine));
        for (let i = sfb_l[sfb]!; i < sfb_l[sfb + 1]!; i++) weight[i] = w;
    }
    for (let i = sfb_l[scfCount]!; i < 576; i++) weight[i] = 1;

    return model;
}

interface BandNoiseMetrics {
    readonly worstRatio: number;
    readonly totalExcess: number;
    readonly loudExcess: number;
    readonly sortedBands: number[];
}

/** Noise to masking threshold of each band of a quantization whose band noise is `noise`. */
function evaluateBandNoise(
    noise: Float64Array,
    scfCount: number,
    model: BandModel,
): BandNoiseMetrics {
    const ratios = new Float64Array(scfCount);
    let worstRatio = 0;
    let totalExcess = 0;
    let loudExcess = 0;
    for (let sfb = 0; sfb < scfCount; sfb++) {
        const ratio = noise[sfb]! / Math.max(model.thresholds[sfb], 1e-18);
        ratios[sfb] = ratio;
        if (ratio > worstRatio) worstRatio = ratio;
        if (ratio > 1) {
            totalExcess += ratio - 1;
            if (sfb < 11) loudExcess += ratio - 1;
        }
    }
    const sortedBands: number[] = new Array<number>(scfCount);
    for (let band = 0; band < scfCount; band++) {
        const ratio = ratios[band]!;
        let at = band;
        while (at > 0 && ratio - ratios[sortedBands[at - 1]!]! > 0) {
            sortedBands[at] = sortedBands[at - 1]!;
            at--;
        }
        sortedBands[at] = band;
    }
    return { worstRatio, totalExcess, loudExcess, sortedBands };
}

function nextScalefactors(
    current: Uint8Array,
    metrics: BandNoiseMetrics,
    model: BandModel,
    maxRank = 3,
    maxChanged = 2,
): Uint8Array | null {
    const next = new Uint8Array(current.length);
    next.set(current);
    let changed = 0;
    for (let rank = 0; rank < metrics.sortedBands.length && rank < maxRank; rank++) {
        const sfb = metrics.sortedBands[rank];
        const maxSf = model.peaks[sfb] > 0.2 ? 15 : 12;
        const boost = rank === 0 ? 2 : 1;
        if (next[sfb] < maxSf) {
            next[sfb] = Math.min(maxSf, next[sfb] + boost);
            changed++;
        }
        if (changed >= maxChanged) break;
    }
    return changed > 0 ? next : null;
}

function quantizePeakPow(
    scalefactors: Uint8Array,
    scalefacScale: 0 | 1,
    sfb_l: number[],
    scfCount: number,
    sbg: Uint8Array,
    work: GranWork,
): number {
    let peakPow = 0;
    const { bandXr34Max } = work;
    const scaleBase = scalefacScale * 16;
    for (let sfb = 0; sfb < sfb_l.length - 1; sfb++) {
        const scalefac = sfb < scfCount ? scalefactors[sfb] : 0;
        const win = sbg === NO_SBG ? 0 : sbg[sfb % 3]!;
        const v = bandXr34Max[sfb] * SCALEFAC_QUANT_MUL[scaleBase + scalefac] * SBG_Q[win]!;
        if (v > peakPow) peakPow = v;
    }
    return peakPow;
}

/** How a granule is coded at one global gain. */
class GranuleCoding {
    blockType: BlockType = 0;
    /** The subblock gains of a short granule's windows (zero otherwise). */
    readonly subblockGain = new Uint8Array(3);
    globalGain = 255;
    bigValues = 0;
    count1Start = 0;
    count1End = 0;
    readonly tableSelect = new Uint8Array(3);
    region0Count = 0;
    region1Count = 0;
    count1Table: 0 | 1 = 0;
    scalefacCompress = 0;
    scalefacScale: 0 | 1 = 0;
    part2Length = 0;
    part23Length = 0;
    /** The weighted reconstruction error of the quantization (quantize()). */
    error = Number.POSITIVE_INFINITY;

    /** A granule without bits: no values at the largest gain. */
    clear(): void {
        this.blockType = 0;
        this.subblockGain.fill(0);
        this.globalGain = 255;
        this.bigValues = 0;
        this.count1Start = 0;
        this.count1End = 0;
        this.tableSelect.fill(0);
        this.region0Count = 0;
        this.region1Count = 0;
        this.count1Table = 0;
        this.scalefacCompress = 0;
        this.scalefacScale = 0;
        this.part2Length = 0;
        this.part23Length = 0;
        this.error = Number.POSITIVE_INFINITY;
    }

    copyFrom(source: GranuleCoding): void {
        this.blockType = source.blockType;
        this.subblockGain.set(source.subblockGain);
        this.globalGain = source.globalGain;
        this.bigValues = source.bigValues;
        this.count1Start = source.count1Start;
        this.count1End = source.count1End;
        this.tableSelect.set(source.tableSelect);
        this.region0Count = source.region0Count;
        this.region1Count = source.region1Count;
        this.count1Table = source.count1Table;
        this.scalefacCompress = source.scalefacCompress;
        this.scalefacScale = source.scalefacScale;
        this.part2Length = source.part2Length;
        this.part23Length = source.part23Length;
        this.error = source.error;
    }
}

/**
 * Codes the values quantize() left in work.absQ at `gain` with `error` into `coding`; false when
 * no table holds them.
 */
function codeGranule(
    coding: GranuleCoding,
    gain: number,
    error: number,
    profile: ScaleFactorProfile,
    sfb_l: number[],
    blockType: BlockType,
    regionBoundary: number,
    sbg: Uint8Array,
    work: GranWork,
): boolean {
    const absQ = work.absQ;
    const [bigValues, count1Start, count1End] = computeRegions(absQ);
    const tableSelect = coding.tableSelect;
    let region0Count = 0;
    let region1Count = 0;
    let bigValueBits: number;
    if (blockType === 0) {
        [region0Count, region1Count] = computeRegionCounts(bigValues, sfb_l);
        bigValueBits = selectRegionTables(
            absQ,
            bigValues,
            region0Count,
            region1Count,
            sfb_l,
            tableSelect,
        );
    } else {
        bigValueBits = selectTwoRegionTables(absQ, bigValues, regionBoundary, tableSelect);
    }
    if (bigValueBits < 0) return false;
    let count1Bits32 = 0;
    let count1SignBits = 0;
    for (let i = count1Start; i < count1End; i += 4) {
        const av = absQ[i];
        const aw = absQ[i + 1];
        const ax = absQ[i + 2];
        const ay = absQ[i + 3];
        count1Bits32 += HT32_LENGTHS[(av ? 8 : 0) | (aw ? 4 : 0) | (ax ? 2 : 0) | (ay ? 1 : 0)];
        count1SignBits += av + aw + ax + ay;
    }
    count1Bits32 += count1SignBits;
    const count1Bits33 = count1End - count1Start + count1SignBits;
    const part3Length = bigValueBits + Math.min(count1Bits32, count1Bits33);
    coding.blockType = blockType;
    coding.subblockGain.set(sbg);
    coding.globalGain = gain;
    coding.bigValues = bigValues;
    coding.count1Start = count1Start;
    coding.count1End = count1End;
    coding.region0Count = region0Count;
    coding.region1Count = region1Count;
    coding.count1Table = count1Bits32 <= count1Bits33 ? 0 : 1;
    coding.scalefacCompress = profile.scalefacCompress;
    coding.scalefacScale = profile.scalefacScale;
    coding.part2Length = profile.part2Length;
    coding.part23Length = profile.part2Length + part3Length;
    coding.error = error;
    return true;
}

/**
 * The global gain of a granule at one scalefactor profile: the smallest whose bits fit the budget,
 * then around it the least-error quantization under the budget (ties: fewer bits), else the
 * smallest over it. Returns work.under or work.over, whose values and band noise are
 * work.underQ/underNoise or work.overQ/overNoise, or null when no quantization codes.
 */
function findGainForBudget(
    targetBudget: number,
    profile: ScaleFactorProfile,
    sfb_l: number[],
    scfCount: number,
    blockType: BlockType,
    regionBoundary: number,
    sbg: Uint8Array,
    work: GranWork,
): GranuleCoding | null {
    const peakPow = quantizePeakPow(
        profile.scalefactors,
        profile.scalefacScale,
        sfb_l,
        scfCount,
        sbg,
        work,
    );
    let lo = 0;
    if (peakPow > 1e-20) {
        const maxTable = HTABLES[31];
        if (maxTable) {
            const minIstep = (tableMaxValue(maxTable) + 0.5) / peakPow;
            lo = Math.floor(GLOBAL_GAIN_BIAS - Math.log2(minIstep) / 0.1875);
            lo = Math.max(0, Math.min(255, lo));
        }
    }
    let hi = 255;
    const { trial, under, over } = work;
    let underKept = false;
    let overKept = false;
    work.seenGeneration++;
    const generation = work.seenGeneration;

    /**
     * Quantizes and codes at `gain`, once per search, keeping it when it beats work.under or
     * work.over. A quantization whose error passes errorCap could not be kept: it stops early.
     * Returns its bits, or -1 when it stopped, does not code or was already made.
     */
    const evaluate = (gain: number, errorCap: number): number => {
        if (work.seenGain[gain] === generation) return -1;
        work.seenGain[gain] = generation;
        const error = quantize(
            gain,
            work.scratch,
            work.absQ,
            profile.scalefactors,
            profile.scalefacScale,
            sfb_l,
            scfCount,
            sbg,
            work,
            errorCap,
        );
        if (error > errorCap) return -1;
        if (!codeGranule(trial, gain, error, profile, sfb_l, blockType, regionBoundary, sbg, work))
            return -1;
        if (trial.part23Length <= targetBudget) {
            if (
                !underKept ||
                trial.error < under.error ||
                (trial.error === under.error && trial.part23Length < under.part23Length)
            ) {
                underKept = true;
                under.copyFrom(trial);
                work.underQ.set(work.scratch);
                work.underNoise.set(work.bandNoise);
            }
        } else if (
            !overKept ||
            trial.part23Length < over.part23Length ||
            (trial.part23Length === over.part23Length && trial.error < over.error)
        ) {
            overKept = true;
            over.copyFrom(trial);
            work.overQ.set(work.scratch);
            work.overNoise.set(work.bandNoise);
        }
        return trial.part23Length;
    };

    // The smallest gain whose granule fits the budget: from the channel's last gain, steps that
    // double until they cross the budget, then halving. Each gain is made once (the brackets
    // hold only gains not yet made), and one that does not code counts as over.
    const fits = (gain: number): boolean => {
        const bits = evaluate(gain, Number.POSITIVE_INFINITY);
        return bits >= 0 && bits <= targetBudget;
    };
    const start = Math.max(lo, Math.min(hi, work.lastGain));
    let step = 1;
    if (fits(start)) {
        hi = start;
        while (hi - step >= lo && fits(hi - step)) {
            hi -= step;
            step *= 2;
        }
        lo = Math.max(lo, hi - step + 1);
    } else {
        lo = start + 1;
        while (lo + step - 1 < hi && !fits(lo + step - 1)) {
            lo += step;
            step *= 2;
        }
        hi = Math.min(hi, lo + step - 1);
    }
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) hi = mid;
        else lo = mid + 1;
    }
    // Around the boundary, the under-budget quantization with the least error wins (ties: fewer
    // bits), so once one is kept a probe stops when its error passes it.
    const center = underKept ? under.globalGain : lo;
    const probeStart = Math.max(0, center - 1);
    const probeEnd = Math.min(255, center + 3);
    for (let g = probeStart; g <= probeEnd; g++) {
        evaluate(g, underKept ? under.error : Number.POSITIVE_INFINITY);
    }

    if (underKept) return under;
    if (overKept) return over;
    return null;
}

/**
 * Codes the granule prepareGranule() left in work into `out` (its values to outQ, its scalefactors
 * to outSf) within targetBudget bits: per scalefactor profile the gain search, the profiles refined
 * by boosting the bands whose noise passes the masking threshold most, the best score kept.
 */
function encodeGranuleFast(
    targetBudget: number,
    sfb_l: number[],
    scfCount: number,
    scfSplit: number,
    blockType: BlockType,
    sampleRate: number,
    work: GranWork,
    outQ: Int16Array,
    outSf: Uint8Array,
    channel: number,
    out: GranuleCoding,
): void {
    outQ.fill(0);
    outSf.fill(0);
    out.clear();
    if (targetBudget <= 0) return;
    const regionBoundary = blockType === 2 ? 36 : (sfb_l[8] ?? 36);
    let sbg: Uint8Array = NO_SBG;
    if (blockType === 2) {
        const winPeak = [0, 0, 0];
        for (let sfb = 0; sfb < scfCount; sfb++) {
            const win = sfb % 3;
            for (let i = sfb_l[sfb]!; i < sfb_l[sfb + 1]!; i++) {
                const a = work.abs[i]!;
                if (a > winPeak[win]!) winPeak[win] = a;
            }
        }
        const maxPeak = Math.max(winPeak[0]!, winPeak[1]!, winPeak[2]!);
        if (maxPeak > 1e-12) {
            const est = new Uint8Array(3);
            let any = false;
            for (let w = 0; w < 3; w++) {
                const ratio = maxPeak / Math.max(winPeak[w]!, maxPeak * 1e-4);
                const steps = Math.max(0, Math.min(7, Math.floor(Math.log2(ratio) / 2)));
                est[w] = steps;
                if (steps > 0) any = true;
            }
            if (any) sbg = est;
        }
    }
    const model = buildBandModel(sfb_l, scfCount, work, sampleRate, targetBudget * 2, blockType);
    let coded = false;
    let bestScore = Number.POSITIVE_INFINITY;

    const maxIter = blockType === 2 ? 6 : 1;
    const boostRank = blockType === 2 ? 6 : 3;
    const boostChanged = blockType === 2 ? 4 : 2;
    // A long granule keeps its scalefactors at zero, which scalefac_scale leaves alone, so it is
    // searched once.
    const scales: readonly (0 | 1)[] = blockType === 2 ? [0, 1] : [0];
    work.lastGain = work.channelGains[channel]!;
    for (const scalefacScale of scales) {
        let scalefactors: Uint8Array = new Uint8Array(scfCount);
        for (let iter = 0; iter < maxIter; iter++) {
            const profile = pickScaleFactorCompress(
                scalefactors,
                scalefacScale,
                scfCount,
                scfSplit,
            );
            if (!profile || profile.part2Length >= targetBudget) break;
            const pick = findGainForBudget(
                targetBudget,
                profile,
                sfb_l,
                scfCount,
                blockType,
                regionBoundary,
                sbg,
                work,
            );
            if (!pick) break;
            const kept = pick === work.under;
            const metrics = evaluateBandNoise(
                kept ? work.underNoise : work.overNoise,
                scfCount,
                model,
            );
            const score =
                pick.error +
                metrics.totalExcess * 450 +
                metrics.loudExcess * 900 +
                metrics.worstRatio * 50;
            if (
                !coded ||
                (pick.part23Length <= targetBudget && out.part23Length > targetBudget) ||
                (pick.part23Length <= targetBudget === out.part23Length <= targetBudget &&
                    score < bestScore - 1e-9)
            ) {
                coded = true;
                out.copyFrom(pick);
                bestScore = score;
                work.lastGain = pick.globalGain;
                outQ.set(kept ? work.underQ : work.overQ);
                outSf.set(profile.scalefactors);
            }
            if (metrics.worstRatio <= 1.05 && metrics.totalExcess <= 0.2) break;
            const next = nextScalefactors(scalefactors, metrics, model, boostRank, boostChanged);
            if (!next) break;
            scalefactors = next;
        }
    }
    work.channelGains[channel] = work.lastGain;
}

/** Bits the reservoir (main_data_begin, 9 bits of bytes) can hold. */
const RESERVOIR_MAX_BITS = 511 * 8;

/**
 * Global gain steps a short granule is quantized coarser than a long one at the same common gain:
 * the error of a short line reaches the output 4.8 dB weaker than the error of a long line.
 */
const SHORT_GAIN_OFFSET = 3;

/** Finer gain steps per dB of energy jump into a short window (onset) and out of it (ahead). */
const ONSET_STEPS_PER_DB = 1 / 1.5;
const AHEAD_STEPS_PER_DB = 2 / 1.5;
const MAX_WINDOW_SHIFT = 24;

/** Frame-to-frame state of the granule bit allocation. */
interface BitAllocation {
    /** Coded over estimated bits by block type, followed as granules are coded. */
    readonly costRatio: number[];
    /** |x|^(3/4) of every line of the frame, from square roots (within 4e-16 of Math.pow). */
    readonly xr34: Float64Array;
    /** The bits allocateFrameBits() gives each granule of the frame. */
    readonly targets: Int32Array;
    /** Energy of each granule's three windows; a long granule counts as three thirds. */
    readonly windowEnergy: Float64Array;
    /** Global gain steps finer than the common gain that each short window is estimated at. */
    readonly windowShift: Float64Array;
    /** Energy of each channel's last window. */
    readonly lastWindowEnergy: Float64Array;
    /** The common gain of the last frame, where the next frame's search starts. */
    lastGain: number;
}

function createBitAllocation(channels: number): BitAllocation {
    return {
        costRatio: [0.8, 0.8, 0.92, 0.8],
        xr34: new Float64Array(channels * 2 * 576),
        targets: new Int32Array(channels * 2),
        windowEnergy: new Float64Array(channels * 2 * 3),
        windowShift: new Float64Array(channels * 2 * 3),
        lastWindowEnergy: new Float64Array(channels),
        lastGain: GLOBAL_GAIN_BIAS,
    };
}

/**
 * Estimated part 3 bits of granule `gi` at a global gain: about 2 + 2 log2(v + 1) bits per line
 * whose scaled magnitude v rounds above zero.
 */
function estimateGranuleBits(
    allocation: BitAllocation,
    gi: number,
    blockType: BlockType,
    gain: number,
    shortBounds: number[],
): number {
    const short = blockType === 2;
    const bandCount = short ? shortBounds.length - 1 : 1;
    const base = gi * 576;
    let lines = 0;
    let logs = 0;
    for (let band = 0; band < bandCount; band++) {
        const shift = short ? allocation.windowShift[gi * 3 + (band % 3)]! : 0;
        const index = Math.round(gain - shift) - GLOBAL_GAIN_BIAS + 256;
        const istep = POW2_ISTEP[Math.max(0, Math.min(511, index))]!;
        const end = base + (short ? shortBounds[band + 1]! : 576);
        // The logarithm of a product of up to 16 factors at a time, each below 2^45.
        let product = 1;
        let factors = 0;
        for (let i = base + (short ? shortBounds[band]! : 0); i < end; i++) {
            const v = allocation.xr34[i]! * istep;
            if (v > 0.4054) {
                lines++;
                product *= v + 1;
                if (++factors === 16) {
                    logs += Math.log2(product);
                    product = 1;
                    factors = 0;
                }
            }
        }
        if (factors > 0) logs += Math.log2(product);
    }
    return 2 * lines + 2 * logs;
}

/**
 * Window energies and the finer gains of short windows. The noise of a short window spreads over
 * all of it, so a window whose energy jumps over the window before it (an onset) and the window
 * just ahead of a jump (which holds the onset's first edge in its overlap) are quantized finer.
 */
function shiftShortWindows(
    allocation: BitAllocation,
    spec: Float64Array,
    energies: Float64Array,
    blockPlan: readonly Uint8Array[],
    channels: number,
    shortBounds: number[],
): void {
    const { windowEnergy, windowShift, lastWindowEnergy } = allocation;
    windowEnergy.fill(0);
    windowShift.fill(0);
    for (let gi = 0; gi < channels * 2; gi++) {
        if (blockPlan[(gi / 2) | 0]![gi % 2] !== 2) {
            windowEnergy.fill(energies[gi]! / 3, gi * 3, gi * 3 + 3);
            continue;
        }
        for (let band = 0; band < shortBounds.length - 1; band++) {
            let energy = 0;
            for (let i = shortBounds[band]!; i < shortBounds[band + 1]!; i++)
                energy += spec[gi * 576 + i]! ** 2;
            windowEnergy[gi * 3 + (band % 3)]! += energy;
        }
    }

    // A channel's six windows in time order, after the last window of its previous frame.
    const riseDb = (from: number, to: number): number =>
        Math.max(0, 10 * Math.log10(Math.max(to, 1e-30) / Math.max(from, 1e-12)));
    for (let ch = 0; ch < channels; ch++) {
        let before = lastWindowEnergy[ch]!;
        for (let k = ch * 6; k < ch * 6 + 6; k++) {
            const short = blockPlan[ch]![((k / 3) | 0) % 2] === 2;
            const energy = windowEnergy[k]!;
            if (short) {
                const onset = ONSET_STEPS_PER_DB * riseDb(before, energy);
                const ahead =
                    k < ch * 6 + 5 ? AHEAD_STEPS_PER_DB * riseDb(energy, windowEnergy[k + 1]!) : 0;
                windowShift[k] = Math.min(MAX_WINDOW_SHIFT, Math.max(onset, ahead));
            }
            before = energy;
        }
        lastWindowEnergy[ch] = before;
    }
}

/**
 * Bits for each granule of a frame from `budget`: the common global gain whose estimated bits
 * fill it, which spreads the frame's quantization noise evenly (short granules
 * SHORT_GAIN_OFFSET coarser and their shifted windows finer). Granules capped at 4095 bits leave
 * the rest to the others.
 */
function allocateFrameBits(
    allocation: BitAllocation,
    blockPlan: readonly Uint8Array[],
    channels: number,
    shortBounds: number[],
    budget: number,
): Int32Array {
    const granules = channels * 2;
    const demands = (gain: number): number[] => {
        const each = new Array<number>(granules);
        for (let gi = 0; gi < granules; gi++) {
            const blockType = blockPlan[(gi / 2) | 0]![gi % 2]! as BlockType;
            const offset = blockType === 2 ? SHORT_GAIN_OFFSET : 0;
            const estimate = estimateGranuleBits(
                allocation,
                gi,
                blockType,
                gain + offset,
                shortBounds,
            );
            each[gi] = Math.min(4095, allocation.costRatio[blockType]! * estimate);
        }
        return each;
    };
    const sum = (each: number[]): number => each.reduce((total, bits) => total + bits, 0);
    // The common gain is the smallest whose demands fit the budget, 255 when none does. The
    // demands fall as the gain rises (each line's estimate does, and the rounded sums keep their
    // order), so every search finds the same gain: this one gallops from the last frame's to a
    // bracket and halves it.
    const fits = (gain: number): boolean => gain >= 255 || sum(demands(gain)) <= budget;
    let lo: number;
    let hi: number;
    let step = 1;
    if (fits(allocation.lastGain)) {
        hi = allocation.lastGain;
        while (hi - step >= 0 && fits(hi - step)) {
            hi -= step;
            step *= 2;
        }
        lo = Math.max(0, hi - step + 1);
    } else {
        lo = allocation.lastGain + 1;
        while (!fits(lo + step - 1)) {
            lo += step;
            step *= 2;
        }
        hi = Math.min(255, lo + step - 1);
    }
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) hi = mid;
        else lo = mid + 1;
    }
    allocation.lastGain = lo;
    const each = demands(lo);
    let open = 0;
    for (const bits of each) if (bits < 4095) open += bits;
    const spare = Math.max(0, budget - sum(each));
    const targets = allocation.targets;
    for (let gi = 0; gi < granules; gi++) {
        const bits = each[gi]!;
        targets[gi] =
            bits >= 4095
                ? 4095
                : Math.min(4095, Math.floor(bits + (spare * bits) / Math.max(1, open)));
    }
    return targets;
}

/** Follows the ratio of coded to estimated bits of the block type of a coded granule. */
function calibrateBitEstimate(
    allocation: BitAllocation,
    gi: number,
    granule: GranuleCoding,
    shortBounds: number[],
): void {
    if (granule.part23Length <= 64) return;
    const blockType = granule.blockType;
    const estimate = estimateGranuleBits(
        allocation,
        gi,
        blockType,
        granule.globalGain,
        shortBounds,
    );
    if (estimate <= 32) return;
    const ratio = granule.part23Length / estimate;
    allocation.costRatio[blockType] = allocation.costRatio[blockType]! * 0.95 + ratio * 0.05;
}

const LOWPASS_TABLE: ReadonlyArray<readonly [number, number]> = [
    [16, 8000],
    [20, 9200],
    [24, 10500],
    [28, 11500],
    [32, 12500],
    [40, 14000],
    [48, 15200],
    [56, 16000],
    [64, 16800],
    [80, 17800],
    [96, 18800],
    [112, 19500],
    [128, 20200],
];

function lowpassCutoffHz(bitrateKbps: number, channels: number): number {
    const perChannel = bitrateKbps / channels;
    if (perChannel >= 160) return Number.POSITIVE_INFINITY;
    for (const [kbps, hz] of LOWPASS_TABLE) {
        if (perChannel <= kbps) return hz;
    }
    return Number.POSITIVE_INFINITY;
}

function applySimpleLowpass(spec: Float64Array, off: number, cutoffLine: number): void {
    const start = Math.max(0, Math.min(576, cutoffLine));
    for (let i = start; i < 576; i++) spec[off + i] = 0;
}

/** Receives the block types of one granule, two bits per channel. */
type Mp3GranulePlanConsumer = (packedBlocks: number) => void;

/**
 * Chooses the block type of each granule from attacks in its 48-sample slots, one granule late.
 * An attack is a slot whose high-passed energy is six times the three slots before it, above an
 * absolute floor, and above half the mean slot energy of the channel, so quiet passages do not
 * switch to short blocks on small changes. The mean is that of the whole input when the caller
 * knows it (a whole-file encode), else that of the input so far.
 */
class Mp3RollingBlockClassifier {
    private readonly highPassPrevious: Float64Array;
    /** High-passed energy and frames of each channel so far, for its mean slot energy. */
    private readonly highPassTotal: Float64Array;
    private readonly highPassFrames: Float64Array;
    /** Each channel's last three slot energies, oldest first, at channel * 3. */
    private readonly slotHistory: Float64Array;
    private readonly slotEnergy = new Float64Array(12);
    private readonly wantNow: Uint8Array;
    private readonly wantNext: Uint8Array;
    private readonly wantAfter: Uint8Array;
    private readonly currentWant: Uint8Array;
    private readonly pendingWant: Uint8Array;
    private readonly previousBlock: Uint8Array;
    private hasPending = false;
    private sealed = false;

    constructor(
        readonly channels: number,
        private readonly wholeMean?: readonly number[],
    ) {
        this.highPassPrevious = new Float64Array(channels);
        this.highPassTotal = new Float64Array(channels);
        this.highPassFrames = new Float64Array(channels);
        this.wantNow = new Uint8Array(channels);
        this.wantNext = new Uint8Array(channels);
        this.wantAfter = new Uint8Array(channels);
        this.currentWant = new Uint8Array(channels);
        this.pendingWant = new Uint8Array(channels);
        this.previousBlock = new Uint8Array(channels);
        this.slotHistory = new Float64Array(channels * 3).fill(1e-3);
    }

    pushGranule(pcm: Float32Array, actualFrames: number, consume: Mp3GranulePlanConsumer): void {
        if (this.sealed) throw new EncodeError('MP3 block classifier received PCM after finish');
        if (pcm.length !== 576 * this.channels) {
            throw new EncodeError(
                `MP3 block classifier needs ${576 * this.channels} samples, got ${pcm.length}`,
            );
        }
        if (!Number.isInteger(actualFrames) || actualFrames < 0 || actualFrames > 576) {
            throw new EncodeError(
                `MP3 block classifier received invalid granule length ${actualFrames}`,
            );
        }

        const history = this.slotHistory;
        const slotEnergy = this.slotEnergy;
        for (let channel = 0; channel < this.channels; channel++) {
            const at = channel * 3;
            for (let slot = 0; slot < 12; slot++) {
                const start = slot * 48;
                const end = Math.min(start + 48, actualFrames);
                let energy = 0;
                for (let frame = start; frame < end; frame++) {
                    const value = pcm[frame * this.channels + channel]!;
                    const difference = value - this.highPassPrevious[channel]!;
                    this.highPassPrevious[channel] = value;
                    energy += difference * difference;
                }
                slotEnergy[slot] = energy;
                this.highPassTotal[channel]! += energy;
            }
            this.highPassFrames[channel]! += actualFrames;

            // The running mean includes this granule, so the first granules compare against
            // themselves.
            const frames = this.highPassFrames[channel]!;
            const meanSlot =
                this.wholeMean?.[channel] ??
                (frames > 0 ? (this.highPassTotal[channel]! / frames) * 48 : 0);
            let attack = false;
            for (let slot = 0; slot < 12; slot++) {
                const energy = slotEnergy[slot]!;
                const reference = Math.max(
                    (history[at]! + history[at + 1]! + history[at + 2]!) / 3,
                    1e-3,
                );
                if (energy > 6 * reference && energy > 0.01 && energy > 0.5 * meanSlot)
                    attack = true;
                history[at] = history[at + 1]!;
                history[at + 1] = history[at + 2]!;
                history[at + 2] = energy;
            }

            let wanted = this.wantNow[channel] !== 0;
            if (attack) {
                wanted = true;
                this.wantNext[channel] = 1;
                this.wantAfter[channel] = 1;
            }
            this.currentWant[channel] = wanted ? 1 : 0;
        }

        if (this.hasPending) this.emitPending(this.currentWant, consume);

        this.pendingWant.set(this.currentWant);
        this.hasPending = true;

        this.wantNow.set(this.wantNext);
        this.wantNext.set(this.wantAfter);
        this.wantAfter.fill(0);
    }

    finish(consume: Mp3GranulePlanConsumer): void {
        if (this.sealed) throw new EncodeError('MP3 block classifier finished twice');
        this.sealed = true;
        if (!this.hasPending) throw new EncodeError('MP3 block classifier received no granules');
        this.currentWant.fill(0);
        this.emitPending(this.currentWant, consume);
        this.hasPending = false;
    }

    private emitPending(nextWant: Uint8Array, consume: Mp3GranulePlanConsumer): void {
        let packed = 0;
        for (let channel = 0; channel < this.channels; channel++) {
            const previous = this.previousBlock[channel]!;
            let block: BlockType;
            if (this.pendingWant[channel] !== 0) block = 2;
            else if (nextWant[channel] !== 0) {
                block = previous === 2 || previous === 1 ? 2 : 1;
            } else block = previous === 2 ? 3 : 0;
            this.previousBlock[channel] = block;
            packed |= block << (channel * 2);
        }
        consume(packed);
    }
}

interface StreamingMp3EncodeOptions extends MpegAudioEncodeOptions {
    readonly onBufferedFrames?: (current: number, peak: number) => void;
    readonly onFrame?: (frame: Uint8Array, frameIndex: number) => void;
    /** False when encoded audio frames are delivered to an external sink. */
    readonly collectFrames?: boolean;
    /** Source frames expected, for progress only; the encoder takes whatever arrives. */
    readonly expectedInputFrames?: number;
    /**
     * Each channel's mean high-passed energy per 48-sample slot over the whole input, when it is
     * known before encoding (mp3SlotEnergyMean()): block switching then weighs attacks against the
     * whole input rather than the input so far.
     */
    readonly slotEnergyMean?: readonly number[];
}

/** Each plane's mean high-passed energy per 48-sample slot, for `slotEnergyMean`. */
export function mp3SlotEnergyMean(planes: readonly Float32Array[]): number[] {
    return planes.map(plane => {
        let previous = 0;
        let total = 0;
        for (let index = 0; index < plane.length; index++) {
            const difference = plane[index]! - previous;
            previous = plane[index]!;
            total += difference * difference;
        }
        return plane.length > 0 ? (total / plane.length) * 48 : 0;
    });
}

interface StreamingMp3Output {
    readonly infoFrame: Uint8Array<ArrayBuffer>;
    /** The audio frames, empty when they went to `onFrame` only. */
    readonly audio: Uint8Array<ArrayBuffer>;
}

/**
 * MPEG-1 Layer III encoder fed PCM in one pass at its own level. Block switching looks one granule
 * ahead, so about a frame of PCM is held. The Info frame with the gapless delay, padding and seek
 * table comes from `finishOutput()`.
 */
export class StreamingMp3Encoder {
    private readonly analysisQueue: InterleavedPcmQueue;
    private readonly encodeQueue: InterleavedPcmQueue;
    private readonly classifier: Mp3RollingBlockClassifier;
    private readonly machine: Generator<void, StreamingMp3Output, Mp3MachineCommand>;
    /** Block types of the classified granules not yet encoded, two bits per channel. */
    private readonly planned: number[] = [];
    private plannedHead = 0;
    private readonly blockScratch: Uint8Array[] = [];
    private receivedFrames = 0;
    private granulesAnalysed = 0;
    private frameIndex = 0;
    private sealed = false;

    /**
     * Bytes of the gapless Info frame that leads a stream of this rate, channel count and bitrate,
     * so that a sink that patches can hold its place before the stream is encoded.
     */
    static infoFrameSize(sampleRate: number, channels: number, bitrate: number): number {
        return mp3GaplessInfoFrameSize(sampleRate, channels, bitrate);
    }

    constructor(
        readonly sampleRate: number,
        readonly channels: number,
        readonly bitrate = 128,
        private readonly options: StreamingMp3EncodeOptions = {},
    ) {
        if (channels !== 1 && channels !== 2) {
            throw new EncodeError(`encodeMp3: channels must be 1 or 2, got ${channels}`);
        }
        this.analysisQueue = new InterleavedPcmQueue(channels);
        this.encodeQueue = new InterleavedPcmQueue(channels);
        this.classifier = new Mp3RollingBlockClassifier(channels, options.slotEnergyMean);
        for (let channel = 0; channel < channels; channel++)
            this.blockScratch.push(new Uint8Array(2));
        const expected = options.expectedInputFrames;
        this.machine = encodeMp3FrameMachine(
            sampleRate,
            channels,
            bitrate,
            options,
            expected && expected > 0 ? Math.ceil(expected / MP3_SAMPLES_PER_FRAME) + 1 : undefined,
        );
        this.machine.next();
    }

    get framesReceived(): number {
        return this.receivedFrames;
    }
    get framesProduced(): number {
        return this.frameIndex;
    }
    get peakBufferedFrames(): number {
        return Math.max(this.analysisQueue.peakBufferedFrames, this.encodeQueue.peakBufferedFrames);
    }

    pushPlanar(planes: readonly Float32Array[]): void {
        this.assertOpen();
        if (planes.length !== this.channels) {
            throw new EncodeError(
                `MP3 stream expected ${this.channels} channels, got ${planes.length}`,
            );
        }

        const frames = planes[0]?.length ?? 0;
        for (let channel = 1; channel < planes.length; channel++) {
            if (planes[channel]!.length !== frames) {
                throw new EncodeError('MP3 stream channel planes have different lengths');
            }
        }

        if (frames === 0) return;
        const interleaved = new Float32Array(frames * this.channels);
        let at = 0;
        for (let frame = 0; frame < frames; frame++)
            for (let channel = 0; channel < this.channels; channel++)
                interleaved[at++] = planes[channel]![frame]!;

        this.analysisQueue.pushInterleaved(interleaved);
        this.encodeQueue.pushInterleaved(interleaved);
        this.receivedFrames += frames;
        while (this.analysisQueue.bufferedFrames >= 576) {
            this.analyseGranule(this.analysisQueue.takeFrames(576), 576);
        }

        this.options.onBufferedFrames?.(this.encodeQueue.bufferedFrames, this.peakBufferedFrames);
    }

    finishOutput(): StreamingMp3Output {
        this.assertOpen();
        this.sealed = true;
        if (this.receivedFrames === 0) throw new EncodeError('encodeMp3: empty input');

        // The stream ends one frame after the source, which the decoder delay pushes into it.
        const totalFrames = Math.ceil(this.receivedFrames / MP3_SAMPLES_PER_FRAME) + 1;
        if (this.analysisQueue.bufferedFrames > 0) {
            const actual = this.analysisQueue.bufferedFrames;
            this.analyseGranule(this.analysisQueue.takeFrames(576, true), actual);
        }
        while (this.granulesAnalysed < totalFrames * 2) {
            this.analyseGranule(new Float32Array(576 * this.channels), 0);
        }
        this.classifier.finish(blocks => this.planned.push(blocks));
        this.drainReadyFrames(true);
        if (this.frameIndex !== totalFrames || this.plannedHead !== this.planned.length) {
            throw new EncodeError('MP3 streaming planner left unconsumed PCM or block plans');
        }
        const result = this.machine.next({
            kind: 'finish',
            sourceFrameCount: this.receivedFrames,
        });
        if (!result.done) throw new EncodeError('MP3 frame machine did not finish');
        return result.value;
    }

    private assertOpen(): void {
        if (this.sealed) throw new EncodeError('MP3 encoder received PCM after finish');
        throwIfAborted(this.options.signal);
    }

    private analyseGranule(pcm: Float32Array, actualFrames: number): void {
        this.classifier.pushGranule(pcm, actualFrames, blocks => this.planned.push(blocks));
        this.granulesAnalysed++;
        this.drainReadyFrames(false);
    }

    /** Encodes every frame whose PCM and two granule plans are ready; at the end pads the PCM. */
    private drainReadyFrames(final: boolean): void {
        while (
            this.plannedHead + 1 < this.planned.length &&
            (final || this.encodeQueue.bufferedFrames >= MP3_SAMPLES_PER_FRAME)
        ) {
            const pcm =
                this.encodeQueue.bufferedFrames > 0
                    ? this.encodeQueue.takeFrames(MP3_SAMPLES_PER_FRAME, true)
                    : new Float32Array(MP3_SAMPLES_PER_FRAME * this.channels);
            this.emit(pcm, this.planned[this.plannedHead]!, this.planned[this.plannedHead + 1]!);
            this.plannedHead += 2;
            if (this.plannedHead >= 1024 && this.plannedHead * 2 >= this.planned.length) {
                this.planned.splice(0, this.plannedHead);
                this.plannedHead = 0;
            }
        }
    }

    private emit(pcm: Float32Array, first: number, second: number): void {
        for (let channel = 0; channel < this.channels; channel++) {
            const shift = channel * 2;
            this.blockScratch[channel]![0] = (first >>> shift) & 3;
            this.blockScratch[channel]![1] = (second >>> shift) & 3;
        }

        let pcmEnergy = 0;
        if (this.options.vbr === true) {
            for (let frame = 0; frame < MP3_SAMPLES_PER_FRAME; frame += 2) {
                const value = pcm[frame * this.channels]!;
                pcmEnergy += value * value;
            }
        }

        const step = this.machine.next({
            kind: 'frame',
            pcm,
            blockPlan: this.blockScratch,
            pcmEnergy,
        });

        if (step.done) throw new EncodeError('MP3 frame machine ended before flush');
        this.frameIndex++;
    }
}

interface Mp3FrameMachineCommand {
    readonly kind: 'frame';
    readonly pcm: Float32Array;
    readonly blockPlan: readonly Uint8Array[];
    readonly pcmEnergy: number;
}

interface Mp3FinishMachineCommand {
    readonly kind: 'finish';
    readonly sourceFrameCount: number;
}

type Mp3MachineCommand = Mp3FrameMachineCommand | Mp3FinishMachineCommand;

/**
 * Encodes each frame as its command arrives. Short blocks are never mixed: the two long subbands
 * of a mixed block take the normal window, which does not overlap-add cleanly with the start and
 * stop windows around a switched run, so their lowest 1 to 1.5 kHz would carry an error no bitrate
 * removes.
 */
function* encodeMp3FrameMachine(
    sampleRate: number,
    channels: number,
    bitrate: number,
    options: StreamingMp3EncodeOptions,
    totalFramesHint?: number,
): Generator<void, StreamingMp3Output, Mp3MachineCommand> {
    if (channels !== 1 && channels !== 2) {
        throw new EncodeError(`encodeMp3: channels must be 1 or 2, got ${channels}`);
    }
    const srIdx = MPEG1_SAMPLE_RATES.indexOf(sampleRate);
    if (srIdx < 0)
        throw new EncodeError(`encodeMp3: sample rate ${sampleRate} is not supported`, {
            hint: 'Use 32000, 44100 or 48000 Hz.',
        });
    const brIdx = BITRATES.indexOf(bitrate);
    if (brIdx < 1) throw new EncodeError(`encodeMp3: unsupported bitrate ${bitrate}`);

    const sfb_l = SFB_L[sampleRate];
    const nch = channels;
    const mono = nch === 1;
    const sideLen = mono ? 17 : 32;
    const sizer = new FrameSizer(bitrate, sampleRate);
    const sink = options.collectFrames === false ? null : new MemorySink();
    let audioByteLength = 0;
    let emittedFrameIndex = 0;

    const cutoffHz = lowpassCutoffHz(bitrate, nch);
    const cutoffLine = Number.isFinite(cutoffHz)
        ? Math.min(576, Math.floor((cutoffHz / (sampleRate * 0.5)) * 576))
        : 576;

    const frame = new Uint8Array(sizer.maxFrameSize);
    const history: Float64Array[] = [];
    for (let ch = 0; ch < nch; ch++) {
        history.push(new Float64Array(ANALYSIS_HISTORY + MP3_SAMPLES_PER_FRAME));
    }
    const prevMdct: Float64Array[] = [];
    for (let ch = 0; ch < nch; ch++) prevMdct.push(new Float64Array(32 * 18));
    const mdctCur = new Float64Array(18);
    const mdctOut = new Float64Array(18);
    const subbands = new Float64Array(nch * 2 * 18 * 32);
    const spec = new Float64Array(nch * 2 * 576);
    const granuleCount = nch * 2;
    const energies = new Float64Array(granuleCount);
    const granQ = new Int16Array(granuleCount * 576);
    const granSf = new Uint8Array(granuleCount * SHORT_BLOCK_SCF_BANDS);
    const sfb_s = SFB_S[sampleRate]!;
    const shortBounds = buildShortBounds(sfb_s);
    const work = makeGranWork(Math.max(sfb_l.length, shortBounds.length) - 1);
    const rawShort = new Float64Array(576);
    const grans = Array.from({ length: granuleCount }, () => new GranuleCoding());
    const vbr = options.vbr === true;
    const targetFrameBytes = Math.floor((144000 * bitrate) / sampleRate);
    let vbrCredit = 0;
    /** Byte length of each VBR frame, for the seek table built at the end. */
    const vbrFrameSizes: number[] = [];
    let plannedAudioByteLength = 0;

    const mdFrame = new Uint8Array(4096);
    const mainChunks: Uint8Array[] = [];
    let mainChunkOffset = 0;
    const allocation = createBitAllocation(nch);
    let mainQueuedBytes = 0;
    let mainWritten = 0;
    let regionStart = 0;
    const pendingFrames: { header: Uint8Array; mainSlots: number; frameSize: number }[] = [];
    const emitReady = (): void => {
        while (pendingFrames.length > 0 && mainQueuedBytes >= pendingFrames[0]!.mainSlots) {
            const pf = pendingFrames.shift()!;
            const out = new Uint8Array(pf.frameSize);
            out.set(pf.header, 0);
            let at = pf.header.length;
            let need = pf.mainSlots;
            while (need > 0) {
                const head = mainChunks[0]!;
                const take = Math.min(need, head.length - mainChunkOffset);
                out.set(head.subarray(mainChunkOffset, mainChunkOffset + take), at);
                at += take;
                need -= take;
                mainChunkOffset += take;
                mainQueuedBytes -= take;
                if (mainChunkOffset === head.length) {
                    mainChunks.shift();
                    mainChunkOffset = 0;
                }
            }

            sink?.write(out);
            options.onFrame?.(out, emittedFrameIndex++);
            audioByteLength += pf.frameSize;
        }
    };

    let frameIndex = 0;
    let command = yield;
    while (command.kind === 'frame') {
        const pcm = command.pcm;
        if (pcm.length !== MP3_SAMPLES_PER_FRAME * nch) {
            throw new EncodeError(
                `MP3 frame needs ${MP3_SAMPLES_PER_FRAME * nch} PCM samples, got ${pcm.length}`,
            );
        }
        let frameBrIdx = brIdx;
        let frameSize: number;
        let padding: number;
        if (vbr) {
            let hasShort = false;
            for (let ch = 0; ch < nch; ch++) {
                if (command.blockPlan[ch]![0] === 2 || command.blockPlan[ch]![1] === 2)
                    hasShort = true;
            }
            if (hasShort) frameBrIdx = BITRATES.length - 1;
            else if (command.pcmEnergy < 1e-6) frameBrIdx = 1;
            else {
                const drift = Math.round(vbrCredit / (2 * targetFrameBytes));
                frameBrIdx = Math.max(
                    1,
                    Math.min(BITRATES.length - 1, brIdx + Math.max(-3, Math.min(5, drift))),
                );
            }
            frameSize = Math.floor((144000 * BITRATES[frameBrIdx]!) / sampleRate);
            padding = 0;
            vbrCredit += targetFrameBytes - frameSize;
        } else {
            ({ size: frameSize, padding } = sizer.next());
        }
        plannedAudioByteLength += frameSize;
        if (vbr) vbrFrameSizes.push(frameSize);
        frame.fill(0, 0, frameSize);
        const mainSlots = frameSize - 4 - sideLen;
        const mainDataBegin = regionStart - mainWritten;
        if (mainDataBegin < 0 || mainDataBegin > 511) {
            throw new EncodeError('encodeMp3: bit reservoir is out of range');
        }
        const availableBits = (mainSlots + mainDataBegin) * 8;
        const pcmBase = 0;

        // Both granules of a channel: 36 slots of 32 samples, at (ch * 2 + gr) * 18 * 32.
        for (let ch = 0; ch < nch; ch++) {
            analysisFilterbank(pcm, pcmBase + ch, nch, 36, history[ch]!, subbands, ch * 2 * 576);
            for (let gr = 0; gr < 2; gr++) applyFrequencyInversion(subbands, (ch * 2 + gr) * 576);
        }

        for (let ch = 0; ch < nch; ch++) {
            for (let gr = 0; gr < 2; gr++) {
                const blockType = command.blockPlan[ch]![gr]! as BlockType;
                const sbBase = (ch * 2 + gr) * 18 * 32;
                const spBase = (ch * 2 + gr) * 576;
                const target = blockType === 2 ? rawShort : spec;
                const targetOff = blockType === 2 ? 0 : spBase;
                for (let sb = 0; sb < 32; sb++) {
                    for (let ss = 0; ss < 18; ss++) mdctCur[ss] = subbands[sbBase + ss * 32 + sb];
                    mdctGranule(mdctCur, prevMdct[ch]!, sb * 18, mdctOut, blockType);
                    for (let k = 0; k < 18; k++) target[targetOff + sb * 18 + k] = mdctOut[k];
                }
                if (blockType === 2) {
                    reorderShortGranule(rawShort, spec, spBase, sfb_s);
                    if (cutoffLine < 576) {
                        const cutoffShortLine = Math.floor(cutoffLine / 3);
                        for (let sfb = 0; sfb < sfb_s.length - 1; sfb++) {
                            const bandStart = sfb_s[sfb]!;
                            const bandEnd = sfb_s[sfb + 1]!;
                            if (bandEnd <= cutoffShortLine) continue;
                            const width = bandEnd - bandStart;
                            const from = Math.max(0, cutoffShortLine - bandStart);
                            for (let w = 0; w < 3; w++) {
                                const base = spBase + 3 * bandStart + w * width;
                                spec.fill(0, base + from, base + width);
                            }
                        }
                    }
                } else {
                    applyAntialias(spec, spBase);
                    if (cutoffLine < 576) applySimpleLowpass(spec, spBase, cutoffLine);
                }
            }
        }

        let msFrame = false;
        if (!mono) {
            const btMatch =
                command.blockPlan[0]![0] === command.blockPlan[1]![0] &&
                command.blockPlan[0]![1] === command.blockPlan[1]![1];
            if (btMatch) {
                let em = 0;
                let es = 0;
                for (let gr = 0; gr < 2; gr++) {
                    const lOff = gr * 576;
                    const rOff = (2 + gr) * 576;
                    for (let i = 0; i < 576; i++) {
                        const l = spec[lOff + i]!;
                        const r = spec[rOff + i]!;
                        em += (l + r) * (l + r);
                        es += (l - r) * (l - r);
                    }
                }
                if (es < 0.5 * em) {
                    msFrame = true;
                    for (let gr = 0; gr < 2; gr++) {
                        const lOff = gr * 576;
                        const rOff = (2 + gr) * 576;
                        for (let i = 0; i < 576; i++) {
                            const l = spec[lOff + i]!;
                            const r = spec[rOff + i]!;
                            spec[lOff + i] = (l + r) * Math.SQRT1_2;
                            spec[rOff + i] = (l - r) * Math.SQRT1_2;
                        }
                    }
                }
            }
        }

        frame[0] = 0xff;
        frame[1] = 0xfb;
        frame[2] = (frameBrIdx << 4) | (srIdx << 2) | (padding << 1);
        frame[3] = mono ? 3 << 6 : (1 << 6) | ((msFrame ? 2 : 0) << 4);

        for (let gi = 0; gi < granuleCount; gi++) {
            const off = gi * 576;
            let energy = 0;
            for (let i = 0; i < 576; i++) {
                const v = spec[off + i];
                energy += v * v;
            }
            energies[gi] = energy;
        }
        for (let i = 0; i < granuleCount * 576; i++) {
            const root = Math.sqrt(Math.abs(spec[i]!));
            allocation.xr34[i] = root * Math.sqrt(root);
        }
        shiftShortWindows(allocation, spec, energies, command.blockPlan, nch, shortBounds);

        // The reservoir saves bits ahead of attacks (more once a start block announces one) and
        // spends them all in frames with short blocks.
        let hasShort = false;
        let starting = false;
        for (let ch = 0; ch < nch; ch++) {
            for (let gr = 0; gr < 2; gr++) {
                if (command.blockPlan[ch]![gr] === 2) hasShort = true;
                if (command.blockPlan[ch]![gr] === 1) starting = true;
            }
        }
        const meanBits = mainSlots * 8;
        const reservoirBits = mainDataBegin * 8;
        const saving = starting
            ? Math.min(0.95 * RESERVOIR_MAX_BITS, reservoirBits + 0.3 * meanBits)
            : Math.min(0.8 * RESERVOIR_MAX_BITS, reservoirBits + 0.15 * meanBits);
        const keep = hasShort ? 0 : saving;
        const budget = Math.max(64 * granuleCount, meanBits + reservoirBits - keep);
        const targets = allocateFrameBits(allocation, command.blockPlan, nch, shortBounds, budget);

        let remainingBits = availableBits;
        let unused = 0;
        for (let gi = 0; gi < granuleCount; gi++) {
            const granulesLeft = granuleCount - gi;

            // Bits a granule left unused go to the next one.
            const targetBits = Math.max(
                64,
                Math.min(4095, remainingBits - 64 * (granulesLeft - 1), targets[gi]! + unused),
            );
            const giCh = (gi / 2) | 0;
            const giGr = gi % 2;
            const giBt = command.blockPlan[giCh]![giGr]! as BlockType;
            const isShort = giBt === 2;
            const giBounds = isShort ? shortBounds : sfb_l;
            prepareGranule(spec, gi * 576, allocation.xr34, giBounds, work);
            const chosen = grans[gi]!;
            encodeGranuleFast(
                targetBits,
                giBounds,
                isShort ? SHORT_BLOCK_SCF_BANDS : LONG_BLOCK_SCF_BANDS,
                isShort ? SHORT_BLOCK_SCF_SPLIT : LONG_BLOCK_SCF_SPLIT,
                giBt,
                sampleRate,
                work,
                granQ.subarray(gi * 576, gi * 576 + 576),
                granSf.subarray(gi * SHORT_BLOCK_SCF_BANDS, (gi + 1) * SHORT_BLOCK_SCF_BANDS),
                giCh,
                chosen,
            );
            unused = Math.max(0, targetBits - chosen.part23Length);
            calibrateBitEstimate(allocation, gi, chosen, shortBounds);
            remainingBits = Math.max(0, remainingBits - chosen.part23Length);
        }

        const si = new Bits(frame, 4);
        si.put(mainDataBegin, 9);
        si.put(0, mono ? 5 : 3);
        for (let ch = 0; ch < nch; ch++) si.put(0, 4);
        for (let gr = 0; gr < 2; gr++) {
            for (let ch = 0; ch < nch; ch++) {
                const g = grans[ch * 2 + gr]!;
                si.put(g.part23Length, 12);
                si.put(g.bigValues, 9);
                si.put(g.globalGain, 8);
                si.put(g.scalefacCompress, 4);
                if (g.blockType === 0) {
                    si.put(0, 1);
                    si.put(g.tableSelect[0], 5);
                    si.put(g.tableSelect[1], 5);
                    si.put(g.tableSelect[2], 5);
                    si.put(g.region0Count, 4);
                    si.put(g.region1Count, 3);
                } else {
                    si.put(1, 1);
                    si.put(g.blockType, 2);

                    // mixed_block_flag: never set (see encodeMp3FrameMachine).
                    si.put(0, 1);
                    si.put(g.tableSelect[0], 5);
                    si.put(g.tableSelect[1], 5);
                    si.put(g.subblockGain[0]!, 3);
                    si.put(g.subblockGain[1]!, 3);
                    si.put(g.subblockGain[2]!, 3);
                }
                si.put(0, 1);
                si.put(g.scalefacScale, 1);
                si.put(g.count1Table, 1);
            }
        }
        if (si.pos !== (4 + sideLen) * 8) {
            throw new EncodeError('encodeMp3: side information has the wrong length');
        }

        mdFrame.fill(0);
        const md = new MainDataWriter(mdFrame);
        for (let gr = 0; gr < 2; gr++) {
            for (let ch = 0; ch < nch; ch++) {
                const gi = ch * 2 + gr;
                const g = grans[gi]!;
                const q = granQ.subarray(gi * 576, gi * 576 + 576);
                const sf = granSf.subarray(
                    gi * SHORT_BLOCK_SCF_BANDS,
                    (gi + 1) * SHORT_BLOCK_SCF_BANDS,
                );
                const [region0Pairs, region1Pairs] =
                    g.blockType === 0
                        ? regionPairBoundaries(g.bigValues, g.region0Count, g.region1Count, sfb_l)
                        : [
                              Math.min(g.bigValues, (g.blockType === 2 ? 36 : sfb_l[8]!) >> 1),
                              g.bigValues,
                          ];
                const [slen1, slen2] = SFC_SLEN[g.scalefacCompress];
                const granuleStartBit = md.pos;

                if (g.blockType === 2) {
                    for (let j = 0; j < SHORT_BLOCK_SCF_BANDS; j++) {
                        const slen = j < SHORT_BLOCK_SCF_SPLIT ? slen1 : slen2;
                        if (slen > 0) md.put(sf[j], slen);
                    }
                } else {
                    for (let sfb = 0; sfb < LONG_BLOCK_SCF_BANDS; sfb++) {
                        const slen = sfb < LONG_BLOCK_SCF_SPLIT ? slen1 : slen2;
                        if (slen > 0) md.put(sf[sfb], slen);
                    }
                }

                const regionEnds = [region0Pairs, region1Pairs, g.bigValues];
                for (let region = 0, p = 0; region < 3; region++) {
                    const table = HTABLES[g.tableSelect[region]!] ?? HT0;
                    const base = table.id * 256;
                    const mv = table.maxval;
                    const lb = table.linbits;
                    for (const end = regionEnds[region]!; p < end; p++) {
                        const x = q[p * 2]!;
                        const y = q[p * 2 + 1]!;
                        const ax = x < 0 ? -x : x;
                        const ay = y < 0 ? -y : y;
                        const at = base + (ax < mv ? ax : mv) * 16 + (ay < mv ? ay : mv);
                        if (lb === 0) {
                            // The codeword and both sign bits in one write (at most 21 bits).
                            let value = PAIR_CODES[at]!;
                            let count = PAIR_LENGTHS[at]!;
                            if (ax) {
                                value = (value << 1) | (x < 0 ? 1 : 0);
                                count++;
                            }
                            if (ay) {
                                value = (value << 1) | (y < 0 ? 1 : 0);
                                count++;
                            }
                            if (count > 0) md.put(value, count);
                            continue;
                        }
                        md.put(PAIR_CODES[at]!, PAIR_LENGTHS[at]!);
                        if (ax >= mv) md.put(ax - mv, lb);
                        if (ax) md.put(x < 0 ? 1 : 0, 1);
                        if (ay >= mv) md.put(ay - mv, lb);
                        if (ay) md.put(y < 0 ? 1 : 0, 1);
                    }
                }

                const quadTable = g.count1Table * 16;
                for (let i = g.count1Start; i < g.count1End; i += 4) {
                    const v = q[i]!;
                    const w = q[i + 1]!;
                    const x = q[i + 2]!;
                    const y = q[i + 3]!;
                    if ((v | w | x | y) > 1 || Math.min(v, w, x, y) < -1) {
                        throw new EncodeError('encodeMp3: a count1 value is out of range');
                    }
                    // The codeword, then the sign of each nonzero value (at most 10 bits).
                    const at = quadTable + ((v ? 8 : 0) | (w ? 4 : 0) | (x ? 2 : 0) | (y ? 1 : 0));
                    let value = QUAD_CODES[at]!;
                    let count = QUAD_LENGTHS[at]!;
                    if (v) {
                        value = (value << 1) | (v < 0 ? 1 : 0);
                        count++;
                    }
                    if (w) {
                        value = (value << 1) | (w < 0 ? 1 : 0);
                        count++;
                    }
                    if (x) {
                        value = (value << 1) | (x < 0 ? 1 : 0);
                        count++;
                    }
                    if (y) {
                        value = (value << 1) | (y < 0 ? 1 : 0);
                        count++;
                    }
                    md.put(value, count);
                }

                const granuleBits = md.pos - granuleStartBit;
                if (granuleBits !== g.part23Length) {
                    throw new EncodeError('encodeMp3: main data has the wrong length');
                }
            }
        }

        if (md.pos > availableBits) {
            throw new EncodeError('encodeMp3: main data overflows the frame');
        }
        md.finish();
        let mainBytes = (md.pos + 7) >> 3;
        const nextBegin = regionStart + mainSlots - (mainWritten + mainBytes);
        if (nextBegin > 511) mainBytes += nextBegin - 511;
        if (mainBytes > mdFrame.length) {
            throw new EncodeError('encodeMp3: main data overflows its buffer');
        }
        mainChunks.push(mdFrame.slice(0, mainBytes));
        mainQueuedBytes += mainBytes;
        mainWritten += mainBytes;
        pendingFrames.push({ header: frame.slice(0, 4 + sideLen), mainSlots, frameSize });
        regionStart += mainSlots;
        emitReady();
        frameIndex++;
        options.onProgress?.(frameIndex, Math.max(frameIndex, totalFramesHint ?? frameIndex));
        command = yield;
    }
    const sourceFrameCount = command.sourceFrameCount;
    const totalFrames = frameIndex;

    if (mainWritten < regionStart) {
        const pad = regionStart - mainWritten;
        mainChunks.push(new Uint8Array(pad));
        mainQueuedBytes += pad;
        mainWritten += pad;
    }
    emitReady();
    if (pendingFrames.length > 0) {
        throw new EncodeError('encodeMp3: frames left unemitted after reservoir flush');
    }
    if (plannedAudioByteLength !== audioByteLength) {
        throw new EncodeError('encodeMp3: VBR byte-accounting checkpoint mismatch');
    }

    // Xing seek table: byte offset (Info frame included) after the first ceil(i% of the frames).
    let tocCumulativeBytes: Float64Array | null = null;
    if (vbr) {
        const infoFrameSize = mp3GaplessInfoFrameSize(sampleRate, channels, bitrate);
        tocCumulativeBytes = new Float64Array(100);
        tocCumulativeBytes[0] = infoFrameSize;
        let bytes = infoFrameSize;
        let frames = 0;
        for (let index = 1; index < 100; index++) {
            const until = Math.ceil((index * totalFrames) / 100);
            while (frames < until) bytes += vbrFrameSizes[frames++]!;
            tocCumulativeBytes[index] = bytes;
        }
    }

    const infoFrame = createGaplessInfoFrame(
        sampleRate,
        channels,
        bitrate,
        totalFrames,
        audioByteLength,
        sourceFrameCount,
        vbr,
        tocCumulativeBytes,
    );
    return {
        infoFrame,
        audio: sink?.toUint8Array() ?? new Uint8Array(0),
    };
}
