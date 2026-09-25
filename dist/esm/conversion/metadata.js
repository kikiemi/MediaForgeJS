import { DiagnosticContext } from '../core/diagnostics.js';
import { logger } from '../core/logger.js';
import { matroskaMetadataLoss, trackDispositionLoss } from '../core/track-metadata.js';
const MP4_FAMILY = new Set(['mp4', 'mov', '3gp', 'm4v', 'm4a']);
export function reportConversionMetadata(result, format, tracks, policy, label) {
    const diagnostics = new DiagnosticContext({
        metadataPolicy: policy,
        onWarning: warning => logger.warn(`[${label}] ${warning.message}`),
    });
    const metadataLoss = matroskaMetadataLoss(result.matroskaPassThrough, result.matroskaUnsupportedTags, format, tracks);
    if (metadataLoss)
        diagnostics.metadata(metadataLoss);
    for (const track of tracks) {
        const loss = trackDispositionLoss(track, format);
        if (loss)
            diagnostics.metadata(loss);
        if (MP4_FAMILY.has(format) && track.language && !/^[a-z]{3}$/i.test(track.language)) {
            diagnostics.metadata({
                code: 'MP4_LANGUAGE_LOSS',
                message: 'MP4 writing cannot preserve this language tag and will use und',
                format,
                trackId: track.id,
            });
        }
    }
}
