export type { ConversionOptions, ConversionAudio } from './conversion/context.js';
import { type ConversionOptions } from './conversion/context.js';
import type { Sink, Source } from './types/io.js';
import type { MediaInput } from './types/media.js';
import type { PipelineConfig } from './core/pipeline-config.js';
import { type ReadableStreamSinkOptions } from './io/readable-stream-sink.js';
export type { PipelineConfig } from './core/pipeline-config.js';
export declare function toInputBlob(input: MediaInput): Blob;
export declare class Pipeline {
    private externalSink;
    private running;
    private operationFailure;
    private runAudioLanguage?;
    private runVideoLanguage?;
    private runTitle?;
    private runVideoColour?;
    private readonly audioComponent?;
    private get audio();
    private readonly components;
    private readonly videoComponent?;
    private get video();
    private readonly domComponent?;
    private get dom();
    private readonly planner;
    private readonly remuxPlanner;
    private readonly muxerFactory;
    private beginRun;
    /** Reads native input on demand without closing borrowed Sources. Index and mux tables may grow with packets. */
    runToSink(input: MediaInput | Source, sink: Sink): Promise<void>;
    /** Starts runToSink() behind a byte-counted, cancellable ReadableStream. */
    runToReadableStream(input: MediaInput | Source, options?: ReadableStreamSinkOptions): ReadableStream<Uint8Array>;
    private lastNativeError;
    private readonly cfg;
    /** Creates a pipeline bound to `cfg`; one run at a time per instance. */
    constructor(cfg: PipelineConfig, options?: ConversionOptions);
    private videoBitrateFor;
    private audioBitrateFor;
    private targetAudioParams;
    private hasDynamicCodecConfiguration;
    private sourceAudioShape;
    private videoPayloadForSample;
    private estimateFps;
    private encoderFps;
    private estimateFpsFromDurations;
    private targetVideoDimensions;
    /** Buffers the muxed output in a Blob. Borrows Source input; rejects overlapping runs on one instance (FORMAT). */
    run(input: MediaInput | Source): Promise<Blob>;
    private runInner;
    private chooseDemuxer;
    private runWebCodecsGeneric;
    private canDirectRemuxVideo;
    private canDirectRemuxAudio;
    private directAudioStartIndex;
    private wireAudioPadding;
    private remuxInterleaved;
    private remuxVideoTrack;
    private remuxAudioTrack;
    private pipeVideo;
    private pipeAudio;
    private runDOM;
    private encodeAudioBuffer;
    private makeMuxer;
    private report;
    private recordFailure;
    private checkAbort;
    private isAbort;
    private yield;
    private drainOutput;
}
