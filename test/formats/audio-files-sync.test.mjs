import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { concat } from '../helpers/original-fixtures.mjs';
import { ac3Frame } from '../helpers/mpeg-video-fixtures.mjs';
import {
    LBR_SYNC,
    XLL_SYNC,
    dts14,
    dtsCore,
    dtsLittleEndian,
    dtsSubstream,
    eac3Frame,
    waveFile,
    waveFormatEx,
} from '../helpers/sync-audio-fixtures.mjs';
import { readAll } from '../helpers/read-media.mjs';

// Raw Dolby and DTS streams, whose frames carry a sync word: each access unit is one packet,
// whatever word layout stores it and whatever substreams extend it; WAVE names them by format tag.

const hex = bytes => Buffer.from(bytes).toString('hex');
/** Codec, rate and channels of each track. */
const shapes = tracks => tracks.map(track => [track.codec, track.sampleRate, track.channelCount]);

const DTS_FRAMES = Array.from({ length: 3 }, (_, index) => dtsCore({ fill: index + 1 }));
const DTS_STREAM = concat(...DTS_FRAMES);

describe('audio files: sync-word streams', () => {
    for (const [layout, bytes] of [
        ['16-bit big-endian', () => DTS_STREAM],
        ['16-bit little-endian', () => dtsLittleEndian(DTS_STREAM)],
        ['14-bit big-endian', () => concat(...DTS_FRAMES.map(frame => dts14(frame)))],
        ['14-bit little-endian', () => concat(...DTS_FRAMES.map(frame => dts14(frame, true)))],
    ])
        test(`raw DTS stored in ${layout} words reads as 16-bit big-endian units`, async () => {
            const { format, tracks, packets } = await readAll(bytes());
            assert.equal(format, 'dts');
            assert.deepEqual(shapes(tracks), [['dtsc', 48000, 2]]);
            assert.deepEqual(
                packets.map(packet => hex(packet.data)),
                DTS_FRAMES.map(hex),
            );
            assert.deepEqual(
                packets.map(packet => packet.timestamp),
                [0, 512 / 48000, 1024 / 48000],
            );
        });

    test('DTS whose payload holds MPEG audio headers is still DTS', async () => {
        // The frame at the start is confirmed by the next one, while the MPEG-looking bytes are
        // inside it.
        const mpegLike = concat(
            ...Array.from({ length: 4 }, () =>
                concat([0xff, 0xff, 0x40, 0xc0], new Uint8Array(132)),
            ),
        );
        const frame = dtsCore({ bytes: 1024 });
        frame.set(mpegLike, 64);
        const { format, tracks } = await readAll(concat(frame, frame, frame));
        assert.equal(format, 'dts');
        assert.equal(tracks[0].codec, 'dtsc');
    });

    for (const [codec, variant, unit, channels] of [
        ['dtsh', 'DTS-HD', () => concat(dtsCore(), dtsSubstream()), 2],
        ['dtsl', 'lossless (XLL)', () => concat(dtsCore(), dtsSubstream({ sync: XLL_SYNC })), 2],
        [
            'dtse',
            'Express (a substream alone with LBR)',
            () => dtsSubstream({ bytes: 96, sampleRateCode: 12, channels: 6, sync: LBR_SYNC }),
            6,
        ],
    ])
        test(`the extension substream names DTS ${variant} '${codec}'`, async () => {
            // Each access unit includes its substream.
            const { tracks, packets } = await readAll(concat(unit(), unit()));
            assert.deepEqual(shapes(tracks), [[codec, 48000, channels]]);
            assert.deepEqual(
                packets.map(packet => packet.data.length),
                [unit().length, unit().length],
            );
        });

    test('an AC-3 core with an E-AC-3 dependent substream is E-AC-3 as a whole', async () => {
        // Here Lrs/Rrs through the dependent frame's custom channel map, as 7.1 discs carry them:
        // one access unit, the joined channel layout and a dec3 describing both.
        const dependent = index => {
            const frame = eac3Frame(128, index, { dependent: true });
            // dialnorm 0, compre 0, chanmape 1, chanmap 0x0200 (location 6: Lrs/Rrs).
            frame.set([0x10, 0x20, 0x00], 6);
            return frame;
        };
        const unit = index => concat(ac3Frame(index + 1), dependent(index + 1));
        const { format, tracks, packets } = await readAll(concat(unit(0), unit(1), unit(2)));
        assert.equal(format, 'ac3');
        assert.deepEqual(shapes(tracks), [['ec-3', 48000, 4]]);
        assert.equal(hex(tracks[0].codecConfig), '010010040202');
        assert.deepEqual(
            packets.map(packet => hex(packet.data)),
            [0, 1, 2].map(index => hex(unit(index))),
        );
    });

    describe('in WAVE', () => {
        // DTS by format tag 0x2001, AC-3 by 0x2000 and E-AC-3 by its WAVE_FORMAT_EXTENSIBLE GUID.
        const eac3Extensible = concat(
            waveFormatEx(0xfffe).subarray(0, 16),
            [22, 0, 16, 0, 3, 0, 0, 0],
            [
                0xaf, 0x87, 0xfb, 0xa7, 0x02, 0x2d, 0xfb, 0x42, 0xa4, 0xd4, 0x05, 0xcd, 0x93, 0x84,
                0x3b, 0xdd,
            ],
        );
        for (const [label, format, payload, codec] of [
            ['DTS', () => waveFormatEx(0x2001), () => DTS_STREAM, 'dtsc'],
            ['AC-3', () => waveFormatEx(0x2000), () => concat(ac3Frame(1), ac3Frame(2)), 'ac-3'],
            ['E-AC-3', () => eac3Extensible, () => concat(eac3Frame(), eac3Frame()), 'ec-3'],
        ])
            test(`${label} is '${codec}' and keeps every byte`, async () => {
                const read = await readAll(waveFile(format(), payload()));
                assert.equal(read.format, 'wav');
                assert.equal(read.tracks[0].codec, codec);
                assert.equal(
                    concat(...read.packets.map(packet => packet.data)).length,
                    payload().length,
                );
            });
    });
});
