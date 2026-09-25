const BLOCK_SIZE_TABLE = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const SAMPLE_RATE_TABLE = [
    undefined,
    88200,
    176400,
    192000,
    8000,
    16000,
    22050,
    24000,
    32000,
    44100,
    48000,
    96000,
];
const BITS_PER_SAMPLE_TABLE = [undefined, 8, 12, undefined, 16, 20, 24, 32];
const CRC16_TABLE = (() => {
    const table = new Uint16Array(256);
    for (let byte = 0; byte < table.length; byte++) {
        let crc = byte << 8;
        for (let bit = 0; bit < 8; bit++) {
            crc = ((crc << 1) ^ (crc & 0x8000 ? 0x8005 : 0)) & 0xffff;
        }
        table[byte] = crc;
    }
    return table;
})();
const UTF8_MIN_VALUE = [0, 0x80, 0x800, 0x10000, 0x200000, 0x4000000, 0x80000000];
const UTF8_FIRST_MASK = [0x7f, 0x1f, 0x0f, 0x07, 0x03, 0x01, 0];
const MAX_FIXED_FRAME_NUMBER = 0x7fffffff;
const MAX_VARIABLE_SAMPLE_NUMBER = 0xfffffffff;
export const MAX_FLAC_FRAME_HEADER_BYTES = 16;
export function flacCrc16(data) {
    let crc = 0;
    for (let index = 0; index < data.length; index++) {
        crc = ((crc << 8) ^ CRC16_TABLE[(crc >>> 8) ^ data[index]]) & 0xffff;
    }
    return crc;
}
function flacCrc8(data) {
    let crc = 0;
    for (let index = 0; index < data.length; index++) {
        crc ^= data[index];
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
    }
    return crc;
}
export function parseFlacFrameHeader(bytes, offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length - 6)
        return null;
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xfc) !== 0xf8)
        return null;
    if ((bytes[offset + 1] & 0x02) !== 0)
        return null;
    const blockingStrategy = (bytes[offset + 1] & 0x01);
    const blockSizeCode = (bytes[offset + 2] >> 4) & 0x0f;
    const sampleRateCode = bytes[offset + 2] & 0x0f;
    const channelCode = (bytes[offset + 3] >> 4) & 0x0f;
    const bitsCode = (bytes[offset + 3] >> 1) & 0x07;
    if (blockSizeCode === 0 ||
        sampleRateCode === 15 ||
        channelCode > 10 ||
        bitsCode === 3 ||
        (bytes[offset + 3] & 0x01) !== 0)
        return null;
    let cursor = offset + 4;
    const firstByte = bytes[cursor];
    if (firstByte === undefined)
        return null;
    let continuationBytes = 0;
    if ((firstByte & 0x80) === 0)
        continuationBytes = 0;
    else if ((firstByte & 0xe0) === 0xc0)
        continuationBytes = 1;
    else if ((firstByte & 0xf0) === 0xe0)
        continuationBytes = 2;
    else if ((firstByte & 0xf8) === 0xf0)
        continuationBytes = 3;
    else if ((firstByte & 0xfc) === 0xf8)
        continuationBytes = 4;
    else if ((firstByte & 0xfe) === 0xfc)
        continuationBytes = 5;
    else if (firstByte === 0xfe)
        continuationBytes = 6;
    else
        return null;
    if (cursor + continuationBytes >= bytes.length)
        return null;
    let codedNumber = firstByte & UTF8_FIRST_MASK[continuationBytes];
    for (let index = 1; index <= continuationBytes; index++) {
        const byte = bytes[cursor + index];
        if ((byte & 0xc0) !== 0x80)
            return null;
        codedNumber = codedNumber * 64 + (byte & 0x3f);
    }
    if (codedNumber < UTF8_MIN_VALUE[continuationBytes])
        return null;
    if (blockingStrategy === 0 && codedNumber > MAX_FIXED_FRAME_NUMBER)
        return null;
    if (blockingStrategy === 1 && codedNumber > MAX_VARIABLE_SAMPLE_NUMBER)
        return null;
    cursor += 1 + continuationBytes;
    let blockSize = BLOCK_SIZE_TABLE[blockSizeCode];
    if (blockSizeCode === 6) {
        if (cursor >= bytes.length)
            return null;
        blockSize = bytes[cursor] + 1;
        cursor++;
    }
    else if (blockSizeCode === 7) {
        if (cursor + 1 >= bytes.length)
            return null;
        blockSize = ((bytes[cursor] << 8) | bytes[cursor + 1]) + 1;
        if (blockSize > 0xffff)
            return null;
        cursor += 2;
    }
    let sampleRate = SAMPLE_RATE_TABLE[sampleRateCode];
    if (sampleRateCode === 12) {
        if (cursor >= bytes.length)
            return null;
        sampleRate = bytes[cursor] * 1000;
        cursor++;
    }
    else if (sampleRateCode === 13 || sampleRateCode === 14) {
        if (cursor + 1 >= bytes.length)
            return null;
        sampleRate = (bytes[cursor] << 8) | bytes[cursor + 1];
        if (sampleRateCode === 14)
            sampleRate *= 10;
        cursor += 2;
    }
    if (sampleRate !== undefined && sampleRate === 0)
        return null;
    if (cursor >= bytes.length)
        return null;
    if (flacCrc8(bytes.subarray(offset, cursor)) !== bytes[cursor])
        return null;
    return {
        headerLen: cursor + 1 - offset,
        blockSize,
        blockingStrategy,
        codedNumber,
        sampleRate,
        channelCount: channelCode <= 7 ? channelCode + 1 : 2,
        bitsPerSample: BITS_PER_SAMPLE_TABLE[bitsCode],
    };
}
