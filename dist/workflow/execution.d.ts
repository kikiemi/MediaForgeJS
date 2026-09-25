import type { Sink } from '../types/io.js';
export declare function executeWithSink<T>(sink: Sink, signals: readonly (AbortSignal | undefined)[], run: (sink: Sink, signal: AbortSignal, invoke: <R>(action: () => R) => R) => Promise<T>): Promise<T>;
