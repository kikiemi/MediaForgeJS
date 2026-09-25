import type { HlsEncryptionHandler } from '../streaming/hls-encryption.js';
/** Decrypts one complete ADTS frame with a 16-byte key and IV. Returns owned bytes; inputs remain unchanged. */
export declare function decryptSampleAesAac(frame: Uint8Array, key: Uint8Array, iv: Uint8Array, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
/** Decrypts one AVC NAL without its start code, returning the original emulation-protected bytes. Inputs remain unchanged. */
export declare function decryptSampleAesAvc(nal: Uint8Array, key: Uint8Array, iv: Uint8Array, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
/** Software identity SAMPLE-AES for complete AVC/AAC MPEG-TS and packed ADTS segments up to 64 MiB and 100000 samples. No keys are retained. */
export declare function createSampleAesHandler(): HlsEncryptionHandler;
