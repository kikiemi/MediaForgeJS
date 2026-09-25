import { MediaWorkflow as CoreWorkflow } from './core.js';
import type { MediaWorkflowOptions } from './types.js';
export { MediaJob } from './job.js';
export type * from './types.js';
/** Built-in formats, native audio and host WebCodecs conversion. */
export declare class MediaWorkflow extends CoreWorkflow {
    constructor(options?: MediaWorkflowOptions);
}
