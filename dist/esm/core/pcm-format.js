import { MediaForgeError } from './errors.js';
import { createWaveCopyHeader, parseWaveFormat } from './wave-format.js';
import { copyOutputBytes, outputByteLength } from '../io/output-data.js';
function invalid(message) {
    throw new MediaForgeError(message, 'FORMAT');
}
export function describePcmTrack(track) {
    const { codec, sampleRate, channelCount: channels, codecConfig } = track;
    const shape = codec === 'pcm' ? ['s', '16', 'le'] : /^pcm-(u|s|f)(8|16|24|32|64)(le|be)?$/.exec(codec)?.slice(1);
    if (!shape)
        return invalid('PCM copying requires an explicit supported PCM codec');
    const [kind, depth, order] = shape;
    const bits = Number(depth);
    const float = kind === 'f';
    if ((float ? ![32, 64].includes(bits) : ![8, 16, 24, 32].includes(bits)) ||
        (kind === 'u' && bits !== 8) ||
        (bits === 8 ? order !== undefined : !order) ||
        !Number.isInteger(sampleRate) ||
        sampleRate < 1 ||
        sampleRate > 768000 ||
        !Number.isInteger(channels) ||
        channels < 1 ||
        channels > 32) {
        return invalid('PCM requires integer8/16/24/32 or float32/64, a rate in 1..768000, and 1..32 channels');
    }
    const blockAlign = channels * (bits / 8);
    let validBits = bits;
    let channelMask;
    let waveConfig;
    if (codecConfig !== undefined) {
        const wave = parseWaveFormat(codecConfig);
        if (order === 'be' ||
            (kind === 's' && bits === 8) ||
            wave.bitsPerSample !== bits ||
            wave.float !== float ||
            wave.sampleRate !== sampleRate ||
            wave.channels !== channels) {
            return invalid('PCM codec, sample rate, and channels must match the WAVE fmt description');
        }
        validBits = wave.validBitsPerSample;
        channelMask = wave.channelMask;
        waveConfig = wave.codecConfig;
        if (codec === 'pcm' && (validBits !== 16 || (wave.codec !== 'pcm' && channelMask !== undefined))) {
            return invalid('Historical pcm requires its existing PCM16LE WAVE description');
        }
    }
    else if (codec === 'pcm')
        return invalid('Historical PCM copying requires a WAVE fmt description');
    return {
        codec: codec,
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
function waveDescription(format) {
    if (format.waveConfig)
        return format.waveConfig;
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
function tag(data, at, value) {
    for (let index = 0; index < 4; index++)
        data[at + index] = value.charCodeAt(index);
}
export function createPcmCopyHeader(container, format, dataBytes) {
    if (!['wav', 'aiff', 'au', 'caf'].includes(container))
        return invalid('Unsupported PCM output container');
    if (!Number.isSafeInteger(dataBytes) ||
        dataBytes < 0 ||
        dataBytes > Number.MAX_SAFE_INTEGER - 128 ||
        dataBytes % format.blockAlign !== 0)
        return invalid('PCM output requires a safe size containing complete frames');
    const waveCopy = container === 'wav' && format.waveConfig !== undefined;
    if (!waveCopy &&
        (format.channels > 2 ||
            format.validBitsPerSample !== format.bitsPerSample ||
            (format.channelMask !== undefined &&
                format.channelMask !== 0 &&
                format.channelMask !== (format.channels === 1 ? 4 : 3)))) {
        return invalid('Cross-container PCM copying supports mono/stereo full-width samples with an unspecified or canonical channel layout');
    }
    const littleEndian = container === 'wav' || container === 'caf';
    const signed = format.bitsPerSample !== 8 || container !== 'wav';
    const codec = format.bitsPerSample === 8
        ? signed
            ? 'pcm-s8'
            : 'pcm-u8'
        : `pcm-${format.float ? 'f' : 's'}${format.bitsPerSample}${littleEndian ? 'le' : 'be'}`;
    const target = { ...format, codec, signed, littleEndian };
    const padding = ((container === 'wav' || container === 'aiff') && dataBytes & 1 ? 1 : 0);
    if (container === 'wav')
        return { header: createWaveCopyHeader(waveDescription(format), dataBytes), target, padding };
    if (container === 'caf') {
        const header = new Uint8Array(68);
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
        tag(header, 52, 'data');
        view.setBigInt64(56, BigInt(dataBytes) + 4n);
        return { header, target, padding };
    }
    if (container === 'au') {
        const header = new Uint8Array(32);
        const view = new DataView(header.buffer);
        tag(header, 0, '.snd');
        view.setUint32(4, 32);
        view.setUint32(8, dataBytes < 0x80000000 ? dataBytes : 0xffffffff);
        view.setUint32(12, format.float
            ? format.bitsPerSample === 32
                ? 6
                : 7
            : format.bitsPerSample === 8
                ? 2
                : format.bitsPerSample === 16
                    ? 3
                    : format.bitsPerSample === 24
                        ? 4
                        : 5);
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
    const exponent = Math.floor(Math.log2(format.sampleRate));
    view.setUint16(at + 16, exponent + 16383);
    view.setBigUint64(at + 18, BigInt(format.sampleRate) << BigInt(63 - exponent));
    if (format.float)
        tag(header, at + 26, format.bitsPerSample === 32 ? 'fl32' : 'fl64');
    at += format.float ? 32 : 26;
    tag(header, at, 'SSND');
    view.setUint32(at + 4, dataBytes + 8);
    return { header, target, padding };
}
export function convertPcmByteOrder(data, source, target) {
    const length = outputByteLength(data);
    if (length % source.blockAlign !== 0 ||
        source.bitsPerSample !== target.bitsPerSample ||
        source.channels !== target.channels ||
        source.float !== target.float)
        return invalid('PCM conversion requires matching complete sample frames');
    const output = copyOutputBytes(data);
    if (source.bitsPerSample === 8) {
        if (source.signed !== target.signed)
            for (let at = 0; at < length; at++)
                output[at] = output[at] ^ 128;
    }
    else if (source.littleEndian !== target.littleEndian) {
        const width = source.bitsPerSample / 8;
        for (let at = 0; at < length; at += width) {
            for (let low = 0, high = width - 1; low < high; low++, high--) {
                const value = output[at + low];
                output[at + low] = output[at + high];
                output[at + high] = value;
            }
        }
    }
    return output;
}
