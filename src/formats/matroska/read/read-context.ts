import type { ByteReader } from '../../../core/io/sources/chunk-reader';
import type { DiagnosticContext } from '../../../core/errors/diagnostics';
import { malformedInput } from '../../../core/errors/demux-guard';

/** What the parts of the Matroska reader loaded on demand use of the reader reading an input. */
export interface MatroskaReadContext {
    readonly reader: ByteReader;
    readonly signal: AbortSignal | undefined;
    readonly diagnostics: DiagnosticContext | undefined;
    /** Counts index bytes against the budget when the reader keeps compact indexes. */
    reserveIndexBytes(bytes: number): void;
}

/** Whether damage is read past: compatible validation, which reading without diagnostics is not. */
export function readsPastDamage(diagnostics: DiagnosticContext | undefined): boolean {
    return diagnostics?.validation === 'compatible';
}

/**
 * Reports damage read past through the diagnostics' recovery, which leaves the tracks incomplete;
 * where damage is not read past (strict validation), fails with `strictMessage` as malformed input.
 */
export function recoverDamage(
    diagnostics: DiagnosticContext | undefined,
    code: string,
    message: string,
    offset: number,
    strictMessage = message,
): void {
    if (!readsPastDamage(diagnostics)) malformedInput(strictMessage);
    diagnostics!.recover({ code, format: 'matroska', message, offset });
}
