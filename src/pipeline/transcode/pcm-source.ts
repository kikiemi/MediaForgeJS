import type { TrackInfo } from '../../core/model/track';
import type { FilePacket } from '../media-types';
import { declarePacketStarts, type ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { decodePcmPacket, MAX_PCM_PACKET_BYTES } from '../../codecs/pcm/pcm-track-source';
import { describePcmTrack } from '../../core/codec-config/audio/pcm-format';
import { sampleCount, sampleAt } from '../../core/model/sample-index';
import { MediaForgeError } from '../../core/errors/errors';
import { sampleClockTolerance } from '../../core/model/sample-clock';
import { layoutMask } from '../../core/model/channel-layout';

/**
 * True when a PCM track's packets present its samples as they are: one configuration, no edits or
 * codec trims.
 */
function plainTimeline(track: TrackInfo): boolean {
    // An edit list that starts at media time zero only bounds the presented length (QuickTime
    // writers emit one for every track); leading edits and codec trims are not presented by linear
    // PCM reading.
    return (
        (track.codecConfigurations?.length ?? 0) <= 1 &&
        [
            track.editMediaTimeSeconds,
            track.editLeadTimeSeconds,
            track.editAbsoluteMediaTimeSeconds,
            track.editTimelineShiftSeconds,
            track.audioPrimingSamples,
            track.audioTrailingPaddingSamples,
            track.opusTrailingPaddingSamples,
            track.matroskaCodecDelaySeconds,
        ].every(value => value === undefined || value === 0)
    );
}

/** Reads a packet of a track by its index, as MediaFile.readPacket() does. */
export type TrackPacketRead = (index: number, signal?: AbortSignal) => Promise<FilePacket>;

/**
 * The samples of a linear PCM track, its packets read through `read` without a decoder. The
 * packets must hold complete frames on a contiguous, unedited timeline from zero; anything else
 * fails with FORMAT.
 */
export function pcmTrackSource(track: TrackInfo, read: TrackPacketRead): ReplayablePcmSource {
    const format = describePcmTrack(track);
    const count = sampleCount(track);
    if (!count || track.incomplete)
        throw new MediaForgeError('Reading PCM needs a complete track with samples', 'FORMAT');
    if (format.channels > 8)
        throw new MediaForgeError('Reading PCM supports at most eight channels', 'FORMAT');
    if (!plainTimeline(track))
        throw new MediaForgeError(
            'Reading PCM does not support edited or trimmed packet timelines',
            'FORMAT',
        );

    let frames = 0;
    const clockTolerance = sampleClockTolerance(track);
    for (let index = 0; index < count; index++) {
        const sample = sampleAt(track, index)!;
        if (sample.size > MAX_PCM_PACKET_BYTES)
            throw new MediaForgeError('Reading PCM needs packets of at most 64 MiB', 'FORMAT');
        if (
            sample.size % format.blockAlign !== 0 ||
            sample.leadingDiscard ||
            Math.abs(sample.timestamp * format.sampleRate - frames) >
                (index === 0 ? 0.5 : clockTolerance) ||
            Math.abs(sample.duration * format.sampleRate - sample.size / format.blockAlign) > 0.5 ||
            (sample.decodeTimestamp !== undefined && sample.decodeTimestamp !== sample.timestamp) ||
            (sample.compositionTimeOffset ?? 0) !== 0
        )
            throw new MediaForgeError(
                'Reading PCM needs whole frames on a gapless timeline from zero',
                'FORMAT',
            );
        frames += sample.size / format.blockAlign;
        if (!Number.isSafeInteger(frames))
            throw new MediaForgeError('PCM frame count exceeds the exact integer range', 'OOM');
    }

    let presented = frames;
    if (track.editPresentationDurationSeconds !== undefined)
        presented = Math.min(
            frames,
            Math.round(track.editPresentationDurationSeconds * format.sampleRate),
        );
    if (presented < 1)
        throw new MediaForgeError('Reading PCM needs a nonempty presentation', 'FORMAT');

    const channelMask = layoutMask(format.channels, format.channelMask);

    /** The presented samples from packet `first`, which starts at frame `from`. */
    const samplesFrom = (first: number, from: number): ReplayablePcmSource => ({
        sampleRate: format.sampleRate,
        channels: format.channels,
        estimatedFrames: presented - from,
        ...(channelMask !== undefined ? { channelMask } : {}),
        async *chunks(signal) {
            let emitted = from;
            for (let index = first; index < count && emitted < presented; index++) {
                const packet = await read(index, signal);
                for (const planes of decodePcmPacket(packet.data, format, signal)) {
                    const keep = Math.min(planes[0]!.length, presented - emitted);
                    if (keep <= 0) return;
                    yield keep === planes[0]!.length
                        ? planes
                        : planes.map(plane => plane.subarray(0, keep));
                    emitted += keep;
                }
            }
        },
    });

    // Every packet holds whole frames, so a range reads from the packet it starts in.
    return declarePacketStarts(
        samplesFrom(0, 0),
        count,
        index => sampleAt(track, index)!.size / format.blockAlign,
        (index, from) => (from < presented ? samplesFrom(index, from) : undefined),
    );
}
