import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classicMp4, patchTable, fixtureSource } from '../helpers/mp4-fixture.mjs';
import { inspect, open } from 'mediaforgejs';
import { Mp4Demuxer, Mp4Muxer } from 'mediaforgejs/formats';
import { distUrl } from '../helpers/dist-paths.mjs';
import { MemorySink } from 'mediaforgejs/io';
import { CmafWriter } from 'mediaforgejs/streaming';

// The compact index is the MP4 reader's store of samples (core/model), observable only within.
const { enableCompactSampleIndex, getCompactSampleIndex, sampleAt } = await import(
    distUrl('esm/core/model/sample-index.js')
);
const { DiagnosticContext } = await import(distUrl('esm/core/errors/diagnostics.js'));

/** The audio track of `bytes` read into a sample array, or into the compact index. */
async function demux(bytes, compact, options = {}, diagnostics = new DiagnosticContext()) {
    const reader = new Mp4Demuxer(options);
    if (compact) enableCompactSampleIndex(reader);
    return (await reader.demux(fixtureSource(bytes), undefined, diagnostics)).audioTracks[0];
}

// The sample tables of MP4 read into sample arrays (Mp4Demuxer) and into the compact
// index open() builds: offsets, sizes, times and flags of every layout the tables state,
// their budgets, and the damage they reject.

describe('mp4: sample tables under stress', () => {
    for (const compact of [false, true]) {
        const mode = compact ? 'compact' : 'array';
        test(`${mode}: independent sample bytes and metadata`, async () => {
            const { bytes } = classicMp4({
                sizes: [4, 2, 5, 3, 4, 6],
                chunkSamples: [2, 1, 3],
                gapBytes: 5,
                timing: [
                    [2, 40],
                    [3, 20],
                    [1, 80],
                ],
                composition: [
                    [1, 40],
                    [1, -40],
                    [4, 0],
                ],
                sync: [1, 4],
                edits: [
                    [100, -1],
                    [240, 20],
                ],
            });
            const track = await demux(bytes, compact);
            const index = getCompactSampleIndex(track);
            const samples = index
                ? Array.from({ length: index.length }, (_, position) => index.get(position))
                : track.samples;
            assert.equal(track.language, 'eng');
            assert.equal(track.codec, 'mp4a.40.2');
            assert.equal(track.sampleRate, 48000);
            assert.equal(track.editTimelineShiftSeconds, 0.08);
            assert.deepEqual(
                samples.map(value => value.offset),
                [32, 36, 43, 53, 56, 60],
            );
            assert.deepEqual(
                samples.map(value => value.size),
                [4, 2, 5, 3, 4, 6],
            );
            assert.deepEqual(
                samples.map(value => value.timestamp),
                [0.12, 0.08, 0.16, 0.18, 0.2, 0.22],
            );
            // The negative composition offset moves every decode time 40 ms earlier, so no sample
            // is shown before it is decoded.
            assert.deepEqual(
                samples.map(value => value.decodeTimestamp),
                [0.04, 0.08, 0.12, 0.14, 0.16, 0.18],
            );
            assert.deepEqual(
                samples.map(value => value.duration),
                [0.04, 0.04, 0.02, 0.02, 0.02, 0.08],
            );
            assert.deepEqual(
                samples.map(value => value.isKeyframe),
                [true, false, false, true, false, false],
            );
            assert.deepEqual(
                Array.from(bytes.slice(samples[3].offset, samples[3].offset + samples[3].size)),
                [118, 129, 140],
            );
            assert.deepEqual(track.samples, samples);
        });
        test(`${mode}: rejects an overfull final chunk`, async () => {
            const { bytes } = classicMp4({ layout: [[1, 7, 1]] });
            await assert.rejects(demux(bytes, compact), error => error.code === 'DEMUX');
        });
        test(`${mode}: rejects undeclared extra chunks`, async () => {
            const { bytes } = classicMp4({ offsets: [32, 32], layout: [[1, 6, 1]] });
            await assert.rejects(demux(bytes, compact), error => error.code === 'DEMUX');
        });
        test(`${mode}: rejects layout runs beyond the final chunk`, async () => {
            const { bytes } = classicMp4({
                layout: [
                    [1, 6, 1],
                    [2, 1, 1],
                ],
            });
            await assert.rejects(demux(bytes, compact), error => error.code === 'DEMUX');
        });
        for (const sync of [
            [0, 1],
            [1, 7],
            [1, 1],
            [4, 1],
        ]) {
            test(`${mode}: rejects invalid sync table ${sync}`, async () => {
                await assert.rejects(
                    demux(classicMp4({ sync }).bytes, compact),
                    error => error.code === 'DEMUX',
                );
            });
        }
    }
    test('compact: fixed-size tracks fit a chunk-sized index budget', async () => {
        const { bytes } = classicMp4({ count: 100000, chunkSamples: new Array(100).fill(1000) });
        const track = await demux(bytes, true, { maxIndexBytes: 4096 });
        const index = getCompactSampleIndex(track);
        assert.equal(index.length, 100000);
        assert.deepEqual(index.get(99999), {
            offset: 400028,
            size: 4,
            timestamp: 3999.96,
            duration: 0.04,
            isKeyframe: true,
        });
        assert.throws(
            () => track.samples,
            error => error.code === 'OOM',
        );
    });
    test('compact: variable sizes fit eight bytes per sample', async () => {
        const { bytes } = classicMp4({
            sizes: Array.from({ length: 100000 }, (_, index) => (index & 1 ? 6 : 4)),
        });
        const track = await demux(bytes, true, { maxIndexBytes: 805000 });
        const index = getCompactSampleIndex(track);
        assert.equal(index.length, 100000);
        assert.deepEqual(index.get(99999), {
            offset: 500026,
            size: 6,
            timestamp: 3999.96,
            duration: 0.04,
            isKeyframe: true,
        });
    });
    for (const compact of [false, true]) {
        const mode = compact ? 'compact' : 'array';
        for (const field of [4, 8, 16]) {
            test(
                `${mode}: stz2 ${field}-bit sizes preserve odd nibbles and empty ` + `samples`,
                async () => {
                    const track = await demux(
                        classicMp4({ field, sizes: [0, 4, 1, 6, 3], chunkSamples: [2, 3] }).bytes,
                        compact,
                    );
                    assert.deepEqual(
                        track.samples.map(sample => sample.offset),
                        [32, 32, 36, 37, 43],
                    );
                    assert.deepEqual(
                        track.samples.map(sample => sample.size),
                        [0, 4, 1, 6, 3],
                    );
                },
            );
        }
        test(`${mode}: zero-count timing runs do not override populated runs`, async () => {
            const track = await demux(
                classicMp4({
                    chunkSamples: [1, 1, 1, 1, 1, 1],
                    timing: [
                        [0, 99],
                        [2, 0],
                        [0, 999],
                        [2, 20],
                        [2, 0],
                        [0, 55],
                    ],
                    composition: [
                        [0, 17],
                        [3, 0],
                        [0, 3],
                        [3, -20],
                        [0, 4],
                    ],
                }).bytes,
                compact,
            );
            assert.deepEqual(
                track.samples.map(sample => sample.timestamp),
                [0, 0, 0, 0, 0.02, 0.02],
            );
            assert.deepEqual(
                track.samples.map(sample => sample.duration),
                [0.001, 0.001, 0.02, 0.02, 0.02, 0.02],
            );
        });
        test(`${mode}: compatible recovery retains original timing and one warning`, async () => {
            const fixture = classicMp4({
                sizes: [4, 4, 100, 99, 3, 2],
                chunkSamples: [2, 2, 2],
                sync: [3, 5],
            });
            const bytes = patchTable(fixture.bytes, 'stco', 20, fixture.moovOffset);
            const diagnostics = new DiagnosticContext({ validation: 'compatible' });
            const track = await demux(bytes, compact, {}, diagnostics);
            const index = getCompactSampleIndex(track);
            if (index) {
                assert.equal(index.maxSampleSize, 4);
                assert.equal(index.allKeyframes, false);
            }
            assert.equal(track.incomplete, true);
            assert.deepEqual(
                track.samples.map(sample => sample.timestamp),
                [0, 0.04, 0.16, 0.2],
            );
            assert.deepEqual(
                track.samples.map(sample => sample.isKeyframe),
                [false, false, true, false],
            );
            assert.equal(diagnostics.warnings.length, 1);
            assert.equal(diagnostics.warnings[0].code, 'MP4_TRUNCATED_SAMPLES');
            assert.equal(diagnostics.warnings[0].offset, fixture.moovOffset);
            await assert.rejects(demux(bytes, compact), error => error.code === 'DEMUX');
        });
        test(`${mode}: invalid ranges above 32 bits cannot wrap into media`, async () => {
            const bytes = classicMp4({ offsets: [0xfffffffe] }).bytes;
            const diagnostics = new DiagnosticContext({ validation: 'compatible' });
            const track = await demux(bytes, compact, { allowEmptyTracks: true }, diagnostics);
            assert.equal(track.samples.length, 0);
            assert.equal(track.incomplete, true);
            assert.equal(diagnostics.warnings.length, 1);
        });
        test(`${mode}: sample and byte budgets reject oversized declarations`, async () => {
            const bytes = classicMp4().bytes;
            await assert.rejects(
                demux(bytes, compact, { maxSamples: 5 }),
                error => error.code === 'OOM',
            );
            await assert.rejects(
                demux(bytes, compact, { maxIndexBytes: 1 }),
                error => error.code === 'OOM',
            );
            await assert.rejects(
                demux(patchTable(bytes, 'stsz', 16, 0xffffffff), compact),
                error => error.code === 'OOM',
            );
        });
        for (const [type, at, value] of [
            ['stts', 16, 7],
            ['stts', 16, 5],
            ['stsc', 24, 2],
            ['stco', 12, 0xffffffff],
            ['ctts', 8, 0x02000000],
            ['ctts', 16, 7],
        ]) {
            test(`${mode}: malformed ${type} ${at} ${value} rejects`, async () => {
                const bytes = classicMp4({ composition: [[6, 0]] }).bytes;
                await assert.rejects(demux(patchTable(bytes, type, at, value), compact), error =>
                    ['DEMUX', 'OOM'].includes(error.code),
                );
            });
        }
    }
    test('compact: fractional sample access agrees with array access', async () => {
        const track = await demux(classicMp4().bytes, true);
        assert.equal(sampleAt(track, 0.5), undefined);
        assert.equal(sampleAt(track, -1), undefined);
        assert.equal(sampleAt(track, 6), undefined);
    });
    test('compact: sparse co64 media above 4 GiB retains exact offsets', async () => {
        const base = 0x100000000 + 40;
        const fixture = classicMp4({ co64: true, offsets: [base] });
        const moov = fixture.bytes.slice(fixture.moovOffset);
        const header = Buffer.alloc(40);
        header.set(fixture.bytes.subarray(0, 24));
        header.writeUInt32BE(1, 24);
        header.write('mdat', 28);
        header.writeBigUInt64BE(BigInt(base + 24 - 24), 32);
        const ranges = [
            [0, header],
            [base, fixture.bytes.subarray(32, 56)],
            [base + 24, moov],
        ];
        const source = {
            size: base + 24 + moov.length,
            read: async (offset, length) => {
                const bytes = new Uint8Array(length);
                for (const [start, data] of ranges) {
                    const from = Math.max(offset, start);
                    const to = Math.min(offset + length, start + data.length);
                    if (to > from)
                        bytes.set(data.subarray(from - start, to - start), from - offset);
                }
                return bytes;
            },
        };
        const track = (await enableCompactSampleIndex(new Mp4Demuxer()).demux(source))
            .audioTracks[0];
        const index = getCompactSampleIndex(track);
        assert.equal(index.get(5).offset, 4294967356);
        assert.deepEqual(
            Array.from(await source.read(index.get(5).offset, 4)),
            [192, 203, 214, 225],
        );
    });
    test('engine: reordered presentation seeks preserve decode-order packet identity', async () => {
        const fixture = classicMp4({
            composition: [
                [1, 40],
                [1, -40],
                [4, 0],
            ],
            sync: [1, 4],
            timing: [
                [2, 40],
                [3, 20],
                [1, 80],
            ],
            edits: [
                [100, -1],
                [240, 20],
            ],
        });
        const file = await open(fixture.bytes, { validation: 'strict' });
        try {
            const packets = [];
            for await (const packet of file.packets()) packets.push(packet);
            assert.equal(packets.length, 6);
            assert(
                packets.every(
                    (packet, at) => !at || packet.decodeTimestamp > packets[at - 1].decodeTimestamp,
                ),
            );
            // The place in decode order of the packet packetAt() finds.
            const at = async (time, options) => {
                const packet = await file.packetAt(1, time, options);
                return (
                    packet &&
                    packets.findIndex(item => item.decodeTimestamp === packet.decodeTimestamp)
                );
            };
            assert.equal(await at(0.11), 1);
            assert.equal(await at(0.11, { mode: 'after' }), 0);
            assert.equal(await at(0.19, { keyframe: true }), 3);
            assert.equal(await at(0.19, { keyframe: true, mode: 'after' }), undefined);
            assert.deepEqual(Array.from(packets[3].data), [118, 129, 140, 151]);
            assert.deepEqual(
                (await file.packetAt(1, 0.19, { keyframe: true })).data,
                packets[3].data,
            );
        } finally {
            file.close();
        }
    });
    test('demux cancellation rejects without returning a partial index', async () => {
        const controller = new AbortController();
        const pending = enableCompactSampleIndex(new Mp4Demuxer()).demux(
            fixtureSource(classicMp4({ count: 100000 }).bytes),
            controller.signal,
        );
        setImmediate(() => controller.abort());
        await assert.rejects(pending, error => error.code === 'ABORT');
    });
    test('independent concurrent opens isolate tables and preserve source failures', async () => {
        const reader = enableCompactSampleIndex(new Mp4Demuxer());
        const results = await Promise.all(
            [3, 7, 2, 11].map(count => reader.demux(fixtureSource(classicMp4({ count }).bytes))),
        );
        assert.deepEqual(
            results.map(result => getCompactSampleIndex(result.audioTracks[0]).length),
            [3, 7, 2, 11],
        );
        const failure = new Error('fixture source unavailable');
        await assert.rejects(
            reader.demux({
                size: 64,
                read: async () => {
                    throw failure;
                },
            }),
            error => error === failure,
        );
    });
    test('compact: random chunk seeks and sync bits cross byte boundaries', async () => {
        const track = await demux(
            classicMp4({
                count: 65,
                chunkSamples: [2, 31, 32],
                gapBytes: 3,
                sync: [1, 8, 9, 32, 33, 64, 65],
            }).bytes,
            true,
        );
        const index = getCompactSampleIndex(track);
        const positions = [64, 0, 31, 32, 8, 7, 63];
        assert.deepEqual(
            positions.map(position => index.get(position).offset),
            [294, 32, 159, 163, 67, 63, 290],
        );
        assert.deepEqual(
            positions.map(position => index.timestampAt(position)),
            [2.56, 0, 1.24, 1.28, 0.32, 0.28, 2.52],
        );
        assert(positions.every(position => index.isKeyframeAt(position)));
        assert([1, 2, 6, 9, 30, 62].every(position => !index.isKeyframeAt(position)));
        assert.equal(index.allKeyframes, false);
        assert.equal(index.firstPresentation, 0);
        assert.equal(index.lastPresentationEnd, 2.6);
    });
    test('compact: constant chunk recovery preserves every complete sample', async () => {
        const fixture = classicMp4({ count: 12, chunkSamples: [4, 4, 4] });
        const bytes = patchTable(fixture.bytes, 'stco', 20, fixture.moovOffset - 8);
        const diagnostics = new DiagnosticContext({ validation: 'compatible' });
        const track = await demux(bytes, true, {}, diagnostics);
        const index = getCompactSampleIndex(track);
        assert.equal(index.length, 10);
        assert.deepEqual(
            Array.from({ length: index.length }, (_, position) => index.get(position).timestamp),
            [0, 0.04, 0.08, 0.12, 0.16, 0.2, 0.32, 0.36, 0.4, 0.44],
        );
        assert.equal(index.get(6).offset, 64);
        assert.equal(diagnostics.warnings[0].offset, fixture.moovOffset);
    });

    describe('long tracks', () => {
        const FRAME = Uint8Array.of(1, 24, 32, 7);
        const CONFIG = Uint8Array.of(17, 136);

        test('an hour of AAC in M4A reads alike with 8 MiB of free space after it', async () => {
            // 168750 frames of 1024 samples at 48 kHz, read in strict validation.
            const count = 168750;
            const sink = new MemorySink();
            const muxer = new Mp4Muxer(
                {
                    format: 'm4a',
                    mode: 'standard',
                    autoSync: true,
                    maxFragmentDuration: 10,
                    audio: {
                        id: 1,
                        type: 'audio',
                        codec: 'mp4a.40.2',
                        codecConfig: CONFIG,
                        sampleRate: 48000,
                        channelCount: 1,
                    },
                },
                sink,
            );
            for (let index = 0; index < count; index++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: FRAME,
                    timestamp: (index * 1024) / 48000,
                    duration: 1024 / 48000,
                    isKeyframe: true,
                });
            await muxer.finalize();
            const bytes = sink.toUint8Array();
            const padded = new Uint8Array(bytes.length + 8 * 1024 * 1024);
            padded.set(bytes);
            new DataView(padded.buffer).setUint32(bytes.length, 8 * 1024 * 1024);
            padded.set([102, 114, 101, 101], bytes.length + 4);
            const options = { open: { validation: 'strict' }, sampleCounts: true };
            const [original, extended] = await Promise.all(
                [bytes, padded].map(input => inspect(input, options)),
            );
            assert.deepEqual(
                [original.tracks[0].sampleCount, original.tracks[0].duration],
                [count, 3600],
            );
            assert.deepEqual(extended.tracks, original.tracks);
            for (const input of [bytes, padded]) {
                const media = await open(input, { validation: 'strict' });
                try {
                    for (const index of [0, count - 1]) {
                        const packet = await media.packetAt(1, (index * 1024) / 48000);
                        assert.deepEqual(packet.data, FRAME);
                    }
                } finally {
                    media.close();
                }
            }
        });

        test('fragmented AAC of 8192 samples reads its last', async () => {
            const writer = new CmafWriter({
                tracks: [
                    {
                        id: 1,
                        type: 'audio',
                        codec: 'mp4a.40.2',
                        codecConfig: CONFIG,
                        timescale: 48000,
                        sampleRate: 48000,
                        channelCount: 1,
                    },
                ],
            });
            const init = writer.createInitSegment();
            for (let index = 0; index < 8192; index++)
                writer.addSample({
                    trackId: 1,
                    data: FRAME,
                    decodeTimestamp: index * 1024,
                    duration: 1024,
                    isKeyframe: true,
                });
            const bytes = new Blob([init, writer.flush().data]);
            const info = await inspect(bytes, {
                open: { validation: 'strict' },
                sampleCounts: true,
            });
            assert.equal(info.tracks[0].sampleCount, 8192);
            const media = await open(bytes, { validation: 'strict' });
            try {
                assert.deepEqual((await media.packetAt(1, (8191 * 1024) / 48000)).data, FRAME);
            } finally {
                media.close();
            }
        });
    });
});
