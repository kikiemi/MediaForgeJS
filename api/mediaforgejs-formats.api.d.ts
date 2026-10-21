// The public API of 'mediaforgejs/formats', from its built declarations (npm run api:report).

export declare class AdtsMuxer implements AudioOutputMuxer {
    constructor(sink: Sink, sampleRate: number, channels: number);
    addAudioChunk(chunk: EncodedPacket): void;
    finalize(): Promise<void>;
}

export declare class AsfDemuxer extends PacketDemuxer {
    demux(source: Source, diagnostics?: DiagnosticContext): Promise<DemuxResult>;
}

export interface AssCueData {
    rawText: string;
    text: string;
    fields: Record<string, string>;
}

export interface AssDocumentData {
    scriptInfo: Record<string, string>;
    styleFormat: string[];
    styles: Record<string, string>[];
    eventFormat: string[];
    comments: string[];
}

export interface AssSubtitleOptions extends SubtitleOptions {
    format?: 'ass' | 'ssa';
    encoding?: string;
}

export declare class AviDemuxer {
    constructor(options?: AviDemuxerOptions);
    demux(input: File | Blob | Source, signal?: AbortSignal, diagnostics?: DiagnosticContext): Promise<DemuxResult>;
}

export interface AviDemuxerOptions extends DemuxBudgetOptions, DiagnosticOptions {
    readonly recovery?: 'complete-packets';
}

export declare class AviMuxer implements OutputMuxer {
    constructor(cfg: MuxerConfig, sink: Sink);
    addVideoChunk(c: EncodedPacket, cfg?: Uint8Array): void;
    addAudioChunk(c: EncodedPacket): void;
    addPcmBuffer(buf: PcmAudioBuffer): void;
    addPcmPlanarChunk(planes: readonly Float32Array[], sampleRate: number, timestamp?: number): void;
    finalize(): Promise<void>;
}

export interface DemuxResult {
    title?: string;
    videoTracks: TrackInfo[];
    audioTracks: TrackInfo[];
    subtitleTracks?: TrackInfo[];
    matroskaPassThrough?: MatroskaPassThrough;
    matroskaUnsupportedTags?: boolean;
    tags?: MediaTags;
}

export type EventMessage = {
    schemeIdUri: string;
    value: string;
    timescale: number;
    eventDuration: number;
    id: number;
    messageData: Uint8Array;
} & ({
    version: 0;
    presentationTimeDelta: number;
} | {
    version: 1;
    presentationTime: bigint;
});

export declare class FlacMuxer implements AudioOutputMuxer {
    constructor(sink: Sink, sampleRate: number, channels: number, bitsPerSample?: number, codecConfig?: Uint8Array, tags?: MediaTags | undefined);
    setAudioCodecConfig(codecConfig: Uint8Array): void;
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    finalize(): Promise<void>;
}

export declare class FlvDemuxer {
    constructor(options?: DemuxBudgetOptions);
    demux(input: File | Blob | Source, signal?: AbortSignal, diagnostics?: DiagnosticContext): Promise<DemuxResult>;
}

export declare class FlvMuxer implements OutputMuxer {
    constructor(cfg: MuxerConfig, sink: Sink);
    addVideoChunk(chunk: EncodedPacket, codecCfg?: Uint8Array): void;
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    finalize(): Promise<void>;
}

export interface Id3Frame {
    id: string;
    flags: number;
    data: Uint8Array;
}

export interface Id3Tag {
    version: number;
    revision: number;
    flags: number;
    frames: Id3Frame[];
    paddingSize: number;
    trailingData?: Uint8Array;
    opaqueData?: Uint8Array;
    metadata: MediaMetadata;
    diagnostics: readonly MediaDiagnostic[];
}

export declare class IvfDemuxer extends PacketDemuxer {
    demux(source: Source, diagnostics?: DiagnosticContext): Promise<DemuxResult>;
}

export declare class IvfMuxer extends ElementaryStreamMuxer {
    constructor(cfg: MuxerConfig, sink: Sink);
    protected write(chunk: EncodedPacket): void;
    protected end(): void;
}

export interface MediaMetadata {
    entries: MetadataEntry[];
    chapters: MetadataChapter[];
    opaque: OpaqueMetadata[];
    diagnostics: readonly MediaDiagnostic[];
}

export interface MetadataChapter {
    id?: string;
    startTime: number;
    endTime?: number;
    title?: string;
    language?: string;
    entries?: readonly MetadataEntry[];
}

export interface MetadataEntry {
    key: string;
    value: MetadataValue;
    language?: string;
    source?: string;
}

export interface MetadataInput {
    entries?: readonly MetadataEntry[];
    chapters?: readonly MetadataChapter[];
    opaque?: readonly OpaqueMetadata[];
}

export interface MetadataOptions extends DiagnosticOptions {
    maxBytes?: number;
    maxEntries?: number;
}

export type MetadataValue = {
    type: 'text';
    value: string;
} | {
    type: 'integer';
    value: bigint;
} | {
    type: 'number';
    value: number;
} | {
    type: 'boolean';
    value: boolean;
} | {
    type: 'date';
    value: string;
} | {
    type: 'binary';
    value: Uint8Array;
    mimeType?: string;
    description?: string;
};

export interface Mp4CodecConfiguration {
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

export declare class Mp4Demuxer {
    constructor(options?: Mp4DemuxerOptions);
    demux(input: File | Blob | Source, signal?: AbortSignal, diagnostics?: DiagnosticContext): Promise<DemuxResult>;
    describe(input: Source, signal: AbortSignal | undefined, diagnostics: DiagnosticContext): Promise<MovieDescription | undefined>;
    readSample(sample: Sample): Promise<Uint8Array>;
    readSample(input: File | Blob | Source, sample: Sample): Promise<Uint8Array>;
}

export interface Mp4DemuxerOptions extends DemuxBudgetOptions {
    allowEmptyTracks?: boolean;
    fragmentsFrom?: number;
    movie?: KeptMovie;
}

export declare class Mp4Muxer implements OutputMuxer {
    constructor(cfg: MuxerConfig, sink: Sink);
    addVideoChunk(chunk: EncodedPacket, codecCfg?: Uint8Array): void;
    addExtraVideoChunk(index: number, chunk: EncodedPacket, codecCfg?: Uint8Array): void;
    addSubtitleChunk(chunk: EncodedPacket, trackIndex?: number): void;
    addExtraAudioChunk(index: number, chunk: EncodedPacket, codecCfg?: Uint8Array): void;
    addAudioChunk(chunk: EncodedPacket, codecCfg?: Uint8Array): void;
    setAudioPriming(primeSamples: number, validSamples: number | undefined, presentationTimestamps?: boolean, _discardLeadingSamples?: boolean, codecDelaySamples?: number): void;
    setAudioCodecConfig(codecConfig: Uint8Array): void;
    setVideoColour(colour: VideoColour): void;
    finalize(): Promise<void>;
}

export declare class MxfDemuxer extends PacketDemuxer {
    demux(source: Source, diagnostics?: DiagnosticContext): Promise<DemuxResult>;
}

export declare class ObuDemuxer extends PacketDemuxer {
    demux(source: Source, diagnostics?: DiagnosticContext): Promise<DemuxResult>;
}

export declare class OggMuxer implements AudioOutputMuxer {
    setValidSamples(samples: number): void;
    constructor(cfg: MuxerConfig, sink: Sink);
    setAudioCodecConfig(codecConfig: Uint8Array): void;
    addVideoChunk(): void;
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    finalize(): Promise<void>;
}

export interface OpaqueMetadata {
    format: string;
    data: Uint8Array;
}

export interface ParseSubtitleOptions extends SubtitleOptions {
    format?: SubtitleFormatInput;
    encoding?: string;
}

export declare class PsDemuxer {
    constructor(options?: DemuxBudgetOptions);
    demux(input: File | Blob | Source, signal?: AbortSignal, diagnostics?: DiagnosticContext): Promise<DemuxResult>;
}

export interface RawAudioDemuxOptions extends DiagnosticOptions, DemuxBudgetOptions {
    readonly format: 'aac' | 'mp1' | 'mp2' | 'mp3';
    readonly signal?: AbortSignal;
}

export declare class RawMuxer implements AudioOutputMuxer {
    constructor(sink: Sink, leading?: Uint8Array | undefined);
    addAudioChunk(chunk: EncodedPacket): void;
    finalize(): Promise<void>;
}

export interface Sample {
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

export interface StandaloneAudioDemuxOptions extends DiagnosticOptions, DemuxBudgetOptions {
    readonly format: 'wav' | 'aiff' | 'aif' | 'aifc' | 'au' | 'caf' | 'flac' | 'ogg' | 'ogv' | 'oga' | 'opus';
    readonly signal?: AbortSignal;
    readonly maxPacketBytes?: number;
    readonly checkedOggPages?: ReadonlySet<number>;
}

export type SubtitleBlock = {
    type: 'cue';
    cueIndex: number;
} | {
    type: 'note' | 'style' | 'region' | 'unknown';
    text: string;
};

export interface SubtitleCue {
    startTime: number;
    endTime: number;
    text: string;
    id?: string;
    settings?: string;
    ass?: AssCueData;
    ttml?: TtmlCueData;
}

export interface SubtitleDocument {
    format: SubtitleFormat;
    cues: SubtitleCue[];
    blocks?: SubtitleBlock[];
    header?: string;
    headers?: string[];
    timestampMap?: SubtitleTimestampMap;
    ass?: AssDocumentData;
    ttml?: TtmlDocumentData;
    diagnostics: readonly MediaDiagnostic[];
}

export interface SubtitleEditOptions {
    startTime?: number;
    endTime?: number;
    offset?: number;
}

export type SubtitleFormat = 'webvtt' | 'srt' | 'ass' | 'ssa' | 'ttml';

export type SubtitleFormatInput = SubtitleFormat | 'vtt' | 'dfxp' | 'imsc';

export interface SubtitleOptions extends DiagnosticOptions {
    maxBytes?: number;
    maxCues?: number;
    maxBlocks?: number;
    maxDepth?: number;
    maxNodes?: number;
}

export interface SubtitleTimestampMap {
    localTime: number;
    mpegTimestamp: number;
}

export interface SubtitleTrackConfig {
    codec: 'text/webvtt' | 'text/utf8' | 'wvtt';
    codecConfig?: Uint8Array;
    language?: string;
    label?: string;
    kind?: 'subtitles' | 'captions' | 'descriptions' | 'chapters' | 'metadata';
    default?: boolean;
}

export interface TrackInfo {
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

export declare class TsDemuxer {
    constructor(options?: DemuxBudgetOptions);
    demux(input: File | Blob | Source, signal?: AbortSignal, diagnostics?: DiagnosticContext): Promise<DemuxResult>;
    probe(source: Source, signal?: AbortSignal, diagnostics?: DiagnosticContext, target?: ProbeTarget): Promise<ProbedInput | undefined>;
}

export declare class TsMuxer implements OutputMuxer {
    constructor(cfg: MuxerConfig, sink: Sink);
    addVideoChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    addExtraAudioChunk(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    startSegment(): void;
    finalize(): Promise<void>;
}

export interface TtmlCueData {
    text: string;
    style?: Record<string, string>;
    region?: string;
    language?: string;
    spans: TtmlSpan[];
}

export interface TtmlDocumentData {
    styles: Record<string, Record<string, string>>;
    regions: Record<string, Record<string, string>>;
    parameters: Record<string, string>;
    rootStyle?: Record<string, string>;
    language?: string;
}

export interface TtmlSpan {
    text: string;
    style?: Record<string, string>;
    language?: string;
    region?: string;
}

export interface TtmlTimingParameters {
    frameRate?: number;
    frameRateMultiplier?: number;
    subFrameRate?: number;
    tickRate?: number;
}

export declare class VorbisMuxer implements AudioOutputMuxer {
    constructor(sink: Sink, track: AudioTrackConfig, comments?: Uint8Array);
    setValidSamples(samples: number): void;
    addAudioChunk(chunk: EncodedPacket): void;
    finalize(): Promise<void>;
}

export declare class WavMuxer {
    constructor(sink: Sink, sampleRate: number, channels: number);
    addPcmData(data: Uint8Array): void;
    addAudioBuffer(buffer: PcmAudioBuffer): void;
    addAudioBufferChunked(buffer: PcmAudioBuffer, signal?: AbortSignal): Promise<void>;
    finalize(): Promise<void>;
}

export interface WaveFormat {
    readonly codec: WavePcmCodec | WaveG711Codec;
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitsPerSample: number;
    readonly validBitsPerSample: number;
    readonly blockAlign: number;
    readonly float: boolean;
    readonly channelMask?: number;
    readonly codecConfig: Uint8Array;
}

export type WavePcmCodec = 'pcm-u8' | 'pcm-s16le' | 'pcm-s24le' | 'pcm-s32le' | 'pcm-f32le' | 'pcm-f64le';

export declare class WebMDemuxer {
    constructor(options?: DemuxBudgetOptions);
    demux(input: Blob | Source, signal?: AbortSignal, diagnostics?: DiagnosticContext): Promise<DemuxResult>;
    probe(input: Source, signal?: AbortSignal, diagnostics?: DiagnosticContext, target?: ProbeTarget): Promise<ProbedInput | undefined>;
}

export declare class WebMMuxer implements OutputMuxer {
    setValidSamples(samples: number): void;
    setAudioPriming(primingSamples: number, validSamples: number | undefined, presentationTimestamps?: boolean, discardLeadingSamples?: boolean, codecDelaySamples?: number): void;
    constructor(cfg: MuxerConfig, sink: Sink);
    setMatroskaPassThrough(pass: MatroskaPassThrough): void;
    setVideoColour(colour: VideoColour): void;
    setAudioCodecConfig(codecConfig: Uint8Array): void;
    addSubtitleChunk(chunk: EncodedPacket, trackIndex?: number): void;
    addVideoChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    addExtraVideoChunk(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    addExtraAudioChunk(index: number, chunk: EncodedPacket, codecCfg?: Uint8Array): void;
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    finalize(): Promise<void>;
}

export interface WebVttSample {
    cues: WebVttSampleCue[];
    empty: boolean;
    unknownBoxes: Uint8Array[];
    diagnostics: readonly MediaDiagnostic[];
}

export interface WebVttSampleCue {
    text: string;
    id?: string;
    settings?: string;
    unknownBoxes?: readonly Uint8Array[];
}

export declare function createId3Tag(input: MetadataInput, options?: MetadataOptions & {
    version?: 3 | 4;
}): Id3Tag;

export declare function decodeEventMessage(bytes: Uint8Array): EventMessage;

export declare function decodeWebVttBlock(data: Uint8Array): WebVttSampleCue;

export declare function decodeWebVttSample(data: Uint8Array, options?: SubtitleOptions): WebVttSample;

export declare function demuxRawAudio(source: Source, options: RawAudioDemuxOptions): Promise<DemuxResult>;

export declare function demuxStandaloneAudio(source: Source, options: StandaloneAudioDemuxOptions): Promise<DemuxResult>;

export declare function deserializeTracks(json: string): MediaTrack[];

export declare function detectFormat(h: Uint8Array): ContainerFormat;

export declare function detectSourceFormat(source: Source, signal?: AbortSignal, extra?: readonly FormatSignature[]): Promise<ContainerFormat>;

export declare function detectSubtitleFormat(input: string | Uint8Array, options?: SubtitleOptions): SubtitleFormat | null;

export declare function editSubtitles(document: SubtitleDocument, options?: SubtitleEditOptions): SubtitleDocument;

export declare function encodeEventMessage(event: EventMessage): Uint8Array<ArrayBuffer>;

export declare function encodeWebVttBlock(cue: WebVttSampleCue): Uint8Array<ArrayBuffer>;

export declare function encodeWebVttSample(cues: readonly WebVttSampleCue[], unknownBoxes?: readonly Uint8Array[]): Uint8Array<ArrayBuffer>;

export declare function eventMessageTime(event: EventMessage, segmentStartTime?: number): number;

export declare function formatAssTimestamp(seconds: number): string;

export declare function formatSubtitleTimestamp(seconds: number, format?: 'webvtt' | 'srt'): string;

export declare function makeWebVttCodecConfig(document?: SubtitleDocument): Uint8Array<ArrayBuffer>;

export declare function normalizeMetadata(input: MetadataInput, options?: MetadataOptions): MediaMetadata;

export declare function parseAss(input: string | Uint8Array, options?: AssSubtitleOptions): SubtitleDocument;

export declare function parseAssTimestamp(value: string): number | null;

export declare function parseId3Tag(bytes: Uint8Array, options?: MetadataOptions): Id3Tag;

export declare function parseSrt(input: string | Uint8Array, options?: SubtitleOptions): SubtitleDocument;

export declare function parseSubtitleTimestamp(value: string): number | null;

export declare function parseSubtitles(input: string | Uint8Array, options?: ParseSubtitleOptions): SubtitleDocument;

export declare function parseTtml(input: string | Uint8Array, options?: SubtitleOptions): SubtitleDocument;

export declare function parseTtmlTimestamp(value: string, parameters?: TtmlTimingParameters): number | null;

export declare function parseWaveFormat(input: Uint8Array, onWrongByteRate?: (declared: number, expected: number) => void): WaveFormat;

export declare function parseWebVtt(input: string | Uint8Array, options?: SubtitleOptions): SubtitleDocument;

export declare function serializeTracks(tracks: readonly MediaTrack[]): string;

export declare function subtitleTrackConfig(document: SubtitleDocument, options?: Omit<SubtitleTrackConfig, 'codecConfig'>): SubtitleTrackConfig;

export declare function toSubtitleChunks(document: SubtitleDocument | readonly SubtitleCue[], codec?: SubtitleTrackConfig['codec'], options?: {
    startTime?: number;
    endTime?: number;
    maxSamples?: number;
    maxBytes?: number;
}): EncodedPacket[];

export declare function writeAss(input: SubtitleDocument | readonly SubtitleCue[], options?: AssSubtitleOptions): string;

export declare function writeId3Tag(tag: Pick<Id3Tag, 'version' | 'frames'> & Partial<Pick<Id3Tag, 'revision' | 'flags' | 'paddingSize' | 'trailingData' | 'opaqueData'>>, options?: MetadataOptions): Uint8Array<ArrayBuffer>;

export declare function writeSrt(document: SubtitleDocument | readonly SubtitleCue[], options?: SubtitleOptions): string;

export declare function writeSubtitles(document: SubtitleDocument | readonly SubtitleCue[], format: SubtitleFormatInput, options?: SubtitleOptions): string;

export declare function writeTtml(input: SubtitleDocument | readonly SubtitleCue[], options?: SubtitleOptions): string;

export declare function writeWebVtt(document: SubtitleDocument | readonly SubtitleCue[], options?: SubtitleOptions): string;

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

declare interface ChunkAudioUnit {
    readonly samples: number;
    readonly bytes: number;
    readonly mpegFrames?: boolean;
}

declare type ContainerFormat = 'mp4' | 'mov' | 'webm' | 'mkv' | 'avi' | 'flv' | '3gp' | 'ts' | 'mpeg' | 'm4a' | 'm4v' | 'ogg' | 'mp3' | 'wav' | 'aiff' | 'au' | 'caf' | 'flac' | 'aac' | 'mp2' | 'mp1' | 'ac3' | 'eac3' | 'dts' | 'truehd' | 'gif' | 'apng' | 'png' | 'jpeg' | 'webp' | 'bmp' | 'tiff' | 'ico' | 'avif' | 'heif' | 'jxl' | 'asf' | 'mxf' | 'ivf' | 'obu' | 'iamf' | 'apv';

declare interface DemuxBudgetOptions {
    readonly maxSamples?: number;
    readonly maxIndexBytes?: number;
}

declare class DemuxIndexBudget {
    readonly limits: ResolvedDemuxBudget;
    constructor(limits: ResolvedDemuxBudget);
    checkSamples(count: number, context?: string): void;
    reserveSamples(count: number, estimatedBytesPerSample?: number, context?: string): void;
    reserveBytes(bytes: number, context?: string): void;
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

declare abstract class ElementaryStreamMuxer implements OutputMuxer {
    protected readonly sink: Sink;
    protected units: number;
    constructor(name: string, unit: string, kind: 'audio' | 'video', cfg: MuxerConfig, sink: Sink);
    protected abstract write(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    protected end(): void;
    addVideoChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    finalize(): Promise<void>;
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

declare type FieldOrder = 'progressive' | 'tt' | 'bb' | 'tb' | 'bt';

declare interface FormatSignature {
    readonly priority: number;
    readonly format: (head: Uint8Array) => string | null;
}

declare interface FragmentState {
    readonly trexDefaults: ReadonlyMap<number, {
        descriptionIndex: number;
        duration: number;
        size: number;
        flags: number;
    }>;
    readonly fragmentNextDts: Map<number, number>;
    readonly fragmentDescriptions: ReadonlyMap<TrackInfo, SampleDescriptions>;
    readonly layerPending: Set<TrackInfo>;
}

declare interface GainMap {
    readonly width: number;
    readonly height: number;
    readonly headroom?: number;
}

declare interface KeptMovie {
    tracks?: readonly (KeptTrack | undefined)[];
    moov?: Uint8Array;
    moovEnd?: number;
    title?: string;
    tags?: DemuxResult['tags'];
    gapless?: Mp4GaplessInfo;
    trex?: FragmentState['trexDefaults'];
}

declare interface KeptTrack {
    readonly track: TrackInfo;
    readonly list: 'videoTracks' | 'audioTracks' | 'subtitleTracks';
    readonly descriptions?: SampleDescriptions;
}

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

declare interface MediaTags {
    readonly entries: readonly {
        readonly key: string;
        readonly value: string;
    }[];
    readonly chapters?: readonly MediaChapter[];
    readonly pictures?: readonly AttachedPicture[];
}

declare interface MediaTrack {
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

declare type MetadataPolicy = 'warn' | 'error';

declare interface MovieDescription {
    readonly result: DemuxResult;
    readonly index: (signal: AbortSignal | undefined, diagnostics: DiagnosticContext) => Promise<DemuxResult>;
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

declare interface Mp4GaplessInfo {
    readonly priming: number;
    readonly padding: number;
    readonly validSamples: number;
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

declare interface OutputMuxer extends AudioOutputMuxer {
    addVideoChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    setVideoColour?(colour: VideoColour): void;
    setMatroskaPassThrough?(pass: MatroskaPassThrough): void;
    addSubtitleChunk?(chunk: EncodedPacket, trackIndex?: number): void;
    addExtraAudioChunk?(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void;
    addExtraVideoChunk?(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void;
}

declare abstract class PacketDemuxer {
    protected readonly signal?: AbortSignal;
    protected readonly budget: DemuxIndexBudget;
    protected readonly maxPacketBytes: number;
    constructor(options?: PacketDemuxerOptions);
    protected checkPacket(size: number, what: string): void;
}

declare interface PacketDemuxerOptions extends DemuxBudgetOptions {
    readonly signal?: AbortSignal;
    readonly maxPacketBytes?: number;
}

declare interface PcmAudioBuffer {
    readonly sampleRate: number;
    readonly length: number;
    readonly numberOfChannels: number;
    readonly duration: number;
    getChannelData(channel: number): Float32Array;
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

declare interface ResolvedDemuxBudget {
    readonly maxSamples: number;
    readonly maxIndexBytes: number;
}

declare interface SampleDescriptions {
    readonly entries: readonly SampleEntry[];
    readonly configIndex: Int32Array;
    readonly configurations?: Mp4CodecConfiguration[];
    readonly pending?: boolean;
}

declare interface SampleEntry {
    readonly codecFourCC: string;
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly pixelAspectRatioNum: number;
    readonly pixelAspectRatioDen: number;
    readonly codecConfig: Uint8Array | undefined;
    readonly pcmFrameBytes: number;
    readonly chunkUnit: ChunkAudioUnit | undefined;
    readonly codecTag: string | undefined;
    readonly dolbyVisionConfig: Uint8Array | undefined;
    readonly colour: VideoColour | undefined;
    readonly fieldOrder: FieldOrder | undefined;
    readonly forced: boolean;
    readonly spatial?: SpatialVideo;
    readonly spatialBoxes?: Uint8Array;
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

declare type WaveG711Codec = 'alaw' | 'ulaw';
