import type { Reader } from '../../core/contracts/reader';
import { HANDS_OVER, readerDiagnostics } from '../shared/contract';
import type { Source } from '../../core/model/types';
import { BlobSource } from '../../core/io/sources/sources';
import { ChunkReader } from '../../core/io/sources/chunk-reader';
import {
    DEMUX_LIMITS,
    DemuxIndexBudget,
    resolveDemuxBudget,
    type ResolvedDemuxBudget,
} from '../shared/demux-budget';
import type { DemuxBudgetOptions } from '../../core/contracts/reader';
import { yieldEventLoop } from '../../core/io/event-loop';
import { DemuxError, throwIfAborted } from '../../core/errors/errors';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import type { DemuxResult, Sample, TrackInfo } from '../../core/model/track';
import { continuedAudioTime, PTS_WRAP, readPesTimestamp } from '../shared/pes-timestamp';
import { findStartCode, type MpegVideoSyntax } from '../../core/codec-config/video/mpeg-video';
import { MpegVideoAccessUnits, buildMpegVideoTrack } from '../shared/mpeg-video-stream';
import { parseMpegAudioHeader } from '../../core/codec-config/audio/mpeg-audio-header';
import {
    ac3SpecificBox,
    parseDolbyFrameHeader,
} from '../../core/codec-config/audio/dolby-audio-header';
import { dtsSpecificBox, parseDtsFrame } from '../../core/codec-config/audio/dts-header';
import { buildAacConfig, parseAdtsFrameHeader } from '../../core/codec-config/audio/adts';
import { PACK, parsePackHeader } from '../shared/mpeg-ps-layout';
import { annexBAccessUnitStarts } from '../../core/codec-config/video/annexb';
import { annexBVideoTrack } from '../shared/pes-video-tracks';

const PROGRAM_END = 0xb9;
const SYSTEM_HEADER = 0xbb;
const STREAM_MAP = 0xbc;
const PRIVATE_1 = 0xbd;
const PADDING = 0xbe;
const PRIVATE_2 = 0xbf;
const WINDOW_BYTES = 1 << 20;

/** SCR steps beyond this are timeline discontinuities (VOB cell joins, concatenated recordings). */
const MAX_SCR_STEP = 10 * 90000;

/** Bytes of one video stream buffered while its syntax is identified. */
const MAX_SNIFF_BYTES = 1 << 20;

/** Enough bytes to read any supported audio frame header. */
const AUDIO_HEADER_BYTES = 11;

interface PesHeader {
    readonly start: number;
    readonly pts?: number;
    readonly dts?: number;
}

/**
 * PES payload start and raw timestamps of the packet in [at, end), in MPEG-1 or MPEG-2 syntax; null
 * when malformed.
 */
function parsePesHeader(bytes: Uint8Array, at: number, end: number): PesHeader | null {
    let p = at + 6;
    if (p >= end) return { start: end };
    if ((bytes[p]! & 0xc0) === 0x80) {
        if (p + 3 > end) return null;
        const flags = bytes[p + 1]! >> 6;
        const headerLength = bytes[p + 2]!;
        const start = p + 3 + headerLength;
        if (start > end || flags === 1) return null;
        if (flags < 2) return { start };
        if (headerLength < (flags === 3 ? 10 : 5)) return null;
        const pts = readPesTimestamp(bytes, p + 3, flags);
        const dts = flags === 3 ? readPesTimestamp(bytes, p + 8, 1) : pts;
        return pts === null || dts === null ? null : { start, pts, dts };
    }

    for (let stuffing = 0; p < end && bytes[p] === 0xff; p++) if (++stuffing > 16) return null;
    if (p < end && (bytes[p]! & 0xc0) === 0x40) p += 2;
    if (p >= end) return null;
    if (bytes[p] === 0x0f) return { start: p + 1 };
    const prefix = bytes[p]! >> 4;
    if (prefix !== 2 && prefix !== 3) return null;
    const length = prefix === 3 ? 10 : 5;
    if (p + length > end) return null;
    const pts = readPesTimestamp(bytes, p, prefix);
    const dts = prefix === 3 ? readPesTimestamp(bytes, p + 5, 1) : pts;
    return pts === null || dts === null ? null : { start: p + length, pts, dts };
}

interface AudioFrame {
    readonly length: number;
    readonly samples: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly codec: string;
    /** Framing bytes that the demuxed packet omits (ADTS headers). */
    readonly headerLength: number;
    readonly codecConfig?: Uint8Array;
}

type AudioFrameParser = (data: Uint8Array, at: number) => AudioFrame | null;

function mpegAudioFrame(data: Uint8Array, at: number): AudioFrame | null {
    const header = parseMpegAudioHeader(data, at);
    return (
        header && {
            length: header.frameLength,
            samples: header.samplesPerFrame,
            sampleRate: header.sampleRate,
            channels: header.channels,
            codec: header.format,
            headerLength: 0,
        }
    );
}

function adtsFrame(data: Uint8Array, at: number): AudioFrame | null {
    const header = parseAdtsFrameHeader(data, at);
    if (!header || header.channels === 0 || header.rawDataBlocks !== 0) return null;
    return {
        length: header.frameLength,
        samples: 1024,
        sampleRate: header.sampleRate,
        channels: header.channels,
        codec: `mp4a.40.${header.audioObjectType}`,
        headerLength: header.headerLength,
        codecConfig: buildAacConfig(header.sampleRate, header.channels, header.audioObjectType),
    };
}

function dolbyFrame(data: Uint8Array, at: number): AudioFrame | null {
    const header = parseDolbyFrameHeader(data, at);
    if (!header || header.frameBytes < 7 || header.streamType === 1) return null;
    return {
        length: header.frameBytes,
        samples: header.samples,
        sampleRate: header.sampleRate,
        channels: header.channels,
        codec: header.codec,
        headerLength: 0,
        codecConfig: header.codec === 'ac-3' ? ac3SpecificBox(data, at) : undefined,
    };
}

/**
 * DTS access unit (core, optionally with an extension substream) in the 16-bit big-endian form DVDs
 * use.
 */
function dtsFrame(data: Uint8Array, at: number): AudioFrame | null {
    const frame = parseDtsFrame(data, at);
    if (!frame) return null;
    return {
        length: frame.frameBytes,
        samples: frame.samples,
        sampleRate: frame.sampleRate,
        channels: frame.channels,
        codec: frame.codec,
        headerLength: 0,
        codecConfig: dtsSpecificBox(data, at),
    };
}

interface TimestampMark {
    readonly position: number;
    readonly pts?: number;
    used: boolean;
}

function audioTrack(
    samples: Sample[],
    codec: string,
    sampleRate: number,
    channelCount: number,
): TrackInfo {
    const last = samples[samples.length - 1];
    return {
        codec,
        width: 0,
        height: 0,
        sampleRate,
        channelCount,
        duration: last ? last.timestamp + last.duration : 0,
        samples,
    };
}

/**
 * Frames an audio elementary stream across PES boundaries; a PES timestamp belongs to the first
 * frame starting in it.
 */
class FramedAudio {
    readonly samples: Sample[] = [];
    private format?: AudioFrame;
    private buffer = new Uint8Array(1 << 14);
    private length = 0;
    private base = 0;
    private marks: TimestampMark[] = [];
    private clock?: number;
    private skipped = 0;

    constructor(
        private parse: AudioFrameParser | undefined,
        private readonly budget: DemuxIndexBudget,
        private readonly onDamage: (message: string) => void,
    ) {}

    push(data: Uint8Array, pts: number | undefined): void {
        if (this.length + data.length > this.buffer.length) {
            let size = this.buffer.length;
            while (size < this.length + data.length) size *= 2;
            const grown = new Uint8Array(size);
            grown.set(this.buffer.subarray(0, this.length));
            this.buffer = grown;
        }
        this.marks.push({ position: this.base + this.length, pts, used: false });
        this.buffer.set(data, this.length);
        this.length += data.length;
        this.frames(false);
    }

    /** Drops the bytes of a frame that the timeline or lost data cut short; returns their count. */
    cut(): number {
        const dropped = this.length;
        this.base += this.length;
        this.length = 0;
        this.marks = [];
        this.skipped = 0;
        return dropped;
    }

    track(): TrackInfo | null {
        this.frames(true);
        this.cut();
        const samples = this.samples;
        const first = samples.findIndex(sample => !Number.isNaN(sample.timestamp));
        for (let index = first - 1; index >= 0; index--)
            samples[index]!.timestamp = samples[index + 1]!.timestamp - samples[index]!.duration;
        if (first < 0) {
            let clock = 0;
            for (const sample of samples) {
                sample.timestamp = clock;
                clock += sample.duration;
            }
        }
        const format = this.format;
        return format && samples.length
            ? audioTrack(samples, format.codec, format.sampleRate, format.channels)
            : null;
    }

    private frames(final: boolean): void {
        let at = 0;
        while (at + 4 <= this.length) {
            const frame = this.frameAt(at, final);
            if (frame === 'more') break;
            if (!frame) {
                at++;
                this.skipped++;
                continue;
            }
            if (at + frame.length > this.length) break;
            this.reportSkipped();
            this.emit(at, frame);
            at += frame.length;
        }

        if (at === 0) return;
        this.buffer.copyWithin(0, at, this.length);
        this.length -= at;
        this.base += at;
        while (this.marks.length > 1 && this.marks[1]!.position <= this.base) this.marks.shift();
    }

    /**
     * A frame found while searching must chain into the next header, so payload bytes are not taken
     * for one.
     */
    private frameAt(at: number, final: boolean): AudioFrame | null | 'more' {
        const bytes = this.buffer.subarray(0, this.length);
        for (const parse of this.parse ? [this.parse] : [mpegAudioFrame, adtsFrame]) {
            const frame = parse(bytes, at);
            const format = this.format;
            if (
                !frame ||
                (format && (frame.codec !== format.codec || frame.sampleRate !== format.sampleRate))
            )
                continue;
            if (format && this.skipped === 0) return frame;
            const next = at + frame.length;
            if (next + AUDIO_HEADER_BYTES > this.length) {
                if (!final) return 'more';
            } else if (!parse(bytes, next)) continue;
            this.parse = parse;
            return frame;
        }
        return at + AUDIO_HEADER_BYTES > this.length && !final ? 'more' : null;
    }

    private reportSkipped(): void {
        const bytes = this.skipped;
        this.skipped = 0;
        if (bytes && this.format)
            this.onDamage(`Skipped ${bytes} audio bytes without a valid frame header`);
    }

    private emit(at: number, frame: AudioFrame): void {
        this.format ??= frame;
        const position = this.base + at;
        while (this.marks.length > 1 && this.marks[1]!.position <= position) this.marks.shift();
        const mark = this.marks[0];

        let timestamp = this.clock;
        const duration = frame.samples / frame.sampleRate;
        if (mark && mark.position <= position && !mark.used && mark.pts !== undefined) {
            mark.used = true;
            timestamp = continuedAudioTime(this.clock, mark.pts / 90000, duration);
        }

        this.budget.reserveSamples(1, 256, 'MPEG-PS audio sample index');
        this.samples.push({
            offset: 0,
            size: frame.length - frame.headerLength,
            timestamp: timestamp ?? NaN,
            duration,
            isKeyframe: true,
            data: this.buffer.slice(at + frame.headerLength, at + frame.length),
        });

        this.clock = timestamp === undefined ? undefined : timestamp + duration;
    }

    get codecConfig(): Uint8Array | undefined {
        return this.format?.codecConfig;
    }
}

interface LpcmFormat {
    readonly bits: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly blockBytes: number;
    readonly blockFrames: number;
}

/**
 * DVD LPCM header byte: quantization (16/20/24 bit), sampling frequency and channel count; blocks
 * follow ffmpeg.
 */
function parseLpcmFormat(value: number): LpcmFormat | null {
    const quantization = value >> 6;
    if (quantization === 3) return null;
    const bits = 16 + quantization * 4;
    const channels = (value & 7) + 1;
    const sampleRate = [48000, 96000, 44100, 32000][(value >> 4) & 3]!;
    if (bits === 16)
        return { bits, sampleRate, channels, blockBytes: channels * 2, blockFrames: 1 };
    const samples =
        channels === 1 || channels === 2 || channels === 4 ? 4 : channels === 8 ? 8 : 4 * channels;
    return {
        bits,
        sampleRate,
        channels,
        blockBytes: (samples * bits) / 8,
        blockFrames: samples / channels,
    };
}

/**
 * Repacks whole DVD LPCM blocks as interleaved big-endian samples. 20- and 24-bit samples are
 * stored in groups (two samples for mono, four otherwise) whose 16 most significant bits precede
 * the remaining low bits.
 */
function unpackLpcm(data: Uint8Array, format: LpcmFormat): Uint8Array {
    if (format.bits === 16) return data.slice();
    const group = format.channels === 1 ? 2 : 4;
    const stride = 2 * group + (format.bits === 24 ? group : group / 2);
    const out = new Uint8Array((data.length / stride) * group * 3);
    for (let source = 0, target = 0; target < out.length; source += stride, target += 3 * group) {
        const low = source + 2 * group;
        for (let index = 0; index < group; index++) {
            out[target + 3 * index] = data[source + 2 * index]!;
            out[target + 3 * index + 1] = data[source + 2 * index + 1]!;
            out[target + 3 * index + 2] =
                format.bits === 24
                    ? data[low + index]!
                    : index & 1
                      ? (data[low + (index >> 1)]! & 0x0f) << 4
                      : data[low + (index >> 1)]! & 0xf0;
        }
    }
    return out;
}

/** DVD LPCM: whole blocks become packets; a partial block waits for the next PES. */
class LpcmAudio {
    readonly samples: Sample[] = [];
    private format?: LpcmFormat;
    private carry = new Uint8Array(0);
    private clock = 0;

    constructor(
        private readonly budget: DemuxIndexBudget,
        private readonly onDamage: (message: string) => void,
    ) {}

    /**
     * `pointer` locates the audio frame that `pts` times, counted from the last pointer byte as
     * DVD-Video does.
     */
    push(header: number, data: Uint8Array, pts: number | undefined, pointer: number): void {
        const format = parseLpcmFormat(header);
        const current = this.format;
        if (
            !format ||
            (current &&
                (current.bits !== format.bits ||
                    current.channels !== format.channels ||
                    current.sampleRate !== format.sampleRate))
        ) {
            this.onDamage(
                'Discarded a DVD LPCM packet whose header is invalid or changes the stream format',
            );
            return;
        }
        this.format = format;

        const bytes = new Uint8Array(this.carry.length + data.length);
        bytes.set(this.carry);
        bytes.set(data, this.carry.length);

        const blocks = Math.floor(bytes.length / format.blockBytes);
        const lead = this.carry.length + Math.min(Math.max(0, pointer - 4), data.length);
        const leadFrames = (lead / format.blockBytes) * format.blockFrames;
        this.carry = bytes.slice(blocks * format.blockBytes);
        if (blocks === 0) return;

        const frames = blocks * format.blockFrames;
        const timestamp =
            pts === undefined ? this.clock : pts / 90000 - leadFrames / format.sampleRate;
        const payload = unpackLpcm(bytes.subarray(0, blocks * format.blockBytes), format);

        this.budget.reserveSamples(1, 256, 'MPEG-PS audio sample index');
        this.samples.push({
            offset: 0,
            size: payload.length,
            timestamp,
            duration: frames / format.sampleRate,
            isKeyframe: true,
            data: payload,
        });
        this.clock = timestamp + frames / format.sampleRate;
    }

    cut(): number {
        const dropped = this.carry.length;
        this.carry = new Uint8Array(0);
        return dropped;
    }

    track(): TrackInfo | null {
        const format = this.format;
        if (!format || !this.samples.length) return null;
        return audioTrack(
            this.samples,
            format.bits === 16 ? 'pcm-s16be' : 'pcm-s24be',
            format.sampleRate,
            format.channels,
        );
    }
}

type VideoKind = MpegVideoSyntax | 'h264' | 'hevc' | 'other';

/**
 * First decisive start code of MPEG-1/2 video, MPEG-4 Part 2, or H.264/HEVC parameter sets; null
 * when undecided.
 */
function sniffVideoSyntax(data: Uint8Array): VideoKind | null {
    let objectStart = false;
    for (
        let at = findStartCode(data, 0);
        at >= 0 && at + 5 < data.length;
        at = findStartCode(data, at + 3)
    ) {
        const code = data[at + 3]!;
        const next = data[at + 4]!;
        if (code === 0xb3 || code === 0xb8) return 'mpeg12';
        if (code === 0xb0 || code === 0xb6 || (objectStart && code >= 0x20 && code <= 0x2f))
            return 'mpeg4';
        objectStart = code <= 0x1f && next === 0 && data[at + 5] === 0;
        if (code === 0 && !objectStart) return 'mpeg12';
        if (
            (code & 0x9f) === 0x07 &&
            [66, 77, 88, 100, 110, 122, 244, 44, 83, 86, 118, 128].includes(next)
        )
            return 'h264';
        if ((code === 0x40 || code === 0x42) && next === 0x01) return 'hevc';
    }
    return null;
}

interface VideoStream {
    readonly order: number;
    readonly id: number;
    kind: VideoKind | null;
    units?: MpegVideoAccessUnits;
    /**
     * H.264/H.265 payloads in arrival order; access units are split once the stream has been read.
     */
    annexB?: { data: Uint8Array; pts?: number; dts?: number }[];
    pending: { data: Uint8Array; pts?: number; dts?: number }[];
    pendingBytes: number;
    lost: boolean;
    /** Frames were discarded as damaged or cut: the track omits part of the stream. */
    incomplete?: boolean;
}

interface AudioStream {
    readonly order: number;
    readonly audio: FramedAudio | LpcmAudio;
}

const VIDEO_STREAM_TYPES: Readonly<Record<number, VideoKind>> = {
    0x01: 'mpeg12',
    0x02: 'mpeg12',
    0x10: 'mpeg4',
    0x1b: 'h264',
    0x24: 'hevc',
    0x42: 'other',
    0xea: 'other',
};

class ProgramStream {
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private readonly size: number;
    private window: Uint8Array = new Uint8Array(0);
    private windowStart = 0;
    private readonly video = new Map<number, VideoStream>();
    private readonly audio = new Map<number, AudioStream>();
    private readonly streamTypes = new Map<number, number>();
    private readonly unsupported = new Map<number, string>();
    private order = 0;
    /** Stream id of the packet the end of the input cuts. */
    declare private cutStream?: number;
    declare private scr?: number;
    declare private lastTimestamp?: number;
    private rebase = 0;
    private maxMapped = -Infinity;

    constructor(
        private readonly reader: ChunkReader,
        private readonly budget: DemuxIndexBudget,
        private readonly diagnostics: DiagnosticContext,
        private readonly signal?: AbortSignal,
    ) {
        this.size = reader.size;
    }

    private checkAbort(): void {
        throwIfAborted(this.signal);
    }

    private async load(pos: number, length: number): Promise<void> {
        const end = Math.min(this.size, pos + length);
        if (pos >= this.windowStart && end <= this.windowStart + this.window.length) return;
        this.window = await this.reader.bytes(
            pos,
            Math.min(this.size - pos, Math.max(WINDOW_BYTES, length)),
        );
        this.windowStart = pos;
        this.checkAbort();
    }

    private byte(pos: number): number {
        return this.window[pos - this.windowStart] ?? 0;
    }

    async read(): Promise<DemuxResult> {
        this.checkAbort();
        let pos = 0;
        for (let packets = 1; pos + 4 <= this.size; packets++) {
            if ((packets & 1023) === 0) {
                await yieldEventLoop();
                this.checkAbort();
            }
            await this.load(pos, 32);
            const id = this.byte(pos + 3);
            const startCode =
                this.byte(pos) === 0 && this.byte(pos + 1) === 0 && this.byte(pos + 2) === 1;
            if (!startCode || (id < SYSTEM_HEADER && id !== PACK && id !== PROGRAM_END)) {
                const padded = startCode ? -1 : await this.afterZeroPadding(pos);
                pos = padded >= 0 ? padded : await this.resynchronize(pos);
                continue;
            }
            if (id === PROGRAM_END) {
                pos += 4;
                continue;
            }
            if (id === PACK) {
                const pack = parsePackHeader(this.window, pos - this.windowStart, false);
                if (!pack) {
                    pos = await this.resynchronize(pos);
                    continue;
                }
                this.clockReference(pack.scr);
                pos += pack.length;
                continue;
            }
            const end = pos + 6 + ((this.byte(pos + 4) << 8) | this.byte(pos + 5));
            if (end > this.size) {
                this.diagnostics.note(
                    'recover',
                    'mpeg',
                    'PS_TRUNCATED_PACKET',
                    id >= 0xe0 || (id !== PRIVATE_1 && id < 0xc0)
                        ? `Discarded the MPEG-PS packet at byte ${pos}, cut by the end`
                        : `MPEG-PS audio packet at byte ${pos} is cut; keeping its whole frames`,
                    { offset: pos },
                );

                // Audio frames before the cut are whole; a cut picture cannot be completed.
                this.cutStream = id;
                if (id !== PRIVATE_1 && (id < 0xc0 || id >= 0xe0)) break;
                await this.load(pos, this.size - pos);
                this.packet(id, pos, this.size);
                break;
            }
            await this.load(pos, end - pos);

            // A malformed header also discredits the length that led here; the next packet is
            // searched for instead.
            pos = this.packet(id, pos, end) ? end : await this.resynchronize(pos);
        }
        return this.finish();
    }

    /**
     * Start code after zero bytes, as Video CD sectors pad every pack; -1 when other bytes
     * intervene.
     */
    private async afterZeroPadding(pos: number): Promise<number> {
        let at = pos;
        for (; at < this.size; at++) {
            if (at >= this.windowStart + this.window.length) await this.load(at, WINDOW_BYTES);
            if (this.byte(at) !== 0) break;
        }
        return at - pos >= 2 && at < this.size && this.byte(at) === 1 ? at - 2 : -1;
    }

    /**
     * A pack header with valid marker bits, or a system or PES start code whose header byte is
     * plausible.
     */
    private resumesAt(at: number): boolean {
        const id = this.window[at + 3]!;
        if (id === PACK) return parsePackHeader(this.window, at, true) !== null;
        if (id < SYSTEM_HEADER || (id >= 0xf0 && id !== 0xff)) return false;
        if (id < PRIVATE_1 || id === PADDING || id === PRIVATE_2) return true;
        const flags = this.window[at + 6] ?? 0;
        return (
            (flags & 0xc0) === 0x80 ||
            (flags & 0xc0) === 0x40 ||
            (flags & 0xe0) === 0x20 ||
            flags === 0x0f ||
            flags === 0xff
        );
    }

    /** Skips damaged bytes up to the next pack header or PES start code. */
    private async resynchronize(from: number): Promise<number> {
        let found = this.size;
        for (let pos = from + 1; pos + 4 <= this.size && found === this.size;) {
            this.checkAbort();
            await this.load(pos, WINDOW_BYTES);
            const end = this.windowStart + this.window.length;
            let resume = Math.max(pos + 1, end - 16);
            for (
                let at = findStartCode(this.window, pos - this.windowStart);
                at >= 0;
                at = findStartCode(this.window, at + 3)
            ) {
                const absolute = this.windowStart + at;
                if (absolute + 16 > end && end < this.size) {
                    resume = absolute;
                    break;
                }
                if (this.resumesAt(at)) {
                    found = absolute;
                    break;
                }
            }

            if (end >= this.size) break;
            pos = resume;
        }

        this.diagnostics.note(
            'recover',
            'mpeg',
            'PS_RESYNCHRONIZED',
            found < this.size
                ? `Skipped ${found - from} bytes without a start code; resumed at byte ${found}`
                : `Ignored ${this.size - from} bytes without a start code at byte ${from}`,
            { offset: from },
        );
        for (const stream of this.video.values()) stream.lost = true;
        for (const stream of this.audio.values()) stream.audio.cut();
        return found;
    }

    private clockReference(raw: number): void {
        if (this.scr === undefined) {
            this.scr = raw;
            return;
        }

        const scr = raw + Math.round((this.scr - raw) / PTS_WRAP) * PTS_WRAP;
        const step = scr - this.scr;
        if (step < 0 || step > MAX_SCR_STEP) {
            // The new timeline continues after every timestamp seen so far, keeping all streams
            // aligned.
            this.rebase = Math.max(this.scr + this.rebase, this.maxMapped + 1) - scr;
            let dropped = 0;
            for (const stream of this.audio.values()) dropped += stream.audio.cut();
            this.diagnostics.note(
                'warn',
                'mpeg',
                'PS_TIMESTAMP_DISCONTINUITY',
                `MPEG-PS clock jumps by ${(step / 90000).toFixed(3)} s; the timeline continues`,
            );
        }
        this.scr = scr;
    }

    /**
     * Unwraps a 33-bit PES timestamp next to the clock reference and applies the discontinuity
     * shift.
     */
    private map(raw: number | undefined): number | undefined {
        if (raw === undefined) return undefined;
        const reference = this.scr ?? this.lastTimestamp;
        const unwrapped =
            reference === undefined
                ? raw
                : raw + Math.round((reference - raw) / PTS_WRAP) * PTS_WRAP;
        this.lastTimestamp = unwrapped;
        const mapped = unwrapped + this.rebase;
        if (mapped > this.maxMapped) this.maxMapped = mapped;
        return mapped;
    }

    /** Reads one packet; false when its PES header is malformed. */
    private packet(id: number, pos: number, end: number): boolean {
        if (id === STREAM_MAP) {
            this.streamMap(pos, end);
            return true;
        }

        if (id !== PRIVATE_1 && (id < 0xc0 || id > 0xef)) return true;
        const header = parsePesHeader(this.window, pos - this.windowStart, end - this.windowStart);
        if (!header) {
            this.diagnostics.note(
                'recover',
                'mpeg',
                'PS_MALFORMED_PES',
                `Discarded a malformed PES packet of stream 0x${id.toString(16)}`,
                { offset: pos },
            );
            const video = this.video.get(id);
            if (video) video.lost = true;
            return false;
        }

        const payload = this.window.subarray(header.start, end - this.windowStart);
        if (payload.length === 0) return true;

        const pts = this.map(header.pts);
        const dts = this.map(header.dts);
        if (id >= 0xe0) this.videoPayload(id, payload, pts, dts);
        else if (id >= 0xc0) {
            const type = this.streamTypes.get(id);
            const parser =
                type === 0x0f
                    ? adtsFrame
                    : type === 0x03 || type === 0x04
                      ? mpegAudioFrame
                      : undefined;
            this.framedAudio(id, parser)?.push(payload, pts);
        } else this.privatePayload(payload, pts);
        return true;
    }

    private streamMap(pos: number, end: number): void {
        const bytes = this.window;
        const limit = end - this.windowStart - 4;
        let p = pos - this.windowStart + 6;
        if (p + 4 > limit) return;
        p += 4 + ((bytes[p + 2]! << 8) | bytes[p + 3]!);
        if (p + 2 > limit) return;
        const mapEnd = Math.min(limit, p + 2 + ((bytes[p]! << 8) | bytes[p + 1]!));
        for (p += 2; p + 4 <= mapEnd; p += 4 + ((bytes[p + 2]! << 8) | bytes[p + 3]!))
            this.streamTypes.set(bytes[p + 1]!, bytes[p]!);
    }

    private reject(key: number, description: string): void {
        if (this.unsupported.has(key)) return;
        this.unsupported.set(key, description);
        this.diagnostics.note(
            'warn',
            'mpeg',
            'PS_UNSUPPORTED_STREAM',
            `MPEG-PS ${description} is not supported; the stream is omitted`,
        );
    }

    private videoUnits(stream: VideoStream): MpegVideoAccessUnits {
        const units = new MpegVideoAccessUnits(
            stream.kind === 'mpeg4' ? 'mpeg4' : 'mpeg12',
            message => {
                stream.incomplete = true;
                this.diagnostics.note('recover', 'mpeg', 'PS_VIDEO_FRAME_DAMAGED', message);
            },
        );
        for (const part of stream.pending) units.push(part);
        stream.pending = [];
        stream.pendingBytes = 0;
        return units;
    }

    private videoPayload(id: number, payload: Uint8Array, pts?: number, dts?: number): void {
        let stream = this.video.get(id);
        if (!stream) {
            if (this.video.size + this.audio.size >= DEMUX_LIMITS.maxTracks) return;
            const type = this.streamTypes.get(id);
            const kind = type === undefined ? null : (VIDEO_STREAM_TYPES[type] ?? null);
            stream = { order: this.order++, id, kind, pending: [], pendingBytes: 0, lost: false };
            this.video.set(id, stream);
        }

        if (stream.units) {
            stream.units.push({ data: payload, pts, dts, discontinuity: stream.lost });
            stream.lost = false;
            return;
        }

        if (stream.annexB) {
            this.budget.reserveBytes(payload.length, 'MPEG-PS video payload');
            stream.annexB.push({ data: payload.slice(), pts, dts });
            return;
        }

        if (stream.kind === 'other')
            return this.reject(id, `AVS or VC-1 video stream 0x${id.toString(16)}`);
        stream.pending.push({ data: payload.slice(), pts, dts });
        stream.pendingBytes += payload.length;
        stream.kind ??=
            sniffVideoSyntax(payload) ?? (stream.pendingBytes >= MAX_SNIFF_BYTES ? 'mpeg12' : null);

        if (stream.kind === 'mpeg12' || stream.kind === 'mpeg4') {
            stream.units = this.videoUnits(stream);
            stream.lost = false;
        } else if (stream.kind === 'h264' || stream.kind === 'hevc') {
            stream.annexB = stream.pending;
            stream.pending = [];
            stream.pendingBytes = 0;
        } else if (stream.kind !== null) {
            stream.pending = [];
            stream.pendingBytes = 0;
            this.videoPayload(id, payload, pts, dts);
        }
    }

    private framedAudio(
        key: number,
        parser: AudioFrameParser | undefined,
    ): FramedAudio | undefined {
        const existing = this.audio.get(key)?.audio;
        if (existing) return existing instanceof FramedAudio ? existing : undefined;
        if (this.video.size + this.audio.size >= DEMUX_LIMITS.maxTracks) return undefined;
        const audio = new FramedAudio(parser, this.budget, message =>
            this.diagnostics.note('recover', 'mpeg', 'PS_AUDIO_DAMAGED', message),
        );
        this.audio.set(key, { order: this.order++, audio });
        return audio;
    }

    private lpcmAudio(key: number): LpcmAudio | undefined {
        const existing = this.audio.get(key)?.audio;
        if (existing) return existing instanceof LpcmAudio ? existing : undefined;
        if (this.video.size + this.audio.size >= DEMUX_LIMITS.maxTracks) return undefined;
        const audio = new LpcmAudio(this.budget, message =>
            this.diagnostics.note('recover', 'mpeg', 'PS_AUDIO_DAMAGED', message),
        );
        this.audio.set(key, { order: this.order++, audio });
        return audio;
    }

    /**
     * Private stream 1: DVD substreams carry a one-byte id and, for audio, a frame count and first
     * access unit pointer; LPCM adds three header bytes. A payload starting with the AC-3 sync word
     * is raw AC-3.
     */
    private privatePayload(payload: Uint8Array, pts?: number): void {
        const substream = payload[0]!;
        const key = (PRIVATE_1 << 8) | substream;
        if (substream === 0x0b && payload[1] === 0x77)
            this.framedAudio((PRIVATE_1 << 8) | 0x80, dolbyFrame)?.push(payload, pts);
        else if (substream >= 0x20 && substream <= 0x3f) return;
        else if (
            (substream >= 0x80 && substream <= 0x87) ||
            (substream >= 0xc0 && substream <= 0xcf)
        ) {
            if (payload.length > 4)
                this.framedAudio(key, dolbyFrame)?.push(payload.subarray(4), pts);
        } else if (
            (substream >= 0x88 && substream <= 0x8f) ||
            (substream >= 0x98 && substream <= 0x9f)
        ) {
            if (payload.length > 4) this.framedAudio(key, dtsFrame)?.push(payload.subarray(4), pts);
        } else if (substream >= 0xa0 && substream <= 0xaf) {
            if (payload.length > 7)
                this.lpcmAudio(key)?.push(
                    payload[5]!,
                    payload.subarray(7),
                    pts,
                    (payload[2]! << 8) | payload[3]!,
                );
        } else this.reject(key, `private stream 1 substream 0x${substream.toString(16)}`);
    }

    /**
     * H.264/H.265 access units split from the stream's payloads. A PES timestamp belongs to the
     * first access unit starting in that PES; units without one continue the previous decode time
     * at the stream's usual step.
     */
    private annexBTrack(stream: VideoStream, unusable: string[]): TrackInfo | null {
        const codec = stream.kind === 'hevc' ? 'hevc' : 'h264';
        const pieces = stream.annexB!;
        const data = new Uint8Array(pieces.reduce((total, piece) => total + piece.data.length, 0));
        const bounds: number[] = [];
        let offset = 0;
        for (const piece of pieces) {
            data.set(piece.data, offset);
            bounds.push(offset);
            offset += piece.data.length;
        }
        stream.annexB = [];
        const starts = annexBAccessUnitStarts(data, codec);
        const units: { data: Uint8Array; pts?: number; dts?: number }[] = [];
        let piece = 0;
        let used = -1;
        starts.forEach((start, index) => {
            while (piece + 1 < bounds.length && bounds[piece + 1]! <= start) piece++;
            const timed = piece !== used && pieces[piece]!.pts !== undefined;
            if (timed) used = piece;
            units.push({
                data: data.subarray(start, starts[index + 1] ?? data.length),
                pts: timed ? pieces[piece]!.pts : undefined,
                dts: timed ? (pieces[piece]!.dts ?? pieces[piece]!.pts) : undefined,
            });
        });
        const first = units.findIndex(unit => unit.dts !== undefined);
        if (first < 0) {
            unusable.push(`MPEG-PS video stream 0x${stream.id.toString(16)} carries no timestamps`);
            return null;
        }
        const steps: number[] = [];
        for (let index = first + 1, last = first; index < units.length; index++) {
            if (units[index]!.dts === undefined) continue;
            const step = (units[index]!.dts! - units[last]!.dts!) / (index - last);
            if (step > 0) steps.push(step);
            last = index;
        }
        steps.sort((left, right) => left - right);
        const step = steps.length ? steps[steps.length >> 1]! : 3003;

        // Data before the first timed unit continues a picture that started before the input.
        const timedUnits: { data: Uint8Array; pts: number; dts: number }[] = [];
        for (const unit of units.slice(first)) {
            const previous = timedUnits[timedUnits.length - 1];
            const dts = unit.dts ?? previous!.dts + step;
            timedUnits.push({ data: unit.data, dts, pts: unit.pts ?? dts });
        }
        try {
            return annexBVideoTrack(codec, timedUnits, this.budget);
        } catch (error) {
            if (!(error instanceof DemuxError)) throw error;
            unusable.push(`MPEG-PS video stream 0x${stream.id.toString(16)}: ${error.message}`);
            return null;
        }
    }

    private finish(): DemuxResult {
        const result: DemuxResult = { videoTracks: [], audioTracks: [] };
        const cut = this.cutStream;
        const video = cut === undefined ? undefined : this.video.get(cut);
        if (video) video.incomplete = true;
        for (const [key, stream] of [...this.audio].sort((a, b) => a[1].order - b[1].order)) {
            const track = stream.audio.track();
            if (!track) continue;
            if (cut !== undefined && (key === cut || key >> 8 === cut)) track.incomplete = true;
            if (stream.audio instanceof FramedAudio) track.codecConfig = stream.audio.codecConfig;
            result.audioTracks.push(track);
        }
        const unusable: string[] = [];
        for (const stream of [...this.video.values()].sort((a, b) => a.order - b.order)) {
            if (stream.annexB) {
                const track = this.annexBTrack(stream, unusable);
                if (track) result.videoTracks.push(track);
                continue;
            }
            if (!stream.units && stream.pending.length) {
                stream.kind = 'mpeg12';
                stream.units = this.videoUnits(stream);
            }
            if (!stream.units) continue;
            stream.units.end();
            if (!stream.units.frames.length) {
                this.reject(
                    stream.id,
                    `video stream 0x${stream.id.toString(16)} without MPEG-1/2 or MPEG-4 Part 2 ` +
                        `pictures`,
                );
                continue;
            }
            const track = buildMpegVideoTrack(
                stream.kind === 'mpeg4' ? 'mpeg4' : 'mpeg12',
                stream.units.frames,
                this.budget,
                `MPEG-PS video stream 0x${stream.id.toString(16)}`,
                message => unusable.push(message),
            );
            if (track && stream.incomplete) track.incomplete = true;
            if (track) result.videoTracks.push(track);
        }
        if (result.videoTracks.length + result.audioTracks.length === 0)
            throw new DemuxError(
                unusable[0] ??
                    'MPEG program stream holds no supported video or audio stream' +
                        (this.unsupported.size
                            ? ` (unsupported: ${[...this.unsupported.values()].join('; ')})`
                            : ''),
            );
        for (const message of unusable)
            this.diagnostics.note(
                'recover',
                'mpeg',
                'PS_VIDEO_UNUSABLE',
                `${message}; the stream is omitted`,
            );
        const tracks = [...result.videoTracks, ...result.audioTracks];
        const start = Math.min(...tracks.map(track => track.samples[0]?.timestamp ?? Infinity));

        // The program lasts until the latest presented sample ends; reordered pictures can end
        // after the last one.
        const end = (track: TrackInfo): number =>
            track.samples.reduce(
                (latest, sample) => Math.max(latest, sample.timestamp + sample.duration),
                track.duration,
            );
        const duration = Math.max(
            0,
            ...tracks.map(track => end(track) - (Number.isFinite(start) ? start : 0)),
        );
        for (const track of tracks) track.duration = duration;
        return result;
    }
}

/**
 * MPEG program stream demuxer (MPEG-1 system streams, MPEG-2 PS, DVD VOB) with SCR discontinuity
 * handling.
 */
export class PsDemuxer {
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private readonly limits: ResolvedDemuxBudget;

    constructor(options: DemuxBudgetOptions = {}) {
        this.limits = resolveDemuxBudget(options, 2_000_000);
    }

    /**
     * Parses the whole stream with windowed reads; payloads are copied into the returned samples;
     * honors `signal`.
     */
    async demux(
        input: File | Blob | Source,
        signal?: AbortSignal,
        diagnostics = new DiagnosticContext(),
    ): Promise<DemuxResult> {
        const source = input instanceof Blob ? new BlobSource(input) : input;
        return new ProgramStream(
            new ChunkReader(source),
            new DemuxIndexBudget(this.limits),
            diagnostics,
            signal,
        ).read();
    }
}

/** The mpegPs plugin's 'mpeg-ps' reader, which its index loads on first use. */
export const mpegPsReader: Reader = {
    read: (source, options) =>
        new PsDemuxer(options).demux(source, options.signal, readerDiagnostics(options)),
    capabilities: HANDS_OVER,
};
