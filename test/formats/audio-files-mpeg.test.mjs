import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, inspect, open } from 'mediaforgejs';
import { encodeMp3 } from 'mediaforgejs/codecs';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import { allPackets, bytesOf, readMedia } from '../helpers/read-media.mjs';

const rejectsStrict = input =>
    assert.rejects(open(input, { validation: 'strict' }), error => error.code === 'DEMUX');

const payloads = packets => packets.map(packet => packet.data);
const latin1 = text => [...text].map(char => char.charCodeAt(0));
const syncsafe = value => [
    (value >> 21) & 127,
    (value >> 14) & 127,
    (value >> 7) & 127,
    value & 127,
];

/** An ID3v2 tag of `version` and `flags` around `body`, with a footer if asked. */
function id3(version, flags, body, footer = false) {
    const header = [...latin1('ID3'), version, 0, flags, ...syncsafe(body.length)];
    return Uint8Array.from([
        ...header,
        ...body,
        ...(footer ? [...latin1('3DI'), ...header.slice(3)] : []),
    ]);
}

/** A TIT2 frame of `payload` in ID3v2 `version`. */
const tit2 = (version, flags, payload) => [
    ...latin1('TIT2'),
    ...(version === 4 ? syncsafe(payload.length) : [0, 0, 0, payload.length]),
    0,
    flags,
    ...payload,
];

/** Bytes of `[value, bit count]` fields, most significant bit first. */
function bitBytes(fields) {
    const bits = fields.flatMap(([value, count]) =>
        Array.from({ length: count }, (_, bit) => (value >> (count - 1 - bit)) & 1),
    );
    while (bits.length % 8) bits.push(0);
    return Array.from({ length: bits.length / 8 }, (_, index) =>
        bits.slice(index * 8, index * 8 + 8).reduce((value, bit) => value * 2 + bit, 0),
    );
}

/** mp3-id3v1.mp3, its packets and where its audio frames start. */
async function plainMp3() {
    const plain = fixtures['mp3-id3v1.mp3']();
    const packets = await allPackets(plain);
    const frames = plain.length - packets.reduce((sum, packet) => sum + packet.data.length, 0);
    return { plain, packets, frames };
}

describe('audio files: MP3 and ADTS', () => {
    test('takes the title of an ID3v2 tag in front of MP3', async () => {
        const { title, tracks } = await readMedia(fixtures['mp3-id3.mp3']());
        assert.equal(title, 'Tagged');
        assert.equal(tracks[0].packets.length, 5);
    });

    test('takes the title of an ID3v1 trailer and reads none without one', async () => {
        const { plain } = await plainMp3();
        const v1 = new Uint8Array(plain.length + 128);
        v1.set(plain);
        v1.set(new TextEncoder().encode('TAGLegacy title'), plain.length);
        assert.equal((await readMedia(v1)).title, 'Legacy title');
        assert.equal((await readMedia(plain)).title, undefined);
    });

    test('an ID3v1 tag is the last 128 bytes, also over a cut frame; spaces are text', async () => {
        const { plain } = await plainMp3();
        const overlapping = Uint8Array.from([
            ...plain.subarray(0, plain.length - 40),
            ...latin1('TAG Low Rider'),
            ...new Array(115).fill(0),
        ]);
        assert.equal((await readMedia(overlapping)).title, ' Low Rider');
    });

    test('detects a stream captured inside a frame and reads from the next one', async () => {
        const { plain, packets } = await plainMp3();
        const midFrame = plain.subarray(
            plain.length -
                packets.slice(1).reduce((sum, packet) => sum + packet.data.length, 0) -
                7,
        );
        const read = await readMedia(midFrame);
        assert.equal(read.format, 'mp3');
        assert.deepEqual(payloads(read.tracks[0].packets), payloads(packets.slice(1)));
        await rejectsStrict(midFrame);
    });

    test('bytes skipped between frames mark the track incomplete', async () => {
        // A frame that then fails to decode is concealed.
        const { plain, packets, frames } = await plainMp3();
        const junkAt = frames + packets[0].data.length;
        const junked = Uint8Array.from([
            ...plain.subarray(0, junkAt),
            1,
            2,
            3,
            4,
            5,
            ...plain.subarray(junkAt),
        ]);
        const { tracks } = await readMedia(junked);
        assert.deepEqual(payloads(tracks[0].packets), payloads(packets));
        assert.equal(tracks[0].track.incomplete, true);
        assert.equal((await readMedia(plain)).tracks[0].track.incomplete, undefined);
    });

    for (const [label, tag] of [
        [
            'a v2.4 tag with a footer',
            id3(4, 0x10, tit2(4, 0, [0, ...latin1('Sync\xff\xe9 title')]), true),
        ],
        [
            'a v2.4 tag with unsynchronised frames',
            id3(
                4,
                0x80,
                tit2(
                    4,
                    2,
                    [0, ...latin1('Sync\xff\xe9 title')].flatMap((byte, at, bytes) =>
                        byte === 255 && (bytes[at + 1] ?? 0) >= 0xe0 ? [255, 0] : [byte],
                    ),
                ),
            ),
        ],
        [
            'a v2.3 unsynchronised tag with an extended header',
            id3(
                3,
                0xc0,
                [
                    0,
                    0,
                    0,
                    6,
                    0,
                    0,
                    0,
                    0,
                    0,
                    4,
                    ...tit2(3, 0, [0, ...latin1('Sync\xff\xe9 title')]),
                    0,
                    0,
                    0,
                    0,
                ].flatMap((byte, at, bytes) =>
                    byte === 255 && (bytes[at + 1] ?? 0) >= 0xe0 ? [255, 0] : [byte],
                ),
            ),
        ],
    ])
        test(`takes the title of ${label} and reads the audio after it`, async () => {
            const { plain, packets } = await plainMp3();
            const read = await readMedia(Uint8Array.from([...tag, ...plain]));
            assert.equal(read.title, 'Syncÿé title');
            assert.deepEqual(payloads(read.tracks[0].packets), payloads(packets));
        });

    test('takes the TT2 title of an ID3v2.2 tag, spaces included', async () => {
        // iTunes still writes ID3v2.2, of three-character frame ids.
        const { plain, packets } = await plainMp3();
        const v22 = Uint8Array.from([
            ...latin1('ID3'),
            2,
            0,
            0,
            ...syncsafe(18),
            ...latin1('TT2'),
            0,
            0,
            12,
            0,
            ...latin1(' iTunes 7rk'),
        ]);
        const read = await readMedia(Uint8Array.from([...v22, ...plain]));
        assert.equal(read.title, ' iTunes 7rk');
        assert.deepEqual(payloads(read.tracks[0].packets), payloads(packets));
    });

    test('a VBRI information frame is not an audio packet', async () => {
        // An MPEG-2.5 layer III frame at 64 kbps and 8 kHz is 576 bytes, long enough for the VBRI
        // header at offset 36; it takes the place of the fixture's LAME Info frame.
        const { plain, packets, frames } = await plainMp3();
        const audio = plain.subarray(frames);
        const vbri = new Uint8Array(576);
        vbri.set([0xff, 0xe3, 0x88, 0xc0]);
        vbri.set([...latin1('VBRI'), 0, 1, 0, 0, 0, 75], 36);
        new DataView(vbri.buffer).setUint32(46, audio.length + vbri.length);
        new DataView(vbri.buffer).setUint32(50, packets.length);
        const read = await readMedia(Uint8Array.from([...vbri, ...audio]));
        assert.deepEqual(payloads(read.tracks[0].packets), payloads(packets));
        assert.equal(
            read.tracks[0].track.duration,
            (await readMedia(plain)).tracks[0].track.duration,
        );
    });

    test('an APEv2 trailer is not a damaged audio tail', async () => {
        const { plain, packets } = await plainMp3();
        const ape = (items, flags) => [
            ...latin1('APETAGEX'),
            ...[208, 7, 0, 0],
            ...[items.length + 32, 0, 0, 0],
            ...[1, 0, 0, 0],
            ...[0, 0, 0, flags],
            ...new Array(8).fill(0),
        ];
        const item = [5, 0, 0, 0, 0, 0, 0, 0, ...latin1('Title'), 0, ...latin1('Tail!')];
        const tagged = Uint8Array.from([...plain, ...ape(item, 0xa0), ...item, ...ape(item, 0x80)]);
        const { tracks, warnings } = await readMedia(tagged);
        assert.deepEqual(warnings, []);
        assert.deepEqual(payloads(tracks[0].packets), payloads(packets));
        (await open(tagged, { validation: 'strict' })).close();
    });

    test('keeps every frame of a stream that turns from mono to stereo, and warns', async () => {
        const { plain, packets, frames } = await plainMp3();
        const switched = plain.slice();
        const mono = (switched[frames + 3] & 0xc0) === 0xc0;
        let at = frames;
        packets.forEach((packet, index) => {
            if (index >= 2) switched[at + 3] = (switched[at + 3] & 0x3f) | (mono ? 0 : 0xc0);
            at += packet.data.length;
        });
        const plainWarnings = (await readMedia(plain)).warnings;
        const { tracks, warnings } = await readMedia(switched);
        assert.equal(tracks[0].packets.length, packets.length);
        assert.equal(tracks[0].track.channelCount, 2);
        const without = codes => codes.filter(code => code !== 'MPEG_GAPLESS_METADATA');
        assert.deepEqual(without(warnings), [
            ...without(plainWarnings),
            'MPEG_CHANNEL_MODE_CHANGED',
        ]);
    });

    for (const [rate, channels, kbps] of [
        [48000, 2, 128],
        [44100, 2, 320],
        [48000, 1, 64],
        [32000, 2, 96],
    ])
        test(`decodes all frames of the library's ${rate} Hz ${channels}-channel MP3`, async () => {
            // The LAME Info frame states the encoder delay and padding, which decoding trims; the
            // Info frame is no audio packet.
            const frames = rate;
            const bytes = await encodeMp3(
                Array.from({ length: channels }, () => new Float32Array(frames)),
                { sampleRate: rate, bitrate: kbps },
            );
            const expected = Math.ceil(frames / 1152) + 1;
            const warnings = [];
            const media = await open(bytes, {
                validation: 'strict',
                onWarning: warning => warnings.push(warning.code),
            });
            try {
                assert.deepEqual(
                    [
                        media.tracks[0].codec,
                        media.tracks[0].sampleRate,
                        media.tracks[0].channelCount,
                    ],
                    ['mp3', rate, channels],
                );
            } finally {
                media.close();
            }
            assert.deepEqual(warnings, []);
            const wav = await bytesOf(await convert(bytes, { to: 'wav' }));
            const data = Buffer.from(wav).indexOf('data');
            assert.equal(
                new DataView(wav.buffer).getUint32(data + 4, true) / (2 * channels),
                frames,
            );
            assert.equal(
                (await inspect(bytes, { sampleCounts: true })).tracks[0].sampleCount,
                expected,
            );
        });

    test('an MP3 without its Info frame keeps every frame and warns: no gapless data', async () => {
        const bytes = await encodeMp3([new Float32Array(48000)], {
            sampleRate: 48000,
            bitrate: 64,
        });
        const infoFrame = Math.floor((144 * 64 * 1000) / 48000);
        const stripped = bytes.subarray(infoFrame);
        const { warnings } = await readMedia(stripped);
        assert.deepEqual(warnings, ['MPEG_GAPLESS_METADATA']);
        assert.equal(
            (await inspect(stripped, { sampleCounts: true })).tracks[0].sampleCount,
            Math.ceil(48000 / 1152) + 1,
        );
    });

    test('takes the title of an ID3v2 tag in front of ADTS', async () => {
        const { title, tracks } = await readMedia(fixtures['adts-id3.aac']());
        assert.equal(title, 'Stream');
        assert.equal(tracks[0].packets.length, 2);
    });

    test('an ADTS header that disagrees with the stream ends it as a damaged tail', async () => {
        const source = fixtures['adts-id3.aac']();
        const packets = await allPackets(source);
        const flipped = source.slice();
        flipped[flipped.length - packets[1].data.length - 7 + 2] ^= 0x3c;
        const { tracks, warnings } = await readMedia(flipped);
        assert.deepEqual(warnings, ['AUDIO_TRUNCATED_TAIL']);
        assert.deepEqual(payloads(tracks[0].packets), payloads(packets.slice(0, 1)));
        await rejectsStrict(flipped);
    });

    test('ADTS channel configuration 0 takes its layout from the program config', async () => {
        // The program config element opens the raw data block (one channel pair here) and goes
        // into the AudioSpecificConfig behind its GASpecificConfig.
        const pce = [
            [0, 4],
            [1, 2],
            [3, 4],
            [1, 4],
            [0, 4],
            [0, 4],
            [0, 2],
            [0, 3],
            [0, 4],
            [0, 3],
            [1, 1],
            [0, 4],
        ];
        const rawBlock = bitBytes([[5, 3], ...pce, [0, 6], [0, 8], [7, 3]]);
        const frame = payload => {
            const length = payload.length + 7;
            return [
                0xff,
                0xf1,
                0x4c,
                length >> 11,
                (length >> 3) & 255,
                ((length & 7) << 5) | 31,
                0xfc,
                ...payload,
            ];
        };
        const { tracks } = await readMedia(
            Uint8Array.from([...frame(rawBlock), ...frame(rawBlock)]),
        );
        const { track, packets } = tracks[0];
        assert.deepEqual(
            [track.codec, track.sampleRate, track.channelCount],
            ['mp4a.40.2', 48000, 2],
        );
        assert.deepEqual(
            [...track.codecConfig],
            bitBytes([[2, 5], [3, 4], [0, 4], [0, 3], ...pce, [0, 1], [0, 8]]),
        );
        assert.deepEqual(
            packets.map(packet => [...packet.data]),
            [rawBlock, rawBlock],
        );
    });
});
