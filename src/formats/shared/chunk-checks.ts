import { MediaForgeError } from '../../core/errors/errors';
import type { EncodedPacket } from '../../core/model/media';

/** The checks every writer makes on its calls, with the MUX errors they share. */

/** Refuses a call on a finalized muxer. */
export function assertOpen(finalized: boolean): void {
    if (finalized) throw new MediaForgeError('Muxer already finalized', 'MUX');
}

/** Refuses a chunk not of the `kind` that `method` takes, then a call on a finalized muxer. */
export function checkChunk(
    method: string,
    chunk: EncodedPacket,
    kind: 'audio' | 'video',
    finalized = false,
): void {
    const type = chunk?.trackType;
    if (type !== kind)
        throw new MediaForgeError(
            type === undefined
                ? `${method} requires chunk.trackType (got a chunk without one)`
                : `${method} received a '${String(type)}' chunk`,
            'MUX',
        );
    assertOpen(finalized);
}

/** The error of a finalize that finds a declared track without chunks. */
export function unfedTrack(kind: 'audio' | 'video', extra = ''): MediaForgeError {
    return new MediaForgeError(
        `finalize with a declared ${extra}${kind} track but no ${kind} chunks`,
        'MUX',
    );
}
