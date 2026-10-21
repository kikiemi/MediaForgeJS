import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, open, packageMedia } from 'mediaforgejs';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { packetOf } from '../helpers/media-packets.mjs';
import { vp8Keyframe } from '../helpers/webm-clip-fixture.mjs';

// A rotation is written into the container where it holds one, the pictures copied as they are; a
// flip or a new size changes pixels and needs codecs.

/** One picture of `codec` in Matroska or WebM, turned by `rotation`, with AAC beside it or not. */
async function clip({ codec = 'vp8', format = 'mkv', rotation, sound = true } = {}) {
    const aac = await encodeAacLc([new Float32Array(2048)], { sampleRate: 48000, bitrate: 64 });
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format,
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            video: {
                id: 3,
                type: 'video',
                codec,
                width: 16,
                height: 16,
                framerate: 25,
                ...(rotation ? { rotation } : {}),
            },
            ...(sound
                ? {
                      audio: {
                          id: 9,
                          type: 'audio',
                          codec: 'mp4a.40.2',
                          sampleRate: 48000,
                          channelCount: 1,
                          codecConfig: aac.audioSpecificConfig,
                      },
                  }
                : {}),
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
    if (sound)
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
    return sink.toBlob(format === 'webm' ? 'video/webm' : 'video/x-matroska');
}

/** The rotation and first packet of the video track of a file. */
async function videoOf(blob) {
    const media = await open(blob);
    try {
        const video = media.tracks.find(track => track.type === 'video');
        return { rotation: video.rotation ?? 0, data: (await packetOf(media, video.id)).data };
    } finally {
        media.close();
    }
}

describe('pipeline/plan: rotation', () => {
    test('a rotation alone copies the pictures; settings for an encoder are ignored', async () => {
        const media = await open(await clip());
        try {
            const turned = await media.check('mkv', { video: { rotate: 90, keyframeInterval: 1 } });
            assert.equal(turned.supported, true);
            assert.ok(
                turned.warnings.some(
                    warning =>
                        warning.code === 'OPTION_IGNORED' &&
                        /keyframeInterval/.test(warning.message),
                ),
            );
        } finally {
            media.close();
        }
    });

    test('rotations compose with the rotation the input has; the pixels stay', async () => {
        let input = await clip();
        for (const [rotate, expected] of [
            [90, 270],
            [90, 180],
            [270, 270],
        ]) {
            input = (await convert(input, 'mkv', { video: { rotate } })).blob;
            assert.deepEqual(await videoOf(input), { rotation: expected, data: vp8Keyframe });
        }
    });

    test('WebM holds a half turn of a chosen video track', async () => {
        const media = await open(await clip());
        try {
            const videoId = media.tracks.find(track => track.type === 'video').id;
            const { blob } = await media.convert('webm', {
                video: { rotate: 180 },
                trackIds: [videoId],
            });
            assert.equal((await videoOf(blob)).rotation, 180);
        } finally {
            media.close();
        }
    });

    for (const [target, expected] of [
        [{ to: 'mp4', copy: true }, 90],
        [{ to: 'fmp4', copy: true }, 90],
        [{ to: 'mp4', video: { rotate: 90 } }, 0],
        [{ to: 'mp4', video: { rotate: 180 } }, 270],
    ])
        test(`turned VP9 into ${JSON.stringify(target)} is shown at ${expected}`, async () => {
            const input = await clip({
                codec: 'vp09.00.10.08',
                format: 'webm',
                rotation: 90,
                sound: false,
            });
            const { blob } = await convert(input, target);
            assert.deepEqual(await videoOf(blob), { rotation: expected, data: vp8Keyframe });
        });

    test('HLS of fMP4 keeps the rotation', async () => {
        const input = await clip({
            codec: 'vp09.00.10.08',
            format: 'webm',
            rotation: 90,
            sound: false,
        });
        const { files } = await packageMedia(input, 'hls');
        const segments = [...files.values()].filter(file => file.kind === 'segment');
        const joined = new Blob([files.get('init.mp4').data, ...segments.map(file => file.data)]);
        assert.equal((await videoOf(joined)).rotation, 90);
    });

    test('a flip or a new size needs a video decoder, refused before the sink', async () => {
        const media = await open(await clip());
        try {
            const videoId = media.tracks.find(track => track.type === 'video').id;
            const flipped = await media.check('mkv', {
                video: { flip: 'horizontal' },
                trackIds: [videoId],
            });
            assert.equal(flipped.code, 'DECODE');
            const resized = { to: 'mkv', video: { width: 8, height: 8 }, trackIds: [videoId] };
            const refused = await media.check(resized);
            assert.deepEqual([refused.supported, refused.code], [false, 'DECODE']);
            assert.match(refused.reason, /No video decoder/);
            let touches = 0;
            const sink = {
                write: () => touches++,
                close: async () => touches++,
                abort: async () => touches++,
            };
            await assert.rejects(
                media.convert({ ...resized, sink }),
                error => error.code === 'DECODE',
            );
            assert.equal(touches, 0);
        } finally {
            media.close();
        }
    });
});
