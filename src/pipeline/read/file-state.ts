import type { FormatWriters, MissingParts } from '../plugins/missing-parts';
import type { RemuxPlanner } from '../copy/remux-plan';
import type { DiagnosticContext } from '../../core/errors/diagnostics';
import type { FilePacket, RemuxTrack, RemuxOptions, SharedReadOptions } from '../media-types';
import type { PacketOptions } from '../packet-types';
import { MediaForgeError } from '../../core/errors/errors';
import type { Source, Sink } from '../../core/model/types';
import type { MatroskaPassThrough, MediaTags } from '../../core/model/media';

export interface MediaFileState {
    readonly source: Source;
    /**
     * The input's container format and the composition's writers, which plan a copy of its packets.
     */
    readonly format: string;
    readonly writers: FormatWriters;
    readonly title?: string;
    /** The input's tags, chapters and pictures, its title among them. */
    readonly tags?: MediaTags;
    readonly matroskaPassThrough?: MatroskaPassThrough;
    readonly matroskaUnsupportedTags: boolean;
    readonly tracks: readonly RemuxTrack[];
    readonly signal: AbortSignal;
    readonly diagnostics: DiagnosticContext;
    /** The errors for parts of the composition that are not in use. */
    readonly missing: MissingParts;
    /** The copy planner of the file; FORMAT until a writer has loaded the packet copy. */
    planner(): RemuxPlanner;
    /**
     * `videoRotation` replaces the copied counter-clockwise display rotation of the first video
     * track.
     */
    remux(
        sink: Sink,
        options: RemuxOptions,
        diagnostics: DiagnosticContext,
        videoRotation?: number,
    ): Promise<void>;
    /**
     * Reads the packets of copies and readers in one pass, each packet once, the packet copy loaded
     * first; see SharedReadOptions.
     */
    share(options: SharedReadOptions): Promise<void>;
    /**
     * The packets of `packets()` borrowed instead of copied: their bytes are views of input pages
     * or reads that nobody rewrites (marked so writers may hold them), and their codec
     * configuration is shared. Read only.
     */
    borrowedPackets(options: PacketOptions): AsyncGenerator<FilePacket>;
}

const states = new WeakMap<object, MediaFileState>();

export function bindMediaFileState(file: object, state: MediaFileState): void {
    states.set(file, state);
}

export function forgetMediaFileState(file: object): void {
    states.delete(file);
}

export function mediaFileState(file: object): MediaFileState {
    const state = states.get(file);
    if (!state || state.signal.aborted) throw new MediaForgeError('Media file is closed', 'ABORT');
    return state;
}
