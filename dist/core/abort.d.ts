export declare function assertAbortSignal(signal: AbortSignal | undefined): void;
/** Await an asynchronous browser operation without letting a stalled promise hide cancellation. */
export declare function awaitWithAbort<T>(pending: PromiseLike<T>, signal?: AbortSignal): Promise<T>;
export declare function linkAbortSignals(...signals: Array<AbortSignal | undefined>): {
    signal: AbortSignal;
    dispose(): void;
};
