// Streams built by hand from their specifications, for the codecs the support matrix copies that
// no encoder at hand writes (test/support/cases/codecs.mjs). Most are structural: their sample
// entries, configuration records and container framing and timing are what the specifications
// define and the readers and writers parse, their access units start with the codec's own headers,
// and the rest of each unit is filler that decodes to nothing meaningful. A copy of one checks
// carriage, not decoding. ProRes RAW is a real stream: its frames are those of the hand-written
// encoder of ./prores-raw-fixtures.mjs, which the ProRes RAW decoder decodes.

const ascii = text => Array.from(text, char => char.charCodeAt(0));

/** The bytes of `parts` (arrays and Uint8Arrays) one after another. */
function bytes(...parts) {
    const arrays = parts.map(part => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
    const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of arrays) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

const be16 = value => [(value >> 8) & 255, value & 255];
const be32 = value => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const le16 = value => [value & 255, (value >> 8) & 255];
const le32 = value => be32(value).reverse();
const zeros = count => new Array(count).fill(0);
const hex = text => Uint8Array.from(text.match(/../g), pair => Number.parseInt(pair, 16));

/** Fields of [bit count, value], most significant bit first, in whole bytes. */
function bits(fields) {
    const total = fields.reduce((sum, [count]) => sum + count, 0);
    const out = new Uint8Array(Math.ceil(total / 8));
    let at = 0;
    for (const [count, value] of fields)
        for (let bit = count - 1; bit >= 0; bit--, at++)
            if (Math.floor(value / 2 ** bit) % 2) out[at >> 3] |= 0x80 >> (at & 7);
    return out;
}

/** `length` bytes of filler that holds no start code: 0x55, 0xAA, ... */
const filler = length => Array.from({ length }, (_, index) => (index % 2 ? 0xaa : 0x55));

// ISO base media files (ISO/IEC 14496-12; QuickTime for MOV).

const box = (type, ...parts) => {
    const body = bytes(...parts);
    return bytes(be32(body.length + 8), ascii(type), body);
};
const fullBox = (type, version, flags, ...parts) =>
    box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(value => be32(value));

/** A visual sample entry of `width` x `height` with its child boxes. */
const visualEntry = (type, width, height, ...children) =>
    box(
        type,
        zeros(6),
        be16(1),
        zeros(16),
        be16(width),
        be16(height),
        be32(0x480000),
        be32(0x480000),
        be32(0),
        be16(1),
        zeros(32),
        be16(0x18),
        be16(0xffff),
        ...children,
    );

/** An audio sample entry of `channels` at `rate` with its child boxes. */
const audioEntry = (type, channels, rate, ...children) =>
    box(
        type,
        zeros(6),
        be16(1),
        zeros(8),
        be16(channels),
        be16(16),
        zeros(4),
        be32(rate * 65536),
        ...children,
    );

/**
 * A file of one track: `entry` its sample description, `samples` its { data, duration, sync }
 * in `timescale` units, all in one chunk; a sync sample table when some samples are not sync.
 */
function isoFile({ brands, handler, entry, timescale, samples, width = 0, height = 0 }) {
    const ftyp = box('ftyp', ascii(brands[0]), be32(0), ...brands.map(ascii));
    const total = samples.reduce((sum, sample) => sum + sample.duration, 0);
    const video = handler === 'vide';
    const runs = [];
    for (const { duration } of samples)
        if (runs.at(-1)?.[1] === duration) runs.at(-1)[0]++;
        else runs.push([1, duration]);
    const sync = samples.flatMap((sample, index) => (sample.sync === false ? [] : [index + 1]));
    const stbl = box(
        'stbl',
        fullBox('stsd', 0, 0, be32(1), entry),
        fullBox(
            'stts',
            0,
            0,
            be32(runs.length),
            ...runs.map(([n, delta]) => [...be32(n), ...be32(delta)]),
        ),
        ...(sync.length < samples.length
            ? [fullBox('stss', 0, 0, be32(sync.length), ...sync.map(be32))]
            : []),
        fullBox('stsc', 0, 0, be32(1), be32(1), be32(samples.length), be32(1)),
        fullBox(
            'stsz',
            0,
            0,
            be32(0),
            be32(samples.length),
            ...samples.map(s => be32(s.data.length)),
        ),
        fullBox('stco', 0, 0, be32(1), be32(ftyp.length + 8)),
    );
    const minf = box(
        'minf',
        video ? fullBox('vmhd', 0, 1, zeros(8)) : fullBox('smhd', 0, 0, zeros(4)),
        box('dinf', fullBox('dref', 0, 0, be32(1), fullBox('url ', 0, 1))),
        stbl,
    );
    const moov = box(
        'moov',
        fullBox(
            'mvhd',
            0,
            0,
            zeros(8),
            be32(timescale),
            be32(total),
            be32(0x10000),
            be16(0x100),
            zeros(10),
            MATRIX,
            zeros(24),
            be32(2),
        ),
        box(
            'trak',
            fullBox(
                'tkhd',
                0,
                3,
                zeros(8),
                be32(1),
                zeros(4),
                be32(total),
                zeros(8),
                zeros(4),
                be16(video ? 0 : 0x100),
                zeros(2),
                MATRIX,
                be32(width * 65536),
                be32(height * 65536),
            ),
            box(
                'mdia',
                fullBox(
                    'mdhd',
                    0,
                    0,
                    zeros(8),
                    be32(timescale),
                    be32(total),
                    be16(0x55c4),
                    zeros(2),
                ),
                fullBox('hdlr', 0, 0, zeros(4), ascii(handler), zeros(12), [0]),
                minf,
            ),
        ),
    );
    return bytes(ftyp, box('mdat', ...samples.map(sample => sample.data)), moov);
}

const MP4 = ['isom', 'isom', 'iso2', 'mp41'];

// AVI (the OpenDML-era RIFF form Video for Windows defines).

const chunk = (id, ...parts) => {
    const body = bytes(...parts);
    return bytes(ascii(id), le32(body.length), body, body.length & 1 ? [0] : []);
};
const list = (type, ...parts) => chunk('LIST', ascii(type), ...parts);

/**
 * An AVI file of one stream: `format` its strf, `chunks` its { data, key } in order, timed by
 * `rate` / `scale` (units of `sampleSize` bytes for audio of fixed blocks), with an idx1 index.
 */
function aviFile({
    type,
    handler,
    format,
    scale,
    rate,
    sampleSize = 0,
    width = 0,
    height = 0,
    chunks,
}) {
    const id = type === 'vids' ? '00dc' : '00wb';
    const largest = Math.max(...chunks.map(entry => entry.data.length));
    const avih = bytes(
        le32(type === 'vids' ? Math.round((1e6 * scale) / rate) : 0),
        zeros(8),
        le32(0x10),
        le32(type === 'vids' ? chunks.length : 0),
        zeros(4),
        le32(1),
        le32(largest),
        le32(width),
        le32(height),
        zeros(16),
    );
    const strh = bytes(
        ascii(type),
        ascii(handler),
        zeros(12),
        le32(scale),
        le32(rate),
        zeros(4),
        le32(chunks.length),
        le32(largest),
        le32(0xffffffff),
        le32(sampleSize),
        zeros(4),
        le16(width),
        le16(height),
    );
    const index = [];
    let offset = 4;
    for (const { data, key } of chunks) {
        index.push(...ascii(id), ...le32(key ? 0x10 : 0), ...le32(offset), ...le32(data.length));
        offset += 8 + data.length + (data.length & 1);
    }
    return chunk(
        'RIFF',
        ascii('AVI '),
        list('hdrl', chunk('avih', avih), list('strl', chunk('strh', strh), chunk('strf', format))),
        list('movi', ...chunks.map(entry => chunk(id, entry.data))),
        chunk('idx1', index),
    );
}

/** BITMAPINFOHEADER of `fourcc` at `width` x `height`, with its codec data after it. */
const bitmapInfo = (fourcc, width, height, extra) =>
    bytes(
        le32(40 + extra.length),
        le32(width),
        le32(height),
        le16(1),
        le16(24),
        ascii(fourcc),
        le32(width * height * 3),
        zeros(16),
        extra,
    );

/** WAVEFORMATEX of `tag`, with its codec data after it (cbSize). */
const waveFormatEx = ({ tag, channels, rate, bytesPerSecond, blockAlign, bitsPerSample }, extra) =>
    bytes(
        le16(tag),
        le16(channels),
        le32(rate),
        le32(bytesPerSecond),
        le16(blockAlign),
        le16(bitsPerSample),
        le16(extra.length),
        extra,
    );

// HEVC with Dolby Vision (ISO/IEC 14496-15 § 8.3; Dolby Vision streams within the ISO base media
// file format, version 2.4).

/**
 * HEVCDecoderConfigurationRecord of Main 10, level 3.1, 4:2:0, four-byte lengths, without
 * parameter set arrays.
 */
const HEVC_RECORD = [
    1, 0x02, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xfa, 0xfa, 0, 0, 0x0f, 0,
];

/**
 * Dolby Vision configuration (dvcC): version 1.0, profile 5 (no cross-compatible base layer, so
 * the entry is dvh1 or dvhe), level 6, RPU and base layer present, no enhancement layer.
 */
const DOLBY_VISION_RECORD = [1, 0, ...be16((5 << 9) | (6 << 3) | 0b101), zeros(20)].flat();

/** A NAL unit of `type` (layer 0, temporal id 0) after its four-byte length. */
const hevcNal = (type, payload) => [...be32(payload.length + 2), (type << 1) & 0x7e, 1, ...payload];

/** A picture: an IDR (type 19) or trailing (type 1) slice and the Dolby Vision RPU (type 62). */
const dolbyVisionPicture = idr =>
    bytes(hevcNal(idr ? 19 : 1, [0xaf, ...filler(14)]), hevcNal(62, [0x19, 0x08, ...filler(10)]));

function dolbyVision(entry) {
    const pictures = [true, false, false, true, false];
    return isoFile({
        brands: [...MP4, 'dby1'],
        handler: 'vide',
        width: 32,
        height: 24,
        timescale: 1000,
        entry: visualEntry(
            entry,
            32,
            24,
            box('hvcC', HEVC_RECORD),
            box('dvcC', DOLBY_VISION_RECORD),
        ),
        samples: pictures.map(idr => ({ data: dolbyVisionPicture(idr), duration: 40, sync: idr })),
    });
}

// VVC (ISO/IEC 14496-15 § 11): the record of hand-built VPS, SPS and PPS (Main 10, level 3.1,
// 32x24) and IDR and trailing slices, as test/pipeline/copy.test.mjs builds them.

const VVC_RECORD = hex(
    'ff00115f0102338000002000180000038e00010004007110048f0001000c0079000b0233800001086470' +
        '900001000400810020',
);
const VVC_IDR = hex('0039af133742');
const VVC_TRAIL = hex('0009215c0d');

function vvc(entry) {
    const pictures = [VVC_IDR, VVC_TRAIL, VVC_TRAIL, VVC_IDR];
    return isoFile({
        brands: MP4,
        handler: 'vide',
        width: 32,
        height: 24,
        timescale: 1000,
        entry: visualEntry(entry, 32, 24, fullBox('vvcC', 0, 0, VVC_RECORD)),
        samples: pictures.map(unit => ({
            data: bytes(be32(unit.length), unit),
            duration: 40,
            sync: unit === VVC_IDR,
        })),
    });
}

// Windows Media Video 9 and VC-1 (SMPTE 421M) in AVI.

/**
 * WMV9 Main profile sequence header (STRUCT_C, SMPTE 421M Annex J): profile, the rate and bit-rate
 * quantizers, loop filter, the reserved RES_FASTTX and RES_RTM_FLAG set, variable-size transform,
 * no B frames, range reduction or frame interpolation.
 */
const WMV3_SEQUENCE = bits([
    [2, 1],
    [2, 0],
    [3, 7],
    [5, 31],
    [1, 1],
    [2, 0],
    [1, 1],
    [4, 0],
    [1, 1],
    [4, 0],
    [3, 0],
    [2, 0],
    [1, 0],
    [1, 1],
]);

/**
 * Advanced profile sequence header (SMPTE 421M § 6.1.1, after its 0x0000010F start code): level 1,
 * 4:2:0, a 32x24 maximum coded size, progressive, then the stuffing bits of its unit.
 */
const VC1_SEQUENCE = bits([
    [2, 3],
    [3, 1],
    [2, 1],
    [3, 0],
    [5, 0],
    [1, 0],
    [12, 32 / 2 - 1],
    [12, 24 / 2 - 1],
    [4, 0],
    [1, 1],
    [3, 0],
    [8, 0x80],
]);

/** Entry point header (§ 6.2.1): a closed entry point, every tool off, then stuffing. */
const VC1_ENTRY_POINT = bits([
    [1, 0],
    [1, 1],
    [14, 0],
    [8, 0x80],
]);

/**
 * WMV9 frames carry FRMCNT and the one-bit PTYPE (0 for I, 1 for P) first; advanced profile frames
 * follow a frame start code with PTYPE 110 for I and 0 for P.
 */
function windowsMediaVideo(codec) {
    const advanced = codec === 'vc1';
    const keys = [true, false, false, true, false];
    const frame = key =>
        advanced
            ? bytes([0, 0, 1, 0x0d, key ? 0xc0 : 0x40], filler(24))
            : bytes([key ? 0x00 : 0x20], filler(24));
    return aviFile({
        type: 'vids',
        handler: advanced ? 'WVC1' : 'WMV3',
        format: bitmapInfo(
            advanced ? 'WVC1' : 'WMV3',
            32,
            24,
            advanced
                ? bytes([0, 0, 1, 0x0f], VC1_SEQUENCE, [0, 0, 1, 0x0e], VC1_ENTRY_POINT)
                : WMV3_SEQUENCE,
        ),
        scale: 1,
        rate: 25,
        width: 32,
        height: 24,
        chunks: keys.map(key => ({ data: frame(key), key })),
    });
}

// Windows Media Audio 9 Professional, Lossless and Voice in AVI: WAVEFORMATEX with the codec data
// their decoders read (bits per sample, channel mask and decode flags; WMA Voice's 46 bytes), and
// blocks of `blockAlign` bytes.

const WMA = {
    wmapro: {
        format: {
            tag: 0x162,
            channels: 2,
            rate: 48000,
            bytesPerSecond: 12000,
            blockAlign: 512,
            bitsPerSample: 16,
        },
        extra: bytes(le16(16), le32(3), zeros(8), le16(0xe0), zeros(2)),
    },
    wmalossless: {
        format: {
            tag: 0x163,
            channels: 2,
            rate: 48000,
            bytesPerSecond: 12000,
            blockAlign: 512,
            bitsPerSample: 16,
        },
        extra: bytes(le16(16), le32(3), zeros(8), le16(0xe0), zeros(2)),
    },
    // Blocks of 60 ms: three 160-sample frames at 8 kHz.
    wmavoice: {
        format: {
            tag: 0x0a,
            channels: 1,
            rate: 8000,
            bytesPerSecond: 1000,
            blockAlign: 60,
            bitsPerSample: 16,
        },
        extra: bytes(zeros(18), le32(0x1000), zeros(24)),
    },
};

function windowsMediaAudio(codec) {
    const { format, extra } = WMA[codec];
    return aviFile({
        type: 'auds',
        handler: '\0\0\0\0',
        format: waveFormatEx(format, extra),
        scale: format.blockAlign,
        rate: format.bytesPerSecond,
        sampleSize: format.blockAlign,
        chunks: Array.from({ length: 6 }, (_, index) => ({
            data: bytes([index + 1], filler(format.blockAlign - 1)),
            key: true,
        })),
    });
}

// DTS-HD and DTS Express in MP4 (ETSI TS 102 114 Annex E): the entry names the variant, ddts its
// rate, bit rates, sample depth, frame duration, core and channel layout; each access unit is a
// core frame and its extension substream (dtsh, and dtsl with an XLL lossless asset) or the
// substream alone (dtse, with an LBR asset), as ./sync-audio-fixtures.mjs builds them.

async function dtsHd(codec) {
    const { dtsCore, dtsSubstream, LBR_SYNC, XLL_SYNC } = await import('./sync-audio-fixtures.mjs');
    const express = codec === 'dtse';
    const unit = () =>
        express
            ? dtsSubstream({ bytes: 96, sampleRateCode: 12, channels: 6, sync: LBR_SYNC })
            : bytes(dtsCore(), dtsSubstream(codec === 'dtsl' ? { sync: XLL_SYNC } : {}));
    const size = unit().length;
    const bitrate = (size * 8 * 48000) / 512;
    const ddts = bytes(
        be32(48000),
        be32(bitrate),
        be32(bitrate),
        [codec === 'dtsl' ? 24 : 16],
        bits([
            [2, 0],
            [5, 0],
            [1, 0],
            [6, express ? 0 : 2],
            [14, express ? 0 : 256],
            [1, 0],
            [3, 0],
            [16, express ? 0x000f : 0x0002],
            [8, 0],
        ]),
    );
    return isoFile({
        brands: MP4,
        handler: 'soun',
        timescale: 48000,
        entry: audioEntry(codec, express ? 6 : 2, 48000, box('ddts', ddts)),
        samples: Array.from({ length: 6 }, () => ({ data: unit(), duration: 512 })),
    });
}

// MPEG-H 3D audio in MP4 (ISO/IEC 23008-3 § 20): mhaC with the configuration's start (Low
// Complexity level 3, 48 kHz, 1024-sample frames, the CICP stereo layout); mha1 access units are
// frames, mhm1 ones MHAS packets (the configuration first, then each frame).

const MPEGH_CONFIG = bits([
    [8, 0x0d],
    [5, 3],
    [3, 1],
    [1, 0],
    [1, 0],
    [2, 0],
    [6, 2],
    [6, 0],
]);
const MPEGH_RECORD = bytes([1, 0x0d, 2], be16(MPEGH_CONFIG.length), MPEGH_CONFIG);

/** An MHAS packet of `type` and label 1 (escaped values of 3, 2 and 11 bits). */
const mhasPacket = (type, payload) =>
    bytes(
        bits([
            [3, type],
            [2, 1],
            [11, payload.length],
        ]),
        payload,
    );

function mpegH(entry) {
    const frame = index => bytes([index + 1], filler(63));
    return isoFile({
        brands: MP4,
        handler: 'soun',
        timescale: 48000,
        entry: audioEntry(entry, 0, 48000, box('mhaC', MPEGH_RECORD)),
        samples: Array.from({ length: 6 }, (_, index) => ({
            data:
                entry === 'mha1'
                    ? frame(index)
                    : bytes(index ? [] : mhasPacket(1, MPEGH_CONFIG), mhasPacket(2, frame(index))),
            duration: 1024,
        })),
    });
}

// EVRC and QCELP in MP4 as ffmpeg and the library carry them: an mp4a entry whose esds names the
// object type (0xD1, 0xE1) without decoder information; each sample one full-rate frame of 20 ms
// (160 samples at 8 kHz), its rate byte (4) first (3GPP2 C.S0050).

function speech(codec) {
    const [objectType, frameBytes, bitrate] =
        codec === 'evrc' ? [0xd1, 23, 9200] : [0xe1, 35, 14000];
    const esds = fullBox('esds', 0, 0, [
        3,
        21,
        0,
        1,
        0,
        4,
        13,
        objectType,
        0x15,
        0,
        0,
        0,
        ...be32(bitrate),
        ...be32(bitrate),
        6,
        1,
        2,
    ]);
    return isoFile({
        brands: ['3g2a', '3g2a', 'isom'],
        handler: 'soun',
        timescale: 8000,
        entry: audioEntry('mp4a', 1, 8000, esds),
        samples: Array.from({ length: 10 }, () => ({
            data: bytes([4], filler(frameBytes - 1)),
            duration: 160,
        })),
    });
}

/** ProRes RAW (`aprn` or `aprh`) in MOV: three frames of ./prores-raw-fixtures.mjs at 25 fps. */
export async function proResRawMovie(codec) {
    const { proResRawFrames } = await import('./prores-raw-fixtures.mjs');
    return isoFile({
        brands: ['qt  ', 'qt  '],
        handler: 'vide',
        width: 32,
        height: 24,
        timescale: 1000,
        entry: visualEntry(codec, 32, 24),
        samples: [0, 1, 2].map(() => ({ data: proResRawFrames[codec], duration: 40 })),
    });
}

/** The structural stream of each codec, a function returning its file (or a promise of it). */
export const structuralStreams = {
    dvh1: () => dolbyVision('dvh1'),
    dvhe: () => dolbyVision('dvhe'),
    vvc1: () => vvc('vvc1'),
    vvi1: () => vvc('vvi1'),
    wmv3: () => windowsMediaVideo('wmv3'),
    vc1: () => windowsMediaVideo('vc1'),
    wmapro: () => windowsMediaAudio('wmapro'),
    wmalossless: () => windowsMediaAudio('wmalossless'),
    wmavoice: () => windowsMediaAudio('wmavoice'),
    dtsh: () => dtsHd('dtsh'),
    dtsl: () => dtsHd('dtsl'),
    dtse: () => dtsHd('dtse'),
    mha1: () => mpegH('mha1'),
    mhm1: () => mpegH('mhm1'),
    evrc: () => speech('evrc'),
    qcelp: () => speech('qcelp'),
};
