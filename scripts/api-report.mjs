// The public API of every package entry, read from the built declarations: one file per entry in
// api/ (`mediaforgejs-lite.api.d.ts`) listing each export as the declarations describe it, without
// comments, and after them the types the exports reach without exporting them. A change of the
// API is a change of these files, so it shows in review. `npm run api:report` writes them after a
// build; test/build/api.test.mjs fails when they differ from the build.
import { readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The entries with declarations of a package: { name, subpath, types (absolute path) }. */
async function packageEntries(dir) {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const entries = [];
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
        const types = typeof target === 'object' ? target?.types : undefined;
        if (!types) continue;
        const name = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
        entries.push({ name, package: manifest.name, root: dir, types: join(dir, types) });
    }
    return entries;
}

/** Every entry of mediaforgejs and of the packages in packages/. */
export async function publicEntries(root = repoRoot) {
    const entries = await packageEntries(root);
    let names = [];
    try {
        names = (await readdir(join(root, 'packages'), { withFileTypes: true }))
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort();
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    for (const name of names) entries.push(...(await packageEntries(join(root, 'packages', name))));
    return entries;
}

/** The report file of an entry: 'mediaforgejs-runtime-node.api.d.ts' for '…/runtime/node'. */
export const reportName = entry => `${entry.name.replaceAll('/', '-')}.api.d.ts`;

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** `text` without import("...") qualifiers and with the modifiers of an exported declaration. */
function normalize(text, keyword) {
    const body = text
        .replaceAll(/import\("[^"]+"\)\./g, '')
        .replace(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?/, '');
    return `${keyword}${body}`;
}

/** The text of one declaration, named `name`. */
function declarationText(declaration, name) {
    const file = declaration.getSourceFile();
    if (ts.isVariableDeclaration(declaration)) {
        const list = declaration.parent;
        const kind = list.flags & ts.NodeFlags.Const ? 'const' : 'let';
        const type = declaration.type
            ? printer.printNode(ts.EmitHint.Unspecified, declaration.type, file)
            : 'unknown';
        return normalize(`${kind} ${name}: ${type};`, 'export declare ');
    }
    const keyword =
        ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
            ? 'export '
            : 'export declare ';
    // A class's private members are not part of its API: they change with its implementation.
    const node = ts.isClassDeclaration(declaration)
        ? ts.factory.updateClassDeclaration(
              declaration,
              declaration.modifiers,
              declaration.name,
              declaration.typeParameters,
              declaration.heritageClauses,
              declaration.members.filter(
                  member =>
                      !(ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private) &&
                      !(member.name && ts.isPrivateIdentifier(member.name)),
              ),
          )
        : declaration;
    const text = normalize(printer.printNode(ts.EmitHint.Unspecified, node, file), keyword);
    const own = declaration.name?.getText(file);
    return own && own !== name ? `/** exported as ${name} */\n${text}` : text;
}

/** The symbols of the package's own declarations that `node` names in a type position. */
function referencedSymbols(node, checker, isOwn) {
    const found = [];
    const visit = child => {
        let target;
        if (ts.isTypeReferenceNode(child)) target = child.typeName;
        else if (ts.isExpressionWithTypeArguments(child)) target = child.expression;
        else if (ts.isTypeQueryNode(child)) target = child.exprName;
        else if (ts.isImportTypeNode(child)) target = child.qualifier;
        if (target) {
            while (ts.isQualifiedName(target)) target = target.right;
            while (ts.isPropertyAccessExpression(target)) target = target.name;
            let symbol = checker.getSymbolAtLocation(target);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias)
                symbol = checker.getAliasedSymbol(symbol);
            if (
                symbol &&
                !(symbol.flags & ts.SymbolFlags.TypeParameter) &&
                symbol.declarations?.length &&
                symbol.declarations.every(declaration => isOwn(declaration.getSourceFile()))
            )
                found.push(symbol);
        }
        ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
}

/**
 * The API of every entry: `reports` maps each report file name to its text, `values` each entry
 * name to the names of the values it exports (the rest are types), and `files` holds the
 * declaration files of the API: the entries, the files their exports pass through, and those that
 * declare an export or a type the exports reach.
 */
export async function readApi(root = repoRoot) {
    const entries = await publicEntries(root);
    const main = entries.filter(entry => entry.root === root);
    const paths = Object.fromEntries(main.map(entry => [entry.name, [entry.types]]));
    const program = ts.createProgram(
        entries.map(entry => entry.types),
        {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
            strict: true,
            noEmit: true,
            types: [],
            paths,
        },
    );
    const checker = program.getTypeChecker();
    const reports = new Map();
    const values = new Map();
    const files = new Set();
    const hosts = (symbol, isOwn) => {
        for (const declaration of symbol.declarations ?? []) {
            const source = declaration.getSourceFile();
            if (isOwn(source)) files.add(resolve(source.fileName));
        }
    };
    for (const entry of entries) {
        const file = program.getSourceFile(entry.types);
        if (!file) throw new Error(`${entry.name}: ${entry.types} is missing; run npm run build`);
        const ownRoot = entry.root === root ? join(root, 'dist') : entry.root;
        const isOwn = source => resolve(source.fileName).startsWith(ownRoot + sep);
        const exported = new Map();
        files.add(resolve(file.fileName));
        // The files an export passes through on its way from its declaration to the entry.
        const passing = [file];
        while (passing.length)
            for (const statement of passing.pop().statements) {
                if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
                const source = checker.getSymbolAtLocation(
                    statement.moduleSpecifier,
                )?.valueDeclaration;
                if (!source || !isOwn(source) || files.has(resolve(source.fileName))) continue;
                files.add(resolve(source.fileName));
                passing.push(source);
            }
        for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(file))) {
            const target =
                symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
            exported.set(symbol.name, target);
            hosts(target, isOwn);
        }
        const names = [...exported.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        values.set(
            entry.name,
            names.filter(name => exported.get(name).flags & ts.SymbolFlags.Value),
        );
        const exportedTargets = new Set(exported.values());
        const blocks = [];
        const reached = new Map();
        const queue = [];
        const follow = declaration => {
            for (const symbol of referencedSymbols(declaration, checker, isOwn))
                if (!exportedTargets.has(symbol) && !reached.has(symbol)) {
                    reached.set(symbol, undefined);
                    queue.push(symbol);
                }
        };
        for (const name of names) {
            const target = exported.get(name);
            for (const declaration of target.declarations ?? []) {
                blocks.push(declarationText(declaration, name));
                follow(declaration);
            }
        }
        while (queue.length) {
            const symbol = queue.shift();
            hosts(symbol, isOwn);
            const texts = [];
            for (const declaration of symbol.declarations) {
                texts.push(
                    declarationText(declaration, symbol.name).replace(
                        /^export (?:declare )?/,
                        'declare ',
                    ),
                );
                follow(declaration);
            }
            reached.set(symbol, texts.join('\n'));
        }
        const internal = [...reached.entries()]
            .sort(([a], [b]) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map(([, text]) => text);
        const header =
            `// The public API of '${entry.name}', from its built declarations ` +
            `(npm run api:report).\n`;
        const reachedHeader = '\n// Types the exports reach without exporting them.\n\n';
        reports.set(
            reportName(entry),
            header +
                '\n' +
                blocks.join('\n\n') +
                '\n' +
                (internal.length ? reachedHeader + internal.join('\n\n') + '\n' : ''),
        );
    }
    return { reports, values, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { reports } = await readApi();
    const dir = join(repoRoot, 'api');
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(dir))
        if (name.endsWith('.api.d.ts') && !reports.has(name)) await rm(join(dir, name));
    for (const [name, text] of reports) await writeFile(join(dir, name), text);
    console.log(`api: ${reports.size} reports in ${relative(process.cwd(), dir) || '.'}`);
}
