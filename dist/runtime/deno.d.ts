import { PositionedFileSource, PositionedFileSink, type FileSourceOptions, type FileSinkOptions } from './file-io.js';
export type { FileSourceOptions, FileSinkOptions } from './file-io.js';
export { HttpSource } from '../io/http-source.js';
export { StreamSource } from '../io/stream-source.js';
export { WritableStreamSink } from '../io/writable-stream-sink.js';
export { sourceToReadableStream } from '../io/source-stream.js';
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
/** Deno file reads serialize seek/read pairs; do not share the handle with another reader. */
export declare class FileSource extends PositionedFileSource {
    static open(path: string | URL, options?: Omit<FileSourceOptions, 'closeHandle'>): Promise<FileSource>;
    static from(handle: DenoFileHandle, options?: FileSourceOptions): Promise<FileSource>;
}
/** from() truncates and borrows a Deno file; writes are serialized with positioned seek/write pairs. */
export declare class FileSink extends PositionedFileSink {
    static open(path: string | URL, options?: Omit<FileSinkOptions, 'closeHandle'>): Promise<FileSink>;
    static from(handle: DenoFileHandle, options?: FileSinkOptions): Promise<FileSink>;
}
