const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const tag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const values = Uint8Array.prototype.values;
function assertNumber(value) {
    if (typeof value !== 'number')
        throw new TypeError('value must be a number');
}
export class BinaryWriter {
    buf;
    view;
    pos = 0;
    constructor(initialCapacity = 4096) {
        if (!Number.isSafeInteger(initialCapacity) || initialCapacity < 0) {
            throw new RangeError('initialCapacity must be a non-negative safe integer');
        }
        this.buf = new Uint8Array(initialCapacity);
        this.view = new DataView(this.buf.buffer);
    }
    get size() {
        return this.pos;
    }
    ensureCapacity(needed) {
        if (!Number.isSafeInteger(needed) || needed < 0 || !Number.isSafeInteger(this.pos + needed)) {
            throw new RangeError('write size must be a non-negative safe integer');
        }
        if (this.pos + needed <= this.buf.length)
            return;
        let newSize = Math.max(1, this.buf.length * 2);
        while (newSize < this.pos + needed)
            newSize *= 2;
        const next = new Uint8Array(newSize);
        next.set(this.buf.subarray(0, this.pos));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }
    writeU8(v) {
        assertNumber(v);
        this.ensureCapacity(1);
        this.view.setUint8(this.pos, v & 0xff);
        this.pos += 1;
    }
    writeU16BE(v) {
        assertNumber(v);
        this.ensureCapacity(2);
        this.view.setUint16(this.pos, v & 0xffff, false);
        this.pos += 2;
    }
    writeU16LE(v) {
        assertNumber(v);
        this.ensureCapacity(2);
        this.view.setUint16(this.pos, v & 0xffff, true);
        this.pos += 2;
    }
    writeU32BE(v) {
        assertNumber(v);
        this.ensureCapacity(4);
        this.view.setUint32(this.pos, v >>> 0, false);
        this.pos += 4;
    }
    writeU32LE(v) {
        assertNumber(v);
        this.ensureCapacity(4);
        this.view.setUint32(this.pos, v >>> 0, true);
        this.pos += 4;
    }
    writeBytes(data) {
        if (tag.call(data) !== 'Uint8Array')
            throw new TypeError('data must be a Uint8Array');
        values.call(data);
        const count = byteLength.call(data);
        this.ensureCapacity(count);
        this.buf.set(data, this.pos);
        this.pos += count;
    }
    writeASCII(str) {
        if (typeof str !== 'string')
            throw new TypeError('str must be a string');
        this.ensureCapacity(str.length);
        for (let i = 0; i < str.length; i++)
            this.buf[this.pos++] = str.charCodeAt(i);
    }
    writeZeros(count) {
        this.ensureCapacity(count);
        this.buf.fill(0, this.pos, this.pos + count);
        this.pos += count;
    }
    toUint8Array() {
        return this.buf.slice(0, this.pos);
    }
}
export class BitSink {
    buf = new Uint8Array(new ArrayBuffer(1 << 12));
    len = 0;
    acc = 0;
    accBits = 0;
    writeBits(value, bits) {
        assertNumber(value);
        this.ensureCapacity(bits);
        while (bits > 0) {
            const take = bits > 24 ? 24 : bits;
            const leading = bits > 24
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
    writeUnary(value) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new RangeError('unary length must be a non-negative safe integer');
        }
        this.ensureCapacity(value + 1);
        if (this.accBits > 0) {
            const take = Math.min(value, 8 - this.accBits);
            this.acc <<= take;
            this.accBits += take;
            value -= take;
            if (this.accBits === 8) {
                this.push(this.acc);
                this.acc = 0;
                this.accBits = 0;
            }
        }
        const count = Math.floor(value / 8);
        this.buf.fill(0, this.len, this.len + count);
        this.len += count;
        const remaining = value % 8;
        this.acc <<= remaining;
        this.accBits += remaining;
        this.writeBits(1, 1);
    }
    alignByte() {
        if (this.accBits > 0)
            this.writeBits(0, 8 - this.accBits);
    }
    get bytePosition() {
        return this.len;
    }
    bytes() {
        return this.buf.subarray(0, this.len);
    }
    toUint8Array() {
        return this.buf.slice(0, this.len);
    }
    ensureCapacity(bits) {
        if (!Number.isSafeInteger(bits) || bits < 0 || !Number.isSafeInteger(this.accBits + bits)) {
            throw new RangeError('bit count must be a non-negative safe integer');
        }
        const required = this.len + Math.ceil((this.accBits + bits) / 8);
        if (!Number.isSafeInteger(required))
            throw new RangeError('bit output is too large');
        if (this.buf.byteLength === 0)
            throw new TypeError('bit storage is detached');
        if (required > this.buf.length) {
            const capacity = Math.max(required, this.buf.length * 2);
            const next = new Uint8Array(new ArrayBuffer(capacity));
            next.set(this.buf.subarray(0, this.len));
            this.buf = next;
        }
    }
    push(byte) {
        this.buf[this.len++] = byte;
    }
}
