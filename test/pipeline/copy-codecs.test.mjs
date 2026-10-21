import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { check, convert, open } from 'mediaforgejs';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { TsMuxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { mpegAudioFixture, waveFixture } from '../helpers/original-fixtures.mjs';
import { proresFrames } from '../helpers/prores-fixtures.mjs';
import { PICTURE_B, mpeg2Gop, programStream } from '../helpers/mpeg-video-fixtures.mjs';

// Whether a conversion copies each track or encodes it, and what the copies keep: MPEG audio, PCM,
// ProRes and MPEG-2 video in the containers that carry them.

/** The output of convert() as a Blob. */
const converted = async (input, format, options) => (await convert(input, format, options)).blob;
async function packets(file, trackId = file.tracks[0].id) {
    const result = [];
    for await (const packet of file.packets({ trackIds: [trackId] })) result.push(packet);
    return result;
}
async function assertCopied(
    source,
    output,
    sourceTrack = source.tracks[0],
    outputTrack = output.tracks[0],
) {
    assert.equal(outputTrack.codec, sourceTrack.codec);
    assert.equal(
        outputTrack.sampleRate,
        sourceTrack.sampleRate,
        'Packet copying must preserve the source sample rate',
    );
    assert.equal(outputTrack.channelCount, sourceTrack.channelCount);
    const original = await packets(source, sourceTrack.id);
    const copied = await packets(output, outputTrack.id);
    assert.equal(copied.length, original.length);
    for (let index = 0; index < original.length; index++) {
        assert.deepEqual(copied[index].data, original[index].data, `Packet ${index} payload`);
        assert(Math.abs(copied[index].timestamp - original[index].timestamp) < 0.000501);
        assert(Math.abs(copied[index].duration - original[index].duration) < 0.000501);
    }
}

describe('copy: what each codec copies into', () => {
    for (const layer of [1, 2, 3]) {
        test(`MPEG layer ${layer} audio copies into Matroska, every frame as it is`, async () => {
            assert.equal(globalThis.AudioDecoder, undefined);
            assert.equal(globalThis.AudioEncoder, undefined);
            const data = mpegAudioFixture(layer);
            const source = await open(data);
            let output;
            try {
                output = await open(await converted(new Blob([data]), 'mkv'));
                await assertCopied(source, output);
            } finally {
                source.close();
                output?.close();
            }
        });
    }

    test('convert copies original WAV PCM to Matroska without an Opus encoder', async () => {
        const data = waveFixture();
        const source = await open(data);
        let output;
        try {
            output = await open(await converted(new Blob([data]), 'mkv'));
            await assertCopied(source, output);
        } finally {
            source.close();
            output?.close();
        }
    });

    test('TS to Matroska retains primary MP3 and secondary MP2 with their languages', async () => {
        const inputs = await Promise.all([3, 2].map(layer => open(mpegAudioFixture(layer))));
        let source;
        let output;
        try {
            const sink = new MemorySink();
            const tracks = inputs.map((input, index) => ({
                ...input.tracks[0],
                id: index + 5,
                language: index ? 'jpn' : 'eng',
            }));
            const muxer = new TsMuxer(
                {
                    format: 'ts',
                    mode: 'standard',
                    maxFragmentDuration: 2,
                    autoSync: true,
                    audio: tracks[0],
                    extraAudioTracks: [tracks[1]],
                },
                sink,
            );
            const primary = await packets(inputs[0]);
            const secondary = await packets(inputs[1]);
            for (let index = 0; index < primary.length; index++) {
                muxer.addAudioChunk(primary[index]);
                muxer.addExtraAudioChunk(0, secondary[index]);
            }
            await muxer.finalize();
            const input = sink.toBlob();
            source = await open(input);
            const copiedSink = new MemorySink();
            await convert(input, 'mkv', { sink: copiedSink });
            const sinkOutput = await open(copiedSink.toBlob());
            try {
                assert.equal(sinkOutput.tracks.length, 2);
                for (let index = 0; index < 2; index++)
                    await assertCopied(
                        source,
                        sinkOutput,
                        source.tracks[index],
                        sinkOutput.tracks[index],
                    );
            } finally {
                sinkOutput.close();
            }
            // AVI holds one audio track: the first is kept and the other left out, reported instead
            // of refused.
            const avi = await convert(input, 'avi');
            assert.deepEqual(
                avi.warnings
                    .filter(warning => warning.code === 'TARGET_TRACKS_DROPPED')
                    .map(warning => warning.trackId),
                [source.tracks[1].id],
            );
            const aviOutput = await open(avi.blob);
            try {
                assert.equal(aviOutput.tracks.length, 1);
                await assertCopied(source, aviOutput, source.tracks[0], aviOutput.tracks[0]);
            } finally {
                aviOutput.close();
            }
            // So are tracks the request names, unless strict validation refuses to leave one out.
            const trackIds = source.tracks.map(track => track.id);
            const named = await convert(input, 'avi', { trackIds });
            assert.deepEqual(
                named.warnings
                    .filter(warning => warning.code === 'TARGET_TRACKS_DROPPED')
                    .map(warning => warning.trackId),
                [source.tracks[1].id],
            );
            const namedOutput = await open(named.blob);
            assert.equal(namedOutput.tracks.length, 1);
            namedOutput.close();
            await assert.rejects(
                convert(input, 'avi', { trackIds, open: { validation: 'strict' } }),
                error => error.code === 'FORMAT',
            );
            // Re-encoding the first audio track plans a copy of the second next to it instead of
            // refusing it; the synthetic MP3 payload then stops the run at decoding.
            let plan;
            const reencoded = await convert(input, 'ts', {
                audio: { bitrate: 96_000 },
                onPlan: report => (plan = report),
            }).catch(error => error);
            assert.equal(reencoded.code, 'DECODE');
            assert.deepEqual(
                plan.tracks.map(track => [track.trackId, track.action]),
                [
                    [source.tracks[0].id, 'encode'],
                    [source.tracks[1].id, 'copy'],
                ],
            );
            output = await open(await converted(input, 'mkv'));
            assert.equal(
                output.tracks.length,
                2,
                'Every supported secondary audio track must survive',
            );
            for (let index = 0; index < 2; index++) {
                assert.equal(output.tracks[index].language, index ? 'jpn' : 'eng');
                await assertCopied(source, output, source.tracks[index], output.tracks[index]);
            }
        } finally {
            for (const input of inputs) input.close();
            source?.close();
            output?.close();
        }
    });

    test('a real PCM resample still selects the native AVI PCM encoder', async () => {
        const input = new Blob([waveFixture()]);
        const output = await open(await converted(input, 'avi', { audio: { sampleRate: 16000 } }));
        try {
            const track = output.tracks[0];
            assert(track.codec.startsWith('pcm'));
            assert.equal(track.sampleRate, 16000);
            assert.equal(track.channelCount, 2);
            const data = (await packets(output)).flatMap(packet => [...packet.data]);
            assert.equal(
                data.length,
                8 * 2 * 2,
                'Four stereo frames at 8 kHz become eight at 16 kHz',
            );
            assert(data.some(value => value !== 0));
        } finally {
            output.close();
        }
    });

    async function proResWithAac() {
        const audio = await encodeAacLc(
            [
                Float32Array.from(
                    { length: 2048 },
                    (_, index) => Math.sin((index * Math.PI) / 24) / 8,
                ),
            ],
            { sampleRate: 48000, bitrate: 64 },
        );
        const sink = new MemorySink();
        const muxer = new WebMMuxer(
            {
                format: 'mkv',
                mode: 'standard',
                maxFragmentDuration: 2,
                autoSync: true,
                video: {
                    id: 1,
                    type: 'video',
                    codec: 'apch',
                    width: 32,
                    height: 24,
                    framerate: 25,
                },
                audio: {
                    id: 2,
                    type: 'audio',
                    codec: 'mp4a.40.2',
                    sampleRate: 48000,
                    channelCount: 1,
                    codecConfig: audio.audioSpecificConfig,
                },
            },
            sink,
        );
        muxer.addVideoChunk({
            trackType: 'video',
            data: proresFrames.apch,
            timestamp: 0,
            duration: 0.04,
            isKeyframe: true,
        });
        for (const [index, data] of audio.frames.entries()) {
            muxer.addAudioChunk({
                trackType: 'audio',
                data,
                timestamp: (index * 1024) / 48000,
                duration: 1024 / 48000,
                isKeyframe: true,
            });
        }
        await muxer.finalize();
        return sink.toBlob();
    }

    {
        test('ProRes is copied while AAC is resampled natively into MOV', async () => {
            const input = await proResWithAac();
            const checked = await check(input, 'mov', { audio: { sampleRate: 24000 } });
            assert.equal(checked.supported, true, checked.reason);
            assert.deepEqual(
                checked.plan.tracks.map(track => track.action),
                ['copy', 'encode'],
            );
            const blob = await converted(input, 'mov', { audio: { sampleRate: 24000 } });
            const output = await open(blob);
            try {
                const video = output.tracks.find(track => track.type === 'video');
                const audio = output.tracks.find(track => track.type === 'audio');
                assert.equal(video.codec, 'apch');
                assert.deepEqual((await packets(output, video.id))[0].data, proresFrames.apch);
                assert.equal(audio.codec, 'mp4a.40.2');
                assert.equal(audio.sampleRate, 24000);
                assert((await packets(output, audio.id)).length > 0);
            } finally {
                output.close();
            }
        });
    }

    for (const layer of [1, 2, 3]) {
        test(`MPEG layer ${layer} audio is copied into MP4 and M4A with its layer`, async () => {
            const source = await open(mpegAudioFixture(layer));
            try {
                for (const format of ['mp4', 'm4a', 'mov']) {
                    const blob = await converted(mpegAudioFixture(layer), format, { copy: true });
                    const bytes = new Uint8Array(await blob.arrayBuffer());
                    const esds = Buffer.from(bytes).indexOf('esds');
                    assert(esds > 0, format);
                    const objectType =
                        bytes[Buffer.from(bytes).indexOf(Uint8Array.of(0x04), esds + 8) + 5];
                    assert(objectType === 0x6b, `${format}: MPEG-1 audio object type`);
                    const output = await open(blob);
                    try {
                        await assertCopied(source, output);
                    } finally {
                        output.close();
                    }
                }
            } finally {
                source.close();
            }
        });
    }

    test('resampled MPEG audio is encoded, or refused without an encoder, not copied', async () => {
        // Matroska's Opus has no encoder in Node: the resample is encoded as AAC, reported (it
        // used to fail before the substitution could act); the strict option policy rejects.
        const input = new Blob([mpegAudioFixture(2)]);
        const resampled = await convert(input, 'mkv', { audio: { sampleRate: 24000 } });
        assert.deepEqual(
            resampled.plan.tracks.map(track => [track.action, track.codec]),
            [['encode', 'mp4a.40.2']],
        );
        assert(resampled.warnings.some(warning => warning.code === 'CODEC_SUBSTITUTED'));
        await assert.rejects(
            convert(input, 'mkv', { audio: { sampleRate: 24000 }, optionPolicy: 'strict' }),
            error => error.code === 'ENCODE' && /No audio encoder for/.test(error.message),
        );
    });

    test('an explicit audio codec decodes MPEG with the built-in decoder, not copied', async () => {
        await assert.rejects(
            convert(new Blob([mpegAudioFixture(3)]), 'mkv', { audio: { codec: 'mp4a.40.2' } }),
            error =>
                error.code === 'DECODE' &&
                /MP3/.test(error.message) &&
                !/WebCodecs/.test(error.message),
        );
    });

    const programStreamVideo = () => {
        const units = mpeg2Gop();
        const bytes = programStream(
            units.map(unit => ({
                streamId: 0xe0,
                payload: unit.data,
                pts: unit.pts,
                dts: unit.type === PICTURE_B ? undefined : unit.dts,
                scr: unit.dts - 900,
            })),
        );
        return { units, bytes };
    };

    for (const format of ['mp4', 'mov', 'mkv', 'ts', 'avi']) {
        test(`MPEG-2 video of a program stream copies into ${format} undecoded`, async () => {
            const { units, bytes } = programStreamVideo();
            const output = await open(await converted(bytes, format));
            try {
                assert.equal(output.tracks[0].codec, 'mp4v.61');
                const copied = await packets(output);
                assert.deepEqual(
                    copied.map(packet => packet.data),
                    units.map(unit => unit.data),
                );
                assert.deepEqual(
                    copied.map(packet =>
                        Math.round((packet.timestamp - copied[0].timestamp) * 90000),
                    ),
                    units.map(unit => unit.pts - units[0].pts),
                );
                assert.deepEqual(
                    copied.map(packet => packet.isKeyframe),
                    units.map((_, index) => index === 0),
                );
            } finally {
                output.close();
            }
        });
    }

    test('MPEG video copy is refused for WebM and offered for Matroska', async () => {
        const job = await open(programStreamVideo().bytes);
        try {
            assert.equal((await job.check('webm', { copy: true })).supported, false);
            assert.equal((await job.check('mkv', { copy: true })).supported, true);
        } finally {
            job.close();
        }
    });

    /**
     * QuickTime MPEG-2 sample entry: the MP4 writer's mp4v entry retagged as `fourcc`, its esds
     * replaced by glbl.
     */
    function quickTimeMpeg2(mov, fourcc, config) {
        const bytes = mov.slice();
        const text = new TextDecoder('latin1').decode(bytes);
        const entry = text.indexOf('mp4v', text.indexOf('stsd'));
        const esds = text.indexOf('esds', entry) - 4;
        const view = new DataView(bytes.buffer);
        const size = view.getUint32(esds);
        bytes.set(new TextEncoder().encode(fourcc), entry);
        bytes.fill(0, esds, esds + size);
        let free = esds;
        if (config) {
            view.setUint32(esds, 8 + config.length);
            bytes.set(new TextEncoder().encode('glbl'), esds + 4);
            bytes.set(config, esds + 8);
            free += 8 + config.length;
        }
        view.setUint32(free, esds + size - free);
        bytes.set(new TextEncoder().encode('free'), free + 4);
        return bytes;
    }

    for (const [fourcc, withConfig] of [
        ['m2v1', true],
        ['xdv7', true],
        ['hdv2', false],
    ]) {
        const how = withConfig ? 'with glbl' : 'unstated';
        test(`MOV '${fourcc}' MPEG-2 ${how} copies to MKV`, async () => {
            const { units, bytes } = programStreamVideo();
            const source = await open(bytes);
            const config = source.tracks[0].codecConfig;
            const mov = new Uint8Array(
                await (await source.convert('mov', { copy: true })).blob.arrayBuffer(),
            );
            source.close();
            const warnings = [];
            const file = await open(quickTimeMpeg2(mov, fourcc, withConfig ? config : undefined), {
                onWarning: warning => warnings.push(warning.code),
            });
            try {
                assert.equal(file.tracks[0].codec, 'mp4v.61');
                assert.deepEqual(file.tracks[0].codecConfig, config);
                assert.equal(warnings.includes('VIDEO_CONFIG_DERIVED'), !withConfig);
                const output = await open((await file.convert('mkv', { copy: true })).blob);
                try {
                    assert.equal(output.tracks[0].codec, 'mp4v.61');
                    assert.deepEqual(
                        (await packets(output)).map(packet => packet.data),
                        units.map(unit => unit.data),
                    );
                } finally {
                    output.close();
                }
            } finally {
                file.close();
            }
        });
    }
});
