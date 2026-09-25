import { MediaForgeError } from '../core/errors.js';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const tag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const values = Uint8Array.prototype.values;
export function outputByteLength(data) {
    try {
        if (tag.call(data) !== 'Uint8Array')
            throw new Error();
        values.call(data);
        return byteLength.call(data);
    }
    catch {
        throw new MediaForgeError('output data must be an attached Uint8Array', 'IO');
    }
}
export function copyOutputBytes(data) {
    try {
        return new Uint8Array(data);
    }
    catch {
        throw new MediaForgeError('could not allocate output bytes', 'OOM');
    }
}
export function outputByteLimit(value) {
    if (value === undefined)
        return Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new MediaForgeError('maxBytes must be a non-negative safe integer', 'IO');
    }
    return value;
}
export function outputError(reason, context = 'output sink failed', code = 'IO') {
    try {
        if (reason instanceof MediaForgeError && (code === 'IO' || reason.code === code))
            return reason;
    }
    catch { }
    let message = 'unknown error';
    try {
        message = String(reason instanceof Error ? reason.message : reason);
    }
    catch { }
    return new MediaForgeError(`${context}: ${message}`, code);
}
