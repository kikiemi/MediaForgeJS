import { DemuxError, MediaForgeError } from './errors.js';
export class DiagnosticContext {
    validation;
    metadataPolicy;
    listener;
    limit;
    entries = [];
    suppressed = 0;
    constructor(options = {}, defaultValidation = 'strict') {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new MediaForgeError('Expected diagnostic options', 'FORMAT');
        }
        const validation = options.validation ?? defaultValidation;
        const requestedMetadataPolicy = options.metadataPolicy;
        const metadataPolicy = requestedMetadataPolicy === undefined ? 'warn' : requestedMetadataPolicy;
        const listener = options.onWarning;
        const limit = options.maxWarnings ?? 100;
        if (validation !== 'strict' && validation !== 'compatible') {
            throw new MediaForgeError('validation must be strict or compatible', 'FORMAT');
        }
        if (metadataPolicy !== 'warn' && metadataPolicy !== 'error') {
            throw new MediaForgeError('metadataPolicy must be warn or error', 'FORMAT');
        }
        if (listener !== undefined && typeof listener !== 'function') {
            throw new MediaForgeError('onWarning must be a function', 'FORMAT');
        }
        if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000) {
            throw new MediaForgeError('maxWarnings must be an integer in 0..10000', 'FORMAT');
        }
        this.validation = validation;
        this.metadataPolicy = metadataPolicy;
        this.listener = listener;
        this.limit = limit;
    }
    get warnings() {
        return this.entries.slice();
    }
    get suppressedWarnings() {
        return this.suppressed;
    }
    recover(diagnostic) {
        if (this.validation === 'strict')
            throw new DemuxError(diagnostic.message);
        this.warn(diagnostic);
    }
    metadata(diagnostic) {
        this.warn(diagnostic);
        if (this.metadataPolicy === 'error')
            throw new MediaForgeError(diagnostic.message, 'FORMAT');
    }
    warn(diagnostic) {
        if (this.entries.length >= this.limit) {
            this.suppressed++;
            return;
        }
        const entry = Object.freeze({ ...diagnostic, severity: 'warning' });
        this.entries.push(entry);
        this.listener?.(entry);
    }
}
