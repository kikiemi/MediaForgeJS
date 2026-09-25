import type { ContainerFormat, OutputContainerFormat, ImageResizeMethod, ImageFitMode, GifDitherMode } from '../types/media.js';
import type { MetadataPolicy } from './diagnostics.js';
export declare const MAX_ANIMATION_PIXELS: number;
export interface MediaForgeJSConfig {
    /** Optional metadata loss warns by default; error rejects known losses before output. */
    metadataPolicy?: MetadataPolicy;
    /** Explicit resizing method for image output; omitted preserves the existing path default. */
    imageResize?: ImageResizeMethod;
    /** Image sizing: fill (default), inside, or scale-down to fit without enlargement; no crop/padding. */
    imageFit?: ImageFitMode;
    /** JPEG/WebP quality from 0 to 1 (default 0.9). */
    imageQuality?: number;
    /** Opt-in APNG rectangle optimization; preserves frame pixels and timing (default false). */
    imageOptimizeFrames?: boolean;
    /** GIF quantization: floyd-steinberg (default) or none. */
    imageDither?: GifDitherMode;
    /** Maximum input/output animation canvas pixels; GIF/APNG only, default and upper limit 134217728. */
    maxAnimationPixels?: number;
    /** Which audio track to use when the input has several (default 0). Others are logged, not silently dropped. */
    audioTrackIndex?: number;
    /** Opt-in: allow the slow media-element/DOM re-encode fallbacks (default false). */
    allowDomFallback?: boolean;
    /** Target container/image format. */
    outputFormat: OutputContainerFormat;
    /** Requested video codec string; empty keeps the plan default. */
    videoCodec?: string;
    /** Requested audio codec string; empty keeps the plan default. */
    audioCodec?: string;
    /** Target width in pixels; omit to keep the source. Explicit values must be positive - 0 is rejected. */
    width?: number;
    /** Target height in pixels; omit to keep the source. Explicit values must be positive - 0 is rejected. */
    height?: number;
    /** Target frame rate; omit to keep the source. Explicit values must be positive - 0 is rejected. */
    fps?: number;
    /** Target video bitrate in bps (values below 10,000 are read as kbps); omit for the format default. Explicit values must be positive - 0 is rejected. */
    videoBitrate?: number;
    /** Target audio bitrate in bps (values below 1,000 are read as kbps); omit for the format default. Explicit values must be positive - 0 is rejected. */
    audioBitrate?: number;
    /** Enables VBR output; valid only when outputFormat is 'mp3' (the MP3 encoder is where VBR lives). */
    audioVbr?: boolean;
    /** Target sample rate in Hz; omit to keep the source. Explicit values must be positive - 0 is rejected. */
    audioSampleRate?: number;
    /** Target channel count; omit to keep the source. Explicit values must be positive - 0 is rejected. */
    audioChannels?: number;
    /** AbortSignal that cancels the operation. */
    signal?: AbortSignal;
    /** (percent, message) called as the conversion advances. */
    onProgress?: (progress: number, message: string) => void;
}
export declare function validateImageEncodingOptions(config: Pick<MediaForgeJSConfig, 'imageDither' | 'imageOptimizeFrames' | 'imageQuality' | 'maxAnimationPixels'>, outputFormat: ContainerFormat): void;
export declare function snapshotMediaForgeConfig(input: Partial<MediaForgeJSConfig>): Partial<MediaForgeJSConfig>;
export declare function normalizeMediaForgeConfig(input?: Partial<MediaForgeJSConfig>): MediaForgeJSConfig;
