export interface Sink {
    /** Optional signal fired when the output consumer cancels. */
    readonly signal?: AbortSignal;
    /** Queues bytes at the current position; may not block - see drain(). */
    write(data: Uint8Array): void;
    /** Awaits everything queued and releases the destination; throws the stored failure if any write failed. */
    close(): Promise<void>;
    patchAt?(offset: number, data: Uint8Array): void;
    abort?(reason?: unknown): Promise<void>;
    drain?(): Promise<void>;
}
/** Random-access byte source (Blob-backed by default). */
export interface Source {
    /** Reads `length` bytes at `offset`. */
    read(offset: number, length: number): Promise<Uint8Array>;
    /** Total size in bytes. */
    readonly size: number;
}
