import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { createClearKeyLicense, player } from 'mediaforgejs-player';

// HLS and DASH playback through Media Source Extensions in a real browser (npm run test:browser):
// streams the library packages in the page, served through the `fetch` option, played to their
// end in an audio element.

const inBrowser = typeof document !== 'undefined';
const BASE = 'https://media.test/stream/';
/** The KID and key of the ClearKey fixture (fixtures/README.md). */
const KID = '0123456789abcdef0123456789abcdef';
const KEY = 'fedcba9876543210fedcba9876543210';

/** Unpadded base64url of hexadecimal bytes, as ClearKey licenses name keys. */
const base64url = hex =>
    btoa(String.fromCharCode(...hex.match(/../g).map(byte => parseInt(byte, 16))))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

/** A WAV file of `seconds` of a 440 Hz tone, 48 kHz stereo 16-bit. */
function toneWave(seconds) {
    const frames = 48000 * seconds;
    const bytes = new Uint8Array(44 + frames * 4);
    const view = new DataView(bytes.buffer);
    const text = (at, value) => [...value].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + frames * 4, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 192000, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, frames * 4, true);
    for (let frame = 0; frame < frames; frame++) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / 48000) * 8000);
        view.setInt16(44 + frame * 4, sample, true);
        view.setInt16(46 + frame * 4, sample, true);
    }
    return bytes;
}

/** A fetch that answers the files of a package under BASE (byte ranges too) and logs them. */
function served(files) {
    const requested = [];
    const fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const name = url.pathname.slice(new URL(BASE).pathname.length);
        requested.push(name);
        const file = files.get(name);
        if (!url.href.startsWith(BASE) || !file) return new Response(null, { status: 404 });
        const data = file.data ?? file;
        const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init.headers).get('range') ?? '');
        if (!range) return new Response(data, { status: 200 });
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) + 1 : data.length;
        return new Response(data.slice(start, end), {
            status: 206,
            headers: { 'Content-Range': `bytes ${start}-${end - 1}/${data.length}` },
        });
    };
    return { fetch, requested };
}

/** The chunks of `encoder` for `inputs`, with its decoder configuration's description. */
async function encoded(Encoder, config, inputs, keyEvery) {
    const chunks = [];
    let description;
    let failure;
    const encoder = new Encoder({
        output: (chunk, metadata) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            chunks.push({ chunk, data });
            description ??= metadata?.decoderConfig?.description;
        },
        error: error => (failure = error),
    });
    encoder.configure(config);
    inputs.forEach((input, index) => {
        if (keyEvery) encoder.encode(input, { keyFrame: index % keyEvery === 0 });
        else encoder.encode(input);
        input.close();
    });
    await encoder.flush();
    encoder.close();
    if (failure) throw failure;
    return {
        chunks,
        description:
            description &&
            new Uint8Array(ArrayBuffer.isView(description) ? description.buffer : description),
    };
}

/** A mono OpusHead of 312 frames of pre-skip at 48 kHz. */
function opusHead() {
    const head = new Uint8Array(19);
    head.set([...'OpusHead'].map(c => c.charCodeAt(0)));
    head.set([1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0], 8);
    return head;
}

/**
 * Two seconds of VP9 pictures and Opus sound the browser encodes, with two Japanese cues, in
 * Matroska; undefined after skipping `t` where the browser cannot encode or play them.
 */
async function demuxedSource(t) {
    const pictures = {
        codec: 'vp09.00.10.08',
        width: 64,
        height: 48,
        bitrate: 200_000,
        framerate: 10,
    };
    const sound = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32_000 };
    const playable = ['video/mp4; codecs="vp09.00.10.08"', 'audio/mp4; codecs="opus"'].every(type =>
        MediaSource.isTypeSupported(type),
    );
    const encodes =
        typeof VideoEncoder === 'function' &&
        typeof AudioEncoder === 'function' &&
        (await VideoEncoder.isConfigSupported(pictures)).supported &&
        (await AudioEncoder.isConfigSupported(sound)).supported;
    if (!playable || !encodes) {
        t.skip('the browser does not encode, or MSE does not play, VP9 and Opus in MP4');
        return undefined;
    }
    const canvas = new OffscreenCanvas(64, 48);
    const context = canvas.getContext('2d');
    const frames = Array.from({ length: 20 }, (_, index) => {
        context.fillStyle = `rgb(${index * 12}, 80, 160)`;
        context.fillRect(0, 0, 64, 48);
        return new VideoFrame(canvas, { timestamp: index * 100_000, duration: 100_000 });
    });
    const video = await encoded(VideoEncoder, pictures, frames, 5);
    const samples = Float32Array.from({ length: 96_000 }, (_, i) => 0.2 * Math.sin(i / 20));
    const blocks = Array.from(
        { length: 100 },
        (_, index) =>
            new AudioData({
                format: 'f32-planar',
                sampleRate: 48000,
                numberOfFrames: 960,
                numberOfChannels: 1,
                timestamp: index * 20_000,
                data: samples.subarray(index * 960, (index + 1) * 960),
            }),
    );
    const audio = await encoded(AudioEncoder, sound, blocks);
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'mkv',
            mode: 'standard',
            autoSync: false,
            video: {
                id: 1,
                type: 'video',
                codec: 'vp09.00.10.08',
                width: 64,
                height: 48,
                framerate: 10,
            },
            audio: {
                id: 2,
                type: 'audio',
                codec: 'opus',
                sampleRate: 48000,
                channelCount: 1,
                codecConfig: audio.description ?? opusHead(),
            },
            subtitleTracks: [{ id: 3, type: 'subtitle', codec: 'text/utf8', language: 'jpn' }],
        },
        sink,
    );
    const chunk = ({ chunk: encodedChunk, data }, trackType) => ({
        trackType,
        data,
        timestamp: encodedChunk.timestamp / 1e6,
        duration: (encodedChunk.duration ?? 0) / 1e6,
        isKeyframe: encodedChunk.type === 'key',
    });
    // The tracks' chunks in time order.
    const ordered = [
        ...video.chunks.map(entry => chunk(entry, 'video')),
        ...audio.chunks.map(entry => chunk(entry, 'audio')),
    ].sort((a, b) => a.timestamp - b.timestamp);
    for (const entry of ordered)
        if (entry.trackType === 'video') muxer.addVideoChunk(entry);
        else muxer.addAudioChunk(entry);
    for (const [start, end, text] of [
        [0.2, 0.6, 'はじめ'],
        [1.2, 1.8, 'おわり'],
    ])
        muxer.addSubtitleChunk({
            trackType: 'subtitle',
            data: new TextEncoder().encode(text),
            timestamp: start,
            duration: end - start,
            isKeyframe: true,
        });
    await muxer.finalize();
    return sink.toBlob('video/x-matroska');
}

/** A muted audio element in the page, playing four times as fast; remove() it after. */
function audioElement() {
    const media = document.createElement('audio');
    media.muted = true;
    media.defaultPlaybackRate = 4;
    media.playbackRate = 4;
    document.body.append(media);
    return media;
}

/**
 * The time and duration `media` shows when it ends: a playback releases the element right after,
 * which resets both.
 */
const endOf = media =>
    new Promise(resolve =>
        media.addEventListener(
            'ended',
            () => resolve({ time: media.currentTime, duration: media.duration }),
            { once: true },
        ),
    );

const skipped = !inBrowser && 'runs in a browser (npm run test:browser)';

describe('player in a browser', { skip: skipped }, () => {
    const forge = new MediaForge({ plugins: { add: [player] } });
    /** The codec and MP4 MIME type of the sound, the first that this browser's MSE plays. */
    let chosen;
    const sound = t => {
        chosen ??= [
            ['aac', 'audio/mp4; codecs="mp4a.40.2"'],
            ['flac', 'audio/mp4; codecs="flac"'],
        ].find(
            ([, type]) => typeof MediaSource === 'function' && MediaSource.isTypeSupported(type),
        );
        if (!chosen) t.skip('Media Source Extensions play neither AAC nor FLAC in MP4 here');
        return chosen?.[0];
    };
    /** Two seconds of a tone in `codec`, packaged as `to` in half-second segments. */
    const packaged = async (codec, to, extra = {}) => {
        const { blob } = await forge.convert(toneWave(2), { to: 'mp4', audio: { codec } });
        return forge.packageMedia(blob, { to, targetDuration: 0.5, ...extra });
    };

    for (const to of ['hls', 'dash'])
        test(
            `play() plays a ${to.toUpperCase()} package to its end`,
            { timeout: 60_000 },
            async t => {
                const codec = sound(t);
                if (!codec) return;
                const pack = await packaged(codec, to);
                const { fetch, requested } = served(pack.files);
                const media = audioElement();
                try {
                    const ended = endOf(media);
                    await forge.play(BASE + pack.entry, media, { fetch }).finished;
                    const { time, duration } = await ended;
                    assert.ok(Math.abs(duration - 2) < 0.05, `${duration} s`);
                    assert.ok(Math.abs(time - duration) < 0.05, `ended at ${time} s`);
                    for (const file of pack.files.values())
                        if (file.kind === 'segment')
                            assert.ok(requested.includes(file.name), file.name);
                } finally {
                    media.remove();
                }
            },
        );

    test('a player stops a stream when it loads the next one', { timeout: 60_000 }, async t => {
        const codec = sound(t);
        if (!codec) return;
        const pack = await packaged(codec, 'hls');
        const { fetch } = served(pack.files);
        const media = audioElement();
        try {
            const created = forge.createPlayer(media, { fetch });
            const first = created.load(BASE + pack.entry);
            const second = created.load(BASE + pack.entry);
            const ended = endOf(media);
            await assert.rejects(first.finished, error => error.code === 'ABORT');
            await second.finished;
            assert.ok((await ended).time > 1.9);
        } finally {
            media.remove();
        }
    });

    test(
        'stop() ends a playback with ABORT and releases the element',
        { timeout: 60_000 },
        async t => {
            const codec = sound(t);
            if (!codec) return;
            const pack = await packaged(codec, 'hls');
            const { fetch } = served(pack.files);
            const media = audioElement();
            try {
                const playback = forge.play(BASE + pack.entry, media, { fetch });
                const playing = new Promise(resolve =>
                    media.addEventListener('playing', resolve, { once: true }),
                );
                await Promise.race([playing, playback.finished]);
                playback.stop();
                await assert.rejects(playback.finished, error => error.code === 'ABORT');
                assert.equal(media.getAttribute('src'), null, 'the MediaSource is detached');
            } finally {
                media.remove();
            }
        },
    );

    test(
        'an HLS package of AES-128 segments is decrypted and played',
        { timeout: 60_000 },
        async t => {
            const codec = sound(t);
            if (!codec) return;
            const key = crypto.getRandomValues(new Uint8Array(16));
            const pack = await packaged(codec, 'hls', {
                encryption: { method: 'AES-128', key, keyUri: 'key.bin', keyFile: 'key.bin' },
            });
            const { fetch, requested } = served(pack.files);
            const media = audioElement();
            try {
                const ended = endOf(media);
                await forge.play(BASE + pack.entry, media, { fetch }).finished;
                assert.ok((await ended).time > 1.9);
                assert.ok(requested.includes('key.bin'), 'the key was fetched');
            } finally {
                media.remove();
            }
        },
    );

    test(
        'a ClearKey stream is decrypted by the browser through EME',
        { timeout: 60_000 },
        async t => {
            // A committed CENC fMP4 of a second of Opus and its HLS playlist (fixtures/README.md).
            const type = 'audio/mp4; codecs="opus"';
            const configurations = [
                {
                    initDataTypes: ['cenc'],
                    audioCapabilities: [{ contentType: type, encryptionScheme: 'cenc' }],
                },
            ];
            const access = await navigator
                .requestMediaKeySystemAccess?.('org.w3.clearkey', configurations)
                .catch(error => error);
            if (!access || access instanceof Error)
                return t.skip(`the browser refuses ClearKey: ${access?.message ?? 'no EME'}`);
            if (!MediaSource.isTypeSupported(type)) return t.skip(`MSE does not play ${type}`);
            const license = createClearKeyLicense({ [base64url(KID)]: base64url(KEY) });
            let licenses = 0;
            const keySystem = {
                keySystem: 'org.w3.clearkey',
                configurations,
                license: request => (licenses++, license(request)),
            };
            const media = audioElement();
            try {
                const url = new URL('/packages/player/test/fixtures/clearkey.m3u8', location.href);
                const ended = endOf(media);
                await forge.play(url.href, media, {
                    mimeType: type,
                    drm: { keySystems: [keySystem] },
                }).finished;
                assert.ok((await ended).time > 0.9);
                assert.ok(licenses >= 1, 'the license callback answered');
            } finally {
                media.remove();
            }
        },
    );

    test(
        'a package with its sound and subtitles in renditions plays both to the end',
        { timeout: 90_000 },
        async t => {
            const source = await demuxedSource(t);
            if (!source) return;
            // hls+dash: the HLS playlists of demuxed segments, the sound in an AUDIO rendition.
            const pack = await forge.packageMedia(source, { to: 'hls+dash', targetDuration: 0.5 });
            const { fetch, requested } = served(pack.files);
            const added = [];
            const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
            MediaSource.prototype.addSourceBuffer = function (type) {
                const buffer = addSourceBuffer.call(this, type);
                added.push({ type, buffer });
                return buffer;
            };
            const media = document.createElement('video');
            media.muted = true;
            media.defaultPlaybackRate = 4;
            media.playbackRate = 4;
            document.body.append(media);
            try {
                // At the end, before the playback releases them: what the buffers and tracks hold.
                const ended = new Promise(resolve =>
                    media.addEventListener(
                        'ended',
                        () => {
                            const sound = added.find(entry => entry.type.startsWith('audio/'));
                            const ranges = sound?.buffer.buffered;
                            resolve({
                                duration: media.duration,
                                sound: ranges?.length
                                    ? [ranges.start(0), ranges.end(ranges.length - 1)]
                                    : undefined,
                                cues: [...media.textTracks].map(track => [
                                    track.language,
                                    track.mode,
                                    track.cues?.length ?? 0,
                                ]),
                            });
                        },
                        { once: true },
                    ),
                );
                await forge.play(BASE + pack.entry, media, {
                    fetch,
                    subtitles: { language: 'jpn' },
                }).finished;
                const { duration, sound, cues } = await ended;
                assert.deepEqual(
                    added.map(entry => entry.type.split(';')[0]),
                    ['video/mp4', 'audio/mp4'],
                );
                assert.ok(sound, 'the sound was buffered');
                assert.ok(sound[0] < 0.05 && sound[1] > duration - 0.05, `sound ${sound}`);
                assert.deepEqual(cues, [['jpn', 'showing', 2]]);
                assert.ok(requested.some(name => name.startsWith('subtitles-')));
            } finally {
                MediaSource.prototype.addSourceBuffer = addSourceBuffer;
                media.remove();
            }
        },
    );
});
