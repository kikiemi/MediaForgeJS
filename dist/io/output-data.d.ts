import { MediaForgeError } from '../core/errors.js';
export declare function outputByteLength(data: Uint8Array): number;
export declare function copyOutputBytes(data: Uint8Array): Uint8Array<ArrayBuffer>;
export declare function outputByteLimit(value: number | undefined): number;
export declare function outputError(reason: unknown, context?: string, code?: 'IO' | 'ABORT'): MediaForgeError;
