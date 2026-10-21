import type { TrackInfo } from '../../core/model/track';
import type { MediaTags } from '../../core/model/media';
import { DemuxError } from '../../core/errors/errors';
import { copyOutputBytes } from '../../core/bytes/output-data';
import {
    bindCompactSampleIndex,
    bindPacketizedReader,
    getCompactSampleIndex,
    packetizedReaderOf,
} from '../../core/model/sample-index';

/** An owned copy of the input's tags, holding its title when the reader gave it apart. */
export function snapshotTags(
    tags: MediaTags | undefined,
    title: string | undefined,
): MediaTags | undefined {
    if (tags !== undefined && (!tags || typeof tags !== 'object' || !Array.isArray(tags.entries)))
        throw new DemuxError('Media tags must be an object with an entries array');
    const entries = (tags?.entries ?? []).map(({ key, value }) => {
        if (typeof key !== 'string' || typeof value !== 'string')
            throw new DemuxError('Media tag keys and values must be strings');
        return { key, value };
    });
    if (title !== undefined && !entries.some(entry => entry.key === 'title'))
        entries.unshift({ key: 'title', value: title });
    const chapters = (tags?.chapters ?? []).map(chapter => ({ ...chapter }));
    const pictures = (tags?.pictures ?? []).map(picture => ({
        ...picture,
        data: copyOutputBytes(picture.data),
    }));
    if (!entries.length && !chapters.length && !pictures.length) return undefined;
    return {
        entries,
        ...(chapters.length ? { chapters } : {}),
        ...(pictures.length ? { pictures } : {}),
    };
}

/**
 * A copy of the fields of a track a snapshot keeps, in their order. Each is read once, so a getter
 * of the reader's track runs once. A compact index the file keeps stands for the samples, added in
 * their place: a copy built in one order keeps one shape, where a replaced property would not.
 */
export function snapshotTrack(track: TrackInfo, owned = false): TrackInfo {
    if (!track || typeof track !== 'object') throw new DemuxError('Invalid media track');
    const compact = owned ? getCompactSampleIndex(track) : undefined;
    const copy: Omit<TrackInfo, 'samples'> & Partial<Pick<TrackInfo, 'samples'>> = {
        id: track.id,
        matroskaTrackUid: track.matroskaTrackUid,
        language: track.language,
        name: track.name,
        title: track.title,
        colour: track.colour,
        fieldOrder: track.fieldOrder,
        default: track.default,
        forced: track.forced,
        commentary: track.commentary,
        dispositions: track.dispositions,
        alphaMode: track.alphaMode,
        opusTrailingPaddingSamples: track.opusTrailingPaddingSamples,
        audioTrailingPaddingSamples: track.audioTrailingPaddingSamples,
        audioPrimingSamples: track.audioPrimingSamples,
        decoderDelaySamples: track.decoderDelaySamples,
        incomplete: track.incomplete,
        matroskaCodecDelaySeconds: track.matroskaCodecDelaySeconds,
        editLeadTimeSeconds: track.editLeadTimeSeconds,
        editAbsoluteMediaTimeSeconds: track.editAbsoluteMediaTimeSeconds,
        editTimelineShiftSeconds: track.editTimelineShiftSeconds,
        editMediaTimeSeconds: track.editMediaTimeSeconds,
        editPresentationDurationSeconds: track.editPresentationDurationSeconds,
        editPresentationDurationUnits: track.editPresentationDurationUnits,
        editList: track.editList,
        editSplices: track.editSplices,
        presentationTimestampsIncludeEdits: track.presentationTimestampsIncludeEdits,
        codec: track.codec,
        width: track.width,
        height: track.height,
        displayWidth: track.displayWidth,
        displayHeight: track.displayHeight,
        pixelAspectRatioNum: track.pixelAspectRatioNum,
        pixelAspectRatioDen: track.pixelAspectRatioDen,
        rotation: track.rotation,
        sampleRate: track.sampleRate,
        channelCount: track.channelCount,
        duration: track.duration,
    };
    const snapshot = copy as TrackInfo;
    if (compact) bindCompactSampleIndex(snapshot, compact);
    else snapshot.samples = track.samples;
    snapshot.codecConfig = track.codecConfig;
    snapshot.codecConfigurations = track.codecConfigurations;
    snapshot.dolbyVisionConfig = track.dolbyVisionConfig;
    snapshot.spatial = track.spatial;
    snapshot.spatialBoxes = track.spatialBoxes;
    snapshot.timescale = track.timescale;
    snapshot.timestampResolutionSeconds = track.timestampResolutionSeconds;
    const packetized = owned ? packetizedReaderOf(track) : undefined;
    if (packetized) bindPacketizedReader(snapshot, packetized);
    return snapshot;
}
