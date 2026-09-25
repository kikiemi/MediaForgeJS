export declare function readFlacMetaBlocks(file: Blob, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>[]>;
export declare function injectFlacMetaBlocks(encoded: Blob, blocks: Uint8Array<ArrayBuffer>[], signal?: AbortSignal): Promise<Blob>;
export declare function readId3v2Prefix(file: Blob, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null>;
