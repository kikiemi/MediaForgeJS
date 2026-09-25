import type { Source } from '../types/io.js';
export interface BufferSourceOptions {
    /** Snapshot input by default; false borrows storage that must remain stable while in use. */
    readonly copy?: boolean;
}
/** Fixed byte interval over a stable Source; wrapping reads no data, and reads return independent copies. */
export declare class RangeSource implements Source {
    readonly size: number;
    private readonly root;
    private static readonly readRange;
    constructor(source: Source, offset?: number, length?: number);
    read(offset: number, length: number): Promise<Uint8Array>;
}
/** Random-access source over the exact input byte range; every read returns an independent copy. */
export declare class BufferSource implements Source {
    private readonly bytes;
    readonly size: number;
    constructor(input: ArrayBuffer | ArrayBufferView, options?: BufferSourceOptions);
    read(offset: number, length: number): Promise<Uint8Array>;
}
/** Source over a stable Blob/File; small reads share up to two 4 MiB windows. */
export declare class BlobSource implements Source {
    private readonly blob;
    private readonly slice;
    readonly size: number;
    private static readonly WINDOW;
    private windows;
    private pending;
    constructor(blob: Blob);
    read(offset: number, length: number): Promise<Uint8Array>;
    private readWindow;
    private readBytes;
}
