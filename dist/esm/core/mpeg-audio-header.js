const MPEG_SAMPLE_RATES = {
    0: [11025, 12000, 8000],
    2: [22050, 24000, 16000],
    3: [44100, 48000, 32000],
};
const MPEG1_LAYER2_BITRATES = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const MPEG1_LAYER1_BITRATES = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];
const MPEG2_LAYER1_BITRATES = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0];
const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_LAYER23_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
export function parseMpegAudioHeader(data, offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > data.length)
        return null;
    if (data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0)
        return null;
    const versionBits = (data[offset + 1] >> 3) & 0x03;
    const layerBits = (data[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (data[offset + 2] >> 4) & 0x0f;
    const sampleRateIndex = (data[offset + 2] >> 2) & 0x03;
    const padding = (data[offset + 2] >> 1) & 0x01;
    const mode = (data[offset + 3] >> 6) & 0x03;
    if (versionBits === 1 || sampleRateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15)
        return null;
    const format = layerBits === 1 ? 'mp3' : layerBits === 2 ? 'mp2' : layerBits === 3 ? 'mp1' : null;
    if (!format)
        return null;
    const sampleRate = MPEG_SAMPLE_RATES[versionBits]?.[sampleRateIndex];
    if (!sampleRate)
        return null;
    const bitrateKbps = format === 'mp1'
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
    if (!bitrateKbps)
        return null;
    const samplesPerFrame = format === 'mp1' ? 384 : format === 'mp2' || versionBits === 3 ? 1152 : 576;
    const frameLength = format === 'mp1'
        ? (Math.floor((12000 * bitrateKbps) / sampleRate) + padding) * 4
        : format === 'mp2'
            ? Math.floor((144000 * bitrateKbps) / sampleRate) + padding
            : Math.floor(((versionBits === 3 ? 144000 : 72000) * bitrateKbps) / sampleRate) + padding;
    if (!Number.isFinite(frameLength) || frameLength < 24)
        return null;
    return { format, sampleRate, channels: mode === 3 ? 1 : 2, frameLength, samplesPerFrame };
}
export function isMpegAudioTrailerHeader(data, remainingBytes) {
    if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0)
        return false;
    if (remainingBytes === 128 && data.length >= 3 && data[0] === 0x54 && data[1] === 0x41 && data[2] === 0x47)
        return true;
    if (data.length < 10 ||
        data[0] !== 0x49 ||
        data[1] !== 0x44 ||
        data[2] !== 0x33 ||
        data[3] < 2 ||
        data[3] > 4 ||
        data[4] === 0xff)
        return false;
    for (let index = 6; index < 10; index++) {
        if ((data[index] & 0x80) !== 0)
            return false;
    }
    const size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9];
    const footer = data[3] === 4 && (data[5] & 0x10) !== 0 ? 10 : 0;
    return 10 + size + footer === remainingBytes;
}
