/**
 * Unsigned integer fields of a byte array, big-endian (be) or little-endian (le). Bytes past the
 * end read as zero, so callers check the length first where a short field is an error.
 */

export function u16be(bytes: Uint8Array, at: number): number {
    return (bytes[at]! << 8) | bytes[at + 1]!;
}

export function u32be(bytes: Uint8Array, at: number): number {
    return (
        ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
    );
}

export function u16le(bytes: Uint8Array, at: number): number {
    return bytes[at]! | (bytes[at + 1]! << 8);
}

export function u24le(bytes: Uint8Array, at: number): number {
    return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

export function u32le(bytes: Uint8Array, at: number): number {
    return (
        (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
    );
}

/** The four Latin-1 characters at `at` of `bytes`: a FourCC, a chunk ID or a box type. */
export function fourcc(bytes: Uint8Array, at = 0): string {
    return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** A view of exactly the bytes of `bytes`, for the fields of other widths and types. */
export function dataView(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
