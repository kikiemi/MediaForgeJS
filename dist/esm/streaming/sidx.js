import { MediaForgeError } from '../core/errors.js';
import { assertSourceBytes } from '../io/source-read.js';
const arrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(arrayPrototype, 'byteLength').get;
const byteOffset = Object.getOwnPropertyDescriptor(arrayPrototype, 'byteOffset').get;
const buffer = Object.getOwnPropertyDescriptor(arrayPrototype, 'buffer').get;
const U64 = 0xffffffffffffffffn;
function invalid(message) {
    throw new MediaForgeError(`SIDX: ${message}`, 'FORMAT');
}
function limit(value, maximum, name) {
    const result = value === undefined ? maximum : value;
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
        invalid(`invalid ${name}`);
    return result;
}
function bounded(value) {
    if (value > U64)
        invalid('byte or timeline arithmetic exceeds uint64');
    return value;
}
export function parseSidx(input, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalid('invalid options');
    const { offset: requestedOffset, maxBytes, maxReferences } = options;
    const offset = requestedOffset === undefined ? 0n : requestedOffset;
    if (typeof offset !== 'bigint' || offset < 0n || offset > U64)
        invalid('offset must fit an unsigned bigint uint64');
    const maximum = limit(maxBytes, 1048576, 'maxBytes');
    const referencesLimit = limit(maxReferences, 65535, 'maxReferences');
    let length;
    try {
        length = byteLength.call(input);
    }
    catch {
        return invalid('expected Uint8Array');
    }
    assertSourceBytes(input, length, 'SIDX');
    if (length > maximum)
        invalid('box exceeds maxBytes');
    if (length < 8)
        invalid('truncated box header');
    const view = new DataView(buffer.call(input), byteOffset.call(input), length);
    let size = view.getUint32(0), headerSize = 8;
    if (view.getUint32(4) !== 0x73696478)
        invalid('expected sidx box');
    if (size === 0)
        invalid('size-zero sidx is unsupported');
    if (size === 1) {
        if (length < 16)
            invalid('truncated extended header');
        const extended = view.getBigUint64(8);
        if (extended !== BigInt(length))
            invalid('box size must exactly match input bytes');
        size = length;
        headerSize = 16;
    }
    if (size !== length || size < headerSize + 24)
        invalid('box size must exactly match a complete sidx');
    bounded(offset + BigInt(size));
    const version = view.getUint8(headerSize);
    if (version !== 0 && version !== 1)
        invalid('unsupported version');
    if (view.getUint32(headerSize) & 0xffffff)
        invalid('nonzero flags');
    if (size < headerSize + (version ? 32 : 24))
        invalid('truncated sidx fields');
    const referenceId = view.getUint32(headerSize + 4), timescale = view.getUint32(headerSize + 8);
    if (!timescale)
        invalid('timescale must be positive');
    let cursor = headerSize + 12;
    const earliestPresentationTime = version ? view.getBigUint64(cursor) : BigInt(view.getUint32(cursor));
    cursor += version ? 8 : 4;
    const firstOffset = version ? view.getBigUint64(cursor) : BigInt(view.getUint32(cursor));
    cursor += version ? 8 : 4;
    if (view.getUint16(cursor))
        invalid('nonzero reserved field');
    const count = view.getUint16(cursor + 2);
    cursor += 4;
    if (count > referencesLimit)
        invalid('reference count exceeds maxReferences');
    if (cursor + count * 12 !== size)
        invalid('reference count does not match box size');
    const references = [];
    let position = bounded(offset + BigInt(size) + firstOffset), time = earliestPresentationTime;
    for (let index = 0; index < count; index++, cursor += 12) {
        const word = view.getUint32(cursor), sap = view.getUint32(cursor + 8);
        const size = word & 0x7fffffff, duration = BigInt(view.getUint32(cursor + 4));
        references.push(Object.freeze({
            referenceType: (word >>> 31),
            offset: position,
            size,
            time,
            duration,
            startsWithSap: Boolean(sap >>> 31),
            sapType: (sap >>> 28) & 7,
            sapDeltaTime: BigInt(sap & 0x0fffffff),
        }));
        position = bounded(position + BigInt(size));
        time = bounded(time + duration);
    }
    return Object.freeze({
        version,
        offset,
        size,
        headerSize,
        referenceId,
        timescale,
        earliestPresentationTime,
        firstOffset,
        references: Object.freeze(references),
    });
}
