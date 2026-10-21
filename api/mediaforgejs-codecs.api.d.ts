// The public API of 'mediaforgejs/codecs', from its built declarations (npm run api:report).

export interface AacDecodeOptions extends DecodeOptions {
    readonly onProgress?: (decodedFrames: number, totalFrames: number) => void;
}

export interface AacEncodeResult {
    readonly frames: Uint8Array[];
    readonly audioSpecificConfig: Uint8Array;
    readonly sampleRate: number;
    readonly channels: number;
    readonly samplesPerFrame: number;
}

export interface AacFrames {
    readonly frames: readonly Uint8Array[];
    readonly sampleRate: number;
    readonly channels: number;
}

export declare class AacLcDecoder extends AacDecoder {
    constructor(sampleRate: number, channels: number);
}

export interface AlacConfig {
    readonly frameLength: number;
    readonly bitDepth: number;
    readonly riceHistoryMultiplier: number;
    readonly riceInitialHistory: number;
    readonly riceLimit: number;
    readonly channels: number;
    readonly maxRun: number;
    readonly maxFrameBytes: number;
    readonly averageBitrate: number;
    readonly sampleRate: number;
    readonly cookie: Uint8Array;
}

export declare class AlacDecoder {
    readonly config: AlacConfig;
    constructor(config: AlacConfig | Uint8Array);
    get channelMask(): number;
    decode(packet: Uint8Array): Float32Array[];
}

export interface AnimatedFrame {
    data: Uint8ClampedArray;
    delayMs: number;
}

export declare class AnimatedGifEncoder {
    constructor(width: number, height: number, options?: GifEncoderOptions);
    addFrame(image: RgbaImage, delayMs: number): Promise<void>;
    encode(): Promise<Uint8Array<ArrayBuffer>>;
}

export interface AnimatedImage {
    width: number;
    height: number;
    frames: AnimatedFrame[];
    loopCount: number;
}

export interface AnimatedWebpDecodeOptions extends DecodeOptions {
    readonly maxTotalPixels?: number;
}

export declare class AnimatedWebpEncoder {
    readonly width: number;
    readonly height: number;
    readonly loopCount: number;
    constructor(width: number, height: number, options?: AnimatedWebpEncoderOptions);
    static supported(): Promise<boolean>;
    addFrame(image: RgbaImage, delayMs: number): Promise<void>;
    encode(): Promise<Uint8Array<ArrayBuffer>>;
}

export interface AnimatedWebpEncoderOptions extends AnimationEncoderOptions {
    readonly quality?: number;
}

export interface AnimationEncoderOptions {
    readonly loopCount?: number;
}

export declare class ApngEncoder {
    constructor(width: number, height: number, options?: ApngEncoderOptions);
    addFrame(image: RgbaImage, delayMs: number): Promise<void>;
    encode(): Promise<Uint8Array<ArrayBuffer>>;
}

export interface ApngEncoderOptions extends AnimationEncoderOptions {
    readonly optimizeFrames?: boolean;
}

export interface AudioEncodeOptions {
    readonly sampleRate: number;
    readonly bitrate?: Bitrate;
    readonly onProgress?: (encodedFrames: number, totalFrames: number) => void;
    readonly signal?: AbortSignal;
}

export interface AudioTrackDecodeOptions {
    readonly codecPreference?: CodecPreference;
    readonly validation?: ValidationMode;
    readonly signal?: AbortSignal;
    readonly onWarning?: Warn;
    readonly builtinOnly?: boolean;
    readonly decoders?: readonly BuiltinAudioDecoder[];
}

export type Bitrate = number | `${number}k` | `${number}M` | `${number}kbps` | `${number}Mbps`;

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

export interface BuiltinAudioDecoder {
    readonly id: string;
    readonly codecs: readonly string[];
    create(track: TrackInfo): BuiltinAudioCodec | Promise<BuiltinAudioCodec>;
}

export interface DecodeOptions {
    readonly signal?: AbortSignal;
}

export interface DecodedAac {
    readonly sampleRate: number;
    readonly channels: number;
    readonly sampleFrames: number;
    readonly channelData: readonly Float32Array[];
}

export interface DecodedFlac {
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    readonly sampleFrames: number;
    readonly channelData: readonly Float32Array[];
}

export interface DecodedFlacFrame {
    readonly header: FlacFrameHeader;
    readonly sampleRate: number;
    readonly bitsPerSample: number;
    readonly channels: readonly Int32Array[];
    readonly byteLength: number;
}

export interface DecodedImage extends RgbaImage {
    readonly data: Uint8ClampedArray;
}

export interface DecodedMp3 {
    readonly sampleRate: number;
    readonly channels: number;
    readonly sampleFrames: number;
    readonly channelData: readonly Float32Array[];
    readonly frames: number;
}

export type EncodedAudioSampleReader = (sample: Sample, index: number, signal?: AbortSignal) => Promise<Uint8Array>;

export interface FlacFrameDecodeOptions {
    readonly streamInfo: FlacStreamInfo;
}

export interface FlacStreamInfo {
    readonly minBlockSize: number;
    readonly maxBlockSize: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    readonly totalSamples: number;
}

export type G711Codec = 'ulaw' | 'alaw';

export interface G711Options {
    readonly codec: G711Codec;
    readonly channels?: number;
}

export type GifDitherMode = 'floyd-steinberg' | 'none';

export interface GifEncoderOptions extends AnimationEncoderOptions {
    readonly dither?: GifDitherMode;
}

export interface ImageEncodeOptions {
    readonly quality?: number;
    readonly signal?: AbortSignal;
}

export interface ImageFrameInfo {
    readonly durationMs: number;
}

export interface ImageInfo {
    readonly format: 'avif' | 'heif' | 'webp' | 'jxl';
    readonly width: number;
    readonly height: number;
    readonly frameCount?: number;
    readonly animated: boolean;
    readonly durationMs?: number;
    readonly loopCount?: number;
    readonly hasAlpha?: boolean;
    readonly codec: string;
    readonly rotation?: number;
    readonly mirror?: 'vertical' | 'horizontal';
    readonly bitDepth?: number;
    readonly colour?: {
        primaries: number;
        transfer: number;
        matrix: number;
        fullRange: boolean;
    } | {
        iccBytes: number;
    };
    readonly frames?: readonly ImageFrameInfo[];
    readonly gainMap?: GainMap;
}

export interface Mp3EncodeOptions extends AudioEncodeOptions {
    readonly vbr?: boolean;
}

export interface Mp3FrameHeader {
    readonly mpeg1: boolean;
    readonly sampleRate: number;
    readonly channels: number;
    readonly mode: number;
    readonly modeExtension: number;
    readonly crc: boolean;
    readonly frameLength: number;
    readonly samplesPerFrame: number;
    readonly sideInfoLength: number;
}

export interface PacketDecoder {
    decode(packet: Uint8Array): Iterable<readonly Float32Array[]>;
    conceal?(frames: number): Iterable<readonly Float32Array[]>;
    flush?(): Iterable<readonly Float32Array[]>;
    reset(): void;
}

export interface ReplayablePcmSource {
    readonly sampleRate: number;
    readonly channels: number;
    readonly estimatedFrames: number;
    readonly channelMask?: number;
    chunks(signal?: AbortSignal): AsyncIterable<readonly Float32Array[]>;
}

export interface RgbaImage {
    readonly data: Uint8Array | Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
}

export declare class RgbaResizer {
    constructor(sourceWidth: number, sourceHeight: number, width: number, height: number, method?: ImageResizeMethod);
    resize(source: Uint8ClampedArray): Uint8ClampedArray;
    resizeAsync(source: Uint8ClampedArray, signal?: AbortSignal): Promise<Uint8ClampedArray>;
}

export interface StreamingAudioDiagnostics {
    readonly format: StreamingSelfHostedAudioFormat;
    readonly passes: number;
    readonly inputFrames: number;
    readonly encodedFrames: number;
    readonly peakPcmFrames: number;
    readonly planningBytes: number;
}

export interface StreamingAudioEncodeOptions {
    readonly bitrateKbps?: number;
    readonly vbr?: boolean;
    readonly codec?: 'pcm' | G711Codec;
    readonly sampleFormat?: PcmSampleFormat;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: MediaProgress) => void;
    readonly tags?: MediaTags;
}

export declare class StreamingMp3Decoder {
    get sampleRate(): number;
    get channels(): number;
    frames: number;
    reset(): void;
    pushFrame(data: Uint8Array): readonly Float32Array[];
}

export type StreamingSelfHostedAudioFormat = 'aac' | 'flac' | 'mp2' | 'mp3' | 'wav' | 'aiff' | 'au' | 'caf';

export interface Vp8lImage extends DecodedImage {
    readonly hasAlpha: boolean;
}

export declare function buildAacAsc(sampleRate: number, channels: number): Uint8Array;

export declare function createAudioTrackSource(track: TrackInfo, read: EncodedAudioSampleReader, options?: AudioTrackDecodeOptions): ReplayablePcmSource;

export declare function createFlacTrackPcmSource(track: TrackInfo, readPacket: (index: number, signal?: AbortSignal) => Promise<Uint8Array>): ReplayablePcmSource;

export declare function createMp3TrackPcmSource(track: TrackInfo, readPacket: (index: number, signal?: AbortSignal) => Promise<Uint8Array>, signal?: AbortSignal): ReplayablePcmSource;

export declare function decodeAacFrames(stream: AacFrames, options?: AacDecodeOptions): Promise<DecodedAac>;

export declare function decodeAnimatedWebp(bytes: Uint8Array, options?: AnimatedWebpDecodeOptions): Promise<AnimatedImage>;

export declare function decodeFlac(bytes: Uint8Array, options?: DecodeOptions): Promise<DecodedFlac>;

export declare function decodeFlacFrame(frame: Uint8Array, options: FlacFrameDecodeOptions): DecodedFlacFrame;

export declare function decodeG711(bytes: Uint8Array, options: G711Options): Float32Array[];

export declare function decodeMp3(bytes: Uint8Array, options?: DecodeOptions): Promise<DecodedMp3>;

export declare function decodeStillWebp(bytes: Uint8Array, options?: DecodeOptions): Promise<DecodedImage>;

export declare function decodeVp8l(data: Uint8Array): Vp8lImage;

export declare function encodeAacLc(planes: readonly Float32Array[], options: AudioEncodeOptions): Promise<AacEncodeResult>;

export declare function encodeBmp(image: RgbaImage, options?: ImageEncodeOptions): Promise<Uint8Array<ArrayBuffer>>;

export declare function encodeFlac(planes: readonly Float32Array[], options: AudioEncodeOptions): Promise<Uint8Array<ArrayBuffer>>;

export declare function encodeG711(planes: readonly Float32Array[], options: G711Options): Uint8Array<ArrayBuffer>;

export declare function encodeIco(image: RgbaImage, options?: ImageEncodeOptions): Promise<Uint8Array<ArrayBuffer>>;

export declare function encodeJpeg(image: RgbaImage, options?: ImageEncodeOptions): Promise<Uint8Array<ArrayBuffer>>;

export declare function encodeMp2(planes: readonly Float32Array[], options: AudioEncodeOptions): Promise<Uint8Array<ArrayBuffer>>;

export declare function encodeMp3(planes: readonly Float32Array[], options: Mp3EncodeOptions): Promise<Uint8Array<ArrayBuffer>>;

export declare function encodePng(image: RgbaImage, options?: ImageEncodeOptions): Promise<Uint8Array<ArrayBuffer>>;

export declare const encodeReplayablePcm: (source: ReplayablePcmSource, format: StreamingSelfHostedAudioFormat, options?: StreamingAudioEncodeOptions) => Promise<{
    blob: Blob;
    diagnostics: StreamingAudioDiagnostics;
}>;

export declare const encodeReplayablePcmToSink: (source: ReplayablePcmSource, format: StreamingSelfHostedAudioFormat, sink: Sink, options?: StreamingAudioEncodeOptions) => Promise<StreamingAudioDiagnostics>;

export declare function encodeTiff(image: RgbaImage, options?: ImageEncodeOptions): Promise<Uint8Array<ArrayBuffer>>;

export declare function encodeWebP(image: RgbaImage, options?: ImageEncodeOptions): Promise<Uint8Array<ArrayBuffer>>;

export declare function flacSamplesToFloat(samples: Int32Array, bitsPerSample: number): Float32Array;

export declare function isMp3InfoFrame(frame: Uint8Array): boolean;

export declare function normalizePcmSource(source: ReplayablePcmSource, targetSampleRate: number, targetChannels: number, window?: PcmStreamWindow): ReplayablePcmSource;

export declare function parseAdtsHeader(adts: Uint8Array): {
    sampleRate: number;
    channels: number;
} | null;

export declare function parseAlacConfig(input: Uint8Array): AlacConfig;

export declare function parseFlacStreamInfo(config: Uint8Array): FlacStreamInfo;

export declare function parseImageInfo(bytes: Uint8Array, format: ContainerFormat): ImageInfo;

export declare function parseMp3FrameHeader(data: Uint8Array, offset: number): Mp3FrameHeader | null;

export declare function sliceAdtsFrames(adts: Uint8Array): Uint8Array[];

export declare function wrapAdts(stream: AacFrames): Uint8Array<ArrayBuffer>;

// Types the exports reach without exporting them.

declare class AacBitReader {
    constructor(bytes: Uint8Array);
    read(bits: number): number;
    readBit(): number;
    peek(bits: number): number;
    skip(bits: number): void;
    bitsLeft(): number;
    bitsRead(): number;
    seek(position: number): void;
    align(origin?: number): void;
}

declare class AacDecoder extends AacSyntax {
    decodeFrame(accessUnit: Uint8Array): Float32Array[];
    protected joinPair(element: Element, commonWindow: boolean, msPresent: number): void;
    protected predict(channel: Channel): void;
    protected dequantize(channel: Channel, positions: number[], amplitudes: number[]): void;
    protected spectralToSample(): void;
}

declare interface AacDecoderConfig {
    readonly objectType: number;
    readonly samplingIndex: number;
    readonly sampleRate: number;
    readonly channelConfiguration: number;
    readonly programLayout?: readonly AacLayoutElement[];
    readonly sbr: number;
    readonly ps: number;
    readonly extensionSampleRate: number;
    readonly frameLengthShort?: boolean;
}

declare interface AacLayoutElement {
    readonly type: number;
    readonly tag: number;
    readonly position: number;
}

declare interface AacSbrProcessor {
    readExtension(reader: AacBitReader, crc: boolean, count: number, elementType: number, sampleRate: number, ps: number): void;
    apply(elementType: number, left: Float64Array, right: Float64Array, extensionRate: number, ps: boolean): void;
}

declare interface AacSbrTools {
    readonly createSbr: (elementType: number) => AacSbrProcessor;
}

declare class AacSyntax {
    protected readonly sbrTools?: AacSbrTools | undefined;
    protected readonly missingSbr: MissingSbr;
    protected readonly objectType: number;
    protected readonly samplingIndex: number;
    protected readonly coreRate: number;
    protected readonly frameLen: number;
    protected sbr: number;
    protected ps: number;
    protected extensionRate: number;
    protected readonly elements: Map<number, Element>[];
    protected outputs: Channel[];
    lastBitsConsumed: number;
    lastCodedBands: number;
    protected sbrFailure?: Error;
    constructor(config: AacDecoderConfig, sbrTools?: AacSbrTools | undefined, missingSbr?: MissingSbr);
    get sampleRate(): number;
    get channels(): number;
    get channelMask(): number | undefined;
    get frameLength(): number;
    get leadingSkip(): number;
    probeFrame(accessUnit: Uint8Array): void;
    protected readFrame(accessUnit: Uint8Array, probe: boolean): Float32Array[];
    protected joinPair(_element: Element, _commonWindow: boolean, _msPresent: number): void;
    protected predict(_channel: Channel): void;
    protected dequantize(_channel: Channel, _positions: number[], _amplitudes: number[]): void;
    protected spectralToSample(): void;
}

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

declare class Channel {
    readonly ics: Ics;
    readonly bandType: Uint8Array<ArrayBuffer>;
    readonly bandTypeRunEnd: Uint8Array<ArrayBuffer>;
    readonly sf: Int32Array<ArrayBuffer>;
    readonly coeffs: Float64Array<ArrayBuffer>;
    readonly saved: Float64Array<ArrayBuffer>;
    readonly ret: Float64Array<ArrayBuffer>;
    readonly tns: Tns;
    predictorState: Float32Array | null;
    predictorInitialized: boolean;
}

declare type CodecPreference = 'webcodecs' | 'builtin';

declare type ContainerFormat = 'mp4' | 'mov' | 'webm' | 'mkv' | 'avi' | 'flv' | '3gp' | 'ts' | 'mpeg' | 'm4a' | 'm4v' | 'ogg' | 'mp3' | 'wav' | 'aiff' | 'au' | 'caf' | 'flac' | 'aac' | 'mp2' | 'mp1' | 'ac3' | 'eac3' | 'dts' | 'truehd' | 'gif' | 'apng' | 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff' | 'ico' | 'avif' | 'heif' | 'jxl' | 'asf' | 'mxf' | 'ivf' | 'obu' | 'iamf' | 'apv';

declare interface Coupling {
    couplingPoint: number;
    numCoupled: number;
    type: Uint8Array;
    idSelect: Uint8Array;
    chSelect: Uint8Array;
    gain: Float64Array[];
}

declare class Element {
    readonly type: number;
    readonly ch: [
        Channel,
        Channel
    ];
    readonly msMask: Uint8Array<ArrayBuffer>;
    present: boolean;
    readonly coupling: Coupling;
    sbr: AacSbrProcessor | null;
    constructor(type: number);
}

declare type FieldOrder = 'progressive' | 'tt' | 'bb' | 'tb' | 'bt';

declare interface FlacFrameHeader {
    readonly headerLen: number;
    readonly blockSize: number;
    readonly blockingStrategy: 0 | 1;
    readonly codedNumber: number;
    readonly sampleRate: number | undefined;
    readonly channelCount: number;
    readonly bitsPerSample: number | undefined;
}

declare interface GainMap {
    readonly width: number;
    readonly height: number;
    readonly headroom?: number;
}

declare interface Ics {
    windowSequence: [
        number,
        number
    ];
    useKbWindow: [
        number,
        number
    ];
    maxSfb: number;
    numWindowGroups: number;
    groupLen: Uint8Array;
    numWindows: number;
    swbOffset: Uint16Array;
    numSwb: number;
    tnsMaxBands: number;
    predictorPresent: boolean;
    predictorResetGroup: number;
    predictionUsed: Uint8Array;
}

declare type ImageResizeMethod = 'nearest' | 'bilinear' | 'lanczos3';

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

declare interface MediaTags {
    readonly entries: readonly {
        readonly key: string;
        readonly value: string;
    }[];
    readonly chapters?: readonly MediaChapter[];
    readonly pictures?: readonly AttachedPicture[];
}

declare type MissingSbr = (message: string) => Error;

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

declare type PcmSampleFormat = 's16' | 's24' | 'f32';

declare interface PcmStreamWindow {
    readonly head?: number;
    readonly valid?: number;
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

declare interface SpatialVideo {
    readonly eyes: readonly ('left' | 'right')[];
    readonly views?: 'layer' | 'side-by-side' | 'over-under';
    readonly heroEye?: 'left' | 'right';
    readonly baseline?: number;
    readonly disparityAdjustment?: number;
    readonly projection?: VideoProjection;
    readonly fieldOfView?: number;
}

declare interface Tns {
    present: boolean;
    nFilt: Uint8Array;
    length: Uint8Array;
    order: Uint8Array;
    direction: Uint8Array;
    coef: Float64Array;
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

declare type Warn = (warning: Omit<MediaDiagnostic, 'severity'>) => void;
