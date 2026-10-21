import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { convert, open } from 'mediaforgejs';
import { encodeFlac, encodeMp3 } from 'mediaforgejs/codecs';
import { MemorySink } from 'mediaforgejs/io';
import { createMuxer, decodeAudio } from 'mediaforgejs/parts';
import { readerPart } from '../helpers/parts.mjs';

// Who encodes the sound of a re-encode: a host AudioEncoder where it takes the codec, the
// library's otherwise or after the host fails; and what reaches the muxer, frame by frame.

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

/**
 * A host Opus AudioEncoder that writes a 20 ms packet for every 960 frames it is given (and
 * `preSkip` more), with `description` as its OpusHead, or fails at its first input with `fail`.
 * It records the AudioData it was given.
 */
function hostOpus({ description, preSkip = 0, fail = false } = {}) {
    const resources = [];
    const inputs = [];
    class Data {
        constructor(init) {
            Object.assign(this, init);
            this.closed = false;
            resources.push(this);
        }
        close() {
            this.closed = true;
        }
    }
    class Encoder {
        static async isConfigSupported(config) {
            return { supported: config.codec === 'opus', config };
        }
        state = 'unconfigured';
        encodeQueueSize = 0;
        pending = Promise.resolve();
        frames = preSkip;
        emitted = 0;
        constructor(init) {
            this.init = init;
            resources.push(this);
        }
        configure(config) {
            this.config = config;
            this.state = 'configured';
        }
        emit(count) {
            for (; this.emitted < count && this.state !== 'closed'; this.emitted++)
                this.init.output(
                    {
                        timestamp: Math.round((this.emitted * 960 * 1e6) / 48000),
                        duration: 20000,
                        byteLength: 3,
                        copyTo: data => data.set([0xf8, 0xff, 0xfe]),
                    },
                    description && this.emitted === 0
                        ? { decoderConfig: { description } }
                        : undefined,
                );
        }
        encode(audio) {
            assert.equal(audio.closed, false);
            inputs.push([audio.format, audio.sampleRate, audio.numberOfChannels, audio.timestamp]);
            if (fail) {
                this.pending = this.pending.then(async () => {
                    await yieldTask();
                    if (this.state === 'closed') return;
                    this.state = 'closed';
                    this.init.error(
                        new DOMException('Native audio encode failed', 'EncodingError'),
                    );
                });
                return;
            }
            assert.deepEqual([...audio.data.slice(0, 4)], [-0.5, 0.5, -0.5, 0.5]);
            this.frames += audio.numberOfFrames;
            const count = Math.floor(this.frames / 960);
            this.pending = this.pending.then(async () => {
                await yieldTask();
                this.emit(count);
            });
        }
        async flush() {
            await this.pending;
            this.emit(Math.ceil(this.frames / 960));
        }
        close() {
            this.state = 'closed';
        }
    }
    const restore = installGlobals({ AudioData: Data, AudioEncoder: Encoder });
    return {
        inputs,
        restore,
        closed: () => resources.every(value => value.closed === true || value.state === 'closed'),
    };
}

/** A host AAC AudioEncoder writing 3-byte packets, or failing at its first input. */
function hostAac(mode) {
    const stats = { encoders: 0, frames: 0 };
    class Data {
        constructor(init) {
            Object.assign(this, init);
        }
        close() {}
    }
    class Encoder {
        static async isConfigSupported(config) {
            return { supported: config.codec === 'mp4a.40.2', config };
        }
        state = 'unconfigured';
        encodeQueueSize = 0;
        constructor(init) {
            this.init = init;
            stats.encoders++;
        }
        configure(config) {
            this.config = config;
            this.state = 'configured';
        }
        encode(audio) {
            if (mode === 'fail') {
                this.state = 'closed';
                queueMicrotask(() =>
                    this.init.error(new DOMException('host encoder failed', 'EncodingError')),
                );
                return;
            }
            stats.frames++;
            this.init.output(
                {
                    timestamp: audio.timestamp,
                    duration: 21333,
                    byteLength: 3,
                    copyTo: target => target.set([1, 2, 3]),
                },
                { decoderConfig: { description: new Uint8Array([0x11, 0x88]) } },
            );
        }
        async flush() {}
        close() {
            this.state = 'closed';
        }
    }
    return { stats, restore: installGlobals({ AudioEncoder: Encoder, AudioData: Data }) };
}

/** A mono 16-bit WAV of `frames`: alternating -0.5 and 0.5, or a sine with `sine`. */
function monoWave(frames, rate = 48000, sine = false) {
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
        view.setInt16(
            44 + frame * 2,
            sine ? Math.round(8000 * Math.sin(frame / 7)) : frame % 2 ? 16384 : -16384,
            true,
        );
    return bytes;
}

/** The packets (time, duration) and the first track of a written file. */
async function written(blob) {
    const media = await open(blob);
    try {
        const packets = [];
        for await (const packet of media.packets())
            packets.push({ data: packet.data, time: packet.timestamp, length: packet.duration });
        return { track: media.tracks[0], packets };
    } finally {
        media.close();
    }
}

/** The options that read one byte as the 'owned' format of the audio `track`. */
function owning(track) {
    const reader = {
        formats: ['owned'],
        async read() {
            return { videoTracks: [], audioTracks: [track] };
        },
    };
    return {
        plugins: { add: [{ name: 'owned', readers: [readerPart(reader)] }] },
        open: { format: 'owned' },
    };
}

/** The 34 bytes of a FLAC STREAMINFO in a track's configuration. */
function streamInfo(config) {
    const at = Buffer.from(config).indexOf('fLaC');
    return at < 0 ? config.subarray(0, 34) : config.subarray(at + 8, at + 42);
}

/** Whether a STREAMINFO states its frame sizes and MD5, which a header written ahead cannot. */
const known = info => info.subarray(4, 10).some(Boolean) && info.subarray(18, 34).some(Boolean);

/** The total sample count of a STREAMINFO: 36 bits from byte 13. */
const totalSamples = info =>
    (info[13] & 15) * 2 ** 32 + new DataView(info.buffer, info.byteOffset).getUint32(14);

/** A mono sine of `total` frames in chunks of 0.1 s; `pulled` gets the frames read so far. */
const sinePcm = (rate, total, pulled = () => {}) => ({
    sampleRate: rate,
    channels: 1,
    estimatedFrames: total,
    async *chunks() {
        const step = rate / 10;
        for (let at = 0; at < total; at += step) {
            const count = Math.min(step, total - at);
            pulled(at + count);
            yield [
                Float32Array.from(
                    { length: count },
                    (_, index) => 0.3 * Math.sin(((at + index) * 2 * Math.PI * 440) / rate),
                ),
            ];
        }
    },
});

/** The samples of `pcm`, joined. */
async function joined(pcm) {
    const parts = [];
    for await (const [plane] of pcm.chunks()) parts.push(plane);
    const all = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        all.set(part, at);
        at += part.length;
    }
    return all;
}

describe('pipeline/codecs: a host audio encoder', () => {
    test('PCM reaches it as timed planar float; its packets keep their times', async () => {
        const host = hostOpus();
        try {
            const { blob } = await convert(monoWave(960 * 24), 'webm');
            const { packets } = await written(blob);
            assert.equal(packets.length, 24);
            assert.deepEqual(
                packets.map(packet => Math.round(packet.time * 100)),
                Array.from({ length: 24 }, (_, index) => index * 2),
            );
            assert.ok(packets.every(packet => packet.length === 0.02));
            assert.ok(host.inputs.every(([format, rate, channels]) => format === 'f32-planar'));
            assert.ok(host.inputs.every(([, rate, channels]) => rate === 48000 && channels === 1));
            assert.ok(host.closed(), 'every AudioData and the encoder are closed');
        } finally {
            host.restore();
        }
    });

    test("the OpusHead pre-skip it gives becomes the track's delay", async () => {
        const head = new Uint8Array(19);
        head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1, 0x38, 0x01, 0x80, 0xbb]);
        const host = hostOpus({ description: head, preSkip: 312 });
        try {
            const { blob } = await convert(monoWave(960 * 24), 'webm');
            const { track, packets } = await written(blob);
            assert.deepEqual(track.codecConfig, head);
            assert.ok(Math.abs(packets[0].time + 312 / 48000) < 1e-3, `${packets[0].time}`);
            assert.ok(Math.abs(track.duration - 0.48) < 1e-6, 'it presents 24 x 960 frames');
        } finally {
            host.restore();
        }
    });

    test(
        'its failure ends the conversion while a read is pending',
        { timeout: 20_000 },
        async () => {
            const host = hostOpus({ fail: true });
            const wave = monoWave(48000 * 10);
            // Past the first 64 KiB the input never answers.
            const source = {
                size: wave.length,
                async read(at, length) {
                    if (at + length > 65536 && at > 44) return new Promise(() => {});
                    return wave.slice(at, at + length);
                },
            };
            try {
                await assert.rejects(
                    convert(source, 'webm', { open: { cacheBytes: 0 } }),
                    error =>
                        error.code === 'ENCODE' && /Native audio encode failed/.test(error.message),
                );
                assert.ok(host.closed());
            } finally {
                host.restore();
            }
        },
    );

    test('an AAC host encoder goes first; the library takes over when it fails', async () => {
        const aacBytes = async options =>
            new Uint8Array(
                await (
                    await convert(monoWave(4800, 48000, true), 'aac', options)
                ).blob.arrayBuffer(),
            );
        const builtIn = await aacBytes({ codecPreference: 'builtin' });
        const working = hostAac('ok');
        try {
            const hosted = await aacBytes({});
            assert.equal(working.stats.encoders, 1);
            assert.equal(
                hosted.length,
                working.stats.frames * 10,
                '3 bytes in 7-byte ADTS headers',
            );
            assert.deepEqual([...hosted.subarray(0, 2)], [0xff, 0xf1]);
            assert.deepEqual(await aacBytes({ codecPreference: 'builtin' }), builtIn);
            assert.equal(working.stats.encoders, 1, "'builtin' does not start the host");
        } finally {
            working.restore();
        }
        const failing = hostAac('fail');
        try {
            const warnings = [];
            const output = await aacBytes({ onWarning: warning => warnings.push(warning.code) });
            assert.deepEqual(output, builtIn, 'the library writes the whole file');
            assert.ok(warnings.includes('AUDIO_ENCODER_FALLBACK'));
        } finally {
            failing.restore();
        }
    });
});

describe("pipeline/codecs: the library's audio encoders", () => {
    test('a new rate presents the nearest whole frame count', async () => {
        // 1024 frames at 48 kHz are 470.4 at 22.05 kHz.
        const { blob } = await convert(monoWave(1024), 'm4a', {
            audio: { sampleRate: 22050, channels: 1 },
        });
        const { track } = await written(blob);
        assert.equal(Math.round(track.duration * 22050), 470);
    });

    test('AAC of a source above 96 kHz is encoded at the nearest AAC rate', async () => {
        const { blob } = await convert(monoWave(19200, 192000, true), 'm4a', {
            codecPreference: 'builtin',
        });
        const { track } = await written(blob);
        assert.equal(track.sampleRate, 96000);
        assert.ok(Math.abs(track.duration - 0.1) < 0.03, `${track.duration} s`);
    });

    test('sound that ends before its stated length is completed with silence', async () => {
        // A decoder may give fewer frames than the packets promised: here one FLAC frame of 3000
        // samples in a track that says 0.1 s. The encoded track covers the length it states.
        const flac = await encodeFlac([new Float32Array(3000).fill(0.25)], { sampleRate: 48000 });
        const copy = await open((await convert(flac, 'mkv', { copy: true })).blob);
        const samples = [];
        for await (const packet of copy.packets())
            samples.push({
                offset: 0,
                size: packet.data.length,
                data: packet.data,
                timestamp: packet.timestamp,
                duration: 0.1 - packet.timestamp,
                isKeyframe: true,
            });
        const track = { ...copy.tracks[0], id: 1, duration: 0.1, samples };
        copy.close();
        const { blob } = await convert(new Uint8Array(1), {
            to: 'm4a',
            copy: false,
            ...owning(track),
        });
        const { track: encoded } = await written(blob);
        assert.equal(Math.round(encoded.duration * 48000), 4800);
    });

    test('PCM that is no finite number fails with DECODE instead of being rounded', async () => {
        for (const bits of [32, 64])
            for (const littleEndian of [true, false])
                for (const value of [NaN, Infinity, -Infinity, ...(bits === 64 ? [1e300] : [])]) {
                    const data = new Uint8Array(bits / 8);
                    new DataView(data.buffer)[`setFloat${bits}`](0, value, littleEndian);
                    const codec = `pcm-f${bits}${littleEndian ? 'le' : 'be'}`;
                    const sample = { offset: 0, size: data.length, timestamp: 0, isKeyframe: true };
                    const track = {
                        id: 1,
                        codec,
                        sampleRate: 48000,
                        channelCount: 1,
                        duration: 1 / 48000,
                        samples: [{ ...sample, duration: 1 / 48000, data }],
                    };
                    const refused = await convert(new Uint8Array(1), {
                        to: 'wav',
                        copy: false,
                        ...owning(track),
                    }).catch(error => error);
                    assert.equal(refused.code, 'DECODE', `${codec}: ${value}`);
                    assert.match(refused.message, /nonfinite/);
                }
    });

    test('MP3 sound through a muxer holds the frames an MP3 file of it holds', async () => {
        const rate = 44100;
        const total = rate * 6;
        const sink = new MemorySink();
        const muxer = await createMuxer('mkv', sink, {
            audio: { codec: 'mp3', sampleRate: rate, channels: 1 },
        });
        await muxer.encodeAudio(sinePcm(rate, total), { bitrate: 128000 });
        await muxer.finish();
        const file = await encodeMp3([await joined(sinePcm(rate, total))], { sampleRate: rate });
        const [inMatroska, inFile] = await Promise.all([
            written(sink.toBlob('video/x-matroska')),
            written(file),
        ]);
        assert.deepEqual(
            inMatroska.packets.map(packet => [...packet.data]),
            inFile.packets.map(packet => [...packet.data]),
        );
        const decoded = async blob =>
            (await (await convert(blob, 'wav')).blob.arrayBuffer()).byteLength;
        assert.equal(
            await decoded(sink.toBlob('video/x-matroska')),
            await decoded(file),
            'both decode to the same length',
        );
    });

    for (const format of ['mp4', 'mkv', 'ogg'])
        test(`FLAC streamed into ${format}: STREAMINFO completed where sinks patch`, async () => {
            for (const patches of [true, false]) {
                const memory = new MemorySink();
                const sink = patches
                    ? memory
                    : { write: data => memory.write(data), close: () => memory.close() };
                await convert(monoWave(32000 * 3 + 500, 32000, true), {
                    to: format,
                    audio: { codec: 'flac' },
                    sink,
                });
                const { track } = await written(memory.toUint8Array());
                const info = streamInfo(track.codecConfig);
                const label = `${format}${patches ? '' : ' without patchAt'}`;
                assert.equal(known(info), patches, label);
                assert.equal(totalSamples(info), 32000 * 3 + 500, label);
                assert.equal(Math.round(track.duration * 32000), 32000 * 3 + 500, label);
            }
        });

    for (const format of ['mp4', 'mkv', 'ogg'])
        test(`a muxer's FLAC in ${format} carries the encoder's STREAMINFO`, async () => {
            const rate = 32000;
            const total = rate * 3 + 500;
            const sink = new MemorySink();
            const muxer = await createMuxer(format, sink, {
                audio: { codec: 'flac', sampleRate: rate, channels: 1 },
            });
            await muxer.encodeAudio(sinePcm(rate, total));
            await muxer.finish();
            const { track } = await written(sink.toUint8Array());
            const info = streamInfo(track.codecConfig);
            assert.ok(known(info), 'frame sizes and MD5 known');
            assert.equal(totalSamples(info), total);
            assert.equal(Math.round(track.duration * rate), total);
        });
});

describe('pipeline/codecs: a muxer encoding sound of unknown length', () => {
    for (const codec of ['flac', 'mp2', 'mp3'])
        test(`writes ${codec} frames as they are coded, before the sound ends`, async () => {
            // A minute of sound: the sink takes nearly the whole file before the source's end
            // is read, so the encoded sound is not held until then.
            const rate = 32000;
            const total = rate * 60;
            let pulled = 0;
            let early = 0;
            const memory = new MemorySink();
            const sink = {
                write(data) {
                    if (pulled < total) early += data.length;
                    memory.write(data);
                },
                patchAt: (offset, data) => memory.patchAt(offset, data),
                close: () => memory.close(),
            };
            const muxer = await createMuxer('mkv', sink, {
                audio: { codec, sampleRate: rate, channels: 1 },
            });
            await muxer.encodeAudio(sinePcm(rate, total, frames => (pulled = frames)));
            await muxer.finish();
            const size = memory.toUint8Array().length;
            assert.ok(early > size * 0.9, `${early} of ${size} bytes before the end`);
            const { track } = await written(memory.toUint8Array());
            assert.equal(Math.round(track.duration * rate), total);
        });
});

describe('pipeline/codecs: a muxer encoding sound of stated length', () => {
    /** A fragmented MP4 sink: one that cannot patch what it wrote. */
    const streamed = () => {
        const memory = new MemorySink();
        return { memory, sink: { write: data => memory.write(data), close: () => memory.close() } };
    };

    for (const codec of ['mp3', 'mp2'])
        test(`a fragmented MP4 trims ${codec} at both ends of a stated length`, async () => {
            const rate = 44100;
            const total = rate * 2 + 300;
            for (const stated of [true, false]) {
                const { memory, sink } = streamed();
                const muxer = await createMuxer('mp4', sink, {
                    audio: { codec, sampleRate: rate, channels: 1 },
                });
                assert.equal(muxer.layout, 'fragmented');
                const source = sinePcm(rate, total);
                await muxer.encodeAudio(stated ? { ...source, frames: total } : source);
                await muxer.finish();
                const { track } = await written(memory.toUint8Array());
                const shown = Math.round(track.duration * rate);
                // Of unknown length, only the priming is hidden: the end shows the padding.
                if (stated) assert.equal(shown, total, `${codec} stated`);
                else assert.ok(shown > total, `${codec} of unknown length shows ${shown}`);
            }
        });

    test("decodeAudio() states a track's frames: its fragmented MP4 trims both ends", async () => {
        const rate = 44100;
        const total = rate * 2 + 300;
        const media = await open(monoWave(total, rate, true));
        try {
            const source = await decodeAudio(media, media.tracks[0].id);
            assert.equal(source.frames, total);
            const { memory, sink } = streamed();
            const muxer = await createMuxer('mp4', sink, {
                audio: { codec: 'mp3', sampleRate: rate, channels: 1 },
            });
            await muxer.encodeAudio(source);
            await muxer.finish();
            const { track } = await written(memory.toUint8Array());
            assert.equal(Math.round(track.duration * rate), total);
        } finally {
            media.close();
        }
    });

    test('MP2 of a stated length in whole frames still streams as it is coded', async () => {
        const rate = 32000;
        const total = 1152 * 1700;
        let pulled = 0;
        let early = 0;
        const memory = new MemorySink();
        const sink = {
            write(data) {
                if (pulled < total) early += data.length;
                memory.write(data);
            },
            patchAt: (offset, data) => memory.patchAt(offset, data),
            close: () => memory.close(),
        };
        const muxer = await createMuxer('mkv', sink, {
            audio: { codec: 'mp2', sampleRate: rate, channels: 1 },
        });
        const source = sinePcm(rate, total, frames => (pulled = frames));
        await muxer.encodeAudio({ ...source, frames: total });
        await muxer.finish();
        const size = memory.toUint8Array().length;
        assert.ok(early > size * 0.9, `${early} of ${size} bytes before the end`);
        const { track } = await written(memory.toUint8Array());
        assert.equal(Math.round(track.duration * rate), total);
    });

    test('a stated length that is no positive whole number fails with INPUT', async () => {
        const muxer = await createMuxer('mkv', new MemorySink(), {
            audio: { codec: 'flac', sampleRate: 8000, channels: 1 },
        });
        for (const frames of [0, 1.5, -2, '8000'])
            await assert.rejects(
                muxer.encodeAudio({ ...sinePcm(8000, 800), frames }),
                error => error.code === 'INPUT',
            );
        muxer.abort();
    });
});
