import type { Sink } from '../../core/model/types';
import { MediaForgeError } from '../../core/errors/errors';
import { handOffOutput } from '../../core/bytes/output-data';
import type { ContainerWriterFactory, MuxerConfig, OutputMuxer } from '../../core/contracts/writer';
import type { EncodedPacket } from '../../core/model/media';
import { buildAacAsc, parseAacAudioSpecificConfig } from '../../core/codec-config/audio/adts';
import {
    annexBToAvcc,
    isAnnexB,
    isValidAvccWalk,
    isValidHevcWalk,
} from '../../core/codec-config/video/annexb';
import { hevcLengthSize } from '../../core/codec-config/video/hevc-codec';
import { assertMuxCodec } from '../shared/capabilities';
import { sameBytes } from '../../core/bytes/bytes';
import { checkChunk, unfedTrack } from '../shared/chunk-checks';
import { isHevcCodec } from '../../core/model/codec-strings';
import { secondsToTicks } from '../../core/model/media-time';

/** PreviousTagSize of the preceding tag and the 11-byte tag header. */
const TAG_HEADER = 15;

/**
 * FLV muxer (AVC + AAC, onMetaData duration write-back). Tags carry unsigned decode times; pictures
 * keep their presentation times, so decode times of reordered pictures before zero move later by
 * that delay and the signed composition offsets carry the difference.
 */
export class FlvMuxer implements OutputMuxer {
    private videoChunkCount = 0;
    private audioChunkCount = 0;
    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;
    private headerWritten = false;
    private prevTagSize = 0;
    private lastVideoConfig?: Uint8Array;
    private lastAudioConfig?: Uint8Array;
    /** Seconds video decode times move later: how far the first one lies before zero. */
    private videoDecodeDelay?: number;
    private lastVideoDtsMs = -1;
    private lastAudioDtsMs = -1;
    private bytesWritten = 0;
    /** Absolute offset of the 8-byte duration double inside onMetaData. */
    private durationPatchOffset = -1;
    private presentationEndSec = 0;
    private finalized = false;

    /** Enhanced RTMP FourCC of the video track; undefined for legacy AVC tags. */
    private readonly videoFourcc?: 'hvc1' | 'av01';

    constructor(cfg: MuxerConfig, sink: Sink) {
        this.cfg = cfg;
        this.sink = sink;
        if (cfg.video) {
            assertMuxCodec('flv', 'video', cfg.video.codec);
            this.videoFourcc = isHevcCodec(cfg.video.codec)
                ? 'hvc1'
                : cfg.video.codec.startsWith('av01')
                  ? 'av01'
                  : undefined;
        }
    }

    /**
     * Appends one encoded video chunk; `codecConfig` on the first call carries the decoder
     * configuration record.
     */
    addVideoChunk(chunk: EncodedPacket, codecCfg?: Uint8Array): void {
        this.assertOpen();
        checkChunk('addVideoChunk', chunk, 'video');
        assertChunkTiming(chunk);
        assertBytes(chunk.data, 'video payload');
        const activeVideoConfig = codecCfg ?? this.lastVideoConfig ?? this.cfg.video?.codecConfig;
        const fourcc = this.videoFourcc;
        assertTagPayloadSize(8 + chunk.data.length);
        if (activeVideoConfig) {
            assertBytes(activeVideoConfig, 'video configuration');
            assertTagPayloadSize(5 + activeVideoConfig.length);
            if (!sameBytes(activeVideoConfig, this.lastVideoConfig)) {
                if (!fourcc) assertAvcConfig(activeVideoConfig);
                else if (
                    fourcc === 'hvc1' &&
                    (activeVideoConfig.length < 23 || activeVideoConfig[0] !== 1)
                )
                    throw new MediaForgeError(
                        'FLV HevcDecoderConfigurationRecord is malformed',
                        'MUX',
                    );
                else if (
                    fourcc === 'av01' &&
                    (activeVideoConfig.length < 4 || (activeVideoConfig[0]! & 0x7f) !== 1)
                )
                    throw new MediaForgeError(
                        'FLV Av1CodecConfigurationRecord is malformed',
                        'MUX',
                    );
            }
        } else if (fourcc)
            throw new MediaForgeError(
                `FLV ${fourcc} video requires its decoder configuration`,
                'FORMAT',
            );
        if (fourcc === 'hvc1') {
            const lengthSize = hevcLengthSize(activeVideoConfig);

            // MPEG-TS and raw HEVC deliver Annex B access units; FLV stores the hvcC
            // length-prefixed form.
            if (!isValidHevcWalk(chunk.data, lengthSize) && isAnnexB(chunk.data))
                chunk = { ...chunk, data: annexBToAvcc(chunk.data, lengthSize) };
            if (!isValidHevcWalk(chunk.data, lengthSize))
                throw new MediaForgeError(
                    `FLV HEVC sample does not match its ${lengthSize}-byte NAL lengths`,
                    'MUX',
                );
        } else if (!fourcc) {
            const lengthSize = activeVideoConfig ? (activeVideoConfig[4]! & 3) + 1 : 4;

            // Some MP4 writers stored Annex B access units; FLV stores the avcC length-prefixed
            // form.
            if (!isValidAvccWalk(chunk.data, lengthSize as 1 | 2 | 3 | 4) && isAnnexB(chunk.data))
                chunk = { ...chunk, data: annexBToAvcc(chunk.data, lengthSize as 1 | 2 | 3 | 4) };
            if (!isValidAvccWalk(chunk.data, lengthSize as 1 | 2 | 3 | 4)) {
                throw new MediaForgeError(
                    `FLV AVC sample does not match its ${lengthSize}-byte NAL lengths`,
                    'MUX',
                );
            }
        }

        const decodeTimestamp = this.videoDecodeTimestamp(chunk);
        this.videoDecodeDelay ??= Math.max(0, -decodeTimestamp);
        const dtsMs = timestampMs(decodeTimestamp + this.videoDecodeDelay);

        // The presentation time is rounded on its own, so it lands on the millisecond nearest to
        // it.
        const ctsMs = timestampMs(chunk.timestamp) - dtsMs;
        if (!Number.isSafeInteger(ctsMs) || ctsMs < -0x800000 || ctsMs > 0x7fffff) {
            throw new MediaForgeError(
                `FLV AVC composition offset ${ctsMs}ms is outside signed 24-bit range`,
                'MUX',
            );
        }
        if (dtsMs < this.lastVideoDtsMs) {
            throw new MediaForgeError(`FLV video timestamp moved backwards at ${dtsMs} ms`, 'MUX');
        }
        const end = presentationEnd(chunk);
        this.lastVideoDtsMs = dtsMs;
        this.videoChunkCount++;
        this.ensureHeader();

        if (
            activeVideoConfig &&
            activeVideoConfig.length > 0 &&
            !sameBytes(activeVideoConfig, this.lastVideoConfig)
        ) {
            const seq = new Uint8Array(5 + activeVideoConfig.length);
            if (fourcc) {
                seq[0] = 0x80 | 0x10;
                for (let index = 0; index < 4; index++) seq[1 + index] = fourcc.charCodeAt(index);
            } else seq[0] = 0x17;
            seq.set(activeVideoConfig, 5);
            this.writeTag(9, dtsMs, seq);
            this.lastVideoConfig = new Uint8Array(activeVideoConfig);
        }

        const encodedCts = ctsMs & 0xffffff;
        const frameType = chunk.isKeyframe ? 0x10 : 0x20;

        // PacketTypeCodedFrames carries a composition time for HEVC; AV1 frames use
        // PacketTypeCodedFramesX.
        const withCts = fourcc !== 'av01';
        if (!withCts && ctsMs !== 0)
            throw new MediaForgeError(
                'FLV AV1 frames cannot carry a composition time offset',
                'MUX',
            );
        const header = fourcc ? (withCts ? 8 : 5) : 5;
        const framed = new Uint8Array(TAG_HEADER + header + chunk.data.length);
        const payload = framed.subarray(TAG_HEADER);
        if (fourcc) {
            payload[0] = 0x80 | frameType | (withCts ? 1 : 3);
            for (let index = 0; index < 4; index++) payload[1 + index] = fourcc.charCodeAt(index);
        } else {
            payload[0] = frameType | 0x07;
            payload[1] = 1;
        }
        if (withCts) {
            payload[header - 3] = (encodedCts >> 16) & 0xff;
            payload[header - 2] = (encodedCts >> 8) & 0xff;
            payload[header - 1] = encodedCts & 0xff;
        }
        payload.set(chunk.data, header);
        this.writeFramedTag(9, dtsMs, framed);
        if (end > this.presentationEndSec) this.presentationEndSec = end;
    }

    /**
     * Appends one encoded audio chunk; `codecConfig` on the first call carries decoder
     * configuration where the container stores it.
     */
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        this.assertOpen();
        checkChunk('addAudioChunk', chunk, 'audio');
        assertChunkTiming(chunk);
        assertBytes(chunk.data, 'audio payload');
        const asc =
            codecConfig ??
            this.lastAudioConfig ??
            this.cfg.audio?.codecConfig ??
            this.defaultAudioConfig();
        assertTagPayloadSize(2 + chunk.data.length);
        assertBytes(asc, 'AAC configuration');
        assertTagPayloadSize(2 + asc.length);
        const soundHeader = this.aacSoundHeader(asc);

        // An FLV tag is stamped with its decode time; audio tags carry no composition offset for
        // the rare audio whose presentation times are reordered. A decode time before zero, as
        // reordered AAC priming leaves it once a copy presents its first packet at zero, is stamped
        // at zero, where the packet is played: its presentation time may lie after the next
        // packet's.
        const decodeTime = Number.isFinite(chunk.decodeTimestamp)
            ? chunk.decodeTimestamp!
            : chunk.timestamp;
        const dtsMs = timestampMs(Math.max(0, decodeTime));
        if (dtsMs < this.lastAudioDtsMs) {
            throw new MediaForgeError(`FLV audio timestamp moved backwards at ${dtsMs} ms`, 'MUX');
        }
        const end = presentationEnd(chunk);
        this.lastAudioDtsMs = dtsMs;
        this.audioChunkCount++;
        this.ensureHeader();

        if (!sameBytes(asc, this.lastAudioConfig)) {
            const seq = new Uint8Array(2 + asc.length);
            seq[0] = soundHeader;
            seq.set(asc, 2);
            this.writeTag(8, dtsMs, seq);
            this.lastAudioConfig = new Uint8Array(asc);
        }

        const framed = new Uint8Array(TAG_HEADER + 2 + chunk.data.length);
        framed[TAG_HEADER] = soundHeader;
        framed[TAG_HEADER + 1] = 1;
        framed.set(chunk.data, TAG_HEADER + 2);
        this.writeFramedTag(8, dtsMs, framed);
        if (end > this.presentationEndSec) this.presentationEndSec = end;
    }

    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    async finalize(): Promise<void> {
        this.assertOpen();
        if (this.cfg.video && this.videoChunkCount === 0) {
            throw unfedTrack('video');
        }
        if (this.cfg.audio && this.audioChunkCount === 0) {
            throw unfedTrack('audio');
        }
        this.finalized = true;
        this.ensureHeader();
        const buf = new Uint8Array(4);
        new DataView(buf.buffer).setUint32(0, this.prevTagSize, false);
        this.write(buf);
        if (this.durationPatchOffset >= 0 && this.sink.patchAt) {
            const d = new Uint8Array(8);
            new DataView(d.buffer).setFloat64(0, this.presentationEndSec, false);
            this.sink.patchAt(this.durationPatchOffset, d);
        }
        await this.sink.close();
    }

    private assertOpen(): void {
        if (this.finalized)
            throw new MediaForgeError('FLV muxer is finalizing or finalized', 'MUX');
    }

    private ensureHeader(): void {
        if (this.headerWritten) return;
        this.headerWritten = true;
        const hasV = !!this.cfg.video;
        const hasA = !!this.cfg.audio;
        const hdr = new Uint8Array(9);
        hdr[0] = 0x46;
        hdr[1] = 0x4c;
        hdr[2] = 0x56;
        hdr[3] = 1;
        hdr[4] = (hasV ? 1 : 0) | (hasA ? 4 : 0);
        new DataView(hdr.buffer).setUint32(5, 9, false);
        this.write(hdr);
        this.writeMetaDataTag();
    }

    private write(data: Uint8Array): void {
        this.sink.write(data);
        this.bytesWritten += data.length;
    }

    private writeMetaDataTag(): void {
        const patchable = typeof this.sink.patchAt === 'function';
        const entries: Array<[string, number]> = [];
        if (patchable) entries.push(['duration', 0]);
        if (this.cfg.video?.width) entries.push(['width', this.cfg.video.width]);
        if (this.cfg.video?.height) entries.push(['height', this.cfg.video.height]);
        if (this.cfg.video)
            entries.push([
                'videocodecid',
                this.videoFourcc
                    ? this.videoFourcc.charCodeAt(0) * 0x1000000 +
                      this.videoFourcc.charCodeAt(1) * 0x10000 +
                      this.videoFourcc.charCodeAt(2) * 0x100 +
                      this.videoFourcc.charCodeAt(3)
                    : 7,
            ]);
        if (this.cfg.audio) {
            entries.push(['audiocodecid', 10]);
            if (this.cfg.audio.sampleRate)
                entries.push(['audiosamplerate', this.cfg.audio.sampleRate]);
        }
        if (entries.length === 0) return;

        let size = 1 + 2 + 10;
        size += 1 + 4;
        for (const [key] of entries) size += 2 + key.length + 1 + 8;
        size += 2 + 1;

        const data = new Uint8Array(size);
        const dv = new DataView(data.buffer);
        let p = 0;
        data[p++] = 0x02;
        dv.setUint16(p, 10, false);
        p += 2;
        for (const c of 'onMetaData') data[p++] = c.charCodeAt(0);
        data[p++] = 0x08;
        dv.setUint32(p, entries.length, false);
        p += 4;
        const payloadAbsStart = this.bytesWritten + 15;
        for (const [key, value] of entries) {
            dv.setUint16(p, key.length, false);
            p += 2;
            for (const c of key) data[p++] = c.charCodeAt(0);
            data[p++] = 0x00;
            if (key === 'duration') this.durationPatchOffset = payloadAbsStart + p;
            dv.setFloat64(p, value, false);
            p += 8;
        }
        data[p++] = 0x00;
        data[p++] = 0x00;
        data[p++] = 0x09;
        this.writeTag(18, 0, data);
    }

    private defaultAudioConfig(): Uint8Array {
        try {
            return buildAacAsc(
                this.cfg.audio?.sampleRate ?? 44100,
                this.cfg.audio?.channelCount ?? 2,
            );
        } catch {
            throw new MediaForgeError(
                'FLV cannot build AAC configuration from the audio track settings',
                'MUX',
            );
        }
    }

    private aacSoundHeader(codecConfig: Uint8Array): number {
        const parsed = parseAacAudioSpecificConfig(codecConfig);
        if (!parsed) throw new MediaForgeError('FLV AAC AudioSpecificConfig is malformed', 'MUX');
        const stereo = parsed.channelCount > 1 ? 1 : 0;
        return 0xa0 | 0x0c | 0x02 | stereo;
    }

    private videoDecodeTimestamp(chunk: EncodedPacket): number {
        const decodeTimestamp =
            chunk.decodeTimestamp ??
            (chunk.compositionTimeOffset !== undefined
                ? chunk.timestamp - chunk.compositionTimeOffset
                : chunk.timestamp);
        if (!Number.isFinite(decodeTimestamp)) {
            throw new MediaForgeError('FLV video timestamp is not finite', 'MUX');
        }
        return decodeTimestamp;
    }

    private writeTag(type: number, ts: number, data: Uint8Array): void {
        const framed = new Uint8Array(TAG_HEADER + data.length);
        framed.set(data, TAG_HEADER);
        this.writeFramedTag(type, ts, framed);
    }

    /** Writes a tag whose payload follows TAG_HEADER bytes reserved at the start of `framed`. */
    private writeFramedTag(type: number, ts: number, framed: Uint8Array): void {
        assertTimestampMs(ts);
        const size = framed.length - TAG_HEADER;
        const dv = new DataView(framed.buffer, framed.byteOffset, TAG_HEADER);
        dv.setUint32(0, this.prevTagSize, false);
        framed[4] = type;
        framed[5] = (size >> 16) & 0xff;
        framed[6] = (size >> 8) & 0xff;
        framed[7] = size & 0xff;
        framed[8] = (ts >> 16) & 0xff;
        framed[9] = (ts >> 8) & 0xff;
        framed[10] = ts & 0xff;
        framed[11] = (ts >> 24) & 0xff;
        this.write(handOffOutput(framed));
        this.prevTagSize = 11 + size;
    }
}

function assertChunkTiming(chunk: EncodedPacket): void {
    if (!Number.isFinite(chunk.timestamp)) {
        throw new MediaForgeError('FLV presentation timestamp must be a finite number', 'MUX');
    }
    if (!Number.isFinite(chunk.duration) || chunk.duration < 0) {
        throw new MediaForgeError('FLV chunk duration must be a finite non-negative number', 'MUX');
    }
    if (
        (chunk.decodeTimestamp !== undefined && !Number.isFinite(chunk.decodeTimestamp)) ||
        (chunk.compositionTimeOffset !== undefined && !Number.isFinite(chunk.compositionTimeOffset))
    ) {
        throw new MediaForgeError('FLV DTS and composition offset must be finite numbers', 'MUX');
    }
}

function assertBytes(data: Uint8Array, label: string): void {
    if (
        !ArrayBuffer.isView(data) ||
        Object.prototype.toString.call(data) !== '[object Uint8Array]' ||
        data.length === 0
    ) {
        throw new MediaForgeError(`FLV ${label} must be a non-empty Uint8Array`, 'MUX');
    }
}

/** Milliseconds of a time at or after zero, as FLV tags store it. */
function timestampMs(seconds: number): number {
    return secondsToTicks(seconds, 1000, 'FLV timestamp', { min: 0, max: 0xffffffff });
}

function presentationEnd(chunk: EncodedPacket): number {
    const end = chunk.timestamp + chunk.duration;
    if (!Number.isFinite(end))
        throw new MediaForgeError('FLV presentation end is not finite', 'MUX');
    return end;
}

function assertTimestampMs(timestamp: number): void {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
        throw new MediaForgeError(`FLV timestamp ${timestamp} ms does not fit in 32 bits`, 'MUX');
    }
}

function assertAvcConfig(record: Uint8Array): void {
    const malformed = () =>
        new MediaForgeError('FLV AvcDecoderConfigurationRecord is malformed', 'MUX');
    if (record.length < 7 || record[0] !== 1) throw malformed();
    let pos = 6;
    for (let group = 0; group < 2; group++) {
        if (group === 1 && pos >= record.length) throw malformed();
        const count = group === 0 ? record[5]! & 0x1f : record[pos++]!;
        for (let i = 0; i < count; i++) {
            if (pos + 2 > record.length) throw malformed();
            const length = record[pos]! * 256 + record[pos + 1]!;
            if (length === 0 || pos + 2 + length > record.length) throw malformed();
            if (!isValidAvccWalk(record.subarray(pos, pos + 2 + length), 2)) throw malformed();
            pos += 2 + length;
        }
    }
}

function assertTagPayloadSize(size: number): void {
    if (size > 0xffffff) {
        throw new MediaForgeError(
            `FLV tag payload size ${size} exceeds the unsigned 24-bit range`,
            'MUX',
        );
    }
}

/** The flv plugin's 'flv' writer, which its index loads on first use. */
export const createFlvMuxer: ContainerWriterFactory = (config, sink) => new FlvMuxer(config, sink);
