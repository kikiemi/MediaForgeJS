// The public API of 'mediaforgejs/streaming', from its built declarations (npm run api:report).

export interface CmafFlushOptions {
    readonly requireKeyframe?: boolean;
    readonly producerReferenceTime?: CmafProducerReferenceTime;
}

export interface CmafProducerReferenceTime {
    readonly trackId: number;
    readonly ntpTimestamp: bigint;
    readonly mediaTime: bigint | number;
}

export interface CmafSample {
    readonly trackId: number;
    readonly data: Uint8Array;
    readonly decodeTimestamp: bigint | number;
    readonly duration: number;
    readonly compositionTimeOffset?: number;
    readonly isKeyframe: boolean;
}

export interface CmafSegment extends CmafSegmentInfo {
    readonly data: Uint8Array;
}

export interface CmafSegmentInfo {
    readonly sequenceNumber: number;
    readonly byteLength: number;
    readonly independent: boolean;
    readonly tracks: readonly CmafSegmentTrack[];
}

export interface CmafSegmentTrack {
    readonly trackId: number;
    readonly timescale: number;
    readonly baseDecodeTime: bigint;
    readonly duration: bigint;
    readonly sampleCount: number;
    readonly independent: boolean;
}

export interface CmafStreamSegment {
    readonly kind: 'init' | 'media';
    readonly offset: number;
    readonly byteLength: number;
    readonly data: Uint8Array;
}

export interface CmafTrack {
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

export declare class CmafWriter {
    constructor(options: CmafWriterOptions);
    get bufferedBytes(): number;
    get bufferedSamples(): number;
    get bufferedEvents(): number;
    createInitSegment(): Uint8Array;
    writeInitSegment(sink: Sink, signal?: AbortSignal): Promise<void>;
    addEvent(event: EventMessage): void;
    addChunk(trackId: number, chunk: EncodedPacket): void;
    addSample(sample: CmafSample): void;
    amendLastSampleDuration(trackId: number, duration: number): number | undefined;
    flush(options?: CmafFlushOptions): CmafSegment;
    flushTo(sink: Sink, options?: CmafFlushOptions, signal?: AbortSignal): Promise<CmafSegmentInfo>;
}

export interface CmafWriterOptions {
    readonly tracks: readonly CmafTrack[];
    readonly title?: string;
    readonly tags?: MediaTags;
    readonly maxBufferedBytes?: number;
    readonly maxBufferedSamples?: number;
    readonly maxBufferedEvents?: number;
    readonly sequenceNumber?: number;
}

export interface DashAdaptationSet {
    readonly id?: string;
    readonly mimeType?: string;
    readonly codecs?: string;
    readonly language?: string;
    readonly contentType?: 'video' | 'audio' | 'text';
    readonly representations: readonly DashRepresentation[];
}

export interface DashByteRange {
    readonly offset: number;
    readonly length: number;
}

export interface DashIndexRequest extends DashIndexResource {
    readonly byteRange: DashByteRange;
}

export interface DashIndexResource {
    readonly url: string;
    readonly byteRange?: DashByteRange;
}

export interface DashManifest {
    readonly type: 'static';
    readonly id?: string;
    readonly baseUrl?: string;
    readonly duration?: number;
    readonly periods: readonly DashPeriod[];
    readonly diagnostics: readonly MediaDiagnostic[];
}

export interface DashParseOptions extends DiagnosticOptions {
    readonly baseUrl?: string;
    readonly maxBytes?: number;
    readonly maxNodes?: number;
    readonly maxDepth?: number;
    readonly maxRepresentations?: number;
    readonly maxSegments?: number;
    readonly maxPlanEntries?: number;
}

export interface DashPeriod {
    readonly id?: string;
    readonly start: number;
    readonly duration?: number;
    readonly adaptationSets: readonly DashAdaptationSet[];
}

export interface DashRepresentation {
    readonly id?: string;
    readonly bandwidth?: number;
    readonly codecs?: string;
    readonly mimeType?: string;
    readonly language?: string;
    readonly contentType?: 'video' | 'audio' | 'text';
    readonly width?: number;
    readonly height?: number;
    readonly audioSamplingRate?: number;
    readonly baseUrl?: string;
    readonly periodIndex: number;
    readonly periodId?: string;
    readonly periodStart: number;
    readonly periodDuration?: number;
    readonly initialization?: DashResource;
    readonly segmentInfo: DashSegmentInfo;
    readonly segmentCount: bigint;
}

export interface DashResolveOptions extends DashParseOptions {
    readonly readIndex: (resource: DashIndexRequest, signal?: AbortSignal) => Uint8Array | Promise<Uint8Array>;
    readonly signal?: AbortSignal;
    readonly maxIndexBytes?: number;
    readonly maxIndexReferences?: number;
    readonly maxIndexRequests?: number;
}

export interface DashResource {
    readonly url: string;
    readonly byteRange?: DashByteRange;
    readonly index?: DashIndexResource;
}

export interface DashSegment extends DashResource {
    readonly number: bigint;
    readonly time: bigint;
    readonly duration: bigint;
    readonly timescale: number;
    readonly presentationTime: number;
    readonly presentationDuration: number;
    readonly periodIndex: number;
}

export interface DashSegmentInfo {
    readonly type: 'template' | 'list';
    readonly timescale: number;
    readonly presentationTimeOffset: bigint;
    readonly startNumber: bigint;
    readonly timeline: readonly DashTimelineEntry[];
    readonly media?: string;
    readonly resources?: readonly DashResource[];
    readonly sourceType?: 'segment-base';
    readonly index?: DashIndexResource;
    readonly sidx?: SidxIndex;
}

export interface DashSegmentOptions {
    readonly start?: number;
    readonly end?: number;
    readonly maxSegments?: number;
}

export interface DashTimelineEntry {
    readonly time: bigint;
    readonly duration: bigint;
    readonly repeat: bigint;
}

export type HlsAttributes = Record<string, string>;

export interface HlsByteRange {
    length: number;
    offset: number;
}

export interface HlsEncryptionOptions {
    readonly method: 'AES-128';
    readonly key: Uint8Array;
    readonly keyUri: string;
    readonly iv?: 'sequence' | Uint8Array;
    readonly keyFile?: string;
}

export interface HlsKey {
    method: string;
    uri?: string;
    iv?: string;
    keyFormat?: string;
    keyFormatVersions?: string;
}

export interface HlsLiveOptions {
    readonly targetDuration?: number;
    readonly window?: number;
    readonly playlistType?: 'live' | 'event';
    readonly playlistName?: string;
    readonly initName?: string;
    readonly segmentNamePattern?: string;
    readonly encryption?: HlsEncryptionOptions;
    readonly programDateTime?: Date | string | number;
    readonly onWarning?: (warning: MediaDiagnostic) => void;
    readonly signal?: AbortSignal;
}

export declare class HlsLivePlaylist {
    readonly initName?: string;
    readonly encryption?: ResolvedHlsEncryption;
    constructor(options?: Pick<HlsLiveOptions, 'targetDuration' | 'window' | 'playlistType' | 'encryption' | 'programDateTime' | 'onWarning'> & {
        readonly initName?: string;
    });
    get targetDuration(): number;
    get sequence(): number;
    get count(): number;
    add(name: string, duration: number): string[];
    end(): string;
    text(): string;
}

export interface HlsLiveSummary {
    readonly segments: number;
    readonly bytes: number;
    readonly duration: number;
    readonly playlist: string;
}

export interface HlsLiveUpdate {
    readonly files: readonly PackagedFile[];
    readonly playlist: string;
    readonly mediaSequence: number;
    readonly segments: number;
    readonly removed: readonly string[];
}

export interface HlsMap {
    uri: string;
    byteRange?: HlsByteRange;
    key?: HlsKey;
    keys?: HlsKey[];
}

export interface HlsMasterPlaylist extends HlsPlaylistBase {
    type: 'master';
    variants: HlsVariant[];
    renditions: HlsRendition[];
    sessionData?: HlsAttributes[];
    sessionKeys?: HlsKey[];
}

export interface HlsMediaPlaylist extends HlsPlaylistBase {
    type: 'media';
    targetDuration: number;
    mediaSequence: number;
    discontinuitySequence: number;
    segments: HlsSegment[];
    endList: boolean;
    playlistType?: 'EVENT' | 'VOD';
    iframeOnly?: boolean;
    dateRanges?: HlsAttributes[];
    partTarget?: number;
    trailingParts?: HlsPart[];
    preloadHints?: HlsAttributes[];
    serverControl?: HlsAttributes;
    renditionReports?: HlsAttributes[];
    skippedSegments?: number;
}

export interface HlsParseOptions extends DiagnosticOptions {
    baseUrl?: string;
    previousPlaylist?: HlsMediaPlaylist;
    maxPlaylistEntries?: number;
}

export interface HlsPart {
    uri: string;
    duration: number;
    independent?: boolean;
    gap?: boolean;
    byteRange?: HlsByteRange;
    sequence?: number;
    partIndex?: number;
    discontinuitySequence?: number;
    discontinuity?: boolean;
    map?: HlsMap;
    key?: HlsKey;
    keys?: HlsKey[];
    programDateTime?: string;
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

export interface HlsRendition {
    type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
    groupId: string;
    name: string;
    uri?: string;
    language?: string;
    default?: boolean;
    autoselect?: boolean;
    forced?: boolean;
    channels?: string;
    instreamId?: string;
    attributes?: HlsAttributes;
}

export interface HlsRenditionSelectionOptions {
    readonly type: HlsRendition['type'];
    readonly languages?: readonly string[];
    readonly name?: string;
    readonly forced?: boolean;
    readonly channels?: string;
}

export interface HlsSegment {
    uri: string;
    duration: number;
    title?: string;
    sequence: number;
    discontinuitySequence: number;
    discontinuity?: boolean;
    byteRange?: HlsByteRange;
    map?: HlsMap;
    key?: HlsKey;
    keys?: HlsKey[];
    programDateTime?: string;
    gap?: boolean;
    parts?: HlsPart[];
}

export declare class HlsSegmentEncryptor {
    readonly encryption: ResolvedHlsEncryption;
    constructor(encryption: ResolvedHlsEncryption);
    encrypt(data: Uint8Array, sequence: number): Promise<Uint8Array>;
}

export interface HlsVariant {
    uri: string;
    bandwidth: number;
    averageBandwidth?: number;
    codecs?: string;
    resolution?: {
        width: number;
        height: number;
    };
    frameRate?: number;
    audio?: string;
    video?: string;
    subtitles?: string;
    closedCaptions?: string;
    iframe?: boolean;
    attributes?: HlsAttributes;
}

export type Mp4ByteInput = ByteStreamInput;

export interface Mp4StreamBox {
    readonly type: string;
    readonly offset: number;
    readonly size: number;
    readonly headerSize: number;
    readonly data: Uint8Array;
}

export interface Mp4StreamIterator<T> extends AsyncIterableIterator<T> {
    readonly diagnostics: readonly MediaDiagnostic[];
    readonly suppressedWarnings: number;
}

export interface Mp4StreamOptions extends DiagnosticOptions {
    readonly signal?: AbortSignal;
    readonly maxBoxBytes?: number;
    readonly maxSegmentBytes?: number;
    readonly maxBoxes?: number;
    readonly maxInputChunkBytes?: number;
    readonly maxEmptyChunks?: number;
}

export interface PackagedFile {
    readonly kind: PackagedFileKind;
    readonly name: string;
    readonly data: Uint8Array;
    readonly representation?: string;
    readonly number?: number;
    readonly timing?: PackageSegmentTiming;
}

export interface ResolvedHlsEncryption {
    readonly key: Uint8Array;
    readonly keyUri: string;
    readonly iv?: Uint8Array;
    readonly keyFile?: string;
}

export interface SidxIndex {
    readonly version: 0 | 1;
    readonly offset: bigint;
    readonly size: number;
    readonly headerSize: number;
    readonly referenceId: number;
    readonly timescale: number;
    readonly earliestPresentationTime: bigint;
    readonly firstOffset: bigint;
    readonly references: readonly SidxReference[];
}

export interface SidxParseOptions {
    readonly offset?: bigint;
    readonly maxBytes?: number;
    readonly maxReferences?: number;
}

export interface SidxReference {
    readonly referenceType: 0 | 1;
    readonly offset: bigint;
    readonly size: number;
    readonly time: bigint;
    readonly duration: bigint;
    readonly startsWithSap: boolean;
    readonly sapType: number;
    readonly sapDeltaTime: bigint;
}

export declare function getHlsRenditions(master: HlsMasterPlaylist, variant: HlsVariant, type: HlsRendition['type']): HlsRendition[];

export declare function hlsKeyTag(encryption: ResolvedHlsEncryption): string;

export declare function iterateDashSegments(representation: DashRepresentation, options?: DashSegmentOptions): IterableIterator<DashSegment>;

export declare function iterateMp4Boxes(input: Mp4ByteInput, options?: Mp4StreamOptions): Mp4StreamIterator<Mp4StreamBox>;

export declare function packageHlsLive(segments: AsyncIterable<MediaSegment> | Iterable<MediaSegment>, options?: HlsLiveOptions): AsyncGenerator<HlsLiveUpdate, HlsLiveSummary>;

export declare function parseDashManifest(input: string | Uint8Array, options?: DashParseOptions): DashManifest;

export declare function parseHlsPlaylist(text: string, options?: HlsParseOptions): HlsPlaylist;

export declare function parseSidx(input: Uint8Array, options?: SidxParseOptions): SidxIndex;

export declare function readCmafSegments(input: Mp4ByteInput, options?: Mp4StreamOptions): Mp4StreamIterator<CmafStreamSegment>;

export declare function resolveDashManifest(input: string | Uint8Array, options: DashResolveOptions): Promise<DashManifest>;

export declare function resolveHlsEncryption(options: HlsEncryptionOptions): ResolvedHlsEncryption;

export declare function selectHlsRendition(master: HlsMasterPlaylist, variant: HlsVariant, options: HlsRenditionSelectionOptions): HlsRendition | undefined;

export declare function sequenceIv(sequence: number): Uint8Array;

export declare function serializeHlsPlaylist(playlist: HlsPlaylist): string;

// Types the exports reach without exporting them.

declare interface AttachedPicture {
    readonly data: Uint8Array;
    readonly mimeType: string;
    readonly description?: string;
    readonly type?: number;
}

declare type ByteStreamInput = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

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

declare type EventMessage = {
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

declare type FieldOrder = 'progressive' | 'tt' | 'bb' | 'tb' | 'bt';

declare interface HlsPlaylistBase {
    version?: number;
    independentSegments?: boolean;
    start?: HlsAttributes;
    baseUrl?: string;
    diagnostics?: readonly MediaDiagnostic[];
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

declare interface PackageSegmentTiming {
    readonly timescale: number;
    readonly time: bigint;
    readonly duration: bigint;
}

declare type PackagedFileKind = 'init' | 'segment' | 'playlist' | 'manifest' | 'key';

declare interface Sink {
    readonly signal?: AbortSignal;
    write(data: Uint8Array): void;
    readonly copiesWrites?: boolean;
    close(): Promise<void>;
    patchAt?(offset: number, data: Uint8Array): void;
    abort?(reason?: unknown): Promise<void>;
    drain?(): Promise<void>;
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
