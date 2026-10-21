import { awaitWithAbort } from './abort';
import { DemuxError, MediaForgeError, throwIfAborted } from '../errors/errors';
import { concatBytes } from '../bytes/bytes';

const arrayBufferResizable = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'resizable',
)?.get;

/**
 * zlib-wrapped DEFLATE `parts` inflated through DecompressionStream, refused as a DemuxError past
 * `maxBytes` or when damaged; `what` names the data in the message.
 */
export async function inflateBounded(
    parts: Uint8Array[],
    maxBytes: number,
    what: string,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    throwIfAborted(signal);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new DemuxError(`${what} has an invalid decompression limit`);
    }

    const ds = new DecompressionStream('deflate');
    const blobParts: BlobPart[] = parts.map(p =>
        p.buffer instanceof ArrayBuffer && !arrayBufferResizable?.call(p.buffer)
            ? new Uint8Array(p.buffer, p.byteOffset, p.byteLength)
            : new Uint8Array(p),
    );
    const reader = new Blob(blobParts).stream().pipeThrough(ds).getReader();

    const chunks: Uint8Array[] = [];
    let total = 0;
    let failed = false;

    try {
        for (;;) {
            const { done, value } = await (signal
                ? awaitWithAbort(reader.read(), signal)
                : reader.read());
            throwIfAborted(signal);
            if (done) break;
            if (value.length > maxBytes - total) {
                throw new DemuxError(`${what} decompresses past its declared size`);
            }
            total += value.length;
            if (value.length) chunks.push(value);
        }
    } catch (cause) {
        failed = true;
        const error =
            cause instanceof MediaForgeError
                ? cause
                : new DemuxError(`${what} decompression failed`);
        if (error !== cause) error.cause = cause;
        try {
            void reader.cancel(error).catch(() => undefined);
        } catch {}
        throw error;
    } finally {
        try {
            reader.releaseLock();
        } catch (error) {
            if (!failed) throw error;
        }
    }
    return concatBytes(chunks);
}
