import { DemuxError, MediaForgeError } from './errors';

export type ValidationMode = 'strict' | 'compatible';

export type MetadataPolicy = 'warn' | 'error';

export interface MediaDiagnostic {
    readonly code: string;
    readonly message: string;
    readonly severity: 'warning';
    readonly format?: string;
    readonly offset?: number;
    readonly trackId?: number;
}

export interface DiagnosticOptions {
    readonly validation?: ValidationMode;
    /** Optional metadata loss warns by default, independently of structural validation. */
    readonly metadataPolicy?: MetadataPolicy;
    readonly onWarning?: (diagnostic: MediaDiagnostic) => void;
    /**
     * Maximum retained and delivered warnings per context; further warnings are counted. Default
     * 100.
     */
    readonly maxWarnings?: number;
}

/** Receives one warning; the severity is added where it is delivered. */
export type Warn = (warning: Omit<MediaDiagnostic, 'severity'>) => void;

export class DiagnosticContext {
    readonly validation: ValidationMode;
    readonly metadataPolicy: MetadataPolicy;
    private readonly listener?: (diagnostic: MediaDiagnostic) => void;
    private readonly limit: number;
    private readonly entries: MediaDiagnostic[] = [];
    private suppressed = 0;
    private recovered = 0;

    constructor(options: DiagnosticOptions = {}, defaultValidation: ValidationMode = 'strict') {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new MediaForgeError('Expected diagnostic options', 'INPUT');
        }
        const validation = options.validation ?? defaultValidation;
        const requestedMetadataPolicy = options.metadataPolicy;
        const metadataPolicy =
            requestedMetadataPolicy === undefined ? 'warn' : requestedMetadataPolicy;
        const listener = options.onWarning;
        const limit = options.maxWarnings ?? 100;

        if (validation !== 'strict' && validation !== 'compatible') {
            throw new MediaForgeError('validation must be strict or compatible', 'INPUT');
        }
        if (metadataPolicy !== 'warn' && metadataPolicy !== 'error') {
            throw new MediaForgeError('metadataPolicy must be warn or error', 'INPUT');
        }
        if (listener !== undefined && typeof listener !== 'function') {
            throw new MediaForgeError('onWarning must be a function', 'INPUT');
        }
        if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000) {
            throw new MediaForgeError('maxWarnings must be an integer in 0..10000', 'INPUT');
        }

        this.validation = validation;
        this.metadataPolicy = metadataPolicy;
        this.listener = listener;
        this.limit = limit;
    }

    /**
     * A context of the same validation and metadata policy, its warnings to `onWarning` (default:
     * kept to itself).
     */
    fresh(onWarning?: (diagnostic: MediaDiagnostic) => void): DiagnosticContext {
        return new DiagnosticContext({
            validation: this.validation,
            metadataPolicy: this.metadataPolicy,
            onWarning,
        });
    }

    get warnings(): readonly MediaDiagnostic[] {
        return this.entries.slice();
    }
    get suppressedWarnings(): number {
        return this.suppressed;
    }
    /** Damage reported with recover() and read past, which leaves the tracks read incomplete. */
    get recoveries(): number {
        return this.recovered;
    }

    /**
     * Reports recovered damage; strict validation fails with DEMUX and `strictMessage` (default:
     * the warning's).
     */
    recover(
        diagnostic: Omit<MediaDiagnostic, 'severity'>,
        strictMessage = diagnostic.message,
    ): void {
        if (this.validation === 'strict') throw new DemuxError(strictMessage);
        this.recovered++;
        this.warn(diagnostic);
    }

    /**
     * Reports `code` of a `format` reader with `message` through warn() or recover(), placed in the
     * file or a stream by `at`.
     */
    note(
        kind: 'warn' | 'recover',
        format: string,
        code: string,
        message: string,
        at?: { offset: number } | { trackId: number },
    ): void {
        this[kind]({ code, format, ...at, message });
    }

    /**
     * Reports what an output leaves out or approximates (a track, alpha, a channel layout): a
     * warning, or a FORMAT error under strict validation.
     */
    lose(diagnostic: Omit<MediaDiagnostic, 'severity'>): void {
        if (this.validation === 'strict') throw new MediaForgeError(diagnostic.message, 'FORMAT');
        this.warn(diagnostic);
    }

    metadata(diagnostic: Omit<MediaDiagnostic, 'severity'>): void {
        this.warn(diagnostic);
        if (this.metadataPolicy === 'error')
            throw new MediaForgeError(diagnostic.message, 'FORMAT');
    }

    warn(diagnostic: Omit<MediaDiagnostic, 'severity'>): void {
        if (this.entries.length >= this.limit) {
            this.suppressed++;
            return;
        }
        const entry: MediaDiagnostic = Object.freeze({ ...diagnostic, severity: 'warning' });
        this.entries.push(entry);
        this.listener?.(entry);
    }
}
