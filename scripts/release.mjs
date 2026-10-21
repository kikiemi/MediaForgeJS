import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
    archiveRecord,
    closurePlan,
    dependencyEdges,
    installOffline,
    offlineEnvironment,
    requiredPackages,
    sha256,
} from './release-offline.mjs';
import { runtimeConsumer, typedConsumer } from './release-consumer.mjs';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.MEDIAFORGE_RELEASE_DIR ?? 'release');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const mode = process.argv[2] ?? 'pack';
const manifestPath = join(output, 'manifest.json');

/** A failure the release explains itself: printed without a stack. */
class ReleaseError extends Error {}

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

function lockDependency(lock, fromKey, name) {
    let base = fromKey;
    while (true) {
        const key = `${base ? `${base}/` : ''}node_modules/${name}`;
        if (lock.packages[key]) return { key, info: lock.packages[key] };
        if (!base) break;
        const index = base.lastIndexOf('/node_modules/');
        base = index < 0 ? '' : base.slice(0, index);
    }
    throw new Error(
        `Offline dependency is absent from package-lock.json: ${name} (from ` +
            `${fromKey || 'release packages'})`,
    );
}

async function packLockedArchive(name, entry, destination) {
    assert(
        entry.info.resolved?.startsWith('https://') && entry.info.integrity?.startsWith('sha512-'),
        `${name}: locked registry archive and SHA-512 integrity required`,
    );
    await mkdir(destination, { recursive: true });
    const archiveName = `${name.replace(/^@/, '').replaceAll('/', '-')}-${entry.info.version}.tgz`;
    const path = join(destination, archiveName);
    // Existing release archives also let an offline source ZIP be rebuilt without any npm cache.
    for (const candidate of [
        path,
        join(root, 'release', 'offline', basename(destination), archiveName),
    ]) {
        try {
            const archived = await archiveRecord(candidate, archiveName);
            assert.equal(
                archived.integrity,
                entry.info.integrity,
                `${name}: existing archive integrity mismatch`,
            );
            if (candidate !== path) await copyFile(candidate, path);
            break;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    if (!(await exists(path))) {
        // The exact registry URL does not require packument metadata in npm's cache. npm ci caches
        // the archives it installs; one it skipped (another platform's optional package) comes from
        // the registry, checked against the lockfile's integrity below.
        let result;
        let failure;
        for (const network of ['--offline', '--prefer-offline']) {
            try {
                result = await run(
                    npm,
                    [
                        'pack',
                        entry.info.resolved,
                        network,
                        '--no-update-notifier',
                        '--json',
                        '--ignore-scripts',
                        '--pack-destination',
                        destination,
                    ],
                    { cwd: root, maxBuffer: 8 * 1024 * 1024 },
                );
                break;
            } catch (error) {
                failure = error;
            }
        }
        if (!result) {
            const reason = `${failure.stderr ?? ''}`
                .split('\n')
                .find(line => /^npm (?:error|ERR!) (?!code )/.test(line));
            throw new ReleaseError(
                `npm cannot fetch ${name}@${entry.info.version}; run npm ci online` +
                    (reason ? `\n${reason}` : ''),
            );
        }
        const [packed] = JSON.parse(result.stdout);
        assert.equal(packed.filename, archiveName);
    }
    const filename = `${destination.slice(output.length + 1).replaceAll('\\', '/')}/${archiveName}`;
    const record = await archiveRecord(path, filename, {
        source: entry.info.resolved,
        sourceIntegrity: entry.info.integrity,
        lockfilePath: entry.key,
    });
    assert.equal(record.name, name);
    assert.equal(record.version, entry.info.version);
    assert.equal(
        record.integrity,
        entry.info.integrity,
        `${name}: upstream archive integrity mismatch`,
    );
    return record;
}

async function packDependencies(packages) {
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    const products = new Set(packages.map(pkg => pkg.name));
    const dependencies = new Map();
    const queue = packages.map(pkg => ({ pkg, lockKey: '' }));
    while (queue.length) {
        const { pkg, lockKey } = queue.shift();
        for (const edge of dependencyEdges(pkg)) {
            if (products.has(edge.name) || edge.kind === 'optional-peer') continue;
            const entry = lockDependency(lock, lockKey, edge.name);
            if (dependencies.has(edge.name)) {
                assert.equal(
                    dependencies.get(edge.name).version,
                    entry.info.version,
                    `Offline closure cannot flatten conflicting versions: ${edge.name}`,
                );
                continue;
            }
            const record = await packLockedArchive(
                edge.name,
                entry,
                join(output, 'offline', 'dependencies'),
            );
            dependencies.set(record.name, record);
            queue.push({ pkg: record, lockKey: entry.key });
        }
    }
    const toolchain = [];
    for (const name of ['typescript', 'prettier'])
        toolchain.push(
            await packLockedArchive(
                name,
                lockDependency(lock, '', name),
                join(output, 'offline', 'toolchain'),
            ),
        );
    closurePlan(toolchain, []);
    return {
        dependencies: [...dependencies.values()].sort((a, b) => a.name.localeCompare(b.name)),
        toolchain,
    };
}

async function pack() {
    const main = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    // npm pack takes dist/ as it is: without a build it would pack a package without its code.
    for (const target of new Set(Object.values(main.exports).flatMap(exportTargets)))
        if (!(await exists(join(root, target.split('*')[0]))))
            throw new ReleaseError(`${target.replace(/^\.\//, '')} is missing; run npm run build`);
    const directories = [root];
    for (const entry of (await readdir(join(root, 'packages'), { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
    )) {
        if (entry.isDirectory()) directories.push(join(root, 'packages', entry.name));
    }
    await mkdir(output, { recursive: true });
    const packages = [];
    for (const cwd of directories) {
        const info = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
        assert.equal(info.version, main.version, `${info.name}: mismatched release version`);
        if (cwd !== root && info.peerDependencies?.mediaforgejs)
            assert.equal(info.peerDependencies.mediaforgejs, `^${main.version}`);
        const npmPack = async () => {
            const result = await run(
                npm,
                [
                    'pack',
                    '--offline',
                    '--no-update-notifier',
                    '--json',
                    '--ignore-scripts',
                    '--pack-destination',
                    output,
                ],
                { cwd, maxBuffer: 8 * 1024 * 1024 },
            );
            return JSON.parse(result.stdout)[0];
        };
        let packed = await npmPack();
        // npm keeps the modes it finds, which the umask of the checkout sets: files of other modes
        // become 0644 (0755 if executable) and the package is packed again.
        const loose = packed.files.filter(file => file.mode !== 0o644 && file.mode !== 0o755);
        if (loose.length) {
            for (const file of loose)
                await chmod(join(cwd, file.path), file.mode & 0o111 ? 0o755 : 0o644);
            packed = await npmPack();
        }
        for (const file of packed.files)
            assert(
                !/^(src|test|scripts|node_modules|\.github)\//.test(file.path),
                `${info.name} packs the development file ${file.path}`,
            );
        packages.push(await archiveRecord(join(output, packed.filename), packed.filename));
    }
    assert.deepEqual(packages.map(pkg => pkg.name).sort(), [...requiredPackages].sort());
    const { dependencies, toolchain } = await packDependencies(packages);
    const plan = closurePlan(packages, dependencies);
    // The archives of earlier packs this one does not list leave the release directory, which then
    // holds the same files whatever was packed into it before.
    const listed = new Set([...packages, ...dependencies, ...toolchain].map(pkg => pkg.filename));
    for (const [dir, ours] of [
        ['', /^mediaforgejs.*\.tgz$/],
        ['offline/dependencies', /\.tgz$/],
        ['offline/toolchain', /\.tgz$/],
    ])
        for (const name of await readdir(join(output, dir)))
            if (ours.test(name) && !listed.has(dir ? `${dir}/${name}` : name))
                await rm(join(output, dir, name));
    const files = [];
    for (const [source, target] of [
        ['release-offline.mjs', 'install.mjs'],
        ['release-network-guard.cjs', 'release-network-guard.cjs'],
        ['release-browser.mjs', 'browser.mjs'],
    ]) {
        const destination = join(output, 'offline', target);
        await copyFile(join(root, 'scripts', source), destination);
        const bytes = await readFile(destination);
        files.push({ path: `offline/${target}`, bytes: bytes.length, sha256: sha256(bytes) });
    }
    await writeFile(
        manifestPath,
        JSON.stringify(
            {
                schema: 2,
                version: main.version,
                packages,
                offline: {
                    installer: 'offline/install.mjs',
                    dependencies,
                    toolchain,
                    optionalPeers: plan.optionalPeers,
                    files,
                    compiler:
                        'TypeScript and Prettier are included separately under ' +
                        'offline/toolchain; neither is a runtime dependency',
                },
            },
            null,
            2,
        ) + '\n',
    );
    console.log(
        JSON.stringify(
            {
                action: 'pack',
                output,
                packages: packages.map(({ name, version, bytes, sha256 }) => ({
                    name,
                    version,
                    bytes,
                    sha256,
                })),
                offlineDependencies: dependencies.map(({ name, version, bytes, integrity }) => ({
                    name,
                    version,
                    bytes,
                    integrity,
                })),
            },
            null,
            2,
        ),
    );
}

function typeTarget(entry) {
    if (typeof entry === 'string') return undefined;
    if (typeof entry?.types === 'string') return entry.types;
    for (const value of Object.values(entry ?? {})) {
        const found = typeTarget(value);
        if (found) return found;
    }
}

function exportTargets(entry) {
    return typeof entry === 'string' ? [entry] : Object.values(entry ?? {}).flatMap(exportTargets);
}

async function verify() {
    if (!(await exists(manifestPath)))
        throw new ReleaseError(
            `${relative(root, manifestPath) || manifestPath} is missing; run npm run release:pack`,
        );
    const consumer = await mkdtemp(join(tmpdir(), 'mediaforge-consumer-'));
    const toolchain = await mkdtemp(join(tmpdir(), 'mediaforge-toolchain-'));
    try {
        const { manifest } = await installOffline(output, consumer);
        const imports = [];
        for (const pkg of manifest.packages) {
            const base = join(consumer, 'node_modules', pkg.name);
            const installed = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
            for (const [subpath, entry] of Object.entries(installed.exports)) {
                if (subpath.includes('*')) {
                    // A pattern export: every plugin script it names ships, the full set and the
                    // H.264 worker too.
                    for (const target of exportTargets(entry)) {
                        const [prefix, suffix] = target.split('*');
                        const names = (await readdir(resolve(base, prefix))).filter(name =>
                            name.endsWith(suffix),
                        );
                        for (const name of ['all', 'h264', 'h264-worker'])
                            assert(
                                names.includes(`${name}${suffix}`),
                                `${pkg.name}: missing ${prefix}${name}${suffix}`,
                            );
                    }
                    continue;
                }
                for (const target of exportTargets(entry))
                    assert(
                        (await stat(resolve(base, target))).isFile(),
                        `${pkg.name}: missing ${target}`,
                    );
                const specifier = pkg.name + (subpath === '.' ? '' : subpath.slice(1));
                if (typeTarget(entry))
                    imports.push(
                        `import type * as entry${imports.length} from ` +
                            `${JSON.stringify(specifier)};\nexport type ` +
                            `PublicEntry${imports.length} = typeof entry${imports.length};`,
                    );
            }
        }
        const rawFixture = (await import('../test/helpers/prores-raw-fixtures.mjs')).proResRawFrames
            .aprn;
        await writeFile(join(consumer, 'verify.mjs'), runtimeConsumer(rawFixture));
        const runtimeReport = join(consumer, 'runtime-network.json');
        const env = offlineEnvironment(
            join(consumer, '.npm-cache'),
            join(consumer, '.npmrc'),
            runtimeReport,
        );
        const runtime = await run(process.execPath, ['verify.mjs'], {
            cwd: consumer,
            env,
            maxBuffer: 8 * 1024 * 1024,
        });
        assert.deepEqual(JSON.parse(await readFile(runtimeReport, 'utf8')), {
            blocked: true,
            attempts: [],
        });
        await writeFile(
            join(consumer, 'consumer.ts'),
            typedConsumer + '\n' + imports.join('\n') + '\n',
        );
        await writeFile(
            join(consumer, 'tsconfig.json'),
            JSON.stringify(
                {
                    compilerOptions: {
                        target: 'ES2022',
                        module: 'NodeNext',
                        moduleResolution: 'NodeNext',
                        strict: true,
                        skipLibCheck: false,
                        noEmit: true,
                        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
                        types: [],
                    },
                    include: ['consumer.ts'],
                },
                null,
                2,
            ),
        );
        await installOffline(output, toolchain, { toolchain: true });
        const compiler = join(toolchain, 'node_modules/typescript/bin/tsc');
        const compilerReport = join(toolchain, 'compiler-network.json');
        const compilerEnv = offlineEnvironment(
            join(toolchain, '.npm-cache'),
            join(toolchain, '.npmrc'),
            compilerReport,
        );
        await run(process.execPath, [compiler, '--project', join(consumer, 'tsconfig.json')], {
            cwd: consumer,
            env: compilerEnv,
        });
        assert.deepEqual(JSON.parse(await readFile(compilerReport, 'utf8')), {
            blocked: true,
            attempts: [],
        });
        console.log(runtime.stdout.trim());
        console.log(
            `release: verified ${manifest.packages.length} public ` +
                `packages, ${manifest.offline.dependencies.length} local dependency archives ` +
                `and ${imports.length} strict NodeNext public declarations; browser execution ` +
                `not included`,
        );
    } finally {
        await rm(consumer, { recursive: true, force: true });
        await rm(toolchain, { recursive: true, force: true });
    }
}

try {
    if (mode === 'pack') await pack();
    else if (mode === 'verify') await verify();
    else throw new ReleaseError('usage: node scripts/release.mjs pack|verify');
} catch (error) {
    console.error(error instanceof ReleaseError ? `release: ${error.message}` : error);
    process.exit(1);
}
