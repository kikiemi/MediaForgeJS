import { MediaForgeError } from 'mediaforgejs/plugins';
import { outputByteLength } from '../support.js';
import type { EmeLicenseCallback } from './eme-controller.js';

function encodedLength(value: string): number {
    if (
        typeof value !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(value) ||
        value.length > 86 ||
        value.length % 4 === 1
    ) {
        throw new MediaForgeError('ClearKey values must be canonical unpadded base64url', 'IO');
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const tail = alphabet.indexOf(value[value.length - 1]!);
    if (
        (value.length % 4 === 2 && (tail & 15) !== 0) ||
        (value.length % 4 === 3 && (tail & 3) !== 0)
    ) {
        throw new MediaForgeError('ClearKey values must be canonical unpadded base64url', 'IO');
    }
    return Math.floor((value.length * 6) / 8);
}

/**
 * Creates temporary ClearKey JWK responses using only the supplied base64url key IDs and AES-128
 * keys.
 */
export function createClearKeyLicense(keys: Readonly<Record<string, string>>): EmeLicenseCallback {
    if (!keys || typeof keys !== 'object' || Array.isArray(keys))
        throw new MediaForgeError('ClearKey requires an explicit key map', 'IO');

    const ids = Object.keys(keys);
    if (ids.length === 0 || ids.length > 128)
        throw new MediaForgeError('ClearKey requires between 1 and 128 supplied keys', 'IO');

    const supplied = new Map<string, string>();
    for (const id of ids) {
        encodedLength(id);
        const key = keys[id]!;
        if (encodedLength(key) !== 16)
            throw new MediaForgeError('ClearKey AES keys must contain 16 bytes', 'IO');
        supplied.set(id, key);
    }

    return request => {
        if (request.signal.aborted)
            throw new MediaForgeError('ClearKey request was aborted', 'ABORT');
        if (
            request.keySystem !== 'org.w3.clearkey' ||
            (request.messageType !== 'license-request' && request.messageType !== 'license-renewal')
        ) {
            throw new MediaForgeError('ClearKey helper requires a ClearKey license request', 'IO');
        }
        if (outputByteLength(request.message) > 65536)
            throw new MediaForgeError('ClearKey request is too large', 'OOM');

        let value: unknown;
        try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.message));
        } catch {
            throw new MediaForgeError('Invalid ClearKey request JSON', 'IO');
        }

        const parsed = value as { kids?: unknown; type?: unknown } | null;
        if (!parsed || typeof parsed !== 'object' || parsed.type !== 'temporary') {
            throw new MediaForgeError('ClearKey helper supports temporary requests only', 'IO');
        }
        if (!Array.isArray(parsed.kids) || parsed.kids.length === 0 || parsed.kids.length > 128) {
            throw new MediaForgeError('ClearKey request requires between 1 and 128 key IDs', 'IO');
        }

        const requested = new Set<string>();
        for (const id of parsed.kids) {
            if (typeof id !== 'string') throw new MediaForgeError('Invalid ClearKey key ID', 'IO');
            encodedLength(id);
            if (!supplied.has(id))
                throw new MediaForgeError(
                    'ClearKey request contains a key ID that was not supplied',
                    'IO',
                );
            requested.add(id);
        }

        return new TextEncoder().encode(
            JSON.stringify({
                keys: [...requested].map(kid => ({ kty: 'oct', kid, k: supplied.get(kid)! })),
                type: 'temporary',
            }),
        );
    };
}
