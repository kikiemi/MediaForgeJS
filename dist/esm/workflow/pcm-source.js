import { decodePcmPacket, MAX_PCM_PACKET_BYTES } from '../audio/pcm-track-source.js';
import { describePcmTrack } from '../core/pcm-format.js';
import { sampleCount, sampleAt } from '../demux/sample-index.js';
import { MediaForgeError } from '../core/errors.js';
import { sampleClockTolerance } from '../audio/sample-clock.js';
export function preparePcmSource(file, track, request) {
    const format = describePcmTrack(track);
    const count = sampleCount(track);
    if (!count || track.incomplete)
        throw new MediaForgeError('Native audio requires a complete PCM track with samples', 'FORMAT');
    if (format.channels > 2 ||
        (format.channelMask !== undefined &&
            format.channelMask !== 0 &&
            format.channelMask !== (format.channels === 1 ? 4 : 3))) {
        throw new MediaForgeError('Native PCM conversion requires mono/stereo with a canonical channel layout', 'FORMAT');
    }
    if (['wav', 'aiff', 'au', 'caf', 'flac'].includes(request.format) &&
        (format.float || format.validBitsPerSample > 16) &&
        !request.allowPrecisionLoss) {
        throw new MediaForgeError('Native audio uses PCM16; float or wider PCM requires allowPrecisionLoss: true, or use remux', 'FORMAT');
    }
    if ((track.codecConfigurations?.length ?? 0) > 1 ||
        [
            track.editMediaTimeSeconds,
            track.editLeadTimeSeconds,
            track.editAbsoluteMediaTimeSeconds,
            track.editTimelineShiftSeconds,
            track.audioPrimingSamples,
            track.audioTrailingPaddingSamples,
            track.opusTrailingPaddingSamples,
            track.matroskaCodecDelaySeconds,
        ].some(value => value !== undefined && value !== 0) ||
        track.editPresentationDurationSeconds !== undefined) {
        throw new MediaForgeError('Native PCM conversion does not support edited or trimmed packet timelines', 'FORMAT');
    }
    let frames = 0;
    const clockTolerance = sampleClockTolerance(track);
    for (let index = 0; index < count; index++) {
        const sample = sampleAt(track, index);
        if (sample.size > MAX_PCM_PACKET_BYTES) {
            throw new MediaForgeError('Native PCM conversion requires packets at most 64 MiB', 'FORMAT');
        }
        if (sample.size % format.blockAlign !== 0 ||
            sample.leadingDiscard ||
            Math.abs(sample.timestamp * format.sampleRate - frames) > (index === 0 ? 0.5 : clockTolerance) ||
            Math.abs(sample.duration * format.sampleRate - sample.size / format.blockAlign) > 0.5 ||
            (sample.decodeTimestamp !== undefined && sample.decodeTimestamp !== sample.timestamp) ||
            (sample.compositionTimeOffset ?? 0) !== 0) {
            throw new MediaForgeError('Native PCM conversion requires complete frames on a contiguous, unedited timeline starting at zero', 'FORMAT');
        }
        frames += sample.size / format.blockAlign;
        if (!Number.isSafeInteger(frames))
            throw new MediaForgeError('PCM frame count exceeds the exact integer range', 'OOM');
    }
    if (frames === 0)
        throw new MediaForgeError('Native PCM conversion requires nonempty samples', 'FORMAT');
    return {
        sampleRate: format.sampleRate,
        channels: format.channels,
        estimatedFrames: frames,
        async *chunks(signal) {
            for (let index = 0; index < count; index++) {
                const packet = await file.readPacket(track.id, index, signal);
                yield* decodePcmPacket(packet.data, format, signal);
            }
        },
    };
}
