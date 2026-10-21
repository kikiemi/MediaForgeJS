import type { Reader } from '../../core/contracts/reader';
import { HANDS_OVER, readerDiagnostics } from '../shared/contract';
import type { Source } from '../../core/model/types';
import type { MediaTags } from '../../core/model/media';
import { BlobSource } from '../../core/io/sources/sources';
import { ChunkReader, MAX_ELEMENT_BYTES } from '../../core/io/sources/chunk-reader';
import { demuxAssert, demuxFailure } from '../../core/errors/demux-guard';
import {
    DEMUX_LIMITS,
    DemuxIndexBudget,
    resolveDemuxBudget,
    type ResolvedDemuxBudget,
} from '../shared/demux-budget';
import type { DemuxBudgetOptions } from '../../core/contracts/reader';
import { yieldEventLoop } from '../../core/io/event-loop';
import { DemuxError, MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import type { Sample, DemuxResult, TrackInfo } from '../../core/model/track';
import {
    compressedWaveCodec,
    parseWaveFormat,
    waveFormatTag,
    waveTagName,
    MAX_WAVE_FORMAT_BYTES,
} from '../../core/codec-config/audio/wave-format';
import { AviAvcReader, MAX_AVI_AVC_CONFIG_BYTES } from '../shared/vfw/avc';
import { restoreAvcPresentation, type AvcPictureOrder } from '../shared/vfw/avc-picture-order';
import {
    isPalettedRawVideo,
    rawVideoCodecForBitmap,
    rawVideoCodecForFourcc,
} from '../../core/codec-config/video/raw-video';
import { DiagnosticContext, type DiagnosticOptions } from '../../core/errors/diagnostics';
import {
    AviMpegVideoReader,
    presentMpegPictures,
    type AviMpegPicture,
} from '../shared/vfw/mpeg-video';
import { AviMpegAudioReader, parseDolbyAudioFrame } from '../shared/vfw/mpeg-audio';
import {
    h263Intra,
    isVfwAvcFourcc,
    msmpeg4Intra,
    vfwVideoCodec,
} from '../../core/codec-config/video/mpeg-video';
import {
    isAnnexB,
    isValidHevcWalk,
    splitAnnexBNals,
    splitLengthPrefixedNals,
} from '../../core/codec-config/video/annexb';
import { buildHevcCFromAnnexB } from '../../core/codec-config/video/hevc-config';
import {
    isWindowsMediaIntraFrame,
    isWindowsMediaVideo,
    normalizedWaveFormatEx,
    parseWaveFormatEx,
    windowsMediaAudioCodec,
    windowsMediaVideoCodec,
} from '../../core/codec-config/windows-media';
import { DV_VIDEO, isDvFourcc } from '../../core/codec-config/video/dv-video';
import { mpegVideoFamily, isHevcCodec } from '../../core/model/codec-strings';
import { riffInfoTags, riffInfoTitle } from '../metadata/riff-info';
import {
    buildAacConfig,
    parseAacAudioSpecificConfig,
    parseAdtsFrameHeader,
} from '../../core/codec-config/audio/adts';
import { dataView, fourcc, u32be, u32le } from '../../core/bytes/byte-fields';

/** RIFF INFO lists beyond this size are not scanned for a title or tags. */
const MAX_INFO_BYTES = 1024 * 1024;

export interface AviDemuxerOptions extends DemuxBudgetOptions, DiagnosticOptions {
    /**
     * The open option of the same name: makes compatible validation the demuxer's default, which
     * recovers truncated and damaged input (strict validation rejects it), and reads a video
     * stream holding fewer frames than its header declares as truncated.
     */
    readonly recovery?: 'complete-packets';
}

class AviDemuxRun {
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private readonly limits: ResolvedDemuxBudget;
    declare private readonly recoverPackets: boolean;
    /** Whether the stream headers were read. */
    private headerParsed = false;
    declare private readonly input: File | Blob | Source;
    declare private readonly signal: AbortSignal | undefined;
    declare private readonly diagnostics: DiagnosticContext;
    declare private budget: DemuxIndexBudget;
    declare private reader: ChunkReader;
    declare private size: number;
    declare private lenient: boolean;
    private incomplete = false;
    private readonly warned = new Set<string>();
    private warnOnce(code: string, message: string, offset?: number): void {
        if (this.warned.has(code)) return;
        this.warned.add(code);
        this.diagnostics.warn({
            code,
            message,
            format: 'avi',
            ...(offset !== undefined ? { offset } : {}),
        });
    }

    private truncated(code: string, message: string, offset: number): void {
        demuxAssert(this.lenient, message);
        this.incomplete = true;
        this.diagnostics.warn({ code, message, offset, format: 'avi' });
    }

    private truncatedHeader(pos: number, end: number): boolean {
        if (pos + 8 <= Math.min(this.size, end)) return false;
        if (this.lenient && end <= this.size) {
            this.warnOnce(
                'AVI_TRAILING_BYTES',
                `Ignored ${end - pos} bytes too short for an AVI chunk header`,
                pos,
            );
            return true;
        }
        demuxAssert(pos + 8 <= end, 'AVI chunk header overruns its parent');
        this.truncated(
            'AVI_TRUNCATED_HEADER',
            'Discarded an incomplete AVI tail chunk header',
            pos,
        );
        return true;
    }

    private readonly checkAbort = (): void => {
        throwIfAborted(this.signal);
    };
    private readonly streams = new Map<number, AviStream>();
    private streamCount = 0;
    declare private maxChunks: number;
    private chunks = 0;
    declare private unsupported: unknown;
    private mapped(map: () => string): string | undefined {
        try {
            return map();
        } catch (error) {
            if (!this.lenient || !(error instanceof DemuxError)) throw error;
            this.unsupported ??= error;
            this.diagnostics.warn({
                code: 'AVI_UNSUPPORTED_STREAM',
                message: `${error.message}; the stream is omitted`,
                format: 'avi',
            });
            return undefined;
        }
    }

    private readonly readChunk: AviChunkReader = async (pos, end, allowTail = false) => {
        if ((this.chunks & 0x0fff) === 0) await yieldEventLoop();
        if ((this.chunks & 0x03ff) === 0) this.checkAbort();
        demuxAssert(
            ++this.chunks <= this.maxChunks,
            `AVI chunk count implausible for a ${this.size}-byte file`,
        );
        demuxAssert(pos + 8 <= end, 'AVI chunk header overruns its parent');

        const head = await this.reader.bytes(pos, 8);
        const id = fourcc(head, 0);
        const length = dataView(head).getUint32(4, true);

        const data = pos + 8;
        const chunkEnd = data + length;
        const next = chunkEnd + (length & 1);
        demuxAssert(next <= end, 'AVI chunk overruns its parent');
        if (next > this.size) {
            demuxAssert(allowTail, 'AVI header chunk is truncated');
            const container = id === 'LIST' || id === 'RIFF';
            this.truncated(
                container ? 'AVI_TRUNCATED_CONTAINER' : 'AVI_TRUNCATED_CHUNK',
                container
                    ? `AVI ${id} is cut by the end of the input; reading its whole chunks`
                    : chunkEnd <= this.size
                      ? 'AVI tail chunk lacks its padding byte'
                      : 'Discarded an incomplete AVI tail chunk payload',
                pos,
            );
        }

        let type = '';
        if (id === 'LIST' || id === 'RIFF') {
            demuxAssert(length >= 4, 'AVI list is missing its type');
            if (data + 4 <= this.size) type = fourcc(await this.reader.bytes(data, 4), 0);
        }
        return { id, type, size: length, data, end: chunkEnd, next };
    };
    /**
     * Whether a movi chunk header at `pos` names a known chunk that fits its list (or the
     * truncated tail).
     */
    private async plausibleAt(pos: number, end: number): Promise<boolean> {
        if (pos < 0 || pos + 8 > Math.min(end, this.size)) return false;
        const bytes = await this.reader.bytes(pos, 8);
        return plausibleMoviChunk(bytes, 0, pos, end, this.streamCount);
    }

    /**
     * Compatible reading accepts an unknown chunk only when it fits and a readable chunk
     * follows it.
     */
    private async acceptable(pos: number, end: number): Promise<boolean> {
        if (await this.plausibleAt(pos, end)) return true;
        const bytes = await this.reader.bytes(pos, 8);
        const length = u32le(bytes, 4);
        const next = pos + 8 + length;
        if (!/^[\x20-\x7e]{4}$/.test(fourcc(bytes, 0)) || next > Math.min(end, this.size))
            return false;
        const limit = Math.min(end, this.size);
        return (
            next + (length & 1) >= limit ||
            (await this.plausibleAt(next + (length & 1), end)) ||
            (await this.plausibleAt(next, end))
        );
    }

    /**
     * Some writers declare chunk sizes a few bytes larger than the data they wrote: the next
     * header then starts shortly before the declared end of `previous`. Returns that header's
     * offset, or -1.
     */
    private async lookback(
        previous: AviChunk | undefined,
        pos: number,
        end: number,
    ): Promise<number> {
        if (!previous || previous.next !== pos) return -1;
        const from = Math.max(previous.data, pos - LOOKBACK_BYTES);
        if (pos - from < 1 || pos + 8 > Math.min(end, this.size)) return -1;
        const window = await this.reader.bytes(from, pos - from + 8);
        for (let at = pos - from - 1; at >= 0; at--)
            if (
                plausibleMoviChunk(window, at, from + at, end, this.streamCount) &&
                (await this.acceptable(from + at, end))
            )
                return from + at;
        return -1;
    }

    /** The next 'LIST....movi' header after damaged top-level chunks, or -1. */
    private async findMovi(from: number, end: number): Promise<number> {
        const limit = Math.min(end, this.size);
        for (let at = from; at + 12 <= limit;) {
            this.checkAbort();
            await yieldEventLoop();
            const window = await this.reader.bytes(at, Math.min(RESYNC_WINDOW_BYTES, limit - at));
            for (let index = 0; index + 12 <= window.length; index++)
                if (fourcc(window, index) === 'LIST' && fourcc(window, index + 8) === 'movi')
                    return at + index;
            if (window.length < 12) break;
            at += window.length - 11;
        }
        return -1;
    }

    /**
     * ffmpeg-style resynchronization: the next offset holding a plausible chunk header, or -1.
     */
    private async resync(from: number, end: number): Promise<number> {
        const limit = Math.min(end, this.size);
        for (let at = from; at + 8 <= limit;) {
            this.checkAbort();
            await yieldEventLoop();
            const window = await this.reader.bytes(at, Math.min(RESYNC_WINDOW_BYTES, limit - at));
            for (let index = 0; index + 8 <= window.length; index++)
                if (plausibleMoviChunk(window, index, at + index, end, this.streamCount))
                    return at + index;
            if (window.length < 8) break;
            at += window.length - 7;
        }
        return -1;
    }

    private async addVideo(stream: AviStream, ch: AviChunk, db: boolean): Promise<void> {
        const schedule = stream.indexDrops;
        if (schedule && (ch.size === 0 || schedule.sizes[schedule.chunks] !== ch.size))
            // The movi list stores its own drop frames, or the index disagrees with it: the
            // chunks decide.
            stream.indexDrops = undefined;
        else if (schedule) {
            const drops = schedule.drops[schedule.chunks++]!;
            if (drops > 0) {
                const previous = stream.samples[stream.samples.length - 1];
                stream.units += drops;
                if (previous)
                    previous.duration =
                        (stream.start + stream.units) * stream.tick - previous.timestamp;
                if (!this.indexDropsNoted) {
                    this.indexDropsNoted = true;
                    this.diagnostics.warn({
                        code: 'AVI_INDEX_DROP_FRAMES',
                        format: 'avi',
                        message:
                            'Timed the video by the drop frames its idx1 index records ' +
                            'without movi chunks',
                    });
                }
            }
        }

        const timestamp = (stream.start + stream.units++) * stream.tick;
        const samples = stream.samples;
        if (ch.size === 0) {
            const previous = samples[samples.length - 1];
            if (previous) previous.duration = timestamp + stream.tick - previous.timestamp;
            return;
        }

        this.budget.reserveSamples(1, stream.avc ? 384 : 256, 'AVI sample index');
        let picture: AviMpegPicture | undefined;
        let inspection: Awaited<ReturnType<AviAvcReader['inspect']>> | undefined;
        let hevcAnnexB = false;
        let keyframe: boolean;
        try {
            picture = stream.mpeg
                ? await stream.mpeg.inspect(this.reader, ch.data, ch.size)
                : undefined;
            inspection = stream.avc
                ? await stream.avc.inspect(this.reader, ch.data, ch.size, this.checkAbort)
                : undefined;
            hevcAnnexB = isHevcCodec(stream.codec)
                ? await this.hevcAnnexB(this.reader, ch.data, ch.size)
                : false;
            keyframe =
                picture?.keyframe ??
                inspection?.isKeyframe ??
                (db ||
                    (await this.inspectKeyframe(
                        stream.codec,
                        this.reader,
                        ch.data,
                        ch.size,
                        hevcAnnexB,
                        stream.codecConfig,
                    )));
        } catch (error) {
            if (!this.lenient || !(error instanceof DemuxError)) throw error;
            this.diagnostics.warn({
                code: 'AVI_PACKET_DAMAGED',
                message:
                    `Dropped a damaged AVI video packet of stream ${stream.index}: ` +
                    `${error.message}`,
                offset: ch.data,
                format: 'avi',
            });
            return;
        }

        const sample: Sample = {
            offset: picture?.offset ?? ch.data,
            size: picture?.size ?? ch.size,
            timestamp,
            duration: stream.tick,
            isKeyframe: keyframe,
        };

        if (picture) {
            stream.pictureTypes.push(picture.type);
            sample.decodeTimestamp = timestamp;
            if (picture.data) sample.data = picture.data;
        }
        if (hevcAnnexB) sample.nalUnitFormat = 'annexb';
        if (inspection) {
            sample.nalUnitFormat = inspection.annexB ? 'annexb' : 'avcc';
            sample.decodeTimestamp = timestamp;
            if (inspection.pictureOrder)
                stream.order.push({ sample, order: inspection.pictureOrder });
        }
        samples.push(sample);
    }

    private async addAudio(stream: AviStream, ch: AviChunk): Promise<void> {
        if (stream.codec.startsWith('mp4a') && !stream.info.codecConfig) {
            const bytes = await this.reader.bytes(ch.data, ch.size);
            for (let at = 0; at < bytes.length;) {
                const header = parseAdtsFrameHeader(bytes, at);
                if (
                    !header ||
                    header.rawDataBlocks !== 0 ||
                    at + header.frameLength > bytes.length
                ) {
                    stream.skipped += bytes.length - at;
                    break;
                }
                this.budget.reserveSamples(1, 256, 'AVI sample index');
                if (!stream.codecConfig) {
                    try {
                        stream.codecConfig = buildAacConfig(
                            header.sampleRate,
                            header.channels,
                            header.audioObjectType,
                        );
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : String(error);
                        throw new DemuxError(`AVI ADTS header is unusable: ${reason}`);
                    }
                    stream.codec = `mp4a.40.${header.audioObjectType}`;
                    stream.sampleRate = header.sampleRate;
                    stream.channelCount = header.channels;
                }
                stream.samples.push({
                    offset: ch.data + at + header.headerLength,
                    size: header.frameLength - header.headerLength,
                    timestamp: stream.start * stream.tick + stream.frames / stream.sampleRate,
                    duration: 1024 / stream.sampleRate,
                    isKeyframe: true,
                });
                stream.frames += 1024;
                at += header.frameLength;
            }
            return;
        }
        if (stream.mpegAudio) {
            const chunk = await stream.mpegAudio.push(this.reader, ch.data, ch.size);
            stream.skipped += chunk.skipped;

            // Where the stream clock places this chunk: bytes over the sample size; without
            // one, as ffmpeg counts it, its bytes over the format's block alignment (rounded
            // up), or one unit per chunk.
            const chunkTime = (stream.start + stream.units) * stream.tick;
            const unitBytes = stream.sampleSize > 0 ? stream.sampleSize : stream.frameBlockAlign;
            stream.units +=
                stream.sampleSize > 0
                    ? ch.size / stream.sampleSize
                    : unitBytes > 0
                      ? Math.ceil(ch.size / unitBytes)
                      : 1;
            for (const frame of chunk.frames) {
                this.budget.reserveSamples(1, 256, 'AVI sample index');
                if (stream.samples.length === 0) {
                    stream.codec = frame.header.format;
                    stream.sampleRate = frame.header.sampleRate;
                    stream.channelCount = frame.header.channels;
                }

                // Bytes skipped as damage or padding still take their time: frames after them
                // resume at the chunk clock rather than directly after the previous frame.
                // Zeroed chunks that delay the sound of a VBR stream count the same way.
                if (frame.skippedBefore > 0 && unitBytes > 0 && !frame.data) {
                    const units = (frame.offset - ch.data) / unitBytes;
                    const within = (stream.sampleSize > 0 ? units : Math.ceil(units)) * stream.tick;
                    const frames = Math.round(
                        (chunkTime + within - stream.start * stream.tick) * stream.sampleRate,
                    );
                    const skippedUnits = frame.skippedBefore / unitBytes;
                    const skippedFrames =
                        (stream.sampleSize > 0 ? skippedUnits : Math.ceil(skippedUnits)) *
                        stream.tick *
                        stream.sampleRate;
                    const gap = frames - stream.frames;
                    if (
                        gap > frame.header.samplesPerFrame &&
                        gap <= skippedFrames + frame.header.samplesPerFrame
                    )
                        stream.frames = frames;
                }
                stream.samples.push({
                    offset: frame.offset,
                    size: frame.size,
                    ...(frame.data ? { data: frame.data } : {}),
                    timestamp: stream.start * stream.tick + stream.frames / stream.sampleRate,
                    duration: frame.header.samplesPerFrame / stream.sampleRate,
                    isKeyframe: true,
                });
                stream.frames += frame.header.samplesPerFrame;
            }
            return;
        }
        if (ch.size === 0) return;
        this.budget.reserveSamples(1, 256, 'AVI sample index');

        // A damaged chunk that ends inside a channel frame keeps its whole frames (compatible
        // validation).
        const partial = stream.blockAlign > 0 ? ch.size % stream.blockAlign : 0;
        if (partial) {
            demuxAssert(this.lenient, 'AVI PCM chunks must contain complete channel frames');
            this.incomplete = true;
            this.warnOnce(
                'AVI_PARTIAL_FRAME',
                `Dropped a partial PCM frame in the chunk at byte ${ch.data}`,
                ch.data,
            );
            if (ch.size === partial) return;
        }
        const pcmSize = ch.size - partial;
        const units = stream.sampleSize > 0 ? pcmSize / stream.sampleSize : 1;
        stream.samples.push({
            offset: ch.data,
            size: pcmSize,
            timestamp: (stream.start + stream.units) * stream.tick,
            duration: units * stream.tick,
            isKeyframe: true,
        });
        stream.units += units;
    }

    private createReaders(): void {
        for (const stream of this.streams.values()) {
            if (['mp1', 'mp2', 'mp3'].includes(stream.codec))
                stream.mpegAudio = new AviMpegAudioReader(
                    stream.info.audioFormat,
                    stream.info.sampleRate,
                );
            else if (stream.codec === 'ac-3' || stream.codec === 'ec-3')
                stream.mpegAudio = new AviMpegAudioReader(
                    stream.info.audioFormat,
                    stream.info.sampleRate,
                    parseDolbyAudioFrame,
                );

            if (stream.codec.startsWith('avc')) {
                try {
                    stream.avc = new AviAvcReader(stream.codecConfig);
                } catch (error) {
                    if (!this.lenient || !(error instanceof DemuxError)) throw error;
                    this.diagnostics.warn({
                        code: 'AVI_CODEC_CONFIG_IGNORED',
                        message:
                            `${error.message}; parameter sets are read from the packets ` +
                            `instead`,
                        format: 'avi',
                    });
                    stream.avc = new AviAvcReader();
                }
            } else if (mpegVideoFamily(stream.codec))
                stream.mpeg = new AviMpegVideoReader(stream.codec, stream.codecConfig, message =>
                    this.diagnostics.recover({
                        code: 'AVI_PACKED_FRAME_LOST',
                        format: 'avi',
                        message,
                    }),
                );
        }
    }

    /**
     * Reads the stream chunks of a movi list, or of damaged data that stands in for one, from
     * `from` to `end`.
     */
    private async readMovi(from: number, end: number): Promise<void> {
        let moviPos = from;
        let moviEnd = end;
        let unpaddedAt = -1;
        let lastChunk: AviChunk | undefined;
        const parents: { end: number; next: number }[] = [];

        while (moviPos < Math.min(moviEnd, this.size) || parents.length > 0) {
            if (moviPos >= Math.min(moviEnd, this.size)) {
                const parent = parents.pop()!;
                moviPos = parent.next;
                moviEnd = parent.end;
                continue;
            }

            if (this.truncatedHeader(moviPos, moviEnd)) break;
            if (this.lenient && !(await this.acceptable(moviPos, moviEnd))) {
                if (moviPos === unpaddedAt + 1 && (await this.plausibleAt(unpaddedAt, moviEnd))) {
                    this.warnOnce(
                        'AVI_UNPADDED_CHUNK',
                        'AVI chunks of odd size are not padded; read them at their unpadded ' +
                            'ends',
                        unpaddedAt,
                    );
                    moviPos = unpaddedAt;
                    continue;
                }

                const overrun = await this.lookback(lastChunk, moviPos, moviEnd);
                if (overrun >= 0) {
                    this.warnOnce(
                        'AVI_CHUNK_SIZE_OVERRUN',
                        'An AVI chunk declares more bytes than it holds',
                        overrun,
                    );
                    for (const stream of this.streams.values()) {
                        const last = stream.samples[stream.samples.length - 1];
                        if (
                            last &&
                            !last.data &&
                            last.offset < overrun &&
                            last.offset + last.size > overrun
                        )
                            last.size = overrun - last.offset;
                    }
                    moviPos = overrun;
                    continue;
                }

                const found = await this.resync(moviPos + 1, moviEnd);
                const limit = Math.min(moviEnd, this.size);
                const skipped = (found < 0 ? limit : found) - moviPos;
                const until = found < 0 ? 'at the end of a movi list' : 'to the next chunk';
                this.diagnostics.warn({
                    code: 'AVI_RESYNCHRONIZED',
                    message: `Skipped ${skipped} bytes of unreadable AVI data ${until}`,
                    offset: moviPos,
                    format: 'avi',
                });
                moviPos = found < 0 ? limit : found;
                continue;
            }

            const ch = await this.readChunk(moviPos, moviEnd, true);
            if (ch.end > this.size && !(ch.id === 'LIST' && ch.type === 'rec ')) break;
            const id = parseMoviChunkId(ch.id);
            const stream = id ? this.streams.get(id.index) : undefined;
            if (stream?.kind === 'video' && (id!.kind === 'dc' || id!.kind === 'db'))
                await this.addVideo(stream, ch, id!.kind === 'db');
            else if (stream?.kind === 'audio' && id!.kind === 'wb') await this.addAudio(stream, ch);
            else if (ch.id === 'LIST' && ch.type === 'rec ') {
                demuxAssert(
                    parents.length < DEMUX_LIMITS.maxBoxDepth,
                    'AVI record nesting exceeds limit',
                );
                parents.push({ end: moviEnd, next: ch.next });
                moviPos = ch.data + 4;
                moviEnd = ch.end;
                continue;
            }

            unpaddedAt = ch.size & 1 ? ch.end : -1;
            lastChunk = ch;
            moviPos = ch.next;
        }
    }

    /**
     * Drop frames that only the idx1 index after the first movi list records (zero-size
     * entries, as some writers stored them without movi chunks): each video stream gets the
     * slots they take before its stored chunks.
     */
    private indexDropsNoted = false;
    private async readIndexDrops(at: number, end: number): Promise<void> {
        if (at + 8 > end) return;
        const header = await this.reader.bytes(at, 8);
        if (fourcc(header, 0) !== 'idx1') return;
        const length = Math.min(
            new DataView(header.buffer, header.byteOffset, 8).getUint32(4, true),
            end - at - 8,
        );
        const entries = Math.floor(length / 16);
        if (entries === 0 || entries > DEMUX_LIMITS.maxTableEntries) return;

        this.budget.reserveBytes(entries * 16, 'AVI idx1 index');
        const bytes = await this.reader.bytes(at + 8, entries * 16);
        const view = dataView(bytes);
        const schedules = new Map<
            number,
            { drops: number[]; sizes: number[]; pending: number; zero: boolean }
        >();

        for (let entry = 0; entry < entries; entry++) {
            const id = parseMoviChunkId(fourcc(bytes, entry * 16));
            const stream = id ? this.streams.get(id.index) : undefined;
            if (stream?.kind !== 'video' || (id!.kind !== 'dc' && id!.kind !== 'db')) continue;

            let schedule = schedules.get(stream.index);
            if (!schedule)
                schedules.set(
                    stream.index,
                    (schedule = { drops: [], sizes: [], pending: 0, zero: false }),
                );

            const chunkSize = view.getUint32(entry * 16 + 12, true);
            if (chunkSize === 0) {
                schedule.pending++;
                schedule.zero = true;
            } else {
                schedule.drops.push(schedule.pending);
                schedule.sizes.push(chunkSize);
                schedule.pending = 0;
            }
        }

        for (const [index, schedule] of schedules)
            if (schedule.zero)
                this.streams.get(index)!.indexDrops = {
                    drops: schedule.drops,
                    sizes: schedule.sizes,
                    chunks: 0,
                };
    }

    declare private ordered: AviStream[];
    private readonly othersHaveSamples = (stream: AviStream): boolean =>
        this.ordered.some(other => other !== stream && other.samples.length > 0);

    constructor(
        limits: ResolvedDemuxBudget,
        recoverPackets: boolean,
        input: File | Blob | Source,
        signal: AbortSignal | undefined,
        diagnostics: DiagnosticContext,
    ) {
        this.limits = limits;
        this.recoverPackets = recoverPackets;
        this.input = input;
        this.signal = signal;
        this.diagnostics = diagnostics;
    }

    async run(): Promise<DemuxResult> {
        this.budget = new DemuxIndexBudget(this.limits);
        const source = this.input instanceof Blob ? new BlobSource(this.input) : this.input;
        this.reader = new ChunkReader(source);
        this.size = this.reader.size;
        this.lenient = this.diagnostics.validation === 'compatible';
        this.checkAbort();
        const head = await this.reader.bytes(0, Math.min(this.size, 12));
        if (head.length < 12 || fourcc(head, 0) !== 'RIFF' || !isAviForm(fourcc(head, 8))) {
            throw new DemuxError('Not an AVI file');
        }

        this.maxChunks = Math.floor(this.size / 8) + 1;
        const { title, tags } = await this.readRiffs();
        this.checkAbort();
        demuxAssert(
            !this.incomplete || this.headerParsed,
            'AVI recovery requires complete stream headers',
        );
        this.ordered = [...this.streams.values()].sort((a, b) => a.index - b.index);
        this.reportStreams();
        await this.settleAvcTiming();
        for (const stream of this.ordered)
            if (stream.mpeg) presentMpegPictures(stream.samples, stream.pictureTypes, stream.tick);
        if (this.ordered.every(stream => stream.samples.length === 0) && this.unsupported)
            throw this.unsupported;
        this.omitEmptyStreams();
        return this.buildResult(title, tags);
    }

    /**
     * Reads the RIFF AVI chunk and the AVIX chunks after it: stream headers, the title and tags of
     * the INFO list, and the stream chunks of each movi list; returns the title and tags. After
     * damage, compatible reading resumes at the next movi list or at stream chunks found without
     * one.
     */
    private async readRiffs(): Promise<{ title?: string; tags?: MediaTags }> {
        let title: string | undefined;
        let tags: MediaTags | undefined;
        let riffPos = 0;
        riffs: while (riffPos + 12 <= this.size) {
            this.checkAbort();
            if (riffPos > 0) {
                const next = await this.reader.bytes(riffPos, 12);
                if (fourcc(next, 0) !== 'RIFF' || fourcc(next, 8) !== 'AVIX') break;
            }
            const riff = await this.readChunk(
                riffPos,
                this.lenient ? Number.MAX_SAFE_INTEGER : this.size,
                true,
            );
            let pos = riff.data + 4;
            while (pos < Math.min(riff.end, this.size)) {
                if (this.truncatedHeader(pos, riff.end)) break;
                let ck: AviChunk;
                try {
                    ck = await this.readChunk(pos, riff.end, true);
                } catch (error) {
                    if (!this.lenient || !this.headerParsed || !(error instanceof DemuxError))
                        throw error;
                    const movi = await this.findMovi(pos + 1, riff.end);

                    // Without a movi list, stream chunks after the damage are read as ffmpeg's scan
                    // reads them.
                    const data = movi < 0 ? await this.resync(pos + 1, riff.end) : -1;
                    const recovery =
                        movi >= 0
                            ? `skipped ${movi - pos} bytes to the movi list`
                            : data >= 0
                              ? `read stream chunks from offset ${data} without a movi list`
                              : 'stopped reading top-level chunks';
                    this.diagnostics.warn({
                        code: 'AVI_RESYNCHRONIZED',
                        message: `${error.message}; ${recovery}`,
                        offset: pos,
                        format: 'avi',
                    });
                    if (movi < 0) {
                        if (data >= 0) await this.readMovi(data, riff.end);
                        break riffs;
                    }
                    pos = movi;
                    continue;
                }
                if (ck.id === 'LIST' && ck.type === 'hdrl') {
                    await this.readHeaderList(ck);
                } else if (
                    ck.id === 'LIST' &&
                    ck.type === 'INFO' &&
                    title === undefined &&
                    ck.end <= this.size
                ) {
                    if (ck.size <= MAX_INFO_BYTES) {
                        const list = await this.reader.bytes(ck.data, ck.size);
                        title = riffInfoTitle(list);
                        tags ??= riffInfoTags(list.subarray(4));
                    }
                } else if (ck.id === 'LIST' && ck.type === 'movi') {
                    if (riffPos === 0)
                        await this.readIndexDrops(ck.next, Math.min(riff.end, this.size));
                    await this.readMovi(ck.data + 4, ck.end);
                }
                pos = ck.next;
            }
            riffPos = riff.next;
        }
        return { title, tags };
    }

    /** Reads the stream headers of an hdrl list; the first one read declares the streams. */
    private async readHeaderList(ck: AviChunk): Promise<void> {
        demuxAssert(ck.end <= this.size, 'AVI stream headers are truncated');
        const context: AviHeaderContext = {
            frameMicroseconds: 0,
            lenient: this.lenient,
            warn: (code, message) => this.diagnostics.warn({ code, message, format: 'avi' }),
        };
        await this.parseHdrl(this.reader, this.readChunk, ck.data + 4, ck.end, context, info => {
            if (this.headerParsed) return;
            this.streamCount = Math.max(this.streamCount, info.streamIndex + 1);
            if (info.type === 'unsupported') {
                this.mapped(() => {
                    throw new DemuxError(info.codec);
                });
                return;
            }

            const codec =
                info.type === 'video'
                    ? this.mapped(() => this.mapVideoCodec(info.codec))
                    : info.codec || this.mapped(() => this.mapAudioFormat(info.audioFormat));
            if (codec === undefined) return;
            this.streams.set(info.streamIndex, {
                index: info.streamIndex,
                kind: info.type,
                info,
                codec,
                tick: info.scale / info.rate,
                start: info.start,
                units: 0,
                samples: [],
                codecConfig: info.codecConfig,
                pictureTypes: [],
                order: [],
                frames: 0,
                skipped: 0,
                sampleRate: info.sampleRate,
                channelCount: info.channelCount,
                sampleSize: info.sampleSize,
                blockAlign: info.blockAlign ?? 0,
                frameBlockAlign: info.frameBlockAlign ?? 0,
            });
        });
        if (!this.headerParsed) {
            this.headerParsed = true;
            if (this.streams.size === 0 && this.unsupported) throw this.unsupported;
            this.createReaders();
        }
    }

    /** Reports what reading each stream skipped or found missing. */
    private reportStreams(): void {
        for (const stream of this.ordered) {
            if (stream.skipped > 0)
                this.diagnostics.recover({
                    code: 'AVI_AUDIO_RESYNCHRONIZED',
                    format: 'avi',
                    message:
                        `Skipped ${stream.skipped} bytes between audio frames of stream ` +
                        `${stream.index}`,
                });
            if (stream.mpegAudio?.pending)
                this.diagnostics.warn({
                    code: 'AVI_AUDIO_TAIL_DISCARDED',
                    format: 'avi',
                    message: `Discarded an unfinished MPEG audio frame at the end of the stream`,
                });
            if (
                this.recoverPackets &&
                this.lenient &&
                !this.incomplete &&
                stream.kind === 'video' &&
                stream.units < stream.info.length
            )
                this.truncated(
                    'AVI_TRUNCATED_STREAM',
                    `AVI holds ${stream.units} of its ${stream.info.length} declared frames`,
                    this.size,
                );
        }
    }

    /**
     * Presentation times of H.264 streams from their picture order; a recovered stream whose final
     * GOP cannot be timed loses that GOP.
     */
    private async settleAvcTiming(): Promise<void> {
        for (const stream of this.ordered) {
            if (!stream.avc) continue;
            if (
                this.incomplete &&
                (stream.info.length === 0 || stream.units !== stream.info.length)
            ) {
                const samples = stream.samples;
                demuxAssert(
                    stream.avc.codecConfig || !samples.length,
                    'AVI H.264 recovery requires complete SPS/PPS configuration',
                );
                let lastIdr = 0;
                for (let index = 0; index < samples.length; index++)
                    if (samples[index]!.isKeyframe) lastIdr = index;
                const offset = samples[lastIdr]?.offset ?? 0;
                const tail = stream.order.filter(({ sample }) => sample.offset >= offset);
                const noReordering =
                    tail.length > 0 &&
                    tail.every(
                        ({ order }, index) =>
                            order.noReordering &&
                            (index === 0 ||
                                order.epoch !== tail[index - 1]!.order.epoch ||
                                order.poc > tail[index - 1]!.order.poc),
                    );

                if (!noReordering && samples.length > 0) {
                    const dropped = samples.length - lastIdr;
                    samples.length = lastIdr;
                    while (
                        stream.order.length &&
                        stream.order[stream.order.length - 1]!.sample.offset >= offset
                    )
                        stream.order.pop();

                    this.diagnostics.warn({
                        code: 'AVI_UNRESOLVED_TIMING',
                        message:
                            `Discarded ${dropped} H.264 tail packets without presentation ` +
                            `timing`,
                        format: 'avi',
                        offset,
                    });
                    demuxAssert(
                        samples.length > 0 || this.othersHaveSamples(stream),
                        'Truncated AVI H.264 has no complete GOP with known timing',
                    );
                }
            }
            await restoreAvcPresentation(
                stream.samples,
                stream.order,
                this.checkAbort,
                this.lenient
                    ? () => {
                          this.incomplete = true;
                          this.warnOnce(
                              'AVI_DUPLICATE_PICTURE',
                              'H.264 pictures repeat a picture order; shown in turn',
                          );
                      }
                    : undefined,
            );
        }
    }

    /** Leaves out the declared streams without chunks, where the others hold samples. */
    private omitEmptyStreams(): void {
        for (const stream of this.ordered) {
            if (stream.samples.length > 0) continue;
            const kind = stream.kind;
            const article = kind === 'video' ? 'a' : 'an';
            const message =
                `AVI declares ${article} ${kind} stream but no ${kind} chunks were ` + `found`;
            demuxAssert(this.lenient && this.othersHaveSamples(stream), message);
            this.diagnostics.warn({
                code: 'AVI_EMPTY_STREAM',
                message: `${message}; the stream is omitted`,
                format: 'avi',
            });
        }
    }

    /** The tracks of the streams that hold samples. */
    private buildResult(title: string | undefined, tags: MediaTags | undefined): DemuxResult {
        const result: DemuxResult = {
            ...(title !== undefined ? { title } : {}),
            ...(tags ? { tags } : {}),
            videoTracks: [],
            audioTracks: [],
        };
        for (const stream of this.ordered) {
            const samples = stream.samples;
            if (samples.length === 0) continue;
            let end = 0;
            for (const sample of samples) end = Math.max(end, sample.timestamp + sample.duration);
            if (stream.kind === 'audio') {
                result.audioTracks.push({
                    codec: stream.codec,
                    width: 0,
                    height: 0,
                    sampleRate: stream.sampleRate,
                    channelCount: stream.channelCount,
                    duration: end,
                    samples,
                    codecConfig: stream.codecConfig,
                    ...(this.incomplete ? { incomplete: true } : {}),
                });
                continue;
            }

            result.videoTracks.push(this.videoTrack(stream, end));
        }
        return result;
    }

    /** The video track of a stream, its codec configuration taken from what its chunks carried. */
    private videoTrack(stream: AviStream, end: number): TrackInfo {
        const samples = stream.samples;
        let codec = stream.codec;
        let codecConfig = stream.codecConfig;
        let width = stream.info.width;
        let height = stream.info.height;
        if (stream.avc) {
            codecConfig = stream.avc.codecConfig;
            codec = stream.avc.codec ?? codec;
        }

        const mpeg = stream.mpeg;
        if (mpeg) {
            codecConfig = mpeg.codecConfig;
            codec = mpeg.codec;
            width ||= mpeg.format?.width ?? 0;
            height ||= mpeg.format?.height ?? 0;
        }

        if (isHevcCodec(codec) && codecConfig && codecConfig[0] !== 1)
            codecConfig = (isAnnexB(codecConfig) && buildHevcCFromAnnexB(codecConfig)) || undefined;
        const aspect = mpeg?.format;
        return {
            codec,
            ...(mpegVideoFamily(codec) === 'mpeg4v' ? { codecTag: stream.info.codec } : {}),
            width: width || 1920,
            height: height || 1080,
            ...(aspect && aspect.width === width && aspect.height === height
                ? {
                      pixelAspectRatioNum: aspect.pixelAspectRatioNum,
                      pixelAspectRatioDen: aspect.pixelAspectRatioDen,
                      displayWidth: aspect.displayWidth,
                      displayHeight: aspect.displayHeight,
                  }
                : {}),
            sampleRate: 0,
            channelCount: 0,
            duration: end,
            samples,
            codecConfig,
            ...(this.incomplete ? { incomplete: true } : {}),
        };
    }

    private async parseHdrl(
        reader: ChunkReader,
        readChunk: AviChunkReader,
        start: number,
        end: number,
        context: AviHeaderContext,
        cb: (info: StreamInfo) => void,
    ): Promise<void> {
        let pos = start;
        let strlIndex = 0;
        while (pos < end && !(context.lenient && pos + 8 > end)) {
            const ck = await readChunk(pos, end);
            if (ck.id === 'avih' && ck.size >= 4)
                context.frameMicroseconds = u32le(await reader.bytes(ck.data, 4), 0);
            else if (ck.id === 'LIST' && ck.type === 'strl') {
                await this.parseStrl(
                    reader,
                    readChunk,
                    ck.data + 4,
                    ck.end,
                    strlIndex++,
                    context,
                    cb,
                );
            }
            pos = ck.next;
        }
    }

    private async parseStrl(
        reader: ChunkReader,
        readChunk: AviChunkReader,
        start: number,
        end: number,
        streamIndex: number,
        context: AviHeaderContext,
        cb: (info: StreamInfo) => void,
    ): Promise<void> {
        let pos = start;
        let strhType = '';
        let fccHandler = '';
        let rate = 0,
            scale = 0,
            streamStart = 0,
            streamLength = 0,
            sampleSize = 0;

        while (pos < end && !(context.lenient && pos + 8 > end)) {
            const ck = await readChunk(pos, end);
            if (ck.id === 'strh') {
                demuxAssert(ck.size >= 48, 'AVI stream header is truncated');
                const data = await reader.bytes(ck.data, 48);
                const dv = dataView(data);
                strhType = fourcc(data, 0);
                fccHandler = fourcc(data, 4);
                scale = dv.getUint32(20, true);
                rate = dv.getUint32(24, true);
                streamStart = dv.getUint32(28, true);
                streamLength = dv.getUint32(32, true);
                sampleSize = dv.getUint32(44, true);
            } else if (ck.id === 'strf' && strhType === 'iavs') {
                cb({
                    ...EMPTY_STREAM,
                    streamIndex,
                    type: 'unsupported',
                    codec: "AVI interleaved DV stream (type 'iavs') is not supported",
                });
            } else if (ck.id === 'strf' && (strhType === 'vids' || strhType === 'auds')) {
                if (!(rate > 0 && scale > 0)) {
                    demuxAssert(context.lenient, 'AVI stream time base must be positive');

                    // ffmpeg's fallback for broken writers: the main header's frame period, else 25
                    // per second.
                    if (strhType === 'auds') [scale, rate] = [1, 0];
                    else if (context.frameMicroseconds > 0)
                        [scale, rate] = [context.frameMicroseconds, 1000000];
                    else [scale, rate] = [1, 25];
                    context.warn(
                        'AVI_INVALID_TIME_BASE',
                        `AVI stream ${streamIndex} declares no time base; using ` +
                            `${rate || 'its sample rate'}/${scale}`,
                    );
                }
                demuxAssert(
                    ck.size >= (strhType === 'vids' ? 40 : 14),
                    'AVI stream format is truncated',
                );
                const data = await reader.bytes(ck.data, strhType === 'vids' ? 40 : 14);
                const dv = dataView(data);
                if (strhType === 'vids') {
                    const w = dv.getInt32(4, true);
                    const h = Math.abs(dv.getInt32(8, true));
                    const codec =
                        rawVideoCodecForBitmap(
                            dv.getUint32(16, true),
                            dv.getUint16(14, true),
                            dv.getInt32(8, true),
                        ) ??
                        rawVideoCodecForFourcc(fourcc(data, 16)) ??
                        fourcc(data, 16);
                    let videoConfig: Uint8Array | undefined;
                    const mpegCodec = vfwVideoCodec(codec || fccHandler);
                    const codedFourcc = codec || fccHandler;
                    if (
                        ck.size > 40 &&
                        (isVfwAvcFourcc(codedFourcc) ||
                            isHevcFourcc(codedFourcc) ||
                            windowsMediaVideoCodec(codedFourcc) ||
                            mpegCodec)
                    ) {
                        demuxAssert(
                            ck.size - 40 <= MAX_AVI_AVC_CONFIG_BYTES,
                            `AVI ${mpegCodec ? 'MPEG video' : 'H.264'} configuration exceeds its ` +
                                `size limit`,
                        );
                        videoConfig = (await reader.bytes(ck.data + 40, ck.size - 40)).slice();
                    } else if (isPalettedRawVideo(codec)) {
                        // RGBQUAD entries follow the header: biClrUsed of them, or all 2^biBitCount
                        // when zero.
                        const headerBytes = Math.max(40, Math.min(dv.getUint32(0, true), ck.size));
                        const entries = Math.min(
                            dv.getUint32(32, true) || 1 << dv.getUint16(14, true),
                            256,
                        );
                        const bytes = Math.min(entries * 4, ck.size - headerBytes) & ~3;
                        demuxAssert(bytes > 0, 'AVI palette-indexed video has no palette');
                        videoConfig = (await reader.bytes(ck.data + headerBytes, bytes)).slice();
                    }
                    cb({
                        streamIndex,
                        type: 'video',
                        codec: codec || fccHandler,
                        width: w,
                        height: h,
                        rate,
                        scale,
                        start: streamStart,
                        length: streamLength,
                        sampleSize,
                        audioFormat: 0,
                        sampleRate: 0,
                        channelCount: 0,
                        codecConfig: videoConfig,
                    });
                } else {
                    const fmtBytes = await reader.bytes(ck.data, Math.min(ck.size, 40));
                    const audioFmt = waveFormatTag(fmtBytes);
                    const ch = dv.getUint16(2, true);
                    const sr = dv.getUint32(4, true);
                    demuxAssert(sr > 0, 'AVI audio sample rate must be positive');
                    demuxAssert(ch > 0, 'AVI audio channel count must be positive');
                    if (rate === 0) rate = sr;
                    let audioConfig: Uint8Array | undefined;
                    let pcmCodec = '';
                    let blockAlign: number | undefined;
                    if (AAC_WAVE_TAGS.has(audioFmt)) {
                        // An AudioSpecificConfig after WAVEFORMATEX; without one the chunks carry
                        // ADTS frames.
                        pcmCodec = 'mp4a.40.2';
                        const extension = ck.size >= 18 ? fmtBytes[16]! | (fmtBytes[17]! << 8) : 0;
                        if (extension >= 2 && extension <= 64 && ck.size >= 18 + extension) {
                            const asc = (await reader.bytes(ck.data + 18, extension)).slice();
                            const parsed = parseAacAudioSpecificConfig(asc);
                            if (parsed) {
                                audioConfig = asc;
                                pcmCodec = `mp4a.40.${parsed.audioObjectType}`;
                            }
                        }
                    } else if (windowsMediaAudioCodec(audioFmt)) {
                        demuxAssert(
                            ck.size >= 18 && ck.size <= MAX_WAVE_FORMAT_BYTES,
                            'AVI WAVEFORMATEX is invalid',
                        );
                        const wave = parseWaveFormatEx(await reader.bytes(ck.data, ck.size));
                        demuxAssert(
                            wave && wave.blockAlign > 0,
                            'AVI Windows Media Audio requires a block alignment',
                        );
                        audioConfig = normalizedWaveFormatEx(await reader.bytes(ck.data, ck.size));
                    } else if (
                        audioFmt === 1 ||
                        audioFmt === 3 ||
                        audioFmt === 0xfffe ||
                        audioFmt === 6 ||
                        audioFmt === 7
                    ) {
                        demuxAssert(ck.size >= 16, 'AVI PCM format is truncated');
                        demuxAssert(
                            ck.size <= MAX_WAVE_FORMAT_BYTES,
                            'AVI PCM format exceeds its size limit',
                        );
                        let wave;
                        try {
                            wave = parseWaveFormat(
                                await reader.bytes(ck.data, ck.size),
                                context.lenient
                                    ? (declared, expected) =>
                                          context.warn(
                                              'AVI_PCM_BYTE_RATE',
                                              `AVI PCM byte rate ${declared} is wrong; using ` +
                                                  `${expected}`,
                                          )
                                    : undefined,
                            );
                        } catch (error) {
                            throw new DemuxError(
                                `Malformed AVI PCM format: ` +
                                    `${error instanceof Error ? error.message : String(error)}`,
                            );
                        }
                        audioConfig = wave.codecConfig;
                        blockAlign = wave.blockAlign;
                        pcmCodec = wave.codec;
                        if (sampleSize !== blockAlign || scale * sr !== rate) {
                            demuxAssert(
                                context.lenient,
                                'AVI PCM stream sample size or time base is inconsistent',
                            );
                            context.warn(
                                'AVI_PCM_STREAM_HEADER',
                                `AVI PCM stream ${streamIndex} header disagrees with its format`,
                            );
                            [sampleSize, scale, rate] = [blockAlign, 1, sr];
                        }
                    }
                    cb({
                        streamIndex,
                        type: 'audio',
                        codec: pcmCodec,
                        width: 0,
                        height: 0,
                        rate,
                        scale,
                        start: streamStart,
                        length: streamLength,
                        sampleSize,
                        audioFormat: audioFmt,
                        sampleRate: sr,
                        channelCount: ch,
                        codecConfig: audioConfig,
                        blockAlign,
                        frameBlockAlign: dv.getUint16(12, true),
                    });
                }
            }
            pos = ck.next;
        }
    }

    /**
     * AVI 'dc' chunks carry no random-access flag of their own; MJPEG frames are all intra, and
     * VP8/VP9 frame headers state the frame type, so those keyframes are read from the payload
     * instead of only trusting 'db' chunk ids.
     */
    /**
     * HEVC chunks carry Annex B or four-byte length-prefixed units; a leading length below 0x200
     * looks like a three-byte start code, so that case is settled by whether the lengths tile the
     * chunk.
     */
    private async hevcAnnexB(reader: ChunkReader, offset: number, size: number): Promise<boolean> {
        if (size < 4) return false;
        const head = await reader.bytes(offset, 4);
        if (!isAnnexB(head)) return false;
        if (head[2] === 0 || size > MAX_ELEMENT_BYTES) return true;
        return !isValidHevcWalk(await reader.bytes(offset, size), 4);
    }

    private async inspectKeyframe(
        codec: string,
        reader: ChunkReader,
        offset: number,
        size: number,
        annexB: boolean,
        config: Uint8Array | undefined,
    ): Promise<boolean> {
        if (codec === 'mjpeg' || codec === DV_VIDEO || codec.startsWith('raw.')) return true;
        if (isWindowsMediaVideo(codec))
            return isWindowsMediaIntraFrame(
                codec,
                await reader.bytes(offset, Math.min(size, 256)),
                config,
            );
        if (isHevcCodec(codec)) {
            // Parameter sets and SEI precede the first slice; the window grows until a VCL unit is
            // seen.
            for (let window = 256; ; window *= 4) {
                const head = await reader.bytes(offset, Math.min(size, window));
                const nals = annexB
                    ? splitAnnexBNals(head)
                    : (splitLengthPrefixedNals(head, 4) ?? lengthPrefixedHeads(head));
                const vcl = nals.find(nal => ((nal[0]! >> 1) & 0x3f) < 32);
                if (vcl) {
                    const type = (vcl[0]! >> 1) & 0x3f;
                    return type >= 16 && type <= 23;
                }
                if (head.length >= size || window >= 65536) return false;
            }
        }

        if (codec === 'h263') return h263Intra(await reader.bytes(offset, Math.min(size, 16)));
        if (codec.startsWith('msmpeg4'))
            return msmpeg4Intra(codec, await reader.bytes(offset, Math.min(size, 8)));
        if (codec !== 'vp8' && codec !== 'vp9') return false;
        if (size < 1) return false;

        const head = await reader.bytes(offset, Math.min(size, 4));
        if (codec === 'vp8') return (head[0]! & 1) === 0;
        const first = head[0]!;
        if (first >> 6 !== 2) return false;

        const profile = ((first >> 5) & 1) | (((first >> 4) & 1) << 1);
        let bit = 4 + (profile === 3 ? 1 : 0);
        const flag = (): number => {
            const value = (head[bit >> 3]! >> (7 - (bit & 7))) & 1;
            bit++;
            return value;
        };
        if (flag()) return false;
        return flag() === 0;
    }

    private mapVideoCodec(fourcc: string): string {
        if (fourcc.startsWith('raw.')) return fourcc;
        const uc = fourcc.toUpperCase().trim();
        if (isVfwAvcFourcc(uc)) return 'avc1.640028';
        if (isHevcFourcc(uc)) return 'hev1';
        const windowsMedia = windowsMediaVideoCodec(uc);
        if (windowsMedia) return windowsMedia;
        if (uc === 'VP8\0' || uc === 'VP80') return 'vp8';
        if (uc === 'VP9\0' || uc === 'VP90') return 'vp9';
        if (MJPEG_FOURCCS.has(uc)) return 'mjpeg';
        if (isDvFourcc(uc)) return DV_VIDEO;
        const mpeg = vfwVideoCodec(fourcc);
        if (mpeg) return mpeg;
        throw new DemuxError(`AVI video codec '${uc}' is not supported`);
    }

    private mapAudioFormat(tag: number): string {
        const codec = windowsMediaAudioCodec(tag) ?? compressedWaveCodec(tag);
        if (codec) return codec;
        throw new DemuxError(`AVI audio format ${waveTagName(tag)} is not supported`);
    }
}

/** AVI demuxer (bounded RIFF/AVIX traversal, stream time bases). */
export class AviDemuxer {
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private readonly limits: ResolvedDemuxBudget;
    declare private readonly recoverPackets: boolean;
    declare private readonly diagnosticOptions: DiagnosticOptions;

    constructor(options: AviDemuxerOptions = {}) {
        this.limits = resolveDemuxBudget(options);
        const { recovery, validation, metadataPolicy, onWarning, maxWarnings } = options;
        if (recovery !== undefined && recovery !== 'complete-packets')
            throw new MediaForgeError('recovery must be complete-packets when provided', 'INPUT');
        this.recoverPackets = recovery === 'complete-packets';
        this.diagnosticOptions = { validation, metadataPolicy, onWarning, maxWarnings };
    }

    /**
     * Parses the container with windowed reads and returns tracks plus encoded samples; honors
     * `signal`.
     */
    async demux(
        input: File | Blob | Source,
        signal?: AbortSignal,
        diagnostics = new DiagnosticContext(
            this.diagnosticOptions,
            this.recoverPackets ? 'compatible' : 'strict',
        ),
    ): Promise<DemuxResult> {
        try {
            const { limits, recoverPackets } = this;
            return await new AviDemuxRun(limits, recoverPackets, input, signal, diagnostics).run();
        } catch (e) {
            throw demuxFailure(e);
        }
    }
}

/**
 * NAL unit heads of a four-byte length-prefixed sample prefix whose final unit is cut by the prefix
 * window.
 */
function lengthPrefixedHeads(head: Uint8Array): Uint8Array[] {
    const nals: Uint8Array[] = [];
    for (let pos = 0; pos + 5 <= head.length;) {
        const length = u32be(head, pos);
        if (length < 1) break;
        nals.push(head.subarray(pos + 4, Math.min(head.length, pos + 4 + length)));
        pos += 4 + length;
    }
    return nals;
}

function isHevcFourcc(value: string): boolean {
    return /^(HEVC|H265|HVC1|HEV1|X265)$/.test(value.toUpperCase().trim());
}

function parseMoviChunkId(id: string): { index: number; kind: 'dc' | 'db' | 'wb' } | null {
    const d0 = id.charCodeAt(0) - 0x30;
    const d1 = id.charCodeAt(1) - 0x30;
    if (d0 < 0 || d0 > 9 || d1 < 0 || d1 > 9) return null;
    const kind = id.slice(2);
    if (kind !== 'dc' && kind !== 'db' && kind !== 'wb') return null;
    return { index: d0 * 10 + d1, kind };
}

/**
 * WAVEFORMATEX tags of AAC: the registered 0x00FF and the tags of FAAD, CoreAac and other VfW
 * filters.
 */
const AAC_WAVE_TAGS = new Set([0x00ff, 0x706d, 0x4143, 0xa106]);

/**
 * Motion JPEG FourCCs of VfW capture cards and cameras, as ffmpeg's RIFF table lists them; each
 * packet is a JPEG.
 */
const MJPEG_FOURCCS = new Set([
    'MJPG',
    'AVRN',
    'AVDJ',
    'IJPG',
    'DMB1',
    'ACDV',
    'QIVG',
    'SLMJ',
    'CJPG',
    'MTSJ',
    'ZJPG',
    'MMJP',
    'JPGL',
]);

/**
 * Chunk ids ffmpeg's AVI resynchronization accepts: stream data, stream indexes, lists and padding.
 */
const MOVI_CHUNK_ID =
    /^(?:[0-9]{2}(?:dc|db|wb|pc|tx|__)|ix[0-9]{2}|[0-9]{2}ix|LIST|JUNK|JUNQ|idx1)$/;

/**
 * How far before a declared chunk end the next chunk header is looked for when the declared size
 * overruns.
 */
const LOOKBACK_BYTES = 4096;

/** Bytes read per step while scanning damaged movi data for the next chunk header. */
const RESYNC_WINDOW_BYTES = 64 * 1024;

/** 'AVI ' and the 'AVI\x19' form some camera firmware writes, which ffmpeg also reads. */
function isAviForm(form: string): boolean {
    return form === 'AVI ' || form === 'AVI\x19';
}

/** A known movi chunk id for a declared stream whose payload ends inside `end`. */
function plausibleMoviChunk(
    bytes: Uint8Array,
    at: number,
    pos: number,
    end: number,
    streams: number,
): boolean {
    const id = fourcc(bytes, at);
    if (!MOVI_CHUNK_ID.test(id)) return false;
    const digits = /^[0-9]{2}/.test(id) ? id.slice(0, 2) : id.startsWith('ix') ? id.slice(2) : '';
    if (digits && Number(digits) >= streams) return false;
    return pos + 8 + u32le(bytes, at + 4) <= end;
}

interface AviHeaderContext {
    /** avih dwMicroSecPerFrame, the frame period that stands in for a missing stream time base. */
    frameMicroseconds: number;
    readonly lenient: boolean;
    readonly warn: (code: string, message: string) => void;
}

const EMPTY_STREAM = {
    width: 0,
    height: 0,
    rate: 0,
    scale: 0,
    start: 0,
    length: 0,
    sampleSize: 0,
    audioFormat: 0,
    sampleRate: 0,
    channelCount: 0,
} as const;

interface AviStream {
    readonly index: number;
    readonly kind: 'video' | 'audio';
    readonly info: StreamInfo;
    codec: string;
    /** Seconds per stream unit (dwScale / dwRate). */
    readonly tick: number;
    readonly start: number;
    /** Units read so far: frame slots of video, sample frames or chunks of audio. */
    units: number;
    readonly samples: Sample[];
    codecConfig?: Uint8Array;
    avc?: AviAvcReader;
    mpeg?: AviMpegVideoReader;
    readonly pictureTypes: number[];
    readonly order: { sample: Sample; order: AvcPictureOrder }[];
    mpegAudio?: AviMpegAudioReader;
    /** Samples per channel of the MPEG audio frames read so far. */
    frames: number;
    skipped: number;
    sampleRate: number;
    channelCount: number;
    readonly sampleSize: number;
    readonly blockAlign: number;
    /**
     * Bytes per clock unit of a chunk of MPEG audio without a sample size (DirectShow VBR); 0
     * counts chunks.
     */
    readonly frameBlockAlign: number;
    /**
     * Drop frames the idx1 index alone records (zero-size entries without a movi chunk): `drops[j]`
     * slots precede the j-th stored chunk, and `sizes[j]` is that chunk's size, which must match
     * for the schedule to apply.
     */
    indexDrops?: {
        readonly drops: readonly number[];
        readonly sizes: readonly number[];
        chunks: number;
    };
}

interface StreamInfo {
    streamIndex: number;
    type: 'video' | 'audio' | 'unsupported';
    codec: string;
    width: number;
    height: number;
    rate: number;
    scale: number;
    start: number;
    length: number;
    sampleSize: number;
    audioFormat: number;
    sampleRate: number;
    channelCount: number;
    codecConfig?: Uint8Array;
    blockAlign?: number;
    /**
     * nBlockAlign of the audio format: with no sample size, a chunk spans its bytes over this many
     * units.
     */
    frameBlockAlign?: number;
}

interface AviChunk {
    id: string;
    type: string;
    size: number;
    data: number;
    end: number;
    next: number;
}

type AviChunkReader = (pos: number, end: number, allowTail?: boolean) => Promise<AviChunk>;

/** The avi plugin's 'avi' reader, which its index loads on first use. */
export const aviReader: Reader = {
    read: (source, options) =>
        new AviDemuxer(options).demux(source, options.signal, readerDiagnostics(options)),
    capabilities: HANDS_OVER,
};
