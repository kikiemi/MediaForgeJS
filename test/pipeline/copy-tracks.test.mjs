import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, check, convert, inspect, open } from 'mediaforgejs';
import { encodeAacLc } from 'mediaforgejs/codecs';
import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { opusHead } from '../helpers/multitrack-pcm-fixtures.mjs';
import {
    avcc,
    filler,
    idr,
    lengthPrefixed,
    pps,
    predicted,
    sps,
} from '../helpers/avi-h264-fixtures.mjs';

// Which tracks a copy keeps and where each starts: sparse subtitle tracks, text as MP4 timed text,
// cues clipped to the range, and the tracks a range misses, which the plan leaves out as it plans.

// Ten seconds of mono AAC silence, for the inputs whose sound must decode.
const SILENCE = await encodeAacLc([new Float32Array(480000)], {
    sampleRate: 48000,
    bitrate: 64,
});

/**
 * Ten seconds of video at 10 frames a second (a keyframe every 2.5 s), its sound `audioOffset`
 * seconds later and UTF-8 cues ([start, end]) in Matroska. `mpeg` makes it H.264 and AAC (stand-in
 * frames, or decodable silence with `aac`) instead of VP8 and Opus; `subtitle` adds fields to the
 * subtitle track.
 */
async function subtitled(cues, { audioOffset = 0, mpeg = false, aac = false, subtitle = {} } = {}) {
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'mkv',
            mode: 'standard',
            autoSync: false,
            video: mpeg
                ? {
                      id: 1,
                      type: 'video',
                      codec: 'avc1.42c00a',
                      codecConfig: avcc(),
                      width: 32,
                      height: 16,
                      framerate: 10,
                  }
                : { id: 1, type: 'video', codec: 'vp8', width: 16, height: 16, framerate: 10 },
            audio: {
                id: 2,
                type: 'audio',
                codec: mpeg ? 'mp4a.40.2' : 'opus',
                sampleRate: 48000,
                channelCount: aac ? 1 : 2,
                codecConfig: aac
                    ? SILENCE.audioSpecificConfig
                    : mpeg
                      ? Uint8Array.of(0x11, 0x90)
                      : opusHead(2),
            },
            subtitleTracks: [
                { id: 3, type: 'subtitle', codec: 'text/utf8', language: 'eng', ...subtitle },
            ],
        },
        sink,
    );
    for (let index = 0; index < 100; index++) {
        const key = index % 25 === 0;
        muxer.addVideoChunk({
            trackType: 'video',
            data: mpeg
                ? lengthPrefixed(4, key ? idr : predicted)
                : Uint8Array.of(key ? 0x10 : 0x11, 0, 0, 0x9d, 1, 0x2a, 16, 0, 16, 0),
            timestamp: index / 10,
            duration: 0.1,
            isKeyframe: key,
        });
        if (!aac)
            muxer.addAudioChunk({
                trackType: 'audio',
                data: mpeg
                    ? Uint8Array.of(0x01, 0x00, 0x10, 0x7f)
                    : Uint8Array.of(0xfc, 0xff, 0xfe),
                timestamp: index / 10 + audioOffset,
                duration: 0.1,
                isKeyframe: true,
            });
    }
    if (aac)
        SILENCE.frames.forEach((data, index) =>
            muxer.addAudioChunk({
                trackType: 'audio',
                data,
                timestamp: (index * 1024) / 48000 + audioOffset,
                duration: 1024 / 48000,
                isKeyframe: true,
            }),
        );
    for (const [start, end] of cues)
        muxer.addSubtitleChunk({
            trackType: 'subtitle',
            data: new TextEncoder().encode(`cue ${start}`),
            timestamp: start,
            duration: end - start,
            isKeyframe: true,
        });
    await muxer.finalize();
    return sink.toBlob();
}

/** The first presentation time of each track type of `blob`, to 10 ms. */
async function firstTimes(blob) {
    const media = await open(blob);
    const first = {};
    try {
        for await (const packet of media.packets())
            first[packet.trackType] ??= Math.round(packet.timestamp * 100) / 100;
    } finally {
        media.close();
    }
    return first;
}

/** The subtitle packets of `blob`: time, duration (to 1 ms) and bytes. */
async function subtitlePackets(blob) {
    const media = await open(blob);
    const packets = [];
    try {
        const id = media.tracks.find(track => track.type === 'subtitle').id;
        for await (const packet of media.packets({ trackIds: [id] }))
            packets.push({
                time: Math.round(packet.timestamp * 1000) / 1000,
                duration: Math.round(packet.duration * 1000) / 1000,
                data: packet.data,
            });
    } finally {
        media.close();
    }
    return packets;
}

/** The cues of MP4 timed text: time, duration and text. */
const timedText = async blob =>
    (await subtitlePackets(blob)).map(({ time, duration, data }) => [
        time,
        duration,
        new TextDecoder().decode(data.subarray(2, 2 + ((data[0] << 8) | data[1]))),
    ]);

describe('copy: tracks', () => {
    describe('a sparse subtitle track in a trim', () => {
        // It starts at the first cue shown from the start on: a cue that ended earlier would move
        // the output's start back to it.
        const range = { to: 'mkv', start: 5.2, end: 7 };

        test('that ended before the start is left out without failing the copy', async () => {
            const { blob } = await convert(await subtitled([[1, 2]]), range);
            assert.deepEqual(await firstTimes(blob), { video: 0, audio: 0 });
        });

        test('starts at the first cue after the start', async () => {
            const input = await subtitled([
                [1, 2],
                [6, 6.5],
            ]);
            const { blob } = await convert(input, range);
            assert.deepEqual(await firstTimes(blob), { video: 0, audio: 0, subtitle: 1 });
        });

        test('starts at a cue still on screen at the start', async () => {
            const input = await subtitled([
                [1, 2],
                [5.1, 5.6],
            ]);
            const { blob } = await convert(input, range);
            assert.deepEqual(await firstTimes(blob), { video: 0, audio: 0, subtitle: 0.1 });
        });
    });

    describe('text in plain MP4, M4V and MOV', () => {
        // 3GPP timed text in an 'sbtl' track, as ffmpeg writes it: one sample per cue, empty
        // samples before, between and after the cues.
        const twoCues = () =>
            subtitled(
                [
                    [1, 2],
                    [2.5, 3],
                ],
                { mpeg: true, aac: true },
            );
        const CUES = [
            [0, 1, ''],
            [1, 1, 'cue 1'],
            [2, 0.5, ''],
            [2.5, 0.5, 'cue 2.5'],
            // The last sample, empty and of no duration, ends the last cue.
            [3, 0, ''],
        ];
        const TARGETS = [
            { to: 'mp4', copy: true },
            { to: 'mov', copy: true },
            { to: 'm4v', copy: true },
            { to: 'mp4', audio: { codec: 'pcm' } },
        ];

        for (const target of TARGETS)
            test(`${JSON.stringify(target)} writes a timed text track`, async () => {
                const { blob } = await convert(await twoCues(), target);
                const bytes = Buffer.from(await blob.arrayBuffer());
                assert.ok(!bytes.includes('moof'), 'a plain movie');
                assert.ok(bytes.includes('tx3g') && bytes.includes('sbtl'));
                assert.deepEqual(await timedText(blob), CUES);
            });

        test('the instant that ends the last cue stays one in a copy of the copy', async () => {
            // It used to take the duration of the sample before it, and each copy made the track
            // longer.
            const { blob } = await convert(await twoCues(), { to: 'mp4', copy: true });
            const again = await convert(blob, { to: 'mov', copy: true });
            assert.deepEqual(await timedText(again.blob), CUES);
        });

        test('fragments leave that instant out: the sample before it ends the cue', async () => {
            const { blob } = await convert(await twoCues(), { to: 'mp4', copy: true });
            const fragmented = await convert(blob, { to: 'fmp4', copy: true });
            assert.deepEqual(await timedText(fragmented.blob), CUES.slice(0, -1));
        });

        for (const to of ['mp4', 'mov'])
            test(`a forced subtitle stays forced as timed text in ${to}`, async () => {
                // Its flag used to fail the copy: the MP4 writer took the text track for one that
                // cannot be forced.
                const input = await subtitled([[1, 2]], {
                    mpeg: true,
                    aac: true,
                    subtitle: { forced: true },
                });
                const { blob } = await convert(input, { to, copy: true });
                const { tracks } = await inspect(blob);
                const subtitle = tracks.find(track => track.type === 'subtitle');
                assert.deepEqual([subtitle.codec, subtitle.forced], ['tx3g', true]);
            });
    });

    describe('cues clipped to what a copy shows', () => {
        // One on screen when the copy starts is shown from there, and one still on screen at the
        // range end stops there.
        const CUES = [
            [4, 6],
            [4.5, 4.9],
            [6.5, 7.5],
            [8, 9],
        ];

        test('in Matroska, from the keyframe at 5 s', async () => {
            const { blob } = await convert(await subtitled(CUES), {
                to: 'mkv',
                start: 5.2,
                end: 7,
            });
            assert.deepEqual(
                (await subtitlePackets(blob)).map(({ time, duration }) => [time, duration]),
                [
                    [0, 1],
                    [1.5, 0.5],
                ],
            );
        });

        test('in MP4, from the in-point 5.2 s its edit list presents', async () => {
            const input = await subtitled(CUES, { mpeg: true });
            const { blob } = await convert(input, { to: 'mp4', start: 5.2, end: 7 });
            assert.deepEqual(
                (await timedText(blob)).filter(cue => cue[2]),
                [
                    [0, 0.8, 'cue 4'],
                    [1.3, 0.5, 'cue 6.5'],
                ],
            );
        });
    });

    test('sound after the picture keeps its start in a trimmed MOV copy', async () => {
        // An empty edit leads into it.
        const input = await subtitled([], { audioOffset: 0.05, mpeg: true });
        const { blob } = await convert(input, { to: 'mov', end: 5 });
        assert.deepEqual(await firstTimes(blob), { video: 0, audio: 0.05 });
    });

    describe('sound that starts after the range', () => {
        const late = () => subtitled([[1, 2]], { audioOffset: 3 });

        test('is left out of a trim with a warning', async () => {
            const trimmed = await convert(await late(), { to: 'mkv', end: 2 });
            assert.ok(
                trimmed.warnings.some(
                    ({ code, message }) =>
                        code === 'TARGET_TRACKS_DROPPED' && message.includes('audio track 2'),
                ),
                JSON.stringify(trimmed.warnings),
            );
            const { tracks } = await inspect(trimmed.blob);
            assert.deepEqual(tracks.map(track => track.type).sort(), ['subtitle', 'video']);
        });

        test('fails an edit that copies it with INPUT', async () => {
            // Rather than a TypeError.
            await assert.rejects(
                new MediaForge().edit({ clips: [{ input: await late(), end: 2 }] }, 'mkv'),
                { code: 'INPUT' },
            );
        });
    });

    test('text beside VP8, which MP4 does not carry, is an unsupported copy', async () => {
        // This host cannot re-encode VP8.
        const support = await check(await subtitled([[1, 2]]), 'mp4');
        assert.equal(support.supported, false);
        assert.equal(support.code, 'FORMAT', support.reason);
    });

    describe('a range that misses a track', () => {
        // 3 s of pictures, and AAC frames from `from` to `until` seconds.
        async function input(from, until) {
            const sink = new MemorySink();
            const muxer = new WebMMuxer(
                {
                    format: 'mkv',
                    mode: 'standard',
                    video: {
                        codec: 'avc1.42c00a',
                        codecConfig: avcc(),
                        width: 64,
                        height: 48,
                        framerate: 30,
                    },
                    audio: {
                        codec: 'mp4a.40.2',
                        codecConfig: Uint8Array.of(0x11, 0x90),
                        sampleRate: 48000,
                        channelCount: 2,
                    },
                },
                sink,
            );
            let sound = 0;
            for (let index = 0; index < 90; index++) {
                for (; from + sound * (1024 / 48000) < Math.min(index / 30, until); sound++)
                    muxer.addAudioChunk({
                        trackType: 'audio',
                        data: Uint8Array.of(0x21, sound & 255, 1, 2),
                        timestamp: from + sound * (1024 / 48000),
                        duration: 1024 / 48000,
                        isKeyframe: true,
                    });
                muxer.addVideoChunk({
                    trackType: 'video',
                    data: lengthPrefixed(
                        4,
                        ...(index % 30 ? [predicted] : [sps, pps, idr]),
                        filler(64),
                    ),
                    timestamp: index / 30,
                    duration: 1 / 30,
                    isKeyframe: index % 30 === 0,
                });
            }
            await muxer.finalize();
            return new Blob([sink.toUint8Array()]);
        }

        // The plan used to list a sound that starts after the range, which the copy then
        // dropped, and the copy refused one that ends before it.
        for (const [label, from, until, range, reason] of [
            [
                'starts after',
                2,
                3,
                { start: 0.5, end: 1.5 },
                /^audio track 2 has no packets in the range$/,
            ],
            [
                'ends before',
                0,
                0.3,
                { start: 1, end: 2 },
                /^audio track 2 ends at 0\.32 s, before the range$/,
            ],
        ])
            test(`a sound that ${label} the range is left out as the plan plans it`, async () => {
                const bytes = await input(from, until);
                const target = { to: 'mp4', ...range };
                const support = await check(bytes, target);
                assert.deepEqual(
                    support.plan.tracks.map(track => [track.trackId, track.action]),
                    [[1, 'copy']],
                );
                let planned;
                const result = await convert(bytes, {
                    ...target,
                    onPlan: plan => (planned = plan),
                });
                assert.deepEqual(
                    [planned, result.plan].map(plan => plan.tracks.map(track => track.trackId)),
                    [[1], [1]],
                );
                const dropped = result.warnings.filter(
                    ({ code }) => code === 'TARGET_TRACKS_DROPPED',
                );
                assert.deepEqual(
                    dropped.map(warning => warning.trackId),
                    [2],
                );
                assert.match(dropped[0].message, reason);
                const { tracks } = await inspect(result.blob);
                assert.deepEqual(
                    tracks.map(track => track.type),
                    ['video'],
                );
            });

        test('strict validation refuses a sound that ends before the range', async () => {
            const media = await open(await input(0, 0.3), { validation: 'strict' });
            try {
                await assert.rejects(media.convert({ to: 'mp4', start: 1, end: 2, copy: true }), {
                    code: 'INPUT',
                    message: /start 1 s is past the end of track 2/,
                });
            } finally {
                media.close();
            }
        });

        for (const to of ['mp4', 'mkv'])
            test(`a range past every track fails a ${to} conversion as the copy does`, async () => {
                // A re-encode would reach no more of the input, so the conversion tries none (it
                // used to name the encoder this host lacks).
                await assert.rejects(convert(await input(0, 0.3), { to, start: 10, end: 12 }), {
                    code: 'INPUT',
                    message: 'start 10 s is past the end of track 1',
                });
            });
    });
});
