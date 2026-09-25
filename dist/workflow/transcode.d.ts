export { createNativeVideoTransform } from './transcode-core.js';
export type { NativeVideoTransformOptions } from './transcode-core.js';
export type { WorkflowConvertRequest, WorkflowConvertSupport, WorkflowTransform } from './types.js';
/** Explicit native Pipeline composition for Workflow, including AAC fallback but excluding DOM fallback. */
export declare const nativeVideoTransform: import("./types.js").WorkflowTransform;
