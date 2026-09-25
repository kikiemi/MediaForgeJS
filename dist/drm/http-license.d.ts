import type { EmeLicenseCallback } from './eme-controller.js';
export interface HttpLicenseOptions {
    readonly url: string | URL;
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: HeadersInit;
    readonly credentials?: RequestCredentials;
    /** Maximum response body bytes, including streamed responses; defaults to 1 MiB. */
    readonly maxResponseBytes?: number;
    /** Deadline for the request and its entire response body; defaults to 30 seconds. */
    readonly timeoutMs?: number;
}
/** Binary challenge/response POST. Configure authorization in headers, credentials or fetch. */
export declare function createHttpLicenseCallback(options: HttpLicenseOptions): EmeLicenseCallback;
