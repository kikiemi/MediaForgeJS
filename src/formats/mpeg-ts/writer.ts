import { sameBytes } from '../../core/bytes/bytes';
import type { Sink } from '../../core/model/types';
import { assertMuxCodec } from '../shared/capabilities';
import { MediaForgeError } from '../../core/errors/errors';
import { handOffOutput } from '../../core/bytes/output-data';
import { copiesWrites } from '../../core/io/sinks/copying-sinks';
import {
    adtsFieldsFromConfig,
    getAdtsConfiguration,
    getAdtsFrameLength,
    parseAdtsFrameHeader,
    writeAdtsHeader,
} from '../../core/codec-config/audio/adts';
import type { AudioTrackConfig, MuxerConfig, OutputMuxer } from '../../core/contracts/writer';
import type { EncodedPacket } from '../../core/model/media';
import {
    annexBUnits,
    avcConfigToAnnexB,
    isAnnexB,
    isValidAvccWalk,
    isValidHevcWalk,
} from '../../core/codec-config/video/annexb';
import { isDtsCodec, mpegVideoFamily, isHevcCodec } from '../../core/model/codec-strings';
import { mpegVideoConfig, type MpegVideoSyntax } from '../../core/codec-config/video/mpeg-video';
import { hevcConfigToAnnexB } from '../../core/codec-config/video/hevc-codec';
import { isVvcCodec, parseVvcC } from '../../core/codec-config/video/vvc';
import { hasVc1StartCode, VC1_FRAME, vc1HeadersOf } from '../../core/codec-config/video/vc1';
import { iso639Language } from '../shared/language';
import { decodeTime, secondsToTicks } from '../../core/model/media-time';
import { checkChunk, unfedTrack } from '../shared/chunk-checks';
import { crc32MpegUpdate } from '../../core/bytes/crc32-mpeg';

/**
 * The ISO 639-2 code of an ISO 639 language descriptor: the primary subtag of a BCP 47 tag, and
 * none for an unknown or undetermined language, which readers would otherwise report as a language.
 */
function descriptorLanguage(tag: string | undefined): string | undefined {
    const code = iso639Language(tag);
    return code && code !== 'und' ? code : undefined;
}

const PAT_PID = 0x0000;
const PMT_PID = 0x1000;
const VIDEO_PID = 0x0100;
const AUDIO_PID = 0x0101;
const TS = 188;

interface AudioStream {
    readonly config: AudioTrackConfig;
    readonly pid: number;
    readonly streamId: number;
    count: number;
    codecConfig?: Uint8Array;
}

interface ParsedDecoderConfig {
    record: Uint8Array;
    lengthSize: number;
    paramSets: Uint8Array;
}

/** MPEG-TS muxer (PAT/PMT/PCR cadence, ADTS-wrapped AAC). */
export class TsMuxer implements OutputMuxer {
    private videoChunkCount = 0;
    private readonly audioStreams: AudioStream[];
    private readonly pat: Uint8Array;
    private readonly pmt: Uint8Array;
    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;
    private headerWritten = false;
    /** Continuity counter of the next packet per PID. */
    private readonly cc = new Uint8Array(0x2000);
    private videoConfigCache: ParsedDecoderConfig | null = null;
    private mpegConfig?: Uint8Array;
    /**
     * Where packets are assembled when the sink copies what it is given before write() returns: one
     * buffer serves every write instead of one allocated (and handed off) per PES.
     */
    private output: Uint8Array | undefined;

    constructor(cfg: MuxerConfig, sink: Sink) {
        const { video, audio, extraVideoTracks, extraAudioTracks, subtitleTracks } = cfg;
        this.cfg = {
            ...cfg,
            video: video
                ? {
                      ...video,
                      codecConfig: video.codecConfig
                          ? new Uint8Array(video.codecConfig)
                          : undefined,
                  }
                : undefined,
            audio: audio
                ? {
                      ...audio,
                      codecConfig: audio.codecConfig
                          ? new Uint8Array(audio.codecConfig)
                          : undefined,
                  }
                : undefined,
        };

        if (this.cfg.video) assertMuxCodec('ts', 'video', this.cfg.video.codec);
        if (extraVideoTracks?.length || subtitleTracks?.length) {
            throw new MediaForgeError(
                'TS writer supports one video and multiple audio tracks',
                'FORMAT',
            );
        }
        if (!audio && extraAudioTracks?.length)
            throw new MediaForgeError(
                'Extra TS audio tracks require a primary audio track',
                'FORMAT',
            );

        const tracks = audio ? [audio, ...(extraAudioTracks ?? [])] : [];
        if (tracks.length + (video ? 1 : 0) > 64)
            throw new MediaForgeError('TS writer supports at most 64 tracks', 'FORMAT');
        this.audioStreams = tracks.map((track, index) => {
            assertMuxCodec('ts', 'audio', track.codec);
            if (track.codec.startsWith('mp4a') && track.codecConfig)
                adtsFieldsFromConfig(track.codecConfig, 'FORMAT');
            const config = {
                ...track,
                codecConfig: track.codecConfig ? new Uint8Array(track.codecConfig) : undefined,
            };
            if (index === 0 && config.language === undefined) config.language = cfg.audioLanguage;
            return {
                config,
                pid: AUDIO_PID + index,
                streamId:
                    track.codec === 'ac-3' || track.codec === 'ec-3' || isDtsCodec(track.codec)
                        ? 0xbd
                        : 0xc0 + (index & 31),
                count: 0,
            };
        });

        this.pat = this.buildPAT();
        this.pmt = this.buildPMT();
        this.sink = sink;
        if (sink.copiesWrites === true || copiesWrites(sink)) this.output = new Uint8Array(0);
    }

    /** `length` bytes for one sink write: of the reused buffer, or new ones the sink may keep. */
    private outputBytes(length: number): Uint8Array {
        if (!this.output) return new Uint8Array(length);
        if (this.output.length < length)
            this.output = new Uint8Array(Math.max(length, 2 * this.output.length, 64 * TS));
        return this.output.subarray(0, length);
    }

    private writeOutput(bytes: Uint8Array): void {
        this.sink.write(this.output ? bytes : handOffOutput(bytes));
    }

    /**
     * Appends one encoded video chunk; `codecConfig` on the first call carries the decoder
     * configuration record.
     */
    addVideoChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        checkChunk('addVideoChunk', chunk, 'video');

        const timestamp = chunk.timestamp;
        const pts = timestamp90k(timestamp);
        const dts = timestamp90k(decodeTime(chunk));
        const codec = this.cfg.video?.codec ?? '';
        const mpeg = mpegVideoFamily(codec);

        let payload: Uint8Array[];
        if (mpeg) {
            this.mpegConfig ??= codecConfig ?? this.cfg.video?.codecConfig;
            payload = [
                withMpegVideoConfig(mpeg === 'mpeg4v' ? 'mpeg4' : 'mpeg12', chunk, this.mpegConfig),
            ];
        } else if (codec.startsWith('av01')) {
            payload = [chunk.data];
        } else if (codec === 'vc1') {
            // A VfW or ASF configuration leads with a size byte, which the elementary stream must
            // not carry.
            const config = codecConfig ?? this.cfg.video?.codecConfig;
            this.mpegConfig ??= config && (vc1HeadersOf(config) ?? config);
            payload = [withVc1Headers(chunk, this.mpegConfig)];
        } else {
            const record =
                codecConfig ?? this.videoConfigCache?.record ?? this.cfg.video?.codecConfig;
            const parsed = record ? this.videoConfigFor(record) : null;
            payload = this.normalizeVideoPayload(chunk, parsed);
            this.videoConfigCache = parsed;
        }

        const pes = pesRuns(0xe0, payload, pts, dts !== pts ? dts : undefined);
        this.videoChunkCount++;
        this.ensureHeader();
        this.packetize(VIDEO_PID, pes, chunk.isKeyframe, dts);
    }

    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        this.addAudio(0, chunk, codecConfig);
    }

    addExtraAudioChunk(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        if (!Number.isInteger(index) || index < 0)
            throw new MediaForgeError('Invalid extra TS audio track index', 'MUX');
        this.addAudio(index + 1, chunk, codecConfig);
    }

    private addAudio(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        const stream = this.audioStreams[index];
        if (!stream) throw new MediaForgeError('TS audio track is not declared', 'MUX');
        if (chunk.trackType !== 'audio')
            throw new MediaForgeError('TS audio chunks require trackType audio', 'MUX');
        const pts = timestamp90k(chunk.timestamp);
        const isAac = stream.config.codec.startsWith('mp4a');
        const asc = codecConfig ?? stream.codecConfig ?? stream.config.codecConfig;
        const payload = isAac ? this.normalizeAacPayload(chunk.data, asc) : [chunk.data];
        const pes = pesRuns(stream.streamId, payload, pts);
        if (isAac && asc && asc !== stream.codecConfig) stream.codecConfig = new Uint8Array(asc);
        stream.count++;
        this.ensureHeader();
        this.packetize(stream.pid, pes, false, pts);
    }

    /**
     * Repeats PAT/PMT and a PCR before the next chunk so a new segment file decodes on its own;
     * continuity counters continue.
     */
    startSegment(): void {
        this.headerWritten = false;
        this.lastPsiTicks = null;
        this.lastPcrTicks = null;
    }

    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    async finalize(): Promise<void> {
        if (this.cfg.video && this.videoChunkCount === 0) {
            throw unfedTrack('video');
        }
        if (this.audioStreams.some(stream => stream.count === 0)) {
            throw unfedTrack('audio');
        }
        this.ensureHeader();
        await this.sink.close();
    }

    /**
     * The Annex-B payload as byte runs; keyframes and the first picture converted from length
     * prefixes lead with the parameter sets.
     */
    private normalizeVideoPayload(
        chunk: EncodedPacket,
        parsed: ParsedDecoderConfig | null,
    ): Uint8Array[] {
        const data = chunk.data;
        if (parsed) {
            const codec = this.cfg.video?.codec ?? '';
            const validWalk = codec.startsWith('avc') ? isValidAvccWalk : isValidHevcWalk;
            if (validWalk(data, parsed.lengthSize as 1 | 2 | 3 | 4)) {
                const delimiter = codec.startsWith('avc') ? 9 : isHevcCodec(codec) ? 35 : -1;
                const runs = lengthPrefixedToAnnexB(data, parsed.lengthSize, delimiter);
                if (runs) {
                    // The first picture carries them too: streams refreshed without IDR pictures
                    // have no keyframe.
                    if (
                        (chunk.isKeyframe || this.videoChunkCount === 0) &&
                        parsed.paramSets.length > 0
                    )
                        insertParameterSets(runs, parsed, codec);
                    return runs;
                }
            }

            if (isAnnexB(data)) return [data];
            throw new MediaForgeError('Video sample does not match its NAL length size', 'MUX');
        }

        if (isAnnexB(data)) return [data];
        throw new MediaForgeError('TS video sample is neither Annex B nor configured', 'MUX', {
            hint: 'Pass the decoder configuration, or encode Annex B.',
        });
    }

    private videoConfigFor(record: Uint8Array): ParsedDecoderConfig {
        if (this.videoConfigCache && sameBytes(this.videoConfigCache.record, record))
            return this.videoConfigCache;
        const snapshot = new Uint8Array(record);
        const codec = this.cfg.video?.codec ?? '';
        const parsed = isVvcCodec(codec)
            ? parseVvcCRecord(snapshot)
            : isHevcCodec(codec)
              ? hevcConfigToAnnexB(snapshot)
              : avcConfigToAnnexB(snapshot, codec.startsWith('avc3'));
        if (!parsed) {
            throw new MediaForgeError('video decoder configuration record is malformed', 'MUX');
        }
        return { record: snapshot, ...parsed };
    }

    private lastPsiTicks: number | null = null;
    private lastPcrTicks: number | null = null;

    private ensureHeader(): void {
        if (this.headerWritten) return;
        this.headerWritten = true;
        this.writeTable(PAT_PID, this.pat);
        this.writeTable(PMT_PID, this.pmt);
    }

    private maybeRepeatTables(ticks: number): void {
        if (this.lastPsiTicks === null) {
            this.lastPsiTicks = ticks;
            return;
        }
        if (ticks - this.lastPsiTicks >= 0.4 * 90000) {
            this.writeTable(PAT_PID, this.pat);
            this.writeTable(PMT_PID, this.pmt);
            this.lastPsiTicks = ticks;
        }
    }

    private pcrPid(): number {
        return this.cfg.video ? VIDEO_PID : AUDIO_PID;
    }

    private nextCC(pid: number): number {
        const c = this.cc[pid]! & 0xf;
        this.cc[pid] = c + 1;
        return c;
    }

    private videoStreamType(): number {
        const codec = this.cfg.video?.codec ?? 'avc1.640028';
        if (isHevcCodec(codec)) return 0x24;
        if (isVvcCodec(codec)) return 0x33;
        if (codec.startsWith('av01')) return 0x06;
        if (codec === 'vc1') return 0xea;
        const mpeg = mpegVideoFamily(codec);
        if (mpeg) return mpeg === 'mpeg4v' ? 0x10 : mpeg === 'mpeg2v' ? 0x02 : 0x01;
        return 0x1b;
    }

    private audioStreamType(codec: string): number {
        if (codec === 'ac-3') return 0x81;
        if (codec === 'ec-3') return 0x87;
        if (isDtsCodec(codec)) return 0x82;
        if (codec === 'mp3' || codec === 'mp2' || codec === 'mp1') return 0x03;
        return 0x0f;
    }

    /** The AAC payload as ADTS frames: as it is when framed, else after a header of its own. */
    private normalizeAacPayload(data: Uint8Array, codecConfig?: Uint8Array): Uint8Array[] {
        if (data.length >= 2 && data[0] === 0xff && (data[1]! & 0xf0) === 0xf0) {
            if (!adtsChainCovers(data)) {
                throw new MediaForgeError(
                    'TS AAC payload contains malformed or truncated ADTS framing',
                    'MUX',
                );
            }
            return [data];
        }
        if (!codecConfig) {
            throw new MediaForgeError(
                'TS AAC needs ADTS frames or an AudioSpecificConfig',
                'FORMAT',
            );
        }
        const { sampleRate, channels, audioObjectType } = adtsFieldsFromConfig(
            codecConfig,
            'FORMAT',
        );
        const header = new Uint8Array(7);
        writeAdtsHeader(
            header,
            0,
            getAdtsFrameLength(data, 'MUX'),
            getAdtsConfiguration(sampleRate, channels, 'FORMAT', audioObjectType),
        );
        return [header, data];
    }

    private buildPAT(): Uint8Array {
        const d = new Uint8Array(12);
        d[0] = 0x00;
        d[1] = 0xb0;
        d[2] = 0x0d;
        d[3] = 0x00;
        d[4] = 0x01;
        d[5] = 0xc1;
        d[6] = 0x00;
        d[7] = 0x00;
        d[8] = 0x00;
        d[9] = 0x01;
        d[10] = 0xe0 | ((PMT_PID >> 8) & 0x1f);
        d[11] = PMT_PID & 0xff;
        return appendCrc(d);
    }

    /**
     * Registration and codec descriptors of the video elementary stream (AV1 and VC-1 carriage).
     */
    private videoDescriptors(): Uint8Array {
        const video = this.cfg.video;
        if (!video) return new Uint8Array(0);
        if (video.codec === 'vc1') return Uint8Array.of(5, 4, 0x56, 0x43, 0x2d, 0x31);
        if (!video.codec.startsWith('av01')) return new Uint8Array(0);
        const config = video.codecConfig;
        const record =
            config && config.length >= 4 && (config[0]! & 0x7f) === 1 ? config : undefined;
        return Uint8Array.of(
            5,
            4,
            0x41,
            0x56,
            0x30,
            0x31,
            0x80,
            4,
            0x81,
            record?.[1] ?? 0,
            record?.[2] ?? 0,
            0xc0,
        );
    }

    private buildPMT(): Uint8Array {
        const streams: {
            type: number;
            pid: number;
            language?: string;
            descriptors?: Uint8Array;
        }[] = [];
        if (this.cfg.video)
            streams.push({
                type: this.videoStreamType(),
                pid: VIDEO_PID,
                descriptors: this.videoDescriptors(),
            });
        for (const { config, pid } of this.audioStreams)
            streams.push({
                type: this.audioStreamType(config.codec),
                pid,
                language: descriptorLanguage(config.language),
                // Stream type 0x82 is DTS in Blu-ray tables only; the registration 'DTS1' names it
                // to other readers.
                ...(isDtsCodec(config.codec)
                    ? { descriptors: Uint8Array.of(5, 4, 0x44, 0x54, 0x53, 0x31) }
                    : {}),
            });

        const infoLen = streams.reduce(
            (sum, stream) =>
                sum + 5 + (stream.descriptors?.length ?? 0) + (stream.language ? 6 : 0),
            0,
        );
        const sectionLen = 9 + infoLen + 4;
        if (sectionLen > 1021)
            throw new MediaForgeError('TS PMT exceeds its section length limit', 'FORMAT');

        const data = new Uint8Array(3 + sectionLen - 4);
        data.set([
            2,
            0xb0 | (sectionLen >> 8),
            sectionLen & 255,
            0,
            1,
            0xc1,
            0,
            0,
            0xe0 | (this.pcrPid() >> 8),
            this.pcrPid() & 255,
            0xf0,
            0,
        ]);

        let offset = 12;
        for (const { type, pid, language, descriptors } of streams) {
            const name = language;
            const extra = descriptors?.length ?? 0;
            data.set(
                [
                    type,
                    0xe0 | (pid >> 8),
                    pid & 255,
                    0xf0 | (((name ? 6 : 0) + extra) >> 8),
                    ((name ? 6 : 0) + extra) & 255,
                ],
                offset,
            );

            offset += 5;
            if (descriptors?.length) {
                data.set(descriptors, offset);
                offset += descriptors.length;
            }
            if (name) {
                data.set(
                    [10, 4, name.charCodeAt(0), name.charCodeAt(1), name.charCodeAt(2), 0],
                    offset,
                );
                offset += 6;
            }
        }
        return appendCrc(data);
    }

    private writeTable(pid: number, section: Uint8Array): void {
        let offset = 0;
        while (offset < section.length) {
            const first = offset === 0;
            const packet = this.outputBytes(TS);
            packet.fill(0xff);
            packet.set([0x47, (first ? 0x40 : 0) | (pid >> 8), pid & 255, 0x10 | this.nextCC(pid)]);
            if (first) packet[4] = 0;
            const header = first ? 5 : 4;
            const length = Math.min(TS - header, section.length - offset);
            packet.set(section.subarray(offset, offset + length), header);
            this.sink.write(packet);
            offset += length;
        }
    }

    private writePcrOnly(pcrTicks: number): void {
        const pkt = this.outputBytes(TS);
        pkt[0] = 0x47;
        const pid = this.pcrPid();
        pkt[1] = (pid >> 8) & 0x1f;
        pkt[2] = pid & 0xff;
        const lastCc = (this.cc[pid]! - 1) & 0xf;
        pkt[3] = 0x20 | lastCc;
        pkt[4] = 183;
        pkt[5] = 0x10;
        writePcrBase(pkt, 6, pcrTicks);
        pkt[11] = 0x00;
        pkt.fill(0xff, 12);
        this.sink.write(pkt);
        this.lastPcrTicks = pcrTicks;
    }

    private bridgeCadence(pcrTicks: number): void {
        if (this.lastPsiTicks !== null) {
            while (pcrTicks - this.lastPsiTicks >= 0.4 * 90000) {
                this.lastPsiTicks += 0.4 * 90000;
                this.writeTable(PAT_PID, this.pat);
                this.writeTable(PMT_PID, this.pmt);
            }
        }
        if (this.lastPcrTicks !== null) {
            while (pcrTicks - this.lastPcrTicks >= 0.08 * 90000) {
                this.writePcrOnly(Math.min(this.lastPcrTicks + 0.08 * 90000, pcrTicks));
            }
        }
    }

    /**
     * Writes one PES, given as byte runs of `pes.length` bytes in total, as TS packets in a single
     * sink write.
     */
    private packetize(pid: number, pes: PesRuns, addPCR: boolean, pcrTicks: number): void {
        if (this.lastPcrTicks === null && pid !== this.pcrPid()) this.writePcrOnly(pcrTicks);
        this.bridgeCadence(pcrTicks);
        this.maybeRepeatTables(pcrTicks);
        if (
            pid === this.pcrPid() &&
            (this.lastPcrTicks === null || pcrTicks - this.lastPcrTicks >= 0.08 * 90000)
        ) {
            addPCR = true;
        }
        if (addPCR) this.lastPcrTicks = pcrTicks;
        const length = pes.length;
        const firstRoom = TS - (addPCR ? 12 : 4);
        const count = length <= firstRoom ? 1 : 1 + Math.ceil((length - firstRoom) / (TS - 4));
        const out = this.outputBytes(count * TS);
        const reader = new RunReader(pes.runs);
        let off = 0,
            first = true,
            at = 0;
        while (off < length) {
            out[at] = 0x47;
            out[at + 1] = (first ? 0x40 : 0) | ((pid >> 8) & 0x1f);
            out[at + 2] = pid & 0xff;
            out[at + 3] = 0x10 | this.nextCC(pid);

            let hdr = 4;

            if (first && addPCR) {
                out[at + 3] |= 0x20;
                out[at + 4] = 7;
                out[at + 5] = 0x10;
                writePcrBase(out, at + 6, pcrTicks);
                out[at + 11] = 0x00;
                hdr = 12;
            }

            const rem = length - off;
            const room = TS - hdr;

            if (rem >= room) {
                reader.copy(out, at + hdr, room);
                off += room;
            } else {
                const stuff = room - rem;
                out[at + 3] |= 0x20;
                if (hdr === 4) {
                    out[at + 4] = stuff - 1;
                    if (stuff > 1) out[at + 5] = 0x00;
                    if (stuff > 2) out.fill(0xff, at + 6, at + 4 + stuff);
                } else {
                    const oldLen = out[at + 4]!;
                    out[at + 4] = oldLen + stuff;
                    out.fill(0xff, at + hdr, at + hdr + stuff);
                }
                reader.copy(out, at + TS - rem, rem);
                off += rem;
            }

            first = false;
            at += TS;
        }
        this.writeOutput(out);
    }
}

/** A PES packet as consecutive byte runs: the header, then the payload pieces. */
interface PesRuns {
    readonly runs: readonly Uint8Array[];
    readonly length: number;
}

/** Sequential reader over byte runs. */
class RunReader {
    private run = 0;
    private offset = 0;

    constructor(private readonly runs: readonly Uint8Array[]) {}

    copy(out: Uint8Array, at: number, count: number): void {
        while (count > 0) {
            const bytes = this.runs[this.run]!;
            const take = Math.min(count, bytes.length - this.offset);
            if (take < 16) for (let i = 0; i < take; i++) out[at + i] = bytes[this.offset + i]!;
            else out.set(bytes.subarray(this.offset, this.offset + take), at);
            at += take;
            count -= take;
            this.offset += take;
            if (this.offset === bytes.length) {
                this.run++;
                this.offset = 0;
            }
        }
    }
}

/**
 * Keyframes without in-band headers repeat the out-of-band configuration so each can start
 * decoding.
 */
function withMpegVideoConfig(
    syntax: MpegVideoSyntax,
    chunk: EncodedPacket,
    config: Uint8Array | undefined,
): Uint8Array {
    if (!chunk.isKeyframe || !config?.length || mpegVideoConfig(syntax, chunk.data))
        return chunk.data;
    const out = new Uint8Array(config.length + chunk.data.length);
    out.set(config);
    out.set(chunk.data, config.length);
    return out;
}

/** A time on the 90 kHz clock of PES timestamps, before it wraps to 33 bits. */
function timestamp90k(seconds: number): number {
    return secondsToTicks(seconds, 90000, 'TS timestamp');
}

function pesRuns(
    streamId: number,
    payload: readonly Uint8Array[],
    pts: number,
    dts?: number,
): PesRuns {
    let dataLength = 0;
    for (const run of payload) dataLength += run.length;
    const withDts = dts !== undefined;
    const headerDataLen = withDts ? 10 : 5;
    const hdrLen = 9 + headerDataLen;
    const pesPacketLen = 3 + headerDataLen + dataLength;
    if (pesPacketLen > 0xffff && (streamId < 0xe0 || streamId > 0xef)) {
        throw new MediaForgeError('TS audio payload exceeds the 65527-byte PES limit', 'MUX');
    }
    const buf = new Uint8Array(hdrLen);
    buf[0] = 0x00;
    buf[1] = 0x00;
    buf[2] = 0x01;
    buf[3] = streamId;

    if (pesPacketLen <= 0xffff) {
        buf[4] = (pesPacketLen >> 8) & 0xff;
        buf[5] = pesPacketLen & 0xff;
    }

    buf[6] = 0x80;
    buf[7] = withDts ? 0xc0 : 0x80;
    buf[8] = headerDataLen;

    writeTs90k(buf, 9, pts, withDts ? 0x3 : 0x2);
    if (withDts) writeTs90k(buf, 14, dts, 0x1);
    return { runs: [buf, ...payload], length: hdrLen + dataLength };
}

/**
 * `ticks` modulo 2^33, as the 33-bit time fields hold them: the bits above 30 and the 30 below,
 * which shifts can take apart.
 */
function ticks33(ticks: number): { high: number; low: number } {
    const wrapped = ((Math.round(ticks) % 2 ** 33) + 2 ** 33) % 2 ** 33;
    return { high: Math.floor(wrapped / 2 ** 30), low: wrapped % 2 ** 30 };
}

function writeTs90k(buf: Uint8Array, off: number, ticks: number, marker: number): void {
    const { high, low } = ticks33(ticks);
    buf[off] = (marker << 4) | 0x01 | (high << 1);
    buf[off + 1] = (low >>> 22) & 0xff;
    buf[off + 2] = (((low >>> 15) & 0x7f) << 1) | 1;
    buf[off + 3] = (low >>> 7) & 0xff;
    buf[off + 4] = ((low & 0x7f) << 1) | 1;
}

/** The 33-bit PCR base and the reserved bits after it, in the five bytes at `off`. */
function writePcrBase(buf: Uint8Array, off: number, ticks: number): void {
    const { high, low } = ticks33(ticks);
    buf[off] = ((high << 5) | (low >>> 25)) & 0xff;
    buf[off + 1] = (low >>> 17) & 0xff;
    buf[off + 2] = (low >>> 9) & 0xff;
    buf[off + 3] = (low >>> 1) & 0xff;
    buf[off + 4] = ((low & 1) << 7) | 0x7e;
}

function appendCrc(section: Uint8Array): Uint8Array {
    const out = new Uint8Array(section.length + 4);
    out.set(section);
    const crc = crc32MpegUpdate(0xffffffff, section) >>> 0;
    out[section.length] = (crc >> 24) & 0xff;
    out[section.length + 1] = (crc >> 16) & 0xff;
    out[section.length + 2] = (crc >> 8) & 0xff;
    out[section.length + 3] = crc & 0xff;
    return out;
}

function adtsChainCovers(data: Uint8Array): boolean {
    let pos = 0;
    while (pos < data.length) {
        const header = parseAdtsFrameHeader(data, pos);
        if (!header || pos + header.frameLength > data.length) return false;
        pos += header.frameLength;
    }
    return pos === data.length && pos > 0;
}

const START_CODE = Uint8Array.of(0, 0, 0, 1);

/**
 * Puts the configuration's parameter sets before a keyframe's NAL units, after its access unit
 * delimiter (which must lead the access unit); an access unit that carries its own SPS and PPS
 * (VPS, SPS and PPS for HEVC) is left alone. `runs` alternates start codes and NAL units.
 */
function insertParameterSets(runs: Uint8Array[], parsed: ParsedDecoderConfig, codec: string): void {
    const avc = codec.startsWith('avc');
    if (!avc && !isHevcCodec(codec)) {
        runs.unshift(parsed.paramSets);
        return;
    }
    const type = (nal: Uint8Array): number => (avc ? nal[0]! & 31 : (nal[0]! >> 1) & 63);
    const types = new Set(runs.filter((_, index) => index % 2 === 1).map(type));
    if ((avc ? [7, 8] : [32, 33, 34]).every(value => types.has(value))) return;
    runs.splice(runs.length > 1 && type(runs[1]!) === (avc ? 9 : 35) ? 2 : 0, 0, parsed.paramSets);
}

/**
 * Offset of a three-byte start code inside a NAL unit, which emulation prevention rules out in a
 * real one; -1.
 */
function embeddedStartCode(nal: Uint8Array): number {
    // Looks at the byte a code would end at: one above 1 rules out codes ending there and at the
    // next two bytes, so the scan steps by three over most bytes instead of a search call per zero.
    for (let end = 2; end < nal.length;) {
        const byte = nal[end]!;
        if (byte === 0) end++;
        else if (byte === 1 && nal[end - 1] === 0 && nal[end - 2] === 0) return end - 2;
        else end += 3;
    }
    return -1;
}

/**
 * Annex B runs of a length-prefixed sample. Some writers leave Annex B units inside a
 * length-prefixed H.264/HEVC unit (an access unit delimiter of the next picture after a field's
 * slice); they are split out, and embedded delimiters (`delimiter`, the codec's AUD type, -1 for
 * none) are dropped, as a delimiter inside an access unit would split it.
 */
function lengthPrefixedToAnnexB(
    data: Uint8Array,
    lengthSize: number,
    delimiter = -1,
): Uint8Array[] | null {
    const runs: Uint8Array[] = [];
    const nalType = (nal: Uint8Array): number =>
        delimiter === 9 ? nal[0]! & 31 : (nal[0]! >> 1) & 63;
    let pos = 0;
    while (pos < data.length) {
        if (pos + lengthSize > data.length) return null;
        let len = 0;
        for (let i = 0; i < lengthSize; i++) len = len * 256 + data[pos + i]!;
        pos += lengthSize;
        if (len === 0) continue;
        if (pos + len > data.length) return null;

        let nal = data.subarray(pos, pos + len);
        pos += len;
        if (delimiter < 0) {
            runs.push(START_CODE, nal);
            continue;
        }

        for (let embedded = true; embedded;) {
            const at = embeddedStartCode(nal);
            embedded = at > 0;
            let end = embedded ? at : nal.length;
            while (embedded && end > 0 && nal[end - 1] === 0) end--;
            const unit = nal.subarray(0, end);
            if (unit.length && !(runs.length && nalType(unit) === delimiter))
                runs.push(START_CODE, unit);
            if (embedded) nal = nal.subarray(at + 3);
        }
    }
    return runs.length === 0 ? null : runs;
}

/**
 * VC-1 advanced profile frames carry Annex E start codes; the sequence and entry point headers
 * precede key frames.
 */
function withVc1Headers(chunk: EncodedPacket, headers: Uint8Array | undefined): Uint8Array {
    const data = chunk.data;
    const framed = hasVc1StartCode(data);
    const prefix =
        chunk.isKeyframe && headers?.length && !(framed && data[3] === 0x0f) ? headers : undefined;
    if (!prefix && framed) return data;
    const out = new Uint8Array((prefix?.length ?? 0) + (framed ? 0 : 4) + data.length);
    let at = 0;
    if (prefix) {
        out.set(prefix, 0);
        at = prefix.length;
    }
    if (!framed) {
        out.set([0, 0, 1, VC1_FRAME], at);
        at += 4;
    }
    out.set(data, at);
    return out;
}

function parseVvcCRecord(record: Uint8Array): { lengthSize: number; paramSets: Uint8Array } | null {
    const parsed = parseVvcC(record);
    if (!parsed) return null;
    return { lengthSize: parsed.lengthSize, paramSets: annexBUnits(parsed.nalUnits) };
}
