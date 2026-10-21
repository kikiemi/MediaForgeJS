import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convert, inspect } from 'mediaforgejs';
import { TsMuxer, WebMMuxer } from 'mediaforgejs/formats';
import { BufferSource, MemorySink } from 'mediaforgejs/io';
import { longTransportStream } from '../helpers/huge-sources.mjs';
import {
    counted,
    indexedCopy,
    muxedWithAudio,
    packetsOf,
    probeBytes,
} from '../helpers/large-ts-matroska.mjs';
import { filler } from '../helpers/avi-h264-fixtures.mjs';
import { MiB, PROBE_MIB, atFullScale, scaleProbeWindows } from '../helpers/probe-windows.mjs';

// convert() of a large MPEG-TS or Matroska into MP4 reads the input once in file order, without an
// index first, and writes what an indexed copy writes; a trim reads the window around its range. A
// destination that cannot be patched gets fragmented MP4 instead of a second read. The pass reads
// 1 MiB at a time, so the bytes it holds stay a few megabytes however long the input is. The
// inputs (about 70 probe megabytes, see probe-windows.mjs) are large against the probe windows.

scaleProbeWindows();

/** `make()` once, on first use. */
const once = make => {
    let made;
    return () => (made ??= make());
};
const matroska = once(() => muxedWithAudio(WebMMuxer, 'mkv'));
const transport = once(() => muxedWithAudio(TsMuxer, 'ts'));

/** The bytes of a Blob or of a MediaResult's blob. */
const bytesOf = async blob => new Uint8Array(await (blob.blob ?? blob).arrayBuffer());

/**
 * Asserts that a copy of `input` into MP4 reads what its probe reads and then the input once, 1 MiB
 * at most at a time, and writes the bytes an indexed copy writes.
 */
async function assertOnePass(input) {
    const probed = await probeBytes(input);
    const whole = counted(input);
    const copied = await convert(whole.source, 'mp4');
    assert.ok(
        whole.counter.bytes <= probed + input.size,
        `read ${whole.counter.bytes} bytes, ${probed} of them to probe ${input.size}`,
    );
    assert.ok(whole.counter.largest <= MiB, `read ${whole.counter.largest} bytes at once`);
    assert.deepEqual(await bytesOf(copied), await bytesOf(await indexedCopy(input, 'mp4')));
}

/** Asserts that a trim of `input` reads less than half of it and writes an indexed trim. */
async function assertTrimWindow(input, range) {
    const ranged = counted(input);
    const trimmed = await convert(ranged.source, { to: 'mp4', ...range });
    assert.ok(ranged.counter.bytes < input.size / 2, `read ${ranged.counter.bytes} bytes`);
    assert.deepEqual(
        await bytesOf(trimmed),
        await bytesOf(await indexedCopy(input, { to: 'mp4', ...range })),
    );
}

/**
 * Ten seconds of WebM (64x48 VP8 pictures of 24 KiB, a keyframe each second) beside Opus whose
 * pre-skip of 312 samples is the Matroska CodecDelay: 7 MiB, sized against the library's own
 * probe windows (atFullScale).
 */
async function trimmedOpusWebm() {
    const sink = new MemorySink();
    const head = Uint8Array.of(
        ...[...'OpusHead'].map(character => character.charCodeAt(0)),
        ...[1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0],
    );
    const muxer = new WebMMuxer(
        {
            format: 'webm',
            mode: 'standard',
            autoSync: true,
            video: { id: 1, type: 'video', codec: 'vp8', width: 64, height: 48, framerate: 30 },
            audio: {
                codec: 'opus',
                codecConfig: head,
                sampleRate: 48000,
                channelCount: 2,
                codecDelaySamples: 312,
            },
        },
        sink,
    );
    let frame = 0;
    for (let index = 0; index < 300; index++) {
        for (; (frame * 960) / 48000 < index / 30; frame++)
            muxer.addAudioChunk({
                trackType: 'audio',
                data: Uint8Array.of(0xfc, 0xff, 0xfe),
                timestamp: (frame * 960) / 48000,
                duration: 960 / 48000,
                isKeyframe: true,
            });
        const picture = filler(24 * 1024);
        picture.set(index % 30 ? [0x01, 0, 0] : [0x10, 0, 0, 0x9d, 0x01, 0x2a, 64, 0, 48, 0]);
        muxer.addVideoChunk({
            trackType: 'video',
            data: picture,
            timestamp: index / 30,
            duration: 1 / 30,
            isKeyframe: index % 30 === 0,
        });
    }
    await muxer.finalize();
    return sink.toUint8Array();
}

/** The description inspect() gives of `input` matches a full read's, but for sample counts. */
async function assertDescribedAsRead(described, input) {
    const full = await inspect(input, { sampleCounts: true });
    assert.deepEqual(described, {
        ...full,
        tracks: full.tracks.map(({ sampleCount, ...track }) => track),
    });
    return full;
}

describe('copy: one pass through large inputs', () => {
    test('a long MPEG-TS of one keyframe copies in one pass', async () => {
        // 18 minutes, 6.5 MiB, an audio PES each 0.53 s.
        await assertOnePass(longTransportStream({ groups: 2_000 }));
    });

    test('a large MPEG-TS copies in one pass, and a trim reads its window', async () => {
        // The trim reads from the start, where its audio clock starts, to after the range.
        await assertOnePass(await transport());
        await assertTrimWindow(await transport(), { start: 4, end: 5 });
    });

    test('a large Matroska copies in one pass, and a trim reads its window', async () => {
        await assertOnePass(await matroska());
        await assertTrimWindow(await matroska(), { start: 20, end: 21 });
    });

    for (const copiesWrites of [false, true])
        test(`a sink ${copiesWrites ? 'done with each write' : 'that keeps writes'} gets ${
            copiesWrites ? 'views of' : 'copies of'
        } the reused buffers`, async () => {
            // A sink states with copiesWrites that it is done with the bytes before write()
            // returns.
            let views = 0;
            await convert(await transport(), 'mp4', {
                sink: {
                    copiesWrites,
                    write(bytes) {
                        if (bytes.buffer.byteLength === MiB && bytes.byteLength < MiB) views++;
                    },
                    patchAt() {},
                    async close() {},
                },
            });
            assert.equal(views > 0, copiesWrites);
        });

    test('a sink that cannot be patched gets fragmented MP4, not a second read', async () => {
        const input = await matroska();
        const forward = new MemorySink();
        Object.defineProperty(forward, 'patchAt', { value: undefined });
        const streamed = counted(input);
        const fragmented = await convert(streamed.source, { to: 'mp4', sink: forward });
        assert.ok(fragmented.warnings.some(warning => warning.code === 'MP4_FRAGMENTED'));
        assert.ok(streamed.counter.bytes <= (await probeBytes(input)) + input.size);
        assert.equal(
            (await packetsOf(new Blob([forward.toUint8Array()]))).length,
            (await packetsOf((await indexedCopy(input, 'mp4')).blob)).length,
        );
    });

    test('a copy that trims Opus by its pre-skip reads the index first', async t => {
        atFullScale(t);
        // It counts the coded samples of the whole track, which the head a probe reads does
        // not hold, and writes what an indexed copy writes.
        const webm = new BufferSource(await trimmedOpusWebm());
        assert.ok(webm.size > 4 * MiB, `the WebM holds ${webm.size} bytes`);
        const copied = await convert(counted(webm).source, 'mkv');
        assert.deepEqual(await bytesOf(copied), await bytesOf(await indexedCopy(webm, 'mkv')));
    });

    test('inspect() of a Matroska Blob reads its head and tail windows once', async t => {
        atFullScale(t);
        // Without reading ahead past them: the head's whole clusters past 2 MiB, and the tail
        // from the last cluster the Cues place to the end (a cluster a second here, about
        // 0.75 MiB), not 2 MiB of clusters.
        let sliced = 0;
        class CountingBlob extends Blob {
            slice(start, end) {
                sliced += end - start;
                return super.slice(start, end);
            }
        }
        const bytes = await trimmedOpusWebm();
        const described = await inspect(new CountingBlob([bytes]));
        assert.ok(sliced < 5 * MiB, `inspect() read ${sliced} of ${bytes.length} bytes`);
        await assertDescribedAsRead(described, bytes);
    });

    test('inspect() of a track that ends long before the input reads no more', async () => {
        // In probe MiB: the tails grow fourfold from the last cluster (20 pictures, 1.25 from the
        // end here) to 5 and 20, and the last reaches the 32 a tail from 2 reaches. The audio ends
        // 26 from the end, past the 20 tail: the description still reads nothing between its head
        // (a few) and the start of its last tail (a cluster before 32 from the end), and equals a
        // full read's.
        const input = await muxedWithAudio(WebMMuxer, 'mkv', { audioEnd: 684 / 30 });
        const between = [];
        const described = await inspect({
            size: input.size,
            read(offset, length) {
                if (offset + length > 8 * PROBE_MIB && offset < input.size - 40 * PROBE_MIB)
                    between.push([offset, length]);
                return input.read(offset, length);
            },
        });
        assert.deepEqual(between, []);
        const full = await assertDescribedAsRead(described, input);
        const audio = full.tracks.find(track => track.type === 'audio');
        assert.ok(Math.abs(audio.duration - 22.8) < 0.1, `the audio lasts ${audio.duration} s`);
    });
});
