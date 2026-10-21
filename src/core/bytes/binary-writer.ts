import { MediaForgeError } from '../errors/errors';
import { attachedLength } from './typed-array';

/** A writer's argument that is not a number, string or size it can write. */
function invalid(message: string): never {
    throw new MediaForgeError(message, 'INPUT');
}

function assertNumber(value: number): void {
    if (typeof value !== 'number') invalid('value must be a number');
}

export class BinaryWriter {
    private buf: Uint8Array;
    private view: DataView;
    private pos = 0;

    constructor(initialCapacity = 4096) {
        if (!Number.isSafeInteger(initialCapacity) || initialCapacity < 0) {
            invalid('initialCapacity must be a non-negative safe integer');
        }
        this.buf = new Uint8Array(initialCapacity);
        this.view = new DataView(this.buf.buffer);
    }

    /** Bytes written so far. */
    get size(): number {
        return this.pos;
    }

    private ensureCapacity(needed: number): void {
        if (
            !Number.isSafeInteger(needed) ||
            needed < 0 ||
            !Number.isSafeInteger(this.pos + needed)
        ) {
            invalid('write size must be a non-negative safe integer');
        }
        if (this.pos + needed <= this.buf.length) return;
        let newSize = Math.max(1, this.buf.length * 2);
        while (newSize < this.pos + needed) newSize *= 2;
        const next = new Uint8Array(newSize);
        next.set(this.buf.subarray(0, this.pos));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    writeU8(v: number): void {
        assertNumber(v);
        this.ensureCapacity(1);
        this.view.setUint8(this.pos, v & 0xff);
        this.pos += 1;
    }

    writeU16LE(v: number): void {
        assertNumber(v);
        this.ensureCapacity(2);
        this.view.setUint16(this.pos, v & 0xffff, true);
        this.pos += 2;
    }

    writeU32LE(v: number): void {
        assertNumber(v);
        this.ensureCapacity(4);
        this.view.setUint32(this.pos, v >>> 0, true);
        this.pos += 4;
    }

    writeBytes(data: Uint8Array): void {
        const count = attachedLength(data);
        this.ensureCapacity(count);
        this.buf.set(data, this.pos);
        this.pos += count;
    }

    /** Appends the string's ASCII bytes. */
    writeASCII(str: string): void {
        if (typeof str !== 'string') invalid('str must be a string');
        this.ensureCapacity(str.length);
        for (let i = 0; i < str.length; i++) this.buf[this.pos++] = str.charCodeAt(i);
    }

    writeZeros(count: number): void {
        this.ensureCapacity(count);
        this.buf.fill(0, this.pos, this.pos + count);
        this.pos += count;
    }

    /** Returns an independent copy of the written bytes. */
    toUint8Array(): Uint8Array {
        return this.buf.slice(0, this.pos);
    }
}

export class BitSink {
    private buf = new Uint8Array(new ArrayBuffer(1 << 12));
    private len = 0;
    private acc = 0;
    private accBits = 0;

    writeBits(value: number, bits: number): void {
        assertNumber(value);
        this.ensureCapacity(bits);
        while (bits > 0) {
            const take = bits > 24 ? 24 : bits;
            const leading =
                bits > 24
                    ? bits - take >= 1024
                        ? Number.isFinite(value) && value < 0
                            ? -1
                            : 0
                        : Math.floor(value / 2 ** (bits - take))
                    : value;
            const chunk = leading & ((1 << take) - 1);
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

    alignByte(): void {
        if (this.accBits > 0) this.writeBits(0, 8 - this.accBits);
    }

    toUint8Array(): Uint8Array<ArrayBuffer> {
        return this.buf.slice(0, this.len);
    }

    private ensureCapacity(bits: number): void {
        if (!Number.isSafeInteger(bits) || bits < 0 || !Number.isSafeInteger(this.accBits + bits)) {
            invalid('bit count must be a non-negative safe integer');
        }
        const required = this.len + Math.ceil((this.accBits + bits) / 8);
        if (!Number.isSafeInteger(required))
            throw new MediaForgeError('bit output is too large', 'OOM');
        if (this.buf.byteLength === 0) invalid('bit storage is detached');
        if (required > this.buf.length) {
            const capacity = Math.max(required, this.buf.length * 2);
            const next = new Uint8Array(new ArrayBuffer(capacity));
            next.set(this.buf.subarray(0, this.len));
            this.buf = next;
        }
    }

    private push(byte: number): void {
        this.buf[this.len++] = byte;
    }
}
