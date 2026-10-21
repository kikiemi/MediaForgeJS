import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    checkFeatures,
    dependents,
    featureMap,
    featureOf,
    featureOfTest,
} from '../../scripts/features.mjs';
import { importGraph } from '../../scripts/layers.mjs';

/** The problems of the feature check on a tree of src held in memory. */
async function check(tree, dependencies, options = {}) {
    const graph = await importGraph(tree);
    const ids = Object.keys(dependencies);
    const { tests = ids.map(id => `test/${id}.test.mjs`), shared = [] } = options;
    return checkFeatures({ ...graph, tests }, { dependencies, shared }).problems;
}

const TREE = {
    'core/errors/errors.ts': 'export const error = 1;\n',
    'formats/shared/util.ts':
        "import { error } from '../../core/errors/errors';\nexport const u = error;\n",
    'formats/mp4/reader.ts':
        "import { u } from '../shared/util';\nimport { m } from '../matroska/reader';\n" +
        'export const r = u + m;\n',
    'formats/matroska/reader.ts':
        "import type { X } from '../mp4/types';\nexport const m: X = 2;\n",
    'formats/mp4/types.ts': 'export type X = number;\n',
};
const DECLARED = {
    'core/errors': [],
    'formats/shared': ['core/*'],
    'formats/mp4': ['formats/shared', 'formats/matroska'],
    'formats/matroska': [],
};

// The feature map (scripts/features.mjs, docs/ARCHITECTURE.md#en-features): every module of src
// belongs to one feature, every feature declares what it uses and has tests, and plugins use only
// core and the shared features.

describe('features', () => {
    test('src and packages/ keep the feature map', async () => {
        const map = await featureMap();
        assert.deepEqual(map.problems, []);
        assert(map.features.size > 40, 'the map reads all of src');
    });

    test('a tree whose uses are all declared passes, type-only imports aside', async () => {
        assert.deepEqual(await check(TREE, DECLARED), []);
    });

    test('the check names an undeclared use and the import that makes it', async () => {
        const problems = await check(TREE, { ...DECLARED, 'formats/mp4': ['formats/shared'] });
        assert.deepEqual(problems, [
            'formats/mp4 uses formats/matroska, which it does not declare ' +
                '(formats/mp4/reader imports formats/matroska/reader)',
        ]);
    });

    test('the check reports a declared use that is unused or names nothing', async () => {
        const problems = await check(TREE, {
            ...DECLARED,
            'formats/matroska': ['formats/shared', 'codecs/*'],
        });
        assert.deepEqual(problems, [
            'formats/matroska declares formats/shared but does not use it',
            'formats/matroska declares codecs/*, which names no feature',
        ]);
    });

    test('the check reports a cycle among the declared uses', async () => {
        const problems = await check(TREE, {
            ...DECLARED,
            'formats/shared': ['core/*', 'formats/mp4'],
        });
        assert.deepEqual(problems, [
            'formats/shared declares formats/mp4 but does not use it',
            'the declared uses form a cycle: formats/mp4 -> formats/shared -> formats/mp4',
        ]);
    });

    test('the check reports a plugin using more than core and shared features', async () => {
        const tree = {
            ...TREE,
            'codecs/plug/manifest.ts': 'export const manifest = {};\n',
            'codecs/plug/index.ts': "export const plug = () => import('./decoder');\n",
            'codecs/plug/decoder.ts':
                "import { r } from '../../formats/mp4/reader';\nexport const d = r;\n",
        };
        const problems = await check(
            tree,
            { ...DECLARED, 'codecs/plug': ['core/*', 'formats/mp4'] },
            { shared: ['formats/shared'] },
        );
        assert.deepEqual(problems, [
            'codecs/plug declares formats/mp4: a plugin uses only core and formats/shared',
        ]);
    });

    test('the check reports features without declaration or tests, and stray tests', async () => {
        const undeclared = Object.fromEntries(
            Object.entries(DECLARED).filter(([id]) => id !== 'formats/matroska'),
        );
        const problems = await check(TREE, undeclared, {
            tests: ['test/core/errors.test.mjs', 'test/formats/mp5.test.mjs'],
        });
        assert.deepEqual(problems, [
            'formats/matroska: a feature without a declaration in scripts/features.mjs',
            'formats/matroska: no test file (test/formats/matroska.test.mjs or ' +
                'test/formats/matroska-<aspect>.test.mjs)',
            'formats/mp4: no test file (test/formats/mp4.test.mjs or ' +
                'test/formats/mp4-<aspect>.test.mjs)',
            'formats/shared: no test file (test/formats/shared.test.mjs or ' +
                'test/formats/shared-<aspect>.test.mjs)',
            'test/formats/mp5.test.mjs belongs to no feature: name it after the feature it tests',
        ]);
    });

    test('a module belongs to its plugin folder, else its subfolder or top folder', () => {
        const plugins = ['codecs/h264', 'player'];
        assert.equal(featureOf('codecs/h264/slice', plugins), 'codecs/h264');
        assert.equal(featureOf('codecs/flac/decoder', plugins), 'codecs/flac');
        assert.equal(featureOf('core/codec-config/audio/aac', plugins), 'core/codec-config');
        assert.equal(featureOf('pipeline/engine', plugins), 'pipeline');
        assert.equal(featureOf('pipeline/copy/packet-copy', plugins), 'pipeline/copy');
        assert.equal(featureOf('api/entries/index', plugins), 'api');
        assert.equal(featureOf('runtime/ffmpeg/backend', plugins), 'runtime');
        assert.equal(featureOf('player/drm/eme', plugins), 'player');
    });

    test('a test file belongs to the longest feature name its path starts with', () => {
        const features = [
            'codecs/mpeg-audio',
            'codecs/mpeg12',
            'core/io',
            'formats/mp4',
            'pipeline',
            'pipeline/copy',
            'stages',
            'packages/player',
        ];
        const owner = path => featureOfTest(path, features);
        assert.equal(owner('test/codecs/mpeg-audio-decode.test.mjs'), 'codecs/mpeg-audio');
        assert.equal(owner('test/codecs/mpeg12.test.mjs'), 'codecs/mpeg12');
        assert.equal(owner('test/core/io-cached-source.test.mjs'), 'core/io');
        assert.equal(owner('test/formats/mp4-read.test.mjs'), 'formats/mp4');
        assert.equal(owner('test/pipeline/copy-trim.test.mjs'), 'pipeline/copy');
        assert.equal(owner('test/pipeline/engine.test.mjs'), 'pipeline');
        assert.equal(owner('test/stages/time-stretch.test.mjs'), 'stages');
        assert.equal(owner('packages/player/test/live.test.mjs'), 'packages/player');
        assert.equal(owner('test/formats/mp5.test.mjs'), undefined);
        assert.equal(owner('test/codecs/mpeg2.test.mjs'), undefined);
    });

    test('the features that may break are the changed ones and every one that uses them', () => {
        const feature = (...uses) => ({ uses: new Map(uses.map(use => [use, ''])), tests: [] });
        const map = {
            features: new Map([
                ['core/errors', feature()],
                ['formats/mp4', feature('core/errors')],
                ['formats/matroska', feature('core/errors', 'formats/mp4')],
                ['codecs/flac', feature('core/errors')],
                ['api', feature('formats/matroska', 'codecs/flac')],
                ['packages/prores', feature()],
            ]),
            packages: ['packages/prores'],
        };
        assert.deepEqual(dependents(map, ['formats/mp4']), [
            'api',
            'formats/matroska',
            'formats/mp4',
            'packages/prores',
        ]);
        assert.deepEqual(dependents(map, ['packages/prores']), ['packages/prores']);
        assert.equal(dependents(map, ['core/errors']).length, 6);
    });
});
