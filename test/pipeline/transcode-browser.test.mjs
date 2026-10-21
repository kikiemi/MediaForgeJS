import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge, capabilities, open } from 'mediaforgejs';
import { hostVp8, patternClip } from '../helpers/pattern-clip.mjs';
import { PATTERN } from '../helpers/pattern.mjs';

// Video re-encoded with the browser's WebCodecs (npm run test:browser): damage the decoder
// recovers from, and an alpha picture a target cannot hold.

const inBrowser = typeof document !== 'undefined';
const codes = result => result.warnings.map(warning => warning.code);
const VP8 = { codec: 'vp8', bitrate: 1_000_000 };

describe(
    'pipeline/transcode',
    { skip: !inBrowser && 'runs in a browser (npm run test:browser)' },
    () => {
        const forge = new MediaForge();
        const strict = new MediaForge({ optionPolicy: 'strict' });

        test('a damaged keyframe is skipped to the next with VIDEO_DECODE_RECOVERED', async t => {
            if (!(await hostVp8())) return t.skip('the browser has no VP8 encoder or decoder');
            // The keyframe at 0.5 s loses three bytes of its header; the decoder resumes at 1 s.
            const damaged = await patternClip({
                damage: (chunk, index) => {
                    if (index !== 5) return undefined;
                    const data = chunk.data.slice();
                    data.fill(0, 3, 6);
                    return { ...chunk, data };
                },
            });
            const result = await forge.convert(damaged, { to: 'webm', video: VP8 });
            assert.deepEqual(
                codes(result).filter(code => code === 'VIDEO_DECODE_RECOVERED'),
                ['VIDEO_DECODE_RECOVERED'],
            );
            const media = await open(result.blob);
            const times = [];
            for await (const packet of media.packets())
                times.push(Math.round(packet.timestamp * 10));
            media.close();
            assert.deepEqual(times, [0, 1, 2, 3, 4, 10, 11, 12, 13, 14]);
            await assert.rejects(
                strict.convert(damaged, { to: 'webm', video: VP8 }),
                error => error.code === 'DECODE',
            );
        });

        test('MKV keeps alpha; MP4 drops it with ALPHA_DROPPED, strict refuses', async t => {
            if (!(await hostVp8())) return t.skip('the browser has no VP8 encoder or decoder');
            if (!(await capabilities({ to: 'mp4' })).video.encode.length)
                return t.skip('the browser has no video encoder for MP4');
            const alpha = await patternClip({ alpha: true, frames: 5 });
            const kept = await open((await forge.convert(alpha, 'mkv')).blob);
            assert.equal(kept.tracks[0].alphaMode, true);
            kept.close();
            const mp4 = await forge.convert(alpha, 'mp4');
            assert.ok(codes(mp4).includes('ALPHA_DROPPED'), `${codes(mp4)}`);
            let pictures = 0;
            for await (const frame of forge.frames(mp4.blob, { maxFrames: 2 }))
                if (frame.width === PATTERN.width) pictures++;
            assert.equal(pictures, 2, 'the colour pictures decode');
            await assert.rejects(strict.convert(alpha, 'mp4'), error => error.code === 'FORMAT');
        });
    },
);
