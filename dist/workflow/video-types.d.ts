import type { EncodedChunk } from '../types/media.js';
export interface VideoFramePlane {
    readonly offset: number;
    readonly stride: number;
}
export interface RgbaVideoFrame {
    readonly data: Uint8Array | Uint8ClampedArray;
    readonly format: 'RGBA';
    readonly width: number;
    readonly height: number;
    readonly bitDepth?: 8;
    /** Presentation time and duration in seconds. */
    readonly timestamp: number;
    readonly duration: number;
    readonly scanType?: 'progressive';
    readonly colorPrimaries?: number;
    readonly colorTransfer?: number;
    readonly premultipliedAlpha?: false;
}
/** Owned decoded storage. The caller closes each frame after consuming it. */
export interface DecodedVideoFrame {
    readonly data: Uint8Array;
    readonly format: string;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly visibleWidth: number;
    readonly visibleHeight: number;
    readonly displayWidth?: number;
    readonly displayHeight?: number;
    readonly layout: readonly VideoFramePlane[];
    readonly bitDepth: number;
    readonly alphaBitDepth?: number;
    readonly originalAlphaBitDepth?: number;
    readonly pixelAspectRatio?: {
        readonly num: number;
        readonly den: number;
    };
    readonly colorPrimaries?: number;
    readonly colorTransfer?: number;
    readonly colorMatrix?: number;
    readonly colorRangeFull?: boolean;
    readonly colorSpaceAssumed?: boolean;
    readonly scanType?: 'progressive' | 'interlaced-top-field-first' | 'interlaced-bottom-field-first';
    readonly timestamp: number;
    readonly duration: number;
    readonly closed?: boolean;
    toRGBA(options?: {
        readonly allowPrecisionLoss?: boolean;
        readonly signal?: AbortSignal;
    }): {
        readonly data: Uint8Array | Uint8ClampedArray;
        readonly width: number;
        readonly height: number;
    } | Promise<{
        readonly data: Uint8Array | Uint8ClampedArray;
        readonly width: number;
        readonly height: number;
    }>;
    close(): void;
}
export interface VideoDecoderConfig {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly description?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly maxPixels?: number;
}
export interface VideoEncoderConfig extends Omit<VideoDecoderConfig, 'description'> {
    readonly bitrate?: number;
    readonly framerate?: number;
}
export interface VideoCodecDecoder {
    /** One completed frame per packet; delayed-output codecs use the native WebCodecs bridge. */
    decode(packet: EncodedChunk): DecodedVideoFrame | Promise<DecodedVideoFrame>;
    flush?(): void | Promise<void>;
    close(): void | Promise<void>;
}
export interface VideoCodecEncoder {
    /** A completed encoded packet, with optional initialization bytes for the muxer. */
    encode(frame: RgbaVideoFrame): (EncodedChunk & {
        readonly codecConfig?: Uint8Array;
    }) | Promise<EncodedChunk & {
        readonly codecConfig?: Uint8Array;
    }>;
    flush?(): void | Promise<void>;
    close(): void | Promise<void>;
}
/** Application-supplied instance; factories and support checks are never registered globally. */
export interface VideoCodecProvider {
    readonly id: string;
    supportsDecode(codec: string): boolean;
    supportsEncode(codec: string): boolean;
    createDecoder(config: VideoDecoderConfig): VideoCodecDecoder | Promise<VideoCodecDecoder>;
    createEncoder(config: VideoEncoderConfig): VideoCodecEncoder | Promise<VideoCodecEncoder>;
}
