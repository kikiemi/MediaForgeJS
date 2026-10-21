import { CABAC_INIT_MN } from './cabac-tables';
import { RANGE_LPS, TRANS_IDX_LPS } from './tables';

const MPS_NEXT = new Uint8Array(128);
const LPS_NEXT = new Uint8Array(128);

/** rangeTabLPS by (pStateIdx << 1 | valMPS) * 4 + qRangeIdx. */
const LPS_RANGE = new Uint8Array(128 * 4);
for (let s = 0; s < 128; s++) {
    const state = s >> 1;
    const mps = s & 1;
    MPS_NEXT[s] = (Math.min(state + 1, 62) << 1) | mps;
    LPS_NEXT[s] = (TRANS_IDX_LPS[state] << 1) | (state === 0 ? mps ^ 1 : mps);
    for (let q = 0; q < 4; q++) LPS_RANGE[s * 4 + q] = RANGE_LPS[state * 4 + q];
}

/** Positions of the significant coefficients of the block being parsed, in coded order. */
const significant = new Uint8Array(64);

/**
 * CABAC arithmetic decoding engine (9.3.1.2, 9.3.3.2). `value` keeps codIOffset in bits 15..7 above
 * seven or more look-ahead bits; `bitsNeeded` counts up to zero as look-ahead bits are consumed,
 * then a byte is appended.
 */
export class Cabac {
    /**
     * Context variables as pStateIdx << 1 | valMPS; a view of kernel memory when the kernels decode
     * residuals.
     */
    state: Uint8Array = new Uint8Array(1024);
    private data: Uint8Array = new Uint8Array(0);
    private pos = 0;
    private end = 0;
    private range = 510;
    private value = 0;
    private bitsNeeded = -8;

    /** Starts decoding at byte `offset` of `data`; bytes at or past `end` read as zero. */
    init(data: Uint8Array, offset: number, end: number): void {
        this.data = data;
        this.pos = offset;
        this.end = end;
        this.range = 510;
        this.bitsNeeded = -8;
        this.value = (this.readByte() << 8) | this.readByte();
    }

    private readByte(): number {
        return this.pos < this.end ? this.data[this.pos++] : (this.pos++, 0);
    }

    /**
     * Writes range, value, pos, bitsNeeded and end to `engine` (the kernels' engine block), for
     * kernels that continue decoding from `data` copied to their memory.
     */
    save(engine: Int32Array): void {
        engine[0] = this.range;
        engine[1] = this.value;
        engine[2] = this.pos;
        engine[3] = this.bitsNeeded;
        engine[4] = this.end;
    }

    /** Continues from the engine state the kernels left in `engine`. */
    restore(engine: Int32Array): void {
        this.range = engine[0];
        this.value = engine[1];
        this.pos = engine[2];
        this.bitsNeeded = engine[3];
    }

    /** Byte offset of the next byte the engine would fetch. */
    get bytePosition(): number {
        return this.pos;
    }

    /** Bits of the RBSP consumed so far, counted from the start of `data`. */
    get bitsConsumed(): number {
        return this.pos * 8 + this.bitsNeeded + 1;
    }

    /** Initialises the context variables for a slice (9.3.1.1). */
    initContexts(sliceQp: number, intra: boolean, cabacInitIdc: number): void {
        const qp = sliceQp < 0 ? 0 : sliceQp > 51 ? 51 : sliceQp;
        const base = intra ? 0 : (cabacInitIdc + 1) * 2048;
        const table = CABAC_INIT_MN;
        const state = this.state;
        for (let ctx = 0; ctx < 1024; ctx++) {
            const m = table[base + ctx * 2];
            const n = table[base + ctx * 2 + 1];
            let pre = ((m * qp) >> 4) + n;
            pre = pre < 1 ? 1 : pre > 126 ? 126 : pre;
            state[ctx] = pre <= 63 ? (63 - pre) << 1 : ((pre - 64) << 1) | 1;
        }
    }

    decodeBin(ctx: number): number {
        const state = this.state;
        const s = state[ctx];
        let range = this.range;
        const lps = LPS_RANGE[(s << 2) + ((range >> 6) & 3)];
        range -= lps;
        const scaled = range << 7;
        let value = this.value;
        if (value < scaled) {
            state[ctx] = MPS_NEXT[s];
            if (scaled < 256 << 7) {
                range <<= 1;
                value <<= 1;
                if (++this.bitsNeeded === 0) {
                    this.bitsNeeded = -8;
                    value |= this.readByte();
                }
            }
            this.range = range;
            this.value = value;
            return s & 1;
        }
        const shift = Math.clz32(lps) - 23;
        this.value = (value - scaled) << shift;
        this.range = lps << shift;
        state[ctx] = LPS_NEXT[s];
        const needed = this.bitsNeeded + shift;
        if (needed >= 0) {
            this.value |= this.readByte() << needed;
            this.bitsNeeded = needed - 8;
        } else this.bitsNeeded = needed;
        return (s & 1) ^ 1;
    }

    decodeBypass(): number {
        let value = this.value << 1;
        if (++this.bitsNeeded >= 0) {
            this.bitsNeeded = -8;
            value |= this.readByte();
        }
        const scaled = this.range << 7;
        if (value >= scaled) {
            this.value = value - scaled;
            return 1;
        }
        this.value = value;
        return 0;
    }

    decodeTerminate(): number {
        const range = this.range - 2;
        const scaled = range << 7;
        if (this.value >= scaled) return 1;
        if (scaled < 256 << 7) {
            this.range = range << 1;
            this.value <<= 1;
            if (++this.bitsNeeded === 0) {
                this.bitsNeeded = -8;
                this.value |= this.readByte();
            }
        } else this.range = range;
        return 0;
    }

    /**
     * residual_block_cabac (7.3.5.3.3) after its coded_block_flag. The significance map uses the
     * contexts `sigCtx + sigMap[i]` and `lastCtx + lastMap[i]` for coded positions i < numCoeff -
     * 1, the levels the contexts from `absCtx` with at most `gt1Max` for the greater-than-one count
     * (9.3.3.1.3). The level of coded position i is stored scaled at out[outOffset + p], p =
     * scan[scanOffset + i], as (level * scale[scaleOffset + p] + 32) >> 6. Returns the number of
     * coefficients. The arithmetic decoding engine is kept in locals across all bins.
     */
    residual(
        sigCtx: number,
        lastCtx: number,
        sigMap: Uint8Array,
        lastMap: Uint8Array,
        numCoeff: number,
        absCtx: number,
        gt1Max: number,
        out: Int32Array,
        outOffset: number,
        scan: Uint8Array,
        scanOffset: number,
        scale: Int32Array,
        scaleOffset: number,
    ): number {
        const state = this.state;
        const data = this.data;
        const end = this.end;
        let pos = this.pos;
        let range = this.range;
        let value = this.value;
        let bitsNeeded = this.bitsNeeded;
        const index = significant;
        const last = numCoeff - 1;
        let count = 0;
        let i = 0;
        let ctx: number;
        let s: number;
        let lps: number;
        let bin: number;
        for (; i < last; i++) {
            ctx = sigCtx + sigMap[i];
            s = state[ctx];
            lps = LPS_RANGE[(s << 2) + ((range >> 6) & 3)];
            range -= lps;
            if (value < range << 7) {
                state[ctx] = MPS_NEXT[s];
                bin = s & 1;
                if (range < 256) {
                    range <<= 1;
                    value <<= 1;
                    if (++bitsNeeded === 0) {
                        bitsNeeded = -8;
                        value |= pos < end ? data[pos] : 0;
                        pos++;
                    }
                }
            } else {
                const shift = Math.clz32(lps) - 23;
                value = (value - (range << 7)) << shift;
                range = lps << shift;
                state[ctx] = LPS_NEXT[s];
                bin = (s & 1) ^ 1;
                bitsNeeded += shift;
                if (bitsNeeded >= 0) {
                    value |= (pos < end ? data[pos] : 0) << bitsNeeded;
                    pos++;
                    bitsNeeded -= 8;
                }
            }
            if (bin === 0) continue;
            index[count++] = i;
            ctx = lastCtx + lastMap[i];
            s = state[ctx];
            lps = LPS_RANGE[(s << 2) + ((range >> 6) & 3)];
            range -= lps;
            if (value < range << 7) {
                state[ctx] = MPS_NEXT[s];
                bin = s & 1;
                if (range < 256) {
                    range <<= 1;
                    value <<= 1;
                    if (++bitsNeeded === 0) {
                        bitsNeeded = -8;
                        value |= pos < end ? data[pos] : 0;
                        pos++;
                    }
                }
            } else {
                const shift = Math.clz32(lps) - 23;
                value = (value - (range << 7)) << shift;
                range = lps << shift;
                state[ctx] = LPS_NEXT[s];
                bin = (s & 1) ^ 1;
                bitsNeeded += shift;
                if (bitsNeeded >= 0) {
                    value |= (pos < end ? data[pos] : 0) << bitsNeeded;
                    pos++;
                    bitsNeeded -= 8;
                }
            }
            if (bin !== 0) break;
        }
        if (i === last) index[count++] = last;
        let eq1 = 1;
        let gt1 = 0;
        for (let k = count - 1; k >= 0; k--) {
            ctx = absCtx + (gt1 !== 0 ? 0 : eq1 < 4 ? eq1 : 4);
            s = state[ctx];
            lps = LPS_RANGE[(s << 2) + ((range >> 6) & 3)];
            range -= lps;
            if (value < range << 7) {
                state[ctx] = MPS_NEXT[s];
                bin = s & 1;
                if (range < 256) {
                    range <<= 1;
                    value <<= 1;
                    if (++bitsNeeded === 0) {
                        bitsNeeded = -8;
                        value |= pos < end ? data[pos] : 0;
                        pos++;
                    }
                }
            } else {
                const shift = Math.clz32(lps) - 23;
                value = (value - (range << 7)) << shift;
                range = lps << shift;
                state[ctx] = LPS_NEXT[s];
                bin = (s & 1) ^ 1;
                bitsNeeded += shift;
                if (bitsNeeded >= 0) {
                    value |= (pos < end ? data[pos] : 0) << bitsNeeded;
                    pos++;
                    bitsNeeded -= 8;
                }
            }
            let level: number;
            if (bin === 0) {
                level = 1;
                eq1++;
            } else {
                ctx = absCtx + 5 + (gt1 < gt1Max ? gt1 : gt1Max);
                level = 2;
                while (level < 15) {
                    s = state[ctx];
                    lps = LPS_RANGE[(s << 2) + ((range >> 6) & 3)];
                    range -= lps;
                    if (value < range << 7) {
                        state[ctx] = MPS_NEXT[s];
                        bin = s & 1;
                        if (range < 256) {
                            range <<= 1;
                            value <<= 1;
                            if (++bitsNeeded === 0) {
                                bitsNeeded = -8;
                                value |= pos < end ? data[pos] : 0;
                                pos++;
                            }
                        }
                    } else {
                        const shift = Math.clz32(lps) - 23;
                        value = (value - (range << 7)) << shift;
                        range = lps << shift;
                        state[ctx] = LPS_NEXT[s];
                        bin = (s & 1) ^ 1;
                        bitsNeeded += shift;
                        if (bitsNeeded >= 0) {
                            value |= (pos < end ? data[pos] : 0) << bitsNeeded;
                            pos++;
                            bitsNeeded -= 8;
                        }
                    }
                    if (bin === 0) break;
                    level++;
                }
                if (level >= 15) {
                    this.pos = pos;
                    this.range = range;
                    this.value = value;
                    this.bitsNeeded = bitsNeeded;
                    level += this.decodeExpGolombBypass(0);
                    pos = this.pos;
                    value = this.value;
                    bitsNeeded = this.bitsNeeded;
                }
                gt1++;
            }
            value <<= 1;
            if (++bitsNeeded >= 0) {
                bitsNeeded = -8;
                value |= pos < end ? data[pos] : 0;
                pos++;
            }
            if (value >= range << 7) {
                value -= range << 7;
                level = -level;
            }
            const p = scan[scanOffset + index[k]];
            out[outOffset + p] = (Math.imul(level, scale[scaleOffset + p]) + 32) >> 6;
        }
        this.pos = pos;
        this.range = range;
        this.value = value;
        this.bitsNeeded = bitsNeeded;
        return count;
    }

    /**
     * Decodes a UEGk suffix (9.3.2.3): `prefixMax` unary bins were all 1, so the Exp-Golomb part
     * follows in bypass bins with parameter `k`.
     */
    decodeExpGolombBypass(k: number): number {
        let value = 0;
        while (this.decodeBypass()) {
            value += 1 << k;
            k++;
            if (k > 24) return 0x7fffffff;
        }
        while (k-- > 0) value += this.decodeBypass() << k;
        return value;
    }
}
