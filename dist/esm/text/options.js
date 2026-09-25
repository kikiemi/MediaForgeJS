import { MediaForgeError } from '../core/errors.js';
export function snapshotSubtitleOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new MediaForgeError('Expected subtitle options', 'FORMAT');
    }
    const { validation, metadataPolicy, onWarning, maxWarnings, maxBytes, maxCues, maxBlocks, maxDepth, maxNodes } = options;
    return { validation, metadataPolicy, onWarning, maxWarnings, maxBytes, maxCues, maxBlocks, maxDepth, maxNodes };
}
export function snapshotInterchangeOptions(options) {
    const base = snapshotSubtitleOptions(options);
    const { format, encoding } = options;
    if (encoding !== undefined && (typeof encoding !== 'string' || !encoding)) {
        throw new MediaForgeError('Expected a subtitle encoding label', 'FORMAT');
    }
    return { ...base, format, encoding };
}
