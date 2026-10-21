// The layer rule of src/: every module belongs to the layer of its top directory, and imports
// (static, dynamic and type-only) point to a lower layer or stay inside their own. Formats and
// codecs are siblings that meet only in core; the stages build on codecs. A plugin lives in one
// folder with a manifest.ts; outside it only its index.ts and manifest.ts are imported, apart from
// types and the API's standalone building blocks. `node scripts/layers.mjs` prints the graph and
// fails on a violation or a cycle.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Layers from the bottom; directories of one rank are siblings that may not import each other. A
 * layer with `entries` is a subsystem the engine does not need: only those package entries reach it
 * through static imports, so every other entry loads it on demand and its startup cost stays the
 * same.
 */
export const LAYERS = Object.freeze([
    {
        name: 'core',
        rank: 0,
        role:
            'errors, diagnostics, bytes, Source and Sink, the track and sample model, codec ' +
            'configuration parsing, the contracts every reader, writer, codec and stage implements',
    },
    {
        name: 'formats',
        rank: 1,
        role: 'containers, manifests, subtitles and tags: bytes to tracks and back',
    },
    { name: 'codecs', rank: 1, role: 'decoders, encoders and the WebCodecs adapters' },
    {
        name: 'stages',
        rank: 2,
        role: 'the processing stages and their runner',
    },
    {
        name: 'pipeline',
        rank: 3,
        role: 'planning and running every operation, packaging, composing the plugins in use',
    },
    {
        name: 'recording',
        rank: 4,
        role: 'encodeFrames() and recordStream(): application frames and MediaStream capture',
        entries: [],
    },
    {
        name: 'editing',
        rank: 4,
        role: 'edit(): the project of several clips and its render on the engine',
        entries: [],
    },
    {
        name: 'runtime',
        rank: 4,
        role: 'files of Node, Bun and Deno, and the installed FFmpeg backend',
        entries: [
            'api/entries/runtime-node',
            'api/entries/runtime-deno',
            'api/entries/runtime-ffmpeg',
        ],
    },
    {
        name: 'plugins',
        rank: 5,
        role: 'the list of the plugins of the library and their catalog of manifests',
    },
    { name: 'api', rank: 6, role: 'the functions, MediaForge and Media, and the package entries' },
]);

const RANK = new Map(LAYERS.map(layer => [layer.name, layer.rank]));
/** Static imports and exports (with `type` captured) and dynamic imports of relative paths. */
const IMPORT = new RegExp(
    String.raw`(?:^|[\s;(])(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?` +
        String.raw`'(\.{1,2}\/[^']*|\.{1,2})'` +
        String.raw`|import\(\s*'(\.{1,2}\/[^']*)'\s*\)`,
    'g',
);

/**
 * The modules of `src` by id ('formats/mp4/reader') with their text, comments removed: `src` is a
 * directory, or an object of paths ('formats/mp4/reader.ts') to text.
 */
async function readTree(src) {
    const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (typeof src !== 'string')
        return new Map(
            Object.entries(src).map(([path, text]) => [path.replace(/\.ts$/, ''), strip(text)]),
        );
    const tree = new Map();
    const walk = async dir => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.name.endsWith('.ts'))
                tree.set(
                    relative(src, path).replace(/\.ts$/, '').replaceAll('\\', '/'),
                    strip(await readFile(path, 'utf8')),
                );
        }
    };
    await walk(src);
    return tree;
}

/** The layer of a module id such as 'formats/mp4/reader'; root modules have none. */
export function layerOf(id) {
    const top = id.includes('/') ? id.slice(0, id.indexOf('/')) : undefined;
    return top !== undefined && RANK.has(top) ? top : undefined;
}

/**
 * Every import edge of `src` (a directory or an object of paths to text, see readTree): { from, to,
 * kind } with module ids, and the modules with their text.
 */
export async function importGraph(src) {
    const tree = await readTree(src);
    const modules = new Set(tree.keys());
    const edges = [];
    for (const [from, text] of tree) {
        for (const match of text.matchAll(IMPORT)) {
            const spec = match[2] ?? match[3];
            const target = posix.join(posix.dirname(from), spec);
            const to = modules.has(target)
                ? target
                : modules.has(`${target}/index`)
                  ? `${target}/index`
                  : undefined;
            if (!to) {
                edges.push({ from, to: target, kind: 'unresolved' });
                continue;
            }
            const typeOnly =
                match[1] !== undefined ||
                /^\s*(?:import|export)\s+\{(?:\s*type\s+[^,}]+,?)+\s*\}/.test(match[0]);
            edges.push({ from, to, kind: match[3] ? 'dynamic' : typeOnly ? 'type' : 'static' });
        }
    }
    return { modules, edges, tree };
}

/** Strongly connected components of more than one module (or a module importing itself). */
function cycles(modules, edges) {
    const next = new Map([...modules].map(module => [module, []]));
    for (const edge of edges) if (edge.kind !== 'unresolved') next.get(edge.from).push(edge.to);
    const index = new Map();
    const low = new Map();
    const stack = [];
    const onStack = new Set();
    const found = [];
    let counter = 0;
    const visit = root => {
        const work = [[root, 0]];
        index.set(root, counter);
        low.set(root, counter++);
        stack.push(root);
        onStack.add(root);
        while (work.length) {
            const frame = work[work.length - 1];
            const [node, position] = frame;
            const targets = next.get(node);
            if (position < targets.length) {
                frame[1]++;
                const target = targets[position];
                if (!index.has(target)) {
                    index.set(target, counter);
                    low.set(target, counter++);
                    stack.push(target);
                    onStack.add(target);
                    work.push([target, 0]);
                } else if (onStack.has(target))
                    low.set(node, Math.min(low.get(node), index.get(target)));
                continue;
            }
            work.pop();
            if (work.length) {
                const parent = work[work.length - 1][0];
                low.set(parent, Math.min(low.get(parent), low.get(node)));
            }
            if (low.get(node) === index.get(node)) {
                const component = [];
                let member;
                do {
                    member = stack.pop();
                    onStack.delete(member);
                    component.push(member);
                } while (member !== node);
                if (component.length > 1 || targets.includes(node)) found.push(component.sort());
            }
        }
    };
    for (const module of modules) if (!index.has(module)) visit(module);
    return found;
}

/**
 * Subsystem modules that a package entry other than the subsystem's own reaches through static
 * imports.
 */
function subsystemReach(modules, edges) {
    const next = new Map([...modules].map(module => [module, []]));
    for (const edge of edges) if (edge.kind === 'static') next.get(edge.from).push(edge.to);
    const problems = [];
    for (const entry of [...modules].filter(module => module.startsWith('api/entries/')).sort()) {
        const reached = new Set([entry]);
        const queue = [entry];
        while (queue.length)
            for (const to of next.get(queue.pop()))
                if (!reached.has(to) && reached.add(to)) queue.push(to);
        for (const layer of LAYERS) {
            if (!layer.entries || layer.entries.includes(entry)) continue;
            const found = [...reached].filter(module => layerOf(module) === layer.name);
            if (found.length)
                problems.push(
                    `${entry} loads the ${layer.name} subsystem at startup: ${found.join(', ')}`,
                );
        }
    }
    return problems;
}

/**
 * The folders of plugins: those with a manifest.ts, whose index.ts is the plugin. Code outside such
 * a folder imports only its index and manifest; types may be shared, and the API layer's
 * standalone building blocks (the codecs and containers as functions) reach in directly.
 */
export function pluginFolders(modules) {
    return [...modules]
        .filter(
            id =>
                id.endsWith('/manifest') && modules.has(`${id.slice(0, -'manifest'.length)}index`),
        )
        .map(id => id.slice(0, -'/manifest'.length))
        .sort();
}

function pluginPrivacy(modules, edges) {
    const folders = pluginFolders(modules);
    const problems = [];
    for (const edge of edges) {
        if (edge.kind === 'unresolved' || edge.kind === 'type' || layerOf(edge.from) === 'api')
            continue;
        const folder = folders.find(candidate => edge.to.startsWith(`${candidate}/`));
        if (!folder || edge.from.startsWith(`${folder}/`)) continue;
        if (edge.to === `${folder}/index` || edge.to === `${folder}/manifest`) continue;
        const where = `${edge.from} imports ${edge.to} (${edge.kind})`;
        problems.push(
            `${where}: outside the plugin folder ${folder}, import its index or manifest`,
        );
    }
    return problems;
}

/**
 * The violations of the layer rule in `src` (a directory or an object of paths to text): modules
 * outside a layer, imports that point upward or across siblings, imports of a plugin's internals,
 * unresolved imports and import cycles.
 */
export async function checkLayers(src) {
    const { modules, edges, tree } = await importGraph(src);
    const problems = [];
    for (const module of modules)
        if (!layerOf(module))
            problems.push(`${module}: not in a layer directory (${[...RANK.keys()].join(', ')})`);
    let downward = 0;
    let inside = 0;
    for (const edge of edges) {
        if (edge.kind === 'unresolved') {
            problems.push(`${edge.from}: unresolved import ${edge.to}`);
            continue;
        }
        const from = layerOf(edge.from);
        const to = layerOf(edge.to);
        if (!from || !to) continue;
        if (from === to) {
            inside++;
            continue;
        }
        if (RANK.get(to) < RANK.get(from)) {
            downward++;
            continue;
        }
        const direction = RANK.get(to) === RANK.get(from) ? 'across to its sibling' : 'upward to';
        problems.push(
            `${edge.from} imports ${edge.to} (${edge.kind}): ${from} may not import ${direction} ` +
                `${to}`,
        );
    }
    const loops = cycles(modules, edges);
    for (const loop of loops) problems.push(`import cycle: ${loop.join(' -> ')}`);
    // A package entry names each export, so its public surface is read off the file, but for the
    // surfaces it shares with another entry or script (api/surface.ts, api/surface-formats.ts,
    // api/surface-codecs.ts); the script-tag builds gather whole entries as namespaces.
    for (const module of modules) {
        if (!module.startsWith('api/entries/') || module.startsWith('api/entries/browser'))
            continue;
        const text = tree.get(module);
        const stars = text.match(/^export\s+(?:type\s+)?\*\s+from\s+'[^']+'/gm) ?? [];
        if (stars.some(line => !/'\.\.\/surface(?:-[a-z]+)?'$/.test(line)))
            problems.push(
                `${module}: a package entry names its exports instead of export * from another ` +
                    `module (the shared surfaces of api/ excepted)`,
            );
    }
    for (const problem of subsystemReach(modules, edges)) problems.push(problem);
    for (const problem of pluginPrivacy(modules, edges)) problems.push(problem);
    return {
        modules: modules.size,
        edges: edges.length,
        inside,
        downward,
        cycles: loops.length,
        problems,
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const srcDir = resolve(
        process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src'),
    );
    const result = await checkLayers(srcDir);
    for (const problem of result.problems) console.error(problem);
    console.log(
        `layers: ${result.modules} modules, ${result.edges} imports (${result.inside} inside a ` +
            `layer, ${result.downward} downward), ${result.problems.length} problems`,
    );
    if (result.problems.length) process.exit(1);
}
