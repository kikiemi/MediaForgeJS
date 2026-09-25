import { MediaForgeError } from '../core/errors.js';
import { copyOutputBytes, outputByteLength, outputByteLimit, outputError } from './output-data.js';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const buffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
export class MemorySink {
    chunks = [];
    ends = [];
    length = 0;
    maxBytes;
    constructor(options = {}) {
        let maxBytes;
        try {
            if (!options || typeof options !== 'object')
                throw new Error();
            maxBytes = options.maxBytes;
        }
        catch {
            throw new MediaForgeError('expected MemorySink options', 'IO');
        }
        this.maxBytes = outputByteLimit(maxBytes);
    }
    write(data) {
        const count = outputByteLength(data);
        if (count === 0)
            return;
        if (!Number.isSafeInteger(this.length + count))
            throw new MediaForgeError('output is too large', 'IO');
        if (count > this.maxBytes - this.length)
            throw new MediaForgeError('output exceeds maxBytes', 'OOM');
        const index = this.chunks.length - 1;
        const previous = this.chunks[index];
        const used = previous ? this.length - (this.ends[index - 1] ?? 0) : 0;
        const appended = previous ? Math.min(count, previous.byteLength - used) : 0;
        const remaining = count - appended;
        const sourceBuffer = buffer.call(data);
        const sourceStart = byteOffset.call(data);
        let next;
        try {
            if (remaining > 0) {
                const slabBytes = Math.min(64 * 1024, Math.max(4096, this.length));
                const capacity = Math.min(this.maxBytes - this.length - appended, Math.max(remaining, slabBytes));
                next = new Uint8Array(capacity);
                next.set(new Uint8Array(sourceBuffer, sourceStart + appended, remaining));
            }
            if (appended > 0) {
                new Uint8Array(previous, used, appended).set(new Uint8Array(sourceBuffer, sourceStart, appended));
            }
        }
        catch {
            throw new MediaForgeError('could not allocate output bytes', 'OOM');
        }
        if (appended > 0) {
            this.length += appended;
            this.ends[index] = this.length;
        }
        if (next) {
            this.chunks.push(next.buffer);
            this.length += remaining;
            this.ends.push(this.length);
        }
    }
    get size() {
        return this.length;
    }
    async close() { }
    patchAt(offset, data) {
        const count = outputByteLength(data);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.length || count > this.length - offset) {
            throw new MediaForgeError('patchAt range exceeds the bytes written', 'IO');
        }
        if (count === 0)
            return;
        const sourceBuffer = buffer.call(data);
        const sourceStart = byteOffset.call(data);
        let low = 0;
        let high = this.ends.length;
        while (low < high) {
            const mid = low + Math.floor((high - low) / 2);
            if (this.ends[mid] <= offset)
                low = mid + 1;
            else
                high = mid;
        }
        let chunkStart = low === 0 ? 0 : this.ends[low - 1];
        let sourceOffset = 0;
        for (let index = low; sourceOffset < count; index++) {
            const chunk = this.chunks[index];
            const inChunk = offset + sourceOffset - chunkStart;
            const size = Math.min(this.ends[index] - chunkStart - inChunk, count - sourceOffset);
            new Uint8Array(chunk, inChunk, size).set(new Uint8Array(sourceBuffer, sourceStart + sourceOffset, size));
            sourceOffset += size;
            chunkStart = this.ends[index];
        }
    }
    toBlob(mimeType) {
        return new Blob(this.chunks.map((chunk, index) => new Uint8Array(chunk, 0, this.ends[index] - (this.ends[index - 1] ?? 0))), { type: mimeType });
    }
    toUint8Array() {
        const out = new Uint8Array(this.length);
        let offset = 0;
        for (let index = 0; index < this.chunks.length; index++) {
            out.set(new Uint8Array(this.chunks[index], 0, this.ends[index] - offset), offset);
            offset = this.ends[index];
        }
        return out;
    }
}
export class StreamSink {
    writer;
    writeOutput;
    closeOutput;
    abortOutput;
    pending = Promise.resolve();
    queuedBytes = 0;
    highWaterMark;
    drainWaiters = [];
    failureWaiters = new Set();
    abortPromise = null;
    closePromise = null;
    closed = false;
    appendPos = 0;
    failure = null;
    constructor(writer, options) {
        try {
            this.writeOutput = writer.write;
            this.closeOutput = writer.close;
            this.abortOutput = writer.abort;
            if (typeof this.writeOutput !== 'function' ||
                typeof this.closeOutput !== 'function' ||
                (this.abortOutput !== undefined && typeof this.abortOutput !== 'function'))
                throw new Error();
        }
        catch {
            throw new MediaForgeError('writer must provide write(), close() and an optional abort()', 'IO');
        }
        this.writer = writer;
        const highWaterMark = options?.highWaterMark ?? 8 * 1024 * 1024;
        if (!Number.isFinite(highWaterMark) || highWaterMark <= 0) {
            throw new MediaForgeError('highWaterMark must be a positive finite number', 'IO');
        }
        this.highWaterMark = highWaterMark;
    }
    assertHealthy() {
        if (this.failure)
            throw this.failure;
    }
    assertWritable() {
        this.assertHealthy();
        if (this.closePromise)
            throw new MediaForgeError('output sink is closing or closed', 'IO');
    }
    fail(reason) {
        if (!this.failure)
            this.failure = outputError(reason);
        for (const reject of this.failureWaiters)
            reject(this.failure);
        this.failureWaiters.clear();
        this.wakeDrainWaiters();
        return this.failure;
    }
    async waitFor(pending) {
        let rejectWait = () => undefined;
        const failed = new Promise((_resolve, reject) => {
            rejectWait = reject;
            if (this.failure)
                reject(this.failure);
            else
                this.failureWaiters.add(reject);
        });
        try {
            await Promise.race([Promise.resolve(pending), failed]);
            this.assertHealthy();
        }
        catch (error) {
            throw this.fail(error);
        }
        finally {
            this.failureWaiters.delete(rejectWait);
        }
    }
    write(data) {
        this.assertWritable();
        const count = outputByteLength(data);
        if (count === 0)
            return;
        if (!Number.isSafeInteger(this.appendPos + count))
            throw new MediaForgeError('output is too large', 'IO');
        const chunk = copyOutputBytes(data).buffer;
        const position = this.appendPos;
        this.appendPos += count;
        this.enqueueWrite(position, chunk);
    }
    patchAt(offset, data) {
        this.assertWritable();
        const count = outputByteLength(data);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.appendPos || count > this.appendPos - offset) {
            throw new MediaForgeError('patchAt range exceeds the bytes written', 'IO');
        }
        if (count === 0)
            return;
        this.enqueueWrite(offset, copyOutputBytes(data).buffer);
    }
    abort(reason) {
        if (this.closed)
            return Promise.resolve();
        this.fail(reason ?? new MediaForgeError('Output sink was aborted', 'ABORT'));
        if (!this.abortPromise) {
            let resolveAbort = () => undefined;
            this.abortPromise = new Promise(resolve => {
                resolveAbort = resolve;
            });
            try {
                Promise.resolve(this.abortOutput?.call(this.writer, reason)).then(resolveAbort, resolveAbort);
            }
            catch {
                resolveAbort();
            }
        }
        return this.abortPromise;
    }
    drain() {
        try {
            this.assertHealthy();
        }
        catch (error) {
            return Promise.reject(error);
        }
        if (this.queuedBytes < this.highWaterMark)
            return Promise.resolve();
        return new Promise(resolve => this.drainWaiters.push(resolve)).then(() => this.assertHealthy());
    }
    close() {
        if (!this.closePromise) {
            this.closePromise = this.waitFor(this.pending).then(async () => {
                this.assertHealthy();
                try {
                    await this.waitFor(this.closeOutput.call(this.writer));
                }
                catch (error) {
                    throw this.fail(error);
                }
                this.closed = true;
            });
        }
        return this.closePromise;
    }
    get done() {
        return this.waitFor(this.pending);
    }
    enqueueWrite(position, chunk) {
        this.queuedBytes += chunk.byteLength;
        this.pending = this.pending.then(async () => {
            try {
                if (!this.failure)
                    await this.waitFor(this.writeOutput.call(this.writer, { type: 'write', position, data: chunk }));
            }
            catch (error) {
                this.fail(error);
            }
            finally {
                this.queuedBytes -= chunk.byteLength;
                if (this.failure || this.queuedBytes < this.highWaterMark)
                    this.wakeDrainWaiters();
            }
        });
    }
    wakeDrainWaiters() {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const waiter of waiters)
            waiter();
    }
    static async fromPicker(suggestedName) {
        const host = globalThis;
        if (typeof host.showSaveFilePicker !== 'function') {
            throw new MediaForgeError('Save-file picker is unavailable; use a Blob download or a writable stream', 'IO');
        }
        const handle = await host.showSaveFilePicker({ suggestedName });
        const writable = await handle.createWritable();
        return new StreamSink(writable);
    }
    static async fromOPFS(name) {
        if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
            throw new MediaForgeError('OPFS is unavailable; use a Blob download or a writable stream', 'IO');
        }
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle(name, { create: true });
        const writable = await file.createWritable();
        return new StreamSink(writable);
    }
}
