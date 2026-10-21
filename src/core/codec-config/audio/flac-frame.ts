const BLOCK_SIZE_TABLE = [
    0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
] as const;

const SAMPLE_RATE_TABLE: readonly (number | undefined)[] = [
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

const BITS_PER_SAMPLE_TABLE: readonly (number | undefined)[] = [
    undefined,
    8,
    12,
    undefined,
    16,
    20,
    24,
    32,
];

/**
 * Eight 256-entry tables: table k maps a byte to its CRC-16 contribution k bytes before the end of
 * an 8-byte block.
 */
const CRC16_TABLES = (() => {
    const table = new Int32Array(8 * 256);
    for (let byte = 0; byte < 256; byte++) {
        let crc = byte << 8;
        for (let bit = 0; bit < 8; bit++) {
            crc = ((crc << 1) ^ (crc & 0x8000 ? 0x8005 : 0)) & 0xffff;
        }
        table[byte] = crc;
    }
    for (let byte = 0; byte < 256; byte++) {
        let crc = table[byte]!;
        for (let slice = 1; slice < 8; slice++) {
            crc = ((crc << 8) ^ table[crc >>> 8]!) & 0xffff;
            table[slice * 256 + byte] = crc;
        }
    }
    return table;
})();

const UTF8_MIN_VALUE = [0, 0x80, 0x800, 0x10000, 0x200000, 0x4000000, 0x80000000] as const;
const UTF8_FIRST_MASK = [0x7f, 0x1f, 0x0f, 0x07, 0x03, 0x01, 0] as const;
const MAX_FIXED_FRAME_NUMBER = 0x7fffffff;
const MAX_VARIABLE_SAMPLE_NUMBER = 0xfffffffff;
export const MAX_FLAC_FRAME_HEADER_BYTES = 16;

export interface FlacFrameHeader {
    readonly headerLen: number;
    readonly blockSize: number;
    /** 0 = fixed-block frame number, 1 = variable-block sample number. */
    readonly blockingStrategy: 0 | 1;
    /** Decoded, canonically encoded frame/sample number. */
    readonly codedNumber: number;
    /** Undefined means that the frame inherits STREAMINFO's sample rate. */
    readonly sampleRate: number | undefined;
    readonly channelCount: number;
    /** Undefined means that the frame inherits STREAMINFO's bit depth. */
    readonly bitsPerSample: number | undefined;
}

/** FLAC frame CRC-16 (polynomial x^16 + x^15 + x^2 + 1). */
export function flacCrc16(data: Uint8Array): number {
    return flacCrc16Update(0, data, 0, data.length);
}

/** Continues a FLAC CRC-16 over bytes[start, end), eight bytes a step read as two words. */
export function flacCrc16Update(
    crc: number,
    bytes: Uint8Array,
    start: number,
    end: number,
): number {
    const t = CRC16_TABLES;
    let index = start;
    const blocks = end - ((end - start) & 7);
    if (index < blocks) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (; index < blocks; index += 8) {
            const a = (crc << 16) ^ view.getInt32(index);
            const b = view.getInt32(index + 4);
            crc =
                t[1792 + (a >>> 24)]! ^
                t[1536 + ((a >>> 16) & 0xff)]! ^
                t[1280 + ((a >>> 8) & 0xff)]! ^
                t[1024 + (a & 0xff)]! ^
                t[768 + (b >>> 24)]! ^
                t[512 + ((b >>> 16) & 0xff)]! ^
                t[256 + ((b >>> 8) & 0xff)]! ^
                t[b & 0xff]!;
        }
    }
    for (; index < end; index++) crc = ((crc << 8) ^ t[(crc >>> 8) ^ bytes[index]!]!) & 0xffff;
    return crc;
}

function flacCrc8(data: Uint8Array): number {
    let crc = 0;
    for (let index = 0; index < data.length; index++) {
        crc ^= data[index]!;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
    }
    return crc;
}

/** Parses and CRC-checks one FLAC frame header. */
export function parseFlacFrameHeader(bytes: Uint8Array, offset: number): FlacFrameHeader | null {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length - 6) return null;
    if (bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xfc) !== 0xf8) return null;

    if ((bytes[offset + 1]! & 0x02) !== 0) return null;
    const blockingStrategy = (bytes[offset + 1]! & 0x01) as 0 | 1;
    const blockSizeCode = (bytes[offset + 2]! >> 4) & 0x0f;
    const sampleRateCode = bytes[offset + 2]! & 0x0f;
    const channelCode = (bytes[offset + 3]! >> 4) & 0x0f;
    const bitsCode = (bytes[offset + 3]! >> 1) & 0x07;
    if (
        blockSizeCode === 0 ||
        sampleRateCode === 15 ||
        channelCode > 10 ||
        bitsCode === 3 ||
        (bytes[offset + 3]! & 0x01) !== 0
    )
        return null;

    let cursor = offset + 4;
    const firstByte = bytes[cursor];
    if (firstByte === undefined) return null;
    let continuationBytes = 0;
    if ((firstByte & 0x80) === 0) continuationBytes = 0;
    else if ((firstByte & 0xe0) === 0xc0) continuationBytes = 1;
    else if ((firstByte & 0xf0) === 0xe0) continuationBytes = 2;
    else if ((firstByte & 0xf8) === 0xf0) continuationBytes = 3;
    else if ((firstByte & 0xfc) === 0xf8) continuationBytes = 4;
    else if ((firstByte & 0xfe) === 0xfc) continuationBytes = 5;
    else if (firstByte === 0xfe) continuationBytes = 6;
    else return null;

    if (cursor + continuationBytes >= bytes.length) return null;
    let codedNumber = firstByte & UTF8_FIRST_MASK[continuationBytes]!;
    for (let index = 1; index <= continuationBytes; index++) {
        const byte = bytes[cursor + index]!;
        if ((byte & 0xc0) !== 0x80) return null;
        codedNumber = codedNumber * 64 + (byte & 0x3f);
    }

    if (codedNumber < UTF8_MIN_VALUE[continuationBytes]!) return null;
    if (blockingStrategy === 0 && codedNumber > MAX_FIXED_FRAME_NUMBER) return null;
    if (blockingStrategy === 1 && codedNumber > MAX_VARIABLE_SAMPLE_NUMBER) return null;
    cursor += 1 + continuationBytes;

    let blockSize = BLOCK_SIZE_TABLE[blockSizeCode]!;
    if (blockSizeCode === 6) {
        if (cursor >= bytes.length) return null;
        blockSize = bytes[cursor]! + 1;
        cursor++;
    } else if (blockSizeCode === 7) {
        if (cursor + 1 >= bytes.length) return null;
        blockSize = ((bytes[cursor]! << 8) | bytes[cursor + 1]!) + 1;
        if (blockSize > 0xffff) return null;
        cursor += 2;
    }
    let sampleRate = SAMPLE_RATE_TABLE[sampleRateCode];
    if (sampleRateCode === 12) {
        if (cursor >= bytes.length) return null;
        sampleRate = bytes[cursor]! * 1000;
        cursor++;
    } else if (sampleRateCode === 13 || sampleRateCode === 14) {
        if (cursor + 1 >= bytes.length) return null;
        sampleRate = (bytes[cursor]! << 8) | bytes[cursor + 1]!;
        if (sampleRateCode === 14) sampleRate *= 10;
        cursor += 2;
    }
    if (sampleRate !== undefined && sampleRate === 0) return null;
    if (cursor >= bytes.length) return null;
    if (flacCrc8(bytes.subarray(offset, cursor)) !== bytes[cursor]) return null;
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

/**
 * Offset of the first FLAC frame header (its CRC-8 verified) that states its own sample rate and
 * bit depth, as frames of a FLAC stream that lost its fLaC marker and STREAMINFO still do; -1 when
 * `h` holds none.
 */
export function firstFlacFrame(h: Uint8Array, from = 0): number {
    for (let at = from; at + 6 <= h.length; at++) {
        if (h[at] !== 0xff || (h[at + 1]! & 0xfe) !== 0xf8) continue;
        const header = parseFlacFrameHeader(h, at);
        if (header?.sampleRate && header.bitsPerSample) return at;
    }
    return -1;
}

/**
 * `frame` (one complete frame) with its frame number (fixed blocking) or first-sample number
 * (variable blocking) replaced by `number`, and both CRCs recomputed; the frame itself when it
 * already carries that number, null when it is not one CRC-valid frame. `blockingStrategy` 1 turns
 * a fixed-blocking frame into a variable-blocking one, whose `number` is then its first sample.
 */
export function renumberFlacFrame(
    frame: Uint8Array,
    number: number,
    blockingStrategy?: 0 | 1,
): Uint8Array | null {
    const header = parseFlacFrameHeader(frame, 0);
    if (!header || frame.length < header.headerLen + 2) return null;
    const strategy = blockingStrategy ?? header.blockingStrategy;
    if (header.codedNumber === number && header.blockingStrategy === strategy) return frame;

    const limit = strategy === 0 ? MAX_FIXED_FRAME_NUMBER : MAX_VARIABLE_SAMPLE_NUMBER;
    if (!Number.isSafeInteger(number) || number < 0 || number > limit) return null;
    if (
        flacCrc16(frame.subarray(0, frame.length - 2)) !==
        ((frame[frame.length - 2]! << 8) | frame[frame.length - 1]!)
    )
        return null;

    const oldStart = 4;
    const first = frame[oldStart]!;
    const oldLength =
        first < 0x80
            ? 1
            : first < 0xe0
              ? 2
              : first < 0xf0
                ? 3
                : first < 0xf8
                  ? 4
                  : first < 0xfc
                    ? 5
                    : first < 0xfe
                      ? 6
                      : 7;

    const coded: number[] = [];
    if (number < 0x80) coded.push(number);
    else {
        let continuation =
            [0x800, 0x10000, 0x200000, 0x4000000, 0x80000000].findIndex(bound => number < bound) +
            1;
        if (continuation === 0) continuation = 6;
        let value = number;
        for (let index = 0; index < continuation; index++) {
            coded.unshift(0x80 | (value % 64));
            value = Math.floor(value / 64);
        }
        coded.unshift(continuation === 6 ? 0xfe : ((0xff00 >> (continuation + 1)) & 0xff) | value);
    }

    const tail = frame.subarray(oldStart + oldLength, header.headerLen - 1);
    const out = new Uint8Array(frame.length - oldLength + coded.length);
    out.set(frame.subarray(0, oldStart));
    out[1] = (out[1]! & 0xfe) | strategy;
    out.set(coded, oldStart);
    out.set(tail, oldStart + coded.length);

    const crcAt = oldStart + coded.length + tail.length;
    out[crcAt] = flacCrc8(out.subarray(0, crcAt));
    out.set(frame.subarray(header.headerLen, frame.length - 2), crcAt + 1);

    const crc = flacCrc16(out.subarray(0, out.length - 2));
    out[out.length - 2] = crc >> 8;
    out[out.length - 1] = crc & 0xff;
    return out;
}

export const STREAMINFO_BYTES = 34;

export function isFlacMarker(bytes: Uint8Array, offset: number): boolean {
    return (
        bytes[offset] === 0x66 &&
        bytes[offset + 1] === 0x4c &&
        bytes[offset + 2] === 0x61 &&
        bytes[offset + 3] === 0x43
    );
}

export function streamInfoBlockAt(bytes: Uint8Array, offset: number): boolean {
    return (
        bytes.length >= offset + 4 + STREAMINFO_BYTES &&
        (bytes[offset]! & 0x7f) === 0 &&
        bytes[offset + 1] === 0 &&
        bytes[offset + 2] === 0 &&
        bytes[offset + 3] === STREAMINFO_BYTES
    );
}

/**
 * The 34-byte STREAMINFO record from any FLAC decoder configuration in use: the raw record, a
 * stream header starting with fLaC (Matroska CodecPrivate, standalone files), or an MP4 dfLa
 * payload. Null when none is present.
 */
export function flacStreamInfoRecord(config: Uint8Array): Uint8Array | null {
    if (config.length === STREAMINFO_BYTES) return config;
    if (streamInfoBlockAt(config, 0)) return config.subarray(4, 4 + STREAMINFO_BYTES);
    if (isFlacMarker(config, 0) && streamInfoBlockAt(config, 4))
        return config.subarray(8, 8 + STREAMINFO_BYTES);
    if (config[0] === 0 && streamInfoBlockAt(config, 4))
        return config.subarray(8, 8 + STREAMINFO_BYTES);
    return null;
}

/**
 * Where `bytes` (a container header written with `config`) hold the STREAMINFO record of the FLAC
 * configuration `config`, or -1.
 */
export function flacStreamInfoAt(bytes: Uint8Array, config: Uint8Array): number {
    const record = flacStreamInfoRecord(config);
    const first = record?.[0] ?? -1;
    for (let at = bytes.indexOf(first); at >= 0; at = bytes.indexOf(first, at + 1))
        if (record!.every((byte, index) => bytes[at + index] === byte)) return at;
    return -1;
}

/** Matroska CodecPrivate form: fLaC marker, a final STREAMINFO block header and the record. */
export function flacStreamHeader(config: Uint8Array): Uint8Array | null {
    const record = flacStreamInfoRecord(config);
    if (!record) return null;
    const header = new Uint8Array(8 + STREAMINFO_BYTES);
    header.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, STREAMINFO_BYTES]);
    header.set(record, 8);
    return header;
}

/** Samples per block of the built-in FLAC encoder; every block but the last has this size. */
export const FLAC_BLOCK_SIZE = 4096;

interface FlacStreamInfo {
    readonly minBlockSize: number;
    readonly maxBlockSize: number;
    /** Frame sizes in bytes; 0 means unknown. */
    readonly minFrameSize: number;
    readonly maxFrameSize: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    /** Samples per channel; 0 means unknown. */
    readonly totalSamples: number;
    /** MD5 of the decoded samples; all zero means unknown. */
    readonly md5?: Uint8Array;
}

/**
 * The fields of a 34-byte STREAMINFO record (RFC 9639 section 8.2) as buildFlacStreamHeader()
 * writes them; the caller checks the values it relies on.
 */
export function readFlacStreamInfo(record: Uint8Array): Required<FlacStreamInfo> {
    const view = new DataView(record.buffer, record.byteOffset, STREAMINFO_BYTES);
    const packed = view.getUint32(10);
    return {
        minBlockSize: view.getUint16(0),
        maxBlockSize: view.getUint16(2),
        minFrameSize: record[4]! * 65536 + view.getUint16(5),
        maxFrameSize: record[7]! * 65536 + view.getUint16(8),
        sampleRate: packed >>> 12,
        channels: ((packed >>> 9) & 7) + 1,
        bitsPerSample: ((packed >>> 4) & 31) + 1,
        totalSamples: (packed & 15) * 2 ** 32 + view.getUint32(14),
        md5: record.slice(18, STREAMINFO_BYTES),
    };
}

/** fLaC marker, a final STREAMINFO block header and the 34-byte record (RFC 9639 section 8.2). */
export function buildFlacStreamHeader(info: FlacStreamInfo): Uint8Array<ArrayBuffer> {
    const header = new Uint8Array(8 + STREAMINFO_BYTES);
    const view = new DataView(header.buffer);
    header.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, STREAMINFO_BYTES]);
    view.setUint16(8, info.minBlockSize);
    view.setUint16(10, info.maxBlockSize);
    header.set(
        [info.minFrameSize >>> 16, info.minFrameSize >>> 8, info.minFrameSize].map(
            byte => byte & 0xff,
        ),
        12,
    );
    header.set(
        [info.maxFrameSize >>> 16, info.maxFrameSize >>> 8, info.maxFrameSize].map(
            byte => byte & 0xff,
        ),
        15,
    );
    const high = Math.floor(info.totalSamples / 4294967296) & 0xf;
    view.setUint32(
        18,
        info.sampleRate * 4096 + (info.channels - 1) * 512 + (info.bitsPerSample - 1) * 16 + high,
    );
    view.setUint32(22, info.totalSamples >>> 0);
    if (info.md5) header.set(info.md5.subarray(0, 16), 26);
    return header;
}

/**
 * STREAMINFO a container declares before the built-in encoder runs: its block size, the depth and
 * the sample count when known, with the frame sizes and MD5 left unknown.
 */
export function declaredFlacHeader(
    sampleRate: number,
    channels: number,
    bitsPerSample = 16,
    totalSamples = 0,
): Uint8Array<ArrayBuffer> {
    return buildFlacStreamHeader({
        minBlockSize: FLAC_BLOCK_SIZE,
        maxBlockSize: FLAC_BLOCK_SIZE,
        minFrameSize: 0,
        maxFrameSize: 0,
        sampleRate,
        channels,
        bitsPerSample,
        totalSamples,
    });
}
