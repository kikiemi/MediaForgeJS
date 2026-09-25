import type { MediaFormat } from '../engine/formats.js';
import type { WorkflowTransform } from './types.js';
export interface NativeVideoTransformOptions {
    readonly formats: readonly MediaFormat[];
    /** Optional input-size admission limit for conversion; omitted has no size ceiling. Packet copy is exempt. */
    readonly maxInputBytes?: number;
}
/** Opt-in native adapter over Pipeline-core; no media-element fallback and no FFmpeg. */
export declare function createNativeVideoTransform(options: NativeVideoTransformOptions): WorkflowTransform;
