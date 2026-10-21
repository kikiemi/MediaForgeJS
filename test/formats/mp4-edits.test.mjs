import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { open } from 'mediaforgejs';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';
import { copied, decodedWave, readAll, rejectsStrict, sha256 } from '../helpers/read-media.mjs';

// What MP4 edit lists present: their media times are composition times, entries that continue one
// another are one edit, and the edits end the track. iTunes gapless information trims like an edit.

const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
/** The offset of the first box of `type` in `bytes`. */
const boxAt = (bytes, type) => Buffer.from(bytes).indexOf(type) - 4;
const milliseconds = value => Math.round(value * 1000);
const timesOf = result => result.packets.map(packet => packet.timestamp);

/** The presentation times of the pictures frames() gives, to the microsecond. */
async function pictureTimes(bytes) {
    const media = await open(bytes);
    try {
        const times = [];
        for await (const frame of media.frames()) times.push(Number(frame.timestamp.toFixed(6)));
        return times;
    } finally {
        media.close();
    }
}

/** A B-frame H.264 movie of one second, 1000 movie ticks, with one edit. */
const bframes = () => fixtures['mp4-bframes.mp4']();

/**
 * `source` with its edit list replaced by `entries` ([duration, media time]) at rate 1.0, the
 * sizes of the boxes holding it grown to match.
 */
function withEdits(source, entries) {
    const elst = boxAt(source, 'elst');
    const grown = (entries.length - 1) * 12;
    const edited = new Uint8Array(source.length + grown);
    edited.set(source.subarray(0, elst + 12));
    const view = viewOf(edited.subarray(elst + 12, elst + 28 + grown));
    view.setUint32(0, entries.length);
    entries.forEach(([duration, time], index) => {
        view.setUint32(4 + index * 12, duration);
        view.setInt32(8 + index * 12, time);
        view.setUint32(12 + index * 12, 0x10000);
    });
    edited.set(source.subarray(elst + 28), elst + 28 + grown);
    for (const type of ['elst', 'edts', 'trak', 'moov']) {
        const box = boxAt(edited, type);
        viewOf(edited).setUint32(box, viewOf(edited).getUint32(box) + grown);
    }
    return edited;
}

/** The edit's duration and media time, and the media ticks per movie tick of `source`. */
function editOf(source) {
    const elst = boxAt(source, 'elst');
    const timescale = type => viewOf(source).getUint32(boxAt(source, type) + 20);
    return {
        elst,
        whole: viewOf(source).getUint32(elst + 16),
        mediaTime: viewOf(source).getInt32(elst + 20),
        ratio: timescale('mdhd') / timescale('mvhd'),
        movieTimescale: timescale('mvhd'),
    };
}

/**
 * The edit of `source` split into entries that continue one another, after two empty edits of
 * `leads` movie ticks; the split points fall on whole media units.
 */
function splitEdit(source, leads = [0, 0]) {
    const { whole, mediaTime, ratio } = editOf(source);
    let step = 1;
    while (!Number.isInteger(step * ratio)) step++;
    const third = Math.floor(whole / 3 / step) * step;
    assert.ok(third > 0);
    return withEdits(source, [
        [leads[0], -1],
        [leads[1], -1],
        [third, mediaTime],
        [third, mediaTime + third * ratio],
        [whole - 2 * third, mediaTime + 2 * third * ratio],
    ]);
}

describe('mp4: edit lists', () => {
    test('a B-frame edit ending past the decode duration is not trimmed', async () => {
        // Edit-list media times are composition times.
        const { warnings, tracks, packets } = await readAll(bframes());
        assert.deepEqual(warnings, []);
        assert.equal(Number(tracks[0].duration.toFixed(6)), 1);
        assert.equal(
            Math.max(...packets.map(packet => packet.timestamp + packet.duration)).toFixed(6),
            '1.000000',
        );
    });

    test('a clip cut to its delayed first picture still applies its edit', async () => {
        const cut = await readAll(fixtures['mp4-bframe-cut.mp4']());
        assert.deepEqual(cut.warnings, []);
        assert.equal(cut.packets[0].timestamp, 0);
        assert.equal(Number(cut.packets[0].decodeTimestamp.toFixed(6)), -0.2);
    });

    test('spliced media ranges are presented from the first edit, unless strict', async () => {
        // One sample timeline cannot represent them; the track is kept.
        const { mediaTime } = editOf(bframes());
        const spliced = withEdits(bframes(), [
            [300, mediaTime],
            [300, mediaTime + 5120],
            [400, mediaTime + 2048],
        ]);
        const reference = await readAll(bframes());
        const simplified = await readAll(spliced);
        assert.deepEqual(simplified.warnings, ['MP4_EDIT_LIST_SIMPLIFIED']);
        assert.deepEqual(simplified.hashes, reference.hashes);
        assert.equal(simplified.packets[0].timestamp, reference.packets[0].timestamp);
        await rejectsStrict(spliced);
    });

    describe('entries that continue one another', () => {
        // As editors write them, two leading empty edits included.
        test('are one edit, in compatible and strict reading alike', async () => {
            const reference = await readAll(bframes());
            const joined = await readAll(splitEdit(bframes()));
            assert.deepEqual(joined.warnings, []);
            assert.deepEqual(joined.hashes, reference.hashes);
            assert.deepEqual(timesOf(joined), timesOf(reference));
            const strict = await readAll(splitEdit(bframes()), { validation: 'strict' });
            assert.deepEqual(strict.hashes, reference.hashes);
        });

        test('after empty edits of 100 and 150 ticks start 250 ticks late', async () => {
            const { movieTimescale } = editOf(bframes());
            const leading = await readAll(splitEdit(bframes(), [100, 150]));
            assert.deepEqual(leading.warnings, []);
            assert.deepEqual(
                leading.packets.map(packet => Number(packet.timestamp.toFixed(6))),
                (await readAll(bframes())).packets.map(packet =>
                    Number((packet.timestamp + 250 / movieTimescale).toFixed(6)),
                ),
            );
        });

        for (const format of ['mp4', 'mov', 'fmp4'])
            test(`copy into ${format} as the one edit they make`, async () => {
                const [fromSplit, fromWhole] = await Promise.all(
                    [splitEdit(bframes()), bframes()].map(async bytes =>
                        readAll(await copied(bytes, format)),
                    ),
                );
                assert.deepEqual(fromSplit.hashes, fromWhole.hashes);
                assert.deepEqual(timesOf(fromSplit), timesOf(fromWhole));
            });
    });

    describe('a media rate other than 1.0', () => {
        // Writers put 1 for 0x10000; FFmpeg presents it at normal speed.
        const rated = () => {
            const bytes = bframes();
            viewOf(bytes).setUint32(editOf(bytes).elst + 24, 1);
            return bytes;
        };

        test('is presented at normal speed', async () => {
            const reference = await readAll(bframes());
            const read = await readAll(rated());
            assert.deepEqual(read.warnings, ['MP4_EDIT_RATE_IGNORED']);
            assert.deepEqual(read.hashes, reference.hashes);
            assert.deepEqual(timesOf(read), timesOf(reference));
        });

        test('keeps the end of its edit', async () => {
            const shortened = rated();
            const { elst } = editOf(shortened);
            viewOf(shortened).setUint32(elst + 16, viewOf(shortened).getUint32(elst + 16) - 150);
            assert.equal(
                (await pictureTimes(shortened)).length,
                (await pictureTimes(bframes())).length - 1,
            );
        });
    });

    test('an entry count past the entries the box holds uses those, unless strict', async () => {
        // As ffmpeg does.
        const edited = classicMp4({ edits: [[200, 40]] }).bytes;
        const overstated = edited.slice();
        viewOf(overstated).setUint32(Buffer.from(overstated).indexOf('elst') + 8, 189);
        const counted = await readAll(overstated);
        assert.deepEqual(counted.warnings, ['MP4_EDIT_LIST_COUNT']);
        const timedHashes = result =>
            result.packets.map(packet => [packet.timestamp, sha256(packet.data)]);
        assert.deepEqual(timedHashes(counted), timedHashes(await readAll(edited)));
        await rejectsStrict(overstated);
    });

    test('an edit into a 24-tick track moves times by whole ticks', async () => {
        // The sample at 98 ticks presents at exactly 4 s (98 / 24 - 2 / 24 is
        // 3.9999999999999996).
        const ticked = await readAll(
            classicMp4({ count: 100, timescale: 24, timing: [[100, 1]], edits: [[98, 2]] }).bytes,
        );
        assert.equal(ticked.packets[98].timestamp, 4);
    });

    test('its edits end a track, not the duration of the media header', async () => {
        const edited = await readAll(classicMp4({ edits: [[100, 40]] }).bytes);
        assert.equal(milliseconds(edited.tracks[0].duration), 100);
        const delayed = await readAll(
            classicMp4({
                edits: [
                    [50, -1],
                    [100, 40],
                ],
            }).bytes,
        );
        assert.equal(milliseconds(delayed.tracks[0].duration), 150);
    });

    test('pictures timed past the edit decode as references only', async () => {
        // frames() and thumbnails present the pictures inside the edit, as players and ffmpeg do.
        const whole = await pictureTimes(bframes());
        assert.equal(whole.length, 10);
        const cut = bframes();
        const elst = Buffer.from(cut).indexOf('elst');
        assert.equal(viewOf(cut).getUint32(elst + 12), 1000, 'one second of the movie');
        viewOf(cut).setUint32(elst + 12, 850);
        assert.deepEqual(await pictureTimes(cut), whole.slice(0, 9));
    });

    test('a Motion JPEG edit from the second sample presents that sample alone', async () => {
        // Every JPEG picture decodes alone, so the sample before the edit is neither presented
        // nor needed, and each picture is a sync sample whatever stss lists.
        const box = (type, ...parts) => {
            const payload = Buffer.concat(parts.map(part => Buffer.from(part)));
            const header = Buffer.alloc(8);
            header.writeUInt32BE(payload.length + 8);
            header.write(type, 4, 'latin1');
            return Buffer.concat([header, payload]);
        };
        const u32s = (...values) => {
            const out = Buffer.alloc(values.length * 4);
            values.forEach((value, index) => out.writeUInt32BE(value >>> 0, index * 4));
            return out;
        };
        const jpeg = index => Buffer.from([0xff, 0xd8, 0xff, 0xe0, index, 0xff, 0xd9]);
        const ftyp = box('ftyp', 'qt  ', u32s(0), 'qt  ');
        const entry = Buffer.alloc(78);
        entry.writeUInt16BE(1, 6);
        entry.writeUInt16BE(32, 24);
        entry.writeUInt16BE(16, 26);
        entry.writeUInt16BE(1, 40);
        entry.writeUInt16BE(24, 74);
        entry.writeInt16BE(-1, 76);
        const mvhd = Buffer.alloc(100);
        mvhd.writeUInt32BE(600, 12);
        mvhd.writeUInt32BE(24, 16);
        const tkhd = Buffer.alloc(84);
        tkhd.writeUInt32BE(15, 0);
        tkhd.writeUInt32BE(1, 12);
        tkhd.writeUInt32BE(24, 20);
        const mdhd = Buffer.alloc(24);
        mdhd.writeUInt32BE(600, 12);
        mdhd.writeUInt32BE(48, 16);
        const stbl = box(
            'stbl',
            box('stsd', u32s(0, 1), box('jpeg', entry)),
            box('stts', u32s(0, 1, 2, 24)),
            box('stss', u32s(0, 1, 1)),
            box('stsc', u32s(0, 1, 1, 2, 1)),
            box('stsz', u32s(0, 0, 2, 7, 7)),
            box('stco', u32s(0, 1, ftyp.length + 8)),
        );
        const moov = box(
            'moov',
            box('mvhd', mvhd),
            box(
                'trak',
                box('tkhd', tkhd),
                box('edts', box('elst', u32s(0, 1, 24, 24, 0x10000))),
                box(
                    'mdia',
                    box('mdhd', mdhd),
                    box('hdlr', u32s(0, 0), 'vide', Buffer.alloc(13)),
                    box('minf', stbl),
                ),
            ),
        );
        const mov = new Uint8Array(Buffer.concat([ftyp, box('mdat', jpeg(0), jpeg(1)), moov]));
        assert.deepEqual(
            (await readAll(mov)).packets.map(packet => [
                milliseconds(packet.timestamp),
                packet.isKeyframe,
                packet.data[4],
            ]),
            [[0, true, 1]],
        );
    });

    describe('iTunes gapless information', () => {
        // iTunSMPB on an AAC track without an edit list trims the encoder delay and padding it
        // states, as the equivalent edit list does.
        const mp4Box = (type, ...parts) => {
            const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
            const box = new Uint8Array(size);
            viewOf(box).setUint32(0, size);
            box.set(new TextEncoder().encode(type), 4);
            let at = 8;
            for (const part of parts) {
                box.set(part, at);
                at += part.length;
            }
            return box;
        };
        /** The primed AAC fixture with its audio edit list replaced by iTunSMPB, and its track. */
        async function gaplessMp4() {
            const source = fixtures['mp4-aac-primed.mp4']();
            const media = await readAll(source);
            const audio = media.tracks.find(track => track.type === 'audio').id;
            const { frames } = await decodedWave(source, audio);
            const coded = media.packets.filter(packet => packet.trackId === audio).length * 1024;
            const patched = source.slice();
            // The audio trak follows the video trak; each has an edit list.
            const edts = Buffer.from(source).indexOf(
                'edts',
                Buffer.from(source).indexOf('edts') + 4,
            );
            assert.ok(edts > Buffer.from(source).lastIndexOf('trak'), 'the audio edit list');
            patched.set(new TextEncoder().encode('free'), edts);
            const hex = (value, digits) => value.toString(16).toUpperCase().padStart(digits, '0');
            const words =
                ` 00000000 ${hex(1024, 8)} ${hex(coded - 1024 - frames, 8)} ` +
                `${hex(frames, 16)}`;
            const full = new Uint8Array(4);
            const text = value => new TextEncoder().encode(value);
            const tag = mp4Box(
                'udta',
                mp4Box(
                    'meta',
                    full,
                    mp4Box('hdlr', full, full, text('mdirappl'), new Uint8Array(9)),
                    mp4Box(
                        'ilst',
                        mp4Box(
                            '----',
                            mp4Box('mean', full, text('com.apple.iTunes')),
                            mp4Box('name', full, text('iTunSMPB')),
                            mp4Box('data', Uint8Array.of(0, 0, 0, 1), full, text(words)),
                        ),
                    ),
                ),
            );
            const moov = boxAt(source, 'moov');
            const view = viewOf(patched);
            assert.equal(moov + view.getUint32(moov), patched.length, 'the movie box ends it');
            view.setUint32(moov, view.getUint32(moov) + tag.length);
            return { source, audio, gapless: join(patched, tag) };
        }
        const join = (...parts) => new Uint8Array(Buffer.concat(parts));
        const wave = async (bytes, track) => sha256((await decodedWave(bytes, track)).bytes);

        test('trims the decoded audio as the edit list does', async () => {
            const { source, audio, gapless } = await gaplessMp4();
            assert.equal(await wave(gapless, audio), await wave(source, audio));
        });

        test('an MP4 copy keeps the trim as an edit list', async () => {
            const { source, audio, gapless } = await gaplessMp4();
            assert.equal(
                await wave(await copied(gapless, 'mp4'), audio),
                await wave(source, audio),
            );
        });
    });
});
