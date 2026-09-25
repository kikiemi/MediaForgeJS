import type { Source } from '../types/io.js';
import { type DiagnosticOptions, type MediaDiagnostic } from '../core/diagnostics.js';
export interface HttpSourceOptions extends DiagnosticOptions {
    readonly fetch?: typeof fetch;
    readonly headers?: HeadersInit;
    readonly signal?: AbortSignal;
    /** Deadline for each response, including its body; defaults to 30000 ms. */
    readonly requestTimeoutMs?: number;
    /** Per-response range limit; defaults to 8 MiB. A read still allocates its requested result. */
    readonly maxResponseBytes?: number;
    /** A server ignoring Range may be snapshotted only during open; defaults to error. */
    readonly fallback?: 'error' | 'buffer';
    /** Required for buffer fallback; maximum retained full-response payload bytes. */
    readonly maxBytes?: number;
    /** Requires a strong ETag. Default false requires the caller to keep unvalidated resources stable. */
    readonly requireValidator?: boolean;
}
/** Fetch-backed random access. Servers must expose Content-Range and ETag to cross-origin browser clients. */
export declare class HttpSource implements Source {
    private readonly url;
    private length;
    private readonly controller;
    private readonly fetcher;
    private readonly headers;
    private readonly maxResponseBytes;
    private readonly requestTimeoutMs;
    private readonly fallback;
    private readonly maxBytes;
    private readonly requireValidator;
    private readonly diagnostics;
    private readonly detach;
    private snapshot;
    private etag;
    private observedEtag;
    private modified;
    private responseUrl;
    private failure;
    private constructor();
    static open(url: string | URL, options?: HttpSourceOptions): Promise<HttpSource>;
    get size(): number;
    get warnings(): readonly MediaDiagnostic[];
    read(offset: number, length: number): Promise<Uint8Array>;
    /** Cancels in-flight requests. Caller owns this source independently of readers using it. */
    close(): Promise<void>;
    private assertOpen;
    private checkEncoding;
    private withRequest;
    private request;
}
