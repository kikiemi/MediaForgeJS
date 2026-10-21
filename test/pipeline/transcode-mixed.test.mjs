import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, check, convert, open } from 'mediaforgejs';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { Mp4Muxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { packetOf, packetsOf } from '../helpers/media-packets.mjs';
import { readerPart } from '../helpers/parts.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';
import { vp8Keyframe, vp9Interframe, vp9Keyframe } from '../helpers/webm-clip-fixture.mjs';

// Conversions that copy some tracks and encode others: the copied packets stay as they are, the
// encoded sound follows its settings, the input is read once, and copied sound ends where the
// range does.

/** Mono AAC-LC at 48 kHz of `seconds` of a quiet sine. */
const aacOf = seconds =>
    encodeAacLc(
        [Float32Array.from({ length: Math.round(48000 * seconds) }, (_, i) => Math.sin(i / 7) / 8)],
        { sampleRate: 48000, bitrate: 64 },
    );

/** One VP8 picture and AAC packets in Matroska. */
async function vp8WithAac(aac) {
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'mkv',
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            video: { id: 3, type: 'video', codec: 'vp8', width: 16, height: 16, framerate: 25 },
            audio: {
                id: 9,
                type: 'audio',
                codec: 'mp4a.40.2',
                sampleRate: 48000,
                channelCount: 1,
                codecConfig: aac.audioSpecificConfig,
            },
        },
        sink,
    );
    const picture = { timestamp: 0, duration: 0.04, isKeyframe: true, trackType: 'video' };
    muxer.addVideoChunk({ ...picture, data: vp8Keyframe });
    for (const [index, data] of aac.frames.entries())
        muxer.addAudioChunk(
            {
                data,
                timestamp: (index * 1024) / 48000,
                duration: 1024 / 48000,
                isKeyframe: true,
                trackType: 'audio',
            },
            aac.audioSpecificConfig,
        );
    await muxer.finalize();
    return sink.toBlob('video/x-matroska');
}

/** The first packet of the first track of `type` in a written file. */
async function firstOf(blob, type) {
    const media = await open(blob);
    try {
        return (await packetOf(media, media.tracks.find(track => track.type === type).id)).data;
    } finally {
        media.close();
    }
}

describe('pipeline/transcode: copied and encoded tracks together', () => {
    test('a copy keeps the packets; check() before it reports nothing', async () => {
        const input = await vp8WithAac(await aacOf(2048 / 48000));
        const warnings = [];
        const progress = [];
        const media = await open(input, { onWarning: warning => warnings.push(warning) });
        try {
            const target = { to: 'mkv', onProgress: value => progress.push(value) };
            assert.equal((await media.check(target)).supported, true);
            assert.deepEqual([warnings.length, progress.length], [0, 0]);
            const { blob } = await media.convert(target);
            assert.deepEqual(await firstOf(blob, 'video'), vp8Keyframe);
            assert.ok(progress.length > 0);
            assert.ok(progress.every(value => value.fraction >= 0 && value.fraction <= 1));
        } finally {
            media.close();
        }
    });

    test('a chosen audio track is written alone into M4A, its packets copied', async () => {
        const aac = await aacOf(2048 / 48000);
        const media = await open(await vp8WithAac(aac));
        try {
            const audioId = media.tracks.find(track => track.type === 'audio').id;
            const selected = { to: 'm4a', trackIds: [audioId] };
            assert.equal((await media.check(selected)).supported, true);
            const written = await open((await media.convert(selected)).blob);
            assert.deepEqual(
                written.tracks.map(track => track.type),
                ['audio'],
            );
            assert.deepEqual((await packetOf(written, written.tracks[0].id)).data, aac.frames[0]);
            written.close();
        } finally {
            media.close();
        }
    });

    test('AAC resampled to 24 kHz mono beside the copied picture', async () => {
        const media = await open(await vp8WithAac(await aacOf(2048 / 48000)));
        const progress = [];
        try {
            const target = {
                to: 'mkv',
                audio: { sampleRate: 24000, channels: 1, bitrate: 48000 },
                onProgress: value => progress.push(value),
            };
            assert.equal((await media.check(target)).supported, true, 'no WebCodecs needed');
            assert.equal(progress.length, 0);
            const { blob } = await media.convert(target);
            const written = await open(blob);
            assert.equal(written.tracks.find(track => track.type === 'audio').sampleRate, 24000);
            written.close();
            assert.deepEqual(await firstOf(blob, 'video'), vp8Keyframe);
            assert.ok(progress.length > 0);
        } finally {
            media.close();
        }
    });

    test('PCM encoded as AAC at 24 kHz beside the copied picture keeps its length', async () => {
        const sink = new MemorySink();
        const muxer = new WebMMuxer(
            {
                format: 'mkv',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: true,
                video: { id: 3, type: 'video', codec: 'vp8', width: 16, height: 16, framerate: 25 },
                audio: {
                    id: 9,
                    type: 'audio',
                    codec: 'pcm-s16le',
                    sampleRate: 48000,
                    channelCount: 1,
                },
            },
            sink,
        );
        muxer.addVideoChunk({
            data: vp8Keyframe,
            timestamp: 0,
            duration: 0.04,
            isKeyframe: true,
            trackType: 'video',
        });
        const pcm = new Uint8Array(4096);
        const view = new DataView(pcm.buffer);
        for (let index = 0; index < 2048; index++)
            view.setInt16(index * 2, Math.round(Math.sin((index * Math.PI) / 24) * 4096), true);
        muxer.addAudioChunk({
            data: pcm,
            timestamp: 0,
            duration: 2048 / 48000,
            isKeyframe: true,
            trackType: 'audio',
        });
        await muxer.finalize();
        const input = sink.toBlob('video/x-matroska');
        const target = { to: 'mkv', audio: { codec: 'mp4a.40.2', sampleRate: 24000 } };
        assert.equal((await check(input, target)).supported, true);
        const { blob } = await convert(input, target);
        const written = await open(blob);
        assert.equal(written.tracks.find(track => track.type === 'audio').sampleRate, 24000);
        written.close();
        assert.deepEqual(await firstOf(blob, 'video'), vp8Keyframe);
        const decoded = await open((await convert(blob, 'wav')).blob);
        assert.ok(Math.abs(decoded.tracks[0].duration - 2048 / 48000) < 1 / 24000);
        decoded.close();
    });

    test('titles and track names survive a re-encode of the sound', async () => {
        const aac = await aacOf(2048 / 48000);
        const sink = new MemorySink();
        const muxer = new Mp4Muxer(
            {
                format: 'm4a',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: true,
                title: 'Original movie title',
                audio: {
                    id: 9,
                    type: 'audio',
                    codec: 'mp4a.40.2',
                    sampleRate: 48000,
                    channelCount: 1,
                    codecConfig: aac.audioSpecificConfig,
                    name: 'Soundtrack',
                    title: 'Independent track title',
                },
            },
            sink,
        );
        for (const [index, data] of aac.frames.entries())
            muxer.addAudioChunk(
                {
                    data,
                    timestamp: (index * 1024) / 48000,
                    duration: 1024 / 48000,
                    isKeyframe: true,
                    trackType: 'audio',
                },
                aac.audioSpecificConfig,
            );
        await muxer.finalize();
        const { blob } = await convert(sink.toBlob('audio/mp4'), 'm4a', {
            audio: { sampleRate: 24000 },
        });
        const written = await open(blob);
        assert.deepEqual(
            [written.title, written.tracks[0].name, written.tracks[0].title],
            ['Original movie title', 'Soundtrack', 'Independent track title'],
        );
        written.close();
    });

    test('of two video tracks the first is encoded and the second copied', async () => {
        const reader = {
            formats: ['owned'],
            async read() {
                const sample = { offset: 0, timestamp: 0, duration: 0.04, isKeyframe: true };
                const packet = { ...sample, size: vp8Keyframe.length, data: vp8Keyframe };
                const track = id => ({
                    id,
                    codec: 'vp8',
                    width: 16,
                    height: 16,
                    sampleRate: 0,
                    channelCount: 0,
                    duration: 0.04,
                    samples: [packet],
                });
                return { audioTracks: [], videoTracks: [track(3), track(7)] };
            },
        };
        const media = await open(vp8Keyframe, {
            format: 'owned',
            plugins: { add: [{ name: 'owned', readers: [readerPart(reader)] }] },
        });
        const host = installVideoCodecs();
        try {
            const both = await media.convert('mkv', { video: { codec: 'vp09.00.10.08' } });
            assert.deepEqual(
                both.plan.tracks.map(track => [track.trackId, track.action]),
                [
                    [3, 'encode'],
                    [7, 'copy'],
                ],
            );
            const written = await open(both.blob);
            assert.deepEqual(
                written.tracks.map(track => [track.id, track.codec.slice(0, 3)]),
                [
                    [3, 'vp0'],
                    [7, 'vp8'],
                ],
            );
            assert.deepEqual((await packetOf(written, 7)).data, vp8Keyframe);
            written.close();
            host.assertClosed();
        } finally {
            host.restore();
            media.close();
        }
    });
});

describe('pipeline/transcode: reading for copied and encoded tracks', () => {
    /** Eight seconds of VP9 pictures of 32 KiB beside AAC in MP4, as bytes. */
    async function movie() {
        const seconds = 8;
        const sound = await aacOf(seconds);
        const sink = new MemorySink();
        const writer = new Mp4Muxer(
            {
                format: 'mp4',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: true,
                video: {
                    id: 3,
                    type: 'video',
                    codec: 'vp09.00.10.08',
                    width: 16,
                    height: 16,
                    framerate: 25,
                },
                audio: {
                    id: 9,
                    type: 'audio',
                    codec: 'mp4a.40.2',
                    sampleRate: 48000,
                    channelCount: 1,
                    codecConfig: sound.audioSpecificConfig,
                },
            },
            sink,
        );
        const picture = new Uint8Array(32 * 1024);
        picture.set(vp8Keyframe);
        let frame = 0;
        for (const [index, data] of sound.frames.entries()) {
            const time = (index * 1024) / 48000;
            for (; frame / 25 <= time && frame < seconds * 25; frame++)
                writer.addVideoChunk({
                    data: picture,
                    timestamp: frame / 25,
                    duration: 0.04,
                    isKeyframe: frame % 25 === 0,
                    trackType: 'video',
                });
            writer.addAudioChunk(
                {
                    data,
                    timestamp: time,
                    duration: 1024 / 48000,
                    isKeyframe: true,
                    trackType: 'audio',
                },
                sound.audioSpecificConfig,
            );
        }
        await writer.finalize();
        return new Uint8Array(await sink.toBlob('video/mp4').arrayBuffer());
    }

    /** A source of `bytes` that counts what is read and the most read but not yet written. */
    function counted(bytes) {
        const state = { read: 0, written: 0, held: 0 };
        const source = {
            size: bytes.length,
            async read(offset, length) {
                const part = bytes.slice(offset, offset + length);
                state.read += part.length;
                state.held = Math.max(state.held, state.read - state.written);
                return part;
            },
        };
        return { state, source };
    }

    const lanes = result => result.plan.tracks.map(track => `${track.type}:${track.action}`);

    test('copied pictures and encoded sound share one read of the input', async () => {
        // Larger than the spans a pass keeps (3 MiB), which once served a second lane by chance.
        const bytes = await movie();
        const { state, source } = counted(bytes);
        const result = await convert(source, 'mkv', { audio: { codec: 'flac' } });
        assert.deepEqual(lanes(result), ['video:copy', 'audio:encode']);
        assert.ok(state.read < bytes.length * 1.25, `${state.read} of ${bytes.length} bytes`);
    });

    test('a range reads its share of the input and nothing after it ends', async () => {
        const bytes = await movie();
        const { state, source } = counted(bytes);
        await convert(source, 'mkv', { end: 2, audio: { codec: 'flac' } });
        const done = state.read;
        for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
        assert.ok(done < bytes.length * 0.6, `${done} of ${bytes.length} bytes for 2 s`);
        assert.equal(state.read, done, 'nothing is read once the conversion ended');
    });

    test('sound encoded frame by frame keeps up: the merge holds a few pictures', async () => {
        const bytes = await movie();
        const { state, source } = counted(bytes);
        class WrittenSink extends MemorySink {
            write(data) {
                state.written += data.length;
                return super.write(data);
            }
        }
        const mp3 = await convert(source, 'mp4', {
            audio: { codec: 'mp3' },
            sink: new WrittenSink(),
        });
        assert.deepEqual(lanes(mp3), ['video:copy', 'audio:encode']);
        assert.ok(state.held < 4 * 1024 * 1024, `held ${state.held} of ${bytes.length} bytes`);
    });
});

describe('pipeline/transcode: where copied sound ends', () => {
    // Two seconds of pictures and three of sound, the sound twice; a subtitle track beside them
    // once stopped the extra sound at the last picture.
    async function source(sound, { subtitle = false, vp9 = false } = {}) {
        const audio = {
            type: 'audio',
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            channelCount: 1,
            codecConfig: sound.audioSpecificConfig,
        };
        const sink = new MemorySink();
        const writer = new WebMMuxer(
            {
                format: 'mkv',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: true,
                video: {
                    id: 1,
                    type: 'video',
                    codec: vp9 ? 'vp09.00.10.08' : 'vp8',
                    width: 16,
                    height: 16,
                    framerate: 25,
                },
                audio: { id: 2, ...audio },
                extraAudioTracks: [{ id: 3, ...audio }],
                ...(subtitle ? { subtitleTracks: [{ id: 4, codec: 'text/utf8' }] } : {}),
            },
            sink,
        );
        let frame = 0;
        for (const [index, data] of sound.frames.entries()) {
            const time = (index * 1024) / 48000;
            for (; frame / 25 <= time && frame < 50; frame++)
                writer.addVideoChunk({
                    data: vp9 ? (frame % 25 ? vp9Interframe : vp9Keyframe) : vp8Keyframe,
                    timestamp: frame / 25,
                    duration: 0.04,
                    isKeyframe: frame % 25 === 0,
                    trackType: 'video',
                });
            const chunk = { data, timestamp: time, duration: 1024 / 48000, isKeyframe: true };
            writer.addAudioChunk({ ...chunk, trackType: 'audio' }, sound.audioSpecificConfig);
            writer.addExtraAudioChunk(
                0,
                { ...chunk, trackType: 'audio' },
                sound.audioSpecificConfig,
            );
            if (subtitle && index === 0)
                writer.addSubtitleChunk(
                    {
                        data: new TextEncoder().encode('cue'),
                        timestamp: 0.5,
                        duration: 0.5,
                        isKeyframe: true,
                        trackType: 'subtitle',
                    },
                    0,
                );
        }
        await writer.finalize();
        return sink.toBlob('video/x-matroska');
    }

    /** The packet count or the presented duration of the nth audio track of a file. */
    async function soundOf(blob, nth) {
        const media = await open(blob);
        try {
            const track = media.tracks.filter(candidate => candidate.type === 'audio')[nth];
            return { packets: (await packetsOf(media, track.id)).length, duration: track.duration };
        } finally {
            media.close();
        }
    }

    for (const subtitle of [false, true]) {
        const name = subtitle ? 'extra sound beside subtitles' : 'extra sound alone';
        test(`${name} runs to its end or the range's`, async () => {
            const sound = await aacOf(3);
            const input = await source(sound, { subtitle });
            const whole = await convert(input, 'mkv', { audio: { codec: 'flac' } });
            assert.deepEqual(
                whole.plan.tracks.map(track => `${track.type}:${track.action}`).slice(0, 3),
                ['video:copy', 'audio:encode', 'audio:copy'],
            );
            assert.equal((await soundOf(whole.blob, 1)).packets, sound.frames.length);
            const cut = await convert(input, 'mkv', { audio: { codec: 'flac' }, end: 2.5 });
            assert.equal((await soundOf(cut.blob, 1)).packets, 118, 'to 2.5 s');
        });
    }

    test('an edit of the whole input copies all of its sound', async () => {
        const sound = await aacOf(3);
        const edited = await new MediaForge().edit(
            { clips: [{ input: await source(sound) }] },
            'mkv',
        );
        assert.deepEqual(
            edited.plan.tracks.map(track => `${track.type}:${track.action}`),
            ['video:copy', 'audio:copy'],
        );
        assert.equal((await soundOf(edited.blob, 0)).packets, sound.frames.length);
    });

    test('MP4 presents copied sound to its end or the range end, not the last frame', async () => {
        const sound = await aacOf(3);
        const own = (sound.frames.length * 1024) / 48000;
        const input = await source(sound, { subtitle: true, vp9: true });
        for (const [name, result, nth, seconds] of [
            ['extra sound', await convert(input, 'mp4', { audio: { codec: 'mp3' } }), 1, own],
            [
                'extra sound to 2.5 s',
                await convert(input, 'mp4', { audio: { codec: 'mp3' }, end: 2.5 }),
                1,
                2.5,
            ],
            ['edited sound', await new MediaForge().edit({ clips: [{ input }] }, 'mp4'), 0, own],
        ]) {
            const { duration } = await soundOf(result.blob, nth);
            assert.ok(Math.abs(duration - seconds) < 0.002, `${name}: ${duration} s of ${seconds}`);
        }
    });
});
