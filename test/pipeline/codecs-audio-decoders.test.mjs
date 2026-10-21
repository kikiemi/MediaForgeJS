import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { convert, open } from 'mediaforgejs';
import { createAudioTrackSource, encodeAacLc } from 'mediaforgejs/codecs';
import * as parts from 'mediaforgejs/parts';
import { AC3_FIXTURES } from '../helpers/ac3-fixtures.mjs';
import { MP3_FIXTURES } from '../helpers/mp3-fixtures.mjs';
import { OPUS_FIXTURES } from '../helpers/opus-fixtures.mjs';
import { readerPart } from '../helpers/parts.mjs';
import { VORBIS_FIXTURES } from '../helpers/vorbis-fixtures.mjs';

// Which decoder decodes a track: the host's AudioDecoder first, the library's where the host has
// none or fails, linear PCM read without asking any; and what is concealed where packets are lost
// or damaged.

/** Replaces globals by `classes` and returns a function that restores them. */
function installGlobals(classes) {
    const saved = Object.keys(classes).map(name => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
    ]);
    Object.assign(globalThis, classes);
    return () => {
        for (const [name, descriptor] of saved)
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
    };
}

class Chunk {
    constructor(init) {
        Object.assign(this, init);
    }
}

/** A mono 16-bit PCM track whose packets hold distinct ramps, so a repeat or a drop shows. */
function rampTrack(count = 24, frames = 480, extra = {}) {
    return {
        codec: 'pcm-s16le',
        sampleRate: 48000,
        channelCount: 1,
        width: 0,
        height: 0,
        duration: (count * frames) / 48000,
        samples: Array.from({ length: count }, (_, index) => {
            const data = new Uint8Array(frames * 2);
            const view = new DataView(data.buffer);
            for (let frame = 0; frame < frames; frame++)
                view.setInt16(frame * 2, index * 1000 - frame * 7, true);
            return {
                offset: 0,
                size: data.length,
                data,
                isKeyframe: true,
                timestamp: (index * frames) / 48000,
                duration: frames / 48000,
            };
        }),
        ...extra,
    };
}

/** The channels of little-endian 16-bit PCM interleaved in `channels`, as planes. */
function s16Planes(data, channels = 1) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const frames = data.length / (2 * channels);
    return Array.from({ length: channels }, (_, channel) =>
        Float32Array.from(
            { length: frames },
            (_, frame) => view.getInt16((frame * channels + channel) * 2, true) / 32768,
        ),
    );
}

/**
 * A library decoder of 'x-ramp', a test codec whose packets are 16-bit PCM, which the host
 * (hostDecoder) decodes too. Linear PCM is no such codec: it is read without any decoder.
 */
const rampDecoder = Object.freeze({
    id: 'ramp',
    codecs: ['x-ramp'],
    create: track => ({
        create: () => ({ decode: packet => [s16Planes(packet, track.channelCount)], reset() {} }),
    }),
});

const hostRamp = (count = 24) => rampTrack(count, 480, { codec: 'x-ramp' });
const reader = async () => {
    throw new Error('inline packets are not read');
};
const rampSource = (track, options = {}) =>
    createAudioTrackSource(track, reader, { decoders: [rampDecoder], ...options });

/**
 * A host AudioDecoder of `codecs` that reads every packet as 16-bit mono PCM and fails once from
 * packet `failAfter`, or with `silent` outputs nothing; `stats` counts its probes, decoders and
 * packets.
 */
function hostDecoder({ supported = true, failAfter, codecs = ['x-ramp'], silent = false } = {}) {
    const stats = { probes: 0, decoders: 0, packets: 0 };
    let failures = failAfter === undefined ? 0 : 1;
    class Decoder {
        static async isConfigSupported(config) {
            stats.probes++;
            return { supported: supported && codecs.includes(config.codec), config };
        }
        state = 'unconfigured';
        decodeQueueSize = 0;
        pending = Promise.resolve();
        decoded = 0;
        constructor(init) {
            this.init = init;
            this.failing = failures-- > 0;
            stats.decoders++;
        }
        configure(config) {
            this.config = config;
            this.state = 'configured';
        }
        decode(chunk) {
            stats.packets++;
            const packet = this.decoded++;
            this.pending = this.pending.then(async () => {
                await yieldTask();
                if (this.state === 'closed') return;
                if (this.failing && packet >= failAfter) {
                    this.state = 'closed';
                    this.init.error(new DOMException(`host failure at ${packet}`, 'EncodingError'));
                    return;
                }
                if (silent) return;
                const [plane] = s16Planes(chunk.data);
                this.init.output({
                    sampleRate: this.config.sampleRate,
                    numberOfChannels: 1,
                    numberOfFrames: plane.length,
                    copyTo: target => target.set(plane),
                    close() {},
                });
            });
        }
        async flush() {
            await this.pending;
        }
        close() {
            this.state = 'closed';
        }
        addEventListener() {}
        removeEventListener() {}
    }
    const restore = installGlobals({ AudioDecoder: Decoder, EncodedAudioChunk: Chunk });
    return { stats, restore };
}

/**
 * A host AudioDecoder of the codec strings of `supported` that records, per codec string, what it
 * was asked, the description configured and the chunks decoded; each decodes to 0.25.
 */
function routingHost(supported) {
    const asked = {};
    const decoded = {};
    const descriptions = {};
    class Decoder {
        static async isConfigSupported(config) {
            asked[config.codec] = (asked[config.codec] ?? 0) + 1;
            return { supported: supported.includes(config.codec), config };
        }
        state = 'unconfigured';
        decodeQueueSize = 0;
        pending = Promise.resolve();
        constructor(init) {
            this.init = init;
        }
        configure(config) {
            this.config = config;
            this.state = 'configured';
            descriptions[config.codec] = config.description;
        }
        decode(chunk) {
            const { codec, sampleRate, numberOfChannels } = this.config;
            decoded[codec] = (decoded[codec] ?? 0) + 1;
            const frames = Math.round((chunk.duration * sampleRate) / 1e6);
            this.pending = this.pending.then(() => {
                if (this.state === 'closed') return;
                this.init.output({
                    sampleRate,
                    numberOfChannels,
                    numberOfFrames: frames,
                    copyTo: target => target.fill(0.25),
                    close() {},
                });
            });
        }
        async flush() {
            await this.pending;
        }
        close() {
            this.state = 'closed';
        }
        addEventListener() {}
        removeEventListener() {}
    }
    const restore = installGlobals({ AudioDecoder: Decoder, EncodedAudioChunk: Chunk });
    return { asked, decoded, descriptions, restore };
}

/** The first plane of every chunk of a source, joined. */
async function collect(source) {
    const blocks = [];
    for await (const planes of source.chunks()) blocks.push(Float32Array.from(planes[0]));
    const output = new Float32Array(blocks.reduce((sum, block) => sum + block.length, 0));
    let at = 0;
    for (const block of blocks) {
        output.set(block, at);
        at += block.length;
    }
    return output;
}

/** Two frames of each little-endian PCM layout, -0.5 then +0.5, both exact. */
const PCM_LAYOUTS = Object.freeze({
    'pcm-u8': [0x40, 0xc0],
    'pcm-s16le': [0, 0xc0, 0, 0x40],
    'pcm-s24le': [0, 0, 0xc0, 0, 0, 0x40],
    'pcm-s32le': [0, 0, 0, 0xc0, 0, 0, 0, 0x40],
    'pcm-f32le': [0, 0, 0, 0xbf, 0, 0, 0, 0x3f],
});

/** A mono 48 kHz WAVE file of 4800 frames of PCM_LAYOUTS[codec]. */
function layoutWave(codec) {
    const pair = PCM_LAYOUTS[codec];
    const width = pair.length / 2;
    const size = 4800 * width;
    const bytes = new Uint8Array(44 + size);
    const view = new DataView(bytes.buffer);
    bytes.set([82, 73, 70, 70], 0);
    view.setUint32(4, 36 + size, true);
    bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, codec === 'pcm-f32le' ? 3 : 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 48000 * width, true);
    view.setUint16(32, width, true);
    view.setUint16(34, width * 8, true);
    bytes.set([100, 97, 116, 97], 36);
    view.setUint32(40, size, true);
    for (let at = 0; at < size; at += pair.length) bytes.set(pair, 44 + at);
    return new Blob([bytes]);
}

/** A mono 16-bit WAV of `frames` of a sine. */
function waveInput(frames = 4800, rate = 48000) {
    const bytes = new Uint8Array(44 + frames * 2);
    const view = new DataView(bytes.buffer);
    bytes.set([82, 73, 70, 70], 0);
    view.setUint32(4, 36 + frames * 2, true);
    bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    bytes.set([100, 97, 116, 97], 36);
    view.setUint32(40, frames * 2, true);
    for (let frame = 0; frame < frames; frame++)
        view.setInt16(44 + frame * 2, Math.round(8000 * Math.sin(frame / 7)), true);
    return new Blob([bytes]);
}

/** The sound of `track` decoded by the default entry's decoders, through parts.decodeAudio. */
async function decodedByLibrary(track, options = {}) {
    const audioReader = {
        formats: ['owned'],
        async read() {
            return { videoTracks: [], audioTracks: [{ id: 1, ...track }] };
        },
    };
    const media = await open(new Uint8Array(1), {
        plugins: { add: [{ name: 'owned', readers: [readerPart(audioReader)] }] },
        format: 'owned',
    });
    try {
        const pcm = await parts.decodeAudio(media, 1, { codecPreference: 'builtin', ...options });
        return await collect(pcm);
    } finally {
        media.close();
    }
}

describe('pipeline/codecs: audio decoders', () => {
    test('the host decodes first; codecPreference builtin leaves it out', async () => {
        const expected = await collect(rampSource(hostRamp(), { builtinOnly: true }));
        const host = hostDecoder();
        try {
            assert.deepEqual(await collect(rampSource(hostRamp())), expected);
            assert.deepEqual([host.stats.decoders, host.stats.packets], [1, 24]);
            const preferred = rampSource(hostRamp(), { codecPreference: 'builtin' });
            assert.deepEqual(await collect(preferred), expected);
            assert.equal(host.stats.packets, 24, 'the library decodes without the host');
            assert.equal(host.stats.probes, 1, 'the answer is kept per configuration');
        } finally {
            host.restore();
        }
    });

    test('a configuration the host does not take goes to the library, silently', async () => {
        const host = hostDecoder({ supported: false });
        try {
            const warnings = [];
            const source = rampSource(hostRamp(), { onWarning: warning => warnings.push(warning) });
            assert.equal((await collect(source)).length, 24 * 480);
            assert.equal(host.stats.decoders, 0);
            assert.deepEqual(warnings, []);
        } finally {
            host.restore();
        }
    });

    test('a host failure midway goes on in the library with the same samples', async () => {
        const expected = await collect(rampSource(hostRamp(), { builtinOnly: true }));
        const host = hostDecoder({ failAfter: 9 });
        try {
            const warnings = [];
            const source = rampSource(hostRamp(), { onWarning: warning => warnings.push(warning) });
            assert.deepEqual(await collect(source), expected, 'nothing lost or repeated');
            assert.deepEqual(await collect(source), expected, 'a replay switches alike');
            assert.deepEqual(
                warnings.map(warning => warning.code),
                ['AUDIO_DECODER_FALLBACK'],
            );
            assert.match(warnings[0].message, /host AudioDecoder failed/);
        } finally {
            host.restore();
        }
    });

    test('a host decoding nothing of a track hands it on, not an empty track', async () => {
        // Chromium 152 takes MP2 as 'mp3' and outputs nothing of it.
        const expected = await collect(rampSource(hostRamp(), { builtinOnly: true }));
        const host = hostDecoder({ silent: true });
        try {
            const warnings = [];
            const source = rampSource(hostRamp(), { onWarning: warning => warnings.push(warning) });
            assert.deepEqual(await collect(source), expected);
            assert.deepEqual(
                warnings.map(warning => warning.code),
                ['AUDIO_DECODER_FALLBACK'],
            );
            await assert.rejects(
                collect(createAudioTrackSource(hostRamp(), reader)),
                error => error.code === 'DECODE' && /'x-ramp'/.test(error.message),
                'without a library decoder the track fails',
            );
        } finally {
            host.restore();
        }
    });

    test('a codec no decoder takes fails with DECODE, one of a plugin with PLUGIN', () => {
        assert.throws(
            () => createAudioTrackSource({ ...rampTrack(), codec: 'dtsc' }, reader),
            error => error.code === 'DECODE' && /'dtsc'/.test(error.message),
        );
        assert.throws(
            () => createAudioTrackSource({ ...rampTrack(), codec: 'ac-3' }, reader),
            error => error.code === 'PLUGIN' && error.plugin === 'ac3',
        );
    });

    test('decodeAudio goes to the host for what it takes and reads linear PCM itself', async () => {
        const inputs = {
            flac: (await convert(waveInput(), 'flac')).blob,
            mp3: new Blob([MP3_FIXTURES[0].bytes()]),
            opus: new Blob([OPUS_FIXTURES[0].bytes()]),
            vorbis: new Blob([VORBIS_FIXTURES[0].bytes()]),
            'mp4a.40.2': (await convert(waveInput(), 'm4a', { codecPreference: 'builtin' })).blob,
            'ac-3': new Blob([AC3_FIXTURES[0].bytes()]),
            ...Object.fromEntries(
                Object.keys(PCM_LAYOUTS).map(codec => [codec, layoutWave(codec)]),
            ),
        };
        // The host takes FLAC, MPEG audio, Opus, Vorbis and every PCM string; not AAC or AC-3.
        const host = routingHost(
            ['flac', 'mp3', 'opus', 'vorbis', 'pcm', 'pcm-u8', 'pcm-s16', 'pcm-s24', 'pcm-s32']
                .concat(['pcm-f32'])
                .concat(Object.keys(PCM_LAYOUTS)),
        );
        try {
            const decodes = {};
            for (const [codec, blob] of Object.entries(inputs)) {
                const media = await parts.open(blob);
                const track = media.tracks.find(candidate => candidate.type === 'audio');
                const samples = await collect(await parts.decodeAudio(media, track.id));
                media.close();
                assert.ok(samples.length > 0, codec);
                decodes[codec] = samples.every(value => value === 0.25) ? 'host' : 'library';
            }
            assert.deepEqual(decodes, {
                flac: 'host',
                mp3: 'host',
                opus: 'host',
                vorbis: 'host',
                'mp4a.40.2': 'library',
                'ac-3': 'library',
                'pcm-u8': 'library',
                'pcm-s16le': 'library',
                'pcm-s24le': 'library',
                'pcm-s32le': 'library',
                'pcm-f32le': 'library',
            });
            assert.deepEqual(Object.keys(host.decoded).sort(), ['flac', 'mp3', 'opus', 'vorbis']);
            assert.deepEqual(
                Object.keys(host.asked).sort(),
                ['ac-3', 'flac', 'mp3', 'mp4a.40.2', 'opus', 'vorbis'],
                'linear PCM is not asked about',
            );
            const flacHeader = host.descriptions.flac.subarray(0, 4);
            assert.equal(new TextDecoder().decode(flacHeader), 'fLaC', 'FLAC by its header');
        } finally {
            host.restore();
        }
    });

    test('linear PCM of every depth is read without the host, even one that takes it', async () => {
        const host = hostDecoder({
            codecs: ['pcm', 'pcm-u8', 'pcm-s16', 'pcm-s24', 'pcm-s32', 'pcm-f32'].concat(
                Object.keys(PCM_LAYOUTS),
            ),
        });
        try {
            const frames = 480;
            for (const [codec, pair] of Object.entries(PCM_LAYOUTS)) {
                const data = new Uint8Array(frames * (pair.length / 2));
                for (let at = 0; at < data.length; at += pair.length) data.set(pair, at);
                const sample = { offset: 0, size: data.length, data, isKeyframe: true };
                const track = {
                    ...rampTrack(1),
                    codec,
                    samples: [{ ...sample, timestamp: 0, duration: frames / 48000 }],
                };
                const decoded = await collect(createAudioTrackSource(track, reader));
                assert.deepEqual([host.stats.probes, host.stats.decoders], [0, 0], codec);
                assert.equal(decoded.length, frames, codec);
                assert.deepEqual([decoded[0], decoded[1]], [-0.5, 0.5], codec);
            }
        } finally {
            host.restore();
        }
    });

    test('HE-AAC the host does not take names the aac plugin', async () => {
        const host = hostDecoder({ supported: false });
        try {
            // Explicit SBR: object type 5, 24 kHz core, stereo, 48 kHz output.
            const track = {
                ...rampTrack(4),
                codec: 'mp4a.40.5',
                codecConfig: Uint8Array.of(0x2b, 0x11, 0x88, 0x00),
                channelCount: 2,
            };
            await assert.rejects(
                collect(createAudioTrackSource(track, reader)),
                error =>
                    error.code === 'PLUGIN' &&
                    error.plugin === 'aac' &&
                    /'aac' plugin/.test(error.hint),
            );
            assert.equal(host.stats.decoders, 0);
        } finally {
            host.restore();
        }
    });

    test('times in whole milliseconds do not drift into filled holes', async () => {
        // Matroska stores 1024-frame packets at 44.1 kHz as 23 or 24 ms: rounded one by one,
        // the durations fall behind the times by more than the 20 ms a hole needs.
        const frames = 1024;
        const count = 3000;
        const stamp = index => Math.round((index * frames * 1000) / 44100) / 1000;
        const track = rampTrack(count, frames, { sampleRate: 44100, duration: stamp(count) });
        track.samples.forEach((sample, index) => {
            sample.timestamp = stamp(index);
            sample.duration = stamp(index + 1) - stamp(index);
        });
        const output = await collect(createAudioTrackSource(track, reader, { builtinOnly: true }));
        assert.ok(Math.abs(output.length - count * frames) <= 44, `${output.length} frames`);
        const late = track.samples[count - 10].data;
        const expected = new DataView(late.buffer, late.byteOffset).getInt16(5 * 2, true) / 32768;
        assert.equal(output[(count - 10) * frames + 5], expected, 'no silence before late packets');
    });
});

describe('pipeline/codecs: damaged audio', () => {
    /** A ramp track whose third packet lost its last byte. */
    const damaged = extra => {
        const track = rampTrack(6, 480, extra);
        track.samples[2] = {
            ...track.samples[2],
            data: track.samples[2].data.subarray(0, 959),
            size: 959,
        };
        return track;
    };

    test('a packet that does not decode is silence of its length, reported once', async () => {
        const warnings = [];
        const source = createAudioTrackSource(damaged({ incomplete: true }), reader, {
            onWarning: warning => warnings.push(warning.code),
        });
        const output = await collect(source);
        await collect(source);
        assert.equal(output.length, 6 * 480);
        assert.ok(output.subarray(960, 1440).every(value => value === 0));
        assert.equal(output[1440], 3000 / 32768);
        assert.deepEqual(warnings, ['AUDIO_FRAME_CONCEALED']);
        // A complete track conceals it the same way, as ffmpeg goes on decoding.
        assert.deepEqual(await collect(createAudioTrackSource(damaged({}), reader)), output);
    });

    test('strictly, a damaged packet is DECODE and an incomplete track FORMAT', async () => {
        await assert.rejects(
            collect(createAudioTrackSource(damaged({}), reader, { validation: 'strict' })),
            error => error.code === 'DECODE',
        );
        assert.throws(
            () =>
                createAudioTrackSource(damaged({ incomplete: true }), reader, {
                    validation: 'strict',
                }),
            error => error.code === 'FORMAT',
        );
    });

    test('a damaged AAC access unit is silence of its length', async () => {
        const rate = 48000;
        const pcm = Float32Array.from(
            { length: 24000 },
            (_, index) => Math.sin((2 * Math.PI * 440 * index) / rate) / 4,
        );
        const encoded = await encodeAacLc([pcm], { sampleRate: rate, bitrate: 96 });
        const track = damage => ({
            codec: 'mp4a.40.2',
            codecConfig: encoded.audioSpecificConfig,
            sampleRate: rate,
            channelCount: 1,
            width: 0,
            height: 0,
            duration: (encoded.frames.length * 1024) / rate,
            samples: encoded.frames.map((frame, index) => {
                const data = index === 10 ? damage(frame) : frame;
                return {
                    offset: 0,
                    size: data.length,
                    data,
                    isKeyframe: true,
                    timestamp: (index * 1024) / rate,
                    duration: 1024 / rate,
                };
            }),
        });
        // Node has no AudioDecoder: the aac plugin's decoder decodes and conceals.
        const intact = await decodedByLibrary(track(frame => frame));
        const cut = frame => frame.subarray(0, 2);
        const warnings = [];
        const concealed = await decodedByLibrary(track(cut), {
            onWarning: warning => warnings.push(warning.code),
        });
        assert.equal(concealed.length, intact.length);
        assert.deepEqual(warnings, ['AUDIO_FRAME_CONCEALED']);
        assert.deepEqual(concealed.subarray(0, 9 * 1024), intact.subarray(0, 9 * 1024));
        await assert.rejects(
            decodedByLibrary(track(cut), { strict: true }),
            error => error.code === 'DECODE',
        );
    });
});
