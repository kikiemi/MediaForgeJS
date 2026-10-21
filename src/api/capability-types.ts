import type {
    VideoEncoderBitrateControl,
    VideoEncoderHardwareAcceleration,
    VideoEncoderLatencyMode,
} from '../codecs/webcodecs/video-options';
import type { VideoTargetFormat } from './types';

// What capabilities() is asked and answers, apart from the probing (./capabilities).

/**
 * The output a capability report is asked about; encode lists answer for this size, rate and
 * container.
 */
export interface CapabilityOptions {
    /**
     * Lists only the codecs this container carries after re-encoding, in the order `codec: 'auto'`
     * tries them.
     */
    readonly to?: VideoTargetFormat | (string & {});
    /** Video: pixels; default 1280 × 720. */
    readonly width?: number;
    readonly height?: number;
    /** Video: frames per second; default 30. */
    readonly framerate?: number;
    /** Bits per second; default the usual rate for the size, or 128 kbit/s for audio. */
    readonly bitrate?: number;
    /** Audio: Hz; default 48000. */
    readonly sampleRate?: number;
    /** Audio: default 2. */
    readonly channels?: number;
    readonly hardwareAcceleration?: VideoEncoderHardwareAcceleration;
    readonly latencyMode?: VideoEncoderLatencyMode;
    readonly bitrateMode?: VideoEncoderBitrateControl;
    readonly signal?: AbortSignal;
}

/**
 * What this build, its plugins and the current host can do, so an app can decide before it tries.
 */
export interface MediaCapabilities {
    /** Names of the plugins in use. */
    readonly plugins: readonly string[];
    readonly containers: { readonly read: readonly string[]; readonly write: readonly string[] };
    /** Audio codecs decoded and encoded, by the library or the host WebCodecs. */
    readonly audio: { readonly decode: readonly string[]; readonly encode: readonly string[] };
    /**
     * `decoders`: the software video decoders by id, which extract frames without host codecs and
     * back up the host decoder. `decode` and `encode`: the codec names the host VideoDecoder and
     * VideoEncoder accept. `transforms`: the pixel changes re-encoding and frame extraction apply.
     */
    readonly video: {
        readonly decoders: readonly string[];
        readonly decode: readonly string[];
        readonly encode: readonly string[];
        readonly transforms: readonly ('crop' | 'resize' | 'rotate' | 'flip')[];
    };
    /** Video codec families each writable container copies without re-encoding. */
    readonly videoCopy: Readonly<Record<string, readonly string[]>>;
    readonly audioCopy: Readonly<Record<string, readonly string[]>>;
    /**
     * Codecs the readers identify and the writers copy that neither this library nor WebCodecs
     * decodes.
     */
    readonly copyOnly: { readonly video: readonly string[]; readonly audio: readonly string[] };
    /**
     * Image formats written. The library writes PNG, APNG, GIF, BMP, TIFF and ICO everywhere;
     * JPEG, WebP, AVIF, HEIF and JPEG XL are listed where the host's canvas encodes them (none in
     * Node), and fail with ENCODE elsewhere.
     */
    readonly images: readonly string[];
    /**
     * Image formats read and decoded. The library decodes PNG, APNG, GIF, baseline TIFF and
     * lossless WebP everywhere; JPEG, BMP, ICO, AVIF, HEIF and JPEG XL are listed where the host
     * decodes them (none in Node), and fail with DECODE elsewhere. inspect() reads the size of
     * every image format on any host.
     */
    readonly imageRead: readonly string[];
    readonly packaging: readonly string[];
    /** Host features that unlock re-encoding, drawing and playback. */
    readonly host: {
        readonly videoDecoder: boolean;
        readonly videoEncoder: boolean;
        readonly audioDecoder: boolean;
        readonly audioEncoder: boolean;
        readonly canvas: boolean;
        readonly mediaSource: boolean;
    };
}
