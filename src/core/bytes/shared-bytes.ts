import { MediaForgeError } from '../errors/errors';

/** Bytes smaller than half of this many share buffers of this size. */
const SHARED_BYTES = 16 * 1024;

let shared = new Uint8Array(0);
let used = 0;

/**
 * Bytes for a packet the library's own readers and decoders keep, or a PES a demuxer assembles. A
 * buffer of its own for each costs an allocation that outweighs copying a small packet, so bytes
 * below half of SHARED_BYTES are laid one after another in a shared buffer of that size, as Node's
 * Buffer pool shares its slabs; larger ones get buffers of their own. Shared bytes are never handed
 * out twice. They never reach user code: packets that leave the library get buffers of their own
 * (MediaFile's packetFrom, `exclusive`).
 */
export function packetBytes(length: number): Uint8Array {
    if (length >= SHARED_BYTES >>> 1) return new Uint8Array(length);
    let at = used;
    if (at + length > shared.length) {
        shared = new Uint8Array(SHARED_BYTES);
        at = 0;
    }
    used = at + length;
    return shared.subarray(at, at + length);
}

/** A copy of `bytes` for the library to keep (packetBytes). */
export function copiedBytes(bytes: Uint8Array): Uint8Array {
    let copy: Uint8Array;
    try {
        copy = packetBytes(bytes.length);
    } catch {
        throw new MediaForgeError('could not allocate output bytes', 'OOM');
    }
    copy.set(bytes);
    return copy;
}

/**
 * `bytes` to keep as long as an index: bytes of a shared buffer are copied out, so keeping them
 * does not keep the whole buffer. A shared buffer is told by its size, not by a registry, which
 * would cost an entry per buffer; part of another buffer of that size is copied too, to no harm.
 * Pooled buffers, whose views a copy passes on as they are, are larger.
 */
export function ownBytes(bytes: Uint8Array): Uint8Array {
    return bytes.buffer.byteLength === SHARED_BYTES && bytes.byteLength < SHARED_BYTES
        ? bytes.slice()
        : bytes;
}
