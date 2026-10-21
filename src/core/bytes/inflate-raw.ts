/**
 * Raw DEFLATE data (RFC 1951) inflated synchronously, for what the build stores compressed (the
 * WebAssembly kernels), where DecompressionStream, being asynchronous, cannot serve a synchronous
 * compile. Canonical Huffman codes are decoded a bit at a time, as zlib's puff does: small rather
 * than fast, which suits data inflated once.
 */

/** Extra bits and base values of the length (29) and distance (30) codes. */
const LENGTH_EXTRA = Array.from({ length: 29 }, (_, code) =>
    code < 8 || code === 28 ? 0 : (code >> 2) - 1,
);
const DISTANCE_EXTRA = Array.from({ length: 30 }, (_, code) => (code < 4 ? 0 : (code >> 1) - 1));
function bases(extra: readonly number[], first: number): number[] {
    const values: number[] = [];
    for (const bits of extra) {
        values.push(first);
        first += 1 << bits;
    }
    return values;
}
const LENGTH_BASE = bases(LENGTH_EXTRA, 3);
LENGTH_BASE[28] = 258;
const DISTANCE_BASE = bases(DISTANCE_EXTRA, 1);
/** The order of the code length code lengths in a dynamic block header. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code: how many codes each length has, and the symbols in code order. */
interface Huffman {
    readonly counts: Uint16Array;
    readonly symbols: Uint16Array;
}

function huffman(lengths: ArrayLike<number>): Huffman {
    const counts = new Uint16Array(16);
    for (let symbol = 0; symbol < lengths.length; symbol++) counts[lengths[symbol]!]!++;
    const offsets = new Uint16Array(16);
    for (let length = 1; length < 15; length++)
        offsets[length + 1] = offsets[length]! + counts[length]!;
    const symbols = new Uint16Array(lengths.length);
    for (let symbol = 0; symbol < lengths.length; symbol++)
        if (lengths[symbol]) symbols[offsets[lengths[symbol]!]!++] = symbol;
    counts[0] = 0;
    return { counts, symbols };
}

const FIXED_LENGTHS = huffman(
    Array.from({ length: 288 }, (_, symbol) =>
        symbol < 144 ? 8 : symbol < 256 ? 9 : symbol < 280 ? 7 : 8,
    ),
);
const FIXED_DISTANCES = huffman(new Array<number>(30).fill(5));

/** The inflated bytes of raw DEFLATE data in base64 `text`; throws on anything else. */
export function inflateBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return inflateRaw(bytes);
}

/** The inflated bytes of `data`; throws on data that is not a complete raw DEFLATE stream. */
export function inflateRaw(data: Uint8Array): Uint8Array<ArrayBuffer> {
    let out = new Uint8Array(data.length * 4 + 1024);
    let written = 0;
    // Bits not yet used, least significant first, and the next byte to take in.
    let buffer = 0;
    let buffered = 0;
    let next = 0;
    const bits = (count: number): number => {
        for (; buffered < count; buffered += 8) {
            if (next >= data.length) throw new RangeError('DEFLATE data is cut');
            buffer |= data[next++]! << buffered;
        }
        const value = buffer & ((1 << count) - 1);
        buffer >>>= count;
        buffered -= count;
        return value;
    };
    const decode = ({ counts, symbols }: Huffman): number => {
        let code = 0;
        let first = 0;
        let index = 0;
        for (let length = 1; length < 16; length++) {
            code |= bits(1);
            const count = counts[length]!;
            if (code < first + count) return symbols[index + code - first]!;
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        throw new RangeError('DEFLATE code is invalid');
    };
    const room = (count: number): void => {
        if (written + count <= out.length) return;
        const grown = new Uint8Array(Math.max(out.length * 2, written + count));
        grown.set(out.subarray(0, written));
        out = grown;
    };

    for (let last = 0; !last;) {
        last = bits(1);
        const type = bits(2);
        if (type === 0) {
            // A stored block starts at the next byte (fewer than 8 bits are ever buffered).
            buffer = buffered = 0;
            const length = data[next]! | (data[next + 1]! << 8);
            if (next + 4 + length > data.length) throw new RangeError('DEFLATE data is cut');
            room(length);
            out.set(data.subarray(next + 4, next + 4 + length), written);
            written += length;
            next += 4 + length;
            continue;
        }
        let lengths = FIXED_LENGTHS;
        let distances = FIXED_DISTANCES;
        if (type === 2) {
            const literalCount = bits(5) + 257;
            const distanceCount = bits(5) + 1;
            const codeLengths = new Uint8Array(19);
            for (let index = bits(4) + 4, at = 0; at < index; at++)
                codeLengths[CODE_LENGTH_ORDER[at]!] = bits(3);
            const codeLengthCode = huffman(codeLengths);
            const all = new Uint8Array(literalCount + distanceCount);
            for (let at = 0; at < all.length;) {
                const symbol = decode(codeLengthCode);
                if (symbol < 16) {
                    all[at++] = symbol;
                    continue;
                }
                const repeat =
                    symbol === 16 ? bits(2) + 3 : symbol === 17 ? bits(3) + 3 : bits(7) + 11;
                if (at + repeat > all.length || (symbol === 16 && !at))
                    throw new RangeError('DEFLATE code lengths are invalid');
                all.fill(symbol === 16 ? all[at - 1]! : 0, at, at + repeat);
                at += repeat;
            }
            lengths = huffman(all.subarray(0, literalCount));
            distances = huffman(all.subarray(literalCount));
        } else if (type !== 1) throw new RangeError('DEFLATE block type is invalid');

        for (;;) {
            const symbol = decode(lengths);
            if (symbol < 256) {
                room(1);
                out[written++] = symbol;
                continue;
            }
            if (symbol === 256) break;
            const code = symbol - 257;
            if (code > 28) throw new RangeError('DEFLATE length code is invalid');
            const length = LENGTH_BASE[code]! + bits(LENGTH_EXTRA[code]!);
            const distanceCode = decode(distances);
            if (distanceCode > 29) throw new RangeError('DEFLATE distance code is invalid');
            const distance = DISTANCE_BASE[distanceCode]! + bits(DISTANCE_EXTRA[distanceCode]!);
            if (distance > written) throw new RangeError('DEFLATE distance is too far back');
            room(length);
            for (let index = 0; index < length; index++, written++)
                out[written] = out[written - distance]!;
        }
    }
    return out.slice(0, written);
}
