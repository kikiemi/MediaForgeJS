import { DecodeError } from '../../core/errors/errors';

const CODE_BOT = 1 << 23;
const SYM_MAX = 255;
const UINT_BITS = 8;
const TELL_CORRECTION = [35733, 38967, 42495, 46340, 50535, 55109, 60097, 65535];
const LAPLACE_NMIN = 16;

/** Bits needed to represent `value` (RFC 6716 EC_ILOG). */
export function ilog(value: number): number {
    return value === 0 ? 0 : 32 - Math.clz32(value);
}

/**
 * Range decoder of RFC 6716 section 4.1 over one frame's bytes: symbols from the front, raw bits
 * from the back. `init` rebinds the same instance to another frame without allocating.
 */
export class RangeDecoder {
    private buf: Uint8Array = new Uint8Array(0);
    private start = 0;
    /** Bytes of the frame; shrinks when redundancy is split off the end (`shrink`). */
    storage = 0;
    private offs = 0;
    private endOffs = 0;
    private endWindow = 0;
    private nendBits = 0;
    nbitsTotal = 0;
    rng = 0;
    private val = 0;
    private ext = 0;
    private rem = 0;
    error = false;

    init(buf: Uint8Array, start = 0, length = buf.length - start): void {
        this.buf = buf;
        this.start = start;
        this.storage = length;
        this.endOffs = 0;
        this.endWindow = 0;
        this.nendBits = 0;
        this.nbitsTotal = 9;
        this.offs = 0;
        this.rng = 128;
        this.rem = this.readByte();
        this.val = this.rng - 1 - (this.rem >> 1);
        this.error = false;
        this.normalize();
    }

    /** Drops `bytes` from the end of the frame (redundancy bytes are decoded separately). */
    shrink(bytes: number): void {
        this.storage -= bytes;
    }

    private readByte(): number {
        return this.offs < this.storage ? this.buf[this.start + this.offs++]! : 0;
    }

    private readByteFromEnd(): number {
        return this.endOffs < this.storage
            ? this.buf[this.start + this.storage - ++this.endOffs]!
            : 0;
    }

    private normalize(): void {
        while (this.rng <= CODE_BOT) {
            this.nbitsTotal += 8;
            this.rng *= 256;
            let sym = this.rem;
            this.rem = this.readByte();
            sym = ((sym << 8) | this.rem) >> 1;
            this.val = ((this.val << 8) | (SYM_MAX & ~sym)) >>> 0;
        }
    }

    decode(ft: number): number {
        this.ext = (this.rng / ft) >>> 0;
        const s = (this.val / this.ext) >>> 0;
        return ft - Math.min(s + 1, ft);
    }

    decodeBin(bits: number): number {
        this.ext = this.rng >>> bits;
        const s = (this.val / this.ext) >>> 0;
        return (1 << bits) - Math.min(s + 1, 1 << bits);
    }

    update(fl: number, fh: number, ft: number): void {
        const s = this.ext * (ft - fh);
        this.val -= s;
        this.rng = fl > 0 ? this.ext * (fh - fl) : this.rng - s;
        this.normalize();
    }

    decodeBitLogp(logp: number): number {
        const r = this.rng;
        const d = this.val;
        const s = r >>> logp;
        const ret = d < s ? 1 : 0;
        if (!ret) this.val = d - s;
        this.rng = ret ? s : r - s;
        this.normalize();
        return ret;
    }

    /**
     * Symbol of an inverse CDF table (8-bit precision unless ftb is given), starting at `offset`.
     */
    decodeIcdf(icdf: Uint8Array, offset = 0, ftb = 8): number {
        let s = this.rng;
        const d = this.val;
        const r = s >>> ftb;
        let ret = -1;
        let t: number;
        do {
            t = s;
            s = r * icdf[offset + ++ret]!;
        } while (d < s);
        this.val = d - s;
        this.rng = t - s;
        this.normalize();
        return ret;
    }

    decodeUint(ft: number): number {
        ft--;
        const ftb = ilog(ft);
        if (ftb > UINT_BITS) {
            const shift = ftb - UINT_BITS;
            const small = Math.floor(ft / 2 ** shift) + 1;
            const s = this.decode(small);
            this.update(s, s + 1, small);
            const t = s * 2 ** shift + this.decodeBits(shift);
            if (t <= ft) return t;
            this.error = true;
            return ft;
        }
        ft++;
        const s = this.decode(ft);
        this.update(s, s + 1, ft);
        return s;
    }

    /** Raw bits from the end of the frame, at most 25 at a time. */
    decodeBits(bits: number): number {
        let window = this.endWindow;
        let available = this.nendBits;
        if (available < bits) {
            do {
                window = (window | (this.readByteFromEnd() << available)) >>> 0;
                available += 8;
            } while (available <= 24);
        }
        const ret = window & ((1 << bits) - 1);
        window >>>= bits;
        available -= bits;
        this.endWindow = window;
        this.nendBits = available;
        this.nbitsTotal += bits;
        return ret;
    }

    tell(): number {
        return this.nbitsTotal - ilog(this.rng);
    }

    /** Bits consumed in 1/8 bit units. */
    tellFrac(): number {
        const nbits = this.nbitsTotal * 8;
        let l = ilog(this.rng);
        const r = this.rng >>> (l - 16);
        let b = (r >> 12) - 8;
        b += r > TELL_CORRECTION[b]! ? 1 : 0;
        l = (l << 3) + b;
        return nbits - l;
    }

    /** Laplace-distributed integer of CELT coarse energy (RFC 6716 section 4.3.2.1). */
    decodeLaplace(fs: number, decay: number): number {
        let val = 0;
        const fm = this.decodeBin(15);
        let fl = 0;
        if (fm >= fs) {
            val++;
            fl = fs;
            fs = ((32768 - 2 * LAPLACE_NMIN - fs) * (16384 - decay)) >> 15;
            fs += 1;
            while (fs > 1 && fm >= fl + 2 * fs) {
                fs *= 2;
                fl += fs;
                fs = ((fs - 2) * decay) >> 15;
                fs += 1;
                val++;
            }
            if (fs <= 1) {
                const di = (fm - fl) >> 1;
                val += di;
                fl += 2 * di;
            }
            if (fm < fl + fs) val = -val;
            else fl += fs;
        }
        this.update(fl, Math.min(fl + fs, 32768), 32768);
        return val;
    }

    /** Fails the frame when a decoder consumed past the end of the range coded data. */
    checkOverrun(bytes: number, what: string): void {
        if (this.tell() > bytes * 8)
            throw new DecodeError(`Opus ${what} frame overran its ${bytes} bytes`);
    }
}
