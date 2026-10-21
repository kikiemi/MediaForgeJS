import { MediaForgeError } from 'mediaforgejs/plugins';
import type { HlsByteRange } from 'mediaforgejs/streaming';
import {
    assertSourceBytes,
    awaitWithAbort,
    ioError,
    linkAbortSignals,
    overLimit,
    throwIfAborted,
    typedArrayByteLength as chunkByteLength,
} from './support.js';

/** One resource the players read: where, how much at most, and within what time. */
export interface ResourceRequest {
    readonly fetcher: typeof globalThis.fetch;
    readonly url: string;
    /** Largest number of bytes read; a larger response fails with OOM. */
    readonly limit: number;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    /** The bytes of the resource read; omitted reads all of it. */
    readonly range?: HlsByteRange;
    /** The protocol errors name; default 'HLS'. */
    readonly label?: string;
}

/** Milliseconds of a clock that never goes back. */
export function monotonicNow(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/** `value` as an absolute HTTP(S) URL; anything else fails. */
export function networkUri(value: string, label = 'HLS'): string {
    let uri: URL;
    try {
        uri = new URL(value);
    } catch {
        throw new MediaForgeError(`${label}: loading requires an absolute HTTP(S) URL`, 'INPUT');
    }
    if (uri.protocol !== 'http:' && uri.protocol !== 'https:') {
        throw new MediaForgeError(`${label}: only HTTP(S) resource URLs are supported`, 'FORMAT');
    }
    return uri.href;
}

/** Waits `milliseconds`, or until `signal` aborts. */
export async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await awaitWithAbort(
            new Promise<void>(resolve => {
                timer = setTimeout(resolve, milliseconds);
            }),
            signal,
        );
    } finally {
        clearTimeout(timer);
    }
}

/** The length of one chunk of a response body, which must fit in the `remaining` bytes. */
export function checkedChunkLength(chunk: Uint8Array, remaining: number, label = 'HLS'): number {
    let length: number;
    try {
        length = chunkByteLength.call(chunk);
    } catch {
        throw ioError(`${label}: response stream must contain Uint8Array chunks`);
    }
    assertSourceBytes(chunk, length, `${label} response`);
    if (length > remaining) overLimit(`${label}: response exceeds the configured byte limit`);
    return length;
}

/**
 * The bytes of one resource (the byte range of it `range` names) and its final URL: at most `limit`
 * bytes, within `timeoutMs`, and a range only from a server that honours it.
 */
export async function fetchResource(
    request: ResourceRequest,
): Promise<{ bytes: Uint8Array; url: string }> {
    const { signal, timeoutMs, label = 'HLS' } = request;
    const timeout = new AbortController();
    const linked = linkAbortSignals(signal, timeout.signal);
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const started = monotonicNow();
    const check = (): void => {
        throwIfAborted(signal);
        if (timeout.signal.aborted || monotonicNow() - started >= timeoutMs) {
            throw ioError(`${label}: resource request exceeded requestTimeoutMs`);
        }
    };
    try {
        return await readBody(request, linked.signal, check);
    } finally {
        clearTimeout(timer);
        linked.dispose();
    }
}

/** Reads the resource of `request` under `signal`; `check` fails once it is stopped or late. */
async function readBody(
    request: ResourceRequest,
    signal: AbortSignal,
    check: () => void,
): Promise<{ bytes: Uint8Array; url: string }> {
    const { fetcher, url, limit, range, label = 'HLS' } = request;
    check();
    if (range && range.length > limit)
        overLimit(`${label}: byte range exceeds the configured byte limit`);
    const pending = Promise.resolve().then(() => {
        check();
        return fetcher(url, {
            signal,
            headers: range
                ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
                : undefined,
        });
    });

    void pending.then(
        response => {
            if (signal.aborted) {
                try {
                    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
                } catch {}
            }
        },
        () => undefined,
    );

    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        response = await awaitWithAbort(pending, signal);
        check();
        if (!response.ok) throw ioError(`${label}: HTTP ${response.status} for ${url}`);
        if (range) {
            const encoding = response.headers.get('Content-Encoding');
            if (encoding && encoding.trim().toLowerCase() !== 'identity')
                throw ioError(`${label}: encoded range responses are unsupported`);
            const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(
                response.headers.get('Content-Range') ?? '',
            );
            if (
                response.status !== 206 ||
                !match ||
                Number(match[1]) !== range.offset ||
                Number(match[2]) !== range.offset + range.length - 1 ||
                (match[3] !== '*' &&
                    (!Number.isSafeInteger(Number(match[3])) ||
                        Number(match[2]) >= Number(match[3])))
            ) {
                throw ioError(`${label}: server did not honor the requested byte range`);
            }
        } else if (response.status === 206) throw ioError(`${label}: unexpected partial response`);

        const lengthHeader = response.headers.get('Content-Length');
        if (lengthHeader !== null && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > limit) {
            overLimit(`${label}: response exceeds the configured byte limit`);
        }

        const chunks: Uint8Array[] = [];
        let page: Uint8Array | undefined;
        let used = 0;
        let length = 0;
        let emptyChunks = 0;
        let chunksRead = 0;
        let lastYield = monotonicNow();
        let lastYieldLength = 0;

        if (response.body) {
            reader = response.body.getReader();
            while (true) {
                if (
                    (++chunksRead % 256 === 0 || length - lastYieldLength >= 4 * 1024 * 1024) &&
                    monotonicNow() - lastYield >= 8
                ) {
                    await delay(0, signal);
                    lastYield = monotonicNow();
                    lastYieldLength = length;
                }

                const item = await awaitWithAbort(reader.read(), signal);
                check();
                if (item.done) break;
                const chunk = item.value;
                const count = checkedChunkLength(chunk, limit - length, label);
                if (!count) {
                    if (++emptyChunks > 1024)
                        throw ioError(`${label}: too many consecutive empty response chunks`);
                    continue;
                }

                emptyChunks = 0;
                if (!page || count > page.length - used) {
                    if (page && used < page.length)
                        chunks[chunks.length - 1] = page.subarray(0, used);
                    const capacity =
                        length === 0 || count >= 65536 ? count : Math.min(limit - length, 65536);
                    page = new Uint8Array(capacity);
                    chunks.push(page);
                    used = 0;
                }
                page.set(chunk, used);
                used += count;
                length += count;
            }
        }

        if (range && length !== range.length)
            throw ioError(`${label}: truncated byte range response`);
        const bytes = chunks.length === 1 ? page! : new Uint8Array(length);
        if (chunks.length > 1) {
            let offset = 0;
            for (let index = 0; index < chunks.length; index++) {
                const chunk = chunks[index]!;
                const part = index === chunks.length - 1 ? chunk.subarray(0, used) : chunk;
                bytes.set(part, offset);
                offset += part.length;
            }
        }

        const result = {
            bytes: bytes.length === length ? bytes : bytes.slice(0, length),
            url: response.url ? networkUri(response.url, label) : url,
        };
        check();
        return result;
    } catch (error) {
        check();
        throw error;
    } finally {
        if (reader) {
            try {
                void Promise.resolve(reader.cancel()).catch(() => undefined);
            } catch {}
            try {
                reader.releaseLock();
            } catch {}
        } else {
            try {
                void Promise.resolve(response?.body?.cancel()).catch(() => undefined);
            } catch {}
        }
    }
}
