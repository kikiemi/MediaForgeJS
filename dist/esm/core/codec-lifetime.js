import { MediaForgeError } from './errors.js';
export class CodecLifetime {
    signal;
    stoppedError;
    failure = null;
    stopped = false;
    listening = false;
    waiters = new Set();
    onAbort = () => {
        this.record(new MediaForgeError('Aborted', 'ABORT'));
    };
    constructor(signal, stoppedError = new MediaForgeError('Codec operation stopped', 'DECODE')) {
        this.signal = signal;
        this.stoppedError = stoppedError;
        if (signal?.aborted)
            this.onAbort();
        else if (signal) {
            signal.addEventListener('abort', this.onAbort, { once: true });
            this.listening = true;
        }
    }
    get acceptingOutput() {
        return !this.stopped && !this.failure && !this.signal?.aborted;
    }
    record(caught) {
        const error = this.failure ?? (caught instanceof Error ? caught : new Error(String(caught)));
        if (!this.stopped && !this.failure) {
            this.failure = error;
            this.notify(error);
        }
        return error;
    }
    check() {
        if (!this.failure && !this.stopped && this.signal?.aborted)
            this.onAbort();
        if (this.failure)
            throw this.failure;
        if (this.stopped)
            throw this.stoppedError;
    }
    async waitFor(pending) {
        let rejectWait = () => undefined;
        const failed = new Promise((_resolve, reject) => {
            rejectWait = reject;
            if (this.failure || this.stopped)
                reject(this.failure ?? this.stoppedError);
            else
                this.waiters.add(reject);
        });
        try {
            const value = await Promise.race([Promise.resolve(pending), failed]);
            this.check();
            return value;
        }
        catch (error) {
            if (this.stopped)
                throw this.failure ?? this.stoppedError;
            throw this.record(error);
        }
        finally {
            this.waiters.delete(rejectWait);
        }
    }
    stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        if (this.listening) {
            this.signal.removeEventListener('abort', this.onAbort);
            this.listening = false;
        }
        this.notify(this.failure ?? this.stoppedError);
    }
    notify(error) {
        for (const reject of this.waiters)
            reject(error);
        this.waiters.clear();
    }
}
