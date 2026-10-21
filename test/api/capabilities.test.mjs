import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { capabilities } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { allPlugins } from 'mediaforgejs/plugins';

// capabilities(): what this host and the plugins in use read, write, decode and encode.

const PLUGIN_CONTAINERS = ['avi', 'flv', 'mxf', 'asf', 'mpeg', 'ivf'];

describe('capabilities()', () => {
    test('the core reads and writes the core containers and codes PCM', async () => {
        const core = await new lite.MediaForge().capabilities();
        for (const format of ['mp4', 'mkv', 'webm', 'ts', 'wav', 'flac', 'mp3', 'aac'])
            assert.ok(core.containers.read.includes(format), `reads ${format}`);
        for (const format of ['mp4', 'mkv', 'webm', 'ts', 'wav', 'flac'])
            assert.ok(core.containers.write.includes(format), `writes ${format}`);
        assert.deepEqual(core.plugins, []);
        assert.deepEqual(core.audio.encode, ['pcm']);
        assert.deepEqual(core.audio.decode, ['pcm', 'ulaw', 'alaw', 'ima4']);
        assert.deepEqual(core.video.decoders, ['uncompressed']);
        for (const format of PLUGIN_CONTAINERS)
            assert.ok(!core.containers.read.includes(format), `the core does not read ${format}`);
    });

    test('the core copies codecs into containers and packages HLS and DASH', async () => {
        const core = await new lite.MediaForge().capabilities();
        assert.ok(core.videoCopy.mkv.includes('avc1'));
        assert.ok(core.audioCopy.mkv.includes('flac'));
        assert.deepEqual(core.packaging, ['hls', 'dash', 'hls+dash']);
    });

    test('the host is never asked to decode linear PCM: the library reads it', async () => {
        // A host decoder that takes everything: linear PCM is still not asked about.
        const asked = [];
        const saved = ['AudioDecoder', 'EncodedAudioChunk'].map(name => [name, globalThis[name]]);
        globalThis.AudioDecoder = class {
            static async isConfigSupported(config) {
                asked.push(config.codec);
                return { supported: true };
            }
        };
        globalThis.EncodedAudioChunk ??= class {};
        try {
            const core = await new lite.MediaForge().capabilities();
            assert.ok(asked.includes('opus') && asked.includes('ulaw'), asked.join(' '));
            assert.deepEqual(
                asked.filter(codec => codec.startsWith('pcm')),
                [],
            );
            assert.ok(core.audio.decode.includes('pcm'));
        } finally {
            for (const [name, value] of saved)
                if (value === undefined) delete globalThis[name];
                else globalThis[name] = value;
        }
    });

    test('the host reports its WebCodecs and Media Source Extensions', async () => {
        const core = await new lite.MediaForge().capabilities();
        assert.equal(core.host.videoDecoder, typeof VideoDecoder === 'function');
        assert.equal(core.host.mediaSource, false);
    });

    test('every plugin adds its codecs and containers', async () => {
        const full = await capabilities();
        assert.equal(full.plugins.length, allPlugins.length);
        assert.deepEqual(full.audio.encode, ['aac', 'mp3', 'flac', 'mp2', 'pcm']);
        for (const codec of ['pcm', 'aac', 'flac', 'mp2', 'mp3', 'alac', 'opus', 'vorbis'])
            assert.ok(full.audio.decode.includes(codec), codec);
        assert.deepEqual(full.video.decoders, [
            'uncompressed',
            'h264',
            'mpeg2video',
            'mpeg4-part2',
            'apv',
        ]);
        for (const format of PLUGIN_CONTAINERS)
            assert.ok(full.containers.read.includes(format), `the plugins read ${format}`);
        for (const format of ['avi', 'flv', 'ivf'])
            assert.ok(full.containers.write.includes(format), `writes ${format}`);
    });

    test('a target narrows the audio encoders to what its container takes', async () => {
        assert.deepEqual((await capabilities({ to: 'ogg' })).audio.encode, ['flac']);
        assert.deepEqual((await capabilities({ to: 'opus' })).audio.encode, []);
    });

    test('excluded plugins are left out', async () => {
        const excluded = await capabilities({ plugins: { exclude: ['avi', 'h264'] } });
        assert.ok(!excluded.containers.read.includes('avi'));
        assert.ok(!excluded.video.decoders.includes('h264'));
        assert.equal(excluded.plugins.length, allPlugins.length - 2);
    });

    test('the picture transforms are listed', async () => {
        const { video } = await capabilities();
        assert.deepEqual(video.transforms, ['crop', 'resize', 'rotate', 'flip']);
        assert.ok(video.decoders.every(id => typeof id === 'string'));
    });
});
