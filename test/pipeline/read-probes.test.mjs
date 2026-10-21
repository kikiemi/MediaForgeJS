import assert from 'node:assert/strict';
import { createAacFixture } from '../helpers/legacy-audio-fixture.mjs';
import { LONG_TS_AUDIO, longTransportStream, manyFragmentsMp4 } from '../helpers/huge-sources.mjs';
import { openFile } from '../helpers/engine.mjs';
import { describe, test } from 'node:test';
import { BufferSource, ConcatSource, MemorySink } from 'mediaforgejs/io';
import { Mp4Demuxer, Mp4Muxer, TsMuxer, WebMMuxer } from 'mediaforgejs/formats';
import { convert, inspect, open, thumbnail } from 'mediaforgejs';
import { distUrl } from '../helpers/dist-paths.mjs';
import { avcc } from '../helpers/avi-h264-fixtures.mjs';
import { largePicture } from '../helpers/large-ts-matroska.mjs';
import { PROBE_MIB, atFullScale, scaleProbeWindows } from '../helpers/probe-windows.mjs';
const { encoded } = await createAacFixture();

// The probe windows are scaled down (probe-windows.mjs): the sizes of the inputs that are probed
// and their byte bounds are in probe kibibytes and mebibytes.

scaleProbeWindows();

/** `count` probe kibibytes. */
const pkib = count => count * (PROBE_MIB / 1024);

/**
 * `bytes` with a free box of 256 KiB at the end of its movie box, its last top-level box: a movie
 * box large enough to be described (a smaller one is indexed at open).
 */
function paddedMovie(bytes) {
    const free = new Uint8Array(256 * 1024);
    new DataView(free.buffer).setUint32(0, free.length);
    free.set([0x66, 0x72, 0x65, 0x65], 4);
    const out = new Uint8Array(bytes.length + free.length);
    out.set(bytes);
    out.set(free, bytes.length);
    const view = new DataView(out.buffer);
    const moov = Buffer.from(bytes).lastIndexOf('moov') - 4;
    view.setUint32(moov, view.getUint32(moov) + free.length);
    return out;
}

describe('read: indexes and probes of large inputs', () => {
    test('a compact MP4 index bounds the open and reads its last packet', async () => {
        const count = 4096;
        const sink = new MemorySink();
        const writer = new Mp4Muxer(
            {
                format: 'mp4',
                audio: {
                    codec: 'mp4a.40.2',
                    sampleRate: 48000,
                    channelCount: 1,
                    codecConfig: Uint8Array.of(0x11, 0x88),
                },
            },
            sink,
        );
        const bytes = encoded.frames[0];
        for (let i = 0; i < count; i++)
            writer.addAudioChunk({
                trackType: 'audio',
                timestamp: (i * 1024) / 48000,
                duration: 1024 / 48000,
                isKeyframe: true,
                data: bytes,
            });
        await writer.finalize();
        const data = sink.toUint8Array();
        const compact = await openFile(data, { maxIndexBytes: count * 16 });
        assert.equal(compact.tracks[0].sampleCount, count);
        assert.deepEqual((await compact.readPacket(compact.tracks[0].id, count - 1)).data, bytes);
        assert.equal(
            compact.findSample(compact.tracks[0].id, ((count - 1) * 1024) / 48000),
            count - 1,
        );
        const eager = await new Mp4Demuxer().demux(new BufferSource(data));
        const { CORE_FORMATS } = await import(distUrl('esm/formats/core-formats.js'));
        const registeredMp4 = await CORE_FORMATS.readers.find(part => part.id === 'mp4').load();
        const direct = await registeredMp4.read(new BufferSource(data), {
            maxIndexBytes: count * 256,
        });
        assert.equal(
            direct.audioTracks[0].samples.length,
            count,
            'direct module materialization must not charge two indexes',
        );
        assert(Array.isArray(eager.audioTracks[0].samples));
        assert.equal(eager.audioTracks[0].samples.length, count);
        await assert.rejects(openFile(data, { maxIndexBytes: count * 4 }), e => e.code === 'OOM');
        await assert.rejects(openFile(data, { maxSamples: count - 1 }), e => e.code === 'OOM');
        compact.close();
    });

    test('a long fragmented MP4 is indexed in typed arrays within 60 bytes a sample', async () => {
        // A long fragmented file: 7,000 one-sample fragments (14,000 top-level boxes) are indexed
        // in typed arrays that fit 60 bytes a fragment of index budget, as 70,000 fit 4 MiB.
        const fragments = 7_000;
        const media = await openFile(manyFragmentsMp4({ fragments }), {
            maxIndexBytes: fragments * 60,
        });
        try {
            const track = media.tracks[0];
            assert.equal(track.sampleCount, fragments);
            assert(
                Math.abs(track.duration - (fragments * 1024) / 48000) < 1e-6,
                `duration ${track.duration}`,
            );
            for (const index of [0, 1, 4_097, fragments - 1]) {
                const packet = await media.readPacket(track.id, index);
                assert.equal(packet.data[0], index & 255);
                assert.equal(packet.timestamp, (index * 1024) / 48000);
                assert.equal(packet.duration, 1024 / 48000);
            }
        } finally {
            media.close();
        }
    });

    test('indexing a fragmented MP4 reads its box headers only', async () => {
        // Indexing a fragmented MP4 reads its box headers and fragment headers once, never the
        // media payloads between them: 2,000 fragments of 64 KiB (125 MiB) cost about one small
        // read each.
        const fragments = 2000;
        const generated = manyFragmentsMp4({ fragments, sampleBytes: 64 * 1024 });
        let readBytes = 0;
        let reads = 0;
        const source = {
            size: generated.size,
            read(offset, length) {
                reads++;
                readBytes += length;
                return generated.read(offset, length);
            },
        };
        const media = await openFile(source);
        try {
            assert.equal(media.tracks[0].sampleCount, fragments);
            assert(
                readBytes < fragments * 8192,
                `index read ${readBytes} bytes of ${generated.size}`,
            );
            assert(reads < fragments * 1.5, `index made ${reads} reads for ${fragments} fragments`);
            const packet = await media.readPacket(media.tracks[0].id, fragments - 1);
            assert.equal(packet.data[0], (fragments - 1) & 255);
            assert.equal(packet.data.length, 64 * 1024);
        } finally {
            media.close();
        }
    });

    test('an hour of MPEG-TS opens within a tenth of the default index budget', async () => {
        // An hour of MPEG-TS (H.264 at 30 pictures a second and 48 kHz AAC, 277,000 samples) opens
        // within a tenth of the default index budget, as ten hours open within it: the samples are
        // indexed in typed arrays and read back from their transport packets.
        const groups = 6_750;
        const media = await openFile(longTransportStream({ groups }), {
            maxIndexBytes: (128 * 2 ** 20) / 10,
        });
        try {
            const [video, audio] = media.tracks;
            assert.equal(video.sampleCount, 1 + groups * 16);
            assert.equal(audio.sampleCount, groups * 25);
            assert(Math.abs(video.duration - 3600.0333) < 1e-3, `duration ${video.duration}`);
            const picture = await media.readPacket(video.id, video.sampleCount - 1);
            assert.deepEqual([...picture.data], [0, 0, 0, 4, 0x41, 0xe2, 0x29, 0xc0]);
            assert.equal(picture.timestamp, 1 + (groups * 16) / 30);
            assert.equal(picture.isKeyframe, false);
            // The last audio frame is the 25th of its PES, whose frames cycle through
            // LONG_TS_AUDIO.
            const frame = await media.readPacket(audio.id, audio.sampleCount - 1);
            assert.deepEqual([...frame.data], [...LONG_TS_AUDIO[24 % LONG_TS_AUDIO.length]]);
            assert(Math.abs(frame.timestamp - (1 + ((groups * 25 - 1) * 1024) / 48000)) < 1e-6);
        } finally {
            media.close();
        }
    });

    test('inspect() describes a large MPEG-TS from its head and tail', async () => {
        // inspect() describes a large MPEG-TS from its head and tail: the tracks equal those of a
        // full index, without sampleCount, after reading the bytes of the 9 MiB input (24 minutes)
        // that it reads of a ten-hour one (122 MiB), but for a page or two; the decode times
        // between them are read from a few packets each.
        const counted = input => {
            const counter = { bytes: 0 };
            return {
                counter,
                source: {
                    size: input.size,
                    read(offset, length) {
                        counter.bytes += length;
                        return input.read(offset, length);
                    },
                },
            };
        };
        const stream = longTransportStream({ groups: 2_700 });
        const fast = counted(stream);
        const probed = await inspect(fast.source);
        const full = await inspect(stream, { sampleCounts: true });
        const long = counted(longTransportStream({ groups: 67_500 }));
        await inspect(long.source);
        assert(
            Math.abs(fast.counter.bytes - long.counter.bytes) <= 2 * 64 * 1024,
            `${fast.counter.bytes} and ${long.counter.bytes} bytes`,
        );
        assert(
            fast.counter.bytes < stream.size / 3,
            `inspect read ${fast.counter.bytes} of ${stream.size} bytes`,
        );
        assert.equal(probed.format, 'ts');
        assert.deepEqual(probed.warnings, []);
        assert.deepEqual(
            probed.tracks.map(track => track.sampleCount),
            [undefined, undefined],
        );
        assert.deepEqual(
            full.tracks.map(track => track.sampleCount),
            [1 + 2_700 * 16, 2_700 * 25],
        );
        assert.deepEqual(
            probed.tracks,
            full.tracks.map(({ sampleCount, ...track }) => track),
        );
        assert.equal(JSON.stringify(probed.tracks[0]).includes('sampleCount'), false);

        // Timestamps that start again in the middle (two recordings joined, 4 MiB each) cannot be
        // spanned from the ends: the probe finds them going back and indexes the whole input, which
        // reports the joined timeline.
        const half = longTransportStream({ groups: 1_250 });
        const joined = new ConcatSource([half, half]);
        const spliced = await inspect(joined);
        const splicedFull = await inspect(joined, { sampleCounts: true });
        assert.deepEqual(spliced, splicedFull);
        assert.equal(typeof spliced.tracks[0].sampleCount, 'number');
        assert(spliced.warnings.some(warning => warning.code === 'TS_TIMELINE_SPLICE'));
    });

    test('open() reads a large MPEG-TS as inspect() does and finds packets', async () => {
        // open() reads what inspect() reads: a large MPEG-TS (7 MiB) from its head and tail, its
        // tracks without sampleCount. The first packetAt() reads the index once and the Media keeps
        // it; the open's warnings reach the listener once, though the input is read again.
        const stream = longTransportStream({ groups: 2_000 });
        let probe = 0;
        await inspect({
            size: stream.size,
            read(offset, length) {
                probe += length;
                return stream.read(offset, length);
            },
        });
        let bytes = 0;
        const source = {
            size: stream.size,
            read(offset, length) {
                bytes += length;
                return stream.read(offset, length);
            },
        };
        const warnings = [];
        const media = await open(source, {
            onWarning: warning => warnings.push(warning.code),
            maxWarnings: 'many',
        });
        try {
            assert(
                bytes <= probe && bytes < stream.size / 2,
                `open() read ${bytes} of ${stream.size} bytes`,
            );
            assert.deepEqual(media.tracks, (await inspect(stream)).tracks);
            assert(media.tracks.every(track => !Object.hasOwn(track, 'sampleCount')));
            const [video, audio] = media.tracks;
            const first = await media.packetAt(audio.id, 0, { mode: 'after' });
            assert(bytes >= stream.size, `the index read ${bytes} of ${stream.size} bytes`);
            const indexed = bytes;
            const later = await media.packetAt(audio.id, first.timestamp + 60);
            const keyframe = await media.packetAt(video.id, first.timestamp + 60, {
                keyframe: true,
            });
            assert(bytes - indexed <= 2 ** 17, `two packets read ${bytes - indexed} bytes`);
            assert.deepEqual(warnings, ['OPTION_IGNORED']);
            assert.deepEqual(
                media.warnings.map(warning => warning.code),
                ['OPTION_IGNORED'],
            );

            // The packets found are those of a pass, presented at or before the times asked.
            const shown = [];
            for await (const packet of media.packets()) shown.push(packet);
            const last = (trackId, time, keyframes) =>
                shown
                    .filter(packet => packet.trackId === trackId && packet.timestamp <= time)
                    .filter(packet => !keyframes || packet.isKeyframe)
                    .sort((a, b) => a.timestamp - b.timestamp)
                    .at(-1);
            assert.deepEqual(later, last(audio.id, first.timestamp + 60));
            assert.deepEqual(keyframe, last(video.id, first.timestamp + 60, true));
            assert.equal(shown.length, 1 + 2_000 * 16 + 2_000 * 25);
        } finally {
            media.close();
        }
        await assert.rejects(media.packetAt(1, 0), error => error.code === 'ABORT');
    });

    test('inspect() describes a large Matroska file from its head and tail', async () => {
        // inspect() describes a large Matroska file from its head and the clusters at its tail,
        // walking the cluster headers between them when no SeekHead lists where its metadata is:
        // the tracks equal a full index.
        const { hugeAudioMp4 } = await import('../helpers/huge-sources.mjs');
        const source = hugeAudioMp4({ count: 1200, sampleBytes: pkib(64) });
        // A SeekHead and Cues place the tail's clusters without a walk to them.
        const sink = new MemorySink();
        const muxer = new WebMMuxer(
            {
                format: 'mkv',
                mode: 'standard',
                audio: {
                    codec: 'mp4a.40.2',
                    codecConfig: Uint8Array.of(0x11, 0x90),
                    sampleRate: 48000,
                    channelCount: 2,
                },
            },
            sink,
        );
        const frame = new Uint8Array(pkib(64));
        for (let index = 0; index < 1200; index++)
            muxer.addAudioChunk({
                trackType: 'audio',
                data: frame,
                timestamp: (index * 1024) / 48000,
                duration: 1024 / 48000,
                isKeyframe: true,
            });
        await muxer.finalize();
        const indexed = sink.toUint8Array();
        let cuesRead = 0;
        const withCues = await inspect({
            size: indexed.length,
            async read(offset, length) {
                cuesRead += length;
                return indexed.slice(offset, offset + length);
            },
        });
        assert(cuesRead < 16 * PROBE_MIB, `inspect read ${cuesRead} of ${indexed.length} bytes`);
        assert.deepEqual(withCues.tracks, (await inspect(indexed)).tracks);
        assert.equal(withCues.tracks[0].sampleCount, undefined);
        const bytes = new Uint8Array(await (await convert(source, 'mkv')).blob.arrayBuffer());
        let readBytes = 0;
        const counted = {
            size: bytes.length,
            async read(offset, length) {
                readBytes += length;
                return bytes.slice(offset, offset + length);
            },
        };
        const probed = await inspect(counted);
        const full = await inspect(bytes, { sampleCounts: true });
        assert(readBytes < 16 * PROBE_MIB, `inspect read ${readBytes} of ${bytes.length} bytes`);
        assert.equal(probed.tracks[0].sampleCount, undefined);
        assert.equal(full.tracks[0].sampleCount, 1200);
        assert.deepEqual(probed, {
            ...full,
            tracks: full.tracks.map(({ sampleCount, ...track }) => track),
        });
        // A file cut inside its last cluster is damaged: it is read whole and reports what a full
        // read reports.
        const cut = bytes.subarray(0, bytes.length - 1000);
        const damaged = await inspect(cut);
        assert.deepEqual(damaged, await inspect(cut, { sampleCounts: true }));
        assert.equal(typeof damaged.tracks[0].sampleCount, 'number');
        assert(damaged.warnings.length > 0);
    });

    test('a Matroska copy in windows keeps a track absent from the middle', async () => {
        // A copy of a large Matroska file reads it once in windows of clusters. A track whose
        // blocks lie only at its ends has none in the windows between them, which neither omit it
        // nor make a strict copy fail.
        const sink = new MemorySink();
        const audio = {
            codec: 'mp4a.40.2',
            codecConfig: Uint8Array.of(0x11, 0x90),
            sampleRate: 48000,
            channelCount: 2,
        };
        const muxer = new WebMMuxer(
            { format: 'mkv', mode: 'standard', audio, extraAudioTracks: [audio] },
            sink,
        );
        const frame = new Uint8Array(6000);
        const chunk = index => ({
            trackType: 'audio',
            data: frame,
            timestamp: (index * 1024) / 48000,
            duration: 1024 / 48000,
            isKeyframe: true,
        });
        for (let index = 0; index < 1000; index++) {
            muxer.addAudioChunk(chunk(index));
            if (index < 3 || index >= 997) muxer.addExtraAudioChunk(0, chunk(index));
        }
        await muxer.finalize();
        const bytes = sink.toUint8Array();
        const warnings = [];
        const { blob, plan } = await convert(bytes, 'mkv', {
            onWarning: warning => warnings.push(warning.code),
            open: { validation: 'strict' },
        });
        assert.equal(plan.action, 'copy');
        assert.deepEqual(warnings, []);
        assert.deepEqual(
            (await inspect(blob, { sampleCounts: true })).tracks.map(track => track.sampleCount),
            [1000, 6],
        );
    });

    test('a WebM range with Opus is copied from a window around it', async () => {
        // A range of a large WebM with Opus (a codec delay) is copied from a window around it, as
        // the Cues place it, into the bytes a copy from the full index writes. Audio packets run 7
        // ms off the 5 s keyframes, so the packet that starts the audio lies in the cluster before
        // the cut.
        const sink = new MemorySink();
        const head = new Uint8Array(19);
        head.set(new TextEncoder().encode('OpusHead'));
        head.set([1, 2, 0x38, 0x01, 0x80, 0xbb], 8);
        const muxer = new WebMMuxer(
            {
                format: 'webm',
                mode: 'standard',
                video: { id: 1, type: 'video', codec: 'vp8', width: 64, height: 48, framerate: 10 },
                audio: { codec: 'opus', codecConfig: head, sampleRate: 48000, channelCount: 2 },
            },
            sink,
        );
        const frame = new Uint8Array(4096);
        const sound = Uint8Array.of(0xfc, 1, 2, 3);
        for (let index = 0; index < 8000; index++) {
            muxer.addVideoChunk({
                data: frame,
                timestamp: index / 10,
                duration: 0.1,
                isKeyframe: index % 50 === 0,
                trackType: 'video',
            });
            for (let part = 0; part < 5; part++)
                muxer.addAudioChunk({
                    data: sound,
                    timestamp: 0.007 + index / 10 + part / 50,
                    duration: 0.02,
                    isKeyframe: true,
                    trackType: 'audio',
                });
        }
        await muxer.finalize();
        const bytes = sink.toUint8Array();
        const range = { start: 403, end: 408 };
        const media = await open(bytes);
        const full = new Uint8Array(await (await media.convert(range)).blob.arrayBuffer());
        media.close();
        let read = 0;
        const windowed = await convert(
            {
                size: bytes.length,
                async read(offset, length) {
                    read += length;
                    return bytes.slice(offset, offset + length);
                },
            },
            range,
        );
        assert(read < bytes.length / 2, `${read} of ${bytes.length} bytes read`);
        assert.deepEqual(new Uint8Array(await windowed.blob.arrayBuffer()), full);
    });

    test('inputs of every size are described as a full read describes them', async t => {
        atFullScale(t);
        // Every size reads the same way: a small MPEG-TS, Matroska file or Ogg stream is described
        // without sampleCount too, its tracks equal to a full read; `sampleCounts: true` counts the
        // packets.
        const { hugeAudioMp4 } = await import('../helpers/huge-sources.mjs');
        const { oggPage, oggFixture, concat } = await import('../helpers/original-fixtures.mjs');
        const reading = input => {
            const counter = { bytes: 0, reads: 0 };
            const bytes = input instanceof Uint8Array ? input : undefined;
            return {
                counter,
                source: {
                    size: bytes ? bytes.length : input.size,
                    async read(offset, length) {
                        counter.bytes += length;
                        counter.reads++;
                        return bytes
                            ? bytes.slice(offset, offset + length)
                            : input.read(offset, length);
                    },
                },
            };
        };
        const sameAsFull = async (input, label) => {
            const probed = await inspect(input);
            const full = await inspect(input, { sampleCounts: true });
            assert(
                full.tracks.every(track => typeof track.sampleCount === 'number'),
                `${label}: counted`,
            );
            assert.deepEqual(
                probed,
                { ...full, tracks: full.tracks.map(({ sampleCount, ...track }) => track) },
                label,
            );
            return probed;
        };
        const transport = longTransportStream({ groups: 400 });
        await sameAsFull(transport, 'small TS');
        const matroska = new Uint8Array(
            await (
                await convert(hugeAudioMp4({ count: 40, sampleBytes: 4096 }), 'mkv')
            ).blob.arrayBuffer(),
        );
        await sameAsFull(matroska, 'small Matroska');
        // An input whose head and tail would meet is read whole without trying its ends first: in
        // no more requests than counting its packets takes.
        for (const [input, label] of [
            [matroska, 'small Matroska'],
            [transport, 'small TS'],
        ]) {
            const [described, counted] = [reading(input), reading(input)];
            await inspect(described.source);
            await inspect(counted.source, { sampleCounts: true });
            assert(
                described.counter.reads <= counted.counter.reads,
                `${label}: ${described.counter.reads} reads, ${counted.counter.reads} counting`,
            );
        }
        await sameAsFull(oggFixture(), 'three-packet Ogg');

        // An Ogg Opus stream of 1,500 packets (600 kB): its tail's last granule gives the duration
        // a full read gives.
        const ascii = text => Uint8Array.from(text, character => character.charCodeAt(0));
        const le = (value, bytes) =>
            Uint8Array.from({ length: bytes }, (_, index) => (value >>> (8 * index)) & 255);
        const opusStream = (serial, packetsPerPage = 100, pageCount = 15) => {
            const head = concat(ascii('OpusHead'), [1, 2], le(312, 2), le(48000, 4), le(0, 2), [0]);
            const vendor = ascii('MediaForgeJS-probe');
            const tags = concat(
                ascii('OpusTags'),
                le(vendor.length, 4),
                vendor,
                le(1, 4),
                le(10, 4),
                ascii('TITLE=Edge'),
            );
            const pages = [
                oggPage([head], 0, { flags: 2, serial }),
                oggPage([tags], 1, { serial }),
            ];
            for (let page = 0; page < pageCount; page++) {
                const packets = Array.from({ length: packetsPerPage }, (_, index) => {
                    const packet = new Uint8Array(400).fill((page * 7 + index) & 255);
                    packet[0] = 0x80;
                    return packet;
                });
                const last = page === pageCount - 1;
                pages.push(
                    oggPage(packets, page + 2, {
                        flags: last ? 4 : 0,
                        granule: (page + 1) * packetsPerPage * 120 - (last ? 50 : 0),
                        serial,
                    }),
                );
            }
            return concat(...pages);
        };
        const ogg = opusStream(0x4d463431);
        const counted = reading(ogg);
        await inspect(counted.source);
        assert(
            counted.counter.bytes < ogg.length,
            `the probe read ${counted.counter.bytes} of ${ogg.length} bytes`,
        );
        const probed = await sameAsFull(ogg, 'Ogg Opus');
        assert.equal(probed.title, 'Edge');
        assert.equal(probed.tracks[0].duration, (15 * 100 * 120 - 50 - 312) / 48000);
        // A chain of two streams is read whole: its tail belongs to another logical stream.
        const chained = concat(opusStream(1, 100, 8), opusStream(2, 100, 8));
        const whole = await inspect(chained);
        assert.equal(typeof whole.tracks[0].sampleCount, 'number');
        assert(whole.warnings.some(warning => warning.code === 'OGG_CHAINED_STREAMS'));
    });

    test('thumbnail() of a large TS or Matroska reads around its picture', async () => {
        // thumbnail() of a large MPEG-TS or Matroska reads the head and tail and then only the
        // packets around the picture it decodes; the picture equals the one an indexed file gives,
        // also before the first and after the last.
        for (const [Muxer, format] of [
            [TsMuxer, 'ts'],
            [WebMMuxer, 'mkv'],
        ]) {
            const sink = new MemorySink();
            const muxer = new Muxer(
                {
                    format,
                    mode: 'standard',
                    autoSync: true,
                    video: {
                        id: 1,
                        type: 'video',
                        codec: 'avc1.42c00a',
                        codecConfig: avcc(),
                        width: 64,
                        height: 48,
                        framerate: 30,
                    },
                },
                sink,
            );
            // 1,100 pictures of 64 probe KiB (36.7 s, about 70 probe MiB) with a keyframe each
            // second.
            for (let index = 0; index < 1100; index++)
                muxer.addVideoChunk({
                    trackType: 'video',
                    data: largePicture(index),
                    timestamp: index / 30,
                    duration: 1 / 30,
                    isKeyframe: index % 30 === 0,
                });
            await muxer.finalize();
            const bytes = sink.toUint8Array();
            let readBytes = 0;
            const source = {
                size: bytes.length,
                async read(offset, length) {
                    readBytes += length;
                    return bytes.slice(offset, offset + length);
                },
            };
            const indexed = await open(bytes);
            try {
                for (const time of [0, 10.4, 20, 36.6, 50]) {
                    readBytes = 0;
                    const picture = new Uint8Array(
                        await (await thumbnail(source, { time })).blob.arrayBuffer(),
                    );
                    const expected = new Uint8Array(
                        await (await indexed.thumbnail({ time })).blob.arrayBuffer(),
                    );
                    assert.deepEqual(picture, expected, `${format} picture at ${time} s`);
                    if (time > 0 && time < 30)
                        assert(
                            readBytes < bytes.length * 0.6,
                            `${format} at ${time} s read ${readBytes} bytes`,
                        );
                }
            } finally {
                indexed.close();
            }
        }
    });

    test('a fragmented MP4 with a fragment index opens from its ends', async t => {
        atFullScale(t);
        // A large fragmented MP4 with a fragment index (mfra) opens from its movie box, the index,
        // its first fragments and its last: the description equals that of a read of every
        // fragment, and packets found by time come from the fragments the index places around them,
        // timed by their tfdt, as the index finds them.
        const { engineWith } = await import('../helpers/engine.mjs');
        const { filler, idr, lengthPrefixed, predicted } =
            await import('../helpers/avi-h264-fixtures.mjs');
        const engine = await engineWith([]);
        const sink = new MemorySink();
        const muxer = new Mp4Muxer(
            {
                format: 'mp4',
                mode: 'fragmented',
                video: {
                    codec: 'avc1.42c00a',
                    codecConfig: avcc(),
                    width: 64,
                    height: 48,
                    framerate: 30,
                },
                audio: {
                    codec: 'mp4a.40.2',
                    sampleRate: 48000,
                    channelCount: 1,
                    codecConfig: Uint8Array.of(0x11, 0x88),
                },
            },
            sink,
        );
        for (let index = 0, sound = 0; index < 900; index++) {
            for (; (sound * 1024) / 48000 < index / 30; sound++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: encoded.frames[sound % encoded.frames.length],
                    timestamp: (sound * 1024) / 48000,
                    duration: 1024 / 48000,
                    isKeyframe: true,
                });
            muxer.addVideoChunk({
                trackType: 'video',
                data: lengthPrefixed(4, index % 30 ? predicted : idr, filler(8 * 1024)),
                timestamp: index / 30,
                duration: 1 / 30,
                isKeyframe: index % 30 === 0,
            });
        }
        await muxer.finalize();
        const written = sink.toUint8Array();

        // The fragment index: each moof's position with the tfdt of each of its track fragments.
        const view = new DataView(written.buffer, written.byteOffset, written.byteLength);
        const type = at => String.fromCharCode(...written.subarray(at + 4, at + 8));
        const entries = new Map();
        for (let at = 0; at < written.length; at += view.getUint32(at)) {
            if (type(at) !== 'moof') continue;
            for (let traf = at + 8; traf < at + view.getUint32(at); traf += view.getUint32(traf)) {
                if (type(traf) !== 'traf') continue;
                let track;
                let time;
                for (let child = traf + 8; child < traf + view.getUint32(traf);) {
                    if (type(child) === 'tfhd') track = view.getUint32(child + 12);
                    if (type(child) === 'tfdt')
                        time =
                            written[child + 8] === 1
                                ? Number(view.getBigUint64(child + 12))
                                : view.getUint32(child + 12);
                    child += view.getUint32(child);
                }
                if (!entries.has(track)) entries.set(track, []);
                entries.get(track).push([time, at]);
            }
        }
        const box = (name, ...parts) => {
            const body = Buffer.concat(parts);
            const out = Buffer.alloc(8 + body.length);
            out.writeUInt32BE(out.length);
            out.write(name, 4, 'latin1');
            body.copy(out, 8);
            return out;
        };
        const tfras = [...entries].map(([track, list]) => {
            const body = Buffer.alloc(16 + list.length * 19);
            body.writeUInt32BE(0x01000000, 0);
            body.writeUInt32BE(track, 4);
            body.writeUInt32BE(list.length, 12);
            list.forEach(([time, position], index) => {
                body.writeBigUInt64BE(BigInt(time), 16 + index * 19);
                body.writeBigUInt64BE(BigInt(position), 24 + index * 19);
                body.fill(1, 32 + index * 19, 35 + index * 19);
            });
            return box('tfra', body);
        });
        const tail = Buffer.alloc(8);
        const indexBytes = Buffer.concat(tfras).length + 8 + 16;
        tail.writeUInt32BE(indexBytes, 4);
        const fragmented = Buffer.concat([written, box('mfra', ...tfras, box('mfro', tail))]);
        assert(fragmented.length > 4 * 2 ** 20 && entries.get(1).length === 15);

        const described = await engine.open(fragmented, {}, [], {});
        const indexed = await engine.open(fragmented);
        assert.equal(described.probedInput, true);
        assert.deepEqual(described.uncountedTracks, indexed.uncountedTracks);
        described.close();

        let reads = 0;
        let bytes = 0;
        const media = await open({
            size: fragmented.length,
            read: async (offset, length) => {
                reads++;
                bytes += length;
                return fragmented.slice(offset, offset + length);
            },
        });
        const opening = reads;
        const opened = bytes;
        try {
            assert(opening < 20, `open() read ${opening} times`);
            for (const time of [0.5, 9.95, 14, 21.37, 29.9])
                for (const trackId of [1, 2])
                    for (const options of [{}, { keyframe: true }, { mode: 'after' }])
                        assert.deepEqual(
                            await media.packetAt(trackId, time, options),
                            await indexed.packetAt(trackId, time, options),
                            `track ${trackId} at ${time} ${JSON.stringify(options)}`,
                        );
            // A search reads the moof boxes of the fragments the index places around its time and
            // the packet it finds, not the media data of those fragments (a window file read it
            // all).
            assert(
                bytes - opened < fragmented.length / 3,
                `30 searches read ${bytes - opened} B of ${fragmented.length}`,
            );
        } finally {
            media.close();
            indexed.close();
        }
    });

    test('a large movie box is described, its tables built on the first read', async () => {
        // open() describes a movie without fragments from a movie box of 256 KiB or more: its
        // sample tables are checked but not built, and the first read of a packet builds them from
        // the movie box read again. That index is the file a full read gives (every sample, the
        // descriptions, warnings, start and index bytes), and inspect() still counts the samples.
        // The open fails on the index limits as a full read does.
        const { mediaContext, mediaReading } = await import(distUrl('esm/api/handles.js'));
        const { sampleAt } = await import(distUrl('esm/core/model/sample-index.js'));
        const { mediaFileState } = await import('../helpers/engine.mjs');
        const { classicMp4 } = await import('../helpers/mp4-fixture.mjs');
        const sizes = Array.from({ length: 100 }, (_, index) => 3 + (index % 7));
        const movie = classicMp4({ sizes, chunkSamples: [30, 30, 40], edits: [[3960, 40]] });
        const { moovOffset } = movie;
        const bytes = paddedMovie(movie.bytes);
        const reads = [];
        const source = {
            size: bytes.length,
            async read(offset, length) {
                reads.push(offset);
                return bytes.slice(offset, offset + length);
            },
        };
        const movieReads = () => reads.filter(offset => offset === moovOffset).length;
        const full = await openFile(bytes);
        const counted = await inspect(source);
        assert.deepEqual(counted, await inspect(bytes, { sampleCounts: true }));
        assert.equal(counted.tracks[0].sampleCount, 100);
        const media = await open(source);
        try {
            assert.equal(mediaContext(media).file.probedInput, true, 'open() describes the movie');
            assert.deepEqual(media.tracks, full.uncountedTracks);
            assert.equal(media.duration, full.duration);
            assert.deepEqual(media.warnings, []);
            const described = movieReads();
            const [track] = media.tracks;
            assert.deepEqual(await media.packetAt(track.id, 2), await full.packetAt(track.id, 2));
            assert.equal(movieReads(), described + 1, 'the first packet builds the tables');
            const index = mediaReading(media).indexed;
            assert.equal(index.probedInput, false);
            for (const field of ['tracks', 'warnings', 'timelineStart', 'retainedIndexBytes'])
                assert.deepEqual(index[field], full[field], field);
            const [ours, theirs] = [index, full].map(file => mediaFileState(file).tracks[0].info);
            for (let at = 0; at < sizes.length; at++)
                assert.deepEqual(sampleAt(ours, at), sampleAt(theirs, at), `sample ${at}`);
            let listed = 0;
            for await (const packet of media.packets())
                listed += packet.data.length === sizes[listed];
            assert.equal(listed, sizes.length);
            assert.equal(movieReads(), described + 1, 'the Media keeps the index');
        } finally {
            media.close();
            full.close();
        }
        for (const limits of [{ maxSamples: 99 }, { maxIndexBytes: 1024 }, { maxPacketBytes: 8 }]) {
            const failed = error => error.code === 'OOM';
            await assert.rejects(open(bytes, limits), failed, JSON.stringify(limits));
            await assert.rejects(openFile(bytes, limits), failed, JSON.stringify(limits));
        }

        // The tables a described open builds report nothing new: the open's warnings reach the
        // listener once and stay the Media's, and a copy that reads the index adds none and writes
        // what a copy of the input writes.
        const heard = [];
        const noted = await open(new Blob([bytes]), {
            onWarning: warning => heard.push(warning.code),
            maxWarnings: 'many',
        });
        try {
            const copy = await noted.convert('mp4');
            assert.deepEqual(heard, ['OPTION_IGNORED']);
            assert.deepEqual(
                noted.warnings.map(warning => warning.code),
                ['OPTION_IGNORED'],
            );
            assert.deepEqual(copy.warnings, []);
            assert.deepEqual(
                new Uint8Array(await copy.blob.arrayBuffer()),
                new Uint8Array(await (await convert(bytes, 'mp4')).blob.arrayBuffer()),
            );
        } finally {
            noted.close();
        }
    });

    test('movies a description cannot match are read whole at open', async () => {
        // A movie the description could not match is read whole at open, as before: two sample
        // descriptions, a chapter track, an edit list that splices the media, a sample outside the
        // media (whose warning the open reports once), and a movie box under 256 KiB, whose tables
        // are built in less time than a description saves. It is counted and reports what the read
        // finds.
        const { mediaContext } = await import(distUrl('esm/api/handles.js'));
        const { classicMp4 } = await import('../helpers/mp4-fixture.mjs');
        const { preservationFixture } = await import('../helpers/mp4-preservation-fixture.mjs');
        const plain = classicMp4({ sizes: [4, 5, 6, 7, 8, 9] }).bytes;
        const outside = classicMp4({ sizes: [4, 4, 4, 4, 4, 4], chunkSamples: [3, 3] }).bytes;
        const at = (bytes, type) => Buffer.from(bytes).indexOf(type) - 4;
        const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        view(outside).setUint32(at(outside, 'stco') + 20, outside.length + 1000);
        // The one sample description twice: the boxes around it grow by its size.
        const stsd = at(plain, 'stsd');
        const entry = plain.subarray(stsd + 16, stsd + view(plain).getUint32(stsd));
        const twice = new Uint8Array(plain.length + entry.length);
        twice.set(plain.subarray(0, stsd + 16 + entry.length));
        twice.set(entry, stsd + 16 + entry.length);
        twice.set(plain.subarray(stsd + 16 + entry.length), stsd + 16 + 2 * entry.length);
        for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])
            view(twice).setUint32(
                at(twice, type),
                view(twice).getUint32(at(twice, type)) + entry.length,
            );
        view(twice).setUint32(stsd + 12, 2);
        const chapters = preservationFixture({
            tracks: [
                { type: 'video', chapters: [3] },
                { type: 'audio' },
                {
                    type: 'subtitle',
                    id: 3,
                    codec: 'tx3g',
                    packets: [Buffer.of(0, 1, 0x41), Buffer.of(0, 1, 0x42), Buffer.of(0, 1, 0x43)],
                },
            ],
        }).bytes;
        const spliced = preservationFixture({
            tracks: [
                {
                    type: 'video',
                    packets: Array.from({ length: 6 }, (_, index) =>
                        Buffer.of(0, 0, 0, 2, 0x65, 0x80 | index),
                    ),
                    edits: [
                        { duration: 40, mediaTime: 0 },
                        { duration: 40, mediaTime: 120 },
                    ],
                },
            ],
        }).bytes;
        for (const [name, bytes, codes] of [
            ['two descriptions', paddedMovie(twice), []],
            ['a chapter track', paddedMovie(chapters), []],
            ['a spliced edit list', paddedMovie(spliced), []],
            ['a sample outside the media', paddedMovie(outside), ['MP4_TRUNCATED_SAMPLES']],
            ['a small movie box', plain, []],
        ]) {
            const heard = [];
            const media = await open(bytes, { onWarning: warning => heard.push(warning.code) });
            const full = await openFile(bytes);
            try {
                assert.equal(mediaContext(media).file.probedInput, false, name);
                assert.deepEqual(media.tracks, full.uncountedTracks, name);
                assert.deepEqual(media.warnings, full.warnings, name);
                for await (const packet of media.packets()) void packet;
                assert.deepEqual(heard, codes, name);
            } finally {
                media.close();
                full.close();
            }
            const counted = await inspect(bytes);
            assert.deepEqual(counted, await inspect(bytes, { sampleCounts: true }), name);
            assert(
                counted.tracks.every(track => typeof track.sampleCount === 'number'),
                name,
            );
        }
    });
});
