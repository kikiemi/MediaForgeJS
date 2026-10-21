import { DecodeError } from '../../core/errors/errors';
import { ilog, type VorbisBits } from './bits';

function invalid(message: string): never {
    throw new DecodeError(`Vorbis codebook is invalid: ${message}`);
}

/** Vorbis I section 3.2.1 float32_unpack (biased exponent, unnormalized 21-bit mantissa). */
function float32Unpack(value: number): number {
    const mantissa = value & 0x1fffff;
    const sign = value & 0x80000000 ? -1 : 1;
    let exponent = ((value & 0x7fe00000) >>> 21) - 20 - 768;
    if (exponent > 63) exponent = 63;
    if (exponent < -63) exponent = -63;
    return sign * mantissa * 2 ** exponent;
}

function bitReverse(x: number): number {
    x = ((x >>> 16) & 0x0000ffff) | ((x << 16) & 0xffff0000);
    x = ((x >>> 8) & 0x00ff00ff) | ((x << 8) & 0xff00ff00);
    x = ((x >>> 4) & 0x0f0f0f0f) | ((x << 4) & 0xf0f0f0f0);
    x = ((x >>> 2) & 0x33333333) | ((x << 2) & 0xcccccccc);
    return (((x >>> 1) & 0x55555555) | ((x << 1) & 0xaaaaaaaa)) >>> 0;
}

/**
 * Canonical Huffman codewords (LSb first per Vorbis I section 3.2.1) of the used entries, or null
 * when the tree is over- or underpopulated.
 */
function makeWords(lengths: Uint8Array, used: number): Uint32Array | null {
    const marker = new Uint32Array(33);
    const words = new Uint32Array(used);
    let count = 0;
    for (let i = 0; i < lengths.length; i++) {
        const length = lengths[i]!;
        if (length === 0) continue;
        let entry = marker[length]!;
        if (length < 32 && entry >>> length) return null;
        words[count++] = entry;
        for (let j = length; j > 0; j--) {
            if (marker[j]! & 1) {
                if (j === 1) marker[1]!++;
                else marker[j] = marker[j - 1]! << 1;
                break;
            }
            marker[j]!++;
        }
        for (let j = length + 1; j < 33; j++) {
            if (marker[j]! >>> 1 === entry) {
                entry = marker[j]!;
                marker[j] = marker[j - 1]! << 1;
            } else break;
        }
    }
    if (!(count === 1 && marker[2] === 2)) {
        for (let i = 1; i < 33; i++) if (marker[i]! & (0xffffffff >>> (32 - i))) return null;
    }
    count = 0;
    for (let i = 0; i < lengths.length; i++) {
        const length = lengths[i]!;
        if (length === 0) continue;
        let reversed = 0;
        for (let j = 0; j < length; j++) reversed = (reversed << 1) | ((words[count]! >>> j) & 1);
        words[count++] = reversed >>> 0;
    }
    return words;
}

function maptype1QuantValues(entries: number, dim: number): number {
    if (entries < 1) return 0;
    let values = Math.max(1, Math.floor(entries ** (1 / dim)));
    for (;;) {
        let acc = 1;
        let acc1 = 1;
        let i = 0;
        for (; i < dim; i++) {
            if (Math.floor(entries / values) < acc) break;
            acc *= values;
            acc1 = Math.min(acc1 * (values + 1), 2 ** 53);
        }
        if (i >= dim && acc <= entries && acc1 > entries) return values;
        if (i < dim || acc > entries) values--;
        else values++;
    }
}

/**
 * One codebook with the treeless decode tables of libvorbis (sorted bit-reversed codewords plus a
 * first-stage table).
 */
export class VorbisCodebook {
    readonly dim: number;
    readonly entries: number;
    readonly used: number;
    readonly mapType: number;
    /**
     * Unquantized vectors of the used entries in sorted-codeword order, `dim` values each; null
     * without a mapping.
     */
    readonly values: Float32Array | null;
    private readonly codes: Uint32Array;
    private readonly index: Int32Array;
    private readonly lengths: Uint8Array;
    private readonly maxLength: number;
    private readonly firstBits: number;
    private readonly firstTable: Uint32Array;

    constructor(bits: VorbisBits) {
        if (bits.read(24) !== 0x564342) invalid('missing the sync pattern');
        const dim = bits.read(16);
        const entries = bits.read(24);
        if (entries < 0 || ilog(dim) + ilog(entries) > 24) invalid('the entry count');
        const lengths = new Uint8Array(entries);
        if (bits.read(1) === 0) {
            const sparse = bits.read(1);
            if (((entries * (sparse ? 1 : 5) + 7) >> 3) * 8 > bits.remaining)
                invalid('the length list is truncated');
            for (let i = 0; i < entries; i++) {
                if (sparse && !bits.read(1)) continue;
                const length = bits.read(5);
                if (length < 0) invalid('the length list is truncated');
                lengths[i] = length + 1;
            }
        } else {
            let length = bits.read(5) + 1;
            for (let i = 0; i < entries;) {
                const count = bits.read(ilog(entries - i));
                if (count < 0) invalid('the length list is truncated');
                if (
                    length > 32 ||
                    count > entries - i ||
                    (count > 0 && (count - 1) >> (length - 1) > 1)
                )
                    invalid('the ordered length list');
                for (let j = 0; j < count; j++, i++) lengths[i] = length;
                length++;
            }
        }
        const mapType = bits.read(4);
        let quantList: Int32Array | null = null;
        let minimum = 0;
        let delta = 0;
        let sequence = false;
        if (mapType === 1 || mapType === 2) {
            minimum = float32Unpack(bits.read(32));
            delta = float32Unpack(bits.read(32));
            const quantBits = bits.read(4) + 1;
            const sequenceFlag = bits.read(1);
            if (sequenceFlag < 0) invalid('the value mapping is truncated');
            sequence = sequenceFlag === 1;
            const quantValues =
                mapType === 1 ? (dim === 0 ? 0 : maptype1QuantValues(entries, dim)) : entries * dim;
            if (((quantValues * quantBits + 7) >> 3) * 8 > bits.remaining)
                invalid('the value list is truncated');
            quantList = new Int32Array(quantValues);
            for (let i = 0; i < quantValues; i++) quantList[i] = bits.read(quantBits);
            if (quantValues && quantList[quantValues - 1] === -1)
                invalid('the value list is truncated');
        } else if (mapType !== 0) invalid(`lookup type ${mapType}`);
        this.dim = dim;
        this.entries = entries;
        this.mapType = mapType;
        let used = 0;
        for (let i = 0; i < entries; i++) if (lengths[i]! > 0) used++;
        this.used = used;
        this.codes = new Uint32Array(used);
        this.index = new Int32Array(used);
        this.lengths = new Uint8Array(used);
        this.values = null;
        this.maxLength = 0;
        this.firstBits = 0;
        this.firstTable = new Uint32Array(0);
        if (used === 0) return;
        const words = makeWords(lengths, used);
        if (!words) invalid('the codeword tree is over- or underpopulated');
        const order = new Uint32Array(used);
        for (let i = 0; i < used; i++) {
            words[i] = bitReverse(words[i]!);
            order[i] = i;
        }
        order.sort((a, b) => words[a]! - words[b]!);
        const sortIndex = new Int32Array(used);
        for (let i = 0; i < used; i++) sortIndex[order[i]!] = i;
        for (let i = 0; i < used; i++) this.codes[sortIndex[i]!] = words[i]!;
        let maxLength = 0;
        for (let i = 0, n = 0; i < entries; i++) {
            if (lengths[i]! === 0) continue;
            this.index[sortIndex[n]!] = i;
            this.lengths[sortIndex[n]!] = lengths[i]!;
            if (lengths[i]! > maxLength) maxLength = lengths[i]!;
            n++;
        }
        this.maxLength = maxLength;
        if (quantList)
            this.values = this.unquantize(lengths, quantList, minimum, delta, sequence, sortIndex);
        if (used === 1 && maxLength === 1) {
            this.firstBits = 1;
            this.firstTable = Uint32Array.of(1, 1);
            return;
        }
        this.firstBits = Math.min(8, Math.max(5, ilog(used) - 4));
        const size = 1 << this.firstBits;
        const table = new Uint32Array(size);
        for (let i = 0; i < used; i++) {
            const length = this.lengths[i]!;
            if (length > this.firstBits) continue;
            const original = bitReverse(this.codes[i]!);
            for (let j = 0; j < 1 << (this.firstBits - length); j++)
                table[original | (j << length)] = i + 1;
        }
        const mask = (0xfffffffe << (31 - this.firstBits)) >>> 0;
        let lo = 0;
        let hi = 0;
        for (let i = 0; i < size; i++) {
            const word = (i << (32 - this.firstBits)) >>> 0;
            const slot = bitReverse(word);
            if (table[slot] !== 0) continue;
            while (lo + 1 < used && this.codes[lo + 1]! <= word) lo++;
            while (hi < used && word >= (this.codes[hi]! & mask) >>> 0) hi++;
            table[slot] =
                (0x80000000 | (Math.min(lo, 0x7fff) << 15) | Math.min(used - hi, 0x7fff)) >>> 0;
        }
        this.firstTable = table;
    }

    private unquantize(
        lengths: Uint8Array,
        quantList: Int32Array,
        minimum: number,
        delta: number,
        sequence: boolean,
        sortIndex: Int32Array,
    ): Float32Array {
        const { dim, entries, used } = this;
        const values = new Float32Array(used * dim);
        const quantValues = this.mapType === 1 ? maptype1QuantValues(entries, dim) : 0;
        let count = 0;
        for (let j = 0; j < entries; j++) {
            if (lengths[j] === 0) continue;
            let last = 0;
            let indexDiv = 1;
            const base = sortIndex[count]! * dim;
            for (let k = 0; k < dim; k++) {
                const quant =
                    this.mapType === 1
                        ? quantList[Math.floor(j / indexDiv) % quantValues]!
                        : quantList[j * dim + k]!;
                const value = Math.fround(Math.abs(quant) * delta + minimum + last);
                if (sequence) last = value;
                values[base + k] = value;
                indexDiv *= quantValues;
            }
            count++;
        }
        return values;
    }

    /** Position of the next codeword in sorted order, or -1 at the end of the packet. */
    decodePacked(bits: VorbisBits): number {
        let lo: number;
        let hi: number;
        const lok = bits.look(this.firstBits);
        if (lok >= 0) {
            const entry = this.firstTable[lok]!;
            if (entry >= 0x80000000) {
                lo = (entry >>> 15) & 0x7fff;
                hi = this.used - (entry & 0x7fff);
            } else {
                bits.advance(this.lengths[entry - 1]!);
                return entry - 1;
            }
        } else {
            lo = 0;
            hi = this.used;
        }
        let read = this.maxLength;
        let word = bits.look(read);
        while (word < 0 && read > 1) word = bits.look(--read);
        if (word < 0) return -1;
        const test = bitReverse(word);
        const codes = this.codes;
        while (hi - lo > 1) {
            const p = (hi - lo) >> 1;
            if (codes[lo + p]! > test) hi -= p;
            else lo += p;
        }
        if (this.lengths[lo]! <= read) {
            bits.advance(this.lengths[lo]!);
            return lo;
        }
        bits.advance(read);
        return -1;
    }

    /** The original entry number of the next codeword, or -1 at the end of the packet. */
    decode(bits: VorbisBits): number {
        if (this.used === 0) return -1;
        const packed = this.decodePacked(bits);
        return packed >= 0 ? this.index[packed]! : -1;
    }

    /**
     * Residue type 0: `n` values as `n / dim` interleaved vectors added to `a` at `offset`; false
     * at end of packet.
     */
    decodeVsAdd(
        a: Float32Array,
        offset: number,
        bits: VorbisBits,
        n: number,
        entries: Int32Array,
    ): boolean {
        if (this.used === 0 || !this.values) return true;
        const dim = this.dim;
        const step = Math.floor(n / dim);
        for (let i = 0; i < step; i++) {
            const entry = this.decodePacked(bits);
            if (entry === -1) return false;
            entries[i] = entry * dim;
        }
        const values = this.values;
        for (let i = 0, o = 0; i < dim; i++, o += step)
            for (let j = 0; o + j < n && j < step; j++)
                a[offset + o + j]! += values[entries[j]! + i]!;
        return true;
    }

    /**
     * Residue type 1: `n` values added to `a` at `offset` vector by vector; false at end of packet.
     */
    decodeVAdd(a: Float32Array, offset: number, bits: VorbisBits, n: number): boolean {
        if (this.used === 0 || !this.values) return true;
        const dim = this.dim;
        const values = this.values;
        for (let i = 0; i < n;) {
            const entry = this.decodePacked(bits);
            if (entry === -1) return false;
            const base = entry * dim;
            for (let j = 0; i < n && j < dim;) a[offset + i++]! += values[base + j++]!;
        }
        return true;
    }

    /** Floor 0: `n` values written to `a`; false at end of packet. */
    decodeVSet(a: Float32Array, bits: VorbisBits, n: number): boolean {
        if (this.used === 0 || !this.values) {
            a.fill(0, 0, n);
            return true;
        }
        const dim = this.dim;
        const values = this.values;
        for (let i = 0; i < n;) {
            const entry = this.decodePacked(bits);
            if (entry === -1) return false;
            const base = entry * dim;
            for (let j = 0; i < n && j < dim;) a[i++] = values[base + j++]!;
        }
        return true;
    }

    /**
     * Residue type 2: `n` values spread over `ch` interleaved channel vectors from `offset`; false
     * at end of packet.
     */
    decodeVvAdd(
        a: readonly Float32Array[],
        offset: number,
        ch: number,
        bits: VorbisBits,
        n: number,
    ): boolean {
        if (this.used === 0 || !this.values) return true;
        const dim = this.dim;
        const values = this.values;
        const m = Math.floor((offset + n) / ch);
        let chptr = 0;
        for (let i = Math.floor(offset / ch); i < m;) {
            const entry = this.decodePacked(bits);
            if (entry === -1) return false;
            const base = entry * dim;
            for (let j = 0; i < m && j < dim; j++) {
                a[chptr++]![i]! += values[base + j]!;
                if (chptr === ch) {
                    chptr = 0;
                    i++;
                }
            }
        }
        return true;
    }
}
