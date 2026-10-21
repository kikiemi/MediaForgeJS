import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { installGlobals } from '../../scripts/browser-globals.mjs';
import { distUrl } from '../helpers/dist-paths.mjs';

// How the script bundles install their two globals: all or none, announced once, and restored
// only where the page has not replaced them since.

describe('script globals', () => {
    test('restoring keeps a property the page made fixed and removes the installed one', () => {
        const target = {};
        const api = {};
        const ready = Promise.resolve(api);
        const restore = installGlobals(target, { MediaForgeJS: api, MediaForgeJSReady: ready });
        Object.defineProperty(target, 'MediaForgeJSReady', {
            value: ready,
            configurable: false,
            writable: false,
        });
        assert.doesNotThrow(restore);
        assert.equal('MediaForgeJS' in target, false);
        assert.equal(target.MediaForgeJSReady, ready);
    });

    for (const filename of [
        'MediaForgeJS.js',
        'MediaForgeJS.min.js',
        'MediaForgeJS.lite.js',
        'MediaForgeJS.lite.min.js',
    ])
        test(`${filename} installs both globals or neither and restores only its own`, async () => {
            const source = await readFile(distUrl(filename), 'utf8');
            const events = [];
            const context = vm.createContext({
                TextEncoder,
                TextDecoder,
                document: {
                    dispatchEvent(event) {
                        events.push(event.type);
                    },
                },
                CustomEvent: class {
                    constructor(type) {
                        this.type = type;
                    }
                },
            });
            const before = Reflect.ownKeys(context);
            const previous = {
                value: { old: true },
                writable: false,
                enumerable: false,
                configurable: true,
            };
            Object.defineProperty(context, 'MediaForgeJS', previous);
            vm.runInContext(source, context);
            const api = context.MediaForgeJS;
            assert.deepEqual(events, ['mediaforgejs:ready']);
            assert.equal(await context.MediaForgeJSReady, api);
            assert.equal(api.noConflict(), api);
            assert.deepEqual(Object.getOwnPropertyDescriptor(context, 'MediaForgeJS'), previous);
            delete context.MediaForgeJS;
            assert.deepEqual(Reflect.ownKeys(context), before);

            // A global the page set since is left as it is.
            vm.runInContext(source, context);
            const newer = { newer: true };
            const owned = context.MediaForgeJS;
            context.MediaForgeJS = newer;
            owned.noConflict();
            assert.equal(context.MediaForgeJS, newer);
            delete context.MediaForgeJS;

            // A global that cannot be set stops the installation before either is set.
            Object.defineProperty(context, 'MediaForgeJSReady', {
                value: 'reserved',
                configurable: false,
            });
            assert.throws(
                () => vm.runInContext(source, context),
                error =>
                    error.name === 'TypeError' &&
                    /Cannot install global MediaForgeJSReady/.test(error.message),
            );
            assert.equal(context.MediaForgeJS, undefined);
            assert.equal(context.MediaForgeJSReady, 'reserved');
        });
});
