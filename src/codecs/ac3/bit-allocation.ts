import { BAND_START, BIN_BAND, HEARING_THRESHOLD, LOG_ADD } from './tables';

/**
 * The parametric bit allocation of A/52 7.2: the power spectral density of the exponents, the
 * excitation and masking curve of each critical band, and the bit allocation pointer of each bin.
 * All values are in the standard's integer units (128 PSD units per 6 dB).
 */

/** The bit allocation parameters a block states, in PSD units. */
export interface AllocationParameters {
    slowDecay: number;
    fastDecay: number;
    slowGain: number;
    dbPerBit: number;
    floor: number;
    /** The coupling channel's fast and slow leak codes. */
    cplFastLeak: number;
    cplSlowLeak: number;
    /** Sample rate code and its shift (half and quarter rates) into the hearing threshold. */
    rateCode: number;
    rateShift: number;
}

/** Delta bit allocation of one channel: offsets, lengths and values of its segments. */
export interface DeltaAllocation {
    mode: number;
    segments: number;
    offsets: Uint8Array;
    lengths: Uint8Array;
    values: Uint8Array;
}

/** PSD of the bins from `start` to `end` and of the bands they cover (7.2.2.2-3). */
export function integratePsd(
    exponents: Int8Array,
    start: number,
    end: number,
    psd: Int16Array,
    bandPsd: Int16Array,
): void {
    for (let bin = start; bin < end; bin++) psd[bin] = 3072 - (exponents[bin]! << 7);
    let bin = start;
    for (; bin < Math.min(end, 28); bin++) bandPsd[bin] = psd[bin]!;
    if (bin >= end) return;
    let band = BIN_BAND[bin]!;
    do {
        let value = psd[bin++]!;
        const bandEnd = Math.min(BAND_START[band + 1]!, end);
        for (; bin < bandEnd; bin++) {
            const next = psd[bin]!;
            const max = value > next ? value : next;
            const address = Math.min(max - ((value + next + 1) >> 1), 255);
            value = max + LOG_ADD[address]!;
        }
        bandPsd[band++] = value;
    } while (end > BAND_START[band]!);
}

/** Low-frequency compensation of one band step (7.2.2.4). */
function lowComp(previous: number, b0: number, b1: number, band: number): number {
    if (band >= 20) return Math.max(previous - 128, 0);
    if (b0 + 256 === b1) return band < 7 ? 384 : 320;
    return b0 > b1 ? Math.max(previous - 64, 0) : previous;
}

/**
 * The masking curve of the bands covering bins `start` to `end` (7.2.2.4-6): excitation with fast
 * and slow leaks, the hearing threshold, and the delta bit allocation of the channel. False when
 * the delta bit allocation runs out of the bands.
 */
export function maskingCurve(
    params: AllocationParameters,
    bandPsd: Int16Array,
    start: number,
    end: number,
    fastGain: number,
    lfe: boolean,
    delta: DeltaAllocation,
    mask: Int16Array,
    excite: Int32Array,
): boolean {
    const bandStart = BIN_BAND[start]!;
    const bandEnd = BIN_BAND[end - 1]! + 1;
    const { slowGain, slowDecay, fastDecay } = params;
    let begin: number;
    let fastLeak = 0;
    let slowLeak = 0;
    if (bandStart === 0) {
        let low = lowComp(0, bandPsd[0]!, bandPsd[1]!, 0);
        excite[0] = bandPsd[0]! - fastGain - low;
        low = lowComp(low, bandPsd[1]!, bandPsd[2]!, 1);
        excite[1] = bandPsd[1]! - fastGain - low;
        begin = 7;
        for (let band = 2; band < 7; band++) {
            const lfeEnd = lfe && band === 6;
            if (!lfeEnd) low = lowComp(low, bandPsd[band]!, bandPsd[band + 1]!, band);
            fastLeak = bandPsd[band]! - fastGain;
            slowLeak = bandPsd[band]! - slowGain;
            excite[band] = fastLeak - low;
            if (!lfeEnd && bandPsd[band]! <= bandPsd[band + 1]!) {
                begin = band + 1;
                break;
            }
        }
        const end1 = Math.min(bandEnd, 22);
        for (let band = begin; band < end1; band++) {
            if (!(lfe && band === 6)) low = lowComp(low, bandPsd[band]!, bandPsd[band + 1]!, band);
            fastLeak = Math.max(fastLeak - fastDecay, bandPsd[band]! - fastGain);
            slowLeak = Math.max(slowLeak - slowDecay, bandPsd[band]! - slowGain);
            excite[band] = Math.max(fastLeak - low, slowLeak);
        }
        begin = 22;
    } else {
        // The coupling channel starts from its leak codes.
        begin = bandStart;
        fastLeak = (params.cplFastLeak << 8) + 768;
        slowLeak = (params.cplSlowLeak << 8) + 768;
    }
    for (let band = begin; band < bandEnd; band++) {
        fastLeak = Math.max(fastLeak - fastDecay, bandPsd[band]! - fastGain);
        slowLeak = Math.max(slowLeak - slowDecay, bandPsd[band]! - slowGain);
        excite[band] = Math.max(fastLeak, slowLeak);
    }
    for (let band = bandStart; band < bandEnd; band++) {
        const knee = params.dbPerBit - bandPsd[band]!;
        if (knee > 0) excite[band] = excite[band]! + (knee >> 2);
        const threshold = HEARING_THRESHOLD[(band >> params.rateShift) * 3 + params.rateCode]!;
        mask[band] = Math.max(threshold, excite[band]!);
    }

    // Delta bit allocation: whole steps of 6 dB up or down over runs of bands.
    if (delta.mode === 0 || delta.mode === 1) {
        let band = bandStart;
        for (let segment = 0; segment < delta.segments; segment++) {
            band += delta.offsets[segment]!;
            const length = delta.lengths[segment]!;
            if (band >= 50 || length > 50 - band) return false;
            const value = delta.values[segment]!;
            const step = (value >= 4 ? value - 3 : value - 4) * 128;
            for (let index = 0; index < length; index++, band++) mask[band] = mask[band]! + step;
        }
    }
    return true;
}

/** Bit allocation pointers of the bins from `start` to `end` (7.2.2.7). */
export function allocatePointers(
    mask: Int16Array,
    psd: Int16Array,
    start: number,
    end: number,
    snrOffset: number,
    floor: number,
    table: Uint8Array,
    bap: Uint8Array,
): void {
    if (snrOffset === -960) {
        bap.fill(0, start, end);
        return;
    }
    let bin = start;
    let band = BIN_BAND[start]!;
    do {
        const level = (Math.max(mask[band]! - snrOffset - floor, 0) & 0x1fe0) + floor;
        const bandEnd = Math.min(BAND_START[band + 1]!, end);
        for (; bin < bandEnd; bin++) {
            const address = (psd[bin]! - level) >> 5;
            bap[bin] = table[address < 0 ? 0 : address > 63 ? 63 : address]!;
        }
    } while (end > BAND_START[band++]!);
}
