import { IOError, MediaForgeError } from '../core/errors.js';
import { sourceReadEnd } from './source-read.js';
import { outputByteLength } from './output-data.js';
import { StreamSource } from './stream-source.js';
import { DiagnosticContext } from '../core/diagnostics.js';
function monotonicNow() {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}
function abortError() {
    return new MediaForgeError('HTTP source was aborted or closed', 'ABORT');
}
function cancelResponse(response) {
    try {
        Promise.resolve(response.body?.cancel()).catch(() => undefined);
    }
    catch { }
}
async function withAbort(pending, signal) {
    let rejectAbort = () => undefined;
    const aborted = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(signal.reason ?? abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted)
        onAbort();
    try {
        return await Promise.race([pending, aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
function responseLength(response) {
    const value = response.headers.get('content-length');
    if (value === null)
        return undefined;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new IOError('Invalid HTTP Content-Length');
    return Number(value);
}
function contentRange(response) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (!match)
        throw new IOError('HTTP range response requires a complete Content-Range');
    const [start, end, size] = match.slice(1).map(Number);
    if (![start, end, size].every(Number.isSafeInteger) || start > end || end >= size) {
        throw new IOError('Invalid HTTP Content-Range');
    }
    return { start: start, end: end, size: size };
}
async function readResponse(response, count, signal, check, target) {
    const declaredLength = responseLength(response);
    if (declaredLength !== undefined && declaredLength !== count) {
        throw new IOError('HTTP Content-Length does not match the requested range');
    }
    if (!response.body)
        throw new IOError('HTTP response has no readable body');
    const reader = response.body.getReader();
    const bytes = target ?? new Uint8Array(count);
    let position = 0;
    let emptyChunks = 0;
    let pulls = 0;
    let lastYield = monotonicNow();
    try {
        while (true) {
            if (++pulls % 256 === 0 && monotonicNow() - lastYield >= 8) {
                await withAbort(new Promise(resolve => setTimeout(resolve, 0)), signal);
                lastYield = monotonicNow();
            }
            check();
            const result = await withAbort(reader.read(), signal);
            check();
            if (result.done)
                break;
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
        if (position !== count)
            throw new IOError('HTTP range response ended early');
        return bytes;
    }
    catch (error) {
        try {
            Promise.resolve(reader.cancel(error)).catch(() => undefined);
        }
        catch { }
        throw error;
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch { }
    }
}
export class HttpSource {
    url;
    length = 0;
    controller = new AbortController();
    fetcher;
    headers;
    maxResponseBytes;
    requestTimeoutMs;
    fallback;
    maxBytes;
    requireValidator;
    diagnostics;
    detach;
    snapshot = null;
    etag = null;
    observedEtag = null;
    modified = null;
    responseUrl = '';
    failure;
    constructor(url, options) {
        this.url = url;
        this.diagnostics = new DiagnosticContext(options, 'compatible');
        this.fetcher = options.fetch ?? globalThis.fetch;
        if (typeof this.fetcher !== 'function')
            throw new IOError('HttpSource requires Fetch');
        this.headers = new Headers(options.headers);
        this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
        if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
            throw new IOError('maxResponseBytes must be a positive safe integer');
        }
        const requestTimeoutMs = options.requestTimeoutMs;
        this.requestTimeoutMs = requestTimeoutMs === undefined ? 30000 : requestTimeoutMs;
        if (!Number.isSafeInteger(this.requestTimeoutMs) ||
            this.requestTimeoutMs <= 0 ||
            this.requestTimeoutMs > 0x7fffffff) {
            throw new IOError('requestTimeoutMs must be a positive safe integer within the timer range');
        }
        this.fallback = options.fallback ?? 'error';
        this.maxBytes = options.maxBytes;
        if (this.fallback !== 'error' && this.fallback !== 'buffer')
            throw new IOError('Invalid HTTP fallback');
        if (this.maxBytes !== undefined && (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0)) {
            throw new IOError('maxBytes must be a non-negative safe integer');
        }
        if (this.fallback === 'buffer' && this.maxBytes === undefined) {
            throw new IOError('HTTP buffer fallback requires an explicit maxBytes');
        }
        const requireValidator = options.requireValidator;
        if (requireValidator !== undefined && typeof requireValidator !== 'boolean') {
            throw new IOError('requireValidator must be a boolean');
        }
        this.requireValidator = requireValidator ?? false;
        const signal = options.signal;
        const onAbort = () => {
            void this.close();
        };
        this.detach = () => signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
    }
    static async open(url, options = {}) {
        const source = new HttpSource(String(url), options);
        try {
            await source.withRequest(0, 1, async (response, signal, check) => {
                source.checkEncoding(response);
                if (response.status === 200) {
                    if (source.fallback !== 'buffer')
                        throw new IOError('HTTP server ignored Range; buffer fallback is disabled');
                    const length = responseLength(response);
                    if (length !== undefined && length > source.maxBytes)
                        throw new MediaForgeError('HTTP response exceeds maxBytes', 'OOM');
                    if (!response.body)
                        throw new IOError('HTTP response has no readable body');
                    source.snapshot = await StreamSource.from(response.body, {
                        retention: 'memory',
                        maxBytes: source.maxBytes,
                        signal,
                    }).catch(error => {
                        if (signal.aborted && error instanceof MediaForgeError && error.code === 'ABORT')
                            throw signal.reason;
                        throw error;
                    });
                    source.length = source.snapshot.size;
                    if (length !== undefined && length !== source.length)
                        throw new IOError('HTTP response ended before Content-Length');
                }
                else if (response.status === 416 && response.headers.get('content-range') === 'bytes */0') {
                    cancelResponse(response);
                }
                else {
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
                            throw new IOError('HTTP random access requires a strong ETag when requireValidator is true');
                        source.diagnostics.warn({
                            code: 'HTTP_UNVALIDATED',
                            format: 'http',
                            message: 'HTTP resource has no strong ETag; the caller must keep its content stable while reading',
                        });
                    }
                    source.responseUrl = response.url;
                    await readResponse(response, 1, signal, check);
                }
            });
            if (source.controller.signal.aborted)
                throw abortError();
            return source;
        }
        catch (error) {
            await source.close();
            throw error;
        }
    }
    get size() {
        return this.length;
    }
    get warnings() {
        return this.diagnostics.warnings;
    }
    async read(offset, length) {
        this.assertOpen();
        const end = sourceReadEnd(offset, length, this.length);
        if (end <= offset)
            return new Uint8Array(0);
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
                    if (range.start !== position || range.end !== position + count - 1 || range.size !== this.length) {
                        throw new IOError('HTTP range or resource size changed');
                    }
                    if (response.headers.get('etag') !== this.observedEtag ||
                        response.headers.get('last-modified') !== this.modified ||
                        (this.responseUrl && response.url !== this.responseUrl)) {
                        throw new IOError('HTTP resource identity changed');
                    }
                    await readResponse(response, count, signal, check, bytes.subarray(position - offset, position - offset + count));
                    this.assertOpen();
                });
                position += count;
            }
            return bytes;
        }
        catch (error) {
            if (this.failure === undefined)
                this.failure = error;
            await this.close();
            throw this.failure;
        }
    }
    async close() {
        this.detach();
        this.controller.abort();
        this.snapshot = null;
    }
    assertOpen() {
        if (this.failure !== undefined)
            throw this.failure;
        if (this.controller.signal.aborted)
            throw abortError();
    }
    checkEncoding(response) {
        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding.toLowerCase() !== 'identity')
            throw new IOError('Encoded HTTP responses cannot provide byte-accurate ranges');
    }
    async withRequest(offset, count, consume) {
        this.assertOpen();
        const lease = new AbortController();
        const onAbort = () => lease.abort(abortError());
        this.controller.signal.addEventListener('abort', onAbort, { once: true });
        const expires = monotonicNow() + this.requestTimeoutMs;
        const expire = () => lease.abort(new IOError('HTTP response exceeded requestTimeoutMs'));
        const timer = setTimeout(expire, this.requestTimeoutMs);
        const check = () => {
            if (!lease.signal.aborted && monotonicNow() >= expires)
                expire();
            if (lease.signal.aborted)
                throw lease.signal.reason;
        };
        let response;
        try {
            response = await this.request(offset, count, lease.signal, check);
            check();
            const result = await consume(response, lease.signal, check);
            check();
            return result;
        }
        catch (error) {
            if (response)
                cancelResponse(response);
            throw error;
        }
        finally {
            clearTimeout(timer);
            this.controller.signal.removeEventListener('abort', onAbort);
        }
    }
    async request(offset, count, signal, check) {
        this.assertOpen();
        const headers = new Headers(this.headers);
        headers.set('Range', `bytes=${offset}-${offset + count - 1}`);
        headers.set('Accept-Encoding', 'identity');
        if (this.etag)
            headers.set('If-Match', this.etag);
        else if (this.modified)
            headers.set('If-Unmodified-Since', this.modified);
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
        return withAbort(pending, signal);
    }
}
