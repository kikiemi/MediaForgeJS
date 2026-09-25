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
    /** Maximum retained and delivered warnings per context; further warnings are counted. Default 100. */
    readonly maxWarnings?: number;
}
export declare class DiagnosticContext {
    readonly validation: ValidationMode;
    readonly metadataPolicy: MetadataPolicy;
    private readonly listener?;
    private readonly limit;
    private readonly entries;
    private suppressed;
    constructor(options?: DiagnosticOptions, defaultValidation?: ValidationMode);
    get warnings(): readonly MediaDiagnostic[];
    get suppressedWarnings(): number;
    recover(diagnostic: Omit<MediaDiagnostic, 'severity'>): void;
    metadata(diagnostic: Omit<MediaDiagnostic, 'severity'>): void;
    warn(diagnostic: Omit<MediaDiagnostic, 'severity'>): void;
}
