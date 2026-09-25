export interface RetryFetchOptions {
    readonly fetch?: typeof globalThis.fetch;
    /** Additional attempts for GET/HEAD requests without a body; defaults to 2, maximum 10. */
    readonly maxRetries?: number;
    /** Initial exponential backoff in milliseconds; defaults to 250. */
    readonly baseDelayMs?: number;
    /** Maximum wait in milliseconds; defaults to 10000. Larger Retry-After values are not retried. */
    readonly maxDelayMs?: number;
}
/** Retries transient GET/HEAD requests before returning a Response; its body is never replayed. */
export declare function createRetryFetch(options?: RetryFetchOptions): typeof globalThis.fetch;
