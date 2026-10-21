import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { open } from 'mediaforgejs';
import {
    AAC_PAYLOADS,
    adtsFrame,
    concat,
    oggFixture,
    oggPage,
    originalFixtures,
    seededBytes,
    tsFixture,
} from '../helpers/original-fixtures.mjs';

// The original fixtures damaged in known ways: structures no reader can read fail with DEMUX or
// FORMAT, damage a reader recovers from is read with a warning in compatible validation and fails
// strict validation, and every reader keeps to the index limits of the open.

const manifest = JSON.parse(
    readFileSync(new URL('../fixtures/formats/original-fixtures.json', import.meta.url), 'utf8'),
);
const hex = bytes => Buffer.from(bytes).toString('hex');
const formatOf = name => manifest.files.find(entry => entry.name === name).format;

/** The packets and warnings of `bytes` read with `options`. */
async function readAll(bytes, options = {}) {
    const media = await open(bytes, options);
    try {
        const packets = [];
        for await (const packet of media.packets()) packets.push(packet);
        return { tracks: media.tracks, warnings: media.warnings.map(item => item.code), packets };
    } finally {
        media.close();
    }
}

/** Asserts that `bytes` fail to open as `format` with DEMUX or FORMAT in either validation. */
async function assertMalformed(bytes, format) {
    for (const validation of ['compatible', 'strict'])
        await assert.rejects(
            open(bytes, {
                format,
                validation,
                maxSamples: 64,
                maxIndexBytes: 65536,
                maxPacketBytes: 4096,
            }),
            error => ['DEMUX', 'FORMAT'].includes(error.code),
            validation,
        );
}

/** Asserts that strict validation refuses `bytes` with DEMUX. */
const rejectsStrict = (bytes, options = {}) =>
    assert.rejects(open(bytes, { ...options, validation: 'strict' }), { code: 'DEMUX' });

describe('formats: the original fixtures damaged', () => {
    describe('structures no reader can read', () => {
        for (const [name, file, offset, replacement] of [
            ['an RF64 sentinel without ds64', 'stereo-pcm.rf64.wav', 12, [0, 0, 0, 0]],
            ['an AIFF FORM extent past the input', 'mono-pcm.aiff', 4, [127, 255, 255, 255]],
            ['AU data that overlaps its header', 'mono-pcm.au', 4, [0, 0, 0, 23]],
            [
                'a CAF desc of an impossible extent',
                'float-stereo.caf',
                12,
                [127, 255, 255, 255, 255, 255, 255, 255],
            ],
            ['ADTS of several raw data blocks', 'four-frames.aac', 6, [0xfd]],
            ['a FLAC STREAMINFO cut short', 'constant-steps.flac', 5, [255, 255, 255]],
            ['an Ogg page of a wrong CRC', 'three-packets.opus', 22, [0, 0, 0, 0]],
            ['an Ogg first page not numbered 0', 'three-packets.opus', 18, [1, 0, 0, 0]],
            ['an EBML size marker of zero', 'audio-and-captions.mkv', 4, [0]],
            ['an FLV first tag past the input', 'aac-tags.flv', 14, [255, 255, 255]],
            ['an MP4 box smaller than its header', 'classic-aac.mp4', 0, [0, 0, 0, 4]],
        ])
            test(`${name} fails with DEMUX or FORMAT`, async () => {
                const bytes = originalFixtures[file]();
                bytes.set(replacement, offset);
                await assertMalformed(bytes, formatOf(file));
            });

        test('the first 8 bytes of each fixture fail with DEMUX or FORMAT', async () => {
            for (const entry of manifest.files)
                await assertMalformed(originalFixtures[entry.name]().subarray(0, 8), entry.format);
        });
    });

    describe('Ogg chains', () => {
        test('a second Opus link plays after the first, trimmed by its own granule', async () => {
            // It restarts serial, page sequence and granules and adds a 120-sample pre-skip.
            const chained = concat(oggFixture(), oggFixture({ trimmed: true, serial: 0x4d463431 }));
            const media = await open(chained, { format: 'opus' });
            try {
                assert.equal(media.tracks[0].duration, 660 / 48000);
                const packets = [];
                for await (const packet of media.packets())
                    packets.push([hex(packet.data), packet.timestamp * 48000]);
                assert.deepEqual(packets, [
                    ['803101', 0],
                    ['803202', 120],
                    ['803303', 240],
                    ['803101', 360],
                    ['803202', 480],
                    ['803303', 600],
                ]);
                assert.deepEqual(
                    media.warnings.map(item => [item.code, /120 samples/.test(item.message)]),
                    [['OGG_CHAINED_STREAMS', true]],
                );
            } finally {
                media.close();
            }
            await rejectsStrict(chained, { format: 'opus' });
        });

        test('a link whose setup cannot continue the track ends it', async () => {
            const changed = concat(oggFixture(), oggFixture({ serial: 0x4d463431, channels: 2 }));
            const { tracks, warnings, packets } = await readAll(changed, { format: 'opus' });
            assert.deepEqual(warnings, ['OGG_CHAIN_OMITTED']);
            assert.deepEqual([packets.length, tracks[0].channelCount], [3, 1]);
            await rejectsStrict(changed, { format: 'opus' });
        });

        test('an Opus stream that starts after zero is placed by its first granule', async () => {
            // As one FFmpeg's concat demuxer joins from files, and where FFmpeg times it.
            const text = value => new TextEncoder().encode(value);
            const opusHead = concat(text('OpusHead'), [1, 1, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0]);
            const opusTags = concat(text('OpusTags'), [0, 0, 0, 0, 0, 0, 0, 0]);
            const audio = [0x31, 0x32, 0x33].map(byte => Uint8Array.of(0x80, byte, 1));
            const later = concat(
                oggPage([opusHead], 0, { flags: 2 }),
                oggPage([opusTags], 1),
                oggPage(audio, 2, { granule: 120 + 360 }),
                oggPage(audio, 3, { flags: 4, granule: 120 + 720 }),
            );
            for (const validation of ['compatible', 'strict']) {
                const { tracks, warnings, packets } = await readAll(later, {
                    format: 'opus',
                    validation,
                });
                assert.deepEqual(
                    packets.map(packet => packet.timestamp * 48000),
                    [120, 240, 360, 480, 600, 720],
                );
                assert.deepEqual(warnings, []);
                assert.equal(Math.round(tracks[0].duration * 48000), 840);
            }
        });

        test('bytes after the last page are no link', async () => {
            const trailing = concat(oggFixture(), new Uint8Array(40));
            const { warnings, packets } = await readAll(trailing, { format: 'opus' });
            assert.deepEqual([warnings, packets.length], [['OGG_TRAILING_BYTES'], 3]);
            await rejectsStrict(trailing, { format: 'opus' });
        });
    });

    describe('MPEG-TS', () => {
        for (const [at, value] of [
            [3, 0x80],
            [4, 0xff],
        ])
            test(`a PES header whose byte ${at} is damaged loses that PES`, async () => {
                // A bit that marks it scrambled or overlong, as a transport error does.
                const bytes = tsFixture();
                bytes[4 * 188 + at] |= value;
                const { warnings, packets } = await readAll(bytes, { format: 'ts' });
                assert.ok(warnings.includes('TS_PES_DAMAGED'), `${warnings}`);
                assert.equal(packets.filter(packet => packet.data.length > 0).length, 3);
                await rejectsStrict(bytes, { format: 'ts' });
            });

        test('a transport packet lost from a PES loses that PES', async () => {
            const bytes = originalFixtures['aac-transport.ts']();
            const missing = concat(bytes.subarray(0, 188 * 3), bytes.subarray(188 * 4));
            const { warnings, packets } = await readAll(missing);
            assert.ok(warnings.includes('TS_PES_CONTINUITY'), `${warnings}`);
            assert.deepEqual(
                packets.map(packet => [packet.timestamp, hex(packet.data)]),
                [
                    [0, '0100107f'],
                    [2048 / 48000, '0122307d'],
                    [3072 / 48000, '0133407c'],
                ],
            );
            await rejectsStrict(missing);
        });
    });

    test('ADTS finds the next frame past bytes between frames', async () => {
        for (const length of [1, 7, 33, 64]) {
            const gap = seededBytes(length, 0x4d463500 + length).map(byte => byte & 127);
            const bytes = concat(
                adtsFrame(AAC_PAYLOADS[0]),
                gap,
                ...AAC_PAYLOADS.slice(1).map(payload => adtsFrame(payload)),
            );
            const media = await open(bytes);
            try {
                assert.deepEqual(
                    media.warnings.map(item => [item.code, item.offset]),
                    [['ADTS_RESYNCHRONIZED', 11]],
                );
                const packets = [];
                for await (const packet of media.packets()) packets.push(hex(packet.data));
                assert.deepEqual(packets, ['0100107f', '0111207e', '0122307d', '0133407c']);
            } finally {
                media.close();
            }
            await assert.rejects(open(bytes, { validation: 'strict' }), {
                code: 'DEMUX',
                message: /Invalid aac frame at/,
            });
        }
    });

    for (const [name, warning] of [
        ['stereo-pcm.wav', 'WAV_TRAILING_BYTES'],
        ['mono-pcm.aiff', 'AIFF_TRAILING_BYTES'],
        ['mono-pcm.au', 'AU_TRAILING_BYTES'],
    ])
        test(`bytes after the audio of ${name} are left with ${warning}`, async () => {
            const bytes = concat(originalFixtures[name](), seededBytes(19));
            const { warnings, packets } = await readAll(bytes);
            assert.deepEqual(warnings, [warning]);
            assert.deepEqual(
                packets.map(packet => packet.data.length),
                [16],
            );
            await rejectsStrict(bytes);
        });

    test('each fixture opens within maxSamples of its packets and not one fewer', async () => {
        for (const entry of manifest.files) {
            const bytes = originalFixtures[entry.name]();
            const count = entry.packets.length;
            (await open(bytes, { maxSamples: count })).close();
            if (count > 1)
                await assert.rejects(
                    open(bytes, { maxSamples: count - 1 }),
                    { code: 'OOM' },
                    `${entry.name} maxSamples`,
                );
            await assert.rejects(
                open(bytes, { maxIndexBytes: 1 }),
                { code: 'OOM' },
                `${entry.name} maxIndexBytes`,
            );
        }
    });

    test('a packet over maxPacketBytes fails the read that meets it with OOM', async () => {
        await assert.rejects(
            readAll(originalFixtures['classic-aac.mp4'](), { maxPacketBytes: 3 }),
            { code: 'OOM', message: /maxPacketBytes/ },
        );
    });
});
