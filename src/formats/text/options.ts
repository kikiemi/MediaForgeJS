import { MediaForgeError } from '../../core/errors/errors';
import type { AssSubtitleOptions, ParseSubtitleOptions, SubtitleOptions } from './types';

export function snapshotSubtitleOptions(options: SubtitleOptions): SubtitleOptions {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new MediaForgeError('Expected subtitle options', 'INPUT');
    }
    const {
        validation,
        metadataPolicy,
        onWarning,
        maxWarnings,
        maxBytes,
        maxCues,
        maxBlocks,
        maxDepth,
        maxNodes,
    } = options;
    return {
        validation,
        metadataPolicy,
        onWarning,
        maxWarnings,
        maxBytes,
        maxCues,
        maxBlocks,
        maxDepth,
        maxNodes,
    };
}

export function snapshotInterchangeOptions<T extends AssSubtitleOptions | ParseSubtitleOptions>(
    options: T,
): T {
    const base = snapshotSubtitleOptions(options);
    const { format, encoding } = options;
    if (encoding !== undefined && (typeof encoding !== 'string' || !encoding)) {
        throw new MediaForgeError('Expected a subtitle encoding label', 'INPUT');
    }
    return { ...base, format, encoding } as T;
}
