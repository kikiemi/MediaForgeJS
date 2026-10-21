import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { allPlugins } from 'mediaforgejs/plugins';
// The catalog has no public face: PLUGIN errors read it.
import { PLUGIN_CATALOG } from '../../dist/esm/plugins/catalog.js';

// The catalog that names missing plugins is the plugins' manifests: each plugin is its manifest
// with a loader for every part.

const described = parts => (parts ?? []).map(({ load, ...part }) => part);

describe('plugins catalog', () => {
    test('lists the manifest of every plugin, in the order of allPlugins', () => {
        assert.deepEqual(
            PLUGIN_CATALOG.map(manifest => manifest.name),
            allPlugins.map(plugin => plugin.name),
        );
    });

    test('each plugin is its manifest with a loader for every part', () => {
        for (const plugin of allPlugins) {
            const manifest = PLUGIN_CATALOG.find(entry => entry.name === plugin.name);
            assert.equal(plugin.description, manifest.description);
            for (const role of ['decoders', 'encoders', 'readers', 'writers', 'players']) {
                assert.deepEqual(described(plugin[role]), described(manifest[role]), plugin.name);
                for (const part of plugin[role] ?? []) assert.equal(typeof part.load, 'function');
            }
            assert.deepEqual(
                (plugin.stages ?? []).map(stage => stage.name),
                (manifest.stages ?? []).map(stage => stage.name),
            );
        }
    });
});
