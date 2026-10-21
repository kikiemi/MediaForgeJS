import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// The router's decisions, one table each; the router has no public face.
import {
    audioEncoderOrder,
    builtinAudioEncoding,
    decoderOrder,
    libraryAudioCodecs,
    plannedAudioEncoder,
    routeAvailable,
} from '../../dist/esm/pipeline/codecs/router.js';

// Who decodes and who encodes: the host's WebCodecs or the library's codecs, in the order they
// are tried. A row that changes here changes every entry.

const table = (decide, rows) => {
    for (const [input, expected] of rows)
        assert.deepEqual(decide(...input), expected, JSON.stringify(input));
};

describe('pipeline/codecs: the router', () => {
    test('audio encoders: the host first where the library also encodes', () => {
        table(audioEncoderOrder, [
            [
                ['mp4a.40.2', true, undefined],
                ['webcodecs', 'builtin'],
            ],
            [
                ['mp4a.40.2', true, 'webcodecs'],
                ['webcodecs', 'builtin'],
            ],
            [['mp4a.40.2', true, 'builtin'], ['builtin']],
            [['mp4a.40.2', false, 'builtin'], ['webcodecs']],
            [['opus', false, undefined], ['webcodecs']],
            [
                ['flac', true, undefined],
                ['webcodecs', 'builtin'],
            ],
            [['mp3', true, 'webcodecs'], ['builtin']],
            [['mp2', true, undefined], ['builtin']],
            [['pcm', true, undefined], ['builtin']],
            [['pcm-s16', true, undefined], ['builtin']],
            [['ulaw', true, 'webcodecs'], ['builtin']],
        ]);
    });

    test("the library's audio encoding for a codec, rate and channel count", () => {
        table(builtinAudioEncoding, [
            [['pcm', 48000, 2, []], 'pcm'],
            [['ulaw', 8000, 1, []], 'g711'],
            [['alaw', 8000, 2, []], 'g711'],
            [['mp4a.40.2', 48000, 2, ['aac']], 'aac'],
            [['mp4a.40.2', 7350, 1, ['aac']], 'aac'],
            [['mp4a.40.2', 48000, 2, []], undefined],
            [['mp4a.40.2', 48000, 6, ['aac']], undefined],
            [['mp4a.40.2', 22222, 2, ['aac']], undefined],
            [['mp4a.40.5', 48000, 2, ['aac']], undefined],
            [['aac', 48000, 2, ['aac']], undefined],
            [['flac', 44100, 2, ['flac', 'mp3']], 'container'],
            [['flac', 44100, 2, []], undefined],
            [['opus', 48000, 2, ['flac', 'mp2', 'mp3']], undefined],
        ]);
    });

    test('decoders: the host first unless the library is preferred', () => {
        table(decoderOrder, [
            [
                [undefined, true, true],
                ['host', 'builtin'],
            ],
            [
                ['webcodecs', true, true],
                ['host', 'builtin'],
            ],
            [
                ['builtin', true, true],
                ['builtin', 'host'],
            ],
            [['builtin', true, false], ['host']],
            [['builtin', false, true], ['builtin']],
            [['webcodecs', false, true], ['builtin']],
            [[undefined, false, false], []],
        ]);
    });

    test('without WebCodecs only the library can run', () => {
        table(routeAvailable, [
            [['AudioDecoder', true], true],
            [['AudioDecoder', false], false],
            [['VideoEncoder', false], false],
            [['VideoDecoder', true], true],
        ]);
    });

    test("the library's audio encoders are those of the plugins in use", () => {
        table(libraryAudioCodecs, [
            [[{ flac: 1, mp3: 1, mp2: 1 }], ['flac', 'mp2', 'mp3']],
            [[{ mp3: 1 }], ['mp3']],
            [[{ aac: 1 }], ['aac']],
            [[{}], []],
        ]);
    });

    test('the planned audio encoder is the host one only where the host has one', () => {
        const orders = [['webcodecs', 'builtin'], ['webcodecs'], ['builtin']];
        assert.deepEqual(orders.map(plannedAudioEncoder), ['builtin', 'webcodecs', 'builtin']);
        const saved = { AudioEncoder: globalThis.AudioEncoder, AudioData: globalThis.AudioData };
        globalThis.AudioEncoder = class {
            static isConfigSupported() {}
        };
        globalThis.AudioData = class {};
        try {
            assert.deepEqual(orders.map(plannedAudioEncoder), [
                'webcodecs',
                'webcodecs',
                'builtin',
            ]);
        } finally {
            for (const [name, value] of Object.entries(saved))
                if (value === undefined) delete globalThis[name];
                else globalThis[name] = value;
        }
    });
});
