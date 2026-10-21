import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, check, convert, inspect, isMediaForgeError } from 'mediaforgejs';
import { MemorySink, ReadableStreamSink } from 'mediaforgejs/io';
import { codes, firstPackets, movie, reopen, toneWav } from '../helpers/api-fixtures.mjs';
import { MP3_FIXTURES } from '../helpers/mp3-fixtures.mjs';
import { waveFixture } from '../helpers/original-fixtures.mjs';

// convert(): the file it writes for a target, where the bytes go, how it stops, and what it
// reports.

const inputError = error => error.code === 'INPUT';
const aborted = () => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
};

describe('convert()', () => {
    describe('targets', () => {
        test('PCM is copied into AIFF and Matroska without a warning', async () => {
            const warnings = [];
            const forge = new MediaForge({ onWarning: warning => warnings.push(warning) });
            const { blob: aiff } = await forge.convert(waveFixture(), { to: 'aiff' });
            assert.equal(aiff.type, 'audio/aiff');
            const head = new Uint8Array(await aiff.arrayBuffer()).subarray(0, 4);
            assert.equal(new TextDecoder().decode(head), 'FORM');
            const { blob: mkv } = await forge.convert(waveFixture(), { to: 'MKV' });
            assert.deepEqual(await reopen(mkv), {
                format: 'mkv',
                tracks: [{ type: 'audio', codec: 'pcm-s16le' }],
            });
            assert.deepEqual(codes(warnings), []);
        });

        test('PCM that MP4 cannot hold is encoded, with TARGET_REENCODED', async () => {
            const warnings = [];
            const forge = new MediaForge({ onWarning: warning => warnings.push(warning) });
            const reencoded = await reopen(
                (await forge.convert(waveFixture(), { to: 'mp4' })).blob,
            );
            assert.equal(reencoded.format, 'mp4');
            assert.equal(reencoded.tracks[0].type, 'audio');
            assert.match(reencoded.tracks[0].codec, /^mp4a/);
            assert.deepEqual(codes(warnings), ['TARGET_REENCODED']);
            assert.match(warnings[0].message, /pcm/);
        });

        test('a target that can neither copy nor re-encode names both reasons', async () => {
            await assert.rejects(
                convert(waveFixture(), { to: 'webm' }),
                error =>
                    error.code !== 'INPUT' &&
                    new RegExp(
                        '^webm cannot copy these tracks \\(it cannot hold pcm-s16le\\) or ' +
                            're-encode them \\(.+\\)$',
                    ).test(error.message) &&
                    /^copy: webm cannot mux audio codec 'pcm-s16le'; re-encode: ./.test(
                        error.cause,
                    ),
            );
        });

        test('a package target, a picture of sound and no format fail before writing', async () => {
            await assert.rejects(convert(waveFixture(), { to: 'hls' }), inputError);
            await assert.rejects(
                convert(waveFixture(), { to: 'png' }),
                error => error.code === 'FORMAT',
            );
            await assert.rejects(convert(waveFixture(), { to: 'nope' }), inputError);
        });

        test('an input that is no file fails with INPUT', async () => {
            await assert.rejects(convert('text', { to: 'png' }), inputError);
        });

        test('a null or undefined input fails with INPUT, not a TypeError', async () => {
            await assert.rejects(convert(null, 'mp4'), inputError);
            await assert.rejects(inspect(undefined), inputError);
            assert.equal((await check(null, 'mp4')).code, 'INPUT');
        });

        test('a format name alone is the target', async () => {
            assert.equal((await convert(waveFixture(), 'au')).blob.type, 'audio/basic');
        });

        test('video settings for an input without video are ignored and reported', async () => {
            const silent = { to: 'mkv', video: { width: 320 } };
            const ignored = await convert(waveFixture(), silent);
            assert.deepEqual(codes(ignored.warnings), ['OPTION_IGNORED']);
            assert.deepEqual((await reopen(ignored.blob)).tracks, [
                { type: 'audio', codec: 'pcm-s16le' },
            ]);
        });

        test('strict validation of the input refuses settings it cannot apply', async () => {
            await assert.rejects(
                convert(waveFixture(), {
                    to: 'mkv',
                    video: { width: 320 },
                    open: { validation: 'strict' },
                }),
                error => error.code === 'FORMAT',
            );
        });
    });

    describe('warnings', () => {
        test('findings reach onWarning and the result; check() has them, unheard', async () => {
            const warnings = [];
            const forge = new MediaForge({ onWarning: warning => warnings.push(warning) });
            const target = { to: 'wav', audio: { sampleRate: 8000, bitrate: 128 } };
            const checked = await forge.check(waveFixture(), target);
            assert.ok(codes(checked.warnings).includes('OPTION_NORMALIZED'));
            assert.deepEqual(warnings, []);
            const converted = await forge.convert(waveFixture(), target);
            assert.ok(codes(converted.warnings).includes('OPTION_NORMALIZED'));
            assert.deepEqual(codes(warnings), codes(converted.warnings));
        });
    });

    describe('sinks', () => {
        test('a sink receives the file and is closed once', async () => {
            const chunks = [];
            let closed = 0;
            await convert(waveFixture(), {
                to: 'au',
                sink: {
                    write(data) {
                        chunks.push(data.slice());
                    },
                    async close() {
                        closed++;
                    },
                },
            });
            assert.equal(closed, 1);
            assert.equal(new TextDecoder().decode(chunks[0].subarray(0, 4)), '.snd');
        });

        test('a readable stream sink streams the file as it is written', async () => {
            const readable = new ReadableStreamSink();
            const [, chunks] = await Promise.all([
                convert(waveFixture(), { to: 'aiff', sink: readable }),
                Array.fromAsync(readable.stream),
            ]);
            assert.equal(new TextDecoder().decode(chunks[0].subarray(0, 4)), 'FORM');
        });

        test('a Blob, a MemorySink and a readable stream hold the same file', async () => {
            const target = { to: 'flac', audio: { sampleRate: 24000 } };
            const blob = await (await convert(toneWav(), target)).blob.arrayBuffer();
            const memory = new MemorySink();
            await convert(toneWav(), { ...target, sink: memory });
            const readable = new ReadableStreamSink();
            const [, streamed] = await Promise.all([
                convert(toneWav(), { ...target, sink: readable }),
                new Response(readable.stream).arrayBuffer(),
            ]);
            assert.deepEqual(memory.toUint8Array(), new Uint8Array(blob));
            assert.deepEqual(new Uint8Array(streamed), new Uint8Array(blob));
        });

        test('a file over maxBytes is OOM in check() and in convert() to a sink', async () => {
            const { blob } = await convert(waveFixture(), 'm4a');
            const limited = { maxBytes: blob.size - 1 };
            assert.equal((await check(waveFixture(), 'm4a', limited)).code, 'OOM');
            await assert.rejects(
                convert(waveFixture(), 'm4a', { ...limited, sink: new MemorySink() }),
                error => error.code === 'OOM',
            );
        });

        test('a readable stream holds the Blob and is held to maxBytes', async () => {
            for (const copy of [true, false]) {
                const expected = await (
                    await convert(waveFixture(), 'wav', { copy })
                ).blob.arrayBuffer();
                const readable = new ReadableStreamSink({ highWaterMark: 16 });
                const [, actual] = await Promise.all([
                    convert(waveFixture(), 'wav', { copy, sink: readable }),
                    new Response(readable.stream).arrayBuffer(),
                ]);
                assert.deepEqual(new Uint8Array(actual), new Uint8Array(expected));
                const limited = new ReadableStreamSink();
                new Response(limited.stream).arrayBuffer().catch(() => {});
                await assert.rejects(
                    convert(waveFixture(), 'wav', { copy, sink: limited, maxBytes: 12 }),
                    error => error.code === 'OOM',
                );
            }
        });

        test('cancelling the stream stops the conversion with ABORT', async () => {
            const cancelled = new ReadableStreamSink({ highWaterMark: 1 });
            const running = convert(waveFixture(), {
                to: 'mkv',
                sink: cancelled,
                signal: cancelled.signal,
            });
            await cancelled.stream.cancel('done early');
            await assert.rejects(running, error => error.code === 'ABORT');
        });

        test('a package or an unknown format with a sink fails with INPUT', async () => {
            for (const to of ['hls', 'nope'])
                await assert.rejects(
                    convert(waveFixture(), { to, sink: new ReadableStreamSink() }),
                    inputError,
                    to,
                );
            await assert.rejects(
                convert(waveFixture(), { to: 'hls', sink: { write() {}, async close() {} } }),
                inputError,
            );
        });
    });

    describe('stopping', () => {
        test('an aborted signal stops before writing', async () => {
            for (const to of ['aiff', 'au'])
                await assert.rejects(
                    convert(waveFixture(), { to, signal: aborted() }),
                    error => error.code === 'ABORT',
                    to,
                );
        });

        test('an abort while the input read stalls ends the conversion', async () => {
            const wav = toneWav();
            const abort = new AbortController();
            let reads = 0;
            const stalling = {
                size: wav.length,
                async read(at, length) {
                    if (++reads > 2 && at >= 44) {
                        queueMicrotask(() => abort.abort());
                        return new Promise(() => {});
                    }
                    return wav.slice(at, at + length);
                },
            };
            await assert.rejects(
                convert(stalling, { to: 'flac', signal: abort.signal, open: { cacheBytes: 0 } }),
                error => error.code === 'ABORT',
            );
        });

        test('an abort while encoding stops the conversion', async () => {
            const cancellation = new AbortController();
            let reads = 0;
            const wav = waveFixture();
            const source = {
                size: wav.length,
                async read(at, size) {
                    // The first packet read aborts.
                    if (at >= 44) {
                        reads++;
                        cancellation.abort();
                    }
                    return wav.slice(at, at + size);
                },
            };
            await assert.rejects(
                convert(source, {
                    to: 'wav',
                    copy: false,
                    signal: cancellation.signal,
                    open: { cacheBytes: 0 },
                }),
                error => error.code === 'ABORT',
            );
            assert.equal(reads, 1);
        });

        test('calls keep their order and failures; each reads its target when called', async () => {
            const targets = Array.from({ length: 5 }, () => ({ to: 'wav', copy: false }));
            targets[2].trackIds = [99];
            const pending = targets.map(target => convert(waveFixture(), target));
            targets[1].to = 'invalid';
            const results = await Promise.allSettled(pending);
            assert.deepEqual(
                results.map(result => result.status),
                ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled'],
            );
            assert.equal(results[1].value.format, 'wav');
        });

        test('calls run independently: one failing does not stop the others', async () => {
            const results = await Promise.allSettled([
                convert(waveFixture(), 'au'),
                convert(waveFixture(), 'nope'),
                convert(waveFixture(), 'flac'),
            ]);
            assert.deepEqual(
                results.map(result => result.status),
                ['fulfilled', 'rejected', 'fulfilled'],
            );
            assert.equal(results[0].value.blob.type, 'audio/basic');
            assert.equal(results[1].reason.code, 'INPUT');
        });
    });

    describe('option policy', () => {
        test('a strict MediaForge refuses repairs and copies what is clean, silently', async () => {
            const warnings = [];
            const forge = new MediaForge({
                optionPolicy: 'strict',
                onWarning: warning => warnings.push(warning),
            });
            const repair = { to: 'aiff', audio: { channels: '2' } };
            await assert.rejects(forge.convert(waveFixture(), repair), inputError);
            const copy = await forge.convert(waveFixture(), { to: 'aiff' });
            assert.equal(copy.blob.type, 'audio/aiff');
            assert.deepEqual(warnings, []);
            const media = await forge.open(waveFixture());
            try {
                assert.equal((await media.check(repair)).code, 'INPUT');
            } finally {
                media.close();
            }
        });

        test('a common option given as undefined keeps the instance setting', async () => {
            const forge = new MediaForge({ optionPolicy: 'strict' });
            await assert.rejects(
                forge.convert(waveFixture(), {
                    to: 'aiff',
                    audio: { channels: '2' },
                    optionPolicy: undefined,
                }),
                inputError,
            );
        });
    });
});

describe('convert() results', () => {
    const clip = () => new File([movie()], 'holiday clip.mp4', { type: 'video/mp4' });

    test('a result names its file and reports its plan once, before writing', async () => {
        const events = [];
        const plans = [];
        const copied = await convert(clip(), 'mkv', {
            onProgress: event => events.push(event),
            onPlan: report => plans.push(report),
        });
        assert.deepEqual(
            [copied.format, copied.mimeType, copied.blob.type, copied.filename],
            ['mkv', 'video/x-matroska', 'video/x-matroska', 'holiday clip.mkv'],
        );
        assert.equal(copied.plan.action, 'copy');
        assert.deepEqual(
            copied.plan.tracks.map(track => [track.trackId, track.type, track.action, track.codec]),
            [
                [11, 'video', 'copy', 'avc1.42000a'],
                [12, 'audio', 'copy', 'mp4a.40.2'],
            ],
        );
        assert.deepEqual(plans, [copied.plan]);
        assert.equal((await reopen(copied.blob)).format, 'mkv');
    });

    test('progress is one fraction object, ending at 1 in its stage', async () => {
        for (const copy of [true, false]) {
            const updates = [];
            await convert(waveFixture(), 'wav', {
                copy,
                onProgress: update => updates.push(update),
            });
            assert.ok(updates.length > 0);
            assert.ok(updates.every(update => update.fraction >= 0 && update.fraction <= 1));
            assert.deepEqual(
                [updates.at(-1).fraction, updates.at(-1).stage],
                [1, copy ? 'copy' : 'encode'],
            );
        }
    });

    test('progress rises to 1 within the duration while copying', async () => {
        const events = [];
        await convert(clip(), 'mkv', { onProgress: event => events.push(event) });
        assert.ok(events.length >= 2);
        assert.ok(events.every(event => event.stage === 'copy'));
        assert.ok(
            events.every(
                (event, index) => index === 0 || event.fraction >= events[index - 1].fraction,
            ),
        );
        assert.equal(events.at(-1).fraction, 1);
        assert.ok(
            events.every(
                event =>
                    event.duration > 0 && event.time >= 0 && event.time <= event.duration + 1e-9,
            ),
        );
    });

    test('one target object works as well as a format and options', async () => {
        assert.equal((await convert(clip(), { to: 'mkv' })).plan.action, 'copy');
    });

    test('an input without a name is written as output', async () => {
        assert.equal((await convert(movie(), 'mkv')).filename, 'output.mkv');
    });

    test('a range without `to` copies into the input container', async () => {
        const trimmed = await convert(clip(), { start: 0.2, end: 0.4 });
        assert.deepEqual([trimmed.format, trimmed.plan.action], ['mp4', 'copy']);
        assert.ok(codes(trimmed.warnings).includes('TRIM_SNAPPED'));
        assert.ok(Math.abs(trimmed.plan.duration - 0.2) < 1e-6);
        assert.equal((await convert(clip(), { start: 0.2, end: 0.4, to: 'mkv' })).format, 'mkv');
    });

    test('an audio format takes the audio of a movie, or a chosen track', async () => {
        const soundtrack = await convert(clip(), 'm4a');
        assert.deepEqual(
            soundtrack.plan.tracks.map(track => track.type),
            ['audio'],
        );
        const flac = await convert(toneWav(), 'flac', { trackIds: [1] });
        assert.equal(flac.mimeType, 'audio/flac');
        assert.equal((await reopen(flac.blob)).format, 'flac');
    });

    test('m4a takes the FLAC audio.codec asks for, not AAC with OPTION_IGNORED', async () => {
        for (const to of ['m4a', 'mp4']) {
            const warnings = [];
            const result = await convert(toneWav(), to, {
                audio: { codec: 'flac' },
                onWarning: warning => warnings.push(warning),
            });
            assert.deepEqual(codes(warnings), [], to);
            assert.deepEqual(
                (await reopen(result.blob)).tracks.map(track => track.codec),
                ['flac'],
            );
        }
    });

    test('dropping the video of a movie for m4a is reported', async () => {
        const warnings = [];
        const audioOnly = await convert(movie(), 'm4a', {
            onWarning: warning => warnings.push(warning),
        });
        assert.ok(codes(warnings).includes('TARGET_TRACKS_DROPPED'));
        assert.deepEqual(
            (await reopen(audioOnly.blob)).tracks.map(track => track.type),
            ['audio'],
        );
    });

    test('several inputs convert in order; one failing does not stop the others', async () => {
        const all = await Promise.allSettled(
            [toneWav(), new Blob(['not media']), toneWav()].map(input =>
                convert(input, 'wav', { audio: { sampleRate: 16000 } }),
            ),
        );
        assert.deepEqual(
            all.map(result => result.status),
            ['fulfilled', 'rejected', 'fulfilled'],
        );
        assert.equal(all[0].value.format, 'wav');
        assert.ok(isMediaForgeError(all[1].reason));
    });
});

describe('convert() audio', () => {
    test("bitrates are bits per second: '96k' needs no repair, 96 is read as kbit/s", async () => {
        const mp3 = await convert(toneWav(), 'mp3', { audio: { bitrate: '96k' } });
        assert.equal(mp3.mimeType, 'audio/mpeg');
        assert.equal(mp3.plan.action, 'reencode');
        assert.deepEqual(
            mp3.plan.tracks.map(track => [track.type, track.action, track.codec, track.encoder]),
            [['audio', 'encode', 'mp3', 'builtin']],
        );
        assert.deepEqual(codes(mp3.warnings), []);
        const kbps = await convert(toneWav(), 'mp3', { audio: { bitrate: 96 } });
        assert.deepEqual(codes(kbps.warnings), ['OPTION_NORMALIZED']);
        assert.match(kbps.warnings[0].message, /96 kbit\/s \(96000 bits per second\)/);
        assert.equal(kbps.blob.size, mp3.blob.size);
    });

    test('an MP3 target copies MP3 frames and keeps the gapless window', async () => {
        const fixture = MP3_FIXTURES[0].bytes();
        const { blob: copied } = await convert(fixture, 'mp3');
        assert.deepEqual(await firstPackets(copied), await firstPackets(fixture));
        // The copy states the source's encoder delay and padding (an Info frame with a LAME tag).
        const presented = async input => {
            const wav = await convert(input instanceof Blob ? input : new Blob([input]), 'wav');
            const [track] = (await inspect(wav.blob)).tracks;
            return Math.round(track.duration * track.sampleRate);
        };
        assert.equal(await presented(copied), MP3_FIXTURES[0].sampleFrames);
        assert.equal(await presented(fixture), MP3_FIXTURES[0].sampleFrames);
    });

    test('settings re-encode MP3 into MP3', async () => {
        const fixture = MP3_FIXTURES[0].bytes();
        const reencoded = await convert(fixture, { to: 'mp3', audio: { bitrate: 32000 } });
        assert.notDeepEqual(await firstPackets(reencoded.blob), await firstPackets(fixture));
        assert.equal((await reopen((await convert(fixture, 'wav')).blob)).format, 'wav');
    });
});
