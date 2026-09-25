import { IOError, MediaForgeError } from '../core/errors.js';
import { awaitWithAbort } from '../core/abort.js';
import { StreamSource } from '../io/stream-source.js';
import { WritableStreamSink } from '../io/writable-stream-sink.js';
import { PositionedFileSource, PositionedFileSink, ownsHandle, validateFileSize, fileHighWaterMark, fileSourceSignal, } from './file-io.js';
async function openFile(path, flags) {
    const name = 'node:fs/promises';
    const fs = (await import(name));
    return fs.open(path, flags);
}
export class FileSource extends PositionedFileSource {
    static async open(path, options = {}) {
        const signal = fileSourceSignal(options);
        return awaitWithAbort(openFile(path, 'r').then(handle => FileSource.from(handle, { signal, closeHandle: true })), signal);
    }
    static async from(handle, options = {}) {
        const own = ownsHandle(options);
        try {
            const signal = fileSourceSignal(options);
            const stat = await awaitWithAbort(handle.stat(), signal);
            if (!stat.isFile())
                throw new IOError('FileSource requires a regular file');
            validateFileSize(stat.size);
            return new FileSource({
                readAt: async (bytes, position) => (await handle.read(bytes, 0, bytes.length, position)).bytesRead,
                close: () => handle.close(),
            }, stat.size, own, signal);
        }
        catch (error) {
            if (own) {
                try {
                    const closing = Promise.resolve(handle.close());
                    if (error instanceof MediaForgeError && error.code === 'ABORT')
                        void closing.catch(() => undefined);
                    else
                        await closing;
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
        const handle = await openFile(path, 'w+');
        return FileSink.from(handle, { highWaterMark, closeHandle: true });
    }
    static async from(handle, options = {}) {
        const own = ownsHandle(options);
        try {
            const sink = new FileSink({
                writeAt: async (bytes, position) => (await handle.write(bytes, 0, bytes.length, position)).bytesWritten,
                close: () => handle.close(),
            }, own, options);
            await handle.truncate(0);
            return sink;
        }
        catch (error) {
            if (own) {
                try {
                    await handle.close();
                }
                catch { }
            }
            throw error;
        }
    }
}
export async function nodeReadableSource(input, options) {
    try {
        return await StreamSource.from(input, options);
    }
    catch (error) {
        try {
            input.destroy();
        }
        catch { }
        throw error;
    }
}
export async function nodeWritableSink(input, options = {}) {
    const highWaterMark = fileHighWaterMark(options.highWaterMark);
    const name = 'node:stream';
    const streams = (await import(name));
    return new WritableStreamSink(streams.Writable.toWeb(input), { highWaterMark });
}
