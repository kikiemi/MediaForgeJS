import { MediaForgeError } from '../core/errors.js';
import { copyOutputBytes, outputByteLength } from '../io/output-data.js';
import { outputLimit } from './requests.js';
export function snapshotStreamOptions(options = {}) {
    const maxBytes = outputLimit(options, Number.MAX_SAFE_INTEGER);
    const highWaterMark = options.highWaterMark ?? 1024 * 1024;
    if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1)
        throw new MediaForgeError('highWaterMark must be a positive safe integer', 'INPUT');
    return { maxBytes, highWaterMark };
}
export function outputStream(run, options) {
    const cancellation = new AbortController();
    let complete = false;
    let total = 0;
    let wake;
    let pending;
    return new ReadableStream({
        start(controller) {
            const settle = () => {
                wake?.();
                wake = undefined;
            };
            const sink = {
                signal: cancellation.signal,
                write(bytes) {
                    if (complete || cancellation.signal.aborted)
                        throw new MediaForgeError('Output stream is closed', 'ABORT');
                    const count = outputByteLength(bytes);
                    if (count > options.maxBytes - total)
                        throw new MediaForgeError('output exceeds maxBytes', 'OOM');
                    total += count;
                    if (count)
                        controller.enqueue(copyOutputBytes(bytes));
                },
                async close() {
                    if (!complete) {
                        complete = true;
                        controller.close();
                    }
                    settle();
                },
                async abort(reason) {
                    if (!complete) {
                        complete = true;
                        controller.error(reason);
                    }
                    settle();
                },
                drain() {
                    if (complete || cancellation.signal.aborted || (controller.desiredSize ?? 0) > 0)
                        return Promise.resolve();
                    return new Promise(resolve => {
                        wake = resolve;
                    });
                },
            };
            pending = run(sink, cancellation.signal)
                .catch(reason => sink.abort(reason))
                .then(() => undefined);
        },
        pull() {
            wake?.();
            wake = undefined;
        },
        async cancel(reason) {
            complete = true;
            cancellation.abort(reason);
            wake?.();
            wake = undefined;
            await pending;
        },
    }, { highWaterMark: options.highWaterMark, size: bytes => bytes.byteLength });
}
