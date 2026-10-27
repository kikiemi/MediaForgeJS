import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import { MemorySink, ReadableStreamSink, StreamSink } from 'mediaforgejs/io';
import { Mp4Muxer } from 'mediaforgejs/formats';

// An input past 2 GiB read from a Blob in a real browser (npm run test:browser): the reader indexes
// it from small reads, and copies and packages stream it to sinks that hold little, without the
// input or the output in memory.

const inBrowser = typeof document !== 'undefined';

/** Bytes of the large input: past 2 GiB, where 32-bit signed offsets end. */
const LARGE_BYTES = 2.2 * 2 ** 30;
/** One second of 25 H.264 keyframes, each an IDR slice padded to a MiB. */
const FRAME_RATE = 25;
const FRAME_BYTES = 2 ** 20;
/** The JS heap the work stays under, where the browser reports it. */
const MAX_HEAP_BYTES = 512 * 2 ** 20;

const hex = text => Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
/** 32x16 Baseline H.264: its decoder configuration and the IDR slice of its one picture. */
const AVCC = hex('0142000affe100076742000ada2e4001000468ce3c80');
const IDR_HEAD = hex('65b84a0d0020');

/** A keyframe sample of FRAME_BYTES: its length field, then the IDR slice padded out. */
function keyframe() {
    const sample = new Uint8Array(FRAME_BYTES).fill(0x5a);
    new DataView(sample.buffer).setUint32(0, FRAME_BYTES - 4);
    sample.set(IDR_HEAD, 4);
    return sample;
}

/** A one-second fragmented MP4 of FRAME_RATE keyframes, a fragment every fifth of a second. */
async function smallFragmentedMp4() {
    const sink = new MemorySink();
    const muxer = new Mp4Muxer(
        {
            format: 'mp4',
            mode: 'fragmented',
            maxFragmentDuration: 0.2,
            autoSync: false,
            video: {
                id: 1,
                type: 'video',
                codec: 'avc1.42000a',
                width: 32,
                height: 16,
                codecConfig: AVCC,
            },
        },
        sink,
    );
    const data = keyframe();
    for (let index = 0; index < FRAME_RATE; index++)
        muxer.addVideoChunk(
            {
                trackType: 'video',
                data,
                timestamp: index / FRAME_RATE,
                duration: 1 / FRAME_RATE,
                isKeyframe: true,
            },
            AVCC,
        );
    await muxer.finalize();
    return sink.toBlob();
}

/** The boxes of `data` from `start` to `end`: their types and spans. */
function boxes(data, start = 0, end = data.length) {
    const view = new DataView(data.buffer, data.byteOffset);
    const found = [];
    for (let at = start; at + 8 <= end;) {
        const size = view.getUint32(at);
        assert.ok(size >= 8 && at + size <= end, 'box sizes are valid');
        found.push({ type: String.fromCharCode(...data.subarray(at + 4, at + 8)), at, size });
        at += size;
    }
    return found;
}

/**
 * A Blob of at least `bytes` that repeats the fragments of the one-track fragmented MP4 `file`
 * after its header: each copy renumbers its fragments and moves their decode times on by the span
 * of the file, so the copies follow each other. The Blob refers to the same bytes over and over.
 */
async function repeatedFragments(file, bytes) {
    const data = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(data.buffer);
    const top = boxes(data);
    const fragments = top.filter(box => box.type === 'moof');
    const inside = (box, type) =>
        boxes(data, box.at + 8, box.at + box.size).filter(child => child.type === type);
    // Each patch is a big-endian counter of `width` bytes that moves on by `step` a copy.
    const patches = [];
    const timescale = (() => {
        const [trak] = inside(
            top.find(box => box.type === 'moov'),
            'trak',
        );
        const [mdhd] = inside(inside(trak, 'mdia')[0], 'mdhd');
        return view.getUint32(mdhd.at + (data[mdhd.at + 8] === 1 ? 28 : 20));
    })();
    for (const moof of fragments) {
        patches.push({ at: inside(moof, 'mfhd')[0].at + 12, width: 4, step: fragments.length });
        const [tfdt] = inside(inside(moof, 'traf')[0], 'tfdt');
        const wide = data[tfdt.at + 8] === 1;
        patches.push({ at: tfdt.at + 12, width: wide ? 8 : 4, step: timescale });
    }
    const body = { start: fragments[0].at, end: data.length };
    const copies = Math.ceil(bytes / (body.end - body.start));
    const parts = [file.slice(0, body.start)];
    for (let copy = 0; copy < copies; copy++) {
        let at = body.start;
        for (const patch of patches) {
            parts.push(file.slice(at, patch.at));
            const value = data.slice(patch.at, patch.at + patch.width);
            const field = new DataView(value.buffer);
            if (patch.width === 8)
                field.setBigUint64(0, field.getBigUint64(0) + BigInt(copy * patch.step));
            else field.setUint32(0, field.getUint32(0) + copy * patch.step);
            parts.push(value);
            at = patch.at + patch.width;
        }
        parts.push(file.slice(at, body.end));
    }
    return { blob: new Blob(parts, { type: 'video/mp4' }), seconds: copies };
}

/**
 * The peak JS heap while `work` runs, or 0 where the browser does not report it. A sample past
 * MAX_HEAP_BYTES counts what survives a collection where the page may collect (the runner exposes
 * gc() in Chromium): garbage the browser has not collected yet is not held by the work.
 */
async function peakHeapOf(work) {
    const used = () => {
        const size = performance.memory?.usedJSHeapSize ?? 0;
        if (size < MAX_HEAP_BYTES || typeof globalThis.gc !== 'function') return size;
        globalThis.gc();
        return performance.memory.usedJSHeapSize;
    };
    let peak = used();
    const sampler = setInterval(() => (peak = Math.max(peak, used())), 50);
    try {
        await work();
    } finally {
        clearInterval(sampler);
    }
    return Math.max(peak, used());
}

describe(
    'pipeline/read in a browser',
    { skip: !inBrowser && 'runs in a browser (npm run test:browser)' },
    () => {
        const forge = new MediaForge();
        const sourceName = 'mediaforge-read-browser.mp4';
        const copyName = 'mediaforge-read-browser.mkv';
        let root;
        let large;
        before(async () => {
            // The repeated file is an OPFS file, so the browser reads the large Blob's parts from
            // disk instead of holding a Blob past 2 GiB in memory.
            root = await navigator.storage.getDirectory();
            const handle = await root.getFileHandle(sourceName, { create: true });
            const writable = await handle.createWritable();
            await writable.write(await smallFragmentedMp4());
            await writable.close();
            large = await repeatedFragments(await handle.getFile(), LARGE_BYTES);
        });
        after(async () => {
            await root?.removeEntry(sourceName).catch(() => undefined);
            await root?.removeEntry(copyName).catch(() => undefined);
        });

        test('an input past 2 GiB is indexed with its whole duration', async () => {
            assert.ok(large.blob.size >= LARGE_BYTES);
            const info = await forge.inspect(large.blob, { sampleCounts: true });
            const [track] = info.tracks;
            assert.equal(info.format, 'mp4');
            assert.ok(Math.abs(track.duration - large.seconds) < 0.05, `${track.duration} s`);
            assert.equal(track.sampleCount, large.seconds * FRAME_RATE);
        });

        test('copies into an OPFS MKV file through a seekable StreamSink', async () => {
            const sink = await StreamSink.fromOPFS(copyName);
            const heap = await peakHeapOf(() => forge.convert(large.blob, 'mkv', { sink }));
            assert.ok(!heap || heap < MAX_HEAP_BYTES, `the heap peaked at ${heap} bytes`);
            const file = await (await root.getFileHandle(copyName)).getFile();
            assert.ok(file.size > large.blob.size * 0.95, `the MKV holds ${file.size} bytes`);
            const [track] = (await forge.inspect(file)).tracks;
            assert.ok(Math.abs(track.duration - large.seconds) < 1, `${track.duration} s`);
            await root.removeEntry(copyName);
        });

        test('streams an MP4 copy through a ReadableStream that keeps nothing', async () => {
            let streamed = 0;
            const sink = new ReadableStreamSink();
            const counted = new WritableStream({
                write(chunk) {
                    streamed += chunk.byteLength;
                },
            });
            const heap = await peakHeapOf(() =>
                Promise.all([
                    forge.convert(large.blob, 'mp4', { sink }),
                    sink.stream.pipeTo(counted),
                ]),
            );
            assert.ok(!heap || heap < MAX_HEAP_BYTES, `the heap peaked at ${heap} bytes`);
            assert.ok(streamed > large.blob.size * 0.95, `the stream carried ${streamed} bytes`);
        });

        test('packages HLS file by file', async () => {
            // The input runs at 25 MiB a second. A segment is handed to onFile whole, and while it
            // is written its samples are held beside it: twice its bytes. Six-second segments
            // reach the 128 MiB of maxBufferedBytes, 256 MiB while one is written, and the
            // segments before it stay in the heap until the browser collects them; two-second
            // segments (50 MiB) leave room for that under the bound.
            let packaged = 0;
            let segments = 0;
            const heap = await peakHeapOf(() =>
                forge.packageMedia(large.blob, 'hls', {
                    targetDuration: 2,
                    onFile: file => {
                        packaged += file.data.byteLength;
                        if (file.kind === 'segment') segments++;
                    },
                }),
            );
            assert.ok(!heap || heap < MAX_HEAP_BYTES, `the heap peaked at ${heap} bytes`);
            assert.ok(packaged > large.blob.size * 0.95, `the package holds ${packaged} bytes`);
            assert.ok(segments >= large.seconds / 3, `${segments} segments`);
        });
    },
);
