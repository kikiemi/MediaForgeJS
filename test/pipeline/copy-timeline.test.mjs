import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, convert, inspect, open, packageMedia } from 'mediaforgejs';
import { Mp4Muxer, TsMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { tsFixture } from '../helpers/original-fixtures.mjs';
import {
    REORDERED_TRACK,
    addReorderedPictures,
    reorderedMp4,
} from '../helpers/reordered-video.mjs';

// One timeline for every container: a copy presents its first packet at zero. Reordered pictures
// decode before it (MP4 edit lists, Matroska presentation times, the MPEG-TS clock, FLV
// composition offsets and each track's own edit in a package), the clock of an MPEG-TS input is
// removed, trims count from the input's start, and a trim into a container without edit lists
// leaves out the open-GOP pictures that precede its keyframe.

/** The presentation times of the packets of `blob` in decode order, to the millisecond. */
async function shown(blob) {
    const media = await open(blob);
    try {
        const times = [];
        for await (const packet of media.packets())
            times.push(Math.round(packet.timestamp * 1000) / 1000);
        return times;
    } finally {
        media.close();
    }
}

/** Three seconds of reordered pictures in MPEG-TS, shown from 100 s on its clock. */
async function clockedTs() {
    const sink = new MemorySink();
    await addReorderedPictures(new TsMuxer({ format: 'ts', video: REORDERED_TRACK }, sink), {
        clock: 100,
    });
    return sink.toBlob();
}

/**
 * Asserts that decode times rise in `blob` and that the picture shown at its edit's start
 * presents at zero: an MP4-family edit never starts inside a picture.
 */
async function assertPresentsAtEdit(blob) {
    const media = await open(blob);
    const decoded = [];
    const presented = [];
    try {
        for await (const packet of media.packets()) {
            decoded.push(packet.decodeTimestamp ?? packet.timestamp);
            presented.push(packet.timestamp);
        }
    } finally {
        media.close();
    }
    assert.ok(
        decoded.every((time, index) => index === 0 || time > decoded[index - 1]),
        `decode times rise: ${decoded}`,
    );
    assert.equal(Math.max(...presented.filter(time => time <= 0)), 0, `${presented}`);
}

describe('copy: one timeline', () => {
    describe('an MPEG-TS clock', () => {
        // tsFixture() starts its clock at 10 s.
        const transport = () => tsFixture({ startPts: 900000 });

        test('is the time of the input packets', async () => {
            assert.equal((await shown(transport()))[0], 10);
        });

        for (const to of ['mkv', 'flv', 'fmp4'])
            test(`is removed by a ${to} copy, which starts at zero`, async () => {
                const times = await shown((await convert(transport(), to)).blob);
                assert.deepEqual(
                    times.map(time => Math.round(time * 1000)),
                    [0, 21, 43, 64],
                );
            });

        test('does not count in trims, which count from the input start', async () => {
            // Start 0.02 is not a time before the clock's first packet: the edit list presents
            // 0.02 s into the first frame.
            const { blob } = await convert(transport(), { to: 'mp4', start: 0.02, end: 0.05 });
            assert.deepEqual(
                (await shown(blob)).map(time => Math.round(time * 1000)),
                [-20, 1, 23],
            );
        });

        test('does not count in edit() clips either', async () => {
            const { blob } = await new MediaForge().edit(
                { clips: [{ input: transport(), start: 0.02, end: 0.05 }] },
                'mp4',
            );
            const info = await inspect(blob, { sampleCounts: true });
            assert.equal(info.tracks[0].sampleCount, 3);
        });
    });

    describe('reordered pictures', () => {
        for (const to of ['mkv', 'ts', 'flv'])
            test(`a ${to} copy presents its first picture at zero, from MP4 or TS`, async () => {
                for (const input of [await reorderedMp4(), await clockedTs()]) {
                    const times = await shown((await convert(input, to)).blob);
                    assert.equal(Math.min(...times), 0, `${times}`);
                }
            });

        for (const to of ['mkv', 'ts', 'flv'])
            test(`a ${to} trim starts at its keyframe, without the open GOP's lead`, async () => {
                // From 1.05 s: the keyframe at 1 s presents at zero, nothing before it, and B9,
                // which decodes after it, is left out.
                const { blob } = await convert(await reorderedMp4(), { to, start: 1.05, end: 2 });
                const times = await shown(blob);
                assert.equal(times[0], 0, `${times}`);
                assert.ok(Math.min(...times) >= 0, `${times}`);
                assert.equal(times.length, 11, `${times}`);
            });

        for (const to of ['mp4', 'mov'])
            test(`a ${to} trim inside a picture presents that picture from the edit`, async () => {
                // From 1.05 s, and from inside the last picture (2.85 s): readers that drop every
                // sample presented before an edit (ffmpeg) would drop it, and every picture when
                // it is the last. Its decode time stays.
                for (const start of [1.05, 2.85])
                    await assertPresentsAtEdit(
                        (await convert(await reorderedMp4(), { to, start })).blob,
                    );
            });

        for (const to of ['mp4', 'mov', 'fmp4'])
            test(`a ${to} copy of an edit starting inside a picture starts with it`, async () => {
                // The input's own edit starts half a picture in.
                const inside = new Uint8Array(await (await reorderedMp4()).arrayBuffer());
                const at = type => Buffer.from(inside).indexOf(type);
                const fields = new DataView(inside.buffer);
                const mediaTime = at('elst') + 16;
                fields.setUint32(
                    mediaTime,
                    fields.getUint32(mediaTime) + fields.getUint32(at('mdhd') + 16) / 20,
                );
                await assertPresentsAtEdit((await convert(new Blob([inside]), to)).blob);
            });
    });

    describe('packages', () => {
        test('an HLS package presents its first picture at zero', async () => {
            const { files } = await packageMedia(await reorderedMp4(), 'hls', {
                targetDuration: 1,
            });
            const list = [...files.values()];
            const init = list.find(file => file.kind === 'init').data;
            const first = list.find(file => file.kind === 'segment').data;
            assert.equal(Math.min(...(await shown(new Blob([init, first])))), 0);
        });

        test('each track keeps its own edit: reorder delay or AAC priming', async () => {
            // As in a fragmented MP4 copy and as ffmpeg packages it: the video's reorder delay and
            // the audio's 1024 priming samples, each from the track's own first sample (ffmpeg
            // counts an audio edit from there).
            const sink = new MemorySink();
            const muxer = new Mp4Muxer(
                {
                    format: 'mp4',
                    mode: 'standard',
                    autoSync: false,
                    video: REORDERED_TRACK,
                    audio: {
                        id: 2,
                        type: 'audio',
                        codec: 'mp4a.40.2',
                        sampleRate: 48000,
                        channelCount: 2,
                        codecConfig: Uint8Array.of(0x11, 0x90),
                        presentationStartSeconds: 0,
                        presentationMediaTimeSeconds: 1024 / 48000,
                        presentationDurationSeconds: 3,
                    },
                },
                sink,
            );
            for (let index = 0; index < 150; index++)
                muxer.addAudioChunk({
                    trackType: 'audio',
                    data: Uint8Array.of(0x21, 0x10, 4, 0x60, 0x8c, 0x1c),
                    timestamp: (index * 1024) / 48000,
                    duration: 1024 / 48000,
                    isKeyframe: true,
                });
            await addReorderedPictures(muxer);
            const { files } = await packageMedia(sink.toBlob(), 'hls', { targetDuration: 1 });
            const header = [...files.values()].find(file => file.kind === 'init').data;
            const view = new DataView(header.buffer, header.byteOffset);
            const fields = (type, offset) => {
                const values = [];
                for (let at = 0; (at = Buffer.from(header).indexOf(type, at + 1)) > 0;)
                    values.push(view.getUint32(at + offset));
                return values;
            };
            const timescales = fields('mdhd', 16);
            assert.deepEqual(
                fields('elst', 16).map((ticks, index) =>
                    Math.round((ticks / timescales[index]) * 48000),
                ),
                [4800, 1024],
            );
        });
    });
});
