// The support matrix's inputs of the codecs and images, of core/, codecs/ and stages/ (see
// ./index.mjs for the shape). A stream here is copied into every container that declares its codec
// and, for audio, decoded by the library: it is a real stream of the codec, made by the library's
// encoders, by ffmpeg (test/helpers/support-streams.mjs, test/helpers/differential-fixtures.mjs,
// test/helpers/new-format-fixtures.mjs, test/fixtures) or by hand where the bitstream is simple
// (Layer I silence, IAMF of LPCM, APV DC blocks, ProRes RAW). A `structural` stream is built by its
// specification where no encoder exists (test/helpers/spec-streams.mjs): its configuration and
// framing are what readers and writers parse, its payload does not decode, so its copy cells check
// carriage, not decoding. A picture is one the library's encoders or, in a browser, the host's
// canvas wrote, so its decoded pixels are known (`picture`, `tolerance`).

/** A stream of test/helpers/support-streams.mjs. */
const support = name => async () =>
    (await import('../../helpers/support-streams.mjs')).supportStream(name);

/** A fixture of test/helpers/differential-fixtures.mjs. */
const differential = name => async () =>
    (await import('../../helpers/differential-fixtures.mjs')).differentialFixtures[name]();

/** A fixture of test/helpers/new-format-fixtures.mjs. */
const newFormat = name => async () =>
    (await import('../../helpers/new-format-fixtures.mjs')).FIXTURES[name].bytes();

/** The stream of test/helpers/spec-streams.mjs built by the specification of `codec`. */
const structural = (codec, aliases = []) => ({
    make: async () => (await import('../../helpers/spec-streams.mjs')).structuralStreams[codec](),
    structural: true,
    aliases,
});

/** ProRes RAW in MOV, of test/helpers/spec-streams.mjs. */
const proResRaw = codec => async () =>
    (await import('../../helpers/spec-streams.mjs')).proResRawMovie(codec);

/** A file of test/fixtures. */
const committed = path => async () => {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(new URL(`../../fixtures/${path}`, import.meta.url)));
};

/** A tone of `seconds` at `rate` in `channels` planes. */
const tone = (rate, channels, seconds) =>
    Array.from({ length: channels }, (_, channel) =>
        Float32Array.from(
            { length: Math.round(rate * seconds) },
            (_, index) => 0.4 * Math.sin((2 * Math.PI * (440 + channel * 110) * index) / rate),
        ),
    );

/** A file of the library's encoder `name` of /codecs: a tone of a fifth of a second. */
const encoded = name => async () => {
    const codecs = await import('mediaforgejs/codecs');
    const planes = tone(48000, 2, 0.2);
    if (name === 'aac')
        return codecs.wrapAdts(await codecs.encodeAacLc(planes, { sampleRate: 48000 }));
    const encode = { mp3: codecs.encodeMp3, mp2: codecs.encodeMp2, flac: codecs.encodeFlac }[name];
    return encode(planes, { sampleRate: 48000 });
};

/**
 * MPEG-1 Layer I at 32 kbit/s, 48 kHz mono: ten frames of 384 samples whose bit allocations are
 * all zero, which decode as silence (ISO/IEC 11172-3 § 2.4.1.5); each frame is 32 bytes, the
 * header and zeros.
 */
const layerOne = () => {
    const frame = new Uint8Array(32);
    frame.set([0xff, 0xff, 0x14, 0xc0]);
    const stream = new Uint8Array(frame.length * 10);
    for (let index = 0; index < 10; index++) stream.set(frame, index * frame.length);
    return stream;
};

const AVC = ['avc1', 'avc3'];
const HEVC = ['hvc1', 'hev1'];
const VVC = ['vvc1', 'vvi1'];

export const streams = {
    // Audio.
    mp4a: encoded('aac'),
    mp3: encoded('mp3'),
    mp2: encoded('mp2'),
    mp1: layerOne,
    flac: encoded('flac'),
    alac: committed('alac/alac16.m4a'),
    opus: differential('ogg-opus.opus'),
    vorbis: differential('ogg-vorbis-pages.ogg'),
    'ac-3': support('ac3.ac3'),
    'ec-3': support('eac3.eac3'),
    dtsc: support('dts.dts'),
    mlpa: support('truehd.thd'),
    wmav1: support('wmav1.wma'),
    wmav2: differential('wma-jpn.wma'),
    ulaw: committed('pcm/g711-ulaw.wav'),
    alaw: committed('pcm/g711-alaw.mkv'),
    ima4: committed('pcm/ima4.aif'),
    pcm: { make: committed('pcm/g711-source.wav'), aliases: ['pcm-s16le'] },
    ...Object.fromEntries(
        [
            's16be',
            's24be',
            's24le',
            's32be',
            's32le',
            'f32be',
            'f32le',
            'f64be',
            'f64le',
            's8',
            'u8',
        ].map(coding => [`pcm-${coding}`, support(`pcm-${coding}.mov`)]),
    ),
    iamf: async () => (await import('../../helpers/new-format-fixtures.mjs')).iamfSequence().raw,
    dtsh: structural('dtsh'),
    dtsl: structural('dtsl'),
    dtse: structural('dtse'),
    mha1: structural('mha1'),
    mhm1: structural('mhm1'),
    evrc: structural('evrc'),
    qcelp: structural('qcelp'),
    wmapro: structural('wmapro'),
    wmalossless: structural('wmalossless'),
    wmavoice: structural('wmavoice'),
    // Video.
    // A container that does not tell avc1 from avc3, or hvc1 from hev1, writes either.
    avc1: { make: differential('mp4-bframes.mp4'), aliases: AVC },
    avc3: { make: support('avc3.mp4'), aliases: AVC },
    hvc1: { make: newFormat('hevc.mp4'), aliases: HEVC },
    hev1: { make: support('hev1.mp4'), aliases: HEVC },
    // Matroska does not tell dvhe from dvh1, nor vvi1 from vvc1; MPEG-TS carries VVC as vvi1.
    dvh1: structural('dvh1'),
    dvhe: structural('dvhe', ['dvh1']),
    vvc1: structural('vvc1', VVC),
    vvi1: structural('vvi1', VVC),
    av01: newFormat('av1.mp4'),
    vp8: support('vp8.webm'),
    vp09: { make: differential('webm-vp9-opus.webm'), aliases: ['vp9'] },
    vp9: { make: differential('webm-vp9-opus.webm'), aliases: ['vp09'] },
    mpeg1v: { make: differential('ps-mpeg1.mpg'), aliases: ['mp4v'] },
    mpeg2v: { make: support('mpeg2.ts'), aliases: ['mp4v'] },
    mpeg4v: { make: support('mpeg4.mp4'), aliases: ['mp4v'] },
    mjpeg: differential('mkv-mjpeg.mkv'),
    theora: newFormat('theora.ogv'),
    dvvideo: support('dv.avi'),
    wmv1: support('wmv1.avi'),
    wmv2: newFormat('wmv2.wmv'),
    wmv3: structural('wmv3'),
    vc1: structural('vc1'),
    apv1: async () => (await import('../../helpers/new-format-fixtures.mjs')).apvFrames(),
    ...Object.fromEntries(
        ['apco', 'apcs', 'apcn', 'apch', 'ap4h', 'ap4x'].map(profile => [
            profile,
            support(`prores-${profile}.mov`),
        ]),
    ),
    aprn: proResRaw('aprn'),
    aprh: proResRaw('aprh'),
};

export const decoderInputs = {
    uncompressed: support('raw.avi'),
    h264: differential('mp4-bframes.mp4'),
    mpeg2video: support('mpeg2.ts'),
    'mpeg4-part2': support('mpeg4.mp4'),
    apv: async () => (await import('../../helpers/new-format-fixtures.mjs')).apvFrames(),
};

/** A 16x12 picture: a ramp in red and green, blue in blocks, opaque. */
const picture = () => {
    const data = new Uint8ClampedArray(16 * 12 * 4);
    for (let y = 0; y < 12; y++)
        for (let x = 0; x < 16; x++)
            data.set([x * 16, y * 20, ((x >> 2) + (y >> 2)) % 2 ? 200 : 40, 255], (y * 16 + x) * 4);
    return { data, width: 16, height: 12 };
};

/** The picture by the library's still encoder `name` of /codecs. */
const still = name => async () => (await import('mediaforgejs/codecs'))[name](picture());

/** The picture as an animation of two frames, by the library's encoder `name`. */
const animation = name => async () => {
    const encoder = new (await import('mediaforgejs/codecs'))[name](16, 12);
    const first = picture();
    const second = {
        ...first,
        data: first.data.map((value, index) => (index % 4 === 3 ? 255 : 255 - value)),
    };
    await encoder.addFrame(first, 100);
    await encoder.addFrame(second, 100);
    return encoder.encode();
};

/** An input whose decoded picture is picture(), each channel within `tolerance`. */
const known = (make, tolerance = 0) => ({ make, picture, tolerance });

/**
 * The gradient of test/helpers/support-streams.mjs in `format`, a picture only the host decodes:
 * its pixels are known, each channel within 16 of the colours ffmpeg encoded.
 */
const gradient = format => {
    const streams = () => import('../../helpers/support-streams.mjs');
    return {
        make: async () => (await streams()).supportStream((await streams()).GRADIENTS[format]),
        picture: async () => (await streams()).gradientPicture(),
        tolerance: 16,
    };
};

// The pictures each image-in/ cell decodes and image-out/ (TIFF) writes from: the library's
// encoders' and ffmpeg's (HEIF: an HEVC picture of libx265 that test/helpers/make-heif.mjs wraps).
// GIF holds 256 colours of the picture's 384.
export const images = {
    png: known(still('encodePng')),
    bmp: known(still('encodeBmp')),
    tiff: known(still('encodeTiff')),
    ico: known(still('encodeIco')),
    gif: known(animation('AnimatedGifEncoder'), 24),
    apng: known(animation('ApngEncoder')),
    webp: newFormat('still-lossless.webp'),
    jpeg: gradient('jpeg'),
    avif: gradient('avif'),
    jxl: gradient('jxl'),
    heif: gradient('heif'),
};

// The host's codecs, in a browser: what the host says it decodes or encodes (isConfigSupported of
// the library's probe, or capabilities() where the library asks itself) against what the lite
// entry, which has no codecs of its own for these, does with a real stream: it hands the stream to
// the host exactly where the host says it can, and the output is the stream's.

/** Real streams of the codecs the host decodes, from files that load in the browser page. */
const HOST_STREAMS = {
    aac: encoded('aac'),
    mp3: encoded('mp3'),
    opus: support('opus.ogg'),
    flac: encoded('flac'),
    vorbis: support('vorbis.ogg'),
    'ac-3': support('ac3.ac3'),
    'ec-3': support('eac3.eac3'),
    ulaw: support('ulaw.wav'),
    alaw: support('alaw.wav'),
    avc1: support('avc1.mp4'),
    hvc1: support('hvc1.mp4'),
    vp8: support('vp8.webm'),
    vp09: support('vp9.webm'),
    av01: support('av1.mp4'),
};

/** The name capabilities() gives each video codec. */
const VIDEO_NAMES = { avc1: 'h264', hvc1: 'hevc', vp8: 'vp8', vp09: 'vp9', av01: 'av1' };

/**
 * What `run` returns or throws, and how many times a host codec of `kind` was configured (for a
 * codec of `families` when given).
 */
async function hostRun(kind, run, families) {
    const prototype = globalThis[kind]?.prototype;
    const configure = prototype?.configure;
    let configured = 0;
    if (prototype)
        prototype.configure = function (config) {
            if (!families || families.includes(config.codec.split('.')[0])) configured++;
            return configure.call(this, config);
        };
    try {
        const value = await run();
        return { value, configured };
    } catch (error) {
        return { error, configured };
    } finally {
        if (prototype) prototype.configure = configure;
    }
}

/** The loudest 16-bit sample of a WAV file the library wrote. */
async function waveLevel(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let at = 12;
    while (String.fromCharCode(...bytes.subarray(at, at + 4)) !== 'data')
        at += 8 + view.getUint32(at + 4, true);
    let level = 0;
    for (let byte = at + 8; byte + 1 < bytes.length; byte += 2)
        level = Math.max(level, Math.abs(view.getInt16(byte, true)));
    return level;
}

/** The lite entry, the first track of `input` as inspect() describes it, and inspect(). */
async function liteAndTrack(input) {
    const { MediaForge, inspect } = await import('mediaforgejs');
    return [new MediaForge({ plugins: [] }), (await inspect(input)).tracks[0], inspect];
}

/** The number of packets of the first track of `input`. */
async function packetCount(input) {
    const { open } = await import('mediaforgejs');
    const media = await open(input);
    try {
        let count = 0;
        for await (const packet of media.packets({ trackIds: [media.tracks[0].id] }))
            count += packet ? 1 : 0;
        return count;
    } finally {
        media.close();
    }
}

/**
 * Whether a host encode case that the host does not declare went as the library documents: the
 * request failed, or another codec was written in its place with CODEC_SUBSTITUTED.
 */
async function refusedOrSubstituted(value, error, families) {
    if (error) return true;
    const { inspect } = await import('mediaforgejs');
    const [track] = (await inspect(value.blob)).tracks;
    return (
        !families.includes(track.codec.split('.')[0]) &&
        value.warnings.some(warning => warning.code === 'CODEC_SUBSTITUTED')
    );
}

/** How a host case went, for its failure messages. */
const outcome = (declared, configured, error) =>
    `declared ${declared}, host configured ${configured} times${error ? `: ${error.message}` : ''}`;

/**
 * Host decoding of audio codec `name`: the lite entry decodes the stream to WAV through the host
 * exactly where the host takes the library's probe, else with the core's G.711 decoder, else not.
 */
const hostAudioDecode = name => ({
    browser: true,
    run: async () => {
        const { default: assert } = await import('node:assert/strict');
        const { HOST_AUDIO_DECODE_PROBES } = await import('/dist/esm/api/capabilities.js');
        const [, probe] = HOST_AUDIO_DECODE_PROBES.find(([codec]) => codec === name);
        const claims =
            typeof AudioDecoder === 'function' &&
            (await AudioDecoder.isConfigSupported(probe)).supported === true;
        const builtin = name === 'ulaw' || name === 'alaw';
        const input = new Blob([await HOST_STREAMS[name]()]);
        const [lite, source, inspect] = await liteAndTrack(input);
        const declared = (await lite.capabilities()).audio.decode.includes(name);
        assert.equal(declared, claims || builtin, 'capabilities() declares what is decoded');
        // Re-encoded, as WAV would hold G.711 as it is.
        const { value, error, configured } = await hostRun('AudioDecoder', () =>
            lite.convert(input, 'wav', { copy: false }),
        );
        const how = `the host takes the probe: ${claims}; ${outcome(declared, configured, error)}`;
        assert.equal(configured > 0, claims, how);
        if (!declared) return assert(error, how);
        assert(!error, error?.message);
        const [track] = (await inspect(value.blob)).tracks;
        assert(Math.abs(track.duration - source.duration) < 0.05, `${track.duration} s`);
        assert((await waveLevel(value.blob)) > 1000, 'the tone is heard');
    },
});

/**
 * Host decoding of video codec `codec`: frames() of the lite entry gives every picture of the
 * stream through the host exactly where capabilities() declares the host decoder, else fails.
 */
const hostVideoDecode = codec => ({
    browser: true,
    run: async () => {
        const { default: assert } = await import('node:assert/strict');
        const input = new Blob([await HOST_STREAMS[codec]()]);
        const [lite, source] = await liteAndTrack(input);
        const declared = (await lite.capabilities()).video.decode.includes(VIDEO_NAMES[codec]);
        const { value, error, configured } = await hostRun('VideoDecoder', async () => {
            const sizes = [];
            for await (const frame of lite.frames(input)) sizes.push([frame.width, frame.height]);
            return sizes;
        });
        const how = outcome(declared, configured, error);
        assert.equal(configured > 0, declared, how);
        if (!declared) return assert(error, how);
        assert(!error, how);
        assert.equal(value.length, await packetCount(input));
        assert.deepEqual(value[0], [source.width, source.height]);
    },
});

/** A WAV file of 16-bit stereo PCM at 48 kHz: a fifth of a second of a tone. */
const wave = () => {
    const planes = tone(48000, 2, 0.2);
    const frames = planes[0].length;
    const bytes = new Uint8Array(44 + frames * 4);
    const view = new DataView(bytes.buffer);
    const text = (at, value) =>
        bytes.set(
            [...value].map(char => char.charCodeAt(0)),
            at,
        );
    text(0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 48000 * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, frames * 4, true);
    for (let frame = 0; frame < frames; frame++)
        for (const channel of [0, 1])
            view.setInt16(44 + frame * 4 + channel * 2, planes[channel][frame] * 32767, true);
    return new Blob([bytes]);
};

/**
 * Host encoding of audio codec `codec`: the lite entry writes WebM of it from a WAV file with the
 * host encoder exactly where capabilities() declares one, else refuses or writes another codec in
 * its place with CODEC_SUBSTITUTED.
 */
const hostAudioEncode = codec => ({
    browser: true,
    run: async () => {
        const { default: assert } = await import('node:assert/strict');
        const [lite, , inspect] = await liteAndTrack(wave());
        const declared = (await lite.capabilities()).audio.encode.includes(codec);
        const { value, error, configured } = await hostRun(
            'AudioEncoder',
            () => lite.convert(wave(), 'webm', { audio: { codec } }),
            [codec],
        );
        const how = outcome(declared, configured, error);
        assert.equal(configured > 0, declared, how);
        if (!declared) return assert(await refusedOrSubstituted(value, error, [codec]), how);
        assert(!error, how);
        assert.equal(value.plan.tracks[0].encoder, 'webcodecs');
        const [track] = (await inspect(value.blob)).tracks;
        assert.equal(track.codec, codec);
        assert(Math.abs(track.duration - 0.2) < 0.05, `${track.duration} s`);
    },
});

/** `count` frames of a 64x48 canvas, ten a second, each a lighter grey. */
const canvasFrames = count => {
    const canvas = new OffscreenCanvas(64, 48);
    const context = canvas.getContext('2d');
    return Array.from({ length: count }, (_, index) => {
        context.fillStyle = `rgb(${index * 20}, ${index * 20}, ${index * 20})`;
        context.fillRect(0, 0, 64, 48);
        return new VideoFrame(canvas, { timestamp: index * 100000 });
    });
};

/**
 * Host encoding of video codec `codec`: encodeFrames() of the lite entry writes ten pictures of
 * it with the host encoder exactly where capabilities() declares one, else refuses or writes
 * another codec in its place with CODEC_SUBSTITUTED.
 */
const hostVideoEncode = codec => ({
    browser: true,
    run: async () => {
        const { default: assert } = await import('node:assert/strict');
        const { MediaForge, inspect } = await import('mediaforgejs');
        const lite = new MediaForge({ plugins: [] });
        const name = VIDEO_NAMES[codec];
        const to = codec === 'avc1' || codec === 'hvc1' ? 'mp4' : 'webm';
        // Asked at the size encoded: a hardware encoder may take no picture this small (NVIDIA's
        // HEVC encoder starts at 144 pixels).
        const asked = { to, width: 64, height: 48 };
        const declared = (await lite.capabilities(asked)).video.encode.includes(name);
        const families = codec === 'avc1' ? AVC : codec === 'hvc1' ? HEVC : [codec, 'vp9'];
        const { value, error, configured } = await hostRun(
            'VideoEncoder',
            () => lite.encodeFrames(canvasFrames(10), { to, video: { codec: name } }),
            families,
        );
        const how = outcome(declared, configured, error);
        assert.equal(configured > 0, declared, how);
        if (!declared) return assert(await refusedOrSubstituted(value, error, families), how);
        assert(!error, how);
        assert.equal(value.plan.tracks[0].encoder, 'webcodecs');
        const [track] = (await inspect(value.blob)).tracks;
        assert(families.includes(track.codec.split('.')[0]), track.codec);
        assert.deepEqual([track.width, track.height], [64, 48]);
        assert.equal(await packetCount(value.blob), 10);
    },
});

export const cases = {
    ...Object.fromEntries(
        ['aac', 'mp3', 'opus', 'flac', 'vorbis', 'ac-3', 'ec-3', 'ulaw', 'alaw'].map(name => [
            `host-decode/${name}`,
            hostAudioDecode(name),
        ]),
    ),
    ...Object.fromEntries(
        Object.keys(VIDEO_NAMES).map(codec => [`host-decode/${codec}`, hostVideoDecode(codec)]),
    ),
    ...Object.fromEntries(
        ['opus', 'vorbis'].map(codec => [`host-encode/${codec}`, hostAudioEncode(codec)]),
    ),
    ...Object.fromEntries(
        Object.keys(VIDEO_NAMES).map(codec => [`host-encode/${codec}`, hostVideoEncode(codec)]),
    ),
    // A still picture written as APNG is a plain PNG: an animation stays an animation.
    'image-out/apng': async () => {
        const { default: assert } = await import('node:assert/strict');
        const { convert, inspect } = await import('mediaforgejs');
        const gif = await animation('AnimatedGifEncoder')();
        const output = await convert(new Blob([gif]), 'apng');
        assert.equal((await inspect(output.blob)).format, 'apng');
    },
};
