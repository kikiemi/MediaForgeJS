export declare function captureViaMediaElement(file: File | Blob, preferredRate: number, allowAcceleration: boolean, callbacks?: {
    onProgress?: (percent: number, message: string) => void;
    signal?: AbortSignal;
    /** Mainly useful to make browser integration tests deterministic. */
    loadTimeoutMs?: number;
}): Promise<{
    buffer: AudioBuffer;
    effectiveSpeed: number;
    wallSeconds: number;
    mediaSeconds: number;
}>;
