import { DecodeError } from '../../errors/errors';

/** MSB-first reader over one AAC access unit; reading past the end is a DECODE error. */
export class AacBitReader {
    private pos = 0;
    constructor(private readonly bytes: Uint8Array) {}

    read(bits: number): number {
        // Up to 24 bits come from one 32-bit window of the bytes.
        if (bits <= 24) {
            if (this.pos + bits > this.bytes.length * 8) {
                if (bits === 0) return 0;
                throw new DecodeError('AAC: bitstream exhausted');
            }
            const value = this.peek(bits);
            this.pos += bits;
            return value;
        }
        let value = 0;
        while (bits > 0) {
            const byteIndex = this.pos >> 3;
            if (byteIndex >= this.bytes.length) throw new DecodeError('AAC: bitstream exhausted');
            const bitOffset = this.pos & 7;
            const take = Math.min(bits, 8 - bitOffset);
            const chunk = (this.bytes[byteIndex]! >> (8 - bitOffset - take)) & ((1 << take) - 1);
            value = value * (1 << take) + chunk;
            this.pos += take;
            bits -= take;
        }
        return value;
    }

    readBit(): number {
        const byteIndex = this.pos >> 3;
        if (byteIndex >= this.bytes.length) throw new DecodeError('AAC: bitstream exhausted');
        const bit = (this.bytes[byteIndex]! >> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return bit;
    }

    /** The next `bits` bits without consuming them; bits past the end read as zero. */
    peek(bits: number): number {
        if (bits <= 24) {
            if (bits <= 0) return 0;
            const bytes = this.bytes;
            const at = this.pos >> 3;
            const window =
                ((bytes[at] ?? 0) << 24) |
                ((bytes[at + 1] ?? 0) << 16) |
                ((bytes[at + 2] ?? 0) << 8) |
                (bytes[at + 3] ?? 0);
            return (window << (this.pos & 7)) >>> (32 - bits);
        }
        let value = 0;
        for (let i = 0; i < bits; i++) {
            const at = this.pos + i;
            const byte = this.bytes[at >> 3] ?? 0;
            value = value * 2 + ((byte >> (7 - (at & 7))) & 1);
        }
        return value;
    }

    skip(bits: number): void {
        if (bits < 0 || this.pos + bits > this.bytes.length * 8)
            throw new DecodeError('AAC: bitstream exhausted');
        this.pos += bits;
    }

    bitsLeft(): number {
        return this.bytes.length * 8 - this.pos;
    }

    bitsRead(): number {
        return this.pos;
    }

    /** Moves to `position` (in bits); a position outside the unit is a DECODE error. */
    seek(position: number): void {
        if (position < 0 || position > this.bytes.length * 8)
            throw new DecodeError('AAC: bitstream exhausted');
        this.pos = position;
    }

    /** Byte alignment relative to bit `origin` (the start of the raw data block). */
    align(origin = 0): void {
        this.pos += (8 - ((this.pos - origin) & 7)) & 7;
    }
}

/** Binary decoding tree of a prefix code: node pairs, leaves stored as -(symbol + 1). */
function buildHuffmanTree(codes: ArrayLike<number>, bits: ArrayLike<number>): Int32Array {
    let total = 0;
    for (let sym = 0; sym < codes.length; sym++) total += bits[sym]!;
    const tree = new Int32Array(2 * (total + 1));
    let nextNode = 1;
    for (let sym = 0; sym < codes.length; sym++) {
        const length = bits[sym]!;
        let node = 0;
        for (let b = length - 1; b >= 0; b--) {
            const bit = (codes[sym]! >>> b) & 1;
            const slot = node * 2 + bit;
            if (b === 0) {
                tree[slot] = -(sym + 1);
            } else {
                if (tree[slot] === 0) tree[slot] = nextNode++;
                node = tree[slot]!;
            }
        }
    }
    return tree;
}

/** Bits a prefix code's lookup table resolves at once; longer codes continue in its tree. */
const LOOKUP_BITS = 9;

/** Table entries at or below this mark a code that no symbol has, at depth INVALID - entry. */
const INVALID = -(1 << 30);

/**
 * A prefix code: its decoding tree (node pairs, leaves stored as -(symbol + 1)) and a table of
 * every LOOKUP_BITS-bit prefix: symbol * 16 + length for a code that ends within them, -(node + 1)
 * for the tree node they lead to, or a mark of an invalid code.
 */
export interface HuffmanCode {
    readonly tree: Int32Array;
    readonly table: Int32Array;
}

/** The decoding tree and lookup table of the prefix code of `codes` and their lengths in `bits`. */
export function huffmanCode(codes: ArrayLike<number>, bits: ArrayLike<number>): HuffmanCode {
    const tree = buildHuffmanTree(codes, bits);
    const table = new Int32Array(1 << LOOKUP_BITS);

    // A code of at most LOOKUP_BITS bits fills the prefixes it starts; a longer one names the node
    // its prefix reaches. Entries are never zero, so the prefixes left at zero are walked in the
    // tree afterwards.
    for (let sym = 0; sym < codes.length; sym++) {
        const length = bits[sym]!;
        if (length > 0 && length <= LOOKUP_BITS) {
            const first = (codes[sym]! & ((1 << length) - 1)) * (1 << (LOOKUP_BITS - length));
            table.fill(sym * 16 + length, first, first + (1 << (LOOKUP_BITS - length)));
        }
    }
    for (let prefix = 0; prefix < table.length; prefix++) {
        if (table[prefix] !== 0) continue;
        let node = 0;
        let entry = 0;
        for (let depth = 1; depth <= LOOKUP_BITS; depth++) {
            const next = tree[node * 2 + ((prefix >> (LOOKUP_BITS - depth)) & 1)]!;
            if (next < 0) {
                entry = (-next - 1) * 16 + depth;
                break;
            }
            if (next === 0) {
                entry = INVALID - depth;
                break;
            }
            node = next;
            if (depth === LOOKUP_BITS) entry = -(node + 1);
        }
        table[prefix] = entry;
    }
    return { tree, table };
}

/**
 * The next symbol of `code`, read as a walk of its tree bit by bit would read it, with the same
 * failures.
 */
export function decodeHuffman(reader: AacBitReader, code: HuffmanCode): number {
    const entry = code.table[reader.peek(LOOKUP_BITS)]!;
    if (entry > 0) {
        reader.skip(entry & 15);
        return entry >> 4;
    }
    if (entry <= INVALID) {
        reader.skip(INVALID - entry);
        throw new DecodeError('AAC: invalid huffman code');
    }
    reader.skip(LOOKUP_BITS);
    const tree = code.tree;
    let node = -entry - 1;
    for (;;) {
        const next = tree[node * 2 + reader.readBit()]!;
        if (next < 0) return -next - 1;
        if (next === 0) throw new DecodeError('AAC: invalid huffman code');
        node = next;
    }
}
