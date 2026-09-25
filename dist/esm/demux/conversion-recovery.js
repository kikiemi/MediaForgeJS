import { encodedAudioSampleCount, sourceAudioWindow } from '../core/pipeline-track-config.js';
import { recoverVideoConfigurations } from '../engine/video-config.js';
export async function recoverConversionDemux(result, source, diagnostics, signal) {
    for (const track of [...result.videoTracks, ...result.audioTracks]) {
        if (!track.incomplete)
            continue;
        let end = 0;
        for (const sample of track.samples)
            end = Math.max(end, sample.timestamp + sample.duration);
        track.duration = Math.min(track.duration, end);
        if (track.editPresentationDurationSeconds === undefined)
            continue;
        let duration = Math.max(0, end - (track.editLeadTimeSeconds ?? 0));
        if (result.audioTracks.includes(track)) {
            const rate = track.sampleRate || 48000;
            const coded = encodedAudioSampleCount(track, rate);
            const head = sourceAudioWindow(track, rate).head;
            const tail = Math.max(track.audioTrailingPaddingSamples ?? 0, track.opusTrailingPaddingSamples ?? 0);
            duration = Math.max(0, coded - head - tail) / rate;
        }
        if (duration < track.editPresentationDurationSeconds) {
            track.editPresentationDurationSeconds = duration;
            diagnostics.warn({
                code: 'MP4_RECOVERED_PRESENTATION',
                format: 'mp4',
                trackId: track.id,
                message: 'Limited the conversion presentation window to recovered complete samples',
            });
        }
    }
    await recoverVideoConfigurations(result, source, diagnostics, 64 * 1024 * 1024, signal);
}
