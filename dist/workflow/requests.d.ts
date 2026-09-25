import type { WorkflowBlobOptions, WorkflowRequest } from './types.js';
export declare const audioFormats: readonly ["wav", "aiff", "au", "caf", "flac", "aac", "mp2", "mp3"];
export declare function checkSignal(signal?: AbortSignal): void;
export declare function snapshotRequest(request: WorkflowRequest): WorkflowRequest;
export declare function outputLimit(options: WorkflowBlobOptions, fallback?: number): number;
