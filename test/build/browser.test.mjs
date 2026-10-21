import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import browserAssert from '../browser/assert.mjs';
import * as browserTest from '../browser/node-test.mjs';
import { startServer } from '../browser/server.mjs';

// The browser test path (scripts/browser-tests.mjs): its node:test and node:assert for the page
// behave as Node's for what the test files use, and its server hands out only what the page needs.

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Whether `check` throws with both asserts, or with neither. */
async function sameVerdict(check) {
    const verdict = async implementation => {
        try {
            await check(implementation);
            return 'pass';
        } catch {
            return 'throw';
        }
    };
    assert.equal(await verdict(browserAssert), await verdict(assert), String(check));
}

describe('browser test path', () => {
    test('the page assert agrees with node:assert/strict', async () => {
        const checks = [
            a => a.equal(1, 1),
            a => a.equal(1, '1'),
            a => a.equal(NaN, NaN),
            a => a(0),
            a => a.ok('yes'),
            a => a.deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }),
            a => a.deepEqual({ a: 1 }, { a: 1, b: undefined }),
            a => a.deepEqual([1, 2], { 0: 1, 1: 2 }),
            a => a.deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])),
            a => a.deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])),
            a => a.deepEqual(new Map([[1, 'a']]), new Map([[1, 'a']])),
            a => a.deepEqual(new Set([1]), new Set([2])),
            a => a.notDeepEqual({ a: 1 }, { a: 2 }),
            a => a.match('abc', /b/),
            a => a.match('abc', /d/),
            a =>
                a.throws(() => {
                    throw new TypeError('x');
                }, TypeError),
            a => a.throws(() => {}),
            a =>
                a.throws(
                    () => {
                        throw Object.assign(new Error('bad input'), { code: 'INPUT' });
                    },
                    { code: 'INPUT', message: /bad/ },
                ),
            a => a.rejects(Promise.reject(new Error('no')), /no/),
            a => a.rejects(Promise.resolve(1)),
            a =>
                a.rejects(Promise.reject(Object.assign(new Error('e'), { code: 'PLUGIN' })), {
                    code: 'DECODE',
                }),
        ];
        for (const check of checks) await sameVerdict(check);
    });

    test('the page node:test runs suites, hooks, skips, todos and failures in order', async () => {
        const { describe: group, test: check, beforeEach } = browserTest;
        browserTest.startFile();
        const order = [];
        group('outer', () => {
            beforeEach(() => order.push('each'));
            check('passes', () => order.push('pass'));
            check('fails', () => {
                throw new Error('broken');
            });
            check('is skipped', { skip: 'not here' }, () => order.push('never'));
            check('is to do', { todo: 'later' });
            group('inner', { skip: 'whole group' }, () =>
                check('inside', () => order.push('never')),
            );
            check('skips itself', t => t.skip('at run time'));
        });
        const results = await browserTest.runFile();
        assert.deepEqual(
            results.map(result => [result.name, result.status, result.reason ?? '']),
            [
                ['outer > passes', 'pass', ''],
                ['outer > fails', 'fail', ''],
                ['outer > is skipped', 'skip', 'not here'],
                ['outer > is to do', 'todo', 'later'],
                ['outer > inner > inside', 'skip', 'whole group'],
                ['outer > skips itself', 'skip', 'at run time'],
            ],
        );
        assert.match(results[1].error, /broken/);
        assert.deepEqual(order, ['each', 'pass', 'each', 'each']);
    });

    test('the server serves the page, dist/, test/ and packages/, and nothing else', async () => {
        const server = await startServer(root, ['test/build/bundles-browser.test.mjs']);
        try {
            const page = await (await fetch(server.url)).text();
            const map = JSON.parse(page.match(/<script type="importmap">(.*?)<\/script>/)[1]);
            assert.equal(map.imports['node:test'], '/test/browser/node-test.mjs');
            assert.equal(map.imports['mediaforgejs/lite'], '/dist/esm/api/entries/lite.js');
            assert.deepEqual(await (await fetch(`${server.url}__files.json`)).json(), [
                'test/build/bundles-browser.test.mjs',
            ]);
            const part = await fetch(`${server.url}package.json`);
            assert.equal(part.status, 404);
            const range = await fetch(`${server.url}test/browser/page.mjs`, {
                headers: { Range: 'bytes=0-1' },
            });
            assert.equal(range.status, 206);
            assert.equal(await range.text(), '//');
            for (const path of ['src/api/forge.ts', 'test/../package.json', 'node_modules/x'])
                assert.equal((await fetch(`${server.url}${path}`)).status, 404, path);
            assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
        } finally {
            await server.close();
        }
    });
});
