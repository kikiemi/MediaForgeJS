import type { MediaDiagnostic } from '../core/errors/diagnostics';
import type { MediaInput, Source } from '../core/model/types';
import type { CommonOptions, MediaPlan, MediaResult } from './types';
import { extensionOf, mimeTypeOf } from '../formats/shared/mime-types';

/** Collects an operation's warnings while passing each to the caller's listener. */
export function warningCollector(listener: CommonOptions['onWarning']): {
    readonly warnings: MediaDiagnostic[];
    readonly onWarning: (warning: MediaDiagnostic) => void;
} {
    const warnings: MediaDiagnostic[] = [];
    return {
        warnings,
        onWarning: warning => {
            warnings.push(warning);
            listener?.(warning);
        },
    };
}

/** The input's file name without its extension, or 'output'. */
function baseName(input: unknown): string {
    const name = (input as { readonly name?: unknown } | null)?.name;
    if (typeof name !== 'string' || !name.trim()) return 'output';
    const file = name.split(/[\\/]/).pop()!;
    const dot = file.lastIndexOf('.');
    return dot > 0 ? file.slice(0, dot) : file;
}

/** A finished result: the Blob typed with its MIME type, a file name, the plan and the warnings. */
export function mediaResult(
    blob: Blob,
    format: string,
    plan: MediaPlan | undefined,
    warnings: readonly MediaDiagnostic[],
    input: Source | MediaInput | undefined,
): MediaResult {
    const mimeType = blob.type || mimeTypeOf(format);
    return {
        blob: blob.type ? blob : new Blob([blob], { type: mimeType }),
        format,
        mimeType,
        filename: `${baseName(input)}.${extensionOf(format)}`,
        plan: plan ?? { format, action: 'reencode', tracks: [] },
        warnings: Object.freeze([...warnings]),
    };
}
