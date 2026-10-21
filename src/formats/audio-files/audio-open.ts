import type { AudioIndexContext } from './index-context';
import type { StandaloneAudioDemuxOptions } from './demux-options';
import { id3MediaTags, id3Title } from '../metadata/id3';
import { id3v2Span } from '../detection/signatures';
import type { MediaTags } from '../../core/model/media';
import type { Source } from '../../core/model/types';
import type { DemuxResult, TrackInfo } from '../../core/model/track';
import { CHUNK_BYTES, ChunkReader, FIRST_CHUNK_BYTES } from '../../core/io/sources/chunk-reader';
import { PASS_START_BYTES } from '../../core/io/sources/cached-source';
import { awaitWithAbort } from '../../core/io/abort';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { DemuxError, MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { positiveLimit } from '../../core/errors/limits';
import { DemuxIndexBudget, resolveDemuxBudget } from '../shared/demux-budget';
import { yieldEventLoop } from '../../core/io/event-loop';
import { getCompactSampleIndex } from '../../core/model/sample-index';

// The options and the open of an audio file read (WAV, AIFF, AU, CAF, FLAC and Ogg), which the
// reader and the parts of it that FLAC and Ogg inputs run share.

/**
 * What an audio file is indexed with: the context of the input, and that of the stream after the
 * ID3v2 tags some taggers put in front of FLAC and Ogg files (`untag` moves the offsets of samples
 * indexed through it back to input offsets).
 */
export interface AudioIndex {
    readonly context: AudioIndexContext;
    readonly stream: AudioIndexContext;
    /** Bytes of the ID3v2 tags in front of the stream, whose offsets `stream` reads from. */
    readonly tagged: number;
    readonly untag: (tracks: TrackInfo[]) => void;
}

/**
 * Checks the options of an audio file read and reads the ID3v2 tags in front of the stream. A read
 * of a PCM file starts at one page, as it ends at its headers, and one of FLAC or Ogg, which reads
 * the whole stream, at PASS_START_BYTES; either goes on to chunks of 1 MiB, the next read while it
 * parses one; a description reads `chunkBytes`.
 */
export async function openAudioIndex(
    source: Source,
    options: StandaloneAudioDemuxOptions,
    chunkBytes = CHUNK_BYTES,
): Promise<AudioIndex> {
    const {
        format,
        signal,
        maxSamples: requestedSamples,
        maxIndexBytes,
        maxPacketBytes: requestedBytes,
        validation,
        onWarning,
        maxWarnings,
    } = options;
    const diagnostics = new DiagnosticContext({ validation, onWarning, maxWarnings }, 'compatible');
    if (
        !['wav', 'aiff', 'aif', 'aifc', 'au', 'caf', 'flac', 'ogg', 'ogv', 'oga', 'opus'].includes(
            format,
        )
    )
        throw new MediaForgeError(`Audio file format '${format}' is not supported`, 'FORMAT');
    const budget = new DemuxIndexBudget(
        resolveDemuxBudget({ maxSamples: requestedSamples, maxIndexBytes }, 2_000_000),
    );
    const maxPacketBytes = positiveLimit(requestedBytes, 16 * 1024 * 1024, 'maxPacketBytes');
    const check = (): void => {
        throwIfAborted(signal);
    };
    check();

    const whole = ['flac', 'ogg', 'ogv', 'oga', 'opus'].includes(format);
    const reader = new ChunkReader(
        source,
        chunkBytes,
        chunkBytes === CHUNK_BYTES,
        whole ? PASS_START_BYTES : FIRST_CHUNK_BYTES,
    );
    const context: AudioIndexContext = {
        size: reader.size,
        budget,
        maxPacketBytes,
        diagnostics,
        metadata: {},
        checkedOggPages: options.checkedOggPages,
        async read(offset, length) {
            check();
            if (
                !Number.isSafeInteger(offset) ||
                !Number.isSafeInteger(length) ||
                offset < 0 ||
                length < 0 ||
                offset > reader.size ||
                length > reader.size - offset
            )
                throw new DemuxError('Truncated audio structure');
            const bytes = await awaitWithAbort(reader.bytes(offset, length), signal);
            check();
            return bytes;
        },
        async checkpoint() {
            check();
            await awaitWithAbort(yieldEventLoop(), signal);
            check();
        },
    };
    let tagged = 0;
    if (format === 'flac' || format === 'ogg' || format === 'oga') {
        const lead = await leadingId3Tags(context.read, reader.size);
        tagged = lead.offset;
        if (lead.title !== undefined) context.metadata.title = lead.title;
        if (lead.tags) context.metadata.tags = lead.tags;
    }
    const stream: AudioIndexContext = tagged
        ? {
              ...context,
              size: reader.size - tagged,
              read: (offset, length) => context.read(offset + tagged, length),
          }
        : context;
    const untag = (tracks: TrackInfo[]): void => {
        if (tagged)
            for (const track of tracks) {
                const packets = getCompactSampleIndex(track) as
                    { moveOffsets?(bytes: number): void } | undefined;
                if (packets?.moveOffsets) packets.moveOffsets(tagged);
                else for (const sample of track.samples) if (!sample.data) sample.offset += tagged;
            }
    };
    return { context, stream, tagged, untag };
}

/** The largest leading ID3v2 tag read for the title and tags of the stream behind it. */
const MAX_LEADING_TAG_BYTES = 16 * 1024 * 1024;

/**
 * The ID3v2 tags some taggers put in front of an MP3, FLAC or Ogg stream, at most 16 of them: where
 * the stream starts, the title of the first that states one and the tags of the first read (tags
 * of up to 16 MiB are read). A tag that the end of the input cuts fails.
 */
export async function leadingId3Tags(
    read: (offset: number, length: number) => Promise<Uint8Array>,
    size: number,
): Promise<{ offset: number; title?: string; tags?: MediaTags }> {
    let offset = 0;
    let title: string | undefined;
    let tags: MediaTags | undefined;
    for (let count = 0; count < 16 && size - offset >= 10; count++) {
        const span = id3v2Span(await read(offset, 10));
        if (!span) break;
        if (span > size - offset) throw new DemuxError('Truncated ID3v2 tag');
        if (title === undefined && span <= MAX_LEADING_TAG_BYTES) {
            const bytes = await read(offset, span);
            title = id3Title(bytes);
            tags ??= id3MediaTags(bytes);
        }
        offset += span;
    }
    return { offset, title, tags };
}

/** The result of an audio file read: its one track, and the title and tags of the file. */
export function audioResult(context: AudioIndexContext, track: TrackInfo): DemuxResult {
    const { title, tags } = context.metadata;
    return {
        ...(title !== undefined ? { title } : {}),
        ...(tags ? { tags } : {}),
        videoTracks: [],
        audioTracks: [track],
    };
}
