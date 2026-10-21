import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { convert, inspect, open } from 'mediaforgejs';
import { encodeFlac } from 'mediaforgejs/codecs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import * as lite from 'mediaforgejs/lite';
import { flac as flacPlugin, mpegAudio } from 'mediaforgejs/plugins';
import { codes, monoWav } from '../helpers/api-fixtures.mjs';

// The precision of re-encoded sound: float and 24-bit samples kept where the output holds them,
// rounded with a report where it does not, or refused with allowPrecisionLoss: false.

/** The bytes of a Blob. */
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());

/** 4096 frames of full-scale noise, then 4096 of a quiet tone with detail below 16 bits. */
function deepSamples() {
    const samples = [];
    let seed = 1;
    for (let i = 0; i < 4096; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        samples.push((seed | 0) >> 8);
    }
    for (let i = 0; i < 4096; i++) samples.push(Math.round(Math.sin(i / 7) * 900) + (i % 5));
    return samples;
}

/** 24-bit stereo FLAC in Matroska: STREAMINFO says 24 bits of silence. */
async function deepFlacMkv() {
    const silence = [new Float32Array(4096), new Float32Array(4096)];
    const flac = await encodeFlac(silence, { sampleRate: 48000 });
    const header = flac.slice(0, 42);
    header[20] = (header[20] & 0xfe) | 1;
    header[21] = (header[21] & 0x0f) | 0x70;
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'mkv',
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            audio: {
                id: 1,
                type: 'audio',
                codec: 'flac',
                sampleRate: 48000,
                channelCount: 2,
                codecConfig: header,
            },
        },
        sink,
    );
    muxer.addAudioChunk({
        data: flac.subarray(42),
        timestamp: 0,
        duration: 4096 / 48000,
        isKeyframe: true,
        trackType: 'audio',
    });
    await muxer.finalize();
    return sink.toBlob('video/x-matroska');
}

describe('pipeline/transcode: precision', () => {
    test('float samples are written exactly into WAV', async () => {
        const media = await open(monoWav([0, 0.5, -0.5, 1], { bits: 32, float: true }));
        try {
            const exact = await media.check('wav', { copy: false, allowPrecisionLoss: false });
            assert.deepEqual([exact.supported, exact.warnings], [true, []]);
            const { blob } = await media.convert('wav', { copy: false });
            assert.equal(blob.type, 'audio/wav');
            assert.equal((await inspect(blob)).tracks[0].codec, 'pcm-f32le');
            assert.deepEqual(
                [...(await bytesOf(blob)).subarray(-8)],
                [0, 0, 0, 191, 0, 0, 128, 63],
            );
        } finally {
            media.close();
        }
    });

    test('float into FLAC is rounded with a report, or refused', async () => {
        const media = await open(monoWav([0, 0.5, -0.5, 1], { bits: 32, float: true }));
        try {
            const rounded = await media.check('flac');
            assert.equal(rounded.supported, true);
            assert.deepEqual(codes(rounded.warnings), ['AUDIO_PRECISION_REDUCED']);
            const refused = await media.check('flac', { allowPrecisionLoss: false });
            assert.equal(refused.code, 'FORMAT');
        } finally {
            media.close();
        }
        const float = monoWav([0, 0.25, -0.5, 0.125], { bits: 32, float: true });
        const target = { to: 'mkv', audio: { codec: 'flac' } };
        assert.deepEqual(codes((await convert(float, target)).warnings), [
            'AUDIO_PRECISION_REDUCED',
        ]);
        await assert.rejects(
            convert(float, { ...target, allowPrecisionLoss: false }),
            error => error.code === 'FORMAT',
        );
    });

    test('24-bit FLAC keeps 24 bits in WAV, AIFF, CAF and FLAC', async () => {
        // Node has no AudioDecoder: the flac plugin decodes, the mpegAudio plugin encodes MP3.
        const media = await lite.open(await deepFlacMkv(), { plugins: [flacPlugin, mpegAudio] });
        try {
            for (const [output, codec] of [
                ['wav', 'pcm-s24le'],
                ['aiff', 'pcm-s24be'],
                ['caf', 'pcm-s24le'],
            ]) {
                const kept = await media.convert(output, { copy: false });
                assert.ok(!codes(kept.warnings).includes('AUDIO_PRECISION_REDUCED'), output);
                assert.equal(kept.plan.tracks[0].codec, 'pcm-s24', 'the plan names the coding');
                assert.equal((await inspect(kept.blob)).tracks[0].codec, codec, output);
            }
            const flac = await media.check('flac', { copy: false, allowPrecisionLoss: false });
            assert.ok(flac.supported);
            assert.ok(!codes(flac.warnings).includes('AUDIO_PRECISION_REDUCED'));
            assert.equal((await media.check('wav', { audio: { codec: 'ulaw' } })).supported, true);
            assert.equal((await media.check('mp3')).supported, true);
        } finally {
            media.close();
        }
    });

    test('a 24-bit WAV becomes a 24-bit FLAC that decodes to the same samples', async () => {
        const source = monoWav(deepSamples(), { bits: 24 });
        const pcm = source.subarray(44);
        const { blob, warnings } = await convert(source, 'flac');
        assert.deepEqual(warnings, []);
        const flac = await bytesOf(blob);
        assert.equal((((flac[20] & 1) << 4) | (flac[21] >> 4)) + 1, 24, 'STREAMINFO: 24 bits');
        assert.deepEqual(
            [...flac.subarray(26, 42)],
            [...createHash('md5').update(pcm).digest()],
            'the MD5 covers the 24-bit samples',
        );
        const back = await bytesOf((await convert(blob, 'wav')).blob);
        assert.deepEqual(back.subarray(back.length - pcm.length), pcm);
    });

    test('16-bit sound in 24-bit samples costs about what 16-bit sound does', async () => {
        // The eight zero bits are coded as wasted bits.
        const quiet = deepSamples().slice(4096);
        const sizeOf = async bytes => (await convert(bytes, 'flac')).blob.size;
        const wide = await sizeOf(
            monoWav(
                quiet.map(sample => sample * 256),
                { bits: 24 },
            ),
        );
        const narrow = await sizeOf(monoWav(quiet));
        assert.ok(wide < narrow + 64, `${wide} bytes from 24-bit samples, ${narrow} from 16-bit`);
    });

    test("24-bit FLAC is the library encoder's in every plan, beside a host encoder", async () => {
        // A host AudioEncoder that takes every configuration chooses its own FLAC depth: the plans
        // of a file and of a container track both name the library's, which keeps 24 bits.
        const saved = { AudioEncoder: globalThis.AudioEncoder, AudioData: globalThis.AudioData };
        globalThis.AudioEncoder = class {
            static async isConfigSupported(config) {
                return { supported: true, config };
            }
        };
        globalThis.AudioData = class {};
        try {
            const media = await open(monoWav(deepSamples(), { bits: 24 }));
            try {
                for (const target of ['flac', { to: 'mkv', audio: { codec: 'flac' } }]) {
                    const { plan } = await media.check(target);
                    assert.deepEqual(
                        [plan.tracks[0].codec, plan.tracks[0].encoder],
                        ['flac', 'builtin'],
                        JSON.stringify(target),
                    );
                }
            } finally {
                media.close();
            }
        } finally {
            for (const [name, value] of Object.entries(saved))
                if (value === undefined) delete globalThis[name];
                else globalThis[name] = value;
        }
    });

    for (const format of ['mkv', 'mp4', 'mov'])
        test(`24-bit FLAC encoded into ${format} decodes to the same samples`, async () => {
            const source = monoWav(deepSamples(), { bits: 24 });
            const pcm = source.subarray(44);
            const packed = await convert(source, { to: format, audio: { codec: 'flac' } });
            assert.deepEqual(packed.warnings, []);
            const unpacked = await bytesOf((await convert(packed.blob, 'wav')).blob);
            assert.deepEqual(unpacked.subarray(unpacked.length - pcm.length), pcm);
        });
});
