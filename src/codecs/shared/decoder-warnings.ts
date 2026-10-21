/** Damage diagnostics delivered per decoder; later ones are counted into one final notice. */
const DECODER_WARNINGS = 24;

/**
 * One decoder's damage reporter: up to DECODER_WARNINGS messages reach `onWarning`, then one
 * notice that further ones are suppressed. Without `onWarning` they are only counted, as every
 * warning of the library without a listener.
 */
export class DecoderWarnings {
    /** Diagnostics raised so far, including the suppressed ones. */
    count = 0;

    constructor(private readonly onWarning?: (message: string) => void) {}

    warn(message: string): void {
        this.count++;
        if (!this.onWarning || this.count > DECODER_WARNINGS + 1) return;
        this.onWarning(this.count > DECODER_WARNINGS ? 'further diagnostics suppressed' : message);
    }
}
