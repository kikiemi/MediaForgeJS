// The public API of 'mediaforgejs/plugins', from its built declarations (npm run api:report).

export type ApplicationVideoDecoderFactory = (config: VideoDecoderConfig) => VideoCodecDecoder | Promise<VideoCodecDecoder>;

export interface ApplicationVideoDecoderPart {
    readonly kind: 'video';
    readonly id: string;
    readonly codecs: CodecMatch;
    readonly replacesHost: true;
    readonly load: () => Promise<ApplicationVideoDecoderFactory>;
}

export type AudioDecoderFactory = (track: TrackInfo) => BuiltinAudioCodec | Promise<BuiltinAudioCodec>;

export interface AudioDecoderPart {
    readonly kind: 'audio';
    readonly id: string;
    readonly codecs: readonly string[];
    readonly load: () => Promise<AudioDecoderFactory>;
}

export interface AudioEncoderPart {
    readonly kind: 'audio';
    readonly id: string;
    readonly codecs: readonly LibraryAudioEncoderCodec[];
    readonly load: () => Promise<unknown>;
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

export type AudioWriterFactory = (format: string, track: TrackInfo, sink: Sink, copied?: () => AudioTrackConfig, tags?: MediaTags) => AudioOutputMuxer;

export interface AudioWriterPart {
    readonly kind: 'audio';
    readonly id: string;
    readonly formats: readonly string[];
    readonly load: () => Promise<AudioWriterFactory>;
}

export interface BuiltinAudioCodec {
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

export interface BuiltinVideoDecoder {
    decode(chunk: EncodedPacket): readonly PlanarVideoFrame[];
    flush(): readonly PlanarVideoFrame[];
    reset(): void;
    close(): void;
}

export interface BuiltinVideoDecoderConfig {
    readonly codec: string;
    readonly description?: Uint8Array;
    readonly codedWidth?: number;
    readonly codedHeight?: number;
    readonly onWarning?: (message: string) => void;
}

export type CodecMatch = readonly string[] | ((codec: string) => boolean);

export type ContainerWriterFactory = (config: MuxerConfig, sink: Sink, options?: MediaMuxerOptions) => OutputMuxer;

export interface ContainerWriterPart {
    readonly kind: 'container';
    readonly id: string;
    readonly formats: readonly string[];
    readonly load: () => Promise<ContainerWriterFactory>;
}

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

export type DecoderPart = AudioDecoderPart | VideoDecoderPart | ApplicationVideoDecoderPart;

export type DemuxProbe = (source: Source, options: ReadOptions, target?: ProbeTarget) => Promise<ProbedInput | null | undefined>;

export type EmitAudio = (planes: AudioPlanes) => void;

export type EmitPicture = (picture: VideoPicture) => void;

export type EncoderPart = AudioEncoderPart | VideoEncoderPart;

export type LibraryAudioEncoderCodec = 'aac' | 'flac' | 'mp2' | 'mp3';

export declare class MediaForgeError extends Error {
    readonly code: ErrorCode;
    hint?: string;
    readonly plugin?: string;
    constructor(message: string, code: ErrorCode, options?: MediaForgeErrorOptions);
}

export interface MediaForgePlugin {
    readonly name: string;
    readonly description?: string;
    readonly decoders?: readonly DecoderPart[];
    readonly encoders?: readonly EncoderPart[];
    readonly readers?: readonly ReaderPart[];
    readonly writers?: readonly WriterPart[];
    readonly stages?: readonly StageDefinition[];
    readonly players?: readonly PlayerPart[];
}

export interface PacketDecoder {
    decode(packet: Uint8Array): Iterable<readonly Float32Array[]>;
    conceal?(frames: number): Iterable<readonly Float32Array[]>;
    flush?(): Iterable<readonly Float32Array[]>;
    reset(): void;
}

export interface PacketizedSampleReader {
    read(source: Source, sample: Sample, signal?: AbortSignal): Promise<Uint8Array>;
    readonly scansReads?: boolean;
    readLent?(source: Source, sample: Sample): Uint8Array | undefined;
}

export interface PlanarVideoFrame {
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

export type PlayerFactory = (request: PlayerRequest) => Promise<void>;

export interface PlayerPart {
    readonly id: string;
    readonly protocols: readonly PlayerProtocol[];
    readonly sniff?: (url: string, manifest?: string) => boolean;
    readonly load: () => Promise<PlayerFactory>;
}

export type PlayerProtocol = 'hls' | 'dash';

export interface PlayerRequest {
    readonly url: string;
    readonly media: HTMLMediaElement;
    readonly settings: PlayerSettings;
    readonly signal: AbortSignal;
    readonly warn?: (code: string, message: string) => void;
}

export interface PlayerSettings {
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

export interface PluginManifest {
    readonly name: string;
    readonly description: string;
    readonly decoders?: readonly Described<DecoderPart>[];
    readonly encoders?: readonly Described<EncoderPart>[];
    readonly readers?: readonly Described<ReaderPart>[];
    readonly writers?: readonly Described<WriterPart>[];
    readonly stages?: readonly Omit<StageDefinition, 'create'>[];
    readonly players?: readonly Described<PlayerPart>[];
}

export type PluginName = 'h264' | 'mpeg12' | 'mpeg4' | 'aac' | 'mpegAudio' | 'flac' | 'alac' | 'opus' | 'vorbis' | 'ac3' | 'avi' | 'flv' | 'asf' | 'mxf' | 'mpegPs' | 'ivf' | 'iamf' | 'apv';

export type PluginSelection = readonly MediaForgePlugin[] | {
    readonly exclude?: readonly (PluginName | (string & {}))[];
    readonly add?: readonly MediaForgePlugin[];
};

export interface ReadOptions extends OpenOptions {
    readonly compactIndex?: boolean;
}

export interface Reader {
    read(source: Source, options: ReadOptions): Promise<DemuxResult>;
    readonly probe?: DemuxProbe;
    readonly capabilities?: ReaderCapabilities;
}

export interface ReaderCapabilities {
    readonly handsOver?: boolean;
    readonly compactIndex?: boolean;
}

export interface ReaderPart {
    readonly id: string;
    readonly formats: readonly string[];
    readonly sniff?: (head: Uint8Array) => boolean;
    readonly priority?: number;
    readonly load: () => Promise<Reader>;
}

export interface RenditionChoice {
    readonly name?: string;
    readonly language?: string | readonly string[];
}

export interface RgbaVideoFrame {
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

export interface SampleIndex {
    readonly length: number;
    readonly byteLength: number;
    readonly maxSampleSize: number;
    readonly allKeyframes: boolean;
    readonly presentationSorted: boolean;
    readonly decodeSorted: boolean;
    readonly firstPresentation: number;
    readonly lastPresentationEnd: number;
    get(index: number): Sample;
    timestampAt(index: number): number;
    decodeTimeAt(index: number): number;
    isKeyframeAt(index: number): boolean;
}

export interface StageDefinition<Stage extends VideoStage | AudioStage = VideoStage | AudioStage> {
    readonly type: Stage['type'];
    readonly name: string;
    readonly description?: string;
    create(options?: unknown): Stage;
}

export type StageRequest<Stage extends VideoStage | AudioStage = VideoStage | AudioStage> = StageDefinition<Stage> | string | {
    readonly name: string;
    readonly options?: unknown;
};

export interface VideoCodecDecoder {
    decode(packet: EncodedPacket): DecodedVideoFrame | Promise<DecodedVideoFrame>;
    flush?(): void | Promise<void>;
    close(): void | Promise<void>;
}

export interface VideoCodecEncoder {
    encode(frame: RgbaVideoFrame): (EncodedPacket & {
        readonly codecConfig?: Uint8Array;
    }) | Promise<EncodedPacket & {
        readonly codecConfig?: Uint8Array;
    }>;
    flush?(): void | Promise<void>;
    close(): void | Promise<void>;
}

export interface VideoCodecProvider {
    readonly id: string;
    supportsDecode(codec: string): boolean;
    supportsEncode(codec: string): boolean;
    createDecoder(config: VideoDecoderConfig): VideoCodecDecoder | Promise<VideoCodecDecoder>;
    createEncoder(config: VideoEncoderConfig): VideoCodecEncoder | Promise<VideoCodecEncoder>;
}

export interface VideoDecoderConfig {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly description?: Uint8Array;
    readonly signal?: AbortSignal;
    readonly maxPixels?: number;
}

export type VideoDecoderFactory = (config: BuiltinVideoDecoderConfig) => BuiltinVideoDecoder | Promise<BuiltinVideoDecoder>;

export interface VideoDecoderPart {
    readonly kind: 'video';
    readonly id: string;
    readonly codecs: CodecMatch;
    readonly replacesHost?: false;
    readonly load: () => Promise<VideoDecoderFactory>;
}

export interface VideoEncoderConfig extends Omit<VideoDecoderConfig, 'description'> {
    readonly bitrate?: number;
    readonly framerate?: number;
}

export type VideoEncoderFactory = (config: VideoEncoderConfig) => VideoCodecEncoder | Promise<VideoCodecEncoder>;

export interface VideoEncoderPart {
    readonly kind: 'video';
    readonly id: string;
    readonly codecs: CodecMatch;
    readonly load: () => Promise<VideoEncoderFactory>;
}

export interface VideoFramePlane {
    readonly offset: number;
    readonly stride: number;
}

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

export interface VideoStage {
    readonly type: 'video';
    readonly name: string;
    configure?(input: VideoStreamInfo): VideoStreamInfo;
    process(picture: VideoPicture, emit: EmitPicture): void | Promise<void>;
    flush?(emit: EmitPicture): void | Promise<void>;
    close?(): void;
}

export interface VideoStreamInfo {
    readonly width: number;
    readonly height: number;
    readonly fps?: number;
}

export type WriterPart = ContainerWriterPart | AudioWriterPart;

export declare const aac: MediaForgePlugin;

export declare const ac3: MediaForgePlugin;

export declare const alac: MediaForgePlugin;

export declare const allPlugins: readonly MediaForgePlugin[];

export declare const apv: MediaForgePlugin;

export declare const asf: MediaForgePlugin;

export declare const avi: MediaForgePlugin;

export declare function bindCompactSampleIndex(track: TrackInfo, index: SampleIndex, reserve?: () => void): void;

export declare function bindPacketizedReader(track: TrackInfo, reader: PacketizedSampleReader): void;

export declare function createPicture(init: {
    readonly data: Uint8Array | Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly timestamp: number;
    readonly duration: number;
    readonly keyframe?: boolean;
}): VideoPicture;

export declare const flac: MediaForgePlugin;

export declare const flv: MediaForgePlugin;

export declare const h264: MediaForgePlugin;

export declare const iamf: MediaForgePlugin;

export declare const ivf: MediaForgePlugin;

export declare const mpeg12: MediaForgePlugin;

export declare const mpeg4: MediaForgePlugin;

export declare const mpegAudio: MediaForgePlugin;

export declare const mpegPs: MediaForgePlugin;

export declare const mxf: MediaForgePlugin;

export declare const opus: MediaForgePlugin;

export declare const vorbis: MediaForgePlugin;

// Types the exports reach without exporting them.

declare interface Aes3Unwrap {
    readonly channels: number;
    readonly bytesPerSample: 2 | 3;
}

declare interface AttachedPicture {
    readonly data: Uint8Array;
    readonly mimeType: string;
    readonly description?: string;
    readonly type?: number;
}

declare type AudioDecoderWarning = (code: string, message: string) => void;

declare interface AudioOutputMuxer {
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    finalize(): Promise<void>;
    setValidSamples?(samples: number): void;
    setAudioPriming?(primingSamples: number, validSamples: number | undefined, presentationTimestamps?: boolean, discardLeadingSamples?: boolean, codecDelaySamples?: number): void;
    setAudioCodecConfig?(codecConfig: Uint8Array): void;
}

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

declare type ContainerFormat = 'mp4' | 'mov' | 'webm' | 'mkv' | 'avi' | 'flv' | '3gp' | 'ts' | 'mpeg' | 'm4a' | 'm4v' | 'ogg' | 'mp3' | 'wav' | 'aiff' | 'au' | 'caf' | 'flac' | 'aac' | 'mp2' | 'mp1' | 'ac3' | 'eac3' | 'dts' | 'truehd' | 'gif' | 'apng' | 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff' | 'ico' | 'avif' | 'heif' | 'jxl' | 'asf' | 'mxf' | 'ivf' | 'obu' | 'iamf' | 'apv';

declare interface DemuxBudgetOptions {
    readonly maxSamples?: number;
    readonly maxIndexBytes?: number;
}

declare interface DemuxResult {
    title?: string;
    videoTracks: TrackInfo[];
    audioTracks: TrackInfo[];
    subtitleTracks?: TrackInfo[];
    matroskaPassThrough?: MatroskaPassThrough;
    matroskaUnsupportedTags?: boolean;
    tags?: MediaTags;
}

declare type Described<Part> = Part extends unknown ? Omit<Part, 'load'> : never;

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

declare interface EncodedPacket {
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

declare type ErrorCode = 'DECODE' | 'ENCODE' | 'MUX' | 'DEMUX' | 'FORMAT' | 'INPUT' | 'OUTPUT' | 'ABORT' | 'IO' | 'OOM' | 'PLUGIN';

declare type FieldOrder = 'progressive' | 'tt' | 'bb' | 'tb' | 'bt';

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

declare interface MediaChapter {
    readonly start: number;
    readonly end?: number;
    readonly title?: string;
}

declare interface MediaDiagnostic {
    readonly code: string;
    readonly message: string;
    readonly severity: 'warning';
    readonly format?: string;
    readonly offset?: number;
    readonly trackId?: number;
}

declare interface MediaForgeErrorOptions {
    readonly cause?: unknown;
    readonly hint?: string;
    readonly plugin?: string;
}

declare interface MediaMuxerOptions {
    readonly deferCodecConfig?: boolean;
}

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

declare interface OpenOptions extends DiagnosticOptions, DemuxBudgetOptions {
    readonly format?: string;
    readonly signal?: AbortSignal;
    readonly recovery?: 'complete-packets';
    readonly maxPacketBytes?: number;
    readonly cacheBytes?: number;
    readonly readPageBytes?: number;
}

declare interface OutputMuxer extends AudioOutputMuxer {
    addVideoChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    setVideoColour?(colour: VideoColour): void;
    setMatroskaPassThrough?(pass: MatroskaPassThrough): void;
    addSubtitleChunk?(chunk: EncodedPacket, trackIndex?: number): void;
    addExtraAudioChunk?(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    addExtraVideoChunk?(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void;
}

declare interface PlanarVideoColorSpace {
    readonly primaries?: VideoColorPrimaries;
    readonly transfer?: VideoTransferCharacteristics;
    readonly matrix?: VideoMatrixCoefficients;
    readonly fullRange?: boolean;
}

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

declare interface Sink {
    readonly signal?: AbortSignal;
    write(data: Uint8Array): void;
    readonly copiesWrites?: boolean;
    close(): Promise<void>;
    patchAt?(offset: number, data: Uint8Array): void;
    abort?(reason?: unknown): Promise<void>;
    drain?(): Promise<void>;
}

declare interface Source {
    read(offset: number, length: number): Promise<Uint8Array>;
    readonly size: number;
}

declare interface SpatialVideo {
    readonly eyes: readonly ('left' | 'right')[];
    readonly views?: 'layer' | 'side-by-side' | 'over-under';
    readonly heroEye?: 'left' | 'right';
    readonly baseline?: number;
    readonly disparityAdjustment?: number;
    readonly projection?: VideoProjection;
    readonly fieldOfView?: number;
}

declare interface StreamedSample {
    readonly track: number;
    readonly sample: Sample & {
        readonly data: Uint8Array;
    };
    readonly codecConfig?: Uint8Array;
    readonly alphaData?: Uint8Array;
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

declare type TrackType = 'video' | 'audio' | 'subtitle';

declare type ValidationMode = 'strict' | 'compatible';

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

declare type VideoProjection = 'rectilinear' | 'equirectangular' | 'half-equirectangular' | 'fisheye' | 'parametric';

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
