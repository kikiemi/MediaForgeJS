import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, check, convert, inspect, open } from 'mediaforgejs';
import { encodeAacLc, wrapAdts } from 'mediaforgejs/codecs';
import * as lite from 'mediaforgejs/lite';
import { aac, avi, flac, mpegAudio } from 'mediaforgejs/plugins';
import { greyAvi, toneWav } from '../helpers/api-fixtures.mjs';
import { MP3_FIXTURES } from '../helpers/mp3-fixtures.mjs';

// The plugins in use: what a call can do with them, and the PLUGIN error, naming the plugin and
// how to include it, for what only a plugin not in use does.

describe('pipeline/plugins', () => {
    describe('missing plugins', () => {
        test('check() and thumbnail() of a plugin container name it, one hint', async () => {
            const input = () => new Blob([greyAvi()]);
            const inspected = await lite.inspect(input()).catch(error => error);
            const checked = await lite.check(input(), 'png');
            assert.deepEqual(
                [checked.supported, checked.code, checked.hint],
                [false, 'PLUGIN', inspected.hint],
            );
            assert.equal((await lite.thumbnail(input()).catch(error => error)).code, 'PLUGIN');
            const excluded = await check(input(), 'png', { plugins: { exclude: ['avi'] } });
            assert.deepEqual([excluded.code, excluded.hint], ['PLUGIN', inspected.hint]);
        });

        test('writing a container of an excluded plugin names it', async () => {
            const input = toneWav();
            assert.equal((await check(input, 'avi')).supported, true);
            const excluded = { plugins: { exclude: ['avi'] } };
            const lacking = await check(input, 'avi', excluded);
            assert.deepEqual([lacking.supported, lacking.code], [false, 'PLUGIN']);
            assert.match(lacking.hint, /'avi' plugin/);
            await assert.rejects(
                convert(input, 'avi', excluded),
                error => error.code === 'PLUGIN' && error.plugin === 'avi',
            );
        });

        test('a plugin given to a call makes it possible', async () => {
            const checked = await lite.check(new Blob([greyAvi()]), 'png', { plugins: [avi] });
            assert.equal(checked.supported, true);
        });

        test('re-encoding MP3 without a host decoder names mpegAudio', async () => {
            const fixture = MP3_FIXTURES[0].bytes();
            const withoutMp3 = new MediaForge({ plugins: { exclude: ['mpegAudio'] } });
            const target = { to: 'mp3', audio: { bitrate: 32000 } };
            const lacking = await withoutMp3.check(fixture, target);
            assert.deepEqual([lacking.supported, lacking.code], [false, 'PLUGIN']);
            assert.match(lacking.hint, /Include the 'mpegAudio' plugin/);
            const refused = await withoutMp3.convert(fixture, target).catch(error => error);
            assert.deepEqual([refused.code, refused.plugin], ['PLUGIN', 'mpegAudio']);
            const liteMp3 = new lite.MediaForge({ plugins: [mpegAudio] });
            assert.equal((await liteMp3.check(fixture, target)).supported, true);
        });

        test('the lite entry names the plugin of each audio encoder it lacks', async () => {
            for (const [to, plugin] of [
                ['flac', 'flac'],
                ['m4a', 'aac'],
                ['aac', 'aac'],
                ['mp2', 'mpegAudio'],
                ['mp3', 'mpegAudio'],
            ]) {
                const lacking = await lite.check(toneWav(), to);
                assert.deepEqual([lacking.supported, lacking.code], [false, 'PLUGIN'], to);
                assert.match(lacking.hint, new RegExp(`'${plugin}' plugin`));
                const refused = await lite.convert(toneWav(), to).catch(error => error);
                assert.deepEqual([refused.code, refused.plugin], ['PLUGIN', plugin], to);
            }
        });

        test('with the plugins the lite entry encodes each of those formats', async () => {
            const coded = new lite.MediaForge({ plugins: [aac, flac, mpegAudio] });
            for (const to of ['flac', 'm4a', 'aac', 'mp2', 'mp3']) {
                const support = await coded.check(toneWav(), to);
                assert.equal(support.plan.tracks[0].action, 'encode', to);
                const written = await inspect((await coded.convert(toneWav(), to)).blob, {
                    open: { validation: 'strict' },
                    sampleCounts: true,
                });
                assert.ok(written.tracks[0].sampleCount > 0, to);
            }
        });

        test('an MPEG audio encoder for MP4 names the mpegAudio plugin', async () => {
            const refused = await lite
                .convert(toneWav(), 'm4a', { audio: { codec: 'mp2' } })
                .catch(error => error);
            assert.deepEqual([refused.code, refused.plugin], ['PLUGIN', 'mpegAudio']);
        });
    });

    describe('plugins in use', () => {
        test('the lite entry and the aac plugin write what the default entry writes', async () => {
            const tone = Float32Array.from(
                { length: 4096 },
                (_, i) => Math.sin((i * 2 * Math.PI * 440) / 48000) * 0.2,
            );
            const encoded = await encodeAacLc([tone], { sampleRate: 48000, bitrate: 96 });
            const { blob: input } = await convert(wrapAdts(encoded), 'm4a');
            const selected = new lite.MediaForge({ plugins: [aac] });
            for (const options of [{}, { audio: { bitrate: 96000, sampleRate: 24000 } }]) {
                const { blob: output } = await convert(input, 'mkv', options);
                const { blob: same } = await selected.convert(input, 'mkv', options);
                assert.deepEqual(
                    new Uint8Array(await same.arrayBuffer()),
                    new Uint8Array(await output.arrayBuffer()),
                );
                const media = await open(output);
                assert.equal(media.tracks[0].sampleRate, options.audio?.sampleRate ?? 48000);
                const packets = [];
                for await (const packet of media.packets()) packets.push(packet.data);
                media.close();
                if (!options.audio) assert.deepEqual(packets, encoded.frames, 'copied as they are');
            }
        });
    });
});
