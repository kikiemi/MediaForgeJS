// Sources that report multi-gigabyte sizes and generate their bytes on demand, so size limits and
// 64-bit positions can be tested without large files.

import { annexB, aud, idr, pps, predicted, sps } from './avi-h264-fixtures.mjs';
import { pesPacket, transportStream } from './mpeg-video-fixtures.mjs';
import { AAC_PAYLOADS, adtsFrame } from './original-fixtures.mjs';

const u32 = value => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0);
    return out;
};
const u64 = value => {
    const out = Buffer.alloc(8);
    out.writeBigUInt64BE(BigInt(value));
    return out;
};
const atom = (type, ...parts) => {
    const payload = Buffer.concat(parts);
    return Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'latin1'), payload]);
};
const full = (type, flags, ...parts) => atom(type, u32(flags), ...parts);

/** Leading bytes of each sample that carry a pattern; the rest of a sample is zero. */
export const PATTERN_BYTES = 64;

/**
 * Byte `index` (below PATTERN_BYTES) of sample `sample`: a pattern that differs between samples and
 * positions.
 */
export const sampleByte = (sample, index) => (sample * 7 + index * 13 + 1) & 255;

/**
 * An AAC-labelled audio-only MP4 whose `count` samples of `sampleBytes` bytes (1024 ticks at 48 kHz
 * each) follow `gapBytes` of free space, so their co64 offsets can start beyond 4 GiB. The moov
 * comes first.
 */
export function hugeAudioMp4({ count, sampleBytes, gapBytes = 0 }) {
    const asc = Buffer.from([0x11, 0x90]);
    const entry = Buffer.alloc(28);
    entry.writeUInt16BE(1, 6);
    entry.writeUInt16BE(2, 16);
    entry.writeUInt16BE(16, 18);
    entry.writeUInt32BE(48000 * 65536, 24);
    const esds = full(
        'esds',
        0,
        Buffer.from([
            3,
            25,
            0,
            1,
            0,
            4,
            17,
            0x40,
            0x15,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            5,
            2,
            ...asc,
            6,
            1,
            2,
        ]),
    );
    const moovFor = dataStart => {
        const media = Buffer.alloc(20);
        media.writeUInt32BE(48000, 8);
        media.writeUInt32BE(count * 1024, 12);
        media.writeUInt16BE(0x55c4, 16);
        const head = Buffer.alloc(80);
        head.writeUInt32BE(1, 8);
        head.writeUInt32BE(0x10000, 36);
        head.writeUInt32BE(0x10000, 52);
        head.writeUInt32BE(0x40000000, 68);
        const movie = Buffer.alloc(96);
        movie.writeUInt32BE(48000, 8);
        movie.writeUInt32BE(count * 1024, 12);
        const offsets = Array.from({ length: count }, (_, sample) =>
            u64(dataStart + sample * sampleBytes),
        );
        const stbl = atom(
            'stbl',
            full('stsd', 0, u32(1), atom('mp4a', entry, esds)),
            full('stts', 0, u32(1), u32(count), u32(1024)),
            full('stsc', 0, u32(1), u32(1), u32(1), u32(1)),
            full('stsz', 0, u32(sampleBytes), u32(count)),
            full('co64', 0, u32(count), ...offsets),
        );
        const handler = full('hdlr', 0, u32(0), Buffer.from('soun'), Buffer.alloc(13));
        return atom(
            'moov',
            full('mvhd', 0, movie),
            atom(
                'trak',
                full('tkhd', 3, head),
                atom('mdia', full('mdhd', 0, media), handler, atom('minf', stbl)),
            ),
        );
    };
    const ftyp = atom('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isommp42'));
    const moovLength = moovFor(0).length;
    const freeStart = ftyp.length + moovLength;
    const mdatStart = freeStart + gapBytes;
    const dataStart = mdatStart + 16;
    const head = Buffer.concat([ftyp, moovFor(dataStart)]);
    const mdatHeader = Buffer.concat([u32(1), Buffer.from('mdat'), u64(16 + count * sampleBytes)]);
    const freeHeader = gapBytes
        ? Buffer.concat([u32(1), Buffer.from('free'), u64(gapBytes)])
        : Buffer.alloc(0);
    const size = dataStart + count * sampleBytes;
    const reads = [];
    return {
        size,
        dataStart,
        reads,
        async read(offset, length) {
            const end = Math.min(size, offset + length);
            const out = new Uint8Array(Math.max(0, end - offset));
            reads.push([offset, out.length]);
            const copy = (bytes, at) => {
                const from = Math.max(offset, at);
                const to = Math.min(end, at + bytes.length);
                if (from < to) out.set(bytes.subarray(from - at, to - at), from - offset);
            };
            copy(head, 0);
            copy(freeHeader, freeStart);
            copy(mdatHeader, mdatStart);
            for (let position = Math.max(offset, dataStart); position < end;) {
                const sample = Math.floor((position - dataStart) / sampleBytes);
                const start = dataStart + sample * sampleBytes;
                const stop = Math.min(end, start + PATTERN_BYTES);
                for (let at = position; at < stop; at++)
                    out[at - offset] = sampleByte(sample, at - start);
                position = start + sampleBytes;
            }
            return out;
        },
    };
}

/**
 * A fragmented AAC-labelled MP4 of `fragments` fragments with one `sampleBytes`-byte sample each
 * (1024 ticks at 48 kHz), generated on demand; sample `n` starts with the byte n & 255 and is
 * otherwise zero.
 */
export function manyFragmentsMp4({ fragments, sampleBytes = 4 }) {
    const asc = Buffer.from([0x11, 0x90]);
    const entry = Buffer.alloc(28);
    entry.writeUInt16BE(1, 6);
    entry.writeUInt16BE(2, 16);
    entry.writeUInt16BE(16, 18);
    entry.writeUInt32BE(48000 * 65536, 24);
    const esds = full(
        'esds',
        0,
        Buffer.from([
            3,
            25,
            0,
            1,
            0,
            4,
            17,
            0x40,
            0x15,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            5,
            2,
            ...asc,
            6,
            1,
            2,
        ]),
    );
    const media = Buffer.alloc(20);
    media.writeUInt32BE(48000, 8);
    media.writeUInt16BE(0x55c4, 16);
    const head = Buffer.alloc(80);
    head.writeUInt32BE(1, 8);
    head.writeUInt32BE(0x10000, 36);
    head.writeUInt32BE(0x40000000, 68);
    const movie = Buffer.alloc(96);
    movie.writeUInt32BE(48000, 8);
    const empty = type => full(type, 0, u32(0));
    const stbl = atom(
        'stbl',
        full('stsd', 0, u32(1), atom('mp4a', entry, esds)),
        empty('stts'),
        empty('stsc'),
        full('stsz', 0, u32(0), u32(0)),
        empty('stco'),
    );
    const handler = full('hdlr', 0, u32(0), Buffer.from('soun'), Buffer.alloc(13));
    const init = Buffer.concat([
        atom('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso6')),
        atom(
            'moov',
            full('mvhd', 0, movie),
            atom(
                'trak',
                full('tkhd', 3, head),
                atom('mdia', full('mdhd', 0, media), handler, atom('minf', stbl)),
            ),
            atom('mvex', full('trex', 0, u32(1), u32(1), u32(1024), u32(sampleBytes), u32(0))),
        ),
    ]);
    const fragment = number => {
        const moof = atom(
            'moof',
            full('mfhd', 0, u32(number + 1)),
            atom(
                'traf',
                full('tfhd', 0x020000, u32(1)),
                full('tfdt', 0x01000000, u64(number * 1024)),
                full('trun', 0x000001, u32(1), u32(0)),
            ),
        );
        moof.writeUInt32BE(moof.length + 8, moof.length - 4);
        const mdat = Buffer.alloc(8 + sampleBytes);
        mdat.writeUInt32BE(mdat.length);
        mdat.write('mdat', 4, 'latin1');
        mdat[8] = number & 255;
        return Buffer.concat([moof, mdat]);
    };
    const fragmentBytes = fragment(0).length;
    const size = init.length + fragments * fragmentBytes;
    return {
        size,
        async read(offset, length) {
            const end = Math.min(size, offset + length);
            const out = new Uint8Array(Math.max(0, end - offset));
            const copy = (bytes, at) => {
                const from = Math.max(offset, at);
                const to = Math.min(end, at + bytes.length);
                if (from < to) out.set(bytes.subarray(from - at, to - at), from - offset);
            };
            copy(init, 0);
            const first = Math.max(0, Math.floor((offset - init.length) / fragmentBytes));
            for (let number = first; number < fragments; number++) {
                const at = init.length + number * fragmentBytes;
                if (at >= end) break;
                copy(fragment(number), at);
            }
            return out;
        },
    };
}

/**
 * Transport packets of one PES on `pid`, continuity counters from `counter`, the last one padded by
 * stuffing.
 */
function pesTransportPackets(pid, counter, pes) {
    const packets = [];
    for (let offset = 0; offset < pes.length; offset += 184) {
        const take = Math.min(184, pes.length - offset);
        const packet = new Uint8Array(188).fill(0xff);
        packet.set([
            0x47,
            (offset === 0 ? 0x40 : 0) | (pid >> 8),
            pid & 255,
            (take < 184 ? 0x30 : 0x10) | (counter++ & 15),
        ]);
        if (take < 184) {
            packet[4] = 183 - take;
            if (take < 183) packet[5] = 0;
        }
        packet.set(pes.subarray(offset, offset + take), 188 - take);
        packets.push(packet);
    }
    return packets;
}

/** Access units of the long transport stream's pictures after the first and its audio frames. */
export const LONG_TS_PICTURE = annexB(aud, predicted);
export const LONG_TS_AUDIO = AAC_PAYLOADS;

/**
 * An MPEG-TS of H.264 at 30 pictures a second (an IDR, then P slices of LONG_TS_PICTURE) and 48 kHz
 * ADTS AAC (LONG_TS_AUDIO in turn), generated on demand. After the PAT, the PMT and the first
 * picture, each group of 18 packets holds 16 pictures and one PES of 25 audio frames (0.533 s);
 * 67,500 groups last ten hours.
 */
export function longTransportStream({ groups }) {
    const head = transportStream(
        [
            { pid: 0x100, streamType: 0x1b },
            { pid: 0x101, streamType: 0x0f },
        ],
        [
            {
                pid: 0x100,
                streamId: 0xe0,
                payload: annexB(aud, sps, pps, idr),
                pts: 90000,
                dts: 90000,
            },
        ],
    );
    const headVideoPackets = head.length / 188 - 2;
    const audio = Buffer.concat(
        Array.from({ length: 25 }, (_, index) =>
            adtsFrame(AAC_PAYLOADS[index % AAC_PAYLOADS.length]),
        ),
    );
    const groupBytes = 18 * 188;
    const size = head.length + groups * groupBytes;
    // Group 0 is the template; the others differ in their timestamps and continuity counters.
    const template = Buffer.concat([
        ...Array.from({ length: 16 }, (_, index) =>
            pesTransportPackets(
                0x100,
                0,
                pesPacket(0xe0, LONG_TS_PICTURE, { pts: 90000 + (1 + index) * 3000 }),
            ),
        ).flat(),
        ...pesTransportPackets(0x101, 0, pesPacket(0xc0, audio, { pts: 90000 })),
    ]);
    const stamp = (bytes, at, ticks) => {
        const high = Math.floor(ticks / 2 ** 30);
        const low = ticks % 2 ** 30;
        bytes[at] = 0x21 | (high << 1);
        bytes[at + 1] = low >>> 22;
        bytes[at + 2] = ((low >>> 14) & 0xfe) | 1;
        bytes[at + 3] = (low >>> 7) & 0xff;
        bytes[at + 4] = ((low << 1) & 0xfe) | 1;
    };
    const bytes = Buffer.from(template);
    const group = number => {
        for (let index = 0; index < 16; index++) {
            const at = index * 188;
            bytes[at + 3] =
                (bytes[at + 3] & 0xf0) | ((headVideoPackets + number * 16 + index) & 15);
            stamp(
                bytes,
                at + 188 - LONG_TS_PICTURE.length - 5,
                90000 + (1 + number * 16 + index) * 3000,
            );
        }
        bytes[16 * 188 + 3] = (bytes[16 * 188 + 3] & 0xf0) | ((number * 2) & 15);
        bytes[17 * 188 + 3] = (bytes[17 * 188 + 3] & 0xf0) | ((number * 2 + 1) & 15);
        stamp(bytes, 16 * 188 + 13, 90000 + number * 48000);
        return bytes;
    };
    return {
        size,
        async read(offset, length) {
            const end = Math.min(size, offset + length);
            const out = new Uint8Array(Math.max(0, end - offset));
            if (offset < head.length) out.set(head.subarray(offset, Math.min(end, head.length)));
            for (let at = Math.max(offset, head.length); at < end;) {
                const number = Math.floor((at - head.length) / groupBytes);
                const start = head.length + number * groupBytes;
                const bytes = group(number);
                const from = at - start;
                const count = Math.min(end - at, groupBytes - from);
                out.set(bytes.subarray(from, from + count), at - offset);
                at += count;
            }
            return out;
        },
    };
}
