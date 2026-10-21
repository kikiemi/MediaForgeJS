/**
 * The first bytes of a Blob input, read once while the reading code loads: the load hints sniff
 * them and each BlobSource over the input until it is open takes them as its first window, so
 * opening the input reads them once.
 */
const heads = new WeakMap<Blob, Promise<ArrayBuffer>>();

/** Bytes read ahead of a Blob input: the window a BlobSource reads at a jump. */
export const BLOB_HEAD_BYTES = 256 * 1024;

/** Starts reading the head of `blob`, or returns the read already started. */
export function readBlobHead(blob: Blob): Promise<ArrayBuffer> {
    let head = heads.get(blob);
    if (!head) {
        head = blob.slice(0, BLOB_HEAD_BYTES).arrayBuffer();
        heads.set(blob, head);
        head.catch(() => heads.delete(blob));
    }
    return head;
}

/** The head read started for `blob`, if any. */
export function blobHead(blob: Blob): Promise<ArrayBuffer> | undefined {
    return heads.get(blob);
}

/** Drops the head read of `input` once it is open or the operation that read it ends. */
export function releaseBlobHead(input: unknown): void {
    if (typeof Blob === 'function' && input instanceof Blob) heads.delete(input);
}
