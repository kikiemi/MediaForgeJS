// Hand-built MPEG-1/2 and MPEG-4 Part 2 elementary streams with MPEG program and transport stream
// wrappers. Pictures carry complete headers and a short slice so parsers see real framing; they do
// not decode to images.
import { Bits, join } from './avi-h264-fixtures.mjs';

export const PICTURE_I = 1;
export const PICTURE_P = 2;
export const PICTURE_B = 3;

const code = value => [0, 0, 1, value];
const raw = bits => {
    bits.align();
    return Uint8Array.from(bits.bits.match(/.{8}/g) ?? [], byte => parseInt(byte, 2));
};
const text = value => new TextEncoder().encode(value);
const SLICE = Uint8Array.of(0x13, 0xf8, 0x7d, 0x29, 0x80);

/**
 * Sequence header, plus the sequence extension for MPEG-2 (`profile` is
 * profile_and_level_indication).
 */
export function mpegSequence({
    width = 32,
    height = 16,
    aspect = 1,
    rate = 3,
    profile,
    progressive = true,
} = {}) {
    const header = raw(
        new Bits()
            .uint(width & 0xfff, 12)
            .uint(height & 0xfff, 12)
            .uint(aspect, 4)
            .uint(rate, 4)
            .uint(0x3ffff, 18)
            .uint(1, 1)
            .uint(112, 10)
            .uint(0, 3),
    );
    if (profile === undefined) return join(code(0xb3), header);
    const extension = raw(
        new Bits()
            .uint(1, 4)
            .uint(profile, 8)
            .uint(progressive ? 1 : 0, 1)
            .uint(1, 2)
            .uint(width >> 12, 2)
            .uint(height >> 12, 2)
            .uint(0, 12)
            .uint(1, 1)
            .uint(0, 8)
            .uint(0, 1)
            .uint(0, 7),
    );
    return join(code(0xb3), header, code(0xb5), extension);
}

export const mpegGop = (closed = true) =>
    join(
        code(0xb8),
        raw(
            new Bits()
                .uint(0, 25)
                .uint(closed ? 1 : 0, 1)
                .uint(0, 1),
        ),
    );

/**
 * Picture header (with the MPEG-2 picture coding extension unless `mpeg1`) followed by one slice.
 */
export function mpegPicture(
    type,
    temporalReference,
    { mpeg1 = false, repeatFirstField = false } = {},
) {
    const header = new Bits()
        .uint(temporalReference & 1023, 10)
        .uint(type, 3)
        .uint(0xffff, 16);
    if (type !== PICTURE_I) header.uint(0, 1).uint(mpeg1 ? 1 : 7, 3);
    if (type === PICTURE_B) header.uint(0, 1).uint(mpeg1 ? 1 : 7, 3);
    header.uint(0, 1);
    const parts = [code(0), raw(header)];
    if (!mpeg1) {
        const extension = new Bits()
            .uint(8, 4)
            .uint(type === PICTURE_I ? 0xffff : type === PICTURE_P ? 0x11ff : 0x1111, 16)
            .uint(0, 2)
            .uint(3, 2)
            .uint(repeatFirstField ? 1 : 0, 1)
            .uint(1, 1)
            .uint(0, 4)
            .uint(repeatFirstField ? 1 : 0, 1)
            .uint(1, 1)
            .uint(1, 1)
            .uint(0, 1);
        parts.push(code(0xb5), raw(extension));
    }
    parts.push(code(0x01), SLICE);
    return join(...parts);
}

/**
 * Visual object sequence, visual object, video object and a rectangular VOL at 25 fixed frames per
 * second.
 */
export function mpeg4Config({ level = 1, width = 32, height = 16, aspect = 1 } = {}) {
    const layer = new Bits()
        .uint(0, 1)
        .uint(1, 8)
        .uint(0, 1)
        .uint(aspect, 4)
        .uint(0, 1)
        .uint(0, 2)
        .uint(1, 1)
        .uint(25, 16)
        .uint(1, 1)
        .uint(1, 1)
        .uint(1, 5)
        .uint(1, 1)
        .uint(width, 13)
        .uint(1, 1)
        .uint(height, 13)
        .uint(1, 1)
        .uint(0, 1)
        .uint(1, 1)
        .uint(0, 1)
        .uint(0, 1)
        .uint(0, 1)
        .uint(1, 1)
        .uint(1, 1)
        .uint(0, 1)
        .uint(0, 1)
        .uint(0, 1);
    layer.bits += '0' + '1'.repeat(7 - (layer.bits.length % 8));
    return join(code(0xb0), [level], code(0xb5), [0x08], code(0x00), code(0x20), raw(layer));
}

/**
 * One VOP; `coded: false` makes the not-coded placeholder that DivX packed streams store after a
 * packed chunk.
 */
export function mpeg4Vop(type, { coded = true } = {}) {
    const coding = type === PICTURE_I ? 0 : type === PICTURE_P ? 1 : 2;
    const header = new Bits()
        .uint(coding, 2)
        .uint(0, 1)
        .uint(1, 1)
        .uint(0, 5)
        .uint(1, 1)
        .uint(coded ? 1 : 0, 1);
    if (!coded) return join(code(0xb6), raw(header.uint(0, 1).uint(0x7f, 7)));
    if (coding === 1) header.uint(0, 1);
    header.uint(0, 3).uint(4, 5);
    if (coding !== 0) header.uint(1, 3);
    if (coding === 2) header.uint(1, 3);
    return join(code(0xb6), raw(header), SLICE);
}

/** DivX user data; the trailing 'p' marks a packed bitstream. */
export const divxUserData = (packed = true) =>
    join(code(0xb2), text(`DivX503b1393${packed ? 'p' : ''}`));

const timestampBytes = (prefix, value) => {
    const ts = BigInt(value);
    return [
        (prefix << 4) | Number(((ts >> 29n) & 0x0en) | 1n),
        Number((ts >> 22n) & 0xffn),
        Number(((ts >> 14n) & 0xfen) | 1n),
        Number((ts >> 7n) & 0xffn),
        Number(((ts << 1n) & 0xfen) | 1n),
    ];
};

/** MPEG-2 (or MPEG-1 with `mpeg1`) PES packet; timestamps are 90 kHz ticks. */
export function pesPacket(streamId, payload, { pts, dts, mpeg1 = false } = {}) {
    let header;
    if (mpeg1) {
        header =
            pts === undefined
                ? [0x0f]
                : dts === undefined || dts === pts
                  ? timestampBytes(2, pts)
                  : [...timestampBytes(3, pts), ...timestampBytes(1, dts)];
    } else {
        const fields =
            pts === undefined
                ? []
                : dts === undefined || dts === pts
                  ? timestampBytes(2, pts)
                  : [...timestampBytes(3, pts), ...timestampBytes(1, dts)];
        const flags = pts === undefined ? 0 : dts === undefined || dts === pts ? 0x80 : 0xc0;
        header = [0x80, flags, fields.length, ...fields];
    }
    const length = header.length + payload.length;
    return join(code(streamId), [length >> 8, length & 255], header, payload);
}

/** Pack header with its system clock reference in 90 kHz ticks. */
export function packHeader(scr, { mpeg1 = false } = {}) {
    const ts = BigInt(scr);
    const high = Number((ts >> 30n) & 7n);
    const middle = Number((ts >> 15n) & 0x7fffn);
    const low = Number(ts & 0x7fffn);
    if (mpeg1) {
        const bits = new Bits()
            .uint(2, 4)
            .uint(high, 3)
            .uint(1, 1)
            .uint(middle, 15)
            .uint(1, 1)
            .uint(low, 15)
            .uint(1, 1)
            .uint(1, 1)
            .uint(2520, 22)
            .uint(1, 1);
        return join(code(0xba), raw(bits));
    }
    const bits = new Bits()
        .uint(1, 2)
        .uint(high, 3)
        .uint(1, 1)
        .uint(middle, 15)
        .uint(1, 1)
        .uint(low, 15)
        .uint(1, 1)
        .uint(0, 9)
        .uint(1, 1)
        .uint(25200, 22)
        .uint(3, 2)
        .uint(0x1f, 5)
        .uint(0, 3);
    return join(code(0xba), raw(bits));
}

export const programEnd = () => Uint8Array.from(code(0xb9));

/** System header announcing one video and one audio stream. */
export function systemHeader() {
    const body = raw(
        new Bits()
            .uint(1, 1)
            .uint(25200, 22)
            .uint(1, 1)
            .uint(1, 6)
            .uint(0, 1)
            .uint(0, 1)
            .uint(1, 1)
            .uint(1, 1)
            .uint(1, 1)
            .uint(1, 5)
            .uint(0, 1)
            .uint(0x7f, 7)
            .uint(0xe0, 8)
            .uint(3, 2)
            .uint(1, 1)
            .uint(232, 13)
            .uint(0xc0, 8)
            .uint(3, 2)
            .uint(0, 1)
            .uint(32, 13),
    );
    return join(code(0xbb), [body.length >> 8, body.length & 255], body);
}

/**
 * Program stream with one pack per PES; `entries` are { streamId, payload, pts?, dts?, scr? } in
 * mux order.
 */
export function programStream(entries, { mpeg1 = false, end = true } = {}) {
    const parts = [];
    let scr = 0;
    for (const entry of entries) {
        scr = entry.scr ?? scr;
        parts.push(
            packHeader(scr, { mpeg1 }),
            pesPacket(entry.streamId, entry.payload, { ...entry, mpeg1 }),
        );
    }
    if (end) parts.push(programEnd());
    return join(...parts);
}

/** 128-byte AC-3 frame: 48 kHz, 32 kbit/s, 2/0 stereo, no LFE. */
export function ac3Frame(fill = 0) {
    const frame = new Uint8Array(128).fill(fill);
    frame.set([0x0b, 0x77, 0, 0, 0x00, 0x08 << 3, 0x40]);
    return frame;
}

/**
 * Private stream 1 payload: substream id, frame count and first access unit pointer, then `data`.
 */
export const privateSubstream = (id, data, { frames = 1, pointer = 1 } = {}) =>
    join([id, frames, pointer >> 8, pointer & 255], data);

/** DVD LPCM private substream: 16-bit big-endian, 48 kHz, `channels` channels. */
export const lpcmSubstream = (samples, { channels = 2, pointer = 1 } = {}) =>
    join([0xa0, 1, pointer >> 8, pointer & 255, 0, channels - 1, 0x80], samples);

const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
    return crc >>> 0;
};
const section = bytes =>
    join(bytes, [
        crc32(bytes) >>> 24,
        (crc32(bytes) >>> 16) & 255,
        (crc32(bytes) >>> 8) & 255,
        crc32(bytes) & 255,
    ]);

/** Transport stream packets for one PES, split over as many 188-byte packets as it needs. */
function transportPackets(pid, pes, counters) {
    const packets = [];
    for (let offset = 0; offset < pes.length || offset === 0;) {
        const take = Math.min(184, pes.length - offset);
        const packet = new Uint8Array(188).fill(0xff);
        const continuity = counters.get(pid) ?? 0;
        counters.set(pid, (continuity + 1) & 15);
        packet.set([
            0x47,
            (offset === 0 ? 0x40 : 0) | ((pid >> 8) & 31),
            pid & 255,
            (take < 184 ? 0x30 : 0x10) | continuity,
        ]);
        if (take < 184) {
            packet[4] = 183 - take;
            if (take < 183) packet[5] = 0;
        }
        packet.set(pes.subarray(offset, offset + take), 188 - take);
        packets.push(packet);
        offset += take;
    }
    return packets;
}

/**
 * Transport stream with one program; `streams` are { pid, streamType, descriptors? } and `entries`
 * are { pid, streamId, payload, pts?, dts? } in mux order. `programDescriptors` precede the stream
 * loop (e.g. HDMV registration); `patFlags` is the PAT byte holding the syntax indicator and
 * section length's high bits.
 */
export function transportStream(
    streams,
    entries,
    { programDescriptors = [], patFlags = 0xb0 } = {},
) {
    const counters = new Map();
    const pat = section([0, patFlags, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0]);
    const elementary = streams.flatMap(({ pid, streamType, descriptors = [] }) => [
        streamType,
        0xe0 | (pid >> 8),
        pid & 255,
        0xf0,
        descriptors.length,
        ...descriptors,
    ]);
    const length = 13 + programDescriptors.length + elementary.length;
    const pmt = section([
        2,
        0xb0,
        length,
        0,
        1,
        0xc1,
        0,
        0,
        0xe0 | (streams[0].pid >> 8),
        streams[0].pid & 255,
        0xf0,
        programDescriptors.length,
        ...programDescriptors,
        ...elementary,
    ]);
    return join(
        ...transportPackets(0, join([0], pat), counters),
        ...transportPackets(0x1000, join([0], pmt), counters),
        ...entries.flatMap(entry =>
            transportPackets(entry.pid, pesPacket(entry.streamId, entry.payload, entry), counters),
        ),
    );
}

/**
 * MPEG-2 access units I0 P3 B1 B2 P6 B4 B5 (display order in the temporal references) with sequence
 * and GOP headers before the I-picture; `dts` and `pts` are 90 kHz ticks at 25 frames per second
 * from `start`.
 */
export function mpeg2Gop({
    start = 90000,
    sequence = mpegSequence({ profile: 0x48 }),
    mpeg1 = false,
} = {}) {
    const order = [
        [PICTURE_I, 0],
        [PICTURE_P, 3],
        [PICTURE_B, 1],
        [PICTURE_B, 2],
        [PICTURE_P, 6],
        [PICTURE_B, 4],
        [PICTURE_B, 5],
    ];
    return order.map(([type, display], index) => ({
        type,
        data: join(
            ...(index === 0 ? [sequence, mpegGop()] : []),
            mpegPicture(type, display, { mpeg1 }),
        ),
        dts: start + (index - 1) * 3600,
        pts: start + display * 3600,
    }));
}
