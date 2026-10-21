import type { Source } from '../../core/model/types';
import type { DemuxResult, ProbedInput, ProbeTarget } from '../../core/model/track';
import { CHUNK_BYTES, ChunkReader } from '../../core/io/sources/chunk-reader';
import {
    adtsProgramConfig,
    parseAdtsFrameHeader,
    buildAacConfig,
} from '../../core/codec-config/audio/adts';
import {
    MP3_DECODER_DELAY,
    isMpegAudioTrailerHeader,
    parseMpegAudioHeader,
    parseMpegGaplessInfo,
    type MpegGaplessInfo,
} from '../../core/codec-config/audio/mpeg-audio-header';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { awaitWithAbort } from '../../core/io/abort';
import { DemuxError, MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { DemuxIndexBudget, resolveDemuxBudget } from '../shared/demux-budget';
import { yieldEventLoop } from '../../core/io/event-loop';
import { bindCompactSampleIndex } from '../../core/model/sample-index';
import { leadingId3Tags } from './audio-open';
import { AudioFrameTable, DESCRIBED_AUDIO_BYTES, audioFileTrack } from './index-context';
import type { RawAudioDemuxOptions } from './demux-options';

class UnsupportedAdtsLayoutError extends DemuxError {
    constructor() {
        super('ADTS channel configuration 0 without a program config is not supported');
    }
}

/**
 * The frames of an MPEG audio or ADTS stream in typed arrays, 10 bytes each: where each frame's
 * payload starts and its size. Every frame of a stream holds the same number of samples (its layer
 * and sample rate fix it, and a frame of another rate is damage), so times follow from positions.
 */
class AudioFrameIndex extends AudioFrameTable {
    static readonly BYTES_PER_FRAME = 10;
    private readonly frameDuration: number;

    constructor(
        private readonly frameSamples: number,
        private readonly sampleRate: number,
        capacity: number,
    ) {
        super(new Uint16Array(capacity), capacity);
        this.frameDuration = frameSamples / sampleRate;
    }

    get byteLength(): number {
        return this.length * AudioFrameIndex.BYTES_PER_FRAME;
    }

    /** Appends the frame whose payload of `size` bytes starts at input byte `offset`. */
    push(offset: number, size: number): void {
        this.append(offset, size);
    }

    timestampAt(index: number): number {
        return (index * this.frameSamples) / this.sampleRate;
    }

    durationAt(): number {
        return this.frameDuration;
    }
}

type ReadBytes = (offset: number, count: number) => Promise<Uint8Array>;

/**
 * Borrowed views of `source` read through aligned chunks of `chunkBytes`, checked for
 * cancellation; with `readAhead` a scan reads the next chunk while it parses one.
 */
function chunkedReads(
    source: Source,
    signal: AbortSignal | undefined,
    chunkBytes: number,
    readAhead: boolean,
): ReadBytes {
    const reader = new ChunkReader(source, chunkBytes, readAhead);
    return async (offset, count) => {
        throwIfAborted(signal);
        return awaitWithAbort(reader.bytes(offset, count), signal);
    };
}

/**
 * The trim a LAME tag states for an MP3 stream of `frameSamples` coded samples (decoders add their
 * own 529-sample delay to the encoder delay), or the warning when none applies.
 */
function mp3Trim(
    gapless: MpegGaplessInfo | undefined,
    frameSamples: number,
): { readonly priming: number; readonly trailing: number } | { readonly warning: string } {
    const priming =
        gapless?.encoderDelay === undefined ? undefined : gapless.encoderDelay + MP3_DECODER_DELAY;
    const trailing =
        gapless?.padding === undefined
            ? undefined
            : Math.max(0, gapless.padding - MP3_DECODER_DELAY);
    if (priming !== undefined && trailing !== undefined && priming + trailing < frameSamples)
        return { priming, trailing };
    return {
        warning: gapless
            ? 'Ignored a Xing/LAME gapless trim longer than the audio'
            : 'No Xing/LAME gapless data; all coded frames are presented',
    };
}

/** Indexes ADTS/MPEG access units without decoding or retaining their payloads. */
export async function demuxRawAudio(
    source: Source,
    options: RawAudioDemuxOptions,
): Promise<DemuxResult> {
    const diagnostics = new DiagnosticContext(options, 'compatible');
    if (!['aac', 'mp1', 'mp2', 'mp3'].includes(options.format))
        throw new MediaForgeError(
            `Raw audio format '${options.format}' is not supported`,
            'FORMAT',
        );
    const budget = new DemuxIndexBudget(resolveDemuxBudget(options, 2_000_000));
    const read = chunkedReads(source, options.signal, CHUNK_BYTES, true);
    const lead = await leadingId3Tags(read, source.size);
    let { offset, title } = lead;
    let index: AudioFrameIndex | undefined;
    let sampleRate = 0;
    let channels = 0;
    /**
     * Channels of the program config element that ADTS frames with channel configuration 0 carry.
     */
    let programChannels = 0;
    let modeChangeReported = false;
    let damaged = false;
    let codec = options.format as string;
    let codecConfig: Uint8Array | undefined;
    let frameSamples = 0;
    let gapless: MpegGaplessInfo | undefined;
    let window: Uint8Array = new Uint8Array(0);
    let windowStart = offset;
    const frames = (): number => index?.length ?? 0;
    /**
     * After damage at the offset: where the next verified frame chain starts, with the bytes
     * skipped reported by `skipped`, or -1 with the damaged tail reported.
     */
    const resync = async (skipped: (next: number) => string): Promise<number> => {
        const next = await findAudioFrameChain(
            read,
            source.size,
            offset + 1,
            options.format,
            sampleRate,
            programChannels ? 0 : channels,
            codec,
        );
        if (next < 0) {
            if (!frames()) throw new DemuxError('No complete audio frames');
            diagnostics.recover({
                code: 'AUDIO_TRUNCATED_TAIL',
                format: options.format,
                offset,
                message: `Ignored a damaged audio tail at byte ${offset}`,
            });
            return next;
        }

        // Bytes skipped between frames are lost audio; the frames around them may not decode.
        damaged ||= frames() > 0;
        diagnostics.recover({
            code: options.format === 'aac' ? 'ADTS_RESYNCHRONIZED' : 'MPEG_RESYNCHRONIZED',
            format: options.format,
            offset,
            message: skipped(next),
        });
        return next;
    };
    while (offset < source.size) {
        if ((frames() & 1023) === 0) await yieldEventLoop();
        throwIfAborted(options.signal);
        if (offset + Math.min(10, source.size - offset) > windowStart + window.length) {
            windowStart = offset;
            window = await read(offset, 65536 + 10);
            throwIfAborted(options.signal);
        }
        const headerOffset = offset - windowStart;
        if (
            window[headerOffset] !== 255 &&
            isMpegAudioTrailerHeader(window.subarray(headerOffset), source.size - offset)
        )
            break;
        const adts = options.format === 'aac' ? parseAdtsFrameHeader(window, headerOffset) : null;
        const mpeg = options.format !== 'aac' ? parseMpegAudioHeader(window, headerOffset) : null;
        if (adts?.channels === 0 && !programChannels && adts.frameLength <= source.size - offset) {
            const frame =
                headerOffset + adts.frameLength <= window.length
                    ? window.subarray(headerOffset, headerOffset + adts.frameLength)
                    : await read(offset, adts.frameLength);
            const program = adtsProgramConfig(frame, adts);
            if (!program) throw new UnsupportedAdtsLayoutError();
            programChannels = program.channels;
            codecConfig = program.config;
        }
        if (adts && adts.rawDataBlocks !== 0)
            throw new DemuxError('ADTS multiple raw_data_blocks require an external parser');
        if (mpeg && mpeg.format !== options.format)
            throw new DemuxError('MPEG audio layer changes within the stream');
        const length = adts?.frameLength ?? mpeg?.frameLength ?? 0;
        if ((!adts && !mpeg) || length > source.size - offset) {
            if (diagnostics.validation === 'strict') {
                throw new DemuxError(
                    `${length ? 'Truncated' : 'Invalid'} ${options.format} frame at ${offset}`,
                );
            }
            const next = await resync(
                next => `Skipped ${next - offset} damaged bytes; resumed at byte ${next}`,
            );
            if (next < 0) break;
            offset = next;
            continue;
        }
        if (mpeg && options.format === 'mp3' && !frames() && gapless === undefined) {
            const frame =
                headerOffset + length <= window.length
                    ? window.subarray(headerOffset, headerOffset + length)
                    : await read(offset, length);
            const info = parseMpegGaplessInfo(frame);
            if (info) {
                gapless = info;
                offset += length;
                continue;
            }
        }
        const rate = adts?.sampleRate ?? mpeg!.sampleRate;
        const channelCount = adts ? adts.channels || programChannels : mpeg!.channels;
        const frameCodec = adts ? `mp4a.40.${adts.audioObjectType}` : codec;

        // MPEG audio headers state each frame's channel mode, and streams may switch between mono
        // and stereo.
        const channelsChange = channels !== channelCount && !mpeg;
        if (frames() && (sampleRate !== rate || channelsChange || codec !== frameCodec)) {
            if (diagnostics.validation === 'strict')
                throw new DemuxError('Raw audio codec configuration changes within the stream');

            // A header whose configuration disagrees with the stream is damage; resume at the next
            // verified chain.
            const next = await resync(
                next =>
                    `Skipped ${next - offset} bytes of mismatched frames; resumed at byte ${next}`,
            );
            if (next < 0) break;
            offset = next;
            continue;
        }
        sampleRate = rate;
        if (mpeg && frames() && channelCount !== channels && !modeChangeReported) {
            modeChangeReported = true;
            diagnostics.warn({
                code: 'MPEG_CHANNEL_MODE_CHANGED',
                format: options.format,
                offset,
                message: `MPEG audio switches from ${channels} to ${channelCount} channels`,
            });
        }
        channels = mpeg ? Math.max(channels, channelCount) : channelCount;
        codec = frameCodec;
        if (adts && !codecConfig)
            codecConfig = buildAacConfig(rate, channelCount, adts.audioObjectType);
        const durationSamples = adts ? 1024 : mpeg!.samplesPerFrame;
        const skip = adts?.headerLength ?? 0;
        budget.reserveSamples(1, AudioFrameIndex.BYTES_PER_FRAME, 'Raw audio sample index');
        index ??= new AudioFrameIndex(
            durationSamples,
            rate,
            Math.min(Math.ceil((source.size - offset) / length) + 16, 65536),
        );
        index.push(offset + skip, length - skip);
        frameSamples += durationSamples;
        offset += length;
    }
    if (!index) throw new DemuxError('No complete audio frames');
    let audioPrimingSamples: number | undefined;
    let audioTrailingPaddingSamples: number | undefined;
    if (options.format === 'mp3') {
        const trim = mp3Trim(gapless, frameSamples);
        if ('warning' in trim)
            diagnostics.warn({
                code: 'MPEG_GAPLESS_METADATA',
                format: options.format,
                message: trim.warning,
            });
        else {
            audioPrimingSamples = trim.priming;
            audioTrailingPaddingSamples = trim.trailing;
        }
    }
    throwIfAborted(options.signal);

    // An ID3v1 tag occupies the last 128 bytes even when a cut final frame runs into it, as ffmpeg
    // reads it.
    if (title === undefined && source.size >= 128)
        title = id3v1Title(await read(source.size - 128, 128));
    const track = audioFileTrack(codec, codecConfig, sampleRate, channels, frameSamples, {
        audioPrimingSamples,
        audioTrailingPaddingSamples,
        ...(damaged ? { incomplete: true } : {}),
    });
    index.finish();
    bindCompactSampleIndex(track, index);
    return {
        ...(title !== undefined ? { title } : {}),
        ...(lead.tags ? { tags: lead.tags } : {}),
        videoTracks: [],
        audioTracks: [track],
    };
}

/** Bytes read at each end of an MP3 that is described: its first frames, and its last ones. */
const MP3_PROBE_BYTES = 32 * 1024;

/** Whole frames the description of an MP3 reads at each end of the stream. */
const MP3_PROBE_FRAMES = 3;

/**
 * The whole MP3 frames at `sampleRate` from `at` in `bytes`, until a frame does not parse or is
 * cut, or `closes` is true after one: where they end, how many, their channel count (0 when it
 * changes) and whether `closes` ended them.
 */
function frameRun(
    bytes: Uint8Array,
    at: number,
    sampleRate: number,
    closes: (position: number) => boolean,
): { end: number; frames: number; channels: number; closed: boolean } {
    let end = at;
    let frames = 0;
    let channels = -1;
    while (!closes(end)) {
        const header = parseMpegAudioHeader(bytes, end);
        if (
            header?.format !== 'mp3' ||
            header.sampleRate !== sampleRate ||
            header.frameLength > bytes.length - end
        )
            return { end, frames, channels, closed: false };
        channels = channels < 0 || channels === header.channels ? header.channels : 0;
        end += header.frameLength;
        frames++;
    }
    return { end, frames, channels, closed: true };
}

/**
 * Describes an MP3 from its ends when inspecting it, as a read of every frame does but without
 * counting them: the Xing/Info or VBRI frame that opens the stream states its frames and the bytes
 * from that frame on, and the description stands when those bytes run to whole frames that end
 * where a read of every frame stops (the input's end or the tags after the audio), the frames at
 * both ends sharing one rate and channel count, and the stated frames fit those bytes. Strict
 * validation, other formats and targets, inputs under DESCRIBED_AUDIO_BYTES and any other layout
 * read every frame.
 */
export async function probeRawAudio(
    source: Source,
    options: RawAudioDemuxOptions,
    target: ProbeTarget = {},
): Promise<ProbedInput | undefined> {
    if (options.format !== 'mp3' || target.stream || target.range || target.around !== undefined)
        return undefined;
    const diagnostics = new DiagnosticContext(options, 'compatible');
    const size = source.size;
    if (diagnostics.validation === 'strict' || size < DESCRIBED_AUDIO_BYTES) return undefined;
    const read = chunkedReads(source, options.signal, 65536, false);
    let lead: Awaited<ReturnType<typeof leadingId3Tags>>;
    try {
        lead = await leadingId3Tags(read, size);
    } catch (error) {
        if (error instanceof DemuxError) return undefined;
        throw error;
    }
    if (size - lead.offset <= 2 * MP3_PROBE_BYTES) return undefined;
    const head = await read(lead.offset, MP3_PROBE_BYTES);
    const first = parseMpegAudioHeader(head, 0);
    if (!first || first.format !== 'mp3') return undefined;
    const info = parseMpegGaplessInfo(head.subarray(0, first.frameLength));
    if (!info?.frames || !info.bytes) return undefined;
    const audio = parseMpegAudioHeader(head, first.frameLength);
    if (!audio) return undefined;
    const { sampleRate, samplesPerFrame } = audio;
    const opening = frameRun(head, first.frameLength, sampleRate, () => false);
    const tailStart = size - MP3_PROBE_BYTES;
    const tail = await read(tailStart, MP3_PROBE_BYTES);

    // The last frames end where a read of every frame stops: at the end of the input or at the tags
    // after the audio.
    const closes = (position: number): boolean =>
        position === tail.length ||
        (tail[position] !== 255 &&
            isMpegAudioTrailerHeader(tail.subarray(position), MP3_PROBE_BYTES - position));
    let closing = { end: 0, frames: 0, channels: 0, closed: false };
    for (let at = tail.indexOf(255); at >= 0 && !closing.closed; at = tail.indexOf(255, at + 1)) {
        closing = frameRun(tail, at, sampleRate, closes);
        if (closing.frames < MP3_PROBE_FRAMES) closing.closed = false;
    }
    const channels = opening.channels;
    if (
        opening.frames < MP3_PROBE_FRAMES ||
        !closing.closed ||
        closing.channels !== channels ||
        !channels
    )
        return undefined;

    // The stated bytes reach from the information frame to the end of the audio (or of the input),
    // and the stated frames fit them at the rates the layer allows.
    const end = tailStart + closing.end;
    const audioBytes = end - lead.offset - first.frameLength;
    const [lowest, highest] = samplesPerFrame === 1152 ? [32, 320] : [8, 160];
    const frameBytes = (kbps: number): number => (samplesPerFrame * 125 * kbps) / sampleRate;
    if (
        (info.bytes !== end - lead.offset && info.bytes !== size - lead.offset) ||
        audioBytes < info.frames * Math.floor(frameBytes(lowest)) ||
        audioBytes > info.frames * (Math.floor(frameBytes(highest)) + 1)
    )
        return undefined;
    const frameSamples = info.frames * samplesPerFrame;
    const trim = mp3Trim(info, frameSamples);
    const title = lead.title ?? id3v1Title(tail.subarray(tail.length - 128));
    const track = audioFileTrack('mp3', undefined, sampleRate, channels, frameSamples, {
        audioPrimingSamples: 'warning' in trim ? undefined : trim.priming,
        audioTrailingPaddingSamples: 'warning' in trim ? undefined : trim.trailing,
    });
    if ('warning' in trim)
        diagnostics.warn({ code: 'MPEG_GAPLESS_METADATA', format: 'mp3', message: trim.warning });
    return {
        result: {
            ...(title !== undefined ? { title } : {}),
            ...(lead.tags ? { tags: lead.tags } : {}),
            videoTracks: [],
            audioTracks: [track],
        },
        packets: false,
    };
}

/** The 30-byte title of a trailing ID3v1 tag, decoded as ISO-8859-1 without NUL padding. */
function id3v1Title(trailer: Uint8Array): string | undefined {
    if (trailer.length !== 128 || trailer[0] !== 84 || trailer[1] !== 65 || trailer[2] !== 71)
        return undefined;
    let text = '';
    for (let index = 3; index < 33 && trailer[index] !== 0; index++)
        text += String.fromCharCode(trailer[index]!);
    // Fields are padded with spaces or zeros; leading spaces belong to the text.
    text = text.replace(/ +$/, '');
    return text.length ? text : undefined;
}

interface AudioSyncFrame {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly frameLength: number;
}

function syncFrame(bytes: Uint8Array, offset: number, format: string): AudioSyncFrame | null {
    if (format === 'aac') {
        const frame = parseAdtsFrameHeader(bytes, offset);
        if (!frame || frame.rawDataBlocks !== 0) return null;
        return { ...frame, codec: `mp4a.40.${frame.audioObjectType}` };
    }
    const frame = parseMpegAudioHeader(bytes, offset);
    return frame?.format === format ? { ...frame, codec: frame.format } : null;
}

async function findAudioFrameChain(
    read: ReadBytes,
    size: number,
    start: number,
    format: string,
    sampleRate: number,
    channels: number,
    codec: string,
): Promise<number> {
    const end = Math.min(size, start + 1024 * 1024);
    const matches = (header: AudioSyncFrame | null): header is AudioSyncFrame =>
        !!header &&
        (!sampleRate || (header.sampleRate === sampleRate && header.codec === codec)) &&
        (!channels || header.channels === channels || format !== 'aac');

    for (let base = start; base < end; base += 65536) {
        await yieldEventLoop();
        const bytes = await read(
            base,
            Math.min(65536 + (format === 'aac' ? 3 * 8191 + 10 : 16384), size - base),
        );
        const count = Math.min(65536, end - base, bytes.length - 3);
        for (let index = 0; index < count; index++) {
            if (bytes[index] !== 255) continue;
            const first = syncFrame(bytes, index, format);
            if (!matches(first)) continue;

            let position = index;
            let verified = 0;
            while (verified < 3) {
                const header = syncFrame(bytes, position, format);
                if (
                    !matches(header) ||
                    header.sampleRate !== first.sampleRate ||
                    header.channels !== first.channels ||
                    header.codec !== first.codec ||
                    header.frameLength > size - base - position
                )
                    break;
                position += header.frameLength;
                verified++;
                if (
                    verified >= 2 &&
                    (base + position === size ||
                        isMpegAudioTrailerHeader(bytes.subarray(position), size - base - position))
                )
                    return base + index;
            }

            if (verified === 3) return base + index;
        }
    }

    if (end < size) throw new DemuxError('Audio resynchronization exceeds the 1 MiB search budget');
    return -1;
}
