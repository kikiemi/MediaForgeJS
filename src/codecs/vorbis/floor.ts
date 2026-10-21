import { DecodeError } from '../../core/errors/errors';
import { ilog, type VorbisBits } from './bits';
import type { VorbisCodebook } from './codebook';

/**
 * Floor curve decoders of Vorbis I sections 6 and 7; `read` consumes a channel's floor data,
 * `render` applies it.
 */
export interface VorbisFloor {
    /** True when the floor is present; false means the channel is silent (or the packet ended). */
    read(bits: VorbisBits, channel: number): boolean;
    /** Multiplies the `blockSize / 2` residue values by the curve read for `channel`. */
    render(out: Float32Array, blockSize: number, channel: number): void;
}

function invalid(message: string): never {
    throw new DecodeError(`Vorbis floor is invalid: ${message}`);
}

/**
 * 10^((i - 255) * 7 / 256): 256 amplitude steps of the floor 1 dB scale (Vorbis I section 7.2.3).
 */
const FLOOR1_FROM_DB = new Float32Array(256);
for (let i = 0; i < 256; i++) FLOOR1_FROM_DB[i] = 10 ** (((i - 255) * 7) / 256);

function toBark(n: number): number {
    return 13.1 * Math.atan(0.00074 * n) + 2.24 * Math.atan(n * n * 1.85e-8) + 1e-4 * n;
}

/** Floor 0 (Vorbis I section 6): LSP coefficients rendered on a Bark-mapped curve. */
export class VorbisFloor0 implements VorbisFloor {
    private readonly order: number;
    private readonly rate: number;
    private readonly barkMap: number;
    private readonly ampBits: number;
    private readonly ampDb: number;
    private readonly books: VorbisCodebook[] = [];
    private readonly lsp: Float32Array[] = [];
    private readonly amp: Float32Array;
    private readonly maps = new Map<number, Int32Array>();

    constructor(bits: VorbisBits, books: readonly VorbisCodebook[], channels: number) {
        this.order = bits.read(8);
        this.rate = bits.read(16);
        this.barkMap = bits.read(16);
        this.ampBits = bits.read(6);
        this.ampDb = bits.read(8);
        const count = bits.read(4) + 1;
        if (this.order < 1 || this.rate < 1 || this.barkMap < 1 || count < 1)
            invalid('floor 0 parameters');
        for (let j = 0; j < count; j++) {
            const book = books[bits.read(8)];
            if (!book || book.mapType === 0 || book.dim < 1) invalid('floor 0 codebook');
            this.books.push(book);
        }
        const maxDim = Math.max(...this.books.map(book => book.dim));
        for (let c = 0; c < channels; c++) this.lsp.push(new Float32Array(this.order + maxDim + 1));
        this.amp = new Float32Array(channels);
    }

    private map(blockSize: number): Int32Array {
        let map = this.maps.get(blockSize);
        if (map) return map;
        const n = blockSize >> 1;
        map = new Int32Array(n + 1);
        const scale = this.barkMap / toBark(this.rate / 2);
        for (let j = 0; j < n; j++) {
            map[j] = Math.min(
                this.barkMap - 1,
                Math.floor(toBark(((this.rate / 2) * j) / n) * scale),
            );
        }
        map[n] = -1;
        this.maps.set(blockSize, map);
        return map;
    }

    read(bits: VorbisBits, channel: number): boolean {
        const raw = bits.read(this.ampBits);
        if (raw <= 0) return false;
        const amp = (raw / ((1 << this.ampBits) - 1)) * this.ampDb;
        const bookIndex = bits.read(ilog(this.books.length));
        if (bookIndex < 0 || bookIndex >= this.books.length) return false;
        const book = this.books[bookIndex]!;
        const lsp = this.lsp[channel]!;
        const m = this.order;
        if (!book.decodeVSet(lsp, bits, m)) return false;
        let last = 0;
        for (let j = 0; j < m;) {
            for (let k = 0; j < m && k < book.dim; k++, j++) lsp[j]! += last;
            last = lsp[j - 1]!;
        }
        this.amp[channel] = amp;
        return true;
    }

    render(out: Float32Array, blockSize: number, channel: number): void {
        const map = this.map(blockSize);
        const n = blockSize >> 1;
        const m = this.order;
        const lsp = this.lsp[channel]!;
        const amp = this.amp[channel]!;
        const wdel = Math.PI / this.barkMap;
        for (let i = 0; i < m; i++) lsp[i] = 2 * Math.cos(lsp[i]!);
        let i = 0;
        while (i < n) {
            const k = map[i]!;
            let p = 0.5;
            let q = 0.5;
            const w = 2 * Math.cos(wdel * k);
            let j = 1;
            for (; j < m; j += 2) {
                q *= w - lsp[j - 1]!;
                p *= w - lsp[j]!;
            }
            if (j === m) {
                q *= w - lsp[j - 1]!;
                p *= p * (4 - w * w);
                q *= q;
            } else {
                p *= p * (2 - w);
                q *= q * (2 + w);
            }
            const curve = Math.exp((amp / Math.sqrt(p + q) - this.ampDb) * 0.11512925);
            out[i]! *= curve;
            while (map[++i] === k) out[i]! *= curve;
        }
    }
}

/** Floor 1 (Vorbis I section 7): piecewise-linear dB curve over sorted x positions. */
export class VorbisFloor1 implements VorbisFloor {
    private readonly partitionClass: Uint8Array;
    private readonly classDim: Uint8Array;
    private readonly classSubs: Uint8Array;
    private readonly classBook: (VorbisCodebook | null)[] = [];
    private readonly classSubBook: (VorbisCodebook | null)[][] = [];
    private readonly mult: number;
    private readonly postList: Int32Array;
    private readonly posts: number;
    private readonly forwardIndex: Int32Array;
    private readonly loNeighbor: Int32Array;
    private readonly hiNeighbor: Int32Array;
    private readonly quant: number;
    private readonly fits: Int32Array[] = [];

    constructor(bits: VorbisBits, books: readonly VorbisCodebook[], channels: number) {
        const partitions = bits.read(5);
        this.partitionClass = new Uint8Array(partitions);
        let maxClass = -1;
        for (let j = 0; j < partitions; j++) {
            const value = bits.read(4);
            if (value < 0) invalid('floor 1 partition class');
            this.partitionClass[j] = value;
            if (value > maxClass) maxClass = value;
        }
        this.classDim = new Uint8Array(maxClass + 1);
        this.classSubs = new Uint8Array(maxClass + 1);
        for (let j = 0; j <= maxClass; j++) {
            this.classDim[j] = bits.read(3) + 1;
            const subs = bits.read(2);
            if (subs < 0) invalid('floor 1 class');
            this.classSubs[j] = subs;
            let masterBook: VorbisCodebook | null = null;
            if (subs) {
                const index = bits.read(8);
                masterBook = books[index] ?? null;
                if (!masterBook) invalid('floor 1 class codebook');
            }
            this.classBook.push(masterBook);
            const subBooks: (VorbisCodebook | null)[] = [];
            for (let k = 0; k < 1 << subs; k++) {
                const index = bits.read(8) - 1;
                if (index < -1 || index >= books.length) invalid('floor 1 subclass codebook');
                subBooks.push(index >= 0 ? books[index]! : null);
            }
            this.classSubBook.push(subBooks);
        }
        this.mult = bits.read(2) + 1;
        const rangeBits = bits.read(4);
        if (rangeBits < 0) invalid('floor 1 range');
        let count = 0;
        for (let j = 0; j < partitions; j++) count += this.classDim[this.partitionClass[j]!]!;
        if (count > 63) invalid('floor 1 has more than 63 values');
        this.posts = count + 2;
        this.postList = new Int32Array(this.posts);
        this.postList[0] = 0;
        this.postList[1] = 1 << rangeBits;
        for (let k = 0; k < count; k++) {
            const value = bits.read(rangeBits);
            if (value < 0 || value >= 1 << rangeBits) invalid('floor 1 x value');
            this.postList[k + 2] = value;
        }
        const sorted = Array.from(this.postList.keys()).sort(
            (a, b) => this.postList[a]! - this.postList[b]!,
        );
        for (let j = 1; j < this.posts; j++)
            if (this.postList[sorted[j - 1]!] === this.postList[sorted[j]!])
                invalid('floor 1 repeats an x value');
        this.forwardIndex = Int32Array.from(sorted);
        this.quant = [256, 128, 86, 64][this.mult - 1]!;
        this.loNeighbor = new Int32Array(count);
        this.hiNeighbor = new Int32Array(count);
        for (let i = 0; i < count; i++) {
            let lo = 0;
            let hi = 1;
            let lx = 0;
            let hx = this.postList[1]!;
            const current = this.postList[i + 2]!;
            for (let j = 0; j < i + 2; j++) {
                const x = this.postList[j]!;
                if (x > lx && x < current) {
                    lo = j;
                    lx = x;
                }
                if (x < hx && x > current) {
                    hi = j;
                    hx = x;
                }
            }
            this.loNeighbor[i] = lo;
            this.hiNeighbor[i] = hi;
        }
        for (let c = 0; c < channels; c++) this.fits.push(new Int32Array(this.posts));
    }

    read(bits: VorbisBits, channel: number): boolean {
        if (bits.read(1) !== 1) return false;
        const fit = this.fits[channel]!;
        const bitsPerValue = ilog(this.quant - 1);
        fit[0] = bits.read(bitsPerValue);
        fit[1] = bits.read(bitsPerValue);
        let j = 2;
        for (let i = 0; i < this.partitionClass.length; i++) {
            const cls = this.partitionClass[i]!;
            const dim = this.classDim[cls]!;
            const subBits = this.classSubs[cls]!;
            const subMask = (1 << subBits) - 1;
            let cval = 0;
            if (subBits) {
                cval = this.classBook[cls]!.decode(bits);
                if (cval === -1) return false;
            }
            for (let k = 0; k < dim; k++) {
                const book = this.classSubBook[cls]![cval & subMask]!;
                cval >>= subBits;
                if (book) {
                    const value = book.decode(bits);
                    if (value === -1) return false;
                    fit[j + k] = value;
                } else fit[j + k] = 0;
            }
            j += dim;
        }
        for (let i = 2; i < this.posts; i++) {
            const lo = this.loNeighbor[i - 2]!;
            const hi = this.hiNeighbor[i - 2]!;
            const predicted = renderPoint(
                this.postList[lo]!,
                this.postList[hi]!,
                fit[lo]! & 0x7fff,
                fit[hi]! & 0x7fff,
                this.postList[i]!,
            );
            const hiRoom = this.quant - predicted;
            const loRoom = predicted;
            const room = (hiRoom < loRoom ? hiRoom : loRoom) << 1;
            let value = fit[i]!;
            if (value) {
                if (value >= room) value = hiRoom > loRoom ? value - loRoom : -1 - (value - hiRoom);
                else value = value & 1 ? -((value + 1) >> 1) : value >> 1;
                fit[i] = (value + predicted) & 0x7fff;
                fit[lo]! &= 0x7fff;
                fit[hi]! &= 0x7fff;
            } else fit[i] = predicted | 0x8000;
        }
        return true;
    }

    render(out: Float32Array, blockSize: number, channel: number): void {
        const n = blockSize >> 1;
        const fit = this.fits[channel]!;
        let hx = 0;
        let lx = 0;
        let ly = Math.min(255, Math.max(0, fit[0]! * this.mult));
        for (let j = 1; j < this.posts; j++) {
            const current = this.forwardIndex[j]!;
            let hy = fit[current]! & 0x7fff;
            if (hy !== fit[current]) continue;
            hx = this.postList[current]!;
            hy = Math.min(255, Math.max(0, hy * this.mult));
            renderLine(n, lx, hx, ly, hy, out);
            lx = hx;
            ly = hy;
        }
        for (let j = hx; j < n; j++) out[j]! *= FLOOR1_FROM_DB[ly]!;
    }
}

function renderPoint(x0: number, x1: number, y0: number, y1: number, x: number): number {
    const dy = y1 - y0;
    const adx = x1 - x0;
    const off = Math.trunc((Math.abs(dy) * (x - x0)) / adx);
    return dy < 0 ? y0 - off : y0 + off;
}

function renderLine(
    n: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    d: Float32Array,
): void {
    const dy = y1 - y0;
    const adx = x1 - x0;
    const base = Math.trunc(dy / adx);
    const sy = dy < 0 ? base - 1 : base + 1;
    const ady = Math.abs(dy) - Math.abs(base * adx);
    let x = x0;
    let y = y0;
    let err = 0;
    if (n > x1) n = x1;
    if (x < n) d[x]! *= FLOOR1_FROM_DB[y]!;
    while (++x < n) {
        err += ady;
        if (err >= adx) {
            err -= adx;
            y += sy;
        } else y += base;
        d[x]! *= FLOOR1_FROM_DB[y]!;
    }
}
