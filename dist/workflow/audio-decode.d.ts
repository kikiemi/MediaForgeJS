import type { WorkflowAudioDecoder } from './types.js';
/** AAC-LC and MPEG I/II use JavaScript; MPEG III uses the host AudioDecoder when available. */
export declare const nativeAudioDecoder: WorkflowAudioDecoder;
export type { WorkflowAudioDecoder } from './types.js';
