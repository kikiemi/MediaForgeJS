import { MediaForgeError } from '../core/errors.js';
export function createValidationSink(maxBytes = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new MediaForgeError('maxBytes must be a positive safe integer', 'INPUT');
    let size = 0;
    let closed = false;
    const checkOpen = () => {
        if (closed)
            throw new MediaForgeError('Output is already closed', 'MUX');
    };
    return {
        write(bytes) {
            checkOpen();
            if (!(bytes instanceof Uint8Array))
                throw new MediaForgeError('Expected output bytes', 'MUX');
            if (bytes.byteLength > maxBytes - size)
                throw new MediaForgeError('output exceeds maxBytes', 'OOM');
            size += bytes.byteLength;
        },
        patchAt(offset, bytes) {
            checkOpen();
            if (!(bytes instanceof Uint8Array) ||
                !Number.isSafeInteger(offset) ||
                offset < 0 ||
                offset > size ||
                bytes.byteLength > size - offset)
                throw new MediaForgeError('Output patch is outside the written range', 'MUX');
        },
        async close() {
            checkOpen();
            closed = true;
        },
        async abort() {
            closed = true;
        },
    };
}
