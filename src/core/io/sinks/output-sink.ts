import type { Sink } from '../../model/types';
import { createValidationSink } from './validation-sink';

export function withOutputLimit(sink: Sink, maxBytes: number): Sink {
    if (maxBytes === Number.MAX_SAFE_INTEGER) return sink;
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
                  patchAt(offset: number, bytes: Uint8Array) {
                      validation.patchAt!(offset, bytes);
                      sink.patchAt!(offset, bytes);
                  },
              }
            : {}),
        ...(sink.abort ? { abort: (reason?: unknown) => sink.abort!(reason) } : {}),
        ...(sink.drain ? { drain: () => sink.drain!() } : {}),
    };
}
