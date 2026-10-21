import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
    MediaForgeError,
    capabilities,
    check,
    convert,
    edit,
    encodeFrames,
    frames,
    inspect,
    open,
    packageMedia,
    thumbnail,
} from 'mediaforgejs';
import {
    decodeAacFrames,
    decodeAnimatedWebp,
    decodeFlac,
    decodeMp3,
    decodeStillWebp,
    encodeAacLc,
    encodeFlac,
    encodeMp2,
    encodeMp3,
} from 'mediaforgejs/codecs';
import { decodeAudio } from 'mediaforgejs/parts';
import { greyAvi, movie, toneWav } from '../helpers/api-fixtures.mjs';
import { FIXTURES } from '../helpers/new-format-fixtures.mjs';
import { installVideoCodecs } from '../helpers/webcodecs-video-harness.mjs';

// One abort rule: a signal stops every public operation with the library's ABORT error, the
// signal's reason kept as its cause; a reason that is itself a library error is the rejection.

/** A signal aborted with `reason` (the host's AbortError when none). */
const abortedWith = reason => {
    const controller = new AbortController();
    controller.abort(reason);
    return controller.signal;
};

/** Whether `error` is ABORT with the reason of `signal` as its cause. */
const abortOf = signal => error =>
    error instanceof MediaForgeError && error.code === 'ABORT' && error.cause === signal.reason;

const wav = () => new Blob([toneWav()]);
const mp4 = () => new Blob([movie()]);
const planes = () => [new Float32Array(48000), new Float32Array(48000)];

/** Every public operation, run with `signal`. */
const OPERATIONS = {
    'convert()': signal => convert(wav(), { to: 'flac', signal }),
    'convert() with copy': signal => convert(mp4(), { to: 'mkv', copy: true, signal }),
    'packageMedia()': signal => packageMedia(mp4(), 'hls', { signal }),
    'edit()': signal => edit({ clips: [{ input: wav() }] }, { to: 'wav', signal }),
    'inspect()': signal => inspect(wav(), { signal }),
    'open()': signal => open(wav(), { signal }),
    'thumbnail()': signal => thumbnail(new Blob([greyAvi()]), { time: 0, signal }),
    'frames()': async signal => {
        for await (const _ of frames(new Blob([greyAvi()]), { signal }));
    },
    'capabilities()': signal => capabilities({ signal }),
    'media.convert()': async signal => {
        const media = await open(wav());
        try {
            await media.convert('flac', { signal });
        } finally {
            media.close();
        }
    },
    'decodeAudio()': async signal => {
        const media = await open(wav());
        try {
            const pcm = await decodeAudio(media, media.tracks[0].id, { signal });
            for await (const _ of pcm.chunks(signal));
        } finally {
            media.close();
        }
    },
    'encodeMp3()': signal => encodeMp3(planes(), { sampleRate: 48000, signal }),
    'encodeMp2()': signal => encodeMp2(planes(), { sampleRate: 48000, signal }),
    'encodeFlac()': signal => encodeFlac(planes(), { sampleRate: 48000, signal }),
    'encodeAacLc()': signal => encodeAacLc(planes(), { sampleRate: 48000, signal }),
    'decodeAacFrames()': async signal => {
        const encoded = await encodeAacLc(planes(), { sampleRate: 48000 });
        await decodeAacFrames(encoded, { signal });
    },
    'decodeMp3()': async signal => {
        await decodeMp3(await encodeMp3(planes(), { sampleRate: 48000 }), { signal });
    },
    'decodeFlac()': async signal => {
        await decodeFlac(await encodeFlac(planes(), { sampleRate: 48000 }), { signal });
    },
    'decodeStillWebp()': signal =>
        decodeStillWebp(FIXTURES['still-lossless.webp'].bytes(), { signal }),
    'decodeAnimatedWebp()': signal =>
        decodeAnimatedWebp(FIXTURES['anim-lossless.webp'].bytes(), { signal }),
};

describe('aborting', () => {
    let host;
    before(() => {
        host = installVideoCodecs({ encodeSupport: config => config.codec === 'vp8' });
    });
    after(() => host.restore());

    describe('an aborted signal stops each operation with ABORT, its reason the cause', () => {
        for (const [name, run] of Object.entries(OPERATIONS))
            test(name, async () => {
                const signal = abortedWith();
                await assert.rejects(run(signal), abortOf(signal));
            });

        test('encodeFrames()', async () => {
            const signal = abortedWith();
            const frame = new VideoFrame(new Uint8Array(32 * 24 * 4), {
                format: 'RGBA',
                codedWidth: 32,
                codedHeight: 24,
                timestamp: 0,
            });
            await assert.rejects(encodeFrames([frame], { to: 'webm', signal }), abortOf(signal));
        });

        test('check() reports ABORT instead of rejecting', async () => {
            const result = await check(wav(), 'flac', { signal: abortedWith() });
            assert.deepEqual([result.supported, result.code], [false, 'ABORT']);
        });
    });

    test('a reason that is a library error is the rejection itself', async () => {
        const timeout = new MediaForgeError('the source timed out', 'IO');
        for (const name of ['convert()', 'inspect()', 'encodeMp3()', 'decodeAacFrames()'])
            await assert.rejects(OPERATIONS[name](abortedWith(timeout)), error => {
                assert.equal(error, timeout, name);
                return true;
            });
    });

    test('an abort while the work runs stops it with ABORT', async () => {
        const controller = new AbortController();
        const running = convert(new Blob([toneWav(4)]), {
            to: 'mp3',
            signal: controller.signal,
            onProgress: progress => {
                if (progress.fraction > 0) controller.abort();
            },
        });
        await assert.rejects(running, abortOf(controller.signal));
        const encoding = encodeFlac([new Float32Array(48000 * 20)], {
            sampleRate: 48000,
            signal: controller.signal,
        });
        await assert.rejects(encoding, abortOf(controller.signal));
    });
});
