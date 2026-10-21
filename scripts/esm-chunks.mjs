// dist/esm as a few ES module chunks (dist/chunks/): the modules of each chunk are concatenated
// with their top-level bindings renamed apart (scope hoisting), and every dist/esm module becomes a
// file that re-exports its bindings from the chunks. There is one copy of every module, so deep
// imports, every entry and the code loaded on demand share classes and module state. An operation
// fetches its code as a few chunk files instead of discovering it module by module, and a bundler
// that splits an application by its dynamic imports gets a few chunks of the library instead of one
// per combination of importers; it still drops the unused bindings of the chunks it keeps.
//
// One rule places every module: it goes with the code that loads it, so that each common call loads
// the code it runs, and nothing else, in few requests. The lists below are the data of the rule.
// 1. What an entry loads at once is its startup chunks.
// 2. A family of CHUNK_FAMILIES, or any other module a dynamic import names, heads a chunk with
//    what only it uses, and with what it shares with code that always loads with it or after it.
// 3. What several of them share goes in a chunk named by the MAIN_READERS that use it (else the
//    OTHER_READERS), and by whether the MAIN_WRITE uses it too. The READER_PARTS of the RARE_PARTS
//    readers count as readers of their own; what all ENGINE_READERS use goes with the engine.
// 4. Writers (WRITER_MODULE) and the other entries never carry a reader's code, and what the engine
//    shares with the RUNTIME_ENTRIES is a chunk of its own.
import ts from 'typescript';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Chunks that group what loads together, by the modules dynamic imports name; every other module a
 * dynamic import names heads a chunk of its own. A family claims what its modules reach before the
 * later ones.
 */
export const CHUNK_FAMILIES = Object.freeze({
    // Every open resolves its options (api/options/open-options) and composes the plugins in use
    // (pipeline/plugins/plugin) as it loads the engine. A Media reads its packets, packetAt() and
    // segments() through api/media-reads (a probed input's index and windows): open() runs it with
    // the engine, so it is part of it rather than a further request.
    read: [
        'pipeline/engine',
        'plugins/catalog',
        'pipeline/frames/image-inspect',
        'api/options/open-options',
        'pipeline/plugins/plugin',
        'api/media-reads',
    ],
    'aac-syntax': ['core/codec-config/audio/aac-syntax'],
    mp4: ['formats/mp4/reader'],
    mkv: ['formats/matroska/reader'],
    ts: ['formats/mpeg-ts/reader'],
    audio: ['formats/audio-files/reader'],
    'mpeg-audio': ['formats/audio-files/mpeg-audio-reader'],
    'sync-audio': ['formats/audio-files/sync-reader'],
    // The packet copy, which every operation of api/operations plans or runs: they import it, so
    // the operations' door names its chunk.
    copy: ['pipeline/copy/packet-copy'],
    ops: ['api/operations'],
    work: ['pipeline/engine-work'],
    // thumbnail() and frames() and what they decode pictures with, without the conversion API and
    // runner: the call loads both in one request.
    pictures: ['api/picture-operations', 'pipeline/frames/frames'],
});

/** The families of the readers most inputs open with: MP4, Matroska and the audio files. */
const MAIN_READERS = ['mp4', 'mkv', 'audio'];

/** The families of the other readers: MPEG-TS, MPEG audio and AC-3, DTS and TrueHD streams. */
const OTHER_READERS = ['ts', 'mpeg-audio', 'sync-audio'];

/**
 * The readers whose common code goes with the engine: opening either input then requests it with
 * the engine instead of as further chunks found once the reader arrives.
 */
const ENGINE_READERS = ['mp4', 'mkv'];

/**
 * The parts of the MP4, Matroska and audio file readers they load on demand, for inputs that need
 * them: chunks of their own. Opening a WAV file loads none of the FLAC, Ogg and CAF code.
 */
const READER_PARTS = Object.freeze({
    mp4: [
        'formats/mp4/read/chunk-audio',
        'formats/mp4/read/fragments',
        'formats/mp4/read/movie-repair',
        'formats/mp4/read/sample-entries',
        'formats/mp4/read/sample-tables',
        'formats/mp4/read/track-fixes',
    ],
    mkv: [
        'formats/matroska/read/codec-parts',
        'formats/matroska/read/compression',
        'formats/matroska/read/metadata',
        'formats/matroska/read/recovery',
    ],
    audio: ['formats/audio-files/described-files'],
});

/**
 * The readers whose parts few of their inputs load (damaged, fragmented or unusual ones): what only
 * the parts share with other readers goes in chunks of their own. The audio file reader's part
 * reads FLAC and Ogg, about as common as WAV: what it shares is keyed as the reader's, so opening
 * a FLAC or Ogg file requests the part and at most one chunk more than a WAV file.
 */
const RARE_PARTS = ['mp4', 'mkv'];

/**
 * What a copy into MP4, the most common write, loads (families and modules loaded on demand):
 * helpers it shares with the readers stay apart from the rest.
 */
const MAIN_WRITE = ['ops', 'copy', 'formats/mp4/writer'];

/**
 * The writers of the formats, and the copy of audio files, which writes them: loaded on demand,
 * they share helpers with the readers.
 */
const WRITER_MODULE = /^formats\/[^/]+\/(?:writer|copy)$/;

/**
 * The chunk of a module that a dynamic import names and no family claims: its module id, spelled as
 * a file name.
 */
const chunkNameOf = id => id.replaceAll('/', '-');

/**
 * The runtime entries an app imports its sources and sinks from, which share a few helpers with the
 * readers.
 */
const RUNTIME_ENTRIES = ['api/entries/runtime-node', 'api/entries/runtime-deno'];

/** The H.264 frame worker: started from a URL, it is a chunk of its own. */
const WORKER_MODULE = 'codecs/h264/frame-worker';
const WORKER_URL_MODULE = 'codecs/h264/frame-worker-url';

async function javaScriptFiles(dir) {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await javaScriptFiles(path)));
        else if (entry.name.endsWith('.js')) files.push(path);
    }
    return files.sort();
}

/**
 * The declaration that introduces a top-level binding of its file, or undefined for nested ones.
 */
function topLevelName(declaration) {
    if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration))
        return ts.isSourceFile(declaration.parent) && declaration.name
            ? declaration.name.text
            : undefined;
    let node = declaration;
    if (ts.isBindingElement(node)) {
        while (
            ts.isBindingElement(node) ||
            ts.isObjectBindingPattern(node) ||
            ts.isArrayBindingPattern(node)
        )
            node = node.parent;
    }
    if (!ts.isVariableDeclaration(node) || !ts.isVariableStatement(node.parent.parent))
        return undefined;
    if (!ts.isSourceFile(node.parent.parent.parent)) return undefined;
    return ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

/** Whether `node` names a property or label rather than a binding. */
function isPropertyName(node) {
    const parent = node.parent;
    return (
        ((ts.isPropertyAccessExpression(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent) ||
            ts.isLabeledStatement(parent) ||
            ts.isBreakOrContinueStatement(parent)) &&
            parent.name === node) ||
        (ts.isLabeledStatement(parent) && parent.label === node) ||
        (ts.isBreakOrContinueStatement(parent) && parent.label === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node)
    );
}

function declaredNames(statement) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name)
        return [statement.name.text];
    if (!ts.isVariableStatement(statement)) return [];
    const names = [];
    const collect = name => {
        if (ts.isIdentifier(name)) names.push(name.text);
        else
            for (const element of name.elements)
                if (!ts.isOmittedExpression(element)) collect(element.name);
    };
    for (const declaration of statement.declarationList.declarations) collect(declaration.name);
    return names;
}

/**
 * Writes dist/chunks from the modules of `esmDir` and replaces each module with the re-exports of
 * its bindings. `entries` are the package's entry modules (static closures load at startup),
 * `startup` the entries of the high-level API whose static modules form the first chunks.
 */
export async function writeEsmChunks({ esmDir, chunkDir, entries, startup }) {
    const files = await javaScriptFiles(esmDir);
    const program = ts.createProgram({
        rootNames: files,
        options: {
            allowJs: true,
            noEmit: true,
            noLib: true,
            types: [],
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
    });
    const checker = program.getTypeChecker();
    const nameOf = file => relative(esmDir, file).replace(/\.js$/, '').replaceAll('\\', '/');
    const resolveSpecifier = (file, specifier) => nameOf(resolve(dirname(file), specifier));

    // Each module: its imports, dynamic imports, top-level bindings, references to rename and
    // exports.
    const modules = new Map();
    const bindingOf = symbol => {
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (!declaration) return undefined;
        if (ts.isSourceFile(declaration))
            return { module: nameOf(declaration.fileName), namespace: true };
        const name = topLevelName(declaration);
        return name === undefined
            ? undefined
            : { module: nameOf(declaration.getSourceFile().fileName), name };
    };
    for (const file of files) {
        const source = program.getSourceFile(file);
        const name = nameOf(file);
        const info = {
            name,
            source,
            staticDeps: [],
            dynamicDeps: [],
            topLevel: [],
            texts: new Set(),
            free: new Set(),
            edits: [],
            refs: [],
            exports: new Map(),
        };
        modules.set(name, info);
        for (const statement of source.statements) {
            if (
                (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
                statement.moduleSpecifier &&
                ts.isStringLiteral(statement.moduleSpecifier) &&
                statement.moduleSpecifier.text.startsWith('.')
            )
                info.staticDeps.push(resolveSpecifier(file, statement.moduleSpecifier.text));
            info.topLevel.push(...declaredNames(statement));
        }
        const visit = node => {
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
                info.edits.push({ start: node.getStart(source), end: node.end, text: '' });
                return;
            }
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const [argument] = node.arguments;
                if (argument && ts.isStringLiteral(argument) && argument.text.startsWith('.')) {
                    const target = resolveSpecifier(file, argument.text);
                    info.dynamicDeps.push(target);
                    info.refs.push({ kind: 'dynamic', node, target });
                    return;
                }
            }
            if (ts.canHaveModifiers(node))
                for (const modifier of ts.getModifiers(node) ?? [])
                    if (modifier.kind === ts.SyntaxKind.ExportKeyword)
                        info.edits.push({
                            start: modifier.getStart(source),
                            end: modifier.end + 1,
                            text: '',
                        });
            if (
                ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                ts.isIdentifier(node.name)
            ) {
                const symbol = checker.getSymbolAtLocation(node.expression);
                if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
                    const target = bindingOf(checker.getAliasedSymbol(symbol));
                    if (target?.namespace) {
                        info.texts.add(node.expression.text);
                        info.refs.push({
                            kind: 'member',
                            node,
                            namespace: target.module,
                            member: node.name.text,
                        });
                        return;
                    }
                }
            }
            if (ts.isMetaProperty(node)) return;
            if (ts.isIdentifier(node)) {
                info.texts.add(node.text);
                // A property or label names no binding; its symbol would cost the type of the
                // object it is read from.
                if (isPropertyName(node)) return;
                const parent = node.parent;
                const shorthand = ts.isShorthandPropertyAssignment(parent) && parent.name === node;
                const symbol = shorthand
                    ? checker.getShorthandAssignmentValueSymbol(parent)
                    : checker.getSymbolAtLocation(node);
                if (!symbol) {
                    info.free.add(node.text);
                } else if (symbol.flags & ts.SymbolFlags.Alias) {
                    const declaration = symbol.declarations?.[0];
                    if (declaration?.getSourceFile() === source) {
                        const target = bindingOf(checker.getAliasedSymbol(symbol));
                        if (!target)
                            throw new Error(`build: cannot resolve ${node.text} in ${name}`);
                        info.refs.push({ kind: 'import', node, target, shorthand });
                    }
                } else {
                    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
                    if (
                        declaration?.getSourceFile() === source &&
                        topLevelName(declaration) !== undefined
                    ) {
                        const destructured =
                            ts.isBindingElement(parent) &&
                            parent.name === node &&
                            !parent.propertyName;
                        info.refs.push({
                            kind: 'own',
                            node,
                            target: { module: name, name: topLevelName(declaration) },
                            shorthand:
                                shorthand ||
                                (destructured && ts.isObjectBindingPattern(parent.parent)),
                        });
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(source, visit);
        const moduleSymbol = checker.getSymbolAtLocation(source);
        for (const symbol of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
            const target = bindingOf(
                symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
            );
            if (!target) throw new Error(`build: cannot resolve export ${symbol.name} of ${name}`);
            info.exports.set(symbol.name, target);
        }
    }

    // Evaluation order: depth-first post-order over the static imports, as ES modules evaluate.
    const order = new Map();
    const visited = new Set();
    const walk = name => {
        if (visited.has(name)) return;
        visited.add(name);
        for (const dep of modules.get(name).staticDeps) walk(dep);
        order.set(name, order.size);
    };
    for (const name of [...entries, ...modules.keys()]) walk(name);
    const closure = (roots, exclude = new Set()) => {
        const seen = new Set();
        const pending = [...roots];
        while (pending.length) {
            const name = pending.pop();
            if (seen.has(name) || exclude.has(name)) continue;
            seen.add(name);
            pending.push(...modules.get(name).staticDeps);
        }
        return seen;
    };
    const reachable = roots => {
        const seen = new Set();
        const pending = [...roots];
        while (pending.length) {
            const name = pending.pop();
            if (seen.has(name)) continue;
            seen.add(name);
            pending.push(...modules.get(name).staticDeps, ...modules.get(name).dynamicDeps);
        }
        return seen;
    };

    // Placement. The lite entry's static modules come first; the default entry's follow, those that
    // the code the lite entry loads on demand also uses in a chunk of their own, so the lite entry
    // never loads the plugin descriptors. Then the reading engine, which every operation loads
    // first, and a chunk for each family or other module that dynamic imports name, with what only
    // it reaches. Last come the modules that only other entries reach statically, and the rest.
    const placed = new Map();
    const place = (names, chunk) => {
        for (const name of names) if (!placed.has(name)) placed.set(name, chunk);
    };
    const [liteEntry, ...otherStartup] = startup;
    place([liteEntry], 'entry-lite');
    place(closure([liteEntry]), 'lite');
    const liteLazy = reachable(
        [...closure([liteEntry])].flatMap(name => modules.get(name).dynamicDeps),
    );
    const startupRest = [...closure(otherStartup)].filter(name => !placed.has(name));
    place(
        startupRest.filter(name => liteLazy.has(name)),
        'common',
    );
    place(startupRest, 'plugins');
    const dynamicRoots = new Set([...modules.values()].flatMap(info => info.dynamicDeps));
    dynamicRoots.add(WORKER_MODULE);
    const groupRoots = new Map();
    for (const [family, roots] of Object.entries(CHUNK_FAMILIES)) {
        for (const root of roots)
            if (!dynamicRoots.has(root))
                throw new Error(
                    `build: chunk family ${family} names ${root}, not loaded on demand`,
                );
        groupRoots.set(family, roots);
    }
    const inFamily = new Set(Object.values(CHUNK_FAMILIES).flat());
    for (const root of [...dynamicRoots].sort()) {
        if (inFamily.has(root)) continue;
        const group = root === WORKER_MODULE ? 'h264-worker' : chunkNameOf(root);
        if (groupRoots.has(group))
            throw new Error(
                `build: ${root} and ${groupRoots.get(group)} would share chunk ${group}`,
            );
        groupRoots.set(group, [root]);
    }
    // What the readers share with the runtime entries goes in a chunk of its own, so importing
    // FileSource loads neither the readers nor anything else they use.
    const readClosure = closure(groupRoots.get('read'));
    const runtimeReach = closure(RUNTIME_ENTRIES.filter(entry => entries.includes(entry)));
    place(
        [...readClosure].filter(name => runtimeReach.has(name)),
        'runtime-core',
    );
    place(readClosure, 'read');
    groupRoots.delete('read');
    const mainWrite = MAIN_WRITE.map(name => (name in CHUNK_FAMILIES ? name : chunkNameOf(name)));
    for (const group of mainWrite)
        if (!groupRoots.has(group))
            throw new Error(`build: the main write names ${group}, not a chunk loaded on demand`);
    for (const part of Object.values(READER_PARTS).flat())
        if (!dynamicRoots.has(part))
            throw new Error(`build: the reader part ${part} is not loaded on demand`);
    /** The family of a part of the MP4 or Matroska reader. */
    const readerPartFamily = group =>
        group in CHUNK_FAMILIES
            ? undefined
            : Object.keys(READER_PARTS).find(family =>
                  (groupRoots.get(group) ?? []).some(root => READER_PARTS[family].includes(root)),
              );
    // The other entries load what they reach statically like the code loaded on demand: a module
    // one of them shares with a family goes with the family only when the entry loads that family
    // anyway.
    for (const entry of entries)
        if (!startup.includes(entry)) groupRoots.set(`entry-${entry.split('/').pop()}`, [entry]);
    const reach = new Map(
        [...groupRoots].map(([group, roots]) => [group, closure(roots, new Set(placed.keys()))]),
    );
    const owners = new Map();
    for (const [group, members] of reach)
        for (const name of members) owners.set(name, [...(owners.get(name) ?? []), group]);
    const shared = new Map();
    // A module one family needs goes with that family, also when other modules loaded on demand
    // need it, and so does one of several families' when the others import that family's modules
    // anyway.
    const fullReach = new Map([...groupRoots].map(([group, roots]) => [group, closure(roots)]));
    const carriedBy = (family, list) =>
        list.every(
            group =>
                group === family ||
                groupRoots.get(family).every(root => fullReach.get(group).has(root)),
        );
    // A group whose roots only another group's modules import (dynamically) loads after it: what
    // the two share goes with the first, which loads it anyway (the Ogg reader's extra streams
    // after the audio file parts, say).
    const importersOf = new Map();
    for (const [importer, info] of modules)
        for (const target of info.dynamicDeps)
            importersOf.set(target, [...(importersOf.get(target) ?? []), importer]);
    const loadsAfter = (later, first) =>
        !later.startsWith('entry-') &&
        groupRoots
            .get(later)
            .every(root =>
                (importersOf.get(root) ?? [undefined]).every(name => reach.get(first).has(name)),
            );
    for (const [name, list] of [...owners].sort((a, b) => order.get(a[0]) - order.get(b[0]))) {
        const first = list.find(
            group =>
                !(group in CHUNK_FAMILIES) &&
                !group.startsWith('entry-') &&
                list.length > 1 &&
                list.every(other => other === group || loadsAfter(other, group)),
        );
        if (first) {
            placed.set(name, first);
            continue;
        }
        const families = list.filter(group => group in CHUNK_FAMILIES);
        // An entry that does not load the family keeps the module out of it, and so does a writer
        // loaded on demand: writing a file loads no reader it does not run.
        const othersLoad = family =>
            carriedBy(
                family,
                list.filter(
                    group =>
                        group.startsWith('entry-') ||
                        groupRoots.get(group).some(root => WRITER_MODULE.test(root)),
                ),
            );
        // A reader carries its own parts; another family does not carry what they share with it.
        const home =
            families.length === 1 &&
            othersLoad(families[0]) &&
            list.every(group => (readerPartFamily(group) ?? families[0]) === families[0])
                ? families[0]
                : families.find(family => carriedBy(family, list));
        if (list.length === 1 || home) {
            placed.set(name, home ?? list[0]);
            continue;
        }
        // Modules the main readers use go in one chunk per set of them, and per whether the main
        // write uses them too, so opening an MP4, Matroska or audio file, or copying one into MP4,
        // loads exactly the shared code it runs in few chunks; a module imports only chunks of more
        // readers and of the write when it is of the write.
        // Code no main reader uses is named by the other readers that use it, so that one of them
        // does not load what another shares with the parts of a main reader.
        const partOf = family => list.some(group => readerPartFamily(group) === family);
        const mainReaders = MAIN_READERS.filter(
            reader => list.includes(reader) || (!RARE_PARTS.includes(reader) && partOf(reader)),
        );
        const readers = mainReaders.length
            ? mainReaders
            : OTHER_READERS.filter(reader => list.includes(reader));
        // What only the rare parts of a reader use with other readers is not loaded with every
        // input of that reader.
        for (const family of RARE_PARTS)
            if (partOf(family) && !readers.includes(family)) readers.push(`${family}parts`);
        // What only the parts of one of them use goes in a chunk of its own, which opening a
        // common input of that reader does not load.
        if (ENGINE_READERS.every(reader => readers.includes(reader))) {
            placed.set(name, 'read');
            continue;
        }
        const write = mainWrite.some(group => list.includes(group)) ? '-write' : '';
        const key = readers.length ? `reading-${readers.join('-')}${write}` : list.join('+');
        shared.set(key, [...(shared.get(key) ?? []), name]);
    }
    // What several of them share and no family carries: a chunk of its own.
    for (const [key, names] of shared) {
        const chunk = `shared-${key.startsWith('reading-') ? key : chunkNameOf(names[0])}`;
        if (groupRoots.has(chunk) || [...placed.values()].includes(chunk))
            throw new Error(`build: shared chunk ${chunk} would take the name of another chunk`);
        place(names, chunk);
    }
    const entryOwners = new Map();
    for (const entry of entries)
        for (const name of closure([entry]))
            if (!placed.has(name))
                entryOwners.set(name, [...(entryOwners.get(name) ?? []), entry.split('/').pop()]);
    for (const [name, list] of entryOwners) placed.set(name, `entry-${list.join('+')}`);
    for (const name of modules.keys()) if (!placed.has(name)) placed.set(name, 'internal');

    const chunks = new Map();
    for (const name of [...modules.keys()].sort((a, b) => order.get(a) - order.get(b))) {
        const chunk = placed.get(name);
        if (!chunks.has(chunk)) chunks.set(chunk, []);
        chunks.get(chunk).push(name);
    }
    // Chunks import each other without cycles, so each evaluates after the chunks it imports.
    const chunkDeps = new Map([...chunks.keys()].map(chunk => [chunk, new Set()]));
    for (const [name, info] of modules)
        for (const dep of info.staticDeps)
            if (placed.get(dep) !== placed.get(name))
                chunkDeps.get(placed.get(name)).add(placed.get(dep));
    {
        const state = new Map();
        const visitChunk = (chunk, path) => {
            if (state.get(chunk) === 'done') return;
            if (state.get(chunk) === 'open')
                throw new Error(`build: chunk cycle ${[...path, chunk].join(' -> ')}`);
            state.set(chunk, 'open');
            for (const dep of chunkDeps.get(chunk)) visitChunk(dep, [...path, chunk]);
            state.set(chunk, 'done');
        };
        for (const chunk of chunks.keys()) visitChunk(chunk, []);
    }
    /** The chunks that load whenever `chunk` does: those it imports, directly or through others. */
    const loadedWith = new Map();
    const loadedBy = chunk => {
        if (!loadedWith.has(chunk)) {
            const seen = new Set();
            const pending = [...chunkDeps.get(chunk)];
            while (pending.length) {
                const next = pending.pop();
                if (seen.has(next)) continue;
                seen.add(next);
                pending.push(...chunkDeps.get(next));
            }
            loadedWith.set(chunk, seen);
        }
        return loadedWith.get(chunk);
    };

    // Names. A binding keeps its name unless another binding of the chunk has it, the chunk reads a
    // global of that name, or a module refers to it by another name and uses its name for something
    // else; then it gets name$n, a name no identifier of the chunk spells.
    const key = (module, name) => `${module}\0${name}`;
    const finalNames = new Map();
    const namespaces = new Set();
    const sitesByTarget = new Map();
    for (const info of modules.values())
        for (const ref of info.refs) {
            if (ref.kind === 'dynamic') namespaces.add(ref.target);
            if (ref.kind === 'import' && ref.target.namespace) namespaces.add(ref.target.module);
            const target =
                ref.kind === 'member'
                    ? modules.get(ref.namespace).exports.get(ref.member)
                    : ref.kind === 'dynamic'
                      ? undefined
                      : ref.target;
            if (ref.kind === 'member' && !target) namespaces.add(ref.namespace);
            if (!target || target.namespace) continue;
            const id = key(target.module, target.name);
            if (!sitesByTarget.has(id)) sitesByTarget.set(id, []);
            sitesByTarget
                .get(id)
                .push({ module: info.name, text: ref.kind === 'member' ? '' : ref.node.text });
        }
    for (const info of modules.values())
        for (const target of info.exports.values())
            if (target.namespace) namespaces.add(target.module);
    // A namespace's name: $ns_ and the shortest end of its module's path that no other namespace's
    // path ends with, which keeps short the code of every dynamic import that names it.
    const namespaceNames = new Map();
    const spelled = path => `$ns_${path.replace(/[^A-Za-z0-9]/g, '_')}`;
    for (const module of [...namespaces].sort()) {
        const segments = module.split('/');
        let name = spelled(module);
        for (let take = 1; take < segments.length; take++) {
            const end = `/${segments.slice(-take).join('/')}`;
            if ([...namespaces].every(other => other === module || !`/${other}`.endsWith(end))) {
                name = spelled(end.slice(1));
                break;
            }
        }
        if ([...namespaceNames.values()].includes(name)) name = spelled(module);
        namespaceNames.set(module, name);
    }
    const namespaceName = module => namespaceNames.get(module);
    const imported = new Map(); // chunk -> Map(binding id -> local name)
    for (const [chunk, names] of chunks) {
        const texts = new Set();
        const free = new Set();
        for (const name of names) {
            for (const text of modules.get(name).texts) texts.add(text);
            for (const text of modules.get(name).free) free.add(text);
        }
        const used = new Set();
        const fresh = base => {
            for (let n = 1; ; n++) {
                const candidate = `${base}$${n}`;
                if (!texts.has(candidate) && !used.has(candidate)) return candidate;
            }
        };
        const conflicts = (id, name) =>
            used.has(name) ||
            free.has(name) ||
            (sitesByTarget.get(id) ?? []).some(
                site =>
                    placed.get(site.module) === chunk &&
                    site.text !== name &&
                    modules.get(site.module).texts.has(name),
            );
        for (const module of names) {
            for (const name of modules.get(module).topLevel) {
                const id = key(module, name);
                const final = conflicts(id, name) ? fresh(name) : name;
                used.add(final);
                finalNames.set(id, final);
            }
            if (namespaces.has(module)) used.add(namespaceName(module));
        }
        const locals = new Map();
        const local = (id, name) => {
            if (!locals.has(id)) {
                const alias = conflicts(id, name) ? fresh(name) : name;
                used.add(alias);
                locals.set(id, alias);
            }
            return locals.get(id);
        };
        imported.set(chunk, { local, locals });
    }
    // The expression a module of `chunk` uses for a binding or a namespace.
    const reference = (chunk, target) => {
        if (target.namespace) {
            const name = namespaceName(target.module);
            return placed.get(target.module) === chunk
                ? name
                : imported.get(chunk).local(`ns\0${target.module}`, name);
        }
        const id = key(target.module, target.name);
        const final = finalNames.get(id);
        if (final === undefined)
            throw new Error(`build: ${target.name} of ${target.module} is not a top-level binding`);
        return placed.get(target.module) === chunk ? final : imported.get(chunk).local(id, final);
    };

    // Chunk texts. A dynamic import of a module whose chunk other chunks import statically loads it
    // through a door, a file that re-exports the namespaces of the chunk's modules loaded on demand
    // only: bundlers then keep the chunk as one shared chunk whose unused exports they drop, rather
    // than also emitting an entry that re-exports all of them. One door per chunk, so the modules
    // of one chunk load in one request. A dynamic import of a module whose chunk loads whenever the
    // importing chunk does takes its namespace from that chunk: there is nothing to request.
    const staticallyImported = new Set([...chunkDeps.values()].flatMap(deps => [...deps]));
    const doorName = chunk => `door-${chunk}`;
    const doors = new Map();
    await mkdir(chunkDir, { recursive: true });
    const workerChunk = placed.get(WORKER_MODULE);
    const exportsOfChunk = new Map([...chunks.keys()].map(chunk => [chunk, new Set()]));
    const texts = new Map();
    const ranges = new Map();
    const offsets = new Map();
    for (const [chunk, names] of chunks) {
        let body = '';
        for (const name of names) {
            const info = modules.get(name);
            const edits = [...info.edits];
            for (const ref of info.refs) {
                const start = ref.node.getStart(info.source);
                if (ref.kind === 'dynamic') {
                    const target = placed.get(ref.target);
                    const namespace = namespaceName(ref.target);
                    if (target !== chunk && loadedBy(chunk).has(target)) {
                        const loaded = reference(chunk, { module: ref.target, namespace: true });
                        edits.push({
                            start,
                            end: ref.node.end,
                            text: `Promise.resolve().then(() => ${loaded})`,
                        });
                        continue;
                    }
                    const file = staticallyImported.has(target) ? doorName(target) : target;
                    if (file !== target) {
                        if (!doors.has(file))
                            doors.set(file, { chunk: target, namespaces: new Set() });
                        doors.get(file).namespaces.add(namespace);
                    }
                    edits.push({
                        start,
                        end: ref.node.end,
                        text:
                            target === chunk
                                ? `Promise.resolve().then(() => ${namespace})`
                                : `import('./${file}.js').then(m => m.${namespace})`,
                    });
                    continue;
                }
                if (ref.kind === 'member') {
                    const target = modules.get(ref.namespace).exports.get(ref.member);
                    const namespace = { module: ref.namespace, namespace: true };
                    const text = target
                        ? reference(chunk, target)
                        : `${reference(chunk, namespace)}.${ref.member}`;
                    edits.push({ start, end: ref.node.end, text });
                    continue;
                }
                const text = reference(chunk, ref.target);
                if (text === ref.node.text) continue;
                edits.push({
                    start,
                    end: ref.node.end,
                    text: ref.shorthand ? `${ref.node.text}: ${text}` : text,
                });
            }
            edits.sort((a, b) => b.start - a.start);
            let text = info.source.text;
            for (const edit of edits)
                text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
            if (name === WORKER_URL_MODULE) {
                // Both forms of the worker's URL, the browser's and Node's, name its chunk.
                text = text.replaceAll("'./frame-worker.js'", `'./${workerChunk}.js'`);
                if (text.includes('frame-worker.js'))
                    throw new Error(`${name}: a frame worker URL names no chunk`);
            }
            const start = body.length;
            body += text.trim() ? `${text.trim()}\n` : '';
            ranges.set(name, [start, body.length]);
            if (namespaces.has(name)) {
                const members = [...info.exports]
                    .map(
                        ([exported, target]) =>
                            `    get ${JSON.stringify(exported)}() { return ` +
                            `${reference(chunk, target)}; },`,
                    )
                    .join('\n');
                body +=
                    `const ${namespaceName(name)} = Object.freeze({\n    __proto__: ` +
                    `null,\n${members}\n});\n`;
                exportsOfChunk.get(chunk).add(namespaceName(name));
            }
            for (const target of info.exports.values())
                if (!target.namespace && placed.get(target.module) === chunk)
                    exportsOfChunk.get(chunk).add(finalNames.get(key(target.module, target.name)));
        }
        texts.set(chunk, body);
    }
    // Every binding another chunk imports is an export of its module, so the export lists above
    // cover them.
    for (const [chunk, body] of texts) {
        const { locals } = imported.get(chunk);
        const byChunk = new Map();
        for (const [id, alias] of locals) {
            const [module, name] = id.split('\0');
            const from = id.startsWith('ns\0') ? placed.get(name) : placed.get(module);
            const exported = id.startsWith('ns\0') ? namespaceName(name) : finalNames.get(id);
            if (!exportsOfChunk.get(from).has(exported))
                throw new Error(`build: ${exported} is not exported by ${from}`);
            if (!byChunk.has(from)) byChunk.set(from, []);
            byChunk.get(from).push(exported === alias ? exported : `${exported} as ${alias}`);
        }
        const header = [...byChunk]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([from, list]) => `import { ${list.join(', ')} } from './${from}.js';\n`)
            .join('');
        const exported = [...exportsOfChunk.get(chunk)];
        const footer = exported.length ? `export { ${exported.join(', ')} };\n` : '';
        offsets.set(chunk, header.length);
        await writeFile(join(chunkDir, `${chunk}.js`), `${header}${body}${footer}`);
    }
    // A door also names one binding of every chunk its chunk imports, the startup chunks aside: a
    // browser then requests them together with the chunk instead of after parsing it, one round
    // trip sooner.
    const startupChunks = new Set([...closure(startup)].map(name => placed.get(name)));
    const importedChunks = chunk => {
        const seen = new Set();
        const pending = [...chunkDeps.get(chunk)];
        while (pending.length) {
            const next = pending.pop();
            if (seen.has(next) || startupChunks.has(next)) continue;
            seen.add(next);
            pending.push(...chunkDeps.get(next));
        }
        return [...seen].sort();
    };
    for (const [door, { chunk, namespaces }] of doors) {
        let text = `export { ${[...namespaces].sort().join(', ')} } from './${chunk}.js';\n`;
        for (const imported of importedChunks(chunk)) {
            const [binding] = exportsOfChunk.get(imported);
            text +=
                `export { ${binding} as $with_${imported.replace(/[^A-Za-z0-9]/g, '_')} } from ` +
                `'./${imported}.js';\n`;
        }
        await writeFile(join(chunkDir, `${door}.js`), text);
    }
    await writeFile(
        join(chunkDir, 'package.json'),
        `${JSON.stringify({ type: 'module', sideEffects: false })}\n`,
    );

    // The modules: re-exports of their bindings from the chunks.
    for (const [name, info] of modules) {
        const file = join(esmDir, `${name}.js`);
        const path = chunk =>
            relative(dirname(file), join(chunkDir, `${chunk}.js`)).replaceAll('\\', '/');
        const byChunk = new Map();
        for (const [exported, target] of info.exports) {
            const from = placed.get(target.module);
            const binding = target.namespace
                ? namespaceName(target.module)
                : finalNames.get(key(target.module, target.name));
            if (!byChunk.has(from)) byChunk.set(from, []);
            byChunk.get(from).push(binding === exported ? exported : `${binding} as ${exported}`);
        }
        const text = byChunk.size
            ? [...byChunk]
                  .map(([from, list]) => `export { ${list.join(', ')} } from '${path(from)}';\n`)
                  .join('')
            : `import '${path(placed.get(name))}';\n`;
        await writeFile(file, text);
    }
    // modules.json: each module's chunk, its text there and its imports, for tools and tests that
    // look at modules.
    const manifest = {
        chunks: Object.fromEntries([...chunks].map(([chunk, names]) => [chunk, names])),
        doors: Object.fromEntries([...doors].map(([door, { chunk }]) => [door, chunk])),
        modules: Object.fromEntries(
            [...modules].map(([name, info]) => {
                const chunk = placed.get(name);
                const [start, end] = ranges.get(name).map(at => at + offsets.get(chunk));
                return [
                    name,
                    {
                        chunk,
                        start,
                        end,
                        static: [...new Set(info.staticDeps)],
                        dynamic: [...new Set(info.dynamicDeps)],
                    },
                ];
            }),
        ),
    };
    await writeFile(join(chunkDir, 'modules.json'), `${JSON.stringify(manifest)}\n`);
    return { chunks: chunks.size, modules: modules.size };
}
