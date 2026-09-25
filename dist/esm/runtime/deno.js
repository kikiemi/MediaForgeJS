import { IOError, MediaForgeError } from '../core/errors.js';
import { awaitWithAbort } from '../core/abort.js';
import { PositionedFileSource, PositionedFileSink, ownsHandle, validateFileSize, fileHighWaterMark, fileSourceSignal, } from './file-io.js';
export { HttpSource } from '../io/http-source.js';
export { StreamSource } from '../io/stream-source.js';
export { WritableStreamSink } from '../io/writable-stream-sink.js';
export { sourceToReadableStream } from '../io/source-stream.js';
async function openFile(path, write) {
    const host = globalThis;
    if (!host.Deno)
        throw new IOError('Deno filesystem APIs are unavailable');
    return host.Deno.open(path, write ? { read: true, write: true, create: true, truncate: true } : { read: true });
}
export class FileSource extends PositionedFileSource {
    static async open(path, options = {}) {
        const signal = fileSourceSignal(options);
        return awaitWithAbort(openFile(path, false).then(handle => FileSource.from(handle, { signal, closeHandle: true })), signal);
    }
    static async from(handle, options = {}) {
        const own = ownsHandle(options);
        try {
            const signal = fileSourceSignal(options);
            const stat = await awaitWithAbort(handle.stat(), signal);
            if (!stat.isFile)
                throw new IOError('FileSource requires a regular file');
            validateFileSize(stat.size);
            let pending = Promise.resolve();
            return new FileSource({
                readAt: (bytes, position, readSignal) => {
                    const read = pending.then(async () => {
                        if (readSignal.aborted)
                            throw new MediaForgeError('File source is closed', 'ABORT');
                        await handle.seek(position, 0);
                        if (readSignal.aborted)
                            throw new MediaForgeError('File source is closed', 'ABORT');
                        return (await handle.read(bytes)) ?? 0;
                    });
                    pending = read.then(() => undefined, () => undefined);
                    return read;
                },
                close: async () => {
                    handle.close();
                },
            }, stat.size, own, signal);
        }
        catch (error) {
            if (own) {
                try {
                    handle.close();
                }
                catch { }
            }
            throw error;
        }
    }
}
export class FileSink extends PositionedFileSink {
    static async open(path, options = {}) {
        const highWaterMark = fileHighWaterMark(options.highWaterMark);
        const handle = await openFile(path, true);
        return FileSink.from(handle, { highWaterMark, closeHandle: true });
    }
    static async from(handle, options = {}) {
        const own = ownsHandle(options);
        try {
            const sink = new FileSink({
                writeAt: async (bytes, position, signal) => {
                    if (signal.aborted)
                        throw new MediaForgeError('File sink is closed', 'ABORT');
                    await handle.seek(position, 0);
                    if (signal.aborted)
                        throw new MediaForgeError('File sink is closed', 'ABORT');
                    return handle.write(bytes);
                },
                close: async () => {
                    handle.close();
                },
            }, own, options);
            await handle.truncate(0);
            return sink;
        }
        catch (error) {
            if (own) {
                try {
                    handle.close();
                }
                catch { }
            }
            throw error;
        }
    }
}
