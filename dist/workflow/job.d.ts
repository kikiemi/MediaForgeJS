import type { Sink } from '../types/io.js';
import type { MediaFile, MediaSegment, SegmentOptions } from '../engine/engine-core.js';
import type { MediaInspection, WorkflowAudio, WorkflowAudioDecoder, WorkflowBlobOptions, WorkflowRequest, WorkflowStreamOptions, WorkflowSupport, WorkflowTransform } from './types.js';
/** A retained input index; closing cancels operations and keeps the borrowed Source open. */
export declare class MediaJob {
    private busy;
    private currentFile?;
    private readonly audio?;
    private readonly audioDecoder?;
    private readonly transform?;
    constructor(file: MediaFile, audio?: WorkflowAudio, audioDecoder?: WorkflowAudioDecoder, transform?: WorkflowTransform);
    private get file();
    private acquire;
    inspect(): MediaInspection;
    private diagnostics;
    private failure;
    /** Checks known configuration without reading packets or invoking callbacks. */
    probe(request: WorkflowRequest): WorkflowSupport;
    /** Runs the complete operation against a discard sink without invoking user callbacks. */
    check(request: WorkflowRequest, options?: WorkflowBlobOptions): Promise<WorkflowSupport>;
    /** Accepted writes close the sink on success and call its optional abort() on failure. */
    write(sink: Sink, request: WorkflowRequest, options?: WorkflowBlobOptions): Promise<void>;
    private execute;
    toBlob(request: WorkflowRequest, options?: WorkflowBlobOptions): Promise<Blob>;
    toReadableStream(request: WorkflowRequest, options?: WorkflowStreamOptions): ReadableStream<Uint8Array>;
    segments(options?: SegmentOptions): AsyncGenerator<MediaSegment>;
    close(): void;
}
