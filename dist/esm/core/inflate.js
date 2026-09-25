import { awaitWithAbort } from './abort.js';
import { DemuxError, MediaForgeError } from './errors.js';
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
export async function inflateBounded(parts, maxBytes, what, signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new DemuxError(`${what} has an invalid decompression limit`);
    }
    const ds = new DecompressionStream('deflate');
    const blobParts = parts.map(p => p.buffer instanceof ArrayBuffer && !arrayBufferResizable?.call(p.buffer)
        ? new Uint8Array(p.buffer, p.byteOffset, p.byteLength)
        : new Uint8Array(p));
    const reader = new Blob(blobParts).stream().pipeThrough(ds).getReader();
    const chunks = [];
    let total = 0;
    let failed = false;
    try {
        for (;;) {
            const { done, value } = await (signal ? awaitWithAbort(reader.read(), signal) : reader.read());
            if (signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            if (done)
                break;
            if (value.length > maxBytes - total) {
                throw new DemuxError(`${what} decompresses past its declared size (${maxBytes} bytes) - refusing the expansion`);
            }
            total += value.length;
            if (value.length)
                chunks.push(value);
        }
    }
    catch (cause) {
        failed = true;
        const error = cause instanceof MediaForgeError ? cause : new DemuxError(`${what} decompression failed`);
        if (error !== cause)
            error.cause = cause;
        try {
            void reader.cancel(error).catch(() => undefined);
        }
        catch { }
        throw error;
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch (error) {
            if (!failed)
                throw error;
        }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}
