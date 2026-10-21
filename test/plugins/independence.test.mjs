import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MediaForge } from 'mediaforgejs';
import * as lite from 'mediaforgejs/lite';
import { allPlugins } from 'mediaforgejs/plugins';
import {
    adtsFixture,
    matroskaFixture,
    tsFixture,
    waveFixture,
} from '../helpers/original-fixtures.mjs';
import { PLUGIN_OPERATIONS } from './fixtures.mjs';

// Every plugin of the catalog stands on its own: the lite entry with only that plugin does what
// its manifest says the plugin adds, and the default entry without it fails exactly those
// operations, with PLUGIN naming the plugin, while the core still works. The operations come from
// test/plugins/fixtures.mjs.

const ROLES = ['decoders', 'encoders', 'readers', 'writers', 'players'];

/** The parts a plugin adds: '<role>/<id>', and 'stages/<name>'. */
function partsOf(plugin) {
    const parts = [];
    for (const role of ROLES)
        for (const part of plugin[role] ?? []) parts.push(`${role}/${part.id}`);
    for (const stage of plugin.stages ?? []) parts.push(`stages/${stage.name}`);
    return parts;
}

/** What the core does without any plugin, on inputs of the core formats. */
const CORE_SMOKE = [
    async forge => {
        const info = await forge.inspect(new Blob([waveFixture()]));
        assert.deepEqual(
            info.tracks.map(track => track.codec),
            ['pcm-s16le'],
        );
    },
    async forge => {
        const result = await forge.convert(new Blob([waveFixture()]), 'wav');
        assert(result.blob.size > 44);
    },
    async forge => {
        const result = await forge.convert(new Blob([adtsFixture()]), 'm4a');
        assert.equal(result.plan.action, 'copy');
    },
    async forge => {
        assert.equal((await forge.inspect(new Blob([matroskaFixture()]))).format, 'mkv');
        assert.equal((await forge.inspect(new Blob([tsFixture()]))).format, 'ts');
    },
];

const isPluginError = name => error => {
    assert.equal(error.code, 'PLUGIN', error.message);
    assert.equal(error.plugin, name);
    return true;
};

describe('plugins', () => {
    for (const plugin of allPlugins) {
        const operations = PLUGIN_OPERATIONS[plugin.name] ?? {};
        describe(plugin.name, () => {
            for (const part of partsOf(plugin)) {
                const run = async forge => {
                    const operation = operations[part];
                    assert(operation, `test/plugins/fixtures.mjs has no operation for ${part}`);
                    await operation(forge);
                };
                test(`the lite entry with only ${plugin.name} does ${part}`, async () => {
                    await run(new lite.MediaForge({ plugins: [plugin] }));
                });
                test(`the default entry without ${plugin.name} fails ${part}`, async () => {
                    const forge = new MediaForge({ plugins: { exclude: [plugin.name] } });
                    await assert.rejects(run(forge), isPluginError(plugin.name));
                });
            }

            test(`operations name only parts of ${plugin.name}`, () => {
                const parts = partsOf(plugin);
                assert.deepEqual(
                    Object.keys(operations).filter(part => !parts.includes(part)),
                    [],
                );
            });

            test(`the core works without ${plugin.name}`, async () => {
                const forge = new MediaForge({ plugins: { exclude: [plugin.name] } });
                for (const operation of CORE_SMOKE) await operation(forge);
            });
        });
    }

    test('every plugin with operations is in the catalog', () => {
        const names = allPlugins.map(plugin => plugin.name);
        assert.deepEqual(
            Object.keys(PLUGIN_OPERATIONS).filter(name => !names.includes(name)),
            [],
        );
    });
});
