import type { Source } from '../../model/types';
import { awaitWithAbort } from '../abort';
import { yieldEventLoop } from '../event-loop';
import { IOError, MediaForgeError } from '../../errors/errors';
import { registerOwnedReads, sourceReadEnd } from './source-read';
import { outputByteLength } from '../../bytes/output-data';
import { StreamSource } from './stream-source';
import {
    DiagnosticContext,
    type DiagnosticOptions,
    type MediaDiagnostic,
} from '../../errors/diagnostics';

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
    /**
     * Requires a strong ETag. Default false requires the caller to keep unvalidated resources
     * stable.
     */
    readonly requireValidator?: boolean;
}

function monotonicNow(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function abortError(): MediaForgeError {
    return new MediaForgeError('HTTP source was aborted or closed', 'ABORT');
}

function cancelResponse(response: Response): void {
    try {
        Promise.resolve(response.body?.cancel()).catch(() => undefined);
    } catch {}
}

function responseLength(response: Response): number | undefined {
    const value = response.headers.get('content-length');
    if (value === null) return undefined;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new IOError('Invalid HTTP Content-Length');
    return Number(value);
}

function contentRange(response: Response): { start: number; end: number; size: number } {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (!match) throw new IOError('HTTP range response requires a complete Content-Range');
    const [start, end, size] = match.slice(1).map(Number);
    if (![start, end, size].every(Number.isSafeInteger) || start! > end! || end! >= size!) {
        throw new IOError('Invalid HTTP Content-Range');
    }
    return { start: start!, end: end!, size: size! };
}

async function readResponse(
    response: Response,
    count: number,
    signal: AbortSignal,
    check: () => void,
    target?: Uint8Array,
): Promise<Uint8Array> {
    const declaredLength = responseLength(response);
    if (declaredLength !== undefined && declaredLength !== count) {
        throw new IOError('HTTP Content-Length does not match the requested range');
    }
    if (!response.body) throw new IOError('HTTP response has no readable body');
    const reader = response.body.getReader();
    const bytes = target ?? new Uint8Array(count);
    let position = 0;
    let emptyChunks = 0;
    let pulls = 0;
    let lastYield = monotonicNow();

    try {
        while (true) {
            if (++pulls % 256 === 0 && monotonicNow() - lastYield >= 8) {
                await awaitWithAbort(yieldEventLoop(), signal);
                lastYield = monotonicNow();
            }

            check();
            const result = await awaitWithAbort(reader.read(), signal);
            check();
            if (result.done) break;
            const length = outputByteLength(result.value);
            if (length === 0) {
                if (++emptyChunks > 1024)
                    throw new IOError('HTTP response made no byte progress within 1024 chunks');
                continue;
            }

            emptyChunks = 0;
            if (length > count - position)
                throw new IOError('HTTP response exceeds its requested range');
            bytes.set(result.value, position);
            position += length;
        }
        if (position !== count) throw new IOError('HTTP range response ended early');
        return bytes;
    } catch (error) {
        try {
            Promise.resolve(reader.cancel(error)).catch(() => undefined);
        } catch {}
        throw error;
    } finally {
        try {
            reader.releaseLock();
        } catch {}
    }
}

/**
 * Fetch-backed random access. Servers must expose Content-Range and ETag to cross-origin browser
 * clients.
 */
export class HttpSource implements Source {
    private length = 0;
    private readonly controller = new AbortController();
    private readonly fetcher: typeof fetch;
    private readonly headers: Headers;
    private readonly maxResponseBytes: number;
    private readonly requestTimeoutMs: number;
    private readonly fallback: 'error' | 'buffer';
    private readonly maxBytes: number | undefined;
    private readonly requireValidator: boolean;
    private readonly diagnostics: DiagnosticContext;
    private readonly detach: () => void;
    private snapshot: Source | null = null;
    private etag: string | null = null;
    private observedEtag: string | null = null;
    private modified: string | null = null;
    private responseUrl = '';
    private failure: unknown;

    private constructor(
        private readonly url: string | URL,
        options: HttpSourceOptions,
    ) {
        this.diagnostics = new DiagnosticContext(options, 'compatible');
        registerOwnedReads(this, HttpSource.prototype.read);
        const customFetch = options.fetch;
        const fetcher = customFetch ?? globalThis.fetch;
        if (typeof fetcher !== 'function') throw new IOError('HttpSource requires Fetch');
        // Browsers refuse a fetch called on another object ("Illegal invocation"): the global one
        // runs on globalThis, the caller's on its options, as in createRetryFetch().
        this.fetcher = fetcher.bind(fetcher === customFetch ? options : globalThis);
        this.headers = new Headers(options.headers);
        this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
        if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
            throw new MediaForgeError('maxResponseBytes must be a positive safe integer', 'INPUT');
        }

        const requestTimeoutMs = options.requestTimeoutMs;
        this.requestTimeoutMs = requestTimeoutMs === undefined ? 30000 : requestTimeoutMs;
        if (
            !Number.isSafeInteger(this.requestTimeoutMs) ||
            this.requestTimeoutMs <= 0 ||
            this.requestTimeoutMs > 0x7fffffff
        ) {
            throw new MediaForgeError(
                'requestTimeoutMs must be an integer from 1 to 2147483647',
                'INPUT',
            );
        }

        this.fallback = options.fallback ?? 'error';
        this.maxBytes = options.maxBytes;
        if (this.fallback !== 'error' && this.fallback !== 'buffer')
            throw new IOError("HttpSource fallback must be 'error' or 'buffer'");
        if (
            this.maxBytes !== undefined &&
            (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0)
        ) {
            throw new MediaForgeError('maxBytes must be a non-negative safe integer', 'INPUT');
        }
        if (this.fallback === 'buffer' && this.maxBytes === undefined) {
            throw new IOError('HTTP buffer fallback requires an explicit maxBytes');
        }

        const requireValidator = options.requireValidator;
        if (requireValidator !== undefined && typeof requireValidator !== 'boolean') {
            throw new MediaForgeError('requireValidator must be a boolean', 'INPUT');
        }
        this.requireValidator = requireValidator ?? false;

        const signal = options.signal;
        const onAbort = (): void => {
            void this.close();
        };
        this.detach = () => signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    }

    static async open(url: string | URL, options: HttpSourceOptions = {}): Promise<HttpSource> {
        const source = new HttpSource(String(url), options);
        try {
            await source.withRequest(0, 1, async (response, signal, check) => {
                source.checkEncoding(response);
                if (response.status === 200) {
                    if (source.fallback !== 'buffer')
                        throw new IOError('HTTP server ignored the Range header', {
                            hint: "Pass fallback: 'buffer' and maxBytes to read it whole.",
                        });
                    const length = responseLength(response);
                    if (length !== undefined && length > source.maxBytes!)
                        throw new MediaForgeError('HTTP response exceeds maxBytes', 'OOM');
                    if (!response.body) throw new IOError('HTTP response has no readable body');
                    source.snapshot = await StreamSource.from(response.body, {
                        retention: 'memory',
                        maxBytes: source.maxBytes!,
                        signal,
                    }).catch(error => {
                        if (
                            signal.aborted &&
                            error instanceof MediaForgeError &&
                            error.code === 'ABORT'
                        )
                            throw signal.reason;
                        throw error;
                    });

                    source.length = source.snapshot.size;
                    if (length !== undefined && length !== source.length)
                        throw new IOError('HTTP response ended before Content-Length');
                } else if (
                    response.status === 416 &&
                    response.headers.get('content-range') === 'bytes */0'
                ) {
                    cancelResponse(response);
                } else {
                    if (response.status !== 206)
                        throw new IOError(`HTTP source returned status ${response.status}`);
                    const range = contentRange(response);
                    if (range.start !== 0 || range.end !== 0)
                        throw new IOError('HTTP server returned a different probe range');
                    source.length = range.size;
                    const etag = response.headers.get('etag');
                    source.observedEtag = etag;
                    source.etag = etag && /^"[^"\r\n]*"$/.test(etag) ? etag : null;
                    source.modified = response.headers.get('last-modified');
                    if (!source.etag) {
                        if (source.requireValidator)
                            throw new IOError(
                                'HTTP random access requires a strong ETag when requireValidator ' +
                                    'is true',
                            );
                        source.diagnostics.warn({
                            code: 'HTTP_UNVALIDATED',
                            format: 'http',
                            message: 'HTTP resource has no strong ETag, so changes go unnoticed',
                        });
                    }

                    source.responseUrl = response.url;
                    await readResponse(response, 1, signal, check);
                }
            });
            if (source.controller.signal.aborted) throw abortError();
            return source;
        } catch (error) {
            await source.close();
            throw error;
        }
    }

    get size(): number {
        return this.length;
    }
    get warnings(): readonly MediaDiagnostic[] {
        return this.diagnostics.warnings;
    }

    async read(offset: number, length: number): Promise<Uint8Array> {
        this.assertOpen();
        const end = sourceReadEnd(offset, length, this.length);
        if (end <= offset) return new Uint8Array(0);
        if (this.snapshot) {
            const bytes = await this.snapshot.read(offset, length);
            this.assertOpen();
            return bytes;
        }

        const bytes = new Uint8Array(end - offset);
        try {
            for (let position = offset; position < end;) {
                this.assertOpen();
                const count = Math.min(this.maxResponseBytes, end - position);
                await this.withRequest(position, count, async (response, signal, check) => {
                    this.checkEncoding(response);
                    if (response.status !== 206)
                        throw new IOError(`HTTP range request returned status ${response.status}`);
                    const range = contentRange(response);
                    if (
                        range.start !== position ||
                        range.end !== position + count - 1 ||
                        range.size !== this.length
                    ) {
                        throw new IOError('HTTP range or resource size changed');
                    }

                    if (
                        response.headers.get('etag') !== this.observedEtag ||
                        response.headers.get('last-modified') !== this.modified ||
                        (this.responseUrl && response.url !== this.responseUrl)
                    ) {
                        throw new IOError('HTTP resource identity changed');
                    }

                    await readResponse(
                        response,
                        count,
                        signal,
                        check,
                        bytes.subarray(position - offset, position - offset + count),
                    );
                    this.assertOpen();
                });
                position += count;
            }
            return bytes;
        } catch (error) {
            if (this.failure === undefined) this.failure = error;
            await this.close();
            throw this.failure;
        }
    }

    /** Cancels in-flight requests. Caller owns this source independently of readers using it. */
    async close(): Promise<void> {
        this.detach();
        this.controller.abort();
        this.snapshot = null;
    }

    private assertOpen(): void {
        if (this.failure !== undefined) throw this.failure;
        if (this.controller.signal.aborted) throw abortError();
    }

    private checkEncoding(response: Response): void {
        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding.toLowerCase() !== 'identity')
            throw new IOError('Encoded HTTP responses cannot provide byte-accurate ranges');
    }

    private async withRequest<T>(
        offset: number,
        count: number,
        consume: (response: Response, signal: AbortSignal, check: () => void) => Promise<T>,
    ): Promise<T> {
        this.assertOpen();

        const lease = new AbortController();
        const onAbort = (): void => lease.abort(abortError());
        this.controller.signal.addEventListener('abort', onAbort, { once: true });

        const expires = monotonicNow() + this.requestTimeoutMs;
        const expire = (): void =>
            lease.abort(new IOError('HTTP response exceeded requestTimeoutMs'));
        const timer = setTimeout(expire, this.requestTimeoutMs);

        const check = (): void => {
            if (!lease.signal.aborted && monotonicNow() >= expires) expire();
            if (lease.signal.aborted) throw lease.signal.reason;
        };

        let response: Response | undefined;
        try {
            response = await this.request(offset, count, lease.signal, check);
            check();
            const result = await consume(response, lease.signal, check);
            check();
            return result;
        } catch (error) {
            if (response) cancelResponse(response);
            throw error;
        } finally {
            clearTimeout(timer);
            this.controller.signal.removeEventListener('abort', onAbort);
        }
    }

    private async request(
        offset: number,
        count: number,
        signal: AbortSignal,
        check: () => void,
    ): Promise<Response> {
        this.assertOpen();
        const headers = new Headers(this.headers);
        headers.set('Range', `bytes=${offset}-${offset + count - 1}`);
        headers.set('Accept-Encoding', 'identity');
        if (this.etag) headers.set('If-Match', this.etag);
        else if (this.modified) headers.set('If-Unmodified-Since', this.modified);

        const pending = Promise.resolve()
            .then(() => {
                check();
                return this.fetcher(this.url, { headers, signal });
            })
            .then(response => {
                if (signal.aborted) {
                    cancelResponse(response);
                    check();
                }
                return response;
            });
        return awaitWithAbort(pending, signal);
    }
}
