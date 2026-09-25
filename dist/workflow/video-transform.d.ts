import type { MediaFormat } from '../engine/formats.js';
import type { WorkflowTransform } from './types.js';
import type { VideoCodecProvider } from './video-types.js';
export interface VideoTransformOptions {
    readonly formats: readonly MediaFormat[];
    readonly codecs: readonly VideoCodecProvider[];
    /** Native Workflow composition used when no supplied codec participates. */
    readonly fallback?: WorkflowTransform;
}
/** Opt-in application-owned codecs with bounded frame work; the native fallback remains instance-local. */
export declare function createVideoTransform(options: VideoTransformOptions): WorkflowTransform;
