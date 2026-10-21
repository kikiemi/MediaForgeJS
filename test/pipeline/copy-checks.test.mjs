import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspect, open } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';
import { atomList, preservationFixture } from '../helpers/mp4-preservation-fixture.mjs';
import { originalFixtures, waveFixture } from '../helpers/original-fixtures.mjs';
import { readAll } from '../helpers/read-media.mjs';
import { structuralStreams } from '../helpers/spec-streams.mjs';
import {
    aviPcmFixture,
    matroskaFixture,
    parseMatroska,
} from '../helpers/multitrack-pcm-fixtures.mjs';

// check() of a copy says what convert() does: the same support, code and message, without
// writing, reporting progress or warning.

/** Asserts that check() and convert() of a copy into `format` agree, and that it is `expected`. */
async function assertParity(media, format, expected) {
    const support = await media.check(format, { copy: true });
    let error;
    try {
        await media.convert(format, { copy: true, sink: new MemorySink() });
    } catch (caught) {
        error = caught;
    }
    assert.equal(support.supported, !error, support.reason ?? error?.message);
    assert.equal(support.supported, expected, `${format}: ${support.reason}`);
    if (error) assert.deepEqual([support.code, support.reason], [error.code, error.message]);
}

/** Runs `use` with `input` opened with `options`, closing it after. */
async function withMedia(input, options, use) {
    const media = await open(input, options);
    try {
        return await use(media);
    } finally {
        media.close();
    }
}

describe('copy: checks agree with copies', () => {
    test('a copy a container cannot hold fails with FORMAT before any write', async () => {
        await withMedia(classicMp4().bytes, {}, async media => {
            const sink = new MemorySink();
            await assert.rejects(media.convert('avi', { copy: true, sink }), { code: 'FORMAT' });
            assert.equal(sink.size, 0);
        });
    });

    for (const count of [1, 2, 19])
        test(`an MP4 of ${count} AAC packets checks and copies alike`, async () => {
            await withMedia(classicMp4({ count }).bytes, {}, async media => {
                for (const format of ['m4a', 'mp4', 'mkv', 'fmp4'])
                    await assertParity(media, format, true);
            });
        });

    test('MPEG-2 program stream video checks and copies alike in every container', async () => {
        await withMedia(originalFixtures['mpeg2-bframes.mpg'](), {}, async media => {
            for (const format of ['mp4', 'mov', 'm4v', 'mkv', 'ts', 'avi'])
                await assertParity(media, format, true);
            for (const format of ['3gp', 'webm', 'flv', 'fmp4'])
                await assertParity(media, format, false);
        });
    });

    test('an MP4 copy of a track only fragments carry is written as fragmented MP4', async () => {
        // WebVTT cues (wvtt) go into fragments only: the copy into MP4 is fragmented MP4.
        const { bytes } = preservationFixture({
            tracks: [{ type: 'audio' }, { type: 'subtitle' }],
        });
        await withMedia(bytes, {}, async media => {
            await assertParity(media, 'mp4', true);
            const output = new Uint8Array(
                await (await media.convert('mp4', { copy: true })).blob.arrayBuffer(),
            );
            const boxes = new Set(atomList(output).map(box => box.type));
            assert(boxes.has('moof') && boxes.has('mdat'), [...boxes].join(' '));
            const info = await inspect(output);
            assert.deepEqual(
                info.tracks.map(track => track.codec),
                ['mp4a.40.2', 'wvtt'],
            );
        });
    });

    test('a check reads each option once, reports no progress and warns of nothing', async () => {
        const warnings = [];
        const options = { onWarning: warning => warnings.push(warning) };
        await withMedia(waveFixture(), options, async media => {
            let calls = 0;
            const before = media.warnings;
            const reads = {};
            const target = {};
            const values = { to: 'aiff', copy: true, onProgress: () => calls++ };
            for (const [key, value] of Object.entries(values))
                Object.defineProperty(target, key, {
                    get() {
                        reads[key] = (reads[key] ?? 0) + 1;
                        return value;
                    },
                });
            assert.equal((await media.check(target)).supported, true);
            assert.deepEqual(reads, { to: 1, copy: 1, onProgress: 1 });
            assert.equal(calls, 0);
            assert.deepEqual([warnings, media.warnings], [[], before]);
            const sink = new MemorySink();
            await media.convert('aiff', { copy: true, sink, onProgress: () => calls++ });
            assert.ok(calls > 0);
        });
    });

    test('short source reads fail check and copy alike without spoiling the input', async () => {
        const data = classicMp4({ count: 3 }).bytes;
        let short = false;
        const source = {
            size: data.length,
            read: async (offset, length) => data.slice(offset, offset + length - (short ? 1 : 0)),
        };
        await withMedia(source, { cacheBytes: 0 }, async media => {
            short = true;
            await assertParity(media, 'm4a', false);
            short = false;
            await assertParity(media, 'm4a', true);
        });
    });

    test('an aborted check and a closed input report no support', async () => {
        const media = await open(waveFixture());
        const controller = new AbortController();
        controller.abort();
        const aborted = await media.check('wav', { copy: true, signal: controller.signal });
        assert.deepEqual([aborted.supported, aborted.code], [false, 'ABORT']);
        media.close();
        const closed = await media.check('wav', { copy: true });
        assert.deepEqual([closed.supported, closed.code], [false, 'ABORT']);
    });

    test('a signal that is no AbortSignal is dropped with a warning', async () => {
        await withMedia(waveFixture(), {}, async media => {
            const repaired = await media.check('wav', { copy: true, signal: 1 });
            assert.equal(repaired.supported, true);
            assert.deepEqual(
                repaired.warnings.map(warning => warning.code),
                ['OPTION_IGNORED'],
            );
        });
    });

    test('strict options refuse it in check and copy alike, before any write', async () => {
        await withMedia(waveFixture(), { optionPolicy: 'strict' }, async media => {
            for (const signal of [1, {}, { aborted: false }]) {
                const checked = await media.check('wav', { copy: true, signal });
                assert.deepEqual([checked.supported, checked.code], [false, 'INPUT']);
                let writes = 0;
                const sink = { write: () => writes++, close: async () => {} };
                await assert.rejects(media.convert('wav', { copy: true, signal, sink }), {
                    code: 'INPUT',
                });
                assert.equal(writes, 0);
            }
        });
    });

    test('a byte budget the output passes fails check and copy with OOM', async () => {
        await withMedia(waveFixture(), {}, async media => {
            const checked = await media.check('wav', { copy: true, maxBytes: 1 });
            assert.deepEqual([checked.supported, checked.code], [false, 'OOM']);
            await assert.rejects(media.convert('wav', { copy: true, maxBytes: 1 }), {
                code: 'OOM',
            });
        });
    });

    for (const [label, input] of [
        ['16-bit PCM in AVI', () => aviPcmFixture().bytes],
        ['two video and two audio tracks in Matroska', () => matroskaFixture()],
    ])
        test(`${label} checks and copies into a Matroska sink`, async () => {
            await withMedia(input(), {}, async media => {
                const checked = media.check('mkv', { copy: true });
                assert.equal(typeof checked?.then, 'function', 'check() returns a promise');
                assert.equal((await checked).supported, true);
                const sink = new MemorySink();
                await media.convert('mkv', { copy: true, sink });
                assert.ok(parseMatroska(sink.toUint8Array()).packets.length > 0);
            });
        });

    for (const codec of ['evrc', 'qcelp'])
        test(`${codec} with no decoder information checks and copies alike in MP4`, async () => {
            // ffmpeg writes these speech codecs with no DecoderSpecificInfo: the esds object type
            // names the codec and fixes its shape, 8 kHz mono, and the copy writes it back so.
            const source = structuralStreams[codec]();
            const { tracks, hashes } = await readAll(source);
            assert.equal(tracks[0].codecConfig, undefined);
            await withMedia(source, {}, async media => {
                for (const format of ['mp4', 'mov', 'm4v', 'm4a', '3gp']) {
                    await assertParity(media, format, true);
                    const copy = await readAll((await media.convert(format, { copy: true })).blob);
                    const [track] = copy.tracks;
                    assert.deepEqual(
                        [track.codec, track.sampleRate, track.channelCount, track.codecConfig],
                        [codec, 8000, 1, undefined],
                    );
                    assert.deepEqual(copy.hashes, hashes, `${format} packets`);
                }
            });
        });
});
