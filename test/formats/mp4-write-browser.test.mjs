import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MemorySink } from 'mediaforgejs/io';
import { createMuxer } from 'mediaforgejs/parts';

// Fragmented MP4 of sound whose length the muxer learns at its end, played in a real browser (npm
// run test:browser): an audio element plays it to its end with a duration of the sound, whether
// the browser applies the init's edit (segment_duration 0, media_time the priming) or not.

const inBrowser = typeof document !== 'undefined';
const RATE = 44100;
const SECONDS = 2;

/** Two seconds of a tone encoded as `codec` into a sink that cannot patch: fragmented MP4. */
async function fragmentedTone(codec) {
    const memory = new MemorySink();
    const sink = { write: data => memory.write(data), close: () => memory.close() };
    const muxer = await createMuxer('mp4', sink, {
        audio: { codec, sampleRate: RATE, channels: 1 },
    });
    const total = SECONDS * RATE;
    await muxer.encodeAudio({
        sampleRate: RATE,
        channels: 1,
        estimatedFrames: total,
        async *chunks() {
            for (let at = 0; at < total; at += RATE / 10)
                yield [
                    Float32Array.from(
                        { length: RATE / 10 },
                        (_, index) => 0.3 * Math.sin(((at + index) * 2 * Math.PI * 440) / RATE),
                    ),
                ];
        },
    });
    await muxer.finish();
    return memory.toUint8Array();
}

/** A muted audio element in the page, playing four times as fast; remove() it after. */
function audioElement() {
    const media = document.createElement('audio');
    media.muted = true;
    media.defaultPlaybackRate = 4;
    media.playbackRate = 4;
    document.body.append(media);
    return media;
}

const skipped = !inBrowser && 'runs in a browser (npm run test:browser)';

describe('mp4: fragmented sound in a browser', { skip: skipped }, () => {
    for (const [codec, type] of [
        ['mp3', 'audio/mp4; codecs="mp4a.6B"'],
        ['aac', 'audio/mp4; codecs="mp4a.40.2"'],
    ])
        test(`${codec} plays to its end in an audio element`, { timeout: 60_000 }, async t => {
            if (!document.createElement('audio').canPlayType(type))
                return t.skip(`the browser does not play ${type}`);
            const media = audioElement();
            try {
                const bytes = await fragmentedTone(codec);
                media.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/mp4' }));
                const ended = new Promise((resolve, reject) => {
                    media.addEventListener('ended', () => resolve(media.currentTime), {
                        once: true,
                    });
                    media.addEventListener('error', () => reject(media.error), { once: true });
                });
                await media.play();
                const time = await ended;
                // The sound, and at most its priming and the padding of its last frame on top.
                assert.ok(media.duration >= SECONDS - 0.01, `${media.duration} s`);
                assert.ok(media.duration <= SECONDS + 0.05, `${media.duration} s`);
                assert.ok(Math.abs(time - media.duration) < 0.05, `ended at ${time} s`);
            } finally {
                media.remove();
            }
        });
});
