import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    adtsFixture,
    aviFixture,
    flacFixture,
    flvFixture,
    mpegAudioFixture,
    waveFixture,
    webmVideoFixture,
} from '../helpers/original-fixtures.mjs';
import { FIXTURES, apvFrames, apvStream, iamfSequence } from '../helpers/new-format-fixtures.mjs';
import { programStream } from '../helpers/mpeg-video-fixtures.mjs';
import { AC3_FIXTURES } from '../helpers/ac3-fixtures.mjs';
import { MP3_FIXTURES } from '../helpers/mp3-fixtures.mjs';
import { OPUS_FIXTURES } from '../helpers/opus-fixtures.mjs';
import { VORBIS_FIXTURES } from '../helpers/vorbis-fixtures.mjs';
import { MAIN_FIXTURE } from '../helpers/h264-fixtures.mjs';
import { MPEG1_FIXTURE } from '../helpers/mpeg2-fixtures.mjs';
import { SIMPLE_FIXTURE } from '../helpers/mpeg4-fixtures.mjs';
import { h264Mp4, mpegVideoMp4 } from '../helpers/video-mp4.mjs';
import { toInt16, tone, waveChunks, waveFile, waveSamples } from '../helpers/pcm.mjs';

const committed = path => new Blob([readFileSync(new URL(`../fixtures/${path}`, import.meta.url))]);
const named = (fixtures, name) => new Blob([fixtures.find(entry => entry.name === name).bytes()]);
/** A tenth of a second of a stereo tone at 44.1 kHz as a 16-bit WAVE file. */
const toneWave = () => new Blob([waveFile(toInt16(tone(44100, 2, 4410)), 44100, 2)]);

/** Decodes `input` to WAV and checks that it holds sound in `channels` channels. */
async function decodesToWave(forge, input, channels) {
    const { blob } = await forge.convert(input, 'wav', { copy: false });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const format = waveChunks(bytes).get('fmt ');
    assert.equal(new DataView(bytes.buffer).getUint16(format.at + 2, true), channels);
    assert((await waveSamples(bytes)).some(sample => sample !== 0));
}

/** Whether `bytes` start with an MPEG audio frame of `layer`. */
const mpegAudioLayer = (bytes, layer) =>
    bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && 4 - ((bytes[1] >> 1) & 3) === layer;

/** Encodes the tone to `to` and checks the first bytes of the output. */
async function encodesTone(forge, to, check) {
    const { blob, plan } = await forge.convert(toneWave(), to);
    assert.equal(plan.tracks[0].action, 'encode');
    check(new Uint8Array(await blob.arrayBuffer()));
}

/** Decodes every picture of a video MP4 and checks their count and size. */
async function decodesPictures(forge, mp4, count, width, height) {
    const sizes = [];
    for await (const frame of forge.frames(await mp4)) sizes.push([frame.width, frame.height]);
    assert.deepEqual(
        sizes,
        Array.from({ length: count }, () => [width, height]),
    );
}

/**
 * What each plugin of the catalog adds, as operations test/plugins/independence.test.mjs runs:
 * for every part of the plugin's manifest, named `<role>/<id>` ('decoders/flac', 'readers/avi'),
 * a function that performs the part's work with the MediaForge it is given and checks the result.
 * The test runs each with the lite entry and only that plugin, where it must pass, and with the
 * default entry without that plugin, where it must fail with PLUGIN naming the plugin. Inputs are
 * small and made here or by the helpers; the owner of a plugin adds its operations.
 */
export const PLUGIN_OPERATIONS = {
    flac: {
        'decoders/flac': async forge => {
            const result = await forge.convert(new Blob([flacFixture()]), 'wav');
            assert.equal(result.filename, 'output.wav');
            assert(result.blob.size > 44);
        },
        'encoders/flac': async forge => {
            const result = await forge.convert(new Blob([waveFixture()]), 'flac');
            const head = new Uint8Array(await result.blob.arrayBuffer()).subarray(0, 4);
            assert.equal(new TextDecoder().decode(head), 'fLaC');
        },
    },
    aac: {
        'decoders/aac': forge => decodesToWave(forge, committed('aac/he-aac-sbr.aac'), 2),
        'encoders/aac': forge =>
            encodesTone(forge, 'm4a', bytes =>
                assert.equal(new TextDecoder().decode(bytes.subarray(4, 8)), 'ftyp'),
            ),
    },
    ac3: {
        'decoders/ac3': forge => decodesToWave(forge, named(AC3_FIXTURES, 'stereo-48000-96k'), 2),
    },
    alac: {
        'decoders/alac': forge => decodesToWave(forge, committed('alac/alac16.m4a'), 2),
    },
    h264: {
        'decoders/h264': forge => decodesPictures(forge, h264Mp4(MAIN_FIXTURE), 9, 64, 48),
    },
    mpegAudio: {
        'decoders/mpegAudio': forge =>
            decodesToWave(forge, named(MP3_FIXTURES, 'mpeg25-8000-mono-16k'), 1),
        'encoders/mp2': forge =>
            encodesTone(forge, 'mp2', bytes => assert(mpegAudioLayer(bytes, 2))),
        'encoders/mp3': forge =>
            encodesTone(forge, 'mp3', bytes => assert(mpegAudioLayer(bytes, 3))),
    },
    mpeg12: {
        'decoders/mpeg2video': forge =>
            decodesPictures(forge, mpegVideoMp4(MPEG1_FIXTURE, 'mpeg12'), 6, 70, 46),
    },
    mpeg4: {
        'decoders/mpeg4-part2': forge =>
            decodesPictures(forge, mpegVideoMp4(SIMPLE_FIXTURE, 'mpeg4'), 6, 64, 48),
    },
    opus: {
        'decoders/opus': forge =>
            decodesToWave(forge, named(OPUS_FIXTURES, 'celt-fb-audio-20ms-stereo'), 2),
    },
    vorbis: {
        'decoders/vorbis': forge =>
            decodesToWave(forge, named(VORBIS_FIXTURES, 'stereo-48000-q2'), 2),
    },
    avi: {
        'readers/avi': async forge => {
            const info = await forge.inspect(new Blob([aviFixture()]));
            assert.equal(info.format, 'avi');
            assert.deepEqual(
                info.tracks.map(track => track.codec),
                ['pcm-s16le'],
            );
        },
        'writers/avi': async forge => {
            const result = await forge.convert(new Blob([waveFixture()]), 'avi');
            const head = new Uint8Array(await result.blob.arrayBuffer()).subarray(8, 12);
            assert.equal(new TextDecoder().decode(head), 'AVI ');
        },
    },
    apv: {
        'readers/apv': async forge => {
            const info = await forge.inspect(new Blob([apvStream().raw]));
            assert.equal(info.format, 'apv');
            assert.deepEqual(
                info.tracks.map(track => track.codec),
                ['apv1.apvf33.apvl30.apvb2'],
            );
        },
        'writers/apv': async forge => {
            const result = await forge.convert(new Blob([apvStream().raw]), 'apv', { copy: true });
            const bytes = new Uint8Array(await result.blob.arrayBuffer());
            assert.equal(new TextDecoder().decode(bytes.subarray(4, 8)), 'aPv1');
        },
        'decoders/apv': async forge => {
            const sizes = [];
            for await (const frame of forge.frames(new Blob([apvFrames()]), { onWarning() {} }))
                sizes.push([frame.width, frame.height]);
            assert.deepEqual(sizes, [[16, 16]]);
        },
    },
    asf: {
        'readers/asf': async forge => {
            const info = await forge.inspect(new Blob([FIXTURES['h264mp3.asf'].bytes()]));
            assert.equal(info.format, 'asf');
            assert.deepEqual(
                info.tracks.map(track => track.type),
                ['video', 'audio'],
            );
        },
    },
    flv: {
        'readers/flv': async forge => {
            const info = await forge.inspect(new Blob([flvFixture()]));
            assert.equal(info.format, 'flv');
        },
        'writers/flv': async forge => {
            const input = new Blob([adtsFixture()]);
            const result = await forge.convert(input, 'flv', { copy: true });
            const head = new Uint8Array(await result.blob.arrayBuffer()).subarray(0, 3);
            assert.equal(new TextDecoder().decode(head), 'FLV');
        },
    },
    iamf: {
        'readers/iamf': async forge => {
            const info = await forge.inspect(new Blob([iamfSequence().raw]));
            assert.equal(info.format, 'iamf');
            assert.deepEqual(
                info.tracks.map(track => track.codec),
                ['iamf.000.000.ipcm'],
            );
        },
        'writers/iamf': async forge => {
            const { descriptors, raw } = iamfSequence();
            const result = await forge.convert(new Blob([raw]), 'iamf', { copy: true });
            const bytes = new Uint8Array(await result.blob.arrayBuffer());
            assert.deepEqual(bytes.subarray(0, descriptors.length), new Uint8Array(descriptors));
        },
    },
    ivf: {
        'readers/ivf': async forge => {
            const info = await forge.inspect(new Blob([FIXTURES['av1.ivf'].bytes()]));
            assert.equal(info.format, 'ivf');
        },
        'readers/obu': async forge => {
            const info = await forge.inspect(new Blob([FIXTURES['av1.obu'].bytes()]));
            assert.equal(info.format, 'obu');
        },
        'writers/ivf': async forge => {
            const result = await forge.convert(new Blob([webmVideoFixture()]), 'ivf');
            const head = new Uint8Array(await result.blob.arrayBuffer()).subarray(0, 4);
            assert.equal(new TextDecoder().decode(head), 'DKIF');
        },
    },
    mpegPs: {
        'readers/mpeg-ps': async forge => {
            const stream = programStream([
                { streamId: 0xc0, payload: mpegAudioFixture(2), pts: 0 },
            ]);
            const info = await forge.inspect(new Blob([stream]));
            assert.equal(info.format, 'mpeg');
            assert.deepEqual(
                info.tracks.map(track => track.codec),
                ['mp2'],
            );
        },
    },
    mxf: {
        'readers/mxf': async forge => {
            const info = await forge.inspect(new Blob([FIXTURES['pcm24.mxf'].bytes()]));
            assert.equal(info.format, 'mxf');
            assert.deepEqual(
                info.tracks.map(track => track.codec),
                ['pcm-s24le'],
            );
        },
    },
};
