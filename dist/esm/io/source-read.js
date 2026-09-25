import { IOError } from '../core/errors.js';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const tag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const values = Uint8Array.prototype.values;
export function sourceReadEnd(offset, length, size) {
    if (!Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        !Number.isSafeInteger(offset + length)) {
        throw new IOError('read offset and length must be non-negative safe integers');
    }
    return Math.min(offset + length, size);
}
export function assertSourceBytes(bytes, count, name) {
    try {
        if (tag.call(bytes) !== 'Uint8Array' || byteLength.call(bytes) !== count) {
            throw new IOError(`${name} read must return exactly the requested Uint8Array bytes`);
        }
        values.call(bytes);
    }
    catch (error) {
        if (error instanceof IOError)
            throw error;
        throw new IOError(`${name} received an invalid or detached byte array`);
    }
}
