import type { MediaFile } from '../engine/engine-core.js';
import type { RemuxTrack } from '../engine/remux-plan.js';
import type { ConversionContext } from '../conversion/context.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { type PipelineConfig } from '../core/pipeline-config.js';
import type { WorkflowConvertRequest } from './types.js';
export interface NativeConversionPlan {
    readonly copy: boolean;
    readonly tracks: readonly RemuxTrack[];
    readonly config: PipelineConfig;
    readonly video?: RemuxTrack;
    readonly audio?: RemuxTrack;
    readonly videoCopy: boolean;
    readonly audioCopy: boolean;
    readonly nativeAudioDecode: boolean;
    readonly nativeAudioEncode: boolean;
}
export declare function freshDiagnostics(context: DiagnosticContext): DiagnosticContext;
export declare function forwardDiagnostics(from: DiagnosticContext, to: DiagnosticContext): void;
export declare function nativeConversionPlan(file: MediaFile, request: WorkflowConvertRequest, context: ConversionContext, maxInputBytes: number | undefined, diagnostics: DiagnosticContext): NativeConversionPlan;
