import type { Reader } from '../../core/contracts/reader';
import { HANDS_OVER, readerDiagnostics } from '../shared/contract';
import type { Source } from '../../core/model/types';
import { BlobSource } from '../../core/io/sources/sources';
import { ChunkReader } from '../../core/io/sources/chunk-reader';
import { demuxAssert, demuxFailure } from '../../core/errors/demux-guard';
import {
    DemuxIndexBudget,
    resolveDemuxBudget,
    type ResolvedDemuxBudget,
} from '../shared/demux-budget';
import type { DemuxBudgetOptions } from '../../core/contracts/reader';
import { yieldEventLoop } from '../../core/io/event-loop';
import { DemuxError, throwIfAborted } from '../../core/errors/errors';
import type { Sample, DemuxResult, Mp4CodecConfiguration } from '../../core/model/track';
import { parseAacAudioSpecificConfig } from '../../core/codec-config/audio/adts';
import {
    parseH264Sps,
    parseHevcSps,
    type ParsedSps,
} from '../../core/codec-config/video/video-sps';
import { hevcCodecString, hevcConfigToAnnexB } from '../../core/codec-config/video/hevc-codec';
import { avcConfigToAnnexB, splitAnnexBNals } from '../../core/codec-config/video/annexb';
import { avcCodecString } from '../../core/codec-config/video/video-sps';
import {
    av1CodecString,
    av1SequenceHeaderFromConfig,
} from '../../core/codec-config/video/av1-config';
import { parseMpegAudioHeader } from '../../core/codec-config/audio/mpeg-audio-header';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { AviMpegAudioReader } from '../shared/vfw/mpeg-audio';
import { isVpcC, vp9CodecFromConfig } from '../../core/codec-config/video/vp9-config';
import { sameBytes } from '../../core/bytes/bytes';
import { decodeTime } from '../../core/model/media-time';
import { u32be, dataView } from '../../core/bytes/byte-fields';

interface FlvMetadata {
    duration?: number;
    framerate?: number;
    title?: string;
    width?: number;
    height?: number;
}

/** Largest composition offset read as such: ten seconds exceeds any decoder reorder delay. */
const MAX_COMPOSITION_OFFSET_MS = 10000;

interface ParsedAvcC extends ParsedSps {
    codec: string;
}

/** An FLV tag: its type, timestamp, where its data lies, and the first bytes of the data. */
interface FlvTag {
    readonly type: number;
    readonly timestampMs: number;
    readonly dataOffset: number;
    readonly dataSize: number;
    readonly prefix: Uint8Array;
}

class FlvDemuxRun {
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private budget: DemuxIndexBudget;
    declare private dataOffset: number;
    declare private declaresAudio: boolean;
    declare private declaresVideo: boolean;
    private readonly videoSamples: Sample[] = [];
    private readonly audioSamples: Sample[] = [];
    declare private skippedVideoCodec: string | undefined;
    private metadataWidth = 0;
    private metadataHeight = 0;
    declare private skippedAudioFormat: number | undefined;
    private readonly videoConfigurations: Mp4CodecConfiguration[] = [];
    private readonly audioConfigurations: Mp4CodecConfiguration[] = [];
    private currentVideoConfigIndex = -1;
    private currentAudioConfigIndex = -1;
    private videoCodec = '';
    private audioCodec = '';
    private width = 0;
    private height = 0;
    private displayWidth = 0;
    private displayHeight = 0;
    private pixelAspectRatioNum = 1;
    private pixelAspectRatioDen = 1;
    private sampleRate = 44100;
    private channelCount = 2;
    declare private videoCodecConfig: Uint8Array | undefined;
    declare private audioCodecConfig: Uint8Array | undefined;
    private metadataDuration = 0;
    private metadataFrameRate = 0;
    declare private metadataTitle: string | undefined;
    private observedEndTimestamp = 0;
    declare private maxTags: number;
    private tags = 0;
    private expectedPreviousTagSize = 0;
    private incomplete = false;
    private mp3 = new AviMpegAudioReader();
    private mp3Clock = 0;
    private mp3Skipped = 0;
    declare private readonly limits: ResolvedDemuxBudget;
    declare private readonly input: File | Blob | Source;
    declare private readonly signal: AbortSignal | undefined;
    declare private readonly diagnostics: DiagnosticContext;
    declare private reader: ChunkReader;
    declare private size: number;
    declare private pos: number;
    private readonly recovered = new Set<string>();
    private recover(code: string, message: string, offset: number): void {
        if (this.recovered.has(code)) return;
        this.recovered.add(code);
        this.diagnostics.recover({ code, message, offset, format: 'flv' });
    }

    declare private lenient: boolean;
    /**
     * A tag header that names a known tag type and whose payload ends inside the file; ffmpeg
     * ignores StreamID.
     */
    private async tagHeaderAt(at: number): Promise<number> {
        if (at + 11 > this.size) return -1;
        const header = await this.reader.bytes(at, 11);
        if (![8, 9, 18].includes(header[0]! & 0x1f)) return -1;
        const length = (header[1]! << 16) | (header[2]! << 8) | header[3]!;
        return at + 11 + length <= this.size ? length : -1;
    }

    /**
     * A tag followed by its matching PreviousTagSize, by another plausible tag header, or by
     * the file end.
     */
    private async tagLooksValid(at: number): Promise<boolean> {
        const length = await this.tagHeaderAt(at);
        if (length < 0) return false;
        const end = at + 11 + length;
        if (end + 4 > this.size) return true;
        const trailer = await this.reader.bytes(end, 4);
        const previous = u32be(trailer, 0);
        return (
            previous === 11 + length ||
            end + 4 === this.size ||
            (await this.tagHeaderAt(end + 4)) >= 0
        );
    }

    /**
     * A known tag type whose payload runs past the end of a cut file: truncation, not damage.
     */
    private async truncatedTag(at: number): Promise<boolean> {
        if (at + 11 > this.size) return true;
        const header = await this.reader.bytes(at, 11);
        const length = (header[1]! << 16) | (header[2]! << 8) | header[3]!;
        return [8, 9, 18].includes(header[0]! & 0x1f) && at + 11 + length > this.size;
    }

    /**
     * ffmpeg-style resynchronization after damage: the next offset holding a valid tag, or -1.
     */
    private async resync(from: number): Promise<number> {
        for (let at = from; at + 11 <= this.size; at++) {
            if ((at - from) % 65536 === 0) {
                throwIfAborted(this.signal);
                await yieldEventLoop();
            }
            const type = (await this.reader.bytes(at, 1))[0]! & 0x1f;
            if ((type === 8 || type === 9 || type === 18) && (await this.tagLooksValid(at)))
                return at;
        }
        return -1;
    }

    /**
     * A composition offset beyond any reorder depth is a writer defect; compatible reading
     * presents at DTS.
     */
    private plausibleCts(cts: number): number {
        if (Math.abs(cts) <= MAX_COMPOSITION_OFFSET_MS) return cts;
        demuxAssert(this.lenient, `FLV composition offset ${cts} ms is implausible`);
        this.recover(
            'FLV_COMPOSITION_OFFSET_IGNORED',
            `Ignored an implausible FLV composition offset of ${cts} ms`,
            this.pos,
        );
        return 0;
    }

    private repaired(message: string): void {
        if (this.recovered.has('FLV_TIMESTAMPS_REPAIRED')) return;
        this.recovered.add('FLV_TIMESTAMPS_REPAIRED');
        this.diagnostics.recover(
            { code: 'FLV_TIMESTAMPS_REPAIRED', message, format: 'flv' },
            message,
        );
    }

    constructor(
        limits: ResolvedDemuxBudget,
        input: File | Blob | Source,
        signal: AbortSignal | undefined,
        diagnostics: DiagnosticContext,
    ) {
        this.limits = limits;
        this.input = input;
        this.signal = signal;
        this.diagnostics = diagnostics;
    }

    async run(): Promise<DemuxResult> {
        this.budget = new DemuxIndexBudget(this.limits);
        const source = this.input instanceof Blob ? new BlobSource(this.input) : this.input;
        this.reader = new ChunkReader(source);
        this.size = this.reader.size;
        const head = await this.reader.bytes(0, 9);
        if (head.length < 9 || head[0] !== 0x46 || head[1] !== 0x4c || head[2] !== 0x56) {
            throw new DemuxError('Not an FLV file');
        }

        const headerView = dataView(head);
        this.dataOffset = headerView.getUint32(5, false);
        demuxAssert(
            this.dataOffset >= 9 && this.dataOffset <= this.size - 4,
            `invalid FLV data offset ${this.dataOffset} for ${this.size}-byte input`,
        );
        const headerFlags = head[4]!;
        this.declaresAudio = !!(headerFlags & 0x04);
        this.declaresVideo = !!(headerFlags & 0x01);
        this.maxTags = Math.floor(Math.max(0, this.size - this.dataOffset) / 15) + 1024;
        this.pos = this.dataOffset;
        this.lenient = this.diagnostics.validation === 'compatible';
        await this.readTags();
        return await this.buildResult();
    }

    /** Reads the tags after the header, resynchronising after damage in compatible reading. */
    private async readTags(): Promise<void> {
        while (true) {
            if ((this.tags & 0x03ff) === 0) throwIfAborted(this.signal);
            if ((this.tags & 0x0fff) === 0) await yieldEventLoop();

            if (this.pos + 4 > this.size) {
                this.recover(
                    'FLV_TRUNCATED',
                    'truncated FLV PreviousTagSize at end of file',
                    this.pos,
                );
                break;
            }
            const previousBytes = await this.reader.bytes(this.pos, 4);
            const previousTagSize = dataView(previousBytes).getUint32(0, false);
            if (previousTagSize !== this.expectedPreviousTagSize)
                this.recover(
                    'FLV_PREVIOUS_TAG_SIZE',
                    `FLV PreviousTagSize mismatch: expected ${this.expectedPreviousTagSize}, got ` +
                        `${previousTagSize}`,
                    this.pos,
                );
            this.pos += 4;
            if (this.pos === this.size) break;
            if (
                this.lenient &&
                !(await this.tagLooksValid(this.pos)) &&
                !(await this.truncatedTag(this.pos))
            ) {
                const found = await this.resync(this.pos + 1);
                const skipped = (found < 0 ? this.size : found) - this.pos;
                const until = found < 0 ? 'at the end of the file' : 'to the next tag';
                this.diagnostics.warn({
                    code: 'FLV_RESYNCHRONIZED',
                    message: `Skipped ${skipped} bytes of unreadable FLV data ${until}`,
                    offset: this.pos,
                    format: 'flv',
                });
                if (found < 0) {
                    this.incomplete = true;
                    break;
                }
                this.pos = found;
                const trailer = await this.reader.bytes(this.pos - 4, 4);
                this.expectedPreviousTagSize = u32be(trailer, 0);
            }

            demuxAssert(
                ++this.tags <= this.maxTags,
                `FLV tag count implausible for a ${this.size}-byte file`,
            );
            if (this.pos + 11 > this.size) {
                this.incomplete = true;
                this.recover('FLV_TRUNCATED', 'truncated FLV tag header at end of file', this.pos);
                break;
            }
            const tagHeader = await this.reader.bytes(this.pos, 11);
            const tagType = tagHeader[0]!;
            const dataSize = (tagHeader[1]! << 16) | (tagHeader[2]! << 8) | tagHeader[3]!;
            const tsLow = (tagHeader[4]! << 16) | (tagHeader[5]! << 8) | tagHeader[6]!;
            const timestampMs = (((tagHeader[7] ?? 0) << 24) | tsLow) >>> 0;
            if (tagHeader[8] !== 0 || tagHeader[9] !== 0 || tagHeader[10] !== 0)
                this.recover('FLV_STREAM_ID', 'FLV tag has a non-zero StreamID', this.pos);
            const tagDataOffset = this.pos + 11;
            if (tagDataOffset + dataSize > this.size) {
                this.incomplete = true;
                this.recover(
                    'FLV_TRUNCATED',
                    `truncated FLV tag payload: need ${dataSize} byte(s), ` +
                        `only ${Math.max(0, this.size - tagDataOffset)} remain`,
                    this.pos,
                );
                break;
            }
            this.observedEndTimestamp = Math.max(this.observedEndTimestamp, timestampMs / 1000);

            const prefixLength = Math.min(dataSize, 16);
            const pl =
                prefixLength > 0
                    ? await this.reader.bytes(tagDataOffset, prefixLength)
                    : new Uint8Array(0);
            try {
                if (dataSize > 0)
                    await this.readTag({
                        type: tagType,
                        timestampMs,
                        dataOffset: tagDataOffset,
                        dataSize,
                        prefix: pl,
                    });
            } catch (error) {
                if (!this.lenient || !(error instanceof DemuxError)) throw error;
                this.diagnostics.warn({
                    code: 'FLV_TAG_DAMAGED',
                    message: `Skipped a damaged FLV tag: ${error.message}`,
                    offset: this.pos,
                    format: 'flv',
                });
            }

            this.expectedPreviousTagSize = 11 + dataSize;
            this.pos = tagDataOffset + dataSize;
        }
    }

    /** The tracks of the samples read, their durations settled from timestamps and metadata. */
    private async buildResult(): Promise<DemuxResult> {
        const { audioSamples, videoSamples } = this;
        if (this.mp3Skipped > 0)
            this.diagnostics.recover({
                code: 'FLV_AUDIO_RESYNCHRONIZED',
                format: 'flv',
                message: `Skipped ${this.mp3Skipped} bytes between MPEG audio frames`,
            });
        if (this.mp3.pending)
            this.diagnostics.warn({
                code: 'FLV_AUDIO_TAIL_DISCARDED',
                format: 'flv',
                message: 'Discarded an unfinished MPEG audio frame at the end of the stream',
            });
        const firstMp3 = audioSamples.length > 0 && !this.audioCodec ? audioSamples[0] : undefined;
        if (firstMp3) {
            const header = parseMpegAudioHeader(
                firstMp3.data ?? (await this.reader.bytes(firstMp3.offset, 4)),
                0,
            )!;
            this.audioCodec = header.format;
            this.sampleRate = header.sampleRate;
            this.channelCount = header.channels;
        }
        const declaredEnd = this.incomplete
            ? this.observedEndTimestamp
            : Math.max(this.metadataDuration, this.observedEndTimestamp);
        let shift = 0;
        let step = 0;
        for (let i = 0; i < videoSamples.length - 1; i++) {
            const currentDts = decodeTime(videoSamples[i]!);
            const next = videoSamples[i + 1]!;
            let nextDts = decodeTime(next) + shift;
            if (step > 0 && currentDts - nextDts > 1) {
                this.repaired(
                    `FLV video time jumps back at sample ${i + 1}; later frames follow on`,
                );
                shift += currentDts + step - nextDts;
                nextDts = currentDts + step;
            }
            if (shift) {
                next.timestamp += shift;
                if (next.decodeTimestamp !== undefined) next.decodeTimestamp += shift;
            }
            if (nextDts > currentDts) step = nextDts - currentDts;
            if (nextDts <= currentDts) {
                // As ffmpeg does when muxing: move the DTS one millisecond past its predecessor,
                // keeping PTS >= DTS.
                this.repaired(`FLV video time does not increase at sample ${i + 1}; moved it on`);
                nextDts = currentDts + 0.001;
                next.decodeTimestamp = nextDts;
                next.timestamp = Math.max(next.timestamp, nextDts);
                next.compositionTimeOffset = next.timestamp - nextDts;
            }
            videoSamples[i]!.duration = nextDts - currentDts;
        }
        if (videoSamples.length > 0) {
            const last = videoSamples[videoSamples.length - 1]!;

            // The declared end bounds presentation time; a composition offset must not stretch the
            // final frame.
            const declaredTail = declaredEnd - last.timestamp;
            if (declaredTail > 0 && Number.isFinite(declaredTail)) {
                last.duration = declaredTail;
            } else if (videoSamples.length > 1) {
                last.duration = videoSamples[videoSamples.length - 2]!.duration;
            } else if (this.metadataFrameRate > 0) {
                last.duration = 1 / this.metadataFrameRate;
            } else {
                last.duration = 1 / 30;
            }
            demuxAssert(
                last.duration > 0 && Number.isFinite(last.duration),
                'FLV final video sample has an invalid duration',
            );
        }
        for (let i = 0; i < audioSamples.length - 1; i++) {
            const current = audioSamples[i]!;
            const next = audioSamples[i + 1]!;
            let delta = decodeTime(next) - decodeTime(current);
            if (delta < 0) {
                this.repaired(`FLV audio time moves back at sample ${i + 1}; moved it on`);
                next.timestamp = next.decodeTimestamp = current.timestamp + current.duration;
                delta = current.duration;
            }
            if (delta > 0 && current.codecConfigIndex !== next.codecConfigIndex) {
                current.duration = delta;
            }
        }
        if (audioSamples.length > 0) {
            // A coded frame lasts its samples; only a frame of unknown length runs to the declared
            // end.
            const last = audioSamples[audioSamples.length - 1]!;
            const declaredTail = declaredEnd - last.timestamp;
            if (!(last.duration > 0) && declaredTail > 0 && Number.isFinite(declaredTail))
                last.duration = declaredTail;
        }
        let totalDuration = declaredEnd;
        for (const sample of videoSamples) {
            totalDuration = Math.max(
                totalDuration,
                sample.timestamp + sample.duration,
                decodeTime(sample) + sample.duration,
            );
        }
        for (const sample of audioSamples) {
            totalDuration = Math.max(totalDuration, sample.timestamp + sample.duration);
        }
        let start = Infinity;
        for (const samples of [videoSamples, audioSamples])
            for (const sample of samples) start = Math.min(start, decodeTime(sample));
        const lateStart = Number.isFinite(start) && start > 0 && start > this.metadataDuration;
        if (lateStart) totalDuration = Math.max(this.metadataDuration, totalDuration - start);
        let audioEnd = 0;
        for (const sample of audioSamples)
            audioEnd = Math.max(audioEnd, sample.timestamp + sample.duration);
        const audioDuration = Math.min(totalDuration, audioEnd - (lateStart ? start : 0));
        const result: DemuxResult = {
            ...(this.metadataTitle !== undefined ? { title: this.metadataTitle } : {}),
            videoTracks: [],
            audioTracks: [],
        };
        const skipped = [
            ...(this.skippedVideoCodec !== undefined && !videoSamples.length
                ? [this.skippedVideoCodec]
                : []),
            ...(this.skippedAudioFormat !== undefined && !audioSamples.length
                ? [`audio format ${this.skippedAudioFormat}`]
                : []),
        ];
        demuxAssert(
            videoSamples.length > 0 || audioSamples.length > 0 || skipped.length === 0,
            `FLV holds only unsupported codecs: ${skipped.join(', ')}`,
        );
        if (skipped.length)
            this.diagnostics.warn({
                code: 'FLV_UNSUPPORTED_CODEC',
                format: 'flv',
                message: `Omitted FLV streams with unsupported ${skipped.join(' and ')}`,
            });
        for (const [declared, samples, other, kind] of [
            [
                this.declaresVideo && this.skippedVideoCodec === undefined,
                videoSamples,
                audioSamples,
                'video',
            ],
            [
                this.declaresAudio && this.skippedAudioFormat === undefined,
                audioSamples,
                videoSamples,
                'audio',
            ],
        ] as const) {
            if (!declared || samples.length > 0) continue;
            const message = `FLV header declares ${kind} but no ${kind} tags were found`;
            demuxAssert(this.lenient && other.length > 0, message);
            this.diagnostics.warn({
                code: 'FLV_EMPTY_STREAM',
                message: `${message}; the stream is omitted`,
                format: 'flv',
            });
        }
        if (videoSamples.length > 0) {
            demuxAssert(
                !!this.videoCodecConfig && this.videoConfigurations.length > 0,
                'FLV video samples have no sequence header',
            );
            const outputCodec =
                this.videoConfigurations.length > 1
                    ? this.videoCodec.replace(/^avc1/i, 'avc3')
                    : this.videoCodec;
            result.videoTracks.push({
                codec: outputCodec,
                timestampResolutionSeconds: 0.001,
                width: this.width,
                height: this.height,
                displayWidth: this.displayWidth,
                displayHeight: this.displayHeight,
                pixelAspectRatioNum: this.pixelAspectRatioNum,
                pixelAspectRatioDen: this.pixelAspectRatioDen,
                sampleRate: 0,
                channelCount: 0,
                duration: totalDuration,
                samples: videoSamples,
                codecConfig: this.videoCodecConfig,
                codecConfigurations: this.videoConfigurations,
                ...(this.incomplete ? { incomplete: true } : {}),
            });
        }
        if (audioSamples.length > 0) {
            result.audioTracks.push({
                codec: this.audioCodec,
                timestampResolutionSeconds: 0.001,
                width: 0,
                height: 0,
                sampleRate: this.sampleRate,
                channelCount: this.channelCount,
                duration: audioDuration > 0 ? audioDuration : totalDuration,
                samples: audioSamples,
                codecConfig: this.audioCodecConfig,
                codecConfigurations:
                    this.audioConfigurations.length > 0 ? this.audioConfigurations : undefined,
                ...(this.incomplete ? { incomplete: true } : {}),
            });
        }
        return result;
    }

    private parseAvcC(avcC: Uint8Array): ParsedAvcC | null {
        const sets = avcConfigToAnnexB(avcC);
        const sps = sets && splitAnnexBNals(sets.paramSets).find(nal => (nal[0]! & 0x1f) === 7);
        const parsed = sps ? parseH264Sps(sps) : null;
        return parsed ? { ...parsed, codec: avcCodecString(avcC) } : null;
    }

    private parseHvcC(hvcC: Uint8Array): ParsedAvcC | null {
        const sets = hevcConfigToAnnexB(hvcC);
        if (!sets) return null;
        const sps = splitAnnexBNals(sets.paramSets).find(nal => ((nal[0]! >> 1) & 0x3f) === 33);
        const parsed = sps ? parseHevcSps(sps) : null;
        return parsed ? { ...parsed, codec: hevcCodecString('hvc1', hvcC) } : null;
    }

    /** vpcC carries no frame size; onMetaData supplies it. */
    private parseVpcC(vpcC: Uint8Array, width: number, height: number): ParsedAvcC | null {
        if (!isVpcC(vpcC)) return null;
        return {
            codec: vp9CodecFromConfig('vp09.00.10.08', vpcC),
            width,
            height,
            displayWidth: width,
            displayHeight: height,
            pixelAspectRatioNum: 1,
            pixelAspectRatioDen: 1,
        };
    }

    private parseAv1C(av1C: Uint8Array): ParsedAvcC | null {
        const codec = av1CodecString(av1C);
        const sequence = av1SequenceHeaderFromConfig(av1C);
        if (!codec || !sequence) return null;
        return {
            codec,
            width: sequence.width,
            height: sequence.height,
            displayWidth: sequence.width,
            displayHeight: sequence.height,
            pixelAspectRatioNum: 1,
            pixelAspectRatioDen: 1,
        };
    }

    /** Reads a tag of the kinds the reader knows, by its type; others are passed over. */
    private async readTag(tag: FlvTag): Promise<void> {
        if (tag.type === 18) await this.readScriptTag(tag);
        else if (tag.type === 9 && (tag.prefix[0]! & 0x80) !== 0)
            await this.readEnhancedVideoTag(tag);
        else if (tag.type === 9) await this.readVideoTag(tag);
        else if (tag.type === 8) await this.readAudioTag(tag);
    }

    /** Script data: the title, size, duration and frame rate of the metadata. */
    private async readScriptTag(tag: FlvTag): Promise<void> {
        if (tag.dataSize <= 256 * 1024) {
            const body = await this.reader.bytes(tag.dataOffset, tag.dataSize);
            const metadata = parseFlvMetadata(body);
            this.metadataTitle ??= metadata.title;
            this.metadataWidth ||= metadata.width ?? 0;
            this.metadataHeight ||= metadata.height ?? 0;
            if (
                metadata.duration !== undefined &&
                Number.isFinite(metadata.duration) &&
                metadata.duration > 0 &&
                metadata.duration <= 6 * 3600
            ) {
                this.metadataDuration = Math.max(this.metadataDuration, metadata.duration);
            }

            if (
                metadata.framerate !== undefined &&
                Number.isFinite(metadata.framerate) &&
                metadata.framerate > 0 &&
                metadata.framerate <= 1000
            ) {
                this.metadataFrameRate = metadata.framerate;
            }
        }
    }

    /** An enhanced RTMP video tag: frame type, packet type and a FourCC (hvc1, av01, vp09). */
    private async readEnhancedVideoTag(tag: FlvTag): Promise<void> {
        // Enhanced RTMP video tags: frame type, packet type and a FourCC (hvc1, av01,
        // vp09).
        const frameType = (tag.prefix[0]! >> 4) & 0x07;
        const packetType = tag.prefix[0]! & 0x0f;
        demuxAssert(tag.dataSize >= 5, 'truncated enhanced FLV video packet');
        const fourcc = String.fromCharCode(
            tag.prefix[1]!,
            tag.prefix[2]!,
            tag.prefix[3]!,
            tag.prefix[4]!,
        );

        const hevc = fourcc === 'hvc1';
        if (fourcc !== 'hvc1' && fourcc !== 'av01' && fourcc !== 'vp09')
            this.skippedVideoCodec ??= `enhanced video '${fourcc}'`;
        // ffmpeg announces AV1 with an empty sequence start before the one carrying
        // av1C.
        else if (packetType === 0 && tag.dataSize > 5) {
            const nextConfig = new Uint8Array(
                await this.reader.bytes(tag.dataOffset + 5, tag.dataSize - 5),
            );
            const parsed = hevc
                ? this.parseHvcC(nextConfig)
                : fourcc === 'av01'
                  ? this.parseAv1C(nextConfig)
                  : this.parseVpcC(nextConfig, this.metadataWidth, this.metadataHeight);

            demuxAssert(
                !!parsed,
                `invalid ${fourcc} configuration in enhanced FLV sequence header`,
            );
            this.useVideoConfig(nextConfig, parsed);
        } else if (packetType === 1 || packetType === 3) {
            const headerBytes = hevc && packetType === 1 ? 8 : 5;
            demuxAssert(tag.dataSize > headerBytes, 'empty enhanced FLV video frame');
            demuxAssert(
                this.currentVideoConfigIndex >= 0 && !!this.videoCodecConfig && !!this.videoCodec,
                'enhanced FLV video frame appears before a valid sequence header',
            );
            const cts = this.plausibleCts(
                headerBytes === 8
                    ? (((tag.prefix[5]! << 16) | (tag.prefix[6]! << 8) | tag.prefix[7]!) << 8) >> 8
                    : 0,
            );

            this.budget.reserveSamples(1, 256, 'FLV sample index');
            this.videoSamples.push({
                offset: tag.dataOffset + headerBytes,
                size: tag.dataSize - headerBytes,
                timestamp: (tag.timestampMs + cts) / 1000,
                decodeTimestamp: tag.timestampMs / 1000,
                compositionTimeOffset: cts / 1000,
                duration: 0,
                isKeyframe: frameType === 1,
                codecConfigIndex: this.currentVideoConfigIndex,
            });
        } else if (packetType !== 0 && packetType !== 2 && packetType !== 4 && packetType !== 5) {
            throw new DemuxError(`unsupported enhanced FLV video packet type ${packetType}`);
        }
    }

    /**
     * Takes the configuration a video sequence header carries; the stream's first one describes
     * the track.
     */
    private useVideoConfig(nextConfig: Uint8Array, parsed: ParsedAvcC): void {
        this.currentVideoConfigIndex = findOrAppendConfiguration(
            this.videoConfigurations,
            nextConfig,
            {
                codec: parsed.codec,
                codecConfig: nextConfig,
                width: parsed.width,
                height: parsed.height,
                displayWidth: parsed.displayWidth,
                displayHeight: parsed.displayHeight,
                pixelAspectRatioNum: parsed.pixelAspectRatioNum,
                pixelAspectRatioDen: parsed.pixelAspectRatioDen,
            },
        );
        if (!this.videoCodecConfig) {
            this.videoCodecConfig = nextConfig;
            this.videoCodec = parsed.codec;
            this.width = parsed.width;
            this.height = parsed.height;
            this.displayWidth = parsed.displayWidth;
            this.displayHeight = parsed.displayHeight;
            this.pixelAspectRatioNum = parsed.pixelAspectRatioNum;
            this.pixelAspectRatioDen = parsed.pixelAspectRatioDen;
        }
    }

    /** A video tag: AVC sequence headers and NAL units; other codecs are skipped. */
    private async readVideoTag(tag: FlvTag): Promise<void> {
        const frameType = (tag.prefix[0]! >> 4) & 0x0f;
        const codecId = tag.prefix[0]! & 0x0f;
        if (codecId !== 7) this.skippedVideoCodec ??= `video codec id ${codecId}`;
        else {
            demuxAssert(tag.dataSize >= 5, 'truncated FLV AVC video packet');
            const avcPacketType = tag.prefix[1]!;
            if (avcPacketType === 0) {
                demuxAssert(tag.dataSize > 5, 'empty FLV AVC sequence header');
                const cfgBytes = await this.reader.bytes(tag.dataOffset + 5, tag.dataSize - 5);
                const nextConfig = new Uint8Array(cfgBytes);
                const parsed = this.parseAvcC(nextConfig);
                demuxAssert(
                    !!parsed,
                    'invalid AvcDecoderConfigurationRecord in FLV sequence header',
                );
                if (this.videoConfigurations.length > 0) {
                    const firstLengthSize =
                        ((this.videoConfigurations[0]!.codecConfig[4] ?? 0xff) & 0x03) + 1;
                    const nextLengthSize = ((nextConfig[4] ?? 0xff) & 0x03) + 1;
                    demuxAssert(
                        firstLengthSize === nextLengthSize,
                        `FLV AVC NAL length size changed from ${firstLengthSize} to ` +
                            `${nextLengthSize}`,
                    );
                }
                this.useVideoConfig(nextConfig, parsed);
            } else if (avcPacketType === 1) {
                demuxAssert(tag.dataSize > 5, 'empty FLV AVC NALU packet');
                demuxAssert(
                    this.currentVideoConfigIndex >= 0 &&
                        !!this.videoCodecConfig &&
                        !!this.videoCodec,
                    'AVC NALU tag appears before a valid sequence header',
                );
                const cts = this.plausibleCts(
                    (((tag.prefix[2]! << 16) | (tag.prefix[3]! << 8) | tag.prefix[4]!) << 8) >> 8,
                );
                const pts = (tag.timestampMs + cts) / 1000;
                this.budget.reserveSamples(1, 256, 'FLV sample index');

                // Some encoders wrap a whole Annex B access unit in one NAL length; it
                // is read unwrapped.
                const wrapped =
                    this.lenient &&
                    tag.dataSize > 13 &&
                    u32be(tag.prefix, 5) === tag.dataSize - 9 &&
                    tag.prefix[9] === 0 &&
                    tag.prefix[10] === 0 &&
                    (tag.prefix[11] === 1 || (tag.prefix[11] === 0 && tag.prefix[12] === 1));
                if (wrapped)
                    this.recover(
                        'FLV_AVC_ANNEXB_WRAPPED',
                        'FLV AVC tags wrap Annex B data; read it as Annex B',
                        this.pos,
                    );
                this.videoSamples.push({
                    offset: tag.dataOffset + (wrapped ? 9 : 5),
                    size: tag.dataSize - (wrapped ? 9 : 5),
                    ...(wrapped ? { nalUnitFormat: 'annexb' as const } : {}),
                    timestamp: pts,
                    decodeTimestamp: tag.timestampMs / 1000,
                    compositionTimeOffset: cts / 1000,
                    duration: 0,
                    isKeyframe: frameType === 1,
                    codecConfigIndex: this.currentVideoConfigIndex,
                });
            } else if (avcPacketType !== 2) {
                throw new DemuxError(`unsupported FLV AVC packet type ${avcPacketType}`);
            }
        }
    }

    /** An audio tag: AAC, G.711 and MP3; other formats are skipped. */
    private async readAudioTag(tag: FlvTag): Promise<void> {
        const soundFormat = (tag.prefix[0]! >> 4) & 0x0f;
        if (soundFormat !== 10 && soundFormat !== 2 && soundFormat !== 7 && soundFormat !== 8)
            this.skippedAudioFormat ??= soundFormat;
        if (soundFormat === 10) {
            demuxAssert(tag.dataSize >= 2, 'truncated FLV AAC packet');
            const aacPacketType = tag.prefix[1]!;
            if (aacPacketType === 0) {
                demuxAssert(tag.dataSize > 2, 'empty FLV AAC sequence header');
                const cfgBytes = await this.reader.bytes(tag.dataOffset + 2, tag.dataSize - 2);
                const nextConfig = new Uint8Array(cfgBytes);
                const parsed = parseAacAudioSpecificConfig(nextConfig);
                demuxAssert(!!parsed, 'invalid AAC AudioSpecificConfig in FLV sequence header');
                demuxAssert(parsed.sampleRate > 0, 'AAC AudioSpecificConfig has no sampling rate');

                // Channel configuration 0 lays the channels out in a
                // program_config_element.
                const channels = parsed.channelCount;
                demuxAssert(channels > 0, 'AAC AudioSpecificConfig has no channel configuration');
                this.currentAudioConfigIndex = findOrAppendConfiguration(
                    this.audioConfigurations,
                    nextConfig,
                    {
                        codec: `mp4a.40.${parsed.audioObjectType}`,
                        codecConfig: nextConfig,
                        sampleRate: parsed.sampleRate,
                        channelCount: channels,
                        samplesPerAccessUnit: parsed.samplesPerAccessUnit,
                    },
                );
                if (!this.audioCodecConfig) {
                    this.audioCodecConfig = nextConfig;
                    this.audioCodec = `mp4a.40.${parsed.audioObjectType}`;
                    this.sampleRate = parsed.sampleRate;
                    this.channelCount = channels;
                }
            } else if (aacPacketType === 1) {
                demuxAssert(tag.dataSize > 2, 'empty FLV AAC raw packet');
                demuxAssert(
                    this.currentAudioConfigIndex >= 0 &&
                        !!this.audioCodecConfig &&
                        !!this.audioCodec,
                    'AAC raw tag appears before a valid sequence header',
                );
                const active = this.audioConfigurations[this.currentAudioConfigIndex]!;
                const activeRate = active.sampleRate ?? this.sampleRate;
                const samplesPerAccessUnit = active.samplesPerAccessUnit ?? 1024;
                demuxAssert(activeRate > 0, 'AAC configuration has an invalid sample rate');
                this.budget.reserveSamples(1, 256, 'FLV sample index');
                this.audioSamples.push({
                    offset: tag.dataOffset + 2,
                    size: tag.dataSize - 2,
                    timestamp: tag.timestampMs / 1000,
                    decodeTimestamp: tag.timestampMs / 1000,
                    duration: samplesPerAccessUnit / activeRate,
                    isKeyframe: true,
                    codecConfigIndex: this.currentAudioConfigIndex,
                });
            } else {
                throw new DemuxError(`unsupported FLV AAC packet type ${aacPacketType}`);
            }
        } else if (soundFormat === 7 || soundFormat === 8) {
            // G.711 is always 8 kHz, whatever the rate bits say; one byte per sample
            // and channel.
            demuxAssert(tag.dataSize > 1, 'empty FLV G.711 packet');
            this.audioCodec = soundFormat === 7 ? 'alaw' : 'ulaw';
            this.sampleRate = 8000;
            this.channelCount = (tag.prefix[0]! & 1) + 1;
            this.budget.reserveSamples(1, 256, 'FLV sample index');
            this.audioSamples.push({
                offset: tag.dataOffset + 1,
                size: tag.dataSize - 1,
                timestamp: tag.timestampMs / 1000,
                decodeTimestamp: tag.timestampMs / 1000,
                duration: (tag.dataSize - 1) / this.channelCount / this.sampleRate,
                isKeyframe: true,
            });
        } else if (soundFormat === 2) {
            demuxAssert(tag.dataSize > 1, 'empty FLV MP3 packet');
            if (!this.audioCodec) {
                const mp3Header = parseMpegAudioHeader(tag.prefix, 1);
                demuxAssert(
                    mp3Header?.format === 'mp3' || this.lenient,
                    'invalid FLV MP3 frame header',
                );
            }

            // A tag may hold several MPEG audio frames or end inside one; each frame
            // becomes a packet.
            const chunk = await this.mp3.push(this.reader, tag.dataOffset + 1, tag.dataSize - 1);
            this.mp3Skipped += chunk.skipped;
            let first = true;
            for (const frame of chunk.frames) {
                const timestamp = first && !frame.data ? tag.timestampMs / 1000 : this.mp3Clock;
                if (!frame.data) first = false;
                this.budget.reserveSamples(1, 256, 'FLV sample index');
                this.audioSamples.push({
                    offset: frame.offset,
                    size: frame.size,
                    ...(frame.data ? { data: frame.data } : {}),
                    timestamp,
                    decodeTimestamp: timestamp,
                    duration: frame.header.samplesPerFrame / frame.header.sampleRate,
                    isKeyframe: true,
                });
                this.mp3Clock = timestamp + frame.header.samplesPerFrame / frame.header.sampleRate;
            }
        }
    }
}

/** FLV demuxer (AVC/AAC tags, mid-stream ASC replacement detection). */
export class FlvDemuxer {
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private readonly limits: ResolvedDemuxBudget;

    constructor(options: DemuxBudgetOptions = {}) {
        this.limits = resolveDemuxBudget(options);
    }

    /**
     * Parses the container with windowed reads and returns tracks plus encoded samples; honors
     * `signal`.
     */
    async demux(
        input: File | Blob | Source,
        signal?: AbortSignal,
        diagnostics = new DiagnosticContext(),
    ): Promise<DemuxResult> {
        try {
            return await new FlvDemuxRun(this.limits, input, signal, diagnostics).run();
        } catch (e) {
            throw demuxFailure(e);
        }
    }
}

function findOrAppendConfiguration(
    configurations: Mp4CodecConfiguration[],
    bytes: Uint8Array,
    entry: Mp4CodecConfiguration,
): number {
    for (let i = 0; i < configurations.length; i++) {
        if (sameBytes(configurations[i]!.codecConfig, bytes)) return i;
    }
    configurations.push(entry);
    return configurations.length - 1;
}

function parseFlvMetadata(data: Uint8Array): FlvMetadata {
    try {
        const reader = new Amf0Reader(data);
        const event = reader.readValue(0);
        if (event !== 'onMetaData') return {};
        const value = reader.readValue(0);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const record = value as Record<string, unknown>;
        return {
            duration: typeof record.duration === 'number' ? record.duration : undefined,
            framerate: typeof record.framerate === 'number' ? record.framerate : undefined,
            title:
                typeof record.title === 'string' && record.title.length ? record.title : undefined,
            width:
                typeof record.width === 'number' && record.width > 0 && record.width < 65536
                    ? record.width
                    : undefined,
            height:
                typeof record.height === 'number' && record.height > 0 && record.height < 65536
                    ? record.height
                    : undefined,
        };
    } catch {
        return {};
    }
}

class Amf0Reader {
    private pos = 0;
    private entries = 0;

    constructor(private readonly data: Uint8Array) {}

    readValue(depth: number): unknown {
        if (depth > 8) throw new RangeError('AMF nesting too deep');
        const type = this.u8();
        switch (type) {
            case 0:
                return this.f64();
            case 1:
                return this.u8() !== 0;
            case 2:
                return this.string16();
            case 3:
                return this.object(depth + 1);
            case 5:
            case 6:
                return null;
            case 7:
                this.skip(2);
                return null;
            case 8:
                this.skip(4);
                return this.object(depth + 1);
            case 10: {
                const count = this.u32();
                if (count > 4096) throw new RangeError('AMF array too large');
                const values: unknown[] = [];
                for (let i = 0; i < count; i++) values.push(this.readValue(depth + 1));
                return values;
            }
            case 11: {
                const value = this.f64();
                this.skip(2);
                return value;
            }
            case 12:
                return this.string32();
            default:
                throw new RangeError(`unsupported AMF0 type ${type}`);
        }
    }

    private object(depth: number): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        while (true) {
            this.ensure(3);
            if (
                this.data[this.pos] === 0 &&
                this.data[this.pos + 1] === 0 &&
                this.data[this.pos + 2] === 9
            ) {
                this.pos += 3;
                return result;
            }
            const key = this.string16();
            if (++this.entries > 4096) throw new RangeError('AMF object too large');
            result[key] = this.readValue(depth);
        }
    }

    private string16(): string {
        const length = this.u16();
        return this.string(length);
    }

    private string32(): string {
        const length = this.u32();
        if (length > 1024 * 1024) throw new RangeError('AMF string too large');
        return this.string(length);
    }

    private string(length: number): string {
        this.ensure(length);
        const value = new TextDecoder().decode(this.data.subarray(this.pos, this.pos + length));
        this.pos += length;
        return value;
    }

    private f64(): number {
        this.ensure(8);
        const value = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 8).getFloat64(
            0,
            false,
        );
        this.pos += 8;
        return value;
    }

    private u8(): number {
        this.ensure(1);
        return this.data[this.pos++]!;
    }

    private u16(): number {
        this.ensure(2);
        const value = (this.data[this.pos]! << 8) | this.data[this.pos + 1]!;
        this.pos += 2;
        return value;
    }

    private u32(): number {
        this.ensure(4);
        const value = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 4).getUint32(
            0,
            false,
        );
        this.pos += 4;
        return value;
    }

    private skip(length: number): void {
        this.ensure(length);
        this.pos += length;
    }

    private ensure(length: number): void {
        if (length < 0 || this.pos + length > this.data.length)
            throw new RangeError('AMF data truncated');
    }
}

/** The flv plugin's 'flv' reader, which its index loads on first use. */
export const flvReader: Reader = {
    read: (source, options) =>
        new FlvDemuxer(options).demux(source, options.signal, readerDiagnostics(options)),
    capabilities: HANDS_OVER,
};
