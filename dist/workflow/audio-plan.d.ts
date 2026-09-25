import type { MediaFile } from '../engine/engine-core.js';
import type { ReplayablePcmSource } from '../audio/pcm-source.js';
import type { DiagnosticContext } from '../core/diagnostics.js';
import type { WorkflowAudio, WorkflowAudioConfig, WorkflowAudioDecoder, WorkflowAudioRequest } from './types.js';
export declare function audioPlan(file: MediaFile, request: WorkflowAudioRequest, diagnostics: DiagnosticContext, audio?: WorkflowAudio, decoder?: WorkflowAudioDecoder): {
    source: ReplayablePcmSource;
    config: WorkflowAudioConfig;
    support: {
        readonly supported: true;
        readonly operation: "audio";
        readonly outputFormat: import("./types.js").WorkflowAudioFormat;
        readonly trackId: number;
        readonly sampleRate: number;
        readonly channels: number;
        readonly pcmBits?: 16;
        readonly lossless: false;
        readonly warnings: readonly import("../index.js").MediaDiagnostic[];
    };
};
