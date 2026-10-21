import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities, convert, open } from 'mediaforgejs';
import { join } from '../helpers/avi-h264-fixtures.mjs';
import { differentialFixtures } from '../helpers/differential-fixtures.mjs';
import { FIXTURES, assertReadsAsRecorded } from '../helpers/recorded-fixtures.mjs';
import { allPackets, readMedia } from '../helpers/read-media.mjs';
import { readFileSync } from 'node:fs';

const rejectsStrict = input =>
    assert.rejects(open(input, { validation: 'strict' }), error => error.code === 'DEMUX');

/**
 * ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=0.05" -c:a wmav2 -b:a 32k
 * -packet_size 100 -fflags +bitexact -f asf: one 256-byte object over four 100-byte packets.
 */
const ONE_OBJECT = new Uint8Array(
    Buffer.from(
        'MCaydY5mzxGm2QCqAGLObIoBAAAAAAAABAAAAAECodyrjEepzxGO5ADADCBTZWgAAAAAAAAAAAAAAAAA' +
            'AAAAAAAAAAAAAEwDAAAAAAAAAIA+1d6xnQEEAAAAAAAAAOCm4AEAAAAAIKEHAAAAAAAcDAAAAAAAAAIA' +
            'AABkAAAAZAAAAAB9AAC1A79fLqnPEY7jAMAMIFNlLgAAAAAAAAAR0tOruqnPEY7mAMAMIFNlBgAAAAAA' +
            'kQfct7epzxGO5gDADCBTZXIAAAAAAAAAQJ5p+E1bzxGo/QCAX1xEK1DNw7+PYc8Ri7IAqgC04iAAAAAA' +
            'AAAAABwAAAAIAAAAAQAAAAAAYQEBAEAfAACgDwAAAAEQAAoAAAAAAAEAAAAAAAEAAQABAQAAQFLRhh0x' +
            '0BGjpACgyQNI9mQAAAAAAAAAQVLRhh0x0BGjpACgyQNI9gEAAAACABcAVwBpAG4AZABvAHcAcwAgAE0A' +
            'ZQBkAGkAYQAgAEEAdQBkAGkAbwAgAFYAOAAAAAAAAgBhATYmsnWOZs8RptkAqgBizmzCAQAAAAAAAAAA' +
            'AAAAAAAAAAAAAAAAAAAEAAAAAAAAAAEBggAAAF0AAAAAAAABAQAAAAAIAAEAABwMAAC7/0AAAt5Rxebw' +
            'HlHmlu38S1gPKfNVjW/zb7iym31wVjYDdL8WAuO31jYCdLuIuAnETj83gL8sG22Pz5Pxd5vK2/k4iYJm' +
            'tMuIUIIAAABdAAAAAAAAAQFKAAAACAABAAAcDAAA84Ez1r8BNQA+Eq8BXYAecY8BgQA+A3UAfAVIAPgJ' +
            'OADwEuABg2un1wFbHYNriK6fq0xXC6f1quBb/eAsBYDz3WvNJt61xW/KeL+CAAAAXQAAAAAAAAEBlAAA' +
            'AAgAAQAAHAwAACTb0Pn62tW6m3h8ml8tU8YWjSiil+haWIQmlD401ClFBpqVQhNIoqwUiirBIQUxIBTU' +
            'mCkImJCKsSBViYJiYmJiYmJiYmJiYmJjggAACV0kAAAAAAAAgQEB3gAAAAgAAQAAHAwAACIAUxMTE7ib' +
            'pi+L4m6V8XwulevhdjcDwE5OTk5OTk5OTk5OTgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
            'AAAAAA==',
        'base64',
    ),
);

/** Where data packet `index` of ONE_OBJECT starts. */
const packetAt = index => 444 + index * 100;

/** ONE_OBJECT as WMA Lossless, whose frames run across packets. */
function lossless() {
    const bytes = ONE_OBJECT.slice();
    bytes[Buffer.from(bytes).indexOf(Buffer.from([0x61, 1, 1, 0, 0x40, 0x1f]))] = 0x63;
    return bytes;
}

const payloads = async input => (await allPackets(input)).map(packet => packet.data);

describe('asf', () => {
    for (const file of ['wmv2.wmv', 'wma2.wma', 'h264mp3.asf'])
        test(`reads ${file} as recorded: tracks, packet times, keyframes and payloads`, () =>
            assertReadsAsRecorded(file));

    test('takes the title and the WMV2 and WMAv2 codec data from the header objects', async () => {
        const { title, tracks } = await readMedia(FIXTURES['wmv2.wmv'].bytes());
        assert.equal(title, 'Windows');
        const [video, audio] = tracks.map(entry => entry.track);
        assert.equal(video.codecConfig.length, 4, 'WMV2 extradata after the BITMAPINFOHEADER');
        assert.equal(audio.codecConfig.length, 18 + 10, 'WAVEFORMATEX with its codec data');
    });

    test('maps the RFC 1766 language of the header extension to ISO 639-2', async () => {
        // ffmpeg's and Microsoft's files put the header extension before the stream properties.
        const { tracks } = await readMedia(differentialFixtures['wma-jpn.wma']());
        assert.equal(tracks[0].track.language, 'jpn');
    });

    test('a data object the end cuts lasts as long as the packets read', async () => {
        const whole = await readMedia(differentialFixtures['wma-jpn.wma']());
        const media = await open(differentialFixtures['wma-jpn.wma']().slice(0, 2400));
        try {
            let last;
            for await (const packet of media.packets()) last = packet;
            const [track] = media.tracks;
            assert.ok(track.duration < whole.tracks[0].track.duration - 0.05, `${track.duration}`);
            assert.ok(Math.abs(track.duration - (last.timestamp + last.duration)) < 0.002);
        } finally {
            media.close();
        }
    });

    test('puts the fragments of an object in swapped packets back in their places', async () => {
        const [object] = await payloads(ONE_OBJECT);
        assert.equal(object.length, 256);
        const swapped = join(
            ONE_OBJECT.subarray(0, packetAt(1)),
            ONE_OBJECT.subarray(packetAt(2), packetAt(3)),
            ONE_OBJECT.subarray(packetAt(1), packetAt(2)),
            ONE_OBJECT.subarray(packetAt(3)),
        );
        const { tracks, warnings } = await readMedia(swapped);
        assert.deepEqual(
            tracks[0].packets.map(packet => packet.data),
            [object],
        );
        assert.deepEqual(warnings, ['ASF_FRAGMENTS_REORDERED']);
        await rejectsStrict(swapped);
    });

    test('a video object the end cuts keeps its bytes before the cut', async () => {
        const wmv = FIXTURES['wmv2.wmv'].bytes();
        const whole = await allPackets(wmv);
        const { tracks, warnings } = await readMedia(wmv.subarray(0, 4200));
        const packets = await allPackets(wmv.subarray(0, 4200));
        const last = packets.at(-1);
        assert.equal(packets.length, 8);
        assert.deepEqual(last.data, whole[7].data.subarray(0, 901));
        assert.ok(warnings.includes('ASF_TRUNCATED'), `${warnings}`);
        assert.ok(tracks.every(entry => entry.track.incomplete));
        await rejectsStrict(wmv.subarray(0, 4200));
    });

    test('a WMA block the end cuts is left out: audio keeps whole blocks only', async () => {
        const wmv = FIXTURES['wmv2.wmv'].bytes();
        const whole = await payloads(wmv);
        assert.deepEqual(await payloads(wmv.subarray(0, 4350)), whole.slice(0, 8));
    });

    test('rejects an input whose packets hold no complete media object', async () => {
        await assert.rejects(open(ONE_OBJECT.subarray(0, 700)), /no complete media objects/);
        await assert.rejects(
            open(join(ONE_OBJECT.subarray(0, packetAt(2)), ONE_OBJECT.subarray(packetAt(3)))),
            /no complete media objects/,
        );
    });

    test('a WMA Lossless object the end cuts keeps the bytes before the cut', async () => {
        const [object] = await payloads(ONE_OBJECT);
        const { tracks } = await readMedia(lossless().subarray(0, 700));
        assert.equal(tracks[0].track.codec, 'wmalossless');
        assert.deepEqual(
            tracks[0].packets.map(packet => packet.data),
            [object.subarray(0, 178)],
        );
    });

    test('a WMA Lossless object missing a fragment keeps the bytes before it', async () => {
        const [object] = await payloads(ONE_OBJECT);
        const bytes = lossless();
        const { tracks, warnings } = await readMedia(
            join(bytes.subarray(0, packetAt(2)), bytes.subarray(packetAt(3))),
        );
        assert.deepEqual(
            tracks[0].packets.map(packet => packet.data),
            [object.subarray(0, 148)],
        );
        assert.ok(warnings.includes('ASF_INCOMPLETE_OBJECT'), `${warnings}`);
    });

    test('keeps the whole packets of a file cut at nine tenths, marked incomplete', async () => {
        const bytes = FIXTURES['wmv2.wmv'].bytes();
        const part = bytes.subarray(0, Math.floor(bytes.length * 0.9));
        const { tracks, warnings } = await readMedia(part);
        assert.ok(warnings.includes('ASF_TRUNCATED'), `${warnings}`);
        assert.ok(tracks.every(entry => entry.track.incomplete));
        assert.equal(
            tracks.reduce((sum, entry) => sum + entry.packets.length, 0),
            11,
        );
        await rejectsStrict(part);
    });

    test('WMA audio, which nothing decodes, fails extraction naming wmav2', async () => {
        await assert.rejects(
            convert(FIXTURES['wma2.wma'].bytes(), { to: 'wav' }),
            error => error.code === 'DECODE' && /'wmav2'/.test(error.message),
        );
    });

    test('capabilities read asf but do not write it, and name its copy-only codecs', async () => {
        const reported = await capabilities();
        assert.ok(reported.containers.read.includes('asf'));
        assert.ok(!reported.containers.write.includes('asf'));
        for (const codec of ['wmv3', 'vc1']) assert.ok(reported.copyOnly.video.includes(codec));
        for (const codec of ['wmav2', 'wmapro']) assert.ok(reported.copyOnly.audio.includes(codec));
        for (const codec of ['wmv3', 'vc1']) assert.ok(reported.videoCopy.mkv.includes(codec));
        assert.ok(reported.videoCopy.ts.includes('vc1'));
        assert.ok(reported.audioCopy.mkv.includes('wmav2'));
    });

    describe('codecs named as ffmpeg names them', () => {
        const fixture = name =>
            new Uint8Array(readFileSync(new URL(`../fixtures/asf/${name}`, import.meta.url)));

        test('E-AC-3 is named by its WAVE_FORMAT_EXTENSIBLE subformat GUID', async () => {
            // ffmpeg -f lavfi -i "sine=f=440:d=0.06:sample_rate=48000" -ac 2 -c:a eac3 -b:a 32k
            // -packet_size 512 -f asf eac3.asf: not by a 16-bit format tag.
            const { format, tracks } = await readMedia(fixture('eac3.asf'));
            assert.equal(format, 'asf');
            const { track, packets } = tracks[0];
            assert.deepEqual(
                [track.codec, track.sampleRate, track.channelCount],
                ['ec-3', 48000, 2],
            );
            assert.deepEqual(
                packets.map(packet => [packet.data.length, packet.data[0], packet.data[1]]),
                [
                    [128, 0x0b, 0x77],
                    [128, 0x0b, 0x77],
                ],
            );
            // The dec3 an MP4 copy needs is derived.
            assert.equal(track.codecConfig.length, 5);
        });

        test("'MP4S' is MPEG-4 Part 2 video, not Microsoft's MPEG-4 v1", async () => {
            // ffmpeg -f lavfi -i "testsrc=d=0.08:s=16x16:r=25" -c:v mpeg4 -vtag MP4S
            // -packet_size 512 -f asf mpeg4-mp4s.asf, as in ffmpeg's tag table.
            const { format, tracks } = await readMedia(fixture('mpeg4-mp4s.asf'));
            assert.equal(format, 'asf');
            assert.match(tracks[0].track.codec, /^mp4v\.20\./);
            assert.deepEqual(
                tracks[0].packets.map(packet => packet.isKeyframe),
                [true, false],
            );
        });
    });
});
