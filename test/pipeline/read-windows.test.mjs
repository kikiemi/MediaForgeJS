import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { open } from 'mediaforgejs';
import { TsMuxer, WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { avcc, filler, idr, lengthPrefixed, predicted } from '../helpers/avi-h264-fixtures.mjs';
// The indexed file behind open(), to compare windows with.
import { openFile } from '../helpers/engine.mjs';

// packetAt() of a large input opened lazily reads windows of the input around the packet, not its
// index, and finds what the index finds, decode times included.

/** A source over `bytes` that counts the bytes read. */
function countingSource(bytes) {
    const source = {
        size: bytes.length,
        bytesRead: 0,
        async read(offset, length) {
            source.bytesRead += length;
            return bytes.slice(offset, offset + length);
        },
    };
    return source;
}

const video = {
    id: 1,
    type: 'video',
    codec: 'avc1.4d400a',
    codecConfig: avcc(),
    width: 64,
    height: 48,
    framerate: 30,
};

describe('pipeline/read: windows of large inputs', () => {
    test('Matroska: the clusters around the packet find what the index finds', async () => {
        // 1,200 pictures of 24 KiB (40 s, 29 MiB) in groups of 30, in decode order. The pictures
        // of the first two groups show two after their place, later ones one: a window times them
        // as the whole track does, by the pictures at its start.
        const sink = new MemorySink();
        const muxer = new WebMMuxer({ format: 'mkv', mode: 'standard', video }, sink);
        const group = pyramid => {
            const order = [0];
            for (let at = 1; at + (pyramid ? 3 : 1) < 30; at += pyramid ? 4 : 2)
                order.push(...(pyramid ? [at + 3, at + 1, at, at + 2] : [at + 1, at]));
            return [...order, 29];
        };
        for (let index = 0; index < 1200; index += 30)
            for (const [position, shown] of group(index < 60).entries())
                muxer.addVideoChunk({
                    trackType: 'video',
                    data: lengthPrefixed(4, shown ? predicted : idr, filler(24 * 1024)),
                    timestamp: (index + shown + 2) / 30,
                    decodeTimestamp: (index + position) / 30,
                    duration: 1 / 30,
                    isKeyframe: shown === 0,
                });
        await muxer.finalize();
        const bytes = sink.toUint8Array();
        const indexed = await openFile(bytes);
        try {
            for (const time of [0.5, 12.31, 20, 33.3])
                for (const options of [{}, { keyframe: true }, { mode: 'after' }]) {
                    const source = countingSource(bytes);
                    const media = await open(source);
                    const opened = source.bytesRead;
                    const packet = await media.packetAt(1, time, options);
                    media.close();
                    const label = `${JSON.stringify(options)} at ${time} s`;
                    assert.deepEqual(packet, await indexed.packetAt(1, time, options), label);
                    assert.ok(source.bytesRead - opened < bytes.length / 4, label);
                }
        } finally {
            indexed.close();
        }
    });

    test('MPEG-TS: a picture shown at the end of the head is found', async () => {
        // 900 pictures of 48 KiB (30 s, 42 MiB): a keyframe each second, then P pictures each
        // shown after the two B pictures stored after it.
        const sink = new MemorySink();
        const muxer = new TsMuxer({ format: 'ts', mode: 'standard', video }, sink);
        for (let index = 0; index < 900; index++) {
            const place = index % 30;
            const shown = place === 0 ? 0 : place % 3 === 1 ? place + 2 : place - 1;
            muxer.addVideoChunk({
                trackType: 'video',
                data: lengthPrefixed(4, place ? predicted : idr, filler(48 * 1024)),
                timestamp: (index - place + Math.min(shown, 29) + 2) / 30,
                decodeTimestamp: index / 30,
                duration: 1 / 30,
                isKeyframe: place === 0,
            });
        }
        await muxer.finalize();
        const bytes = sink.toUint8Array();
        const source = countingSource(bytes);
        const indexed = await openFile(bytes);
        const media = await open(source);
        try {
            for (let frame = 2; frame < 75; frame++)
                for (const mode of ['before', 'after']) {
                    const time = (frame + 0.5) / 30;
                    source.bytesRead = 0;
                    const packet = await media.packetAt(1, time, { mode });
                    assert.deepEqual(
                        packet,
                        await indexed.packetAt(1, time, { mode }),
                        `${mode} ${time}`,
                    );
                    assert.ok(
                        source.bytesRead < bytes.length / 2,
                        `${source.bytesRead} at ${time} s`,
                    );
                }
        } finally {
            media.close();
            indexed.close();
        }
    });
});
