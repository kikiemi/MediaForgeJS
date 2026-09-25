import type { TrackType } from '../types/media.js';
export interface CodecDescriptor {
    readonly id: string;
    readonly type: TrackType;
    readonly name: string;
    readonly aliases: readonly string[];
    /** Packet formats supported by built-in writers; decoder availability is separate. */
    readonly containers: readonly string[];
}
/** Per-engine codec vocabulary. Recognition never implies a decoder or encoder is installed. */
export declare class CodecRegistry {
    private readonly entries;
    private readonly names;
    constructor(descriptors?: readonly CodecDescriptor[]);
    register(descriptor: CodecDescriptor): void;
    resolve(codec: string): CodecDescriptor | undefined;
    list(type?: TrackType): readonly CodecDescriptor[];
    canMux(codec: string, container: string): boolean;
}
export interface NativeCodecSupport {
    readonly available: boolean;
    readonly supported: boolean;
    readonly config?: Readonly<Record<string, unknown>>;
    readonly reason?: string;
}
/** Queries the current WebCodecs implementation with the caller's complete configuration. */
export declare function probeNativeCodec(type: 'video' | 'audio', operation: 'encode' | 'decode', config: Readonly<Record<string, unknown>>): Promise<NativeCodecSupport>;
