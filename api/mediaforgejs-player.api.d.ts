// The public API of 'mediaforgejs-player', from its built declarations (npm run api:report).

export declare class AdaptiveQualityController {
    constructor(options?: AdaptiveQualityOptions);
    get bandwidthEstimate(): number | undefined;
    addSample(byteLength: number, elapsedMs: number): void;
    selectBandwidth(bandwidths: readonly number[], currentBandwidth?: number): number;
}

export interface AdaptiveQualityOptions {
    initialBandwidth?: number;
    bandwidthSafetyFactor?: number;
    upSwitchSegments?: number;
}

export declare class EmeController {
    readonly keySystem: string;
    readonly done: Promise<void>;
    static isSupported(): boolean;
    static attach(element: HTMLMediaElement, options: EmeControllerOptions): Promise<EmeController>;
    get failure(): MediaForgeError | null;
    get sessionCount(): number;
    get configuration(): MediaKeySystemConfiguration;
    addSession(initDataType: string, initData: Uint8Array): Promise<MediaKeySession>;
    close(): Promise<void>;
}

export interface EmeControllerOptions {
    readonly keySystem: string;
    readonly configurations: readonly MediaKeySystemConfiguration[];
    readonly license: EmeLicenseCallback;
    readonly signal?: AbortSignal;
    readonly keySystemAccess?: MediaKeySystemAccess;
    readonly serverCertificate?: Uint8Array;
    readonly attachTimeoutMs?: number;
    readonly maxSessions?: number;
    readonly maxInitDataBytes?: number;
    readonly maxLicenseBytes?: number;
    readonly maxPendingMessages?: number;
    readonly licenseTimeoutMs?: number;
    readonly onError?: (error: MediaForgeError) => void;
    readonly onKeyStatusesChange?: (change: EmeKeyStatusesChange) => void;
}

export interface EmeKeyStatus {
    readonly keyId: Uint8Array;
    readonly status: MediaKeyStatus;
}

export interface EmeKeyStatusesChange {
    readonly keySystem: string;
    readonly sessionId: string;
    readonly statuses: readonly EmeKeyStatus[];
}

export type EmeLicenseCallback = (request: EmeLicenseRequest) => Uint8Array | PromiseLike<Uint8Array>;

export interface EmeLicenseRequest {
    readonly keySystem: string;
    readonly message: Uint8Array;
    readonly messageType: MediaKeyMessageType;
    readonly sessionId: string;
    readonly signal: AbortSignal;
}

export interface HlsAdaptiveOptions extends AdaptiveQualityOptions {
    onVariantChange?: (event: HlsVariantChange) => void | PromiseLike<void>;
    switchGroups?: boolean;
    switchCodecs?: boolean;
}

export declare class HlsClient {
    constructor(options?: HlsClientOptions);
    get variant(): HlsVariant | undefined;
    get playlist(): HlsPlaylist | undefined;
    get diagnostics(): readonly MediaDiagnostic[];
    load(url: string, options?: {
        signal?: AbortSignal;
    }): Promise<HlsPlaylist>;
    refresh(options?: {
        signal?: AbortSignal;
    }): Promise<HlsPlaylist>;
    close(reason?: unknown): void;
    segments(options?: HlsSegmentOptions): AsyncIterableIterator<HlsSegmentData>;
    parts(options?: HlsPartOptions): AsyncIterableIterator<HlsPartData>;
}

export interface HlsClientOptions extends WarningOptions {
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    maxPlaylistBytes?: number;
    maxSegmentBytes?: number;
    encryptionHandlers?: readonly HlsEncryptionHandler[];
    keyLoader?: HlsKeyLoader;
    maxKeyBytes?: number;
    maxCachedKeys?: number;
    maxPlaylistEntries?: number;
    refreshIntervalMs?: number;
    requestTimeoutMs?: number;
    adaptive?: boolean | HlsAdaptiveOptions;
    playable?: (variant: HlsVariant) => boolean;
}

export interface HlsDecryptionRequest extends HlsEncryptionContext {
    readonly data: Uint8Array;
    readonly loadKey: () => Promise<Uint8Array>;
}

export interface HlsDrmInitData {
    readonly type: string;
    readonly data: Uint8Array;
}

export interface HlsDrmInitDataRequest {
    readonly keySystem: string;
    readonly key: Readonly<HlsKey>;
    readonly signal: AbortSignal;
}

export interface HlsDrmKeySystem {
    readonly keySystem: string;
    readonly keyFormats?: readonly string[];
    readonly configurations?: readonly MediaKeySystemConfiguration[];
    readonly license: EmeLicenseCallback;
    readonly serverCertificate?: Uint8Array;
    readonly getInitData?: (request: HlsDrmInitDataRequest) => HlsDrmInitData | undefined | PromiseLike<HlsDrmInitData | undefined>;
}

export interface HlsDrmOptions {
    readonly keySystems: readonly HlsDrmKeySystem[];
}

export interface HlsDrmPlaybackOptions extends HlsPlaybackOptions, HlsDrmOptions {
    readonly eme?: HlsDrmSessionOptions;
    readonly keyTimeoutMs?: number;
}

export type HlsDrmSessionOptions = Pick<EmeControllerOptions, 'attachTimeoutMs' | 'licenseTimeoutMs' | 'maxSessions' | 'maxInitDataBytes' | 'maxLicenseBytes' | 'maxPendingMessages' | 'onKeyStatusesChange'>;

export interface HlsEncryptionContext {
    readonly key: Readonly<HlsKey>;
    readonly kind: 'map' | 'segment' | 'part';
    readonly sequence: number;
    readonly partIndex?: number;
    readonly uri: string;
    readonly map?: HlsMap;
    readonly signal: AbortSignal;
}

export interface HlsEncryptionHandler {
    supports(context: HlsEncryptionContext): boolean;
    decrypt(request: HlsDecryptionRequest): Uint8Array | PromiseLike<Uint8Array>;
    readonly retainsEncryption?: boolean;
}

export type HlsKeyLoader = (request: HlsEncryptionContext) => Uint8Array | PromiseLike<Uint8Array>;

export type HlsPartData = {
    type: 'part';
    part: HlsPart;
    sequence: number;
    partIndex: number;
    discontinuitySequence: number;
    variant?: HlsVariant;
    data: Uint8Array;
    initData?: Uint8Array;
    encryption?: HlsKey;
} | ({
    type: 'segment';
} & HlsSegmentData);

export type HlsPartOptions = HlsSegmentOptions;

export interface HlsPlaybackOptions {
    mimeType?: string;
    autoplay?: boolean;
    bufferAhead?: number;
    bufferBehind?: number;
    operationTimeoutMs?: number;
    signal?: AbortSignal;
}

export interface HlsSegmentData {
    segment: HlsSegment;
    data: Uint8Array;
    variant?: HlsVariant;
    initData?: Uint8Array;
    encryption?: HlsKey;
}

export interface HlsSegmentOptions {
    live?: boolean;
    startSequence?: number;
    signal?: AbortSignal;
    maxRefreshes?: number;
    maxIdleRefreshes?: number;
}

export interface HlsVariantChange {
    previous?: HlsVariant;
    variant: HlsVariant;
    sequence: number;
    partIndex?: number;
    bandwidthEstimate?: number;
    reason: 'initial' | 'up' | 'down';
}

export interface HttpLicenseOptions {
    readonly url: string | URL;
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: HeadersInit;
    readonly credentials?: RequestCredentials;
    readonly maxResponseBytes?: number;
    readonly timeoutMs?: number;
}

export type PlayDrmOptions = Omit<HlsDrmPlaybackOptions, keyof HlsPlaybackOptions>;

export declare function createClearKeyLicense(keys: Readonly<Record<string, string>>): EmeLicenseCallback;

export declare function createHlsDrmHandler(options: HlsDrmOptions): HlsEncryptionHandler;

export declare function createHttpLicenseCallback(options: HttpLicenseOptions): EmeLicenseCallback;

export declare function createSampleAesHandler(): HlsEncryptionHandler;

export declare function decryptSampleAesAac(frame: Uint8Array, key: Uint8Array, iv: Uint8Array, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;

export declare function decryptSampleAesAvc(nal: Uint8Array, key: Uint8Array, iv: Uint8Array, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;

export declare function playHls(media: HTMLMediaElement, units: AsyncIterable<HlsPartData>, options?: HlsPlaybackOptions): Promise<void>;

export declare function playHlsWithDrm(media: HTMLMediaElement, units: AsyncIterable<HlsPartData>, options: HlsDrmPlaybackOptions): Promise<void>;

export declare const player: MediaForgePlugin;

// Types the exports reach without exporting them.

declare type WarningOptions = Pick<HlsParseOptions, 'validation' | 'metadataPolicy' | 'onWarning' | 'maxWarnings'>;
