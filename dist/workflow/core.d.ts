import type { Source, Sink } from '../types/io.js';
import type { MediaInput } from '../types/media.js';
import { type MediaOpenOptions, type MediaSegment, type SegmentOptions } from '../engine/engine-core.js';
import { MediaJob } from './job.js';
import type { MediaWorkflowOptions, MediaInspection, WorkflowRequest, WorkflowInputOptions, WorkflowSupport, WorkflowStreamInputOptions, WorkflowBatchItem, WorkflowBatchOptions, WorkflowBatchResult } from './types.js';
export { MediaJob } from './job.js';
export type * from './types.js';
/** Empty composition. Install only the format, audio and transform modules required by the application. */
export declare class MediaWorkflow {
    private readonly engine;
    private readonly audio?;
    private readonly audioDecoder?;
    private readonly transform?;
    constructor(options?: MediaWorkflowOptions);
    open(input: Source | MediaInput, options?: MediaOpenOptions): Promise<MediaJob>;
    inspect(input: Source | MediaInput, options?: MediaOpenOptions): Promise<MediaInspection>;
    check(input: Source | MediaInput, request: WorkflowRequest, options?: WorkflowInputOptions): Promise<WorkflowSupport>;
    write(input: Source | MediaInput, sink: Sink, request: WorkflowRequest, options?: WorkflowInputOptions | MediaOpenOptions): Promise<void>;
    toBlob(input: Source | MediaInput, request: WorkflowRequest, options?: WorkflowInputOptions): Promise<Blob>;
    toReadableStream(input: Source | MediaInput, request: WorkflowRequest, options?: WorkflowStreamInputOptions): ReadableStream<Uint8Array>;
    segments(input: Source | MediaInput, options?: SegmentOptions, openOptions?: MediaOpenOptions): AsyncGenerator<MediaSegment>;
    batch(items: readonly WorkflowBatchItem[], options?: WorkflowBatchOptions): Promise<WorkflowBatchResult[]>;
}
