import { MediaForgeError } from '../../core/errors/errors';
import { awaitWithAbort } from '../../core/io/abort';

export interface ProcessOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

export function formatError(message: string): never {
    throw new MediaForgeError(message, 'FORMAT');
}

export function integer(
    value: number | undefined,
    fallback: number,
    name: string,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
): number {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result < min || result > max)
        formatError(`${name} must be an integer from ${min} to ${max}`);
    return result;
}

export function processOptions(
    options: ProcessOptions,
): Required<Pick<ProcessOptions, 'timeoutMs'>> & ProcessOptions {
    const signal = options.signal;
    const timeoutMs = integer(options.timeoutMs, 120000, 'timeoutMs', 1, 2147483647);
    if (
        signal !== undefined &&
        (!signal ||
            typeof signal.aborted !== 'boolean' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function')
    ) {
        formatError('signal must be an AbortSignal');
    }
    return { signal, timeoutMs };
}

/** One operation owns its process, timers and cancellation; borrowed I/O remains caller-owned. */
export class FFmpegOperation {
    private readonly controller = new AbortController();
    private readonly removers: Array<() => void> = [];
    private readonly timer: ReturnType<typeof setTimeout>;
    private failed = false;
    private failure: unknown;
    readonly signal = this.controller.signal;

    constructor(options: ReturnType<typeof processOptions>, extraSignal?: AbortSignal) {
        this.timer = setTimeout(
            () => this.fail(new MediaForgeError('FFmpeg operation timed out', 'ABORT')),
            options.timeoutMs,
        );
        try {
            for (const signal of [options.signal, extraSignal]) {
                if (!signal) continue;
                if (signal.aborted) {
                    this.fail(new MediaForgeError('FFmpeg operation aborted', 'ABORT'));
                    break;
                }

                const abort = (): void =>
                    this.fail(new MediaForgeError('FFmpeg operation aborted', 'ABORT'));
                this.removers.push(() => signal.removeEventListener('abort', abort));
                signal.addEventListener('abort', abort, { once: true });
            }
        } catch (error) {
            this.dispose();
            throw error;
        }
    }

    fail(error: unknown): void {
        if (this.failed) return;
        this.failed = true;
        this.failure = error;
        this.controller.abort();
    }

    check(): void {
        if (this.failed) throw this.failure;
    }

    async wait<T>(pending: PromiseLike<T>): Promise<T> {
        try {
            const value = await awaitWithAbort(pending, this.signal);
            this.check();
            return value;
        } catch (error) {
            this.check();
            throw error;
        }
    }

    dispose(): void {
        clearTimeout(this.timer);
        for (const remove of this.removers.splice(0)) {
            try {
                remove();
            } catch {}
        }
    }
}

interface NativeReadable extends AsyncIterable<Uint8Array> {
    on(event: 'error', listener: (error: unknown) => void): void;
    destroy(): void;
}

interface NativeChild {
    readonly pid?: number;
    stdout: NativeReadable;
    stderr: NativeReadable;
    kill(signal: string): boolean;
    once(event: 'error', listener: (error: unknown) => void): void;
    once(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
}

const STDERR_LIMIT = 65536;

/** Starts a trusted host executable with literal arguments, then reaps it before returning. */
export async function runFFmpegProcess(
    executable: string,
    args: string[],
    operation: FFmpegOperation,
    output: (bytes: Uint8Array) => Promise<void>,
    workingDirectory?: string,
): Promise<void> {
    operation.check();
    const moduleName = 'node:child_process';
    const processName = 'node:process';
    const [nativeModule, processModule] = await Promise.all([
        import(moduleName),
        import(processName),
    ]);
    const native = nativeModule as {
        spawn(
            file: string,
            args: string[],
            options: {
                shell: false;
                windowsHide: true;
                detached: boolean;
                cwd?: string;
                stdio: ['ignore', 'pipe', 'pipe'];
            },
        ): NativeChild;
    };
    const host = processModule as {
        platform: string;
        kill(pid: number, signal: string | number): boolean;
    };

    operation.check();
    const grouped = host.platform !== 'win32';
    const child = native.spawn(executable, args, {
        shell: false,
        windowsHide: true,
        detached: grouped,
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = new Uint8Array(0);
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let escalation: Promise<void> | undefined;
    let finishEscalation = (): void => undefined;

    const groupExists = (): boolean => {
        if (!grouped || child.pid === undefined) return false;
        try {
            host.kill(-child.pid, 0);
            return true;
        } catch (error) {
            return (error as { code?: string })?.code !== 'ESRCH';
        }
    };
    const kill = (signal: string): void => {
        if (grouped && child.pid !== undefined) {
            try {
                host.kill(-child.pid, signal);
                return;
            } catch {}
        }
        try {
            child.kill(signal);
        } catch {}
    };
    const stop = (): void => {
        if (killTimer !== undefined || (exited && !groupExists())) return;
        escalation = new Promise(resolve => {
            finishEscalation = resolve;
        });
        kill('SIGTERM');
        killTimer = setTimeout(() => {
            kill('SIGKILL');
            child.stdout.destroy();
            child.stderr.destroy();
            finishEscalation();
        }, 500);
    };

    const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
        child.once('error', error => operation.fail(error));
        child.once('close', (code, signal) => {
            exited = true;
            resolve({ code, signal });
        });
    });

    operation.signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('error', error => operation.fail(error));
    child.stderr.on('error', error => operation.fail(error));

    const readError = async (): Promise<void> => {
        try {
            for await (const bytes of child.stderr) {
                const keep = Math.min(STDERR_LIMIT, bytes.byteLength);
                const previous = Math.min(stderr.byteLength, STDERR_LIMIT - keep);
                const next = new Uint8Array(previous + keep);
                next.set(stderr.subarray(stderr.byteLength - previous));
                next.set(bytes.subarray(bytes.byteLength - keep), previous);
                stderr = next;
            }
        } catch (error) {
            operation.fail(error);
        }
    };
    const readOutput = async (): Promise<void> => {
        try {
            for await (const bytes of child.stdout) {
                operation.check();
                await operation.wait(output(bytes));
            }
        } catch (error) {
            operation.fail(error);
        }
    };

    const tasks = [readError(), readOutput()];
    if (operation.signal.aborted) stop();
    try {
        const result = await closed;
        if (result.code !== 0) {
            operation.fail(
                new MediaForgeError(
                    `FFmpeg failed with ${result.code ?? result.signal ?? 'an unknown status'}`,
                    'IO',
                    { cause: new Error(new TextDecoder().decode(stderr).trim()) },
                ),
            );
        }

        await Promise.all(tasks);
        if (killTimer !== undefined && !groupExists()) {
            clearTimeout(killTimer);
            finishEscalation();
        }
        await escalation;
        operation.check();
    } finally {
        operation.signal.removeEventListener('abort', stop);
        if (killTimer !== undefined) clearTimeout(killTimer);
    }
}

export async function captureFFmpegProcess(
    executable: string,
    args: string[],
    operation: FFmpegOperation,
    maxBytes: number,
): Promise<string> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    await runFFmpegProcess(executable, args, operation, async bytes => {
        if (bytes.byteLength > maxBytes - length)
            throw new MediaForgeError('FFmpeg response exceeds its byte limit', 'IO');
        chunks.push(new Uint8Array(bytes));
        length += bytes.byteLength;
    });
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}
