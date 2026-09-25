export function checkAbort(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

export function validateSignal(signal) {
    if (signal == null) return;
    if (
        typeof signal !== 'object' ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function'
    ) {
        throw new TypeError('signal must be AbortSignal-compatible');
    }
}

export function yieldTask() {
    if (typeof globalThis.scheduler?.yield === 'function') return globalThis.scheduler.yield();
    if (typeof globalThis.setImmediate === 'function') return new Promise(resolve => globalThis.setImmediate(resolve));
    return new Promise(resolve => setTimeout(resolve, 0));
}

export function timing(value) {
    if (!Number.isFinite(value?.timestamp)) throw new TypeError('A finite timestamp in seconds is required');
    if (!Number.isFinite(value?.duration) || value.duration < 0)
        throw new TypeError('A nonnegative duration in seconds is required');
}

export function positiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > max)
        throw new RangeError(`${name} must be a positive integer at most ${max}`);
    return value;
}

export class CodecQueue {
    constructor(signal, maxQueueSize, dispose) {
        this.signal = signal;
        this.limit = positiveInteger(maxQueueSize ?? 4, 'maxQueueSize', 1024);
        this.dispose = dispose;
        this.pending = 0;
        this.closed = false;
        this.tail = Promise.resolve();
        this.stop = () => {
            void this.close().catch(() => {});
        };
        try {
            signal?.addEventListener('abort', this.stop, { once: true });
        } catch (error) {
            try {
                signal?.removeEventListener('abort', this.stop);
            } catch {}
            throw error;
        }
    }

    check() {
        checkAbort(this.signal);
        if (this.closed) throw new Error('ProRes codec is closed');
    }

    run(prepare, work) {
        try {
            this.check();
            if (this.pending >= this.limit)
                throw new RangeError('ProRes queue is full; await pending work to apply backpressure');
            const input = prepare();
            this.pending++;
            const result = this.tail
                .then(async () => {
                    this.check();
                    return work(input);
                })
                .finally(() => {
                    this.pending--;
                });
            this.tail = result.then(
                () => {},
                () => {},
            );
            return result;
        } catch (error) {
            return Promise.reject(error);
        }
    }

    async flush() {
        this.check();
        await this.tail;
        this.check();
    }

    close() {
        if (!this.closing) {
            this.closed = true;
            this.signal?.removeEventListener('abort', this.stop);
            this.closing = this.tail.then(this.dispose);
        }
        return this.closing;
    }
}
