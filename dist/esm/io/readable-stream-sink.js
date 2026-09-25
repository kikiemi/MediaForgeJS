import { MediaForgeError } from '../core/errors.js';
import { copyOutputBytes, outputByteLength, outputByteLimit, outputError } from './output-data.js';
export class ReadableStreamSink {
    stream;
    controller;
    waiters = [];
    failure = null;
    maxBytes;
    writtenBytes = 0;
    closed = false;
    consumerCancelled = false;
    cancellation = new AbortController();
    get signal() {
        return this.cancellation.signal;
    }
    constructor(options = {}) {
        let highWaterMark;
        let maxBytes;
        try {
            if (!options || typeof options !== 'object' || Array.isArray(options))
                throw new Error();
            highWaterMark = options.highWaterMark;
            maxBytes = options.maxBytes;
        }
        catch {
            throw new MediaForgeError('expected ReadableStreamSink options', 'IO');
        }
        if (highWaterMark === undefined)
            highWaterMark = 1024 * 1024;
        this.maxBytes = outputByteLimit(maxBytes);
        if (!Number.isFinite(highWaterMark) || highWaterMark <= 0) {
            throw new MediaForgeError('highWaterMark must be a positive finite number', 'IO');
        }
        this.stream = new ReadableStream({
            start: controller => {
                this.controller = controller;
            },
            pull: () => {
                this.releaseDrainsIfReady();
            },
            cancel: reason => {
                this.consumerCancelled = true;
                const abort = reason === undefined
                    ? new MediaForgeError('Output stream was cancelled', 'ABORT')
                    : outputError(reason, 'Output stream was cancelled', 'ABORT');
                this.fail(abort, false);
                this.cancellation.abort(abort);
            },
        }, {
            highWaterMark,
            size: chunk => chunk.byteLength,
        });
    }
    write(data) {
        this.assertWritable();
        const count = outputByteLength(data);
        if (count === 0)
            return;
        if (count > this.maxBytes - this.writtenBytes)
            throw new MediaForgeError('output exceeds maxBytes', 'OOM');
        const copy = copyOutputBytes(data);
        try {
            this.controller.enqueue(copy);
            this.writtenBytes += count;
        }
        catch (error) {
            throw this.fail(error, false);
        }
    }
    drain() {
        if (this.failure !== null)
            return Promise.reject(this.failure);
        if (this.closed || (this.controller.desiredSize ?? 0) > 0)
            return Promise.resolve();
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
    async close() {
        if (this.failure !== null)
            throw this.failure;
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.controller.close();
        }
        catch (error) {
            throw this.fail(error, false);
        }
        this.resolveWaiters();
    }
    async abort(reason) {
        if (this.closed)
            return;
        this.fail(reason ?? new MediaForgeError('Output stream was aborted', 'ABORT'), !this.consumerCancelled);
    }
    assertWritable() {
        if (this.failure !== null)
            throw this.failure;
        if (this.closed)
            throw new MediaForgeError('output stream is already closed', 'IO');
    }
    releaseDrainsIfReady() {
        if (this.failure !== null) {
            this.rejectWaiters(this.failure);
        }
        else if (this.closed || (this.controller.desiredSize ?? 0) > 0) {
            this.resolveWaiters();
        }
    }
    fail(reason, notifyReader) {
        this.failure ??= outputError(reason, 'output stream failed');
        const failure = this.failure;
        this.rejectWaiters(failure);
        if (notifyReader && !this.closed) {
            try {
                this.controller.error(failure);
            }
            catch { }
        }
        return failure;
    }
    resolveWaiters() {
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters)
            waiter.resolve();
    }
    rejectWaiters(reason) {
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters)
            waiter.reject(reason);
    }
}
