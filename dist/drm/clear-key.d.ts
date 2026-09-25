import type { EmeLicenseCallback } from './eme-controller.js';
/** Creates temporary ClearKey JWK responses using only the supplied base64url key IDs and AES-128 keys. */
export declare function createClearKeyLicense(keys: Readonly<Record<string, string>>): EmeLicenseCallback;
