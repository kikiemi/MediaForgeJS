export declare class CodecLifetime {
    private readonly signal?;
    private readonly stoppedError;
    private failure;
    private stopped;
    private listening;
    private readonly waiters;
    private readonly onAbort;
    constructor(signal?: AbortSignal | undefined, stoppedError?: Error);
    get acceptingOutput(): boolean;
    record(caught: unknown): Error;
    check(): void;
    waitFor<T>(pending: PromiseLike<T>): Promise<T>;
    stop(): void;
    private notify;
}
