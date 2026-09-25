import type { Source, Sink } from '../types/io.js';
export interface FileSourceOptions {
    /** from() borrows the handle by default; open() always owns it. */
    readonly closeHandle?: boolean;
    readonly signal?: AbortSignal;
}
export interface FileSinkOptions {
    /** from() borrows the handle by default; open() always owns it. */
    readonly closeHandle?: boolean;
    /** Queued write bytes before drain() blocks; defaults to 1 MiB. */
    readonly highWaterMark?: number;
}
export interface PositionedFileReader {
    readAt(bytes: Uint8Array, position: number, signal: AbortSignal): Promise<number>;
    close(): Promise<void>;
}
export interface PositionedFileWriter {
    writeAt(bytes: Uint8Array, position: number, signal: AbortSignal): Promise<number>;
    close(): Promise<void>;
}
export declare function ownsHandle(options: FileSourceOptions | FileSinkOptions): boolean;
export declare function fileSourceSignal(options: FileSourceOptions): AbortSignal | undefined;
export declare function validateFileSize(size: number): void;
export declare function fileHighWaterMark(value: number | undefined): number;
/** Bounded positioned reads over a stable file; close interrupts callers and releases an owned handle. */
export declare class PositionedFileSource implements Source {
    private readonly reader;
    readonly size: number;
    private readonly own;
    private closed;
    private closePromise;
    private readonly controller;
    private readonly detach;
    constructor(reader: PositionedFileReader, size: number, own: boolean, signal?: AbortSignal);
    read(offset: number, length: number): Promise<Uint8Array>;
    private readPart;
    close(): Promise<void>;
}
/** Positioned append/patch output; use drain() to bound queued bytes. */
export declare class PositionedFileSink implements Sink {
    private readonly sink;
    constructor(writer: PositionedFileWriter, own: boolean, options?: FileSinkOptions);
    write(bytes: Uint8Array): void;
    patchAt(offset: number, bytes: Uint8Array): void;
    drain(): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
    get done(): Promise<void>;
}
