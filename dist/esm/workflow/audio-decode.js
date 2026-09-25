import { createConfiguredAacTrackPcmSource } from '../audio/aac-track-decoder.js';
import { createMpegTrackPcmSource } from '../audio/mpeg-track-pcm-source.js';
import { createWebCodecsTrackPcmSource } from '../audio/webcodecs-pcm-source.js';
import { normalizePcmSource } from '../audio/pcm-source.js';
import { codecFamily } from '../core/codec-strings.js';
import { MediaForgeError } from '../core/errors.js';
import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { sampleClockTolerance } from '../audio/sample-clock.js';
function mpegWindow(track) {
    let frames = 0;
    const first = sampleAt(track, 0)?.timestamp ?? 0;
    const clockTolerance = sampleClockTolerance(track, 1);
    for (let index = 0, length = sampleCount(track); index < length; index++) {
        const sample = sampleAt(track, index);
        const count = Math.round(sample.duration * track.sampleRate);
        if (!Number.isSafeInteger(count) ||
            count < 1 ||
            sample.leadingDiscard ||
            Math.abs((sample.timestamp - first) * track.sampleRate - frames) > clockTolerance ||
            (sample.codecConfigIndex ?? 0) !== 0)
            throw new MediaForgeError('MPEG audio requires contiguous complete coded frames', 'FORMAT');
        frames += count;
    }
    const head = Math.round((track.editMediaTimeSeconds ??
        (track.audioPrimingSamples !== undefined
            ? track.audioPrimingSamples / track.sampleRate
            : Math.max(0, -first))) * track.sampleRate);
    const tail = track.audioTrailingPaddingSamples ?? 0;
    const valid = track.editPresentationDurationSeconds === undefined
        ? frames - head - tail
        : Math.round(track.editPresentationDurationSeconds * track.sampleRate);
    if (![head, tail, valid, frames].every(Number.isSafeInteger) ||
        head < 0 ||
        tail < 0 ||
        valid < 1 ||
        head + tail + valid > frames + 1)
        throw new MediaForgeError('MPEG trim metadata exceeds the coded presentation span', 'DEMUX');
    return { head, valid, frames };
}
export const nativeAudioDecoder = Object.freeze({
    codecs: Object.freeze(['mp4a', 'mp1', 'mp2', 'mp3']),
    createSource(track, readPacket) {
        if (track.incomplete ||
            !sampleCount(track) ||
            !Number.isInteger(track.sampleRate) ||
            track.sampleRate < 1 ||
            track.channelCount < 1 ||
            track.channelCount > 2)
            throw new MediaForgeError('Native decoding requires a complete mono/stereo audio track', 'FORMAT');
        if ((track.editLeadTimeSeconds ?? 0) !== 0)
            throw new MediaForgeError('Native audio does not synthesize leading empty edits', 'FORMAT');
        const family = codecFamily(track.codec);
        if (family === 'mp4a') {
            const prepared = createConfiguredAacTrackPcmSource(track, (_sample, index, signal) => readPacket(index, signal));
            return {
                ...prepared,
                async *chunks(signal) {
                    try {
                        yield* prepared.chunks(signal);
                    }
                    catch (error) {
                        if (error instanceof MediaForgeError || signal?.aborted)
                            throw error;
                        throw new MediaForgeError(`AAC decode failed: ${error instanceof Error ? error.message : String(error)}`, 'DECODE');
                    }
                },
            };
        }
        if (!['mp1', 'mp2', 'mp3'].includes(family))
            throw new MediaForgeError(`Audio decoder '${track.codec}' is not installed`, 'FORMAT');
        if ((track.codecConfigurations?.length ?? 0) > 1)
            throw new MediaForgeError('MPEG decoder configuration changes are unsupported', 'FORMAT');
        const window = mpegWindow(track);
        if (family === 'mp3') {
            if (typeof AudioDecoder === 'undefined')
                throw new MediaForgeError('MP3 decoding requires a host AudioDecoder or an injected WorkflowAudioDecoder', 'DECODE');
            return {
                sampleRate: track.sampleRate,
                channels: track.channelCount,
                estimatedFrames: window.valid,
                async *chunks(signal) {
                    const source = await createWebCodecsTrackPcmSource(track, (_sample, index) => readPacket(index, signal), signal);
                    if (!source)
                        throw new MediaForgeError('MP3 decoding is unavailable in this environment', 'DECODE');
                    yield* source.chunks(signal);
                },
            };
        }
        const raw = {
            sampleRate: track.sampleRate,
            channels: track.channelCount,
            estimatedFrames: window.frames,
            async *chunks(signal) {
                yield* createMpegTrackPcmSource(track, (_sample, index) => readPacket(index, signal), signal).chunks(signal);
            },
        };
        return normalizePcmSource(raw, raw.sampleRate, raw.channels, window);
    },
});
