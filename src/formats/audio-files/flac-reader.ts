import {
    DESCRIBED_AUDIO_BYTES,
    audioFileTrack,
    reportDamage,
    scanBatches,
    type AudioIndexContext,
} from './index-context';
import { narrowToPosition, type PlacedUnit } from '../shared/position-search';
import { MAX_TEXT_METADATA_BYTES } from '../metadata/metadata-text';
import { flacPicture, vorbisCommentTags, vorbisCommentTitle } from '../metadata/vorbis-comment';
import type { Source } from '../../core/model/types';
import type {
    DemuxResult,
    TrackInfo,
    ProbedInput,
    ProbeTarget,
    Sample,
    StreamedSample,
} from '../../core/model/track';
import { awaitWithAbort } from '../../core/io/abort';
import type { MediaDiagnostic, Warn } from '../../core/errors/diagnostics';
import { DemuxError, MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import {
    firstFlacFrame,
    flacCrc16Update,
    MAX_FLAC_FRAME_HEADER_BYTES,
    parseFlacFrameHeader,
    readFlacStreamInfo,
    type FlacFrameHeader,
} from '../../core/codec-config/audio/flac-frame';
import { bindCompactSampleIndex, getCompactSampleIndex } from '../../core/model/sample-index';
import { FlacFrameIndex } from './flac-index';
import { audioResult, openAudioIndex } from './audio-open';
import type { StandaloneAudioDemuxOptions } from './demux-options';
import {
    WINDOW_ATTEMPTS,
    WINDOW_MARGIN,
    probeWindows,
    readParts,
    sampleRun,
} from './audio-windows';
import { fourcc } from '../../core/bytes/byte-fields';

// The part of the audio file reader that FLAC inputs run, loaded with the first of them: the index
// of every frame, and the description of an input from its ends with the windows it opens later.

/**
 * The fLaC marker and a STREAMINFO block for FLAC frames that lost them (a stream cut from its
 * middle), taken from the first frame header, which states its sample rate, channels and bit depth;
 * block sizes and length stay unknown.
 */
async function headerlessFlac(
    context: AudioIndexContext,
): Promise<{ offset: number; config: Uint8Array } | undefined> {
    const head = await context.read(0, Math.min(context.size, 1 << 20));
    const at = firstFlacFrame(head);
    const header = at >= 0 ? parseFlacFrameHeader(head, at) : null;
    if (!header?.sampleRate || !header.bitsPerSample) return undefined;
    const { sampleRate: rate, channelCount: channels, bitsPerSample: bits } = header;
    const config = new Uint8Array(42);
    config.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, 0, 16, 0xff, 0xff]);
    config[18] = rate >> 12;
    config[19] = (rate >> 4) & 0xff;
    config[20] = ((rate & 15) << 4) | ((channels - 1) << 1) | ((bits - 1) >> 4);
    config[21] = ((bits - 1) & 15) << 4;
    return { offset: at, config };
}

/** The STREAMINFO of a FLAC stream and its metadata blocks, read up to the first frame. */
interface FlacStreamHeader {
    /** The fLaC marker and the STREAMINFO block. */
    readonly first: Uint8Array;
    readonly minBlock: number;
    readonly maxBlock: number;
    readonly minFrame: number;
    readonly maxFrame: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bits: number;
    /** Samples per channel STREAMINFO states, 0 when unknown. */
    readonly declaredSamples: number;
    /** Where the first frame starts. */
    readonly offset: number;
    /** The comment and picture blocks the codec configuration keeps. */
    readonly metadata: readonly { offset: number; size: number; type: number }[];
    readonly configSize: number;
}

/**
 * Reads the STREAMINFO and metadata blocks of a FLAC stream, its title, tags and pictures among
 * them; a stream that lost its header is read from its first frame under compatible validation.
 */
async function readFlacHeader(context: AudioIndexContext): Promise<FlacStreamHeader> {
    let first = await context.read(0, Math.min(42, context.size));
    const headerless =
        fourcc(first) !== 'fLaC' && context.diagnostics.validation === 'compatible'
            ? await headerlessFlac(context)
            : undefined;
    if (headerless) {
        first = headerless.config;
        reportDamage(
            context,
            'warn',
            'flac',
            'FLAC_HEADERLESS',
            headerless.offset,
            `FLAC has no fLaC header; read from the frame at byte ${headerless.offset}`,
        );
    }
    if (
        first.length < 42 ||
        fourcc(first) !== 'fLaC' ||
        (first[4]! & 127) !== 0 ||
        first[5] !== 0 ||
        first[6] !== 0 ||
        first[7] !== 34
    ) {
        throw new DemuxError('A FLAC file needs fLaC and a 34-byte STREAMINFO block');
    }
    const {
        minBlockSize: minBlock,
        maxBlockSize: maxBlock,
        minFrameSize: minFrame,
        maxFrameSize: maxFrame,
        sampleRate,
        channels,
        bitsPerSample: bits,
        totalSamples: declaredSamples,
    } = readFlacStreamInfo(first.subarray(8));
    if (
        minBlock < 16 ||
        maxBlock < minBlock ||
        sampleRate < 1 ||
        sampleRate > 655350 ||
        bits < 4 ||
        (minFrame > 0 && maxFrame > 0 && minFrame > maxFrame)
    )
        throw new DemuxError('Invalid FLAC STREAMINFO audio shape');
    let offset = headerless?.offset ?? 4;
    let blocks = 0;
    let singletons = 0;
    const metadata: { offset: number; size: number; type: number }[] = [];
    let configSize = 42;
    for (; !headerless;) {
        if (++blocks > 4096) throw new DemuxError('FLAC metadata chain exceeds 4096 blocks');
        const header = await context.read(offset, 4);
        const type = header[0]! & 127;
        const length = header[1]! * 65536 + header[2]! * 256 + header[3]!;
        if (type === 127 || (blocks > 1 && type === 0) || length > context.size - offset - 4)
            throw new DemuxError('Invalid or truncated FLAC metadata block');
        if (type === 3 || type === 4) {
            const flag = 1 << type;
            if (singletons & flag) throw new DemuxError('Repeated singleton FLAC metadata block');
            singletons |= flag;
        }
        if (
            type === 4 &&
            length <= MAX_TEXT_METADATA_BYTES &&
            context.metadata.title === undefined
        ) {
            const comments = await context.read(offset + 4, length);
            context.metadata.title = vorbisCommentTitle(comments);
            const tags = vorbisCommentTags(comments);
            if (tags)
                context.metadata.tags = {
                    ...tags,
                    ...(context.metadata.tags?.pictures
                        ? { pictures: context.metadata.tags.pictures }
                        : {}),
                };
        }
        if (type === 6 && length <= MAX_TEXT_METADATA_BYTES * 16) {
            const picture = flacPicture(await context.read(offset + 4, length));
            if (picture)
                context.metadata.tags = {
                    entries: context.metadata.tags?.entries ?? [],
                    ...context.metadata.tags,
                    pictures: [...(context.metadata.tags?.pictures ?? []), picture],
                };
        }
        if (type === 4 || type === 6) {
            if (length + 4 > 16 * 1024 * 1024 - configSize) {
                reportDamage(
                    context,
                    'recover',
                    'flac',
                    'FLAC_METADATA_LIMIT',
                    offset,
                    'FLAC comment or picture exceeds the 16 MiB metadata preservation budget',
                );
            } else {
                metadata.push({ offset, size: length + 4, type });
                configSize += length + 4;
            }
        }
        offset += 4 + length;
        if (header[0]! & 128) break;
        if ((blocks & 255) === 0) await context.checkpoint();
    }
    if (offset >= context.size) throw new DemuxError('FLAC contains no audio frames');
    return {
        first,
        minBlock,
        maxBlock,
        minFrame,
        maxFrame,
        sampleRate,
        channels,
        bits,
        declaredSamples,
        offset,
        metadata,
        configSize,
    };
}

/** The codec configuration of a FLAC stream: its STREAMINFO and the blocks it keeps. */
async function flacCodecConfig(
    context: AudioIndexContext,
    header: FlacStreamHeader,
): Promise<Uint8Array> {
    const { first, metadata, configSize } = header;
    const config = new Uint8Array(configSize);
    config.set(first);
    config[4] = metadata.length ? 0 : 128;
    let configOffset = 42;
    for (let index = 0; index < metadata.length; index++) {
        const block = metadata[index]!;
        config.set(await context.read(block.offset, block.size), configOffset);
        config[configOffset] = block.type | (index === metadata.length - 1 ? 128 : 0);
        configOffset += block.size;
    }
    return config;
}

/** Whether a frame header agrees with the STREAMINFO of its stream. */
function flacFrameFits(
    header: FlacFrameHeader | null,
    stream: FlacStreamHeader,
): header is FlacFrameHeader {
    return (
        !!header &&
        header.channelCount === stream.channels &&
        (header.sampleRate ?? stream.sampleRate) === stream.sampleRate &&
        (header.bitsPerSample ?? stream.bits) === stream.bits &&
        header.blockSize <= stream.maxBlock
    );
}

/** Reads a FLAC file: the index of every frame, after the ID3v2 tags some taggers put in front. */
export async function demuxFlac(
    source: Source,
    options: StandaloneAudioDemuxOptions,
): Promise<DemuxResult> {
    const { context, stream, untag } = await openAudioIndex(source, options);
    const track = await indexFlac(stream);
    throwIfAborted(options.signal);
    untag([track]);
    return audioResult(context, track);
}

/**
 * The track of a FLAC stream with the index of its frames, each verified by its CRC-16; `found`
 * receives each frame as it is indexed, with its bytes.
 */
async function indexFlac(
    context: AudioIndexContext,
    found?: (frame: Sample, data: Uint8Array) => void,
): Promise<TrackInfo> {
    const header = await readFlacHeader(context);
    const { minBlock, maxBlock, minFrame, maxFrame, sampleRate, declaredSamples } = header;
    let { offset } = header;
    const lenient = context.diagnostics.validation === 'compatible';
    const frameLimit = Math.min(context.maxPacketBytes, maxFrame || 4 * 1024 * 1024);
    const windowBytes = Math.min(
        64 * 1024 * 1024,
        Math.max(65536, frameLimit + MAX_FLAC_FRAME_HEADER_BYTES),
    );
    let windowStart = -1;
    let window: Uint8Array = new Uint8Array(0);
    const slide = async (at: number): Promise<void> => {
        windowStart = at;
        window = await context.read(at, Math.min(windowBytes, context.size - at));
    };
    /** Whether the window holds the frame at `at`, as far as a frame may reach. */
    const windowHolds = (at: number): boolean =>
        at >= windowStart &&
        Math.min(context.size, at + frameLimit + MAX_FLAC_FRAME_HEADER_BYTES) <=
            windowStart + window.length;
    const ensureWindow = async (at: number): Promise<number> => {
        if (!windowHolds(at)) await slide(at);
        return at - windowStart;
    };
    const consistent = (frame: FlacFrameHeader | null): frame is FlacFrameHeader =>
        flacFrameFits(frame, header);
    /**
     * The frame end is the next sync whose preceding two bytes are this frame's CRC-16, or the
     * input end when the remaining bytes verify as one frame. Returns -1 for a damaged or truncated
     * frame, and throws on the byte budget only under strict validation, where damage is not
     * recovered anyway.
     */
    const findFrameEnd = (relative: number, header: FlacFrameHeader): number => {
        const absolute = windowStart + relative;
        let candidates = 0;
        let crc = 0;
        let crcEnd = relative;

        // Sync candidates are the 0xFF bytes up to the frame limit, found natively instead of byte
        // by byte.
        const region = window.subarray(
            0,
            Math.max(0, Math.min(window.length - 5, relative + frameLimit + 1)),
        );
        for (let cursor = region.indexOf(255, relative + header.headerLen + 2); cursor >= 0;) {
            const at = cursor;
            cursor = region.indexOf(255, cursor + 1);
            if ((window[at + 1]! & 0xfc) !== 0xf8 || !parseFlacFrameHeader(window, at)) continue;
            if (++candidates > 64) {
                if (lenient) return -1;
                throw new DemuxError('FLAC frame boundary exceeds CRC candidate budget');
            }
            crc = flacCrc16Update(crc, window, crcEnd, at - 2);
            crcEnd = at - 2;
            if (crc === window[at - 2]! * 256 + window[at - 1]!) return windowStart + at;
        }
        const remaining = context.size - absolute;
        if (remaining > frameLimit) {
            if (lenient) return -1;

            // Only a caller budget below the stream's own frame limit is a resource error;
            // otherwise the data is damaged.
            if (context.maxPacketBytes < (maxFrame || 4 * 1024 * 1024))
                throw new MediaForgeError('FLAC frame exceeds maxPacketBytes', 'OOM');
            throw new DemuxError(
                `No verifiable FLAC frame boundary within the frame limit after byte ${absolute}`,
            );
        }
        if (remaining < header.headerLen + 2) {
            if (lenient) return -1;
            throw new DemuxError('Truncated FLAC frame');
        }
        const limit = relative + remaining;
        if (
            flacCrc16Update(crc, window, crcEnd, limit - 2) !==
            window[limit - 2]! * 256 + window[limit - 1]!
        ) {
            if (lenient) return -1;
            throw new DemuxError('FLAC frame CRC-16 mismatch');
        }
        return context.size;
    };
    const index = new FlacFrameIndex(sampleRate);
    // Frames between checkpoints, less one: a scan whose frames go out hands them over more often,
    // so the bytes they view are let go sooner.
    const between = found ? 63 : 255;
    let frames = 0;
    let strategy = -1;
    let fixedBlock = minBlock === maxBlock ? minBlock : 0;
    let recovered = false;
    let numberingWarned = false;
    let sizeWarned = false;

    /** Indexes the verified frame at `offset` that ends at `end`, and moves past it. */
    const addFrame = (header: FlacFrameHeader, end: number): void => {
        if (strategy < 0) strategy = header.blockingStrategy;
        if (!fixedBlock) fixedBlock = header.blockSize;
        const start = strategy ? header.codedNumber : header.codedNumber * fixedBlock;
        if (header.blockingStrategy !== strategy || start !== frames) {
            if (!lenient) throw new DemuxError('FLAC frame numbering is discontinuous');
            if (!numberingWarned) {
                numberingWarned = true;
                reportDamage(
                    context,
                    'warn',
                    'flac',
                    'FLAC_FRAME_NUMBER_GAP',
                    offset,
                    `FLAC frame at byte ${offset} skips samples; timing follows its number`,
                );
            }
            recovered = true;
            frames = start;
        }
        if (
            (end < context.size &&
                (header.blockSize < minBlock || (!strategy && header.blockSize !== fixedBlock))) ||
            (!strategy && header.blockSize > fixedBlock) ||
            (minFrame && end - offset < minFrame)
        ) {
            if (!lenient)
                throw new DemuxError(
                    'FLAC frame size disagrees with STREAMINFO or blocking strategy',
                );
            if (!sizeWarned) {
                sizeWarned = true;
                reportDamage(
                    context,
                    'warn',
                    'flac',
                    'FLAC_FRAME_SIZE',
                    offset,
                    'FLAC frame sizes disagree with STREAMINFO; using the frame headers',
                );
            }
        }
        context.budget.reserveSamples(1, 256, 'FLAC sample index');
        index.push(offset, end - offset, frames, header.blockSize);
        found?.(
            index.get(index.length - 1),
            window.subarray(offset - windowStart, end - windowStart),
        );
        frames += header.blockSize;
        if (!Number.isSafeInteger(frames))
            throw new DemuxError('FLAC sample count exceeds exact integer range');
        offset = end;
    };

    /**
     * Indexes frames from `offset` while the window holds them and they verify, up to the next
     * checkpoint, without a promise per frame and outside the async loop, whose code V8 does not
     * optimize while it runs. The loop takes over where a window is to be read or a frame is
     * damaged.
     */
    const addWindowFrames = (): void => {
        while (offset < context.size && windowHolds(offset)) {
            const relative = offset - windowStart;
            const header = parseFlacFrameHeader(window, relative);
            if (!consistent(header)) return;
            const end = findFrameEnd(relative, header);
            if (end < 0) return;
            addFrame(header, end);
            if ((index.length & between) === 0) return;
        }
    };

    while (offset < context.size) {
        if ((index.length & between) === 0) await context.checkpoint();
        const indexed = index.length;
        addWindowFrames();
        if (offset >= context.size) break;
        if (index.length !== indexed && (index.length & between) === 0) continue;
        let relative = await ensureWindow(offset);
        let header = parseFlacFrameHeader(window, relative);
        let end = consistent(header) ? findFrameEnd(relative, header) : -1;
        if (!consistent(header) || end < 0) {
            if (!lenient) throw new DemuxError(`Invalid FLAC frame configuration at ${offset}`);

            // Resynchronize on the next verified frame; each candidate must parse, match STREAMINFO
            // and CRC-check.
            let next = -1;
            for (let scan = offset + 1; scan < context.size - 6 && next < 0;) {
                if ((scan & 0xfffff) === 0) await context.checkpoint();
                if (
                    scan < windowStart ||
                    scan + MAX_FLAC_FRAME_HEADER_BYTES > windowStart + window.length
                )
                    await slide(scan);
                const cursor = scan - windowStart;
                if (window[cursor] === 255 && (window[cursor + 1]! & 0xfc) === 0xf8) {
                    const candidate = parseFlacFrameHeader(window, cursor);
                    if (consistent(candidate)) {
                        const at = await ensureWindow(scan);
                        const candidateEnd = findFrameEnd(at, candidate);
                        if (candidateEnd >= 0) {
                            next = scan;
                            header = candidate;
                            end = candidateEnd;
                            relative = at;
                        }
                    }
                }
                scan++;
            }
            recovered = true;
            if (next < 0) {
                if (!index.length) throw new DemuxError('FLAC contains no complete audio frames');
                reportDamage(
                    context,
                    'warn',
                    'flac',
                    'FLAC_TRUNCATED_TAIL',
                    offset,
                    `Ignored ${context.size - offset} damaged bytes at the end`,
                );
                break;
            }
            reportDamage(
                context,
                'warn',
                'flac',
                'FLAC_RESYNCHRONIZED',
                offset,
                `Skipped ${next - offset} damaged bytes; resumed at byte ${next}`,
            );
            offset = next;
        }
        if (!consistent(header))
            throw new DemuxError(`Invalid FLAC frame configuration at ${offset}`);
        addFrame(header, end);
    }
    if (declaredSamples && declaredSamples !== frames) {
        context.diagnostics.recover(
            {
                code: 'FLAC_SAMPLE_COUNT',
                format: 'flac',
                offset: 8,
                message:
                    `STREAMINFO declares ${declaredSamples} samples but the frames hold ` +
                    `${frames}`,
            },
            'FLAC decoded sample count disagrees with STREAMINFO',
        );
        recovered = true;
    }
    const track = await flacTrack(context, header, frames);
    if (recovered) track.incomplete = true;
    index.finish();
    bindCompactSampleIndex(track, index);
    return track;
}

/** Bytes read at the end of a FLAC input for its last frame when STREAMINFO states no largest. */
const FLAC_PROBE_BYTES = 1024 * 1024;

/**
 * The last frame of a FLAC stream in `tail`, the bytes before the end of the input: the frame
 * header nearest the end that agrees with STREAMINFO and whose CRC-16 matches the bytes from it to
 * the end.
 */
function lastFlacFrame(
    tail: Uint8Array,
    stream: FlacStreamHeader,
): { readonly at: number; readonly header: FlacFrameHeader } | undefined {
    const end = tail.length;
    if (end < 2) return undefined;
    const crc = tail[end - 2]! * 256 + tail[end - 1]!;
    const before = (at: number): number => (at > 0 ? tail.lastIndexOf(255, at - 1) : -1);
    for (let at = tail.lastIndexOf(255, end - 3); at >= 0; at = before(at)) {
        const header = fittingFrameAt(tail, at, stream);
        if (!header || end - at < header.headerLen + 2) continue;
        if (flacCrc16Update(0, tail, at, end - 2) === crc) return { at, header };
    }
    return undefined;
}

/** The header of a frame of `stream` at the 0xFF byte `at` of `bytes`, or null. */
function fittingFrameAt(
    bytes: Uint8Array,
    at: number,
    stream: FlacStreamHeader,
): FlacFrameHeader | null {
    const header = parseFlacFrameHeader(bytes, at);
    return flacFrameFits(header, stream) ? header : null;
}

/**
 * The track of a FLAC stream from its header and its first and last frames (see probeFlac), or
 * undefined when they do not describe it.
 */
/** A FLAC stream described from its ends: its track, header and the frame numbering it uses. */
interface DescribedFlac {
    readonly track: TrackInfo;
    readonly header: FlacStreamHeader;
    /** 1 for frames numbered by their first sample, 0 for frames numbered in blocks. */
    readonly strategy: number;
    readonly fixedBlock: number;
}

async function describeFlac(context: AudioIndexContext): Promise<DescribedFlac | undefined> {
    if (context.size < 4 || fourcc(await context.read(0, 4)) !== 'fLaC') return undefined;
    const header = await readFlacHeader(context);
    const { minBlock, maxBlock, minFrame, maxFrame, declaredSamples, offset } = header;
    if (!declaredSamples) return undefined;
    const lead = await context.read(
        offset,
        Math.min(MAX_FLAC_FRAME_HEADER_BYTES, context.size - offset),
    );
    const opening = fittingFrameAt(lead, 0, header);
    if (!opening || opening.codedNumber !== 0) return undefined;
    const strategy = opening.blockingStrategy;
    const fixedBlock = minBlock === maxBlock ? minBlock : opening.blockSize;
    const reach = Math.min(context.size - offset, maxFrame || FLAC_PROBE_BYTES);
    const tail = await context.read(context.size - reach, reach);
    const closing = lastFlacFrame(tail, header);
    if (!closing) return undefined;
    const last = closing.header;
    const lastBytes = tail.length - closing.at;
    const end = (strategy ? last.codedNumber : last.codedNumber * fixedBlock) + last.blockSize;
    const frameLimit = Math.min(context.maxPacketBytes, maxFrame || 4 * 1024 * 1024);
    const shapes =
        opening.blockSize >= minBlock &&
        (strategy || (opening.blockSize === fixedBlock && last.blockSize <= fixedBlock)) &&
        (!minFrame || lastBytes >= minFrame) &&
        lastBytes <= frameLimit;
    if (last.blockingStrategy !== strategy || end !== declaredSamples || !shapes) return undefined;
    return { track: await flacTrack(context, header, end), header, strategy, fixedBlock };
}

/** The track of a FLAC stream of `samples` samples. */
async function flacTrack(
    context: AudioIndexContext,
    header: FlacStreamHeader,
    samples: number,
): Promise<TrackInfo> {
    return audioFileTrack(
        'flac',
        await flacCodecConfig(context, header),
        header.sampleRate,
        header.channels,
        samples,
    );
}

/**
 * Describes a FLAC input from its ends when inspecting it, as a read of every frame does but
 * without counting them: STREAMINFO states the samples, the first frame starts their numbering, and
 * the last frame, whole to the end of the input with a matching CRC-16, ends at the stated count,
 * both frames agreeing with STREAMINFO. With `around`, the result holds the frames from before
 * `around` through after `through` (see flacWindow). Strict validation, inputs under
 * DESCRIBED_AUDIO_BYTES, a stream without the fLaC header or a sample count, and any other layout
 * read every frame; so does a range's read, and a stream's but for packets() alone (packetsOnly),
 * which streams the frames as the index finds them (streamFlac).
 */
export async function probeFlac(
    source: Source,
    options: StandaloneAudioDemuxOptions,
    target: ProbeTarget = {},
): Promise<ProbedInput | undefined> {
    if (target.range || (target.stream && !target.packetsOnly)) return undefined;
    if (options.validation === 'strict' || source.size < DESCRIBED_AUDIO_BYTES) return undefined;
    const warnings: MediaDiagnostic[] = [];
    try {
        const { context, stream } = await openAudioIndex(
            source,
            {
                ...options,
                onWarning: warning => void warnings.push(warning),
                maxWarnings: undefined,
            },
            65536,
        );
        const described = await describeFlac(stream);
        if (!described) return undefined;
        const probed = await probeWindows(
            source,
            options,
            target,
            // Frame offsets are the input's without a tag in front.
            async (windowOptions, around, through) =>
                stream === context
                    ? flacWindow(source, windowOptions, described, around, through)
                    : undefined,
            async () => audioResult(context, described.track),
        );
        if (probed) for (const warning of warnings) options.onWarning?.(warning);
        return probed && target.stream
            ? {
                  ...probed,
                  stream: (signal, warn) => streamFlac(source, options, warnings, signal, warn),
              }
            : probed;
    } catch (error) {
        if (error instanceof DemuxError) return undefined;
        throw error;
    }
}

/**
 * The frames of a described FLAC input in one pass, as its index gives them: the index is read as
 * a read of the whole input reads it, and the frames it has found are handed over at each of its
 * checkpoints, with views of the bytes it read them from. The warnings of the description
 * (`described`) are not reported again, as a read of the index leaves them out.
 */
async function* streamFlac(
    source: Source,
    options: StandaloneAudioDemuxOptions,
    described: readonly MediaDiagnostic[],
    signal?: AbortSignal,
    warn?: Warn,
): AsyncGenerator<StreamedSample[]> {
    const key = (warning: Omit<MediaDiagnostic, 'severity'>): string =>
        JSON.stringify([warning.code, warning.message, warning.offset, warning.trackId]);
    const known = new Set(described.map(key));
    const { stream, tagged } = await openAudioIndex(source, {
        ...options,
        signal,
        onWarning: warning => {
            if (!known.has(key(warning))) warn?.(warning);
        },
    });
    yield* scanBatches<StreamedSample>(async handOver => {
        let found: StreamedSample[] = [];
        const ready = async (): Promise<void> => {
            const batch = found;
            found = [];
            if (batch.length) await handOver(batch);
        };
        const scan: AudioIndexContext = {
            ...stream,
            async checkpoint() {
                await stream.checkpoint();
                await ready();
            },
        };
        await indexFlac(scan, (frame, data) =>
            found.push({ track: 0, sample: { ...frame, offset: frame.offset + tagged, data } }),
        );
        await ready();
    });
}

/** Bytes a search for FLAC frame headers reads at a time. */
const FLAC_SEEK_BYTES = 16 * 1024;

/** Probes a search for a FLAC frame takes at most (see narrowToPosition). */
const FLAC_SEEK_PROBES = 64;

/** A frame header found in the input: where it starts, the first sample it holds and how many. */
interface FoundFlacFrame extends PlacedUnit {
    readonly blockSize: number;
}

/**
 * The frames of a described FLAC input from before `around` through after `through` seconds, as a
 * read of every frame holds them: frame headers state their first sample, so a search over the
 * input (narrowToPosition, each probe reading FLAC_SEEK_BYTES and taking the first header that
 * agrees with STREAMINFO, then a walk over frames that succeed each other exactly) finds the frame
 * before `around` and the one after `through`, and the frames between them are read after the
 * header as a read of every frame reads them, their CRC-16 checked. A window that does not reach
 * `around` is moved further back; undefined when the frames cannot be found or the window is
 * damaged.
 */
async function flacWindow(
    source: Source,
    options: StandaloneAudioDemuxOptions,
    { track, header, strategy, fixedBlock }: DescribedFlac,
    around: number,
    through: number,
): Promise<ProbedInput | undefined> {
    const { size } = source;
    const rate = header.sampleRate;
    const from = around;
    const to = Math.max(from, through);
    /** The bytes a frame header is looked for in: a frame and a header. */
    const reach = (header.maxFrame || FLAC_PROBE_BYTES) + MAX_FLAC_FRAME_HEADER_BYTES;
    /** The first frame header at or after `at`, before `limit`, that agrees with the stream. */
    const frameFrom = async (at: number, limit: number): Promise<FoundFlacFrame | null> => {
        for (let base = at; base < limit; base += FLAC_SEEK_BYTES) {
            const length = Math.min(FLAC_SEEK_BYTES + MAX_FLAC_FRAME_HEADER_BYTES, size - base);
            const bytes = await awaitWithAbort(source.read(base, length), options.signal);
            const scan = Math.min(FLAC_SEEK_BYTES, limit - base, bytes.length - 1);
            for (let index = bytes.indexOf(255); index >= 0 && index < scan;) {
                const frame = fittingFrameAt(bytes, index, header);
                if (frame?.blockingStrategy === strategy) {
                    const position = strategy ? frame.codedNumber : frame.codedNumber * fixedBlock;
                    return { offset: base + index, position, blockSize: frame.blockSize };
                }
                index = bytes.indexOf(255, index + 1);
            }
        }
        return null;
    };
    /** The last frame from `first` on that starts at or before sample `sample`, and the next. */
    const bracket = async (
        first: FoundFlacFrame,
        sample: number,
    ): Promise<{ before: FoundFlacFrame; after?: FoundFlacFrame } | undefined> => {
        const narrowed = await narrowToPosition(
            {
                from: first.offset,
                to: size,
                fromPosition: first.position,
                toPosition: header.declaredSamples,
            },
            sample + 1,
            FLAC_SEEK_BYTES,
            FLAC_SEEK_PROBES,
            (at, limit) => frameFrom(at, Math.min(limit, at + reach)),
            // Frame numbers that fall as the offsets rise are another stream's.
            (earlier, later) => earlier.position < later.position,
        );
        if (!narrowed) return undefined;
        let before = narrowed.below ?? first;
        for (let at = before.offset + 1; ;) {
            const next = await frameFrom(at, Math.min(size, before.offset + reach));
            if (!next) return before.offset + reach >= size ? { before } : undefined;

            // A header that does not continue the numbering is a sync pattern inside a frame.
            if (next.position !== before.position + before.blockSize) at = next.offset + 1;
            else if (next.position > sample) return { before, after: next };
            else {
                before = next;
                at = next.offset + 1;
            }
        }
    };
    const first = await frameFrom(header.offset, header.offset + 1);
    if (first?.position !== 0) return undefined;
    let margin = WINDOW_MARGIN;
    for (let attempt = 0; attempt < WINDOW_ATTEMPTS; attempt++, margin *= 4) {
        const opening = await bracket(first, Math.floor((from - margin) * rate));
        const closing = opening && (await bracket(opening.before, Math.ceil((to + margin) * rate)));
        if (!opening || !closing) return undefined;
        const begin = opening.before.offset;
        const end = closing.after?.offset ?? size;

        // The frames left out before the window and after it are what the read reports.
        const read = await readParts(
            demuxFlac,
            source,
            options,
            [
                { from: 0, to: header.offset },
                { from: begin, to: end },
            ],
            ({ code, offset }) =>
                (code === 'FLAC_FRAME_NUMBER_GAP' && offset === header.offset) ||
                (code === 'FLAC_SAMPLE_COUNT' && end < size),
        );
        const window = read?.result.audioTracks[0];
        const frames = window && getCompactSampleIndex(window);
        if (!read || !window || !frames || !frames.length) return undefined;
        const last = frames.get(frames.length - 1);
        if (
            frames.timestampAt(0) <= from &&
            (end === size || last.timestamp + last.duration >= to)
        ) {
            window.duration = track.duration;
            bindCompactSampleIndex(
                window,
                sampleRun(frames, 0, frames.length, begin - header.offset),
            );
            const fromStart = begin === header.offset;
            return { result: read.result, packets: true, start: 0, fromStart };
        }
    }
    return undefined;
}
