import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { ERROR_CODES, open } from 'mediaforgejs';
import { allPlugins } from 'mediaforgejs/plugins';
import { distUrl } from '../helpers/dist-paths.mjs';
import { originalFixtures } from '../helpers/original-fixtures.mjs';
import { FIXTURES, apvStream, iamfSequence } from '../helpers/new-format-fixtures.mjs';
import { ac3Frame } from '../helpers/mpeg-video-fixtures.mjs';
import { dtsCore } from '../helpers/sync-audio-fixtures.mjs';

// Every reader given damaged inputs: a fixed set of seeded damages (flipped, zeroed and saturated
// bytes, cuts, dropped, repeated and swapped ranges, damaged size fields) to small valid inputs of
// each format, read with compatible and strict validation. Every outcome is a result or a library
// error, the same input reads the same, packets are well formed, and an input strict validation
// accepts reads the same with compatible validation.

const { CORE_FORMATS } = await import(distUrl('esm/formats/core-formats.js'));
/** Damages of each input: as many as the library's readers cover in a few seconds. */
const ROUNDS = 12;
const join = (...parts) => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
const original = name => originalFixtures[name]();
const extra = name => FIXTURES[name].bytes();

/** Valid inputs of each reader, keyed by its first format, with the format each is read as. */
const SEEDS = {
    avi: () => [
        ['avi', original('nested-record-pcm.avi')],
        ['avi', extra('hevc.avi')],
    ],
    flv: () => [
        ['flv', original('aac-tags.flv')],
        ['flv', extra('hevc.flv')],
    ],
    asf: () => [
        ['wma', extra('wma2.wma')],
        ['wmv', extra('wmv2.wmv')],
        ['asf', extra('h264mp3.asf')],
    ],
    mxf: () => [
        ['mxf', extra('mpeg2.mxf')],
        ['mxf', extra('pcm24.mxf')],
    ],
    mpeg: () => [['mpeg', original('mpeg2-bframes.mpg')]],
    ivf: () => [['ivf', extra('av1.ivf')]],
    iamf: () => [['iamf', iamfSequence().raw]],
    apv: () => [['apv', apvStream().raw]],
    obu: () => [['obu', extra('av1.obu')]],
    mp4: () => [
        ['mp4', original('classic-aac.mp4')],
        ['mp4', original('variable-chunks.mp4')],
        ['mp4', extra('hevc.mp4')],
    ],
    mkv: () => [
        ['mkv', original('audio-and-captions.mkv')],
        ['webm', original('keyframe-and-deltas.webm')],
    ],
    ts: () => [
        ['ts', original('aac-transport.ts')],
        ['ts', extra('hevc.ts')],
    ],
    aac: () => [
        ['aac', original('four-frames.aac')],
        ['mp2', original('four-frames.mp2')],
    ],
    mp3: () => [['mp3', original('four-frames.mp3')]],
    ac3: () => [
        ['ac3', join(ac3Frame(1), ac3Frame(2), ac3Frame(3), ac3Frame(4))],
        ['dts', join(dtsCore(), dtsCore())],
    ],
    wav: () => [
        ['wav', original('stereo-pcm.wav')],
        ['aiff', original('mono-pcm.aiff')],
        ['au', original('mono-pcm.au')],
        ['caf', original('float-stereo.caf')],
    ],
    flac: () => [['flac', original('constant-steps.flac')]],
    ogg: () => [
        ['opus', original('three-packets.opus')],
        ['ogg', extra('speex.ogg')],
        ['ogv', extra('theora.ogv')],
    ],
};

/** Deterministic numbers in [0, 1) from a seed. */
function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Damage number `seed` of `bytes`, half of them in the first 256 bytes, where headers are. */
function damage(bytes, seed) {
    const next = random(seed);
    const at = (limit = bytes.length) =>
        Math.floor(next() * (next() < 0.5 ? Math.min(256, limit) : limit));
    const span = () => 1 + Math.floor(next() * Math.min(64, bytes.length / 4));
    const out = Uint8Array.from(bytes);
    const kind = Math.floor(next() * 8);
    const start = at();
    const length = Math.min(span(), bytes.length - start);
    switch (kind) {
        case 0:
            for (let count = 1 + Math.floor(next() * 4); count > 0; count--)
                out[at()] ^= 1 + Math.floor(next() * 255);
            return out;
        case 1:
            return out.fill(0, start, start + length);
        case 2:
            return out.fill(0xff, start, start + length);
        case 3:
            return out.subarray(0, Math.max(1, at()));
        case 4:
            return join(bytes.subarray(0, start), bytes.subarray(start + length));
        case 5:
            return join(bytes.subarray(0, start + length), bytes.subarray(start));
        case 6: {
            const other = Math.min(at(), bytes.length - length);
            const [first, second] = start < other ? [start, other] : [other, start];
            if (first + length > second) return out.fill(0x55, start, start + length);
            out.set(bytes.subarray(second, second + length), first);
            out.set(bytes.subarray(first, first + length), second);
            return out;
        }
        default: {
            const where = Math.min(at(), bytes.length - 4);
            new DataView(out.buffer).setUint32(Math.max(0, where), next() * 0xffffffff);
            return out;
        }
    }
}

const digest = data => createHash('sha256').update(data).digest('hex').slice(0, 16);

/** What reading `bytes` gives: packets and warnings, or the error, as one comparable line. */
async function outcome(bytes, format, validation) {
    const warnings = [];
    let media;
    try {
        media = await open(bytes, {
            format,
            validation,
            maxSamples: 4096,
            maxPacketBytes: 1 << 20,
            maxIndexBytes: 1 << 22,
            onWarning: warning => warnings.push(warning.code),
        });
        const ids = new Set(media.tracks.map(track => track.id));
        const lines = [];
        for await (const packet of media.packets()) {
            assert.ok(ids.has(packet.trackId), 'a packet names a track of the input');
            assert.ok(Number.isFinite(packet.timestamp) && Number.isFinite(packet.duration));
            assert.ok(packet.duration >= 0 && packet.data.length <= 1 << 20);
            lines.push(
                `${packet.trackId} ${packet.timestamp} ${packet.duration} ${digest(packet.data)}`,
            );
        }
        return { ok: true, line: `${media.tracks.length} ${lines.join('|')}`, warnings };
    } catch (error) {
        assert.notEqual(
            error?.name,
            'AssertionError',
            `${format} ${validation}: ${error?.message}`,
        );
        assert.ok(
            ERROR_CODES.includes(error?.code),
            `${format} ${validation}: not a library error: ${error?.stack ?? error}`,
        );
        return { ok: false, line: `${error.code} ${error.message}`, warnings };
    } finally {
        media?.close();
    }
}

describe('formats: every reader given damaged inputs', () => {
    const readers = [
        ...allPlugins.flatMap(plugin => plugin.readers ?? []),
        ...CORE_FORMATS.readers,
    ];

    test('every reader has inputs here', () => {
        for (const reader of readers)
            assert.ok(SEEDS[reader.formats[0]], `inputs for ${reader.formats.join('/')}`);
    });

    for (const [name, seeds] of Object.entries(SEEDS))
        test(`the ${name} reader gives a result or a library error, alike each time`, async () => {
            const reader = readers.find(part => part.formats[0] === name);
            assert.ok(reader, `a reader of ${name}`);
            for (const [seedIndex, [format, seed]] of seeds().entries()) {
                assert.ok(reader.formats.includes(format), `${format} is read by ${name}`);
                const clean = await outcome(seed, format, 'strict');
                assert.ok(clean.ok, `${name} input ${seedIndex} reads cleanly: ${clean.line}`);
                for (let round = 0; round < ROUNDS; round++) {
                    const damaged = damage(seed, (seedIndex + 1) * 7919 + round * 104729);
                    const label = `${name} input ${seedIndex} damage ${round}`;
                    const strict = await outcome(damaged, format, 'strict');
                    const compatible = await outcome(damaged, format, 'compatible');
                    const again = await outcome(damaged, format, 'compatible');
                    assert.equal(again.line, compatible.line, `${label}: reads the same again`);
                    if (strict.ok)
                        assert.equal(compatible.line, strict.line, `${label}: strict agrees`);
                }
            }
        });
});
