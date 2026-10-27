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

/** ISO/IEC 23091-2 code points of the WebCodecs colour names an encoder reports. */
const CODES = {
    primaries: { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9 },
    transfer: { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13, pq: 16, hlg: 18 },
    matrix: { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 },
};

/**
 * The colour the encoder reports it converted the RGBA pictures to (Chromium on Windows: BT.709 in
 * full range), as ISO code points; BT.601 in limited range where it reports none.
 */
function reportedColour(space) {
    const [primaries, transfer, matrix] = ['primaries', 'transfer', 'matrix'].map(
        field => CODES[field][space?.[field]],
    );
    return matrix === undefined
        ? { primaries: 6, transfer: 6, matrix: 6, fullRange: false }
        : {
              primaries: primaries ?? 2,
              transfer: transfer ?? 2,
              matrix,
              fullRange: space.fullRange === true,
          };
}

/**
 * `frames` pictures of the pattern (default 15, ten per second, keyframes every five) as VP8 in
 * WebM, encoded by the browser: from `start` seconds, with `colour` as the track's colour (else
 * the one the encoder reports), an alpha picture (the colour picture's own bytes) when `alpha`,
 * and `damage(chunk, index)` replacing chunks.
 */
export async function patternClip({ frames = 15, start = 0, alpha = false, colour, damage } = {}) {
    const chunks = [];
    let failure;
    let reported;
    const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
            if (metadata?.decoderConfig) reported ??= metadata.decoderConfig.colorSpace ?? null;
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
            videoColour: colour ?? reportedColour(reported),
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
