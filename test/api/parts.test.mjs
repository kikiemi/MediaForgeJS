import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { inspect } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';
import * as parts from 'mediaforgejs/parts';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';

// mediaforgejs/parts assembled by hand: decoders, stages, encoders and muxers.

const clip = async () =>
    new Blob([await readFile(new URL('../fixtures/editing/clip-a.mp4', import.meta.url))]);

/** Pictures of 16x16 at 25 fps: two of noise, then two of stripes. */
function scenes() {
    const size = 16 * 16 * 4;
    const noise = shift =>
        Uint8Array.from({ length: size }, (_, i) =>
            i % 4 === 3 ? 255 : 64 + ((Math.imul((i >> 2) + shift, 2654435761) >>> 25) & 127),
        );
    const stripes = shift =>
        Uint8Array.from({ length: size }, (_, i) =>
            i % 4 === 3 ? 255 : (((i >> 2) % 16) + shift) % 4 < 2 ? 230 : 40,
        );
    return [0, 1, 2, 3].map(k => (k < 2 ? noise(k) : stripes(k)));
}

/** Every picture `stages` emits for `pictures`, flushed, and the chain closed. */
async function run(stages, pictures) {
    const out = [];
    for (const picture of pictures) out.push(...(await stages.push(picture)));
    out.push(...(await stages.flush()));
    stages.close();
    return out;
}

describe('parts', () => {
    test('sound decoded, remixed to 24 kHz mono and encoded as AAC into an MP4', async () => {
        const media = await parts.open(await clip());
        const audio = media.tracks.find(track => track.type === 'audio');
        const sink = new MemorySink();
        try {
            const muxer = await parts.createMuxer('mp4', sink, {
                audio: { codec: 'aac', sampleRate: 24000, channels: 1 },
            });
            await muxer.encodeAudio(
                parts.stageAudio(await parts.decodeAudio(media, audio.id), [
                    parts.remix({ sampleRate: 24000, channels: 1 }),
                ]),
            );
            await muxer.finish();
        } finally {
            media.close();
        }
        const m4a = (await inspect(sink.toBlob('audio/mp4'))).tracks[0];
        assert.deepEqual([m4a.codec, m4a.sampleRate, m4a.channelCount], ['mp4a.40.2', 24000, 1]);
        assert.ok(Math.abs(m4a.duration - audio.duration) < 0.03, `${m4a.duration} s`);
    });

    test('a video decoder of an audio track fails with INPUT', async () => {
        const media = await parts.open(await clip());
        try {
            const audio = media.tracks.find(track => track.type === 'audio');
            await assert.rejects(
                parts.createVideoDecoder(media, audio.id),
                error => error.code === 'INPUT' && /not a video track/.test(error.message),
            );
        } finally {
            media.close();
        }
    });

    test(
        'a video decoder lending few frames at once returns its whole flush, not deadlocked',
        { timeout: 10_000 },
        async () => {
            // GPU decoders hold back the next picture until one they lent is closed; this one
            // outputs every picture when it flushes.
            const host = installVideoCodecs({ reorder: true, pixels: true, pool: 2 });
            const media = await parts.open(await clip());
            try {
                const track = media.tracks.find(candidate => candidate.type === 'video');
                const decoder = await parts.createVideoDecoder(media, track.id);
                const pictures = [];
                const times = [];
                for await (const packet of media.packets({ trackIds: [track.id] })) {
                    times.push(packet.timestamp);
                    pictures.push(...(await decoder.decode(packet)));
                }
                assert.equal(pictures.length, 0, 'the decoder outputs only when it flushes');
                pictures.push(...(await decoder.flush()));
                await decoder.close();
                assert.deepEqual(
                    pictures.map(picture => picture.timestamp),
                    times.sort((a, b) => a - b),
                );
                const grey = await pictures[0].rgba();
                for (const picture of pictures) {
                    assert.ok(picture.frame, 'each picture keeps a frame');
                    assert.deepEqual([picture.width, picture.height], [track.width, track.height]);
                    assert.deepEqual(await picture.rgba(), grey);
                    picture.close();
                }
                host.assertClosed();
            } finally {
                media.close();
                host.restore();
            }
        },
    );

    test('createParts() binds the parts to the plugins: no AVI muxer without avi', async () => {
        const chosen = parts.createParts({ plugins: { exclude: ['avi'] } });
        await assert.rejects(
            chosen.createMuxer('avi', new MemorySink(), {
                audio: { codec: 'pcm', sampleRate: 8000, channels: 1 },
            }),
            error => error.code === 'PLUGIN' && error.plugin === 'avi',
        );
    });

    describe('audio stages', () => {
        /** Six channels of silence under a speaker mask other than the default. */
        const sixChannels = {
            sampleRate: 48000,
            channels: 6,
            channelMask: 0x60f,
            estimatedFrames: 480,
            async *chunks() {
                yield Array.from({ length: 6 }, () => new Float32Array(480));
            },
        };
        const gain = {
            type: 'audio',
            name: 'gain',
            process: (planes, emit) => emit(planes.map(plane => plane.map(value => value / 2))),
        };

        test('staged sound keeps the speaker mask while it keeps the channels', () => {
            assert.equal(parts.stageAudio(sixChannels, [gain]).channelMask, 0x60f);
            const stereo = parts.stageAudio(sixChannels, [parts.remix({ channels: 2 })]);
            assert.deepEqual([stereo.channels, stereo.channelMask], [2, undefined]);
        });

        test('a time stretch out of range fails with INPUT', () => {
            for (const factor of [0, 0.01, 21, NaN])
                assert.throws(
                    () => parts.timeStretch(factor),
                    error => error.code === 'INPUT',
                );
        });
    });

    describe('video stages', () => {
        test('half speed at 25 fps shows each picture on two slots', async () => {
            const [width, height, rate] = [16, 16, 25];
            const source = scenes();
            const stages = parts.createVideoStages([parts.speed(0.5), parts.frameRate(rate)], {
                width,
                height,
                fps: rate,
            });
            assert.deepEqual(stages.output, { width, height, fps: rate });
            const out = await run(
                stages,
                source.map((data, k) =>
                    parts.createPicture({
                        data,
                        width,
                        height,
                        timestamp: k / rate,
                        duration: 1 / rate,
                    }),
                ),
            );
            assert.deepEqual(
                out.map(picture => Math.round(picture.timestamp * rate)),
                [0, 1, 2, 3, 4, 5, 6, 7],
            );
            for (let k = 0; k < 4; k++) assert.deepEqual(await out[2 * k].rgba(), source[k]);
            assert.deepEqual(await out[3].rgba(), source[1], 'slot 3 repeats picture 1');
            for (const picture of out) picture.close();
        });

        test('a frame rate then double speed puts two pictures on four slots', async () => {
            const stages = parts.createVideoStages([parts.frameRate(20), parts.speed(2)], {
                width: 8,
                height: 8,
            });
            assert.deepEqual(stages.output, { width: 8, height: 8, fps: 40 });
            const picture = (value, timestamp) =>
                parts.createPicture({
                    data: new Uint8Array(256).fill(value),
                    width: 8,
                    height: 8,
                    timestamp,
                    duration: 0.1,
                });
            const out = await run(stages, [picture(100, 0), picture(120, 0.1)]);
            assert.deepEqual(
                out.map(entry => Math.round(entry.timestamp * 1000)),
                [0, 25, 50, 75],
            );
            const values = [];
            for (const entry of out) values.push((await entry.rgba())[0]);
            assert.deepEqual(values, [100, 100, 120, 120]);
            for (const entry of out) entry.close();
        });
    });
});
