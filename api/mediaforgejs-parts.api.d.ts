// The public API of 'mediaforgejs/parts', from its built declarations (npm run api:report).

export interface AudioDecodeOptions extends PartOptions {
    readonly codecPreference?: CodecPreference;
    readonly strict?: boolean;
}

export type AudioPlanes = readonly Float32Array[];

export interface AudioStage {
    readonly type: 'audio';
    readonly name: string;
    configure?(input: AudioStreamInfo): AudioStreamInfo;
    process(planes: AudioPlanes, emit: EmitAudio): void | Promise<void>;
    flush?(emit: EmitAudio): void | Promise<void>;
    close?(): void;
}

export interface AudioStreamInfo {
    readonly sampleRate: number;
    readonly channels: number;
    readonly channelMask?: number;
}

export type EmitAudio = (planes: AudioPlanes) => void;

export type EmitPicture = (picture: VideoPicture) => void;

export interface EncodeAudioOptions extends PartOptions {
    readonly bitrate?: number;
    readonly codecPreference?: CodecPreference;
    readonly start?: number;
}

export interface EncodedPacket {
    readonly data: Uint8Array;
    readonly alphaData?: Uint8Array;
    readonly timestamp: number;
    readonly duration: number;
    readonly isKeyframe: boolean;
    readonly trackType: TrackType;
    readonly decodeTimestamp?: number;
    readonly compositionTimeOffset?: number;
    readonly codecConfig?: Uint8Array;
    readonly colour?: VideoColour;
    readonly trailingDiscard?: number;
}

export declare class Media {
    get format(): string;
    get title(): string | undefined;
    get tracks(): readonly MediaTrack[];
    get warnings(): readonly MediaDiagnostic[];
    get duration(): number;
    packets(options?: PacketOptions): AsyncGenerator<MediaPacket>;
    packetAt(trackId: number, time: number, options?: PacketSearchOptions): Promise<MediaPacket | undefined>;
    segments(options?: SegmentOptions): AsyncGenerator<MediaSegment>;
    convert(to: TargetFormat, options: TargetOptions & {
        readonly sink: NonNullable<TargetOptions['sink']>;
    }): Promise<SinkResult>;
    convert(to: TargetFormat, options?: TargetOptions): Promise<MediaResult>;
    convert(options: TargetOptions & {
        readonly sink: NonNullable<TargetOptions['sink']>;
    }): Promise<SinkResult>;
    convert(options?: TargetOptions): Promise<MediaResult>;
    check(to?: TargetFormat | TargetOptions, options?: TargetOptions): Promise<ConvertSupport>;
    packageMedia(to?: PackageTargetFormat | TargetOptions, options?: TargetOptions): Promise<PackageResult>;
    frames(options: FrameOptions & {
        readonly format: 'videoframe';
    }): AsyncGenerator<VideoFrame>;
    frames(options?: FrameOptions): AsyncGenerator<Frame>;
    thumbnail(options?: ThumbnailOptions): Promise<MediaResult>;
    close(): void;
}

export interface MediaDiagnostic {
    readonly code: string;
    readonly message: string;
    readonly severity: 'warning';
    readonly format?: string;
    readonly offset?: number;
    readonly trackId?: number;
}

export interface MediaPacket extends EncodedPacket {
    readonly trackId: number;
    readonly codecConfig?: Uint8Array;
    readonly leadingDiscard?: boolean;
    readonly decodeOnly?: boolean;
}

export interface MediaTrack {
    readonly id: number;
    readonly type: TrackType;
    readonly matroskaTrackUid?: bigint;
    readonly default?: boolean;
    readonly forced?: boolean;
    readonly name?: string;
    readonly title?: string;
    readonly commentary?: boolean;
    readonly alphaMode?: boolean;
    readonly codec: string;
    readonly width?: number;
    readonly height?: number;
    readonly displayWidth?: number;
    readonly displayHeight?: number;
    readonly pixelAspectRatioNum?: number;
    readonly pixelAspectRatioDen?: number;
    readonly framerate?: number;
    readonly sampleRate?: number;
    readonly channelCount?: number;
    codecConfig?: Uint8Array;
    readonly language?: string;
    readonly incomplete?: boolean;
    readonly duration: number;
    readonly timescale?: number;
    readonly sampleCount?: number;
    readonly rotation?: number;
    readonly spatial?: SpatialVideo;
    readonly gainMap?: GainMap;
}

export interface Muxer {
    readonly format: string;
    readonly layout: 'standard' | 'fragmented';
    addVideo(packet: EncodedPacket): Promise<void>;
    addAudio(packet: EncodedPacket): Promise<void>;
    encodeAudio(source: PcmSource, options?: EncodeAudioOptions): Promise<void>;
    finish(): Promise<void>;
    abort(reason?: unknown): void;
}

export interface MuxerAudioTrack {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly codecConfig?: Uint8Array;
    readonly language?: string;
    readonly name?: string;
}

export interface MuxerOptions extends PartOptions {
    readonly video?: MuxerVideoTrack;
    readonly audio?: MuxerAudioTrack;
    readonly title?: string;
}

export interface MuxerVideoTrack {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly framerate?: number;
    readonly codecConfig?: Uint8Array;
    readonly rotation?: number;
    readonly language?: string;
    readonly name?: string;
}

export interface PacketOptions {
    readonly trackIds?: readonly number[];
    readonly start?: number;
    readonly end?: number;
    readonly keyframesOnly?: boolean;
    readonly signal?: AbortSignal;
}

export interface PartOptions {
    readonly signal?: AbortSignal;
    readonly onWarning?: (warning: MediaDiagnostic) => void;
}

export interface Parts {
    readonly open: MediaForge['open'];
    readonly createVideoDecoder: typeof createVideoDecoder;
    readonly decodeAudio: typeof decodeAudio;
    createVideoEncoder(options: VideoEncoderOptions): Promise<VideoEncoderPart>;
    createMuxer(format: string, sink: Sink, options: MuxerOptions): Promise<Muxer>;
}

export type PartsOptions = MediaForgeOptions;

export interface PcmSource extends ReplayablePcmSource {
    readonly frames?: number;
}

export interface RemixOptions {
    readonly sampleRate?: number;
    readonly channels?: number;
    readonly speed?: number;
}

export interface Sink {
    readonly signal?: AbortSignal;
    write(data: Uint8Array): void;
    readonly copiesWrites?: boolean;
    close(): Promise<void>;
    patchAt?(offset: number, data: Uint8Array): void;
    abort?(reason?: unknown): Promise<void>;
    drain?(): Promise<void>;
}

export interface Source {
    read(offset: number, length: number): Promise<Uint8Array>;
    readonly size: number;
}

export interface TransformOptions {
    readonly crop?: VideoCrop;
    readonly rotate?: VideoRotation;
    readonly flip?: VideoFlip;
    readonly width?: number;
    readonly height?: number;
    readonly fit?: VideoFit;
}

export interface VideoCrop {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface VideoDecoderOptions extends PartOptions {
    readonly codecPreference?: CodecPreference;
    readonly strict?: boolean;
}

export interface VideoDecoderPart {
    decode(packet: EncodedPacket | MediaPacket): Promise<VideoPicture[]>;
    flush(): Promise<VideoPicture[]>;
    close(): Promise<void>;
}

export interface VideoEncoderOptions extends PartOptions, HostVideoEncoderOptions {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly framerate?: number;
    readonly bitrate?: number;
    readonly keyframeInterval?: number;
    readonly container?: string;
}

export interface VideoEncoderPart {
    readonly codec: string;
    encode(picture: VideoPicture): Promise<EncodedPacket[]>;
    flush(): Promise<EncodedPacket[]>;
    close(): Promise<void>;
}

export type VideoFit = 'fill' | 'contain' | 'cover';

export type VideoFlip = 'horizontal' | 'vertical' | 'both';

export interface VideoPicture {
    readonly width: number;
    readonly height: number;
    readonly timestamp: number;
    readonly duration: number;
    readonly frame?: VideoFrame;
    readonly keyframe?: boolean;
    rgba(): Promise<Uint8Array>;
    retime(timestamp: number, duration: number): VideoPicture;
    close(): void;
}

export type VideoRotation = 0 | 90 | 180 | 270;

export interface VideoStage {
    readonly type: 'video';
    readonly name: string;
    configure?(input: VideoStreamInfo): VideoStreamInfo;
    process(picture: VideoPicture, emit: EmitPicture): void | Promise<void>;
    flush?(emit: EmitPicture): void | Promise<void>;
    close?(): void;
}

export interface VideoStages {
    readonly output: VideoStreamInfo;
    push(picture: VideoPicture): Promise<VideoPicture[]>;
    flush(): Promise<VideoPicture[]>;
    close(): void;
}

export interface VideoStreamInfo {
    readonly width: number;
    readonly height: number;
    readonly fps?: number;
}

export declare const createMuxer: (format: string, sink: Sink, options: MuxerOptions) => Promise<Muxer>;

export declare function createParts(options?: PartsOptions): Parts;

export declare function createPicture(init: {
    readonly data: Uint8Array | Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly timestamp: number;
    readonly duration: number;
    readonly keyframe?: boolean;
}): VideoPicture;

export declare function createVideoDecoder(media: Media, trackId: number, options?: VideoDecoderOptions): Promise<VideoDecoderPart>;

export declare const createVideoEncoder: (options: VideoEncoderOptions) => Promise<VideoEncoderPart>;

export declare function createVideoStages(stages: readonly VideoStage[], input: VideoStreamInfo, options?: PartOptions): VideoStages;

export declare function decodeAudio(media: Media, trackId: number, options?: AudioDecodeOptions): Promise<PcmSource>;

export declare function frameRate(fps: number): VideoStage;

export declare const open: (input: Input, options?: OpenCallOptions) => Promise<Media>;

export declare function remix(options: RemixOptions): AudioStage;

export declare function speed(factor: number): VideoStage;

export declare function stageAudio(source: PcmSource, stages: readonly AudioStage[], options?: PartOptions): PcmSource;

export declare function timeStretch(factor: number): AudioStage;

export declare function transform(options: TransformOptions): VideoStage;

// Types the exports reach without exporting them.

declare interface Aes3Unwrap {
    readonly channels: number;
    readonly bytesPerSample: 2 | 3;
}

declare type ApplicationVideoDecoderFactory = (config: VideoDecoderConfig) => VideoCodecDecoder | Promise<VideoCodecDecoder>;

declare interface ApplicationVideoDecoderPart {
    readonly kind: 'video';
    readonly id: string;
    readonly codecs: CodecMatch;
    readonly replacesHost: true;
    readonly load: () => Promise<ApplicationVideoDecoderFactory>;
}

declare interface AttachedPicture {
    readonly data: Uint8Array;
    readonly mimeType: string;
    readonly description?: string;
    readonly type?: number;
}

declare type AudioCodecName = 'auto' | 'aac' | 'opus' | 'mp3' | 'flac' | 'vorbis' | 'pcm' | 'ulaw' | 'alaw' | (string & {});

declare type AudioDecoderFactory = (track: TrackInfo) => BuiltinAudioCodec | Promise<BuiltinAudioCodec>;

declare interface AudioDecoderPart {
    readonly kind: 'audio';
    readonly id: string;
    readonly codecs: readonly string[];
    readonly load: () => Promise<AudioDecoderFactory>;
}

declare type AudioDecoderWarning = (code: string, message: string) => void;

declare interface AudioEncoderPart {
    readonly kind: 'audio';
    readonly id: string;
    readonly codecs: readonly LibraryAudioEncoderCodec[];
    readonly load: () => Promise<unknown>;
}

declare interface AudioOutputMuxer {
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    finalize(): Promise<void>;
    setValidSamples?(samples: number): void;
    setAudioPriming?(primingSamples: number, validSamples: number | undefined, presentationTimestamps?: boolean, discardLeadingSamples?: boolean, codecDelaySamples?: number): void;
    setAudioCodecConfig?(codecConfig: Uint8Array): void;
}

declare interface AudioSettings {
    readonly codec?: AudioCodecName;
    readonly sampleRate?: number;
    readonly channels?: number;
    readonly bitrate?: Bitrate;
    readonly vbr?: boolean;
    readonly mute?: boolean;
    readonly speed?: AudioSpeedSetting;
    readonly replace?: Source | MediaInput;
    readonly stages?: readonly StageRequest<AudioStage>[];
}

declare type AudioSpeedMode = 'preserve-pitch' | 'shift-pitch';

declare type AudioSpeedSetting = AudioSpeedMode | 'mute';

declare type AudioTargetFormat = 'mp3' | 'mp2' | 'aac' | 'flac' | 'wav' | 'aiff' | 'au' | 'caf' | 'm4a' | 'ogg' | 'iamf';

declare interface AudioTrackConfig {
    id: number;
    type: 'audio';
    matroskaTrackUid?: bigint;
    default?: boolean;
    forced?: boolean;
    name?: string;
    title?: string;
    commentary?: boolean;
    dispositions?: TrackDispositions;
    codecConfigChanges?: boolean;
    codec: string;
    sampleRate: number;
    channelCount: number;
    language?: string;
    primingSamples?: number;
    validSamples?: number;
    presentationTimestamps?: boolean;
    discardLeadingSamples?: boolean;
    codecDelaySamples?: number;
    codecConfig?: Uint8Array;
    presentationStartSeconds?: number;
    presentationDurationSeconds?: number;
    presentationMediaTimeSeconds?: number;
    mediaTimescale?: number;
    presentationEdit?: Mp4PresentationEdit;
}

declare type AudioWriterFactory = (format: string, track: TrackInfo, sink: Sink, copied?: () => AudioTrackConfig, tags?: MediaTags) => AudioOutputMuxer;

declare interface AudioWriterPart {
    readonly kind: 'audio';
    readonly id: string;
    readonly formats: readonly string[];
    readonly load: () => Promise<AudioWriterFactory>;
}

declare type Bitrate = number | `${number}k` | `${number}M` | `${number}kbps` | `${number}Mbps`;

declare interface BuiltinAudioCodec {
    readonly create: (warn?: AudioDecoderWarning) => PacketDecoder | Promise<PacketDecoder>;
    readonly channelMask?: number;
    readonly window?: {
        readonly head: number;
        readonly valid: number;
        readonly frames: number;
    };
    readonly preRoll?: number;
    readonly unoutputLead?: number;
}

declare interface BuiltinVideoDecoder {
    decode(chunk: EncodedPacket): readonly PlanarVideoFrame[];
    flush(): readonly PlanarVideoFrame[];
    reset(): void;
    close(): void;
}

declare interface BuiltinVideoDecoderConfig {
    readonly codec: string;
    readonly description?: Uint8Array;
    readonly codedWidth?: number;
    readonly codedHeight?: number;
    readonly onWarning?: (message: string) => void;
}

declare interface CapabilityOptions {
    readonly to?: VideoTargetFormat | (string & {});
    readonly width?: number;
    readonly height?: number;
    readonly framerate?: number;
    readonly bitrate?: number;
    readonly sampleRate?: number;
    readonly channels?: number;
    readonly hardwareAcceleration?: VideoEncoderHardwareAcceleration;
    readonly latencyMode?: VideoEncoderLatencyMode;
    readonly bitrateMode?: VideoEncoderBitrateControl;
    readonly signal?: AbortSignal;
}

declare interface CmafSegment extends CmafSegmentInfo {
    readonly data: Uint8Array;
}

declare interface CmafSegmentInfo {
    readonly sequenceNumber: number;
    readonly byteLength: number;
    readonly independent: boolean;
    readonly tracks: readonly CmafSegmentTrack[];
}

declare interface CmafSegmentTrack {
    readonly trackId: number;
    readonly timescale: number;
    readonly baseDecodeTime: bigint;
    readonly duration: bigint;
    readonly sampleCount: number;
    readonly independent: boolean;
}

declare interface CmafTrack {
    readonly id: number;
    readonly type: TrackType;
    readonly codec: string;
    readonly timescale: number;
    readonly width?: number;
    readonly height?: number;
    readonly rotation?: number;
    readonly pixelAspectRatioNum?: number;
    readonly pixelAspectRatioDen?: number;
    readonly sampleRate?: number;
    readonly channelCount?: number;
    readonly codecConfig?: Uint8Array;
    readonly edit?: {
        readonly mediaTime: number;
        readonly duration?: number;
    };
    readonly colour?: VideoColour;
    readonly fieldOrder?: FieldOrder;
    readonly spatialBoxes?: Uint8Array;
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

declare type CodecMatch = readonly string[] | ((codec: string) => boolean);

declare type CodecPreference = 'webcodecs' | 'builtin';

declare interface CommonOptions {
    readonly plugins?: PluginSelection;
    readonly onWarning?: (warning: MediaDiagnostic) => void;
    readonly optionPolicy?: OptionPolicy;
    readonly codecPreference?: CodecPreference;
    readonly open?: OpenOptions;
}

declare type ContainerFormat = 'mp4' | 'mov' | 'webm' | 'mkv' | 'avi' | 'flv' | '3gp' | 'ts' | 'mpeg' | 'm4a' | 'm4v' | 'ogg' | 'mp3' | 'wav' | 'aiff' | 'au' | 'caf' | 'flac' | 'aac' | 'mp2' | 'mp1' | 'ac3' | 'eac3' | 'dts' | 'truehd' | 'gif' | 'apng' | 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff' | 'ico' | 'avif' | 'heif' | 'jxl' | 'asf' | 'mxf' | 'ivf' | 'obu' | 'iamf' | 'apv';

declare type ContainerWriterFactory = (config: MuxerConfig, sink: Sink, options?: MediaMuxerOptions) => OutputMuxer;

declare interface ContainerWriterPart {
    readonly kind: 'container';
    readonly id: string;
    readonly formats: readonly string[];
    readonly load: () => Promise<ContainerWriterFactory>;
}

declare interface ConvertOptions extends TargetOptions, CommonOptions {
}

declare type ConvertSupport = {
    readonly supported: true;
    readonly plan: MediaPlan;
    readonly warnings: readonly MediaDiagnostic[];
} | {
    readonly supported: false;
    readonly code: ErrorCode;
    readonly reason: string;
    readonly hint?: string;
    readonly plugin?: string;
    readonly warnings: readonly MediaDiagnostic[];
};

declare interface DecodedVideoFrame {
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
    toRgba(options?: {
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

declare type DecoderPart = AudioDecoderPart | VideoDecoderPart | ApplicationVideoDecoderPart;

declare interface DemuxBudgetOptions {
    readonly maxSamples?: number;
    readonly maxIndexBytes?: number;
}

declare type DemuxProbe = (source: Source, options: ReadOptions, target?: ProbeTarget) => Promise<ProbedInput | null | undefined>;

declare interface DemuxResult {
    title?: string;
    videoTracks: TrackInfo[];
    audioTracks: TrackInfo[];
    subtitleTracks?: TrackInfo[];
    matroskaPassThrough?: MatroskaPassThrough;
    matroskaUnsupportedTags?: boolean;
    tags?: MediaTags;
}

declare class DiagnosticContext {
    readonly validation: ValidationMode;
    readonly metadataPolicy: MetadataPolicy;
    constructor(options?: DiagnosticOptions, defaultValidation?: ValidationMode);
    fresh(onWarning?: (diagnostic: MediaDiagnostic) => void): DiagnosticContext;
    get warnings(): readonly MediaDiagnostic[];
    get suppressedWarnings(): number;
    get recoveries(): number;
    recover(diagnostic: Omit<MediaDiagnostic, 'severity'>, strictMessage?: string): void;
    note(kind: 'warn' | 'recover', format: string, code: string, message: string, at?: {
        offset: number;
    } | {
        trackId: number;
    }): void;
    lose(diagnostic: Omit<MediaDiagnostic, 'severity'>): void;
    metadata(diagnostic: Omit<MediaDiagnostic, 'severity'>): void;
    warn(diagnostic: Omit<MediaDiagnostic, 'severity'>): void;
}

declare interface DiagnosticOptions {
    readonly validation?: ValidationMode;
    readonly metadataPolicy?: MetadataPolicy;
    readonly onWarning?: (diagnostic: MediaDiagnostic) => void;
    readonly maxWarnings?: number;
}

declare interface EditAudioTrack {
    readonly input: Source | MediaInput;
    readonly start?: number;
    readonly end?: number;
    readonly offset?: number;
    readonly volume?: number;
    readonly loop?: boolean;
    readonly fade?: EditFade;
}

declare interface EditClip {
    readonly input: Source | MediaInput;
    readonly start?: number;
    readonly end?: number;
    readonly speed?: number;
    readonly video?: EditClipVideo;
    readonly audio?: EditClipAudio;
}

declare interface EditClipAudio {
    readonly volume?: number;
    readonly fade?: EditFade;
    readonly mute?: boolean;
    readonly speed?: AudioSpeedMode | 'mute';
}

declare interface EditClipVideo {
    readonly crop?: VideoCrop;
    readonly rotate?: VideoRotation;
    readonly flip?: VideoFlip;
    readonly fit?: VideoFit;
    readonly fade?: EditFade;
}

declare interface EditFade {
    readonly in?: number;
    readonly out?: number;
}

declare interface EditImageOverlay {
    readonly kind: 'image';
    readonly input: Blob | ArrayBuffer | ArrayBufferView;
    readonly x: number;
    readonly y: number;
    readonly width?: number;
    readonly height?: number;
    readonly opacity?: number;
    readonly start?: number;
    readonly end?: number;
}

declare type EditOverlay = EditTextOverlay | EditImageOverlay;

declare interface EditProject {
    readonly clips: readonly EditClip[];
    readonly audio?: readonly EditAudioTrack[];
    readonly overlays?: readonly EditOverlay[];
    readonly width?: number;
    readonly height?: number;
    readonly fps?: number;
    readonly background?: string;
}

declare interface EditTextOverlay {
    readonly kind: 'text';
    readonly text: string;
    readonly x: number;
    readonly y: number;
    readonly size?: number;
    readonly color?: string;
    readonly font?: string;
    readonly start?: number;
    readonly end?: number;
    readonly opacity?: number;
}

declare interface EncodeAudioSettings {
    readonly codec?: AudioCodecName;
    readonly bitrate?: Bitrate;
}

declare interface EncodeFramesOptions extends Pick<CommonOptions, 'onWarning' | 'optionPolicy' | 'codecPreference'> {
    readonly to?: EncodeTargetFormat | (string & {});
    readonly video?: EncodeVideoSettings;
    readonly audio?: EncodeAudioSettings | false;
    readonly duration?: number;
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MediaProgress) => void;
    readonly onPlan?: (plan: MediaPlan) => void;
}

declare interface EncodeSources {
    readonly video?: FrameStream<VideoFrame>;
    readonly audio?: FrameStream<AudioData>;
}

declare type EncodeTargetFormat = 'mp4' | 'mov' | 'm4v' | 'webm' | 'mkv';

declare interface EncodeVideoSettings {
    readonly codec?: VideoCodecName;
    readonly width?: number;
    readonly height?: number;
    readonly fps?: number;
    readonly bitrate?: Bitrate;
    readonly quality?: VideoQuality;
    readonly keyframeInterval?: number;
    readonly hardwareAcceleration?: VideoEncoderHardwareAcceleration;
    readonly latencyMode?: VideoEncoderLatencyMode;
    readonly bitrateMode?: VideoEncoderBitrateControl;
    readonly stages?: readonly StageRequest<VideoStage>[];
}

declare type EncoderPart = AudioEncoderPart | VideoEncoderPart;

declare type ErrorCode = 'DECODE' | 'ENCODE' | 'MUX' | 'DEMUX' | 'FORMAT' | 'INPUT' | 'OUTPUT' | 'ABORT' | 'IO' | 'OOM' | 'PLUGIN';

declare type FieldOrder = 'progressive' | 'tt' | 'bb' | 'tb' | 'bt';

declare interface Frame {
    readonly data: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly timestamp: number;
}

declare interface FrameCallOptions extends FrameOptions, CommonOptions {
}

declare interface FrameOptions {
    readonly format?: 'rgba' | 'videoframe';
    readonly times?: readonly number[];
    readonly every?: number;
    readonly maxFrames?: number;
    readonly trackId?: number;
    readonly width?: number;
    readonly height?: number;
    readonly fit?: VideoFit;
    readonly crop?: VideoCrop;
    readonly rotate?: VideoRotation;
    readonly flip?: VideoFlip;
    readonly stages?: readonly StageRequest<VideoStage>[];
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MediaProgress) => void;
}

declare type FrameStream<T> = AsyncIterable<T> | Iterable<T> | ReadableStream<T>;

declare interface GainMap {
    readonly width: number;
    readonly height: number;
    readonly headroom?: number;
}

declare type GifDitherMode = 'floyd-steinberg' | 'none';

declare interface HlsEncryptionOptions {
    readonly method: 'AES-128';
    readonly key: Uint8Array;
    readonly keyUri: string;
    readonly iv?: 'sequence' | Uint8Array;
    readonly keyFile?: string;
}

declare interface HostVideoEncoderOptions {
    readonly hardwareAcceleration?: VideoEncoderHardwareAcceleration;
    readonly latencyMode?: VideoEncoderLatencyMode;
    readonly bitrateMode?: VideoEncoderBitrateControl;
}

declare type ImageFitMode = 'fill' | 'inside' | 'scale-down';

declare type ImageResizeMethod = 'nearest' | 'bilinear' | 'lanczos3';

declare interface ImageSettings {
    readonly quality?: number;
    readonly fit?: ImageFitMode;
    readonly resize?: ImageResizeMethod;
    readonly dither?: GifDitherMode;
}

declare type ImageTargetFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'apng' | 'bmp' | 'tiff' | 'ico' | 'avif';

declare type Input = Source | MediaInput;

declare interface InspectOptions extends CommonOptions {
    readonly signal?: AbortSignal;
    readonly sampleCounts?: boolean;
}

declare type LibraryAudioEncoderCodec = 'aac' | 'flac' | 'mp2' | 'mp3';

declare interface MasteringDisplay {
    readonly red: readonly [
        number,
        number
    ];
    readonly green: readonly [
        number,
        number
    ];
    readonly blue: readonly [
        number,
        number
    ];
    readonly whitePoint: readonly [
        number,
        number
    ];
    readonly maxLuminance: number;
    readonly minLuminance: number;
}

declare interface MatroskaPassThrough {
    chapters?: Uint8Array;
    attachments?: Uint8Array;
    title?: string;
    tags?: Uint8Array;
}

declare interface MediaCapabilities {
    readonly plugins: readonly string[];
    readonly containers: {
        readonly read: readonly string[];
        readonly write: readonly string[];
    };
    readonly audio: {
        readonly decode: readonly string[];
        readonly encode: readonly string[];
    };
    readonly video: {
        readonly decoders: readonly string[];
        readonly decode: readonly string[];
        readonly encode: readonly string[];
        readonly transforms: readonly ('crop' | 'resize' | 'rotate' | 'flip')[];
    };
    readonly videoCopy: Readonly<Record<string, readonly string[]>>;
    readonly audioCopy: Readonly<Record<string, readonly string[]>>;
    readonly copyOnly: {
        readonly video: readonly string[];
        readonly audio: readonly string[];
    };
    readonly images: readonly string[];
    readonly imageRead: readonly string[];
    readonly packaging: readonly string[];
    readonly host: {
        readonly videoDecoder: boolean;
        readonly videoEncoder: boolean;
        readonly audioDecoder: boolean;
        readonly audioEncoder: boolean;
        readonly canvas: boolean;
        readonly mediaSource: boolean;
    };
}

declare interface MediaChapter {
    readonly start: number;
    readonly end?: number;
    readonly title?: string;
}

declare class MediaForge {
    static readonly defaultPlugins: readonly MediaForgePlugin[];
    constructor(options?: MediaForgeOptions);
    get plugins(): readonly string[];
    inspect(input: Input, options?: InspectOptions): Promise<MediaInfo>;
    open(input: Input, options?: OpenCallOptions): Promise<Media>;
    convert(input: Input, to: TargetFormat, options: ConvertOptions & {
        readonly sink: NonNullable<TargetOptions['sink']>;
    }): Promise<SinkResult>;
    convert(input: Input, to: TargetFormat, options?: ConvertOptions): Promise<MediaResult>;
    convert(input: Input, options: ConvertOptions & {
        readonly sink: NonNullable<TargetOptions['sink']>;
    }): Promise<SinkResult>;
    convert(input: Input, options?: ConvertOptions): Promise<MediaResult>;
    check(input: Input, to?: TargetFormat | ConvertOptions, options?: ConvertOptions): Promise<ConvertSupport>;
    thumbnail(input: Input, options?: ThumbnailCallOptions): Promise<MediaResult>;
    frames(input: Input, options: FrameCallOptions & {
        readonly format: 'videoframe';
    }): AsyncGenerator<VideoFrame>;
    frames(input: Input, options?: FrameCallOptions): AsyncGenerator<Frame>;
    packageMedia(input: Input, to?: PackageTargetFormat | ConvertOptions, options?: ConvertOptions): Promise<PackageResult>;
    edit(project: EditProject, to: TargetFormat, options: ConvertOptions & {
        readonly sink: NonNullable<TargetOptions['sink']>;
    }): Promise<SinkResult>;
    edit(project: EditProject, to: TargetFormat, options?: ConvertOptions): Promise<MediaResult>;
    edit(project: EditProject, options: ConvertOptions & {
        readonly sink: NonNullable<TargetOptions['sink']>;
    }): Promise<SinkResult>;
    edit(project: EditProject, options: ConvertOptions): Promise<MediaResult>;
    encodeFrames(sources: FrameStream<VideoFrame> | EncodeSources, options?: EncodeFramesOptions): Promise<MediaResult>;
    recordStream(stream: MediaStream, options?: RecordStreamOptions): MediaRecording;
    play(source: string | URL, media: HTMLMediaElement, options?: PlayOptions): Playback;
    createPlayer(media: HTMLMediaElement, options?: PlayOptions): Player;
    capabilities(options?: CapabilityOptions & CommonOptions): Promise<MediaCapabilities>;
}

declare type MediaForgeOptions = CommonOptions;

declare interface MediaForgePlugin {
    readonly name: string;
    readonly description?: string;
    readonly decoders?: readonly DecoderPart[];
    readonly encoders?: readonly EncoderPart[];
    readonly readers?: readonly ReaderPart[];
    readonly writers?: readonly WriterPart[];
    readonly stages?: readonly StageDefinition[];
    readonly players?: readonly PlayerPart[];
}

declare interface MediaInfo {
    readonly title?: string;
    readonly format: string;
    readonly tracks: readonly (Omit<MediaTrack, 'sampleCount'> & {
        readonly sampleCount?: number;
    })[];
    readonly warnings: readonly MediaDiagnostic[];
}

declare type MediaInput = File | Blob | ArrayBuffer | ArrayBufferView;

declare interface MediaMuxerOptions {
    readonly deferCodecConfig?: boolean;
}

declare interface MediaPlan {
    readonly format: string;
    readonly action: 'copy' | 'reencode' | 'image' | 'package';
    readonly tracks: readonly TrackPlan[];
    readonly duration?: number;
}

declare interface MediaProgress {
    readonly fraction: number;
    readonly stage?: MediaProgressStage;
    readonly time?: number;
    readonly duration?: number;
    readonly message?: string;
    readonly packets?: number;
    readonly packetBytes?: number;
    readonly segments?: number;
    readonly outputBytes?: number;
}

declare type MediaProgressStage = 'copy' | 'encode' | 'decode' | 'package';

declare interface MediaRecording {
    readonly result: Promise<MediaResult>;
    stop(): Promise<MediaResult>;
}

declare interface MediaResult {
    readonly blob: Blob;
    readonly format: string;
    readonly mimeType: string;
    readonly filename: string;
    readonly plan: MediaPlan;
    readonly warnings: readonly MediaDiagnostic[];
}

declare type MediaSegment = {
    readonly kind: 'init';
    readonly data: Uint8Array;
    readonly tracks: readonly CmafTrack[];
} | ({
    readonly kind: 'media';
} & CmafSegment);

declare interface MediaTags {
    readonly entries: readonly {
        readonly key: string;
        readonly value: string;
    }[];
    readonly chapters?: readonly MediaChapter[];
    readonly pictures?: readonly AttachedPicture[];
}

declare type MetadataPolicy = 'warn' | 'error';

declare interface Mp4CodecConfiguration {
    codec: string;
    codecConfig: Uint8Array;
    width?: number;
    height?: number;
    displayWidth?: number;
    displayHeight?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    rotation?: number;
    sampleRate?: number;
    channelCount?: number;
    samplesPerAccessUnit?: number;
}

declare interface Mp4EditList {
    version: 0 | 1;
    movieTimescale: number;
    mediaTimescale: number;
    entries: readonly Mp4EditListEntry[];
}

declare interface Mp4EditListEntry {
    segmentDuration: number;
    mediaTime: number;
}

declare interface Mp4EditSplice {
    readonly start: number;
    readonly shift: number;
}

declare interface Mp4EditSpliceEntry {
    readonly movieDuration: number;
    readonly mediaTimeUnits: number;
}

declare interface Mp4PresentationEdit {
    leadMovieUnits: number;
    movieDuration: number;
    mediaTimeUnits: number;
    movieTimescale: number;
    mediaTimescale: number;
    version?: 0 | 1;
    splices?: readonly Mp4EditSpliceEntry[];
}

declare interface MuxerConfig {
    title?: string;
    tags?: MediaTags;
    subtitleTracks?: Array<{
        codec: string;
        codecConfig?: Uint8Array;
        id?: number;
        matroskaTrackUid?: bigint;
        language?: string;
        default?: boolean;
        forced?: boolean;
        name?: string;
        title?: string;
        commentary?: boolean;
        dispositions?: TrackDispositions;
    }>;
    format: ContainerFormat;
    mode: 'standard' | 'fragmented';
    maxFragmentDuration: number;
    autoSync: boolean;
    video?: VideoTrackConfig;
    audio?: AudioTrackConfig;
    videoColour?: VideoColour;
    audioLanguage?: string;
    videoLanguage?: string;
    extraVideoTracks?: VideoTrackConfig[];
    extraAudioTracks?: AudioTrackConfig[];
    oggCommentPayload?: Uint8Array;
    moovUserData?: Uint8Array;
}

declare interface OpenCallOptions extends OpenOptions, CommonOptions {
}

declare interface OpenOptions extends DiagnosticOptions, DemuxBudgetOptions {
    readonly format?: string;
    readonly signal?: AbortSignal;
    readonly recovery?: 'complete-packets';
    readonly maxPacketBytes?: number;
    readonly cacheBytes?: number;
    readonly readPageBytes?: number;
}

declare type OptionPolicy = 'lenient' | 'strict';

declare interface OutputMuxer extends AudioOutputMuxer {
    addVideoChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    setVideoColour?(colour: VideoColour): void;
    setMatroskaPassThrough?(pass: MatroskaPassThrough): void;
    addSubtitleChunk?(chunk: EncodedPacket, trackIndex?: number): void;
    addExtraAudioChunk?(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    addExtraVideoChunk?(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void;
}

declare interface PackageResult {
    readonly files: Map<string, PackagedFile>;
    readonly entry: string;
    readonly format: PackageTargetFormat;
    readonly plan: MediaPlan;
    readonly warnings: readonly MediaDiagnostic[];
}

declare interface PackageSegmentTiming {
    readonly timescale: number;
    readonly time: bigint;
    readonly duration: bigint;
}

declare type PackageTargetFormat = 'hls' | 'dash' | 'hls+dash';

declare interface PackagedFile {
    readonly kind: PackagedFileKind;
    readonly name: string;
    readonly data: Uint8Array;
    readonly representation?: string;
    readonly number?: number;
    readonly timing?: PackageSegmentTiming;
}

declare type PackagedFileKind = 'init' | 'segment' | 'playlist' | 'manifest' | 'key';

declare interface PacketDecoder {
    decode(packet: Uint8Array): Iterable<readonly Float32Array[]>;
    conceal?(frames: number): Iterable<readonly Float32Array[]>;
    flush?(): Iterable<readonly Float32Array[]>;
    reset(): void;
}

declare interface PacketSearchOptions {
    readonly keyframe?: boolean;
    readonly mode?: 'before' | 'after';
    readonly signal?: AbortSignal;
}

declare interface PlanarVideoColorSpace {
    readonly primaries?: VideoColorPrimaries;
    readonly transfer?: VideoTransferCharacteristics;
    readonly matrix?: VideoMatrixCoefficients;
    readonly fullRange?: boolean;
}

declare interface PlanarVideoFrame {
    readonly format: 'I420' | 'I422' | 'I444' | 'BGRX' | 'RGBX';
    readonly data: Uint8Array;
    readonly layout: readonly VideoFramePlane[];
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly visibleRect: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    };
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly timestamp: number;
    readonly duration: number;
    readonly keyFrame: boolean;
    readonly colorSpace?: PlanarVideoColorSpace;
    readonly interlaced?: 'top-field-first' | 'bottom-field-first';
    readonly bitDepth?: number;
}

declare interface PlayOptions extends PlayerSettings, CommonOptions {
    readonly protocol?: PlayerProtocol;
    readonly signal?: AbortSignal;
}

declare interface Playback {
    readonly finished: Promise<void>;
    stop(): void;
}

declare interface Player {
    load(source: string | URL, options?: PlayOptions): Playback;
    stop(): void;
}

declare type PlayerFactory = (request: PlayerRequest) => Promise<void>;

declare interface PlayerPart {
    readonly id: string;
    readonly protocols: readonly PlayerProtocol[];
    readonly sniff?: (url: string, manifest?: string) => boolean;
    readonly load: () => Promise<PlayerFactory>;
}

declare type PlayerProtocol = 'hls' | 'dash';

declare interface PlayerRequest {
    readonly url: string;
    readonly media: HTMLMediaElement;
    readonly settings: PlayerSettings;
    readonly signal: AbortSignal;
    readonly warn?: (code: string, message: string) => void;
}

declare interface PlayerSettings {
    readonly mimeType?: string;
    readonly autoplay?: boolean;
    readonly bufferAhead?: number;
    readonly bufferBehind?: number;
    readonly operationTimeoutMs?: number;
    readonly requestTimeoutMs?: number;
    readonly live?: boolean;
    readonly adaptive?: boolean;
    readonly fetch?: typeof globalThis.fetch;
    readonly drm?: object;
    readonly audio?: RenditionChoice;
    readonly subtitles?: boolean | RenditionChoice;
}

declare type PluginName = 'h264' | 'mpeg12' | 'mpeg4' | 'aac' | 'mpegAudio' | 'flac' | 'alac' | 'opus' | 'vorbis' | 'ac3' | 'avi' | 'flv' | 'asf' | 'mxf' | 'mpegPs' | 'ivf' | 'iamf' | 'apv';

declare type PluginSelection = readonly MediaForgePlugin[] | {
    readonly exclude?: readonly (PluginName | (string & {}))[];
    readonly add?: readonly MediaForgePlugin[];
};

declare interface ProbeTarget {
    readonly around?: number;
    readonly through?: number;
    readonly timed?: boolean;
    readonly range?: {
        readonly start: number;
        readonly end?: number;
        readonly fromStart?: boolean;
    };
    readonly stream?: boolean;
    readonly packetsOnly?: boolean;
    readonly windowOnly?: boolean;
}

declare interface ProbedInput {
    readonly result: DemuxResult;
    readonly packets: boolean;
    readonly counted?: boolean;
    readonly index?: (signal: AbortSignal | undefined, diagnostics: DiagnosticContext) => Promise<DemuxResult>;
    readonly start?: number;
    readonly stream?: (signal?: AbortSignal, warn?: Warn) => AsyncGenerator<readonly StreamedSample[]>;
    readonly fromStart?: boolean;
    readonly end?: number;
    readonly window?: (target: ProbeTarget, signal?: AbortSignal) => Promise<ProbedInput | undefined>;
    readonly windowTracks?: (target: ProbeTarget, signal?: AbortSignal) => Promise<DemuxResult | undefined>;
}

declare interface ReadOptions extends OpenOptions {
    readonly compactIndex?: boolean;
}

declare interface Reader {
    read(source: Source, options: ReadOptions): Promise<DemuxResult>;
    readonly probe?: DemuxProbe;
    readonly capabilities?: ReaderCapabilities;
}

declare interface ReaderCapabilities {
    readonly handsOver?: boolean;
    readonly compactIndex?: boolean;
}

declare interface ReaderPart {
    readonly id: string;
    readonly formats: readonly string[];
    readonly sniff?: (head: Uint8Array) => boolean;
    readonly priority?: number;
    readonly load: () => Promise<Reader>;
}

declare interface RecordStreamOptions extends EncodeFramesOptions {
    readonly maxDuration?: number;
}

declare interface RenditionChoice {
    readonly name?: string;
    readonly language?: string | readonly string[];
}

declare interface ReplayablePcmSource {
    readonly sampleRate: number;
    readonly channels: number;
    readonly estimatedFrames: number;
    readonly channelMask?: number;
    chunks(signal?: AbortSignal): AsyncIterable<readonly Float32Array[]>;
}

declare interface RgbaVideoFrame {
    readonly data: Uint8Array | Uint8ClampedArray;
    readonly format: 'RGBA';
    readonly width: number;
    readonly height: number;
    readonly bitDepth?: 8;
    readonly timestamp: number;
    readonly duration: number;
    readonly scanType?: 'progressive';
    readonly colorPrimaries?: number;
    readonly colorTransfer?: number;
    readonly premultipliedAlpha?: false;
}

declare interface Sample {
    proResHeaderless?: boolean;
    leadingDiscard?: boolean;
    trailingDiscard?: number;
    decodeOnly?: boolean;
    nalUnitFormat?: 'annexb' | 'avcc';
    aes3?: Aes3Unwrap;
    alphaOffset?: number;
    alphaSize?: number;
    offset: number;
    size: number;
    timestamp: number;
    duration: number;
    isKeyframe: boolean;
    decodeTimestamp?: number;
    compositionTimeOffset?: number;
    codecConfigIndex?: number;
    data?: Uint8Array;
    packetSkip?: number;
    packetBytes?: number;
}

declare interface SegmentOptions {
    readonly trackIds?: readonly number[];
    readonly targetDuration?: number;
    readonly maxBufferedBytes?: number;
    readonly maxBufferedSamples?: number;
    readonly requireKeyframe?: boolean;
    readonly signal?: AbortSignal;
}

declare type SinkResult = Omit<MediaResult, 'blob'>;

declare interface SpatialVideo {
    readonly eyes: readonly ('left' | 'right')[];
    readonly views?: 'layer' | 'side-by-side' | 'over-under';
    readonly heroEye?: 'left' | 'right';
    readonly baseline?: number;
    readonly disparityAdjustment?: number;
    readonly projection?: VideoProjection;
    readonly fieldOfView?: number;
}

declare interface StageDefinition<Stage extends VideoStage | AudioStage = VideoStage | AudioStage> {
    readonly type: Stage['type'];
    readonly name: string;
    readonly description?: string;
    create(options?: unknown): Stage;
}

declare type StageRequest<Stage extends VideoStage | AudioStage = VideoStage | AudioStage> = StageDefinition<Stage> | string | {
    readonly name: string;
    readonly options?: unknown;
};

declare interface StreamedSample {
    readonly track: number;
    readonly sample: Sample & {
        readonly data: Uint8Array;
    };
    readonly codecConfig?: Uint8Array;
    readonly alphaData?: Uint8Array;
}

declare type TargetFormat = VideoTargetFormat | AudioTargetFormat | ImageTargetFormat | PackageTargetFormat | (string & {});

declare interface TargetOptions {
    readonly to?: TargetFormat;
    readonly trackIds?: readonly number[];
    readonly start?: number;
    readonly end?: number;
    readonly video?: VideoSettings;
    readonly audio?: AudioSettings;
    readonly image?: ImageSettings;
    readonly copy?: boolean;
    readonly allowPrecisionLoss?: boolean;
    readonly container?: 'fmp4' | 'ts';
    readonly targetDuration?: number;
    readonly encryption?: HlsEncryptionOptions;
    readonly programDateTime?: Date | string | number;
    readonly maxBytes?: number;
    readonly sink?: Sink;
    readonly onFile?: (file: PackagedFile) => void | Promise<void>;
    readonly codecPreference?: CodecPreference;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MediaProgress) => void;
    readonly onPlan?: (plan: MediaPlan) => void;
}

declare interface ThumbnailCallOptions extends ThumbnailOptions, CommonOptions {
}

declare interface ThumbnailOptions extends Omit<FrameOptions, 'times' | 'every' | 'maxFrames' | 'onProgress'> {
    readonly time?: number;
    readonly to?: 'png' | 'jpeg' | 'webp';
    readonly quality?: number;
}

declare interface TrackDispositions {
    readonly hearingImpaired?: boolean;
    readonly visualImpaired?: boolean;
    readonly textDescriptions?: boolean;
    readonly original?: boolean;
}

declare interface TrackInfo {
    id?: number;
    matroskaTrackUid?: bigint;
    language?: string;
    default?: boolean;
    name?: string;
    title?: string;
    commentary?: boolean;
    forced?: boolean;
    dispositions?: TrackDispositions;
    alphaMode?: boolean;
    colour?: VideoColour;
    fieldOrder?: FieldOrder;
    opusTrailingPaddingSamples?: number;
    audioTrailingPaddingSamples?: number;
    audioPrimingSamples?: number;
    decoderDelaySamples?: number;
    incomplete?: boolean;
    matroskaCodecDelaySeconds?: number;
    editLeadTimeSeconds?: number;
    editAbsoluteMediaTimeSeconds?: number;
    editTimelineShiftSeconds?: number;
    editMediaTimeSeconds?: number;
    editPresentationDurationSeconds?: number;
    editList?: Mp4EditList;
    editSplices?: readonly Mp4EditSplice[];
    editPresentationDurationUnits?: number;
    presentationTimestampsIncludeEdits?: boolean;
    codec: string;
    codecTag?: string;
    width: number;
    height: number;
    displayWidth?: number;
    displayHeight?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    rotation?: number;
    sampleRate: number;
    channelCount: number;
    duration: number;
    samples: Sample[];
    codecConfig?: Uint8Array;
    codecConfigurations?: Mp4CodecConfiguration[];
    dolbyVisionConfig?: Uint8Array;
    spatial?: SpatialVideo;
    spatialBoxes?: Uint8Array;
    timescale?: number;
    timestampResolutionSeconds?: number;
}

declare interface TrackPlan {
    readonly trackId: number;
    readonly type: 'video' | 'audio' | 'subtitle';
    readonly action: 'copy' | 'encode';
    readonly sourceCodec: string;
    readonly codec: string;
    readonly encoder?: 'webcodecs' | 'builtin' | 'plugin';
    readonly stages?: readonly string[];
    readonly fps?: number;
    readonly width?: number;
    readonly height?: number;
    readonly sampleRate?: number;
    readonly channels?: number;
}

declare type TrackType = 'video' | 'audio' | 'subtitle';

declare type ValidationMode = 'strict' | 'compatible';

declare interface VideoCodecDecoder {
    decode(packet: EncodedPacket): DecodedVideoFrame | Promise<DecodedVideoFrame>;
    flush?(): void | Promise<void>;
    close(): void | Promise<void>;
}

declare interface VideoCodecEncoder {
    encode(frame: RgbaVideoFrame): (EncodedPacket & {
        readonly codecConfig?: Uint8Array;
    }) | Promise<EncodedPacket & {
        readonly codecConfig?: Uint8Array;
    }>;
    flush?(): void | Promise<void>;
    close(): void | Promise<void>;
}

declare type VideoCodecName = 'auto' | 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1' | (string & {});

declare interface VideoColour {
    primaries: number;
    transfer: number;
    matrix: number;
    fullRange?: boolean;
    mastering?: MasteringDisplay;
    contentLight?: {
        readonly maxContent: number;
        readonly maxAverage: number;
    };
}

declare interface VideoDecoderConfig {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly description?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly maxPixels?: number;
}

declare type VideoDecoderFactory = (config: BuiltinVideoDecoderConfig) => BuiltinVideoDecoder | Promise<BuiltinVideoDecoder>;

declare interface VideoDecoderPart {
    readonly kind: 'video';
    readonly id: string;
    readonly codecs: CodecMatch;
    readonly replacesHost?: false;
    readonly load: () => Promise<VideoDecoderFactory>;
}

declare type VideoEncoderBitrateControl = 'constant' | 'variable';

declare interface VideoEncoderConfig extends Omit<VideoDecoderConfig, 'description'> {
    readonly bitrate?: number;
    readonly framerate?: number;
}

declare type VideoEncoderFactory = (config: VideoEncoderConfig) => VideoCodecEncoder | Promise<VideoCodecEncoder>;

declare type VideoEncoderHardwareAcceleration = 'no-preference' | 'prefer-hardware' | 'prefer-software';

declare type VideoEncoderLatencyMode = 'quality' | 'realtime';

declare interface VideoEncoderPart {
    readonly kind: 'video';
    readonly id: string;
    readonly codecs: CodecMatch;
    readonly load: () => Promise<VideoEncoderFactory>;
}

declare interface VideoFramePlane {
    readonly offset: number;
    readonly stride: number;
}

declare type VideoProjection = 'rectilinear' | 'equirectangular' | 'half-equirectangular' | 'fisheye' | 'parametric';

declare type VideoQuality = 'low' | 'medium' | 'high' | 'very-high';

declare interface VideoSettings {
    readonly codec?: VideoCodecName;
    readonly width?: number;
    readonly height?: number;
    readonly fit?: VideoFit;
    readonly crop?: VideoCrop;
    readonly rotate?: VideoRotation;
    readonly flip?: VideoFlip;
    readonly fps?: number;
    readonly speed?: number;
    readonly bitrate?: Bitrate;
    readonly quality?: VideoQuality;
    readonly keyframeInterval?: number;
    readonly autoRotate?: boolean;
    readonly hardwareAcceleration?: VideoEncoderHardwareAcceleration;
    readonly latencyMode?: VideoEncoderLatencyMode;
    readonly bitrateMode?: VideoEncoderBitrateControl;
    readonly stages?: readonly StageRequest<VideoStage>[];
}

declare type VideoTargetFormat = 'mp4' | 'mov' | 'm4v' | 'mkv' | 'webm' | 'ts' | 'fmp4' | '3gp' | 'avi' | 'flv' | 'ivf' | 'apv';

declare interface VideoTrackConfig {
    rotation?: number;
    id: number;
    type: 'video';
    matroskaTrackUid?: bigint;
    default?: boolean;
    forced?: boolean;
    name?: string;
    title?: string;
    commentary?: boolean;
    dispositions?: TrackDispositions;
    alphaMode?: boolean;
    codecConfigChanges?: boolean;
    codec: string;
    width: number;
    height: number;
    displayWidth?: number;
    displayHeight?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    language?: string;
    colour?: VideoColour;
    fieldOrder?: FieldOrder;
    framerate: number;
    codecConfig?: Uint8Array;
    dolbyVisionConfig?: Uint8Array;
    spatialBoxes?: Uint8Array;
    presentationStartSeconds?: number;
    presentationDurationSeconds?: number;
    presentationMediaTimeSeconds?: number;
    mediaTimescale?: number;
    presentationEdit?: Mp4PresentationEdit;
}

declare type Warn = (warning: Omit<MediaDiagnostic, 'severity'>) => void;

declare type WriterPart = ContainerWriterPart | AudioWriterPart;
