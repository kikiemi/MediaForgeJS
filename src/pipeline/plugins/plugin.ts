import type {
    ApplicationVideoDecoderPart,
    AudioDecoderPart,
    AudioEncoderPart,
    CodecMatch,
    DecoderPart,
    EncoderPart,
    MediaForgePlugin,
    VideoDecoderPart,
    VideoEncoderPart,
} from '../../core/contracts/plugin';
import { MediaForgeError } from '../../core/errors/errors';
import type { BuiltinVideoCodec } from '../../core/contracts/decoder';
import type { BuiltinAudioDecoder } from '../../core/contracts/decoder';
import type { VideoCodecProvider } from '../../core/contracts/encoder';
import type { ReaderPart } from '../../core/contracts/reader';
import type { WriterPart } from '../../core/contracts/writer';
import type { StageDefinition } from '../../core/contracts/stage';
import type { PlayerPart } from '../../core/contracts/player';
import { lazy } from '../../core/contracts/lazy';
import { codecFamily } from '../../core/model/codec-strings';
import { lazyAudioEncoder } from '../../codecs/shared/lazy-audio-encoder';
import type { StreamingAudioCodecs } from '../codecs/streaming-audio-output-core';
import {
    checkPlugins,
    checkStageDefinition,
    invalidPlugin,
    partsOf,
    stagesOf,
} from './plugin-check';

/**
 * The parts of every plugin of one instance, in plugin order, in the forms the engine runs: the
 * software decoders, the library's audio encoders by codec, the application video codecs, the
 * readers, writers and stages.
 */
export interface PluginSet {
    readonly names: readonly string[];
    readonly plugins: readonly MediaForgePlugin[];
    readonly readers: readonly ReaderPart[];
    readonly writers: readonly WriterPart[];
    readonly videoDecoders: readonly BuiltinVideoCodec[];
    readonly audioDecoders: readonly BuiltinAudioDecoder[];
    readonly audioEncoders: StreamingAudioCodecs;
    readonly videoCodecs: readonly VideoCodecProvider[];
    readonly stages: readonly StageDefinition[];
    readonly players: readonly PlayerPart[];
}

/** A test of codec strings from a part's codecs; a throwing test answers false. */
function matcher(plugin: string, codecs: CodecMatch): (codec: string) => boolean {
    if (typeof codecs === 'function') {
        const known = new Map<string, boolean>();
        return codec => {
            if (!known.has(codec)) {
                let result: unknown;
                try {
                    result = codecs(codec);
                } catch {
                    result = false;
                }
                if (typeof result !== 'boolean')
                    throw invalidPlugin(plugin, 'codec tests must return a boolean');
                known.set(codec, result);
            }
            return known.get(codec)!;
        };
    }
    return codec => codecs.includes(codecFamily(codec)) || codecs.includes(codec);
}

/** A software video decoder in the form the frame decoders run. */
function softwareVideoDecoder(plugin: string, part: VideoDecoderPart): BuiltinVideoCodec {
    const load = lazy(part.load);
    const decoder: BuiltinVideoCodec = {
        id: part.id,
        supports: matcher(plugin, part.codecs),
        create: async config => (await load())(config),
    };
    return Object.freeze(decoder);
}

/** A software audio decoder in the form the track decoders run. */
function softwareAudioDecoder(part: AudioDecoderPart): BuiltinAudioDecoder {
    const load = lazy(part.load);
    const decoder: BuiltinAudioDecoder = {
        id: part.id,
        codecs: Object.freeze([...part.codecs]),
        create: async track => (await load())(track),
    };
    return Object.freeze(decoder);
}

/**
 * The application video codecs of one plugin: its decoders that replace the host and its video
 * encoders, paired by id, in the form the conversions run.
 */
function applicationCodecs(
    plugin: string,
    decoders: readonly ApplicationVideoDecoderPart[],
    encoders: readonly VideoEncoderPart[],
): VideoCodecProvider[] {
    const ids = [...new Set([...decoders, ...encoders].map(part => part.id))];
    return ids.map(id => {
        const decoder = decoders.find(part => part.id === id);
        const encoder = encoders.find(part => part.id === id);
        const loadDecoder = decoder && lazy(decoder.load);
        const loadEncoder = encoder && lazy(encoder.load);
        const missing = (role: string): never => {
            throw new MediaForgeError(`The '${id}' codec of '${plugin}' has no ${role}`, 'INPUT');
        };
        return Object.freeze({
            id,
            supportsDecode: decoder ? matcher(plugin, decoder.codecs) : () => false,
            supportsEncode: encoder ? matcher(plugin, encoder.codecs) : () => false,
            createDecoder: async config =>
                loadDecoder ? (await loadDecoder())(config) : missing('decoder'),
            createEncoder: async config =>
                loadEncoder ? (await loadEncoder())(config) : missing('encoder'),
        } satisfies VideoCodecProvider);
    });
}

/**
 * Checks plugins (see checkPlugins) and gathers their parts in the forms the engine runs. A
 * MediaForge checks its plugins when it is made and gathers them with its first operation.
 */
export function composePlugins(plugins: readonly MediaForgePlugin[]): PluginSet {
    const checked = checkPlugins(plugins);
    const readers: ReaderPart[] = [];
    const writers: WriterPart[] = [];
    const videoDecoders: BuiltinVideoCodec[] = [];
    const audioDecoders: BuiltinAudioDecoder[] = [];
    const videoCodecs: VideoCodecProvider[] = [];
    const stages: StageDefinition[] = [];
    const players: PlayerPart[] = [];
    const audioEncoders: Record<string, unknown> = {};

    for (const plugin of checked.plugins) {
        const { name } = plugin;
        readers.push(...partsOf<ReaderPart>(plugin, 'readers', plugin.readers));
        writers.push(...partsOf<WriterPart>(plugin, 'writers', plugin.writers));
        players.push(...partsOf<PlayerPart>(plugin, 'players', plugin.players));
        const replacing: ApplicationVideoDecoderPart[] = [];
        for (const part of partsOf<DecoderPart>(plugin, 'decoders', plugin.decoders)) {
            if (part.kind === 'audio') audioDecoders.push(softwareAudioDecoder(part));
            else if (part.replacesHost === true) replacing.push(part);
            else videoDecoders.push(softwareVideoDecoder(name, part));
        }
        const videoEncoders: VideoEncoderPart[] = [];
        for (const part of partsOf<EncoderPart>(plugin, 'encoders', plugin.encoders)) {
            if (part.kind === 'video') {
                videoEncoders.push(part);
                continue;
            }
            const audio = part as AudioEncoderPart;
            const load = lazy(audio.load);
            for (const codec of audio.codecs ?? []) audioEncoders[codec] = lazyAudioEncoder(load);
        }
        videoCodecs.push(...applicationCodecs(name, replacing, videoEncoders));
        stages.push(...stagesOf(plugin).map(checkStageDefinition));
    }

    return Object.freeze({
        names: checked.names,
        plugins: checked.plugins,
        readers: Object.freeze(readers),
        writers: Object.freeze(writers),
        videoDecoders: Object.freeze(videoDecoders),
        audioDecoders: Object.freeze(audioDecoders),
        audioEncoders: Object.freeze(audioEncoders) as StreamingAudioCodecs,
        videoCodecs: Object.freeze(videoCodecs),
        stages: Object.freeze(stages),
        players: Object.freeze(players),
    });
}
