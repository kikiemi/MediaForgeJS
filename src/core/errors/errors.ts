/**
 * Every machine-readable error category the library emits:
 *
 * - `INPUT`: an invalid argument, or a setting rejected under the strict option policy.
 * - `FORMAT`: the format, codec or combination is not supported.
 * - `DEMUX`: the input could not be parsed.
 * - `DECODE` / `ENCODE`: no usable decoder or encoder, or it failed.
 * - `MUX` / `OUTPUT`: writing failed, or an output budget was exceeded.
 * - `IO`: reading a source or writing a sink failed.
 * - `OOM`: a memory or size limit was reached.
 * - `ABORT`: the operation was cancelled or its job was closed.
 * - `PLUGIN`: the work needs a plugin that is not in use; `plugin` names it.
 */
export type ErrorCode =
    | 'DECODE'
    | 'ENCODE'
    | 'MUX'
    | 'DEMUX'
    | 'FORMAT'
    | 'INPUT'
    | 'OUTPUT'
    | 'ABORT'
    | 'IO'
    | 'OOM'
    | 'PLUGIN';

/** The values of {@link ErrorCode}, for exhaustive handling and runtime checks. */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze([
    'INPUT',
    'FORMAT',
    'DEMUX',
    'DECODE',
    'ENCODE',
    'MUX',
    'OUTPUT',
    'IO',
    'OOM',
    'ABORT',
    'PLUGIN',
]);

export interface MediaForgeErrorOptions {
    /** The first failure when a later step reports on its behalf. */
    readonly cause?: unknown;
    /** What the caller can do about the failure, in one sentence. */
    readonly hint?: string;
    /** The plugin that would handle the input, such as 'h264'. */
    readonly plugin?: string;
}

/**
 * The error every MediaForgeJS operation rejects with. `code` is the stable category to branch on,
 * `message` says what failed and `hint`, where the library knows one, says what to do instead.
 *
 * @example
 * ```ts
 * try {
 *     await convert(file, 'mp4', { video: { codec: 'hevc' } });
 * } catch (error) {
 *     if (isMediaForgeError(error, 'ABORT')) return;
 *     if (isMediaForgeError(error)) showMessage(error.message, error.hint);
 *     else throw error;
 * }
 * ```
 */
export class MediaForgeError extends Error {
    /** Machine-readable category; see {@link ErrorCode}. */
    readonly code: ErrorCode;
    /**
     * What to do about the failure, such as a codec or container to choose instead; absent when
     * unknown.
     */
    hint?: string;
    /** With code PLUGIN: the name of the plugin to include, such as 'mxf'. */
    readonly plugin?: string;
    constructor(message: string, code: ErrorCode, options?: MediaForgeErrorOptions) {
        super(message, options && 'cause' in options ? { cause: options.cause } : undefined);
        this.name = 'MediaForgeError';
        this.code = code;
        if (options?.hint) this.hint = options.hint;
        if (options?.plugin) this.plugin = options.plugin;
    }
}

/**
 * True for a {@link MediaForgeError}, optionally of one of `codes`; narrows `error` in a `catch`
 * block.
 *
 * @example
 * ```ts
 * catch (error) {
 *     if (isMediaForgeError(error, 'ABORT')) return; // the user pressed Cancel
 *     throw error;
 * }
 * ```
 */
export function isMediaForgeError(
    error: unknown,
    ...codes: readonly ErrorCode[]
): error is MediaForgeError {
    return error instanceof MediaForgeError && (!codes.length || codes.includes(error.code));
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? 'unknown');
}

/** Container parsing failed (code 'DEMUX'). */
export class DemuxError extends MediaForgeError {
    constructor(msg: string, options?: MediaForgeErrorOptions) {
        super(msg, 'DEMUX', options);
        this.name = 'DemuxError';
    }
}

/** Decoding failed (code 'DECODE'). */
export class DecodeError extends MediaForgeError {
    constructor(msg: string, options?: MediaForgeErrorOptions) {
        super(msg, 'DECODE', options);
        this.name = 'DecodeError';
    }
}

/** Encoding failed (code 'ENCODE'). */
export class EncodeError extends MediaForgeError {
    constructor(msg: string, options?: MediaForgeErrorOptions) {
        super(msg, 'ENCODE', options);
        this.name = 'EncodeError';
    }
}

/** Muxing failed (code 'MUX'). */
export class MuxError extends MediaForgeError {
    constructor(msg: string, options?: MediaForgeErrorOptions) {
        super(msg, 'MUX', options);
        this.name = 'MuxError';
    }
}

/** Sink or source I/O failed (code 'IO'). */
export class IOError extends MediaForgeError {
    constructor(msg: string, options?: MediaForgeErrorOptions) {
        super(msg, 'IO', options);
        this.name = 'IOError';
    }
}

/** An abort for `cause`: the cause itself when it is a library error, else ABORT with it. */
const aborted = (cause: unknown): MediaForgeError =>
    cause instanceof MediaForgeError ? cause : new MediaForgeError('Aborted', 'ABORT', { cause });

/**
 * The error an aborted signal stops work with, the one rule for every abort: the signal's reason
 * when that is a library error (a timeout of the library's own, say), else ABORT with the reason as
 * its cause.
 */
export const abortError = (signal: AbortSignal): MediaForgeError => aborted(signal.reason);

/** Stops with abortError() once `signal` is aborted. */
export function throwIfAborted(signal?: AbortSignal | null): void {
    if (signal?.aborted) throw abortError(signal);
}

/** Rethrows an abort: of `signal`, an ABORT error, or the host's AbortError as ABORT. */
export function rethrowIfAbort(error: unknown, signal?: AbortSignal | null): void {
    throwIfAborted(signal);
    if (
        error instanceof MediaForgeError
            ? error.code === 'ABORT'
            : (error as { name?: unknown } | null)?.name === 'AbortError'
    )
        throw aborted(error);
}
