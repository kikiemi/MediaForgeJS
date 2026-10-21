const copyingSinks = new WeakSet<object>();

/**
 * Declares that `sink` copies the bytes it is given, unless they are handed off, before its write()
 * returns.
 */
export function declareCopyingSink(sink: object): void {
    copyingSinks.add(sink);
}

/**
 * Whether `sink` copies the bytes it is given (declareCopyingSink), so they may change once write()
 * returns.
 */
export function copiesWrites(sink: object): boolean {
    return copyingSinks.has(sink);
}
