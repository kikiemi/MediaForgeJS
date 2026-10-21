import { MediaForgeError } from '../../errors/errors';
import type { Sink } from '../../model/types';
import { StreamSink } from './sinks';

/** Non-seekable WritableStream output; callers await drain() for backpressure. */
export class WritableStreamSink implements Sink {
    private readonly sink: StreamSink;

    constructor(stream: WritableStream<Uint8Array>, options: { highWaterMark?: number } = {}) {
        let getWriter: WritableStream<Uint8Array>['getWriter'];
        try {
            getWriter = stream.getWriter;
            if (typeof getWriter !== 'function') throw new Error();
        } catch {
            throw new MediaForgeError('expected a WritableStream of Uint8Array chunks', 'INPUT');
        }

        const highWaterMark = options.highWaterMark ?? 1024 * 1024;
        if (!Number.isFinite(highWaterMark) || highWaterMark <= 0) {
            throw new MediaForgeError('highWaterMark must be a positive finite number', 'INPUT');
        }

        if (stream.locked)
            throw new MediaForgeError('output WritableStream is already locked', 'IO');
        const writer = getWriter.call(stream);
        let released = false;
        let aborted = false;

        const release = (preserveFailure = false): void => {
            if (released) return;
            released = true;
            try {
                writer.releaseLock();
            } catch (error) {
                if (!preserveFailure) throw error;
            }
        };

        this.sink = new StreamSink(
            {
                write: async ({ data }) => {
                    try {
                        if (aborted) return;
                        await writer.write(new Uint8Array(data));
                    } catch (error) {
                        release(true);
                        throw error;
                    }
                },
                close: async () => {
                    try {
                        await writer.close();
                    } catch (error) {
                        release(true);
                        throw error;
                    }
                    release();
                },
                abort: async reason => {
                    aborted = true;
                    try {
                        const pending = writer.abort(reason);
                        release(true);
                        Promise.resolve(pending).catch(() => undefined);
                    } finally {
                        release(true);
                    }
                },
            },
            { highWaterMark },
        );
    }

    write(data: Uint8Array): void {
        this.sink.write(data);
    }
    drain(): Promise<void> {
        return this.sink.drain();
    }
    close(): Promise<void> {
        return this.sink.close();
    }
    abort(reason?: unknown): Promise<void> {
        return this.sink.abort(reason);
    }
    get done(): Promise<void> {
        return this.sink.done;
    }
}
