import { distUrl } from './dist-paths.mjs';
import { readerPart } from './parts.mjs';

export { readerPart };

// The internal file index behind open(), for tests of the engine layer: sample tables, codec
// windows and the packet-copy writers (checkRemux, validateRemux, remux, toBlob) that
// Media.convert() builds on.
const { FormatRegistry } = await import(distUrl('esm/pipeline/read/format-registry.js'));
const { CORE_FORMATS } = await import(distUrl('esm/formats/core-formats.js'));
const { composePlugins } = await import(distUrl('esm/pipeline/plugins/plugin.js'));
const { allPlugins } = await import(distUrl('esm/plugins/index.js'));
export const { mediaFileState } = await import(distUrl('esm/pipeline/read/file-state.js'));
const { providePacketCopy } = await import(distUrl('esm/pipeline/read/media-file.js'));
// The engine provides the copy side to the files it reads; so does this helper.
providePacketCopy(() => import(distUrl('esm/pipeline/copy/packet-copy.js')));
const { MissingParts } = await import(distUrl('esm/pipeline/plugins/missing-parts.js'));
const { PLUGIN_CATALOG } = await import(distUrl('esm/plugins/catalog.js'));
const { resolveOpenOptions } = await import(distUrl('esm/api/options/open-options.js'));
/** Missing parts name the library's plugins, as in the composition of the default entry. */
const missing = new MissingParts(PLUGIN_CATALOG);

const plugins = composePlugins(allPlugins);
/** The readers and writers of the default entry: the plugins' ahead of the core's. */
const formats = {
    readers: [...plugins.readers, ...CORE_FORMATS.readers],
    writers: [...plugins.writers, ...CORE_FORMATS.writers],
    segments: CORE_FORMATS.segments,
};
const engine = new FormatRegistry(formats, missing);

/**
 * The core's readers and writers with the ids `ids` ('mp4', 'matroska', 'ts', ...), with the
 * fragmented MP4 writer unless `segments` is false.
 */
export function coreParts(ids, { segments = true } = {}) {
    return {
        readers: CORE_FORMATS.readers.filter(part => ids.includes(part.id)),
        writers: CORE_FORMATS.writers.filter(part => ids.includes(part.id)),
        ...(segments ? { segments: CORE_FORMATS.segments } : {}),
    };
}

/** Loads every writer of `target`, so the synchronous checkRemux() sees all of them. */
async function loadWriters(target) {
    const { writers } = target;
    await Promise.all(
        [...writers.container.keys(), ...writers.audio.keys(), 'fmp4'].map(format =>
            writers.load(format),
        ),
    );
}
await loadWriters(engine);

/**
 * Opens an input as the engine's MediaFile, with every format of the default entry and all writers
 * loaded. The open options are read as open() reads them, repairs reported with the file's
 * warnings.
 */
export function openFile(input, options) {
    return openIn(engine, input, options);
}

/** Opens `input` with the engine `target`, its open options read as open() reads them. */
export async function openIn(target, input, options) {
    const { snapshot, findings } = resolveOpenOptions(options);
    return target.open(input, snapshot, findings);
}

/**
 * An engine of exactly the reader and writer parts of `parts` (the first reader of a format wins),
 * its writers loaded.
 */
export async function engineOf(parts) {
    const custom = new FormatRegistry({ readers: [], writers: [], ...parts }, missing);
    await loadWriters(custom);
    return custom;
}

/** An engine with `readers` (a test's readers, see readerPart) ahead of the default formats. */
export function engineWith(readers) {
    return engineOf({ ...formats, readers: [...readers.map(readerPart), ...formats.readers] });
}

/** Opens `input` with `readers` ahead of the default formats. */
export async function openWith(readers, input, options) {
    return openIn(await engineWith(readers), input, options);
}
