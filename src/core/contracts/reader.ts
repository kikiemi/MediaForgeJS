import type { DemuxResult, ProbedInput, ProbeTarget } from '../model/track';
import type { Source } from '../model/types';
import type { DiagnosticOptions } from '../errors/diagnostics';

/** The reader contract: how an input is opened and indexed into tracks and samples. */

/** How much of the input's index a reader may hold. */
export interface DemuxBudgetOptions {
    /** Maximum sample-index entries across all tracks. */
    readonly maxSamples?: number;
    /** Estimated index-allocation budget in bytes; defaults to 128 MiB. Excludes media payloads. */
    readonly maxIndexBytes?: number;
}

/** How an input is read: the format to assume, validation, limits and caching. */
export interface OpenOptions extends DiagnosticOptions, DemuxBudgetOptions {
    /** Reads the input as this format instead of detecting it. */
    readonly format?: string;
    readonly signal?: AbortSignal;
    /**
     * Reads every complete packet of truncated or damaged input under compatible validation, also
     * where a stream holds fewer packets than its header declares, which is then read as
     * truncated (AVI states its frame count). AviDemuxer used on its own then defaults to
     * compatible validation.
     */
    readonly recovery?: 'complete-packets';
    /** Largest packet read; default 64 MiB. */
    readonly maxPacketBytes?: number;
    /** Retained input pages. Default 4 MiB; zero disables the cache. */
    readonly cacheBytes?: number;
    /** Aligned page size. Default 64 KiB. */
    readonly readPageBytes?: number;
}

/** The options a reader reads an input with: those of open() and what its capabilities allow. */
export interface ReadOptions extends OpenOptions {
    /**
     * Set for a reader whose capabilities include `compactIndex`: it may describe a track's samples
     * by a compact sample index (bindCompactSampleIndex) instead of an array of sample objects.
     */
    readonly compactIndex?: boolean;
}

/**
 * What a reader declares about the results it returns, which the opened file relies on. Every
 * reader, the library's own included, is read the same way; a reader that declares nothing has its
 * samples copied and checked one by one.
 */
export interface ReaderCapabilities {
    /**
     * The tracks and samples it returns are the file's: the reader keeps no reference to them, so
     * the file keeps them instead of copies, with the compact sample indexes and packet readers
     * bound to its tracks (bindCompactSampleIndex, bindPacketizedReader).
     */
    readonly handsOver?: boolean;
    /** Reads `compactIndex` in its options (see ReadOptions); needs `handsOver`. */
    readonly compactIndex?: boolean;
}

/** A container reader, as its part loads it. */
export interface Reader {
    /** Indexes the encoded samples of each track; samples with data need no source reads. */
    read(source: Source, options: ReadOptions): Promise<DemuxResult>;
    /** Describes a large input from a few reads instead of indexing it; see DemuxProbe. */
    readonly probe?: DemuxProbe;
    /** What the opened file may rely on in the reader's results; see ReaderCapabilities. */
    readonly capabilities?: ReaderCapabilities;
}

/** A container reader part: the formats it reads, how it recognises them, and its reader. */
export interface ReaderPart {
    readonly id: string;
    /** Format names, lower case; the first is the one detection reports. */
    readonly formats: readonly string[];
    /**
     * Recognises the format from the first bytes (up to 8 KiB, fewer for a shorter input), before
     * the library's detection runs; true opens the input as the part's first format. Omitted leaves
     * detection to the library.
     */
    readonly sniff?: (head: Uint8Array) => boolean;
    /**
     * Asks `sniff` within the library's detection instead of before it, after the signatures of
     * lower priority (the head then starts after any ID3v2 tags). The library's readers have one:
     * CAF 10, AIFF 20, AU 30, WAVE 40, WebP 41, AVI 42, RF64 50, Matroska 60, the MP4 family 80,
     * ASF 90, IVF 100, MXF 110, FLV 130, Ogg 140, MPEG audio 150, ADTS 160, FLAC 170, the images
     * 180 to 230 and a QuickTime movie without ftyp 240; elementary streams come after them all.
     */
    readonly priority?: number;
    /** Loads the reader with the first input of its formats. */
    readonly load: () => Promise<Reader>;
}

/**
 * The tracks and durations of an input its reader describes with less work than its index (from
 * its headers, head and tail, or an MP4's movie box without building its tables), with the samples
 * of those reads only; with a `target`, also the window of samples it asks for or a stream of
 * every sample. Undefined when the input must be read whole; null when it is not one the probe
 * describes, which is read whole and counted as a reader without a probe reads it.
 */
export type DemuxProbe = (
    source: Source,
    options: ReadOptions,
    target?: ProbeTarget,
) => Promise<ProbedInput | null | undefined>;
