import { StreamSource, type StreamSourceOptions } from '../io/stream-source.js';
import { WritableStreamSink } from '../io/writable-stream-sink.js';
import { PositionedFileSource, PositionedFileSink, type FileSourceOptions, type FileSinkOptions } from './file-io.js';
export type { FileSourceOptions, FileSinkOptions } from './file-io.js';
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
/** Node/Bun positioned file input. The caller must not modify the file while it is in use. */
export declare class FileSource extends PositionedFileSource {
    static open(path: string | URL, options?: Omit<FileSourceOptions, 'closeHandle'>): Promise<FileSource>;
    static from(handle: NodeFileHandle, options?: FileSourceOptions): Promise<FileSource>;
}
/** Node/Bun positioned output. from() truncates the file and requires a handle opened without append mode. */
export declare class FileSink extends PositionedFileSink {
    static open(path: string | URL, options?: Omit<FileSinkOptions, 'closeHandle'>): Promise<FileSink>;
    static from(handle: NodeFileHandle, options?: FileSinkOptions): Promise<FileSink>;
}
export interface NodeReadable extends AsyncIterable<Uint8Array> {
    destroy(error?: Error): unknown;
}
export interface NodeWritable {
    write(bytes: Uint8Array): boolean;
    end(): unknown;
    destroy(error?: Error): unknown;
}
/** Consumes a Node byte stream; abort/error destroys it. All input is retained within maxBytes. */
export declare function nodeReadableSource(input: NodeReadable, options: StreamSourceOptions): Promise<StreamSource>;
/** Owns stream completion/cancellation; await drain() to bound queued output. */
export declare function nodeWritableSink(input: NodeWritable, options?: {
    highWaterMark?: number;
}): Promise<WritableStreamSink>;
