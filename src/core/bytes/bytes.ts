/**
 * Whether two byte arrays hold the same bytes; two absent arrays are the same, an absent and a
 * present one are not.
 */
export function sameBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
    if (!left || !right) return left === right;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++)
        if (left[index] !== right[index]) return false;
    return true;
}

/** The parts one after another in a new array. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
