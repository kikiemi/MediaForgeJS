import { DemuxError, MediaForgeError } from '../../../core/errors/errors';
import { assertSourceBytes } from '../../../core/io/sources/source-read';
import {
    typedArrayBuffer as buffer,
    typedArrayByteLength as byteLength,
    typedArrayOffset as byteOffset,
} from '../../../core/bytes/typed-array';

export interface SidxParseOptions {
    /** Absolute byte offset of this complete sidx box in its resource. Default 0n. */
    readonly offset?: bigint;
    /** Complete box limit, at most 1 MiB. Default 1 MiB. */
    readonly maxBytes?: number;
    /** Maximum reference records, at most 65535. Default 65535. */
    readonly maxReferences?: number;
}

export interface SidxReference {
    /** 0 references media bytes; 1 references another index, which this parser does not follow. */
    readonly referenceType: 0 | 1;
    readonly offset: bigint;
    readonly size: number;
    /** Presentation ticks in the containing index's timescale. */
    readonly time: bigint;
    readonly duration: bigint;
    readonly startsWithSap: boolean;
    readonly sapType: number;
    readonly sapDeltaTime: bigint;
}

export interface SidxIndex {
    readonly version: 0 | 1;
    readonly offset: bigint;
    readonly size: number;
    readonly headerSize: number;
    readonly referenceId: number;
    readonly timescale: number;
    readonly earliestPresentationTime: bigint;
    readonly firstOffset: bigint;
    readonly references: readonly SidxReference[];
}

const U64 = 0xffffffffffffffffn;

// A box that does not follow ISO/IEC 14496-12 is malformed (DEMUX), one this parser does not read
// is unsupported (FORMAT), an invalid argument or option is INPUT, and a box past a size limit is
// OOM.

function malformed(message: string): never {
    throw new DemuxError(`SIDX: ${message}`);
}

function unsupported(message: string): never {
    throw new MediaForgeError(`SIDX: ${message}`, 'FORMAT');
}

function invalidArgument(message: string): never {
    throw new MediaForgeError(`SIDX: ${message}`, 'INPUT');
}

function overLimit(message: string): never {
    throw new MediaForgeError(`SIDX: ${message}`, 'OOM');
}

function limit(value: number | undefined, maximum: number, name: string): number {
    const result = value === undefined ? maximum : value;
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
        invalidArgument(`invalid ${name}`);
    return result;
}

function bounded(value: bigint): bigint {
    if (value > U64) malformed('byte or timeline arithmetic exceeds uint64');
    return value;
}

/**
 * Parses one complete sidx box without retaining input bytes or following nested index references.
 */
export function parseSidx(input: Uint8Array, options: SidxParseOptions = {}): SidxIndex {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalidArgument('invalid options');
    const { offset: requestedOffset, maxBytes, maxReferences } = options;
    const offset = requestedOffset === undefined ? 0n : requestedOffset;
    if (typeof offset !== 'bigint' || offset < 0n || offset > U64)
        invalidArgument('offset must fit an unsigned bigint uint64');
    const maximum = limit(maxBytes, 1048576, 'maxBytes');
    const referencesLimit = limit(maxReferences, 65535, 'maxReferences');
    let length: number;
    try {
        length = byteLength.call(input);
    } catch {
        return invalidArgument('expected Uint8Array');
    }

    assertSourceBytes(input, length, 'SIDX');
    if (length > maximum) overLimit('box exceeds maxBytes');
    if (length < 8) malformed('truncated box header');
    const view = new DataView(buffer.call(input), byteOffset.call(input), length);
    let size = view.getUint32(0),
        headerSize = 8;
    if (view.getUint32(4) !== 0x73696478) malformed('expected sidx box');
    if (size === 0) unsupported('size-zero sidx is not supported');
    if (size === 1) {
        if (length < 16) malformed('truncated extended header');
        const extended = view.getBigUint64(8);
        if (extended !== BigInt(length)) malformed('box size must exactly match input bytes');
        size = length;
        headerSize = 16;
    }

    if (size !== length || size < headerSize + 24)
        malformed('box size must exactly match a complete sidx');
    bounded(offset + BigInt(size));
    const version = view.getUint8(headerSize);
    if (version !== 0 && version !== 1) unsupported('unsupported version');
    if (view.getUint32(headerSize) & 0xffffff) malformed('nonzero flags');
    if (size < headerSize + (version ? 32 : 24)) malformed('truncated sidx fields');
    const referenceId = view.getUint32(headerSize + 4),
        timescale = view.getUint32(headerSize + 8);
    if (!timescale) malformed('timescale must be positive');
    let cursor = headerSize + 12;
    const earliestPresentationTime = version
        ? view.getBigUint64(cursor)
        : BigInt(view.getUint32(cursor));
    cursor += version ? 8 : 4;
    const firstOffset = version ? view.getBigUint64(cursor) : BigInt(view.getUint32(cursor));
    cursor += version ? 8 : 4;
    if (view.getUint16(cursor)) malformed('nonzero reserved field');
    const count = view.getUint16(cursor + 2);
    cursor += 4;
    if (count > referencesLimit) overLimit('reference count exceeds maxReferences');
    if (cursor + count * 12 !== size) malformed('reference count does not match box size');
    const references: SidxReference[] = [];
    let position = bounded(offset + BigInt(size) + firstOffset),
        time = earliestPresentationTime;
    for (let index = 0; index < count; index++, cursor += 12) {
        const word = view.getUint32(cursor),
            sap = view.getUint32(cursor + 8);
        const size = word & 0x7fffffff,
            duration = BigInt(view.getUint32(cursor + 4));
        references.push(
            Object.freeze({
                referenceType: (word >>> 31) as 0 | 1,
                offset: position,
                size,
                time,
                duration,
                startsWithSap: Boolean(sap >>> 31),
                sapType: (sap >>> 28) & 7,
                sapDeltaTime: BigInt(sap & 0x0fffffff),
            }),
        );
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
