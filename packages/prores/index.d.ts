import type { VideoCodecProvider } from 'mediaforgejs/workflow/video';

export type ProResCodec = 'apco' | 'apcs' | 'apcn' | 'apch' | 'ap4h' | 'ap4x';

export interface ProResDecoderOptions {
    codec: ProResCodec;
    width?: number;
    height?: number;
    signal?: AbortSignal;
    /** Zero uses the calling thread. Workers require the host's worker support. Default: 0. */
    concurrency?: number;
    /** Default: false. Shared workers require cross-origin isolation in browsers. */
    useSharedMemory?: boolean;
    /** Maximum outstanding calls; excess calls reject. Default: 4. */
    maxQueueSize?: number;
    /** Limit on padded decoded pixels. Default: 8192 * 8192. */
    maxPixels?: number;
    /** Default: 256 MiB. */
    maxPacketBytes?: number;
    /** Matrix used by toRGBA when the bitstream does not specify one. Default: 1 (BT.709). */
    unspecifiedColorMatrix?: 1 | 5 | 6;
}

export interface ProResEncoderOptions {
    codec: ProResCodec;
    width: number;
    height: number;
    signal?: AbortSignal;
    maxQueueSize?: number;
    maxPixels?: number;
    framerate?: number;
    /** Only zero/undefined is accepted. ProRes rate control is selected by profile. */
    bitrate?: 0;
}

export interface ProResPacket {
    readonly data: Uint8Array;
    /** Seconds. */
    readonly timestamp: number;
    /** Seconds. */
    readonly duration: number;
}

export interface EncodedProResPacket extends ProResPacket {
    readonly trackType: 'video';
    readonly isKeyframe: true;
}

export interface ProResRgbaFrame extends Omit<ProResPacket, 'data'> {
    readonly data: Uint8Array | Uint8ClampedArray;
    readonly format: 'RGBA';
    readonly width: number;
    readonly height: number;
    readonly bitDepth?: 8;
    readonly scanType?: 'progressive';
    readonly colorPrimaries?: 1;
    readonly colorTransfer?: 1;
    readonly premultipliedAlpha?: false;
}

export interface ProResFrame {
    /** Owned, little-endian planar data. Throws after close(). */
    readonly data: Uint8Array;
    /** I444P12A16/I422P12A16 mean 12-bit color with a separate full 16-bit alpha plane. */
    readonly format: 'I422P10' | 'I422P12' | 'I444P12' | 'I422AP12' | 'I444AP12' | 'I422P12A16' | 'I444P12A16';
    readonly bitDepth: 10 | 12;
    readonly alphaBitDepth: 0 | 12 | 16;
    readonly originalAlphaBitDepth: 0 | 8 | 16;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly visibleWidth: number;
    readonly visibleHeight: number;
    readonly displayWidth: number;
    readonly displayHeight: number;
    /** Byte offsets and strides; planes are Y, Cb, Cr, and optional alpha. */
    readonly layout: readonly { readonly offset: number; readonly stride: number }[];
    readonly pixelAspectRatio: { readonly num: number; readonly den: number };
    readonly colorPrimaries: number;
    readonly colorTransfer: number;
    readonly colorMatrix: number;
    readonly colorRangeFull: false;
    readonly colorSpaceAssumed: boolean;
    readonly scanType: 'progressive' | 'interlaced-top-field-first' | 'interlaced-bottom-field-first';
    /** Seconds. */
    readonly timestamp: number;
    /** Seconds. */
    readonly duration: number;
    readonly closed: boolean;
    /** Explicitly converts native precision to straight RGBA8; no HDR tone mapping or deinterlacing. */
    toRGBA(options?: {
        allowPrecisionLoss?: boolean;
        signal?: AbortSignal;
    }): Promise<{ data: Uint8Array; width: number; height: number }>;
    close(): void;
}

export interface ProResDecoder {
    readonly queueSize: number;
    readonly desiredSize: number;
    readonly closed: boolean;
    decode(packet: ProResPacket): Promise<ProResFrame>;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export interface ProResEncoder {
    readonly queueSize: number;
    readonly desiredSize: number;
    readonly closed: boolean;
    encode(frame: ProResRgbaFrame): Promise<EncodedProResPacket>;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export declare function createProResDecoder(options: ProResDecoderOptions): Promise<ProResDecoder>;
export declare function createProResEncoder(options: ProResEncoderOptions): Promise<ProResEncoder>;
export declare const proResVideoCodec: VideoCodecProvider;
