import type { EmeControllerOptions, EmeLicenseCallback } from '../drm/eme-controller.js';
import type { HlsPartData } from './hls-client.js';
import type { HlsEncryptionHandler } from './hls-encryption.js';
import type { HlsPlaybackOptions } from './hls-playback.js';
import type { HlsKey } from './hls-playlist.js';
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
    /** Overrides the known Widevine, PlayReady or FairPlay KEYFORMAT mapping. */
    readonly keyFormats?: readonly string[];
    /** If omitted, AVC/AAC capabilities are inferred from the playback MIME or variant. */
    readonly configurations?: readonly MediaKeySystemConfiguration[];
    readonly license: EmeLicenseCallback;
    readonly serverCertificate?: Uint8Array;
    /** Overrides playlist init-data decoding; undefined waits for the browser encrypted event. */
    readonly getInitData?: (request: HlsDrmInitDataRequest) => HlsDrmInitData | undefined | PromiseLike<HlsDrmInitData | undefined>;
}
export interface HlsDrmOptions {
    /** Ordered preference; capability rejection tries the next matching system. */
    readonly keySystems: readonly HlsDrmKeySystem[];
}
export type HlsDrmSessionOptions = Pick<EmeControllerOptions, 'attachTimeoutMs' | 'licenseTimeoutMs' | 'maxSessions' | 'maxInitDataBytes' | 'maxLicenseBytes' | 'maxPendingMessages' | 'onKeyStatusesChange'>;
export interface HlsDrmPlaybackOptions extends HlsPlaybackOptions, HlsDrmOptions {
    readonly eme?: HlsDrmSessionOptions;
    /** Maximum continuous browser waitingforkey interval; default 30000 ms. */
    readonly keyTimeoutMs?: number;
}
/** Opt-in ciphertext delivery for fMP4 CDM playback. Never fetches a DRM key URI. */
export declare function createHlsDrmHandler(options: HlsDrmOptions): HlsEncryptionHandler;
/** Attaches a configured CDM before protected appends; completion includes playHls's actual ended event. */
export declare function playHlsWithDrm(media: HTMLMediaElement, units: AsyncIterable<HlsPartData>, options: HlsDrmPlaybackOptions): Promise<void>;
