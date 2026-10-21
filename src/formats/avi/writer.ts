import type { Sink } from '../../core/model/types';
import { assertMuxCodec } from '../shared/capabilities';
import type { ContainerWriterFactory, MuxerConfig, OutputMuxer } from '../../core/contracts/writer';
import type { EncodedPacket, PcmAudioBuffer } from '../../core/model/media';
import { BinaryWriter } from '../../core/bytes/binary-writer';
import {
    avcConfigToAnnexB,
    isAnnexB,
    isValidAvccWalk,
    isValidHevcWalk,
} from '../../core/codec-config/video/annexb';
import { gcd } from '../../core/bytes/gcd';
import { MediaForgeError } from '../../core/errors/errors';
import { describePcmTrack } from '../../core/codec-config/audio/pcm-format';
import { parseMpegAudioHeader } from '../../core/codec-config/audio/mpeg-audio-header';
import { mpegVideoFamily, type MpegVideoFamily, isHevcCodec } from '../../core/model/codec-strings';
import { hevcConfigToAnnexB } from '../../core/codec-config/video/hevc-codec';
import { DV_VIDEO, DV_WRITE_FOURCC } from '../../core/codec-config/video/dv-video';
import { MJPEG_VIDEO, MJPEG_WRITE_FOURCC } from '../../core/codec-config/video/mjpeg';
import {
    isWindowsMediaAudio,
    parseWaveFormatEx,
    windowsMediaVideoFourcc,
    type WaveFormatEx,
} from '../../core/codec-config/windows-media';
import { concatBytes } from '../../core/bytes/bytes';
import { decodeTime } from '../../core/model/media-time';
import { quantizeSample } from '../../core/model/pcm-quantize';
import { riffInfoChunk } from '../metadata/riff-info';

/**
 * Compressed audio AVI stores one coded frame per chunk under its WAVEFORMATEX tag: MPEG Layer I/II
 * 0x0050, Layer III 0x0055, AC-3 0x2000. `layer` is the MPEG layer, 0 for AC-3.
 */
const FRAME_AUDIO: Readonly<Record<string, { readonly tag: number; readonly layer: number }>> = {
    mp1: { tag: 0x0050, layer: 1 },
    mp2: { tag: 0x0050, layer: 2 },
    mp3: { tag: 0x0055, layer: 3 },
    'ac-3': { tag: 0x2000, layer: 0 },
};

/** Samples of one AC-3 frame. */
const AC3_FRAME_SAMPLES = 1536;
/** What to do when an AVI would pass the 4 GiB of classic RIFF (OpenDML is not written). */
const AVI_TOO_LARGE = 'Write MP4 or MKV, or lower the bitrate or size.';

interface IndexEntry {
    fourcc: string;
    flags: number;
    offset: number;
    size: number;
}

interface PreparedChunk {
    fourcc: string;
    data: Uint8Array;
    ts: number;
    durationSec: number;
    isKey: boolean;
    sampleFrames: number;
}

interface MoviBuildResult {
    data: Uint8Array;
    videoFrames: number;
    audioSampleFrames: number;
    index: IndexEntry[];
    maxChunkSize: number;
    maxVideoChunkSize: number;
    maxAudioChunkSize: number;
    avgBytesPerSec: number;
    videoStartSec: number;
    audioStartSec: number;
}

interface AvcConfigInfo {
    nalLengthSize: number;
    annexBConfig: Uint8Array;
}

/** Four uint32 values per idx1 entry, paged to avoid per-frame JS objects. */
class AviIndexLedger {
    private static readonly ENTRIES_PER_PAGE = 4096;
    private readonly pages: Uint32Array[] = [];
    private entries = 0;

    get length(): number {
        return this.entries;
    }

    push(fourcc: string, flags: number, offset: number, size: number): void {
        const pageIndex = Math.floor(this.entries / AviIndexLedger.ENTRIES_PER_PAGE);
        const entryIndex = this.entries % AviIndexLedger.ENTRIES_PER_PAGE;
        let page = this.pages[pageIndex];
        if (!page) {
            page = new Uint32Array(AviIndexLedger.ENTRIES_PER_PAGE * 4);
            this.pages.push(page);
        }
        page[entryIndex * 4] =
            fourcc.charCodeAt(0) |
            (fourcc.charCodeAt(1) << 8) |
            (fourcc.charCodeAt(2) << 16) |
            (fourcc.charCodeAt(3) << 24);
        page[entryIndex * 4 + 1] = flags >>> 0;
        page[entryIndex * 4 + 2] = offset >>> 0;
        page[entryIndex * 4 + 3] = size >>> 0;
        this.entries++;
    }

    *encodedPages(): Iterable<Uint8Array> {
        let remaining = this.entries;
        for (const page of this.pages) {
            const count = Math.min(remaining, AviIndexLedger.ENTRIES_PER_PAGE);
            const bytes = new Uint8Array(count * 16);
            const view = new DataView(bytes.buffer);
            for (let index = 0; index < count; index++) {
                const source = index * 4;
                const target = index * 16;
                view.setUint32(target, page[source]!, true);
                view.setUint32(target + 4, page[source + 1]!, true);
                view.setUint32(target + 8, page[source + 2]!, true);
                view.setUint32(target + 12, page[source + 3]!, true);
            }
            remaining -= count;
            yield bytes;
        }
    }
}

/** Longest PCM chunk built from contiguous packets. */
const AUDIO_CHUNK_SECONDS = 0.05;

/** AVI muxer (strl-ordered streams, explicit 4 GiB limit). */
export class AviMuxer implements OutputMuxer {
    private static readonly START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;
    /** The LIST INFO chunk of the title and tags, written between hdrl and movi; may be empty. */
    private readonly info: Uint8Array;
    private finalized = false;

    private videoChunks: EncodedPacket[] = [];
    /** Running payload total, checked against the classic-AVI 4 GiB limit. */
    private payloadBytes = 0;
    private audioChunks: EncodedPacket[] = [];
    /**
     * Contiguous PCM packets gathered into one chunk; a chunk per sample frame would multiply the
     * file size.
     */
    private pendingAudio: {
        parts: Uint8Array[];
        bytes: number;
        timestamp: number;
        duration: number;
        frames: number;
    } | null = null;

    private codecConfig?: Uint8Array;
    private annexBCodecConfig?: Uint8Array;
    /**
     * MPEG video chunks are stored as coded; the configuration becomes BITMAPINFOHEADER extradata.
     */
    private readonly mpeg: MpegVideoFamily | null;
    /**
     * Windows Media or DV video FourCC; its chunks and extradata are stored as coded like MPEG
     * video.
     */
    private readonly vfwVideoFourcc?: string;
    private readonly hevc: boolean;
    /** Windows Media audio keeps its WAVEFORMATEX as the stream format. */
    private readonly windowsAudio?: WaveFormatEx;
    private readonly frameAudio?: { readonly tag: number; readonly layer: number };
    /** Samples per coded frame of compressed audio, from its first frame header. */
    private audioFrameSamples?: number;
    private audioBytes = 0;
    private nalLengthSize?: number;

    private observedAudioSampleRate?: number;
    private observedAudioChannels?: number;

    private readonly streaming: boolean;
    private streamingStarted = false;
    private streamingHdrlOffset = 0;
    private streamingHdrlLength = 0;
    private streamingMoviSizeOffset = 0;
    private streamingMoviBytes = 0;
    private readonly streamingIndex = new AviIndexLedger();
    private streamingVideoFrames = 0;
    private streamingAudioFrames = 0;
    private streamingMaxChunk = 0;
    private streamingMaxVideoChunk = 0;
    private streamingMaxAudioChunk = 0;
    private streamingMediaBytes = 0;
    private streamingFirstVideo = Number.POSITIVE_INFINITY;
    private streamingFirstAudio = Number.POSITIVE_INFINITY;
    private streamingVideoEnd = Number.NEGATIVE_INFINITY;
    private streamingAudioEnd = Number.NEGATIVE_INFINITY;
    private streamingNextVideoTs = 0;
    private streamingFirstVideoSlot?: number;
    private streamingNextAudioTs = 0;

    constructor(cfg: MuxerConfig, sink: Sink) {
        this.cfg = {
            ...cfg,
            video: cfg.video
                ? {
                      ...cfg.video,
                      codecConfig: cfg.video.codecConfig
                          ? new Uint8Array(cfg.video.codecConfig)
                          : undefined,
                  }
                : undefined,
            audio: cfg.audio ? { ...cfg.audio } : undefined,
        };

        this.sink = sink;
        // The title stated for the output wins over the input's.
        const title = cfg.title !== undefined ? [{ key: 'title', value: cfg.title }] : [];
        const entries = (cfg.tags?.entries ?? []).filter(
            entry => entry.key !== 'title' || cfg.title === undefined,
        );
        this.info = riffInfoChunk({ entries: [...title, ...entries] }) ?? new Uint8Array(0);
        if (this.cfg.video) assertMuxCodec('avi', 'video', this.cfg.video.codec);
        this.mpeg = mpegVideoFamily(this.cfg.video?.codec ?? '');
        this.vfwVideoFourcc =
            windowsMediaVideoFourcc(this.cfg.video?.codec ?? '') ??
            (this.cfg.video?.codec === DV_VIDEO
                ? DV_WRITE_FOURCC
                : this.cfg.video?.codec === MJPEG_VIDEO
                  ? MJPEG_WRITE_FOURCC
                  : undefined);
        this.hevc = isHevcCodec(this.cfg.video?.codec ?? '');
        if ((this.mpeg || this.vfwVideoFourcc) && this.cfg.video?.codecConfig)
            this.codecConfig = this.cfg.video.codecConfig;

        if (this.cfg.audio) {
            assertMuxCodec('avi', 'audio', this.cfg.audio.codec);
            if (isWindowsMediaAudio(this.cfg.audio.codec)) {
                const wave =
                    this.cfg.audio.codecConfig && parseWaveFormatEx(this.cfg.audio.codecConfig);
                if (!wave || wave.blockAlign < 1 || wave.averageBytesPerSecond < 1)
                    throw new MediaForgeError(
                        'AVI Windows Media Audio requires its WAVEFORMATEX',
                        'FORMAT',
                    );
                this.windowsAudio = wave;
            } else if (FRAME_AUDIO[this.cfg.audio.codec]) {
                this.frameAudio = FRAME_AUDIO[this.cfg.audio.codec];
                if (this.frameAudio.layer === 0) this.audioFrameSamples = AC3_FRAME_SAMPLES;
            } else if (this.cfg.audio.codecConfig || this.cfg.audio.codec === 'pcm-s16le') {
                const pcm = describePcmTrack(this.cfg.audio);
                if (
                    pcm.float ||
                    !pcm.littleEndian ||
                    pcm.bitsPerSample !== 16 ||
                    pcm.validBitsPerSample !== 16 ||
                    (pcm.channelMask !== undefined &&
                        pcm.channelMask !== 0 &&
                        pcm.channelMask !== (pcm.channels === 1 ? 4 : pcm.channels === 2 ? 3 : -1))
                )
                    throw new MediaForgeError(
                        'AVI copies only full 16-bit PCM in its standard channel layout',
                        'FORMAT',
                    );
            }
        }

        if (
            cfg.extraVideoTracks?.length ||
            cfg.extraAudioTracks?.length ||
            cfg.subtitleTracks?.length
        ) {
            throw new MediaForgeError(
                'AVI writer supports one video and one audio track',
                'FORMAT',
            );
        }

        this.streaming = typeof sink.patchAt === 'function';
        this.validateTrackConfig();
    }

    /**
     * Appends one encoded video chunk; `codecConfig` on the first call carries the decoder
     * configuration record.
     */
    addVideoChunk(c: EncodedPacket, cfg?: Uint8Array): void {
        this.assertOpen();
        this.validateBytes(c.data);
        if (this.streaming && !this.cfg.video)
            throw new MediaForgeError('AVI video track is not configured', 'MUX');

        const record = this.codecConfig ? undefined : (cfg ?? this.cfg.video?.codecConfig);
        const stored = this.mpeg || this.vfwVideoFourcc;
        if (stored && record) this.codecConfig = new Uint8Array(record);
        const info = record && !stored ? this.prepareCodecConfig(record) : undefined;

        const tb = this.getVideoRateScale();
        const duration = this.isFinitePositive(c.duration) ? c.duration : tb.scale / tb.rate;
        const slot = this.videoSlotTime(c);
        const timestamp = this.isFiniteNonNegative(slot) ? slot : this.streamingNextVideoTs;
        this.validateEnd(timestamp, duration);

        const data = stored ? c.data : this.normalizeH264Chunk(c.data, c.isKeyframe, info);
        this.checkPayloadSize(data.length);

        if (this.streaming) {
            this.streamingFirstVideoSlot ??= timestamp;
            const skipped = this.skippedVideoSlots(
                timestamp,
                this.streamingFirstVideoSlot,
                this.streamingVideoFrames,
            );
            for (let index = 0; index < skipped; index++)
                this.appendStreamingChunk(this.emptyVideoChunk(timestamp));
            this.appendStreamingChunk({
                fourcc: '00dc',
                data,
                ts: timestamp,
                durationSec: duration,
                isKey: !!c.isKeyframe,
                sampleFrames: 0,
            });
        } else {
            this.videoChunks.push({ ...c, data: new Uint8Array(data) });
            this.payloadBytes += data.length + 8 + (data.length & 1);
        }

        this.streamingNextVideoTs = timestamp + duration;
        if (record && info) {
            this.codecConfig = new Uint8Array(record);
            this.nalLengthSize = info.nalLengthSize;
            this.annexBCodecConfig = info.annexBConfig;
        }
    }

    /**
     * Whether sound was queued, so the next packet's distance from the written sound is a pause.
     */
    private audioQueued = false;
    /**
     * Where the sound written so far ends on the timeline AVI gives it by its bytes. Pauses are
     * written in whole units (frames, or PCM sample frames); what is left of a pause stays
     * unwritten and adds to the next one.
     */
    private audioWrittenEnd = 0;

    /**
     * Appends one encoded audio chunk; `codecConfig` on the first call carries decoder
     * configuration where the container stores it.
     */
    addAudioChunk(c: EncodedPacket): void {
        this.assertOpen();
        this.validateBytes(c.data);
        if (this.streaming && !this.cfg.audio)
            throw new MediaForgeError('AVI audio track is not configured', 'MUX');
        if (!this.frameAudio && c.data.length % this.getAudioBlockAlign() !== 0) {
            throw new MediaForgeError('AVI PCM bytes do not contain complete sample frames', 'MUX');
        }
        const sampleFrames = this.getAudioChunkSampleFrames(c);
        const sampleRate = this.getAudioSampleRate();
        const duration = this.isFinitePositive(c.duration) ? c.duration : sampleFrames / sampleRate;
        const timestamp = this.isFiniteNonNegative(c.timestamp)
            ? c.timestamp
            : this.streamingNextAudioTs;
        this.validateEnd(timestamp, duration);
        this.queueAudio(new Uint8Array(c.data), timestamp, duration, sampleFrames, sampleRate);
    }

    /**
     * Adds owned PCM bytes to the pending chunk when they continue it, otherwise starts a new one;
     * MPEG frames stay whole.
     */
    private queueAudio(
        data: Uint8Array,
        timestamp: number,
        duration: number,
        frames: number,
        rate: number,
    ): void {
        if (!this.audioQueued) this.audioWrittenEnd = timestamp;
        else this.queueAudioGap(this.audioWrittenEnd, timestamp, rate);
        this.audioQueued = true;

        const pending = this.pendingAudio;
        if (
            pending &&
            !this.frameAudio &&
            Math.abs(pending.timestamp + pending.duration - timestamp) < 0.5 / rate &&
            pending.duration + duration <= AUDIO_CHUNK_SECONDS
        ) {
            pending.parts.push(data);
            pending.bytes += data.length;
            pending.duration += duration;
            pending.frames += frames;
        } else {
            this.flushAudio();
            this.pendingAudio = { parts: [data], bytes: data.length, timestamp, duration, frames };
        }

        this.streamingNextAudioTs = timestamp + duration;
        this.audioWrittenEnd += duration;
    }

    /**
     * AVI places sound by its bytes alone, so a pause between packets (such as the zero chunks with
     * which a VBR MP3 writer delays the sound) is written as zero bytes that readers count as time:
     * whole frames of MPEG audio or AC-3 of nBlockAlign bytes each, or PCM silence. Windows Media
     * Audio has no such unit and closes the gap. A pause shorter than a unit, as the clock jitter
     * of MPEG-TS gives, is left for later pauses.
     */
    private queueAudioGap(from: number, to: number, rate: number): void {
        const frameSamples = this.frameAudio ? (this.audioFrameSamples ?? 1152) : 1;
        const units = Math.floor(((to - from) * rate) / frameSamples + 1e-3);
        if (this.windowsAudio || units < 1 || (!this.frameAudio && units < rate / 200)) return;
        if (!this.frameAudio) {
            const bytes = units * this.getAudioBlockAlign();
            this.audioQueued = false;
            this.queueAudio(new Uint8Array(bytes), from, units / rate, units, rate);
            return;
        }
        const unitBytes = this.frameAudio.layer === 0 ? 3840 : frameSamples;

        // Chunks of at most 1 MiB, each a whole number of frames.
        const perChunk = Math.max(1, Math.floor(0x100000 / unitBytes));
        for (let done = 0; done < units; done += perChunk) {
            const count = Math.min(perChunk, units - done);
            this.flushAudio();
            this.pendingAudio = {
                parts: [new Uint8Array(count * unitBytes)],
                bytes: count * unitBytes,
                timestamp: from + (done * frameSamples) / rate,
                duration: (count * frameSamples) / rate,
                frames: count * frameSamples,
            };
        }
        this.flushAudio();
        this.audioWrittenEnd = from + (units * frameSamples) / rate;
    }

    private flushAudio(): void {
        const pending = this.pendingAudio;
        if (!pending) return;
        this.pendingAudio = null;

        const data = pending.parts.length === 1 ? pending.parts[0]! : new Uint8Array(pending.bytes);
        if (pending.parts.length > 1) {
            let at = 0;
            for (const part of pending.parts) {
                data.set(part, at);
                at += part.length;
            }
        }

        this.checkPayloadSize(data.length);
        if (this.streaming) {
            this.appendStreamingChunk({
                fourcc: this.cfg.video ? '01wb' : '00wb',
                data,
                ts: pending.timestamp,
                durationSec: pending.duration,
                isKey: true,
                sampleFrames: pending.frames,
            });
        } else {
            this.audioChunks.push({
                data,
                timestamp: pending.timestamp,
                duration: pending.duration,
                isKeyframe: true,
                trackType: 'audio',
            });
            this.payloadBytes += data.length + 8 + (data.length & 1);
        }

        this.audioBytes += data.length;
    }

    private checkPayloadSize(bytes: number): void {
        const payloadBytes = this.payloadBytes + bytes + 8 + (bytes & 1);
        const entries =
            (this.streaming
                ? this.streamingIndex.length
                : this.videoChunks.length + this.audioChunks.length) + 1;
        const headerBytes =
            76 +
            (this.cfg.video || this.videoChunks.length ? 124 : 0) +
            (this.cfg.audio || this.audioChunks.length ? 100 : 0);
        const fileBytes = 12 + headerBytes + 12 + payloadBytes + 8 + entries * 16;
        if (
            !Number.isSafeInteger(payloadBytes) ||
            payloadBytes > 0xf0000000 ||
            !Number.isSafeInteger(fileBytes) ||
            fileBytes > 0xffffffff
        ) {
            throw new MediaForgeError('AVI output is over 4 GiB', 'MUX', { hint: AVI_TOO_LARGE });
        }
    }

    private assertOpen(): void {
        if (this.finalized)
            throw new MediaForgeError('AVI muxer is finalizing or finalized', 'MUX');
    }

    private validateBytes(data: Uint8Array): void {
        if (
            !ArrayBuffer.isView(data) ||
            Object.prototype.toString.call(data) !== '[object Uint8Array]' ||
            data.length === 0
        ) {
            throw new MediaForgeError('AVI chunk must contain Uint8Array bytes', 'MUX');
        }
    }

    private validateEnd(timestamp: number, duration: number): void {
        if (!Number.isFinite(timestamp + duration)) {
            throw new MediaForgeError('AVI chunk end time exceeds the supported range', 'MUX');
        }
    }

    private u32(value: number, label: string): void {
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
            throw new MediaForgeError(`AVI ${label} exceeds its uint32 field`, 'MUX');
        }
    }

    private validateTrackConfig(): void {
        if (this.cfg.video) {
            for (const dimension of [this.getVideoWidth(), this.getVideoHeight()]) {
                if (!Number.isInteger(dimension) || dimension < 1 || dimension > 65535) {
                    throw new MediaForgeError(
                        'AVI video dimensions exceed the stream header range',
                        'MUX',
                    );
                }
            }
            this.getVideoRateScale();
        }
        if (this.cfg.audio) {
            this.validateAudioShape(this.getAudioSampleRate(), this.getAudioChannelCount());
        }
    }

    private validateAudioShape(sampleRate: number, channels: number): void {
        if (
            !Number.isInteger(sampleRate) ||
            sampleRate < 1 ||
            sampleRate > 0xffffffff ||
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > 32767
        ) {
            throw new MediaForgeError('AVI PCM sample rate or channel count is invalid', 'FORMAT');
        }
        this.u32(sampleRate * channels * 2, 'PCM byte rate');
    }

    private validatePcmShape(
        planes: readonly Float32Array[],
        sampleRate: number,
        allowEmpty = false,
    ): void {
        const channels = planes.length;
        const frames = planes[0]?.length ?? 0;
        this.validateAudioShape(sampleRate, channels);
        if (
            (!allowEmpty && frames < 1) ||
            planes.some(
                plane =>
                    !ArrayBuffer.isView(plane) ||
                    Object.prototype.toString.call(plane) !== '[object Float32Array]' ||
                    plane.length !== frames,
            )
        ) {
            throw new MediaForgeError('AVI PCM chunk has an invalid shape', 'MUX');
        }

        if (this.streaming && !this.cfg.audio)
            throw new MediaForgeError('AVI audio track is not configured', 'MUX');
        if (
            (this.cfg.audio?.sampleRate !== undefined &&
                this.cfg.audio.sampleRate !== sampleRate) ||
            (this.cfg.audio?.channelCount !== undefined && this.cfg.audio.channelCount !== channels)
        ) {
            throw new MediaForgeError(
                'AVI PCM shape does not match the configured audio track',
                'MUX',
            );
        }
    }

    private writeSink(bytes: Uint8Array): void {
        try {
            this.sink.write(bytes);
        } catch (error) {
            this.finalized = true;
            throw error;
        }
    }

    private u32le(value: number): Uint8Array {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        return bytes;
    }

    private startStreaming(): void {
        if (this.streamingStarted) return;
        const hasV = !!this.cfg.video;
        const hasA = !!this.cfg.audio;
        if (!hasV && !hasA) throw new MediaForgeError('AVI has no configured tracks', 'MUX');

        const hdrl = this.buildHdrl(hasV, hasA, 0, 0, 0, 0, 0, 0, 0, 0);
        const riff = new BinaryWriter();
        riff.writeASCII('RIFF');
        riff.writeU32LE(0);
        riff.writeASCII('AVI ');
        this.writeSink(riff.toUint8Array());
        this.streamingHdrlOffset = 12;
        this.streamingHdrlLength = hdrl.length;
        this.writeSink(hdrl);
        if (this.info.length) this.writeSink(this.info);

        const movi = new BinaryWriter();
        movi.writeASCII('LIST');
        movi.writeU32LE(0);
        movi.writeASCII('movi');
        this.streamingMoviSizeOffset = 12 + hdrl.length + this.info.length + 4;
        this.writeSink(movi.toUint8Array());
        this.streamingStarted = true;
    }

    private checkStreamingCounters(video: boolean, sampleFrames: number): void {
        this.u32(this.streamingMoviBytes + 4, 'index offset');
        this.u32(this.streamingIndex.length * 16 + 16, 'index size');
        this.u32(
            video ? this.streamingVideoFrames + 1 : this.streamingAudioFrames + sampleFrames,
            'stream length',
        );
    }

    private appendStreamingChunk(chunk: PreparedChunk): void {
        this.checkStreamingCounters(chunk.fourcc.endsWith('dc'), chunk.sampleFrames);
        this.startStreaming();
        const header = new BinaryWriter();
        header.writeASCII(chunk.fourcc);
        header.writeU32LE(chunk.data.length);
        this.writeSink(header.toUint8Array());
        this.writeSink(chunk.data);
        if ((chunk.data.length & 1) !== 0) this.writeSink(new Uint8Array(1));

        this.streamingIndex.push(
            chunk.fourcc,
            chunk.isKey ? 0x10 : 0,
            this.streamingMoviBytes + 4,
            chunk.data.length,
        );
        this.streamingMoviBytes += 8 + chunk.data.length + (chunk.data.length & 1);
        this.payloadBytes += 8 + chunk.data.length + (chunk.data.length & 1);
        this.streamingMediaBytes += chunk.data.length;
        this.streamingMaxChunk = Math.max(this.streamingMaxChunk, chunk.data.length);
        if (chunk.fourcc.endsWith('dc')) {
            this.streamingVideoFrames++;
            this.streamingMaxVideoChunk = Math.max(this.streamingMaxVideoChunk, chunk.data.length);
            this.streamingFirstVideo = Math.min(this.streamingFirstVideo, chunk.ts);
            this.streamingVideoEnd = Math.max(this.streamingVideoEnd, chunk.ts + chunk.durationSec);
        } else {
            this.streamingAudioFrames += chunk.sampleFrames;
            this.streamingMaxAudioChunk = Math.max(this.streamingMaxAudioChunk, chunk.data.length);
            this.streamingFirstAudio = Math.min(this.streamingFirstAudio, chunk.ts);
            this.streamingAudioEnd = Math.max(this.streamingAudioEnd, chunk.ts + chunk.durationSec);
        }
    }

    /** Appends raw PCM from a PcmAudioBuffer as the audio stream (no encoder involved). */
    addPcmBuffer(buf: PcmAudioBuffer): void {
        this.assertOpen();
        const ch = buf.numberOfChannels;
        const len = buf.length;
        const blockSize = 4096;
        const channels: Float32Array[] = [];

        if (
            !Number.isSafeInteger(len) ||
            len < 0 ||
            !Number.isInteger(ch) ||
            ch < 1 ||
            ch > 32767
        ) {
            throw new MediaForgeError('AVI PCM buffer has an invalid shape', 'MUX');
        }
        for (let c = 0; c < ch; c++) {
            const plane = buf.getChannelData(c);
            if (
                !ArrayBuffer.isView(plane) ||
                Object.prototype.toString.call(plane) !== '[object Float32Array]' ||
                plane.length !== len
            ) {
                throw new MediaForgeError(
                    'AVI PCM buffer channel length does not match its frame count',
                    'MUX',
                );
            }
            channels.push(plane);
        }
        this.validatePcmShape(channels, buf.sampleRate, true);

        for (let off = 0; off < len; off += blockSize) {
            const end = Math.min(off + blockSize, len);
            this.addPcmPlanarChunk(
                channels.map(channel => channel.subarray(off, end)),
                buf.sampleRate,
                off / buf.sampleRate,
            );
        }
    }

    /** Appends one bounded planar PCM work unit as signed 16-bit AVI audio. */
    addPcmPlanarChunk(planes: readonly Float32Array[], sampleRate: number, timestamp = 0): void {
        this.assertOpen();
        this.validatePcmShape(planes, sampleRate);
        const channels = planes.length;
        const frames = planes[0]?.length ?? 0;
        if (
            this.observedAudioSampleRate !== undefined &&
            this.observedAudioSampleRate !== sampleRate
        ) {
            throw new MediaForgeError('AVI PCM sample rate changed mid-stream', 'MUX');
        }
        if (this.observedAudioChannels !== undefined && this.observedAudioChannels !== channels) {
            throw new MediaForgeError('AVI PCM channel count changed mid-stream', 'MUX');
        }
        const safeTimestamp = this.isFiniteNonNegative(timestamp)
            ? timestamp
            : this.streamingNextAudioTs;
        this.validateEnd(safeTimestamp, frames / sampleRate);
        this.checkPayloadSize(frames * channels * 2);
        if (this.streaming) this.checkStreamingCounters(false, frames);

        const pcm = new Int16Array(frames * channels);
        for (let channel = 0; channel < channels; channel++) {
            const plane = planes[channel]!;
            for (let frame = 0, at = channel; frame < frames; frame++, at += channels)
                pcm[at] = quantizeSample(plane[frame]!, 16);
        }
        this.observedAudioSampleRate = sampleRate;
        this.observedAudioChannels = channels;
        this.queueAudio(
            new Uint8Array(pcm.buffer),
            safeTimestamp,
            frames / sampleRate,
            frames,
            sampleRate,
        );
    }

    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    async finalize(): Promise<void> {
        this.assertOpen();
        this.flushAudio();
        if (this.streaming) {
            await this.finalizeStreaming();
            return;
        }
        const hasV = this.videoChunks.length > 0;
        const hasA = this.audioChunks.length > 0;

        if (!hasV && !hasA) {
            throw new MediaForgeError('Nothing to mux', 'MUX');
        }

        const moviResult = this.buildMovi(hasV, hasA);
        const hdrl = this.buildHdrl(
            hasV,
            hasA,
            moviResult.videoFrames,
            moviResult.audioSampleFrames,
            moviResult.maxChunkSize,
            moviResult.maxVideoChunkSize,
            moviResult.maxAudioChunkSize,
            moviResult.avgBytesPerSec,
            moviResult.videoStartSec,
            moviResult.audioStartSec,
        );
        const movi = this.wrapList('movi', moviResult.data);
        const idx1 = this.buildIdx1(moviResult.index);

        const riffPayloadSize = 4 + hdrl.length + this.info.length + movi.length + idx1.length;

        const AVI_MAX_RIFF = 0xffffffff;
        if (riffPayloadSize + 8 > AVI_MAX_RIFF) {
            throw new MediaForgeError('AVI output is over 4 GiB', 'MUX', { hint: AVI_TOO_LARGE });
        }

        const w = new BinaryWriter();
        w.writeASCII('RIFF');
        w.writeU32LE(riffPayloadSize);
        w.writeASCII('AVI ');
        w.writeBytes(hdrl);
        w.writeBytes(this.info);
        w.writeBytes(movi);
        w.writeBytes(idx1);

        const bytes = w.toUint8Array();
        this.finalized = true;
        this.writeSink(bytes);
        await this.sink.close();
    }

    private async finalizeStreaming(): Promise<void> {
        const hasV = this.streamingVideoFrames > 0;
        const hasA = this.streamingAudioFrames > 0;
        if (!hasV && !hasA) throw new MediaForgeError('Nothing to mux', 'MUX');
        if (!!this.cfg.video !== hasV || !!this.cfg.audio !== hasA) {
            throw new MediaForgeError('AVI finalized without all configured streams', 'MUX');
        }
        const baseStart = Math.min(
            hasV ? this.streamingFirstVideo : Number.POSITIVE_INFINITY,
            hasA ? this.streamingFirstAudio : Number.POSITIVE_INFINITY,
        );
        const end = Math.max(
            hasV ? this.streamingVideoEnd : baseStart,
            hasA ? this.streamingAudioEnd : baseStart,
        );
        const duration = Math.max(0.001, end - baseStart);
        const hdrl = this.buildHdrl(
            hasV,
            hasA,
            this.streamingVideoFrames,
            this.streamingAudioFrames,
            this.streamingMaxChunk,
            this.streamingMaxVideoChunk,
            this.streamingMaxAudioChunk,
            Math.ceil(this.streamingMediaBytes / duration),
            hasV ? Math.max(0, this.streamingFirstVideo - baseStart) : 0,
            hasA ? Math.max(0, this.streamingFirstAudio - baseStart) : 0,
        );
        if (hdrl.length !== this.streamingHdrlLength) {
            throw new MediaForgeError('AVI header changed its size while streaming', 'MUX');
        }
        const indexBytes = this.streamingIndex.length * 16;
        const fileSize =
            12 + hdrl.length + this.info.length + 12 + this.streamingMoviBytes + 8 + indexBytes;
        if (fileSize > 0xffffffff) {
            throw new MediaForgeError('AVI output is over 4 GiB', 'MUX', { hint: AVI_TOO_LARGE });
        }
        this.finalized = true;
        this.sink.patchAt!(this.streamingHdrlOffset, hdrl);
        this.sink.patchAt!(this.streamingMoviSizeOffset, this.u32le(4 + this.streamingMoviBytes));
        this.sink.patchAt!(4, this.u32le(fileSize - 8));

        const idxHeader = new BinaryWriter();
        idxHeader.writeASCII('idx1');
        idxHeader.writeU32LE(indexBytes);
        this.writeSink(idxHeader.toUint8Array());
        for (const page of this.streamingIndex.encodedPages()) this.writeSink(page);
        await this.sink.close();
    }

    private buildMovi(hasV: boolean, hasA: boolean): MoviBuildResult {
        const videoFourCC = '00dc';
        const audioFourCC = hasV ? '01wb' : '00wb';

        const preparedVideo = hasV ? this.prepareVideoChunks(videoFourCC) : [];
        const preparedAudio = hasA ? this.prepareAudioChunks(audioFourCC) : [];

        const firstVideoTs =
            preparedVideo.length > 0 ? preparedVideo[0]!.ts : Number.POSITIVE_INFINITY;
        const firstAudioTs =
            preparedAudio.length > 0 ? preparedAudio[0]!.ts : Number.POSITIVE_INFINITY;
        const baseStartSec = Number.isFinite(Math.min(firstVideoTs, firstAudioTs))
            ? Math.min(firstVideoTs, firstAudioTs)
            : 0;

        const videoStartSec =
            preparedVideo.length > 0 ? Math.max(0, preparedVideo[0]!.ts - baseStartSec) : 0;
        const audioStartSec =
            preparedAudio.length > 0 ? Math.max(0, preparedAudio[0]!.ts - baseStartSec) : 0;

        const merged = this.mergePreparedChunks(preparedVideo, preparedAudio);

        const payloadBytes = merged.reduce(
            (total, chunk) => total + 8 + chunk.data.length + (chunk.data.length & 1),
            0,
        );
        const headerBytes = 76 + (hasV ? 124 : 0) + (hasA ? 100 : 0);
        this.u32(12 + headerBytes + 12 + payloadBytes + 8 + merged.length * 16, 'file size');

        const w = new BinaryWriter();
        const index: IndexEntry[] = [];

        let maxChunkSize = 0;
        let maxVideoChunkSize = 0;
        let maxAudioChunkSize = 0;

        let videoFrames = 0;
        let audioSampleFrames = 0;

        let totalMediaBytes = 0;
        let videoEndSec = baseStartSec;
        for (const chunk of preparedVideo) {
            videoEndSec = Math.max(videoEndSec, chunk.ts + chunk.durationSec);
        }
        let audioEndSec = baseStartSec;
        for (const chunk of preparedAudio) {
            audioEndSec = Math.max(audioEndSec, chunk.ts + chunk.durationSec);
        }

        for (const m of merged) {
            const offset = w.size;

            w.writeASCII(m.fourcc);
            w.writeU32LE(m.data.length);
            w.writeBytes(m.data);
            if ((m.data.length & 1) !== 0) {
                w.writeU8(0);
            }

            index.push({
                fourcc: m.fourcc,
                flags: m.isKey ? 0x10 : 0,
                offset,
                size: m.data.length,
            });

            totalMediaBytes += m.data.length;
            if (m.data.length > maxChunkSize) maxChunkSize = m.data.length;

            if (m.fourcc.endsWith('dc')) {
                videoFrames++;
                if (m.data.length > maxVideoChunkSize) maxVideoChunkSize = m.data.length;
            } else if (m.fourcc.endsWith('wb')) {
                audioSampleFrames += m.sampleFrames;
                if (m.data.length > maxAudioChunkSize) maxAudioChunkSize = m.data.length;
            }
        }

        const overallDuration = Math.max(0.001, Math.max(videoEndSec, audioEndSec) - baseStartSec);
        const avgBytesPerSec = Math.ceil(totalMediaBytes / overallDuration);

        return {
            data: w.toUint8Array(),
            videoFrames,
            audioSampleFrames,
            index,
            maxChunkSize,
            maxVideoChunkSize,
            maxAudioChunkSize,
            avgBytesPerSec,
            videoStartSec,
            audioStartSec,
        };
    }

    private mergePreparedChunks(video: PreparedChunk[], audio: PreparedChunk[]): PreparedChunk[] {
        const merged: PreparedChunk[] = [];
        let vi = 0;
        let ai = 0;

        while (vi < video.length || ai < audio.length) {
            if (vi >= video.length) {
                merged.push(audio[ai++]!);
                continue;
            }
            if (ai >= audio.length) {
                merged.push(video[vi++]!);
                continue;
            }

            const v = video[vi]!;
            const a = audio[ai]!;

            if (v.ts <= a.ts) {
                merged.push(v);
                vi++;
            } else {
                merged.push(a);
                ai++;
            }
        }

        return merged;
    }

    private prepareVideoChunks(fourcc: string): PreparedChunk[] {
        const tb = this.getVideoRateScale();
        const defaultFrameDur = tb.scale / tb.rate;

        const out: PreparedChunk[] = [];
        let nextFallbackTs = 0;

        for (let i = 0; i < this.videoChunks.length; i++) {
            const c = this.videoChunks[i]!;
            const slot = this.videoSlotTime(c);
            const ts = this.isFiniteNonNegative(slot) ? slot : nextFallbackTs;
            const durationSec = this.isFinitePositive(c.duration) ? c.duration : defaultFrameDur;
            const data =
                this.mpeg || this.vfwVideoFourcc
                    ? c.data
                    : this.normalizeH264Chunk(c.data, c.isKeyframe);
            const skipped = this.skippedVideoSlots(ts, out[0]?.ts ?? ts, out.length);
            for (let index = 0; index < skipped; index++) out.push(this.emptyVideoChunk(ts));

            out.push({
                fourcc,
                data,
                ts,
                durationSec,
                isKey: !!c.isKeyframe,
                sampleFrames: 0,
            });

            nextFallbackTs = ts + durationSec;
        }

        return out;
    }

    /**
     * Dropped MPEG video frames, and the time a variable-rate Windows Media video frame is held,
     * keep their slots as empty chunks so later slots stay on the source timeline.
     */
    private skippedVideoSlots(slotTime: number, firstSlotTime: number, written: number): number {
        if (!this.mpeg && !this.vfwVideoFourcc) return 0;
        const tb = this.getVideoRateScale();
        return Math.max(0, Math.round(((slotTime - firstSlotTime) * tb.rate) / tb.scale) - written);
    }

    private emptyVideoChunk(ts: number): PreparedChunk {
        return {
            fourcc: '00dc',
            data: new Uint8Array(0),
            ts,
            durationSec: 0,
            isKey: false,
            sampleFrames: 0,
        };
    }

    /**
     * AVI slots follow decode order; MPEG video B-pictures are presented from their slot by picture
     * type.
     */
    private videoSlotTime(chunk: EncodedPacket): number {
        return this.mpeg || this.vfwVideoFourcc ? decodeTime(chunk) : chunk.timestamp;
    }

    private prepareAudioChunks(fourcc: string): PreparedChunk[] {
        const sr = this.getAudioSampleRate();

        const out: PreparedChunk[] = [];
        let nextFallbackTs = 0;

        for (let i = 0; i < this.audioChunks.length; i++) {
            const c = this.audioChunks[i]!;
            const sampleFrames = this.getAudioChunkSampleFrames(c);
            const fallbackDur = sampleFrames > 0 ? sampleFrames / sr : 0;
            const ts = this.isFiniteNonNegative(c.timestamp) ? c.timestamp : nextFallbackTs;
            const durationSec = this.isFinitePositive(c.duration) ? c.duration : fallbackDur;

            out.push({
                fourcc,
                data: c.data,
                ts,
                durationSec,
                isKey: true,
                sampleFrames,
            });

            nextFallbackTs = ts + durationSec;
        }

        return out;
    }

    private buildIdx1(entries: IndexEntry[]): Uint8Array {
        const w = new BinaryWriter();
        w.writeASCII('idx1');
        w.writeU32LE(entries.length * 16);

        for (const e of entries) {
            w.writeASCII(e.fourcc);
            w.writeU32LE(e.flags);

            w.writeU32LE(e.offset + 4);
            w.writeU32LE(e.size);
        }

        return w.toUint8Array();
    }

    private buildHdrl(
        hasV: boolean,
        hasA: boolean,
        videoFrames: number,
        audioSampleFrames: number,
        maxChunkSize: number,
        maxVideoChunkSize: number,
        maxAudioChunkSize: number,
        avgBytesPerSec: number,
        videoStartSec: number,
        audioStartSec: number,
    ): Uint8Array {
        const avih = this.buildAvih(hasV, hasA, videoFrames, maxChunkSize, avgBytesPerSec);

        const content = new BinaryWriter();
        content.writeBytes(avih);

        if (hasV) {
            content.writeBytes(
                this.buildVideoStream(videoFrames, maxVideoChunkSize, videoStartSec),
            );
        }

        if (hasA) {
            content.writeBytes(
                this.buildAudioStream(audioSampleFrames, maxAudioChunkSize, audioStartSec),
            );
        }

        return this.wrapList('hdrl', content.toUint8Array());
    }

    private buildAvih(
        hasV: boolean,
        hasA: boolean,
        videoFrames: number,
        maxChunkSize: number,
        avgBytesPerSec: number,
    ): Uint8Array {
        const tb = this.getVideoRateScale();
        const streamCount = (hasV ? 1 : 0) + (hasA ? 1 : 0);
        const width = hasV ? this.getVideoWidth() : 0;
        const height = hasV ? this.getVideoHeight() : 0;
        this.u32(videoFrames, 'video frame count');
        this.u32(avgBytesPerSec, 'average byte rate');

        const w = new BinaryWriter();
        w.writeU32LE(hasV ? Math.round((1_000_000 * tb.scale) / tb.rate) : 0);
        w.writeU32LE(avgBytesPerSec);
        w.writeU32LE(0);

        w.writeU32LE(0x10 | (hasV && hasA && !this.streaming ? 0x100 : 0));
        w.writeU32LE(hasV ? videoFrames : 0);
        w.writeU32LE(0);
        w.writeU32LE(streamCount);
        w.writeU32LE(maxChunkSize);
        w.writeU32LE(width);
        w.writeU32LE(height);
        w.writeZeros(16);

        return this.wrapChunk('avih', w.toUint8Array());
    }

    private buildVideoStream(
        frameCount: number,
        maxVideoChunkSize: number,
        videoStartSec: number,
    ): Uint8Array {
        const tb = this.getVideoRateScale();
        const vw = this.getVideoWidth();
        const vh = this.getVideoHeight();
        const videoStartUnits = Math.max(0, Math.round((videoStartSec * tb.rate) / tb.scale));
        this.u32(videoStartUnits, 'video start');
        this.u32(frameCount, 'video frame count');

        const fourcc =
            this.vfwVideoFourcc ??
            (this.mpeg === 'mpeg4v'
                ? 'FMP4'
                : this.mpeg === 'mpeg2v'
                  ? 'mpg2'
                  : this.mpeg
                    ? 'mpg1'
                    : this.hevc
                      ? 'HEVC'
                      : 'H264');
        const extradata =
            ((this.mpeg || this.vfwVideoFourcc) && this.codecConfig) || new Uint8Array(0);
        const strh = new BinaryWriter();
        strh.writeASCII('vids');
        strh.writeASCII(fourcc);
        strh.writeU32LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        strh.writeU32LE(0);
        strh.writeU32LE(tb.scale);
        strh.writeU32LE(tb.rate);
        strh.writeU32LE(videoStartUnits);
        strh.writeU32LE(frameCount);
        strh.writeU32LE(maxVideoChunkSize);
        strh.writeU32LE(0xffffffff);
        strh.writeU32LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(vw);
        strh.writeU16LE(vh);

        const strf = new BinaryWriter();
        strf.writeU32LE(40 + extradata.length);
        strf.writeU32LE(vw);
        strf.writeU32LE(vh);
        strf.writeU16LE(1);
        strf.writeU16LE(24);
        strf.writeASCII(fourcc);
        strf.writeU32LE(0);
        strf.writeU32LE(0);
        strf.writeU32LE(0);
        strf.writeU32LE(0);
        strf.writeU32LE(0);
        strf.writeBytes(extradata);

        const content = new BinaryWriter();
        content.writeBytes(this.wrapChunk('strh', strh.toUint8Array()));
        content.writeBytes(this.wrapChunk('strf', strf.toUint8Array()));

        return this.wrapList('strl', content.toUint8Array());
    }

    private buildAudioStream(
        sampleFrames: number,
        maxAudioChunkSize: number,
        audioStartSec: number,
    ): Uint8Array {
        const sr = this.getAudioSampleRate();
        const ch = this.getAudioChannelCount();
        const frameSamples = this.frameAudio ? (this.audioFrameSamples ?? 1152) : 1;
        const blockAlign = this.frameAudio ? frameSamples : this.getAudioBlockAlign();
        const bytesPerSec = this.frameAudio ? sr : this.getAudioBytesPerSec();
        const sampleSize = this.frameAudio ? 0 : blockAlign;
        const audioStartUnits = Math.max(0, Math.round((audioStartSec * sr) / frameSamples));
        const length = Math.round(sampleFrames / frameSamples);
        this.u32(audioStartUnits, 'audio start');
        this.u32(length, 'audio sample count');

        const strh = new BinaryWriter();
        strh.writeASCII('auds');
        strh.writeU32LE(0);
        strh.writeU32LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        strh.writeU32LE(0);
        strh.writeU32LE(blockAlign);
        strh.writeU32LE(bytesPerSec);
        strh.writeU32LE(audioStartUnits);
        strh.writeU32LE(length);
        strh.writeU32LE(maxAudioChunkSize);
        strh.writeU32LE(0xffffffff);
        strh.writeU32LE(sampleSize);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(0);

        const strf = new BinaryWriter();
        if (this.windowsAudio) strf.writeBytes(this.cfg.audio!.codecConfig!);
        else if (this.frameAudio) this.frameAudioFormat(sampleFrames, strf);
        else {
            strf.writeU16LE(0x0001);
            strf.writeU16LE(ch);
            strf.writeU32LE(sr);
            strf.writeU32LE(bytesPerSec);
            strf.writeU16LE(blockAlign);
            strf.writeU16LE(16);
        }

        const content = new BinaryWriter();
        content.writeBytes(this.wrapChunk('strh', strh.toUint8Array()));
        content.writeBytes(this.wrapChunk('strf', strf.toUint8Array()));

        return this.wrapList('strl', content.toUint8Array());
    }

    private wrapChunk(fourcc: string, data: Uint8Array): Uint8Array {
        const w = new BinaryWriter();
        w.writeASCII(fourcc);
        w.writeU32LE(data.length);
        w.writeBytes(data);
        if ((data.length & 1) !== 0) {
            w.writeU8(0);
        }
        return w.toUint8Array();
    }

    private wrapList(fourcc: string, data: Uint8Array): Uint8Array {
        const w = new BinaryWriter();
        const listSize = data.length + 4;

        w.writeASCII('LIST');
        w.writeU32LE(listSize);
        w.writeASCII(fourcc);
        w.writeBytes(data);

        if ((listSize & 1) !== 0) {
            w.writeU8(0);
        }

        return w.toUint8Array();
    }

    private getVideoRateScale(): { rate: number; scale: number } {
        const fps = this.getConfiguredOrEstimatedVideoFps();
        const result = this.fpsToAviRateScale(fps);
        this.u32(result.rate, 'video rate');
        this.u32(result.scale, 'video scale');
        this.u32(Math.round((1_000_000 * result.scale) / result.rate), 'frame duration');
        return result;
    }

    private getConfiguredOrEstimatedVideoFps(): number {
        const cfgFps = this.cfg.video?.framerate;
        if (typeof cfgFps === 'number' && Number.isFinite(cfgFps) && cfgFps > 0) {
            return cfgFps;
        }

        const estimated = this.estimateVideoFpsFromChunks();
        if (estimated && Number.isFinite(estimated) && estimated > 0) {
            return estimated;
        }

        return 30;
    }

    private estimateVideoFpsFromChunks(): number | undefined {
        if (this.videoChunks.length >= 2) {
            const deltas: number[] = [];
            for (let i = 1; i < this.videoChunks.length; i++) {
                const dt = this.videoChunks[i]!.timestamp - this.videoChunks[i - 1]!.timestamp;
                if (Number.isFinite(dt) && dt > 0 && dt < 10) {
                    deltas.push(dt);
                }
            }
            if (deltas.length > 0) {
                deltas.sort((a, b) => a - b);
                const median = deltas[deltas.length >> 1]!;
                if (median > 0) return 1 / median;
            }
        }

        const durations: number[] = [];
        for (const c of this.videoChunks) {
            if (Number.isFinite(c.duration) && c.duration > 0 && c.duration < 10) {
                durations.push(c.duration);
            }
        }
        if (durations.length > 0) {
            durations.sort((a, b) => a - b);
            const median = durations[durations.length >> 1]!;
            if (median > 0) return 1 / median;
        }

        return undefined;
    }

    private fpsToAviRateScale(fps: number): { rate: number; scale: number } {
        if (!Number.isFinite(fps) || fps <= 0) {
            return { rate: 30, scale: 1 };
        }

        const common = [
            { fps: 24000 / 1001, rate: 24000, scale: 1001 },
            { fps: 30000 / 1001, rate: 30000, scale: 1001 },
            { fps: 60000 / 1001, rate: 60000, scale: 1001 },
            { fps: 120000 / 1001, rate: 120000, scale: 1001 },
            { fps: 24, rate: 24, scale: 1 },
            { fps: 25, rate: 25, scale: 1 },
            { fps: 30, rate: 30, scale: 1 },
            { fps: 50, rate: 50, scale: 1 },
            { fps: 60, rate: 60, scale: 1 },
        ];

        for (const c of common) {
            if (Math.abs(fps - c.fps) < 0.01) {
                return { rate: c.rate, scale: c.scale };
            }
        }

        const scale = 1_000_000;
        const rate = Math.max(1, Math.round(fps * scale));
        if (!Number.isSafeInteger(rate))
            throw new MediaForgeError('AVI frame rate exceeds the supported range', 'MUX');
        const g = gcd(rate, scale);

        return {
            rate: Math.floor(rate / g),
            scale: Math.floor(scale / g),
        };
    }

    private getVideoWidth(): number {
        return this.cfg.video?.width ?? 1920;
    }

    private getVideoHeight(): number {
        return this.cfg.video?.height ?? 1080;
    }

    private getAudioSampleRate(): number {
        return this.cfg.audio?.sampleRate ?? this.observedAudioSampleRate ?? 48000;
    }

    private getAudioChannelCount(): number {
        return this.cfg.audio?.channelCount ?? this.observedAudioChannels ?? 2;
    }

    private getAudioBlockAlign(): number {
        return this.windowsAudio?.blockAlign ?? this.getAudioChannelCount() * 2;
    }

    private getAudioBytesPerSec(): number {
        return (
            this.windowsAudio?.averageBytesPerSecond ??
            this.getAudioSampleRate() * this.getAudioBlockAlign()
        );
    }

    private getAudioChunkSampleFrames(c: EncodedPacket): number {
        if (this.frameAudio) return this.frameAudioSamples(c.data);
        const blockAlign = this.getAudioBlockAlign();
        if (blockAlign > 0 && c.data.length >= blockAlign) {
            return Math.floor(c.data.length / blockAlign);
        }

        const sr = this.getAudioSampleRate();
        if (this.isFinitePositive(c.duration)) {
            return Math.max(0, Math.round(c.duration * sr));
        }

        return 0;
    }

    /** Samples of the MPEG frames a chunk holds, or one AC-3 frame. */
    private frameAudioSamples(data: Uint8Array): number {
        if (this.frameAudio!.layer === 0) return AC3_FRAME_SAMPLES;
        let samples = 0;
        for (let offset = 0; offset + 4 <= data.length;) {
            const header = parseMpegAudioHeader(data, offset);
            if (!header) break;
            this.audioFrameSamples ??= header.samplesPerFrame;
            samples += header.samplesPerFrame;
            offset += header.frameLength;
        }
        if (!samples)
            throw new MediaForgeError(
                'AVI MPEG audio chunk does not start with a frame header',
                'MUX',
            );
        return samples;
    }

    /**
     * WAVEFORMATEX of compressed audio, with the MPEG extensions that Layer I-III readers expect.
     */
    private frameAudioFormat(sampleFrames: number, strf: BinaryWriter): void {
        const { tag, layer } = this.frameAudio!;
        const sr = this.getAudioSampleRate();
        const ch = this.getAudioChannelCount();
        const frameSamples = this.audioFrameSamples ?? (layer === 1 ? 384 : 1152);
        const frames = Math.round(sampleFrames / frameSamples);
        const bytesPerSec =
            sampleFrames > 0 ? Math.round((this.audioBytes * sr) / sampleFrames) : 0;
        this.u32(bytesPerSec, 'audio byte rate');

        strf.writeU16LE(tag);
        strf.writeU16LE(ch);
        strf.writeU32LE(sr);
        strf.writeU32LE(bytesPerSec);
        strf.writeU16LE(layer === 0 ? 3840 : frameSamples);
        strf.writeU16LE(0);

        if (tag === 0x0055) {
            strf.writeU16LE(12);
            strf.writeU16LE(1);
            strf.writeU32LE(2);
            strf.writeU16LE(
                frames > 0 ? Math.min(0xffff, Math.round(this.audioBytes / frames)) : 0,
            );
            strf.writeU16LE(1);
            strf.writeU16LE(0);
        } else if (tag === 0x0050) {
            strf.writeU16LE(22);
            strf.writeU16LE(1 << (layer - 1));
            strf.writeU32LE(bytesPerSec * 8);
            strf.writeU16LE(ch === 1 ? 8 : 1);
            strf.writeU16LE(0);
            strf.writeU16LE(1);
            strf.writeU16LE(0x10);
            strf.writeU32LE(0);
            strf.writeU32LE(0);
        } else strf.writeU16LE(0);
    }

    private prepareCodecConfig(cfg: Uint8Array): AvcConfigInfo {
        this.validateBytes(cfg);
        const parsed =
            cfg[0] === 1
                ? this.hevc
                    ? this.parseHevcDecoderConfigurationRecord(cfg)
                    : this.parseAvcDecoderConfigurationRecord(cfg)
                : null;
        if (parsed) return parsed;
        if (isAnnexB(cfg) && this.chunkHasSpsPps(cfg)) {
            return { nalLengthSize: 0, annexBConfig: new Uint8Array(cfg) };
        }
        throw new MediaForgeError('AVI AVC decoder configuration is malformed', 'MUX');
    }

    private normalizeH264Chunk(
        data: Uint8Array,
        isKeyframe: boolean,
        config?: AvcConfigInfo,
    ): Uint8Array {
        let out = data;

        const nalLengthSize =
            (config?.nalLengthSize ?? this.nalLengthSize) || this.guessAvccNalLengthSize(out) || 0;
        const walk = this.hevc ? isValidHevcWalk : isValidAvccWalk;
        if (nalLengthSize >= 1 && nalLengthSize <= 4 && walk(out, nalLengthSize as 1 | 2 | 3 | 4)) {
            const converted = this.convertAvccSampleToAnnexB(out, nalLengthSize);
            if (!converted) {
                throw new MediaForgeError(
                    'Failed to convert H.264 sample from AVCC to Annex B',
                    'MUX',
                );
            }
            out = converted;
        } else if (!isAnnexB(out)) {
            throw new MediaForgeError('H.264 chunk is neither AVCC nor Annex B', 'MUX', {
                hint: 'Pass the codec config to addVideoChunk(), or encode Annex B.',
            });
        }

        const annexBConfig = config?.annexBConfig ?? this.annexBCodecConfig;
        if (isKeyframe && annexBConfig && !this.chunkHasSpsPps(out)) {
            out = concatBytes([annexBConfig, out]);
        }

        return out;
    }

    private parseHevcDecoderConfigurationRecord(data: Uint8Array): AvcConfigInfo | null {
        const parsed = hevcConfigToAnnexB(data);
        return parsed ? { nalLengthSize: parsed.lengthSize, annexBConfig: parsed.paramSets } : null;
    }

    private parseAvcDecoderConfigurationRecord(data: Uint8Array): AvcConfigInfo | null {
        // An 'avc3' record may leave every parameter set to the samples.
        const inBand = (this.cfg.video?.codec ?? '').startsWith('avc3');
        const parsed = avcConfigToAnnexB(data, inBand);
        return parsed ? { nalLengthSize: parsed.lengthSize, annexBConfig: parsed.paramSets } : null;
    }

    private guessAvccNalLengthSize(data: Uint8Array): number | undefined {
        for (const n of [4, 2, 1]) {
            if (this.looksLikeAvccSample(data, n)) return n;
        }
        return undefined;
    }

    private looksLikeAvccSample(data: Uint8Array, nalLengthSize: number): boolean {
        let pos = 0;
        let sawNal = false;

        while (pos + nalLengthSize <= data.length) {
            let len = 0;
            for (let i = 0; i < nalLengthSize; i++) {
                len = (len << 8) | data[pos + i]!;
            }
            pos += nalLengthSize;

            if (len <= 0 || pos + len > data.length) return false;

            if (this.hevc ? (data[pos]! & 0x80) !== 0 : (data[pos]! & 0x1f) === 0) return false;

            pos += len;
            sawNal = true;
        }

        return sawNal && pos === data.length;
    }

    private convertAvccSampleToAnnexB(data: Uint8Array, nalLengthSize: number): Uint8Array | null {
        let pos = 0;
        const parts: Uint8Array[] = [];

        while (pos + nalLengthSize <= data.length) {
            let len = 0;
            for (let i = 0; i < nalLengthSize; i++) {
                len = (len << 8) | data[pos + i]!;
            }
            pos += nalLengthSize;

            if (len <= 0 || pos + len > data.length) return null;

            parts.push(AviMuxer.START_CODE, data.subarray(pos, pos + len));
            pos += len;
        }

        if (pos !== data.length) return null;
        return concatBytes(parts);
    }

    private chunkHasSpsPps(data: Uint8Array): boolean {
        let foundSps = false;
        let foundPps = false;
        let pos = 0;

        while (true) {
            const cur = this.findStartCode(data, pos);
            if (!cur) break;

            const nalStart = cur.index + cur.length;
            const next = this.findStartCode(data, nalStart);
            const nalEnd = next ? next.index : data.length;

            if (nalStart < nalEnd) {
                const nalType = this.hevc ? (data[nalStart]! >> 1) & 0x3f : data[nalStart]! & 0x1f;
                if (nalType === (this.hevc ? 33 : 7)) foundSps = true;
                if (nalType === (this.hevc ? 34 : 8)) foundPps = true;
                if (foundSps && foundPps) return true;
            }

            pos = nalEnd;
        }

        return false;
    }

    private findStartCode(
        data: Uint8Array,
        from: number,
    ): { index: number; length: number } | null {
        for (let i = from; i + 3 < data.length; i++) {
            if (data[i] === 0x00 && data[i + 1] === 0x00) {
                if (data[i + 2] === 0x01) {
                    return { index: i, length: 3 };
                }
                if (data[i + 2] === 0x00 && data[i + 3] === 0x01) {
                    return { index: i, length: 4 };
                }
            }
        }
        return null;
    }

    private isFinitePositive(v: number | undefined): v is number {
        return typeof v === 'number' && Number.isFinite(v) && v > 0;
    }

    private isFiniteNonNegative(v: number | undefined): v is number {
        return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    }
}

/** The avi plugin's 'avi' writer, which its index loads on first use. */
export const createAviMuxer: ContainerWriterFactory = (config, sink) => new AviMuxer(config, sink);
