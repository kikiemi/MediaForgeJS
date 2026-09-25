import { getCompactSampleIndex, sampleCount } from '../demux/sample-index.js';
import { copiedAudioTrackConfig, copiedVideoTrackConfig } from '../core/pipeline-track-config.js';
import { MediaForgeError } from '../core/errors.js';
const MP4 = new Set(['mp4', 'mov', 'm4a', 'm4v', '3gp']);
function presentation(track, source, target) {
    if (!MP4.has(source) ||
        !MP4.has(target) ||
        track.editLeadTimeSeconds === undefined ||
        track.editPresentationDurationSeconds === undefined ||
        !sampleCount(track))
        return undefined;
    const index = getCompactSampleIndex(track);
    let firstDecode = index ? index.decodeTimeAt(0) : Infinity;
    if (!index)
        for (const sample of track.samples)
            firstDecode = Math.min(firstDecode, sample.decodeTimestamp ?? sample.timestamp);
    const mediaTime = track.editLeadTimeSeconds - firstDecode;
    if (mediaTime < 0)
        throw new MediaForgeError('Cannot copy an MP4 edit beginning before the first coded sample', 'FORMAT');
    return {
        presentationStartSeconds: track.editLeadTimeSeconds,
        presentationDurationSeconds: track.editPresentationDurationSeconds,
        presentationMediaTimeSeconds: mediaTime,
        mediaTimescale: track.timescale,
    };
}
export function copyEngineVideoTrack(track, source, target) {
    return { ...copiedVideoTrackConfig(track), ...presentation(track, source, target) };
}
export function copyEngineAudioTrack(track, source, target) {
    const edit = presentation(track, source, target);
    if (!edit)
        return copiedAudioTrackConfig(track, target);
    return {
        id: 0,
        matroskaTrackUid: track.matroskaTrackUid,
        type: 'audio',
        codec: track.codec,
        sampleRate: track.sampleRate,
        channelCount: track.channelCount,
        codecConfig: track.codecConfig,
        language: track.language,
        default: track.default,
        forced: track.forced,
        name: track.name,
        title: track.title,
        commentary: track.commentary,
        presentationStartSeconds: edit.presentationStartSeconds,
        presentationDurationSeconds: edit.presentationDurationSeconds,
        presentationMediaTimeSeconds: edit.presentationMediaTimeSeconds,
        mediaTimescale: edit.mediaTimescale,
    };
}
