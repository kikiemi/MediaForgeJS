import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as canonical from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';

// The two package entries: the same calls, with and without the bundled plugins.

describe('the package entries', () => {
    test('the main entry exports one API, without the layers that were removed', () => {
        for (const removed of [
            'MediaForgeConverter',
            'Pipeline',
            'Engine',
            'MediaWorkflow',
            'MediaEngine',
            'convertMedia',
            'convertBatch',
        ])
            assert.equal(removed in canonical, false, `${removed} is not part of the API`);
    });

    test('lite exports the same names, with its own MediaForge and the same errors', () => {
        assert.deepEqual(Object.keys(lite).sort(), Object.keys(canonical).sort());
        assert.notEqual(lite.MediaForge, canonical.MediaForge);
        assert.equal(lite.MediaForgeError, canonical.MediaForgeError);
    });
});
