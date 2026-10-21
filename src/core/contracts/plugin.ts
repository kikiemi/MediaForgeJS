import type { TrackInfo } from '../model/track';
import type {
    BuiltinAudioCodec,
    BuiltinVideoDecoder,
    BuiltinVideoDecoderConfig,
    VideoCodecDecoder,
    VideoDecoderConfig,
} from './decoder';
import type { VideoCodecEncoder, VideoEncoderConfig } from './encoder';
import type { ReaderPart } from './reader';
import type { WriterPart } from './writer';
import type { StageDefinition } from './stage';
import type { PlayerPart } from './player';
import { MediaForgeError } from '../errors/errors';
import { lazy } from './lazy';

/**
 * The plugin contract: one shape for every optional part of the library and of an application. A
 * plugin names itself and lists its parts by role; each part says what it handles (codecs or
 * formats) and loads its implementation with `load()` on first use, so a plugin costs its
 * description until a file needs it.
 */

/**
 * The codec strings a decoder or encoder takes: codec families as track codecs name them ('mp3',
 * 'flac', 'mp4a'), or a test of the whole codec string.
 */
export type CodecMatch = readonly string[] | ((codec: string) => boolean);

/** The decoder of one track, as a software audio decoder part loads it. */
export type AudioDecoderFactory = (
    track: TrackInfo,
) => BuiltinAudioCodec | Promise<BuiltinAudioCodec>;

/** A software audio decoder, used where the host AudioDecoder is missing or refuses a track. */
export interface AudioDecoderPart {
    readonly kind: 'audio';
    readonly id: string;
    /** Codec families, as track codecs name them: 'mp3', 'flac', 'mp4a'. */
    readonly codecs: readonly string[];
    /** Loads the decoder; it builds the decoder of one track and may reject its configuration. */
    readonly load: () => Promise<AudioDecoderFactory>;
}

/** The decoder of one video track, as a software video decoder part loads it. */
export type VideoDecoderFactory = (
    config: BuiltinVideoDecoderConfig,
) => BuiltinVideoDecoder | Promise<BuiltinVideoDecoder>;

/**
 * A software video decoder that fills a gap of the host VideoDecoder: packets in decode order,
 * 8-bit planar pictures out in presentation order.
 */
export interface VideoDecoderPart {
    readonly kind: 'video';
    readonly id: string;
    readonly codecs: CodecMatch;
    readonly replacesHost?: false;
    readonly load: () => Promise<VideoDecoderFactory>;
}

/** The decoder of one video track, as an application video decoder part loads it. */
export type ApplicationVideoDecoderFactory = (
    config: VideoDecoderConfig,
) => VideoCodecDecoder | Promise<VideoCodecDecoder>;

/**
 * An application video decoder, such as ProRes: it decodes its codecs in place of the host, one
 * frame per packet.
 */
export interface ApplicationVideoDecoderPart {
    readonly kind: 'video';
    readonly id: string;
    readonly codecs: CodecMatch;
    readonly replacesHost: true;
    readonly load: () => Promise<ApplicationVideoDecoderFactory>;
}

export type DecoderPart = AudioDecoderPart | VideoDecoderPart | ApplicationVideoDecoderPart;

/** The codecs of the library's own audio encoders. */
export type LibraryAudioEncoderCodec = 'aac' | 'flac' | 'mp2' | 'mp3';

/**
 * One of the library's own audio encoders (AAC-LC, FLAC, MP2, MP3), used where the host
 * AudioEncoder is missing or refuses the stream. Its implementation follows that encoder's
 * interface in the library, so only the library's plugins supply audio encoders.
 */
export interface AudioEncoderPart {
    readonly kind: 'audio';
    readonly id: string;
    readonly codecs: readonly LibraryAudioEncoderCodec[];
    readonly load: () => Promise<unknown>;
}

/** The encoder of one video track, as an application video encoder part loads it. */
export type VideoEncoderFactory = (
    config: VideoEncoderConfig,
) => VideoCodecEncoder | Promise<VideoCodecEncoder>;

/** An application video encoder, such as ProRes: it encodes its codecs in place of the host. */
export interface VideoEncoderPart {
    readonly kind: 'video';
    readonly id: string;
    readonly codecs: CodecMatch;
    readonly load: () => Promise<VideoEncoderFactory>;
}

export type EncoderPart = AudioEncoderPart | VideoEncoderPart;

/**
 * An optional part of the library, or of an application: containers, codecs for what the host
 * WebCodecs cannot do, processing stages. The default entry 'mediaforgejs' uses every plugin of the
 * library and 'mediaforgejs/lite' none; the `plugins` option of every function and of MediaForge
 * excludes, adds or lists them. Implementations load on first use.
 *
 * @example
 * ```ts
 * import { convert } from 'mediaforgejs';
 * import { prores } from 'mediaforgejs-prores';
 *
 * await convert(file, 'mov', { plugins: { exclude: ['h264'], add: [prores] } });
 * ```
 */
export interface MediaForgePlugin {
    /** Unique name, such as 'h264' or 'mxf'. */
    readonly name: string;
    /** What the plugin adds, as PLUGIN errors name it, such as 'AVI files'. */
    readonly description?: string;
    /** Decoders for what the host decoders cannot decode, and application video decoders. */
    readonly decoders?: readonly DecoderPart[];
    /** The library's audio encoders and application video encoders. */
    readonly encoders?: readonly EncoderPart[];
    /** Container readers; a plugin's reader of a format replaces the core's. */
    readonly readers?: readonly ReaderPart[];
    /** Container and audio file writers. */
    readonly writers?: readonly WriterPart[];
    /** Video and audio processing stages that targets name in `video.stages` and `audio.stages`. */
    readonly stages?: readonly StageDefinition[];
    /** Players of streaming protocols, which play() uses. */
    readonly players?: readonly PlayerPart[];
}

/** A part as a manifest describes it: everything but its implementation. */
type Described<Part> = Part extends unknown ? Omit<Part, 'load'> : never;

/**
 * What a plugin adds, without its implementation: enough to name the plugin in a PLUGIN error, so
 * an entry without the plugin knows what it would add.
 */
export interface PluginManifest {
    readonly name: string;
    readonly description: string;
    readonly decoders?: readonly Described<DecoderPart>[];
    readonly encoders?: readonly Described<EncoderPart>[];
    readonly readers?: readonly Described<ReaderPart>[];
    readonly writers?: readonly Described<WriterPart>[];
    readonly stages?: readonly Omit<StageDefinition, 'create'>[];
    readonly players?: readonly Described<PlayerPart>[];
}

/** The `load` of each part of a manifest, by role and part id. */
export interface PluginLoaders {
    readonly decoders?: Readonly<Record<string, DecoderPart['load']>>;
    readonly encoders?: Readonly<Record<string, EncoderPart['load']>>;
    readonly readers?: Readonly<Record<string, ReaderPart['load']>>;
    readonly writers?: Readonly<Record<string, WriterPart['load']>>;
    readonly players?: Readonly<Record<string, PlayerPart['load']>>;
}

const ROLES = ['decoders', 'encoders', 'readers', 'writers', 'players'] as const;

/**
 * The plugin a manifest describes, with the loader of each part (each fetched once, and again
 * after a failure) and the stages it offers. Every part of the manifest needs its loader.
 */
export function definePlugin(
    manifest: PluginManifest,
    loaders: PluginLoaders,
    stages: readonly StageDefinition[] = [],
): MediaForgePlugin {
    const plugin: Record<string, unknown> = {
        name: manifest.name,
        description: manifest.description,
    };
    for (const role of ROLES) {
        const described = manifest[role];
        const loads: Readonly<Record<string, () => Promise<unknown>>> = loaders[role] ?? {};
        if (!described) continue;
        plugin[role] = Object.freeze(
            described.map(part => {
                const load = loads[part.id];
                if (!load)
                    throw new MediaForgeError(
                        `Plugin '${manifest.name}': no loader for ${role} '${part.id}'`,
                        'INPUT',
                    );
                return Object.freeze({ ...part, load: lazy(load) });
            }),
        );
    }
    if (manifest.stages) plugin.stages = Object.freeze([...stages]);
    return Object.freeze(plugin) as unknown as MediaForgePlugin;
}
