import { MediaForgeError } from '../core/errors.js';
import { awaitWithAbort } from '../core/abort.js';
export function formatError(message) {
    throw new MediaForgeError(message, 'FORMAT');
}
export function integer(value, fallback, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result < min || result > max)
        formatError(`${name} must be an integer from ${min} to ${max}`);
    return result;
}
export function processOptions(options) {
    const signal = options.signal;
    const timeoutMs = integer(options.timeoutMs, 120000, 'timeoutMs', 1, 2147483647);
    if (signal !== undefined &&
        (!signal ||
            typeof signal.aborted !== 'boolean' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function')) {
        formatError('signal must be an AbortSignal');
    }
    return { signal, timeoutMs };
}
export class FFmpegOperation {
    controller = new AbortController();
    removers = [];
    timer;
    failed = false;
    failure;
    signal = this.controller.signal;
    constructor(options, extraSignal) {
        this.timer = setTimeout(() => this.fail(new MediaForgeError('FFmpeg operation timed out', 'ABORT')), options.timeoutMs);
        try {
            for (const signal of [options.signal, extraSignal]) {
                if (!signal)
                    continue;
                if (signal.aborted) {
                    this.fail(new MediaForgeError('FFmpeg operation aborted', 'ABORT'));
                    break;
                }
                const abort = () => this.fail(new MediaForgeError('FFmpeg operation aborted', 'ABORT'));
                this.removers.push(() => signal.removeEventListener('abort', abort));
                signal.addEventListener('abort', abort, { once: true });
            }
        }
        catch (error) {
            this.dispose();
            throw error;
        }
    }
    fail(error) {
        if (this.failed)
            return;
        this.failed = true;
        this.failure = error;
        this.controller.abort();
    }
    check() {
        if (this.failed)
            throw this.failure;
    }
    async wait(pending) {
        try {
            const value = await awaitWithAbort(pending, this.signal);
            this.check();
            return value;
        }
        catch (error) {
            this.check();
            throw error;
        }
    }
    dispose() {
        clearTimeout(this.timer);
        for (const remove of this.removers.splice(0)) {
            try {
                remove();
            }
            catch { }
        }
    }
}
const STDERR_LIMIT = 65536;
export async function runFFmpegProcess(executable, args, operation, output, workingDirectory) {
    operation.check();
    const moduleName = 'node:child_process';
    const processName = 'node:process';
    const [nativeModule, processModule] = await Promise.all([import(moduleName), import(processName)]);
    const native = nativeModule;
    const host = processModule;
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
    let killTimer;
    let escalation;
    let finishEscalation = () => undefined;
    const groupExists = () => {
        if (!grouped || child.pid === undefined)
            return false;
        try {
            host.kill(-child.pid, 0);
            return true;
        }
        catch (error) {
            return error?.code !== 'ESRCH';
        }
    };
    const kill = (signal) => {
        if (grouped && child.pid !== undefined) {
            try {
                host.kill(-child.pid, signal);
                return;
            }
            catch { }
        }
        try {
            child.kill(signal);
        }
        catch { }
    };
    const stop = () => {
        if (killTimer !== undefined || (exited && !groupExists()))
            return;
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
    const closed = new Promise(resolve => {
        child.once('error', error => operation.fail(error));
        child.once('close', (code, signal) => {
            exited = true;
            resolve({ code, signal });
        });
    });
    operation.signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('error', error => operation.fail(error));
    child.stderr.on('error', error => operation.fail(error));
    const readError = async () => {
        try {
            for await (const bytes of child.stderr) {
                const keep = Math.min(STDERR_LIMIT, bytes.byteLength);
                const previous = Math.min(stderr.byteLength, STDERR_LIMIT - keep);
                const next = new Uint8Array(previous + keep);
                next.set(stderr.subarray(stderr.byteLength - previous));
                next.set(bytes.subarray(bytes.byteLength - keep), previous);
                stderr = next;
            }
        }
        catch (error) {
            operation.fail(error);
        }
    };
    const readOutput = async () => {
        try {
            for await (const bytes of child.stdout) {
                operation.check();
                await operation.wait(output(bytes));
            }
        }
        catch (error) {
            operation.fail(error);
        }
    };
    const tasks = [readError(), readOutput()];
    if (operation.signal.aborted)
        stop();
    try {
        const result = await closed;
        if (result.code !== 0) {
            operation.fail(new MediaForgeError(`FFmpeg process failed (${result.code ?? result.signal ?? 'unknown'}): ${new TextDecoder().decode(stderr).trim()}`, 'IO'));
        }
        await Promise.all(tasks);
        if (killTimer !== undefined && !groupExists()) {
            clearTimeout(killTimer);
            finishEscalation();
        }
        await escalation;
        operation.check();
    }
    finally {
        operation.signal.removeEventListener('abort', stop);
        if (killTimer !== undefined)
            clearTimeout(killTimer);
    }
}
export async function captureFFmpegProcess(executable, args, operation, maxBytes) {
    const chunks = [];
    let length = 0;
    await runFFmpegProcess(executable, args, operation, async (bytes) => {
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
