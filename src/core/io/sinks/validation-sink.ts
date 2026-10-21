import type { Sink } from '../../model/types';
import { MediaForgeError } from '../../errors/errors';
import { copyOutputBytes, outputByteLength } from '../../bytes/output-data';
import { declareCopyingSink } from './copying-sinks';

export function createValidationSink(maxBytes = Number.MAX_SAFE_INTEGER): Sink {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new MediaForgeError('maxBytes must be a positive safe integer', 'INPUT');
    let size = 0;
    let closed = false;

    const checkOpen = (): void => {
        if (closed) throw new MediaForgeError('Output is already closed', 'MUX');
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
            if (
                !(bytes instanceof Uint8Array) ||
                !Number.isSafeInteger(offset) ||
                offset < 0 ||
                offset > size ||
                bytes.byteLength > size - offset
            )
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

interface RecordedPatch {
    readonly offset: number;
    readonly bytes: Uint8Array;
}

/**
 * A measuring sink that keeps no output: it counts written bytes and records every patch in order.
 */
export class PatchRecorder implements Sink {
    readonly patches: RecordedPatch[] = [];
    length = 0;

    constructor() {
        declareCopyingSink(this);
    }

    write(bytes: Uint8Array): void {
        this.length += outputByteLength(bytes);
    }

    patchAt(offset: number, bytes: Uint8Array): void {
        const count = outputByteLength(bytes);
        if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > this.length ||
            count > this.length - offset
        )
            throw new MediaForgeError('Output patch is outside the written range', 'MUX');
        this.patches.push({ offset, bytes: copyOutputBytes(bytes) });
    }

    async close(): Promise<void> {}
}

/**
 * A seekable view of a forward-only sink for a writer that repeats a recorded pass byte for byte:
 * the recorded patches are applied to the bytes as they are written, the writer's own patchAt()
 * calls must repeat them exactly, and close() checks that the output length matches.
 */
export function replayPatches(sink: Sink, recorded: PatchRecorder): Sink {
    const pending = recorded.patches
        .map((patch, order) => ({ ...patch, order }))
        .sort((a, b) => a.offset - b.offset || a.order - b.order);

    let first = 0;
    let position = 0;
    let replayed = 0;

    const differs = (): MediaForgeError =>
        new MediaForgeError(
            'Output changed between the measuring pass and the written pass',
            'MUX',
        );

    return {
        signal: sink.signal,
        write(bytes) {
            const count = outputByteLength(bytes);
            const end = position + count;
            if (end > recorded.length) throw differs();
            while (
                first < pending.length &&
                pending[first]!.offset + pending[first]!.bytes.length <= position
            )
                first++;

            let out = bytes;
            for (
                let index = first;
                index < pending.length && pending[index]!.offset < end;
                index++
            ) {
                const patch = pending[index]!;
                const from = Math.max(patch.offset, position);
                const to = Math.min(patch.offset + patch.bytes.length, end);
                if (from >= to) continue;
                if (out === bytes) out = copyOutputBytes(bytes);
                out.set(
                    patch.bytes.subarray(from - patch.offset, to - patch.offset),
                    from - position,
                );
            }

            sink.write(out);
            position = end;
        },
        patchAt(offset, bytes) {
            const patch = recorded.patches[replayed];
            const count = outputByteLength(bytes);
            if (!patch || patch.offset !== offset || patch.bytes.length !== count) throw differs();
            for (let index = 0; index < count; index++)
                if (patch.bytes[index] !== bytes[index]) throw differs();
            replayed++;
        },
        async close() {
            if (position !== recorded.length || replayed !== recorded.patches.length)
                throw differs();
            await sink.close();
        },
        ...(sink.abort ? { abort: (reason?: unknown) => sink.abort!(reason) } : {}),
        ...(sink.drain ? { drain: () => sink.drain!() } : {}),
    };
}
