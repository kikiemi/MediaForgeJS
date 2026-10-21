import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { check, convert, open } from 'mediaforgejs';
import { BufferSource, MemorySink } from 'mediaforgejs/io';
import { Mp4Demuxer, WebMDemuxer, WebMMuxer } from 'mediaforgejs/formats';
import { differentialFixtures as fixtures } from '../helpers/differential-fixtures.mjs';
import { packetOf } from '../helpers/media-packets.mjs';
import { avcc, idr, lengthPrefixed } from '../helpers/avi-h264-fixtures.mjs';
import { reorderFixture } from '../helpers/avi-h264-reorder-fixtures.mjs';
import { mpegAudioFixture } from '../helpers/original-fixtures.mjs';
import {
    PICTURE_B,
    PICTURE_I,
    PICTURE_P,
    mpeg2Gop,
    mpeg4Config,
    mpeg4Vop,
    mpegSequence,
} from '../helpers/mpeg-video-fixtures.mjs';
import {
    audioShape,
    blockGroup,
    cluster,
    element,
    float,
    info,
    join,
    matroskaFile,
    opusHead,
    simpleBlock,
    simpleTag,
    string,
    trackEntry,
    tracks,
    uint,
    videoShape,
} from '../helpers/matroska.mjs';
import { bytesOf, decodedWave, readAll, rejectsStrict, sha256 } from '../helpers/read-media.mjs';
import { readerPart } from '../helpers/parts.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';
import { dtsCore, truehdUnit } from '../helpers/sync-audio-fixtures.mjs';

/** The last place `pattern` (bytes) starts in `bytes`. */
function findLast(bytes, pattern) {
    for (let index = bytes.length - pattern.length; index >= 0; index--)
        if (pattern.every((value, at) => bytes[index + at] === value)) return index;
    return -1;
}
const milliseconds = seconds => Math.round(seconds * 1000) + 0;
const hex = bytes => Buffer.from(bytes).toString('hex');

/**
 * A file of one 32x16 video track of `codecId` (CodecPrivate `config`) at 25 frames a second, and
 * one cluster holding `packet`, or `clusters`.
 */
const videoFile = (codecId, config, packet = Uint8Array.of(1, 2, 3), clusters) =>
    matroskaFile([
        tracks(
            trackEntry(
                1,
                1,
                codecId,
                uint(0x73c5, 1),
                ...(config === undefined ? [] : [element(0x63a2, config)]),
                uint(0x23e383, 40000000),
                videoShape(32, 16),
            ),
        ),
        ...(clusters ?? [cluster(0, simpleBlock(1, 0, packet))]),
    ]);

/** A BITMAPINFOHEADER of a 32x16 picture of `fourcc` followed by `extradata`. */
function bitmapInfo(fourcc, extradata) {
    const header = new Uint8Array(40);
    const view = new DataView(header.buffer);
    view.setUint32(0, 40 + extradata.length, true);
    view.setInt32(4, 32, true);
    view.setInt32(8, 16, true);
    view.setUint16(12, 1, true);
    view.setUint16(14, 24, true);
    header.set(new TextEncoder().encode(fourcc), 16);
    return join(header, extradata);
}

/** A VfW H.264 file of `pictures` of reorderFixture(), one a 40 ms slot after `firstSlot`. */
function vfwH264(pictures, { fixture = reorderFixture(), firstSlot = 0, lead = [] } = {}) {
    const frames = pictures.map((picture, index) =>
        index === 0
            ? fixture.packet(fixture.sps, fixture.pps, fixture.slice(picture))
            : fixture.packet(fixture.slice(picture)),
    );
    return videoFile('V_MS/VFW/FOURCC', bitmapInfo('H264', new Uint8Array(0)), undefined, [
        cluster(
            0,
            ...lead,
            ...frames.map((data, index) =>
                simpleBlock(1, 40 * (index + firstSlot), data, index === 0 ? 0x80 : 0),
            ),
        ),
    ]);
}

/** One A_PCM/INT/LIT mono track at 8 kHz whose ContentEncoding is `encoding`, and a block. */
const encodedPcm = (encoding, frames) =>
    matroskaFile([
        tracks(
            trackEntry(
                1,
                2,
                'A_PCM/INT/LIT',
                element(0x6d80, element(0x6240, encoding)),
                audioShape(1, 8000, uint(0x6264, 16)),
            ),
        ),
        cluster(0, simpleBlock(1, 0, frames)),
    ]);

const HEVC_MAIN_10 = Uint8Array.of(
    ...[1, 2, 0x20, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 120, 0xf0, 0, 0xfc, 0xfd, 0xfa, 0xfa, 0, 0],
    ...[15, 0],
);
const HEVC_SPACE = Uint8Array.of(
    ...[1, 0xa5, 1, 0, 0, 1, 0x90, 0, 0x21, 0, 0, 0, 153, 0xf0, 0, 0xfc, 0xfd, 0xfa, 0xfa, 0, 0],
    ...[15, 0],
);
const HEVC_NO_CONSTRAINTS = HEVC_MAIN_10.slice().fill(0, 6, 12);

/** A cluster of MPEG video `units` ({ data, time }), the first a keyframe. */
const mpegCluster = units =>
    cluster(
        0,
        ...units.map((unit, index) => simpleBlock(1, unit.time, unit.data, index === 0 ? 0x80 : 0)),
    );
const MPEG4_UNITS = [
    { data: mpeg4Vop(PICTURE_I), time: 0 },
    { data: mpeg4Vop(PICTURE_P), time: 120 },
    { data: mpeg4Vop(PICTURE_B), time: 40 },
    { data: mpeg4Vop(PICTURE_B), time: 80 },
];

/** An Opus track entry of `number` named `name`. */
const opusEntry = (number, ...children) =>
    trackEntry(
        number,
        2,
        'A_OPUS',
        uint(0x73c5, BigInt(number) + (1n << 60n)),
        audioShape(1, 48000),
        element(0x63a2, opusHead(1)),
        ...children,
    );
/** An Opus packet of one 20 ms CELT frame. */
const OPUS_FRAME = Uint8Array.of(0x80, 0);
/** A VP9 keyframe header of a 2x2 picture. */
const VP9_FRAME = Uint8Array.of(0x82, 0x49, 0x83, 0x42);

/** An MPEG-1 Layer III frame of 417 bytes (44.1 kHz, 128 kbit/s) marked with `index`. */
function mp3Frame(index) {
    const bytes = new Uint8Array(417);
    bytes.set([0xff, 0xfb, 0x90, 0x64], 0);
    bytes[4] = index;
    return bytes;
}

/**
 * A file of one A_MPEG/L`layer` track of mpegAudioFixture(layer), in Japanese and named, its
 * blocks timed in ms; with `keep`, the last frame keeps that many samples as FFmpeg writes it (the
 * kept samples in BlockDuration, the rest in DiscardPadding).
 */
function mpegAudioFile(layer, { keep } = {}) {
    const raw = mpegAudioFixture(layer);
    const frameSize = raw.length / 4;
    const duration = (layer === 1 ? 384 : 1152) / 44100;
    const blocks = Array.from({ length: 4 }, (_, i) => {
        const at = Math.round(i * duration * 1000);
        const frame = raw.subarray(i * frameSize, (i + 1) * frameSize);
        if (keep !== undefined && i === 3)
            return blockGroup(
                1,
                at,
                frame,
                uint(0x9b, Math.round((keep / 44100) * 1000)),
                uint(0x75a2, Math.round(((1152 - keep) / 44100) * 1e9)),
            );
        return simpleBlock(1, at, frame);
    });
    return matroskaFile([
        tracks(
            trackEntry(
                1,
                2,
                `A_MPEG/L${layer}`,
                uint(0x73c5, 101 + layer),
                string(0x22b59c, 'jpn'),
                string(0x536e, `Original layer ${layer}`),
                audioShape(1, 44100),
            ),
        ),
        cluster(0, ...blocks),
    ]);
}

describe('matroska: reading', () => {
    describe('the file', () => {
        test('an aborted signal stops the demuxer before it reads', async () => {
            const bytes = videoFile('V_VP9');
            const controller = new AbortController();
            controller.abort();
            let reads = 0;
            const source = {
                size: bytes.length,
                async read(at, length) {
                    reads++;
                    return bytes.subarray(at, at + length);
                },
            };
            await assert.rejects(new WebMDemuxer().demux(source, controller.signal), {
                code: 'ABORT',
            });
            assert.equal(reads, 0);
        });

        for (const unknown of [false, true])
            test(`${unknown ? 'unknown-size' : 'sized'} clusters keep packets apart`, async () => {
                // The source hands each read in a buffer it reuses, a MiB at most.
                const pageSize = 1 << 20;
                const tail = join(
                    simpleBlock(1, 40, [1, 2, 3]),
                    blockGroup(1, 80, [4, 5], uint(0x9b, 60)),
                    element(0xa3, [0x81, 0, 140, 0x84, 1], [6, 7, 8, 9]),
                );
                const finalCluster = cluster(2000, simpleBlock(1, 0, [10]));
                const makeInput = payload => {
                    const body = join(uint(0xe7, 1000), simpleBlock(1, 0, payload), tail);
                    const first = unknown
                        ? join([0x1f, 0x43, 0xb6, 0x75, 0xff], body)
                        : element(0x1f43b675, body);
                    return videoFile('V_VP9', undefined, undefined, [first, finalCluster]);
                };
                const trial = makeInput(new Uint8Array(3 * pageSize));
                const before = (trial.length - tail.length - finalCluster.length) % pageSize;
                const payload = new Uint8Array(3 * pageSize - before - 1).fill(90);
                const input = makeInput(payload);
                assert.equal(
                    (input.length - tail.length - finalCluster.length) % pageSize,
                    pageSize - 1,
                );
                const borrowed = new Uint8Array(pageSize);
                const parsed = await new WebMDemuxer().demux({
                    size: input.length,
                    async read(at, length) {
                        assert.ok(length <= pageSize, 'reads are bounded');
                        borrowed.fill(0);
                        borrowed.set(input.subarray(at, at + length));
                        return borrowed.subarray(0, length);
                    },
                });
                const samples = parsed.videoTracks[0].samples;
                assert.deepEqual(
                    samples.map(sample => [sample.timestamp, sample.duration]),
                    [
                        [1, 0.04],
                        [1.04, 0.04],
                        [1.08, 0.06],
                        [1.14, 0.04],
                        [1.18, 0.04],
                        [2, 0.04],
                    ],
                );
                assert.deepEqual(
                    samples.map(sample => input.slice(sample.offset, sample.offset + sample.size)),
                    [[...payload], [1, 2, 3], [4, 5], [6, 7], [8, 9], [10]].map(bytes =>
                        Uint8Array.from(bytes),
                    ),
                );
            });

        test('clusters stored before the Tracks are read once the tracks are known', async () => {
            // Header stripping restores the bytes it removed in front of every frame.
            const bytes = matroskaFile([
                cluster(1000, blockGroup(1, 0, [], uint(0x9b, 500))),
                tracks(
                    trackEntry(
                        1,
                        0x11,
                        'S_TEXT/UTF8',
                        element(
                            0x6d80,
                            element(
                                0x6240,
                                element(0x5034, uint(0x4254, 3), element(0x4255, [0x48, 0x69])),
                            ),
                        ),
                    ),
                ),
            ]);
            const media = await open(bytes);
            try {
                const packet = await packetOf(media, media.tracks[0].id);
                assert.equal(new TextDecoder().decode(packet.data), 'Hi');
                assert.equal(packet.timestamp, 1);
            } finally {
                media.close();
            }
        });

        test('a truncated segment keeps its whole blocks and is incomplete', async () => {
            const source = fixtures['mkv-aac.mkv']();
            const intact = await readAll(source);
            assert.equal(intact.packets.length, 3);
            const cut = source.subarray(0, source.length - intact.packets[2].data.length - 2);
            const truncated = await readAll(cut);
            assert.ok(truncated.warnings.includes('MATROSKA_TRUNCATED'), truncated.warnings.join());
            assert.equal(truncated.tracks[0].incomplete, true);
            assert.deepEqual(truncated.hashes, intact.hashes.slice(0, 2));
            await rejectsStrict(cut);
        });

        /** The start of the block header of packet `index` of mkv-aac.mkv. */
        const blockAt = (source, packets, index) => {
            const payload = findLast(source, Array.from(packets[index].data.subarray(0, 12)));
            // Element ID, a one- or two-byte size, track number, 16-bit time and flags.
            return [payload - 6, payload - 7].find(
                at => source[at] === 0xa3 || source[at] === 0xa1,
            );
        };

        test('a damaged last block resynchronises, keeping the blocks before it', async () => {
            const source = fixtures['mkv-aac.mkv']();
            const intact = await readAll(source);
            const damaged = source.slice();
            const last = blockAt(source, intact.packets, 2);
            damaged.fill(0, last, last + 3);
            const recovered = await readAll(damaged);
            assert.ok(recovered.warnings.includes('MATROSKA_RESYNCHRONIZED'));
            assert.deepEqual(recovered.hashes, intact.hashes.slice(0, 2));
            await rejectsStrict(damaged);
        });

        test('damage before the last block of a cluster resumes at the next block', async () => {
            const source = fixtures['mkv-aac.mkv']();
            const intact = await readAll(source);
            const damaged = source.slice();
            const second = blockAt(source, intact.packets, 1);
            damaged.fill(0xd7, second, second + 3);
            const resumed = await readAll(damaged);
            assert.ok(resumed.warnings.includes('MATROSKA_RESYNCHRONIZED'));
            assert.deepEqual(resumed.hashes, [intact.hashes[0], intact.hashes[2]]);
            assert.equal(resumed.packets[1].timestamp, intact.packets[2].timestamp);
        });

        test('video resumes at a keyframe after damage inside a cluster', async () => {
            // A foreign element inside a sized cluster: the pictures before the next keyframe,
            // whose references may be lost, are skipped with a warning.
            const damaged = cluster(
                0,
                simpleBlock(1, 0, [1, 1]),
                simpleBlock(1, 40, [2, 2], 0),
                Uint8Array.of(0x40, 0x01, 0x81, 0),
                simpleBlock(1, 80, [3, 3], 0),
                simpleBlock(1, 120, [4, 4]),
                simpleBlock(1, 160, [5, 5], 0),
            );
            const { packets, warnings } = await readAll(
                videoFile('V_VP9', undefined, undefined, [damaged]),
            );
            assert.deepEqual(
                packets.map(packet => packet.data[0]),
                [1, 2, 4, 5],
            );
            assert.ok(warnings.includes('MATROSKA_VIDEO_KEYFRAME_WAIT'), warnings.join());
        });

        test('damage before the first cluster resumes at the next top-level element', async () => {
            const intact = videoFile('V_VP9');
            const header = element(
                0x1a45dfa3,
                uint(0x4286, 1),
                string(0x4282, 'matroska'),
                uint(0x4287, 4),
            );
            const timescale = element(0x1549a966, uint(0x2ad7b1, 1000000));
            const rest = intact.subarray(findLast(intact, [0x16, 0x54, 0xae, 0x6b]));
            // Zero bytes where an element header belongs, and an EBML header whose size runs past
            // the file.
            const damaged = join(header, element(0x18538067, timescale, [0, 0, 0, 0], rest));
            const hugeHeader = join(
                [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0, 0, 0, 0x50, 0, 0x88, 0x23],
                header.subarray(header.indexOf(0x42)),
                element(0x18538067, timescale, rest),
            );
            const expected = await readAll(intact);
            for (const bytes of [damaged, hugeHeader]) {
                const read = await readAll(bytes);
                assert.equal(read.tracks[0].codec, expected.tracks[0].codec);
                assert.deepEqual(read.hashes, expected.hashes);
                assert.ok(read.warnings.length > 0);
                await rejectsStrict(bytes);
            }
        });

        test('a stray byte before a cluster resynchronises at the cluster', async () => {
            // It reads as an unknown element (ID 0x6e1f) whose size covers the cluster header; the
            // damage found at its end resumes from its start, as FFmpeg does.
            const stream = join(...[0, 1, 2, 3, 4, 5].map(mp3Frame));
            const blocks = [
                simpleBlock(1, 0, stream.subarray(0, 834)),
                simpleBlock(1, 52, stream.subarray(834)),
            ];
            const mp3Track = tracks(trackEntry(1, 2, 'A_MPEG/L3', audioShape(2, 44100)));
            const whole = await readAll(matroskaFile([mp3Track, cluster(0, ...blocks)]));
            const strayed = await readAll(matroskaFile([mp3Track, [0x6e], cluster(0, ...blocks)]));
            assert.deepEqual(strayed.hashes, whole.hashes);
            assert.ok(strayed.warnings.includes('MATROSKA_RESYNCHRONIZED'));
        });

        test('after a block overrunning its cluster, one whose time fits resumes', async () => {
            // Bytes that read as a block two seconds back are part of the damage.
            const cue = (time, text) => simpleBlock(1, time, new TextEncoder().encode(text));
            const { packets } = await readAll(
                matroskaFile([
                    tracks(trackEntry(1, 0x11, 'S_TEXT/UTF8', uint(0x73c5, 1))),
                    cluster(
                        5000,
                        cue(0, 'one'),
                        [0xa3, 0x10, 0xff, 0xff, 0xff],
                        [0xa3, 0x85, 0x81, 0xf8, 0x30, 0x80, 0x58],
                        cue(100, 'two'),
                    ),
                ]),
            );
            assert.deepEqual(
                packets.map(packet => [
                    milliseconds(packet.timestamp),
                    new TextDecoder().decode(packet.data),
                ]),
                [
                    [5000, 'one'],
                    [5100, 'two'],
                ],
            );
        });
    });

    describe('tracks', () => {
        test('a track of an unsupported codec is left out with a warning', async () => {
            const { tracks: read, warnings } = await readAll(
                fixtures['mkv-cinepak-opus-pcm.mkv'](),
            );
            assert.deepEqual(
                read.map(track => track.codec),
                ['opus', 'pcm-s16le'],
            );
            assert.deepEqual(warnings, ['MATROSKA_UNSUPPORTED_TRACK']);
        });

        test('an encrypted track is left out, not copied as if its frames were plain', async () => {
            const source = fixtures['mkv-cinepak-opus-pcm.mkv']();
            const plain = await readAll(source);
            const encrypted = source.slice();
            // ContentEncodings { ContentEncoding { ContentEncryption {} } } and a Void fill the
            // 11-byte TrackUID of the PCM track.
            encrypted.set(
                [0x6d, 0x80, 0x86, 0x62, 0x40, 0x83, 0x50, 0x35, 0x80, 0xec, 0x80],
                findLast(encrypted, [0x73, 0xc5, 0x88]),
            );
            const read = await readAll(encrypted);
            assert.deepEqual(
                read.tracks.map(track => track.codec),
                ['opus'],
            );
            assert.deepEqual(read.warnings, [
                'MATROSKA_UNSUPPORTED_TRACK',
                'MATROSKA_UNSUPPORTED_TRACK',
            ]);
            assert.deepEqual(
                read.hashes,
                plain.hashes.filter((_, at) => plain.packets[at].trackId === plain.tracks[0].id),
            );
        });

        test('zlib and LZO compressed frames are read decompressed', async () => {
            const pcm = new Uint8Array(64).map((_, index) => (index * 7) & 255);
            const text = new TextEncoder().encode('abcdabcdabcdXY');
            // LZO1X: four literals, an eight-byte match four bytes back with two trailing literals,
            // then the end of the stream.
            const lzo = Uint8Array.of(
                21,
                ...text.subarray(0, 4),
                38,
                14,
                0,
                text[12],
                text[13],
                17,
                0,
                0,
            );
            for (const [label, encoding, frame, expected] of [
                ['zlib', element(0x5034, uint(0x4254, 0)), deflateSync(pcm), pcm],
                ['LZO', element(0x5034, uint(0x4254, 2)), lzo, text],
            ]) {
                const media = await open(encodedPcm(encoding, frame));
                try {
                    const packet = await packetOf(media, media.tracks[0].id);
                    assert.deepEqual(packet.data, expected, label);
                    // The timing follows the decompressed frame.
                    assert.equal(packet.duration, expected.length / 2 / 8000, label);
                } finally {
                    media.close();
                }
            }
        });

        test('an encrypted ContentEncoding alone fails the file with DEMUX', async () => {
            await assert.rejects(
                open(encodedPcm(element(0x5035), new Uint8Array(64))),
                error => error.code === 'DEMUX' && /ContentEncoding/.test(error.message),
            );
        });

        test('a corrupt LZO frame is damage, not plain data', async () => {
            // Strict validation names it; the default drops it, which leaves the track no blocks.
            const corrupt = encodedPcm(element(0x5034, uint(0x4254, 2)), Uint8Array.of(21, 1, 2));
            await assert.rejects(
                open(corrupt, { validation: 'strict' }),
                error => error.code === 'DEMUX' && /not valid LZO1X/.test(error.message),
            );
            await assert.rejects(
                open(corrupt),
                error => error.code === 'DEMUX' && /declares no blocks/.test(error.message),
            );
        });

        test('DisplayUnit 4 leaves the display size without a meaning', async () => {
            // As FFmpeg reads it.
            const aspect = fixtures['mkv-h264-aspect.mkv']();
            const declared = await readAll(aspect);
            assert.equal(declared.tracks[0].pixelAspectRatioNum, 16);
            aspect[findLast(aspect, [0x54, 0xb2, 0x81, 0x03]) + 3] = 4;
            const unknownUnit = await readAll(aspect);
            assert.equal(unknownUnit.tracks[0].pixelAspectRatioNum, undefined);
            assert.deepEqual(unknownUnit.hashes, declared.hashes);
        });

        test('a TrackTimestampScale of 0, as old muxers wrote, reads as 1', async () => {
            const declared = await readAll(fixtures['mkv-h264-aspect.mkv']());
            const zeroScale = fixtures['mkv-h264-aspect.mkv']();
            zeroScale.set(
                [0x23, 0x31, 0x4f, 0x84, 0, 0, 0, 0, 0xec, 0x81, 0],
                findLast(zeroScale, [0x73, 0xc5, 0x88]),
            );
            const scaled = await readAll(zeroScale);
            assert.deepEqual(scaled.warnings, ['MATROSKA_TRACK_TIMESTAMP_SCALE']);
            assert.deepEqual(scaled.hashes, declared.hashes);
            await rejectsStrict(zeroScale);
        });

        test('a last block timed back does not make the track length negative', async () => {
            const backwards = fixtures['mkv-cinepak-opus-pcm.mkv']();
            backwards.set([0x80, 0x00], findLast(backwards, [0xa3, 0x41, 0x04, 0x83]) + 4);
            const read = await readAll(backwards);
            // The track ends with the block before the backward one.
            assert.equal(read.tracks[1].duration, 0.384);
        });

        test('blocks timed wholly before the segment start last their span', async () => {
            const vp8 = join([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 32, 0, 16, 0], new Uint8Array(8));
            const block = time => {
                const head = Buffer.alloc(4);
                head[0] = 0x81;
                head.writeInt16BE(time, 1);
                head[3] = 0x80;
                return element(0xa3, head, vp8);
            };
            const { packets, tracks: read } = await readAll(
                videoFile('V_VP8', undefined, undefined, [
                    cluster(0, block(-200), block(-160), block(-120)),
                ]),
            );
            assert.deepEqual(
                packets.map(packet => milliseconds(packet.timestamp)),
                [-200, -160, -120],
            );
            assert.equal(milliseconds(read[0].duration), 120);
        });

        test('an image subtitle track is left out with a warning, never silently', async () => {
            const { tracks: read, warnings } = await readAll(
                matroskaFile([
                    tracks(
                        trackEntry(1, 1, 'V_VP9', videoShape(2, 2)),
                        trackEntry(2, 17, 'S_HDMV/PGS'),
                    ),
                    cluster(0, simpleBlock(1, 0, VP9_FRAME)),
                ]),
            );
            assert.deepEqual(
                read.map(track => track.type),
                ['video'],
            );
            assert.deepEqual(warnings, ['MATROSKA_UNSUPPORTED_TRACK']);
        });

        for (const [codecId, expected] of [
            ['S_SSA', 'text/ssa'],
            ['S_ASS', 'text/ass'],
            ['S_TEXT/ASCII', 'text/utf8'],
        ])
            test(`the early subtitle codec ID ${codecId} is ${expected}`, async () => {
                const { tracks: read } = await readAll(
                    matroskaFile([
                        tracks(opusEntry(1), trackEntry(2, 17, codecId)),
                        cluster(
                            0,
                            simpleBlock(1, 0, OPUS_FRAME),
                            blockGroup(2, 0, [65], uint(0x9b, 1000)),
                        ),
                    ]),
                );
                assert.deepEqual(
                    read.map(track => track.codec),
                    ['opus', expected],
                );
            });
    });

    describe('video codecs', () => {
        for (const [name, codecId, config, expected] of [
            ['AVC Baseline', 'V_MPEG4/ISO/AVC', avcc(), 'avc1.42000a'],
            [
                'an AVC High profile header',
                'V_MPEG4/ISO/AVC',
                Uint8Array.of(1, 100, 0, 42, 0xff, 0xe0, 0),
                'avc1.64002a',
            ],
            ['HEVC Main 10', 'V_MPEGH/ISO/HEVC', HEVC_MAIN_10, 'hvc1.2.4.L120.B0'],
            [
                'HEVC of a profile space and a high compatibility bit',
                'V_MPEGH/ISO/HEVC',
                HEVC_SPACE,
                'hvc1.B5.80000080.H153.90.00.21',
            ],
            [
                'HEVC without constraints',
                'V_MPEGH/ISO/HEVC',
                HEVC_NO_CONSTRAINTS,
                'hvc1.2.4.L120.00',
            ],
            ['AV1 Main 10 high tier', 'V_AV1', Uint8Array.of(0x81, 12, 0xcc, 0), 'av01.0.12H.10'],
            ['AV1 Professional 12', 'V_AV1', Uint8Array.of(0x81, 0x48, 0x60, 0), 'av01.2.08M.12'],
            [
                'VP9 profile 2',
                'V_VP9',
                Uint8Array.of(1, 1, 2, 2, 1, 51, 3, 1, 10, 4, 1, 1),
                'vp09.02.51.10',
            ],
            [
                'VP9 profile 3 with an unknown feature',
                'V_VP9',
                Uint8Array.of(99, 2, 9, 9, 3, 1, 12, 2, 1, 62, 1, 1, 3),
                'vp09.03.62.12',
            ],
        ])
            test(`${name} is named from its CodecPrivate, which it keeps`, async () => {
                const media = await open(videoFile(codecId, config));
                try {
                    assert.equal(media.tracks[0].codec, expected);
                    assert.deepEqual(media.tracks[0].codecConfig, config);
                    const packet = await packetOf(media, media.tracks[0].id);
                    assert.deepEqual(packet.data, Uint8Array.of(1, 2, 3));
                } finally {
                    media.close();
                }
            });

        test('VP9 without CodecPrivate keeps its full codec and copies into WebM', async () => {
            const input = videoFile('V_VP9', undefined, VP9_FRAME);
            const media = await open(input);
            try {
                assert.equal(media.tracks[0].codec, 'vp09.00.10.08');
                assert.equal((await media.check('webm', { copy: true })).supported, true);
                const copy = await readAll((await media.convert('webm', { copy: true })).blob);
                assert.equal(copy.tracks[0].codec, 'vp09.00.10.08');
            } finally {
                media.close();
            }
        });

        test('AVC keeps its exact profile from Matroska to MP4 and back', async () => {
            const input = videoFile('V_MPEG4/ISO/AVC', avcc(), lengthPrefixed(4, idr));
            const mp4 = (await convert(input, 'mp4', { copy: true })).blob;
            const back = await readAll((await convert(mp4, 'mkv', { copy: true })).blob);
            assert.equal(back.tracks[0].codec, 'avc1.42000a');
            assert.deepEqual(back.tracks[0].codecConfig, avcc());
            assert.deepEqual(back.packets[0].data, lengthPrefixed(4, idr));
        });

        for (const [name, codecId, config, units, expected] of [
            [
                'MPEG-4 Part 2',
                'V_MPEG4/ISO/ASP',
                mpeg4Config({ level: 5 }),
                MPEG4_UNITS,
                'mp4v.20.5',
            ],
            [
                'MPEG-4 Part 2 of the SP codec ID',
                'V_MPEG4/ISO/SP',
                mpeg4Config(),
                MPEG4_UNITS,
                'mp4v.20.1',
            ],
            [
                'MPEG-2',
                'V_MPEG2',
                mpegSequence({ profile: 0x48 }),
                mpeg2Gop().map((unit, index) => ({
                    data: unit.data,
                    time: [0, 120, 40, 80, 240, 160, 200][index],
                })),
                'mp4v.61',
            ],
            [
                'MPEG-4 Part 2 in VfW mode',
                'V_MS/VFW/FOURCC',
                bitmapInfo('XVID', mpeg4Config()),
                MPEG4_UNITS,
                'mp4v.20.1',
            ],
        ])
            test(`${name} is named and copies into MP4, Matroska and MPEG-TS`, async () => {
                const input = videoFile(codecId, config, undefined, [mpegCluster(units)]);
                const vfw = codecId === 'V_MS/VFW/FOURCC';
                const decoderConfig = vfw ? config.subarray(40) : config;
                // The FourCC of VfW mode is the codec tag.
                const demuxed = await new WebMDemuxer().demux(new Blob([input]));
                assert.equal(demuxed.videoTracks[0].codecTag, vfw ? 'XVID' : undefined);
                const read = await readAll(input);
                assert.equal(read.tracks[0].codec, expected);
                assert.deepEqual(read.tracks[0].codecConfig, decoderConfig);
                assert.deepEqual([read.tracks[0].width, read.tracks[0].height], [32, 16]);
                for (const format of ['mp4', 'mkv', 'ts']) {
                    const copy = await readAll((await convert(input, format, { copy: true })).blob);
                    assert.equal(copy.tracks[0].codec, expected, format);
                    assert.deepEqual(copy.tracks[0].codecConfig, decoderConfig, format);
                    const [first] = copy.packets;
                    assert.deepEqual(
                        copy.packets.map(packet =>
                            milliseconds(packet.timestamp - first.timestamp),
                        ),
                        units.map(unit => unit.time),
                        format,
                    );
                    assert.deepEqual(
                        copy.packets.slice(1).map(packet => packet.data),
                        units.slice(1).map(unit => unit.data),
                        format,
                    );
                }
            });

        test('VfW Microsoft MPEG-4 v1-v3 keeps its codec; an unknown FourCC fails', async () => {
            for (const [fourcc, codec] of [
                ['DIV3', 'msmpeg4v3'],
                ['MP42', 'msmpeg4v2'],
                ['MP41', 'msmpeg4v1'],
            ]) {
                const read = await readAll(
                    videoFile('V_MS/VFW/FOURCC', bitmapInfo(fourcc, new Uint8Array(0))),
                );
                assert.equal(read.tracks[0].codec, codec);
                assert.deepEqual(read.packets[0].data, Uint8Array.of(1, 2, 3));
            }
            await assert.rejects(
                open(videoFile('V_MS/VFW/FOURCC', bitmapInfo('ABCD', new Uint8Array(0)))),
                error => /ABCD/.test(error.message),
            );
        });

        test('VfW H.264 is timed by picture order and configured from its frames', async () => {
            // VfW blocks carry decode times, as AVI chunks do; the empty block is a drop-frame
            // placeholder and is skipped.
            const fixture = reorderFixture();
            const pictures = [
                { type: 'IDR', poc: 0 },
                { frameNum: 1, poc: 6 },
                { type: 'B', frameNum: 2, poc: 2 },
                { type: 'B', frameNum: 2, poc: 4 },
            ];
            const read = await readAll(
                vfwH264(pictures, {
                    fixture,
                    firstSlot: 1,
                    lead: [simpleBlock(1, 0, new Uint8Array(0))],
                }),
            );
            const [track] = read.tracks;
            assert.equal(track.codec, 'avc1.4d000a');
            assert.deepEqual(track.codecConfig, fixture.config);
            assert.deepEqual(
                read.packets.map(packet => milliseconds(packet.timestamp)),
                [40, 160, 80, 120],
            );
            assert.deepEqual(
                read.packets.map(packet => milliseconds(packet.decodeTimestamp)),
                [0, 40, 80, 120],
            );
            // Annex B frames are handed out with NAL lengths, as the configuration describes them.
            assert.deepEqual(read.packets[1].data, lengthPrefixed(4, fixture.slice(pictures[1])));
        });

        test('VfW H.264 pictures repeated by damage show in turn, unless strict', async () => {
            const repeated = { type: 'B', frameNum: 2, poc: 2 };
            const bytes = vfwH264([
                { type: 'IDR', poc: 0 },
                { frameNum: 1, poc: 4 },
                repeated,
                repeated,
            ]);
            const read = await readAll(bytes);
            // Picture order 0, 4, 2, 2 on the 40 ms slots: the repeated pictures follow each other.
            assert.deepEqual(
                read.packets.map(packet => milliseconds(packet.timestamp)),
                [0, 120, 40, 80],
            );
            assert.deepEqual(read.warnings, ['MATROSKA_DUPLICATE_PICTURE']);
            await rejectsStrict(bytes);
        });

        test('DivX packed B-frames are unpacked into the placeholder after them', async () => {
            // MPEG-4 converted from AVI: the blocks are decode slots, a block holding an anchor and
            // a B-VOP gives the B-VOP to the placeholder after it, and the pictures are reordered.
            const vop = (coding, fill) =>
                Buffer.from([0, 0, 1, 0xb6, coding << 6, fill, fill, fill, fill, fill]);
            const intra = Buffer.concat([
                Buffer.from([0, 0, 1, 0xb2]),
                Buffer.from('DivX503b1393p'),
                vop(0, 1),
            ]);
            const packed = times =>
                videoFile('V_MPEG4/ISO/ASP', undefined, undefined, [
                    cluster(
                        0,
                        simpleBlock(1, times[0], intra),
                        simpleBlock(1, times[1], Buffer.concat([vop(1, 2), vop(2, 3)]), 0),
                        simpleBlock(1, times[2], vop(1, 4).subarray(0, 7), 0),
                        simpleBlock(1, times[3], vop(1, 5), 0),
                    ),
                ]);
            const read = await readAll(packed([0, 40, 80, 120]));
            assert.ok(read.warnings.includes('MATROSKA_PACKED_BFRAMES'), read.warnings.join());
            const vopOf = packet => {
                const at = Buffer.from(packet.data).indexOf(Buffer.from([0, 0, 1, 0xb6]));
                return [packet.data[at + 4] >> 6, packet.data[at + 5], packet.isKeyframe];
            };
            assert.deepEqual(read.packets.map(vopOf), [
                [0, 1, true],
                [1, 2, false],
                [2, 3, false],
                [1, 5, false],
            ]);
            const [, anchor, bidirectional] = read.packets;
            assert.ok(bidirectional.timestamp < anchor.timestamp);
            assert.ok(bidirectional.decodeTimestamp > anchor.decodeTimestamp);
        });

        test('blocks timed back at the B-frames keep the times their muxer gave', async () => {
            const vop = (coding, fill) =>
                Buffer.from([0, 0, 1, 0xb6, coding << 6, fill, fill, fill, fill, fill]);
            const intra = Buffer.concat([
                Buffer.from([0, 0, 1, 0xb2]),
                Buffer.from('DivX503b1393p'),
                vop(0, 1),
            ]);
            const read = await readAll(
                videoFile('V_MPEG4/ISO/ASP', undefined, undefined, [
                    cluster(
                        0,
                        simpleBlock(1, 0, intra),
                        simpleBlock(1, 80, Buffer.concat([vop(1, 2), vop(2, 3)]), 0),
                        simpleBlock(1, 40, vop(1, 4).subarray(0, 7), 0),
                        simpleBlock(1, 120, vop(1, 5), 0),
                    ),
                ]),
            );
            assert.deepEqual(read.warnings, []);
            assert.deepEqual(
                read.packets.map(packet => [milliseconds(packet.timestamp), packet.data.length]),
                [
                    [0, 27],
                    [80, 20],
                    [40, 7],
                    [120, 10],
                ],
            );
        });

        test('VP8 inter frames in BlockGroups without references are not keys', async () => {
            // As in fate/vp8_alpha: the frame header decides.
            const key = Uint8Array.of(0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 16, 0, 16, 0, 0, 0);
            const inter = Uint8Array.of(0x31, 0x01, 0x00, 0, 0, 0);
            const read = await readAll(
                matroskaFile(
                    [
                        tracks(trackEntry(1, 1, 'V_VP8', uint(0x73c5, 1), videoShape(16, 16))),
                        cluster(
                            0,
                            blockGroup(1, 0, key),
                            blockGroup(1, 40, inter),
                            blockGroup(1, 80, inter),
                        ),
                    ],
                    { docType: 'webm' },
                ),
            );
            assert.deepEqual(
                read.packets.map(packet => packet.isKeyframe),
                [true, false, false],
            );
        });

        test('MJPEG reads one picture a block', async () => {
            const read = await readAll(fixtures['mkv-mjpeg.mkv']());
            assert.equal(read.tracks[0].codec, 'mjpeg');
            assert.equal(read.packets.length, 2);
        });

        test('with B-frames the track ends at the latest frame end', async () => {
            const read = await readAll(fixtures['mkv-bframes.mkv']());
            assert.equal(Number(read.tracks[0].duration.toFixed(6)), 0.5);
            const end = Math.max(...read.packets.map(packet => packet.timestamp + packet.duration));
            assert.equal(Number(end.toFixed(6)), 0.5);
        });

        test('a track that reorders late gets the decode times ffprobe infers', async () => {
            // Matroska stores presentation times only: the decode times are those times in rising
            // order, moved back by the largest lead of a sorted time over the picture at its place,
            // also where the reordering starts late (as samples.ffmpeg.org's h264-TTA.mkv does
            // from its 55th picture).
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    video: {
                        id: 1,
                        type: 'video',
                        codec: 'avc1.42c00a',
                        codecConfig: avcc(),
                        width: 64,
                        height: 48,
                        framerate: 25,
                    },
                },
                sink,
            );
            const shown = [];
            for (let index = 0; index < 200; index++) {
                // In order, then decode order I P B shown as I B P from picture 60.
                const position =
                    index < 60 || index % 3 === 0 ? index : index % 3 === 1 ? index + 1 : index - 1;
                shown.push(position * 0.04);
                muxer.addVideoChunk({
                    trackType: 'video',
                    data: Uint8Array.of(0, 0, 0, 2, 0x65, index & 255),
                    timestamp: position * 0.04,
                    decodeTimestamp: index * 0.04,
                    duration: 0.04,
                    isKeyframe: index % 30 === 0,
                });
            }
            await muxer.finalize();
            const read = await readAll(sink.toUint8Array());
            const sorted = [...shown].sort((a, b) => a - b);
            const lead = Math.max(...sorted.map((time, index) => time - shown[index]));
            assert.deepEqual(
                read.packets.map(packet => milliseconds(packet.decodeTimestamp)),
                sorted.map(time => milliseconds(time - lead)),
            );
        });
    });

    describe('audio', () => {
        test('Opus coded at 8 kHz is described at 48 kHz', async () => {
            const read = await readAll(fixtures['mkv-opus8k.mkv']());
            assert.equal(read.tracks[0].sampleRate, 48000);
        });

        test('MP3 whose last block keeps part of its frame decodes to its samples', async () => {
            // FFmpeg states the kept part of the final 576-sample frame in BlockDuration and the
            // rest in DiscardPadding.
            const source = fixtures['mkv-mp3-8k.mkv']();
            const read = await readAll(source, { validation: 'strict' });
            assert.deepEqual(read.warnings, []);
            assert.equal(read.packets.length, 4);
            const wave = await decodedWave(source, read.tracks[0].id);
            assert.deepEqual([wave.channels, wave.frames], [1, 800]);
        });

        test('MP3 with CodecDelay and padding stated twice is trimmed once', async () => {
            // The final block's BlockDuration and DiscardPadding state the same padding; an MP4
            // copy starts its edit after the codec delay.
            const source = fixtures['mkv-mp3-discard.mkv']();
            const track = (await readAll(source)).tracks[0].id;
            const wave = await decodedWave(source, track);
            assert.deepEqual([wave.channels, wave.frames], [1, 3200]);
            const copy = await bytesOf(await convert(source, { to: 'mp4', copy: true }));
            const copied = (await readAll(copy)).tracks[0].id;
            assert.equal(sha256((await decodedWave(copy, copied)).bytes), sha256(wave.bytes));
        });

        for (const layer of [1, 2])
            test(`A_MPEG/L${layer} keeps its language and name; frames last a frame`, async () => {
                const read = await readAll(mpegAudioFile(layer));
                assert.deepEqual(
                    [read.tracks[0].codec, read.tracks[0].language, read.tracks[0].name],
                    [`mp${layer}`, 'jpn', `Original layer ${layer}`],
                );
                for (const packet of read.packets)
                    assert.ok(
                        Math.abs(packet.duration - (layer === 1 ? 384 : 1152) / 44100) < 1e-10,
                    );
            });

        test('an MP3 BlockDuration of the kept samples trims only the padding', async () => {
            const warnings = [];
            for (const validation of ['compatible', 'strict']) {
                const input = mpegAudioFile(3, { keep: 400 });
                const read = await readAll(input, {
                    validation,
                    onWarning: warning => warnings.push(warning.code),
                });
                assert.equal(read.packets.length, 4);
                assert.ok(Math.abs(read.packets[3].duration - 1152 / 44100) < 1e-10);
                const copy = await readAll(
                    await bytesOf(await convert(input, { to: 'mp4', copy: true })),
                );
                const expected = (3 * 1152 + 400) / 44100;
                assert.ok(Math.abs(copy.tracks[0].duration - expected) < 0.0015);
            }
            assert.ok(!warnings.includes('MATROSKA_DISCARD_PADDING_CLAMPED'), warnings.join());
        });

        test('MPEG audio blocks of whole frames give a packet a frame', async () => {
            const stream = join(...[0, 1, 2, 3, 4, 5].map(mp3Frame));
            const read = await readAll(
                matroskaFile([
                    tracks(trackEntry(1, 2, 'A_MPEG/L3', audioShape(2, 44100))),
                    cluster(
                        0,
                        simpleBlock(1, 0, stream.subarray(0, 834)),
                        simpleBlock(1, 52, stream.subarray(834)),
                    ),
                ]),
            );
            assert.deepEqual(
                read.packets.map(packet => packet.data[4]),
                [0, 1, 2, 3, 4, 5],
            );
        });

        test('MPEG audio blocks cut at byte counts are reassembled into frames', async () => {
            // As blocks written from AVI chunks are, and as FFmpeg's parser reads them.
            const stream = join(...[0, 1, 2, 3, 4, 5].map(mp3Frame));
            const read = await readAll(
                matroskaFile([
                    tracks(trackEntry(1, 2, 'A_MPEG/L3', audioShape(2, 44100))),
                    cluster(
                        0,
                        simpleBlock(1, 0, stream.subarray(0, 700)),
                        simpleBlock(1, 26, stream.subarray(700, 1400)),
                        simpleBlock(1, 52, stream.subarray(1400, 2100)),
                        simpleBlock(1, 78, stream.subarray(2100)),
                    ),
                ]),
            );
            assert.deepEqual(
                read.packets.map(packet => packet.data[4]),
                [0, 1, 2, 3, 4, 5],
            );
            assert.deepEqual(
                read.packets.map(packet => Math.round(packet.timestamp * 44100)),
                [0, 1152, 2304, 3456, 4608, 5760],
            );
        });

        test('AC-3 that turns from stereo to 5.1 is described with the most channels', async () => {
            // Decoders output the frames' own layout, under a Channels element of 2; copies say so
            // too, as ffprobe reports it.
            const syncframe = (acmodByte, index) => {
                const bytes = new Uint8Array(128);
                bytes.set([0x0b, 0x77, 0, 0, 0x00, 0x40, acmodByte, index]);
                return bytes;
            };
            const input = matroskaFile([
                tracks(trackEntry(1, 2, 'A_AC3', audioShape(2, 48000))),
                cluster(
                    0,
                    ...[0x40, 0x40, 0xe1, 0xe1, 0xe1].map((acmod, index) =>
                        simpleBlock(1, index * 32, syncframe(acmod, index)),
                    ),
                ),
            ]);
            const read = await readAll(input);
            assert.deepEqual([read.tracks[0].codec, read.tracks[0].channelCount], ['ac-3', 6]);
            assert.deepEqual(
                read.packets.map(packet => packet.data[7]),
                [0, 1, 2, 3, 4],
            );
            const copy = await readAll(
                await bytesOf(await convert(input, { to: 'mkv', copy: true })),
            );
            assert.equal(copy.tracks[0].channelCount, 6);
        });

        test('Vorbis frames laced in one block are timed by their block sizes', async () => {
            // A quarter of the previous and the current block, in whole ticks of the block clock
            // as FFmpeg counts them.
            const ogg = await readAll(fixtures['ogg-vorbis-pages.ogg']());
            const audio = ogg.packets.slice(0, 5);
            const lacing = [audio.length - 1];
            for (const packet of audio.slice(0, -1)) {
                let size = packet.data.length;
                for (; size >= 255; size -= 255) lacing.push(255);
                lacing.push(size);
            }
            const [track] = ogg.tracks;
            const read = await readAll(
                matroskaFile([
                    tracks(
                        trackEntry(
                            1,
                            2,
                            'A_VORBIS',
                            element(0x63a2, track.codecConfig),
                            audioShape(track.channelCount, track.sampleRate),
                        ),
                    ),
                    cluster(
                        0,
                        element(
                            0xa3,
                            [0x81, 0, 0, 0x82],
                            lacing,
                            ...audio.map(packet => packet.data),
                        ),
                    ),
                ]),
            );
            const rate = track.sampleRate;
            let clock = 0;
            const expected = audio.map(packet => {
                const at = clock;
                clock += Math.floor(Math.round(packet.duration * rate) / rate / 0.001 + 1e-9);
                return at;
            });
            assert.deepEqual(
                read.packets.map(packet => milliseconds(packet.timestamp)),
                expected,
            );
            assert.deepEqual(read.hashes, ogg.hashes.slice(0, 5));
        });

        test('audio blocks timed back still decode in the order stored', async () => {
            const read = await readAll(
                matroskaFile([
                    tracks(opusEntry(1)),
                    cluster(
                        0,
                        simpleBlock(1, 0, [0x08, 1]),
                        simpleBlock(1, 20, [0x08, 2]),
                        simpleBlock(1, 10, [0x08, 3]),
                        simpleBlock(1, 40, [0x08, 4]),
                    ),
                ]),
            );
            assert.deepEqual(
                read.packets.map(packet => [packet.data[1], milliseconds(packet.timestamp)]),
                [
                    [1, 0],
                    [2, 20],
                    [3, 10],
                    [4, 40],
                ],
            );
        });

        test('an early AAC codec ID without CodecPrivate is configured from it', async () => {
            // As ffmpeg builds the AudioSpecificConfig: the profile, the frequency and channels.
            const legacy = (codecId, shape) =>
                matroskaFile([
                    tracks(trackEntry(1, 2, codecId, shape)),
                    cluster(0, simpleBlock(1, 0, [0x21, 0x10, 4, 0x60, 0x8c, 0x1c])),
                ]);
            const lc = await new WebMDemuxer().demux(
                new BufferSource(legacy('A_AAC/MPEG4/LC', audioShape(2, 44100))),
            );
            assert.equal(lc.audioTracks[0].codec, 'mp4a.40.2');
            assert.deepEqual([...lc.audioTracks[0].codecConfig], [0x12, 0x10]);
            const sbr = await new WebMDemuxer().demux(
                new BufferSource(
                    legacy('A_AAC/MPEG2/LC/SBR', audioShape(2, 22050, float(0x78b5, 44100))),
                ),
            );
            assert.deepEqual([...sbr.audioTracks[0].codecConfig], [0x13, 0x90, 0x56, 0xe5, 0xa0]);
        });

        test('fixed lacing of 256 frames a block counts every frame', async () => {
            const laced = matroskaFile([
                tracks(opusEntry(1)),
                ...Array.from({ length: 300 }, (_, i) =>
                    cluster(
                        i * 640,
                        simpleBlock(
                            1,
                            0,
                            join([255], ...Array.from({ length: 256 }, () => [0x80, 0])),
                            0x84,
                        ),
                    ),
                ),
            ]);
            const read = await new WebMDemuxer().demux(new BufferSource(laced));
            assert.equal(read.audioTracks[0].samples.length, 76800);
            await assert.rejects(
                new WebMDemuxer({ maxSamples: 70000 }).demux(new BufferSource(laced)),
                {
                    code: 'OOM',
                },
            );
        });
    });

    describe('metadata', () => {
        const tagsOf = (...tags) => element(0x1254c367, ...tags);
        const globalTag = element(
            0x7373,
            element(0x63c0),
            simpleTag('ARTIST', '芸術家'),
            simpleTag('COMMENT', 'Global comment'),
        );
        /** Video, two Opus tracks and WebVTT, all named, with `extra` after the Tracks. */
        const namedFile = (extra = tagsOf(globalTag)) =>
            matroskaFile([
                info(string(0x7ba9, '作品の題名')),
                tracks(
                    trackEntry(
                        1,
                        1,
                        'V_VP9',
                        uint(0x73c5, 1n + (1n << 60n)),
                        string(0x536e, '主映像'),
                        uint(0x55af, 0),
                        videoShape(2, 2),
                    ),
                    opusEntry(2, string(0x536e, 'Director commentary'), uint(0x55af, 1)),
                    opusEntry(3, string(0x536e, 'Main audio'), uint(0x55af, 0)),
                    trackEntry(
                        4,
                        17,
                        'D_WEBVTT/SUBTITLES',
                        uint(0x73c5, 4n + (1n << 60n)),
                        string(0x536e, '字幕'),
                        uint(0x55af, 1),
                    ),
                ),
                extra,
                cluster(
                    0,
                    simpleBlock(1, 0, VP9_FRAME),
                    simpleBlock(2, 0, OPUS_FRAME),
                    simpleBlock(3, 0, OPUS_FRAME),
                    blockGroup(4, 0, [10, 10, 65], uint(0x9b, 1000)),
                ),
            ]);

        test('names, commentary flags, UIDs, the title and the tags are read', async () => {
            const parsed = await new WebMDemuxer().demux(new BufferSource(namedFile()));
            const [commentary, main] = parsed.audioTracks;
            assert.deepEqual(
                [commentary.matroskaTrackUid, main.matroskaTrackUid],
                [2n + (1n << 60n), 3n + (1n << 60n)],
            );
            assert.deepEqual(
                [commentary.name, commentary.commentary],
                ['Director commentary', true],
            );
            // A track without a Language has no known language.
            assert.equal(commentary.language, undefined);
            assert.equal(parsed.matroskaPassThrough.title, '作品の題名');
            assert.deepEqual(parsed.matroskaPassThrough.tags, tagsOf(globalTag));
            const read = await readAll(namedFile());
            assert.deepEqual(
                read.tracks.map(track => [track.name, track.commentary]),
                [
                    ['主映像', false],
                    ['Director commentary', true],
                    ['Main audio', false],
                    ['字幕', true],
                ],
            );
        });

        test('an invalid commentary flag is reported as lost metadata', async () => {
            const invalid = namedFile();
            invalid[
                invalid.findIndex(
                    (_, i) =>
                        invalid[i] === 0x55 && invalid[i + 1] === 0xaf && invalid[i + 2] === 0x81,
                ) + 3
            ] = 2;
            const read = await readAll(invalid, { validation: 'strict' });
            assert.ok(read.warnings.includes('MATROSKA_METADATA_LOSS'), read.warnings.join());
        });

        test('the sample and index budgets bound the blocks read', async () => {
            const input = namedFile();
            await assert.rejects(
                new WebMDemuxer({ maxSamples: 3 }).demux(new BufferSource(input)),
                {
                    code: 'OOM',
                },
            );
            await assert.rejects(
                new WebMDemuxer({ maxIndexBytes: 1023 }).demux(new BufferSource(input)),
                {
                    code: 'OOM',
                },
            );
            await new WebMDemuxer({ maxSamples: 4, maxIndexBytes: 1024 }).demux(
                new BufferSource(input),
            );
        });

        test('Matroska flags default as the specification says', async () => {
            // FlagDefault true and FlagForced false when omitted.
            const read = await readAll(
                matroskaFile([
                    tracks(
                        opusEntry(1, uint(0x88, 0), uint(0x55aa, 0)),
                        opusEntry(2, uint(0x88, 1)),
                        opusEntry(3),
                        trackEntry(4, 17, 'S_TEXT/UTF8', uint(0x88, 0), uint(0x55aa, 1)),
                    ),
                    cluster(
                        0,
                        simpleBlock(1, 0, OPUS_FRAME),
                        simpleBlock(2, 0, OPUS_FRAME),
                        simpleBlock(3, 0, OPUS_FRAME),
                        blockGroup(4, 0, [65], uint(0x9b, 1000)),
                    ),
                ]),
            );
            assert.deepEqual(
                read.tracks.map(track => [track.default, track.forced]),
                [
                    [false, false],
                    [true, false],
                    [true, false],
                    [false, true],
                ],
            );
        });

        test('an edition tag, chapter titles and pictures are read as ffmpeg does', async () => {
            // A Tag of an edition is file-wide and its TITLE replaces the segment title, a
            // chapter's title is its last ChapString, and only GIF, JPEG, PNG, TIFF, BMP and WebP
            // attachments are pictures; other attachments are Matroska's own.
            const edition = element(
                0x7373,
                element(0x63c0, uint(0x63c9, 7)),
                simpleTag('TITLE', 'Edition title'),
                simpleTag('DESCRIPTION', 'About'),
            );
            const chapters = element(
                0x1043a770,
                element(
                    0x45b9,
                    uint(0x45bc, 7),
                    element(
                        0xb6,
                        uint(0x73c4, 1),
                        uint(0x91, 0),
                        element(0x80, string(0x85, 'English'), string(0x437c, 'eng')),
                        element(0x80, string(0x85, 'Deutsch'), string(0x437c, 'ger')),
                    ),
                ),
            );
            const attached = (name, mime, uid) =>
                element(
                    0x61a7,
                    string(0x466e, name),
                    string(0x4660, mime),
                    element(0x465c, [1, 2, 3]),
                    uint(0x46ae, uid),
                );
            const attachments = element(
                0x1941a469,
                attached('cover.png', 'image/png', 1),
                attached('icon.xpm', 'image/x-xpixmap', 2),
            );
            const input = namedFile(join(tagsOf(edition), chapters, attachments));
            const read = await readAll(input);
            assert.equal(read.title, 'Edition title');
            // The XPM attachment has no place in MP4.
            const support = await check(input, { to: 'mp4', copy: true, trackIds: [1, 2] });
            assert.ok(
                support.warnings.some(
                    w => w.code === 'MATROSKA_METADATA_LOSS' && /attachments/.test(w.message),
                ),
            );
            const mp4 = await new Mp4Demuxer().demux(
                new BufferSource(
                    await bytesOf(
                        await convert(input, { to: 'mp4', copy: true, trackIds: [1, 2] }),
                    ),
                ),
            );
            assert.equal(mp4.title, 'Edition title');
            assert.deepEqual(
                mp4.tags.entries.filter(entry => entry.key === 'description'),
                [{ key: 'description', value: 'About' }],
            );
            assert.deepEqual(
                mp4.tags.chapters.map(chapter => chapter.title),
                ['Deutsch'],
            );
            assert.deepEqual(
                mp4.tags.pictures.map(picture => picture.mimeType),
                ['image/png'],
            );
        });

        test('a segment TITLE tag names a file without an Info title', async () => {
            const tagged = matroskaFile([
                tracks(trackEntry(1, 1, 'V_VP9', videoShape(2, 2))),
                tagsOf(
                    element(
                        0x7373,
                        element(0x63c0, uint(0x68ca, 50)),
                        simpleTag('TITLE', 'Tagged'),
                    ),
                ),
                cluster(0, simpleBlock(1, 0, VP9_FRAME)),
            ]);
            assert.equal((await readAll(tagged)).title, 'Tagged');
        });

        test('colour, HDR mastering, a field order and accessibility flags are read', async () => {
            const mastering = [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329, 1000, 0.01];
            const colour = element(
                0x55b0,
                uint(0x55b1, 9),
                uint(0x55ba, 16),
                uint(0x55bb, 9),
                uint(0x55bc, 1000),
                uint(0x55bd, 400),
                element(0x55d0, ...mastering.map((value, index) => float(0x55d1 + index, value))),
            );
            const parsed = await new WebMDemuxer().demux(
                new BufferSource(
                    matroskaFile([
                        tracks(
                            trackEntry(
                                1,
                                1,
                                'V_VP9',
                                videoShape(2, 2, uint(0x9a, 1), uint(0x9d, 6), colour),
                            ),
                            opusEntry(2, uint(0x55ab, 1)),
                        ),
                        cluster(0, simpleBlock(1, 0, VP9_FRAME), simpleBlock(2, 0, OPUS_FRAME)),
                    ]),
                ),
            );
            // An unspecified range keeps the other fields.
            assert.deepEqual(parsed.videoTracks[0].colour, {
                primaries: 9,
                transfer: 16,
                matrix: 9,
                mastering: {
                    red: [0.68, 0.32],
                    green: [0.265, 0.69],
                    blue: [0.15, 0.06],
                    whitePoint: [0.3127, 0.329],
                    maxLuminance: 1000,
                    minLuminance: 0.01,
                },
                contentLight: { maxContent: 1000, maxAverage: 400 },
            });
            assert.equal(parsed.videoTracks[0].fieldOrder, 'bb');
            assert.deepEqual(parsed.audioTracks[0].dispositions, { hearingImpaired: true });
        });
    });

    describe('alpha and side data', () => {
        const ALPHA = [9, 8, 7];
        const alphaFile = (codecId = 'V_VP9', frame = VP9_FRAME, addId = 1) =>
            matroskaFile([
                tracks(
                    trackEntry(
                        1,
                        1,
                        codecId,
                        uint(0x73c5, 1n + (1n << 60n)),
                        videoShape(2, 2, ...(addId === 1 ? [uint(0x53c0, 1)] : [])),
                    ),
                ),
                cluster(
                    0,
                    blockGroup(
                        1,
                        0,
                        frame,
                        uint(0x9b, 40),
                        element(0x75a1, element(0xa6, uint(0xee, addId), element(0xa5, ALPHA))),
                    ),
                ),
            ]);

        test('a VP9 alpha channel is read with each picture', async () => {
            const read = await readAll(alphaFile());
            assert.equal(read.tracks[0].alphaMode, true);
            assert.deepEqual(read.packets[0].alphaData, Uint8Array.from(ALPHA));
            await assert.rejects(open(alphaFile(), { maxPacketBytes: 4 }), { code: 'OOM' });
        });

        test('VP8 alpha from a file is read with every picture', async () => {
            const read = await readAll(fixtures['webm-vp8-alpha.webm']());
            assert.ok(read.packets.every(packet => packet.alphaData?.length > 0));
        });

        test('side data other than alpha is left out as metadata, unless strict', async () => {
            // BlockAddID 4 carries HDR10+.
            const alpha = fixtures['webm-vp8-alpha.webm']();
            const withAlpha = await readAll(alpha);
            for (let index = 0; (index = alpha.indexOf(0xee, index + 1)) > 0;)
                if (
                    alpha[index + 1] === 0x81 &&
                    alpha[index + 2] === 0x01 &&
                    alpha[index + 3] === 0xa5
                )
                    alpha[index + 2] = 4;
            const sideData = await readAll(alpha);
            assert.deepEqual(sideData.warnings, ['MATROSKA_METADATA_LOSS']);
            assert.deepEqual(sideData.hashes, withAlpha.hashes);
            assert.ok(sideData.packets.every(packet => !packet.alphaData));
            const unsupported = alphaFile('V_VP9', VP9_FRAME, 2);
            await assert.rejects(
                new WebMDemuxer().demux(new BufferSource(unsupported)),
                /BlockAdd|side data/i,
            );
            await assert.rejects(
                open(unsupported, { validation: 'strict' }),
                error => error.code === 'FORMAT' && /BlockAdd|side data/i.test(error.message),
            );
        });
    });

    for (const layer of [1, 2])
        test(`an A_MPEG/L${layer} copy keeps its language, name and raw frames`, async () => {
            const original = await readAll(mpegAudioFile(layer));
            const copy = await bytesOf(
                await convert(mpegAudioFile(layer), { to: 'mkv', copy: true }),
            );
            const read = await readAll(copy);
            assert.deepEqual(
                [read.tracks[0].language, read.tracks[0].name],
                ['jpn', `Original layer ${layer}`],
            );
            assert.deepEqual(read.hashes, original.hashes);
            read.packets.forEach((packet, i) =>
                assert.ok(Math.abs(packet.timestamp - original.packets[i].timestamp) <= 0.000501),
            );
            const raw = await bytesOf(await convert(copy, { to: `mp${layer}`, copy: true }));
            assert.deepEqual(raw, mpegAudioFixture(layer));
        });

    describe('the compact index', async () => {
        const { enableCompactSampleIndex, getCompactSampleIndex } = await import(
            distUrl('esm/core/model/sample-index.js')
        );
        const timed = (track, rel, flags, ...body) =>
            join([0x80 | track, (rel >> 8) & 255, rel & 255, flags], ...body);
        const xiph = frames =>
            join(
                [frames.length - 1],
                ...frames.slice(0, -1).map(frame => [frame.length]),
                ...frames,
            );
        const ebmlLaced = frames =>
            join(
                [frames.length - 1, 0x80 | frames[0].length],
                ...frames
                    .slice(1, -1)
                    .map((frame, i) => [0x80 | (frame.length - frames[i].length + 63)]),
                ...frames,
            );
        const fixed = frames => join([frames.length - 1], ...frames);
        const opusFrames = i => [
            [0x80, i & 255],
            [0x80, 1, 2],
            [0x80, 3],
            [0x80, 4, 5, 6],
        ];
        const equalFrames = i => [
            [0x80, i & 255],
            [0x80, 1],
            [0x80, 2],
            [0x80, 3],
        ];
        const AUDIO_BLOCKS = 300;
        const VIDEO_BLOCKS = 1200;
        /** Xiph, EBML and fixed lacing in turn. */
        const lacedBlock = (track, i, rel) =>
            i % 3 === 0
                ? timed(track, rel, 0x82, xiph(opusFrames(i)))
                : i % 3 === 1
                  ? timed(track, rel, 0x86, ebmlLaced(opusFrames(i)))
                  : timed(track, rel, 0x84, fixed(equalFrames(i)));
        const padding = value => {
            const bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setInt32(0, value);
            return element(0x75a2, bytes);
        };
        const blocks = [];
        for (let i = 0; i < VIDEO_BLOCKS; i++) {
            // Pictures in the order I P B shown as I B P.
            const rel = i % 3 === 1 ? (i + 1) * 20 : i % 3 === 2 ? (i - 1) * 20 : i * 20;
            const picture = [0x82, 0x49, 0x83, 0x42 + (i & 15)];
            blocks.push(element(0xa3, timed(1, rel, i % 30 === 0 ? 0x80 : 0, picture)));
        }
        for (let i = 0; i < AUDIO_BLOCKS; i++) {
            // The first sound starts 6.5 ms early, the last ends 2.5 ms early.
            const edge = i === 0 ? -6500000 : i === AUDIO_BLOCKS - 1 ? 2500000 : 0;
            blocks.push(
                edge
                    ? element(0xa0, element(0xa1, lacedBlock(2, i, i * 10)), padding(edge))
                    : element(0xa3, lacedBlock(2, i, i * 10)),
            );
            // The other sound track's blocks are timed out of order.
            blocks.push(element(0xa3, lacedBlock(3, i, (i ^ 1) * 10)));
        }
        const laced = matroskaFile([
            tracks(
                trackEntry(1, 1, 'V_VP9', uint(0x23e383, 20000000), videoShape(2, 2)),
                opusEntry(2),
                opusEntry(3),
            ),
            cluster(0, ...blocks),
        ]);
        const SAMPLES = VIDEO_BLOCKS + AUDIO_BLOCKS * 8;

        test('holds the samples, sizes, times and flags of the sample arrays', async () => {
            const eager = await new WebMDemuxer().demux(new BufferSource(laced));
            const compact = await enableCompactSampleIndex(new WebMDemuxer()).demux(
                new BufferSource(laced),
            );
            const eagerTracks = [...eager.videoTracks, ...eager.audioTracks];
            const compactTracks = [...compact.videoTracks, ...compact.audioTracks];
            assert.equal(eagerTracks.length, 3);
            for (const [position, expected] of eagerTracks.entries()) {
                const track = compactTracks[position];
                const index = getCompactSampleIndex(track);
                const { samples } = expected;
                assert.ok(index, 'the track carries a compact sample index');
                assert.equal(index.length, samples.length);
                assert.ok(index.byteLength > 0 && index.byteLength <= 48 * index.length);
                assert.equal(index.maxSampleSize, Math.max(...samples.map(sample => sample.size)));
                assert.equal(
                    index.allKeyframes,
                    samples.every(sample => sample.isKeyframe),
                );
                const rising = key =>
                    samples.every((sample, i) => i === 0 || sample[key] >= samples[i - 1][key]);
                assert.equal(index.presentationSorted, rising('timestamp'));
                assert.equal(index.decodeSorted, rising('decodeTimestamp'));
                assert.equal(
                    index.firstPresentation,
                    Math.min(...samples.map(sample => sample.timestamp)),
                );
                assert.equal(
                    index.lastPresentationEnd,
                    Math.max(...samples.map(sample => sample.timestamp + sample.duration)),
                );
                for (const [i, sample] of samples.entries()) {
                    assert.deepEqual(index.get(i), sample);
                    assert.equal(index.timestampAt(i), sample.timestamp);
                    assert.equal(index.decodeTimeAt(i), sample.decodeTimestamp);
                    assert.equal(index.isKeyframeAt(i), sample.isKeyframe);
                }
                for (const field of [
                    'id',
                    'codec',
                    'duration',
                    'timestampResolutionSeconds',
                    'editMediaTimeSeconds',
                    'opusTrailingPaddingSamples',
                    'matroskaCodecDelaySeconds',
                ])
                    assert.equal(track[field], expected[field], field);
                // Reading the sample array ends the compact index.
                assert.deepEqual(track.samples, samples);
                assert.equal(getCompactSampleIndex(track), undefined);
            }
        });

        test('negative and positive DiscardPadding trim the lead and the tail', async () => {
            const eager = await new WebMDemuxer().demux(new BufferSource(laced));
            assert.equal(eager.audioTracks[0].editMediaTimeSeconds, 0.0065);
            assert.equal(eager.audioTracks[0].opusTrailingPaddingSamples, 120);
            const backwards = samples =>
                samples.some((sample, i) => i > 0 && sample.timestamp < samples[i - 1].timestamp);
            assert.equal(backwards(eager.videoTracks[0].samples), true);
            assert.equal(backwards(eager.audioTracks[1].samples), true);
        });

        test('gives the packets and searches a reader of sample arrays gives', async () => {
            const arrays = {
                name: 'matroska-arrays',
                readers: [
                    readerPart({
                        formats: ['mkv', 'webm'],
                        read: source => new WebMDemuxer().demux(source),
                    }),
                ],
            };
            const compactFile = await open(laced, { maxIndexBytes: 262144, maxSamples: SAMPLES });
            const arrayFile = await open(laced, { plugins: { add: [arrays] } });
            const packetsOf = async media => {
                const packets = [];
                for await (const packet of media.packets())
                    packets.push([
                        packet.trackId,
                        packet.timestamp,
                        packet.decodeTimestamp,
                        packet.duration,
                        packet.isKeyframe,
                        hex(packet.data),
                    ]);
                return packets;
            };
            try {
                const compactPackets = await packetsOf(compactFile);
                assert.equal(compactPackets.length, SAMPLES);
                assert.deepEqual(compactPackets, await packetsOf(arrayFile));
                for (const time of [0, 0.0125, 0.42, 1.3, 2.9, 30])
                    for (const track of compactFile.tracks)
                        for (const options of [{}, { keyframe: true }, { mode: 'after' }]) {
                            const found = await compactFile.packetAt(track.id, time, options);
                            const expected = await arrayFile.packetAt(track.id, time, options);
                            assert.deepEqual(
                                [found?.timestamp, found?.data],
                                [expected?.timestamp, expected?.data],
                                `${track.id} at ${time}: ${JSON.stringify(options)}`,
                            );
                        }
            } finally {
                compactFile.close();
                arrayFile.close();
            }
        });

        test('the index budget and the sample budget bound it', async () => {
            await assert.rejects(open(laced, { maxIndexBytes: 65536 }), { code: 'OOM' });
            await assert.rejects(open(laced, { maxSamples: SAMPLES - 1 }), { code: 'OOM' });
            const limited = enableCompactSampleIndex(new WebMDemuxer({ maxIndexBytes: 65536 }));
            await assert.rejects(limited.demux(new BufferSource(laced)), { code: 'OOM' });
        });
    });

    describe('DTS, TrueHD and codecs not read', () => {
        /** DTS, TrueHD and Opus tracks in Matroska, two blocks each. */
        async function threeTracks() {
            const tracks = [
                { type: 'audio', codec: 'dtsc', sampleRate: 48000, channelCount: 2 },
                { type: 'audio', codec: 'mlpa', sampleRate: 48000, channelCount: 2 },
                {
                    type: 'audio',
                    codec: 'opus',
                    sampleRate: 48000,
                    channelCount: 2,
                    codecConfig: opusHead(2),
                },
            ];
            const data = [
                dtsCore({ fill: 1 }),
                truehdUnit({ sampleRateCode: 0 }),
                Uint8Array.of(0xfc, 0),
            ];
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    autoSync: false,
                    maxFragmentDuration: 2,
                    audio: tracks[0],
                    extraAudioTracks: tracks.slice(1),
                },
                sink,
            );
            for (let index = 0; index < 2; index++)
                tracks.forEach((_, trackIndex) => {
                    const chunk = {
                        trackType: 'audio',
                        data: data[trackIndex],
                        timestamp: index * 0.02,
                        duration: 0.02,
                        isKeyframe: true,
                    };
                    if (trackIndex) muxer.addExtraAudioChunk(trackIndex - 1, chunk);
                    else muxer.addAudioChunk(chunk);
                });
            await muxer.finalize();
            return sink.toUint8Array();
        }
        const shapes = tracks =>
            tracks.map(track => [track.codec, track.sampleRate, track.channelCount]);

        test('DTS and TrueHD are written as A_DTS and A_TRUEHD and read back', async () => {
            const bytes = await threeTracks();
            for (const id of ['A_DTS', 'A_TRUEHD']) assert.ok(Buffer.from(bytes).includes(id), id);
            assert.deepEqual(shapes((await readAll(bytes)).tracks), [
                ['dtsc', 48000, 2],
                ['mlpa', 48000, 2],
                ['opus', 48000, 2],
            ]);
        });

        test('a track of a codec not read is skipped with a warning, not the file', async () => {
            // A CodecID of the same length: TTA audio.
            const patched = Buffer.from(await threeTracks());
            patched.write('A_TTA1', patched.indexOf('A_OPUS'), 'latin1');
            const { tracks, warnings } = await readAll(new Uint8Array(patched));
            assert.deepEqual(shapes(tracks), [
                ['dtsc', 48000, 2],
                ['mlpa', 48000, 2],
            ]);
            assert.deepEqual(warnings, ['MATROSKA_UNSUPPORTED_TRACK']);
        });
    });
});
