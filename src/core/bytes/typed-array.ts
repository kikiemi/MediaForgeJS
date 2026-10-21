import { MediaForgeError } from '../errors/errors';

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
export const typedArrayLength = getter('length');
export const typedArrayValues: (this: unknown) => unknown = prototype.values;

/** The element count of `value`, which must be an attached typed array of `type`. */
export function attachedLength(value: ArrayBufferView, type = 'Uint8Array'): number {
    if (typedArrayTag.call(value) !== type)
        throw new MediaForgeError(`data must be a ${type}`, 'INPUT');
    try {
        typedArrayValues.call(value);
    } catch {
        throw new MediaForgeError(`data must be an attached ${type}`, 'INPUT');
    }
    return typedArrayLength.call(value);
}

/** A fresh view of the elements of `value`, which must be an attached typed array of `type`. */
export function attachedView<T extends Uint8Array | Float32Array>(
    value: T,
    type: 'Uint8Array' | 'Float32Array' = 'Uint8Array',
): T {
    const length = attachedLength(value, type);
    const View = type === 'Uint8Array' ? Uint8Array : Float32Array;
    return new View(typedArrayBuffer.call(value), typedArrayOffset.call(value), length) as T;
}
