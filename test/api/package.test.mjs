import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { packageMedia } from 'mediaforgejs';
import { movie } from '../helpers/api-fixtures.mjs';
import { hugeAudioMp4 } from '../helpers/huge-sources.mjs';
import { preservationFixture } from '../helpers/mp4-preservation-fixture.mjs';

// packageMedia(): the files of an HLS or DASH package for a target.

describe('packageMedia()', () => {
    test('HLS of fMP4 writes a master and a media playlist and an init segment', async () => {
        const { files } = await packageMedia(movie(), { to: 'hls', targetDuration: 0.16 });
        assert.deepEqual(
            [...files.keys()].filter(name => name.endsWith('.m3u8')),
            ['index.m3u8', 'master.m3u8'],
        );
        assert.ok(files.has('init.mp4'));
    });

    test('HLS of MPEG-TS writes .ts segments', async () => {
        const { files } = await packageMedia(movie(), { to: 'm3u8', container: 'MPEGTS' });
        assert.ok([...files.keys()].some(name => name.endsWith('.ts')));
    });

    test('DASH writes manifest.mpd', async () => {
        const { files } = await packageMedia(movie(), { to: 'dash' });
        assert.ok(files.has('manifest.mpd'));
    });

    test('the result names the file a player opens', async () => {
        const hls = await packageMedia(movie(), 'hls', { targetDuration: 0.16 });
        assert.equal(hls.entry, 'master.m3u8');
        assert.ok(hls.files.has('master.m3u8'));
        assert.equal(hls.plan.action, 'package');
        assert.equal((await packageMedia(movie(), 'dash')).entry, 'manifest.mpd');
    });

    test('a target that is no package fails with INPUT', async () => {
        await assert.rejects(packageMedia(movie(), { to: 'mp4' }), error => error.code === 'INPUT');
    });
});

describe('packageMedia() limits', () => {
    test('files delivered one by one have no byte budget unless one is set', async () => {
        const source = hugeAudioMp4({
            count: 132,
            sampleBytes: 8 * 1024 * 1024,
            gapBytes: 4.5 * 2 ** 30,
        });
        let bytes = 0;
        let segments = 0;
        const onFile = file => {
            bytes += file.data.length;
            if (file.kind === 'segment') segments++;
        };
        const result = await packageMedia(source, 'hls', { targetDuration: 0.1, onFile });
        assert.equal(result.files.size, 0, 'delivered files are not kept');
        assert.ok(bytes > 2 ** 30, `${bytes} bytes`);
        assert.ok(segments > 1);
        await assert.rejects(
            packageMedia(source, 'hls', {
                targetDuration: 0.1,
                maxBytes: 64 * 1024 * 1024,
                onFile: () => {},
            }),
            error => error.code === 'OOM',
        );
    });

    test('a second of 160 Mbit/s video between keyframes fits the default buffer', async () => {
        // 20 MB between keyframes.
        const frame = predicted =>
            Buffer.concat([
                Buffer.of(0, 0x4c, 0x4b, 0x3c, predicted ? 0x41 : 0x65),
                Buffer.alloc(0x4c4b3b),
            ]);
        const { bytes } = preservationFixture({
            tracks: [
                {
                    type: 'video',
                    packets: Array.from({ length: 8 }, (_, index) => frame(index % 4)),
                    sync: [1, 5],
                },
            ],
        });
        const { files } = await packageMedia(bytes, 'hls', { targetDuration: 0.1 });
        assert.equal([...files.values()].filter(file => file.kind === 'segment').length, 2);
    });
});
