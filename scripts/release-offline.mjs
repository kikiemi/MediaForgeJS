import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';

const run = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const requiredPackages = [
    'mediaforgejs',
    'mediaforgejs-player',
    'mediaforgejs-prores',
    'mediaforgejs-prores-raw',
];

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const integrity = data => `sha512-${createHash('sha512').update(data).digest('base64')}`;

function safePath(base, path) {
    assert(
        typeof path === 'string' && !isAbsolute(path) && !path.includes('\\'),
        `Unsafe release path: ${path}`,
    );
    const resolved = resolve(base, path);
    const rel = relative(base, resolved);
    assert(rel && !rel.startsWith('..') && !isAbsolute(rel), `Unsafe release path: ${path}`);
    return resolved;
}

// Inspect npm's tar archives directly, retaining the original upstream compressed bytes.
export function tarFiles(compressed) {
    const bytes = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 });
    const files = new Map();
    let pax = {};
    for (let offset = 0; offset + 512 <= bytes.length;) {
        const header = bytes.subarray(offset, offset + 512);
        if (header.every(value => value === 0)) break;
        const string = (start, end) =>
            header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(string(124, 136).trim(), 8);
        assert(
            Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length,
            'Invalid npm tar size',
        );
        const contents = bytes.subarray(offset + 512, offset + 512 + size);
        const kind = string(156, 157);
        const prefix = string(345, 500);
        const name = pax.path ?? `${prefix ? `${prefix}/` : ''}${string(0, 100)}`;
        offset += 512 + Math.ceil(size / 512) * 512;
        if (kind === 'x') {
            pax = {};
            let cursor = 0;
            while (cursor < contents.length) {
                const space = contents.indexOf(32, cursor);
                const length = Number(contents.subarray(cursor, space).toString());
                assert(length > 0 && cursor + length <= contents.length, 'Invalid npm pax header');
                const field = contents.subarray(space + 1, cursor + length - 1).toString();
                const equals = field.indexOf('=');
                pax[field.slice(0, equals)] = field.slice(equals + 1);
                cursor += length;
            }
            continue;
        }
        pax = {};
        if (kind === '5') continue;
        assert(kind === '' || kind === '0', `Unsupported npm archive entry type ${kind}: ${name}`);
        assert(
            name.startsWith('package/') && !name.split('/').includes('..'),
            `Unsafe npm archive entry: ${name}`,
        );
        const path = name.slice('package/'.length);
        assert(!files.has(path), `Duplicate npm archive entry: ${path}`);
        files.set(path, contents);
    }
    assert(files.has('package.json'), 'npm archive is missing package.json');
    return files;
}

export async function archiveRecord(path, filename, extra = {}) {
    const bytes = await readFile(path);
    const files = tarFiles(bytes);
    const info = JSON.parse(files.get('package.json').toString());
    assert(
        info.name && info.version && info.license,
        `Missing package identity/license: ${filename}`,
    );
    return {
        name: info.name,
        version: info.version,
        filename,
        bytes: bytes.length,
        files: files.size,
        sha256: sha256(bytes),
        integrity: integrity(bytes),
        license: info.license,
        licenseFiles: [...files]
            .filter(([path]) =>
                /(^|\/)(licen[cs]e|copying|notice|third.?party.*notice.*)([.-]|$)/i.test(path),
            )
            .map(([path, data]) => ({ path, bytes: data.length, sha256: sha256(data) })),
        dependencies: info.dependencies ?? {},
        optionalDependencies: info.optionalDependencies ?? {},
        peerDependencies: info.peerDependencies ?? {},
        peerDependenciesMeta: info.peerDependenciesMeta ?? {},
        ...(info.os ? { os: info.os } : {}),
        ...(info.cpu ? { cpu: info.cpu } : {}),
        ...(info.libc ? { libc: info.libc } : {}),
        ...extra,
    };
}

export function dependencyEdges(pkg) {
    const result = [];
    for (const [name, range] of Object.entries({
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
    })) {
        result.push({
            from: pkg.name,
            name,
            range,
            kind: Object.hasOwn(pkg.optionalDependencies ?? {}, name) ? 'optional' : 'required',
        });
    }
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
        result.push({
            from: pkg.name,
            name,
            range,
            kind: pkg.peerDependenciesMeta?.[name]?.optional ? 'optional-peer' : 'peer',
        });
    }
    return result;
}

export function closurePlan(packages, dependencies) {
    const all = new Map();
    for (const pkg of [...packages, ...dependencies]) {
        assert(
            !all.has(pkg.name),
            `Offline closure requires one resolved version per package: ${pkg.name}`,
        );
        all.set(pkg.name, pkg);
    }
    const required = new Set(packages.map(pkg => pkg.name));
    const visited = new Set();
    const optionalPeers = [];
    const queue = packages.map(pkg => ({ pkg, optional: false }));
    while (queue.length) {
        const { pkg, optional } = queue.shift();
        const key = `${pkg.name}:${optional}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (!optional) required.add(pkg.name);
        for (const edge of dependencyEdges(pkg)) {
            if (edge.kind === 'optional-peer' && !all.has(edge.name)) {
                optionalPeers.push(edge);
                continue;
            }
            const target = all.get(edge.name);
            assert(
                target,
                `Incomplete offline closure: ${edge.from} requires ${edge.name}@${edge.range} ` +
                    `(${edge.kind})`,
            );
            queue.push({
                pkg: target,
                optional: optional || edge.kind === 'optional' || edge.kind === 'optional-peer',
            });
        }
    }
    for (const pkg of dependencies)
        assert(
            [...visited].some(key => key.startsWith(`${pkg.name}:`)),
            `Unreferenced offline dependency: ${pkg.name}`,
        );
    return { required, optionalPeers };
}

export async function validateRelease(directory) {
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    assert.equal(
        manifest.schema,
        2,
        'Release lacks the offline dependency closure; run release:pack',
    );
    assert.deepEqual(
        manifest.packages.map(pkg => pkg.name).sort(),
        [...requiredPackages].sort(),
        'Release must contain core and both ProRes packages',
    );
    assert(Array.isArray(manifest.offline?.dependencies), 'Release lacks offline dependencies');
    const products = new Set(manifest.packages.map(pkg => pkg.name));
    assert(
        manifest.offline.toolchain?.some(pkg => pkg.name === 'typescript'),
        'Release lacks its verification compiler',
    );
    for (const pkg of [
        ...manifest.packages,
        ...manifest.offline.dependencies,
        ...manifest.offline.toolchain,
    ]) {
        const path = safePath(directory, pkg.filename);
        const actual = await archiveRecord(path, pkg.filename);
        for (const key of Object.keys(actual))
            assert.deepEqual(pkg[key], actual[key], `${pkg.name}: ${key} mismatch`);
        if (products.has(pkg.name))
            assert.equal(pkg.version, manifest.version, `${pkg.name}: release version`);
        else
            assert.equal(
                pkg.sourceIntegrity,
                pkg.integrity,
                `${pkg.name}: upstream integrity mismatch`,
            );
    }
    for (const file of manifest.offline.files) {
        const bytes = await readFile(safePath(directory, file.path));
        assert.equal(bytes.length, file.bytes, `${file.path}: size mismatch`);
        assert.equal(sha256(bytes), file.sha256, `${file.path}: checksum mismatch`);
    }
    closurePlan(manifest.offline.toolchain, []);
    const plan = closurePlan(manifest.packages, manifest.offline.dependencies);
    assert.deepEqual(
        manifest.offline.optionalPeers,
        plan.optionalPeers,
        'Optional peer manifest mismatch',
    );
    return { manifest, plan };
}

export function offlineEnvironment(
    cache,
    config,
    report,
    guard = join(scriptDirectory, 'release-network-guard.cjs'),
) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(npm_config_|node_options$|node_path$|https?_proxy$|all_proxy$|no_proxy$)/i.test(key))
            delete env[key];
    }
    return {
        ...env,
        NODE_OPTIONS: `--require=${JSON.stringify(guard)}`,
        NODE_PATH: '',
        npm_config_cache: cache,
        npm_config_userconfig: config,
        npm_config_globalconfig: `${config}.global`,
        npm_config_offline: 'true',
        npm_config_registry: 'http://127.0.0.1:9',
        npm_config_ignore_scripts: 'true',
        npm_config_update_notifier: 'false',
        MEDIAFORGE_NETWORK_REPORT: report,
    };
}

export function platformMismatches(pkg, host) {
    const matches = (list, current) =>
        !list ||
        list.includes('any') ||
        ((!list.some(item => !item.startsWith('!')) || list.includes(current)) &&
            !list.includes(`!${current}`));
    // An unknown libc is not evidence that an archive may be omitted.
    return ['os', 'cpu', 'libc'].filter(key => host[key] && !matches(pkg[key], host[key]));
}

async function hostPlatform() {
    let libc = null;
    if (process.platform === 'linux') {
        const report = process.report?.getReport();
        if (report?.header.glibcVersionRuntime) libc = 'glibc';
        else if (report?.sharedObjects?.some(path => /ld-musl|libc[.]musl/.test(path)))
            libc = 'musl';
        else {
            try {
                const ldd = await readFile('/usr/bin/ldd', 'utf8');
                if (/musl/.test(ldd)) libc = 'musl';
                else if (/GNU C Library|GLIBC/.test(ldd)) libc = 'glibc';
            } catch {
                /* Missing ldd leaves libc unknown and omission checks fail closed. */
            }
        }
    }
    return { os: process.platform, cpu: process.arch, libc };
}

function recordPlatformOmission(pkg, host) {
    const mismatch = platformMismatches(pkg, host);
    assert(
        mismatch.length > 0,
        `npm silently omitted a compatible optional dependency or libc is unknown: ${pkg.name}`,
    );
    return {
        name: pkg.name,
        reason: 'upstream platform restriction',
        mismatch,
        host,
        os: pkg.os,
        cpu: pkg.cpu,
        libc: pkg.libc,
    };
}

export async function installOffline(directory, target, options = {}) {
    directory = resolve(directory);
    target = resolve(target);
    const validated = await validateRelease(directory);
    const { manifest } = validated;
    const packages = options.toolchain
        ? manifest.offline.toolchain
        : [...manifest.packages, ...manifest.offline.dependencies];
    const plan = options.toolchain ? closurePlan(packages, []) : validated.plan;
    await mkdir(target, { recursive: true });
    assert.equal((await readdir(target)).length, 0, 'Offline consumer directory must be empty');
    const dependencies = {};
    const optionalDependencies = {};
    for (const pkg of packages) {
        const group = plan.required.has(pkg.name) ? dependencies : optionalDependencies;
        group[pkg.name] = `file:${safePath(directory, pkg.filename)}`;
    }
    await writeFile(
        join(target, 'package.json'),
        JSON.stringify(
            { private: true, type: 'module', dependencies, optionalDependencies },
            null,
            2,
        ) + '\n',
    );
    const cache = join(target, '.npm-cache');
    await mkdir(cache);
    assert.equal((await readdir(cache)).length, 0, 'npm cache must start empty');
    const config = join(target, '.npmrc');
    await writeFile(config, '');
    await writeFile(`${config}.global`, '');
    const networkReport = join(target, 'install-network.json');
    const result = await run(
        npm,
        [
            'install',
            '--offline',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--fetch-retries=0',
            '--cache',
            cache,
            '--registry',
            'http://127.0.0.1:9',
        ],
        {
            cwd: target,
            env: offlineEnvironment(cache, config, networkReport),
            maxBuffer: 8 * 1024 * 1024,
        },
    );
    const network = JSON.parse(await readFile(networkReport, 'utf8'));
    assert.deepEqual(network, { blocked: true, attempts: [] }, 'npm attempted network access');
    const installed = [];
    const platformOmissions = [];
    const host = await hostPlatform();
    for (const pkg of packages) {
        let value;
        try {
            value = JSON.parse(
                await readFile(join(target, 'node_modules', pkg.name, 'package.json'), 'utf8'),
            );
        } catch (error) {
            if (error.code !== 'ENOENT' || plan.required.has(pkg.name)) throw error;
            platformOmissions.push(recordPlatformOmission(pkg, host));
            continue;
        }
        assert.equal(value.name, pkg.name);
        assert.equal(value.version, pkg.version, `${pkg.name}: installed version mismatch`);
        const files = tarFiles(await readFile(safePath(directory, pkg.filename)));
        for (const [path, expected] of files) {
            const actual = await readFile(safePath(join(target, 'node_modules', pkg.name), path));
            assert.equal(
                sha256(actual),
                sha256(expected),
                `${pkg.name}: installed file differs from archive: ${path}`,
            );
        }
        installed.push({ name: pkg.name, version: pkg.version, verifiedFiles: files.size });
    }
    const lock = JSON.parse(await readFile(join(target, 'package-lock.json'), 'utf8'));
    for (const [key, entry] of Object.entries(lock.packages)) {
        if (!key) continue;
        assert(entry.resolved?.startsWith('file:'), `${key}: nonlocal dependency resolution`);
        assert.equal(entry.link, undefined, `${key}: dependency must be extracted, not linked`);
    }
    return {
        manifest,
        installed,
        platformOmissions,
        cacheInitiallyEmpty: true,
        network,
        stdout: result.stdout,
    };
}

export async function initializeDevelopment(directory, source) {
    directory = resolve(directory);
    source = resolve(source);
    const { manifest } = await validateRelease(directory);
    const packageBytes = await readFile(join(source, 'package.json'));
    const lockBytes = await readFile(join(source, 'package-lock.json'));
    const info = JSON.parse(packageBytes);
    const lock = JSON.parse(lockBytes);
    assert.equal(
        info.name,
        'mediaforgejs',
        'Development target must be the MediaForgeJS source directory',
    );
    assert.equal(info.version, manifest.version, 'Source and release versions must match');
    try {
        await stat(join(source, 'node_modules'));
        throw new Error(
            'Development target already contains node_modules; use a fresh source copy',
        );
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const archives = [...manifest.offline.dependencies, ...manifest.offline.toolchain];
    const selected = [];
    for (const [key, entry] of Object.entries(lock.packages)) {
        if (!key) continue;
        const archive = archives.find(pkg => pkg.lockfilePath === key);
        assert(archive, `Development archive missing for ${key}`);
        assert.equal(archive.version, entry.version, `${key}: development version mismatch`);
        assert.equal(archive.integrity, entry.integrity, `${key}: development integrity mismatch`);
        selected.push({ archive, optional: entry.optional === true });
    }
    const work = await mkdtemp(join(tmpdir(), 'mediaforge-development-'));
    try {
        const cache = join(work, 'cache');
        await mkdir(cache);
        assert.equal((await readdir(cache)).length, 0);
        const config = join(work, '.npmrc');
        await writeFile(config, '');
        await writeFile(`${config}.global`, '');
        const report = join(work, 'network.json');
        const env = offlineEnvironment(cache, config, report);
        for (const { archive } of selected) {
            await run(
                npm,
                [
                    'cache',
                    'add',
                    safePath(directory, archive.filename),
                    '--offline',
                    '--ignore-scripts',
                ],
                {
                    cwd: work,
                    env,
                },
            );
            assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), {
                blocked: true,
                attempts: [],
            });
        }
        await run(
            npm,
            ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache],
            {
                cwd: source,
                env,
                maxBuffer: 8 * 1024 * 1024,
            },
        );
        const network = JSON.parse(await readFile(report, 'utf8'));
        assert.deepEqual(network, { blocked: true, attempts: [] });
        assert.deepEqual(
            await readFile(join(source, 'package.json')),
            packageBytes,
            'Source package.json changed',
        );
        assert.deepEqual(
            await readFile(join(source, 'package-lock.json')),
            lockBytes,
            'Source lockfile changed',
        );
        const installed = [];
        const platformOmissions = [];
        const host = await hostPlatform();
        for (const { archive, optional } of selected) {
            const base = join(source, 'node_modules', archive.name);
            try {
                await stat(join(base, 'package.json'));
            } catch (error) {
                if (error.code !== 'ENOENT' || !optional) throw error;
                platformOmissions.push(recordPlatformOmission(archive, host));
                continue;
            }
            const files = tarFiles(await readFile(safePath(directory, archive.filename)));
            for (const [path, expected] of files)
                assert.equal(
                    sha256(await readFile(safePath(base, path))),
                    sha256(expected),
                    `${archive.name}: installed development file mismatch: ${path}`,
                );
            installed.push({
                name: archive.name,
                version: archive.version,
                verifiedFiles: files.size,
            });
        }
        return {
            installed,
            platformOmissions,
            cacheInitiallyEmpty: true,
            network,
            sourceManifestsUnchanged: true,
        };
    } finally {
        await rm(work, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert(process.argv[2], 'Usage: node release/offline/install.mjs EMPTY_CONSUMER_DIRECTORY');
    assert(
        !process.argv[3] || ['--toolchain', '--development'].includes(process.argv[3]),
        'Only --toolchain or --development is supported',
    );
    const result =
        process.argv[3] === '--development'
            ? await initializeDevelopment(resolve(scriptDirectory, '..'), process.argv[2])
            : await installOffline(resolve(scriptDirectory, '..'), process.argv[2], {
                  toolchain: process.argv[3] === '--toolchain',
              });
    console.log(
        JSON.stringify(
            {
                installed: result.installed,
                platformOmissions: result.platformOmissions,
                cacheInitiallyEmpty: true,
                network: result.network,
                ...(result.sourceManifestsUnchanged ? { sourceManifestsUnchanged: true } : {}),
            },
            null,
            2,
        ),
    );
}
