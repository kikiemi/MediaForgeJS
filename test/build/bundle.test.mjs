import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { constants, deflateRawSync } from 'node:zlib';
import { minifyJs } from '../../scripts/minify.mjs';

// What the build ships and what each entry loads: the script bundles, the module closures of the
// ESM entries and their size budgets, the chunk layout (scripts/esm-chunks.mjs) and the order in
// which a first call loads its code.

const dist = new URL('../../dist/', import.meta.url);
const distUrl = path => new URL(path, dist);
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const chunkDir = fileURLToPath(distUrl('chunks/'));
const layout = JSON.parse(await readFile(distUrl('chunks/modules.json'), 'utf8'));
const fixtures = new URL('../helpers/original-fixtures.mjs', import.meta.url).href;

/**
 * Size budgets in bytes of minified code (the repository's minifier over whole modules, an upper
 * bound on a tree-shaken bundle). An entry's budget is [initial load, loaded on demand]. A new
 * feature is paid for by reductions elsewhere; a budget rises only with the reason in the commit.
 */
const BUDGETS = {
    entries: {
        lite: [41_046, 2_101_248],
        default: [54_506, 3_323_261],
        plugins: [12_386, 1_540_482],
        streaming: [286_178, 0],
        codecs: [489_472, 125_180],
        codecsCore: [393_216, 155_918],
    },
    /** What opening any input loads: the engine and the readers. */
    readers: 182_272,
    /** The MP4 reader that every MP4 input runs. */
    mp4Reader: 59_867,
    /** The Matroska reader that every Matroska or WebM input runs. */
    matroskaReader: 59_554,
    /** The chunks opening an MP4 loads beyond the startup of the default entry. */
    openMp4: 392_192,
    /** The speaker masks of dac3 and dec3 that the core keeps for AC-3. */
    dolbyLayout: 577,
    /** The deflated WebAssembly kernels of the h264 plugin. */
    h264Kernels: 23_886,
};

/** Every plugin of the catalog and the modules of its implementation, loaded on first use. */
const STATIC = 'static';
const ANY = 'any';
const sources = new Map();
const read = async file => {
    if (!sources.has(file)) sources.set(file, await readFile(file, 'utf8'));
    return sources.get(file);
};
/** The modules an entry reaches through static imports, or through any import. */
const closure = async (entry, kind = STATIC) => {
    const seen = new Set();
    const queue = [entry.replace(/\.js$/, '')];
    while (queue.length) {
        const name = queue.pop();
        if (seen.has(name)) continue;
        seen.add(name);
        const module = layout.modules[name];
        assert(module, `${name} is in dist/chunks/modules.json`);
        queue.push(...module.static, ...(kind === ANY ? module.dynamic : []));
    }
    return [...seen].map(name => `${name}.js`);
};
const minified = new Map();
/** The minified size of modules. */
const size = async files => {
    let total = 0;
    for (const file of files) {
        if (!minified.has(file)) {
            const module = layout.modules[file.replace(/\.js$/, '')];
            const text = await read(resolve(chunkDir, `${module.chunk}.js`));
            minified.set(file, minifyJs(text.slice(module.start, module.end)));
        }
        total += minified.get(file).length;
    }
    return total;
};
const chunkOf = file => layout.modules[file.replace(/\.js$/, '')].chunk;
/** The chunks that loading `roots` loads, following their imports. */
const chunkClosure = async roots => {
    const seen = new Set();
    const queue = [...roots];
    while (queue.length) {
        const chunk = queue.pop();
        if (seen.has(chunk)) continue;
        seen.add(chunk);
        const text = await read(resolve(chunkDir, `${chunk}.js`));
        for (const match of text.matchAll(/^import \{[^}]*\} from '\.\/([^']+)\.js';$/gm))
            queue.push(match[1]);
    }
    return [...seen];
};
const modulesOf = chunks => chunks.flatMap(chunk => layout.chunks[chunk]).map(name => `${name}.js`);

// Patterns name modules by id; each alternative of a pattern must name a module of the build, so a
// pattern never silently checks nothing.
const known = Object.keys(layout.modules).map(name => `${name}.js`);
const alternatives = pattern => {
    const group = /\((?!\?)([^()]*\|[^()]*)\)/.exec(pattern.source);
    if (!group) return [pattern];
    const before = pattern.source.slice(0, group.index);
    const after = pattern.source.slice(group.index + group[0].length);
    return group[1]
        .split('|')
        .flatMap(option =>
            alternatives(new RegExp(`${before}(?:${option})${after}`, pattern.flags)),
        );
};
const names = patterns => {
    for (const pattern of patterns)
        for (const alternative of alternatives(pattern))
            assert(
                known.some(file => alternative.test(file)),
                `${alternative} (of ${pattern}) names no module of the build`,
            );
    return patterns;
};
const escapeId = id => id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** Exactly the named modules. */
const modules = (...ids) => new RegExp(`^(${ids.map(escapeId).join('|')})\\.js$`);
/** Every module under the directories (ids ending in '/'). */
const under = (...dirs) => new RegExp(`^(${dirs.map(escapeId).join('|')})`);
/** A plugin folder's implementation: its modules but the manifest and the index. */
const code = (...dirs) =>
    new RegExp(`^(${dirs.map(escapeId).join('|')})(?!(?:manifest|index)\\.js$)`);
/** A pattern's modules except the named ones. */
const except = (pattern, ...ids) =>
    new RegExp(`^(?!(?:${ids.map(escapeId).join('|')})\\.js$)${pattern.source.slice(1)}`);
const matches = pattern => {
    names([pattern]);
    return file => pattern.test(file);
};

const ENTRIES = {
    lite: 'api/entries/lite.js',
    default: 'api/entries/index.js',
    plugins: 'plugins/index.js',
    isMediaForgeError: 'core/errors/errors.js',
    streaming: 'api/entries/streaming.js',
    codecs: 'api/entries/codecs.js',
    // The codecs namespace of the lite script.
    codecsCore: 'api/surface-codecs.js',
};
const graphs = {};
const initial = {};
for (const [name, entry] of Object.entries(ENTRIES)) {
    graphs[name] = await closure(entry, ANY);
    initial[name] = await closure(entry);
}
const lacks = (name, patterns) => {
    for (const pattern of names(patterns))
        assert.deepEqual(
            graphs[name].filter(file => pattern.test(file)),
            [],
            `${name} must not pull ${pattern}`,
        );
};
const loadsLazily = (name, patterns) => {
    for (const pattern of names(patterns))
        assert.deepEqual(
            initial[name].filter(file => pattern.test(file)),
            [],
            `${name} loads ${pattern} on demand, not initially`,
        );
};

/** The implementation of every plugin, which none of its descriptors loads at once. */
const PLUGIN_CODE = [
    code('codecs/h264/', 'codecs/mpeg12/', 'codecs/mpeg4/'),
    modules('codecs/shared/decoder-warnings'),
    code('codecs/opus/'),
    code('codecs/vorbis/'),
    modules(
        'codecs/mpeg-audio/mp3-decoder',
        'codecs/mpeg-audio/layer12-decoder',
        'codecs/flac/decoder',
        'codecs/alac/decoder',
        'codecs/mpeg-audio/mp2-encoder',
    ),
    code('codecs/ac3/'),
    modules('codecs/aac/sbr', 'codecs/aac/sbr-tables', 'codecs/aac/sbr-tools', 'codecs/aac/ps'),
    modules(
        'codecs/aac/decoder',
        'codecs/aac/track',
        'codecs/aac/encoder',
        'codecs/flac/encoder',
        'codecs/mpeg-audio/mp3-encoder',
    ),
    modules(
        'formats/mxf/reader',
        'formats/asf/reader',
        'formats/avi/reader',
        'formats/flv/reader',
        'formats/mpeg-ps/reader',
        'formats/ivf/reader',
        'formats/ivf/obu-reader',
    ),
    modules('formats/avi/writer', 'formats/flv/writer', 'formats/ivf/writer'),
    // The plugin descriptors: the lite entry knows the plugins by their manifests only.
    modules(
        'plugins/index',
        'codecs/h264/index',
        'codecs/mpeg12/index',
        'codecs/mpeg4/index',
        'codecs/aac/index',
        'codecs/mpeg-audio/index',
        'codecs/ac3/index',
        'codecs/flac/index',
        'codecs/alac/index',
        'codecs/opus/index',
        'codecs/vorbis/index',
        'formats/avi/index',
        'formats/flv/index',
        'formats/asf/index',
        'formats/mxf/index',
        'formats/mpeg-ps/index',
        'formats/ivf/index',
    ),
];

/** The modules each plugin loads on first use. */
const PLUGIN_IMPLEMENTATIONS = {
    h264: code('codecs/h264/'),
    mpeg12: code('codecs/mpeg12/'),
    mpeg4: code('codecs/mpeg4/'),
    aac: modules('codecs/aac/decoder', 'codecs/aac/sbr', 'codecs/aac/encoder'),
    mpegAudio: modules('codecs/mpeg-audio/mp3-decoder', 'codecs/mpeg-audio/mp2-encoder'),
    flac: modules('codecs/flac/decoder', 'codecs/flac/encoder'),
    alac: modules('codecs/alac/decoder'),
    opus: modules('codecs/opus/decoder'),
    vorbis: modules('codecs/vorbis/decoder'),
    ac3: code('codecs/ac3/'),
    avi: modules('formats/avi/reader'),
    flv: modules('formats/flv/reader'),
    asf: modules('formats/asf/reader'),
    mxf: modules('formats/mxf/reader'),
    mpegPs: modules('formats/mpeg-ps/reader'),
    ivf: modules('formats/ivf/reader'),
    iamf: modules('formats/iamf/reader', 'formats/iamf/writer'),
    apv: modules('formats/apv/reader', 'formats/apv/writer', 'formats/apv/decoder'),
};
const PLUGIN_NAMES = Object.keys(PLUGIN_IMPLEMENTATIONS);

/** A context with what every browser and worker has, for running a script bundle. */
const browserGlobals = () =>
    vm.createContext({
        atob,
        TextEncoder,
        TextDecoder,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        Blob,
        AbortController,
        AbortSignal,
        DOMException,
    });
const script = async path => readFile(distUrl(path), 'utf8');

/**
 * Runs `child` (module code) in a fresh Node process with the default entry, the fixtures and
 * `args`; the process records the URLs of the modules it loads. Resolves what it printed.
 */
function inFreshProcess(child, ...args) {
    const recorder = `
        import { register } from 'node:module';
        import { MessageChannel } from 'node:worker_threads';
        const { port1, port2 } = new MessageChannel();
        const loaded = new Set();
        port1.on('message', url => loaded.add(url));
        port1.unref();
        const hooks =
            'let port; export function initialize(data) { port = data.port; } ' +
            'export async function load(url, context, next) { port.postMessage(url); ' +
            'return next(url, context); }';
        register('data:text/javascript,' + encodeURIComponent(hooks), {
            data: { port: port2 },
            transferList: [port2],
        });
        const named = () => new Set([...loaded].map(url => url.slice(url.lastIndexOf('/') + 1)));
        const [entry, fixtures, ...args] = process.argv.slice(1);
        let release;
        const held = new Promise(resolve => (release = resolve));
        class HeldBlob extends Blob {
            arrayBuffer() {
                return held.then(() => super.arrayBuffer());
            }
        }
        class HeldFile extends File {
            slice(...range) {
                return new HeldBlob([super.slice(...range)]);
            }
        }
    `;
    const result = spawnSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            recorder + child,
            distUrl('esm/api/entries/index.js').href,
            fixtures,
            ...args,
        ],
        { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout);
}

describe('bundles', () => {
    describe('script bundles', () => {
        test('each script sets its two globals and noConflict() restores the page', async () => {
            for (const name of [
                'MediaForgeJS.js',
                'MediaForgeJS.min.js',
                'MediaForgeJS.lite.js',
                'MediaForgeJS.lite.min.js',
            ]) {
                const source = await script(name);
                const old = {
                    define() {},
                    require() {},
                    MediaForgeJS: { previous: 1 },
                    MediaForgeJSReady: {},
                };
                const context = vm.createContext({ ...old, atob, TextEncoder, TextDecoder });
                const keys = Reflect.ownKeys(context);
                vm.runInContext(source, context);
                assert.equal(context.define, old.define, `${name} replaced define`);
                assert.equal(context.require, old.require, `${name} replaced require`);
                const api = context.MediaForgeJS;
                assert.equal(typeof api.convert, 'function');
                assert.equal(api.noConflict(), api);
                for (const [key, value] of Object.entries(old))
                    assert.equal(context[key], value, key);
                assert.deepEqual(Reflect.ownKeys(context).sort(), keys.sort());
                const fresh = vm.createContext({ atob, TextEncoder, TextDecoder });
                vm.runInContext(source, fresh);
                assert.deepEqual(Reflect.ownKeys(fresh).sort(), [
                    'MediaForgeJS',
                    'MediaForgeJSReady',
                    'TextDecoder',
                    'TextEncoder',
                    'atob',
                ]);
                fresh.MediaForgeJS.noConflict();
                assert.deepEqual(Reflect.ownKeys(fresh).sort(), [
                    'TextDecoder',
                    'TextEncoder',
                    'atob',
                ]);
            }
        });

        test('the scripts expose none of the removed classes and functions', async () => {
            for (const name of ['MediaForgeJS.min.js', 'MediaForgeJS.lite.min.js']) {
                const context = browserGlobals();
                vm.runInContext(await script(name), context);
                for (const removed of [
                    'Engine',
                    'MediaEngine',
                    'MediaWorkflow',
                    'MediaForgeConverter',
                    'Pipeline',
                    'convertMedia',
                ])
                    assert.equal(context.MediaForgeJS[removed], undefined, `${name}: ${removed}`);
            }
        });

        test('a plugin script before the lite script says to load that first', async () => {
            const h264 = await script('browser-plugins/h264.min.js');
            assert.throws(
                () => vm.runInContext(h264, browserGlobals()),
                /load MediaForgeJS\.lite\.min\.js first/,
            );
        });

        test('the lite script has no plugin, and no plugin codecs or containers', async () => {
            const context = browserGlobals();
            vm.runInContext(await script('MediaForgeJS.lite.min.js'), context);
            const api = context.MediaForgeJS;
            assert.equal((await new api.MediaForge().capabilities()).plugins.length, 0);
            assert.equal(api.formats.AviDemuxer, undefined);
            assert.equal(typeof api.formats.parseSubtitles, 'function');
            for (const codec of ['decodeMp3', 'decodeFlac', 'AlacDecoder', 'encodeMp2'])
                assert.equal(api.codecs[codec], undefined, codec);
        });

        test('a plugin without its script fails with PLUGIN naming the script', async () => {
            const context = browserGlobals();
            vm.runInContext(await script('MediaForgeJS.lite.min.js'), context);
            const api = context.MediaForgeJS;
            const missing = await api.plugins.h264.decoders[0].load().catch(error => error);
            assert.equal(missing.code, 'PLUGIN');
            assert.equal(missing.plugin, 'h264');
            assert(api.isMediaForgeError(missing));
            assert.match(missing.hint, /browser-plugins\/h264\.min\.js/);
        });

        test('the lite script reads MP4, WebM and MP3 from its module registry', async () => {
            const context = browserGlobals();
            vm.runInContext(await script('MediaForgeJS.lite.min.js'), context);
            for (const [file, format, codecs] of [
                ['clip-a.mp4', 'mp4', ['avc1.4d400a', 'mp4a.40.2']],
                ['clip-c.webm', 'webm', ['vp09.00.10.08', 'opus']],
                ['music.mp3', 'mp3', ['mp3']],
            ]) {
                const bytes = new Uint8Array(
                    await readFile(new URL(`../fixtures/editing/${file}`, import.meta.url)),
                );
                const result = await context.MediaForgeJS.inspect(bytes);
                assert.equal(result.format, format, file);
                assert.deepEqual(
                    Array.from(result.tracks, track => track.codec),
                    codecs,
                    file,
                );
            }
        });

        test('each plugin script completes its plugin in the lite script', async () => {
            const context = browserGlobals();
            vm.runInContext(await script('MediaForgeJS.lite.min.js'), context);
            const api = context.MediaForgeJS;
            for (const name of PLUGIN_NAMES) {
                vm.runInContext(await script(`browser-plugins/${name}.min.js`), context);
                assert.equal(api.plugins[name]?.name, name, `browser-plugins/${name}.min.js`);
            }
            const forge = new api.MediaForge({ plugins: { add: api.plugins.allPlugins } });
            assert.equal((await forge.capabilities()).plugins.length, PLUGIN_NAMES.length);
            const decoder = await (
                await api.plugins.h264.decoders[0].load()
            )({
                codec: 'avc1.42001e',
            });
            assert.equal(typeof decoder.decode, 'function');
            decoder.close();
            const audio = { sampleRate: 48000, channelCount: 2, samples: [] };
            const opus = await (
                await api.plugins.opus.decoders[0].load()
            )({
                ...audio,
                codec: 'opus',
            });
            assert.equal(typeof opus.create, 'function');
            const aac = await (
                await api.plugins.aac.decoders[0].load()
            )({
                ...audio,
                codec: 'mp4a.40.2',
                codecConfig: Uint8Array.of(0x12, 0x10),
                sampleRate: 44100,
            });
            assert.equal(typeof aac.create, 'function');
            const ac3 = await (
                await api.plugins.ac3.decoders[0].load()
            )({ ...audio, codec: 'ac-3' });
            assert.equal(typeof ac3.create, 'function');
        });

        test('all.min.js adds every plugin to the lite script', async () => {
            const context = browserGlobals();
            vm.runInContext(await script('MediaForgeJS.lite.min.js'), context);
            vm.runInContext(await script('browser-plugins/all.min.js'), context);
            const api = context.MediaForgeJS;
            const everything = new api.MediaForge({ plugins: api.plugins.allPlugins });
            assert.equal((await everything.capabilities()).plugins.length, PLUGIN_NAMES.length);
            assert.equal(typeof (await api.plugins.avi.readers[0].load()).read, 'function');
        });

        test('the default script uses every plugin; plugins.exclude leaves one out', async () => {
            const context = browserGlobals();
            vm.runInContext(await script('MediaForgeJS.min.js'), context);
            const api = context.MediaForgeJS;
            assert.equal((await api.capabilities()).plugins.length, PLUGIN_NAMES.length);
            for (const codec of ['decodeMp3', 'decodeFlac', 'AlacDecoder', 'encodeMp2'])
                assert.equal(typeof api.codecs[codec], 'function', codec);
            assert.equal(typeof api.formats.AviDemuxer, 'function');
            const decoder = await (
                await api.plugins.h264.decoders[0].load()
            )({
                codec: 'avc1.42001e',
            });
            decoder.close();
            const trimmed = new api.MediaForge({ plugins: { exclude: ['h264'] } });
            assert(!(await trimmed.capabilities()).video.decoders.includes('h264'));
        });

        test('the repository minifier reproduces the shipped script', async () => {
            assert.equal(
                minifyJs(await script('MediaForgeJS.js')),
                await script('MediaForgeJS.min.js'),
            );
        });
    });

    describe('entries', () => {
        test('dist/esm and dist/chunks are modules free of side effects', async () => {
            assert(Array.isArray(manifest.sideEffects));
            assert(
                manifest.sideEffects.every(
                    path => !path.startsWith('./dist/esm/') && !path.startsWith('./dist/chunks/'),
                ),
            );
            for (const dir of ['esm', 'chunks'])
                assert.deepEqual(
                    JSON.parse(await readFile(distUrl(`${dir}/package.json`), 'utf8')),
                    {
                        type: 'module',
                        sideEffects: false,
                    },
                );
        });

        test('every public subpath resolves to built files, plugin scripts too', async () => {
            const root = new URL('../../', import.meta.url);
            for (const [subpath, target] of Object.entries(manifest.exports)) {
                const files =
                    typeof target === 'string'
                        ? [target]
                        : [target.types, target.import, target.default];
                for (const file of files.filter(Boolean)) {
                    if (file.includes('*')) {
                        const [prefix, suffix] = file.split('*');
                        const found = (await readdir(new URL(prefix, root))).filter(entry =>
                            entry.endsWith(suffix),
                        );
                        assert(found.length >= PLUGIN_NAMES.length, `${subpath}: ${file}`);
                        continue;
                    }
                    assert((await stat(new URL(file, root)).catch(() => null))?.isFile(), file);
                }
            }
        });

        test('the lite entry and isMediaForgeError reach no plugin code at all', () => {
            for (const name of ['lite', 'isMediaForgeError']) lacks(name, PLUGIN_CODE);
            assert.deepEqual(graphs.isMediaForgeError, ['core/errors/errors.js']);
        });

        test("the lite script's codecs leave the plugins' decoders out", () => {
            lacks('codecsCore', [
                ...PLUGIN_CODE.slice(0, 4),
                code('codecs/ac3/'),
                modules(
                    'codecs/mpeg-audio/mp3-decoder',
                    'codecs/mpeg-audio/layer12-decoder',
                    'codecs/flac/decoder',
                    'codecs/alac/decoder',
                ),
            ]);
        });

        test('the audio encoders of the codecs entries load with their first call', () => {
            const encoders = modules(
                'codecs/mpeg-audio/mp3-encoder',
                'codecs/mpeg-audio/mp2-encoder',
                'codecs/flac/encoder',
                'codecs/aac/encoder',
            );
            loadsLazily('codecs', [encoders]);
            loadsLazily('codecsCore', [encoders]);
        });

        test('the default and plugins entries import every plugin dynamically', () => {
            loadsLazily('default', PLUGIN_CODE.slice(0, -1));
            loadsLazily('plugins', PLUGIN_CODE.slice(0, -1));
        });

        test('the entries load readers, encoders and conversion on demand', () => {
            for (const name of ['lite', 'default'])
                loadsLazily(name, [
                    modules(
                        'formats/mp4/reader',
                        'formats/matroska/reader',
                        'formats/mpeg-ts/reader',
                        'formats/audio-files/mpeg-audio-reader',
                        'formats/audio-files/reader',
                        'formats/ogg/reader',
                        'formats/ogg/audio-index',
                        'formats/audio-files/caf-reader',
                        'formats/audio-files/pcm-reader',
                    ),
                    modules(
                        'core/codec-config/image-info',
                        'codecs/image/encoders',
                        'pipeline/frames/image-converter',
                    ),
                    modules(
                        'codecs/aac/encoder',
                        'codecs/flac/encoder',
                        'codecs/mpeg-audio/mp3-encoder',
                    ),
                    modules('pipeline/package/hls', 'pipeline/package/dash'),
                    modules('pipeline/transcode/timeline', 'editing/render'),
                    under('recording/', 'runtime/', 'editing/'),
                    modules(
                        'pipeline/engine',
                        'pipeline/frames/image-inspect',
                        'pipeline/plan/conversion',
                        'pipeline/transcode/conversion-runner',
                    ),
                    modules(
                        'api/capabilities',
                        'api/encode',
                        'api/operations',
                        'api/hints',
                        'api/options/requests',
                        'api/target',
                    ),
                ]);
        });

        test('opening an input loads the readers and nothing it does not run', async () => {
            const opening = await closure('pipeline/engine.js');
            for (const pattern of names([
                modules(
                    'pipeline/transcode/conversion-runner',
                    'pipeline/plan/conversion-plan',
                    'pipeline/transcode/audio-file-writer',
                    'pipeline/transcode/audio-plan',
                    'pipeline/frames/frames',
                    'pipeline/execution',
                ),
                // The engine's choice of core video codecs is in the readers' code.
                except(
                    under('pipeline/codecs/', 'pipeline/package/', 'pipeline/transcode/'),
                    'pipeline/codecs/core-codecs',
                ),
                under(
                    'codecs/aac/',
                    'codecs/mpeg-audio/',
                    'codecs/flac/',
                    'codecs/alac/',
                    'codecs/opus/',
                    'codecs/vorbis/',
                    'codecs/ac3/',
                    'codecs/pcm/',
                    'stages/',
                    'codecs/webcodecs/',
                ),
                modules(
                    'codecs/shared/lazy-audio-encoder',
                    'codecs/shared/pow43',
                    'codecs/shared/real-fft',
                ),
                modules(
                    'pipeline/copy/packet-copy',
                    'pipeline/copy/media-file-writer',
                    'pipeline/copy/remux-plan',
                    'pipeline/copy/copied-track',
                    'pipeline/copy/trim-plan',
                    'pipeline/copy/cmaf-timing',
                    'pipeline/read/sync-audio-config',
                ),
                modules('pipeline/read/video-config', 'pipeline/read/stream-schedule'),
                modules('core/io/sinks/sinks', 'core/io/sinks/validation-sink'),
                modules(
                    'core/codec-config/audio/dts-header',
                    'core/codec-config/audio/dolby-audio-header',
                    'core/codec-config/audio/truehd-header',
                    'core/codec-config/audio/flac-frame',
                ),
                modules(
                    'formats/shared/capabilities',
                    'formats/detect',
                    'formats/stream-format',
                    'formats/metadata/id3',
                ),
                modules('codecs/shared/raw-video'),
            ]))
                assert.deepEqual(
                    opening.filter(file => pattern.test(file)),
                    [],
                    String(pattern),
                );
        });

        test('the AC-3 decoder loads with the first AC-3 decode only', async () => {
            for (const root of [
                'pipeline/codecs/audio-track-decoder.js',
                'pipeline/engine.js',
                'pipeline/copy/media-file-writer.js',
            ])
                assert.deepEqual(
                    (await closure(root, ANY)).filter(file => file.startsWith('codecs/ac3/')),
                    [],
                    root,
                );
        });

        test('every plugin loads its implementation on first use', async () => {
            const { allPlugins } = await import('mediaforgejs/plugins');
            assert.deepEqual(
                allPlugins.map(plugin => plugin.name),
                PLUGIN_NAMES,
            );
            const core = new Set(graphs.lite);
            const reachable = (await closure('plugins/index.js', ANY)).filter(
                file => !core.has(file),
            );
            const startup = (await closure('plugins/index.js')).filter(file => !core.has(file));
            for (const [name, implementation] of Object.entries(PLUGIN_IMPLEMENTATIONS)) {
                names([implementation]);
                assert.deepEqual(
                    startup.filter(file => implementation.test(file)),
                    [],
                    name,
                );
                assert(
                    reachable.some(file => implementation.test(file)),
                    name,
                );
            }
        });
    });

    describe('chunks', () => {
        test('the startup chunks of an entry hold its static closure only', async () => {
            for (const name of ['lite', 'default']) {
                const startup = await chunkClosure([...new Set(initial[name].map(chunkOf))]);
                assert.deepEqual(
                    modulesOf(startup).filter(file => !initial[name].includes(file)),
                    [],
                    `${name}: ${startup.join(', ')}`,
                );
            }
        });

        test('open options, plugin composition and window tracks share the engine chunk', () => {
            assert.equal(chunkOf('pipeline/plan/operation-loads.js'), chunkOf('api/operations.js'));
            for (const module of [
                'api/options/open-options.js',
                'pipeline/plugins/plugin.js',
                'pipeline/read/window-tracks.js',
            ])
                assert.equal(chunkOf(module), chunkOf('pipeline/engine.js'), module);
        });

        test('opening an MP4 loads engine, reader and AAC syntax in few chunks', async () => {
            const chunks = await chunkClosure(
                ['pipeline/engine', 'formats/mp4/reader', 'core/codec-config/audio/aac-syntax'].map(
                    chunkOf,
                ),
            );
            const loaded = modulesOf(chunks).filter(file => !initial.default.includes(file));
            for (const pattern of names([
                modules(
                    'pipeline/transcode/conversion-runner',
                    'pipeline/plan/conversion-plan',
                    'pipeline/transcode/audio-file-writer',
                    'pipeline/transcode/audio-plan',
                    'pipeline/frames/frames',
                    'pipeline/execution',
                ),
                except(
                    under('pipeline/codecs/', 'pipeline/package/', 'pipeline/transcode/'),
                    'pipeline/codecs/core-codecs',
                ),
                modules('formats/mp4/iso-boxes'),
                modules('codecs/aac/decoder', 'codecs/aac/transform', 'codecs/shared/pow43'),
                // The parts of the MP4 reader for fragments, other codecs, damage and rare layouts.
                modules(
                    'formats/mp4/read/fragments',
                    'formats/mp4/read/sample-entries',
                    'formats/mp4/read/sample-tables',
                    'formats/mp4/read/chunk-audio',
                    'formats/mp4/read/movie-repair',
                    'formats/mp4/read/track-fixes',
                ),
                modules(
                    'core/codec-config/video/av1-config',
                    'core/codec-config/video/vp9-config',
                    'core/codec-config/video/mpeg-video',
                    'core/codec-config/audio/mpeg-audio-header',
                    'core/io/inflate',
                    'core/codec-config/video/dolby-vision',
                ),
            ]))
                assert.deepEqual(
                    loaded.filter(file => pattern.test(file)),
                    [],
                    String(pattern),
                );
            const onDemand = chunks.filter(
                chunk => !initial.default.some(file => chunkOf(file) === chunk),
            );
            assert(onDemand.length <= 6, onDemand.join(', '));
        });

        test('opening a Matroska input loads the parts of its reader on demand', async () => {
            const loaded = modulesOf(
                await chunkClosure(['pipeline/engine', 'formats/matroska/reader'].map(chunkOf)),
            ).filter(file => !initial.default.includes(file));
            const parts = modules(
                'formats/matroska/read/metadata',
                'formats/matroska/read/compression',
                'formats/matroska/read/codec-parts',
                'formats/matroska/read/recovery',
                'formats/matroska/tags',
                'formats/matroska/track-titles',
                'formats/matroska/media-tags',
                'core/codec-config/windows-media',
                'formats/matroska/read/lzo',
            );
            assert.deepEqual(loaded.filter(matches(parts)), []);
        });

        test('opening an audio file loads the other audio readers on demand', async () => {
            const opens = {};
            for (const reader of [
                'formats/audio-files/reader',
                'formats/audio-files/described-files',
            ]) {
                const chunks = await chunkClosure(['pipeline/engine', reader].map(chunkOf));
                opens[reader] = {
                    modules: modulesOf(chunks),
                    chunks: chunks.filter(
                        chunk => !initial.default.some(file => chunkOf(file) === chunk),
                    ),
                };
                const others = modules(
                    'formats/audio-files/mpeg-audio-reader',
                    'formats/audio-files/sync-reader',
                );
                assert.deepEqual(opens[reader].modules.filter(matches(others)), [], reader);
            }
            const wav = opens['formats/audio-files/reader'];
            const described = opens['formats/audio-files/described-files'];
            const flacOggCaf = modules(
                'formats/audio-files/flac-reader',
                'formats/audio-files/ogg-reader',
                'formats/audio-files/caf-reader',
                'formats/ogg/reader',
                'formats/ogg/audio-index',
                'core/codec-config/audio/flac-frame',
            );
            assert.deepEqual(wav.modules.filter(matches(flacOggCaf)), []);
            assert(wav.chunks.length <= 6, wav.chunks.join(', '));
            assert(described.chunks.length <= wav.chunks.length + 2, described.chunks.join(', '));
        });

        test('copying an MP4 into MP4 loads no Matroska or audio reader code', async () => {
            const chunks = await chunkClosure(
                [
                    'pipeline/engine',
                    'formats/mp4/reader',
                    'core/codec-config/audio/aac-syntax',
                    'api/operations',
                    'pipeline/copy/packet-copy',
                    'formats/mp4/writer',
                ].map(chunkOf),
            );
            const others = modules(
                'core/codec-config/audio/pcm-format',
                'core/codec-config/audio/vorbis-headers',
                'formats/ogg/crc',
                'core/codec-config/audio/wave-format',
                'formats/matroska/pcm',
            );
            assert.deepEqual(modulesOf(chunks).filter(matches(others)), []);
        });

        test('writing a file loads no reader', async () => {
            const writers = Object.keys(layout.modules).filter(name =>
                /^formats\/[^/]+\/(?:writer|copy)$/.test(name),
            );
            assert(writers.length >= 8, writers.join(', '));
            for (const writer of writers) {
                const loaded = await chunkClosure([chunkOf(writer)]);
                assert.deepEqual(
                    ['mp4', 'mkv', 'ts', 'audio', 'mpeg-audio', 'sync-audio'].filter(family =>
                        loaded.includes(family),
                    ),
                    [],
                    writer,
                );
            }
        });

        test('the parts entry loads conversion and its parts on demand', async () => {
            const parts = await closure('api/entries/parts.js');
            for (const pattern of names([
                modules(
                    'pipeline/engine',
                    'pipeline/engine-work',
                    'pipeline/transcode/conversion-runner',
                    'pipeline/plan/conversion-plan',
                    'pipeline/codecs/part-codecs',
                ),
                modules(
                    'pipeline/transcode/timeline',
                    'pipeline/transcode/audio-lane',
                    'pipeline/transcode/video-lane',
                    'pipeline/codecs/video-codecs',
                ),
            ]))
                assert.deepEqual(
                    parts.filter(file => pattern.test(file)),
                    [],
                    String(pattern),
                );
            const chunks = await chunkClosure([...new Set(parts.map(chunkOf))]);
            for (const chunk of ['work', 'ops', 'copy']) assert(!chunks.includes(chunk), chunk);
        });

        test('the Node runtime entry loads reader helpers, not readers', async () => {
            const chunks = await chunkClosure([
                ...new Set((await closure('api/entries/runtime-node.js')).map(chunkOf)),
            ]);
            assert(!chunks.includes('read'), chunks.join(', '));
        });

        test('a door names the chunks its chunk imports, to request them at once', async () => {
            const started = new Set();
            for (const name of ['lite', 'default'])
                for (const chunk of await chunkClosure([...new Set(initial[name].map(chunkOf))]))
                    started.add(chunk);
            for (const [door, chunk] of Object.entries(layout.doors)) {
                const named = [
                    ...(await read(resolve(chunkDir, `${door}.js`))).matchAll(
                        /from '\.\/([^']+)\.js'/g,
                    ),
                ].map(match => match[1]);
                for (const imported of await chunkClosure([chunk]))
                    if (!started.has(imported))
                        assert(named.includes(imported), `${door} names ${imported}`);
            }
        });

        test('the H.264 decoder starts its frame worker from the worker chunk', async () => {
            const workerChunk = layout.modules['codecs/h264/frame-worker'].chunk;
            const urlChunk = layout.modules['codecs/h264/frame-worker-url'].chunk;
            const urls = (await read(resolve(chunkDir, `${urlChunk}.js`))).match(
                /'\.\/[^']*worker[^']*\.js'/g,
            );
            assert.deepEqual(urls, [`'./${workerChunk}.js'`, `'./${workerChunk}.js'`]);
            assert((await stat(resolve(chunkDir, `${workerChunk}.js`))).isFile());
        });
    });

    describe('sizes', () => {
        test('each entry stays within its budget, initially and on demand', async t => {
            for (const [name, [load, onDemand]] of Object.entries(BUDGETS.entries)) {
                const initialBytes = await size(initial[name]);
                const lazyBytes = await size(
                    graphs[name].filter(file => !initial[name].includes(file)),
                );
                t.diagnostic(`${name}: ${initialBytes} B initially, ${lazyBytes} B on demand`);
                assert(
                    initialBytes <= load,
                    `${name} loads ${initialBytes} B initially (budget ${load})`,
                );
                assert(
                    lazyBytes <= onDemand,
                    `${name} loads ${lazyBytes} B on demand (budget ${onDemand})`,
                );
            }
        });

        test('the readers and an MP4 open stay within their budgets', async t => {
            const readers = await size(await closure('pipeline/engine.js'));
            const mp4Reader = await size(['formats/mp4/reader.js']);
            const matroskaReader = await size(['formats/matroska/reader.js']);
            const chunks = await chunkClosure(
                ['pipeline/engine', 'formats/mp4/reader', 'core/codec-config/audio/aac-syntax'].map(
                    chunkOf,
                ),
            );
            const openMp4 = await size(
                modulesOf(chunks).filter(file => !initial.default.includes(file)),
            );
            const dolbyLayout = await size(['core/codec-config/audio/dolby-layout.js']);
            for (const [name, bytes] of Object.entries({
                readers,
                mp4Reader,
                matroskaReader,
                openMp4,
                dolbyLayout,
            })) {
                t.diagnostic(`${name}: ${bytes} B`);
                assert(bytes <= BUDGETS[name], `${name} is ${bytes} B (budget ${BUDGETS[name]})`);
            }
        });

        test('the WebAssembly kernels ship deflated within budget and inflate', async () => {
            const { inflateBase64 } = await import(distUrl('esm/core/bytes/inflate-raw.js'));
            const { H264_KERNELS_BASE64: text } = await import(
                distUrl('esm/codecs/h264/kernels-binary.js')
            );
            assert(
                text.length <= BUDGETS.h264Kernels,
                `${text.length} B (budget ${BUDGETS.h264Kernels})`,
            );
            assert(WebAssembly.validate(inflateBase64(text)));
        });

        test('the inflater reads every kind of DEFLATE block and rejects cut data', async () => {
            const { inflateRaw } = await import(distUrl('esm/core/bytes/inflate-raw.js'));
            let seed = 7;
            const random = count => {
                seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
                return (seed >>> 8) % count;
            };
            for (const input of [
                new Uint8Array(0),
                Uint8Array.from({ length: 70000 }, () => 65 + random(4)),
                Uint8Array.from({ length: 5000 }, () => random(256)),
            ])
                for (const options of [
                    { level: 0 },
                    { level: 9 },
                    { strategy: constants.Z_FIXED },
                    { strategy: constants.Z_HUFFMAN_ONLY },
                ])
                    assert.deepEqual(inflateRaw(deflateRawSync(input, options)), input);
            assert.throws(
                () => inflateRaw(deflateRawSync(new Uint8Array(4000)).subarray(0, 4)),
                /DEFLATE data is cut/,
            );
        });
    });

    describe('loading order', () => {
        test('a File named and typed as MP4 loads the MP4 reader before its bytes are read', () => {
            const result = inFreshProcess(`
                const { inspect } = await import(entry);
                const { originalFixtures } = await import(fixtures);
                const bytes = originalFixtures['classic-aac.mp4']();
                const file = new HeldFile([bytes], 'clip.mp4', { type: 'video/mp4' });
                const inspecting = inspect(file);
                for (let waited = 0; !named().has('mp4.js') && waited < 3000; waited += 10)
                    await new Promise(resolve => setTimeout(resolve, 10));
                const early = named().has('mp4.js');
                release();
                const { format } = await inspecting;
                process.stdout.write(JSON.stringify({ early, format }));
            `);
            assert.deepEqual(result, { early: true, format: 'mp4' });
        });

        /** What the default entry loads ahead: on an idle page, a first call, Node, saveData. */
        const loadedAhead = mode =>
            inFreshProcess(
                `
                const mode = args[0];
                let idle;
                if (mode !== 'node') {
                    globalThis.document = {};
                    globalThis.requestIdleCallback = run => (idle = run);
                }
                if (mode === 'save')
                    Object.defineProperty(globalThis, 'navigator', {
                        value: { connection: { saveData: true, effectiveType: '4g' } },
                        configurable: true,
                    });
                const { inspect } = await import(entry);
                const { originalFixtures } = await import(fixtures);
                if (mode === 'first') {
                    const bytes = originalFixtures['classic-aac.mp4']();
                    await inspect(new File([bytes], 'clip.mp4', { type: 'video/mp4' }));
                }
                idle?.();
                const wanted = ['read.js', 'mp4.js', 'mpeg-audio.js', 'mkv.js',
                    'formats-matroska-read-metadata.js', 'ops.js'];
                const limit = mode === 'idle' ? 5000 : 300;
                for (let waited = 0; waited < limit; waited += 10) {
                    const common = wanted.slice(0, 5);
                    if (mode === 'idle' && common.every(name => named().has(name))) break;
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                process.stdout.write(JSON.stringify(wanted.filter(name => named().has(name))));
            `,
                mode,
            );

        test('an idle browser page loads the engine and the common readers ahead', () => {
            assert.deepEqual(loadedAhead('idle'), [
                'read.js',
                'mp4.js',
                'mpeg-audio.js',
                'mkv.js',
                'formats-matroska-read-metadata.js',
            ]);
        });

        test('an inspect() that starts first loads only what it runs', () => {
            assert.deepEqual(loadedAhead('first'), ['read.js', 'mp4.js']);
        });

        test('nothing loads ahead outside a browser or on a page that saves data', () => {
            assert.deepEqual(loadedAhead('node'), []);
            assert.deepEqual(loadedAhead('save'), []);
        });

        /** Which of `wanted` a first `op` loads while its input opens, and all it loads. */
        const firstCall = (op, wanted) =>
            inFreshProcess(
                `
                const [op, ...wanted] = args;
                let idle;
                globalThis.document = {};
                globalThis.requestIdleCallback = run => (idle = run);
                const forge = await import(entry);
                const { originalFixtures } = await import(fixtures);
                const file = new HeldFile([originalFixtures['classic-aac.mp4']()], 'clip.mp4', {
                    type: 'video/mp4',
                });
                const running =
                    op === 'copy'
                        ? forge.convert(file, 'mkv')
                        : op === 'thumbnail'
                          ? forge.thumbnail(file, { to: 'png' })
                          : forge.open(file).then(async media => {
                                for await (const packet of media.packets()) break;
                                media.close();
                            });
                for (let waited = 0; waited < 3000; waited += 10) {
                    if (wanted.every(name => named().has(name))) break;
                    await new Promise(resolve => setTimeout(resolve, 10));
                    if (waited === 0) idle?.();
                }
                const early = wanted.filter(name => named().has(name));
                release();
                await running.catch(() => undefined);
                process.stdout.write(JSON.stringify({ early, loaded: [...named()] }));
            `,
                op,
                ...wanted,
            );
        const chunkFile = module => `${chunkOf(module)}.js`;

        test('a copy into Matroska loads the copy and the writer while its input opens', () => {
            const copying = [
                'pipeline/copy/packet-copy',
                'pipeline/copy/copied-track',
                'formats/matroska/writer',
            ].map(chunkFile);
            assert.deepEqual(firstCall('copy', copying).early, copying);
        });

        test('a PNG thumbnail loads decoding and PNG while its input opens', () => {
            const picturing = ['pipeline/frames/frames', 'codecs/image/encoders'].map(chunkFile);
            const thumbnail = firstCall('thumbnail', picturing);
            assert.deepEqual(thumbnail.early, picturing);
            for (const chunk of [
                'mkv.js',
                'mpeg-audio.js',
                ...['api/operations', 'pipeline/copy/packet-copy', 'pipeline/engine-work'].map(
                    chunkFile,
                ),
            ])
                assert(!thumbnail.loaded.includes(chunk), chunk);
        });

        test("open() loads a Media's reads while its input opens, no operation", () => {
            const reads = [chunkFile('api/media-reads')];
            const reading = firstCall('packets', reads);
            assert.deepEqual(reading.early, reads);
            assert(!reading.loaded.includes(chunkFile('api/operations')));
        });
    });
});
