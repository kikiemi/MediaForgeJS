// The support matrix's inputs of the containers, of formats/ and pipeline/{read,copy,package}
// (see ./index.mjs for the shape): the original fixtures, the small files real muxers wrote
// (test/helpers/new-format-fixtures.mjs), streams built from bytes, and the MP4 family written by
// the library's own MP4 writer.

/** An original fixture by name (test/helpers/original-fixtures.mjs), loaded when asked for. */
const original = name => async () =>
    (await import('../../helpers/original-fixtures.mjs')).originalFixtures[name]();

/** A file a real muxer wrote (test/helpers/new-format-fixtures.mjs), by name. */
const recorded = name => async () =>
    (await import('../../helpers/new-format-fixtures.mjs')).FIXTURES[name].bytes();

/** `make()`'s file copied by the library into `format`. */
const copiedInto = (make, format) => async () => {
    const { convert } = await import('mediaforgejs');
    return (await convert(new Blob([await make()]), format)).blob;
};

/** Eight frames of a raw audio stream, built by `frame(index)`. */
const frames = frame => async () => {
    const { concat } = await import('../../helpers/original-fixtures.mjs');
    return concat(...(await Promise.all(Array.from({ length: 8 }, (_, index) => frame(index)))));
};

/** A DVD program stream: MPEG-2 video with B-pictures, and AC-3 in private stream 1. */
async function dvdProgramStream() {
    const { join } = await import('../../helpers/avi-h264-fixtures.mjs');
    const { ac3Frame, mpeg2Gop, packHeader, privateSubstream, programStream, systemHeader } =
        await import('../../helpers/mpeg-video-fixtures.mjs');
    return join(
        packHeader(80000),
        systemHeader(),
        programStream([
            ...mpeg2Gop().map(unit => ({
                streamId: 0xe0,
                payload: unit.data,
                pts: unit.pts,
                dts: unit.dts,
                scr: unit.dts - 900,
            })),
            {
                streamId: 0xbd,
                payload: privateSubstream(0x80, join(ac3Frame(1), ac3Frame(2))),
                pts: 90000,
            },
        ]),
    );
}

/** A program stream of H.264 and DTS in private stream 1. */
async function h264ProgramStream() {
    const { annexB, aud, idr, join, pps, predicted, sps } =
        await import('../../helpers/avi-h264-fixtures.mjs');
    const { privateSubstream, programStream } =
        await import('../../helpers/mpeg-video-fixtures.mjs');
    const { dtsCore } = await import('../../helpers/sync-audio-fixtures.mjs');
    return programStream([
        { streamId: 0xe0, payload: annexB(aud, sps, pps, idr), pts: 90000 },
        { streamId: 0xe0, payload: annexB(aud, predicted), pts: 93600 },
        {
            streamId: 0xbd,
            payload: privateSubstream(0x88, join(dtsCore({ fill: 1 }), dtsCore({ fill: 2 }))),
            pts: 90000,
        },
    ]);
}

const classicAac = original('classic-aac.mp4');

export const containers = {
    wav: original('stereo-pcm.wav'),
    aiff: original('mono-pcm.aiff'),
    au: original('mono-pcm.au'),
    caf: original('float-stereo.caf'),
    aac: original('four-frames.aac'),
    mp1: original('four-frames.mp1'),
    mp2: original('four-frames.mp2'),
    mp3: original('four-frames.mp3'),
    flac: original('constant-steps.flac'),
    ac3: frames(async index =>
        (await import('../../helpers/mpeg-video-fixtures.mjs')).ac3Frame(index),
    ),
    eac3: frames(async index =>
        (await import('../../helpers/sync-audio-fixtures.mjs')).eac3Frame(256, index),
    ),
    dts: frames(async index =>
        (await import('../../helpers/sync-audio-fixtures.mjs')).dtsCore({ fill: index }),
    ),
    // Each access unit with a major sync is followed by one without.
    truehd: frames(async index =>
        (await import('../../helpers/sync-audio-fixtures.mjs')).truehdUnit(
            index % 2 ? { bytes: 32 } : { sampleRateCode: 0 },
        ),
    ),
    ogg: original('three-packets.opus'),
    opus: { make: original('three-packets.opus'), format: 'ogg' },
    oga: { make: recorded('twoopus.ogg'), format: 'ogg' },
    ogv: { make: recorded('theora.ogv'), format: 'ogg' },
    mkv: original('audio-and-captions.mkv'),
    webm: original('keyframe-and-deltas.webm'),
    ts: original('aac-transport.ts'),
    flv: original('aac-tags.flv'),
    mp4: classicAac,
    mov: copiedInto(classicAac, 'mov'),
    m4a: copiedInto(classicAac, 'm4a'),
    '3gp': copiedInto(classicAac, '3gp'),
    m4v: copiedInto(recorded('hevc.mp4'), 'm4v'),
    avi: original('nested-record-pcm.avi'),
    mpeg: original('mpeg2-bframes.mpg'),
    ps: { make: h264ProgramStream, format: 'mpeg' },
    vob: { make: dvdProgramStream, format: 'mpeg' },
    mxf: recorded('h264.mxf'),
    asf: recorded('h264mp3.asf'),
    wmv: { make: recorded('wmv2.wmv'), format: 'asf' },
    wma: { make: recorded('wma2.wma'), format: 'asf' },
    ivf: recorded('av1.ivf'),
    obu: recorded('av1.obu'),
    av1: { make: recorded('av1.obu'), format: 'obu' },
    apv: async () => (await import('../../helpers/new-format-fixtures.mjs')).apvStream().raw,
    iamf: async () => (await import('../../helpers/new-format-fixtures.mjs')).iamfSequence().raw,
};

export const streams = {
    'pcm-s16le': original('stereo-pcm.wav'),
};
