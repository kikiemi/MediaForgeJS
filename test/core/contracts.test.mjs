import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { allPlugins } from 'mediaforgejs/plugins';
import { distUrl } from '../helpers/dist-paths.mjs';

const { definePlugin } = await import(distUrl('esm/core/contracts/plugin.js'));
const { lazy } = await import(distUrl('esm/core/contracts/lazy.js'));

const ROLES = ['decoders', 'encoders', 'readers', 'writers', 'players'];

const manifest = {
    name: 'demo',
    description: 'demo files',
    decoders: [{ kind: 'audio', id: 'demo', codecs: ['demo'] }],
    readers: [{ id: 'demo', formats: ['demo'] }],
};

describe('contracts', () => {
    describe('plugins of the library', () => {
        test('every plugin and its parts are frozen, with a name and a loader per part', () => {
            assert(allPlugins.length > 0);
            for (const plugin of allPlugins) {
                assert.equal(Object.isFrozen(plugin), true, plugin.name);
                assert.equal(typeof plugin.name, 'string');
                assert.equal(typeof plugin.description, 'string', plugin.name);
                for (const role of ROLES)
                    for (const part of plugin[role] ?? []) {
                        assert.equal(Object.isFrozen(part), true, `${plugin.name} ${part.id}`);
                        assert.equal(typeof part.load, 'function', `${plugin.name} ${part.id}`);
                    }
            }
        });

        test('plugin names are unique', () => {
            const names = allPlugins.map(plugin => plugin.name);
            assert.equal(new Set(names).size, names.length);
        });

        test('every audio encoder part loads its encoder class', async () => {
            const parts = allPlugins.flatMap(plugin =>
                (plugin.encoders ?? []).filter(part => part.kind === 'audio'),
            );
            assert.deepEqual(parts.map(part => part.id).sort(), ['aac', 'flac', 'mp2', 'mp3']);
            for (const part of parts) {
                const Encoder = await part.load();
                assert.equal(typeof Encoder, 'function', part.id);
                assert.equal(typeof Encoder.prototype.pushPlanar, 'function', part.id);
            }
        });
    });

    describe('definePlugin', () => {
        test('gives each part of the manifest its loader', async () => {
            const plugin = definePlugin(manifest, {
                decoders: { demo: async () => 'decoder' },
                readers: { demo: async () => 'reader' },
            });
            assert.deepEqual([plugin.name, plugin.description], ['demo', 'demo files']);
            assert.equal(plugin.decoders[0].kind, 'audio');
            assert.deepEqual(plugin.decoders[0].codecs, ['demo']);
            assert.equal(await plugin.decoders[0].load(), 'decoder');
            assert.equal(await plugin.readers[0].load(), 'reader');
            assert.equal(Object.isFrozen(plugin.decoders), true);
        });

        test('roles the manifest leaves out stay out', () => {
            const plugin = definePlugin(manifest, {
                decoders: { demo: async () => 0 },
                readers: { demo: async () => 0 },
                writers: { other: async () => 0 },
            });
            assert.deepEqual(Object.keys(plugin).sort(), [
                'decoders',
                'description',
                'name',
                'readers',
            ]);
        });

        test('a part without its loader fails with INPUT, naming it', () => {
            assert.throws(() => definePlugin(manifest, { decoders: { demo: async () => 0 } }), {
                code: 'INPUT',
                message: "Plugin 'demo': no loader for readers 'demo'",
            });
        });

        test('stages come with the manifest that lists them', () => {
            const stage = { type: 'video', name: 'blur', create: () => ({}) };
            const listed = definePlugin(
                { name: 'fx', description: 'effects', stages: [{ type: 'video', name: 'blur' }] },
                {},
                [stage],
            );
            assert.deepEqual(listed.stages, [stage]);
            assert.equal(Object.isFrozen(listed.stages), true);
            assert.equal(
                definePlugin({ name: 'fx', description: 'effects' }, {}, [stage]).stages,
                undefined,
            );
        });
    });

    describe('lazy loading', () => {
        test('callers share one fetch, made on the first call', async () => {
            let fetches = 0;
            const load = lazy(async () => ++fetches);
            assert.equal(fetches, 0, 'nothing is fetched before a call');
            const [first, second] = await Promise.all([load(), load()]);
            assert.deepEqual([first, second, await load(), fetches], [1, 1, 1, 1]);
        });

        test('a failed fetch is tried again by the next call', async () => {
            let fetches = 0;
            const load = lazy(async () => {
                if (++fetches === 1) throw new Error('offline');
                return 'loaded';
            });
            await assert.rejects(load(), /offline/);
            assert.equal(await load(), 'loaded');
            assert.equal(fetches, 2);
        });

        test('a fetch that throws at once rejects instead', async () => {
            const load = lazy(() => {
                throw new Error('bad module');
            });
            const pending = load();
            assert(pending instanceof Promise);
            await assert.rejects(pending, /bad module/);
        });

        test('a plugin part loads once however often it is asked', async () => {
            let fetches = 0;
            const plugin = definePlugin(
                { name: 'demo', description: 'demo', readers: [{ id: 'r', formats: ['x'] }] },
                { readers: { r: async () => ++fetches } },
            );
            await plugin.readers[0].load();
            await plugin.readers[0].load();
            assert.equal(fetches, 1);
        });
    });
});
