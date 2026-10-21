import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { validateRelease } from '../scripts/release-offline.mjs';
import { startOfflineBrowserServer } from '../scripts/release-browser.mjs';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test(
    'release includes the unchanged locked closure and installs without a shared ' + 'cache',
    async t => {
        const output = await mkdtemp(join(tmpdir(), 'mediaforge-release-test-'));
        try {
            await run(process.execPath, ['scripts/release.mjs', 'pack'], {
                cwd: root,
                env: { ...process.env, MEDIAFORGE_RELEASE_DIR: output },
                maxBuffer: 8 * 1024 * 1024,
            });
            const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
            assert.equal(
                manifest.schema,
                2,
                'offline release must have a dependency-closure manifest',
            );
            assert.deepEqual(manifest.offline.dependencies.map(pkg => pkg.name).sort(), [
                '@rollup/rollup-linux-x64-gnu',
                'prores-wasm-encoder',
                'turbores',
            ]);
            assert.equal(
                manifest.offline.toolchain?.find(pkg => pkg.name === 'typescript')?.version,
                '5.9.3',
                'verification compiler must be supplied separately from runtime dependencies',
            );
            assert(
                manifest.offline.toolchain.some(pkg => pkg.name === 'prettier'),
                'offline source build must include its formatter',
            );
            const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
            for (const pkg of [...manifest.offline.dependencies, ...manifest.offline.toolchain]) {
                assert.equal(pkg.integrity, lock.packages[`node_modules/${pkg.name}`].integrity);
                assert(pkg.license);
                assert(Array.isArray(pkg.licenseFiles));
            }
            await t.test(
                'portable installer uses only local archives and an initially empty cache',
                async () => {
                    const consumer = join(output, 'consumer');
                    const result = await run(
                        process.execPath,
                        [join(output, 'offline/install.mjs'), consumer],
                        {
                            cwd: tmpdir(),
                        },
                    );
                    const installed = JSON.parse(result.stdout);
                    assert.equal(installed.cacheInitiallyEmpty, true);
                    assert.deepEqual(installed.network, { blocked: true, attempts: [] });
                    // The four packages and their locked dependencies, one of which exists for
                    // linux-x64 only.
                    assert.equal(
                        installed.installed.length,
                        process.platform === 'linux' && process.arch === 'x64' ? 7 : 6,
                    );
                    assert(installed.installed.every(pkg => pkg.verifiedFiles > 0));
                    assert(!installed.installed.some(pkg => pkg.name === 'typescript'));
                    const browser = await startOfflineBrowserServer(consumer);
                    try {
                        const page = await fetch(browser.url);
                        assert.equal(page.status, 200);
                        assert.equal(
                            page.headers.get('cross-origin-embedder-policy'),
                            'require-corp',
                        );
                        assert.match(
                            page.headers.get('content-security-policy'),
                            /connect-src 'self'/,
                        );
                        assert.match(await page.text(), /type="importmap"/);
                        for (const path of [
                            '/node_modules/turbores/dist/turbores.js',
                            '/node_modules/prores-wasm-encoder/dist/prores-core.mjs',
                        ]) {
                            const response = await fetch(new URL(path, browser.url));
                            assert.equal(response.status, 200);
                            assert((await response.arrayBuffer()).byteLength > 1000);
                        }
                        assert.equal(
                            (await fetch(new URL('/package.json', browser.url))).status,
                            404,
                        );
                    } finally {
                        await browser.close();
                    }
                },
            );
            await t.test(
                'development setup preserves the source lockfile with a seeded private cache',
                async () => {
                    const source = join(output, 'source');
                    await mkdir(source);
                    for (const name of ['package.json', 'package-lock.json'])
                        await copyFile(join(root, name), join(source, name));
                    const before = await readFile(join(source, 'package-lock.json'));
                    const result = await run(
                        process.execPath,
                        [join(output, 'offline/install.mjs'), source, '--development'],
                        {
                            cwd: tmpdir(),
                        },
                    );
                    const report = JSON.parse(result.stdout);
                    assert.equal(report.sourceManifestsUnchanged, true);
                    assert.equal(report.cacheInitiallyEmpty, true);
                    assert.deepEqual(report.network, { blocked: true, attempts: [] });
                    assert.deepEqual(await readFile(join(source, 'package-lock.json')), before);
                    for (const name of [
                        'typescript',
                        'prettier',
                        'turbores',
                        'prores-wasm-encoder',
                    ])
                        assert(report.installed.some(pkg => pkg.name === name));
                    await assert.rejects(
                        run(process.execPath, [
                            join(output, 'offline/install.mjs'),
                            source,
                            '--development',
                        ]),
                        /already contains node_modules/,
                    );
                },
            );
            await t.test(
                'a missing transitive optional dependency is rejected before installation',
                async () => {
                    const changed = structuredClone(manifest);
                    changed.offline.dependencies = changed.offline.dependencies.filter(
                        pkg => pkg.name !== '@rollup/rollup-linux-x64-gnu',
                    );
                    await writeFile(join(output, 'manifest.json'), JSON.stringify(changed));
                    try {
                        await assert.rejects(validateRelease(output), /Incomplete offline closure/);
                    } finally {
                        await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest));
                    }
                },
            );
            await t.test(
                'dependency metadata and tarball tampering cannot pass checksum verification',
                async () => {
                    const changed = structuredClone(manifest);
                    changed.offline.dependencies.find(pkg => pkg.name === 'turbores').sha256 =
                        '0'.repeat(64);
                    await writeFile(join(output, 'manifest.json'), JSON.stringify(changed));
                    try {
                        await assert.rejects(validateRelease(output), /sha256 mismatch/);
                    } finally {
                        await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest));
                    }
                    const pkg = manifest.offline.dependencies.find(pkg => pkg.name === 'turbores');
                    const archive = join(output, pkg.filename);
                    const original = await readFile(archive);
                    const corrupted = Buffer.from(original);
                    corrupted[corrupted.length - 10] ^= 1;
                    await writeFile(archive, corrupted);
                    try {
                        await assert.rejects(validateRelease(output));
                    } finally {
                        await writeFile(archive, original);
                    }
                },
            );
            await t.test(
                'runtime guard records and fails even a caught fetch attempt',
                async () => {
                    const report = join(output, 'guard-probe.json');
                    await assert.rejects(
                        run(
                            process.execPath,
                            [
                                '--require',
                                join(output, 'offline/release-network-guard.cjs'),
                                '--input-type=module',
                                '-e',
                                "try { await fetch('https://example.invalid'); } catch {}",
                            ],
                            {
                                env: { ...process.env, MEDIAFORGE_NETWORK_REPORT: report },
                            },
                        ),
                        error => error.code === 86,
                    );
                    assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), {
                        blocked: true,
                        attempts: ['fetch'],
                    });
                },
            );
        } finally {
            await rm(output, { recursive: true, force: true });
        }
    },
);

test('optional dependency omission checks libc as well as OS and CPU', async () => {
    const helper = await import('../scripts/release-offline.mjs');
    assert.equal(
        typeof helper.platformMismatches,
        'function',
        'offline installer must check libc restrictions',
    );
    const pkg = { os: ['linux'], cpu: ['x64'], libc: ['glibc'] };
    assert.deepEqual(helper.platformMismatches(pkg, { os: 'linux', cpu: 'x64', libc: 'musl' }), [
        'libc',
    ]);
    assert.deepEqual(
        helper.platformMismatches(pkg, { os: 'linux', cpu: 'x64', libc: 'glibc' }),
        [],
    );
    assert.deepEqual(helper.platformMismatches(pkg, { os: 'darwin', cpu: 'arm64', libc: null }), [
        'os',
        'cpu',
    ]);
    assert.deepEqual(helper.platformMismatches(pkg, { os: 'linux', cpu: 'x64', libc: null }), []);
});
