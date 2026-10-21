import { MediaForgeError } from '../../core/errors/errors';
import type { MediaWriters } from '../../formats/shared/contract';
import { codecFamily, mp4aAudioObjectType } from '../../core/model/codec-strings';
import type { CodecMatch, PluginManifest } from '../../core/contracts/plugin';

/**
 * The plugins a composition knows, in use or not, by their manifests; the API passes the
 * library's.
 */
export type PluginCatalog = readonly PluginManifest[];

/** Whether a decoder or encoder manifest part takes `codec`, as composePlugins tests it. */
function takes(codecs: CodecMatch, codec: string): boolean {
    if (typeof codecs === 'function') {
        try {
            return codecs(codec) === true;
        } catch {
            return false;
        }
    }
    return codecs.includes(codecFamily(codec)) || codecs.includes(codec);
}

/** Audio codecs no part of the library decodes (nor any host), by codec string, with names. */
const UNDECODED_AUDIO: Readonly<Record<string, string>> = {
    MAC3: 'MACE 3:1',
    MAC6: 'MACE 6:1',
    iamf: 'IAMF',
};

/** AAC object types the aac plugin decodes: Main and LC, with SBR and PS (HE-AAC v1 and v2). */
const PLUGIN_AAC_OBJECT_TYPES = [1, 2, 5, 29];

/** Chroma formats by chroma_format_idc, for messages. */
const CHROMA_FORMATS = ['monochrome', '4:2:0', '4:2:2', '4:4:4'];

/**
 * The errors for a part that is not in use: PLUGIN, naming the plugin of the catalog that adds it,
 * or the code of an unsupported request when no plugin does. The engine raises every such error
 * through one instance.
 */
export class MissingParts {
    constructor(private readonly catalog: PluginCatalog = []) {}

    private find(test: (manifest: PluginManifest) => boolean): string | undefined {
        return this.catalog.find(test)?.name;
    }

    /**
     * The PLUGIN error for plugin `name`: `message` says what needs it, the hint how to include it
     * and, when the host could do the job instead, `alternative` says how.
     */
    plugin(name: string, message: string, alternative?: string): MediaForgeError {
        return new MediaForgeError(message, 'PLUGIN', {
            plugin: name,
            hint: alternative
                ? `Include the '${name}' plugin, or ${alternative}.`
                : `Include the '${name}' plugin from 'mediaforgejs/plugins'.`,
        });
    }

    /** The plugin with a software decoder for the video codec string. */
    videoDecoderPlugin(codec: string): string | undefined {
        return this.find(manifest =>
            (manifest.decoders ?? []).some(
                part => part.kind === 'video' && !part.replacesHost && takes(part.codecs, codec),
            ),
        );
    }

    /**
     * A container without a reader (or, with `write`, a writer): PLUGIN when a plugin adds it, else
     * FORMAT.
     */
    format(format: string, message: string, write = false): MediaForgeError {
        const plugin = this.find(manifest =>
            ((write ? manifest.writers : manifest.readers) ?? []).some(part =>
                part.formats.includes(format),
            ),
        );
        return plugin ? this.plugin(plugin, message) : new MediaForgeError(message, 'FORMAT');
    }

    /**
     * An audio encoder that is not in use, named by its codec or codec string: PLUGIN when a plugin
     * adds it, else `code`.
     */
    audioEncoder(
        codec: string,
        message: string,
        code: 'FORMAT' | 'ENCODE' = 'FORMAT',
    ): MediaForgeError {
        const name = mp4aAudioObjectType(codec) === 2 ? 'aac' : codec;
        const plugin = this.find(manifest =>
            (manifest.encoders ?? []).some(
                part => part.kind === 'audio' && part.codecs.some(encoded => encoded === name),
            ),
        );
        return plugin ? this.plugin(plugin, message) : new MediaForgeError(message, code);
    }

    /**
     * A processing stage no plugin in use offers: PLUGIN when a plugin of the catalog offers it,
     * else INPUT.
     */
    stage(name: string, message: string, alternative?: string): MediaForgeError {
        const plugin = this.find(manifest =>
            (manifest.stages ?? []).some(stage => stage.name === name),
        );
        return plugin
            ? this.plugin(plugin, message, alternative)
            : new MediaForgeError(message, 'INPUT');
    }

    /**
     * A video codec neither the host nor a plugin in use decodes. H.264 whose decoder configuration
     * shows more than 8 bits or 4:4:4 (`format`, from h264ConfigFormat()), which the h264 plugin
     * does not decode, is unsupported (DECODE) instead.
     */
    videoDecoder(
        codec: string,
        message: string,
        format: { bitDepth: number; chromaFormat: number } | null = null,
    ): MediaForgeError {
        if (format && (format.bitDepth > 8 || format.chromaFormat === 3))
            return new MediaForgeError(
                `${format.bitDepth}-bit ${CHROMA_FORMATS[format.chromaFormat]} H.264 cannot be ` +
                    `decoded here`,
                'DECODE',
                {
                    hint: 'Use a browser that decodes H.264 High 10 or High 4:4:4.',
                },
            );
        const plugin = this.videoDecoderPlugin(codec);
        return plugin
            ? this.plugin(plugin, message, `use a browser whose VideoDecoder supports ${codec}`)
            : new MediaForgeError(message, 'DECODE');
    }

    /**
     * A streaming protocol no plugin in use plays: PLUGIN naming the plugin of the catalog that
     * plays it, else the player of the package mediaforgejs-player.
     */
    player(protocol: string, message: string): MediaForgeError {
        const plugin = this.find(manifest =>
            (manifest.players ?? []).some(part => part.protocols.some(name => name === protocol)),
        );
        if (plugin) return this.plugin(plugin, message);
        return new MediaForgeError(message, 'PLUGIN', {
            plugin: 'player',
            hint: "Add the player of 'mediaforgejs-player': plugins: { add: [player] }.",
        });
    }

    /**
     * An audio codec neither the host nor a plugin in use decodes; one no part of the library
     * decodes (MACE) says so, and AAC no plugin decodes (xHE-AAC, low delay) names the host.
     */
    audioDecoder(codec: string, message: string): MediaForgeError {
        const unsupported = UNDECODED_AUDIO[codec.split('.')[0]!];
        if (unsupported)
            return new MediaForgeError(`${unsupported} audio cannot be decoded`, 'DECODE', {
                hint: 'Convert its audio with another tool first.',
            });
        const alternative = `use a browser whose AudioDecoder supports ${codec}`;
        const objectType = mp4aAudioObjectType(codec);
        if (objectType !== null && !PLUGIN_AAC_OBJECT_TYPES.includes(objectType))
            return new MediaForgeError(message, 'DECODE', {
                hint: `Use a browser whose AudioDecoder supports ${codec}.`,
            });
        const family = codecFamily(codec);
        const plugin = this.find(manifest =>
            (manifest.decoders ?? []).some(
                part => part.kind === 'audio' && part.codecs.includes(family),
            ),
        );
        return plugin
            ? this.plugin(plugin, message, alternative)
            : new MediaForgeError(message, 'DECODE');
    }
}

/**
 * A composition that knows no plugins: missing parts fail with the codes of unsupported requests.
 */
export const NO_PLUGINS = new MissingParts();

/** The writers of a composition, with the errors for the formats it has no writer for. */
export interface FormatWriters extends MediaWriters {
    readonly missing: MissingParts;
}

/**
 * Loads the writer of `format`; a format without one fails with PLUGIN when a plugin adds it, else
 * FORMAT.
 */
export function loadFormatWriter(writers: FormatWriters, format: string): Promise<void> {
    if (format !== 'fmp4' && !writers.container.has(format) && !writers.audio.has(format))
        throw writers.missing.format(format, `No writer for '${format}'`, true);
    return writers.load(format);
}
