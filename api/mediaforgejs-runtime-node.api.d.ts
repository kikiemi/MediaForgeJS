// The public API of 'mediaforgejs/runtime/node', from its built declarations (npm run api:report).

export declare class FileSink extends PositionedFileSink {
    static open(path: string | URL, options?: Omit<FileSinkOptions, 'closeHandle'>): Promise<FileSink>;
    static from(handle: NodeFileHandle, options?: FileSinkOptions): Promise<FileSink>;
}

export interface FileSinkOptions {
    readonly closeHandle?: boolean;
    readonly highWaterMark?: number;
}

export declare class FileSource extends PositionedFileSource {
    static open(path: string | URL, options?: Omit<FileSourceOptions, 'closeHandle'>): Promise<FileSource>;
    static from(handle: NodeFileHandle, options?: FileSourceOptions): Promise<FileSource>;
}

export interface FileSourceOptions {
    readonly closeHandle?: boolean;
    readonly signal?: AbortSignal;
}

export interface NodeFileHandle {
    stat(): Promise<{
        size: number;
        isFile(): boolean;
    }>;
    read(bytes: Uint8Array, offset: number, length: number, position: number): Promise<{
        bytesRead: number;
    }>;
    write(bytes: Uint8Array, offset: number, length: number, position: number): Promise<{
        bytesWritten: number;
    }>;
    truncate(length: number): Promise<void>;
    close(): Promise<void>;
}

export interface NodeReadable extends AsyncIterable<Uint8Array> {
    destroy(error?: Error): unknown;
}

export interface NodeWritable {
    write(bytes: Uint8Array): boolean;
    end(): unknown;
    destroy(error?: Error): unknown;
}

export interface PackageDirectoryFile {
    readonly name: string;
    readonly bytes: number;
}

export interface PackageDirectoryOptions {
    readonly overwrite?: boolean;
    readonly signal?: AbortSignal;
}

export interface PackageDirectoryResult {
    readonly directory: string;
    readonly files: readonly PackageDirectoryFile[];
    readonly bytesWritten: number;
}

export interface PackageInputFile {
    readonly name: string;
    readonly data: Uint8Array;
}

export declare function nodeReadableSource(input: NodeReadable, options: StreamSourceOptions): Promise<StreamSource>;

export declare function nodeWritableSink(input: NodeWritable, options?: {
    highWaterMark?: number;
}): Promise<WritableStreamSink>;

export declare function writePackageToDirectory(files: AsyncIterable<PackageInputFile> | Iterable<PackageInputFile>, directory: string, options?: PackageDirectoryOptions): Promise<PackageDirectoryResult>;

// Types the exports reach without exporting them.

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

declare class StreamSource implements Source {
    readonly size: number;
    static from(input: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, options: StreamSourceOptions): Promise<StreamSource>;
    read(offset: number, length: number): Promise<Uint8Array>;
}

declare interface StreamSourceOptions {
    readonly retention: 'memory';
    readonly maxBytes: number;
    readonly maxEmptyChunks?: number;
    readonly signal?: AbortSignal;
}

declare class WritableStreamSink implements Sink {
    constructor(stream: WritableStream<Uint8Array>, options?: {
        highWaterMark?: number;
    });
    write(data: Uint8Array): void;
    drain(): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
    get done(): Promise<void>;
}
