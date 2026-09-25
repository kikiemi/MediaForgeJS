/** Every machine-readable error category the library emits. */
export type ErrorCode = 'DECODE' | 'ENCODE' | 'MUX' | 'DEMUX' | 'FORMAT' | 'INPUT' | 'OUTPUT' | 'ABORT' | 'IO' | 'OOM';
export declare class MediaForgeError extends Error {
    /** Machine-readable category; see the class doc for the values. */
    readonly code: ErrorCode;
    constructor(message: string, code: ErrorCode);
}
/** Container parsing failed (code 'DEMUX'). */
export declare class DemuxError extends MediaForgeError {
    constructor(msg: string);
}
/** Decoding failed (code 'DECODE'). */
export declare class DecodeError extends MediaForgeError {
    constructor(msg: string);
}
/** Encoding failed (code 'ENCODE'). */
export declare class EncodeError extends MediaForgeError {
    constructor(msg: string);
}
/** Muxing failed (code 'MUX'). */
export declare class MuxError extends MediaForgeError {
    constructor(msg: string);
}
/** Sink or source I/O failed (code 'IO'). */
export declare class IOError extends MediaForgeError {
    constructor(msg: string);
}
export declare function rethrowIfAbort(error: unknown, signal?: AbortSignal | null): void;
export declare function normalizeBitrateBps(value: number | undefined, kind: 'audio' | 'video'): number;
