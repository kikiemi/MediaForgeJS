// The small recorded fixtures of new-format-fixtures.mjs (files a real muxer wrote, with the tracks
// and packets each holds) read through the public API: reading one as recorded, and comparing the
// packets of a copy with those of its source.
import assert from 'node:assert/strict';
import { detectFormat } from 'mediaforgejs/formats';
import { FIXTURES, md5, nalBodies, nalDigest } from './new-format-fixtures.mjs';
import { readMedia } from './read-media.mjs';

export { FIXTURES };

const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 2e-3, `${message}: ${actual} vs ${expected}`);

const FORMAT_OF = { wmv: 'asf', wma: 'asf', asf: 'asf', ogv: 'ogg', ogg: 'ogg' };

/** The format detection reports for a fixture's file name. */
export function formatOf(file) {
    const extension = file.slice(file.lastIndexOf('.') + 1);
    return FORMAT_OF[extension] ?? extension;
}

/** The codec strings each recorded codec name reads as. */
const CODEC_OF = {
    wmv2: /^wmv2$/,
    wmav2: /^wmav2$/,
    h264: /^avc1/,
    hevc: /^(hvc1|hev1)/,
    aac: /^mp4a\.40\.2$/,
    mp3: /^mp3$/,
    mpeg2video: /^mp4v\.61$/,
    pcm_s16le: /^pcm-s16le$/,
    pcm_s24le: /^pcm-s24le$/,
    av1: /^av01\.0\.00M\.08$/,
    theora: /^theora$/,
    vorbis: /^vorbis$/,
    opus: /^opus$/,
    speex: /^speex$/,
};

const nalCodec = codec =>
    /^avc1/.test(codec) ? 'h264' : /^(hvc1|hev1)/.test(codec) ? 'hevc' : undefined;

/** NAL unit types of the parameter sets (and HEVC prefix SEI) writers may repeat in band. */
const PARAMETER_SETS = { h264: [6, 7, 8], hevc: [32, 33, 34, 39] };

/**
 * A digest of a packet's payload; for H.264 and HEVC of its slices only, as writers that carry the
 * decoder configuration in band repeat the parameter sets before keyframes.
 */
export function payloadDigest(data, codec) {
    const family = nalCodec(codec);
    if (!family) return md5(data);
    const type = unit => (family === 'h264' ? unit[0] & 31 : (unit[0] >> 1) & 63);
    const slices = nalBodies(data, family).filter(
        unit => !PARAMETER_SETS[family].includes(type(unit)),
    );
    return md5(Buffer.concat(slices));
}

/** Warnings a fixture reads with. */
const EXPECTED_WARNINGS = { 'h264.mxf': ['VIDEO_CONFIG_DERIVED'] };

/** Where the recorded packet times are not those the container states. */
const TIMING_ADJUSTMENTS = {
    // The recording starts Speex at -40 samples (the encoder lookahead, from the final granule);
    // the stream starts at zero and those 40 samples are its trailing padding.
    'speex.ogg': packet => ({ ...packet, pts: packet.pts + 0.005, dts: packet.dts + 0.005 }),
    // The second Theora page's granule states frame 2 (th_granule_frame) for this packet; the
    // recording extrapolates it from the frame before.
    'theora.ogv': (packet, stream, index) =>
        stream === 0 && index === 1 ? { ...packet, pts: 0.2, dts: 0.2 } : packet,
};

/**
 * Asserts that the fixture `file` is detected as its format and reads as recorded: its tracks
 * with their codecs and sizes or rates, and every packet's times, keyframe flag and payload.
 */
export async function assertReadsAsRecorded(file) {
    const fixture = FIXTURES[file];
    const bytes = fixture.bytes();
    assert.equal(detectFormat(bytes.subarray(0, 8192)), formatOf(file), 'detected format');
    const { format, tracks, warnings } = await readMedia(bytes);
    assert.equal(format, formatOf(file), 'format');
    assert.deepEqual(warnings, EXPECTED_WARNINGS[file] ?? [], 'warnings');
    assert.equal(tracks.length, fixture.streams.length, 'track count');
    const used = new Set();
    fixture.streams.forEach((stream, streamIndex) => {
        const index = tracks.findIndex(
            (entry, at) => !used.has(at) && entry.track.type === stream.type,
        );
        assert.ok(index >= 0, `a ${stream.type} track for stream ${streamIndex}`);
        used.add(index);
        const { track, packets } = tracks[index];
        assert.match(track.codec, CODEC_OF[stream.codec], `stream ${streamIndex} codec`);
        if (stream.type === 'video') {
            assert.equal(track.width, stream.width, 'width');
            assert.equal(track.height, stream.height, 'height');
        } else {
            assert.equal(track.sampleRate, stream.sampleRate, 'sample rate');
            assert.equal(track.channelCount, stream.channels, 'channels');
        }
        const expected = fixture.packets[streamIndex];
        assert.equal(packets.length, expected.length, `stream ${streamIndex} packet count`);
        const adjust = TIMING_ADJUSTMENTS[file] ?? (packet => packet);
        packets.forEach((packet, at) => {
            const reference = adjust(expected[at], streamIndex, at);
            const label = `stream ${streamIndex} packet ${at}`;
            if (reference.pts !== null) near(packet.timestamp, reference.pts, `${label} pts`);
            if (reference.dts !== null)
                near(packet.decodeTimestamp ?? packet.timestamp, reference.dts, `${label} dts`);
            assert.equal(packet.isKeyframe, reference.key, `${label} keyframe`);
            if (reference.nal)
                assert.equal(
                    nalDigest(packet.data, nalCodec(track.codec)),
                    reference.nal,
                    `${label} NAL units`,
                );
            else {
                assert.equal(packet.data.length, reference.size, `${label} size`);
                assert.equal(md5(packet.data), reference.md5, `${label} payload`);
            }
        });
    });
}

const firstTime = read => Math.min(...read.tracks.map(track => track.packets[0].timestamp));
const decodeTime = packet => packet.decodeTimestamp ?? packet.timestamp;

/**
 * Asserts that `copy` (a readMedia() result) holds the packets of `source`: the same tracks, and
 * per track the same keyframes, payloads and times, the whole presentation possibly moved to the
 * writer's origin. With `decodeOrder` (AVI, which keeps decode order only) decode times are
 * compared, with an origin per track.
 */
export function assertSamePackets(source, copy, { decodeOrder = false } = {}) {
    const shift = firstTime(source) - firstTime(copy);
    assert.equal(copy.tracks.length, source.tracks.length, 'track count');
    source.tracks.forEach((entry, index) => {
        const copied = copy.tracks[index];
        assert.equal(copied.track.type, entry.track.type, `track ${index} type`);
        assert.equal(copied.packets.length, entry.packets.length, `track ${index} packet count`);
        const time = decodeOrder ? decodeTime : packet => packet.timestamp;
        const base = decodeOrder ? time(entry.packets[0]) - time(copied.packets[0]) : shift;
        entry.packets.forEach((packet, at) => {
            const other = copied.packets[at];
            const tag = `track ${index} packet ${at}`;
            near(time(other) + base, time(packet), `${tag} time`);
            assert.equal(other.isKeyframe, packet.isKeyframe, `${tag} keyframe`);
            assert.equal(
                payloadDigest(other.data, copied.track.codec),
                payloadDigest(packet.data, entry.track.codec),
                `${tag} payload`,
            );
        });
    });
}
