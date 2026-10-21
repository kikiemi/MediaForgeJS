import { WebMMuxer } from 'mediaforgejs/formats';
import { MemorySink } from 'mediaforgejs/io';
import { PATTERN, patternRgba } from './pattern.mjs';

// Pattern clips the browser encodes itself, for the browser tests (npm run test:browser).

const VP8 = { codec: 'vp8', width: PATTERN.width, height: PATTERN.height, framerate: 10 };

/** Whether the browser encodes and decodes VP8 at the pattern's size and has OffscreenCanvas. */
export async function hostVp8() {
    const needed = ['VideoEncoder', 'VideoDecoder', 'OffscreenCanvas'].map(
        name => globalThis[name],
    );
    if (!needed.every(constructor => typeof constructor === 'function')) return false;
    return (
        (await VideoEncoder.isConfigSupported({ ...VP8, bitrate: 2_000_000 })).supported === true &&
        (await VideoDecoder.isConfigSupported({ codec: 'vp8' })).supported === true
    );
}

/**
 * `frames` pictures of the pattern (default 15, ten per second, keyframes every five) as VP8 in
 * WebM, encoded by the browser: from `start` seconds, with `colour` as the track's colour, an
 * alpha picture (the colour picture's own bytes) when `alpha`, and `damage(chunk, index)`
 * replacing chunks.
 */
export async function patternClip({ frames = 15, start = 0, alpha = false, colour, damage } = {}) {
    const chunks = [];
    let failure;
    const encoder = new VideoEncoder({
        output: chunk => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            chunks.push({
                data,
                timestamp: start + chunk.timestamp / 1e6,
                duration: 0.1,
                isKeyframe: chunk.type === 'key',
                trackType: 'video',
            });
        },
        error: error => (failure = error),
    });
    encoder.configure({ ...VP8, bitrate: 2_000_000 });
    const rgba = patternRgba();
    for (let index = 0; index < frames; index++) {
        const frame = new VideoFrame(rgba, {
            format: 'RGBA',
            codedWidth: PATTERN.width,
            codedHeight: PATTERN.height,
            timestamp: index * 100000,
            duration: 100000,
        });
        encoder.encode(frame, { keyFrame: index % 5 === 0 });
        frame.close();
    }
    await encoder.flush();
    encoder.close();
    if (failure) throw failure;
    const sink = new MemorySink();
    const muxer = new WebMMuxer(
        {
            format: 'webm',
            mode: 'standard',
            maxFragmentDuration: 2,
            autoSync: true,
            videoColour: colour ?? { primaries: 6, transfer: 6, matrix: 6, fullRange: false },
            video: { id: 1, type: 'video', ...VP8, alphaMode: alpha },
        },
        sink,
    );
    for (const [index, chunk] of chunks.entries()) {
        const written = damage?.(chunk, index) ?? chunk;
        muxer.addVideoChunk(alpha ? { ...written, alphaData: written.data } : written);
    }
    await muxer.finalize();
    return sink.toBlob('video/webm');
}
