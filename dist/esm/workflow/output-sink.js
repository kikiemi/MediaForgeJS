import { createValidationSink } from '../io/validation-sink.js';
export function withOutputLimit(sink, maxBytes) {
    if (maxBytes === Number.MAX_SAFE_INTEGER)
        return sink;
    const validation = createValidationSink(maxBytes);
    return {
        signal: sink.signal,
        write(bytes) {
            validation.write(bytes);
            sink.write(bytes);
        },
        close: () => sink.close(),
        ...(sink.patchAt
            ? {
                patchAt(offset, bytes) {
                    validation.patchAt(offset, bytes);
                    sink.patchAt(offset, bytes);
                },
            }
            : {}),
        ...(sink.abort ? { abort: (reason) => sink.abort(reason) } : {}),
        ...(sink.drain ? { drain: () => sink.drain() } : {}),
    };
}
