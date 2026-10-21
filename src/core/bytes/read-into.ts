import type { Source } from '../model/types';

/**
 * Fills `target` with the input from `offset`, as many bytes as it holds, which the input must
 * have.
 */
export type ReadInto = (offset: number, target: Uint8Array) => Promise<void>;

/** A source's read into a caller's bytes, called with the source as `this`. */
type ReadIntoMethod = (this: Source, offset: number, target: Uint8Array) => Promise<void>;

const intoReads = new WeakMap<
    Source,
    { readonly read: Source['read']; readonly into: ReadIntoMethod }
>();

/**
 * Declares that the method `into` fills a caller's bytes as `read` would return them; replacing
 * `read` ends the declaration. Methods rather than closures keep the registry from holding
 * short-lived sources.
 */
export function registerReadInto(source: Source, read: Source['read'], into: ReadIntoMethod): void {
    intoReads.set(source, { read, into });
}

/**
 * The read into a caller's bytes of a source read with `read` (its own by default), when it
 * declared one.
 */
export function readerInto(source: Source, read?: Source['read']): ReadInto | undefined {
    const entry = intoReads.get(source);
    try {
        if (!entry || source.read !== entry.read || (read ?? entry.read) !== entry.read)
            return undefined;
    } catch {
        return undefined;
    }
    return (offset, target) => entry.into.call(source, offset, target);
}
