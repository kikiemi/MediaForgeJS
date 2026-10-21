import type { ByteReader } from '../../core/io/sources/chunk-reader';
import { DEMUX_LIMITS } from '../shared/demux-budget';
import { yieldEventLoop } from '../../core/io/event-loop';
import { parseMpegAudioHeader } from '../../core/codec-config/audio/mpeg-audio-header';
import { parseAdtsFrameHeader } from '../../core/codec-config/audio/adts';
import { loasFrameLength } from './latm';
import { parseDolbyFrameHeader } from '../../core/codec-config/audio/dolby-audio-header';
import { parseDtsFrame } from '../../core/codec-config/audio/dts-header';
import { concatBytes } from '../../core/bytes/bytes';

export const TS_PACKET = 188;

/**
 * Private PES (0x06) with an AV01 registration descriptor, per the AV1 MPEG-2 TS carriage
 * specification.
 */
export const STREAM_TYPE_AV1 = 0x106;

/**
 * The format identifier of a registration descriptor (tag 5) among elementary stream descriptors.
 */
export function registrationOf(descriptors: Uint8Array): string | undefined {
    for (let offset = 0; offset + 2 <= descriptors.length; offset += 2 + descriptors[offset + 1]!) {
        if (descriptors[offset] === 5 && descriptors[offset + 1]! >= 4)
            return String.fromCharCode(
                descriptors[offset + 2]!,
                descriptors[offset + 3]!,
                descriptors[offset + 4]!,
                descriptors[offset + 5]!,
            );
    }
    return undefined;
}

// Descriptors that say nothing about a private stream's content: ISO 639 language (0x0a) and DVB
// stream identifier (0x52).
export function describesNoContent(descriptors: Uint8Array): boolean {
    for (let offset = 0; offset + 2 <= descriptors.length; offset += 2 + descriptors[offset + 1]!)
        if (descriptors[offset] !== 0x0a && descriptors[offset] !== 0x52) return false;
    return true;
}

/**
 * Longest audio frame header the resynchronization keeps across PES packets (a DTS core header).
 */
export const AUDIO_HEADER_BYTES = 16;

/** MPEG-4 AAC in LOAS/LATM transport syntax (ISO/IEC 13818-1 stream type 0x11). */
export const STREAM_TYPE_LATM = 0x11;

/** Blu-ray LPCM (HDMV stream type 0x80), kept apart from other private uses of 0x80. */
export const STREAM_TYPE_BLURAY_LPCM = 0x180;

/** Internal stream type of Opus (registration 'Opus'), outside the one-byte stream_type range. */
export const OPUS_STREAM = 0x100;

/**
 * Opus access unit in MPEG-TS at `offset`: an 11-bit 0x3ff prefix, start/end trim and extension
 * flags, the unit size as a run of 0xff bytes plus a final byte, then the optional trims and
 * extension before the packet.
 */
export function opusUnit(
    data: Uint8Array,
    offset: number,
): { start: number; size: number; trim?: number } | null {
    if (offset + 3 > data.length || data[offset] !== 0x7f || (data[offset + 1]! & 0xe0) !== 0xe0)
        return null;
    const flags = data[offset + 1]!;
    let cursor = offset + 2;
    let size = 0;
    while (cursor < data.length && data[cursor] === 0xff) size += data[cursor++]!;
    if (cursor >= data.length) return null;
    size += data[cursor++]!;
    let trim: number | undefined;
    if (flags & 0x10) {
        if (cursor + 2 <= data.length) trim = (data[cursor]! << 8) | data[cursor + 1]!;
        cursor += 2;
    }
    if (flags & 0x08) cursor += 2;
    if (flags & 0x04) cursor += 1 + (data[cursor] ?? 0);
    return size > 0 ? { start: cursor, size, trim } : null;
}

export function audioFrameLength(streamType: number, data: Uint8Array, offset: number): number {
    if (streamType === 0x0f) return parseAdtsFrameHeader(data, offset)?.frameLength ?? 0;
    if (streamType === STREAM_TYPE_LATM) return loasFrameLength(data, offset);
    if (streamType === 0x81 || streamType === 0x87)
        return parseDolbyFrameHeader(data, offset)?.frameBytes ?? 0;
    if (streamType === 0x82) return parseDtsFrame(data, offset)?.frameBytes ?? 0;
    if (streamType === STREAM_TYPE_BLURAY_LPCM) {
        const header = blurayLpcmHeader(data, offset);
        return header ? 4 + header.bytes : 0;
    }
    if (streamType === OPUS_STREAM) {
        const unit = opusUnit(data, offset);
        return unit ? unit.start + unit.size - offset : 0;
    }
    return parseMpegAudioHeader(data, offset)?.frameLength ?? 0;
}

/**
 * First offset from `from` holding a frame header whose frame is followed by a header of the same
 * stream, or ends too close to the end of the data to check; the length of the data when there is
 * none.
 */
export function audioFrameStart(streamType: number, data: Uint8Array, from: number): number {
    for (let offset = from; offset < data.length; offset++) {
        const length = audioFrameLength(streamType, data, offset);
        if (length <= 0) continue;
        const next = offset + length;
        if (
            next + AUDIO_HEADER_BYTES > data.length ||
            continuesAudio(streamType, data, offset, next)
        )
            return offset;
    }
    return data.length;
}

/**
 * Whether a frame header at `next` continues the frame at `offset`: MPEG audio of the same version,
 * layer and rate, ADTS of the same object type and rate, AC-3 of the same rate. Sync words inside
 * frame data (a stream cut mid-frame) rarely chain to a header of the same shape, so a lone match
 * there is not taken for the stream's framing.
 */
function continuesAudio(
    streamType: number,
    data: Uint8Array,
    offset: number,
    next: number,
): boolean {
    if (audioFrameLength(streamType, data, next) <= 0) return false;
    if (streamType === 0x0f) {
        const [left, right] = [
            parseAdtsFrameHeader(data, offset)!,
            parseAdtsFrameHeader(data, next)!,
        ];
        return (
            left.sampleRate === right.sampleRate && left.audioObjectType === right.audioObjectType
        );
    }

    if (streamType === 0x81 || streamType === 0x87)
        return (
            parseDolbyFrameHeader(data, offset)!.sampleRate ===
            parseDolbyFrameHeader(data, next)!.sampleRate
        );
    if (streamType === 0x03 || streamType === 0x04) {
        const [left, right] = [
            parseMpegAudioHeader(data, offset)!,
            parseMpegAudioHeader(data, next)!,
        ];
        return left.format === right.format && left.sampleRate === right.sampleRate;
    }

    return true;
}

/**
 * A frame of `length` bytes at the payload start is confirmed by the next header or by ending the
 * payload.
 */
function confirmedFrame(
    data: Uint8Array,
    length: number | undefined,
    next: (at: number) => unknown,
): boolean {
    return length !== undefined && length > 0 && (length >= data.length || !!next(length));
}

/**
 * Elementary stream type implied by a private PES payload: ADTS AAC, AC-3/E-AC-3, DTS or MPEG audio
 * whose first header the following one confirms, so other payloads (FLAC, PCM, video) are never
 * labelled as audio they are not.
 */
export function sniffAudioStreamType(data: Uint8Array): number {
    const adts = parseAdtsFrameHeader(data, 0);
    if (
        adts &&
        adts.channels > 0 &&
        confirmedFrame(data, adts.frameLength, at => parseAdtsFrameHeader(data, at))
    )
        return 0x0f;
    const dolby = parseDolbyFrameHeader(data, 0);
    if (dolby && confirmedFrame(data, dolby.frameBytes, at => parseDolbyFrameHeader(data, at)))
        return dolby.codec === 'ac-3' ? 0x81 : 0x87;
    const dts = parseDtsFrame(data, 0);
    if (dts && confirmedFrame(data, dts.frameBytes, at => parseDtsFrame(data, at))) return 0x82;
    const mpeg = parseMpegAudioHeader(data, 0);
    if (mpeg && confirmedFrame(data, mpeg.frameLength, at => parseMpegAudioHeader(data, at)))
        return mpeg.format === 'mp1' ? 0x03 : 0x04;
    return 0;
}

/** A payload holding a confirmed LOAS frame and no confirmed ADTS frame. */
export function isLoasPayload(data: Uint8Array): boolean {
    return (
        audioFrameStart(0x0f, data, 0) >= data.length &&
        audioFrameStart(STREAM_TYPE_LATM, data, 0) < data.length
    );
}

/** Declared stream types of audio this demuxer indexes, before descriptors and payload sniffing. */
export function declaredAudioStreamType(streamType: number, hdmv: boolean): number {
    if (
        streamType === 0x0f ||
        streamType === STREAM_TYPE_LATM ||
        streamType === 0x03 ||
        streamType === 0x04
    )
        return streamType;
    if (streamType === 0x81 || streamType === 0x87) return streamType;
    // ffmpeg also writes TrueHD as 0x83 outside Blu-ray; its access units are checked before a
    // track is formed.
    if (streamType === 0x83) return 0x83;
    if (!hdmv) return 0;
    if (streamType === 0x80) return STREAM_TYPE_BLURAY_LPCM;
    if (streamType === 0x82 || streamType === 0x85 || streamType === 0x86 || streamType === 0xa2)
        return 0x82;
    if (streamType === 0x84 || streamType === 0xa1) return 0x87;
    return 0;
}

/**
 * User-private stream types that carry DTS in DVB and ATSC multiplexes; their payload must confirm
 * it.
 */
export const DTS_CANDIDATE_TYPES = new Set([0x82, 0x8a]);

/**
 * Audio and video stream types this demuxer does not index, reported instead of dropped silently.
 */
export const UNSUPPORTED_STREAMS: ReadonlyMap<number, string> = new Map([
    [0x1c, 'MPEG-4 audio without transport syntax'],
    [0x21, 'JPEG 2000 video'],
    [0x2d, 'MPEG-H 3D audio'],
    [0x2e, 'MPEG-H 3D audio'],
    [0x42, 'AVS video'],
    [0xd1, 'Dirac video'],
]);

const OPUS_COUPLED_STREAMS = [1, 0, 1, 1, 2, 2, 2, 3, 3];
const OPUS_STREAMS = [1, 1, 1, 2, 2, 3, 4, 4, 5];
const OPUS_CHANNEL_MAPS = [
    [0],
    [0, 1],
    [0, 2, 1],
    [0, 1, 2, 3],
    [0, 4, 1, 2, 3],
    [0, 4, 1, 2, 3, 5],
    [0, 4, 1, 2, 3, 5, 6],
    [0, 6, 1, 2, 3, 4, 5, 7],
];

/**
 * OpusHead for an Opus stream in MPEG-TS: channel mapping family 1 above two channels, the first
 * trim as pre-skip.
 */
export function opusHead(channels: number, preSkip: number): Uint8Array {
    const mapped = channels > 2;
    const head = new Uint8Array(19 + (mapped ? 2 + channels : 0));
    head.set([
        0x4f,
        0x70,
        0x75,
        0x73,
        0x48,
        0x65,
        0x61,
        0x64,
        1,
        channels,
        preSkip & 255,
        preSkip >> 8,
    ]);
    new DataView(head.buffer).setUint32(12, 48000, true);
    if (mapped) {
        head[18] = 1;
        head[19] = OPUS_STREAMS[channels]!;
        head[20] = OPUS_COUPLED_STREAMS[channels]!;
        head.set(OPUS_CHANNEL_MAPS[channels - 1]!, 21);
    }

    return head;
}

/**
 * Channel count of an Opus stream from its DVB extension descriptor (tag 0x7f, extension 0x80); 2
 * when absent.
 */
export function opusChannels(descriptors: Uint8Array): number {
    for (let offset = 0; offset + 2 <= descriptors.length; offset += 2 + descriptors[offset + 1]!) {
        if (
            descriptors[offset] === 0x7f &&
            descriptors[offset + 1]! >= 2 &&
            descriptors[offset + 2] === 0x80
        ) {
            const code = descriptors[offset + 3]!;
            if (code >= 1 && code <= 8) return code;
            if (code === 0x81 || code === 0x82) return 2;
        }
    }
    return 2;
}

/**
 * Stream type of a video elementary stream from the start codes of its first bytes: MPEG-1/2 video
 * (a sequence header, or a run of consecutive slices), H.265 or H.264 parameter sets and
 * delimiters, or MPEG-4 Part 2 headers; 0 when the payload shows none of them.
 */
function sniffVideoStreamType(es: Uint8Array): number {
    let previous = -1;
    let slices = 0;
    let hevc = false;
    let h264 = false;
    let mpeg4 = false;

    for (let at = 0; at + 5 <= es.length; at++) {
        if (es[at] !== 0 || es[at + 1] !== 0 || es[at + 2] !== 1) continue;
        const code = es[at + 3]!;
        if (code === 0xb3) return 0x02;
        if (code >= 0x01 && code <= 0xaf && code === previous + 1) slices++;
        if ((code === 0x40 || code === 0x42 || code === 0x44 || code === 0x46) && es[at + 4] === 1)
            hevc = true;
        if (code === 0x09 || ((code & 0x9f) === 0x07 && (code & 0x60) !== 0)) h264 = true;
        if (
            code === 0xb0 ||
            code === 0xb6 ||
            (code >= 0x20 && code <= 0x2f && previous >= 0 && previous <= 0x1f)
        )
            mpeg4 = true;
        previous = code;
        at += 3;
    }

    if (slices >= 3) return 0x02;
    if (hevc) return 0x24;
    if (h264) return 0x1b;
    return mpeg4 ? 0x10 : 0;
}

/** Whether `es` holds two consecutive frames of `streamType` audio. */
function holdsAudioFrames(streamType: number, es: Uint8Array): boolean {
    for (let offset = 0; offset + AUDIO_HEADER_BYTES < es.length; offset++) {
        const length = audioFrameLength(streamType, es, offset);
        if (length > 0 && offset + length + AUDIO_HEADER_BYTES <= es.length)
            if (audioFrameLength(streamType, es, offset + length) > 0) return true;
    }
    return false;
}

/**
 * Stream type of an audio PES without a PMT entry: MPEG audio streams (ids 0xc0-0xdf) holding ADTS
 * or MPEG audio frames, private stream 1 holding AC-3; other private audio stays a sniffed private
 * stream (0x06).
 */
function orphanAudioStreamType(streamId: number, es: Uint8Array): number {
    if (streamId !== 0xbd) {
        if (holdsAudioFrames(0x0f, es)) return 0x0f;
        if (holdsAudioFrames(0x03, es)) return 0x03;
    } else if (holdsAudioFrames(0x81, es)) return 0x81;
    return 0x06;
}

/** PES bytes collected per PID to identify a stream without a PMT. */
const ORPHAN_PROBE_BYTES = 16384;

/** Input scanned for elementary streams when the PSI is missing. */
const ORPHAN_PROBE_LIMIT = 32 * 1024 * 1024;

/**
 * A PMT section (without CRC) declaring the elementary streams found in PES packets of a transport
 * stream whose PAT or PMT is missing: video by its first start code, and audio (stream ids
 * 0xc0-0xdf and private stream 1) as private streams identified later from their frame headers.
 * Null when no stream is found.
 */
export async function orphanStreamsSection(
    reader: ByteReader,
    syncOff: number,
    size: number,
    stride: number,
    payOff: number,
    checkAbort: () => void,
): Promise<Uint8Array | null> {
    const pending = new Map<number, { streamId: number; bytes: Uint8Array[]; length: number }>();
    const found = new Map<number, number>();
    const end = Math.min(size, syncOff + ORPHAN_PROBE_LIMIT);
    let windowStart = 0;
    let window: Uint8Array = new Uint8Array(0);

    const identify = (pid: number, streamId: number, bytes: Uint8Array[]): void => {
        const pes = concatBytes(bytes);
        const es = pes.subarray(Math.min(pes.length, 9 + (pes[8] ?? 0)));
        const type =
            streamId >= 0xe0 && streamId <= 0xef
                ? sniffVideoStreamType(es)
                : orphanAudioStreamType(streamId, es);
        if (type) found.set(pid, type);
    };

    for (let pos = syncOff, scanned = 0; pos + stride <= end; pos += stride, scanned++) {
        if ((scanned & 0x0fff) === 0) {
            await yieldEventLoop();
            checkAbort();
        }
        if (pos + stride > windowStart + window.length) {
            windowStart = pos;
            window = await reader.bytes(pos, Math.min(stride * 1024, size - pos));
        }

        const packet = window.subarray(
            pos - windowStart + payOff,
            pos - windowStart + payOff + TS_PACKET,
        );
        if (packet[0] !== 0x47 || (packet[1]! & 0x80) !== 0 || (packet[3]! & 0xc0) !== 0) continue;
        const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
        if (pid < 0x20 || pid === 0x1fff || found.has(pid)) continue;

        const control = (packet[3]! >> 4) & 3;
        const start = (control & 2) !== 0 ? 5 + packet[4]! : 4;
        if ((control & 1) === 0 || start >= TS_PACKET) continue;
        const payload = packet.subarray(start);

        let entry = pending.get(pid);
        if ((packet[1]! & 0x40) !== 0) {
            if (entry) identify(pid, entry.streamId, entry.bytes);
            const streamId = payload[3] ?? 0;
            const media = streamId === 0xbd || (streamId >= 0xc0 && streamId <= 0xef);
            if (
                found.has(pid) ||
                payload[0] !== 0 ||
                payload[1] !== 0 ||
                payload[2] !== 1 ||
                !media
            ) {
                pending.delete(pid);
                continue;
            }
            pending.set(pid, (entry = { streamId, bytes: [], length: 0 }));
        }

        if (!entry) continue;
        entry.bytes.push(payload.slice());
        entry.length += payload.length;
        if (entry.length >= ORPHAN_PROBE_BYTES) {
            identify(pid, entry.streamId, entry.bytes);
            pending.delete(pid);
        }
    }

    for (const [pid, entry] of pending)
        if (!found.has(pid)) identify(pid, entry.streamId, entry.bytes);
    if (!found.size) return null;
    const pids = [...found.keys()]
        .sort((left, right) => left - right)
        .slice(0, DEMUX_LIMITS.maxTracks);
    const section = new Uint8Array(12 + pids.length * 5 + 4);
    section.set([0x02, 0xb0, 0, 0, 1, 0xc1, 0, 0, 0xff, 0xff, 0xf0, 0]);
    pids.forEach((pid, index) =>
        section.set([found.get(pid)!, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0], 12 + index * 5),
    );
    return section;
}

/** Channels of each Blu-ray LPCM channel_assignment; 0 marks reserved values. */
const BLURAY_LPCM_CHANNELS = [0, 1, 0, 2, 3, 3, 4, 4, 5, 6, 7, 8] as const;

/**
 * The 4-byte header opening each Blu-ray LPCM PES payload: payload size, channel assignment,
 * sampling frequency and sample size (20-bit samples are stored in 24 bits); null for reserved
 * values.
 */
export function blurayLpcmHeader(
    data: Uint8Array,
    offset: number,
): { bytes: number; channels: number; sampleRate: number; bits: 16 | 24 } | null {
    if (offset + 4 > data.length) return null;
    const bytes = (data[offset]! << 8) | data[offset + 1]!;
    const channels = BLURAY_LPCM_CHANNELS[data[offset + 2]! >> 4] ?? 0;
    const sampleRate = [0, 48000, 0, 0, 96000, 192000][data[offset + 2]! & 15] ?? 0;
    const size = data[offset + 3]! >> 6;
    if (!bytes || !channels || !sampleRate || size === 0) return null;
    return { bytes, channels, sampleRate, bits: size === 1 ? 16 : 24 };
}
