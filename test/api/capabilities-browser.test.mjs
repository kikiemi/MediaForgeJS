import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, capabilities } from 'mediaforgejs';

// capabilities() in a real browser (npm run test:browser): what it says of the host agrees with
// what the browser's own WebCodecs, canvas and Media Source Extensions answer.

const inBrowser = typeof document !== 'undefined';

/** Whether the host `Codec` (AudioDecoder, AudioEncoder, VideoEncoder) supports `config`. */
async function hostSupports(Codec, config) {
    if (typeof globalThis[Codec] !== 'function') return false;
    try {
        return (await globalThis[Codec].isConfigSupported(config)).supported === true;
    } catch {
        return false;
    }
}

describe(
    'capabilities() in a browser',
    { skip: !inBrowser && 'runs in a browser (npm run test:browser)' },
    () => {
        test('the host features are the ones the browser has', async () => {
            const { host } = await capabilities();
            assert.deepEqual(host, {
                videoDecoder: typeof VideoDecoder === 'function',
                videoEncoder: typeof VideoEncoder === 'function',
                audioDecoder: typeof AudioDecoder === 'function',
                audioEncoder: typeof AudioEncoder === 'function',
                canvas: typeof OffscreenCanvas === 'function',
                mediaSource: typeof MediaSource === 'function',
            });
        });

        test('AAC decodes with the bundled plugins wherever the host cannot', async () => {
            assert.ok((await capabilities()).audio.decode.includes('aac'));
        });

        test('without plugins Opus decodes where the host AudioDecoder takes it', async () => {
            const { audio } = await new MediaForge({ plugins: [] }).capabilities();
            const opus = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
            assert.equal(audio.decode.includes('opus'), await hostSupports('AudioDecoder', opus));
        });

        test('Opus encodes into WebM where the host AudioEncoder takes it', async () => {
            const { audio } = await new MediaForge({ plugins: [] }).capabilities({ to: 'webm' });
            const opus = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 };
            assert.equal(audio.encode.includes('opus'), await hostSupports('AudioEncoder', opus));
        });

        test('the video encoders listed for a size take that size', async () => {
            const { video } = await capabilities({ to: 'webm', width: 640, height: 360 });
            const vp8 = { codec: 'vp8', width: 640, height: 360 };
            assert.equal(video.encode.includes('vp8'), await hostSupports('VideoEncoder', vp8));
        });
    },
);
