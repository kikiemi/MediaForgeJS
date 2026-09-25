import { awaitWithAbort } from '../core/abort.js';
import { MediaForgeError } from '../core/errors.js';
import { copyOutputBytes, outputByteLength, outputError } from '../io/output-data.js';
import { createDeadline } from './deadline.js';
function positive(value, fallback, name) {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result <= 0)
        throw new MediaForgeError(`${name} must be a positive safe integer`, 'FORMAT');
    return result;
}
export function createHttpLicenseCallback(options) {
    if (!options || typeof options !== 'object')
        throw new MediaForgeError('HTTP license options are required', 'FORMAT');
    const { url, fetch: customFetch, headers, credentials, maxResponseBytes, timeoutMs } = options;
    let target;
    try {
        if (typeof url !== 'string' && !(url instanceof URL))
            throw new Error();
        target = new URL(url);
        if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password)
            throw new Error();
    }
    catch {
        throw new MediaForgeError('HTTP license URL must be an absolute HTTP(S) URL without embedded credentials', 'FORMAT');
    }
    const address = target.href;
    const fetcher = customFetch === undefined ? globalThis.fetch : customFetch;
    if (typeof fetcher !== 'function')
        throw new MediaForgeError('HTTP license fetch must be a function', 'FORMAT');
    if (credentials !== undefined && !['omit', 'same-origin', 'include'].includes(credentials)) {
        throw new MediaForgeError('Invalid HTTP license credentials mode', 'FORMAT');
    }
    const limit = positive(maxResponseBytes, 1024 * 1024, 'maxResponseBytes');
    const timeout = positive(timeoutMs, 30000, 'timeoutMs');
    if (timeout > 0x7fffffff)
        throw new MediaForgeError('timeoutMs exceeds the timer range', 'FORMAT');
    let requestHeaders;
    try {
        requestHeaders = new Headers(headers);
    }
    catch {
        throw new MediaForgeError('Invalid HTTP license headers', 'FORMAT');
    }
    if (!requestHeaders.has('Content-Type'))
        requestHeaders.set('Content-Type', 'application/octet-stream');
    const send = fetcher.bind(customFetch === undefined ? globalThis : options);
    return async (request) => {
        const { signal, message } = request;
        if (!signal ||
            typeof signal.aborted !== 'boolean' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function') {
            throw new MediaForgeError('HTTP license request requires an AbortSignal', 'FORMAT');
        }
        const aborted = () => outputError(signal.reason, 'HTTP license request aborted', 'ABORT');
        if (signal.aborted)
            throw aborted();
        if (!outputByteLength(message))
            throw new MediaForgeError('HTTP license challenge must not be empty', 'IO');
        const challenge = copyOutputBytes(message);
        const lease = new AbortController();
        let failure;
        const fail = (reason) => (failure ??= outputError(reason, 'HTTP license request failed'));
        const observe = (pending) => Promise.resolve(pending).catch(reason => {
            throw fail(reason);
        });
        const onAbort = () => lease.abort(fail(aborted()));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted)
            onAbort();
        const expired = createDeadline(timeout);
        const onTimeout = () => lease.abort(fail(new MediaForgeError('HTTP license request timed out', 'IO')));
        const timer = setTimeout(onTimeout, timeout);
        const check = () => {
            if (!failure && expired())
                onTimeout();
            if (failure)
                throw failure;
        };
        let response;
        let reader;
        let cancelled = false;
        let finished = false;
        const cancel = () => {
            if (cancelled)
                return;
            cancelled = true;
            try {
                void Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => undefined);
            }
            catch { }
        };
        const pending = Promise.resolve().then(() => {
            check();
            try {
                return observe(send(address, {
                    method: 'POST',
                    body: challenge,
                    headers: new Headers(requestHeaders),
                    credentials,
                    signal: lease.signal,
                }));
            }
            catch (error) {
                throw fail(error);
            }
        });
        void pending.then(result => {
            response = result;
            if (lease.signal.aborted)
                cancel();
        }, () => undefined);
        try {
            await awaitWithAbort(pending, lease.signal);
            check();
            if (!response.ok)
                throw new MediaForgeError(`HTTP license request failed with status ${response.status}`, 'IO');
            if (response.status === 206 || response.headers.get('Content-Range') !== null) {
                throw new MediaForgeError('HTTP license server returned an unexpected partial response', 'IO');
            }
            const lengthHeader = response.headers.get('Content-Length');
            let declared;
            if (lengthHeader !== null) {
                if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(Number(lengthHeader))) {
                    throw new MediaForgeError('HTTP license response has an invalid Content-Length', 'IO');
                }
                declared = Number(lengthHeader);
                if (declared > limit)
                    throw new MediaForgeError('HTTP license response exceeds its byte limit', 'OOM');
            }
            const chunks = [];
            let page;
            let used = 0;
            let length = 0;
            let emptyChunks = 0;
            let reads = 0;
            let lastYield = Date.now();
            const body = response.body;
            if (body) {
                reader = body.getReader();
                while (true) {
                    if (++reads % 256 === 0 && Date.now() - lastYield >= 8) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                        check();
                        lastYield = Date.now();
                    }
                    check();
                    const item = await awaitWithAbort(observe(reader.read()), lease.signal);
                    check();
                    if (item.done)
                        break;
                    const chunk = item.value;
                    const count = outputByteLength(chunk);
                    if (count > limit - length)
                        throw new MediaForgeError('HTTP license response exceeds its byte limit', 'OOM');
                    if (!count) {
                        if (++emptyChunks > 1024)
                            throw new MediaForgeError('HTTP license response contains too many empty chunks', 'IO');
                        continue;
                    }
                    emptyChunks = 0;
                    if (!page || count > page.length - used) {
                        if (page)
                            chunks[chunks.length - 1] = page.subarray(0, used);
                        page = new Uint8Array(Math.min(limit - length, Math.max(65536, count)));
                        chunks.push(page);
                        used = 0;
                    }
                    page.set(chunk, used);
                    used += count;
                    length += count;
                }
            }
            const encoding = response.headers.get('Content-Encoding');
            if (declared !== undefined &&
                (!encoding || encoding.trim().toLowerCase() === 'identity') &&
                length !== declared) {
                throw new MediaForgeError('HTTP license response was truncated or has an invalid Content-Length', 'IO');
            }
            if (!length)
                throw new MediaForgeError('HTTP license response must not be empty', 'IO');
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (let index = 0; index < chunks.length; index++) {
                const chunk = index === chunks.length - 1 ? chunks[index].subarray(0, used) : chunks[index];
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            check();
            finished = true;
            return bytes;
        }
        catch (error) {
            throw fail(error);
        }
        finally {
            clearTimeout(timer);
            try {
                signal.removeEventListener('abort', onAbort);
            }
            catch { }
            if (!finished && response)
                cancel();
            try {
                reader?.releaseLock();
            }
            catch { }
        }
    };
}
