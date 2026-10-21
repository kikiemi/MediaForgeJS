// Original deterministic fixtures, authored for MediaForgeJS. This module has
// no imports from production parsers, writers, encoders, or another media corpus.
// Compressed payload sentinels exercise packet transport only; PCM and constant
// FLAC frames contain real audio sample values. Their expectations are in
// test/fixtures/formats/original-fixtures.json.
import { classicMp4 } from './mp4-fixture.mjs';
import { PICTURE_B, mpeg2Gop, programStream } from './mpeg-video-fixtures.mjs';
const ascii = value => new TextEncoder().encode(value);
export const concat = (...parts) => {
    const arrays = parts.map(part => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
    const output = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0));
    let position = 0;
    for (const part of arrays) {
        output.set(part, position);
        position += part.length;
    }
    return output;
};
const number = (bytes, value, little = false) => {
    const result = new Uint8Array(bytes);
    let remaining = BigInt(value);
    for (let index = 0; index < bytes; index++) {
        result[little ? index : bytes - index - 1] = Number(remaining & 255n);
        remaining >>= 8n;
    }
    return result;
};
const u16 = value => number(2, value);
const u32 = value => number(4, value);
const le16 = value => number(2, value, true);
const le32 = value => number(4, value, true);
const float64 = value => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value);
    return bytes;
};
const chunk = (name, bytes, little = false) =>
    concat(ascii(name), number(4, bytes.length, little), bytes, bytes.length & 1 ? [0] : []);

export const PCM_SAMPLES = Object.freeze([0, 32767, -32768, -1, 8192, -8192, 1234, -1234]);
const pcm16 = little => concat(...PCM_SAMPLES.map(sample => number(2, sample & 65535, little)));

export function waveFixture({ rf64 = false } = {}) {
    const payload = pcm16(true);
    const format = chunk(
        'fmt ',
        concat(le16(1), le16(2), le32(8000), le32(32000), le16(4), le16(16)),
        true,
    );
    const junk = chunk('JUNK', [0x4d, 0x46, 0x34], true); // Odd chunk with required padding.
    const data = concat(ascii('data'), le32(rf64 ? 0xffffffff : payload.length), payload);
    const body = concat(ascii('WAVE'), junk, format, data);
    if (!rf64) return concat(ascii('RIFF'), le32(body.length), body);
    const ds64 = chunk(
        'ds64',
        concat(
            number(8, body.length + 36, true),
            number(8, payload.length, true),
            number(8, 4, true),
            le32(0),
        ),
        true,
    );
    return concat(ascii('RF64'), le32(0xffffffff), ascii('WAVE'), ds64, junk, format, data);
}

export function aiffFixture() {
    // 8000 Hz in IEEE 754 extended precision: exponent 12, mantissa 1.953125.
    const rate = [0x40, 0x0b, 0xfa, 0, 0, 0, 0, 0, 0, 0];
    const comm = chunk('COMM', concat(u16(1), u32(8), u16(16), rate));
    const sound = chunk('SSND', concat(u32(2), u32(0), [0xa5, 0x5a], pcm16(false)));
    const body = concat(ascii('AIFF'), chunk('ANNO', ascii('MediaForge original')), comm, sound);
    return concat(ascii('FORM'), u32(body.length), body);
}

export function auFixture({ unknownSize = false } = {}) {
    const payload = pcm16(false);
    return concat(
        ascii('.snd'),
        u32(32),
        u32(unknownSize ? 0xffffffff : payload.length),
        u32(3),
        u32(8000),
        u32(1),
        ascii('MF4-test'),
        payload,
    );
}

export function cafFixture({ unknownSize = false } = {}) {
    const payload = new Uint8Array(32);
    const view = new DataView(payload.buffer);
    [-1, 1, 0.5, -0.5, 0, 0.25, -0.25, 0].forEach((value, index) =>
        view.setFloat32(index * 4, value, true),
    );
    const desc = concat(float64(8000), ascii('lpcm'), u32(3), u32(8), u32(1), u32(2), u32(32));
    return concat(
        ascii('caff'),
        u16(1),
        u16(0),
        ascii('desc'),
        number(8, 32),
        desc,
        ascii('data'),
        number(8, unknownSize ? -1n : payload.length + 4),
        u32(0),
        payload,
    );
}

export const AAC_PAYLOADS = Object.freeze([
    Object.freeze([0x01, 0x00, 0x10, 0x7f]),
    Object.freeze([0x01, 0x11, 0x20, 0x7e]),
    Object.freeze([0x01, 0x22, 0x30, 0x7d]),
    Object.freeze([0x01, 0x33, 0x40, 0x7c]),
]);
export function adtsFrame(payload, crc = false) {
    const length = payload.length + (crc ? 9 : 7);
    return concat(
        [
            0xff,
            crc ? 0xf0 : 0xf1,
            0x4c,
            0x40 | (length >> 11),
            (length >> 3) & 255,
            ((length & 7) << 5) | 31,
            0xfc,
        ],
        crc ? [0x12, 0x34] : [],
        payload,
    );
}
export function adtsFixture({ crc = false, gap = false, truncate = false } = {}) {
    const frames = AAC_PAYLOADS.map(payload => adtsFrame(payload, crc));
    const bytes = concat(frames[0], gap ? [0x4d, 0x46, 0x34] : [], ...frames.slice(1));
    return truncate ? bytes.slice(0, -2) : bytes;
}

export function mpegAudioFixture(layer = 3) {
    // MPEG-1, 44.1 kHz, mono, 128 kbit/s, no CRC. Payloads are transport sentinels.
    const length = layer === 1 ? 136 : 417;
    const header =
        layer === 1
            ? [0xff, 0xff, 0x40, 0xc0]
            : layer === 2
              ? [0xff, 0xfd, 0x80, 0xc0]
              : [0xff, 0xfb, 0x90, 0xc0];
    return concat(
        ...Array.from({ length: 4 }, (_, index) => {
            const frame = new Uint8Array(length).fill(0x20 + index);
            frame.set(header);
            return frame;
        }),
    );
}

// Bit-at-a-time CRCs provide an independent oracle for FLAC, Ogg and MPEG-TS.
function crc(bytes, width, polynomial, initial = 0) {
    let remainder = initial >>> 0;
    const high = 2 ** (width - 1);
    const mask = width === 32 ? 0xffffffff : 2 ** width - 1;
    for (const byte of bytes) {
        remainder ^= byte << (width - 8);
        for (let bit = 0; bit < 8; bit++) {
            remainder =
                (((remainder & high) !== 0 ? (remainder << 1) ^ polynomial : remainder << 1) &
                    mask) >>>
                0;
        }
    }
    return remainder;
}

export function flacFixture({ variable = false } = {}) {
    // Three constant subframes, each sixteen mono 16-bit samples at 8000 Hz. Variable blocking
    // numbers each frame by its first sample instead of its index.
    const frames = [1000, -1000, 0].map((sample, index) => {
        const sync = variable ? [0xff, 0xf9] : [0xff, 0xf8];
        const prefix = concat(sync, [0x64, 0x08, variable ? index * 16 : index, 15]);
        const body = concat(prefix, [crc(prefix, 8, 0x07)], [0], u16(sample & 65535));
        return concat(body, u16(crc(body, 16, 0x8005)));
    });
    const streamInfo = concat(
        u16(16),
        u16(16),
        number(3, 12),
        number(3, 12),
        number(8, (8000n << 44n) | (15n << 36n) | 48n),
        new Uint8Array(16),
    );
    return concat(ascii('fLaC'), [0x80, 0, 0, 34], streamInfo, ...frames);
}

/** An Ogg page; with `open`, its last packet (a multiple of 255 bytes) goes on in the next page. */
export function oggPage(
    packets,
    sequence,
    { flags = 0, granule = 0, serial = 0x4d463430, open = false } = {},
) {
    const lacing = [];
    for (const [index, packet] of packets.entries()) {
        let remaining = packet.length;
        while (remaining >= 255) {
            lacing.push(255);
            remaining -= 255;
        }
        if (!open || index < packets.length - 1) lacing.push(remaining);
    }
    const page = concat(
        ascii('OggS'),
        [0, flags],
        number(8, granule, true),
        le32(serial),
        le32(sequence),
        le32(0),
        [lacing.length],
        lacing,
        ...packets,
    );
    new DataView(page.buffer).setUint32(22, crc(page, 32, 0x04c11db7), true);
    return page;
}
export function oggFixture({ trimmed = false, serial = 0x4d463430, channels = 1 } = {}) {
    const head = concat(
        ascii('OpusHead'),
        [1, channels],
        le16(trimmed ? 120 : 0),
        le32(48000),
        le16(0),
        [0],
    );
    const vendor = ascii('MediaForgeJS-original');
    const tags = concat(ascii('OpusTags'), le32(vendor.length), vendor, le32(0));
    const packets = [
        [0x80, 0x31, 0x01],
        [0x80, 0x32, 0x02],
        [0x80, 0x33, 0x03],
    ];
    return concat(
        oggPage([head], 0, { flags: 2, serial }),
        oggPage([tags], 1, { serial }),
        oggPage(packets, 2, { flags: 4, granule: trimmed ? 300 : 360, serial }),
    );
}

const ebmlNumber = value => {
    let width = 1;
    while (BigInt(value) >= 1n << BigInt(width * 8)) width++;
    return number(width, value);
};
const ebmlSize = value => {
    let width = 1;
    while (BigInt(value) >= (1n << BigInt(width * 7)) - 1n) width++;
    return number(width, BigInt(value) | (1n << BigInt(width * 7)));
};
export const ebmlElement = (id, ...data) => {
    const payload = concat(...data);
    return concat(ebmlNumber(id), ebmlSize(payload.length), payload);
};
const ebmlUInt = (id, value) => ebmlElement(id, ebmlNumber(value));
const ebmlText = (id, text) => ebmlElement(id, ascii(text));
export function matroskaFixture() {
    const head = ebmlElement(
        0x1a45dfa3,
        ebmlUInt(0x4286, 1),
        ebmlUInt(0x42f7, 1),
        ebmlUInt(0x42f2, 4),
        ebmlUInt(0x42f3, 8),
        ebmlText(0x4282, 'matroska'),
        ebmlUInt(0x4287, 4),
        ebmlUInt(0x4285, 2),
    );
    const opusHead = concat(ascii('OpusHead'), [1, 1], le16(0), le32(48000), le16(0), [0]);
    const audio = ebmlElement(
        0xae,
        ebmlUInt(0xd7, 1),
        ebmlUInt(0x73c5, 0x4d463401),
        ebmlUInt(0x83, 2),
        ebmlText(0x86, 'A_OPUS'),
        ebmlUInt(0x23e383, 20000000),
        ebmlText(0x22b59c, 'eng'),
        ebmlElement(0x63a2, opusHead),
        ebmlElement(0xe1, ebmlUInt(0x9f, 1), ebmlElement(0xb5, float64(48000))),
    );
    const subtitle = ebmlElement(
        0xae,
        ebmlUInt(0xd7, 2),
        ebmlUInt(0x73c5, 0x4d463402),
        ebmlUInt(0x83, 17),
        ebmlText(0x86, 'S_TEXT/UTF8'),
        ebmlText(0x22b59c, 'jpn'),
        ebmlText(0x536e, 'Original captions'),
        ebmlUInt(0x55aa, 1),
    );
    const cluster = ebmlElement(
        0x1f43b675,
        ebmlUInt(0xe7, 0),
        ebmlElement(0xa3, [0x81, 0, 0, 0x80, 0xf8, 0x31, 0x01]),
        ebmlElement(
            0xa0,
            ebmlElement(0xa1, concat([0x82, 0, 10, 0], ascii('独自 fixture'))),
            ebmlUInt(0x9b, 75),
        ),
        ebmlElement(0xa3, [0x81, 0, 20, 0x80, 0xf8, 0x32, 0x02]),
    );
    return concat(
        head,
        ebmlElement(
            0x18538067,
            ebmlElement(
                0x1549a966,
                ebmlUInt(0x2ad7b1, 1000000),
                ebmlText(0x4d80, 'MediaForge-original'),
            ),
            ebmlElement(0x1654ae6b, audio, subtitle),
            cluster,
        ),
    );
}

const section = bytes => concat(bytes, u32(crc(bytes, 32, 0x04c11db7, 0xffffffff)));
export function transportPacket(pid, payload, { continuity = 0, start = true } = {}) {
    if (payload.length > 182)
        throw new RangeError('Original TS fixture payload exceeds one packet');
    const packet = new Uint8Array(188).fill(255);
    packet.set([0x47, (start ? 0x40 : 0) | ((pid >> 8) & 31), pid & 255, 0x30 | (continuity & 15)]);
    packet[4] = 183 - payload.length;
    packet[5] = 0;
    packet.set(payload, 188 - payload.length);
    return packet;
}
export function tsFixture({ continuityGap = false, startPts = 0 } = {}) {
    const pat = section([0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0]);
    const pmt = section([2, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 1, 0xf0, 0, 15, 0xe1, 1, 0xf0, 0]);
    const packets = AAC_PAYLOADS.map((payload, index) => {
        const timestamp = startPts + index * 1920;
        const pts = [
            0x21 | ((timestamp / 2 ** 29) & 14),
            (timestamp >>> 22) & 255,
            ((timestamp >>> 14) & 254) | 1,
            (timestamp >>> 7) & 255,
            ((timestamp << 1) & 254) | 1,
        ];
        const frame = adtsFrame(payload);
        const pes = concat([0, 0, 1, 0xc0], u16(frame.length + 8), [0x80, 0x80, 5], pts, frame);
        return transportPacket(0x101, pes, {
            continuity: index + (continuityGap && index > 0 ? 1 : 0),
        });
    });
    return concat(
        transportPacket(0, concat([0], pat)),
        transportPacket(0x100, concat([0], pmt)),
        ...packets,
    );
}

export function flvFixture() {
    const tag = (payload, timestamp) =>
        concat(
            [8],
            number(3, payload.length),
            number(3, timestamp),
            [0],
            [0, 0, 0],
            payload,
            u32(payload.length + 11),
        );
    return concat(
        ascii('FLV'),
        [1, 4],
        u32(9),
        u32(0),
        tag([0xaf, 0, 0x11, 0x88], 0),
        ...AAC_PAYLOADS.map((payload, index) =>
            tag(concat([0xaf, 1], payload), [0, 21, 43, 64][index]),
        ),
    );
}

export function webmVideoFixture() {
    const head = ebmlElement(
        0x1a45dfa3,
        ebmlUInt(0x4286, 1),
        ebmlUInt(0x42f7, 1),
        ebmlUInt(0x42f2, 4),
        ebmlUInt(0x42f3, 8),
        ebmlText(0x4282, 'webm'),
        ebmlUInt(0x4287, 4),
        ebmlUInt(0x4285, 2),
    );
    const track = ebmlElement(
        0xae,
        ebmlUInt(0xd7, 1),
        ebmlUInt(0x73c5, 0x4d463403),
        ebmlUInt(0x83, 1),
        ebmlText(0x86, 'V_VP8'),
        ebmlUInt(0x23e383, 40000000),
        ebmlElement(
            0xe0,
            ebmlUInt(0xb0, 2),
            ebmlUInt(0xba, 2),
            ebmlUInt(0x54b0, 4),
            ebmlUInt(0x54ba, 2),
        ),
    );
    const cluster = ebmlElement(
        0x1f43b675,
        ebmlUInt(0xe7, 0),
        ebmlElement(0xa3, [0x81, 0, 0, 0x80, 0x10, 0, 0, 0x9d, 1, 0x2a, 2, 0, 2, 0, 0x14, 0x30]),
        ebmlElement(0xa3, [0x81, 0, 40, 0, 0x11, 0, 0, 1, 0x13]),
        ebmlElement(0xa3, [0x81, 0, 80, 0, 0x11, 0, 0, 2, 0x14]),
    );
    return concat(
        head,
        ebmlElement(
            0x18538067,
            ebmlElement(0x1549a966, ebmlUInt(0x2ad7b1, 1000000)),
            ebmlElement(0x1654ae6b, track),
            cluster,
        ),
    );
}

export function aviFixture() {
    const main = new Uint8Array(56);
    const mainView = new DataView(main.buffer);
    mainView.setUint32(0, 500, true);
    mainView.setUint32(16, 1, true);
    mainView.setUint32(24, 1, true);
    const stream = new Uint8Array(56);
    stream.set(ascii('auds'));
    const view = new DataView(stream.buffer);
    view.setUint32(20, 4, true);
    view.setUint32(24, 32000, true);
    view.setUint32(32, 4, true);
    view.setUint32(44, 4, true);
    const format = concat(le16(1), le16(2), le32(8000), le32(32000), le16(4), le16(16));
    const list = (type, ...children) => chunk('LIST', concat(ascii(type), ...children), true);
    const header = list(
        'hdrl',
        chunk('avih', main, true),
        list('strl', chunk('strh', stream, true), chunk('strf', format, true)),
    );
    const movie = list('movi', list('rec ', chunk('00wb', pcm16(true), true)));
    return chunk('RIFF', concat(ascii('AVI '), header, movie), true);
}

export const originalFixtures = Object.freeze({
    'stereo-pcm.wav': () => waveFixture(),
    'stereo-pcm.rf64.wav': () => waveFixture({ rf64: true }),
    'mono-pcm.aiff': aiffFixture,
    'mono-pcm.au': auFixture,
    'unknown-size.au': () => auFixture({ unknownSize: true }),
    'float-stereo.caf': cafFixture,
    'unknown-size.caf': () => cafFixture({ unknownSize: true }),
    'four-frames.aac': adtsFixture,
    'crc-headers.aac': () => adtsFixture({ crc: true }),
    'resynchronized.aac': () => adtsFixture({ gap: true }),
    'truncated-tail.aac': () => adtsFixture({ truncate: true }),
    'four-frames.mp1': () => mpegAudioFixture(1),
    'four-frames.mp2': () => mpegAudioFixture(2),
    'four-frames.mp3': () => mpegAudioFixture(3),
    'constant-steps.flac': flacFixture,
    'three-packets.opus': oggFixture,
    'preskip-and-trim.opus': () => oggFixture({ trimmed: true }),
    'audio-and-captions.mkv': matroskaFixture,
    'aac-transport.ts': tsFixture,
    'aac-tags.flv': flvFixture,
    'classic-aac.mp4': () => classicMp4().bytes,
    'variable-chunks.mp4': () =>
        classicMp4({
            sizes: [3, 5, 1, 7, 2, 4],
            chunkSamples: [2, 2, 2],
            gapBytes: 5,
            timing: [
                [2, 10],
                [2, 30],
                [2, 20],
            ],
            composition: [
                [1, -5],
                [5, 0],
            ],
            co64: true,
        }).bytes,
    'keyframe-and-deltas.webm': webmVideoFixture,
    'nested-record-pcm.avi': aviFixture,
    'mpeg2-bframes.mpg': () =>
        programStream(
            mpeg2Gop().map(unit => ({
                streamId: 0xe0,
                payload: unit.data,
                pts: unit.pts,
                dts: unit.type === PICTURE_B ? undefined : unit.dts,
                scr: unit.dts - 900,
            })),
        ),
});

export function seededBytes(length, seed = 0x4d463430) {
    let state = seed >>> 0;
    return Uint8Array.from({ length }, () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state & 255;
    });
}
