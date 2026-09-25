import type { FFmpegOperation } from './ffmpeg-process.js';
export interface FFmpegDirectoryFile {
    /** Relative basename within directory. */
    readonly name: string;
    readonly bytes: number;
}
export interface FFmpegDirectoryResult {
    readonly directory: string;
    readonly manifestPath: string;
    readonly files: readonly FFmpegDirectoryFile[];
    readonly bytesWritten: number;
}
export interface DirectoryConfig {
    readonly format: 'hls' | 'dash';
    readonly segmentDuration: number;
    readonly hlsSegmentType: 'mpegts' | 'fmp4';
    readonly maxFiles: number;
    readonly maxOutputBytes: number;
}
export interface DirectoryStat {
    readonly size: number;
    readonly dev: number;
    readonly ino: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}
interface DirectoryHandle {
    read(): Promise<{
        name: string;
    } | null>;
    close(): Promise<void>;
}
export interface DirectoryFiles {
    mkdir(path: string, options: {
        mode: number;
    }): Promise<unknown>;
    mkdtemp(prefix: string): Promise<string>;
    lstat(path: string): Promise<DirectoryStat>;
    opendir(path: string): Promise<DirectoryHandle>;
    readFile(path: string): Promise<Uint8Array>;
    rename(source: string, destination: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rm(path: string, options: {
        recursive: true;
        force: true;
    }): Promise<void>;
}
export interface DirectoryPaths {
    resolve(path: string): string;
    join(...paths: string[]): string;
    dirname(path: string): string;
}
export declare function directoryMuxerArguments(config: DirectoryConfig): string[];
/** Reserves a new empty destination; callers must not mutate it or its parent until completion. */
export declare function withFFmpegDirectory(destination: string, io: {
    fs: DirectoryFiles;
    path: DirectoryPaths;
    platform: string;
}, config: DirectoryConfig, operation: FFmpegOperation, generate: (stage: string) => Promise<void>): Promise<FFmpegDirectoryResult>;
export {};
