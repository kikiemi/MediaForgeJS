import { releaseBytes, trackHolds } from './byte-holds';

/** Buffers of pools: their bytes change once their holds are released and they are refilled. */
const pooled = new WeakSet<ArrayBufferLike>();

/** Whether `bytes` are of a pooled buffer, refilled for later uses. */
export function isPooledBytes(bytes: Uint8Array): boolean {
    return pooled.has(bytes.buffer);
}

/**
 * Fixed-size byte buffers a pass refills instead of allocating new ones: a buffer goes back to its
 * pool when its owner's hold and every other hold on it (holdBytes) are released (releaseBytes).
 */
export class BufferPool {
    private readonly free: Uint8Array<ArrayBuffer>[] = [];

    /**
     * `bytes` per buffer; at most `maxFree` released buffers wait for reuse, others are left to the
     * collector.
     */
    constructor(
        readonly bytes: number,
        private readonly maxFree = 64,
    ) {}

    /**
     * A buffer of `bytes` bytes with the caller's hold; its contents are those of its previous use.
     */
    acquire(): Uint8Array<ArrayBuffer> {
        const buffer = this.free.pop() ?? new Uint8Array(this.bytes);
        pooled.add(buffer.buffer);
        trackHolds(buffer.buffer, () => {
            // A buffer a sink took (transferred) is gone.
            if (this.free.length < this.maxFree && buffer.byteLength > 0) this.free.push(buffer);
        });
        return buffer;
    }
}

/**
 * Bytes handed out from a pool's buffers until reset(), which releases the arena's hold on them; a
 * request larger than a pooled buffer gets bytes of its own. Views keep a buffer only through holds
 * (holdBytes).
 */
export class ByteArena {
    private readonly slabs: Uint8Array[] = [];
    private current: Uint8Array | undefined;
    private used = 0;

    constructor(private readonly pool: BufferPool) {}

    /** `length` bytes, holding whatever their buffer held before. */
    allocate(length: number): Uint8Array {
        if (length > this.pool.bytes) return new Uint8Array(length);
        if (!this.current || this.used + length > this.current.length) {
            this.current = this.pool.acquire();
            this.slabs.push(this.current);
            this.used = 0;
        }
        const bytes = this.current.subarray(this.used, this.used + length);
        this.used += length;
        return bytes;
    }

    /** Releases the bytes handed out so far. */
    reset(): void {
        for (const slab of this.slabs) releaseBytes(slab);
        this.slabs.length = 0;
        this.current = undefined;
        this.used = 0;
    }
}
