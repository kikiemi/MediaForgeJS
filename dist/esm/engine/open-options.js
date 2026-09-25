import { MediaForgeError } from '../core/errors.js';
export function snapshotOpenOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new MediaForgeError('Expected open options', 'INPUT');
    }
    const { format, signal, aviRecovery, maxPacketBytes, maxSamples, maxIndexBytes, cacheBytes, readPageBytes, validation, metadataPolicy, onWarning, maxWarnings, } = options;
    if (aviRecovery !== undefined && aviRecovery !== 'complete-packets')
        throw new MediaForgeError("aviRecovery must be 'complete-packets'", 'INPUT');
    return {
        format,
        signal,
        aviRecovery,
        maxPacketBytes,
        maxSamples,
        maxIndexBytes,
        cacheBytes,
        readPageBytes,
        validation,
        metadataPolicy,
        onWarning,
        maxWarnings,
    };
}
