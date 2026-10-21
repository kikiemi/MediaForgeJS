import { MediaForgeError } from '../../core/errors/errors';

// The elements of EBML as the Matroska writer and the Matroska metadata it writes lay them out:
// IDs and sizes in their shortest widths, unsigned integers in as few bytes as hold them.

const encoder = new TextEncoder();

export function ebmlIdBytes(id: number): number {
    if (id > 0xffffff) return 4;
    if (id > 0xffff) return 3;
    if (id > 0xff) return 2;
    return 1;
}

export function writeEbmlId(out: Uint8Array, pos: number, id: number): number {
    if (id > 0xffffff) {
        out[pos++] = (id >>> 24) & 0xff;
        out[pos++] = (id >>> 16) & 0xff;
        out[pos++] = (id >>> 8) & 0xff;
        out[pos++] = id & 0xff;
        return pos;
    }

    if (id > 0xffff) {
        out[pos++] = (id >>> 16) & 0xff;
        out[pos++] = (id >>> 8) & 0xff;
        out[pos++] = id & 0xff;
        return pos;
    }

    if (id > 0xff) {
        out[pos++] = (id >>> 8) & 0xff;
        out[pos++] = id & 0xff;
        return pos;
    }

    out[pos++] = id & 0xff;
    return pos;
}

export function unsignedBytes(value: number): number {
    let remaining = Math.max(0, Math.floor(value));
    let bytes = 1;
    while (remaining > 0xff && bytes < 8) {
        remaining = Math.floor(remaining / 256);
        bytes++;
    }
    return bytes;
}

export function writeUnsigned(out: Uint8Array, pos: number, value: number, bytes: number): number {
    let remaining = Math.max(0, Math.floor(value));
    for (let i = bytes - 1; i >= 0; i--) {
        out[pos + i] = remaining % 256;
        remaining = Math.floor(remaining / 256);
    }
    return pos + bytes;
}

/** The largest size each EBML size width from 1 to 8 bytes holds, computed once. */
const EBML_SIZE_LIMITS = Array.from({ length: 8 }, (_, index) => 2 ** (7 * (index + 1)) - 2);

/**
 * Shortest EBML size width; sizes are byte counts below 2^53, so the all-ones reserved pattern is
 * excluded per width.
 */
export function ebmlSizeBytes(size: number): number {
    const value = Math.max(0, Math.floor(size));
    for (let bytes = 1; bytes <= 8; bytes++)
        if (!(value > EBML_SIZE_LIMITS[bytes - 1]!)) return bytes;
    throw new MediaForgeError(`EBML size ${size} is too large`, 'MUX');
}

export function writeEbmlSize(out: Uint8Array, pos: number, size: number): number {
    const bytes = ebmlSizeBytes(size);
    let remaining = Math.max(0, Math.floor(size));
    for (let i = bytes - 1; i >= 1; i--) {
        out[pos + i] = remaining % 256;
        remaining = Math.floor(remaining / 256);
    }
    out[pos] = remaining | (0x80 >> (bytes - 1));
    return pos + bytes;
}

/** An element of `id` whose data is `payloads` one after another. */
export function ebmlElement(id: number, ...payloads: readonly Uint8Array[]): Uint8Array {
    const size = payloads.reduce((total, payload) => total + payload.length, 0);
    const out = new Uint8Array(ebmlIdBytes(id) + ebmlSizeBytes(size) + size);
    let pos = writeEbmlSize(out, writeEbmlId(out, 0, id), size);
    for (const payload of payloads) {
        out.set(payload, pos);
        pos += payload.length;
    }
    return out;
}

export function ebmlSint(id: number, value: number): Uint8Array {
    const rounded = Math.round(value);
    if (!Number.isSafeInteger(rounded)) {
        throw new MediaForgeError(`EBML element 0x${id.toString(16)} is not a safe integer`, 'MUX');
    }

    const signed = BigInt(rounded);
    let bytes = 1;
    for (; bytes < 8; bytes++) {
        const bits = BigInt(bytes * 8 - 1);
        const min = -(1n << bits);
        const max = (1n << bits) - 1n;
        if (signed >= min && signed <= max) break;
    }

    const bits = BigInt(bytes * 8);
    let encoded = signed < 0 ? (1n << bits) + signed : signed;
    const payload = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--) {
        payload[i] = Number(encoded & 0xffn);
        encoded >>= 8n;
    }
    return ebmlElement(id, payload);
}

export function ebmlUint(id: number, value: number): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new MediaForgeError(
            `EBML element 0x${id.toString(16)} must be a non-negative safe integer`,
            'MUX',
        );
    }
    const bytes = unsignedBytes(value);
    const payload = new Uint8Array(bytes);
    writeUnsigned(payload, 0, value, bytes);
    return ebmlElement(id, payload);
}

export function ebmlUid(value: bigint): Uint8Array {
    let width = 1;
    while (value >= 1n << BigInt(width * 8)) width++;
    const bytes = new Uint8Array(width);
    for (let pos = width - 1; pos >= 0; pos--) {
        bytes[pos] = Number(value & 255n);
        value >>= 8n;
    }
    return ebmlElement(0x73c5, bytes);
}

export function ebmlFloat(id: number, value: number): Uint8Array {
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setFloat64(0, value, false);
    return ebmlElement(id, payload);
}

export function ebmlString(id: number, value: string): Uint8Array {
    return ebmlElement(id, encoder.encode(value));
}

export function ebmlBinary(id: number, payload: Uint8Array): Uint8Array {
    return ebmlElement(id, payload);
}

export function ebmlUintFixed8(id: number, value: number): Uint8Array {
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setBigUint64(0, BigInt(value), false);
    return ebmlElement(id, payload);
}
