import { MediaForgeError } from './errors.js';
import { copyOutputBytes, outputByteLength } from '../io/output-data.js';
export const MAX_WAVE_FORMAT_BYTES = 65553;
function invalid(message) {
    throw new MediaForgeError(message, 'FORMAT');
}
export function parseWaveFormat(input) {
    const length = outputByteLength(input);
    if (length < 16 || length > MAX_WAVE_FORMAT_BYTES)
        return invalid('WAVE fmt size must be in 16..65553 bytes');
    const bytes = copyOutputBytes(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let tag = view.getUint16(0, true);
    const extensible = tag === 0xfffe;
    const channels = view.getUint16(2, true);
    const sampleRate = view.getUint32(4, true);
    const blockAlign = view.getUint16(12, true);
    const bits = view.getUint16(14, true);
    let validBits = bits;
    let channelMask;
    if (extensible) {
        if (length < 40 ||
            view.getUint16(16, true) < 22 ||
            view.getUint16(16, true) > length - 18 ||
            view.getUint32(28, true) !== 0x00100000 ||
            view.getUint32(32, true) !== 0xaa000080 ||
            view.getUint32(36, true) !== 0x719b3800)
            return invalid('Invalid WAVE extensible fmt or subformat GUID');
        tag = view.getUint32(24, true);
        validBits = view.getUint16(18, true);
        channelMask = view.getUint32(20, true);
    }
    else if (tag === 3 && length !== 16 && (length < 18 || view.getUint16(16, true) !== 0)) {
        return invalid('IEEE-float WAVE fmt must have no format-specific extension');
    }
    const float = tag === 3;
    if ((tag !== 1 && !float) || (float ? ![32, 64].includes(bits) : ![8, 16, 24, 32].includes(bits))) {
        return invalid('WAVE packet input supports integer PCM8/16/24/32 and IEEE float32/64');
    }
    if (validBits < 1 || validBits > bits || (float && validBits !== bits))
        return invalid('Invalid WAVE valid bits per sample');
    if (channels < 1 ||
        channels > 32 ||
        sampleRate < 1 ||
        sampleRate > 768000 ||
        blockAlign !== channels * (bits / 8) ||
        view.getUint32(8, true) !== sampleRate * blockAlign) {
        return invalid('WAVE requires 1..32 channels, a rate in 1..768000, and consistent block alignment and byte rate');
    }
    const legacy = !float &&
        bits === 16 &&
        validBits === 16 &&
        channels <= 2 &&
        (channelMask === undefined || channelMask === 0 || channelMask === (channels === 1 ? 4 : 3));
    const codec = legacy
        ? 'pcm'
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
    const config = new Uint8Array(extensible ? 40 : float ? 18 : 16);
    config.set(bytes.subarray(0, config.length));
    if (config.length >= 18)
        new DataView(config.buffer).setUint16(16, extensible ? 22 : 0, true);
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
export function createWaveCopyHeader(config, dataBytes) {
    const format = parseWaveFormat(config);
    if (!Number.isSafeInteger(dataBytes) ||
        dataBytes < 0 ||
        dataBytes > Number.MAX_SAFE_INTEGER - 128 ||
        dataBytes % format.blockAlign !== 0)
        return invalid('WAVE data size must contain complete frames within the exact integer range');
    const frames = dataBytes / format.blockAlign;
    const fmt = format.codecConfig;
    const baseBytes = 12 + 8 + fmt.length + (format.float ? 12 : 0) + 8;
    const padding = dataBytes & 1;
    const rf64 = baseBytes - 8 + dataBytes + padding > 0xffffffff;
    const header = new Uint8Array(baseBytes + (rf64 ? 36 : 0));
    const view = new DataView(header.buffer);
    const writeTag = (at, text) => {
        for (let index = 0; index < 4; index++)
            header[at + index] = text.charCodeAt(index);
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
    if (format.float) {
        writeTag(offset, 'fact');
        view.setUint32(offset + 4, 4, true);
        view.setUint32(offset + 8, frames > 0xffffffff ? 0xffffffff : frames, true);
        offset += 12;
    }
    writeTag(offset, 'data');
    view.setUint32(offset + 4, rf64 ? 0xffffffff : dataBytes, true);
    return header;
}
