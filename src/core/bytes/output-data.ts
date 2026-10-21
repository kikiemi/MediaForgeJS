import { MediaForgeError } from '../errors/errors';
import { holdBytes } from './byte-holds';
import { copiedBytes } from './shared-bytes';
import {
    attachedLength,
    typedArrayBuffer as bufferOf,
    typedArrayByteLength as byteLength,
    typedArrayOffset as byteOffsetOf,
} from './typed-array';

export function outputByteLength(data: Uint8Array): number {
    try {
        return attachedLength(data);
    } catch {
        throw new MediaForgeError('output data must be an attached Uint8Array', 'IO');
    }
}

const handedOff = new WeakSet<Uint8Array>();

/**
 * Marks bytes a writer allocated for one sink write and never reads or changes afterwards, so the
 * sink may keep their buffer instead of copying it. Returns the same bytes.
 */
export function handOffOutput<T extends Uint8Array>(bytes: T): T {
    handedOff.add(bytes);
    return bytes;
}

/**
 * The whole buffer behind handed-off bytes, at most once per hand-off; undefined when the sink must
 * copy.
 */
export function adoptOutputBuffer(data: Uint8Array): ArrayBuffer | undefined {
    if (!handedOff.delete(data)) return undefined;
    const buffer = bufferOf.call(data) as ArrayBufferLike;
    if (!(buffer instanceof ArrayBuffer) || byteOffsetOf.call(data) !== 0) return undefined;
    return byteLength.call(data) === buffer.byteLength ? buffer : undefined;
}

/**
 * The buffer of the packet a copy hands to its writer: retained source pages, chunks of a stream
 * and fresh reads, whose bytes no one rewrites while the writer holds views of them (a pooled chunk
 * is refilled only once the holds taken on it are released). A writer asks about a packet's bytes
 * as it takes the packet, before the next one is marked, so one slot serves where a weak registry
 * would cost an entry per packet.
 */
let unchangingBuffer: ArrayBufferLike | undefined;

/** Below this size a copy costs less than the bookkeeping that avoids it. */
const UNCHANGING_MIN_BYTES = 256;

/**
 * Marks the bytes of the packet handed to a writer next as unchanging, until another packet is
 * marked.
 */
export function markUnchangingBytes(bytes: Uint8Array): void {
    if (bytes.length >= UNCHANGING_MIN_BYTES)
        unchangingBuffer = bufferOf.call(bytes) as ArrayBufferLike;
}

/** Ends a run of marked packets, so the slot holds none of their bytes. */
export function forgetUnchangingBytes(): void {
    unchangingBuffer = undefined;
}

/**
 * Bytes a writer may hold for a bounded time: the marked packet's bytes as they are, with a hold on
 * a pooled buffer behind them, anything else as a copy (small ones share buffers, packetBytes). The
 * writer passes them to releaseBytes() once it is done with them.
 */
export function retainedBytes(bytes: Uint8Array): Uint8Array {
    if (bytes.length < UNCHANGING_MIN_BYTES || bufferOf.call(bytes) !== unchangingBuffer)
        return copiedBytes(bytes);
    holdBytes(bytes);
    return bytes;
}

export function copyOutputBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
    try {
        return new Uint8Array(data);
    } catch {
        throw new MediaForgeError('could not allocate output bytes', 'OOM');
    }
}

export function outputByteLimit(value: number | undefined): number {
    if (value === undefined) return Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new MediaForgeError('maxBytes must be a non-negative safe integer', 'INPUT');
    }
    return value;
}

export function outputError(
    reason: unknown,
    context = 'output sink failed',
    code: 'IO' | 'ABORT' = 'IO',
): MediaForgeError {
    try {
        if (reason instanceof MediaForgeError && (code === 'IO' || reason.code === code))
            return reason;
    } catch {}
    let message = 'unknown error';
    try {
        message = String(reason instanceof Error ? reason.message : reason);
    } catch {}
    return new MediaForgeError(`${context}: ${message}`, code);
}
