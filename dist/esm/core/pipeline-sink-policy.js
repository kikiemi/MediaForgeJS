import { MediaForgeError } from './errors.js';
export function assertSinkContainerSupport(cfg, sink) {
    if (cfg.outputFormat !== 'avi' || sink.patchAt)
        return;
    throw new MediaForgeError('AVI sink output requires patchAt(); a non-seekable destination would force the ' +
        'classic AVI muxer to retain every encoded payload. Use a seekable sink or choose ' +
        'MP4, MKV, WebM, FLV or TS.', 'FORMAT');
}
export function assertSinkTrackSupport(result) {
    if ((result.subtitleTracks?.length ?? 0) > 0) {
        throw new MediaForgeError(`sink output cannot yet interleave ${result.subtitleTracks.length} subtitle track(s) safely; ` +
            'use run()/convert() or remove the subtitle tracks', 'FORMAT');
    }
}
