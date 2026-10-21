import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAYERS, checkLayers, importGraph, layerOf } from '../../scripts/layers.mjs';

// The layer rule of src (scripts/layers.mjs, docs/ARCHITECTURE.md): imports point to a lower layer
// or stay in their own, formats and codecs never meet, a package entry names its exports, only a
// subsystem's own entries load it at startup and a plugin folder is entered through its index or
// manifest.

const root = fileURLToPath(new URL('../..', import.meta.url));
const exists = path =>
    access(path).then(
        () => true,
        () => false,
    );

/** A small tree with one violation of each kind, and the finding each must produce. */
const BROKEN = {
    'core/base.ts': 'export const base = 1;\n',
    'core/up.ts': "import { job } from '../pipeline/a';\nexport const up = job;\n",
    'formats/reader.ts': "import { codec } from '../codecs/codec';\nexport const reader = codec;\n",
    'codecs/codec.ts':
        "import type { Options } from '../api/options';\nexport const codec: Options = {};\n",
    'codecs/lazy.ts': "export const lazy = () => import('../pipeline/b');\n",
    'pipeline/a.ts': "import { b } from './b';\nexport const job = b;\n",
    'pipeline/b.ts':
        "import { job } from './a';\nexport const b = 2;\nexport const again = () => job;\n",
    'pipeline/missing.ts': "import { gone } from './gone';\nexport const missing = gone;\n",
    'api/options.ts':
        "import { base } from '../core/base';\nexport interface Options {}\n" +
        'export const value = base;\n',
    'api/entries/index.ts': "export * from '../options';\n",
    'editing/edit.ts': "import { base } from '../core/base';\nexport const edit = base;\n",
    'api/forge.ts': "import { edit } from '../editing/edit';\nexport const forge = edit;\n",
    'api/later.ts': "export const later = () => import('../editing/edit');\n",
    'api/entries/lite.ts': "export { forge } from '../forge';\nexport { later } from '../later';\n",
    'stray.ts': 'export const stray = 0;\n',
    'codecs/plug/manifest.ts': 'export const manifest = {};\n',
    'codecs/plug/index.ts': "export const plug = () => import('./decoder');\n",
    'codecs/plug/decoder.ts': 'export interface Decoder {}\nexport const decoder = 1;\n',
    'pipeline/run.ts':
        "import { plug } from '../codecs/plug/index';\n" +
        "import type { Decoder } from '../codecs/plug/decoder';\n" +
        'export const run = (decoder?: Decoder) => [plug, decoder];\n',
    'pipeline/peek.ts': "export const peek = () => import('../codecs/plug/decoder');\n",
};

describe('layers', () => {
    test('src keeps the layer rule', async () => {
        const result = await checkLayers(join(root, 'src'));
        assert.deepEqual(result.problems, []);
        assert.equal(result.cycles, 0);
        assert(result.modules > 300 && result.downward > 1000, 'the check reads all of src');
    });

    test('formats and codecs import nothing above core, not even types', async () => {
        const { edges } = await importGraph(join(root, 'src'));
        const above = edges.filter(edge => {
            const from = layerOf(edge.from);
            const to = layerOf(edge.to);
            return (from === 'formats' || from === 'codecs') && to !== 'core' && to !== from;
        });
        assert.deepEqual(above, []);
    });

    test('package entries are imported by entries only, the API by itself only', async () => {
        const rank = new Map(LAYERS.map(layer => [layer.name, layer.rank]));
        const { edges } = await importGraph(join(root, 'src'));
        const wrong = edges.filter(
            edge =>
                (edge.to.startsWith('api/entries/') && !edge.from.startsWith('api/entries/')) ||
                (layerOf(edge.to) === 'api' && rank.get(layerOf(edge.from)) < rank.get('api')),
        );
        assert.deepEqual(wrong, []);
    });

    test('the check reports upward, sibling and type-only upward imports', async () => {
        const { problems } = await checkLayers(BROKEN);
        assert(
            problems.includes(
                'core/up imports pipeline/a (static): core may not import upward to pipeline',
            ),
        );
        assert(
            problems.includes(
                'formats/reader imports codecs/codec (static): formats may not import across to ' +
                    'its sibling codecs',
            ),
        );
        assert(
            problems.includes(
                'codecs/codec imports api/options (type): codecs may not import upward to api',
            ),
        );
        assert(
            problems.includes(
                'codecs/lazy imports pipeline/b (dynamic): codecs may not import upward to ' +
                    'pipeline',
            ),
        );
    });

    test('the check reports unresolved imports, cycles and stray modules', async () => {
        const { problems } = await checkLayers(BROKEN);
        assert(problems.includes('pipeline/missing: unresolved import pipeline/gone'));
        assert(
            problems.some(problem => problem.startsWith('import cycle: pipeline/a -> pipeline/b')),
        );
        assert(problems.some(problem => problem.startsWith('stray: not in a layer directory')));
    });

    test('the check reports a re-exporting entry and a subsystem loaded at startup', async () => {
        const { problems } = await checkLayers(BROKEN);
        assert(problems.some(problem => problem.startsWith('api/entries/index: a package entry')));
        assert(
            problems.includes(
                'api/entries/lite loads the editing subsystem at startup: editing/edit',
            ),
        );
    });

    test("the check reports an import of a plugin's internals and accepts its types", async () => {
        const { problems } = await checkLayers(BROKEN);
        assert(
            problems.includes(
                'pipeline/peek imports codecs/plug/decoder (dynamic): outside the plugin folder ' +
                    'codecs/plug, import its index or manifest',
            ),
        );
        assert.equal(problems.length, 10, problems.join('\n'));
    });

    test('the docs name only modules and folders of src that exist', async () => {
        const tops = new Set(LAYERS.map(layer => layer.name));
        const missing = [];
        let named = 0;
        for (const doc of ['docs/README.md', 'docs/ARCHITECTURE.md', 'README.md']) {
            const text = (await readFile(join(root, doc), 'utf8')).replace(
                /<a id="(?:en|ja)-migration"><\/a>[\s\S]*?(?=<a id=|$)/g,
                '',
            );
            for (const match of text.matchAll(/`([a-z0-9-]+(?:\/[a-z0-9.-]+)+\/?)`/g)) {
                const path = match[1];
                const end = match.index + match[0].length;
                const around = text.slice(Math.max(0, match.index - 5), end + 6);
                if (/not\s+`|`\s*ではない/.test(around) || !tops.has(path.split('/')[0])) continue;
                named++;
                const file = join(root, 'src', path.replace(/\/$/, ''));
                if (!(await exists(file)) && !(await exists(`${file}.ts`)))
                    missing.push(`${doc}: ${path}`);
            }
        }
        assert.deepEqual(missing, []);
        assert(named > 100, `the docs name ${named} modules`);
    });

    test('the build checks the layers before it compiles anything', async () => {
        const build = await readFile(join(root, 'scripts/build.mjs'), 'utf8');
        assert.match(build, /async function main\(\) \{\n {4}await assertLayers\(\);/);
    });
});
