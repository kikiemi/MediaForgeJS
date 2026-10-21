import { MediaForgeError } from '../../errors/errors';
import { copyOutputBytes, outputByteLength } from '../../bytes/output-data';
import { dataView } from '../../bytes/byte-fields';

export type WavePcmCodec =
    'pcm-u8' | 'pcm-s16le' | 'pcm-s24le' | 'pcm-s32le' | 'pcm-f32le' | 'pcm-f64le';

/** WAVE_FORMAT_ALAW (6) and WAVE_FORMAT_MULAW (7): one G.711 code byte per sample. */
export type WaveG711Codec = 'alaw' | 'ulaw';

export interface WaveFormat {
    readonly codec: WavePcmCodec | WaveG711Codec;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    readonly validBitsPerSample: number;
    readonly blockAlign: number;
    readonly float: boolean;
    readonly channelMask?: number;
    readonly codecConfig: Uint8Array;
}

export const MAX_WAVE_FORMAT_BYTES = 65553;

/**
 * Pseudo tag for the IEC 61937 E-AC-3 subformat GUID of WAVE_FORMAT_EXTENSIBLE, which has no 16-bit
 * tag.
 */
export const EAC3_WAVE_TAG = 0x10000;

/** Compressed WAVE format tags whose frames this library indexes, by codec string. */
const COMPRESSED_WAVE_CODECS: ReadonlyMap<number, string> = new Map([
    [0x0050, 'mp2'],
    [0x0055, 'mp3'],
    [0x00ff, 'mp4a.40.2'],
    [0x2000, 'ac-3'],
    [0x2001, 'dtsc'],
    [EAC3_WAVE_TAG, 'ec-3'],
]);

/**
 * The format tag of a WAVE fmt payload (at least 16 bytes), with WAVE_FORMAT_EXTENSIBLE resolved to
 * its subformat: a tag in the standard KSDATAFORMAT GUID base, or EAC3_WAVE_TAG for the E-AC-3
 * GUID. Unknown GUIDs stay 0xfffe.
 */
export function waveFormatTag(fmt: Uint8Array): number {
    const view = dataView(fmt);
    const tag = view.getUint16(0, true);
    if (tag !== 0xfffe || fmt.length < 40) return tag;
    const guid = [
        view.getUint32(24, true),
        view.getUint32(28, true),
        view.getUint32(32, true),
        view.getUint32(36, true),
    ];
    if (
        guid[1] === 0x00100000 &&
        guid[2] === 0xaa000080 &&
        guid[3] === 0x719b3800 &&
        guid[0]! <= 0xffff
    )
        return guid[0]!;
    if (
        guid[0] === 0xa7fb87af &&
        guid[1] === 0x42fb2d02 &&
        guid[2] === 0xcd05d4a4 &&
        guid[3] === 0xdd3b8493
    )
        return EAC3_WAVE_TAG;
    return tag;
}

/**
 * Codec string of a compressed WAVE format tag from waveFormatTag, or undefined when it is not
 * indexed.
 */
export function compressedWaveCodec(tag: number): string | undefined {
    return COMPRESSED_WAVE_CODECS.get(tag);
}

/** Printable name of a format tag for messages. */
export function waveTagName(tag: number): string {
    return tag === EAC3_WAVE_TAG
        ? 'E-AC-3 (IEC 61937 GUID)'
        : `0x${tag.toString(16).padStart(4, '0')}`;
}

function invalid(message: string): never {
    throw new MediaForgeError(message, 'FORMAT');
}

/**
 * WAVEFORMATEX of G.711: format tag 7 (u-law) or 6 (A-law), one byte per sample, no extension data.
 */
export function g711WaveFormat(
    codec: WaveG711Codec,
    sampleRate: number,
    channels: number,
): Uint8Array {
    const fmt = new Uint8Array(18);
    const view = new DataView(fmt.buffer);
    view.setUint16(0, codec === 'ulaw' ? 7 : 6, true);
    view.setUint16(2, channels, true);
    view.setUint32(4, sampleRate, true);
    view.setUint32(8, sampleRate * channels, true);
    view.setUint16(12, channels, true);
    view.setUint16(14, 8, true);
    return fmt;
}

/**
 * Reads a WAVE fmt payload (PCM, IEEE float or G.711); extensible precision and speaker assignments
 * stay in codecConfig.
 */
export function parseWaveFormat(
    input: Uint8Array,
    /**
     * Receives a byte rate that disagrees with the rate and block alignment; without it that is an
     * error.
     */
    onWrongByteRate?: (declared: number, expected: number) => void,
): WaveFormat {
    const length = outputByteLength(input);
    if (length < 16 || length > MAX_WAVE_FORMAT_BYTES)
        return invalid('WAVE fmt size must be in 16..65553 bytes');
    const bytes = copyOutputBytes(input);
    const view = dataView(bytes);
    let tag = view.getUint16(0, true);
    const extensible = tag === 0xfffe;
    const channels = view.getUint16(2, true);
    const sampleRate = view.getUint32(4, true);
    const blockAlign = view.getUint16(12, true);
    const bits = view.getUint16(14, true);
    let validBits = bits;
    let channelMask: number | undefined;
    if (extensible) {
        if (
            length < 40 ||
            view.getUint16(16, true) < 22 ||
            view.getUint16(16, true) > length - 18 ||
            view.getUint32(28, true) !== 0x00100000 ||
            view.getUint32(32, true) !== 0xaa000080 ||
            view.getUint32(36, true) !== 0x719b3800
        )
            return invalid('Invalid WAVE extensible fmt or subformat GUID');
        tag = view.getUint32(24, true);

        // Writers that leave the valid-bits union zero mean the full container width, as ffmpeg
        // reads it.
        validBits = view.getUint16(18, true) || bits;
        channelMask = view.getUint32(20, true);
    } else if (tag === 3 && length !== 16 && (length < 18 || view.getUint16(16, true) !== 0)) {
        return invalid('IEEE-float WAVE fmt must have no format-specific extension');
    }
    const float = tag === 3;
    const g711 = tag === 6 || tag === 7;
    if (
        g711
            ? bits !== 8
            : (tag !== 1 && !float) ||
              (float ? ![32, 64].includes(bits) : ![8, 16, 24, 32].includes(bits))
    ) {
        return invalid('WAVE sample format is not supported');
    }

    // Integer tag 1 with 24 bits in 4-byte slots is Adobe Audition's 24.0 floating point, not
    // integer PCM.
    if (!extensible && tag === 1 && bits === 24 && blockAlign === channels * 4)
        return invalid('WAVE 24-bit float in 32-bit slots is not supported');
    if (validBits < 1 || validBits > bits || ((float || g711) && validBits !== bits))
        return invalid('Invalid WAVE valid bits per sample');
    if (channels < 1 || channels > 32) return invalid('WAVE must have 1 to 32 channels');
    if (sampleRate < 1 || sampleRate > 768000)
        return invalid('WAVE sample rate must be 1 to 768000 Hz');
    if (blockAlign !== channels * (bits / 8))
        return invalid('WAVE block alignment does not match its channels and depth');
    const byteRate = view.getUint32(8, true);
    if (byteRate !== sampleRate * blockAlign) {
        if (!onWrongByteRate)
            return invalid('WAVE byte rate disagrees with its rate and block alignment');
        onWrongByteRate(byteRate, sampleRate * blockAlign);
    }
    // The codec names the stored samples alone; precision and speaker layout stay in codecConfig.
    const codec: WaveFormat['codec'] = g711
        ? tag === 6
            ? 'alaw'
            : 'ulaw'
        : float
          ? bits === 32
              ? 'pcm-f32le'
              : 'pcm-f64le'
          : bits === 8
            ? 'pcm-u8'
            : bits === 16
              ? 'pcm-s16le'
              : bits === 24
                ? 'pcm-s24le'
                : 'pcm-s32le';
    const config = new Uint8Array(extensible ? 40 : float || g711 ? 18 : 16);
    config.set(bytes.subarray(0, config.length));

    // The byte rate is redundant with the rate and block alignment; a wrong one is replaced rather
    // than copied.
    new DataView(config.buffer).setUint32(8, sampleRate * blockAlign, true);
    if (config.length >= 18) new DataView(config.buffer).setUint16(16, extensible ? 22 : 0, true);
    if (extensible) new DataView(config.buffer).setUint16(18, validBits, true);
    return {
        codec,
        sampleRate,
        channels,
        bitsPerSample: bits,
        validBitsPerSample: validBits,
        blockAlign,
        float,
        channelMask,
        codecConfig: config,
    };
}

/** Builds a complete RIFF/RF64 prefix; callers append dataBytes and one zero pad byte if odd. */
export function createWaveCopyHeader(config: Uint8Array, dataBytes: number): Uint8Array {
    const format = parseWaveFormat(config);
    if (
        !Number.isSafeInteger(dataBytes) ||
        dataBytes < 0 ||
        dataBytes > Number.MAX_SAFE_INTEGER - 128 ||
        dataBytes % format.blockAlign !== 0
    )
        return invalid('WAVE data size must be whole frames');

    const frames = dataBytes / format.blockAlign;
    const fmt = format.codecConfig;
    const fact = format.float || format.codec === 'alaw' || format.codec === 'ulaw';
    const baseBytes = 12 + 8 + fmt.length + (fact ? 12 : 0) + 8;
    const padding = dataBytes & 1;
    const rf64 = baseBytes - 8 + dataBytes + padding > 0xffffffff;

    const header = new Uint8Array(baseBytes + (rf64 ? 36 : 0));
    const view = new DataView(header.buffer);

    const writeTag = (at: number, text: string): void => {
        for (let index = 0; index < 4; index++) header[at + index] = text.charCodeAt(index);
    };

    const riffSize = header.length - 8 + dataBytes + padding;
    writeTag(0, rf64 ? 'RF64' : 'RIFF');
    view.setUint32(4, rf64 ? 0xffffffff : riffSize, true);
    writeTag(8, 'WAVE');

    let offset = 12;
    if (rf64) {
        writeTag(offset, 'ds64');
        view.setUint32(offset + 4, 28, true);
        view.setBigUint64(offset + 8, BigInt(riffSize), true);
        view.setBigUint64(offset + 16, BigInt(dataBytes), true);
        view.setBigUint64(offset + 24, BigInt(frames), true);
        offset += 36;
    }

    writeTag(offset, 'fmt ');
    view.setUint32(offset + 4, fmt.length, true);
    header.set(fmt, offset + 8);
    offset += 8 + fmt.length;
    if (fact) {
        writeTag(offset, 'fact');
        view.setUint32(offset + 4, 4, true);
        view.setUint32(offset + 8, frames > 0xffffffff ? 0xffffffff : frames, true);
        offset += 12;
    }

    writeTag(offset, 'data');
    view.setUint32(offset + 4, rf64 ? 0xffffffff : dataBytes, true);
    return header;
}
