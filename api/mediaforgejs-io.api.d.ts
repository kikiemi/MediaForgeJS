// The public API of 'mediaforgejs/io', from its built declarations (npm run api:report).

export declare class BlobSource implements Source {
    readonly size: number;
    constructor(blob: Blob);
    read(offset: number, length: number): Promise<Uint8Array>;
}

export declare class BufferSource implements Source {
    readonly size: number;
    constructor(input: ArrayBuffer | ArrayBufferView, options?: BufferSourceOptions);
    read(offset: number, length: number): Promise<Uint8Array>;
    readInto(offset: number, target: Uint8Array): Promise<void>;
}

export interface BufferSourceOptions {
    readonly copy?: boolean;
}

export declare class CachedSource implements Source {
    readonly size: number;
    static readonly DIRECT_READ_BYTES: number;
    constructor(source: Source, options?: CachedSourceOptions);
    get cachedBytes(): number;
    clear(): void;
    read(offset: number, length: number): Promise<Uint8Array>;
}

export interface CachedSourceOptions {
    readonly pageBytes?: number;
    readonly maxBytes?: number;
}

export declare class ConcatSource extends SourceRope {
    constructor(sources: readonly Source[]);
    static fromRanges(source: Source, ranges: readonly SourceRange[]): ConcatSource;
}

export declare class HttpSource implements Source {
    static open(url: string | URL, options?: HttpSourceOptions): Promise<HttpSource>;
    get size(): number;
    get warnings(): readonly MediaDiagnostic[];
    read(offset: number, length: number): Promise<Uint8Array>;
    close(): Promise<void>;
}

export interface HttpSourceOptions extends DiagnosticOptions {
    readonly fetch?: typeof fetch;
    readonly headers?: HeadersInit;
    readonly signal?: AbortSignal;
    readonly requestTimeoutMs?: number;
    readonly maxResponseBytes?: number;
    readonly fallback?: 'error' | 'buffer';
    readonly maxBytes?: number;
    readonly requireValidator?: boolean;
}

export declare class MemorySink implements Sink {
    constructor(options?: MemorySinkOptions);
    write(data: Uint8Array): void;
    get size(): number;
    close(): Promise<void>;
    patchAt(offset: number, data: Uint8Array): void;
    toBlob(mimeType: string): Blob;
    toUint8Array(): Uint8Array<ArrayBuffer>;
}

export interface MemorySinkOptions {
    maxBytes?: number;
    blobPartBytes?: number;
}

export interface PositionedWriter {
    write(data: {
        type: 'write';
        position: number;
        data: ArrayBuffer;
    }): Promise<void>;
    close(): Promise<void>;
    abort?(reason?: unknown): Promise<void>;
}

export declare class RangeSource extends SourceRope {
    constructor(source: Source, offset?: number, length?: number);
}

export declare class ReadableStreamSink implements Sink {
    readonly stream: ReadableStream<Uint8Array>;
    get signal(): AbortSignal;
    constructor(options?: ReadableStreamSinkOptions);
    write(data: Uint8Array): void;
    drain(): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
}

export interface ReadableStreamSinkOptions {
    readonly highWaterMark?: number;
    readonly maxBytes?: number;
}

export interface RetryFetchOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly maxRetries?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
}

export interface Sink {
    readonly signal?: AbortSignal;
    write(data: Uint8Array): void;
    readonly copiesWrites?: boolean;
    close(): Promise<void>;
    patchAt?(offset: number, data: Uint8Array): void;
    abort?(reason?: unknown): Promise<void>;
    drain?(): Promise<void>;
}

export interface Source {
    read(offset: number, length: number): Promise<Uint8Array>;
    readonly size: number;
}

export interface SourceRange {
    readonly offset: number;
    readonly length?: number;
}

export interface SourceStreamOptions {
    readonly chunkBytes?: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (bytesRead: number, totalBytes: number) => void | PromiseLike<void>;
}

export declare class StreamSink implements Sink {
    constructor(writer: PositionedWriter, options?: {
        highWaterMark?: number;
    });
    write(data: Uint8Array): void;
    patchAt(offset: number, data: Uint8Array): void;
    abort(reason?: unknown): Promise<void>;
    drain(): Promise<void>;
    close(): Promise<void>;
    get done(): Promise<void>;
    static fromPicker(suggestedName: string): Promise<StreamSink>;
    static fromOPFS(name: string): Promise<StreamSink>;
}

export declare class StreamSource implements Source {
    readonly size: number;
    static from(input: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, options: StreamSourceOptions): Promise<StreamSource>;
    read(offset: number, length: number): Promise<Uint8Array>;
}

export interface StreamSourceOptions {
    readonly retention: 'memory';
    readonly maxBytes: number;
    readonly maxEmptyChunks?: number;
    readonly signal?: AbortSignal;
}

export declare class WritableStreamSink implements Sink {
    constructor(stream: WritableStream<Uint8Array>, options?: {
        highWaterMark?: number;
    });
    write(data: Uint8Array): void;
    drain(): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
    get done(): Promise<void>;
}

export declare function createRetryFetch(options?: RetryFetchOptions): typeof globalThis.fetch;

export declare function sourceToReadableStream(source: Source, options?: SourceStreamOptions): ReadableStream<Uint8Array>;

// Types the exports reach without exporting them.

declare interface DiagnosticOptions {
    readonly validation?: ValidationMode;
    readonly metadataPolicy?: MetadataPolicy;
    readonly onWarning?: (diagnostic: MediaDiagnostic) => void;
    readonly maxWarnings?: number;
}

declare interface MediaDiagnostic {
    readonly code: string;
    readonly message: string;
    readonly severity: 'warning';
    readonly format?: string;
    readonly offset?: number;
    readonly trackId?: number;
}

declare type MetadataPolicy = 'warn' | 'error';

declare interface SourceBranch {
    readonly left: SourceNode;
    readonly right: SourceNode;
    readonly size: number;
    readonly height: number;
}

declare interface SourceLeaf {
    readonly source: Source;
    readonly read: Source['read'];
    readonly offset: number;
    readonly size: number;
    readonly height: 1;
}

declare type SourceNode = SourceLeaf | SourceBranch;

declare class SourceRope implements Source {
    readonly size: number;
    constructor(tree: SourceNode | null, name: string);
    read(offset: number, length: number): Promise<Uint8Array>;
    readInto(offset: number, target: Uint8Array): Promise<void>;
    static treeOf(source: Source, read: Source['read'], size: number): SourceNode | null | undefined;
}

declare type ValidationMode = 'strict' | 'compatible';
