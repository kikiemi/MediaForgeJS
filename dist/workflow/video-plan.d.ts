import type { MediaFile } from '../engine/engine-core.js';
import type { RemuxTrack } from '../engine/remux-plan.js';
import type { MuxerConfig } from '../types/container.js';
import type { DiagnosticContext } from '../core/diagnostics.js';
import type { WorkflowConvertRequest } from './types.js';
import type { VideoCodecProvider } from './video-types.js';
export interface ProviderVideoPlan {
    readonly tracks: readonly RemuxTrack[];
    readonly video: RemuxTrack;
    readonly decode?: VideoCodecProvider;
    readonly encode?: VideoCodecProvider;
    readonly config: MuxerConfig;
}
export declare function providerVideoPlan(file: MediaFile, request: WorkflowConvertRequest, codecs: readonly VideoCodecProvider[], diagnostics: DiagnosticContext): ProviderVideoPlan | undefined;
