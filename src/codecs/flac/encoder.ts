import { EncodeError, throwIfAborted } from '../../core/errors/errors';
import {
    FLAC_BLOCK_SIZE,
    buildFlacStreamHeader,
    flacCrc16,
} from '../../core/codec-config/audio/flac-frame';
import { concatBytes } from '../../core/bytes/bytes';

const BLOCK_SIZE = FLAC_BLOCK_SIZE;
const MAX_LPC_ORDER = 8;
const LPC_PRECISION = 14;
const MAX_PARTITION_ORDER = 6;

/** Largest Rice parameter of the 4-bit coding (RICE1) and of the 5-bit coding (RICE2). */
const MAX_RICE_PARAM = 14;
const MAX_RICE2_PARAM = 30;

/** Largest residual magnitude whose zigzag code fits the 31 bits the coder shifts through. */
const MAX_RESIDUAL = 2 ** 30 - 1;
const MAX_TOTAL_SAMPLES = 2 ** 36 - 1;

class Md5 {
    private readonly state = new Int32Array([
        0x67452301,
        0xefcdab89 | 0,
        0x98badcfe | 0,
        0x10325476,
    ]);
    private readonly buffer = new Uint8Array(64);
    private readonly words = new Int32Array(16);
    private buffered = 0;
    private totalBytes = 0;

    update(data: Uint8Array): void {
        this.totalBytes += data.length;
        let off = 0;
        if (this.buffered > 0) {
            const take = Math.min(64 - this.buffered, data.length);
            this.buffer.set(data.subarray(0, take), this.buffered);
            this.buffered += take;
            off = take;
            if (this.buffered === 64) {
                this.processBytes(this.buffer, 0);
                this.buffered = 0;
            }
        }
        while (off + 64 <= data.length) {
            this.processBytes(data, off);
            off += 64;
        }
        if (off < data.length) {
            this.buffer.set(data.subarray(off), 0);
            this.buffered = data.length - off;
        }
    }

    /** Feeds the first `count` words of `words`, each four bytes, least significant first. */
    updateWords(words: Int32Array, count: number): void {
        let at = 0;
        if (this.buffered === 0) {
            for (; at + 16 <= count; at += 16) this.processWords(words, at);
            this.totalBytes += at * 4;
        }
        if (at === count) return;
        const rest = new Uint8Array((count - at) * 4);
        for (let i = at, o = 0; i < count; i++, o += 4) {
            const word = words[i]!;
            rest[o] = word;
            rest[o + 1] = word >> 8;
            rest[o + 2] = word >> 16;
            rest[o + 3] = word >> 24;
        }
        this.update(rest);
    }

    digest(): Uint8Array {
        const bitLength = this.totalBytes * 8;
        const pad = new Uint8Array((this.buffered < 56 ? 56 : 120) - this.buffered + 8);
        pad[0] = 0x80;
        const lo = bitLength >>> 0;
        const hi = Math.floor(bitLength / 4294967296);
        for (let i = 0; i < 4; i++) pad[pad.length - 8 + i] = (lo >>> (i * 8)) & 0xff;
        for (let i = 0; i < 4; i++) pad[pad.length - 4 + i] = (hi >>> (i * 8)) & 0xff;
        this.update(pad);
        const out = new Uint8Array(16);
        for (let i = 0; i < 4; i++) {
            const v = this.state[i];
            out[i * 4] = v & 0xff;
            out[i * 4 + 1] = (v >>> 8) & 0xff;
            out[i * 4 + 2] = (v >>> 16) & 0xff;
            out[i * 4 + 3] = (v >>> 24) & 0xff;
        }
        return out;
    }

    private processBytes(data: Uint8Array, off: number): void {
        const words = this.words;
        for (let i = 0, at = off; i < 16; i++, at += 4)
            words[i] =
                data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16) | (data[at + 3]! << 24);
        this.processWords(words, 0);
    }

    /** The 64 steps of RFC 1321 written out, with the sine constants as literals. */
    private processWords(words: Int32Array, off: number): void {
        const m0 = words[off]!;
        const m1 = words[off + 1]!;
        const m2 = words[off + 2]!;
        const m3 = words[off + 3]!;
        const m4 = words[off + 4]!;
        const m5 = words[off + 5]!;
        const m6 = words[off + 6]!;
        const m7 = words[off + 7]!;
        const m8 = words[off + 8]!;
        const m9 = words[off + 9]!;
        const m10 = words[off + 10]!;
        const m11 = words[off + 11]!;
        const m12 = words[off + 12]!;
        const m13 = words[off + 13]!;
        const m14 = words[off + 14]!;
        const m15 = words[off + 15]!;

        const state = this.state;
        let a = state[0]!;
        let b = state[1]!;
        let c = state[2]!;
        let d = state[3]!;

        let t: number;
        t = (a + ((b & c) | (~b & d)) + m0 - 680876936) | 0;
        a = (((t << 7) | (t >>> 25)) + b) | 0;
        t = (d + ((a & b) | (~a & c)) + m1 - 389564586) | 0;
        d = (((t << 12) | (t >>> 20)) + a) | 0;
        t = (c + ((d & a) | (~d & b)) + m2 + 606105819) | 0;
        c = (((t << 17) | (t >>> 15)) + d) | 0;
        t = (b + ((c & d) | (~c & a)) + m3 - 1044525330) | 0;
        b = (((t << 22) | (t >>> 10)) + c) | 0;
        t = (a + ((b & c) | (~b & d)) + m4 - 176418897) | 0;
        a = (((t << 7) | (t >>> 25)) + b) | 0;
        t = (d + ((a & b) | (~a & c)) + m5 + 1200080426) | 0;
        d = (((t << 12) | (t >>> 20)) + a) | 0;
        t = (c + ((d & a) | (~d & b)) + m6 - 1473231341) | 0;
        c = (((t << 17) | (t >>> 15)) + d) | 0;
        t = (b + ((c & d) | (~c & a)) + m7 - 45705983) | 0;
        b = (((t << 22) | (t >>> 10)) + c) | 0;
        t = (a + ((b & c) | (~b & d)) + m8 + 1770035416) | 0;
        a = (((t << 7) | (t >>> 25)) + b) | 0;
        t = (d + ((a & b) | (~a & c)) + m9 - 1958414417) | 0;
        d = (((t << 12) | (t >>> 20)) + a) | 0;
        t = (c + ((d & a) | (~d & b)) + m10 - 42063) | 0;
        c = (((t << 17) | (t >>> 15)) + d) | 0;
        t = (b + ((c & d) | (~c & a)) + m11 - 1990404162) | 0;
        b = (((t << 22) | (t >>> 10)) + c) | 0;
        t = (a + ((b & c) | (~b & d)) + m12 + 1804603682) | 0;
        a = (((t << 7) | (t >>> 25)) + b) | 0;
        t = (d + ((a & b) | (~a & c)) + m13 - 40341101) | 0;
        d = (((t << 12) | (t >>> 20)) + a) | 0;
        t = (c + ((d & a) | (~d & b)) + m14 - 1502002290) | 0;
        c = (((t << 17) | (t >>> 15)) + d) | 0;
        t = (b + ((c & d) | (~c & a)) + m15 + 1236535329) | 0;
        b = (((t << 22) | (t >>> 10)) + c) | 0;

        t = (a + ((b & d) | (c & ~d)) + m1 - 165796510) | 0;
        a = (((t << 5) | (t >>> 27)) + b) | 0;
        t = (d + ((a & c) | (b & ~c)) + m6 - 1069501632) | 0;
        d = (((t << 9) | (t >>> 23)) + a) | 0;
        t = (c + ((d & b) | (a & ~b)) + m11 + 643717713) | 0;
        c = (((t << 14) | (t >>> 18)) + d) | 0;
        t = (b + ((c & a) | (d & ~a)) + m0 - 373897302) | 0;
        b = (((t << 20) | (t >>> 12)) + c) | 0;
        t = (a + ((b & d) | (c & ~d)) + m5 - 701558691) | 0;
        a = (((t << 5) | (t >>> 27)) + b) | 0;
        t = (d + ((a & c) | (b & ~c)) + m10 + 38016083) | 0;
        d = (((t << 9) | (t >>> 23)) + a) | 0;
        t = (c + ((d & b) | (a & ~b)) + m15 - 660478335) | 0;
        c = (((t << 14) | (t >>> 18)) + d) | 0;
        t = (b + ((c & a) | (d & ~a)) + m4 - 405537848) | 0;
        b = (((t << 20) | (t >>> 12)) + c) | 0;
        t = (a + ((b & d) | (c & ~d)) + m9 + 568446438) | 0;
        a = (((t << 5) | (t >>> 27)) + b) | 0;
        t = (d + ((a & c) | (b & ~c)) + m14 - 1019803690) | 0;
        d = (((t << 9) | (t >>> 23)) + a) | 0;
        t = (c + ((d & b) | (a & ~b)) + m3 - 187363961) | 0;
        c = (((t << 14) | (t >>> 18)) + d) | 0;
        t = (b + ((c & a) | (d & ~a)) + m8 + 1163531501) | 0;
        b = (((t << 20) | (t >>> 12)) + c) | 0;
        t = (a + ((b & d) | (c & ~d)) + m13 - 1444681467) | 0;
        a = (((t << 5) | (t >>> 27)) + b) | 0;
        t = (d + ((a & c) | (b & ~c)) + m2 - 51403784) | 0;
        d = (((t << 9) | (t >>> 23)) + a) | 0;
        t = (c + ((d & b) | (a & ~b)) + m7 + 1735328473) | 0;
        c = (((t << 14) | (t >>> 18)) + d) | 0;
        t = (b + ((c & a) | (d & ~a)) + m12 - 1926607734) | 0;
        b = (((t << 20) | (t >>> 12)) + c) | 0;

        t = (a + (b ^ c ^ d) + m5 - 378558) | 0;
        a = (((t << 4) | (t >>> 28)) + b) | 0;
        t = (d + (a ^ b ^ c) + m8 - 2022574463) | 0;
        d = (((t << 11) | (t >>> 21)) + a) | 0;
        t = (c + (d ^ a ^ b) + m11 + 1839030562) | 0;
        c = (((t << 16) | (t >>> 16)) + d) | 0;
        t = (b + (c ^ d ^ a) + m14 - 35309556) | 0;
        b = (((t << 23) | (t >>> 9)) + c) | 0;
        t = (a + (b ^ c ^ d) + m1 - 1530992060) | 0;
        a = (((t << 4) | (t >>> 28)) + b) | 0;
        t = (d + (a ^ b ^ c) + m4 + 1272893353) | 0;
        d = (((t << 11) | (t >>> 21)) + a) | 0;
        t = (c + (d ^ a ^ b) + m7 - 155497632) | 0;
        c = (((t << 16) | (t >>> 16)) + d) | 0;
        t = (b + (c ^ d ^ a) + m10 - 1094730640) | 0;
        b = (((t << 23) | (t >>> 9)) + c) | 0;
        t = (a + (b ^ c ^ d) + m13 + 681279174) | 0;
        a = (((t << 4) | (t >>> 28)) + b) | 0;
        t = (d + (a ^ b ^ c) + m0 - 358537222) | 0;
        d = (((t << 11) | (t >>> 21)) + a) | 0;
        t = (c + (d ^ a ^ b) + m3 - 722521979) | 0;
        c = (((t << 16) | (t >>> 16)) + d) | 0;
        t = (b + (c ^ d ^ a) + m6 + 76029189) | 0;
        b = (((t << 23) | (t >>> 9)) + c) | 0;
        t = (a + (b ^ c ^ d) + m9 - 640364487) | 0;
        a = (((t << 4) | (t >>> 28)) + b) | 0;
        t = (d + (a ^ b ^ c) + m12 - 421815835) | 0;
        d = (((t << 11) | (t >>> 21)) + a) | 0;
        t = (c + (d ^ a ^ b) + m15 + 530742520) | 0;
        c = (((t << 16) | (t >>> 16)) + d) | 0;
        t = (b + (c ^ d ^ a) + m2 - 995338651) | 0;
        b = (((t << 23) | (t >>> 9)) + c) | 0;

        t = (a + (c ^ (b | ~d)) + m0 - 198630844) | 0;
        a = (((t << 6) | (t >>> 26)) + b) | 0;
        t = (d + (b ^ (a | ~c)) + m7 + 1126891415) | 0;
        d = (((t << 10) | (t >>> 22)) + a) | 0;
        t = (c + (a ^ (d | ~b)) + m14 - 1416354905) | 0;
        c = (((t << 15) | (t >>> 17)) + d) | 0;
        t = (b + (d ^ (c | ~a)) + m5 - 57434055) | 0;
        b = (((t << 21) | (t >>> 11)) + c) | 0;
        t = (a + (c ^ (b | ~d)) + m12 + 1700485571) | 0;
        a = (((t << 6) | (t >>> 26)) + b) | 0;
        t = (d + (b ^ (a | ~c)) + m3 - 1894986606) | 0;
        d = (((t << 10) | (t >>> 22)) + a) | 0;
        t = (c + (a ^ (d | ~b)) + m10 - 1051523) | 0;
        c = (((t << 15) | (t >>> 17)) + d) | 0;
        t = (b + (d ^ (c | ~a)) + m1 - 2054922799) | 0;
        b = (((t << 21) | (t >>> 11)) + c) | 0;
        t = (a + (c ^ (b | ~d)) + m8 + 1873313359) | 0;
        a = (((t << 6) | (t >>> 26)) + b) | 0;
        t = (d + (b ^ (a | ~c)) + m15 - 30611744) | 0;
        d = (((t << 10) | (t >>> 22)) + a) | 0;
        t = (c + (a ^ (d | ~b)) + m6 - 1560198380) | 0;
        c = (((t << 15) | (t >>> 17)) + d) | 0;
        t = (b + (d ^ (c | ~a)) + m13 + 1309151649) | 0;
        b = (((t << 21) | (t >>> 11)) + c) | 0;
        t = (a + (c ^ (b | ~d)) + m4 - 145523070) | 0;
        a = (((t << 6) | (t >>> 26)) + b) | 0;
        t = (d + (b ^ (a | ~c)) + m11 - 1120210379) | 0;
        d = (((t << 10) | (t >>> 22)) + a) | 0;
        t = (c + (a ^ (d | ~b)) + m2 + 718787259) | 0;
        c = (((t << 15) | (t >>> 17)) + d) | 0;
        t = (b + (d ^ (c | ~a)) + m9 - 343485551) | 0;
        b = (((t << 21) | (t >>> 11)) + c) | 0;

        state[0] = (state[0]! + a) | 0;
        state[1] = (state[1]! + b) | 0;
        state[2] = (state[2]! + c) | 0;
        state[3] = (state[3]! + d) | 0;
    }
}

class FlacBits {
    private buf: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(1 << 10));
    private len = 0;
    private acc = 0;
    private accBits = 0;

    write(value: number, bits: number): void {
        while (bits > 0) {
            const take = Math.min(bits, 24);
            const chunk =
                bits > 24
                    ? Math.floor(value / 2 ** (bits - take)) & ((1 << take) - 1)
                    : value & ((1 << take) - 1);
            this.acc = (this.acc << take) | chunk;
            this.accBits += take;
            bits -= take;
            while (this.accBits >= 8) {
                this.push((this.acc >>> (this.accBits - 8)) & 0xff);
                this.accBits -= 8;
            }
            this.acc &= (1 << this.accBits) - 1;
        }
    }

    reserve(bits: number): void {
        const bytes = Math.ceil(bits / 8) + 8;
        if (this.len + bytes > this.buf.length) this.grow(bytes);
    }

    /** Rice codes of residuals[start, end) with parameter `k`; reserve() made room for them. */
    writeRice(residuals: Int32Array, start: number, end: number, k: number): void {
        let buf = this.buf;
        const mask = (1 << k) - 1;
        const stop = 1 << k;
        let acc = this.acc;
        let accBits = this.accBits;
        let len = this.len;
        for (let i = start; i < end; i++) {
            const v = residuals[i]!;
            const zigzag = ((v << 1) ^ (v >> 31)) >>> 0;
            const quotient = zigzag >>> k;
            if (quotient + k < 24) {
                // The quotient's zeros, the stop bit and the low bits: at most 24 bits above the
                // fewer than 8 the accumulator holds.
                const bits = quotient + 1 + k;
                acc = (acc << bits) | stop | (zigzag & mask);
                accBits += bits;
                while (accBits >= 8) {
                    accBits -= 8;
                    buf[len++] = acc >>> accBits;
                }
                acc &= (1 << accBits) - 1;
                continue;
            }
            this.acc = acc;
            this.accBits = accBits;
            this.len = len;
            this.writeUnary(quotient);
            if (k > 0) this.write(zigzag & mask, k);
            buf = this.buf;
            acc = this.acc;
            accBits = this.accBits;
            len = this.len;
        }
        this.acc = acc;
        this.accBits = accBits;
        this.len = len;
    }

    /** Starts the next frame in the same buffer. */
    reset(): void {
        this.len = 0;
        this.acc = 0;
        this.accBits = 0;
    }

    writeUnary(value: number): void {
        while (value >= 32) {
            this.write(0, 32);
            value -= 32;
        }
        this.write(1, value + 1);
    }

    alignByte(): void {
        if (this.accBits > 0) this.write(0, 8 - this.accBits);
    }

    bytes(): Uint8Array<ArrayBuffer> {
        return this.buf.subarray(0, this.len);
    }

    private push(byte: number): void {
        if (this.len === this.buf.length) this.grow(1);
        this.buf[this.len++] = byte;
    }

    private grow(bytes: number): void {
        let size = this.buf.length * 2;
        while (size < this.len + bytes) size *= 2;
        const next = new Uint8Array(new ArrayBuffer(size));
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }
}

const CRC8_TABLE = (() => {
    const table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        table[i] = crc;
    }
    return table;
})();

function crc8(data: Uint8Array): number {
    let crc = 0;
    for (let i = 0; i < data.length; i++) crc = CRC8_TABLE[crc ^ data[i]];
    return crc;
}

function writeUtf8Number(bits: FlacBits, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOTAL_SAMPLES) {
        throw new EncodeError('FLAC sample number exceeds 36 bits');
    }
    if (value < 0x80) {
        bits.write(value, 8);
        return;
    }
    const bytes: number[] = [];
    let v = value;

    let mask = 0x80;
    let max = 0x40;
    while (v >= max && max > 1) {
        bytes.unshift(0x80 | (v & 0x3f));
        v = Math.floor(v / 64);
        mask = (mask >> 1) | 0x80;
        max >>= 1;
    }
    bytes.unshift((mask & 0xff) | v);
    for (const byte of bytes) bits.write(byte, 8);
}

function fixedResiduals(samples: Int32Array, order: number, out: Int32Array): void {
    const n = samples.length;
    switch (order) {
        case 0:
            out.set(samples);
            return;
        case 1:
            for (let i = 1; i < n; i++) out[i - 1] = samples[i]! - samples[i - 1]!;
            return;
        case 2:
            for (let i = 2; i < n; i++)
                out[i - 2] = samples[i]! - 2 * samples[i - 1]! + samples[i - 2]!;
            return;
        case 3:
            for (let i = 3; i < n; i++)
                out[i - 3] =
                    samples[i]! - 3 * samples[i - 1]! + 3 * samples[i - 2]! - samples[i - 3]!;
            return;
        default:
            for (let i = 4; i < n; i++)
                out[i - 4] =
                    samples[i]! -
                    4 * samples[i - 1]! +
                    6 * samples[i - 2]! -
                    4 * samples[i - 3]! +
                    samples[i - 4]!;
    }
}

let cachedWindow = new Float64Array(0);

function welchWindow(n: number): Float64Array {
    if (cachedWindow.length === n) return cachedWindow;
    const window = new Float64Array(n);
    for (let i = 0; i < n; i++) window[i] = 1 - ((i - (n - 1) / 2) / ((n + 1) / 2)) ** 2;
    if (n === BLOCK_SIZE) cachedWindow = window;
    return window;
}

/** The order of the linear predictor a block of `n` samples takes: 8, or less for a short block. */
function lpcOrderFor(n: number): number {
    return Math.min(MAX_LPC_ORDER, n >> 1);
}

/**
 * One pass over a candidate's samples: the sums of the zigzag codes (2|r|, less 1 for a negative
 * r) of the residuals of the fixed predictors of orders 0..4 into costs[at, at + 5), each over
 * samples order..n-1; the autocorrelation of the Welch-windowed samples at lags
 * 0..lpcOrderFor(n) into `autoc`, each lag summed in increasing sample order (the quantized
 * coefficients depend on its rounding); and the OR of the samples, which it returns: its lowest set
 * bit tells the zero bits every sample shares. Every sample is the same when the order-1 sum is
 * zero.
 */
function survey(samples: Int32Array, costs: Float64Array, at: number, autoc: Float64Array): number {
    const n = samples.length;
    const window = welchWindow(n);
    const maxOrder = lpcOrderFor(n);
    let shared = 0;
    let c0 = 0;
    let c1 = 0;
    let c2 = 0;
    let c3 = 0;
    let c4 = 0;
    let x1 = 0;
    let d1 = 0;
    let e1 = 0;
    let f1 = 0;
    // Math.abs rather than a comparison: the signs of sound change at random, and a branch on them
    // costs more than the rest of the loop.
    if (maxOrder !== MAX_LPC_ORDER) {
        for (let i = 0; i < n; i++) {
            const x = samples[i]!;
            const d = x - x1;
            const e = d - d1;
            const f = e - e1;
            shared |= x;
            c0 += (x << 1) ^ (x >> 31);
            c1 += (d << 1) ^ (d >> 31);
            c2 += (e << 1) ^ (e >> 31);
            c3 += (f << 1) ^ (f >> 31);
            c4 += ((f - f1) << 1) ^ ((f - f1) >> 31);
            x1 = x;
            d1 = d;
            e1 = e;
            f1 = f;
        }
        for (let lag = 0; lag <= maxOrder; lag++) {
            let sum = 0;
            for (let i = lag; i < n; i++)
                sum += samples[i]! * window[i]! * (samples[i - lag]! * window[i - lag]!);
            autoc[lag] = sum;
        }
    } else {
        // Before sample 8 the earlier windowed samples are zero, so the longer lags add exact
        // zeros.
        let a0 = 0;
        let a1 = 0;
        let a2 = 0;
        let a3 = 0;
        let a4 = 0;
        let a5 = 0;
        let a6 = 0;
        let a7 = 0;
        let a8 = 0;
        let w1 = 0;
        let w2 = 0;
        let w3 = 0;
        let w4 = 0;
        let w5 = 0;
        let w6 = 0;
        let w7 = 0;
        let w8 = 0;
        for (let i = 0; i < n; i++) {
            const x = samples[i]!;
            const d = x - x1;
            const e = d - d1;
            const f = e - e1;
            shared |= x;
            c0 += (x << 1) ^ (x >> 31);
            c1 += (d << 1) ^ (d >> 31);
            c2 += (e << 1) ^ (e >> 31);
            c3 += (f << 1) ^ (f >> 31);
            c4 += ((f - f1) << 1) ^ ((f - f1) >> 31);
            x1 = x;
            d1 = d;
            e1 = e;
            f1 = f;
            const v = x * window[i]!;
            a0 += v * v;
            a1 += v * w1;
            a2 += v * w2;
            a3 += v * w3;
            a4 += v * w4;
            a5 += v * w5;
            a6 += v * w6;
            a7 += v * w7;
            a8 += v * w8;
            w8 = w7;
            w7 = w6;
            w6 = w5;
            w5 = w4;
            w4 = w3;
            w3 = w2;
            w2 = w1;
            w1 = v;
        }
        autoc[0] = a0;
        autoc[1] = a1;
        autoc[2] = a2;
        autoc[3] = a3;
        autoc[4] = a4;
        autoc[5] = a5;
        autoc[6] = a6;
        autoc[7] = a7;
        autoc[8] = a8;
    }
    // Each fixed predictor starts at its order: the loop's terms before it, taken from the zeros
    // before the block, are taken off again. The sums are integers, so this is exact.
    x1 = 0;
    d1 = 0;
    e1 = 0;
    f1 = 0;
    for (let i = 0; i < 4 && i < n; i++) {
        const x = samples[i]!;
        const d = x - x1;
        const e = d - d1;
        const f = e - e1;
        if (i < 1) c1 -= (d << 1) ^ (d >> 31);
        if (i < 2) c2 -= (e << 1) ^ (e >> 31);
        if (i < 3) c3 -= (f << 1) ^ (f >> 31);
        c4 -= ((f - f1) << 1) ^ ((f - f1) >> 31);
        x1 = x;
        d1 = d;
        e1 = e;
        f1 = f;
    }
    costs[at] = c0;
    costs[at + 1] = c1;
    costs[at + 2] = c2;
    costs[at + 3] = c3;
    costs[at + 4] = c4;
    return shared;
}

interface LpcModel {
    readonly order: number;
    readonly shift: number;
    readonly coefficients: Int32Array;
}

/** The quantized linear predictor of up to `maxOrder` from an autocorrelation, lags 0..maxOrder. */
function computeLpc(autoc: Float64Array, n: number, maxOrder: number): LpcModel | null {
    if (n <= maxOrder * 2) return null;
    if (autoc[0] <= 0) return null;

    const lpc = new Float64Array(maxOrder);
    let error = autoc[0];
    let order = 0;
    for (let i = 0; i < maxOrder; i++) {
        let acc = autoc[i + 1];
        for (let j = 0; j < i; j++) acc -= lpc[j] * autoc[i - j];
        const reflection = acc / error;
        error *= 1 - reflection * reflection;
        lpc[i] = reflection;
        for (let j = 0; j < i >> 1; j++) {
            const tmp = lpc[j];
            lpc[j] = tmp - reflection * lpc[i - 1 - j];
            lpc[i - 1 - j] -= reflection * tmp;
        }
        if (i & 1) lpc[i >> 1] -= lpc[i >> 1] * reflection;
        order = i + 1;
        if (error <= 0) break;
    }
    if (order === 0) return null;

    let maxCoef = 0;
    for (let i = 0; i < order; i++) maxCoef = Math.max(maxCoef, Math.abs(lpc[i]));
    if (!(maxCoef > 0) || !Number.isFinite(maxCoef)) return null;
    let shift = LPC_PRECISION - 1 - Math.max(0, Math.floor(Math.log2(maxCoef)) + 1);
    shift = Math.max(1, Math.min(15, shift));
    const limit = (1 << (LPC_PRECISION - 1)) - 1;
    const coefficients = new Int32Array(order);
    let err = 0;
    for (let i = 0; i < order; i++) {
        const ideal = lpc[i] * (1 << shift) + err;
        let q = Math.round(ideal);
        if (q > limit) q = limit;
        else if (q < -limit - 1) q = -limit - 1;
        err = ideal - q;
        coefficients[i] = q;
    }
    return { order, shift, coefficients };
}

let floatScratch = new Float64Array(BLOCK_SIZE);

/**
 * Writes the residuals of `model` into `out`; false when one is too large to code, as a predictor
 * far off a loud signal can make it.
 */
function lpcResiduals(samples: Int32Array, model: LpcModel, out: Int32Array): boolean {
    const { order, shift, coefficients } = model;
    let fits = true;
    if (order === MAX_LPC_ORDER) {
        // The samples as doubles once, rather than each of them eight times.
        const n = samples.length;
        if (floatScratch.length < n) floatScratch = new Float64Array(n);
        const x = floatScratch;
        for (let i = 0; i < n; i++) x[i] = samples[i]!;
        const scale = 1 / (1 << shift);
        const c0 = coefficients[0]!;
        const c1 = coefficients[1]!;
        const c2 = coefficients[2]!;
        const c3 = coefficients[3]!;
        const c4 = coefficients[4]!;
        const c5 = coefficients[5]!;
        const c6 = coefficients[6]!;
        const c7 = coefficients[7]!;
        for (let i = MAX_LPC_ORDER; i < n; i++) {
            const prediction =
                c0 * x[i - 1]! +
                c1 * x[i - 2]! +
                c2 * x[i - 3]! +
                c3 * x[i - 4]! +
                c4 * x[i - 5]! +
                c5 * x[i - 6]! +
                c6 * x[i - 7]! +
                c7 * x[i - 8]!;
            const residual = x[i]! - Math.floor(prediction * scale);
            if (residual > MAX_RESIDUAL || residual < -MAX_RESIDUAL) fits = false;
            out[i - MAX_LPC_ORDER] = residual;
        }
        return fits;
    }
    for (let i = order; i < samples.length; i++) {
        let prediction = 0;
        for (let j = 0; j < order; j++) prediction += coefficients[j] * samples[i - 1 - j];
        const residual = samples[i] - Math.floor(prediction / (1 << shift));
        if (residual > MAX_RESIDUAL || residual < -MAX_RESIDUAL) fits = false;
        out[i - order] = residual;
    }
    return fits;
}

/**
 * The smallest Rice parameter (up to `maxParam`) whose 2^k reaches the mean magnitude: an integer
 * reaches the mean exactly when it reaches the mean rounded up, which leading zeros count.
 */
function riceParamFor(sumAbs: number, count: number, maxParam: number): number {
    if (count === 0 || sumAbs === 0) return 0;
    const ceiling = Math.ceil(sumAbs / count);
    const k = ceiling <= 1 ? 0 : ceiling > 2 ** 31 ? 32 : 32 - Math.clz32(ceiling - 1);
    return Math.min(k, maxParam);
}

interface RicePlan {
    /** 0: 4-bit parameters (RICE1); 1: 5-bit parameters (RICE2). */
    readonly method: 0 | 1;
    readonly partitionOrder: number;
    readonly params: number[];
    readonly bits: number;
}

const FINE_PARTITIONS = 1 << MAX_PARTITION_ORDER;
const SHIFTED_STRIDE = MAX_RICE2_PARAM + 1;
const fineSums = new Float64Array(FINE_PARTITIONS);
const fineNegatives = new Float64Array(FINE_PARTITIONS);
const fineLow = new Int32Array(FINE_PARTITIONS);
const fineHigh = new Int32Array(FINE_PARTITIONS);
const fineShifted = new Float64Array(FINE_PARTITIONS * SHIFTED_STRIDE);
const levelParams = new Int32Array(2 * FINE_PARTITIONS);

/** Partition order of the sums in fineSums: their partitions are the finest planRice() uses. */
let fineOrder = 0;

/**
 * Sums the residual magnitudes of each partition of the finest valid order (the partitions divide
 * the block evenly and each holds more samples than the predictor's warm-up) into fineSums, and
 * counts their negative residuals into fineNegatives, for planRice() and estimateRice().
 */
function sumPartitions(residuals: Int32Array, blockSize: number, predictorOrder: number): void {
    let top = -1;
    for (let po = 0; po <= MAX_PARTITION_ORDER; po++) {
        const partitions = 1 << po;
        if (blockSize % partitions !== 0) continue;
        if (blockSize / partitions <= predictorOrder) break;
        top = po;
    }
    if (top < 0) throw new EncodeError('FLAC: no valid Rice partitioning');
    const fine = 1 << top;
    const fineSize = blockSize / fine;
    for (let f = 0; f < fine; f++) {
        const start = f === 0 ? 0 : f * fineSize - predictorOrder;
        const end = (f + 1) * fineSize - predictorOrder;
        let sumAbs = 0;
        let negatives = 0;
        for (let i = start; i < end; i++) {
            const v = residuals[i]!;
            sumAbs += Math.abs(v);
            negatives += v >>> 31;
        }
        fineSums[f] = sumAbs;
        fineNegatives[f] = negatives;
    }
    fineOrder = top;
}

/**
 * Estimated bits of the residual coding of the residuals sumPartitions() summed last, over the
 * partition orders planRice() searches, each partition's codes estimated from its zigzag sum
 * (estimateRiceBits()) instead of counted. The sums are taken as `scale` times smaller: residuals
 * of samples that share zero bits, before those are shifted out.
 */
function estimateRice(
    blockSize: number,
    predictorOrder: number,
    maxParam: number,
    scale: number,
): number {
    const parameterBits = maxParam > MAX_RICE_PARAM ? 5 : 4;
    const fine = 1 << fineOrder;
    let best = Number.POSITIVE_INFINITY;
    for (let po = 0; po <= fineOrder; po++) {
        const partitions = 1 << po;
        const group = fine >> po;
        const partSize = blockSize / partitions;
        let bits = 6;
        for (let p = 0; p < partitions; p++) {
            let zigzag = 0;
            for (let f = p * group; f < (p + 1) * group; f++)
                zigzag += 2 * fineSums[f]! - fineNegatives[f]!;
            const count = p === 0 ? partSize - predictorOrder : partSize;
            bits += parameterBits + estimateRiceBits(zigzag / scale, count, maxParam);
        }
        if (bits < best) best = bits;
    }
    return best;
}

/**
 * Smallest exact Rice cost of the residuals sumPartitions() summed last; each coarser partition is
 * a union of the finest. Parameters go up to `maxParam`; above 14 they take the 5-bit coding,
 * which a plan uses only when one of its parameters needs it.
 */
function planRice(
    residuals: Int32Array,
    blockSize: number,
    predictorOrder: number,
    maxParam: number,
): RicePlan {
    const parameterBits = maxParam > MAX_RICE_PARAM ? 5 : 4;
    const top = fineOrder;
    const fine = 1 << top;
    const fineSize = blockSize / fine;
    for (let f = 0; f < fine; f++) {
        fineLow[f] = maxParam;
        fineHigh[f] = 0;
    }
    for (let po = 0; po <= top; po++) {
        const partitions = 1 << po;
        const group = fine >> po;
        const partSize = blockSize / partitions;
        for (let p = 0; p < partitions; p++) {
            let sumAbs = 0;
            for (let f = p * group; f < (p + 1) * group; f++) sumAbs += fineSums[f]!;
            const count = p === 0 ? partSize - predictorOrder : partSize;
            const k = riceParamFor(sumAbs, count, maxParam);
            levelParams[partitions - 1 + p] = k;
            const low = k > 0 ? k - 1 : 0;
            const high = k < maxParam ? k + 1 : maxParam;
            for (let f = p * group; f < (p + 1) * group; f++) {
                if (low < fineLow[f]!) fineLow[f] = low;
                if (high > fineHigh[f]!) fineHigh[f] = high;
            }
        }
    }
    for (let f = 0; f < fine; f++) {
        const start = f === 0 ? 0 : f * fineSize - predictorOrder;
        const end = (f + 1) * fineSize - predictorOrder;
        const low = fineLow[f]!;
        const high = fineHigh[f]!;
        const base = f * SHIFTED_STRIDE;
        if (high - low === 2) {
            let s0 = 0;
            let s1 = 0;
            let s2 = 0;
            for (let i = start; i < end; i++) {
                const v = residuals[i]!;
                const t = ((v << 1) ^ (v >> 31)) >>> low;
                s0 += t;
                s1 += t >>> 1;
                s2 += t >>> 2;
            }
            fineShifted[base + low] = s0;
            fineShifted[base + low + 1] = s1;
            fineShifted[base + low + 2] = s2;
            continue;
        }
        for (let j = low; j <= high; j++) fineShifted[base + j] = 0;
        for (let i = start; i < end; i++) {
            const v = residuals[i]!;
            let t = ((v << 1) ^ (v >> 31)) >>> low;
            for (let j = base + low; j <= base + high; j++) {
                fineShifted[j] += t;
                t >>>= 1;
            }
        }
    }
    let bestOrder = -1;
    let bestBits = 0;
    for (let po = 0; po <= top; po++) {
        const partitions = 1 << po;
        const group = fine >> po;
        const partSize = blockSize / partitions;
        let bits = 0;
        for (let p = 0; p < partitions; p++) {
            const count = p === 0 ? partSize - predictorOrder : partSize;
            const first = p * group;
            const last = first + group;
            let k = levelParams[partitions - 1 + p]!;
            let cost = shiftedSum(first, last, k) + count * (1 + k);
            if (k > 0) {
                const lower = shiftedSum(first, last, k - 1) + count * k;
                if (lower < cost) {
                    k--;
                    cost = lower;
                }
            }
            if (k + 1 <= maxParam) {
                const higher = shiftedSum(first, last, k + 1) + count * (2 + k);
                if (higher < cost) {
                    k++;
                    cost = higher;
                }
            }
            levelParams[partitions - 1 + p] = k;
            bits += parameterBits + cost;
        }
        const total = bits + 3;
        if (bestOrder < 0 || total < bestBits) {
            bestOrder = po;
            bestBits = total;
        }
    }
    const partitions = 1 << bestOrder;
    const params: number[] = new Array(partitions);
    let largest = 0;
    for (let p = 0; p < partitions; p++) {
        params[p] = levelParams[partitions - 1 + p]!;
        largest = Math.max(largest, params[p]);
    }
    if (largest > MAX_RICE_PARAM)
        return { method: 1, partitionOrder: bestOrder, params, bits: bestBits };
    const bits = bestBits - (parameterBits - 4) * partitions;
    return { method: 0, partitionOrder: bestOrder, params, bits };
}

function shiftedSum(first: number, last: number, k: number): number {
    let sum = 0;
    for (let f = first; f < last; f++) sum += fineShifted[f * SHIFTED_STRIDE + k]!;
    return sum;
}

function writeResidual(
    bits: FlacBits,
    residuals: Int32Array,
    plan: RicePlan,
    blockSize: number,
    predictorOrder: number,
): void {
    bits.reserve(plan.bits);
    bits.write(plan.method, 2);
    bits.write(plan.partitionOrder, 4);
    const parameterBits = plan.method === 1 ? 5 : 4;
    const partitions = 1 << plan.partitionOrder;
    const partSize = blockSize / partitions;
    for (let p = 0; p < partitions; p++) {
        const k = plan.params[p]!;
        bits.write(k, parameterBits);
        const start = p === 0 ? 0 : p * partSize - predictorOrder;
        bits.writeRice(residuals, start, (p + 1) * partSize - predictorOrder, k);
    }
}

interface SubframePlan {
    readonly kind: 'constant' | 'verbatim' | 'fixed' | 'lpc';
    readonly order: number;
    readonly lpc: LpcModel | null;
    readonly residuals: Int32Array;
    readonly rice: RicePlan | null;
    readonly bits: number;
}

/**
 * Estimated Rice bits of `count` residuals whose zigzag codes sum to `z`, at the best parameter
 * within one of riceParamFor()'s pick, taking the bits a shift by k drops as uniform: they lose
 * (1 - 2^-k) / 2 of each quotient on average.
 */
function estimateRiceBits(z: number, count: number, maxParam: number): number {
    const k0 = riceParamFor(z / 2, count, maxParam);
    const last = k0 < maxParam ? k0 + 1 : maxParam;
    let best = Number.POSITIVE_INFINITY;
    for (let k = k0 > 0 ? k0 - 1 : 0; k <= last; k++) {
        const scale = RICE_SCALES[k]!;
        const quotients = z * scale - (k > 0 ? count * (1 - scale) * 0.5 : 0);
        const bits = count * (1 + k) + (quotients > 0 ? quotients : 0);
        if (bits < best) best = bits;
    }
    return best;
}

/** 2^-k for each Rice parameter k. */
const RICE_SCALES = Float64Array.from({ length: MAX_RICE2_PARAM + 1 }, (_, k) => 2 ** -k);

/** The fixed predictor order whose residuals' zigzag sum at `at` of `costs` is smallest. */
function bestFixedOrder(costs: Float64Array, at: number, n: number): number {
    let order = 0;
    for (let candidate = 1; candidate <= 4 && candidate < n; candidate++)
        if (costs[at + candidate]! < costs[at + order]!) order = candidate;
    return order;
}

/**
 * Plans a subframe exactly (Rice partitions and parameters) with one predictor: the linear
 * predictor `lpc` when `useLpc` (its residuals already in `lpcScratch`), else the fixed predictor
 * whose residuals' zigzag sum at `at` of `fixedCosts` is smallest; a verbatim subframe when that is
 * smaller. `fixedScratch` and `lpcScratch` hold at least samples.length values; the returned plan
 * may alias either. Samples of more than 17 bits (24-bit audio and its side channel) may take Rice
 * parameters past 14.
 */
function planSubframe(
    samples: Int32Array,
    sampleBits: number,
    fixedCosts: Float64Array,
    at: number,
    lpc: LpcModel | null,
    useLpc: boolean,
    fixedScratch: Int32Array,
    lpcScratch: Int32Array,
): SubframePlan {
    const n = samples.length;
    const maxParam = sampleBits > 17 ? MAX_RICE2_PARAM : MAX_RICE_PARAM;
    if (fixedCosts[at + 1] === 0) {
        return {
            kind: 'constant',
            order: 0,
            lpc: null,
            residuals: new Int32Array(0),
            rice: null,
            bits: 8 + sampleBits,
        };
    }

    const verbatim: SubframePlan = {
        kind: 'verbatim',
        order: 0,
        lpc: null,
        residuals: new Int32Array(0),
        rice: null,
        bits: 8 + n * sampleBits,
    };

    if (useLpc && lpc) {
        const residuals = lpcScratch.subarray(0, n - lpc.order);
        sumPartitions(residuals, n, lpc.order);
        const rice = planRice(residuals, n, lpc.order, maxParam);
        const bits = 8 + lpc.order * sampleBits + 4 + 5 + lpc.order * LPC_PRECISION + rice.bits;
        return bits < verbatim.bits
            ? { kind: 'lpc', order: lpc.order, lpc, residuals, rice, bits }
            : verbatim;
    }

    const order = bestFixedOrder(fixedCosts, at, n);
    const residuals = fixedScratch.subarray(0, n - order);
    fixedResiduals(samples, order, residuals);
    sumPartitions(residuals, n, order);
    const rice = planRice(residuals, n, order, maxParam);
    const bits = 8 + order * sampleBits + rice.bits;
    return bits < verbatim.bits
        ? { kind: 'fixed', order, lpc: null, residuals, rice, bits }
        : verbatim;
}

/**
 * Writes one subframe of `samples`, `sampleBits` wide after `wasted` shared trailing zero bits were
 * shifted out of them (the decoder shifts them back).
 */
function writeSubframe(
    bits: FlacBits,
    samples: Int32Array,
    plan: SubframePlan,
    sampleBits: number,
    wasted: number,
): void {
    const header = (type: number): void => {
        bits.write(0, 1);
        bits.write(type, 6);

        // The wasted-bits flag, then their count as unary: count - 1 zeros and a one.
        bits.write(wasted ? 1 : 0, 1);
        if (wasted) bits.write(1, wasted);
    };

    const mask = (1 << sampleBits) - 1;
    if (plan.kind === 'constant') {
        header(0);
        bits.write(samples[0] & mask, sampleBits);
        return;
    }

    if (plan.kind === 'verbatim') {
        header(1);
        for (let i = 0; i < samples.length; i++) bits.write(samples[i] & mask, sampleBits);
        return;
    }

    if (plan.kind === 'fixed') {
        header(0b001000 | plan.order);
        for (let i = 0; i < plan.order; i++) bits.write(samples[i] & mask, sampleBits);
        writeResidual(bits, plan.residuals, plan.rice as RicePlan, samples.length, plan.order);
        return;
    }

    const lpc = plan.lpc as LpcModel;
    header(0b100000 | (lpc.order - 1));
    for (let i = 0; i < lpc.order; i++) bits.write(samples[i] & mask, sampleBits);
    bits.write(LPC_PRECISION - 1, 4);
    bits.write(lpc.shift, 5);
    const coefMask = (1 << LPC_PRECISION) - 1;
    for (let i = 0; i < lpc.order; i++) bits.write(lpc.coefficients[i] & coefMask, LPC_PRECISION);
    writeResidual(bits, plan.residuals, plan.rice as RicePlan, samples.length, lpc.order);
}

interface FlacSampleRateCode {
    readonly code: number;
    readonly tail: 'none' | 'khz8' | 'hz16' | 'tensHz16';
    readonly value?: number;
}

function sampleRateCode(rate: number): FlacSampleRateCode {
    switch (rate) {
        case 88200:
            return { code: 1, tail: 'none' };
        case 176400:
            return { code: 2, tail: 'none' };
        case 192000:
            return { code: 3, tail: 'none' };
        case 8000:
            return { code: 4, tail: 'none' };
        case 16000:
            return { code: 5, tail: 'none' };
        case 22050:
            return { code: 6, tail: 'none' };
        case 24000:
            return { code: 7, tail: 'none' };
        case 32000:
            return { code: 8, tail: 'none' };
        case 44100:
            return { code: 9, tail: 'none' };
        case 48000:
            return { code: 10, tail: 'none' };
        case 96000:
            return { code: 11, tail: 'none' };
        default:
            if (rate % 1000 === 0 && rate / 1000 <= 0xff) {
                return { code: 12, tail: 'khz8', value: rate / 1000 };
            }
            if (rate <= 0xffff) return { code: 13, tail: 'hz16', value: rate };
            if (rate % 10 === 0 && rate / 10 <= 0xffff) {
                return { code: 14, tail: 'tensHz16', value: rate / 10 };
            }

            return { code: 0, tail: 'none' };
    }
}

export interface FlacEncodeOptions {
    readonly onProgress?: (encodedFrames: number, totalFrames: number) => void;
    readonly signal?: AbortSignal;
}

interface StreamingFlacEncodeOptions extends FlacEncodeOptions {
    /** Sample depth of the stream: 16 (default) or 24 bits. */
    readonly bitsPerSample?: 16 | 24;
    readonly expectedInputFrames?: number;
    readonly onFrame?: (frame: Uint8Array, frameIndex: number) => void;
    /** False when encoded frames are delivered directly to an external sink. */
    readonly collectFrames?: boolean;
}

/**
 * The integer sample nearest `value`, a single-precision sample in [-1, 1); `scale` is
 * 2^(bits - 1). Values past full scale take the extreme samples, NaN 0. value * scale has at most
 * 24 significant bits, so adding 1/2 is exact and floor(x + 0.5) is Math.round(x), only quicker.
 */
function quantizePcm(value: number, scale: number): number {
    const sample = Math.floor(value * scale + 0.5);
    return sample > scale - 1 ? scale - 1 : sample < -scale ? -scale : sample;
}

/** A planned subframe: its samples, their width after the wasted bits. */
interface CodedSubframe {
    readonly samples: Int32Array;
    readonly plan: SubframePlan;
    readonly sampleBits: number;
    readonly wasted: number;
}

/**
 * Channel assignments of a stereo frame (RFC 9639 section 9.1.3) and the candidate slots they code:
 * left and right, left and side, side and right, mid and side.
 */
const STEREO_MODES = [
    [1, 0, 1],
    [8, 0, 3],
    [9, 3, 1],
    [10, 2, 3],
] as const;

/**
 * Codes the frames of a stream. Each block's candidate subframes (its channels, and of a stereo
 * block also mid and side) are surveyed in one pass each (the residual sums of the fixed
 * predictors, the shared zero bits, the autocorrelation that gives the linear predictor), and the
 * linear predictor's residuals computed. Each candidate's size is estimated with either predictor
 * from its residuals' zigzag sums (assess()): the linear predictor's per partition, the fixed
 * one's over the block. A stereo block takes the channel assignment whose two candidates are
 * estimated smallest; each coded subframe takes its predictor estimated smaller and is planned
 * exactly with it alone (planSubframe()).
 */
class FlacFrameCore {
    /** Each channel's samples of the block being filled (takePlanar()). */
    private readonly quantized: Int32Array[] = [];
    private readonly mid = new Int32Array(BLOCK_SIZE);
    private readonly side = new Int32Array(BLOCK_SIZE);
    private readonly residuals: Int32Array[] = [];
    /** Samples of each subframe candidate with their wasted bits shifted out. */
    private readonly shifted: Int32Array[] = [];
    /** The fixed predictors' residual sums of each candidate slot (survey()), five per slot. */
    private readonly costs: Float64Array;
    /** The OR of each candidate slot's samples. */
    private readonly shared: Int32Array;
    private readonly models: (LpcModel | null)[] = [];
    /**
     * Estimated bits of each candidate slot (assess()) with its best fixed predictor and with its
     * linear predictor (infinite without one, or when its residuals do not fit).
     */
    private readonly fixedBits: Float64Array;
    private readonly lpcBits: Float64Array;
    private readonly autoc = new Float64Array(MAX_LPC_ORDER + 1);
    private readonly frame = new FlacBits();
    /** A block's samples as the MD5 reads them: words (16-bit mono and stereo) or bytes. */
    private readonly md5Words = new Int32Array(BLOCK_SIZE);
    private readonly md5Bytes: Uint8Array;

    constructor(
        private readonly sampleRate: number,
        private readonly channels: number,
        private readonly depth: 16 | 24,
    ) {
        for (let channel = 0; channel < channels; channel++) {
            this.quantized.push(new Int32Array(BLOCK_SIZE));
        }
        const slots = Math.max(channels, 4);
        for (let slot = 0; slot < slots; slot++) {
            this.residuals.push(new Int32Array(BLOCK_SIZE), new Int32Array(BLOCK_SIZE));
            this.shifted.push(new Int32Array(BLOCK_SIZE));
            this.models.push(null);
        }
        this.costs = new Float64Array(slots * 5);
        this.shared = new Int32Array(slots);
        this.fixedBits = new Float64Array(slots);
        this.lpcBits = new Float64Array(slots);
        this.md5Bytes = new Uint8Array(BLOCK_SIZE * channels * (depth / 8));
    }

    /**
     * Surveys the samples of candidate `slot`, `sampleBits` wide, computes its linear predictor's
     * residuals and estimates its size with either predictor; returns the smaller estimate. The
     * estimates of a candidate with shared zero bits take them off each residual.
     */
    private assess(samples: Int32Array, sampleBits: number, slot: number): number {
        const n = samples.length;
        const at = slot * 5;
        const costs = this.costs;
        const shared = survey(samples, costs, at, this.autoc);
        this.shared[slot] = shared;
        if (costs[at + 1] === 0) {
            this.models[slot] = null;
            this.fixedBits[slot] = 8 + sampleBits;
            this.lpcBits[slot] = Number.POSITIVE_INFINITY;
            return 8 + sampleBits;
        }
        const wasted = shared === 0 ? 0 : 31 - Math.clz32(shared & -shared);
        const bits = sampleBits - wasted;
        const maxParam = bits > 17 ? MAX_RICE2_PARAM : MAX_RICE_PARAM;
        const order = bestFixedOrder(costs, at, n);
        this.fixedBits[slot] = Math.min(
            8 + n * bits,
            8 +
                order * bits +
                6 +
                estimateRiceBits(costs[at + order]! / 2 ** wasted, n - order, maxParam),
        );
        const model = computeLpc(this.autoc, n, lpcOrderFor(n));
        this.models[slot] = model;
        this.lpcBits[slot] = Number.POSITIVE_INFINITY;
        if (model) this.assessResiduals(samples, bits, slot);
        return Math.min(this.fixedBits[slot]!, this.lpcBits[slot]!) + wasted;
    }

    /**
     * Computes the linear predictor's residuals of the assessed candidate `slot` (samples
     * `sampleBits` wide after their shared zero bits) and estimates its size from them.
     */
    private assessResiduals(samples: Int32Array, sampleBits: number, slot: number): void {
        const model = this.models[slot]!;
        const n = samples.length;
        const shared = this.shared[slot]!;
        const wasted = shared === 0 ? 0 : 31 - Math.clz32(shared & -shared);
        const maxParam = sampleBits > 17 ? MAX_RICE2_PARAM : MAX_RICE_PARAM;
        const residuals = this.residuals[2 * slot + 1]!.subarray(0, n - model.order);
        if (!lpcResiduals(samples, model, residuals)) return;
        sumPartitions(residuals, n, model.order);
        this.lpcBits[slot] =
            8 +
            model.order * (sampleBits + LPC_PRECISION) +
            9 +
            estimateRice(n, model.order, maxParam, 2 ** wasted);
    }

    /**
     * Plans the assessed subframe of `samples`, `sampleBits` wide, in candidate `slot`. Trailing
     * zero bits every sample shares (a 16-bit source in 24-bit samples has eight) are shifted out
     * and flagged as wasted, so they cost a few header bits instead of a bit per sample; the
     * shifted samples are assessed again for their own predictors.
     */
    private code(samples: Int32Array, sampleBits: number, slot: number): CodedSubframe {
        const shared = this.shared[slot]!;
        const wasted = shared === 0 ? 0 : 31 - Math.clz32(shared & -shared);
        let source = samples;
        if (wasted > 0) {
            source = this.shifted[slot]!.subarray(0, samples.length);
            for (let i = 0; i < samples.length; i++) source[i] = samples[i]! >> wasted;
            this.assess(source, sampleBits - wasted, slot);
        }
        const bits = sampleBits - wasted;
        const plan = planSubframe(
            source,
            bits,
            this.costs,
            slot * 5,
            this.models[slot] ?? null,
            this.lpcBits[slot]! <= this.fixedBits[slot]!,
            this.residuals[2 * slot]!,
            this.residuals[2 * slot + 1]!,
        );
        return { samples: source, plan, sampleBits: bits, wasted };
    }

    /**
     * Feeds `md5` the samples of the last encoded block as the stream's MD5 covers them:
     * interleaved, little-endian. 16-bit mono and stereo go as 32-bit words (a stereo frame, or two
     * mono samples), the rest as bytes.
     */
    hash(md5: Md5, blockSize: number): void {
        const channels = this.channels;
        if (this.depth === 16 && channels <= 2) {
            const words = this.md5Words;
            const first = this.quantized[0]!;
            let count = blockSize;
            if (channels === 2) {
                const second = this.quantized[1]!;
                for (let frame = 0; frame < blockSize; frame++)
                    words[frame] = (first[frame]! & 0xffff) | (second[frame]! << 16);
            } else {
                count = blockSize >> 1;
                for (let i = 0; i < count; i++)
                    words[i] = (first[2 * i]! & 0xffff) | (first[2 * i + 1]! << 16);
            }
            md5.updateWords(words, count);
            if (channels === 1 && blockSize & 1) {
                const last = first[blockSize - 1]!;
                md5.update(new Uint8Array([last & 0xff, (last >> 8) & 0xff]));
            }
            return;
        }
        const out = this.md5Bytes;
        const width = this.depth / 8;
        const stride = channels * width;
        for (let channel = 0; channel < channels; channel++) {
            const block = this.quantized[channel]!;
            for (let frame = 0, at = channel * width; frame < blockSize; frame++, at += stride) {
                const sample = block[frame]!;
                out[at] = sample;
                out[at + 1] = sample >> 8;
                if (width === 3) out[at + 2] = sample >> 16;
            }
        }
        md5.update(out.subarray(0, blockSize * stride));
    }

    /** Quantizes `count` frames of each plane from frame `from` into the block at frame `at`. */
    takePlanar(planes: readonly Float32Array[], from: number, count: number, at: number): void {
        const scale = 2 ** (this.depth - 1);
        for (let channel = 0; channel < this.channels; channel++) {
            const plane = planes[channel]!;
            const block = this.quantized[channel]!;
            for (let i = 0; i < count; i++) block[at + i] = quantizePcm(plane[from + i]!, scale);
        }
    }

    /** Encodes the first `blockSize` frames of the block as frame `frameIndex`. */
    encode(blockSize: number, frameIndex: number): Uint8Array<ArrayBuffer> {
        const blocks: Int32Array[] = [];
        for (let channel = 0; channel < this.channels; channel++) {
            blocks.push(this.quantized[channel]!.subarray(0, blockSize));
        }
        const depth = this.depth;

        let channelAssignment = this.channels - 1;
        let coded: CodedSubframe[];
        if (this.channels === 2) {
            const left = blocks[0]!;
            const right = blocks[1]!;
            const middle = this.mid.subarray(0, blockSize);
            const difference = this.side.subarray(0, blockSize);
            for (let frame = 0; frame < blockSize; frame++) {
                difference[frame] = left[frame]! - right[frame]!;
                middle[frame] = (left[frame]! + right[frame]!) >> 1;
            }
            const candidates = [left, right, middle, difference];
            const widths = [depth, depth, depth, depth + 1];
            const estimates = candidates.map((samples, slot) =>
                this.assess(samples, widths[slot]!, slot),
            );
            let mode: (typeof STEREO_MODES)[number] = STEREO_MODES[0];
            for (const candidate of STEREO_MODES) {
                const size = estimates[candidate[1]]! + estimates[candidate[2]]!;
                if (size < estimates[mode[1]]! + estimates[mode[2]]!) mode = candidate;
            }
            channelAssignment = mode[0];
            coded = [mode[1], mode[2]].map(slot =>
                this.code(candidates[slot]!, widths[slot]!, slot),
            );
        } else
            coded = blocks.map((block, channel) => {
                this.assess(block, depth, channel);
                return this.code(block, depth, channel);
            });

        const frame = this.frame;
        frame.reset();
        frame.write(0b11111111111110, 14);
        frame.write(0, 1);
        frame.write(0, 1);
        const partialBlock = blockSize !== BLOCK_SIZE;
        frame.write(partialBlock ? 7 : 12, 4);
        const rate = sampleRateCode(this.sampleRate);
        frame.write(rate.code, 4);
        frame.write(channelAssignment, 4);

        // Sample size: 0b100 for 16 bits, 0b110 for 24.
        frame.write(depth === 24 ? 6 : 4, 3);
        frame.write(0, 1);
        writeUtf8Number(frame, frameIndex);
        if (partialBlock) frame.write(blockSize - 1, 16);
        if (rate.tail === 'khz8') frame.write(rate.value!, 8);
        else if (rate.tail === 'hz16' || rate.tail === 'tensHz16') {
            frame.write(rate.value!, 16);
        }
        frame.write(crc8(frame.bytes()), 8);

        for (const subframe of coded)
            writeSubframe(
                frame,
                subframe.samples,
                subframe.plan,
                subframe.sampleBits,
                subframe.wasted,
            );
        frame.alignByte();
        frame.write(flacCrc16(frame.bytes()), 16);
        return frame.bytes().slice();
    }
}

/**
 * Incremental FLAC encoder: the PCM it is given is quantized straight into the block being filled,
 * which is encoded once full, so it holds less than one codec block between calls.
 */
export class StreamingFlacEncoder {
    private readonly core: FlacFrameCore;
    private readonly md5 = new Md5();
    /** Frames of the block being filled, and the most it held between calls. */
    private filled = 0;
    private peakFilled = 0;
    private readonly depth: 16 | 24;
    private readonly encodedFrames: Uint8Array<ArrayBuffer>[] | null;
    private readonly expectedCodecFrames: number | null;
    private totalInputFrames = 0;
    private frameIndex = 0;
    private minFrameSize = Number.POSITIVE_INFINITY;
    private maxFrameSize = 0;
    private sealed = false;

    constructor(
        readonly sampleRate: number,
        readonly channels: number,
        private readonly options: StreamingFlacEncodeOptions = {},
    ) {
        if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
            throw new EncodeError(`encodeFlac: unsupported channel count ${channels}`);
        }
        if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 655350) {
            throw new EncodeError(`encodeFlac: unsupported sample rate ${sampleRate}`);
        }

        sampleRateCode(sampleRate);
        if (
            options.expectedInputFrames !== undefined &&
            (!Number.isSafeInteger(options.expectedInputFrames) ||
                options.expectedInputFrames < 0 ||
                options.expectedInputFrames > MAX_TOTAL_SAMPLES)
        ) {
            throw new EncodeError('encodeFlac: expectedInputFrames must fit in 36 bits');
        }
        this.depth = options.bitsPerSample ?? 16;
        if (this.depth !== 16 && this.depth !== 24)
            throw new EncodeError(`encodeFlac: unsupported sample depth ${this.depth}`);
        this.core = new FlacFrameCore(sampleRate, channels, this.depth);
        this.encodedFrames = options.collectFrames === false ? null : [];
        this.expectedCodecFrames =
            options.expectedInputFrames === undefined
                ? null
                : Math.ceil(Math.max(0, options.expectedInputFrames) / BLOCK_SIZE);
    }

    get framesReceived(): number {
        return this.totalInputFrames;
    }
    get framesProduced(): number {
        return this.frameIndex;
    }
    get peakBufferedFrames(): number {
        return this.peakFilled;
    }

    pushPlanar(planes: readonly Float32Array[]): void {
        this.assertOpen();
        if (planes.length !== this.channels) {
            throw new EncodeError(`FLAC expected ${this.channels} channels, got ${planes.length}`);
        }

        const frames = planes[0]?.length ?? 0;
        for (let channel = 1; channel < planes.length; channel++) {
            if (planes[channel]!.length !== frames) {
                throw new EncodeError('FLAC PCM channel planes have different lengths');
            }
        }

        if (frames === 0) return;
        this.reserveInputFrames(frames);
        for (let start = 0; start < frames;) {
            const count = Math.min(BLOCK_SIZE - this.filled, frames - start);
            this.core.takePlanar(planes, start, count, this.filled);
            this.advance(count);
            start += count;
        }
    }

    /** Reserves the complete call atomically before any MD5/frame work starts. */
    private reserveInputFrames(frames: number): void {
        if (frames > MAX_TOTAL_SAMPLES - this.totalInputFrames) {
            throw new EncodeError('encodeFlac: input exceeds the 36-bit FLAC sample count');
        }
        this.totalInputFrames += frames;
    }

    /** Counts `count` more frames into the block and encodes it once full. */
    private advance(count: number): void {
        this.filled += count;
        if (this.filled < BLOCK_SIZE) {
            this.peakFilled = Math.max(this.peakFilled, this.filled);
            return;
        }
        this.emit(BLOCK_SIZE);
        this.filled = 0;
    }

    finish(): Uint8Array<ArrayBuffer> {
        return concatBytes(this.finishParts());
    }

    /** Finalizes statistics/MD5 and returns the 42-byte fLaC+STREAMINFO header. */
    finishHeader(): Uint8Array<ArrayBuffer> {
        this.assertOpen();
        this.sealed = true;
        if (this.totalInputFrames === 0) throw new EncodeError('encodeFlac: empty input');
        if (this.filled > 0) {
            this.emit(this.filled);
            this.filled = 0;
        }
        return this.buildHeader();
    }

    private finishParts(): Uint8Array<ArrayBuffer>[] {
        const header = this.finishHeader();
        return [header, ...(this.encodedFrames ?? [])];
    }

    private assertOpen(): void {
        if (this.sealed) throw new EncodeError('FLAC encoder received PCM after finish');
        throwIfAborted(this.options.signal);
    }

    private emit(blockSize: number): void {
        const frame = this.core.encode(blockSize, this.frameIndex);
        this.core.hash(this.md5, blockSize);
        this.encodedFrames?.push(frame);
        this.options.onFrame?.(frame, this.frameIndex);
        this.frameIndex++;
        this.minFrameSize = Math.min(this.minFrameSize, frame.length);
        this.maxFrameSize = Math.max(this.maxFrameSize, frame.length);
        this.options.onProgress?.(this.frameIndex, this.expectedCodecFrames ?? this.frameIndex);
    }

    private buildHeader(): Uint8Array<ArrayBuffer> {
        return buildFlacStreamHeader({
            minBlockSize: BLOCK_SIZE,
            maxBlockSize: BLOCK_SIZE,
            minFrameSize: this.minFrameSize,
            maxFrameSize: this.maxFrameSize,
            sampleRate: this.sampleRate,
            channels: this.channels,
            bitsPerSample: this.depth,
            totalSamples: this.totalInputFrames,
            md5: this.md5.digest(),
        });
    }
}
