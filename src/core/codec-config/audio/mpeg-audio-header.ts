import { u32be, u32le } from '../../bytes/byte-fields';

type MpegAudioInputFormat = 'mp1' | 'mp2' | 'mp3';

interface ParsedMpegAudioHeader {
    readonly format: MpegAudioInputFormat;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitrateKbps: number;
    readonly frameLength: number;
    readonly samplesPerFrame: number;
}

/** Sample rates by version bits (MPEG-1 3, MPEG-2 2, MPEG-2.5 0) and rate index. */
export const MPEG_SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = {
    0: [11025, 12000, 8000],
    2: [22050, 24000, 16000],
    3: [44100, 48000, 32000],
};

/** Bitrates in kbps by header index (ISO/IEC 11172-3 2.4.2.3, ISO/IEC 13818-3 2.4.2.3). */
export const MPEG1_LAYER2_BITRATES: readonly number[] = [
    0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
];
const MPEG1_LAYER1_BITRATES = [
    0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0,
] as const;
const MPEG2_LAYER1_BITRATES = [
    0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
] as const;
export const MPEG1_LAYER3_BITRATES: readonly number[] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
export const MPEG2_LAYER23_BITRATES: readonly number[] = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

/** Parses the four-byte MPEG audio header without reading beyond `data`. */
export function parseMpegAudioHeader(
    data: Uint8Array,
    offset: number,
): ParsedMpegAudioHeader | null {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > data.length) return null;
    if (data[offset] !== 0xff || (data[offset + 1]! & 0xe0) !== 0xe0) return null;

    const versionBits = (data[offset + 1]! >> 3) & 0x03;
    const layerBits = (data[offset + 1]! >> 1) & 0x03;
    const bitrateIndex = (data[offset + 2]! >> 4) & 0x0f;
    const sampleRateIndex = (data[offset + 2]! >> 2) & 0x03;
    const padding = (data[offset + 2]! >> 1) & 0x01;
    const mode = (data[offset + 3]! >> 6) & 0x03;
    if (versionBits === 1 || sampleRateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15)
        return null;

    const format: MpegAudioInputFormat | null =
        layerBits === 1 ? 'mp3' : layerBits === 2 ? 'mp2' : layerBits === 3 ? 'mp1' : null;
    if (!format) return null;

    const sampleRate = MPEG_SAMPLE_RATES[versionBits]?.[sampleRateIndex];
    if (!sampleRate) return null;
    const bitrateKbps =
        format === 'mp1'
            ? versionBits === 3
                ? MPEG1_LAYER1_BITRATES[bitrateIndex]
                : MPEG2_LAYER1_BITRATES[bitrateIndex]
            : format === 'mp2'
              ? versionBits === 3
                  ? MPEG1_LAYER2_BITRATES[bitrateIndex]
                  : MPEG2_LAYER23_BITRATES[bitrateIndex]
              : versionBits === 3
                ? MPEG1_LAYER3_BITRATES[bitrateIndex]
                : MPEG2_LAYER23_BITRATES[bitrateIndex];
    if (!bitrateKbps) return null;

    const samplesPerFrame =
        format === 'mp1' ? 384 : format === 'mp2' || versionBits === 3 ? 1152 : 576;
    const frameLength =
        format === 'mp1'
            ? (Math.floor((12000 * bitrateKbps) / sampleRate) + padding) * 4
            : format === 'mp2'
              ? Math.floor((144000 * bitrateKbps) / sampleRate) + padding
              : Math.floor(((versionBits === 3 ? 144000 : 72000) * bitrateKbps) / sampleRate) +
                padding;
    if (!Number.isFinite(frameLength) || frameLength < 24) return null;
    return {
        format,
        sampleRate,
        channels: mode === 3 ? 1 : 2,
        bitrateKbps,
        frameLength,
        samplesPerFrame,
    };
}

/**
 * Legal MPEG-1 Layer II/III bitrates in kbps for the channel count; Layer II pairs low rates with
 * mono only.
 */
export function mpegBitrates(format: 'mp2' | 'mp3', channels: number): readonly number[] {
    if (format === 'mp3') return MPEG1_LAYER3_BITRATES.slice(1, 15);
    return MPEG1_LAYER2_BITRATES.slice(1, 15).filter(rate =>
        channels === 1 ? rate <= 192 : rate >= 64,
    );
}

/**
 * Layer III decoders add this to the LAME encoder delay; it is the synthesis filterbank latency.
 */
export const MP3_DECODER_DELAY = 529;

/** The delay the library's MP3 encoder writes in its LAME tag. */
export const MP3_ENCODER_DELAY = 528;

export interface MpegGaplessInfo {
    /** Audio frames after the information frame. */
    readonly frames?: number;
    /** Bytes of the stream from the information frame on. */
    readonly bytes?: number;
    readonly encoderDelay?: number;
    readonly padding?: number;
}

/**
 * Reads an information frame, which carries no audio: a Xing/Info frame (the magic follows the side
 * information, and a LAME-style extension after the optional fields states the encoder delay and
 * padding) or a Fraunhofer VBRI frame (version 1 magic always 32 bytes after the header; its delay
 * field is not a gapless trim).
 */
export function parseMpegGaplessInfo(frame: Uint8Array): MpegGaplessInfo | null {
    if (frame.length < 4 || frame[0] !== 0xff || (frame[1]! & 0xe6) !== 0xe2) return null;
    if (
        frame.length >= 54 &&
        String.fromCharCode(frame[36]!, frame[37]!, frame[38]!, frame[39]!) === 'VBRI' &&
        frame[40] === 0 &&
        frame[41] === 1 &&
        frame.subarray(46, 54).some(byte => byte !== 0)
    )
        return { frames: u32be(frame, 50), bytes: u32be(frame, 46) };

    const mpeg1 = ((frame[1]! >> 3) & 0x03) === 3;
    const mono = ((frame[3]! >> 6) & 0x03) === 3;
    const crc = (frame[1]! & 0x01) === 0 ? 2 : 0;
    const at = 4 + crc + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17);
    if (at + 8 > frame.length) return null;
    const magic = String.fromCharCode(frame[at]!, frame[at + 1]!, frame[at + 2]!, frame[at + 3]!);
    if (magic !== 'Xing' && magic !== 'Info') return null;

    const flags = frame[at + 7]!;
    let cursor = at + 8;
    let frames: number | undefined;
    let bytes: number | undefined;
    if (flags & 1) {
        frames = u32be(frame, cursor);
        cursor += 4;
    }
    if (flags & 2) {
        bytes = u32be(frame, cursor);
        cursor += 4;
    }
    if (flags & 4) cursor += 100;
    if (flags & 8) cursor += 4;

    const encoder = frame.subarray(cursor, cursor + 9);
    if (cursor + 24 > frame.length || encoder.every(byte => byte === 0)) return { frames, bytes };
    const encoderDelay = (frame[cursor + 21]! << 4) | (frame[cursor + 22]! >> 4);
    const padding = ((frame[cursor + 22]! & 0x0f) << 8) | frame[cursor + 23]!;
    return { frames, bytes, encoderDelay, padding };
}

/**
 * Whether `data` starts a metadata trailer that ends the audio: an ID3v1 tag in the last 128 bytes,
 * an appended ID3v2 tag, or an APEv2 tag with its header, optionally followed by ID3v1.
 */
export function isMpegAudioTrailerHeader(data: Uint8Array, remainingBytes: number): boolean {
    if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0) return false;
    if (
        remainingBytes === 128 &&
        data.length >= 3 &&
        data[0] === 0x54 &&
        data[1] === 0x41 &&
        data[2] === 0x47
    )
        return true;
    if (data.length >= 32 && String.fromCharCode(...data.subarray(0, 8)) === 'APETAGEX') {
        const size = u32le(data, 12);
        const isHeader = (data[23]! & 0xa0) === 0xa0;
        return isHeader && (size + 32 === remainingBytes || size + 32 + 128 === remainingBytes);
    }
    if (
        data.length < 10 ||
        data[0] !== 0x49 ||
        data[1] !== 0x44 ||
        data[2] !== 0x33 ||
        data[3]! < 2 ||
        data[3]! > 4 ||
        data[4] === 0xff
    )
        return false;
    for (let index = 6; index < 10; index++) {
        if ((data[index]! & 0x80) !== 0) return false;
    }

    const size = (data[6]! << 21) | (data[7]! << 14) | (data[8]! << 7) | data[9]!;
    const footer = data[3] === 4 && (data[5]! & 0x10) !== 0 ? 10 : 0;
    return 10 + size + footer === remainingBytes;
}
