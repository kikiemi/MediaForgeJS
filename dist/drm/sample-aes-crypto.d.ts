export declare const SAMPLE_AES_MAX_BYTES: number;
export declare function sampleAesBytes(value: Uint8Array, name: string, exactLength?: number): Uint8Array<ArrayBuffer>;
export declare function sampleAesAbort(signal?: AbortSignal): void;
export declare function sampleAesYield(signal?: AbortSignal): Promise<void>;
export declare class SampleAesCrypto {
    private readonly subtle;
    private readonly key;
    private readonly iv;
    private readonly signal?;
    private samples;
    private constructor();
    static create(keyBytes: Uint8Array, ivBytes: Uint8Array, signal?: AbortSignal): Promise<SampleAesCrypto>;
    consumeSample(): void;
    decrypt(blocks: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
}
export declare function adtsFrameLength(data: Uint8Array, offset: number): number;
export declare function decodeAacFrame(data: Uint8Array<ArrayBuffer>, crypto: SampleAesCrypto): Promise<void>;
export declare function decodeAvcNal(data: Uint8Array<ArrayBuffer>, crypto: SampleAesCrypto, signal?: AbortSignal, removed?: (offset: number) => void): Promise<Uint8Array<ArrayBuffer>>;
