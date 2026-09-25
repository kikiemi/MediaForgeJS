import { MediaForgeError } from './errors.js';
import { filterMatroskaTags } from './matroska-tags.js';
import { preservesMatroskaTrackTitles } from './matroska-track-titles.js';
export function trackDispositionLoss(track, format) {
    if (['mkv', 'webm', 'mp4', 'mov', 'm4a', 'm4v', '3gp', 'fmp4'].includes(format))
        return undefined;
    const dispositions = track.default !== undefined || track.forced !== undefined || track.commentary !== undefined;
    if (!dispositions && track.name === undefined && track.title === undefined)
        return undefined;
    return {
        code: dispositions ? 'TRACK_DISPOSITION_LOSS' : 'TRACK_METADATA_LOSS',
        message: `${format} writing cannot preserve the track's name, title and default/forced/commentary dispositions`,
        trackId: track.id,
        format,
    };
}
export function matroskaMetadataLoss(pass, unsupportedTags, format, tracks) {
    const lost = [];
    if (unsupportedTags)
        lost.push('malformed or unsupported metadata');
    if (pass && (format === 'mkv' || format === 'webm') && filterMatroskaTags(pass, format, tracks).unsupported) {
        lost.push('tags with missing, ambiguous or unsupported targets');
    }
    if (format !== 'mkv' && format !== 'webm') {
        if (pass?.title !== undefined && !['mp4', 'mov', 'm4a', 'm4v', '3gp', 'fmp4'].includes(format))
            lost.push('segment title');
        if (pass?.tags !== undefined &&
            (!['mp4', 'mov', 'm4a', 'm4v', '3gp', 'fmp4'].includes(format) ||
                !tracks ||
                !preservesMatroskaTrackTitles(pass.tags, tracks)))
            lost.push('tags');
    }
    if (format !== 'mkv') {
        if (pass?.chapters !== undefined)
            lost.push('chapters');
        if (pass?.attachments !== undefined)
            lost.push('attachments');
    }
    if (lost.length === 0)
        return undefined;
    return {
        code: 'MATROSKA_METADATA_LOSS',
        message: `${format} writing cannot preserve Matroska metadata: ${lost.join(', ')}`,
        format,
    };
}
export function matroskaOutputMetadata(pass, format, tracks) {
    const tags = filterMatroskaTags(pass, format, tracks).tags;
    return format === 'mkv' ? { ...pass, tags } : { title: pass.title, tags };
}
export function assertAlphaCopy(track, format, copied = true) {
    if (track.alphaMode && (!copied || (format !== 'mkv' && format !== 'webm'))) {
        throw new MediaForgeError('VP8/VP9 alpha transparency requires packet copy to MKV/WebM; this output cannot preserve it', 'FORMAT');
    }
}
