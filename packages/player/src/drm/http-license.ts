import { MediaForgeError } from 'mediaforgejs/plugins';
import {
    awaitWithAbort,
    copyOutputBytes,
    createDeadline,
    invalidArgument,
    outputByteLength,
    outputError,
    positiveLimit,
    unsupported,
} from '../support.js';
import type { EmeLicenseCallback } from './eme-controller.js';

export interface HttpLicenseOptions {
    readonly url: string | URL;
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: HeadersInit;
    readonly credentials?: RequestCredentials;
    /** Maximum response body bytes, including streamed responses; defaults to 1 MiB. */
    readonly maxResponseBytes?: number;
    /** Deadline for the request and its entire response body; defaults to 30 seconds. */
    readonly timeoutMs?: number;
}

/** Binary challenge/response POST. Configure authorization in headers, credentials or fetch. */
export function createHttpLicenseCallback(options: HttpLicenseOptions): EmeLicenseCallback {
    if (!options || typeof options !== 'object')
        invalidArgument('HTTP license options are required');
    const { url, fetch: customFetch, headers, credentials, maxResponseBytes, timeoutMs } = options;
    let target: URL;
    try {
        if (typeof url !== 'string' && !(url instanceof URL)) throw new Error();
        target = new URL(url);
        if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password)
            throw new Error();
    } catch {
        invalidArgument('License URL must be an absolute HTTP(S) URL without credentials');
    }
    const address = target.href;
    const fetcher = customFetch === undefined ? globalThis.fetch : customFetch;
    if (typeof fetcher !== 'function') {
        if (customFetch !== undefined) invalidArgument('HTTP license fetch must be a function');
        unsupported('HTTP license requests need fetch, which this host lacks');
    }
    if (credentials !== undefined && !['omit', 'same-origin', 'include'].includes(credentials)) {
        invalidArgument('Invalid HTTP license credentials mode');
    }
    const limit = positiveLimit(maxResponseBytes, 1024 * 1024, 'maxResponseBytes');
    const timeout = positiveLimit(timeoutMs, 30000, 'timeoutMs');
    if (timeout > 0x7fffffff) invalidArgument('timeoutMs exceeds the timer range');
    let requestHeaders: Headers;
    try {
        requestHeaders = new Headers(headers);
    } catch {
        invalidArgument('Invalid HTTP license headers');
    }
    if (!requestHeaders.has('Content-Type'))
        requestHeaders.set('Content-Type', 'application/octet-stream');
    const send = fetcher.bind(customFetch === undefined ? globalThis : options);

    return async request => {
        const { signal, message } = request;
        if (
            !signal ||
            typeof signal.aborted !== 'boolean' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function'
        ) {
            invalidArgument('HTTP license request requires an AbortSignal');
        }

        const aborted = (): MediaForgeError =>
            outputError(signal.reason, 'HTTP license request aborted', 'ABORT');
        if (signal.aborted) throw aborted();
        if (!outputByteLength(message))
            throw new MediaForgeError('HTTP license challenge must not be empty', 'IO');

        const challenge = copyOutputBytes(message);
        const lease = new AbortController();

        let failure: MediaForgeError | undefined;
        const fail = (reason: unknown): MediaForgeError =>
            (failure ??= outputError(reason, 'HTTP license request failed'));
        const observe = <T>(pending: PromiseLike<T>): Promise<T> =>
            Promise.resolve(pending).catch(reason => {
                throw fail(reason);
            });

        const onAbort = (): void => lease.abort(fail(aborted()));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();

        const expired = createDeadline(timeout);
        const onTimeout = (): void =>
            lease.abort(fail(new MediaForgeError('HTTP license request timed out', 'IO')));
        const timer = setTimeout(onTimeout, timeout);

        const check = (): void => {
            if (!failure && expired()) onTimeout();
            if (failure) throw failure;
        };

        let response: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let cancelled = false;
        let finished = false;

        const cancel = (): void => {
            if (cancelled) return;
            cancelled = true;
            try {
                void Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(
                    () => undefined,
                );
            } catch {}
        };

        const pending = Promise.resolve().then(() => {
            check();
            try {
                return observe(
                    send(address, {
                        method: 'POST',
                        body: challenge,
                        headers: new Headers(requestHeaders),
                        credentials,
                        signal: lease.signal,
                    }),
                );
            } catch (error) {
                throw fail(error);
            }
        });

        void pending.then(
            result => {
                response = result;
                if (lease.signal.aborted) cancel();
            },
            () => undefined,
        );

        try {
            await awaitWithAbort(pending, lease.signal);
            check();
            if (!response!.ok)
                throw new MediaForgeError(
                    `HTTP license request failed with status ${response!.status}`,
                    'IO',
                );
            if (response!.status === 206 || response!.headers.get('Content-Range') !== null) {
                throw new MediaForgeError(
                    'HTTP license server returned an unexpected partial response',
                    'IO',
                );
            }

            const lengthHeader = response!.headers.get('Content-Length');
            let declared: number | undefined;
            if (lengthHeader !== null) {
                if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(Number(lengthHeader))) {
                    throw new MediaForgeError(
                        'HTTP license response has an invalid Content-Length',
                        'IO',
                    );
                }
                declared = Number(lengthHeader);
                if (declared > limit)
                    throw new MediaForgeError(
                        'HTTP license response exceeds its byte limit',
                        'OOM',
                    );
            }

            const chunks: Uint8Array[] = [];
            let page: Uint8Array | undefined;
            let used = 0;
            let length = 0;
            let emptyChunks = 0;
            let reads = 0;
            let lastYield = Date.now();
            const body = response!.body;
            if (body) {
                reader = body.getReader();
                while (true) {
                    if (++reads % 256 === 0 && Date.now() - lastYield >= 8) {
                        await new Promise<void>(resolve => setTimeout(resolve, 0));
                        check();
                        lastYield = Date.now();
                    }

                    check();
                    const item = await awaitWithAbort(observe(reader.read()), lease.signal);
                    check();
                    if (item.done) break;

                    const chunk = item.value;
                    const count = outputByteLength(chunk);
                    if (count > limit - length)
                        throw new MediaForgeError(
                            'HTTP license response exceeds its byte limit',
                            'OOM',
                        );
                    if (!count) {
                        if (++emptyChunks > 1024)
                            throw new MediaForgeError(
                                'HTTP license response contains too many empty chunks',
                                'IO',
                            );
                        continue;
                    }

                    emptyChunks = 0;
                    if (!page || count > page.length - used) {
                        if (page) chunks[chunks.length - 1] = page.subarray(0, used);
                        page = new Uint8Array(Math.min(limit - length, Math.max(65536, count)));
                        chunks.push(page);
                        used = 0;
                    }
                    page.set(chunk, used);
                    used += count;
                    length += count;
                }
            }

            const encoding = response!.headers.get('Content-Encoding');
            if (
                declared !== undefined &&
                (!encoding || encoding.trim().toLowerCase() === 'identity') &&
                length !== declared
            ) {
                throw new MediaForgeError(
                    'HTTP license response was truncated or has an invalid Content-Length',
                    'IO',
                );
            }

            if (!length) throw new MediaForgeError('HTTP license response must not be empty', 'IO');
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (let index = 0; index < chunks.length; index++) {
                const chunk =
                    index === chunks.length - 1 ? chunks[index]!.subarray(0, used) : chunks[index]!;
                bytes.set(chunk, offset);
                offset += chunk.length;
            }

            check();
            finished = true;
            return bytes;
        } catch (error) {
            throw fail(error);
        } finally {
            clearTimeout(timer);
            try {
                signal.removeEventListener('abort', onAbort);
            } catch {}
            if (!finished && response) cancel();
            try {
                reader?.releaseLock();
            } catch {}
        }
    };
}
