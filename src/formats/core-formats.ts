import type {
    RawAudioDemuxOptions,
    StandaloneAudioDemuxOptions,
} from './audio-files/demux-options';
import type { SyncAudioDemuxOptions } from './audio-files/sync-reader';
import type { ReadOptions, Reader, ReaderPart } from '../core/contracts/reader';
import type { DemuxResult, ProbedInput, ProbeTarget } from '../core/model/track';
import type { Source } from '../core/model/types';
import type { DiagnosticContext } from '../core/errors/diagnostics';
import type { WriterPart } from '../core/contracts/writer';
import { enableCompactSampleIndex } from '../core/model/sample-index';
import {
    COMPACT_INDEX,
    HANDS_OVER,
    lazySegmentWriter,
    readerDiagnostics,
    type FormatParts,
} from './shared/contract';

/**
 * The containers of the core: readers and writers under their format names, each implementation
 * imported with the first input or output of its format.
 */

/** The format option of a reader that reads several formats. */
const formatOf = <T>(options: ReadOptions): T => options.format as T;

/** MP4, MOV, M4A, M4V and 3GP. */
const mp4Reader: ReaderPart = {
    id: 'mp4',
    formats: ['mp4', 'mov', 'm4a', 'm4v', '3gp'],
    load: async () => {
        // The walk that repairs a damaged movie box comes with the reader, which uses it too.
        const [{ Mp4Demuxer, fragmentedLayout }, { compatibleMp4Source }] = await Promise.all([
            import('./mp4/reader'),
            import('./mp4/read/compatible-source'),
        ]);
        return {
            // A large fragmented movie with a fragment index is described from a few reads, a
            // movie without fragments from its movie box with its tables checked but not built;
            // any other is read whole.
            async probe(source, options, target = {}) {
                const layout = await fragmentedLayout(source);
                if (!layout) {
                    if (target.stream || target.range || target.around !== undefined) return null;
                    if (!options.compactIndex) return null;
                    const described = await new Mp4Demuxer({
                        allowEmptyTracks: true,
                        maxSamples: options.maxSamples,
                        maxIndexBytes: options.maxIndexBytes,
                    }).describe(source, options.signal, readerDiagnostics(options));
                    if (!described) return null;
                    const { result, index } = described;
                    return { result, packets: false, counted: true, index };
                }
                const { probeFragmentedMp4 } = await import('./mp4/read/fragment-probe');
                const probed = await probeFragmentedMp4(
                    source,
                    layout,
                    {
                        limits: {
                            maxSamples: options.maxSamples,
                            maxIndexBytes: options.maxIndexBytes,
                        },
                        compact: options.compactIndex === true,
                    },
                    options.signal,
                    readerDiagnostics(options),
                    target,
                );
                return probed ?? null;
            },
            async read(source, options) {
                const diagnostics = readerDiagnostics(options);
                const compatible = await compatibleMp4Source(source, diagnostics, options.signal);
                const demuxer = new Mp4Demuxer({
                    allowEmptyTracks: true,
                    maxSamples: options.maxSamples,
                    maxIndexBytes: options.maxIndexBytes,
                });
                if (options.compactIndex) enableCompactSampleIndex(demuxer);
                return demuxer.demux(compatible, options.signal, diagnostics);
            },
            capabilities: COMPACT_INDEX,
        };
    },
};

/** A demuxer that reads an input whole or describes it from its head and tail. */
interface ProbingDemuxer {
    demux(
        source: Source,
        signal?: AbortSignal,
        diagnostics?: DiagnosticContext,
    ): Promise<DemuxResult>;
    probe(
        source: Source,
        signal?: AbortSignal,
        diagnostics?: DiagnosticContext,
        target?: ProbeTarget,
    ): Promise<ProbedInput | undefined>;
}

/** The reader of a probing demuxer, a new one for each input. */
function probingReader(Demuxer: new (options: ReadOptions) => ProbingDemuxer): Reader {
    const demuxer = (options: ReadOptions): ProbingDemuxer => {
        const created = new Demuxer(options);
        if (options.compactIndex) enableCompactSampleIndex(created);
        return created;
    };
    return {
        read: (source, options) =>
            demuxer(options).demux(source, options.signal, readerDiagnostics(options)),
        probe: (source, options, target) =>
            demuxer(options).probe(source, options.signal, readerDiagnostics(options), target),
        capabilities: COMPACT_INDEX,
    };
}

/** Matroska and WebM, described from their head and tail when large. */
const matroskaReader: ReaderPart = {
    id: 'matroska',
    formats: ['mkv', 'webm'],
    load: async () => probingReader((await import('./matroska/reader')).WebMDemuxer),
};

/** MPEG transport streams, described from their head and tail when large. */
const tsReader: ReaderPart = {
    id: 'ts',
    formats: ['ts'],
    load: async () => probingReader((await import('./mpeg-ts/reader')).TsDemuxer),
};

/** The options of a raw MPEG audio or ADTS read. */
const rawAudioOptions = (options: ReadOptions): RawAudioDemuxOptions => ({
    ...options,
    format: formatOf<RawAudioDemuxOptions['format']>(options),
});

/** MP3, described from its Xing/Info or VBRI frame and its last frames when inspected. */
const mp3Reader: ReaderPart = {
    id: 'mp3',
    formats: ['mp3'],
    load: async () => {
        const { demuxRawAudio, probeRawAudio } = await import('./audio-files/mpeg-audio-reader');
        return {
            read: (source, options) => demuxRawAudio(source, rawAudioOptions(options)),
            probe: (source, options, target) =>
                probeRawAudio(source, rawAudioOptions(options), target),
            capabilities: HANDS_OVER,
        };
    },
};

/** MPEG audio Layers I and II and ADTS AAC, whose durations add up every frame. */
const mpegAudioReader: ReaderPart = {
    id: 'mpeg-audio',
    formats: ['aac', 'mp1', 'mp2'],
    load: async () => {
        const { demuxRawAudio } = await import('./audio-files/mpeg-audio-reader');
        return {
            read: (source, options) => demuxRawAudio(source, rawAudioOptions(options)),
            capabilities: HANDS_OVER,
        };
    },
};

/** Raw AC-3, E-AC-3, DTS and TrueHD. */
const syncAudioReader: ReaderPart = {
    id: 'sync-audio',
    formats: ['ac3', 'eac3', 'dts', 'truehd'],
    load: async () => {
        const { demuxSyncAudio } = await import('./audio-files/sync-reader');
        return {
            read: (source, options) =>
                demuxSyncAudio(source, {
                    ...options,
                    format: formatOf<SyncAudioDemuxOptions['format']>(options),
                }),
            capabilities: HANDS_OVER,
        };
    },
};

/** The options of an audio file read. */
const audioFileOptions = (options: ReadOptions): StandaloneAudioDemuxOptions => ({
    ...options,
    format: formatOf<StandaloneAudioDemuxOptions['format']>(options),
});

/** WAV, AIFF, AU and CAF files, whose headers state where every packet lies. */
const audioFileReader: ReaderPart = {
    id: 'audio-file',
    formats: ['wav', 'aiff', 'au', 'caf'],
    load: async () => {
        const { demuxStandaloneAudio } = await import('./audio-files/reader');
        return {
            read: (source, options) => demuxStandaloneAudio(source, audioFileOptions(options)),
            capabilities: HANDS_OVER,
        };
    },
};

/** FLAC, described from STREAMINFO and its first and last frames when inspected. */
const flacReader: ReaderPart = {
    id: 'flac',
    formats: ['flac'],
    load: async () => {
        const { demuxFlac, probeFlac } = await import('./audio-files/described-files');
        return {
            read: (source, options) => demuxFlac(source, audioFileOptions(options)),
            probe: (source, options, target) =>
                probeFlac(source, audioFileOptions(options), target),
            capabilities: HANDS_OVER,
        };
    },
};

/**
 * Ogg, described from its head and tail: its packets are counted only by a read of every page.
 */
const oggReader: ReaderPart = {
    id: 'ogg',
    formats: ['ogg', 'ogv', 'oga', 'opus'],
    load: async () => {
        const { demuxOgg, probeOgg } = await import('./audio-files/described-files');
        return {
            read: (source, options) => demuxOgg(source, audioFileOptions(options)),
            probe: (source, options, target) => probeOgg(source, audioFileOptions(options), target),
            capabilities: HANDS_OVER,
        };
    },
};

const CORE_WRITERS: readonly WriterPart[] = [
    {
        kind: 'container',
        id: 'mp4',
        formats: ['mp4', 'mov', 'm4a', 'm4v', '3gp'],
        load: async () => {
            const { Mp4Muxer } = await import('./mp4/writer');
            return (config, sink) => new Mp4Muxer(config, sink);
        },
    },
    {
        kind: 'container',
        id: 'matroska',
        formats: ['mkv', 'webm'],
        load: async () => {
            const { WebMMuxer, validateMatroskaCodecConfigs } = await import('./matroska/writer');
            return (config, sink, options) => {
                if (!options?.deferCodecConfig) validateMatroskaCodecConfigs(config);
                return new WebMMuxer(config, sink);
            };
        },
    },
    {
        kind: 'container',
        id: 'ts',
        formats: ['ts'],
        load: async () => {
            const { TsMuxer } = await import('./mpeg-ts/writer');
            return (config, sink) => new TsMuxer(config, sink);
        },
    },
    // Sound encoded for an Ogg target: Opus or FLAC; copies of one track go to the audio writer.
    {
        kind: 'container',
        id: 'ogg',
        formats: ['ogg'],
        load: async () => {
            const { OggMuxer } = await import('./ogg/writer');
            return (config, sink) => new OggMuxer(config, sink);
        },
    },
    {
        kind: 'audio',
        id: 'audio-file',
        formats: ['aac', 'mp1', 'mp2', 'mp3', 'wav', 'aiff', 'au', 'caf', 'flac', 'ogg'],
        load: async () => (await import('./audio-files/copy')).createAudioCopyMuxer,
    },
];

/** The containers every composition reads and writes, fragmented MP4 through the CMAF writer. */
export const CORE_FORMATS: FormatParts = Object.freeze({
    readers: Object.freeze([
        mp4Reader,
        matroskaReader,
        tsReader,
        mpegAudioReader,
        mp3Reader,
        syncAudioReader,
        audioFileReader,
        flacReader,
        oggReader,
    ]),
    writers: Object.freeze(CORE_WRITERS),
    segments: lazySegmentWriter(async () => {
        const { CmafWriter } = await import('./mp4/write/cmaf');
        return options => new CmafWriter(options);
    }),
});
