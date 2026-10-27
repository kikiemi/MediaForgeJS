// The support matrix's cases of the operations and of playback, of api/, pipeline/{plan,transcode,
// codecs,frames}, editing/, recording/, runtime/ and the player package (see ./index.mjs for the
// shape). An operation that takes targets has a case for each class it takes
// (operation/<name>/<class>), which writes one format of the class; what each format needs is in
// the cells of write/, image-out/ and package/. Playback, encodeFrames() and recordStream() need
// the browser's MSE, WebCodecs or a MediaStream.
import assert from 'node:assert/strict';

const api = () => import('mediaforgejs');

/** `format`, which `cell` declares among the formats of its class. */
function formatOf(cell, format) {
    assert(cell.formats.includes(format), `${cell.id} takes ${format}`);
    return format;
}

/** `seconds` of a 440 Hz tone: a 48 kHz stereo 16-bit WAV file. */
async function toneWave(seconds = 0.5) {
    const { tone, toInt16, waveFile } = await import('../../helpers/pcm.mjs');
    const samples = toInt16(tone(48000, 2, Math.round(seconds * 48000)));
    return new Blob([waveFile(samples, 48000, 2)]);
}

/** A grey 32x16 AVI of three uncompressed pictures, which the library decodes. */
async function greyMovie() {
    const { greyAvi } = await import('../../helpers/api-fixtures.mjs');
    return new Blob([greyAvi()]);
}

/** An MP4 of AAC (test/helpers/original-fixtures.mjs), which packages without a re-encode. */
async function aacMovie() {
    const { originalFixtures } = await import('../../helpers/original-fixtures.mjs');
    return new Blob([originalFixtures['classic-aac.mp4']()]);
}

/** The input and the format of each target class's cases, and the plan check() gives it. */
const WRITTEN = {
    container: [toneWave, 'mkv', 'copy'],
    audio: [toneWave, 'flac', 'reencode'],
    image: [greyMovie, 'png', 'image'],
    package: [aacMovie, 'hls', 'package'],
};

/** check(): the plan of a format of the class, without writing. */
async function checks(cell) {
    const [input, format, action] = WRITTEN[cell.targetClass];
    const report = await (await api()).check(await input(), formatOf(cell, format));
    assert.deepEqual([report.supported, report.plan?.action], [true, action]);
}

/** convert(): a file of a format of the class, which reads back as that format. */
async function converts(cell) {
    const { convert, inspect } = await api();
    const [input, format] = WRITTEN[cell.targetClass];
    const output = await convert(await input(), formatOf(cell, format));
    assert.equal((await inspect(output.blob)).format, format);
}

/** edit(): two clips of half a second, one after the other, in a format of the class. */
async function edits(cell) {
    const { edit, open } = await api();
    const [input, format] = WRITTEN[cell.targetClass];
    const clips = [{ input: await input() }, { input: await input() }];
    const output = await edit({ clips }, formatOf(cell, format));
    const media = await open(output.blob);
    try {
        assert.equal(media.format, format);
        assert(Math.abs(media.duration - 1) < 0.01, `${media.duration} s`);
    } finally {
        media.close();
    }
}

const BASE = 'https://media.test/support/';

/** A fetch that answers `files` of a package under BASE, byte ranges too, and logs their names. */
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

/**
 * A second of a tone in the first sound codec this browser's MSE plays in MP4 (AAC, else FLAC),
 * packaged as `to` in half-second segments, served; and a MediaForge with mediaforgejs-player.
 */
async function packagedTone(to) {
    const { MediaForge } = await api();
    const { player } = await import('../../../packages/player/dist/index.js');
    const forge = new MediaForge({ plugins: { add: [player] } });
    const [codec] =
        [
            ['aac', 'mp4a.40.2'],
            ['flac', 'flac'],
        ].find(([, codecs]) => MediaSource.isTypeSupported(`audio/mp4; codecs="${codecs}"`)) ?? [];
    assert(codec, 'Media Source Extensions play AAC or FLAC in MP4');
    const { blob } = await forge.convert(await toneWave(1), { to: 'mp4', audio: { codec } });
    const pack = await forge.packageMedia(blob, { to, targetDuration: 0.5 });
    return { forge, pack, ...served(pack.files) };
}

/** Runs `use` with a muted audio element in the page that plays four times as fast. */
async function withAudioElement(use) {
    const media = document.createElement('audio');
    media.muted = true;
    media.defaultPlaybackRate = 4;
    media.playbackRate = 4;
    document.body.append(media);
    try {
        return await use(media);
    } finally {
        media.remove();
    }
}

/** The time and duration `media` shows when it ends (a playback releases it right after). */
const endOf = media =>
    new Promise(resolve =>
        media.addEventListener(
            'ended',
            () => resolve({ time: media.currentTime, duration: media.duration }),
            { once: true },
        ),
    );

/** A package of `to` plays to its end, and every segment of it was fetched. */
async function playsToEnd(to) {
    const { forge, pack, fetch, requested } = await packagedTone(to);
    await withAudioElement(async media => {
        const ended = endOf(media);
        await forge.play(BASE + pack.entry, media, { fetch }).finished;
        const { time, duration } = await ended;
        assert(Math.abs(duration - 1) < 0.05, `${duration} s`);
        assert(Math.abs(time - duration) < 0.05, `ended at ${time} s`);
    });
    for (const file of pack.files.values())
        if (file.kind === 'segment') assert(requested.includes(file.name), file.name);
}

/** `count` 64x48 VideoFrames of a canvas at 30 per second, each of its own colour. */
function canvasFrames(count) {
    const canvas = new OffscreenCanvas(64, 48);
    const context = canvas.getContext('2d');
    return Array.from({ length: count }, (_, index) => {
        context.fillStyle = `rgb(${index * 20}, 80, 160)`;
        context.fillRect(0, 0, 64, 48);
        return new VideoFrame(canvas, { timestamp: Math.round((index * 1e6) / 30) });
    });
}

/** Asserts that `blob` is a file of `format` holding one 64x48 video track. */
async function holdsPictures(blob, format) {
    const info = await (await api()).inspect(blob);
    assert.equal(info.format, format);
    assert.deepEqual(
        info.tracks.map(track => [track.type, track.width, track.height]),
        [['video', 64, 48]],
    );
}

export const cases = {
    'operation/capabilities': async () => {
        const { capabilities } = await api();
        const report = await capabilities();
        assert(report.containers.read.includes('mp4'));
    },
    'operation/inspect': async () => {
        const info = await (await api()).inspect(await toneWave());
        assert.equal(info.format, 'wav');
        assert.deepEqual(
            info.tracks.map(track => [track.type, track.sampleRate, track.channelCount]),
            [['audio', 48000, 2]],
        );
    },
    'operation/open': async () => {
        const media = await (await api()).open(await toneWave());
        try {
            assert.deepEqual([media.format, media.duration], ['wav', 0.5]);
            let packets = 0;
            for await (const packet of media.packets()) packets += packet.data.length > 0 ? 1 : 0;
            assert(packets > 0, 'the packets are read');
        } finally {
            media.close();
        }
    },
    'operation/frames': async () => {
        const sizes = [];
        for await (const frame of (await api()).frames(await greyMovie()))
            sizes.push([frame.width, frame.height]);
        assert.deepEqual(sizes, [
            [32, 16],
            [32, 16],
            [32, 16],
        ]);
    },
    'operation/thumbnail/image': async cell => {
        const { inspect, thumbnail } = await api();
        const poster = await thumbnail(await greyMovie(), { to: formatOf(cell, 'png') });
        assert.equal((await inspect(poster.blob)).format, 'png');
    },
    'operation/check/container': checks,
    'operation/check/audio': checks,
    'operation/check/image': checks,
    'operation/check/package': checks,
    'operation/convert/container': converts,
    'operation/convert/audio': converts,
    'operation/convert/image': converts,
    'operation/edit/container': edits,
    'operation/edit/audio': edits,
    'operation/packageMedia/package': async cell => {
        const { files, entry } = await (
            await api()
        ).packageMedia(await aacMovie(), formatOf(cell, 'hls'));
        const kinds = new Set([...files.values()].map(file => file.kind));
        assert(
            files.has(entry) && kinds.has('playlist') && kinds.has('segment'),
            [...kinds].join(),
        );
    },
    'operation/encodeFrames/container': {
        browser: true,
        run: async cell => {
            const to = formatOf(cell, 'webm');
            const result = await (await api()).encodeFrames(canvasFrames(10), { to });
            await holdsPictures(result.blob, to);
        },
    },
    'operation/recordStream/container': {
        browser: true,
        run: async cell => {
            const to = formatOf(cell, 'webm');
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 48;
            const context = canvas.getContext('2d');
            const stream = canvas.captureStream(0);
            const [track] = stream.getVideoTracks();
            // Firefox asks the stream for a frame, the others the track.
            const requestFrame =
                typeof track.requestFrame === 'function'
                    ? () => track.requestFrame()
                    : () => stream.requestFrame();
            let encoded = 0;
            const recording = (await api()).recordStream(stream, {
                to,
                onProgress: () => encoded++,
            });
            // A picture at a time, until the recording has encoded a few.
            for (let index = 0; index < 200 && encoded < 3; index++) {
                context.fillStyle = `rgb(${(index * 20) % 256}, 80, 160)`;
                context.fillRect(0, 0, 64, 48);
                requestFrame();
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            const result = await recording.stop();
            track.stop();
            await holdsPictures(result.blob, to);
        },
    },
    'operation/play': {
        browser: true,
        run: async () => {
            const { forge, pack, fetch } = await packagedTone('hls');
            await withAudioElement(async media => {
                const ended = endOf(media);
                await forge.play(BASE + pack.entry, media, { fetch }).finished;
                assert((await ended).time > 0.95, 'played to the end');
                assert.equal(media.getAttribute('src'), null, 'the element is released');
            });
        },
    },
    'operation/createPlayer': {
        browser: true,
        run: async () => {
            const { forge, pack, fetch } = await packagedTone('hls');
            await withAudioElement(async media => {
                const created = forge.createPlayer(media, { fetch });
                const first = created.load(BASE + pack.entry);
                const second = created.load(BASE + pack.entry);
                const ended = endOf(media);
                await assert.rejects(first.finished, error => error.code === 'ABORT');
                await second.finished;
                assert((await ended).time > 0.95, 'the second load played to the end');
            });
        },
    },
    'play/hls': { browser: true, run: () => playsToEnd('hls') },
    'play/dash': { browser: true, run: () => playsToEnd('dash') },
};
