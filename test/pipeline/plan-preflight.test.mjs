import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, check, convert, edit, open } from 'mediaforgejs';
import { WebMDemuxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import {
    avcc,
    filler,
    idr,
    lengthPrefixed,
    pps,
    predicted,
    sps,
} from '../helpers/avi-h264-fixtures.mjs';
import { codes } from '../helpers/api-fixtures.mjs';
import { readerPart } from '../helpers/parts.mjs';

// What check() promises before anything is written, and what convert() then does: the same
// answer, and nothing written when the answer is no.

/** A MediaForge whose reader of the format 'fixture' returns one track `track` of `type`. */
function fixtureForge(type, track) {
    const reader = {
        formats: ['fixture'],
        async read() {
            return {
                duration: track.duration,
                videoTracks: type === 'video' ? [track] : [],
                audioTracks: type === 'audio' ? [track] : [],
            };
        },
    };
    return new MediaForge({
        plugins: { add: [{ name: 'fixture', readers: [readerPart(reader)] }] },
        open: { format: 'fixture' },
    });
}

const packet = data => ({
    offset: 0,
    size: data.length,
    timestamp: 0,
    duration: 0.04,
    isKeyframe: true,
    data,
});

/** A VP9 track of 160x96 coded pixels whose pixels are `num`:`den`. */
const anamorphic = (num, den) => ({
    id: 1,
    codec: 'vp09.00.10.08',
    width: 160,
    height: 96,
    duration: 0.04,
    sampleRate: 0,
    channelCount: 0,
    displayWidth: (160 * num) / den,
    displayHeight: 96,
    pixelAspectRatioNum: num,
    pixelAspectRatioDen: den,
    samples: [packet(Uint8Array.of(0x82, 0x49, 0x83, 0x42))],
});

/** H.264 in Matroska next to DTS whose frames carry no sync word, so no ddts describes them. */
async function dtsWithoutDescription(pictures, pictureBytes) {
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'mkv',
            mode: 'standard',
            video: {
                codec: 'avc1.42c00a',
                codecConfig: avcc(),
                width: 64,
                height: 48,
                framerate: 30,
            },
            audio: { codec: 'dtsc', sampleRate: 48000, channelCount: 2 },
        },
        sink,
    );
    for (let index = 0; index < pictures; index++) {
        muxer.addAudioChunk({
            trackType: 'audio',
            data: new Uint8Array(600).fill(index & 255),
            timestamp: index / 30,
            duration: 1 / 30,
            isKeyframe: true,
        });
        muxer.addVideoChunk({
            trackType: 'video',
            data:
                index % 30
                    ? lengthPrefixed(4, predicted, filler(pictureBytes))
                    : lengthPrefixed(4, sps, pps, idr, filler(pictureBytes)),
            timestamp: index / 30,
            duration: 1 / 30,
            isKeyframe: index % 30 === 0,
        });
    }
    await muxer.finalize();
    return sink.toUint8Array();
}

describe('pipeline/plan: before writing', () => {
    for (const [num, den] of [
        [4, 3],
        [16, 15],
    ])
        test(`pixels of ${num}:${den} are copied into Matroska with their shape`, async () => {
            const forge = fixtureForge('video', anamorphic(num, den));
            const input = new Uint8Array(4);
            assert.equal((await forge.check(input, 'mkv')).supported, true);
            const { blob } = await forge.convert(input, 'mkv');
            const [track] = (await new WebMDemuxer().demux(blob)).videoTracks;
            assert.equal(track.pixelAspectRatioNum / track.pixelAspectRatioDen, num / den);
        });

    for (const [label, change] of [
        ['a display width that is no number', { displayWidth: NaN }],
        ['H.264 without its decoder configuration', { codec: 'avc1.42c00b' }],
    ])
        test(`${label} is refused by check() and writes no byte`, async () => {
            const forge = fixtureForge('video', { ...anamorphic(4, 3), ...change });
            const input = new Uint8Array(4);
            assert.equal((await forge.check(input, 'mkv')).supported, false);
            const sink = new MemorySink();
            const refused = await forge.convert(input, 'mkv', { sink }).catch(error => error);
            assert.equal(refused.code, 'FORMAT');
            assert.equal(sink.size, 0);
        });

    for (const [type, codec] of [
        ['audio', 'mp4a.40.2'],
        ['video', 'av01.0.01M.08'],
    ])
        test(`${type} lacking the record MP4 needs is refused, no byte written`, async () => {
            const track = {
                id: 1,
                codec,
                width: 16,
                height: 16,
                sampleRate: 48000,
                channelCount: 1,
                duration: 1,
                samples: [{ ...packet(Uint8Array.of(1)), duration: 1 }],
            };
            const forge = fixtureForge(type, track);
            const input = new Uint8Array(1);
            assert.equal((await forge.check(input, { to: 'mp4', copy: true })).supported, false);
            const sink = new MemorySink();
            const refused = await forge
                .convert(input, { to: 'mp4', copy: true, sink })
                .catch(error => error);
            assert.equal(refused.code, 'FORMAT');
            assert.match(refused.message, /lacks its decoder configuration/);
            assert.equal(sink.size, 0);
        });

    describe('a track that cannot be copied is not planned as a copy', () => {
        const refused = error =>
            error.code === 'FORMAT' &&
            /'dtsc' lacks its decoder configuration\) or re-encode/.test(error.message);

        test('DTS without ddts is refused for MP4 by check(), convert() and edit()', async () => {
            const input = await dtsWithoutDescription(30, 64);
            const support = await check(input, 'mp4');
            assert.equal(support.supported, false);
            assert.match(support.reason, /dtsc/);
            await assert.rejects(convert(input, 'mp4'), refused);
            await assert.rejects(edit({ clips: [{ input }] }, 'mp4'), /decoder for 'dtsc'/);
        });

        test('a large input, planned from its probe, is refused the same way', async () => {
            await assert.rejects(convert(await dtsWithoutDescription(900, 8192), 'mp4'), refused);
        });

        test('Matroska needs no ddts: the tracks are copied, no warning', async () => {
            const copied = await convert(await dtsWithoutDescription(30, 64), 'mkv');
            assert.deepEqual(
                copied.plan.tracks.map(track => track.action),
                ['copy', 'copy'],
            );
            assert.deepEqual(copied.warnings, []);
        });
    });
});

describe('pipeline/plan: what a WAV cannot hold', () => {
    /** One sample of 16-bit PCM in a track of the 'owned' format, with `extra` fields. */
    const pcmTrack = (extra = {}) => ({
        id: 7,
        codec: 'pcm-s16le',
        sampleRate: 48000,
        channelCount: 1,
        duration: 1 / 48000,
        samples: [{ ...packet(new Uint8Array(2)), duration: 1 / 48000 }],
        ...extra,
    });
    /** Opens two bytes as the 'owned' format of `tracks`. */
    const owned = (tracks, options = {}) => {
        const reader = {
            formats: ['owned'],
            async read() {
                return { videoTracks: [], audioTracks: tracks };
            },
        };
        return open(new Uint8Array(2), {
            plugins: { add: [{ name: 'owned', readers: [readerPart(reader)] }] },
            format: 'owned',
            ...options,
        });
    };
    const uid = 18446744073709551615n;
    const named = () => [pcmTrack({ matroskaTrackUid: uid, language: 'jpn', name: 'Original' })];

    test('a track name and language are reported lost, after check() at the call', async () => {
        const warnings = [];
        const media = await owned(named(), { onWarning: warning => warnings.push(warning) });
        try {
            assert.equal(JSON.parse(JSON.stringify(media.tracks))[0].matroskaTrackUid, `${uid}`);
            const checked = await media.check('wav', { copy: false });
            assert.equal(checked.supported, true);
            for (const code of ['TRACK_METADATA_LOSS', 'AUDIO_LANGUAGE_LOSS'])
                assert.ok(codes(checked.warnings).includes(code), code);
            assert.deepEqual(warnings, [], 'check() warnings do not reach the listener');
            await media.convert('wav', { copy: false });
            assert.ok(warnings.length >= 2);
        } finally {
            media.close();
        }
    });

    test("metadataPolicy: 'error' makes the loss unsupported", async () => {
        const media = await owned(named(), { metadataPolicy: 'error' });
        try {
            assert.equal((await media.check('wav', { copy: false })).supported, false);
        } finally {
            media.close();
        }
    });

    test('a PCM packet over the ceiling is refused before reading or writing', async () => {
        const size = 64 * 1024 * 1024 + 2;
        let reads = 0;
        let writes = 0;
        const source = {
            size,
            async read(_offset, length) {
                reads++;
                return new Uint8Array(length);
            },
        };
        const duration = size / 2 / 48000;
        const huge = pcmTrack({
            id: 1,
            duration,
            samples: [{ offset: 0, size, timestamp: 0, duration, isKeyframe: true }],
        });
        const reader = {
            formats: ['owned'],
            async read() {
                return { videoTracks: [], audioTracks: [huge] };
            },
        };
        const media = await open(source, {
            plugins: { add: [{ name: 'owned', readers: [readerPart(reader)] }] },
            format: 'owned',
            maxPacketBytes: size,
            cacheBytes: 0,
        });
        try {
            assert.equal((await media.check('wav', { copy: false })).supported, false);
            const sink = { write: () => writes++, async close() {} };
            await assert.rejects(
                media.convert('wav', { copy: false, sink }),
                error => error.code === 'FORMAT',
            );
            assert.deepEqual([reads, writes], [0, 0]);
        } finally {
            media.close();
        }
    });

    test('two tracks need a choice; an edit or an unknown codec cannot be written', async () => {
        const two = await owned([pcmTrack(), pcmTrack({ id: 8 })]);
        try {
            assert.equal((await two.check('wav', { copy: false })).supported, false);
            const one = await two.check('wav', { copy: false, trackIds: [8] });
            assert.equal(one.supported, true);
        } finally {
            two.close();
        }
        for (const extra of [{ editMediaTimeSeconds: 1 }, { codec: 'unknown-audio' }]) {
            const media = await owned([pcmTrack(extra)]);
            try {
                const support = await media.check('wav', { copy: false });
                assert.equal(support.supported, false, JSON.stringify(extra));
            } finally {
                media.close();
            }
        }
    });
});
