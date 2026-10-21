import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, check, convert, open } from 'mediaforgejs';
import { encodePng } from 'mediaforgejs/codecs';
import { codes, movie } from '../helpers/api-fixtures.mjs';
import { adtsFixture, waveFixture } from '../helpers/original-fixtures.mjs';
import { readerPart } from '../helpers/parts.mjs';

const inputError = error => error.code === 'INPUT';

// check(): whether a target can be written from an input, with the plan or the code, reason and
// hint of the failure, without writing; convert() fails with the same code.

describe('check()', () => {
    test('says whether tracks are copied or re-encoded', async () => {
        const plans = [
            [{ to: 'aiff' }, 'copy'],
            [{ to: 'aiff', audio: { sampleRate: 8000 } }, 'reencode'],
            [{ to: 'mkv' }, 'copy'],
            [{ to: 'mp4' }, 'reencode'],
        ];
        for (const [target, action] of plans) {
            const support = await check(waveFixture(), target);
            assert.deepEqual([support.supported, support.plan.action], [true, action], target.to);
        }
    });

    test('a target that can neither copy nor re-encode is unsupported, with why', async () => {
        const neither = await check(waveFixture(), { to: 'webm' });
        assert.equal(neither.supported, false);
        assert.match(neither.reason, /cannot copy/);
    });

    test('a package needs video or audio it can package', async () => {
        assert.equal((await check(waveFixture(), { to: 'hls' })).supported, false);
        const movies = await check(movie(), { to: 'hls' });
        assert.deepEqual([movies.supported, movies.plan.action], [true, 'package']);
    });

    test('a still picture plans an image conversion', async () => {
        const png = new Blob([await encodePng({ data: new Uint8Array(64), width: 4, height: 4 })]);
        const image = await check(png, { to: 'png' });
        assert.deepEqual([image.supported, image.plan.action], [true, 'image']);
    });

    test('audio holds no picture to take; convert() fails with the same code', async () => {
        const silent = await check(new Blob([waveFixture()]), { to: 'png' });
        assert.equal(silent.supported, false);
        await assert.rejects(
            convert(new Blob([waveFixture()]), { to: 'png' }),
            error => error.code === silent.code,
        );
    });

    test('without OffscreenCanvas a JPEG of media fails with ENCODE before decoding', async () => {
        assert.equal((await check(new Blob([waveFixture()]), { to: 'jpg' })).code, 'ENCODE');
        await assert.rejects(
            convert(new Blob([waveFixture()]), { to: 'jpg' }),
            error => error.code === 'ENCODE',
        );
    });

    test('an input that is no file or a format that does not exist is INPUT', async () => {
        for (const [input, target] of [
            ['text', { to: 'png' }],
            [waveFixture(), { to: 'nope' }],
        ]) {
            const refused = await new MediaForge().check(input, target);
            assert.deepEqual([refused.supported, refused.code], [false, 'INPUT']);
        }
    });
});

describe('check() of an open input', () => {
    /** Four 16-bit samples at 8 kHz in a track of the 'owned' format. */
    const pcmTrack = (extra = {}) => ({
        id: 1,
        codec: 'pcm-s16le',
        sampleRate: 8000,
        channelCount: 1,
        duration: 4 / 8000,
        samples: [{ offset: 0, size: 8, timestamp: 0, duration: 4 / 8000, isKeyframe: true }],
        ...extra,
    });
    /** Opens eight bytes read by `read` as the 'owned' format of `tracks`. */
    const owned = (tracks, read, options = {}) => {
        const reader = {
            formats: ['owned'],
            async read() {
                return { videoTracks: [], audioTracks: tracks };
            },
        };
        const source = {
            size: 8,
            read: read ?? (async (at, size) => new Uint8Array(8).slice(at, at + size)),
        };
        return open(source, {
            plugins: { add: [{ name: 'owned', readers: [readerPart(reader)] }] },
            format: 'owned',
            ...options,
        });
    };
    const sink = () => ({ write() {}, patchAt() {}, async close() {} });

    test('check() reads the packets once; convert() does not read them again first', async () => {
        let reads = 0;
        const counting = async (_at, size) => {
            reads++;
            return new Uint8Array(size);
        };
        const media = await owned([pcmTrack()], counting, { cacheBytes: 0 });
        try {
            assert.equal(reads, 0, 'open reads the structure only');
            const checked = media.check('wav', { copy: false });
            assert.ok(checked instanceof Promise);
            assert.equal((await checked).supported, true);
            assert.equal(reads, 1);
            await media.convert('wav', { copy: false, sink: sink() });
            assert.equal(reads, 2, 'one pass for a seekable output');
        } finally {
            media.close();
        }
    });

    test('short packet reads fail check(), copy or not; a later conversion works', async () => {
        let short = true;
        const read = async (_at, size) => new Uint8Array(short ? size - 1 : size);
        const media = await owned([pcmTrack()], read, { cacheBytes: 0 });
        try {
            assert.equal((await media.check('wav', { copy: false })).supported, false);
            assert.equal((await media.check('wav', { copy: true })).supported, false);
            short = false;
            await media.convert('wav', { copy: false, sink: sink() });
        } finally {
            media.close();
        }
    });

    test('check() reports to no listener and reads its target once', async () => {
        let warnings = 0;
        let progress = 0;
        let formats = 0;
        const media = await owned([pcmTrack({ name: 'Named' })], undefined, {
            onWarning: () => warnings++,
        });
        try {
            const checked = await media.check({
                copy: false,
                get to() {
                    return ++formats === 1 ? 'wav' : 'invalid';
                },
                onProgress: () => progress++,
            });
            assert.equal(checked.supported, true);
            assert.ok(codes(checked.warnings).includes('TRACK_METADATA_LOSS'));
            assert.deepEqual([formats, warnings, progress], [1, 0, 0]);
            await media.convert('wav', { copy: false, sink: sink() });
            assert.ok(warnings > 0, 'convert() reports');
        } finally {
            media.close();
        }
    });

    test('check() holds the Media from its first getter until it is aborted', async () => {
        let started;
        const reading = new Promise(resolve => (started = resolve));
        let hang = true;
        const read = async (_at, size) => {
            if (!hang) return new Uint8Array(size);
            started();
            return new Promise(() => {});
        };
        const media = await owned([pcmTrack()], read, { cacheBytes: 0 });
        const controller = new AbortController();
        let nested;
        const checked = media.check({
            copy: false,
            get to() {
                nested = media.check('wav');
                return 'wav';
            },
            signal: controller.signal,
        });
        try {
            const refused = await nested;
            assert.deepEqual([refused.supported, refused.code], [false, 'INPUT']);
            await reading;
            await assert.rejects(media.convert('wav', { sink: sink() }), inputError);
            controller.abort();
            assert.equal((await checked).code, 'ABORT');
            hang = false;
            await media.convert('wav', { copy: false, sink: sink() });
        } finally {
            media.close();
        }
    });

    test('AAC whose payloads do not decode fails check() with DECODE', async () => {
        const media = await open(adtsFixture());
        try {
            const checked = await media.check('wav');
            assert.deepEqual([checked.supported, checked.code], [false, 'DECODE']);
        } finally {
            media.close();
        }
    });

    test('check() holds the output to maxBytes as convert() does', async () => {
        const media = await open(waveFixture());
        try {
            for (const copy of [false, true]) {
                const { blob } = await media.convert('wav', { copy });
                const over = { copy, maxBytes: blob.size - 1 };
                const support = await media.check('wav', over);
                assert.deepEqual([support.supported, support.code], [false, 'OOM']);
                await assert.rejects(media.convert('wav', over), error => error.code === 'OOM');
                const exact = await media.check('wav', { copy, maxBytes: blob.size });
                assert.equal(exact.supported, true);
                assert.equal((await check(waveFixture(), 'wav', over)).code, 'OOM');
            }
        } finally {
            media.close();
        }
    });

    test('check() reads maxBytes once and takes inherited open limits', async () => {
        const media = await open(waveFixture());
        let budgets = 0;
        const options = {
            copy: false,
            get maxBytes() {
                budgets++;
                return 1;
            },
        };
        try {
            assert.equal((await media.check('wav', options)).code, 'OOM');
            assert.equal(budgets, 1);
            assert.equal((await check(waveFixture(), 'wav', options)).code, 'OOM');
            assert.equal(budgets, 2);
            const limits = Object.create({ maxPacketBytes: 1 });
            const limited = await check(waveFixture(), 'wav', { copy: false, open: limits });
            assert.equal(limited.code, 'OOM');
        } finally {
            media.close();
        }
    });
});
