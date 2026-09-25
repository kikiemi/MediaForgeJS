import type { EncodedChunk, TrackType } from '../types/media.js';
import type { Sink } from '../types/io.js';
import type { EventMessage } from '../metadata/emsg.js';
export interface CmafTrack {
    readonly id: number;
    readonly type: TrackType;
    readonly codec: string;
    readonly timescale: number;
    readonly width?: number;
    readonly height?: number;
    readonly pixelAspectRatioNum?: number;
    readonly pixelAspectRatioDen?: number;
    readonly sampleRate?: number;
    readonly channelCount?: number;
    /** avcC/hvcC/av1C/dOps/dac3/dec3 payload, full vpcC payload, AAC ASC, raw FLAC STREAMINFO, 24-byte ALACSpecificConfig, or UTF-8 vttC. */
    readonly codecConfig?: Uint8Array;
    readonly language?: string;
    readonly default?: boolean;
    readonly forced?: boolean;
    readonly commentary?: boolean;
    readonly name?: string;
    readonly title?: string;
    readonly namespace?: string;
    readonly schemaLocation?: string;
    readonly auxiliaryMimeTypes?: string;
}
export interface CmafWriterOptions {
    readonly tracks: readonly CmafTrack[];
    readonly title?: string;
    readonly maxBufferedBytes?: number;
    readonly maxBufferedSamples?: number;
    /** Defaults to 1000; zero disables events. Encoded event bytes also count against maxBufferedBytes. */
    readonly maxBufferedEvents?: number;
    readonly sequenceNumber?: number;
}
export interface CmafSample {
    readonly trackId: number;
    readonly data: Uint8Array;
    /** Exact nonnegative decode timestamp in this track's timescale. */
    readonly decodeTimestamp: bigint | number;
    readonly duration: number;
    readonly compositionTimeOffset?: number;
    readonly isKeyframe: boolean;
}
export interface CmafFlushOptions {
    /** Defaults to true. False permits dependent chunks within a segment. */
    readonly requireKeyframe?: boolean;
    readonly producerReferenceTime?: CmafProducerReferenceTime;
}
export interface CmafProducerReferenceTime {
    readonly trackId: number;
    /** Unsigned NTP timestamp: seconds since 1900 in the high 32 bits, fractional seconds in the low 32 bits. */
    readonly ntpTimestamp: bigint;
    /** Presentation time in the referenced track's timescale. */
    readonly mediaTime: bigint | number;
}
export interface CmafSegmentTrack {
    readonly trackId: number;
    readonly timescale: number;
    readonly baseDecodeTime: bigint;
    readonly duration: bigint;
    readonly sampleCount: number;
    readonly independent: boolean;
}
export interface CmafSegmentInfo {
    readonly sequenceNumber: number;
    readonly byteLength: number;
    readonly independent: boolean;
    readonly tracks: readonly CmafSegmentTrack[];
}
export interface CmafSegment extends CmafSegmentInfo {
    readonly data: Uint8Array;
}
/** Bounded fragmented MP4 writer for CMAF-oriented packaging; codec/profile conformance remains caller-owned. */
export declare class CmafWriter {
    private readonly states;
    private readonly init;
    private readonly maxBytes;
    private readonly maxSamples;
    private readonly maxEvents;
    private events;
    private eventBytes;
    private bytes;
    private samples;
    private sequence;
    private writing;
    private failure;
    private failed;
    constructor(options: CmafWriterOptions);
    /** Retained sample payload and encoded emsg bytes; excludes initialization and fragment headers. */
    get bufferedBytes(): number;
    get bufferedSamples(): number;
    get bufferedEvents(): number;
    createInitSegment(): Uint8Array;
    writeInitSegment(sink: Sink, signal?: AbortSignal): Promise<void>;
    /** Copies an emsg for the next nonempty fragment; version-0 deltas are relative to that fragment's presentation start. */
    addEvent(event: EventMessage): void;
    addChunk(trackId: number, chunk: EncodedChunk): void;
    addSample(sample: CmafSample): void;
    flush(options?: CmafFlushOptions): CmafSegment;
    /** Writes owned byte arrays with per-write backpressure. Preflight rejection is retryable; failure after a write is terminal. Does not close the sink. */
    flushTo(sink: Sink, options?: CmafFlushOptions, signal?: AbortSignal): Promise<CmafSegmentInfo>;
    private assertReady;
    private getTrack;
    private plan;
    private commit;
}
