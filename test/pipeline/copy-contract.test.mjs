import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { open } from 'mediaforgejs';
import { originalFixtures } from '../helpers/original-fixtures.mjs';
import { webmClip } from '../helpers/webm-clip-fixture.mjs';

// The contract between the readers and the copies: the packets of every input have finite times
// whose decode order never runs backwards and video that starts at a keyframe, and a copy into each
// container that takes the input reads back as the same tracks, with the same payload bytes,
// keyframes and relative times.

const TARGETS = [
    'mp4',
    'mov',
    'm4a',
    'fmp4',
    'mkv',
    'webm',
    'ts',
    'flv',
    'avi',
    'ogg',
    'wav',
    'aac',
    'mp3',
    'flac',
];
/**
 * Containers that store a timestamp for every packet. The others (elementary streams, Ogg granules,
 * AVI audio, PES audio) time audio by its frame sizes, so a source table with other durations reads
 * back on the codec's clock.
 */
const STAMPED = new Set(['mp4', 'mov', 'm4a', 'fmp4', 'mkv', 'webm', 'flv']);
/** Seconds a container's clock may move a timestamp: Matroska and FLV count milliseconds. */
const CLOCK = 0.0015;
const INPUTS = { ...originalFixtures, 'vp9-opus.webm': () => webmClip() };

/** The tracks of `input` and the packets of each, in decode order. */
async function readTracks(input) {
    const media = await open(input);
    try {
        const tracks = [];
        for (const track of media.tracks) {
            const packets = [];
            for await (const packet of media.packets({ trackIds: [track.id] }))
                packets.push(packet);
            tracks.push({ track, packets });
        }
        return tracks;
    } finally {
        media.close();
    }
}

/** Asserts finite times, a decode order that never runs back and video from a keyframe. */
function assertTiming(name, { track, packets }) {
    assert.ok(packets.length > 0, `${name} track ${track.id}: no packets`);
    let decode = -Infinity;
    for (const [index, packet] of packets.entries()) {
        const at = `${name} track ${track.id} packet ${index}`;
        assert.ok(Number.isFinite(packet.timestamp), `${at}: timestamp ${packet.timestamp}`);
        assert.ok(
            Number.isFinite(packet.duration) && packet.duration >= 0,
            `${at}: duration ${packet.duration}`,
        );
        const dts = packet.decodeTimestamp ?? packet.timestamp;
        assert.ok(dts >= decode - 1e-9, `${at}: decode time ${dts} runs back from ${decode}`);
        decode = dts;
    }
    if (track.type === 'video')
        assert.equal(packets[0].isKeyframe, true, `${name} track ${track.id}: no leading keyframe`);
}

const concat = packets => Buffer.concat(packets.map(packet => packet.data));
/** The text of a 3GPP timed text sample: the bytes after its 16-bit length. */
const timedText = data =>
    new TextDecoder().decode(data.subarray(2, 2 + ((data[0] << 8) | data[1])));

/** Asserts that `output`, a copy of the track `input` into `format`, keeps its packets. */
function assertCopied(label, format, input, output) {
    assertTiming(label, output);
    // MP4 writes text subtitles as 3GPP timed text: the cue text after its length, an empty sample
    // between cues.
    if (output.track.codec === 'tx3g' && input.track.codec.startsWith('text/')) {
        const cues = output.packets.filter(packet => timedText(packet.data));
        assert.deepEqual(
            cues.map(packet => [timedText(packet.data), packet.timestamp, packet.duration]),
            input.packets.map(packet => [
                new TextDecoder().decode(packet.data),
                packet.timestamp,
                packet.duration,
            ]),
            `${label}: timed text`,
        );
        return;
    }
    // PCM may be packetized again and change byte order; every other codec keeps its packets one
    // for one.
    if (/^pcm|^[su]\d|^f(32|64)|ulaw|alaw/.test(input.track.codec)) {
        assert.equal(
            concat(output.packets).length,
            concat(input.packets).length,
            `${label}: PCM bytes`,
        );
        return;
    }
    assert.deepEqual(concat(output.packets), concat(input.packets), `${label}: payload bytes`);
    assert.equal(output.packets.length, input.packets.length, `${label}: packet count`);
    for (const [at, packet] of output.packets.entries())
        if (input.packets[at].isKeyframe)
            assert.equal(packet.isKeyframe, true, `${label}: keyframe ${at} lost`);
    if (!STAMPED.has(format) && !(format === 'ts' && output.track.type === 'video')) return;
    // Presentation times hold; audio with composition offsets may keep its decode times instead
    // (FLV stores no audio composition), so either clock of the source matches.
    const clocks = [
        packet => packet.timestamp,
        packet => packet.decodeTimestamp ?? packet.timestamp,
    ];
    for (const [at, packet] of output.packets.entries()) {
        const offsets = clocks.map(
            clock =>
                packet.timestamp -
                output.packets[0].timestamp -
                (clock(input.packets[at]) - clock(input.packets[0])),
        );
        const matched = output.track.type === 'video' ? [offsets[0]] : offsets;
        assert.ok(
            matched.some(offset => Math.abs(offset) <= CLOCK),
            `${label} track ${output.track.id} packet ${at}: off by ${offsets[0]} s`,
        );
    }
}

describe('copy: the packets of every input in every container', () => {
    const sources = new Map();
    /** The tracks of input `name`, read once. */
    const sourceOf = name => {
        if (!sources.has(name)) sources.set(name, readTracks(INPUTS[name]()));
        return sources.get(name);
    };

    for (const name of Object.keys(INPUTS))
        test(`${name} reads with finite, ordered times and video from a keyframe`, async () => {
            for (const track of await sourceOf(name)) assertTiming(name, track);
        });

    for (const format of TARGETS)
        test(`a copy into ${format} keeps the tracks, bytes and times it takes`, async () => {
            let copies = 0;
            for (const [name, make] of Object.entries(INPUTS)) {
                const media = await open(make());
                let copy;
                try {
                    if (!(await media.check(format, { copy: true })).supported) continue;
                    copy = await media.convert(format, { copy: true });
                } finally {
                    media.close();
                }
                const label = `${name} -> ${format}`;
                const [all, written] = await Promise.all([sourceOf(name), readTracks(copy.blob)]);
                // The tracks the plan copies: a container leaves out those it cannot hold.
                assert.ok(
                    copy.plan.tracks.every(plan => plan.action === 'copy'),
                    label,
                );
                const kept = copy.plan.tracks.map(plan => plan.trackId);
                const source = all.filter(({ track }) => kept.includes(track.id));
                assert.deepEqual(
                    written.map(({ track }) => track.type),
                    source.map(({ track }) => track.type),
                    `${label}: track types`,
                );
                for (const [index, output] of written.entries())
                    assertCopied(label, format, source[index], output);
                copies++;
            }
            assert.ok(copies > 0, `nothing copies into ${format}`);
        });
});
