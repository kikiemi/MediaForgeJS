import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { open } from 'mediaforgejs';
import { encodeAacLc, wrapAdts } from 'mediaforgejs/codecs';
import {
    decodeEventMessage,
    encodeEventMessage,
    parseWebVtt,
    toSubtitleChunks,
} from 'mediaforgejs/formats';
import { BufferSource, ConcatSource } from 'mediaforgejs/io';
import { CmafWriter, readCmafSegments } from 'mediaforgejs/streaming';

// Fragmented MP4 in pieces: the segments of an input read again as one input, fragments cut short,
// a stream of fragments split into its init and media segments, WebVTT cues and event messages.

const { frames } = await encodeAacLc([new Float32Array(4096)], { sampleRate: 48000, bitrate: 64 });

/** The data of every packet of `input`. */
async function packetData(input) {
    const media = await open(input);
    try {
        const data = [];
        for await (const packet of media.packets()) data.push(packet.data);
        return { data, warnings: media.warnings.map(warning => warning.code), media };
    } finally {
        media.close();
    }
}

/** The init and media segments of an M4A of `frames`, a sample each. */
async function fragmentsOf() {
    const input = await open(wrapAdts({ frames, sampleRate: 48000, channels: 1 }));
    try {
        const { blob } = await input.convert('m4a', { copy: true });
        const restored = await open(blob);
        try {
            const fragments = [];
            for await (const segment of restored.segments({ maxBufferedSamples: 1 }))
                fragments.push(segment.data);
            return fragments;
        } finally {
            restored.close();
        }
    } finally {
        input.close();
    }
}

describe('mp4: fragments', () => {
    test('the segments of an input read again as one input of its packets', async () => {
        const fragments = await fragmentsOf();
        assert.equal(fragments.length, frames.length + 1);
        const joined = new ConcatSource(fragments.map(data => new BufferSource(data)));
        assert.deepEqual((await packetData(joined)).data, frames);
    });

    test('fragments cut short keep their whole samples, and strict reading fails', async () => {
        const fragments = await fragmentsOf();
        const whole = new ConcatSource(fragments.map(data => new BufferSource(data)));
        const cut = await whole.read(0, whole.size - 1);
        const { data, warnings } = await packetData(cut);
        assert.ok(warnings.includes('MP4_TRUNCATED_SAMPLES'), `${warnings}`);
        assert.deepEqual(data, frames.slice(0, -1));
        await assert.rejects(open(cut, { validation: 'strict' }), {
            code: 'DEMUX',
            message: /cut by the end of the input/,
        });
    });

    test('a stream of fragments splits into its init segment and media segments', async () => {
        const fragments = await fragmentsOf();
        async function* stream() {
            yield* fragments;
        }
        const read = [];
        for await (const segment of readCmafSegments(stream())) {
            assert.equal(segment.byteLength, segment.data.byteLength);
            read.push(segment.kind);
        }
        assert.deepEqual(read, ['init', ...frames.map(() => 'media')]);
    });

    test('WebVTT cues written as wvtt samples read back as a subtitle track', async () => {
        const document = parseWebVtt(
            'WEBVTT\n\nA\n00:00.000 --> 00:02.000\n字幕\n\nB\n00:01.000 --> 00:03.000\nOverlap\n',
        );
        const writer = new CmafWriter({
            tracks: [{ id: 1, type: 'subtitle', codec: 'wvtt', timescale: 1000 }],
        });
        const init = writer.createInitSegment();
        for (const chunk of toSubtitleChunks(document)) writer.addChunk(1, chunk);
        const media = await open(new Blob([init, writer.flush().data]));
        try {
            assert.equal(media.tracks[0].type, 'subtitle');
            // The overlap splits the cues into three spans.
            assert.equal((await Array.fromAsync(media.packets())).length, 3);
        } finally {
            media.close();
        }
    });

    test('an event message keeps a 64-bit time and leads the fragment it is added to', () => {
        const event = {
            version: 1,
            schemeIdUri: 'urn:test',
            value: '',
            timescale: 1000,
            presentationTime: 2n ** 60n,
            eventDuration: 20,
            id: 3,
            messageData: Uint8Array.of(4),
        };
        assert.equal(
            decodeEventMessage(encodeEventMessage(event)).presentationTime,
            event.presentationTime,
        );
        const writer = new CmafWriter({
            tracks: [{ id: 1, type: 'subtitle', codec: 'wvtt', timescale: 1000 }],
        });
        writer.addEvent(event);
        writer.addSample({
            trackId: 1,
            data: Uint8Array.of(0, 0, 0, 8, 118, 116, 116, 101),
            decodeTimestamp: 3000,
            duration: 1000,
            isKeyframe: true,
        });
        const { data } = writer.flush();
        const size = new DataView(data.buffer, data.byteOffset).getUint32(0);
        assert.equal(decodeEventMessage(data.slice(0, size)).id, 3);
    });
});
