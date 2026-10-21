// Builds dist/ from src/: the script bundles, the ES modules and their chunks, and the
// declarations; then packages/player/dist from its TypeScript. The same sources and
// dependencies give the same bytes: nothing depends on the time, the paths of the checkout or
// the order a directory lists its files in.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    readlink,
    rename,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { installGlobals } from './browser-globals.mjs';
import { featureMap } from './features.mjs';
import { checkLayers, importGraph, pluginFolders } from './layers.mjs';

const run = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const distDir = join(repoRoot, 'dist');
const localTscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const started = Date.now();

/** A failure the build explains itself: printed without a stack. */
class BuildError extends Error {}

// The build runs the TypeScript of the lockfile, never another one on the PATH: another version
// would compile other bytes.
try {
    await stat(localTscPath);
} catch {
    console.error('build: TypeScript is not installed (node_modules/typescript); run npm ci');
    process.exit(1);
}
const { h264Kernels } = await import('./h264-kernels.mjs');
const { writeEsmChunks } = await import('./esm-chunks.mjs');

/**
 * Staging and backup directories are siblings of dist/ named for the process that made them; a
 * build removes those of builds no longer running (stopped, or killed before they cleaned up).
 */
const STAGING = /^\.mediaforge-(?:build|backup)-(\d+)-[A-Za-z0-9]{6}$/;
async function sweepStaleStaging() {
    for (const name of await readdir(dirname(distDir))) {
        const match = STAGING.exec(name);
        if (!match) continue;
        try {
            process.kill(Number(match[1]), 0);
            continue;
        } catch (error) {
            if (error.code === 'EPERM') continue;
        }
        await rm(join(dirname(distDir), name), { recursive: true, force: true });
    }
}

await mkdir(dirname(distDir), { recursive: true });
await sweepStaleStaging();
const stagingDir = await mkdtemp(join(dirname(distDir), `.mediaforge-build-${process.pid}-`));
const esmOutDir = join(stagingDir, 'esm');
const chunkOutDir = join(stagingDir, 'chunks');
const tmpDir = join(stagingDir, '.tmp');

const SHARED_TSC_FLAGS = [
    '--target',
    'ES2022',
    '--lib',
    'ES2022,DOM,DOM.Iterable',
    '--moduleResolution',
    'classic',
    '--strict',
    'true',
    '--esModuleInterop',
    'true',
    '--skipLibCheck',
    'true',
    '--forceConsistentCasingInFileNames',
    'true',
];

const AMD_LOADER = `var define, require;
(function () {
    'use strict';
    var registry = Object.create(null);
    var cache = Object.create(null);
    define = function (name, deps, factory) { registry[name] = { deps: deps, factory: factory }; };
    require = function (name, onLoad, onError) {
        if (Array.isArray(name)) {
            Promise.resolve()
                .then(function () { return name.map(function (dep) { return require(dep); }); })
                .then(function (modules) { onLoad.apply(null, modules); }, function (error) {
                    if (onError) onError(error);
                });
            return undefined;
        }
        if (cache[name]) return cache[name].exports;
        var record = registry[name];
        if (!record) {
            var plugin =
                typeof __MEDIAFORGE_PLUGIN_OF__ !== 'undefined'
                    ? __MEDIAFORGE_PLUGIN_OF__[name]
                    : undefined;
            if (plugin && registry['core/errors/errors'])
                throw new (require('core/errors/errors').MediaForgeError)(
                    "The '" + plugin + "' plugin is not loaded in this script bundle",
                    'PLUGIN',
                    {
                        plugin: plugin,
                        hint:
                            'Add browser-plugins/' + plugin + '.min.js (or ' +
                                'browser-plugins/all.min.js) after MediaForgeJS.lite.min.js, ' +
                            'or use MediaForgeJS.min.js, which carries every plugin.'
                    }
                );
            throw new Error('MediaForgeJS bundle: unknown module "' + name + '"');
        }
        var module = { exports: {} };
        cache[name] = module;
        var args = record.deps.map(function (dep) {
            if (dep === 'require') return require;
            if (dep === 'exports') return module.exports;
            return require(dep);
        });
        var result = record.factory.apply(null, args);
        if (result !== undefined) module.exports = result;
        return module.exports;
    };
})();
`;

const bundleFooter = entry => `
(function () {
    'use strict';
    var api = require('${entry}');
    var modules = Object.freeze({ define: define, require: require });
    Object.defineProperty(api, '__modules', { value: modules });
    var globalObject = typeof globalThis !== 'undefined' ? globalThis : self;
    var restore = (${installGlobals.toString()})(globalObject, {
        MediaForgeJS: api,
        MediaForgeJSReady: Promise.resolve(api)
    });
    api.noConflict = function () {
        restore();
        return api;
    };
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        try {
            document.dispatchEvent(new CustomEvent('mediaforgejs:ready', { detail: api }));
        } catch (dispatchError) {
            void dispatchError;
        }
    }
})();
`;

/**
 * Runs the local TypeScript compiler; a failure reports what it printed. `label` names the output
 * in the message.
 */
async function runTsc(label, extraArgs) {
    try {
        await run(process.execPath, [localTscPath, ...extraArgs], {
            cwd: repoRoot,
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch (error) {
        const printed = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
        throw new BuildError(`TypeScript failed on ${label}:\n${printed || error.message}`);
    }
}

async function prepareStagingDirectory() {
    await mkdir(tmpDir, { recursive: true });
}

async function publishStagingDirectory() {
    const backupDir = await mkdtemp(join(dirname(distDir), `.mediaforge-backup-${process.pid}-`));
    const retiredDir = join(backupDir, 'dist');
    let preserveBackup = false;
    try {
        try {
            await rename(distDir, retiredDir);
            preserveBackup = true;
        } catch (renameError) {
            if (renameError?.code !== 'ENOENT') throw renameError;
        }
        try {
            await rename(stagingDir, distDir);
        } catch (error) {
            if (preserveBackup) {
                try {
                    await rename(retiredDir, distDir);
                    preserveBackup = false;
                } catch (restoreError) {
                    throw new AggregateError(
                        [error, restoreError],
                        `Build publication failed; previous output remains at ${retiredDir}`,
                    );
                }
            }
            throw error;
        }
        preserveBackup = false;
    } finally {
        await rm(stagingDir, { recursive: true, force: true });
        if (!preserveBackup) await rm(backupDir, { recursive: true, force: true });
    }
}

/**
 * One AMD file of every module the script entries reach, the types left unchecked: the ES module
 * build checks them. One compilation serves every script: emitting AMD asks the checker about each
 * name, which costs about as much as the check itself.
 */
async function compileAmdModules(entries, outFile) {
    await runTsc('the script modules', [
        ...entries.map(entry => join(repoRoot, entry)),
        '--module',
        'amd',
        '--rootDir',
        join(repoRoot, 'src'),
        '--outFile',
        outFile,
        '--removeComments',
        'true',
        '--noCheck',
        'true',
        ...SHARED_TSC_FLAGS,
    ]);
    return readFile(outFile, 'utf8');
}

async function minifyBundle(source) {
    const { minifyJs } = await import('./minify.mjs');
    const code = minifyJs(source);
    if (!code) throw new BuildError('minification produced no output');
    const again = minifyJs(source);
    if (again !== code) throw new BuildError('the minifier is not deterministic');
    // Compiled as the classic script a page loads, without running it.
    try {
        new Script(code);
    } catch (error) {
        throw new BuildError(`a minified bundle does not parse:\n${error.message}`);
    }
    return code;
}

const H264_KERNELS_MODULE = 'codecs/h264/kernels-binary';
const H264_WORKER_MODULE = 'codecs/h264/frame-worker-url';
/**
 * The H.264 frame worker of the script bundles: h264-worker(.min).js next to the plugin scripts,
 * loaded by a classic worker from a Blob (so the plugin may come from another origin), matching the
 * minification of the script.
 */
const H264_SCRIPT_WORKER = `(function () {
    var script = typeof document !== 'undefined' ? document.currentScript : null;
    var src = script && script.src;
    var workers =
        typeof Worker === 'function' && typeof Blob === 'function' && typeof URL === 'function';
    if (!src || !workers) return undefined;
    var path = new URL(src).pathname;
    var file = path.slice(path.lastIndexOf('/') + 1);
    var dir = file.indexOf('MediaForgeJS') === 0 ? 'browser-plugins/' : '';
    var min = file.slice(-7) === '.min.js' ? '.min' : '';
    var url = new URL(dir + 'h264-worker' + min + '.js', src).href;
    return {
        browser: function () {
            var code = 'importScripts(' + JSON.stringify(url) + ');';
            return new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
        },
        node: null
    };
})()`;
/**
 * The H.264 SIMD kernels, assembled from scripts/h264-kernels.mjs, deflated and in base64: about a
 * third of the bytes, inflated once when the decoder first needs them.
 */
const H264_KERNELS = deflateRawSync(Buffer.from(h264Kernels()), { level: 9 }).toString('base64');

/**
 * The helpers tsc emits before the first module, and each module's text and dependencies by name.
 */
function splitAmdModules(amd) {
    const starts = [...amd.matchAll(/^define\("([^"]+)", \[([^\]]*)\]/gm)];
    const names = source => [...source.matchAll(/"([^"]+)"/g)].map(name => name[1]);
    const modules = new Map();
    starts.forEach((match, index) => {
        const text = amd.slice(
            match.index,
            index + 1 < starts.length ? starts[index + 1].index : amd.length,
        );
        const dynamic = [...text.matchAll(/require\(\[([^\]]*)\]/g)].flatMap(call =>
            names(call[1]),
        );
        const staticDeps = names(match[2]).filter(dep => dep !== 'require' && dep !== 'exports');
        modules.set(match[1], { text, deps: [...staticDeps, ...dynamic], staticDeps });
    });
    return { prelude: starts.length ? amd.slice(0, starts[0].index) : amd, modules };
}

/**
 * Modules reachable from `entry`, in definition order, leaving out those `loaded` already defines
 * and the modules only reached through the dynamic imports of `lazy` modules.
 */
function chunkModules(split, entry, loaded, lazy = new Set()) {
    const reached = new Set();
    const queue = [entry];
    while (queue.length) {
        const name = queue.pop();
        if (reached.has(name) || loaded.has(name)) continue;
        const module = split.modules.get(name);
        if (!module) throw new Error(`build: module ${name} is missing from the compilation`);
        reached.add(name);
        queue.push(...(lazy.has(name) ? module.staticDeps : module.deps));
    }
    return [...split.modules.keys()].filter(name => reached.has(name));
}

/**
 * Declarations of the build-time values the modules `names` read: the H.264 kernels and frame
 * worker.
 */
function injections(names) {
    let text = '';
    if (names.includes(H264_KERNELS_MODULE))
        text += `var __MEDIAFORGE_H264_KERNELS__ = ${JSON.stringify(H264_KERNELS)};\n`;
    if (names.includes(H264_WORKER_MODULE))
        text += `var __MEDIAFORGE_H264_WORKER__ = ${H264_SCRIPT_WORKER};\n`;
    return text;
}

/**
 * The H.264 frame worker at `path` from the module that starts it, in the form bundlers follow for
 * browsers; Node's worker_threads load the file itself, from a URL built as a string so that
 * bundlers neither emit it as an asset nor warn about it.
 */
const esmWorker = path => `{
    browser:
        typeof Worker === 'function'
            ? () => new Worker(new URL('${path}', import.meta.url), { type: 'module' })
            : null,
    node: () => {
        const base = String(import.meta.url);
        return new URL(base.slice(0, base.lastIndexOf('/') + 1) + '${path}');
    },
}`;

/**
 * A script-tag bundle: the modules `entry` reaches at run time, dynamic imports included (they are
 * evaluated on first use), except those only the plugin descriptors of `lazy` import. tsc emits
 * every file of the program into an AMD outFile, type-only imports included, so the rest is left
 * out here.
 */
function composeMainBundle(banner, split, entry, lazy, pluginOf) {
    const names = chunkModules(split, entry, new Set(), lazy);
    let worker = injections(names);
    if (pluginOf) worker += `var __MEDIAFORGE_PLUGIN_OF__ = ${JSON.stringify(pluginOf)};\n`;
    const modules = names.map(name => split.modules.get(name).text).join('');
    return {
        names: new Set(names),
        source:
            `${banner}(function () {\n'use ` +
            `strict';\n${worker}${AMD_LOADER}${split.prelude}${modules}` +
            `${bundleFooter(entry)}\n})();\n`,
    };
}

/** A script that adds the modules `roots` reach, which the lite bundle lacks, to its loader. */
function composeChunk(banner, label, split, roots, loaded) {
    const names = [...new Set(roots.flatMap(root => chunkModules(split, root, loaded)))];
    const ordered = [...split.modules.keys()].filter(name => names.includes(name));
    const worker = injections(ordered);
    return `${banner}(function () {
'use strict';
var api = (typeof globalThis !== 'undefined' ? globalThis : self).MediaForgeJS;
if (!api || !api.__modules) throw new Error('MediaForgeJS ${label}: load ' +
    'MediaForgeJS.lite.min.js first');
var define = api.__modules.define;
var require = api.__modules.require;
${worker}${split.prelude}${ordered.map(name => split.modules.get(name).text).join('')}
})();
`;
}

/**
 * Each plugin of the library, in the order of `allPlugins`, with its descriptor module (the index
 * of its folder, which the lite bundle keeps) and the modules its implementation loads: the
 * dynamic imports of that descriptor, read off the import graph.
 */
async function pluginImports() {
    const srcDir = join(repoRoot, 'src');
    const { modules, edges } = await importGraph(srcDir);
    const list = await readFile(join(srcDir, 'plugins/index.ts'), 'utf8');
    const order = /allPlugins[^=]*=\s*Object\.freeze\(\[([^\]]*)\]/.exec(list)?.[1];
    if (!order) throw new Error('build: plugins/index.ts lists no allPlugins');
    const names = order
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
    const found = new Map();
    for (const folder of pluginFolders(modules)) {
        const descriptor = `${folder}/index`;
        const text = await readFile(join(srcDir, `${descriptor}.ts`), 'utf8');
        const name = /^export const (\w+) = definePlugin\(/m.exec(text)?.[1];
        if (!name) throw new Error(`build: ${descriptor}.ts defines no plugin`);
        const roots = edges
            .filter(edge => edge.from === descriptor && edge.kind === 'dynamic')
            .map(edge => edge.to);
        found.set(name, { descriptor, roots });
    }
    const missing = names.filter(name => !found.has(name));
    const unlisted = [...found.keys()].filter(name => !names.includes(name));
    if (missing.length || unlisted.length)
        throw new Error(
            'build: plugin folders and allPlugins disagree ' +
                `(${[...missing, ...unlisted].join(', ')})`,
        );
    return new Map(names.map(name => [name, found.get(name)]));
}

async function writeScript(path, source) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, 'utf8');
    await writeFile(`${path.slice(0, -'.js'.length)}.min.js`, await minifyBundle(source), 'utf8');
}

/** The AMD modules of the script bundles: the full and lite bundles and the H.264 frame worker. */
function compileScriptSources() {
    return compileAmdModules(
        [
            'src/api/entries/browser.ts',
            'src/api/entries/browser-lite.ts',
            'src/codecs/h264/frame-worker.ts',
        ],
        join(tmpDir, 'scripts.amd.js'),
    );
}

async function buildSingleFileBundles(amd) {
    const split = splitAmdModules(amd);
    const { source: main } = composeMainBundle(
        '/*! MediaForgeJS - browser media converter, with every plugin (evaluated on first use). ' +
            '*/\n',
        split,
        'api/entries/browser',
        new Set(),
    );
    await writeScript(join(stagingDir, 'MediaForgeJS.js'), main);

    const plugins = await pluginImports();
    // The first module each plugin's implementation loads names the plugin script it is missing
    // from.
    const pluginOf = Object.fromEntries(
        [...plugins].flatMap(([name, { roots }]) => roots.map(root => [root, name])),
    );
    // The lite bundle keeps the plugin descriptors and leaves out what their dynamic imports load.
    const descriptors = [
        'plugins/index',
        ...[...plugins.values()].map(plugin => plugin.descriptor),
    ];
    const { names: loaded, source: lite } = composeMainBundle(
        '/*! MediaForgeJS lite - browser media converter without plugins; plugins load as ' +
            'separate scripts. */\n',
        split,
        'api/entries/browser-lite',
        new Set(descriptors),
        pluginOf,
    );
    await writeScript(join(stagingDir, 'MediaForgeJS.lite.js'), lite);

    const worker = 'codecs/h264/frame-worker';
    const workerModules = chunkModules(split, worker, new Set())
        .map(name => split.modules.get(name).text)
        .join('');
    await writeScript(
        join(stagingDir, 'browser-plugins', 'h264-worker.js'),
        '/*! MediaForgeJS H.264 frame worker ' +
            `*/\n${AMD_LOADER}${split.prelude}${workerModules}\nrequire('${worker}');\n`,
    );

    for (const [name, { roots }] of plugins)
        await writeScript(
            join(stagingDir, 'browser-plugins', `${name}.js`),
            composeChunk(
                `/*! MediaForgeJS plugin ${name}: pass MediaForgeJS.plugins.${name} to plugins: ` +
                    `{ add: [...] } */\n`,
                `plugin ${name}`,
                split,
                roots,
                loaded,
            ),
        );
    await writeScript(
        join(stagingDir, 'browser-plugins', 'all.js'),
        composeChunk(
            '/*! MediaForgeJS plugins: every plugin implementation for the lite bundle */\n',
            'plugins',
            split,
            [...plugins.values()].flatMap(plugin => plugin.roots),
            loaded,
        ),
    );
}

/** The ES modules, with the type check of the build. */
async function buildEsmJavaScript() {
    await runTsc('the ES modules', [
        '--project',
        join(repoRoot, 'tsconfig.json'),
        '--outDir',
        esmOutDir,
        '--declaration',
        'false',
        '--sourceMap',
        'false',
        '--module',
        'ES2022',
        '--removeComments',
        'true',
    ]);
}

/** The files under `dir` whose names end in `suffix`. */
async function filesEndingIn(dir, suffix) {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await filesEndingIn(path, suffix)));
        else if (entry.name.endsWith(suffix)) files.push(path);
    }
    return files;
}

const isFile = path =>
    stat(path).then(
        found => found.isFile(),
        () => false,
    );

/**
 * Gives the relative specifiers of the emitted files under `dir` that end in `suffix` ('.js' or
 * '.d.ts') the names Node and bundlers resolve: './x' becomes './x.js', or './x/index.js' for a
 * folder. tsc emits them as they are written in src.
 */
async function addExtensions(dir, suffix) {
    const specifier = /((?:from\s+|import\(\s*)['"])(\.{1,2}(?:\/[^'"]*)?)(['"])/g;
    for (const file of await filesEndingIn(dir, suffix)) {
        const source = await readFile(file, 'utf8');
        const resolved = new Map();
        for (const match of source.matchAll(specifier)) {
            const name = match[2];
            if (resolved.has(name)) continue;
            const base = resolve(dirname(file), name);
            resolved.set(
                name,
                /\.(?:js|mjs|cjs|json)$/.test(name)
                    ? name
                    : (await isFile(`${base}${suffix}`))
                      ? `${name}.js`
                      : (await isFile(join(base, `index${suffix}`)))
                        ? `${name}/index.js`
                        : name,
            );
        }
        let text = source;
        for (const [before, after] of resolved)
            if (before !== after)
                text = text
                    .replaceAll(`'${before}'`, `'${after}'`)
                    .replaceAll(`"${before}"`, `"${after}"`);
        if (text !== source) await writeFile(file, text, 'utf8');
    }
}

/**
 * Files 0644 and directories 0755, whatever the umask (mkdtemp makes the staging directory 0700):
 * npm pack keeps the modes it finds, and a server running as another user reads dist/.
 */
async function normalizeModes(dir) {
    await chmod(dir, 0o755);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await normalizeModes(path);
        else await chmod(path, 0o644);
    }
}

/**
 * Keeps the declarations the package's entries reach and deletes the rest: the `types` file of each
 * entry in the exports map and every declaration file those reference, so internal modules that no
 * public type mentions ship no .d.ts. Their JavaScript stays in dist/esm, where the exports map
 * keeps it out of reach.
 */
async function pruneDeclarations() {
    const { exports } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const pending = Object.values(exports)
        .filter(target => typeof target === 'object' && target.types)
        .map(target => join(stagingDir, target.types.replace(/^\.\/dist\//, '')));
    const reached = new Set();
    const reference = /(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
    while (pending.length) {
        const file = pending.pop();
        if (reached.has(file)) continue;
        reached.add(file);
        const source = await readFile(file, 'utf8');
        for (const match of source.matchAll(reference))
            pending.push(join(dirname(file), match[1].replace(/\.js$/, '.d.ts')));
    }
    const walk = async dir => {
        let left = 0;
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (fullPath === esmOutDir || fullPath === chunkOutDir || fullPath === tmpDir) {
                    left++;
                    continue;
                }
                if (await walk(fullPath)) left++;
                else await rm(fullPath, { recursive: true });
            } else if (fullPath.endsWith('.d.ts') && !reached.has(fullPath)) await rm(fullPath);
            else left++;
        }
        return left;
    };
    await walk(stagingDir);
}

/**
 * Fails the build when an import breaks the layering of src (scripts/layers.mjs) or the feature map
 * (scripts/features.mjs).
 */
async function assertLayers() {
    const layers = await checkLayers(join(repoRoot, 'src'));
    if (layers.problems.length)
        throw new BuildError(
            `the layering of src is broken:\n${layers.problems.join('\n')}\nSee ` +
                `docs/ARCHITECTURE.md.`,
        );
    const features = await featureMap(repoRoot);
    if (features.problems.length)
        throw new BuildError(
            `the feature map is broken:\n${features.problems.join('\n')}\nSee ` +
                `docs/ARCHITECTURE.md.`,
        );
}

/** Replaces `typeof name === type ? name : fallback` in an ESM module with `code`. */
async function injectIntoEsm(module, name, type, fallback, code) {
    const inlinePath = join(esmOutDir, `${module}.js`);
    const source = await readFile(inlinePath, 'utf8');
    const pattern = new RegExp(
        `typeof ${name} === '${type}'\\s*\\?\\s*${name}\\s*:\\s*${fallback}`,
    );
    if (!pattern.test(source)) {
        throw new BuildError(`the ${name} injection point is missing from ${inlinePath}`);
    }
    await writeFile(
        inlinePath,
        source.replace(pattern, () => code),
        'utf8',
    );
}

/**
 * dist/esm/package.json: Node takes a module's format from its nearest package.json and parses that
 * file's exports map again for every module it loads, so the small scope file saves the package's
 * large map on each of them. Bundlers read sideEffects from the same file, which keeps the modules
 * free of side effects as the package declares.
 */
async function writeEsmScope() {
    await writeFile(
        join(esmOutDir, 'package.json'),
        `${JSON.stringify({ type: 'module', sideEffects: false })}\n`,
    );
}

/** The declarations, the types left unchecked: the ES module build checks them. */
async function buildTypes() {
    await runTsc('the declarations', [
        '--project',
        join(repoRoot, 'tsconfig.json'),
        '--outDir',
        stagingDir,
        '--declaration',
        'true',
        '--emitDeclarationOnly',
        'true',
        '--noCheck',
        'true',
    ]);
}

/**
 * The player package: its TypeScript, which uses mediaforgejs through its public entries only,
 * compiled into packages/player/dist against the dist/ just published. The package finds
 * mediaforgejs as an installed peer dependency would be found, through
 * packages/player/node_modules/mediaforgejs: a link to the repository, which the build makes or
 * mends.
 */
async function buildPlayerPackage() {
    const dir = join(repoRoot, 'packages', 'player');
    const link = join(dir, 'node_modules', 'mediaforgejs');
    let target;
    try {
        target = resolve(dirname(link), await readlink(link));
    } catch {}
    if (target !== repoRoot) {
        await rm(link, { recursive: true, force: true });
        await mkdir(dirname(link), { recursive: true });
        await symlink('../../..', link, 'junction');
    }
    const staging = await mkdtemp(join(dir, '.build-'));
    try {
        await runTsc('the player package', [
            '--project',
            join(dir, 'tsconfig.json'),
            '--outDir',
            staging,
        ]);
        await normalizeModes(staging);
        await rm(join(dir, 'dist'), { recursive: true, force: true });
        await rename(staging, join(dir, 'dist'));
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

async function main() {
    await assertLayers();
    await prepareStagingDirectory();
    try {
        // The three compilations run together; the rest waits for the ones it reads.
        const scripts = compileScriptSources();
        const esm = buildEsmJavaScript();
        const types = buildTypes();
        const settled = await Promise.allSettled([scripts, esm, types]);
        const failed = settled.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        await buildSingleFileBundles(settled[0].value);
        await addExtensions(esmOutDir, '.js');
        await injectIntoEsm(
            H264_KERNELS_MODULE,
            '__MEDIAFORGE_H264_KERNELS__',
            'string',
            "''",
            JSON.stringify(H264_KERNELS),
        );
        // The frame worker of the H.264 decoder; the chunks point this at the worker's chunk.
        await injectIntoEsm(
            H264_WORKER_MODULE,
            '__MEDIAFORGE_H264_WORKER__',
            'object',
            'null',
            esmWorker('./frame-worker.js'),
        );
        await writeEsmChunks({
            esmDir: esmOutDir,
            chunkDir: chunkOutDir,
            entries: (await readdir(join(repoRoot, 'src/api/entries')))
                .filter(file => file.endsWith('.ts') && !file.startsWith('browser'))
                .map(file => `api/entries/${file.slice(0, -'.ts'.length)}`)
                .sort(),
            startup: ['api/entries/lite', 'api/entries/index'],
        });
        await writeEsmScope();
        await addExtensions(stagingDir, '.d.ts');
        await pruneDeclarations();
        await rm(tmpDir, { recursive: true, force: true });
        await normalizeModes(stagingDir);
    } catch (buildError) {
        await rm(stagingDir, { recursive: true, force: true });
        throw buildError;
    }
    await publishStagingDirectory();
    await buildPlayerPackage();
    console.log(
        `build: dist/MediaForgeJS(.lite)(.min).js, browser-plugins/, esm/, ` +
            `chunks/, **.d.ts, packages/player/dist in ` +
            `${Math.round((Date.now() - started) / 1000)} s`,
    );
}

try {
    await main();
} catch (error) {
    console.error(error instanceof BuildError ? `build: ${error.message}` : error);
    process.exit(1);
}
