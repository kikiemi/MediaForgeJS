import { MemorySink } from '../../io/sinks.js';
import { yieldToEventLoop } from '../audio-buffer-tools.js';
import { EncodeError } from '../../core/errors.js';
import { analysisFilterbank, FrameSizer } from '../mpeg-common.js';
import { InterleavedPcmQueue } from '../streaming-pcm.js';
import { SFB_L, SFB_S, SFC_SLEN, LONG_BLOCK_SCF_BANDS, LONG_BLOCK_SCF_SPLIT, SHORT_BLOCK_SCF_BANDS, SHORT_BLOCK_SCF_SPLIT, GLOBAL_GAIN_BIAS, MIXED_BLOCK_SCF_BANDS, MIXED_BLOCK_SCF_SPLIT, HT0, HT32, HT33, HTABLES, SR_TAB, BR_TAB, Bits, mdctGranule, applyFrequencyInversion, applyAntialias, candidateTables, tableMaxValue, } from './tables.js';
const MP3_SAMPLES_PER_FRAME = 1152;
const MP3_ENCODER_DELAY = 528;
const XING_INFO_SIZE = 156;
export function mp3GaplessInfoFrameSize(sampleRate, channels, requestedBitrate) {
    const sampleRateIndex = SR_TAB.indexOf(sampleRate);
    const requestedBitrateIndex = BR_TAB.indexOf(requestedBitrate);
    if (sampleRateIndex < 0 || requestedBitrateIndex < 1) {
        throw new EncodeError('encodeMP3: cannot construct gapless Info frame');
    }
    const bytesNeeded = 4 + (channels === 1 ? 17 : 32) + XING_INFO_SIZE;
    for (let index = requestedBitrateIndex; index < BR_TAB.length; index++) {
        const size = Math.floor((144000 * BR_TAB[index]) / sampleRate);
        if (size >= bytesNeeded)
            return size;
    }
    throw new EncodeError('encodeMP3: bitrate is too small for gapless metadata');
}
function writeU32BE(target, offset, value) {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
}
function createGaplessInfoFrame(sampleRate, channels, requestedBitrate, audioFrameCount, audioByteLength, sourceFrameCount, vbr = false, tocCumulativeBytes = null) {
    const sampleRateIndex = SR_TAB.indexOf(sampleRate);
    const requestedBitrateIndex = BR_TAB.indexOf(requestedBitrate);
    if (sampleRateIndex < 0 || requestedBitrateIndex < 1) {
        throw new EncodeError('encodeMP3: cannot construct gapless Info frame');
    }
    const sideInfoLength = channels === 1 ? 17 : 32;
    const infoOffset = 4 + sideInfoLength;
    const infoFrameSize = mp3GaplessInfoFrameSize(sampleRate, channels, requestedBitrate);
    let infoBitrateIndex = requestedBitrateIndex;
    while (Math.floor((144000 * BR_TAB[infoBitrateIndex]) / sampleRate) < infoFrameSize)
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
            frame[infoOffset + 16 + i] = Math.min(255, Math.floor((256 * tocCumulativeBytes[i]) / totalBytes));
        }
    }
    else {
        for (let i = 0; i < 100; i++) {
            frame[infoOffset + 16 + i] = Math.min(255, Math.floor((256 * i) / 100));
        }
    }
    writeU32BE(frame, infoOffset + 116, 0);
    frame.set(new TextEncoder().encode('LavfFlowC'), infoOffset + 120);
    const endPadding = audioFrameCount * MP3_SAMPLES_PER_FRAME - MP3_ENCODER_DELAY - sourceFrameCount;
    if (endPadding < 0 || endPadding >= 1 << 12) {
        throw new EncodeError(`encodeMP3: invalid gapless padding ${endPadding}`);
    }
    const delayAndPadding = (MP3_ENCODER_DELAY << 12) | endPadding;
    frame[infoOffset + 141] = (delayAndPadding >>> 16) & 0xff;
    frame[infoOffset + 142] = (delayAndPadding >>> 8) & 0xff;
    frame[infoOffset + 143] = delayAndPadding & 0xff;
    writeU32BE(frame, infoOffset + 148, infoFrameSize + audioByteLength);
    return frame;
}
const Q_MAX = 8206;
const POW43 = new Float64Array(Q_MAX + 1);
for (let q = 0; q <= Q_MAX; q++)
    POW43[q] = Math.pow(q, 4 / 3);
function pow43(q) {
    return q <= Q_MAX ? POW43[q] : Math.pow(q, 4 / 3);
}
const POW2_ISTEP = (() => {
    const t = new Float64Array(512);
    for (let g = 0; g < 512; g++)
        t[g] = Math.pow(2.0, -0.1875 * (g - 256));
    return t;
})();
const POW2_RECON = (() => {
    const t = new Float64Array(512);
    for (let g = 0; g < 512; g++)
        t[g] = Math.pow(2.0, 0.25 * (g - 256));
    return t;
})();
const SBG_Q = [1, 4, 16, 64, 256, 1024, 4096, 16384];
const SBG_R = [1, 0.25, 0.0625, 0.015625, 0.00390625, 0.0009765625, 0.000244140625, 0.00006103515625];
const NO_SBG = new Uint8Array(3);
function computeBlockTypes(pcm, nch, ch, totalGranules) {
    const SLOT = 48;
    const RATIO = 6;
    const ABS_FLOOR = 0.01;
    const REF_FLOOR = 1e-3;
    const want = new Uint8Array(totalGranules);
    const history = [REF_FLOOR, REF_FLOOR, REF_FLOOR];
    const sourceFrames = Math.floor(pcm.length / nch);
    let prev = 0;
    let hpTotal = 0;
    for (let i = 0; i < sourceFrames; i++) {
        const v = pcm[i * nch + ch];
        const d = v - prev;
        prev = v;
        hpTotal += d * d;
    }
    const hpMeanSlot = sourceFrames > 0 ? (hpTotal / sourceFrames) * SLOT : 0;
    const LEVEL_FRACTION = 0.5;
    const SPEC_DELAY_GRANULES = 2;
    prev = 0;
    for (let g = 0; g < totalGranules; g++) {
        let attack = false;
        for (let slot = 0; slot < 12; slot++) {
            const start = g * 576 + slot * SLOT;
            let energy = 0;
            const end = Math.min(start + SLOT, sourceFrames);
            for (let i = start; i < end; i++) {
                const value = pcm[i * nch + ch];
                const d = value - prev;
                prev = value;
                energy += d * d;
            }
            const ref = Math.max((history[0] + history[1] + history[2]) / 3, REF_FLOOR);
            if (energy > RATIO * ref && energy > ABS_FLOOR && energy > LEVEL_FRACTION * hpMeanSlot) {
                attack = true;
            }
            history.shift();
            history.push(energy);
        }
        if (attack) {
            want[g] = 2;
            if (g + 1 < totalGranules)
                want[g + 1] = 2;
            if (g + SPEC_DELAY_GRANULES < totalGranules)
                want[g + SPEC_DELAY_GRANULES] = 2;
        }
    }
    const bt = new Uint8Array(totalGranules);
    for (let g = 0; g < totalGranules; g++)
        if (want[g] === 2)
            bt[g] = 2;
    for (let g = 0; g < totalGranules; g++) {
        if (bt[g] === 2)
            continue;
        const next = g + 1 < totalGranules ? bt[g + 1] : 0;
        const prev = g > 0 ? bt[g - 1] : 0;
        if (next === 2 && (prev === 2 || prev === 1))
            bt[g] = 2;
        else if (next === 2)
            bt[g] = 1;
        else if (prev === 2)
            bt[g] = 3;
    }
    return bt;
}
function reorderShortGranule(raw, out, outOff, sfb_s) {
    let pos = outOff;
    for (let sfb = 0; sfb < sfb_s.length - 1; sfb++) {
        for (let win = 0; win < 3; win++) {
            for (let line = sfb_s[sfb]; line < sfb_s[sfb + 1]; line++) {
                const sb = (line / 6) | 0;
                const m = line - sb * 6;
                out[pos++] = raw[sb * 18 + win * 6 + m];
            }
        }
    }
}
function buildMixedBounds(sfb_l, shortBounds) {
    return [...sfb_l.slice(0, 9), ...shortBounds.slice(10)];
}
function reorderMixedGranule(raw, out, outOff, sfb_s) {
    for (let i = 0; i < 36; i++)
        out[outOff + i] = raw[i];
    let pos = outOff + 36;
    for (let sfb = 3; sfb < sfb_s.length - 1; sfb++) {
        for (let win = 0; win < 3; win++) {
            for (let line = sfb_s[sfb]; line < sfb_s[sfb + 1]; line++) {
                const sb = (line / 6) | 0;
                const m = line - sb * 6;
                out[pos++] = raw[sb * 18 + win * 6 + m];
            }
        }
    }
}
function computeMixedFlags(pcm, nch, ch, totalGranules, plan) {
    const flags = new Uint8Array(totalGranules);
    const sourceFrames = Math.floor(pcm.length / nch);
    const lowE = new Float64Array(totalGranules);
    const totE = new Float64Array(totalGranules);
    let lp = 0;
    for (let g = 0; g < totalGranules; g++) {
        const start = g * 576;
        const end = Math.min(start + 576, sourceFrames);
        let le = 0;
        let te = 0;
        for (let i = start; i < end; i++) {
            const v = pcm[i * nch + ch];
            lp += 0.05 * (v - lp);
            le += lp * lp;
            te += v * v;
        }
        lowE[g] = le;
        totE[g] = te;
    }
    let g = 0;
    while (g < totalGranules) {
        if (plan[g] === 0) {
            g++;
            continue;
        }
        let end = g;
        while (end < totalGranules && plan[end] !== 0)
            end++;
        let lo = Number.POSITIVE_INFINITY;
        let hi = 0;
        let lSum = 0;
        let tSum = 0;
        for (let k = g; k < end; k++) {
            lo = Math.min(lo, lowE[k]);
            hi = Math.max(hi, lowE[k]);
            lSum += lowE[k];
            tSum += totE[k];
        }
        const stationary = hi < 4 * Math.max(lo, 1e-9);
        const dominant = tSum > 1e-9 && lSum / tSum > 0.3 && lSum > 1e-6;
        if (stationary && dominant) {
            for (let k = g; k < end; k++)
                if (plan[k] === 2)
                    flags[k] = 1;
        }
        g = end;
    }
    return flags;
}
function buildShortBounds(sfb_s) {
    const bounds = [];
    for (let sfb = 0; sfb < sfb_s.length - 1; sfb++) {
        const base = 3 * sfb_s[sfb];
        const width = sfb_s[sfb + 1] - sfb_s[sfb];
        for (let win = 0; win < 3; win++)
            bounds.push(base + win * width);
    }
    bounds.push(576);
    return bounds;
}
function makeGranWork(bandCount) {
    return {
        abs: new Float64Array(576),
        xr34: new Float64Array(576),
        weight: new Float64Array(576),
        bandXr34Max: new Float64Array(bandCount),
        bandEnergy: new Float64Array(bandCount),
        scratch: new Int16Array(576),
        underQ: new Int16Array(576),
        overQ: new Int16Array(576),
        pickQ: new Int16Array(576),
        bestQ: new Int16Array(576),
        bestSf: new Uint8Array(SHORT_BLOCK_SCF_BANDS),
        seenGain: new Int32Array(256),
        lastGain: -1,
        seenGeneration: 0,
    };
}
function prepareGranule(spec, off, sfb_l, work, shortBlock) {
    const { abs, xr34, weight, bandXr34Max } = work;
    let peak = 0;
    for (let i = 0; i < 576; i++) {
        const a = Math.abs(spec[off + i]);
        abs[i] = a;
        xr34[i] = a <= 1e-20 ? 0 : Math.pow(a, 0.75);
        if (a > peak)
            peak = a;
    }
    void peak;
    void shortBlock;
    const bandCount = sfb_l.length - 1;
    for (let sfb = 0; sfb < bandCount; sfb++) {
        let bandMax = 0;
        for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
            weight[i] = 1;
            if (xr34[i] > bandMax)
                bandMax = xr34[i];
        }
        bandXr34Max[sfb] = bandMax;
    }
}
function quantizeLine(absValue, xr34, istep, reconScale) {
    if (absValue <= 1e-20)
        return 0;
    const x = xr34 * istep - 0.0946;
    const qBase = Math.max(0, Math.round(x));
    let bestQ = 0;
    let bestErr = absValue;
    const qMin = Math.max(0, qBase - 1);
    const qMax = qBase + 1;
    for (let q = qMin; q <= qMax; q++) {
        const recon = q === 0 ? 0 : pow43(q) * reconScale;
        const err = Math.abs(absValue - recon);
        if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) <= 1e-12 && q < bestQ)) {
            bestErr = err;
            bestQ = q;
        }
    }
    return bestQ;
}
function bandQuantizerMul(scalefac, scalefacScale) {
    return Math.pow(2.0, 0.375 * (scalefacScale + 1) * scalefac);
}
function bandReconMul(scalefac, scalefacScale) {
    return Math.pow(2.0, -0.5 * (scalefacScale + 1) * scalefac);
}
function quantize(spec, off, gain, q, scalefactors, scalefacScale, sfb_l, scfCount, sbg, work) {
    const baseIstep = POW2_ISTEP[gain - GLOBAL_GAIN_BIAS + 256];
    const baseReconScale = POW2_RECON[gain - GLOBAL_GAIN_BIAS + 256];
    const { abs, xr34 } = work;
    for (let sfb = 0; sfb < sfb_l.length - 1; sfb++) {
        const scalefac = sfb < scfCount ? scalefactors[sfb] : 0;
        const win = sbg === NO_SBG ? 0 : sbg[sfb % 3];
        const istep = baseIstep * bandQuantizerMul(scalefac, scalefacScale) * SBG_Q[win];
        const reconScale = baseReconScale * bandReconMul(scalefac, scalefacScale) * SBG_R[win];
        for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
            const vq = quantizeLine(abs[i], xr34[i], istep, reconScale);
            q[i] = spec[off + i] < 0 ? -vq : vq;
        }
    }
}
function reconstructionError(gain, q, scalefactors, scalefacScale, sfb_l, scfCount, sbg, work) {
    const baseReconScale = POW2_RECON[gain - GLOBAL_GAIN_BIAS + 256];
    const { abs, weight } = work;
    let err = 0;
    for (let sfb = 0; sfb < sfb_l.length - 1; sfb++) {
        const scalefac = sfb < scfCount ? scalefactors[sfb] : 0;
        const win = sbg === NO_SBG ? 0 : sbg[sfb % 3];
        const reconScale = baseReconScale * bandReconMul(scalefac, scalefacScale) * SBG_R[win];
        for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
            const aq = q[i] < 0 ? -q[i] : q[i];
            const diff = abs[i] - pow43(aq) * reconScale;
            err += diff * diff * weight[i];
        }
    }
    return err;
}
function computeRegions(q) {
    let lastNonZero = -1;
    for (let i = 575; i >= 0; i--) {
        if (q[i] !== 0) {
            lastNonZero = i;
            break;
        }
    }
    let count1End = lastNonZero + 1;
    if (count1End % 2 === 1)
        count1End++;
    let bigEnd = count1End;
    while (bigEnd >= 4) {
        const a = Math.abs(q[bigEnd - 1]);
        const b = Math.abs(q[bigEnd - 2]);
        const c = Math.abs(q[bigEnd - 3]);
        const d = Math.abs(q[bigEnd - 4]);
        if (a <= 1 && b <= 1 && c <= 1 && d <= 1)
            bigEnd -= 4;
        else
            break;
    }
    const bigValues = bigEnd >> 1;
    return [bigValues, bigEnd, count1End];
}
const HUFF_LENGTH_CACHE = new Map();
function huffmanLengths(table) {
    let lengths = HUFF_LENGTH_CACHE.get(table);
    if (!lengths) {
        lengths = new Int32Array(table.entries.length).fill(-1);
        for (let i = 0; i < table.entries.length; i++) {
            const entry = table.entries[i];
            if (entry)
                lengths[i] = entry[0];
        }
        HUFF_LENGTH_CACHE.set(table, lengths);
    }
    return lengths;
}
function countBigValueBitsRange(q, pairStart, pairEnd, table, ceiling = Number.POSITIVE_INFINITY) {
    const mv = table.maxval;
    const lb = table.linbits;
    const xlen = table.xlen;
    const lengths = huffmanLengths(table);
    let bits = 0;
    for (let p = pairStart; p < pairEnd; p++) {
        if (bits >= ceiling)
            return Number.POSITIVE_INFINITY;
        const x = q[p * 2];
        const y = q[p * 2 + 1];
        const ax = x < 0 ? -x : x;
        const ay = y < 0 ? -y : y;
        const hx = ax < mv ? ax : mv;
        const hy = ay < mv ? ay : mv;
        const length = lengths[hx * xlen + hy];
        if (length < 0)
            return Number.POSITIVE_INFINITY;
        bits += length;
        if (lb > 0) {
            if (ax >= mv)
                bits += lb;
            if (ay >= mv)
                bits += lb;
        }
        if (ax !== 0)
            bits++;
        if (ay !== 0)
            bits++;
    }
    return bits;
}
function countCount1Bits(q, count1Start, count1End, table) {
    const ht = table === 0 ? HT32 : HT33;
    let bits = 0;
    for (let i = count1Start; i < count1End; i += 4) {
        const av = Math.abs(q[i]);
        const aw = Math.abs(q[i + 1]);
        const ax = Math.abs(q[i + 2]);
        const ay = Math.abs(q[i + 3]);
        const idx = (av ? 8 : 0) | (aw ? 4 : 0) | (ax ? 2 : 0) | (ay ? 1 : 0);
        bits += ht[idx][0] + av + aw + ax + ay;
    }
    return bits;
}
function regionPairBoundaries(bigValues, region0Count, region1Count, sfb_l) {
    const r0Band = Math.min(region0Count + 1, sfb_l.length - 1);
    const r1Band = Math.min(region0Count + 1 + region1Count + 1, sfb_l.length - 1);
    const region0Pairs = Math.min(bigValues, sfb_l[r0Band] >> 1);
    const region1Pairs = Math.min(bigValues, sfb_l[r1Band] >> 1);
    return [region0Pairs, region1Pairs];
}
function maxValueInPairRange(q, pairStart, pairEnd) {
    let max = 0;
    for (let p = pairStart; p < pairEnd; p++) {
        const ax = Math.abs(q[p * 2]);
        const ay = Math.abs(q[p * 2 + 1]);
        if (ax > max)
            max = ax;
        if (ay > max)
            max = ay;
    }
    return max;
}
function computeRegionCounts(bigValues, sfb_l) {
    const bigEnd = bigValues * 2;
    let bandEnd = 0;
    while (bandEnd < sfb_l.length - 1 && sfb_l[bandEnd + 1] < bigEnd)
        bandEnd++;
    const region0 = Math.max(0, Math.min(15, Math.floor(bandEnd / 3) - 1));
    const region1 = Math.max(0, Math.min(7, bandEnd - (region0 + 1) - 1));
    return [region0, region1];
}
function selectRegionTables(q, bigValues, sfb_l) {
    if (bigValues === 0) {
        return { tableSelect: [0, 0, 0], region0Count: 0, region1Count: 0, bigValueBits: 0 };
    }
    const [region0Count, region1Count] = computeRegionCounts(bigValues, sfb_l);
    const [region0Pairs, region1Pairs] = regionPairBoundaries(bigValues, region0Count, region1Count, sfb_l);
    const ranges = [
        [0, Math.min(bigValues, region0Pairs)],
        [Math.min(bigValues, region0Pairs), Math.min(bigValues, region1Pairs)],
        [Math.min(bigValues, region1Pairs), bigValues],
    ];
    const tableSelect = [0, 0, 0];
    let totalBits = 0;
    for (let r = 0; r < 3; r++) {
        const [start, end] = ranges[r];
        if (end <= start) {
            tableSelect[r] = 0;
            continue;
        }
        const maxVal = maxValueInPairRange(q, start, end);
        const candidates = candidateTables(maxVal);
        if (candidates.length === 0)
            return null;
        let bestBits = Number.POSITIVE_INFINITY;
        let bestTable = -1;
        for (const table of candidates) {
            const bits = countBigValueBitsRange(q, start, end, table, bestBits);
            if (bits < bestBits) {
                bestBits = bits;
                bestTable = table.id;
            }
        }
        if (bestTable < 0 || !Number.isFinite(bestBits))
            return null;
        tableSelect[r] = bestTable;
        totalBits += bestBits;
    }
    return { tableSelect, region0Count, region1Count, bigValueBits: totalBits };
}
function selectTwoRegionTables(q, bigValues, boundaryLine) {
    if (bigValues === 0) {
        return { tableSelect: [0, 0, 0], region0Count: 0, region1Count: 0, bigValueBits: 0 };
    }
    const region0Pairs = Math.min(bigValues, boundaryLine >> 1);
    const ranges = [
        [0, region0Pairs],
        [region0Pairs, bigValues],
    ];
    const tableSelect = [0, 0, 0];
    let totalBits = 0;
    for (let r = 0; r < 2; r++) {
        const [start, end] = ranges[r];
        if (end <= start)
            continue;
        const maxVal = maxValueInPairRange(q, start, end);
        const candidates = candidateTables(maxVal);
        if (candidates.length === 0)
            return null;
        let bestBits = Number.POSITIVE_INFINITY;
        let bestTable = -1;
        for (const table of candidates) {
            const bits = countBigValueBitsRange(q, start, end, table, bestBits);
            if (bits < bestBits) {
                bestBits = bits;
                bestTable = table.id;
            }
        }
        if (bestTable < 0 || !Number.isFinite(bestBits))
            return null;
        tableSelect[r] = bestTable;
        totalBits += bestBits;
    }
    return { tableSelect, region0Count: 0, region1Count: 0, bigValueBits: totalBits };
}
function pickScaleFactorCompress(scalefactors, scalefacScale, scfCount, scfSplit) {
    let maxSlen1 = 0;
    let maxSlen2 = 0;
    for (let sfb = 0; sfb < scfCount; sfb++) {
        if (sfb < scfSplit)
            maxSlen1 = Math.max(maxSlen1, scalefactors[sfb]);
        else
            maxSlen2 = Math.max(maxSlen2, scalefactors[sfb]);
    }
    let best = null;
    for (let scalefacCompress = 0; scalefacCompress < SFC_SLEN.length; scalefacCompress++) {
        const [slen1, slen2] = SFC_SLEN[scalefacCompress];
        if (maxSlen1 >= 1 << slen1 || maxSlen2 >= 1 << slen2)
            continue;
        const part2Length = scfSplit * slen1 + (scfCount - scfSplit) * slen2;
        if (!best || part2Length < best.part2Length)
            best = { scalefacCompress, scalefacScale, part2Length, scalefactors };
    }
    return best;
}
function buildBandModel(sfb_l, scfCount, work, sampleRate, bitsPerChannelFrame, blockType) {
    const thresholds = new Float64Array(scfCount);
    const peaks = new Float64Array(scfCount);
    const energies = new Float64Array(scfCount);
    const bark = new Float64Array(scfCount);
    const widths = new Float64Array(scfCount);
    const tonality = new Float64Array(scfCount);
    const { abs, weight } = work;
    const shortBlock = blockType === 2;
    if (shortBlock) {
        for (let sfb = 0; sfb < scfCount; sfb++) {
            let energy = 0;
            let peak = 0;
            let sumLog = 0;
            const start = sfb_l[sfb];
            const end = sfb_l[sfb + 1];
            const width = Math.max(1, end - start);
            for (let i = start; i < end; i++) {
                const v = abs[i];
                if (v > peak)
                    peak = v;
                energy += v * v;
                sumLog += Math.log(v + 1e-12);
            }
            energies[sfb] = energy;
            peaks[sfb] = peak;
            const rms = Math.sqrt(energy / width + 1e-30);
            const flatness = Math.exp(sumLog / width) / Math.max(rms, 1e-12);
            const ton = Math.min(1, Math.max(0, (0.6 - flatness) / 0.5));
            tonality[sfb] = 6 + ton * 12;
        }
        const spreadL = new Float64Array(scfCount);
        for (let sfb = 0; sfb < scfCount; sfb++) {
            let acc = energies[sfb];
            let gain = 1;
            for (let j = sfb - 1; j >= 0 && gain > 1e-4; j--) {
                gain *= 0.05;
                acc += energies[j] * gain;
            }
            gain = 1;
            for (let j = sfb + 1; j < scfCount && gain > 1e-4; j++) {
                gain *= 0.006;
                acc += energies[j] * gain;
            }
            spreadL[sfb] = acc;
        }
        const rateBonusDb = Math.min(10, Math.max(-4, (bitsPerChannelFrame - 1600) / 220));
        const binHz = sampleRate / 1152;
        for (let sfb = 0; sfb < scfCount; sfb++) {
            const snrDb = tonality[sfb] + rateBonusDb;
            const masked = spreadL[sfb] * Math.pow(10, -snrDb / 10);
            const centerHz = Math.max(20, ((sfb_l[sfb] + sfb_l[sfb + 1]) / 2) * binHz);
            const khz = centerHz / 1000;
            const athSpl = 3.64 * Math.pow(khz, -0.8) - 6.5 * Math.exp(-0.6 * (khz - 3.3) * (khz - 3.3)) + 1e-3 * Math.pow(khz, 4);
            const athAmp = Math.pow(10, (Math.min(athSpl, 40) - 96) / 20);
            const width = Math.max(1, sfb_l[sfb + 1] - sfb_l[sfb]);
            const athScale = Math.pow(10, (-Math.max(0, rateBonusDb) * 1.5) / 10);
            thresholds[sfb] = Math.max(masked, athAmp * athAmp * width * 0.5 * athScale, 1e-14);
        }
        let gp = 0;
        for (let i = 0; i < 576; i++)
            if (abs[i] > gp)
                gp = abs[i];
        const invPeak = gp > 1e-18 ? 1 / gp : 0;
        for (let sfb = 0; sfb < scfCount; sfb++) {
            const bandBoost = sfb < 8 ? 1.5 : 0;
            for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
                weight[i] = 1 + 8 * abs[i] * invPeak + bandBoost;
            }
        }
        for (let i = sfb_l[scfCount]; i < 576; i++)
            weight[i] = 1;
        return { thresholds, peaks };
    }
    let globalSumLog = 0;
    let globalEnergy = 0;
    let globalLines = 0;
    for (let sfb = 0; sfb < scfCount; sfb++) {
        let energy = 0;
        let peak = 0;
        let sumLog = 0;
        const start = sfb_l[sfb];
        const end = sfb_l[sfb + 1];
        const width = Math.max(1, end - start);
        for (let i = start; i < end; i++) {
            const v = abs[i];
            if (v > peak)
                peak = v;
            energy += v * v;
            sumLog += Math.log(v + 1e-12);
        }
        energies[sfb] = energy;
        peaks[sfb] = peak;
        widths[sfb] = width;
        globalSumLog += sumLog;
        globalEnergy += energy;
        globalLines += width;
        const rms = Math.sqrt(energy / width + 1e-30);
        const flatness = Math.exp(sumLog / width) / Math.max(rms, 1e-12);
        tonality[sfb] = Math.min(1, Math.max(0, (0.6 - flatness) / 0.5));
        let centerHz;
        if (shortBlock) {
            const win = sfb % 3;
            const bandStart = (start - win * width) / 3;
            centerHz = Math.max(20, ((bandStart + width / 2) * (sampleRate * 0.5)) / 192);
        }
        else {
            centerHz = Math.max(20, (((start + end) / 2) * (sampleRate * 0.5)) / 576);
        }
        bark[sfb] = 13 * Math.atan(0.00076 * centerHz) + 3.5 * Math.atan((centerHz / 7500) * (centerHz / 7500));
    }
    {
        const gRms = Math.sqrt(globalEnergy / Math.max(1, globalLines) + 1e-30);
        const gFlat = Math.exp(globalSumLog / Math.max(1, globalLines)) / Math.max(gRms, 1e-12);
        const gTon = Math.min(1, Math.max(0, (0.6 - gFlat) / 0.5));
        for (let sfb = 0; sfb < scfCount; sfb++) {
            tonality[sfb] = Math.max(tonality[sfb], 0.7 * gTon);
        }
    }
    const SPREAD_UP = -13;
    const SPREAD_DOWN = -27;
    const spread = new Float64Array(scfCount);
    for (let b = 0; b < scfCount; b++) {
        let acc = 0;
        for (let j = 0; j < scfCount; j++) {
            if (shortBlock && j % 3 !== b % 3)
                continue;
            const dz = bark[b] - bark[j];
            const slopeDb = dz >= 0 ? SPREAD_UP * dz : SPREAD_DOWN * -dz;
            if (slopeDb < -40)
                continue;
            acc += energies[j] * Math.pow(10, slopeDb / 10);
        }
        spread[b] = acc;
    }
    const rateBonusDb = Math.min(10, Math.max(-4, (bitsPerChannelFrame - 1600) / 220));
    for (let sfb = 0; sfb < scfCount; sfb++) {
        const offsetDb = tonality[sfb] * (14.5 + Math.min(16, bark[sfb])) + (1 - tonality[sfb]) * 5.5 + rateBonusDb;
        const masked = spread[sfb] * Math.pow(10, -offsetDb / 10);
        const centerKhz = Math.max(0.02, (shortBlock
            ? (((sfb_l[sfb] - (sfb % 3) * widths[sfb]) / 3 + widths[sfb] / 2) * (sampleRate * 0.5)) / 192
            : (((sfb_l[sfb] + sfb_l[sfb + 1]) / 2) * (sampleRate * 0.5)) / 576) / 1000);
        const athSpl = 3.64 * Math.pow(centerKhz, -0.8) -
            6.5 * Math.exp(-0.6 * (centerKhz - 3.3) * (centerKhz - 3.3)) +
            1e-3 * Math.pow(centerKhz, 4);
        const athAmp = Math.pow(10, (Math.min(athSpl, 60) - 96) / 20);
        const athScale = Math.pow(10, (-Math.max(0, rateBonusDb) * 1.5) / 10);
        thresholds[sfb] = Math.max(masked, athAmp * athAmp * widths[sfb] * 0.5 * athScale, 1e-14);
    }
    let refLog = 0;
    for (let sfb = 0; sfb < scfCount; sfb++)
        refLog += Math.log(thresholds[sfb] / widths[sfb]);
    const refT = Math.exp(refLog / Math.max(1, scfCount));
    for (let sfb = 0; sfb < scfCount; sfb++) {
        const perLine = thresholds[sfb] / widths[sfb];
        const w = Math.min(400, Math.max(0.05, refT / perLine));
        for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++)
            weight[i] = w;
    }
    for (let i = sfb_l[scfCount]; i < 576; i++)
        weight[i] = 1;
    return { thresholds, peaks };
}
function evaluateBandNoise(gain, q, scalefactors, scalefacScale, sfb_l, scfCount, sbg, model, work) {
    const baseReconScale = POW2_RECON[gain - GLOBAL_GAIN_BIAS + 256];
    const { abs } = work;
    const ratios = new Float64Array(scfCount);
    let worstRatio = 0;
    let totalExcess = 0;
    let loudExcess = 0;
    for (let sfb = 0; sfb < scfCount; sfb++) {
        const win = sbg === NO_SBG ? 0 : sbg[sfb % 3];
        const reconScale = baseReconScale * bandReconMul(scalefactors[sfb], scalefacScale) * SBG_R[win];
        let noiseEnergy = 0;
        for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
            const aq = q[i] < 0 ? -q[i] : q[i];
            const diff = abs[i] - pow43(aq) * reconScale;
            noiseEnergy += diff * diff;
        }
        const ratio = noiseEnergy / Math.max(model.thresholds[sfb], 1e-18);
        ratios[sfb] = ratio;
        if (ratio > worstRatio)
            worstRatio = ratio;
        if (ratio > 1) {
            totalExcess += ratio - 1;
            if (sfb < 11)
                loudExcess += ratio - 1;
        }
    }
    const sortedBands = Array.from({ length: scfCount }, (_, i) => i).sort((a, b) => ratios[b] - ratios[a]);
    return { worstRatio, totalExcess, loudExcess, sortedBands };
}
function nextScalefactors(current, metrics, model, maxRank = 3, maxChanged = 2) {
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
        if (changed >= maxChanged)
            break;
    }
    return changed > 0 ? next : null;
}
function quantizePeakPow(scalefactors, scalefacScale, sfb_l, scfCount, sbg, work) {
    let peakPow = 0;
    const { bandXr34Max } = work;
    for (let sfb = 0; sfb < sfb_l.length - 1; sfb++) {
        const scalefac = sfb < scfCount ? scalefactors[sfb] : 0;
        const win = sbg === NO_SBG ? 0 : sbg[sfb % 3];
        const v = bandXr34Max[sfb] * bandQuantizerMul(scalefac, scalefacScale) * SBG_Q[win];
        if (v > peakPow)
            peakPow = v;
    }
    return peakPow;
}
function zeroGranule() {
    return {
        blockType: 0,
        mixedFlag: 0,
        subblockGain: NO_SBG,
        globalGain: 255,
        bigValues: 0,
        count1Start: 0,
        count1End: 0,
        tableSelect: [0, 0, 0],
        region0Count: 0,
        region1Count: 0,
        count1Table: 0,
        scalefacCompress: 0,
        scalefacScale: 0,
        part2Length: 0,
        part23Length: 0,
        error: Number.POSITIVE_INFINITY,
    };
}
function buildGranuleAtGain(spec, off, gain, profile, sfb_l, scfCount, blockType, regionBoundary, sbg, work) {
    const scratch = work.scratch;
    quantize(spec, off, gain, scratch, profile.scalefactors, profile.scalefacScale, sfb_l, scfCount, sbg, work);
    const [bigValues, count1Start, count1End] = computeRegions(scratch);
    const regionTables = blockType === 0
        ? selectRegionTables(scratch, bigValues, sfb_l)
        : selectTwoRegionTables(scratch, bigValues, regionBoundary);
    if (!regionTables)
        return null;
    const count1Bits32 = countCount1Bits(scratch, count1Start, count1End, 0);
    const count1Bits33 = countCount1Bits(scratch, count1Start, count1End, 1);
    const count1Table = count1Bits32 <= count1Bits33 ? 0 : 1;
    const part3Length = regionTables.bigValueBits + Math.min(count1Bits32, count1Bits33);
    return {
        blockType,
        mixedFlag: 0,
        subblockGain: sbg,
        globalGain: gain,
        bigValues,
        count1Start,
        count1End,
        tableSelect: regionTables.tableSelect,
        region0Count: regionTables.region0Count,
        region1Count: regionTables.region1Count,
        count1Table,
        scalefacCompress: profile.scalefacCompress,
        scalefacScale: profile.scalefacScale,
        part2Length: profile.part2Length,
        part23Length: profile.part2Length + part3Length,
        error: reconstructionError(gain, scratch, profile.scalefactors, profile.scalefacScale, sfb_l, scfCount, sbg, work),
    };
}
function findGainForBudget(spec, off, targetBudget, profile, sfb_l, scfCount, blockType, regionBoundary, sbg, work) {
    const peakPow = quantizePeakPow(profile.scalefactors, profile.scalefacScale, sfb_l, scfCount, sbg, work);
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
    const found = { under: null, over: null };
    work.seenGeneration++;
    const generation = work.seenGeneration;
    const evaluate = (gain) => {
        if (work.seenGain[gain] === generation)
            return null;
        work.seenGain[gain] = generation;
        const cand = buildGranuleAtGain(spec, off, gain, profile, sfb_l, scfCount, blockType, regionBoundary, sbg, work);
        if (!cand)
            return null;
        if (cand.part23Length <= targetBudget) {
            const prev = found.under;
            if (!prev ||
                cand.error < prev.error ||
                (cand.error === prev.error && cand.part23Length < prev.part23Length)) {
                found.under = cand;
                work.underQ.set(work.scratch);
            }
        }
        else {
            const prev = found.over;
            if (!prev ||
                cand.part23Length < prev.part23Length ||
                (cand.part23Length === prev.part23Length && cand.error < prev.error)) {
                found.over = cand;
                work.overQ.set(work.scratch);
            }
        }
        return cand;
    };
    if (work.lastGain >= lo && work.lastGain <= hi) {
        const warm = evaluate(work.lastGain);
        if (warm) {
            if (warm.part23Length > targetBudget)
                lo = work.lastGain + 1;
            else
                hi = work.lastGain - 1;
        }
    }
    for (let iter = 0; iter < 6 && lo <= hi; iter++) {
        const mid = (lo + hi) >> 1;
        const cand = evaluate(mid);
        if (!cand) {
            lo = mid + 1;
            continue;
        }
        if (cand.part23Length > targetBudget)
            lo = mid + 1;
        else
            hi = mid - 1;
    }
    const center = found.under ? found.under.globalGain : lo;
    const probeStart = Math.max(0, center - 1);
    const probeEnd = Math.min(255, center + 3);
    for (let g = probeStart; g <= probeEnd; g++)
        evaluate(g);
    if (found.under)
        return { meta: found.under, under: true };
    if (found.over)
        return { meta: found.over, under: false };
    return null;
}
function encodeGranuleFast(spec, off, targetBudget, sfb_l, scfCount, scfSplit, blockType, mixed, sampleRate, work, outQ, outSf) {
    outQ.fill(0);
    outSf.fill(0);
    if (targetBudget <= 0)
        return zeroGranule();
    const regionBoundary = blockType === 2 ? 36 : (sfb_l[8] ?? 36);
    prepareGranule(spec, off, sfb_l, work, blockType === 2);
    let sbg = NO_SBG;
    if (blockType === 2 && !mixed) {
        const winPeak = [0, 0, 0];
        for (let sfb = 0; sfb < scfCount; sfb++) {
            const win = sfb % 3;
            for (let i = sfb_l[sfb]; i < sfb_l[sfb + 1]; i++) {
                const a = work.abs[i];
                if (a > winPeak[win])
                    winPeak[win] = a;
            }
        }
        const maxPeak = Math.max(winPeak[0], winPeak[1], winPeak[2]);
        if (maxPeak > 1e-12) {
            const est = new Uint8Array(3);
            let any = false;
            for (let w = 0; w < 3; w++) {
                const ratio = maxPeak / Math.max(winPeak[w], maxPeak * 1e-4);
                const steps = Math.max(0, Math.min(7, Math.floor(Math.log2(ratio) / 2)));
                est[w] = steps;
                if (steps > 0)
                    any = true;
            }
            if (any)
                sbg = est;
        }
    }
    const model = buildBandModel(sfb_l, scfCount, work, sampleRate, targetBudget * 2, blockType);
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    const maxIter = blockType === 2 ? 6 : 1;
    const boostRank = blockType === 2 ? 6 : 3;
    const boostChanged = blockType === 2 ? 4 : 2;
    for (const scalefacScale of [0, 1]) {
        let scalefactors = new Uint8Array(scfCount);
        for (let iter = 0; iter < maxIter; iter++) {
            const profile = pickScaleFactorCompress(scalefactors, scalefacScale, scfCount, scfSplit);
            if (!profile || profile.part2Length >= targetBudget)
                break;
            const pick = findGainForBudget(spec, off, targetBudget, profile, sfb_l, scfCount, blockType, regionBoundary, sbg, work);
            if (!pick)
                break;
            const cand = pick.meta;
            const candQ = pick.under ? work.underQ : work.overQ;
            const metrics = evaluateBandNoise(cand.globalGain, candQ, profile.scalefactors, cand.scalefacScale, sfb_l, scfCount, sbg, model, work);
            const score = cand.error + metrics.totalExcess * 450 + metrics.loudExcess * 900 + metrics.worstRatio * 50;
            if (!best ||
                (cand.part23Length <= targetBudget && best.part23Length > targetBudget) ||
                (cand.part23Length <= targetBudget === best.part23Length <= targetBudget && score < bestScore - 1e-9)) {
                best = cand;
                best.error = score;
                bestScore = score;
                work.lastGain = cand.globalGain;
                work.bestQ.set(candQ);
                work.bestSf.set(profile.scalefactors);
            }
            const meets = metrics.worstRatio <= 1.05 && metrics.totalExcess <= 0.2;
            if (best === cand)
                best.satisfied = meets;
            if (meets)
                break;
            const next = nextScalefactors(scalefactors, metrics, model, boostRank, boostChanged);
            if (!next)
                break;
            scalefactors = next;
        }
    }
    if (!best)
        return zeroGranule();
    outQ.set(work.bestQ);
    outSf.set(work.bestSf);
    return best;
}
const LOWPASS_TABLE = [
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
function lowpassCutoffHz(bitrateKbps, channels) {
    const perChannel = bitrateKbps / channels;
    if (perChannel >= 160)
        return Number.POSITIVE_INFINITY;
    for (const [kbps, hz] of LOWPASS_TABLE) {
        if (perChannel <= kbps)
            return hz;
    }
    return Number.POSITIVE_INFINITY;
}
function applySimpleLowpass(spec, off, cutoffLine) {
    const start = Math.max(0, Math.min(576, cutoffLine));
    for (let i = start; i < 576; i++)
        spec[off + i] = 0;
}
export class Mp3LevelAnalyzer {
    channels;
    previous;
    highPassTotal;
    sourceFrames = 0;
    peakValue = 0;
    sealed = false;
    constructor(channels) {
        this.channels = channels;
        if (channels !== 1 && channels !== 2) {
            throw new EncodeError(`MP3 analysis needs 1 or 2 channels, got ${channels}`);
        }
        this.previous = new Float64Array(channels);
        this.highPassTotal = new Float64Array(channels);
    }
    pushPlanar(planes) {
        this.assertOpen();
        if (planes.length !== this.channels) {
            throw new EncodeError(`MP3 analysis expected ${this.channels} channels, got ${planes.length}`);
        }
        const frames = planes[0]?.length ?? 0;
        for (let channel = 1; channel < planes.length; channel++) {
            if (planes[channel].length !== frames) {
                throw new EncodeError('MP3 analysis channel planes have different lengths');
            }
        }
        for (let frame = 0; frame < frames; frame++) {
            for (let channel = 0; channel < this.channels; channel++) {
                this.consumeSample(channel, planes[channel][frame]);
            }
        }
        this.sourceFrames += frames;
    }
    pushInterleaved(pcm) {
        this.assertOpen();
        if (pcm.length % this.channels !== 0) {
            throw new EncodeError('MP3 analysis PCM is not channel-aligned');
        }
        const frames = pcm.length / this.channels;
        for (let frame = 0; frame < frames; frame++) {
            for (let channel = 0; channel < this.channels; channel++) {
                this.consumeSample(channel, pcm[frame * this.channels + channel]);
            }
        }
        this.sourceFrames += frames;
    }
    finish() {
        this.assertOpen();
        this.sealed = true;
        if (this.sourceFrames === 0)
            throw new EncodeError('encodeMP3: empty input');
        const mean = new Float64Array(this.channels);
        for (let channel = 0; channel < this.channels; channel++) {
            mean[channel] = (this.highPassTotal[channel] / this.sourceFrames) * 48;
        }
        return {
            sourceFrameCount: this.sourceFrames,
            peak: this.peakValue,
            highPassMeanSlot: mean,
        };
    }
    assertOpen() {
        if (this.sealed)
            throw new EncodeError('MP3 level analyzer received PCM after finish');
    }
    consumeSample(channel, value) {
        const absolute = Math.abs(value);
        if (absolute > this.peakValue)
            this.peakValue = absolute;
        const difference = value - this.previous[channel];
        this.previous[channel] = value;
        this.highPassTotal[channel] += difference * difference;
    }
}
class Mp3RollingBlockClassifier {
    channels;
    highPassPrevious;
    lowPassPrevious;
    highPassMeanSlot;
    slotHistory = [];
    wantNow;
    wantNext;
    wantAfter;
    currentWant;
    pendingWant;
    previousBlock;
    pendingLow;
    pendingTotal;
    currentLow;
    currentTotal;
    hasPending = false;
    sealed = false;
    constructor(channels, levels, gain) {
        this.channels = channels;
        if (levels.length !== channels)
            throw new EncodeError('MP3 block classifier channel mismatch');
        this.highPassPrevious = new Float64Array(channels);
        this.lowPassPrevious = new Float64Array(channels);
        this.highPassMeanSlot = new Float64Array(channels);
        this.wantNow = new Uint8Array(channels);
        this.wantNext = new Uint8Array(channels);
        this.wantAfter = new Uint8Array(channels);
        this.currentWant = new Uint8Array(channels);
        this.pendingWant = new Uint8Array(channels);
        this.previousBlock = new Uint8Array(channels);
        this.pendingLow = new Float32Array(channels);
        this.pendingTotal = new Float32Array(channels);
        this.currentLow = new Float32Array(channels);
        this.currentTotal = new Float32Array(channels);
        const gainSquared = gain * gain;
        for (let channel = 0; channel < channels; channel++) {
            this.highPassMeanSlot[channel] = levels[channel] * gainSquared;
            this.slotHistory.push([1e-3, 1e-3, 1e-3]);
        }
    }
    pushGranule(pcm, actualFrames, consume) {
        if (this.sealed)
            throw new EncodeError('MP3 block classifier received PCM after finish');
        if (pcm.length !== 576 * this.channels) {
            throw new EncodeError(`MP3 block classifier needs ${576 * this.channels} samples, got ${pcm.length}`);
        }
        if (!Number.isInteger(actualFrames) || actualFrames < 0 || actualFrames > 576) {
            throw new EncodeError(`MP3 block classifier received invalid granule length ${actualFrames}`);
        }
        for (let channel = 0; channel < this.channels; channel++) {
            let attack = false;
            const history = this.slotHistory[channel];
            for (let slot = 0; slot < 12; slot++) {
                const start = slot * 48;
                const end = Math.min(start + 48, actualFrames);
                let energy = 0;
                for (let frame = start; frame < end; frame++) {
                    const value = pcm[frame * this.channels + channel];
                    const difference = value - this.highPassPrevious[channel];
                    this.highPassPrevious[channel] = value;
                    energy += difference * difference;
                }
                const reference = Math.max((history[0] + history[1] + history[2]) / 3, 1e-3);
                if (energy > 6 * reference && energy > 0.01 && energy > 0.5 * this.highPassMeanSlot[channel]) {
                    attack = true;
                }
                history.shift();
                history.push(energy);
            }
            let wanted = this.wantNow[channel] !== 0;
            if (attack) {
                wanted = true;
                this.wantNext[channel] = 1;
                this.wantAfter[channel] = 1;
            }
            this.currentWant[channel] = wanted ? 1 : 0;
            let low = 0;
            let total = 0;
            for (let frame = 0; frame < actualFrames; frame++) {
                const value = pcm[frame * this.channels + channel];
                this.lowPassPrevious[channel] += 0.05 * (value - this.lowPassPrevious[channel]);
                low += this.lowPassPrevious[channel] * this.lowPassPrevious[channel];
                total += value * value;
            }
            this.currentLow[channel] = Math.fround(low);
            this.currentTotal[channel] = Math.fround(total);
        }
        if (this.hasPending)
            this.emitPending(this.currentWant, consume);
        this.pendingWant.set(this.currentWant);
        let swap = this.pendingLow;
        this.pendingLow = this.currentLow;
        this.currentLow = swap;
        swap = this.pendingTotal;
        this.pendingTotal = this.currentTotal;
        this.currentTotal = swap;
        this.hasPending = true;
        this.wantNow.set(this.wantNext);
        this.wantNext.set(this.wantAfter);
        this.wantAfter.fill(0);
    }
    finish(consume) {
        if (this.sealed)
            throw new EncodeError('MP3 block classifier finished twice');
        this.sealed = true;
        if (!this.hasPending)
            throw new EncodeError('MP3 block classifier received no granules');
        this.currentWant.fill(0);
        this.emitPending(this.currentWant, consume);
        this.hasPending = false;
    }
    emitPending(nextWant, consume) {
        let packed = 0;
        for (let channel = 0; channel < this.channels; channel++) {
            const previous = this.previousBlock[channel];
            let block;
            if (this.pendingWant[channel] !== 0)
                block = 2;
            else if (nextWant[channel] !== 0) {
                block = previous === 2 || previous === 1 ? 2 : 1;
            }
            else
                block = previous === 2 ? 3 : 0;
            this.previousBlock[channel] = block;
            packed |= block << (channel * 2);
        }
        consume(packed, this.pendingLow, this.pendingTotal);
    }
}
class Mp3EpisodeBitWriter {
    bytes = new Uint8Array(16);
    countValue = 0;
    push(value) {
        const byte = this.countValue >>> 3;
        if (byte >= this.bytes.length) {
            const grown = new Uint8Array(this.bytes.length * 2);
            grown.set(this.bytes);
            this.bytes = grown;
        }
        if (value)
            this.bytes[byte] |= 1 << (this.countValue & 7);
        this.countValue++;
    }
    finish() {
        const bits = this.bytes.slice(0, Math.ceil(this.countValue / 8));
        this.bytes = new Uint8Array(0);
        return { bits, count: this.countValue };
    }
}
export class Mp3PlanAnalyzer {
    sampleRate;
    channels;
    levels;
    gain;
    totalFrames;
    totalGranules;
    queue;
    classifier;
    episodeBits = [];
    episodeActive = [];
    episodeLow = [];
    episodeHigh = [];
    episodeLowSum = [];
    episodeTotalSum = [];
    receivedFrames = 0;
    granulesProcessed = 0;
    granulesPlanned = 0;
    sealed = false;
    constructor(sampleRate, channels, levels, gain = 1) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.levels = levels;
        this.gain = gain;
        if (levels.sourceFrameCount <= 0)
            throw new EncodeError('encodeMP3: empty input');
        if (levels.highPassMeanSlot.length !== channels) {
            throw new EncodeError('MP3 level summary channel mismatch');
        }
        this.totalFrames = Math.ceil(levels.sourceFrameCount / MP3_SAMPLES_PER_FRAME) + 1;
        this.totalGranules = this.totalFrames * 2;
        this.queue = new InterleavedPcmQueue(channels);
        this.classifier = new Mp3RollingBlockClassifier(channels, levels.highPassMeanSlot, gain);
        for (let channel = 0; channel < channels; channel++) {
            this.episodeBits.push(new Mp3EpisodeBitWriter());
            this.episodeActive.push(false);
            this.episodeLow.push(Number.POSITIVE_INFINITY);
            this.episodeHigh.push(0);
            this.episodeLowSum.push(0);
            this.episodeTotalSum.push(0);
        }
    }
    get peakBufferedFrames() {
        return this.queue.peakBufferedFrames;
    }
    pushPlanar(planes) {
        this.assertOpen();
        const frames = planes[0]?.length ?? 0;
        this.queue.pushPlanar(planes, this.gain);
        this.receivedFrames += frames;
        this.drainGranules();
    }
    pushInterleaved(pcm) {
        this.assertOpen();
        if (pcm.length % this.channels !== 0) {
            throw new EncodeError('MP3 plan PCM is not channel-aligned');
        }
        const frames = pcm.length / this.channels;
        const scaled = this.gain === 1 ? pcm : Float32Array.from(pcm, value => value * this.gain);
        this.queue.pushInterleaved(scaled);
        this.receivedFrames += frames;
        this.drainGranules();
    }
    finish() {
        this.assertOpen();
        this.sealed = true;
        if (this.receivedFrames !== this.levels.sourceFrameCount) {
            throw new EncodeError(`MP3 replay length changed (${this.levels.sourceFrameCount} -> ${this.receivedFrames})`);
        }
        if (this.queue.bufferedFrames > 0) {
            const actual = this.queue.bufferedFrames;
            this.analyzeGranule(this.queue.takeFrames(576, true), actual);
        }
        while (this.granulesProcessed < this.totalGranules) {
            this.analyzeGranule(new Float32Array(576 * this.channels), 0);
        }
        this.classifier.finish((blocks, low, total) => this.consumeGranule(blocks, low, total));
        if (this.granulesPlanned !== this.totalGranules) {
            throw new EncodeError(`MP3 planner produced ${this.granulesPlanned}/${this.totalGranules} granules`);
        }
        for (let channel = 0; channel < this.channels; channel++) {
            if (this.episodeActive[channel])
                this.finishEpisode(channel);
        }
        return {
            sampleRate: this.sampleRate,
            channels: this.channels,
            sourceFrameCount: this.levels.sourceFrameCount,
            totalFrames: this.totalFrames,
            gain: this.gain,
            highPassMeanSlot: Float64Array.from(this.levels.highPassMeanSlot),
            mixedEpisodes: this.episodeBits.map(writer => writer.finish()),
        };
    }
    assertOpen() {
        if (this.sealed)
            throw new EncodeError('MP3 plan analyzer received PCM after finish');
    }
    drainGranules() {
        while (this.queue.bufferedFrames >= 576) {
            this.analyzeGranule(this.queue.takeFrames(576), 576);
        }
    }
    analyzeGranule(pcm, actualFrames) {
        if (this.granulesProcessed >= this.totalGranules) {
            throw new EncodeError('MP3 replay contains more PCM than its level pass');
        }
        this.classifier.pushGranule(pcm, actualFrames, (blocks, low, total) => this.consumeGranule(blocks, low, total));
        this.granulesProcessed++;
    }
    consumeGranule(packedBlocks, lowEnergy, totalEnergy) {
        this.granulesPlanned++;
        for (let channel = 0; channel < this.channels; channel++) {
            const block = (packedBlocks >>> (channel * 2)) & 3;
            if (block === 0) {
                if (this.episodeActive[channel])
                    this.finishEpisode(channel);
                continue;
            }
            if (!this.episodeActive[channel]) {
                this.episodeActive[channel] = true;
                this.episodeLow[channel] = Number.POSITIVE_INFINITY;
                this.episodeHigh[channel] = 0;
                this.episodeLowSum[channel] = 0;
                this.episodeTotalSum[channel] = 0;
            }
            const low = lowEnergy[channel];
            this.episodeLow[channel] = Math.min(this.episodeLow[channel], low);
            this.episodeHigh[channel] = Math.max(this.episodeHigh[channel], low);
            this.episodeLowSum[channel] += low;
            this.episodeTotalSum[channel] += totalEnergy[channel];
        }
    }
    finishEpisode(channel) {
        const low = this.episodeLow[channel];
        const high = this.episodeHigh[channel];
        const lowSum = this.episodeLowSum[channel];
        const totalSum = this.episodeTotalSum[channel];
        const stationary = high < 4 * Math.max(low, 1e-9);
        const dominant = totalSum > 1e-9 && lowSum / totalSum > 0.3 && lowSum > 1e-6;
        this.episodeBits[channel].push(stationary && dominant);
        this.episodeActive[channel] = false;
    }
}
export class StreamingMp3Encoder {
    plan;
    bitrate;
    options;
    analysisQueue;
    encodeQueue;
    classifier;
    machine;
    plannedGranules = [];
    episodeActive = [];
    episodeMixed;
    episodeIndex;
    blockScratch = [];
    mixedScratch = [];
    receivedFrames = 0;
    granulesAnalysed = 0;
    granulesPlanned = 0;
    frameIndex = 0;
    sealed = false;
    constructor(plan, bitrate = 128, options = {}) {
        this.plan = plan;
        this.bitrate = bitrate;
        this.options = options;
        if (plan.highPassMeanSlot.length !== plan.channels || plan.mixedEpisodes.length !== plan.channels) {
            throw new EncodeError('MP3 streaming plan channel mismatch');
        }
        this.analysisQueue = new InterleavedPcmQueue(plan.channels);
        this.encodeQueue = new InterleavedPcmQueue(plan.channels);
        this.classifier = new Mp3RollingBlockClassifier(plan.channels, plan.highPassMeanSlot, plan.gain);
        this.episodeMixed = new Uint8Array(plan.channels);
        this.episodeIndex = new Uint32Array(plan.channels);
        for (let channel = 0; channel < plan.channels; channel++) {
            this.episodeActive.push(false);
            this.blockScratch.push(new Uint8Array(2));
            this.mixedScratch.push(new Uint8Array(2));
        }
        this.machine = encodeMP3FrameMachine(plan.sampleRate, plan.channels, bitrate, options, plan.totalFrames);
        this.machine.next();
    }
    get framesReceived() {
        return this.receivedFrames;
    }
    get framesProduced() {
        return this.frameIndex;
    }
    get peakBufferedFrames() {
        return Math.max(this.analysisQueue.peakBufferedFrames, this.encodeQueue.peakBufferedFrames);
    }
    pushPlanar(planes) {
        this.assertOpen();
        if (planes.length !== this.plan.channels) {
            throw new EncodeError(`MP3 stream expected ${this.plan.channels} channels, got ${planes.length}`);
        }
        const frames = planes[0]?.length ?? 0;
        for (let channel = 1; channel < planes.length; channel++) {
            if (planes[channel].length !== frames) {
                throw new EncodeError('MP3 stream channel planes have different lengths');
            }
        }
        if (frames === 0)
            return;
        const scaled = new Float32Array(frames * this.plan.channels);
        let at = 0;
        for (let frame = 0; frame < frames; frame++) {
            for (let channel = 0; channel < this.plan.channels; channel++) {
                scaled[at++] = planes[channel][frame] * this.plan.gain;
            }
        }
        this.feedScaled(scaled, frames);
    }
    pushInterleaved(pcm) {
        this.assertOpen();
        if (pcm.length % this.plan.channels !== 0) {
            throw new EncodeError('MP3 stream PCM is not channel-aligned');
        }
        const frames = pcm.length / this.plan.channels;
        const scaled = this.plan.gain === 1 ? pcm : Float32Array.from(pcm, value => value * this.plan.gain);
        this.feedScaled(scaled, frames);
    }
    finish() {
        const result = this.finishOutput();
        return new Blob([result.infoFrame, result.audioBlob], { type: 'audio/mpeg' });
    }
    finishOutput() {
        this.assertOpen();
        this.sealed = true;
        if (this.receivedFrames !== this.plan.sourceFrameCount) {
            throw new EncodeError(`MP3 replay length changed (${this.plan.sourceFrameCount} -> ${this.receivedFrames})`);
        }
        if (this.analysisQueue.bufferedFrames > 0) {
            const actual = this.analysisQueue.bufferedFrames;
            this.analyseGranule(this.analysisQueue.takeFrames(576, true), actual);
        }
        const totalGranules = this.plan.totalFrames * 2;
        while (this.granulesAnalysed < totalGranules) {
            this.analyseGranule(new Float32Array(576 * this.plan.channels), 0);
        }
        this.classifier.finish(blocks => this.consumeBlocks(blocks));
        if (this.granulesPlanned !== totalGranules) {
            throw new EncodeError(`MP3 encode replay planned ${this.granulesPlanned}/${totalGranules} granules`);
        }
        for (let channel = 0; channel < this.plan.channels; channel++) {
            const consumed = this.episodeIndex[channel];
            const expected = this.plan.mixedEpisodes[channel].count;
            if (consumed !== expected) {
                throw new EncodeError(`MP3 replay block episodes changed for channel ${channel} (${expected} -> ${consumed})`);
            }
        }
        while (this.frameIndex < this.plan.totalFrames) {
            if (this.plannedGranules.length < 2) {
                throw new EncodeError('MP3 block planner ended before the audio frames');
            }
            const pcm = this.encodeQueue.bufferedFrames > 0
                ? this.encodeQueue.takeFrames(MP3_SAMPLES_PER_FRAME, true)
                : new Float32Array(MP3_SAMPLES_PER_FRAME * this.plan.channels);
            this.emit(pcm, this.plannedGranules.shift(), this.plannedGranules.shift());
        }
        if (this.plannedGranules.length !== 0 || this.encodeQueue.bufferedFrames !== 0) {
            throw new EncodeError('MP3 streaming planner left unconsumed PCM or block plans');
        }
        const result = this.machine.next({
            kind: 'finish',
            sourceFrameCount: this.plan.sourceFrameCount,
        });
        if (!result.done)
            throw new EncodeError('MP3 frame machine did not finish');
        return result.value;
    }
    assertOpen() {
        if (this.sealed)
            throw new EncodeError('MP3 encoder received PCM after finish');
        this.options.signal?.throwIfAborted();
    }
    feedScaled(pcm, frames) {
        this.analysisQueue.pushInterleaved(pcm);
        this.encodeQueue.pushInterleaved(pcm);
        this.receivedFrames += frames;
        while (this.analysisQueue.bufferedFrames >= 576) {
            this.analyseGranule(this.analysisQueue.takeFrames(576), 576);
        }
        this.options.onBufferedFrames?.(this.encodeQueue.bufferedFrames, this.peakBufferedFrames);
    }
    analyseGranule(pcm, actualFrames) {
        const totalGranules = this.plan.totalFrames * 2;
        if (this.granulesAnalysed >= totalGranules) {
            throw new EncodeError('MP3 encode replay contains more PCM than its plan');
        }
        this.classifier.pushGranule(pcm, actualFrames, blocks => this.consumeBlocks(blocks));
        this.granulesAnalysed++;
        this.drainReadyFrames();
    }
    consumeBlocks(packedBlocks) {
        let packedPlan = 0;
        for (let channel = 0; channel < this.plan.channels; channel++) {
            const block = (packedBlocks >>> (channel * 2)) & 3;
            if (block === 0) {
                this.episodeActive[channel] = false;
                this.episodeMixed[channel] = 0;
            }
            else if (!this.episodeActive[channel]) {
                const episode = this.plan.mixedEpisodes[channel];
                const index = this.episodeIndex[channel];
                if (index >= episode.count) {
                    throw new EncodeError(`MP3 replay added a block episode on channel ${channel}`);
                }
                this.episodeMixed[channel] = (episode.bits[index >>> 3] >>> (index & 7)) & 1;
                this.episodeIndex[channel] = index + 1;
                this.episodeActive[channel] = true;
            }
            const mixed = block === 2 ? this.episodeMixed[channel] : 0;
            packedPlan |= block << (channel * 3);
            packedPlan |= mixed << (channel * 3 + 2);
        }
        this.plannedGranules.push(packedPlan);
        this.granulesPlanned++;
    }
    drainReadyFrames() {
        while (this.plannedGranules.length >= 2 &&
            this.encodeQueue.bufferedFrames >= MP3_SAMPLES_PER_FRAME &&
            this.frameIndex < Math.floor(this.plan.sourceFrameCount / MP3_SAMPLES_PER_FRAME)) {
            this.emit(this.encodeQueue.takeFrames(MP3_SAMPLES_PER_FRAME), this.plannedGranules.shift(), this.plannedGranules.shift());
        }
    }
    emit(pcm, firstPlan, secondPlan) {
        for (let channel = 0; channel < this.plan.channels; channel++) {
            const shift = channel * 3;
            this.blockScratch[channel][0] = (firstPlan >>> shift) & 3;
            this.blockScratch[channel][1] = (secondPlan >>> shift) & 3;
            this.mixedScratch[channel][0] = (firstPlan >>> (shift + 2)) & 1;
            this.mixedScratch[channel][1] = (secondPlan >>> (shift + 2)) & 1;
        }
        let pcmEnergy = 0;
        if (this.options.vbr === true) {
            for (let frame = 0; frame < MP3_SAMPLES_PER_FRAME; frame += 2) {
                const value = pcm[frame * this.plan.channels];
                pcmEnergy += value * value;
            }
        }
        const step = this.machine.next({
            kind: 'frame',
            pcm,
            blockPlan: this.blockScratch,
            mixedPlan: this.mixedScratch,
            pcmEnergy,
        });
        if (step.done)
            throw new EncodeError('MP3 frame machine ended before flush');
        this.frameIndex++;
    }
}
function* encodeMP3FrameMachine(sampleRate, channels, bitrate, options, totalFramesHint) {
    if (channels !== 1 && channels !== 2) {
        throw new EncodeError(`encodeMP3: channels must be 1 or 2, got ${channels}`);
    }
    const srIdx = SR_TAB.indexOf(sampleRate);
    if (srIdx < 0)
        throw new EncodeError(`encodeMP3: unsupported sample rate ${sampleRate} (need 32000/44100/48000)`);
    const brIdx = BR_TAB.indexOf(bitrate);
    if (brIdx < 1)
        throw new EncodeError(`encodeMP3: unsupported bitrate ${bitrate}`);
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
    const vbuf = [];
    for (let ch = 0; ch < nch; ch++)
        vbuf.push(new Float64Array(512));
    const win64 = new Float64Array(64);
    const prevMdct = [];
    for (let ch = 0; ch < nch; ch++)
        prevMdct.push(new Float64Array(32 * 18));
    const mdctCur = new Float64Array(18);
    const mdctOut = new Float64Array(18);
    const subbands = new Float64Array(nch * 2 * 18 * 32);
    const spec = new Float64Array(nch * 2 * 576);
    const granuleCount = nch * 2;
    const energies = new Float64Array(granuleCount);
    const granQ = new Int16Array(granuleCount * 576);
    const granSf = new Uint8Array(granuleCount * SHORT_BLOCK_SCF_BANDS);
    const sfb_s = SFB_S[sampleRate];
    const shortBounds = buildShortBounds(sfb_s);
    const mixedBounds = buildMixedBounds(sfb_l, shortBounds);
    const work = makeGranWork(Math.max(sfb_l.length, shortBounds.length) - 1);
    const rawShort = new Float64Array(576);
    const vbr = options.vbr === true;
    if (!Number.isSafeInteger(totalFramesHint) || totalFramesHint <= 0) {
        throw new EncodeError(`encodeMP3: invalid total frame count ${totalFramesHint}`);
    }
    const targetFrameBytes = Math.floor((144000 * bitrate) / sampleRate);
    let vbrCredit = 0;
    const tocCumulativeBytes = vbr ? new Float64Array(100) : null;
    const infoFrameSize = vbr ? mp3GaplessInfoFrameSize(sampleRate, channels, bitrate) : 0;
    let tocIndex = 0;
    let plannedAudioByteLength = 0;
    if (tocCumulativeBytes) {
        tocCumulativeBytes[0] = infoFrameSize;
        tocIndex = 1;
    }
    const mdFrame = new Uint8Array(4096);
    const mainChunks = [];
    let mainChunkOffset = 0;
    let frameWasHungry = false;
    let mainQueuedBytes = 0;
    let mainWritten = 0;
    let regionStart = 0;
    const pendingFrames = [];
    const emitReady = () => {
        while (pendingFrames.length > 0 && mainQueuedBytes >= pendingFrames[0].mainSlots) {
            const pf = pendingFrames.shift();
            const out = new Uint8Array(pf.frameSize);
            out.set(pf.header, 0);
            let at = pf.header.length;
            let need = pf.mainSlots;
            while (need > 0) {
                const head = mainChunks[0];
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
            throw new EncodeError(`MP3 frame needs ${MP3_SAMPLES_PER_FRAME * nch} PCM samples, got ${pcm.length}`);
        }
        let frameBrIdx = brIdx;
        let frameSize;
        let padding;
        if (vbr) {
            let hasShort = false;
            for (let ch = 0; ch < nch; ch++) {
                if (command.blockPlan[ch][0] === 2 || command.blockPlan[ch][1] === 2)
                    hasShort = true;
            }
            if (hasShort)
                frameBrIdx = BR_TAB.length - 1;
            else if (command.pcmEnergy < 1e-6)
                frameBrIdx = 1;
            else {
                const drift = Math.round(vbrCredit / (2 * targetFrameBytes));
                frameBrIdx = Math.max(1, Math.min(BR_TAB.length - 1, brIdx + Math.max(-3, Math.min(5, drift))));
            }
            frameSize = Math.floor((144000 * BR_TAB[frameBrIdx]) / sampleRate);
            padding = 0;
            vbrCredit += targetFrameBytes - frameSize;
        }
        else {
            ({ size: frameSize, padding } = sizer.next());
        }
        plannedAudioByteLength += frameSize;
        if (tocCumulativeBytes) {
            const plannedFrames = frameIndex + 1;
            while (tocIndex < 100 && Math.ceil((tocIndex * totalFramesHint) / 100) <= plannedFrames) {
                tocCumulativeBytes[tocIndex++] = infoFrameSize + plannedAudioByteLength;
            }
        }
        frame.fill(0, 0, frameSize);
        const mainSlots = frameSize - 4 - sideLen;
        const mainDataBegin = regionStart - mainWritten;
        if (mainDataBegin < 0 || mainDataBegin > 511) {
            throw new EncodeError(`encodeMP3: reservoir accounting broke (main_data_begin=${mainDataBegin})`);
        }
        const availableBits = (mainSlots + mainDataBegin) * 8;
        const pcmBase = 0;
        for (let gr = 0; gr < 2; gr++) {
            for (let ch = 0; ch < nch; ch++) {
                const sbBase = (ch * 2 + gr) * 18 * 32;
                for (let ss = 0; ss < 18; ss++) {
                    analysisFilterbank(pcm, pcmBase + (gr * 576 + ss * 32) * nch + ch, nch, vbuf[ch], subbands, sbBase + ss * 32, win64);
                }
                applyFrequencyInversion(subbands, sbBase);
            }
        }
        for (let ch = 0; ch < nch; ch++) {
            for (let gr = 0; gr < 2; gr++) {
                const blockType = command.blockPlan[ch][gr];
                const grMixed = blockType === 2 && command.mixedPlan[ch][gr] === 1;
                const sbBase = (ch * 2 + gr) * 18 * 32;
                const spBase = (ch * 2 + gr) * 576;
                const target = blockType === 2 ? rawShort : spec;
                const targetOff = blockType === 2 ? 0 : spBase;
                for (let sb = 0; sb < 32; sb++) {
                    for (let ss = 0; ss < 18; ss++)
                        mdctCur[ss] = subbands[sbBase + ss * 32 + sb];
                    mdctGranule(mdctCur, prevMdct[ch].subarray(sb * 18, sb * 18 + 18), mdctOut, grMixed && sb < 2 ? 0 : blockType);
                    for (let k = 0; k < 18; k++)
                        target[targetOff + sb * 18 + k] = mdctOut[k];
                }
                if (blockType === 2) {
                    if (grMixed)
                        reorderMixedGranule(rawShort, spec, spBase, sfb_s);
                    else
                        reorderShortGranule(rawShort, spec, spBase, sfb_s);
                    if (grMixed && cutoffLine < 36)
                        spec.fill(0, spBase + cutoffLine, spBase + 36);
                    if (cutoffLine < 576) {
                        const cutoffShortLine = Math.floor(cutoffLine / 3);
                        for (let sfb = grMixed ? 3 : 0; sfb < sfb_s.length - 1; sfb++) {
                            const bandStart = sfb_s[sfb];
                            const bandEnd = sfb_s[sfb + 1];
                            if (bandEnd <= cutoffShortLine)
                                continue;
                            const width = bandEnd - bandStart;
                            const from = Math.max(0, cutoffShortLine - bandStart);
                            for (let w = 0; w < 3; w++) {
                                const base = spBase + 3 * bandStart + w * width;
                                spec.fill(0, base + from, base + width);
                            }
                        }
                    }
                }
                else {
                    applyAntialias(spec, spBase);
                    if (cutoffLine < 576)
                        applySimpleLowpass(spec, spBase, cutoffLine);
                }
            }
        }
        let msFrame = false;
        if (!mono) {
            const btMatch = command.blockPlan[0][0] === command.blockPlan[1][0] &&
                command.blockPlan[0][1] === command.blockPlan[1][1] &&
                command.mixedPlan[0][0] === command.mixedPlan[1][0] &&
                command.mixedPlan[0][1] === command.mixedPlan[1][1];
            if (btMatch) {
                let em = 0;
                let es = 0;
                for (let gr = 0; gr < 2; gr++) {
                    const lOff = gr * 576;
                    const rOff = (2 + gr) * 576;
                    for (let i = 0; i < 576; i++) {
                        const l = spec[lOff + i];
                        const r = spec[rOff + i];
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
                            const l = spec[lOff + i];
                            const r = spec[rOff + i];
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
        let totalEnergy = 0;
        for (let gi = 0; gi < granuleCount; gi++) {
            const off = gi * 576;
            let energy = 0;
            for (let i = 0; i < 576; i++) {
                const v = spec[off + i];
                energy += v * v;
            }
            energies[gi] = energy;
            totalEnergy += energy;
        }
        const grans = new Array(granuleCount);
        let remainingBits = availableBits;
        let remainingEnergy = totalEnergy > 1e-18 ? totalEnergy : granuleCount;
        for (let gi = 0; gi < granuleCount; gi++) {
            const granuleEnergy = totalEnergy > 1e-18 ? energies[gi] : 1;
            const granulesLeft = granuleCount - gi;
            const baseShare = Math.floor(remainingBits / Math.max(1, granulesLeft));
            const weightedShare = Math.floor((remainingBits * granuleEnergy) / Math.max(remainingEnergy, 1e-18));
            const targetBits = Math.max(64, Math.min(4095, remainingBits - 64 * (granulesLeft - 1), Math.max(baseShare, weightedShare)));
            const giCh = (gi / 2) | 0;
            const giGr = gi % 2;
            const giBt = command.blockPlan[giCh][giGr];
            const isShort = giBt === 2;
            const giMixed = isShort && command.mixedPlan[giCh][giGr] === 1;
            const runGranule = (bits) => {
                const enc = encodeGranuleFast(spec, gi * 576, bits, giMixed ? mixedBounds : isShort ? shortBounds : sfb_l, giMixed ? MIXED_BLOCK_SCF_BANDS : isShort ? SHORT_BLOCK_SCF_BANDS : LONG_BLOCK_SCF_BANDS, giMixed ? MIXED_BLOCK_SCF_SPLIT : isShort ? SHORT_BLOCK_SCF_SPLIT : LONG_BLOCK_SCF_SPLIT, giBt, giMixed, sampleRate, work, granQ.subarray(gi * 576, gi * 576 + 576), granSf.subarray(gi * SHORT_BLOCK_SCF_BANDS, (gi + 1) * SHORT_BLOCK_SCF_BANDS));
                enc.mixedFlag = giMixed ? 1 : 0;
                return enc;
            };
            const THRIFT = 0.85;
            const BASE_THRIFT = isShort ? 0.95 : 0.7;
            const thriftyBits = Math.max(64, Math.floor(targetBits * THRIFT));
            const budget = Math.max(64, Math.floor(targetBits * BASE_THRIFT));
            let chosen = frameWasHungry ? runGranule(budget) : runGranule(Math.min(budget, thriftyBits));
            frameWasHungry = !chosen.satisfied;
            if (!chosen.satisfied && chosen.part23Length < targetBits * 0.99) {
                chosen = runGranule(budget);
            }
            grans[gi] = chosen;
            remainingBits = Math.max(0, remainingBits - grans[gi].part23Length);
            remainingEnergy = Math.max(1e-18, remainingEnergy - granuleEnergy);
        }
        const si = new Bits(frame, 4);
        si.put(mainDataBegin, 9);
        si.put(0, mono ? 5 : 3);
        for (let ch = 0; ch < nch; ch++)
            si.put(0, 4);
        for (let gr = 0; gr < 2; gr++) {
            for (let ch = 0; ch < nch; ch++) {
                const g = grans[ch * 2 + gr];
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
                }
                else {
                    si.put(1, 1);
                    si.put(g.blockType, 2);
                    si.put(g.mixedFlag, 1);
                    si.put(g.tableSelect[0], 5);
                    si.put(g.tableSelect[1], 5);
                    si.put(g.subblockGain[0], 3);
                    si.put(g.subblockGain[1], 3);
                    si.put(g.subblockGain[2], 3);
                }
                si.put(0, 1);
                si.put(g.scalefacScale, 1);
                si.put(g.count1Table, 1);
            }
        }
        if (si.pos !== (4 + sideLen) * 8) {
            throw new EncodeError(`encodeMP3: side-info mismatch (wrote ${si.pos}, expected ${(4 + sideLen) * 8})`);
        }
        mdFrame.fill(0);
        const md = new Bits(mdFrame, 0);
        for (let gr = 0; gr < 2; gr++) {
            for (let ch = 0; ch < nch; ch++) {
                const gi = ch * 2 + gr;
                const g = grans[gi];
                const q = granQ.subarray(gi * 576, gi * 576 + 576);
                const sf = granSf.subarray(gi * SHORT_BLOCK_SCF_BANDS, (gi + 1) * SHORT_BLOCK_SCF_BANDS);
                const [region0Pairs, region1Pairs] = g.blockType === 0
                    ? regionPairBoundaries(g.bigValues, g.region0Count, g.region1Count, sfb_l)
                    : [Math.min(g.bigValues, (g.blockType === 2 ? 36 : sfb_l[8]) >> 1), g.bigValues];
                const count1Ht = g.count1Table === 0 ? HT32 : HT33;
                const [slen1, slen2] = SFC_SLEN[g.scalefacCompress];
                const granuleStartBit = md.pos;
                if (g.blockType === 2) {
                    const bands = g.mixedFlag ? MIXED_BLOCK_SCF_BANDS : SHORT_BLOCK_SCF_BANDS;
                    const split = g.mixedFlag ? MIXED_BLOCK_SCF_SPLIT : SHORT_BLOCK_SCF_SPLIT;
                    for (let j = 0; j < bands; j++) {
                        const slen = j < split ? slen1 : slen2;
                        if (slen > 0)
                            md.put(sf[j], slen);
                    }
                }
                else {
                    for (let sfb = 0; sfb < LONG_BLOCK_SCF_BANDS; sfb++) {
                        const slen = sfb < LONG_BLOCK_SCF_SPLIT ? slen1 : slen2;
                        if (slen > 0)
                            md.put(sf[sfb], slen);
                    }
                }
                for (let p = 0; p < g.bigValues; p++) {
                    const tableId = p < region0Pairs ? g.tableSelect[0] : p < region1Pairs ? g.tableSelect[1] : g.tableSelect[2];
                    const table = HTABLES[tableId] ?? HT0;
                    const mv = table.maxval;
                    const lb = table.linbits;
                    const x = q[p * 2];
                    const y = q[p * 2 + 1];
                    const ax = Math.abs(x);
                    const ay = Math.abs(y);
                    const hx = Math.min(ax, mv);
                    const hy = Math.min(ay, mv);
                    const entry = table.entries[hx * table.xlen + hy];
                    if (!entry)
                        throw new EncodeError(`encodeMP3: missing Huffman entry table=${tableId} x=${hx} y=${hy}`);
                    md.put(entry[1], entry[0]);
                    if (lb > 0 && ax >= mv)
                        md.put(ax - mv, lb);
                    if (ax)
                        md.put(x < 0 ? 1 : 0, 1);
                    if (lb > 0 && ay >= mv)
                        md.put(ay - mv, lb);
                    if (ay)
                        md.put(y < 0 ? 1 : 0, 1);
                }
                for (let i = g.count1Start; i < g.count1End; i += 4) {
                    const v = q[i], w = q[i + 1], x = q[i + 2], y = q[i + 3];
                    const av = Math.abs(v), aw = Math.abs(w), ax = Math.abs(x), ay = Math.abs(y);
                    if (av > 1 || aw > 1 || ax > 1 || ay > 1) {
                        throw new EncodeError(`encodeMP3: invalid count1 tuple at frame=${frameIndex} gr=${gr} ch=${ch}`);
                    }
                    const idx = (av ? 8 : 0) | (aw ? 4 : 0) | (ax ? 2 : 0) | (ay ? 1 : 0);
                    md.put(count1Ht[idx][1], count1Ht[idx][0]);
                    if (av)
                        md.put(v < 0 ? 1 : 0, 1);
                    if (aw)
                        md.put(w < 0 ? 1 : 0, 1);
                    if (ax)
                        md.put(x < 0 ? 1 : 0, 1);
                    if (ay)
                        md.put(y < 0 ? 1 : 0, 1);
                }
                const granuleBits = md.pos - granuleStartBit;
                if (granuleBits !== g.part23Length) {
                    throw new EncodeError(`encodeMP3: main-data length mismatch frame=${frameIndex} gr=${gr} ch=${ch} wrote=${granuleBits} expected=${g.part23Length}`);
                }
            }
        }
        if (md.pos > availableBits) {
            throw new EncodeError(`encodeMP3: main-data overflow (wrote ${md.pos}, available ${availableBits})`);
        }
        let mainBytes = (md.pos + 7) >> 3;
        const nextBegin = regionStart + mainSlots - (mainWritten + mainBytes);
        if (nextBegin > 511)
            mainBytes += nextBegin - 511;
        if (mainBytes > mdFrame.length) {
            throw new EncodeError(`encodeMP3: main-data scratch overflow (${mainBytes} bytes)`);
        }
        mainChunks.push(mdFrame.slice(0, mainBytes));
        mainQueuedBytes += mainBytes;
        mainWritten += mainBytes;
        pendingFrames.push({ header: frame.slice(0, 4 + sideLen), mainSlots, frameSize });
        regionStart += mainSlots;
        emitReady();
        frameIndex++;
        options.onProgress?.({
            completedFrames: frameIndex,
            totalFrames: totalFramesHint,
        });
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
        throw new EncodeError('encodeMP3: frames left unemitted after reservoir flush');
    }
    if (frameIndex !== totalFramesHint) {
        throw new EncodeError(`encodeMP3: frame count changed (${totalFramesHint} -> ${frameIndex})`);
    }
    if (plannedAudioByteLength !== audioByteLength || (vbr && tocIndex !== 100)) {
        throw new EncodeError('encodeMP3: VBR byte-accounting checkpoint mismatch');
    }
    const infoFrame = createGaplessInfoFrame(sampleRate, channels, bitrate, totalFrames, audioByteLength, sourceFrameCount, vbr, tocCumulativeBytes);
    return {
        infoFrame,
        audioBlob: sink?.toBlob('audio/mpeg') ?? new Blob([], { type: 'audio/mpeg' }),
    };
}
function* encodeMP3FramesViaMachine(pcm, sampleRate, channels, bitrate, options) {
    if (channels !== 1 && channels !== 2) {
        throw new EncodeError(`encodeMP3: channels must be 1 or 2, got ${channels}`);
    }
    const sourceFrameCount = Math.floor(pcm.length / channels);
    if (sourceFrameCount === 0)
        throw new EncodeError('encodeMP3: empty input');
    const totalFrames = Math.ceil(sourceFrameCount / MP3_SAMPLES_PER_FRAME) + 1;
    const totalGranules = totalFrames * 2;
    const blockPlan = [];
    const mixedPlan = [];
    for (let channel = 0; channel < channels; channel++) {
        blockPlan.push(computeBlockTypes(pcm, channels, channel, totalGranules));
    }
    for (let channel = 0; channel < channels; channel++) {
        mixedPlan.push(computeMixedFlags(pcm, channels, channel, totalGranules, blockPlan[channel]));
    }
    const machine = encodeMP3FrameMachine(sampleRate, channels, bitrate, options, totalFrames);
    machine.next();
    const frameSamples = MP3_SAMPLES_PER_FRAME * channels;
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        options.signal?.throwIfAborted();
        const framePcm = new Float32Array(frameSamples);
        const from = frameIndex * frameSamples;
        const to = Math.min(from + frameSamples, pcm.length);
        if (from < to)
            framePcm.set(pcm.subarray(from, to));
        let pcmEnergy = 0;
        if (options.vbr === true) {
            const realFrames = Math.min(MP3_SAMPLES_PER_FRAME, Math.max(0, sourceFrameCount - frameIndex * MP3_SAMPLES_PER_FRAME));
            for (let frame = 0; frame < realFrames; frame += 2) {
                const value = framePcm[frame * channels];
                pcmEnergy += value * value;
            }
        }
        const step = machine.next({
            kind: 'frame',
            pcm: framePcm,
            blockPlan: blockPlan.map(plan => plan.subarray(frameIndex * 2, frameIndex * 2 + 2)),
            mixedPlan: mixedPlan.map(plan => plan.subarray(frameIndex * 2, frameIndex * 2 + 2)),
            pcmEnergy,
        });
        if (step.done)
            throw new EncodeError('MP3 frame machine ended before flush');
        yield;
    }
    const result = machine.next({ kind: 'finish', sourceFrameCount });
    if (!result.done)
        throw new EncodeError('MP3 frame machine did not finish');
    return new Blob([result.value.infoFrame, result.value.audioBlob], { type: 'audio/mpeg' });
}
export function encodeMP3(pcm, sampleRate, channels, bitrate = 128, options = {}) {
    const it = encodeMP3FramesViaMachine(pcm, sampleRate, channels, bitrate, options);
    for (;;) {
        const step = it.next();
        if (step.done)
            return step.value;
    }
}
export async function encodeMP3Async(pcm, sampleRate, channels, bitrate = 128, options = {}) {
    const it = encodeMP3FramesViaMachine(pcm, sampleRate, channels, bitrate, options);
    for (;;) {
        const step = it.next();
        if (step.done)
            return step.value;
        options.signal?.throwIfAborted();
        await yieldToEventLoop();
        options.signal?.throwIfAborted();
    }
}
