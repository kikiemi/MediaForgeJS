import type { Sink } from '../../core/model/types';
import { isPooledBytes } from '../../core/bytes/buffer-pool';
import { copiesWrites } from '../../core/io/sinks/copying-sinks';

/**
 * The sink a copy writes to: `sink` itself when it copies what it is given, else one that gives it
 * copies of bytes of reused buffers (a stream's chunks, a pass's spans), which change once
 * refilled, and the other bytes as they are.
 */
export function copySink(sink: Sink): Sink {
    if (sink.copiesWrites === true || copiesWrites(sink)) return sink;
    const wrapped: Sink = {
        signal: sink.signal,
        write: bytes => sink.write(isPooledBytes(bytes) ? bytes.slice() : bytes),
        close: () => sink.close(),
    };
    if (sink.patchAt) wrapped.patchAt = (offset, bytes) => sink.patchAt!(offset, bytes);
    if (sink.abort) wrapped.abort = reason => sink.abort!(reason);
    if (sink.drain) wrapped.drain = () => sink.drain!();
    return wrapped;
}
