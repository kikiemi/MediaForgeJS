// The features of the library and how they may use each other. Every module of src belongs to one
// feature, read off its folder: a plugin folder (one with a manifest.ts) is a feature; in core,
// formats, codecs and pipeline each subfolder is a feature, and the files directly in such a folder
// are one more, named after it (pipeline: the engine); every other top folder of src is one
// feature. Each package of packages/ is a feature too. A feature declares below the features it may
// use; the check compares that with the imports that run (static and dynamic; type-only imports
// are the layer rule's and the compiler's) and fails on an undeclared use, a cycle, a plugin that
// uses more than core and the shared features, a feature without a declaration or without tests,
// and a test file that belongs to no feature. `node scripts/features.mjs` prints the map.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importGraph, pluginFolders } from './layers.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The top folders of src whose subfolders are features of their own. */
const SPLIT = new Set(['core', 'formats', 'codecs', 'pipeline']);

/** Features a plugin may use besides those of core; they use only core and each other. */
export const SHARED = [
    'codecs/pcm',
    'codecs/shared',
    'formats/detection',
    'formats/metadata',
    'formats/shared',
];

/**
 * The features each feature may use at run time. `layer/*` names every feature in that folder and
 * `*` every feature. A use that is declared but no longer happens is reported, so the list says
 * what the code does.
 */
export const DEPENDENCIES = {
    'core/errors': [],
    'core/model': ['core/errors'],
    'core/contracts': ['core/errors'],
    'core/bytes': ['core/errors'],
    'core/io': ['core/bytes', 'core/errors'],
    'core/codec-config': ['core/bytes', 'core/errors', 'core/model'],

    'codecs/shared': ['core/*'],
    'codecs/pcm': ['core/*'],
    'codecs/image': ['core/*'],
    'codecs/webcodecs': ['core/*', 'codecs/pcm', 'codecs/shared'],
    'codecs/aac': ['core/*', 'codecs/pcm', 'codecs/shared'],
    'codecs/ac3': ['core/*', 'codecs/shared'],
    'codecs/alac': ['core/*'],
    'codecs/flac': ['core/*'],
    'codecs/h264': ['core/*', 'codecs/shared'],
    'codecs/mpeg-audio': ['core/*', 'codecs/pcm', 'codecs/shared'],
    'codecs/mpeg12': ['core/*', 'codecs/shared'],
    'codecs/mpeg4': ['core/*', 'codecs/shared'],
    'codecs/opus': ['core/*'],
    'codecs/vorbis': ['core/*'],

    'formats/shared': ['core/*'],
    'formats/detection': ['core/*'],
    'formats/metadata': ['core/*'],
    'formats/text': ['core/*', 'formats/shared'],
    'formats/mp4': ['core/*', 'formats/metadata', 'formats/shared', 'formats/text'],
    'formats/matroska': [
        'core/*',
        'formats/metadata',
        'formats/mp4',
        'formats/shared',
        'formats/text',
    ],
    'formats/mpeg-ts': ['core/*', 'formats/shared'],
    'formats/ogg': ['core/*', 'formats/detection', 'formats/metadata', 'formats/shared'],
    'formats/audio-files': [
        'core/*',
        'formats/detection',
        'formats/metadata',
        'formats/ogg',
        'formats/shared',
    ],
    'formats/dash': ['core/*', 'formats/mp4', 'formats/shared'],
    'formats/hls': ['core/*'],
    'formats/images': ['core/*'],
    'formats/apv': ['core/*', 'formats/detection', 'formats/shared'],
    'formats/asf': ['core/*', 'formats/detection', 'formats/shared'],
    'formats/avi': ['core/*', 'formats/detection', 'formats/metadata', 'formats/shared'],
    'formats/flv': ['core/*', 'formats/detection', 'formats/shared'],
    'formats/iamf': ['core/*', 'formats/detection', 'formats/shared'],
    'formats/ivf': ['core/*', 'formats/detection', 'formats/shared'],
    'formats/mpeg-ps': ['core/*', 'formats/shared'],
    'formats/mxf': ['core/*', 'formats/detection', 'formats/shared'],
    // The library's formats as a whole: the core ones, the plugins' manifests, detection of any
    // input and the tags each writer keeps.
    formats: ['core/*', 'formats/*'],

    stages: ['core/*', 'codecs/image', 'codecs/pcm', 'codecs/shared', 'codecs/webcodecs'],

    'pipeline/plugins': ['core/*', 'codecs/shared'],
    'pipeline/read': [
        'core/*',
        'formats',
        'formats/audio-files',
        'formats/matroska',
        'formats/metadata',
        'formats/mp4',
        'formats/mpeg-ts',
        'formats/shared',
        'pipeline/plugins',
    ],
    'pipeline/copy': [
        'core/*',
        'formats',
        'formats/matroska',
        'formats/mp4',
        'formats/shared',
        'formats/text',
        'pipeline/plugins',
        'pipeline/read',
    ],
    'pipeline/codecs': [
        'core/*',
        'codecs/pcm',
        'codecs/shared',
        'codecs/webcodecs',
        'formats/audio-files',
        'formats/metadata',
        'formats/shared',
        'stages',
        'pipeline/copy',
        'pipeline/plugins',
    ],
    'pipeline/plan': [
        'core/*',
        'formats',
        'codecs/webcodecs',
        'formats/shared',
        'stages',
        'pipeline/codecs',
        'pipeline/copy',
        'pipeline/read',
    ],
    'pipeline/transcode': [
        'core/*',
        'codecs/pcm',
        'codecs/shared',
        'codecs/webcodecs',
        'formats/audio-files',
        'formats/shared',
        'stages',
        'pipeline/codecs',
        'pipeline/copy',
        'pipeline/plan',
        'pipeline/plugins',
        'pipeline/read',
    ],
    'pipeline/frames': [
        'core/*',
        'codecs/image',
        'codecs/shared',
        'codecs/webcodecs',
        'formats',
        'formats/images',
        'formats/metadata',
        'formats/shared',
        'stages',
        'pipeline/codecs',
        'pipeline/plan',
        'pipeline/read',
    ],
    'pipeline/package': [
        'core/*',
        'formats/dash',
        'formats/hls',
        'formats/mp4',
        'formats/shared',
        'formats/text',
        'pipeline/copy',
        'pipeline/read',
    ],
    pipeline: ['core/*', 'formats', 'formats/shared', 'stages', 'pipeline/*'],

    recording: [
        'core/*',
        'formats',
        'codecs/shared',
        'codecs/webcodecs',
        'formats/shared',
        'stages',
        'pipeline',
        'pipeline/codecs',
        'pipeline/plan',
        'pipeline/plugins',
    ],
    editing: [
        'core/*',
        'codecs/webcodecs',
        'formats/shared',
        'stages',
        'pipeline/codecs',
        'pipeline/copy',
        'pipeline/plan',
        'pipeline/read',
        'pipeline/transcode',
    ],
    runtime: ['core/*', 'formats/dash', 'formats/hls'],
    plugins: ['codecs/*', 'formats', 'formats/*'],
    api: ['*'],
};

/**
 * Test folders outside the features of src: the tooling (scripts/ and the build), and the support
 * matrix, which runs every feature.
 */
export const TOOL_TESTS = ['test/build/', 'test/support/'];

/** The feature of a module id of src, given the plugin folders. */
export function featureOf(module, plugins) {
    const plugin = plugins.find(folder => module.startsWith(`${folder}/`));
    if (plugin) return plugin;
    const parts = module.split('/');
    return SPLIT.has(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** The feature a test file belongs to: the longest feature name its path starts with. */
export function featureOfTest(path, features) {
    const name = path.startsWith('test/') ? path.slice(5).replace(/\.test\.mjs$/, '') : '';
    const match = path.match(/^(packages\/[^/]+)\/test\//);
    if (match) return features.includes(match[1]) ? match[1] : undefined;
    let best;
    for (const feature of features)
        if (
            (name === feature ||
                name.startsWith(`${feature}-`) ||
                name.startsWith(`${feature}/`)) &&
            feature.length > (best?.length ?? 0)
        )
            best = feature;
    return best;
}

async function walk(dir, keep, skip, out = []) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return out;
        throw error;
    }
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!skip.includes(entry.name)) await walk(path, keep, skip, out);
        } else if (keep(entry.name)) out.push(path);
    }
    return out;
}

/** Every test file of the repository, relative to it, with '/' separators. */
export async function testFiles(root = repoRoot) {
    const isTest = name => name.endsWith('.test.mjs');
    const skip = ['fixtures', 'helpers', 'node_modules'];
    const found = await walk(join(root, 'test'), isTest, skip);
    for (const name of await packageNames(root))
        found.push(...(await walk(join(root, 'packages', name, 'test'), isTest, skip)));
    return found.map(path => relative(root, path).replaceAll('\\', '/')).sort();
}

async function packageNames(root) {
    try {
        const entries = await readdir(join(root, 'packages'), { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort();
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

/** The specifier of a static import or export, or of a dynamic import. */
const SPECIFIER = new RegExp(
    String.raw`(?:^|[\s;(])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?'([^']+)'` +
        String.raw`|import\(\s*'([^']+)'`,
    'g',
);

/** The code of a package of packages/: its modules outside test/ and dist/. */
async function packageSources(root, name) {
    const files = await walk(join(root, 'packages', name), file => /\.(?:m?js|ts)$/.test(file), [
        'dist',
        'node_modules',
        'test',
    ]);
    return files.map(path => relative(root, path).replaceAll('\\', '/')).sort();
}

/** Imports of a package's code that reach past its files, its dependencies and mediaforgejs. */
async function packageProblems(root, name, sources) {
    const dir = join(root, 'packages', name);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const own = Object.keys({
        ...manifest.dependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
    });
    const main = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const entries = Object.keys(main.exports)
        .filter(key => key !== './package.json')
        .map(key => (key === '.' ? 'mediaforgejs' : `mediaforgejs${key.slice(1)}`));
    const problems = [];
    for (const path of sources) {
        const file = join(root, path);
        const text = (await readFile(file, 'utf8'))
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        for (const match of text.matchAll(SPECIFIER)) {
            const specifier = match[1] ?? match[2];
            if (specifier.startsWith('.')) {
                if (relative(dir, resolve(dirname(file), specifier)).startsWith('..'))
                    problems.push(`${path} imports ${specifier}, outside its package`);
            } else if (
                !specifier.startsWith('node:') &&
                !entries.includes(specifier) &&
                !own.includes(specifier.replace(/^((?:@[^/]+\/)?[^/]+).*$/, '$1'))
            )
                problems.push(
                    `${path} imports ${specifier}: a package uses its own files, its ` +
                        `dependencies and the entries of mediaforgejs`,
                );
        }
    }
    return problems;
}

/** `pattern` expanded over `features`, without `self`. */
function expand(pattern, features, self) {
    const named =
        pattern === '*'
            ? features
            : pattern.endsWith('/*')
              ? features.filter(feature => feature.startsWith(pattern.slice(0, -1)))
              : features.filter(feature => feature === pattern);
    return named.filter(feature => feature !== self);
}

/** The first cycle of `next` (a Map of feature to the Set it uses), or undefined. */
function findCycle(next) {
    const state = new Map();
    const path = [];
    const visit = node => {
        state.set(node, 'open');
        path.push(node);
        for (const target of next.get(node) ?? []) {
            if (state.get(target) === 'open') return [...path.slice(path.indexOf(target)), target];
            if (!state.has(target)) {
                const found = visit(target);
                if (found) return found;
            }
        }
        path.pop();
        state.set(node, 'done');
        return undefined;
    };
    for (const node of [...next.keys()].sort())
        if (!state.has(node)) {
            const found = visit(node);
            if (found) return found;
        }
    return undefined;
}

/**
 * The feature map of the repository at `root`: each feature with its modules, whether it is a
 * plugin, the features it uses at run time (with an example import each) and its test files; the
 * test files of the tooling, and the problems the check fails on.
 */
export async function featureMap(root = repoRoot) {
    const { modules, edges } = await importGraph(join(root, 'src'));
    const packages = [];
    for (const name of await packageNames(root))
        packages.push({ id: `packages/${name}`, modules: await packageSources(root, name) });
    const map = checkFeatures({ modules, edges, packages, tests: await testFiles(root) });
    for (const { id, modules: sources } of packages)
        map.problems.push(...(await packageProblems(root, id.slice(9), sources)));
    return map;
}

/** The rules of this repository: the declared uses and the shared features. */
const RULES = { dependencies: DEPENDENCIES, shared: SHARED };

/**
 * The feature map of an import graph ({ modules, edges } of scripts/layers.mjs), the packages
 * ({ id, modules }) and the test files, under `rules`: see featureMap. Package imports are checked
 * by featureMap, which reads their files.
 */
export function checkFeatures({ modules, edges, packages = [], tests }, rules = RULES) {
    const { dependencies, shared } = rules;
    const plugins = pluginFolders(modules);
    const features = new Map();
    const add = (id, plugin) =>
        features.get(id) ??
        features.set(id, { id, modules: [], plugin, uses: new Map(), tests: [] }).get(id);
    for (const module of [...modules].sort())
        add(featureOf(module, plugins), plugins.includes(featureOf(module, plugins))).modules.push(
            module,
        );
    for (const edge of edges) {
        if (edge.kind !== 'static' && edge.kind !== 'dynamic') continue;
        const from = featureOf(edge.from, plugins);
        const to = featureOf(edge.to, plugins);
        if (from !== to && !features.get(from).uses.has(to))
            features.get(from).uses.set(to, `${edge.from} imports ${edge.to}`);
    }
    for (const { id, modules: sources } of packages) add(id, false).modules.push(...sources);
    const packageIds = packages.map(({ id }) => id);
    const ids = [...features.keys()].sort();
    const tools = [];
    const strayTests = [];
    for (const test of tests) {
        const feature = featureOfTest(test, ids);
        if (feature) features.get(feature).tests.push(test);
        else if (TOOL_TESTS.some(folder => test.startsWith(folder))) tools.push(test);
        else strayTests.push(test);
    }

    const problems = [];
    const allowed = new Map();
    const srcIds = ids.filter(id => !packageIds.includes(id));
    for (const id of srcIds) {
        const declared = dependencies[id];
        if (!declared) {
            problems.push(`${id}: a feature without a declaration in scripts/features.mjs`);
            continue;
        }
        const set = new Set();
        for (const pattern of declared) {
            const named = expand(pattern, srcIds, id);
            if (!named.length) problems.push(`${id} declares ${pattern}, which names no feature`);
            for (const feature of named) set.add(feature);
            if (!pattern.endsWith('*') && named.length && !features.get(id).uses.has(pattern))
                problems.push(`${id} declares ${pattern} but does not use it`);
        }
        allowed.set(id, set);
        const feature = features.get(id);
        if (feature.plugin || shared.includes(id))
            for (const used of set)
                if (!used.startsWith('core/') && !shared.includes(used))
                    problems.push(
                        `${id} declares ${used}: a ${feature.plugin ? 'plugin' : 'shared one'} ` +
                            `uses only core and ${shared.join(', ')}`,
                    );
    }
    for (const id of Object.keys(dependencies))
        if (!features.has(id)) problems.push(`${id} is declared but has no modules in src`);
    for (const id of shared)
        if (!features.has(id) || features.get(id).plugin)
            problems.push(`${id} is listed as shared but is not a feature outside the plugins`);
    const cycle = findCycle(allowed);
    if (cycle) problems.push(`the declared uses form a cycle: ${cycle.join(' -> ')}`);
    for (const id of srcIds)
        for (const [used, example] of features.get(id).uses)
            if (!allowed.get(id)?.has(used))
                problems.push(`${id} uses ${used}, which it does not declare (${example})`);
    for (const id of ids)
        if (!features.get(id).tests.length)
            problems.push(
                packageIds.includes(id)
                    ? `${id}: no test file (${id}/test/<aspect>.test.mjs)`
                    : `${id}: no test file (test/${id}.test.mjs or test/${id}-<aspect>.test.mjs)`,
            );
    for (const test of strayTests)
        problems.push(`${test} belongs to no feature: name it after the feature it tests`);
    return { features, plugins, packages: packageIds, tools, problems };
}

/**
 * The features that may break when `changed` features change: they and every feature that uses
 * one of them at run time, directly or through others. A package uses the API.
 */
export function dependents(map, changed) {
    const users = new Map([...map.features.keys()].map(id => [id, new Set()]));
    for (const [id, feature] of map.features)
        for (const used of feature.uses.keys()) users.get(used)?.add(id);
    for (const id of map.packages) users.get('api')?.add(id);
    const reached = new Set(changed.filter(id => users.has(id)));
    const queue = [...reached];
    while (queue.length)
        for (const user of users.get(queue.pop()))
            if (!reached.has(user)) reached.add(user) && queue.push(user);
    return [...reached].sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const map = await featureMap();
    for (const [id, feature] of [...map.features].sort(([a], [b]) => a.localeCompare(b))) {
        const kind = feature.plugin ? ', plugin' : SHARED.includes(id) ? ', shared' : '';
        console.log(
            `${id} (${feature.modules.length} modules${kind}, ${feature.tests.length} test ` +
                `files): ${[...feature.uses.keys()].sort().join(' ') || '-'}`,
        );
    }
    for (const problem of map.problems) console.error(problem);
    console.log(`features: ${map.features.size}, ${map.problems.length} problems`);
    if (map.problems.length) process.exit(1);
}
