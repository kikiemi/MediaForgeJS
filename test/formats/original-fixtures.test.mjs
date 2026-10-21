import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { inspect, open } from 'mediaforgejs';
import { originalFixtures } from '../helpers/original-fixtures.mjs';

// The original fixtures (test/helpers/original-fixtures.mjs: PCM and FLAC of real sample values,
// payload sentinels for the other codecs) read as their recorded expectations
// (test/fixtures/formats/original-fixtures.json): their bytes, tracks, warnings and every packet,
// with strict validation as with compatible, and copied into the containers recorded for each.

const manifest = JSON.parse(
    readFileSync(new URL('../fixtures/formats/original-fixtures.json', import.meta.url), 'utf8'),
);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = bytes => Buffer.from(bytes).toString('hex');
const near = (actual, [ticks, scale], label) =>
    assert.ok(
        Math.abs(actual - ticks / scale) <= 1e-10,
        `${label}: ${actual} != ${ticks}/${scale}`,
    );

/** Asserts that `actual` has the recorded fields of `expected`. */
function assertTrack(actual, expected, label) {
    for (const [key, value] of Object.entries(expected)) {
        if (key === 'duration') near(actual.duration, value, `${label} duration`);
        else if (key === 'configHex')
            assert.equal(hex(actual.codecConfig), value, `${label} decoder configuration`);
        else assert.deepEqual(actual[key], value, `${label} ${key}`);
    }
}

/** The 16-bit or 32-bit float samples of a PCM packet. */
function pcmValues(packet, track, kind) {
    const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
    const little = track.codec.endsWith('le');
    const width = kind === 's16' ? 2 : 4;
    return Array.from({ length: packet.data.length / width }, (_, index) =>
        kind === 's16'
            ? view.getInt16(index * width, little)
            : view.getFloat32(index * width, little),
    );
}

/** The tracks and the packets of `input`. */
async function readAll(input, options) {
    const media = await open(input, options);
    try {
        const packets = [];
        for await (const packet of media.packets()) packets.push(packet);
        return { media, tracks: media.tracks, warnings: media.warnings, packets };
    } finally {
        media.close();
    }
}

describe('formats: the original fixtures as recorded', () => {
    test('every original fixture has recorded expectations', () => {
        assert.deepEqual(
            Object.keys(originalFixtures).sort(),
            manifest.files.map(entry => entry.name).sort(),
        );
    });

    for (const entry of manifest.files)
        test(`${entry.name} reads and copies as recorded`, async () => {
            const bytes = originalFixtures[entry.name]();
            assert.equal(bytes.length, entry.bytes, 'byte count');
            assert.equal(hash(bytes), entry.sha256, 'bytes');
            assert.deepEqual(originalFixtures[entry.name](), bytes, 'made alike each time');

            const heard = [];
            const read = await readAll(bytes, { onWarning: warning => heard.push(warning.code) });
            const counted = await inspect(bytes, { sampleCounts: true });
            assert.equal(counted.tracks.length, entry.tracks.length, 'track count');
            counted.tracks.forEach((track, index) =>
                assertTrack(track, entry.tracks[index], `track ${index}`),
            );
            assert.deepEqual(
                read.warnings.map(warning => warning.code),
                entry.warnings,
                'warnings',
            );
            assert.deepEqual(heard, entry.warnings, 'warnings heard');
            assert.equal(read.packets.length, entry.packets.length, 'packet count');
            for (const [index, packet] of read.packets.entries()) {
                const expected = entry.packets[index];
                const label = `packet ${index}`;
                assert.equal(packet.trackId, expected.trackId, `${label} track`);
                assert.equal(packet.isKeyframe, expected.keyframe ?? true, `${label} keyframe`);
                near(packet.timestamp, expected.time, `${label} time`);
                if (expected.decodeTime === null)
                    assert.equal(packet.decodeTimestamp, undefined, `${label} decode time`);
                else
                    near(
                        packet.decodeTimestamp,
                        expected.decodeTime ?? expected.time,
                        `${label} decode time`,
                    );
                near(packet.duration, expected.duration, `${label} duration`);
                if (expected.hex) assert.equal(hex(packet.data), expected.hex, `${label} bytes`);
                else {
                    assert.equal(packet.data.length, expected.bytes, `${label} length`);
                    assert.equal(hash(packet.data), expected.sha256, `${label} bytes`);
                }
            }
            // The packets handed out are the reader's own: changing one changes no later read.
            read.packets[0].data.fill(0xa5);
            const again = await readAll(bytes);
            const [first] = entry.packets;
            if (first.hex) assert.equal(hex(again.packets[0].data), first.hex, 'read again');
            else assert.equal(hash(again.packets[0].data), first.sha256, 'read again');
            assert.equal(hash(bytes), entry.sha256, 'the input stays unchanged');

            if (entry.strict === 'reject')
                await assert.rejects(open(bytes, { validation: 'strict' }), { code: 'DEMUX' });
            else {
                const strict = await inspect(bytes, {
                    sampleCounts: true,
                    open: { validation: 'strict' },
                });
                strict.tracks.forEach((track, index) =>
                    assertTrack(track, entry.tracks[index], `strict track ${index}`),
                );
            }

            const media = await open(bytes);
            try {
                for (const format of entry.unsupportedRemux ?? [])
                    assert.equal(
                        (await media.check(format, { copy: true })).supported,
                        false,
                        `no copy into ${format}`,
                    );
                for (const format of entry.remux ?? []) {
                    const label = `${entry.name} -> ${format}`;
                    const copy = await readAll((await media.convert(format, { copy: true })).blob);
                    assert.equal(copy.packets.length, read.packets.length, `${label} packets`);
                    for (const [index, packet] of copy.packets.entries())
                        if (entry.pcm)
                            assert.deepEqual(
                                pcmValues(packet, copy.tracks[0], entry.pcm),
                                entry.pcm === 's16'
                                    ? [0, 32767, -32768, -1, 8192, -8192, 1234, -1234]
                                    : [-1, 1, 0.5, -0.5, 0, 0.25, -0.25, 0],
                                `${label} PCM values`,
                            );
                        else
                            assert.deepEqual(
                                packet.data,
                                again.packets[index].data,
                                `${label} packet ${index}`,
                            );
                    assert.equal(copy.tracks[0].sampleRate, entry.tracks[0].sampleRate);
                    assert.equal(copy.tracks[0].channelCount, entry.tracks[0].channelCount);
                    if (entry.name === 'audio-and-captions.mkv')
                        assert.deepEqual(
                            [copy.tracks[1].language, copy.tracks[1].forced, copy.tracks[1].name],
                            ['jpn', true, 'Original captions'],
                        );
                    if (entry.name.endsWith('.flac'))
                        assert.deepEqual(copy.tracks[0].codecConfig, read.tracks[0].codecConfig);
                    if (entry.name === 'preskip-and-trim.opus')
                        near(copy.tracks[0].duration, [180, 48000], 'Ogg trimmed duration');
                }
            } finally {
                media.close();
            }
        });
});
