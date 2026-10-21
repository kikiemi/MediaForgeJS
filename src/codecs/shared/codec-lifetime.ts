import { MediaForgeError, abortError } from '../../core/errors/errors';

export class CodecLifetime {
    private failure: Error | null = null;
    private stopped = false;
    private listening = false;
    private readonly waiters = new Set<(error: Error) => void>();
    private readonly onAbort = (): void => {
        this.record(abortError(this.signal!));
    };

    constructor(
        private readonly signal?: AbortSignal,
        private readonly stoppedError: Error = new MediaForgeError(
            'Codec operation stopped',
            'DECODE',
        ),
    ) {
        if (signal?.aborted) this.onAbort();
        else if (signal) {
            signal.addEventListener('abort', this.onAbort, { once: true });
            this.listening = true;
        }
    }

    get acceptingOutput(): boolean {
        return !this.stopped && !this.failure && !this.signal?.aborted;
    }

    record(caught: unknown): Error {
        const error =
            this.failure ?? (caught instanceof Error ? caught : new Error(String(caught)));
        if (!this.stopped && !this.failure) {
            this.failure = error;
            this.notify(error);
        }
        return error;
    }

    check(): void {
        if (!this.failure && !this.stopped && this.signal?.aborted) this.onAbort();
        if (this.failure) throw this.failure;
        if (this.stopped) throw this.stoppedError;
    }

    async waitFor<T>(pending: PromiseLike<T>): Promise<T> {
        let rejectWait: (error: Error) => void = () => undefined;
        const failed = new Promise<never>((_resolve, reject) => {
            rejectWait = reject;
            if (this.failure || this.stopped) reject(this.failure ?? this.stoppedError);
            else this.waiters.add(reject);
        });
        try {
            const value = await Promise.race([Promise.resolve(pending), failed]);
            this.check();
            return value;
        } catch (error) {
            if (this.stopped) throw this.failure ?? this.stoppedError;
            throw this.record(error);
        } finally {
            this.waiters.delete(rejectWait);
        }
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.listening) {
            this.signal!.removeEventListener('abort', this.onAbort);
            this.listening = false;
        }
        this.notify(this.failure ?? this.stoppedError);
    }

    private notify(error: Error): void {
        for (const reject of this.waiters) reject(error);
        this.waiters.clear();
    }
}
