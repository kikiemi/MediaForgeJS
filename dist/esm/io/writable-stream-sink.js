import { MediaForgeError } from '../core/errors.js';
import { StreamSink } from './sinks.js';
export class WritableStreamSink {
    sink;
    constructor(stream, options = {}) {
        let getWriter;
        try {
            getWriter = stream.getWriter;
            if (typeof getWriter !== 'function')
                throw new Error();
        }
        catch {
            throw new MediaForgeError('expected a WritableStream of Uint8Array chunks', 'IO');
        }
        const highWaterMark = options.highWaterMark ?? 1024 * 1024;
        if (!Number.isFinite(highWaterMark) || highWaterMark <= 0) {
            throw new MediaForgeError('highWaterMark must be a positive finite number', 'IO');
        }
        if (stream.locked)
            throw new MediaForgeError('output WritableStream is already locked', 'IO');
        const writer = getWriter.call(stream);
        let released = false;
        let aborted = false;
        const release = (preserveFailure = false) => {
            if (released)
                return;
            released = true;
            try {
                writer.releaseLock();
            }
            catch (error) {
                if (!preserveFailure)
                    throw error;
            }
        };
        this.sink = new StreamSink({
            write: async ({ data }) => {
                try {
                    if (aborted)
                        return;
                    await writer.write(new Uint8Array(data));
                }
                catch (error) {
                    release(true);
                    throw error;
                }
            },
            close: async () => {
                try {
                    await writer.close();
                }
                catch (error) {
                    release(true);
                    throw error;
                }
                release();
            },
            abort: async (reason) => {
                aborted = true;
                try {
                    const pending = writer.abort(reason);
                    release(true);
                    Promise.resolve(pending).catch(() => undefined);
                }
                finally {
                    release(true);
                }
            },
        }, { highWaterMark });
    }
    write(data) {
        this.sink.write(data);
    }
    drain() {
        return this.sink.drain();
    }
    close() {
        return this.sink.close();
    }
    abort(reason) {
        return this.sink.abort(reason);
    }
    get done() {
        return this.sink.done;
    }
}
