import { MediaForgeError } from '../core/errors.js';
import { yieldEventLoop } from '../core/demux-guard.js';
import { awaitWithAbort, linkAbortSignals } from '../core/abort.js';
import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { StreamingMpegLayer12Decoder } from './mpeg-layer12-decoder.js';
function checkAbort(signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
export function createMpegTrackPcmSource(track, readSample, signal) {
    const format = track.codec;
    return {
        sampleRate: track.sampleRate,
        channels: track.channelCount,
        estimatedFrames: Math.round(track.duration * track.sampleRate),
        async *chunks(replaySignal) {
            const linked = linkAbortSignals(signal, replaySignal);
            const decoder = new StreamingMpegLayer12Decoder();
            try {
                for (let index = 0, count = sampleCount(track); index < count; index++) {
                    checkAbort(linked.signal);
                    const sample = sampleAt(track, index);
                    const bytes = await awaitWithAbort(readSample(sample, index), linked.signal);
                    checkAbort(linked.signal);
                    let planes;
                    try {
                        planes = decoder.pushFrame(bytes);
                    }
                    catch (error) {
                        if (error instanceof MediaForgeError)
                            throw error;
                        throw new MediaForgeError(`${format.toUpperCase()} decode failed at frame ${index}: ${error instanceof Error ? error.message : String(error)}`, 'DECODE');
                    }
                    checkAbort(linked.signal);
                    yield planes;
                    if ((index & 31) === 31) {
                        await awaitWithAbort(yieldEventLoop(), linked.signal);
                    }
                }
            }
            finally {
                linked.dispose();
            }
        },
    };
}
