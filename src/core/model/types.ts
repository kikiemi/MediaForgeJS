export interface Sink {
    /** Optional signal fired when the output consumer cancels. */
    readonly signal?: AbortSignal;
    /** Queues bytes at the current position; may not block - see drain(). */
    write(data: Uint8Array): void;
    /**
     * True when write() is done with the bytes before it returns (it writes or copies them). A copy
     * may then pass it views of buffers it refills later, and PCM output (WAV, AIFF, AU, CAF) one
     * buffer it refills for every chunk; otherwise each write gets bytes of its own, which costs
     * CPU time on long outputs.
     */
    readonly copiesWrites?: boolean;
    /**
     * Awaits everything queued and releases the destination; throws the stored failure if any write
     * failed.
     */
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

/** Accepted input bytes for conversion and format detection. */
export type MediaInput = File | Blob | ArrayBuffer | ArrayBufferView;
