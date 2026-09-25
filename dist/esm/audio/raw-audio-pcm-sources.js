import { demuxRawAudio, UnsupportedAdtsLayoutError } from '../demux/raw-audio-demuxer.js';
import { logger } from '../core/logger.js';
import { MediaForgeError } from '../core/errors.js';
import { awaitWithAbort } from '../core/abort.js';
import { DEMUX_LIMITS } from '../core/demux-guard.js';
import { BlobSource } from '../io/sources.js';
import { createConfiguredAacTrackPcmSource } from './aac-track-decoder.js';
import { createMpegTrackPcmSource } from './mpeg-track-pcm-source.js';
import { createWebCodecsTrackPcmSource } from './webcodecs-pcm-source.js';
function checkAbort(signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
export async function createAdtsPcmSource(file, signal) {
    checkAbort(signal);
    const source = new BlobSource(file);
    let track;
    try {
        const result = await demuxRawAudio(source, {
            format: 'aac',
            signal,
            maxSamples: DEMUX_LIMITS.maxSamplesPerTrack,
            onWarning: warning => logger.warn(warning.message),
        });
        track = result.audioTracks[0];
    }
    catch (error) {
        if (error instanceof UnsupportedAdtsLayoutError) {
            checkAbort(signal);
            return null;
        }
        throw error;
    }
    if (!track || track.codec !== 'mp4a.40.2' || track.channelCount > 2)
        return null;
    return createConfiguredAacTrackPcmSource(track, sample => awaitWithAbort(source.read(sample.offset, sample.size), signal), { signal });
}
async function scanMpegTrack(file, expectedFormat, signal) {
    checkAbort(signal);
    const blobSource = new BlobSource(file);
    const result = await demuxRawAudio(blobSource, {
        format: expectedFormat,
        signal,
        maxSamples: DEMUX_LIMITS.maxSamplesPerTrack,
        onWarning: warning => logger.warn(warning.message),
    });
    const track = result.audioTracks[0];
    if (!track)
        return null;
    return {
        track,
        readSample: async (sample) => {
            checkAbort(signal);
            return awaitWithAbort(blobSource.read(sample.offset, sample.size), signal);
        },
    };
}
export async function createRawMpegPcmSource(file, format, signal) {
    checkAbort(signal);
    const scanned = await scanMpegTrack(file, format, signal);
    checkAbort(signal);
    if (!scanned)
        return null;
    if (format === 'mp3') {
        const webCodecs = await awaitWithAbort(createWebCodecsTrackPcmSource(scanned.track, scanned.readSample, signal), signal);
        checkAbort(signal);
        return webCodecs;
    }
    return createMpegTrackPcmSource(scanned.track, scanned.readSample, signal);
}
