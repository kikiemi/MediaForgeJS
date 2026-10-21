import type {
    AudioWriterFactory,
    ContainerWriterFactory,
    WriterPart,
} from '../../core/contracts/writer';
import type { OpenOptions, ReaderCapabilities, ReaderPart } from '../../core/contracts/reader';
import type { CmafWriter, CmafWriterOptions } from '../mp4/write/cmaf';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { MediaForgeError } from '../../core/errors/errors';
import { lazy } from '../../core/contracts/lazy';

/**
 * How the formats of a composition are registered: reader and writer parts by format name, the
 * fragmented MP4 segment writer, and the capabilities the library's readers declare.
 */

/** A fragmented MP4 (CMAF) segment writer, for fmp4 output and packaging. */
export interface MediaSegmentWriter {
    readonly load: () => Promise<void>;
    create(options: CmafWriterOptions): CmafWriter;
}

/** The containers of a composition: readers and writers, those listed first winning a format. */
export interface FormatParts {
    readonly readers: readonly ReaderPart[];
    readonly writers: readonly WriterPart[];
    readonly segments?: MediaSegmentWriter;
}

/**
 * The writers of a composition by format name; `load` fetches a format's writer before the sync
 * lookups.
 */
export interface MediaWriters {
    readonly container: ReadonlyMap<string, ContainerWriterFactory>;
    readonly audio: ReadonlyMap<string, AudioWriterFactory>;
    readonly segments?: MediaSegmentWriter['create'];
    /** Loads the writer of `format` ('fmp4' and the packaging formats load the segment writer). */
    load(format: string): Promise<void>;
}

/** The diagnostics of one read, with the compatible validation readers default to. */
export function readerDiagnostics(options: OpenOptions): DiagnosticContext {
    return new DiagnosticContext(options, 'compatible');
}

/** The capabilities of the library's readers: their results are the opened file's. */
export const HANDS_OVER: ReaderCapabilities = Object.freeze({ handsOver: true });

/** Those of the MP4, Matroska and MPEG-TS readers, which also describe long tracks compactly. */
export const COMPACT_INDEX: ReaderCapabilities = Object.freeze({
    handsOver: true,
    compactIndex: true,
});

/** A segment writer whose implementation is imported by `load`. */
export function lazySegmentWriter(
    fetch: () => Promise<MediaSegmentWriter['create']>,
): MediaSegmentWriter {
    const load = lazy(fetch);
    let loaded: MediaSegmentWriter['create'] | undefined;
    return Object.freeze({
        load: async () => void (loaded = await load()),
        create(options: CmafWriterOptions) {
            if (!loaded)
                throw new MediaForgeError('The fragmented MP4 writer is not loaded', 'FORMAT');
            return loaded(options);
        },
    });
}

/** Formats written through the segment writer. */
const SEGMENTED = new Set(['fmp4', 'hls', 'dash', 'hls+dash']);

/**
 * The format names of a reader or writer part, trimmed and lower case; an empty list or name is
 * rejected.
 */
export function partFormats(part: { readonly formats: readonly string[] }, role: string): string[] {
    const { formats } = part;
    if (!Array.isArray(formats) || !formats.length)
        throw new MediaForgeError(`A ${role} needs its formats`, 'INPUT');
    return formats.map(value => {
        if (typeof value !== 'string' || !value.trim())
            throw new MediaForgeError(`Invalid ${role} format`, 'INPUT');
        return value.trim().toLowerCase();
    });
}

/**
 * The writers of `parts` by format, each implementation loaded with the first output of its
 * formats. A format has at most one container writer (conversions) and one audio writer (copies of
 * one audio track), as Ogg has; two of one kind are rejected.
 */
export function createWriters(
    parts: readonly WriterPart[],
    segments?: MediaSegmentWriter,
): MediaWriters {
    const container = new Map<string, ContainerWriterFactory>();
    const audio = new Map<string, AudioWriterFactory>();
    const loaders = new Map<string, () => Promise<void>>();
    for (const part of parts) {
        if (!part || typeof part !== 'object' || typeof part.load !== 'function')
            throw new MediaForgeError('A writer needs formats and load()', 'INPUT');
        if (part.kind !== 'container' && part.kind !== 'audio')
            throw new MediaForgeError("A writer's kind is 'container' or 'audio'", 'INPUT');
        const fetch = lazy(part.load as () => Promise<Function>);
        let loaded: Function | undefined;
        const load = async (): Promise<void> => void (loaded = await fetch());
        /** The writer, once loaded; a call before names the format the caller asked for. */
        const implementation = (format: string): Function => {
            if (!loaded) throw new MediaForgeError(`The ${format} writer is not loaded`, 'FORMAT');
            return loaded;
        };

        for (const format of partFormats(part, 'writer')) {
            const target = part.kind === 'container' ? container : audio;
            if (target.has(format))
                throw new MediaForgeError(`Two writers are registered for ${format}`, 'INPUT');
            target.set(format, (...args: unknown[]) => implementation(format)(...args));
            const other = loaders.get(format);
            loaders.set(format, other ? async () => void (await other(), await load()) : load);
        }
    }

    return {
        container,
        audio,
        segments: segments && ((options: CmafWriterOptions) => segments.create(options)),
        async load(format) {
            await loaders.get(format)?.();
            if (SEGMENTED.has(format)) await segments?.load();
        },
    };
}
