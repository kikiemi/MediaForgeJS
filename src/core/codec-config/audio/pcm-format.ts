import { MediaForgeError } from '../../errors/errors';
import {
    createWaveCopyHeader,
    g711WaveFormat,
    parseWaveFormat,
    type WavePcmCodec,
} from './wave-format';
import { copyOutputBytes, outputByteLength } from '../../bytes/output-data';
import { layoutMask } from '../../model/channel-layout';

export type PcmCodec =
    WavePcmCodec | 'pcm-s8' | 'pcm-s16be' | 'pcm-s24be' | 'pcm-s32be' | 'pcm-f32be' | 'pcm-f64be';

export type PcmCopyContainer = 'wav' | 'aiff' | 'au' | 'caf';

export interface PcmFormat {
    readonly codec: PcmCodec;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    readonly validBitsPerSample: number;
    readonly blockAlign: number;
    readonly float: boolean;
    readonly signed: boolean;
    readonly littleEndian: boolean;
    readonly channelMask?: number;
    readonly waveConfig?: Uint8Array;
}

interface PcmTrackShape {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly codecConfig?: Uint8Array;
}

function invalid(message: string, hint?: string): never {
    throw new MediaForgeError(message, 'FORMAT', hint ? { hint } : undefined);
}

/**
 * The stored samples of a PCM track: an explicit codec ID ('pcm-s16le', 'pcm-f32be', ...) names
 * them, as every reader of the library states them. 'pcm', the encoded coding's name, is taken as
 * 16-bit little-endian PCM in the default layout of a WAVE description and described as
 * 'pcm-s16le'.
 */
export function describePcmTrack(track: PcmTrackShape): PcmFormat {
    const { codec, sampleRate, channelCount: channels, codecConfig } = track;
    const shape =
        codec === 'pcm'
            ? ['s', '16', 'le']
            : /^pcm-(u|s|f)(8|16|24|32|64)(le|be)?$/.exec(codec)?.slice(1);
    if (!shape) return invalid('PCM copying requires an explicit supported PCM codec');
    const [kind, depth, order] = shape;
    const bits = Number(depth);
    const float = kind === 'f';

    if (
        (float ? ![32, 64].includes(bits) : ![8, 16, 24, 32].includes(bits)) ||
        (kind === 'u' && bits !== 8) ||
        (bits === 8 ? order !== undefined : !order)
    )
        return invalid('PCM samples must be 8 to 32-bit integers or 32/64-bit floats');
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 768000)
        return invalid('PCM sample rate must be 1 to 768000 Hz');
    if (!Number.isInteger(channels) || channels < 1 || channels > 32)
        return invalid('PCM must have 1 to 32 channels');

    const blockAlign = channels * (bits / 8);
    let validBits = bits;
    let channelMask: number | undefined;
    let waveConfig: Uint8Array | undefined;
    if (codecConfig !== undefined) {
        const wave = parseWaveFormat(codecConfig);
        if (
            order === 'be' ||
            (kind === 's' && bits === 8) ||
            wave.bitsPerSample !== bits ||
            wave.float !== float ||
            wave.sampleRate !== sampleRate ||
            wave.channels !== channels
        ) {
            return invalid('PCM track does not match its WAVE format chunk');
        }
        validBits = wave.validBitsPerSample;
        channelMask = wave.channelMask;
        waveConfig = wave.codecConfig;
        const otherLayout =
            channelMask !== undefined &&
            (channels > 2 || (channelMask !== 0 && channelMask !== (channels === 1 ? 4 : 3)));
        if (codec === 'pcm' && (validBits !== 16 || otherLayout)) {
            return invalid("'pcm' needs a 16-bit WAVE description in the default layout");
        }
    } else if (codec === 'pcm') return invalid("'pcm' needs a WAVE fmt description");
    return {
        codec: codec === 'pcm' ? 'pcm-s16le' : (codec as PcmCodec),
        sampleRate,
        channels,
        bitsPerSample: bits,
        validBitsPerSample: validBits,
        blockAlign,
        float,
        signed: kind !== 'u',
        littleEndian: order !== 'be',
        channelMask,
        waveConfig,
    };
}

/**
 * A written PCM track: copied PCM as described, and encoded 'pcm' (no WAVE description) as 16-bit
 * little-endian.
 */
export function describeWrittenPcm(track: PcmTrackShape): PcmFormat {
    const encoded = track.codec === 'pcm' && !track.codecConfig;
    return describePcmTrack(encoded ? { ...track, codec: 'pcm-s16le' } : track);
}

function waveDescription(format: PcmFormat): Uint8Array {
    if (format.waveConfig) return format.waveConfig;
    const bytes = new Uint8Array(format.float ? 18 : 16);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, format.float ? 3 : 1, true);
    view.setUint16(2, format.channels, true);
    view.setUint32(4, format.sampleRate, true);
    view.setUint32(8, format.sampleRate * format.blockAlign, true);
    view.setUint16(12, format.blockAlign, true);
    view.setUint16(14, format.bitsPerSample, true);
    return bytes;
}

function tag(data: Uint8Array, at: number, value: string): void {
    for (let index = 0; index < 4; index++) data[at + index] = value.charCodeAt(index);
}

/** AIFF COMM sample rate: an 80-bit IEEE 754 extended value of the integer rate. */
function writeExtendedRate(view: DataView, at: number, rate: number): void {
    const exponent = Math.floor(Math.log2(rate));
    view.setUint16(at, exponent + 16383);
    view.setBigUint64(at + 2, BigInt(rate) << BigInt(63 - exponent));
}

/**
 * Seek-free prefix of G.711 audio (one code byte per sample and channel) in WAV (format tag 7/6
 * with a fact chunk), AU (encoding 1/27), CAF ('ulaw'/'alaw') or AIFF-C ('ulaw'/'alaw'); callers
 * append dataBytes and the pad byte.
 */
export function createG711Header(
    container: PcmCopyContainer,
    codec: 'ulaw' | 'alaw',
    sampleRate: number,
    channels: number,
    dataBytes: number,
): { header: Uint8Array; padding: 0 | 1 } {
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 768000)
        return invalid('G.711 sample rate must be 1 to 768000 Hz');
    if (!Number.isInteger(channels) || channels < 1 || channels > 32)
        return invalid('G.711 must have 1 to 32 channels');
    if (
        !Number.isSafeInteger(dataBytes) ||
        dataBytes < 0 ||
        dataBytes > Number.MAX_SAFE_INTEGER - 128 ||
        dataBytes % channels !== 0
    )
        return invalid('G.711 data must be whole frames');

    const padding = ((container === 'wav' || container === 'aiff') && dataBytes & 1 ? 1 : 0) as
        0 | 1;
    if (container === 'wav')
        return {
            header: createWaveCopyHeader(g711WaveFormat(codec, sampleRate, channels), dataBytes),
            padding,
        };

    if (container === 'au') {
        const header = new Uint8Array(32);
        const view = new DataView(header.buffer);
        tag(header, 0, '.snd');
        view.setUint32(4, 32);
        view.setUint32(8, dataBytes < 0x80000000 ? dataBytes : 0xffffffff);
        view.setUint32(12, codec === 'ulaw' ? 1 : 27);
        view.setUint32(16, sampleRate);
        view.setUint32(20, channels);
        return { header, padding };
    }

    if (container === 'caf') {
        const header = new Uint8Array(68);
        const view = new DataView(header.buffer);
        tag(header, 0, 'caff');
        view.setUint16(4, 1);
        tag(header, 8, 'desc');
        view.setBigInt64(12, 32n);
        view.setFloat64(20, sampleRate);
        tag(header, 28, codec);
        view.setUint32(36, channels);
        view.setUint32(40, 1);
        view.setUint32(44, channels);
        view.setUint32(48, 8);
        tag(header, 52, 'data');
        view.setBigInt64(56, BigInt(dataBytes) + 4n);
        return { header, padding };
    }

    if (container !== 'aiff') return invalid('Unsupported G.711 output container');
    const name = codec === 'ulaw' ? '\u00b5Law 2:1' : 'ALaw 2:1';
    const nameBytes = 1 + name.length + ((1 + name.length) & 1);
    const header = new Uint8Array(12 + 12 + 8 + 22 + nameBytes + 16);
    const frames = dataBytes / channels;
    const formSize = header.length - 8 + dataBytes + padding;
    if (formSize > 0xffffffff || frames > 0xffffffff)
        return invalid('AIFF output exceeds its 32-bit FORM or frame-count fields');

    const view = new DataView(header.buffer);
    tag(header, 0, 'FORM');
    view.setUint32(4, formSize);
    tag(header, 8, 'AIFC');
    tag(header, 12, 'FVER');
    view.setUint32(16, 4);
    view.setUint32(20, 0xa2805140);
    tag(header, 24, 'COMM');
    view.setUint32(28, 22 + nameBytes);
    view.setUint16(32, channels);
    view.setUint32(34, frames);
    view.setUint16(38, 16);
    writeExtendedRate(view, 40, sampleRate);
    tag(header, 50, codec);
    header[54] = name.length;
    for (let index = 0; index < name.length; index++) header[55 + index] = name.charCodeAt(index);

    const ssnd = 54 + nameBytes;
    tag(header, ssnd, 'SSND');
    view.setUint32(ssnd + 4, dataBytes + 8);
    return { header, padding };
}

/**
 * CAF 'chan' bitmap (kCAFChannelLayoutTag_UseChannelBitmap uses the WAVE speaker bits); defaults by
 * channel count.
 */
function cafChannelBitmap(channels: number, mask: number | undefined): number {
    return layoutMask(channels, mask) ?? 0;
}

/** Builds a seek-free prefix and a byte-representation target without changing sample precision. */
export function createPcmCopyHeader(
    container: PcmCopyContainer,
    format: PcmFormat,
    dataBytes: number,
): {
    header: Uint8Array;
    target: PcmFormat;
    padding: 0 | 1;
} {
    if (!['wav', 'aiff', 'au', 'caf'].includes(container))
        return invalid('Unsupported PCM output container');
    if (
        !Number.isSafeInteger(dataBytes) ||
        dataBytes < 0 ||
        dataBytes > Number.MAX_SAFE_INTEGER - 128 ||
        dataBytes % format.blockAlign !== 0
    )
        return invalid('PCM output requires a safe size containing complete frames');

    const waveCopy = container === 'wav' && format.waveConfig !== undefined;
    const layout =
        format.channels > 2 ||
        (format.channelMask !== undefined &&
            format.channelMask !== 0 &&
            format.channelMask !== (format.channels === 1 ? 4 : 3));
    if (!waveCopy && format.validBitsPerSample !== format.bitsPerSample)
        return invalid(
            `PCM with padded samples cannot be copied into ${container}`,
            'Copy into WAV.',
        );
    if (!waveCopy && layout && container !== 'caf')
        return invalid(
            `${container} cannot keep more than two PCM channels or a speaker layout`,
            'Copy into WAV or CAF.',
        );

    const littleEndian = container === 'wav' || container === 'caf';
    const signed = format.bitsPerSample !== 8 || container !== 'wav';
    const sampleType = format.float ? 'f' : 's';
    const byteOrder = littleEndian ? 'le' : 'be';
    const wideCodec = `pcm-${sampleType}${format.bitsPerSample}${byteOrder}` as PcmCodec;
    const byteCodec = signed ? 'pcm-s8' : 'pcm-u8';
    const codec = format.bitsPerSample === 8 ? byteCodec : wideCodec;
    const target: PcmFormat = { ...format, codec, signed, littleEndian };

    const padding = ((container === 'wav' || container === 'aiff') && dataBytes & 1 ? 1 : 0) as
        0 | 1;
    if (container === 'wav')
        return {
            header: createWaveCopyHeader(waveDescription(format), dataBytes),
            target,
            padding,
        };

    if (container === 'caf') {
        const header = new Uint8Array(layout ? 92 : 68);
        const view = new DataView(header.buffer);
        tag(header, 0, 'caff');
        view.setUint16(4, 1);
        tag(header, 8, 'desc');
        view.setBigInt64(12, 32n);
        view.setFloat64(20, format.sampleRate);
        tag(header, 28, 'lpcm');
        view.setUint32(32, (format.float ? 1 : 0) | (format.bitsPerSample === 8 ? 0 : 2));
        view.setUint32(36, format.blockAlign);
        view.setUint32(40, 1);
        view.setUint32(44, format.channels);
        view.setUint32(48, format.bitsPerSample);

        let at = 52;
        if (layout) {
            tag(header, at, 'chan');
            view.setBigInt64(at + 4, 12n);
            view.setUint32(at + 12, 0x10000);
            view.setUint32(at + 16, cafChannelBitmap(format.channels, format.channelMask));
            at += 24;
        }

        tag(header, at, 'data');
        view.setBigInt64(at + 4, BigInt(dataBytes) + 4n);
        return { header, target, padding };
    }

    if (container === 'au') {
        const header = new Uint8Array(32);
        const view = new DataView(header.buffer);
        tag(header, 0, '.snd');
        view.setUint32(4, 32);
        view.setUint32(8, dataBytes < 0x80000000 ? dataBytes : 0xffffffff);
        view.setUint32(
            12,
            format.float
                ? format.bitsPerSample === 32
                    ? 6
                    : 7
                : format.bitsPerSample === 8
                  ? 2
                  : format.bitsPerSample === 16
                    ? 3
                    : format.bitsPerSample === 24
                      ? 4
                      : 5,
        );
        view.setUint32(16, format.sampleRate);
        view.setUint32(20, format.channels);
        return { header, target, padding };
    }

    const frames = dataBytes / format.blockAlign;
    const header = new Uint8Array(format.float ? 72 : 54);
    const formSize = header.length - 8 + dataBytes + padding;
    if (formSize > 0xffffffff || frames > 0xffffffff)
        return invalid('AIFF output exceeds its 32-bit FORM or frame-count fields');

    const view = new DataView(header.buffer);
    tag(header, 0, 'FORM');
    view.setUint32(4, formSize);
    tag(header, 8, format.float ? 'AIFC' : 'AIFF');

    let at = 12;
    if (format.float) {
        tag(header, at, 'FVER');
        view.setUint32(at + 4, 4);
        view.setUint32(at + 8, 0xa2805140);
        at += 12;
    }

    tag(header, at, 'COMM');
    view.setUint32(at + 4, format.float ? 24 : 18);
    view.setUint16(at + 8, format.channels);
    view.setUint32(at + 10, frames);
    view.setUint16(at + 14, format.bitsPerSample);
    writeExtendedRate(view, at + 16, format.sampleRate);
    if (format.float) tag(header, at + 26, format.bitsPerSample === 32 ? 'fl32' : 'fl64');
    at += format.float ? 32 : 26;

    tag(header, at, 'SSND');
    view.setUint32(at + 4, dataBytes + 8);
    return { header, target, padding };
}

/** Copies sample bits, swapping byte order or the 8-bit sign bias without numerical conversion. */
export function convertPcmByteOrder(
    data: Uint8Array,
    source: PcmFormat,
    target: PcmFormat,
): Uint8Array {
    const length = outputByteLength(data);
    if (
        length % source.blockAlign !== 0 ||
        source.bitsPerSample !== target.bitsPerSample ||
        source.channels !== target.channels ||
        source.float !== target.float
    )
        return invalid('PCM conversion requires matching complete sample frames');

    const output = copyOutputBytes(data);
    if (source.bitsPerSample === 8) {
        if (source.signed !== target.signed)
            for (let at = 0; at < length; at++) output[at] = output[at]! ^ 128;
    } else if (source.littleEndian !== target.littleEndian) {
        const width = source.bitsPerSample / 8;
        for (let at = 0; at < length; at += width) {
            for (let low = 0, high = width - 1; low < high; low++, high--) {
                const value = output[at + low]!;
                output[at + low] = output[at + high]!;
                output[at + high] = value;
            }
        }
    }
    return output;
}
