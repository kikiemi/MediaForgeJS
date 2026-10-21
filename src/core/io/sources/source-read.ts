import { IOError } from '../../errors/errors';
import type { Source } from '../../model/types';
import {
    typedArrayByteLength as byteLength,
    typedArrayTag as tag,
    typedArrayValues as values,
} from '../../bytes/typed-array';

const ownedReads = new WeakMap<Source, Source['read']>();

export function sourceReadEnd(offset: number, length: number, size: number): number {
    if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        !Number.isSafeInteger(offset + length)
    ) {
        throw new IOError('read offset and length must be non-negative safe integers');
    }
    return Math.min(offset + length, size);
}

export function assertSourceBytes(bytes: Uint8Array, count: number, name: string): void {
    try {
        if (tag.call(bytes) !== 'Uint8Array' || byteLength.call(bytes) !== count) {
            throw new IOError(`${name} read must return exactly the requested Uint8Array bytes`);
        }
        values.call(bytes);
    } catch (error) {
        if (error instanceof IOError) throw error;
        throw new IOError(`${name} received an invalid or detached byte array`);
    }
}

/**
 * Declares that `read` resolves to bytes the caller owns outright; replacing the method ends the
 * declaration.
 */
export function registerOwnedReads(source: Source, read: Source['read']): void {
    ownedReads.set(source, read);
}

type ViewMethod = (this: Source, offset: number, length: number) => Promise<Uint8Array>;

const viewReads = new WeakMap<Source, ViewMethod>();

/**
 * Declares that the method `view` resolves to the bytes of the source's owned reads
 * (registerOwnedReads) as views of bytes it never changes, which callers must not change either.
 */
export function registerViewReads(source: Source, view: ViewMethod): void {
    viewReads.set(source, view);
}

/** The read of views of `source` while `read` is its owned read, when it declared one. */
export function viewReader(
    source: Source,
    read: Source['read'],
): ((offset: number, length: number) => Promise<Uint8Array>) | undefined {
    const view = viewReads.get(source);
    return view && read === ownedReads.get(source) && returnsOwnedBytes(source)
        ? (offset, length) => view.call(source, offset, length)
        : undefined;
}

const heldReads = new WeakMap<Source, () => void>();

/**
 * Declares how `source` drops the bytes it holds from reads it has done (the windows a scan read
 * ahead, retained pages), which the reads of a later operation would at most reuse in part.
 */
export function registerReleaseReads(source: Source, release: () => void): void {
    heldReads.set(source, release);
}

/**
 * Drops the bytes `source`, and the sources it reads, hold from reads done so far: an input that
 * stays open between operations keeps its index and reads again what the next one needs.
 */
export function releaseReads(source: Source): void {
    heldReads.get(source)?.();
}

/** True when a read result may be retained or handed on without copying. */
export function returnsOwnedBytes(source: Source): boolean {
    const read = ownedReads.get(source);
    if (read === undefined) return false;
    try {
        return source.read === read;
    } catch {
        return false;
    }
}
