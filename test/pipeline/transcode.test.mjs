import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, convert, inspect, open } from 'mediaforgejs';
import { createPicture } from 'mediaforgejs/plugins';
import { codes, patternDecoderPlugin, reopen, toneWav, vp8Clip } from '../helpers/api-fixtures.mjs';
import { editingFixture, tracksOf } from '../helpers/editing-fixtures.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';
import { pcmBenchmarkFixture } from '../helpers/workflow-benchmark-fixtures.mjs';

// The timeline of a re-encode: decode, stages, encode and one muxer, and what it reports.

/** The samples of the data chunk of a WAV result. */
async function wavSamples(result) {
    const bytes = await result.blob.arrayBuffer();
    const view = new DataView(bytes);
    let at = 12;
    while (view.getUint32(at) !== 0x64617461) at += 8 + view.getUint32(at + 4, true);
    return new Int16Array(bytes.slice(at + 8, at + 8 + view.getUint32(at + 4, true)));
}

describe('pipeline/transcode', () => {
    describe('stages', () => {
        test('a container target re-encodes the staged video and reports the stage', async () => {
            const life = { created: 0, closed: 0 };
            const invert = {
                type: 'video',
                name: 'invert',
                create() {
                    life.created++;
                    return {
                        type: 'video',
                        name: 'invert',
                        async process(picture, emit) {
                            const data = (await picture.rgba()).slice();
                            for (let at = 0; at < data.length; at++)
                                if (at % 4 !== 3) data[at] = 255 - data[at];
                            const { width, height, timestamp, duration } = picture;
                            emit(createPicture({ data, width, height, timestamp, duration }));
                            picture.close();
                        },
                        close: () => life.closed++,
                    };
                },
            };
            const { plugin } = patternDecoderPlugin();
            const forge = new MediaForge({ plugins: { add: [plugin] } });
            const input = await vp8Clip();
            const encoding = installVideoCodecs();
            try {
                const target = {
                    to: 'mkv',
                    video: { stages: [invert] },
                    codecPreference: 'builtin',
                };
                const checked = await forge.check(input, target);
                const converted = await forge.convert(input, target);
                for (const report of [checked.plan, converted.plan])
                    assert.deepEqual(
                        report.tracks.map(track => [track.action, track.stages]),
                        [['encode', ['invert']]],
                    );
                assert.equal(
                    encoding.encoded.length,
                    20,
                    'the check and the write encode ten each',
                );
                assert.equal(life.closed, life.created);
                encoding.assertClosed();
            } finally {
                encoding.restore();
            }
        });
    });

    describe('audio', () => {
        test('MP3 and MP2 in M4A are written by the plugin encoders and decode back', async () => {
            for (const codec of ['mp3', 'mp2']) {
                const m4a = await convert(toneWav(), 'm4a', { audio: { codec } });
                assert.deepEqual(codes(m4a.warnings), []);
                assert.deepEqual(
                    (await reopen(m4a.blob)).tracks.map(track => [track.type, track.codec]),
                    [['audio', codec]],
                );
                const pcm = await inspect((await convert(m4a.blob, 'wav')).blob);
                assert.equal(pcm.tracks[0].duration, 0.5, codec);
            }
        });

        test('AAC re-encoded at a lower rate is written at that rate', async () => {
            const { blob: m4a } = await convert(toneWav(), 'm4a');
            const resampled = await convert(m4a, 'mkv', {
                audio: { bitrate: 96000, sampleRate: 24000 },
            });
            assert.deepEqual(
                (await inspect(resampled.blob)).tracks.map(track => [
                    track.codec,
                    track.sampleRate,
                ]),
                [['mp4a.40.2', 24000]],
            );
        });

        test('a trimmed re-encode into AVI writes PCM for the range', async () => {
            const aac = await convert(toneWav(1), 'aac');
            const trimmed = await inspect(
                (await convert(aac.blob, 'avi', { start: 0.25, end: 0.75 })).blob,
            );
            assert.deepEqual(
                trimmed.tracks.map(track => [track.codec, track.duration]),
                [['pcm-s16le', 0.5]],
            );
        });
    });

    describe('ranges', () => {
        test('a re-encoded range holds the pictures shown in it', async () => {
            const host = installVideoCodecs();
            try {
                const { blob } = await convert(editingFixture('clip-m4v.mp4'), {
                    to: 'mkv',
                    video: { codec: 'vp8' },
                    start: 0.5,
                    end: 1,
                });
                const [video] = await tracksOf(blob);
                assert.equal(video.sampleCount, 13, 'the 13 pictures shown from 0.5 s to 1 s');
                assert.ok(Math.abs(video.duration - 0.5) < 0.01, `${video.duration} s`);
                host.assertClosed();
            } finally {
                host.restore();
            }
        });

        test('a range of PCM reads from the packet its start is in', async () => {
            // The last half second of 16 s of 48 kHz stereo.
            const frames = 48000 * 16;
            const wav = pcmBenchmarkFixture(frames);
            let read = 0;
            const source = {
                size: wav.length,
                async read(at, length) {
                    read += length;
                    return wav.slice(at, at + length);
                },
            };
            const mono = { to: 'wav', audio: { channels: 1 } };
            const range = await wavSamples(await convert(source, { ...mono, start: 15.5 }));
            assert.ok(read < wav.length / 2, `${read} of ${wav.length} bytes read`);
            const whole = await wavSamples(await convert(wav, mono));
            assert.deepEqual(range, whole.subarray(48000 * 15.5));
        });
    });

    describe('stopping', () => {
        test('a re-encode of PCM stops between work units and aborts the sink once', async () => {
            const frames = 262144;
            const media = await open(pcmBenchmarkFixture(frames));
            const cancellation = new AbortController();
            const sink = { writes: 0, aborts: 0, closes: 0 };
            const stopped = await media
                .convert('wav', {
                    copy: false,
                    signal: cancellation.signal,
                    sink: {
                        write() {
                            // Stop behind the first output, however busy the host is.
                            if (++sink.writes === 1) setImmediate(() => cancellation.abort());
                        },
                        patchAt() {},
                        async close() {
                            sink.closes++;
                        },
                        async abort() {
                            sink.aborts++;
                        },
                    },
                })
                .catch(error => error);
            media.close();
            assert.equal(stopped.code, 'ABORT');
            assert.ok(sink.writes > 0 && sink.writes < 1 + frames / 4096, `${sink.writes} writes`);
            assert.deepEqual([sink.aborts, sink.closes], [1, 0]);
        });
    });
});
