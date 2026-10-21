import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createClearKeyLicense } from 'mediaforgejs-player';

// createClearKeyLicense(): ClearKey licenses (JSON Web Keys) for the keys the application holds.

const KID = 'AAAAAAAAAAAAAAAAAAAAAA';
const KEY = 'AQEBAQEBAQEBAQEBAQEBAQ';

/** A ClearKey license request for `kids`. */
const request = (kids, init = {}) => ({
    keySystem: 'org.w3.clearkey',
    messageType: 'license-request',
    sessionId: '',
    signal: new AbortController().signal,
    message: new TextEncoder().encode(JSON.stringify({ kids, type: 'temporary' })),
    ...init,
});

describe('the ClearKey license', () => {
    test('answers a request with the keys it asks for', async () => {
        const license = createClearKeyLicense({ [KID]: KEY });
        const response = JSON.parse(new TextDecoder().decode(await license(request([KID]))));
        assert.deepEqual(
            response.keys.map(key => [key.kid, key.k]),
            [[KID, KEY]],
        );
    });

    test('a key ID it was not given fails with IO', async () => {
        const license = createClearKeyLicense({ [KID]: KEY });
        await assert.rejects(
            async () => license(request(['AQAAAAAAAAAAAAAAAAAAAA'])),
            error => error.code === 'IO',
        );
    });

    test('a key that is not 16 bytes of base64url fails with IO when made', () => {
        assert.throws(
            () => createClearKeyLicense({ [KID]: 'AQEB' }),
            error => error.code === 'IO',
        );
    });
});
