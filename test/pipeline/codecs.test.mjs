import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, check, convert, open } from 'mediaforgejs';
import { WebMDemuxer } from 'mediaforgejs/formats';
import * as lite from 'mediaforgejs/lite';
import { decodeAudio } from 'mediaforgejs/parts';
import { mpeg4 } from 'mediaforgejs/plugins';
import { codes, toneWav } from '../helpers/api-fixtures.mjs';
import { classicMp4 } from '../helpers/mp4-fixture.mjs';
import { SIMPLE_FIXTURE } from '../helpers/mpeg4-fixtures.mjs';
import { OPUS_FIXTURES } from '../helpers/opus-fixtures.mjs';
import { readerPart } from '../helpers/parts.mjs';

// Which decoder and encoder runs for each track: the host first, a plugin's where the host has
// none, and the PLUGIN error that names the plugin when neither is in use.

/** An MPEG-4 Part 2 elementary stream as one packet per VOP, through a test reader. */
function mpeg4Stream() {
    const stream = SIMPLE_FIXTURE.bytes();
    const vops = [];
    for (let index = 0; index + 3 < stream.length; index++)
        if (
            stream[index] === 0 &&
            stream[index + 1] === 0 &&
            stream[index + 2] === 1 &&
            stream[index + 3] === 0xb6
        )
            vops.push(index);
    const samples = vops.map((start, index) => {
        const data = stream.slice(index ? start : 0, vops[index + 1] ?? stream.length);
        return {
            data,
            offset: 0,
            size: data.length,
            timestamp: index / 25,
            duration: 0.04,
            isKeyframe: stream[start + 4] >> 6 === 0,
        };
    });
    const elementary = {
        formats: ['m4v-es'],
        async read() {
            return {
                audioTracks: [],
                videoTracks: [
                    {
                        id: 1,
                        codec: SIMPLE_FIXTURE.codec,
                        width: 64,
                        height: 48,
                        sampleRate: 0,
                        channelCount: 0,
                        duration: 0.24,
                        samples,
                    },
                ],
            };
        },
    };
    return { stream, reader: { name: 'm4v-es', readers: [readerPart(elementary)] } };
}

describe('pipeline/codecs', () => {
    describe('video decoders', () => {
        test('without a host decoder or the plugin, decoding names both', async () => {
            const { stream, reader } = mpeg4Stream();
            const core = new lite.MediaForge({ plugins: [reader], open: { format: 'm4v-es' } });
            const missing = await core
                .thumbnail(stream, { time: 0.1, to: 'png' })
                .catch(error => error);
            assert.deepEqual([missing.code, missing.plugin], ['PLUGIN', 'mpeg4']);
            assert.match(missing.hint, /Include the 'mpeg4' plugin/);
            assert.match(missing.hint, /VideoDecoder supports mp4v\.20/);
        });

        test('an excluded plugin is named the same way', async () => {
            const { stream, reader } = mpeg4Stream();
            const excluded = await new MediaForge({
                plugins: { exclude: ['mpeg4'], add: [reader] },
                open: { format: 'm4v-es' },
            })
                .thumbnail(stream, { time: 0.1, to: 'png' })
                .catch(error => error);
            assert.deepEqual([excluded.code, excluded.plugin], ['PLUGIN', 'mpeg4']);
        });

        test('the plugin decoder serves frames() and thumbnail() without host codecs', async () => {
            const { stream, reader } = mpeg4Stream();
            const forge = new lite.MediaForge({
                plugins: [reader, mpeg4],
                open: { format: 'm4v-es' },
            });
            const frames = [];
            for await (const frame of forge.frames(stream, { rotate: 90 })) frames.push(frame);
            assert.deepEqual(
                frames.map(frame => [Math.round(frame.timestamp * 100), frame.width, frame.height]),
                [0, 4, 8, 12, 16, 20].map(time => [time, 48, 64]),
            );
            assert.ok(
                frames.every(frame => frame.data.some((value, at) => at % 4 !== 3 && value > 32)),
                'the pictures are decoded, not blank',
            );
            const { blob } = await forge.thumbnail(stream, { time: 0.1, to: 'png' });
            assert.deepEqual(
                [...new Uint8Array(await blob.arrayBuffer()).subarray(16, 24)],
                [0, 0, 0, 64, 0, 0, 0, 48],
            );
        });
    });

    describe('audio encoders', () => {
        test('a setting an encoder cannot take becomes the nearest it can, reported', async () => {
            for (const target of [
                { to: 'mp2', audio: { sampleRate: 8000 } },
                { to: 'mp3', audio: { bitrate: 12_000 } },
            ]) {
                const repaired = await check(toneWav(), target);
                assert.equal(repaired.supported, true, JSON.stringify(target));
                assert.ok(codes(repaired.warnings).includes('OPTION_NORMALIZED'));
            }
            const { blob } = await convert(toneWav(), { to: 'mp2', audio: { sampleRate: 8000 } });
            const media = await open(blob, { validation: 'strict' });
            assert.equal(media.tracks[0].sampleRate, 32000, 'the file has the repaired rate');
            media.close();
        });

        test('strictly, a setting an encoder cannot take is refused', async () => {
            const media = await open(toneWav(), { validation: 'strict' });
            try {
                for (const target of [
                    { to: 'mp2', audio: { sampleRate: 8000 } },
                    { to: 'mp3', audio: { bitrate: 12_000 } },
                ])
                    assert.equal((await media.check(target)).supported, false);
            } finally {
                media.close();
            }
        });

        test('AAC is encoded as AAC-LC only: HE-AAC fails with ENCODE', async () => {
            const refused = await convert(toneWav(), 'aac', {
                audio: { codec: 'mp4a.40.5' },
            }).catch(error => error);
            assert.equal(refused.code, 'ENCODE');
            assert.match(refused.hint, /AAC-LC/);
        });
    });
});

describe('pipeline/codecs: decoded sound', () => {
    /** 128 packets of one AAC or MP2 frame, in MP4 or as MPEG audio. */
    async function longTrack(format) {
        const count = 128;
        const unit = format === 'aac' ? 1024 : 1152;
        if (format === 'mp2')
            return {
                input: (
                    await convert(toneWav((count * unit) / 48000), 'mp2', {
                        audio: { channels: 1 },
                    })
                ).blob,
                frames: count * unit,
            };
        const { blob } = await convert(toneWav(0.05), 'aac', { audio: { channels: 1 } });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const size = ((bytes[3] & 3) << 11) | (bytes[4] << 3) | (bytes[5] >> 5);
        const packet = bytes.slice(7, size);
        const fixture = classicMp4({
            count,
            constantSize: packet.length,
            timescale: 48000,
            timing: [[count, unit]],
        });
        for (const offset of fixture.sampleOffsets) fixture.bytes.set(packet, offset);
        return { input: fixture.bytes, frames: count * unit };
    }

    for (const format of ['aac', 'mp2'])
        test(`${format}: decoded sound replays whole and yields without timers`, async () => {
            const { input, frames } = await longTrack(format);
            const media = await open(input, { maxIndexBytes: 8192 });
            try {
                const pcm = await decodeAudio(media, media.tracks[0].id);
                assert.equal(pcm.channels, 1);
                for (let replay = 0; replay < 2; replay++) {
                    let decoded = 0;
                    for await (const planes of pcm.chunks()) {
                        assert.equal(planes.length, 1);
                        assert.ok(planes[0].every(Number.isFinite));
                        decoded += planes[0].length;
                    }
                    assert.ok(Math.abs(decoded - frames) <= 1152, `${decoded} of ${frames}`);
                    assert.equal(decoded, pcm.estimatedFrames);
                }
                const timeout = globalThis.setTimeout;
                let yielded = false;
                try {
                    globalThis.setTimeout = () => {
                        throw new Error('a timer delay where setImmediate is there');
                    };
                    setImmediate(() => (yielded = true));
                    for await (const planes of pcm.chunks()) void planes;
                } finally {
                    globalThis.setTimeout = timeout;
                }
                assert.ok(yielded, 'other work ran while decoding');
            } finally {
                media.close();
            }
        });
});

describe('pipeline/codecs: lost packets', () => {
    /** The planes of the first track of `input` read as `track`, decoded by the library. */
    async function decoded(bytes, track) {
        const reader = {
            formats: ['lossy'],
            async read() {
                return { videoTracks: [], audioTracks: [track] };
            },
        };
        const media = await open(bytes, {
            plugins: { add: [{ name: 'lossy', readers: [readerPart(reader)] }] },
            format: 'lossy',
        });
        try {
            const pcm = await decodeAudio(media, track.id, { codecPreference: 'builtin' });
            const planes = Array.from({ length: pcm.channels }, () => []);
            for await (const chunk of pcm.chunks())
                chunk.forEach((plane, channel) => planes[channel].push(plane));
            return planes.map(parts => {
                const plane = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
                let at = 0;
                for (const part of parts) {
                    plane.set(part, at);
                    at += part.length;
                }
                return plane;
            });
        } finally {
            media.close();
        }
    }

    test('Opus conceals two lost packets in place and resynchronizes after them', async () => {
        const entry = OPUS_FIXTURES.find(item => item.name === 'celt-fb-audio-20ms-stereo');
        // The Ogg Opus copied into Matroska, read by a reader that can drop packets.
        const mkv = (await convert(entry.bytes(), 'mkv', { copy: true })).blob;
        const bytes = new Uint8Array(await mkv.arrayBuffer());
        const [track] = (await new WebMDemuxer().demux(mkv)).audioTracks;
        const intact = await decoded(bytes, track);
        const lost = [8, 9];
        const samples = track.samples.filter((_, index) => !lost.includes(index));
        const concealed = await decoded(bytes, { ...track, samples });
        assert.equal(concealed[0].length, intact[0].length, 'the loss keeps its place');
        const rms = (plane, start, count) => {
            let energy = 0;
            for (let index = start; index < start + count; index++)
                energy += plane[index] * plane[index];
            return Math.sqrt(energy / count);
        };
        // The first lost packet, on the presented timeline after the 312-sample pre-skip.
        const gap =
            Math.round(track.samples[8].timestamp * 48000) -
            Math.round(track.samples[0].timestamp * 48000) -
            312;
        assert.deepEqual(concealed[0].subarray(0, gap - 1), intact[0].subarray(0, gap - 1));
        const before = rms(intact[0], gap - 960, 960);
        const filled = rms(concealed[0], gap, 960);
        assert.ok(filled > before * 0.1, `the gap continues the sound (${filled} vs ${before})`);
        const tail = gap + 1920 * 3;
        let signal = 0;
        let noise = 0;
        for (let channel = 0; channel < 2; channel++)
            for (let index = tail; index < intact[channel].length; index++) {
                signal += intact[channel][index] ** 2;
                noise += (concealed[channel][index] - intact[channel][index]) ** 2;
            }
        const snr = 10 * Math.log10(signal / (noise || 1e-30));
        assert.ok(snr > 40, `resynchronized: ${snr.toFixed(1)} dB`);
    });
});
