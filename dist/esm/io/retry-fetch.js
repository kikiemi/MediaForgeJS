import { IOError } from '../core/errors.js';
const retryStatuses = new Set([408, 429, 500, 502, 503, 504]);
const weekDay = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const clock = '\\d{2}:\\d{2}:\\d{2}';
const httpDate = new RegExp(`^(?:${weekDay}, \\d{2} ${month} \\d{4} ${clock} GMT` +
    `|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} ${clock} GMT` +
    `|${weekDay} ${month} (?: \\d|\\d{2}) ${clock} \\d{4})$`);
const requestFields = [
    'body',
    'cache',
    'credentials',
    'headers',
    'integrity',
    'keepalive',
    'method',
    'mode',
    'redirect',
    'referrer',
    'referrerPolicy',
    'signal',
    'window',
    'priority',
    'duplex',
];
function integer(value, fallback, maximum, name) {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
        throw new IOError(`${name} must be a non-negative safe integer no greater than ${maximum}`);
    }
    return result;
}
function cancel(response) {
    try {
        void Promise.resolve(response.body?.cancel()).catch(() => undefined);
    }
    catch { }
}
function checkAbort(signal) {
    if (signal?.aborted)
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
async function wait(pending, signal) {
    if (!signal)
        return pending;
    let rejectAbort = () => undefined;
    const stopped = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted)
        onAbort();
    try {
        return await Promise.race([pending, stopped]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
async function delay(milliseconds, signal) {
    let timer;
    try {
        await wait(new Promise(resolve => {
            timer = setTimeout(resolve, milliseconds);
        }), signal);
    }
    finally {
        clearTimeout(timer);
    }
}
function retryAfter(response) {
    const value = response.headers.get('Retry-After');
    if (value === null)
        return 0;
    if (/^\d+$/.test(value))
        return Number(value) * 1000;
    if (!httpDate.test(value))
        return 0;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
export function createRetryFetch(options = {}) {
    if (!options || typeof options !== 'object')
        throw new IOError('Retry fetch options must be an object');
    const { fetch: customFetch, maxRetries, baseDelayMs, maxDelayMs } = options;
    const fetcher = customFetch === undefined ? globalThis.fetch : customFetch;
    if (typeof fetcher !== 'function')
        throw new IOError('Retry fetch requires a fetch function');
    const retries = integer(maxRetries, 2, 10, 'maxRetries');
    const baseDelay = integer(baseDelayMs, 250, 0x7fffffff, 'baseDelayMs');
    const maxDelay = integer(maxDelayMs, 10000, 0x7fffffff, 'maxDelayMs');
    const send = fetcher.bind(customFetch === undefined ? globalThis : options);
    return async (input, init) => {
        const settings = { ...init };
        for (const field of requestFields) {
            if (init && !Object.hasOwn(settings, field)) {
                const value = Reflect.get(init, field);
                if (value !== undefined)
                    Reflect.set(settings, field, value);
            }
        }
        if (settings.method !== undefined)
            settings.method = String(settings.method);
        const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
        const method = String(settings.method ?? request?.method ?? 'GET').toUpperCase();
        const replayable = (method === 'GET' || method === 'HEAD') && (settings.body ?? request?.body) == null;
        const headers = new Headers(settings.headers === undefined ? request?.headers : settings.headers);
        const signal = settings.signal === undefined ? request?.signal : settings.signal;
        const target = request && replayable ? new Request(request) : (request ?? String(input));
        for (let attempt = 0;; attempt++) {
            checkAbort(signal);
            const backoff = Math.min(maxDelay, baseDelay * 2 ** attempt);
            let response;
            let discarded = false;
            const dispose = () => {
                if (response && !discarded) {
                    discarded = true;
                    cancel(response);
                }
            };
            const pending = (async () => {
                checkAbort(signal);
                return send(request && replayable ? new Request(target) : target, {
                    ...settings,
                    headers: new Headers(headers),
                    signal,
                });
            })();
            void pending.then(result => {
                response = result;
                if (signal?.aborted)
                    dispose();
            }, () => undefined);
            try {
                response = await wait(pending, signal);
                checkAbort(signal);
            }
            catch (error) {
                if (signal?.aborted)
                    dispose();
                checkAbort(signal);
                if (!replayable || attempt >= retries || !(error instanceof TypeError))
                    throw error;
                await delay(backoff, signal);
                continue;
            }
            try {
                if (!response ||
                    typeof response !== 'object' ||
                    !Number.isInteger(response.status) ||
                    response.status < 0 ||
                    response.status > 599 ||
                    typeof response.headers?.get !== 'function') {
                    throw new IOError('Retry fetch callback must return a Response');
                }
                if (!replayable || attempt >= retries || !retryStatuses.has(response.status))
                    return response;
            }
            catch (error) {
                dispose();
                throw error;
            }
            let requiredDelay;
            try {
                requiredDelay = retryAfter(response);
            }
            catch (error) {
                dispose();
                throw error;
            }
            if (requiredDelay > maxDelay)
                return response;
            const milliseconds = Math.max(requiredDelay, backoff);
            dispose();
            await delay(milliseconds, signal);
        }
    };
}
