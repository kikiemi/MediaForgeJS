import type { Source } from '../types/io.js';
import { DiagnosticContext } from '../core/diagnostics.js';
/** Inspects top-level boxes; recovery never invents missing metadata or media bytes. */
export declare function compatibleMp4Source(source: Source, diagnostics: DiagnosticContext, signal?: AbortSignal): Promise<Source>;
