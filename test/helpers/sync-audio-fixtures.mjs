// Hand-built DTS, Dolby TrueHD, AC-3/E-AC-3 and Opus access units with valid headers and zero
// payloads, and the container wrappers that carry them. They exercise identification and packet
// transport, not decoding.
import { concat } from './original-fixtures.mjs';

const ascii = value => new TextEncoder().encode(value);

function bits(fields, length) {
    const out = new Uint8Array(length);
    let position = 0;
    for (const [count, value] of fields) {
        for (let bit = count - 1; bit >= 0; bit--, position++)
            if (Math.floor(value / 2 ** bit) % 2) out[position >> 3] |= 0x80 >> (position & 7);
    }
    return out;
}

/**
 * DTS core frame (16-bit big-endian): 48 kHz, `blocks` of 32 samples, AMODE 2 (stereo) unless
 * given.
 */
export function dtsCore({
    bytes = 256,
    blocks = 16,
    amode = 2,
    sfreq = 13,
    lfe = 0,
    fill = 0,
} = {}) {
    const frame = bits(
        [
            [32, 0x7ffe8001],
            [1, 1],
            [5, 31],
            [1, 0],
            [7, blocks - 1],
            [14, bytes - 1],
            [6, amode],
            [4, sfreq],
            [5, 15],
            [10, 0],
            [2, lfe],
        ],
        bytes,
    );
    frame.fill(fill, 12);
    return frame;
}

/**
 * DTS extension substream of `bytes` bytes. With `sampleRate` it carries static fields and one
 * asset descriptor (48 kHz reference clock, 512-sample frames); `sync` places an XLL or LBR sync
 * word inside the payload.
 */
export function dtsSubstream({ bytes = 64, channels = 6, sampleRateCode, sync } = {}) {
    const header = [
        [32, 0x64582025],
        [8, 0],
        [2, 0],
        [1, 0],
        [8, 15],
        [16, bytes - 1],
    ];
    const fields =
        sampleRateCode === undefined
            ? [[1, 0]]
            : [
                  [1, 1],
                  [2, 2],
                  [3, 0],
                  [1, 0],
                  [3, 0],
                  [3, 0],
                  [1, 1],
                  [8, 1],
                  [1, 0],
                  [16, bytes - 16],
                  [9, 20],
                  [3, 0],
                  [1, 0],
                  [1, 0],
                  [1, 0],
                  [5, 15],
                  [4, sampleRateCode],
                  [8, channels - 1],
              ];
    const out = bits([...header, ...fields], bytes);
    if (sync) new DataView(out.buffer).setUint32(bytes - 8, sync);
    return out;
}

export const XLL_SYNC = 0x41a29547;
export const LBR_SYNC = 0x0a801921;

/** Converts a 16-bit big-endian DTS stream to little-endian words. */
export function dtsLittleEndian(data) {
    const out = new Uint8Array(data.length);
    for (let index = 0; index + 1 < data.length; index += 2) {
        out[index] = data[index + 1];
        out[index + 1] = data[index];
    }
    return out;
}

/**
 * Packs a 16-bit big-endian DTS frame into 14-bit words (big- or little-endian), padding the last
 * word.
 */
export function dts14(frame, little = false) {
    const words = Math.ceil((frame.length * 8) / 14);
    const out = new Uint8Array(words * 2);
    for (let word = 0; word < words; word++) {
        let value = 0;
        for (let bit = 0; bit < 14; bit++) {
            const position = word * 14 + bit;
            const set =
                position < frame.length * 8 && (frame[position >> 3] >> (7 - (position & 7))) & 1;
            value = value * 2 + (set ? 1 : 0);
        }
        // The two spare bits sign-extend bit 13, as encoders emit them.
        const stored = value & 0x2000 ? value | 0xc000 : value;
        out[word * 2 + (little ? 1 : 0)] = stored >> 8;
        out[word * 2 + (little ? 0 : 1)] = stored & 255;
    }
    return out;
}

/**
 * Dolby TrueHD access unit; with `sampleRateCode` it starts with a major sync (0 = 48 kHz) for
 * `channelMask`.
 */
export function truehdUnit({ bytes = 64, sampleRateCode, channelMask = 1, fill = 0 } = {}) {
    const out = new Uint8Array(bytes).fill(fill);
    out[0] = (bytes / 2) >> 8;
    out[1] = (bytes / 2) & 255;
    out[2] = 0;
    out[3] = 0;
    if (sampleRateCode !== undefined) {
        out.set(
            [
                0xf8,
                0x72,
                0x6f,
                0xba,
                sampleRateCode << 4,
                0,
                (channelMask >> 8) & 31,
                channelMask & 255,
            ],
            4,
        );
        out.set([0xb7, 0x52, 0, 0, 0, 0, 0x18, 0xfe], 12);
    }
    return out;
}

/**
 * E-AC-3 frame at 48 kHz with six blocks, stereo, of `bytes` bytes; `dependent` marks a dependent
 * substream.
 */
export function eac3Frame(bytes = 256, fill = 0, { dependent = false } = {}) {
    const out = new Uint8Array(bytes).fill(fill);
    const words = bytes / 2 - 1;
    out.set([0x0b, 0x77, (dependent ? 0x40 : 0) | (words >> 8), words & 255, 0x34, 16 << 3]);
    return out;
}

const le16 = value => Uint8Array.of(value & 255, value >> 8);
const le32 = value =>
    Uint8Array.of(value & 255, (value >> 8) & 255, (value >> 16) & 255, value >>> 24);
const chunk = (name, bytes) =>
    concat(ascii(name), le32(bytes.length), bytes, bytes.length & 1 ? [0] : []);

/** WAVEFORMATEX with a compressed format tag. */
export function waveFormatEx(tag, channels = 2, sampleRate = 48000) {
    return concat(
        le16(tag),
        le16(channels),
        le32(sampleRate),
        le32(sampleRate * 4),
        le16(4),
        le16(16),
        le16(0),
    );
}

/** RIFF WAVE whose data chunk carries `payload` under `format`. */
export function waveFile(format, payload) {
    return chunk('RIFF', concat(ascii('WAVE'), chunk('fmt ', format), chunk('data', payload)));
}

/**
 * AVI with one audio stream per `audio` entry ({ format, chunks, samples }): one frame of `samples`
 * per chunk.
 */
export function aviAudioFile(audio) {
    const main = new Uint8Array(56);
    new DataView(main.buffer).setUint32(24, audio.length, true);
    const lists = audio.map(({ format, samples = 512 }) => {
        const stream = new Uint8Array(56);
        stream.set(ascii('auds'));
        const view = new DataView(stream.buffer);
        view.setUint32(20, samples, true);
        view.setUint32(24, 48000, true);
        return chunk('LIST', concat(ascii('strl'), chunk('strh', stream), chunk('strf', format)));
    });
    const header = chunk('LIST', concat(ascii('hdrl'), chunk('avih', main), ...lists));
    const media = audio.flatMap(({ chunks }, index) =>
        chunks.map(data => chunk(`0${index}wb`, data)),
    );
    return chunk(
        'RIFF',
        concat(ascii('AVI '), header, chunk('LIST', concat(ascii('movi'), ...media))),
    );
}

/**
 * Opus access unit in MPEG-TS framing: control header (0x7fe0), start trim when given, size,
 * packet.
 */
export function tsOpusUnit(packet, startTrim) {
    const size = [];
    for (let rest = packet.length; ; rest -= 255) {
        size.push(Math.min(rest, 255));
        if (rest < 255) break;
    }
    return concat(
        [0x7f, 0xe0 | (startTrim === undefined ? 0 : 0x10)],
        size,
        startTrim === undefined ? [] : [startTrim >> 8, startTrim & 255],
        packet,
    );
}

/** One FLV tag of `type` (8 audio, 9 video) followed by its PreviousTagSize. */
export function flvTag(type, payload, timestampMs) {
    const size = payload.length;
    const header = [
        type,
        size >> 16,
        (size >> 8) & 255,
        size & 255,
        (timestampMs >> 16) & 255,
        (timestampMs >> 8) & 255,
        timestampMs & 255,
        0,
        0,
        0,
        0,
    ];
    const total = size + 11;
    return concat(header, payload, [
        total >>> 24,
        (total >> 16) & 255,
        (total >> 8) & 255,
        total & 255,
    ]);
}

/** FLV header declaring audio and/or video, then `tags`. */
export function flvFile({ audio = false, video = false }, ...tags) {
    return concat(
        ascii('FLV'),
        [1, (audio ? 4 : 0) | (video ? 1 : 0), 0, 0, 0, 9, 0, 0, 0, 0],
        ...tags,
    );
}
