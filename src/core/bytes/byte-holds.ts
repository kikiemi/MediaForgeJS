/**
 * Holds on reused buffers. A buffer whose holds are tracked has its owner's hold and one from each
 * holdBytes() of a view of it; when the last hold is released the owner may refill it. A view
 * without a hold is valid only until its owner releases the buffer.
 */
interface Holds {
    count: number;
    readonly free: () => void;
}

const holds = new WeakMap<ArrayBufferLike, Holds>();

/**
 * Tracks the holds on `buffer`, starting with its owner's; `free` runs once the last one is
 * released.
 */
export function trackHolds(buffer: ArrayBufferLike, free: () => void): void {
    holds.set(buffer, { count: 1, free });
}

/**
 * Takes a hold on the buffer behind `bytes`; false for bytes of a buffer no one reuses, which never
 * change.
 */
export function holdBytes(bytes: Uint8Array): boolean {
    const entry = holds.get(bytes.buffer);
    if (!entry) return false;
    entry.count++;
    return true;
}

/** Releases a hold on the buffer behind `bytes`; nothing for bytes of a buffer no one reuses. */
export function releaseBytes(bytes: Uint8Array): void {
    const entry = holds.get(bytes.buffer);
    if (!entry || --entry.count > 0) return;
    holds.delete(bytes.buffer);
    entry.free();
}
