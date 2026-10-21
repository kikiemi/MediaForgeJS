import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, inspect, open } from 'mediaforgejs';
import { MemorySink } from 'mediaforgejs/io';
import * as lite from 'mediaforgejs/lite';
import { aac } from 'mediaforgejs/plugins';
import {
    AacLcDecoder,
    decodeFlacFrame,
    encodeFlac,
    parseFlacStreamInfo,
} from 'mediaforgejs/codecs';
import { aacMatroska, toneWav } from '../helpers/api-fixtures.mjs';
import { waveFixture } from '../helpers/original-fixtures.mjs';
import { readerPart } from '../helpers/parts.mjs';
import { tone, waveFile } from '../helpers/pcm.mjs';

// Sound re-encoded in Node, where the library's decoders and encoders do the work: lengths,
// windows and the samples written.

describe('pipeline/transcode: sound decoded by the library', () => {
    /** Four 16-bit samples at 8 kHz, or `extra`, in a track of the 'owned' format. */
    const pcmTrack = (extra = {}) => ({
        id: 1,
        codec: 'pcm-s16le',
        sampleRate: 8000,
        channelCount: 1,
        duration: 4 / 8000,
        samples: [{ offset: 0, size: 8, timestamp: 0, duration: 4 / 8000, isKeyframe: true }],
        ...extra,
    });
    /** Opens `input` as the 'owned' format of `tracks`. */
    const owned = (tracks, input = new Uint8Array(8)) => {
        const reader = {
            formats: ['owned'],
            async read() {
                return { videoTracks: [], audioTracks: tracks };
            },
        };
        return open(input, {
            plugins: { add: [{ name: 'owned', readers: [readerPart(reader)] }] },
            format: 'owned',
        });
    };
    /** The data chunk of a WAV result. */
    const waveData = async result => {
        const bytes = new Uint8Array(await result.blob.arrayBuffer());
        const view = new DataView(bytes.buffer);
        for (let at = 12; at + 8 <= bytes.length;) {
            const size = view.getUint32(at + 4, true);
            if (String.fromCharCode(...bytes.subarray(at, at + 4)) === 'data')
                return bytes.subarray(at + 8, at + 8 + size);
            at += 8 + size + (size & 1);
        }
        assert.fail('the WAVE data chunk is missing');
    };

    test('AAC and MP2 encoded from PCM decode back to PCM', async () => {
        for (const format of ['aac', 'mp2']) {
            const encoded = await convert(waveFixture(), format, { audio: { sampleRate: 48000 } });
            const media = await open(encoded.blob);
            try {
                const support = await media.check('wav');
                assert.equal(support.plan.tracks[0].action, 'encode', format);
                const decoded = await inspect((await media.convert('wav')).blob, {
                    sampleCounts: true,
                });
                assert.ok(decoded.tracks[0].codec.startsWith('pcm'));
                assert.ok(decoded.tracks[0].sampleCount > 0);
            } finally {
                media.close();
            }
        }
    });

    test('MP3 decodes to the length of its source: the LAME gapless trim', async () => {
        const target = { audio: { sampleRate: 48000 } };
        const encoded = (await convert(waveFixture(), 'mp3', target)).blob;
        const media = await open(encoded);
        try {
            const decoded = await media.convert('wav');
            const [track] = (await inspect(decoded.blob)).tracks;
            assert.deepEqual([track.sampleRate, track.channelCount], [48000, 2]);
            const source = await convert(waveFixture(), 'wav', target);
            assert.equal((await waveData(decoded)).length, (await waveData(source)).length);
        } finally {
            media.close();
        }
    });

    test("AAC's priming and trailing padding are left out of the decoded sound", async () => {
        const encoded = (await convert(waveFixture(), 'aac', { audio: { sampleRate: 48000 } }))
            .blob;
        const file = await open(encoded);
        const packets = [];
        for await (const packet of file.packets()) packets.push(packet);
        const info = file.tracks[0];
        file.close();
        const track = {
            id: 7,
            default: true,
            codec: info.codec,
            codecConfig: info.codecConfig,
            sampleRate: 48000,
            channelCount: info.channelCount,
            duration: (packets.length * 1024) / 48000,
            audioPrimingSamples: 100,
            audioTrailingPaddingSamples: 100,
            samples: packets.map(packet => ({
                offset: 0,
                size: packet.data.length,
                timestamp: packet.timestamp,
                duration: packet.duration,
                isKeyframe: true,
                data: packet.data,
            })),
        };
        const broken = { ...track, id: 2, default: false, codecConfig: new Uint8Array([0]) };
        const media = await owned([broken, track]);
        try {
            assert.equal((await media.check('wav')).plan.tracks[0].trackId, 7, 'the default');
            const data = await waveData(await media.convert('wav'));
            assert.equal(data.length, (packets.length * 1024 - 200) * info.channelCount * 2);
        } finally {
            media.close();
        }
    });

    test('a silent MPEG layer I frame written elsewhere decodes to silence', async () => {
        const frame = new Uint8Array(32);
        frame.set([0xff, 0xff, 0x14, 0xc0]);
        const media = await open(frame, { format: 'mp1' });
        try {
            const data = await waveData(await media.convert('wav'));
            assert.equal(data.length, 384 * 2);
            assert.ok(data.every(byte => byte === 0));
        } finally {
            media.close();
        }
    });

    test('a range of PCM is cut at the sample, the samples unchanged', async () => {
        const data = new Uint8Array([0, 0, 0, 32, 0, 64, 0, 96]);
        const samples = [{ offset: 0, size: 8, timestamp: 0, duration: 4 / 8000, data }];
        const media = await owned([pcmTrack({ samples: [{ ...samples[0], isKeyframe: true }] })]);
        try {
            const range = await media.convert('wav', {
                copy: false,
                start: 1 / 8000,
                end: 3 / 8000,
            });
            assert.deepEqual([...(await waveData(range))], [0, 32, 0, 64]);
            const past = await media.check('wav', { copy: false, start: 1, end: 2 });
            assert.equal(past.supported, false);
        } finally {
            media.close();
        }
    });

    test('PCM that is not a number is refused, not quantized', async () => {
        const data = new Uint8Array(8);
        new DataView(data.buffer).setFloat32(0, NaN, true);
        const sample = { offset: 0, size: 8, timestamp: 0, duration: 2 / 8000, isKeyframe: true };
        const media = await owned([
            pcmTrack({ codec: 'pcm-f32le', duration: 2 / 8000, samples: [{ ...sample, data }] }),
        ]);
        try {
            const target = { copy: false, allowPrecisionLoss: true };
            assert.equal((await media.check('wav', target)).supported, false);
        } finally {
            media.close();
        }
    });

    test('the sole default track is chosen; trackIds chooses another', async () => {
        const media = await owned([
            pcmTrack({ id: 2, default: false }),
            pcmTrack({ id: 7, default: true }),
        ]);
        try {
            const chosen = await media.check('wav', { copy: false });
            assert.equal(chosen.plan.tracks[0].trackId, 7);
            const asked = await media.check('wav', { copy: false, trackIds: [2] });
            assert.equal(asked.plan.tracks[0].trackId, 2);
        } finally {
            media.close();
        }
    });
});

describe('pipeline/transcode: codecs met on the way', () => {
    /** The 16-bit samples of a WAV result. */
    const wavInt16 = async blob => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const view = new DataView(bytes.buffer);
        for (let at = 12; at + 8 <= bytes.length;) {
            const size = view.getUint32(at + 4, true);
            if (String.fromCharCode(...bytes.subarray(at, at + 4)) === 'data')
                return new Int16Array(bytes.buffer, at + 8, size / 2);
            at += 8 + size + (size & 1);
        }
        assert.fail('the WAVE data chunk is missing');
    };

    test('a FLAC range decodes from its frame; a damaged frame before it is not read', async () => {
        // Six frames of 4096 and some: a tone, noise and steps per channel.
        const frames = 4096 * 6 + 77;
        const pcm = Float32Array.from({ length: frames * 2 }, (_, index) =>
            index < frames
                ? 0.6 * Math.sin(index / (5 + (index & 1)))
                : ((Math.imul(index, 2654435761) >>> 16) / 65536 - 0.5) * 0.9,
        );
        const planes = [0, 1].map(channel => pcm.filter((_, index) => index % 2 === channel));
        const flac = await encodeFlac(planes, { sampleRate: 48000 });
        const streamInfo = parseFlacStreamInfo(flac.subarray(0, 42));
        const second = 42 + decodeFlacFrame(flac.subarray(42), { streamInfo }).byteLength;
        const length = decodeFlacFrame(flac.subarray(second), { streamInfo }).byteLength;
        const mp4 = new Uint8Array(
            await (await convert(flac, 'mp4', { copy: true })).blob.arrayBuffer(),
        );
        const at = Buffer.from(mp4).indexOf(flac.subarray(second, second + length));
        assert.ok(at > 0, 'the second frame is copied unchanged');
        const damaged = mp4.slice();
        damaged[at + length - 1] ^= 0x55;
        const whole = await wavInt16((await convert(mp4, 'wav')).blob);
        const warnings = [];
        const range = await convert(new Blob([damaged]), {
            to: 'wav',
            start: (4096 * 3.5) / 48000,
            end: (4096 * 5.25) / 48000,
            onWarning: warning => warnings.push(warning.code),
        });
        assert.deepEqual(warnings, [], 'nothing is concealed');
        assert.deepEqual(
            await wavInt16(range.blob),
            whole.subarray(4096 * 3.5 * 2, 4096 * 5.25 * 2),
        );
    });

    test('an M4A re-encoded keeps its language, however the file is taken', async () => {
        const { blob: source } = await convert(await aacMatroska({ language: 'jpn' }), 'm4a');
        const target = {
            to: 'm4a',
            open: { metadataPolicy: 'error' },
            audio: { sampleRate: 24000 },
        };
        const sink = new MemorySink();
        await convert(source, { ...target, sink });
        const outputs = [
            (await convert(source, target)).blob,
            sink.toBlob('audio/mp4'),
            (await new lite.MediaForge({ plugins: [aac] }).convert(source, target)).blob,
        ];
        for (const output of outputs) {
            const [track] = (await inspect(output)).tracks;
            assert.deepEqual([track.sampleRate, track.language], [24000, 'jpn']);
        }
    });

    test('MP3 re-encoded as AAC is written by the AAC-LC encoder at its rate', async () => {
        const mp3 = (await convert(toneWav(1, 44100), 'mp3')).blob;
        const m4a = (await convert(mp3, 'm4a', { audio: { codec: 'aac' } })).blob;
        const [track] = (await inspect(m4a, { sampleCounts: true })).tracks;
        assert.deepEqual([track.codec, track.sampleRate], ['mp4a.40.2', 44100]);
        const expected = Math.ceil(44100 / 1024);
        assert.ok(Math.abs(track.sampleCount - expected) <= 2, `${track.sampleCount} packets`);
    });

    test('six channels written into a two-channel format report the fold-down', async () => {
        const wav = waveFile(tone(48000, 6, 4800), 48000, 6);
        for (const to of ['aiff', 'au']) {
            const warnings = [];
            const { blob } = await convert(wav, to, {
                copy: false,
                onWarning: warning => warnings.push(warning.code),
            });
            assert.ok(warnings.includes('AUDIO_DOWNMIXED'), to);
            assert.equal((await inspect(blob)).tracks[0].channelCount, 2);
        }
    });

    test("libfaac's encoder delay is dropped where FLV configures each packet", async () => {
        // libfaac starts with a fill element naming the encoder; the first 1024 decoded samples
        // (its delay) are dropped, as FFmpeg drops them.
        const marker = Buffer.from('de0200006c69626661616320312e323801c0', 'hex');
        const audio = Buffer.from('01540685a00000800380', 'hex');
        const frames = [marker, ...new Array(6).fill(audio)];
        const tag = (payload, ms) =>
            Buffer.concat([
                Buffer.from([
                    8,
                    0,
                    0,
                    payload.length,
                    ms >> 16,
                    (ms >> 8) & 255,
                    ms & 255,
                    0,
                    0,
                    0,
                    0,
                ]),
                payload,
                Buffer.from([0, 0, 0, payload.length + 11]),
            ]);
        const file = Buffer.concat([
            Buffer.from([0x46, 0x4c, 0x56, 1, 4, 0, 0, 0, 9, 0, 0, 0, 0]),
            tag(Buffer.from([0xaf, 0, 0x13, 0x88]), 0),
            ...frames.map((payload, index) =>
                tag(Buffer.concat([Buffer.from([0xaf, 1]), payload]), index * 46),
            ),
        ]);
        // AAC-LC at 22050 Hz mono, as the configuration 0x1388 says.
        const decoder = new AacLcDecoder(22050, 1);
        const direct = frames.map(
            payload => decoder.decodeFrame(payload)[0] ?? new Float32Array(0),
        );
        assert.equal(direct[0].length, 0, 'the marker carries no audio');
        const written = await wavInt16((await convert(file, 'wav', { copy: false })).blob);
        let worst = 0;
        for (let index = 0; index < 1024; index++)
            worst = Math.max(worst, Math.abs(written[index] / 32768 - direct[2][index]));
        assert.ok(worst < 2 / 32768, `starts with the second audio frame (${worst})`);
    });
});
