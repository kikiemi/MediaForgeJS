export interface ProcessOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}
export declare function formatError(message: string): never;
export declare function integer(value: number | undefined, fallback: number, name: string, min?: number, max?: number): number;
export declare function processOptions(options: ProcessOptions): Required<Pick<ProcessOptions, 'timeoutMs'>> & ProcessOptions;
/** One operation owns its process, timers and cancellation; borrowed I/O remains caller-owned. */
export declare class FFmpegOperation {
    private readonly controller;
    private readonly removers;
    private readonly timer;
    private failed;
    private failure;
    readonly signal: AbortSignal;
    constructor(options: ReturnType<typeof processOptions>, extraSignal?: AbortSignal);
    fail(error: unknown): void;
    check(): void;
    wait<T>(pending: PromiseLike<T>): Promise<T>;
    dispose(): void;
}
/** Starts a trusted host executable with literal arguments, then reaps it before returning. */
export declare function runFFmpegProcess(executable: string, args: string[], operation: FFmpegOperation, output: (bytes: Uint8Array) => Promise<void>, workingDirectory?: string): Promise<void>;
export declare function captureFFmpegProcess(executable: string, args: string[], operation: FFmpegOperation, maxBytes: number): Promise<string>;
