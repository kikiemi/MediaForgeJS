// What the player shares between its parts: errors, cancellation, deadlines, checked byte arrays and
// the warnings of a client, as mediaforgejs reports them.
import { MediaForgeError } from 'mediaforgejs/plugins';
import type { MediaDiagnostic } from 'mediaforgejs';
import type { HlsParseOptions } from 'mediaforgejs/streaming';

/** Codec families of video tracks in fMP4, as RFC 6381 names them in CODECS. */
export const VIDEO_CODECS = /^(?:avc[13]|hvc1|hev1|dvh[1e]|dva[1v]|vp0[89]|av01)\b/;

/** Codec families of text in fMP4 (IMSC, WebVTT, timed text, captions), which MSE does not play. */
const TEXT_CODECS = /^(?:stpp|wvtt|tx3g|c60[78])\b/;

/**
 * The MSE type of a variant's CODECS: of all its picture and sound, or of `kind` only (a variant
 * whose sound is in a rendition of its own); video where it has a picture codec (or a resolution).
 * Undefined when it names no codec of the kind.
 */
export function codecsType(
    codecs: string | undefined,
    kind?: 'video' | 'audio',
    resolution = false,
): string | undefined {
    if (typeof codecs !== 'string' || /["\r\n]/.test(codecs)) return undefined;
    const media = codecs
        .split(',')
        .map(codec => codec.trim())
        .filter(codec => codec && !TEXT_CODECS.test(codec));
    const own = kind
        ? media.filter(codec => VIDEO_CODECS.test(codec) === (kind === 'video'))
        : media;
    if (!own.length) return undefined;
    const video = kind
        ? kind === 'video'
        : resolution || own.some(codec => VIDEO_CODECS.test(codec));
    return `${video ? 'video' : 'audio'}/mp4; codecs="${own.join(',')}"`;
}

/** `items` that `playable` accepts, or all of them when it accepts none. */
export function playableOf<T>(items: readonly T[], playable: (item: T) => boolean): T[] {
    const usable = items.filter(playable);
    return usable.length ? usable : [...items];
}

/**
 * The first item of the highest bandwidth: what a player plays without adaptive quality, an HLS
 * variant or a DASH representation, among the playable ones (playableOf).
 */
export function highestOf<T>(items: readonly T[], bandwidth: (item: T) => number): T | undefined {
    return items.reduce<T | undefined>(
        (best, item) => (best === undefined || bandwidth(item) > bandwidth(best) ? item : best),
        undefined,
    );
}

/**
 * Whether this host's MSE changes the codecs of a SourceBuffer in place (`changeType()`: Chrome 70,
 * Firefox 63, Safari 13.1): the one rule for playing on across a change of codecs, which adaptive
 * quality may then switch to. Asks `buffer` when given, else the host's SourceBuffer.
 */
export function changesCodecs(buffer?: SourceBuffer): boolean {
    const target =
        buffer ?? (typeof SourceBuffer === 'function' ? SourceBuffer.prototype : undefined);
    return typeof target?.changeType === 'function';
}

/** A failed request or response (code IO). */
export const ioError = (message: string): MediaForgeError => new MediaForgeError(message, 'IO');

// The player refuses as mediaforgejs does: an invalid argument, option or callback result with
// INPUT, a resource that does not follow its specification with DEMUX, what it does not play (or
// what the host lacks) with FORMAT, and a resource past a size limit with OOM.

/** Refuses an invalid argument, option or callback result. */
export function invalidArgument(message: string): never {
    throw new MediaForgeError(message, 'INPUT');
}

/** Refuses a resource that does not follow its specification. */
export function malformed(message: string): never {
    throw new MediaForgeError(message, 'DEMUX');
}

/** Refuses what the player does not play, or what the host lacks. */
export function unsupported(message: string): never {
    throw new MediaForgeError(message, 'FORMAT');
}

/** Refuses a resource past a size limit. */
export function overLimit(message: string): never {
    throw new MediaForgeError(message, 'OOM');
}

/** Stops with ABORT once `signal` is aborted. */
export function throwIfAborted(signal?: AbortSignal | null): void {
    if (signal?.aborted) throw new MediaForgeError('Aborted', 'ABORT');
}

/**
 * The rejections of the awaits pending on each signal, which its one abort listener runs: many
 * awaits then add no listener each.
 */
const waiting = new WeakMap<AbortSignal, Set<(error: MediaForgeError) => void>>();

function waitersOf(signal: AbortSignal): Set<(error: MediaForgeError) => void> {
    let waiters = waiting.get(signal);
    if (!waiters) {
        const pending = (waiters = new Set());
        waiting.set(signal, pending);
        signal.addEventListener(
            'abort',
            () => {
                for (const reject of pending) reject(new MediaForgeError('Aborted', 'ABORT'));
                pending.clear();
            },
            { once: true },
        );
    }
    return waiters;
}

/** Awaits a browser operation without letting a stalled promise hide cancellation. */
export async function awaitWithAbort<T>(pending: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return pending;
    if (signal.aborted) {
        void Promise.resolve(pending).catch(() => undefined);
        throw new MediaForgeError('Aborted', 'ABORT');
    }
    const waiters = waitersOf(signal);
    return new Promise<T>((resolve, reject) => {
        waiters.add(reject);
        Promise.resolve(pending).then(
            value => {
                waiters.delete(reject);
                resolve(value);
            },
            (error: unknown) => {
                waiters.delete(reject);
                reject(error);
            },
        );
    });
}

/** A signal that aborts when any of `signals` does, and the removal of its listeners. */
export function linkAbortSignals(...signals: Array<AbortSignal | undefined>): {
    signal: AbortSignal;
    dispose(): void;
} {
    const controller = new AbortController();
    const listeners: Array<() => void> = [];
    for (const signal of signals) {
        if (!signal) continue;
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        const abort = (): void => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        listeners.push(() => signal.removeEventListener('abort', abort));
    }
    return {
        signal: controller.signal,
        dispose: () => {
            for (const remove of listeners.splice(0)) remove();
        },
    };
}

/** Whether `timeoutMs` milliseconds have passed since the call. */
export function createDeadline(timeoutMs: number): () => boolean {
    const now = typeof performance === 'undefined' ? Date.now : performance.now.bind(performance);
    const expires = now() + timeoutMs;
    return () => now() >= expires;
}

/** A count or byte limit: `value`, or `fallback` when unset, as a positive safe integer. */
export function positiveLimit(value: number | undefined, fallback: number, name: string): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1)
        invalidArgument(`${name} must be a positive safe integer`);
    return result;
}

/**
 * The typed-array accessors as the engine defines them, captured once: through them a caller's
 * array shows its real kind, buffer, offset and length whatever its own properties claim, and
 * values() throws when its buffer is detached.
 */
const prototype = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (key: PropertyKey): ((this: unknown) => any) =>
    Object.getOwnPropertyDescriptor(prototype, key)!.get!;

export const typedArrayTag = getter(Symbol.toStringTag);
export const typedArrayBuffer = getter('buffer');
export const typedArrayOffset = getter('byteOffset');
export const typedArrayByteLength = getter('byteLength');
export const typedArrayValues: (this: unknown) => unknown = prototype.values;

/** The length of `data`, which must be an attached Uint8Array (IO otherwise). */
export function outputByteLength(data: Uint8Array): number {
    try {
        if (typedArrayTag.call(data) !== 'Uint8Array') throw new TypeError();
        typedArrayValues.call(data);
        return typedArrayByteLength.call(data);
    } catch {
        throw new MediaForgeError('output data must be an attached Uint8Array', 'IO');
    }
}

/** A copy of `data` the caller owns. */
export function copyOutputBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
    try {
        return new Uint8Array(data);
    } catch {
        throw new MediaForgeError('could not allocate output bytes', 'OOM');
    }
}

/** `reason` as a MediaForgeError of `code`, its message after `context`. */
export function outputError(
    reason: unknown,
    context = 'output sink failed',
    code: 'IO' | 'ABORT' = 'IO',
): MediaForgeError {
    try {
        if (reason instanceof MediaForgeError && (code === 'IO' || reason.code === code))
            return reason;
    } catch {}
    let message = 'unknown error';
    try {
        message = String(reason instanceof Error ? reason.message : reason);
    } catch {}
    return new MediaForgeError(`${context}: ${message}`, code);
}

/** Checks that a read returned exactly `count` bytes in an attached Uint8Array. */
export function assertSourceBytes(bytes: Uint8Array, count: number, name: string): void {
    let valid = false;
    try {
        valid =
            typedArrayTag.call(bytes) === 'Uint8Array' &&
            typedArrayByteLength.call(bytes) === count;
        typedArrayValues.call(bytes);
    } catch {
        throw ioError(`${name} received an invalid or detached byte array`);
    }
    if (!valid) throw ioError(`${name} read must return exactly the requested Uint8Array bytes`);
}

/** The warning settings of a client, as the HLS playlist parser of mediaforgejs takes them. */
export type WarningOptions = Pick<
    HlsParseOptions,
    'validation' | 'metadataPolicy' | 'onWarning' | 'maxWarnings'
>;

/**
 * The warnings of a client: delivered to `onWarning` and kept up to `maxWarnings` (default 100);
 * recovered damage fails with DEMUX under strict validation.
 */
export class Warnings {
    readonly validation: 'strict' | 'compatible';
    private readonly listener?: (diagnostic: MediaDiagnostic) => void;
    private readonly limit: number;
    private readonly entries: MediaDiagnostic[] = [];

    constructor(options: WarningOptions, defaultValidation: 'strict' | 'compatible') {
        const validation = options.validation ?? defaultValidation;
        const requested = options.metadataPolicy;
        const metadataPolicy = requested === undefined ? 'warn' : requested;
        const limit = options.maxWarnings ?? 100;
        if (validation !== 'strict' && validation !== 'compatible')
            invalidArgument('validation must be strict or compatible');
        if (metadataPolicy !== 'warn' && metadataPolicy !== 'error')
            invalidArgument('metadataPolicy must be warn or error');
        if (options.onWarning !== undefined && typeof options.onWarning !== 'function')
            invalidArgument('onWarning must be a function');
        if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000)
            invalidArgument('maxWarnings must be an integer in 0..10000');
        this.validation = validation;
        this.listener = options.onWarning;
        this.limit = limit;
    }

    get warnings(): readonly MediaDiagnostic[] {
        return this.entries.slice();
    }

    /** Reports recovered damage; strict validation fails with DEMUX instead. */
    recover(diagnostic: Omit<MediaDiagnostic, 'severity'>): void {
        if (this.validation === 'strict') throw new MediaForgeError(diagnostic.message, 'DEMUX');
        this.warn(diagnostic);
    }

    warn(diagnostic: Omit<MediaDiagnostic, 'severity'>): void {
        if (this.entries.length >= this.limit) return;
        const entry: MediaDiagnostic = Object.freeze({ ...diagnostic, severity: 'warning' });
        this.entries.push(entry);
        this.listener?.(entry);
    }
}
