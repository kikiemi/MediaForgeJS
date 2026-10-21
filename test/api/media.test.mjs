import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, convert, inspect, open } from 'mediaforgejs';
import { TsMuxer } from 'mediaforgejs/formats';
import { MemorySink, ReadableStreamSink } from 'mediaforgejs/io';
import * as lite from 'mediaforgejs/lite';
import { h264 } from 'mediaforgejs/plugins';
import { monoWav, toneWav } from '../helpers/api-fixtures.mjs';
import { avcc, filler, idr, lengthPrefixed, predicted } from '../helpers/avi-h264-fixtures.mjs';
import { adtsFixture, waveFixture } from '../helpers/original-fixtures.mjs';
import { readerPart } from '../helpers/parts.mjs';

// open() and Media: an input opened once, read and converted many times.

describe('open() and Media', () => {
    test('a Media knows its format and reads its packets', async () => {
        const media = await new MediaForge().open(waveFixture());
        try {
            assert.equal(media.format, 'wav');
            assert.ok((await media.packetAt(media.tracks[0].id, 0)).data.length > 0);
        } finally {
            media.close();
        }
    });

    test('a Media keeps its own index, whatever becomes of what the reader returned', async () => {
        let returned;
        const reader = {
            formats: ['kept'],
            async read() {
                const samples = [0, 1].map(index => ({
                    offset: index,
                    size: 1,
                    timestamp: index,
                    duration: 1,
                    isKeyframe: true,
                }));
                const track = { id: 1, codec: 'mp3', duration: 2, sampleRate: 48000 };
                const audio = { ...track, channelCount: 1, width: 0, height: 0, samples };
                return (returned = { duration: 2, videoTracks: [], audioTracks: [audio] });
            },
        };
        const forge = new MediaForge({
            plugins: { add: [{ name: 'kept', readers: [readerPart(reader)] }] },
        });
        const media = await forge.open(Uint8Array.of(7, 9), { format: 'kept' });
        try {
            const before = await media.packetAt(1, 1);
            returned.audioTracks[0].samples[1].timestamp = 98765;
            returned.audioTracks[0].samples[1].offset = 0;
            returned.audioTracks[0].samples.length = 0;
            const after = await media.packetAt(1, 1);
            assert.deepEqual([after.timestamp, [...after.data]], [1, [9]]);
            assert.deepEqual(after, before);
        } finally {
            media.close();
        }
    });

    test('an open input cuts into parts without reading it again', async () => {
        const whole = await open(toneWav(1));
        const halves = [];
        try {
            halves.push((await whole.convert({ end: 0.5 })).blob);
            halves.push((await whole.convert({ start: 0.5 })).blob);
        } finally {
            whole.close();
        }
        const described = [];
        for (const half of halves) {
            const media = await open(half);
            described.push([media.format, media.tracks[0].duration]);
            media.close();
        }
        assert.deepEqual(described, [
            ['wav', 0.5],
            ['wav', 0.5],
        ]);
    });

    test('a call that opens its input returns the warnings of reading it too', async () => {
        const bytes = adtsFixture({ gap: true });
        const heard = [];
        const forge = new MediaForge({ onWarning: warning => heard.push(warning) });
        const codes = result => result.warnings.map(warning => warning.code);
        const converted = await forge.convert(bytes, 'wav');
        assert.ok(codes(converted).includes('ADTS_RESYNCHRONIZED'), codes(converted).join());
        assert.deepEqual(converted.warnings, heard, 'each once, as onWarning hears them');
        assert.ok(codes(await forge.check(bytes, 'wav')).includes('ADTS_RESYNCHRONIZED'));
        const media = await forge.open(bytes);
        try {
            // A Media keeps them in its own warnings; its operations return theirs.
            assert.ok(codes(media).includes('ADTS_RESYNCHRONIZED'));
            assert.ok(!codes(await media.convert('wav')).includes('ADTS_RESYNCHRONIZED'));
        } finally {
            media.close();
        }
    });

    test("a Media reports its thumbnail decoder's warnings as the function does", async () => {
        // 90 pictures of 48 KiB: over the size from which an MPEG-TS is described from its ends.
        const sink = new MemorySink();
        const muxer = new TsMuxer(
            {
                format: 'ts',
                mode: 'standard',
                autoSync: true,
                video: {
                    id: 1,
                    type: 'video',
                    codec: 'avc1.42c00a',
                    codecConfig: avcc(),
                    width: 64,
                    height: 48,
                    framerate: 30,
                },
            },
            sink,
        );
        const pictures = [idr, predicted].map(slice => lengthPrefixed(4, slice, filler(48 * 1024)));
        for (let index = 0; index < 90; index++)
            muxer.addVideoChunk({
                trackType: 'video',
                data: pictures[index % 30 ? 1 : 0],
                timestamp: index / 30,
                duration: 1 / 30,
                isKeyframe: index % 30 === 0,
            });
        await muxer.finalize();
        const bytes = sink.toUint8Array();
        // The H.264 decoder warns twice for every decoder it creates.
        const [builtin] = h264.decoders;
        const warning = {
            name: 'h264',
            description: h264.description,
            decoders: [
                {
                    ...builtin,
                    async load() {
                        const create = await builtin.load();
                        return async config => {
                            for (let count = 0; count < 2; count++) config.onWarning('concealed');
                            return create(config);
                        };
                    },
                },
            ],
        };
        const forge = new lite.MediaForge({ plugins: [warning] });
        const concealed = result =>
            result.warnings.filter(item => item.code === 'VIDEO_FRAME_CONCEALED').length;
        const media = await forge.open(bytes);
        try {
            assert.equal(concealed(await forge.thumbnail(bytes, { time: 1.2 })), 2);
            assert.equal(concealed(await media.thumbnail({ time: 1.2 })), 2);
        } finally {
            media.close();
        }
    });
});

describe('a Media checks and converts', () => {
    /** A Media of five 16-bit samples read from a source that counts its closes. */
    async function job() {
        const bytes = monoWav();
        const source = {
            size: bytes.length,
            closes: 0,
            async read(at, length) {
                return bytes.slice(at, at + length);
            },
            close() {
                this.closes++;
            },
        };
        return { media: await open(source), source, bytes };
    }
    const inputError = error => error.code === 'INPUT';

    test('a copy into AIFF writes the samples as they are', async () => {
        const { media } = await job();
        try {
            assert.equal(media.format, 'wav');
            const copy = await media.check('aiff');
            assert.deepEqual([copy.supported, copy.plan.action], [true, 'copy']);
            const aiff = new Uint8Array(await (await media.convert('aiff')).blob.arrayBuffer());
            assert.equal(new TextDecoder().decode(aiff.subarray(0, 4)), 'FORM');
            assert.deepEqual([...aiff.subarray(-10)], [128, 0, 192, 0, 0, 0, 64, 0, 127, 255]);
        } finally {
            media.close();
        }
    });

    test('a new rate and channel count re-encode, as check() says', async () => {
        const { media } = await job();
        try {
            const target = { audio: { sampleRate: 24000, channels: 2 } };
            const support = await media.check('wav', target);
            assert.deepEqual(
                [support.supported, support.plan.action, support.plan.tracks[0].codec],
                [true, 'reencode', 'pcm-s16'],
            );
            const [track] = (await inspect((await media.convert('wav', target)).blob)).tracks;
            assert.deepEqual([track.sampleRate, track.channelCount], [24000, 2]);
        } finally {
            media.close();
        }
    });

    test('a target refused before writing leaves the sink untouched', async () => {
        const { media } = await job();
        const sink = { writes: 0, closes: 0, aborts: 0 };
        try {
            const refused = await media
                .convert('webm', {
                    sink: {
                        write: () => sink.writes++,
                        close: async () => sink.closes++,
                        abort: async () => sink.aborts++,
                    },
                })
                .catch(error => error);
            assert.equal(refused.code, 'FORMAT');
            assert.deepEqual(sink, { writes: 0, closes: 0, aborts: 0 });
            const limited = media.convert('wav', { audio: { sampleRate: 24000 }, maxBytes: 16 });
            await assert.rejects(limited, error => error.code === 'OOM');
        } finally {
            media.close();
        }
    });

    test('check() says no to a missing track or format and repairs settings', async () => {
        const { media } = await job();
        try {
            for (const target of [{ to: 'wav', trackIds: [99] }, { to: 'no-such-format' }])
                assert.equal((await media.check(target)).supported, false, JSON.stringify(target));
            for (const target of [
                { to: 'wav', audio: { channels: 0 } },
                { to: 'wav', audio: { sampleRate: NaN } },
                { to: 'wav', copy: false, allowPrecisionLoss: 1 },
                { to: 'WAV', audio: { channels: '2' } },
                { to: 'wav', audio: { chanels: 2 } },
            ]) {
                const repaired = await media.check(target);
                assert.equal(repaired.supported, true, JSON.stringify(target));
                assert.ok(
                    repaired.warnings.some(warning => warning.code.startsWith('OPTION_')),
                    JSON.stringify(target),
                );
            }
            const aborted = new AbortController();
            aborted.abort();
            const stopped = await media.check('wav', { copy: false, signal: aborted.signal });
            assert.equal(stopped.code, 'ABORT');
        } finally {
            media.close();
        }
    });

    test('strictly, check() refuses what it would repair, with INPUT', async () => {
        const media = await open(monoWav(), { optionPolicy: 'strict' });
        try {
            for (const target of [
                { to: 'wav', audio: { channels: 0 } },
                { to: 'wav', audio: { sampleRate: NaN } },
                { to: 'wav', copy: false, allowPrecisionLoss: 1 },
            ]) {
                const refused = await media.check(target);
                assert.deepEqual([refused.supported, refused.code], [false, 'INPUT']);
            }
        } finally {
            media.close();
        }
    });

    test('bytes of no format fail the open with DEMUX', async () => {
        await assert.rejects(open(new Uint8Array(16)), error => error.code === 'DEMUX');
    });

    test('a failing sink is aborted with its failure and never closed', async () => {
        const { media } = await job();
        const failure = new Error('caller write failed');
        const reasons = [];
        try {
            const thrown = await media
                .convert('wav', {
                    copy: false,
                    sink: {
                        write() {
                            throw failure;
                        },
                        async close() {
                            assert.fail('a failed sink is not closed');
                        },
                        async abort(reason) {
                            reasons.push(reason);
                        },
                    },
                })
                .catch(error => error);
            assert.equal(thrown, failure);
            assert.deepEqual(reasons, [failure]);
        } finally {
            media.close();
        }
    });

    test("a sink's own signal stops the conversion with ABORT", async () => {
        const { media } = await job();
        const cancellation = new AbortController();
        let aborts = 0;
        try {
            const stopped = media.convert('wav', {
                copy: false,
                sink: {
                    signal: cancellation.signal,
                    write: () => cancellation.abort(),
                    async close() {
                        assert.fail('a cancelled sink is not closed');
                    },
                    abort: async () => aborts++,
                },
            });
            await assert.rejects(stopped, error => error.code === 'ABORT');
            assert.equal(aborts, 1);
        } finally {
            media.close();
        }
    });

    test('an onProgress that throws ends the conversion with its error', async () => {
        const { media } = await job();
        const failure = new Error('callback aborted and failed');
        const controller = new AbortController();
        try {
            const thrown = await media
                .convert('wav', {
                    copy: false,
                    signal: controller.signal,
                    onProgress() {
                        controller.abort();
                        throw failure;
                    },
                })
                .catch(error => error);
            assert.equal(thrown, failure);
        } finally {
            media.close();
        }
    });

    test('options or open options that are no object fail with INPUT', async () => {
        await assert.rejects(convert(monoWav(), 'wav', null), inputError);
        await assert.rejects(convert(monoWav(), 'wav', { open: 42 }), inputError);
    });

    test('closing a Media stops its conversion and leaves the source open', async () => {
        let started;
        const reading = new Promise(resolve => (started = resolve));
        const source = {
            size: 2,
            closes: 0,
            read() {
                started();
                return new Promise(() => {});
            },
            close() {
                this.closes++;
            },
        };
        const reader = {
            formats: ['owned'],
            async read() {
                const sample = { offset: 0, size: 2, timestamp: 0, duration: 1 / 48000 };
                const track = { id: 7, codec: 'pcm-s16le', sampleRate: 48000, channelCount: 1 };
                const samples = [{ ...sample, isKeyframe: true }];
                const audio = { ...track, duration: 1 / 48000, samples };
                return { videoTracks: [], audioTracks: [audio] };
            },
        };
        const media = await open(source, {
            plugins: { add: [{ name: 'owned', readers: [readerPart(reader)] }] },
            format: 'owned',
            cacheBytes: 0,
        });
        let aborts = 0;
        const pending = media.convert('wav', {
            copy: false,
            sink: {
                write() {},
                async close() {
                    assert.fail('a stalled conversion does not finish');
                },
                abort: async () => aborts++,
            },
        });
        await reading;
        await assert.rejects(media.convert('wav', { copy: false }), inputError, 'one at a time');
        media.close();
        await assert.rejects(pending, error => error.code === 'ABORT');
        assert.deepEqual([aborts, source.closes], [1, 0]);
        media.close();
        assert.equal((await media.check('wav', { copy: false })).code, 'ABORT');
    });

    test('a Media runs one operation at a time', async () => {
        const media = await open(waveFixture());
        let nested;
        const closes = { outer: 0, nested: 0 };
        const sink = name => ({
            write() {},
            async close() {
                closes[name]++;
            },
        });
        try {
            const outer = media.convert({
                copy: false,
                sink: sink('outer'),
                get to() {
                    nested = media.convert('wav', { copy: false, sink: sink('nested') });
                    nested.catch(() => {});
                    return 'wav';
                },
            });
            const [first, second] = await Promise.allSettled([outer, nested]);
            assert.deepEqual([first.status, second.status], ['fulfilled', 'rejected']);
            assert.equal(second.reason.code, 'INPUT');
            assert.deepEqual(closes, { outer: 1, nested: 0 });
        } finally {
            media.close();
        }
    });

    test('convert() reads its target after holding the Media', async () => {
        const media = await open(waveFixture());
        let nested;
        let reads = 0;
        const target = {
            copy: false,
            get to() {
                reads++;
                nested = media.convert('wav', { sink: { write() {}, async close() {} } });
                nested.catch(() => {});
                return reads === 1 ? 'wav' : 'invalid';
            },
        };
        try {
            const result = media.convert(target);
            await assert.rejects(nested, inputError);
            assert.ok((await result).blob.size > 0);
            assert.equal(reads, 1);
        } finally {
            media.close();
        }
    });

    test('a cancelled stream stops the conversion and leaves the Media usable', async () => {
        const media = await open(waveFixture());
        try {
            const readable = new ReadableStreamSink({ highWaterMark: 1 });
            const running = media.convert('wav', {
                copy: false,
                sink: readable,
                signal: readable.signal,
            });
            const reader = readable.stream.getReader();
            await reader.read();
            await reader.cancel();
            await assert.rejects(running, error => error.code === 'ABORT');
            assert.equal((await media.check('wav', { copy: false })).supported, true);
        } finally {
            media.close();
        }
    });

    test('segments start with the init segment and come again the same', async () => {
        const media = await open(adtsFixture());
        try {
            const runs = [];
            for (let run = 0; run < 2; run++) {
                const segments = [];
                for await (const segment of media.segments({ targetDuration: 0.04 }))
                    segments.push(segment);
                runs.push(segments);
            }
            assert.equal(runs[0][0].kind, 'init');
            assert.ok(runs[0].some(segment => segment.kind === 'media'));
            assert.deepEqual(
                runs[1].map(segment => [...segment.data]),
                runs[0].map(segment => [...segment.data]),
            );
        } finally {
            media.close();
        }
    });

    test('segment options read while segmenting cannot start another operation', async () => {
        const media = await open(adtsFixture());
        let nested;
        const iterator = media.segments({
            get targetDuration() {
                nested = media.convert('aac', {
                    copy: true,
                    sink: { write() {}, async close() {} },
                });
                nested.catch(() => {});
                return 0.04;
            },
        });
        try {
            assert.equal((await iterator.next()).value.kind, 'init');
            await assert.rejects(nested, inputError);
        } finally {
            await iterator.return();
            media.close();
        }
    });

    test('a Media closed after its work leaves a borrowed source open', async () => {
        const { media, source, bytes } = await job();
        await media.convert('wav', { copy: false });
        media.close();
        assert.equal(source.closes, 0);
        assert.equal((await inspect(bytes)).tracks.length, 1);
        assert.equal((await convert(bytes, 'caf')).blob.type, 'audio/x-caf');
    });
});
