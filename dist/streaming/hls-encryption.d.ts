import type { HlsKey, HlsMap } from './hls-playlist.js';
export interface HlsEncryptionContext {
    readonly key: Readonly<HlsKey>;
    readonly kind: 'map' | 'segment' | 'part';
    readonly sequence: number;
    readonly partIndex?: number;
    readonly uri: string;
    readonly map?: HlsMap;
    readonly signal: AbortSignal;
}
export interface HlsDecryptionRequest extends HlsEncryptionContext {
    /** Owned resource bytes; handlers may modify and return this array. */
    readonly data: Uint8Array;
    /** Returns a separate copy of the bounded, cached key bytes. */
    readonly loadKey: () => Promise<Uint8Array>;
}
export type HlsKeyLoader = (request: HlsEncryptionContext) => Uint8Array | PromiseLike<Uint8Array>;
export interface HlsEncryptionHandler {
    supports(context: HlsEncryptionContext): boolean;
    decrypt(request: HlsDecryptionRequest): Uint8Array | PromiseLike<Uint8Array>;
    /** True for CDM passthrough; yielded units retain their selected encryption metadata. */
    readonly retainsEncryption?: boolean;
}
