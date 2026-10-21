// The public API of 'mediaforgejs/runtime/deno', from its built declarations (npm run api:report).

export interface DenoFileHandle {
    stat(): Promise<{
        size: number;
        isFile: boolean;
    }>;
    seek(offset: number, whence: number): Promise<number>;
    read(bytes: Uint8Array): Promise<number | null>;
    write(bytes: Uint8Array): Promise<number>;
    truncate(length: number): Promise<void>;
    close(): void;
}

export declare class FileSink extends PositionedFileSink {
    static open(path: string | URL, options?: Omit<FileSinkOptions, 'closeHandle'>): Promise<FileSink>;
    static from(handle: DenoFileHandle, options?: FileSinkOptions): Promise<FileSink>;
}

export interface FileSinkOptions {
    readonly closeHandle?: boolean;
    readonly highWaterMark?: number;
}

export declare class FileSource extends PositionedFileSource {
    static open(path: string | URL, options?: Omit<FileSourceOptions, 'closeHandle'>): Promise<FileSource>;
    static from(handle: DenoFileHandle, options?: FileSourceOptions): Promise<FileSource>;
}

export interface FileSourceOptions {
    readonly closeHandle?: boolean;
    readonly signal?: AbortSignal;
}

export declare class HttpSource implements Source {
    static open(url: string | URL, options?: HttpSourceOptions): Promise<HttpSource>;
    get size(): number;
    get warnings(): readonly MediaDiagnostic[];
    read(offset: number, length: number): Promise<Uint8Array>;
    close(): Promise<void>;
}

export declare class StreamSource implements Source {
    readonly size: number;
    static from(input: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, options: StreamSourceOptions): Promise<StreamSource>;
    read(offset: number, length: number): Promise<Uint8Array>;
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

export declare function sourceToReadableStream(source: Source, options?: SourceStreamOptions): ReadableStream<Uint8Array>;

// Types the exports reach without exporting them.

declare interface DiagnosticOptions {
    readonly validation?: ValidationMode;
    readonly metadataPolicy?: MetadataPolicy;
    readonly onWarning?: (diagnostic: MediaDiagnostic) => void;
    readonly maxWarnings?: number;
}

declare interface HttpSourceOptions extends DiagnosticOptions {
    readonly fetch?: typeof fetch;
    readonly headers?: HeadersInit;
    readonly signal?: AbortSignal;
    readonly requestTimeoutMs?: number;
    readonly maxResponseBytes?: number;
    readonly fallback?: 'error' | 'buffer';
    readonly maxBytes?: number;
    readonly requireValidator?: boolean;
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

declare interface PositionedFileReader {
    readAt(bytes: Uint8Array, position: number, signal: AbortSignal): Promise<number>;
    close(): Promise<void>;
}

declare class PositionedFileSink implements Sink {
    constructor(writer: PositionedFileWriter, own: boolean, options?: FileSinkOptions);
    write(bytes: Uint8Array): void;
    patchAt(offset: number, bytes: Uint8Array): void;
    drain(): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
    get done(): Promise<void>;
}

declare class PositionedFileSource implements Source {
    readonly size: number;
    constructor(reader: PositionedFileReader, size: number, own: boolean, signal?: AbortSignal);
    read(offset: number, length: number): Promise<Uint8Array>;
    readInto(offset: number, bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
}

declare interface PositionedFileWriter {
    writeAt(bytes: Uint8Array, position: number, signal: AbortSignal): Promise<number>;
    close(): Promise<void>;
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

declare interface SourceStreamOptions {
    readonly chunkBytes?: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (bytesRead: number, totalBytes: number) => void | PromiseLike<void>;
}

declare interface StreamSourceOptions {
    readonly retention: 'memory';
    readonly maxBytes: number;
    readonly maxEmptyChunks?: number;
    readonly signal?: AbortSignal;
}

declare type ValidationMode = 'strict' | 'compatible';
