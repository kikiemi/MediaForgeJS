import { MediaForgeError } from '../../core/errors/errors';
import type {
    AudioEncoderPart,
    DecoderPart,
    EncoderPart,
    MediaForgePlugin,
} from '../../core/contracts/plugin';
import type { StageDefinition } from '../../core/contracts/stage';
import type { PlayerPart } from '../../core/contracts/player';

/** Keys of the plugin shape before 1.0.0, with what replaced them. */
const REPLACED_KEYS: Readonly<Record<string, string>> = {
    formats: 'readers and writers',
    videoDecoders: "decoders of kind 'video'",
    audioDecoders: "decoders of kind 'audio'",
    audioEncoders: "encoders of kind 'audio'",
    videoCodecs: "decoders and encoders of kind 'video' with replacesHost",
};

const LIBRARY_ENCODERS = ['aac', 'flac', 'mp2', 'mp3'];

/** The plugins of an instance, checked: each once, in order, and their names. */
export interface CheckedPlugins {
    readonly names: readonly string[];
    readonly plugins: readonly MediaForgePlugin[];
}

export function invalidPlugin(plugin: string, message: string): MediaForgeError {
    return new MediaForgeError(`Plugin '${plugin}': ${message}`, 'INPUT');
}

/** The parts of one role of a plugin, checked to be an array of parts with an id and load(). */
export function partsOf<T extends { readonly id: string; readonly load: unknown }>(
    plugin: MediaForgePlugin,
    role: string,
    value: unknown,
): readonly T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw invalidPlugin(plugin.name, `${role} must be an array`);
    for (const part of value)
        if (
            !part ||
            typeof part !== 'object' ||
            typeof part.id !== 'string' ||
            !part.id ||
            typeof part.load !== 'function'
        )
            throw invalidPlugin(plugin.name, `each of its ${role} needs an id and load()`);
    return value as readonly T[];
}

/** The stage definitions of a plugin, as given. */
export function stagesOf(plugin: MediaForgePlugin): readonly StageDefinition[] {
    const value = plugin.stages;
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw invalidPlugin(plugin.name, 'stages must be an array');
    return value;
}

/** Checks a stage definition, as a plugin offers it or a target gives it. */
export function checkStageDefinition(definition: StageDefinition): StageDefinition {
    const { type, name, description, create } = definition ?? {};
    if (
        (type !== 'video' && type !== 'audio') ||
        typeof name !== 'string' ||
        !name.trim() ||
        typeof create !== 'function'
    )
        throw new MediaForgeError(
            "A stage definition needs type 'video' or 'audio', a name and create()",
            'INPUT',
        );
    return Object.freeze({
        type,
        name,
        ...(typeof description === 'string' ? { description } : {}),
        create: create.bind(definition),
    });
}

/** Rejects a part `id` of one role and kind that `seen` already holds. */
function unique(seen: Set<string>, id: string, role: string): void {
    if (seen.has(id)) throw new MediaForgeError(`Two ${role} have the id '${id}'`, 'INPUT');
    seen.add(id);
}

/** Checks what a part's `codecs` names: codec families or a test. */
function checkCodecs(plugin: string, codecs: unknown): void {
    if (
        typeof codecs !== 'function' &&
        (!Array.isArray(codecs) || codecs.some(codec => typeof codec !== 'string'))
    )
        throw invalidPlugin(plugin, 'codecs must be codec families or a test');
}

/**
 * Checks plugins without loading anything: each is an object with a name and the parts of the
 * plugin shape, no two plugins share a name or supply one stage, audio encoder or part id. The same
 * plugin object listed twice counts once.
 */
export function checkPlugins(plugins: readonly MediaForgePlugin[]): CheckedPlugins {
    const seen = new Map<string, MediaForgePlugin>();
    const ids = {
        video: new Set<string>(),
        audio: new Set<string>(),
        application: new Set<string>(),
    };
    const encoders = new Set<string>();
    const stages = new Set<string>();
    for (const plugin of plugins) {
        if (
            !plugin ||
            typeof plugin !== 'object' ||
            typeof plugin.name !== 'string' ||
            !plugin.name.trim()
        )
            throw new MediaForgeError('Each plugin must be an object with a name', 'INPUT', {
                hint: "Import plugins from 'mediaforgejs/plugins' instead of building them.",
            });
        const { name } = plugin;
        if (seen.get(name) === plugin) continue;
        if (seen.has(name))
            throw new MediaForgeError(`Two different plugins are named '${name}'`, 'INPUT');
        for (const [key, replacement] of Object.entries(REPLACED_KEYS))
            if (key in plugin) throw invalidPlugin(name, `'${key}' is replaced by ${replacement}`);
        seen.set(name, plugin);

        partsOf(plugin, 'readers', plugin.readers);
        partsOf(plugin, 'writers', plugin.writers);
        for (const part of partsOf<PlayerPart>(plugin, 'players', plugin.players)) {
            const { protocols, sniff } = part;
            if (
                !Array.isArray(protocols) ||
                !protocols.length ||
                protocols.some(protocol => protocol !== 'hls' && protocol !== 'dash')
            )
                throw invalidPlugin(name, "a player plays the protocols 'hls' or 'dash'");
            if (sniff !== undefined && typeof sniff !== 'function')
                throw invalidPlugin(name, "a player's sniff must be a function");
        }
        const decoders = partsOf<DecoderPart>(plugin, 'decoders', plugin.decoders);
        const encoderParts = partsOf<EncoderPart>(plugin, 'encoders', plugin.encoders);
        const application = new Set<string>();
        for (const part of [...decoders, ...encoderParts]) {
            if (part.kind !== 'video' && part.kind !== 'audio')
                throw invalidPlugin(name, "a decoder or encoder has the kind 'video' or 'audio'");
            if (part.kind === 'video') checkCodecs(name, part.codecs);
        }
        for (const part of decoders) {
            if (part.kind === 'audio') {
                if (
                    !Array.isArray(part.codecs) ||
                    part.codecs.some(codec => typeof codec !== 'string')
                )
                    throw invalidPlugin(
                        name,
                        'an audio decoder lists the codec families it decodes',
                    );
                unique(ids.audio, part.id, 'audio decoders');
            } else if (part.replacesHost === true) application.add(part.id);
            else unique(ids.video, part.id, 'video decoders');
        }
        for (const part of encoderParts) {
            if (part.kind === 'video') {
                application.add(part.id);
                continue;
            }
            for (const codec of (part as AudioEncoderPart).codecs ?? []) {
                if (!LIBRARY_ENCODERS.includes(codec))
                    throw invalidPlugin(name, `unknown audio encoder '${codec}'`);
                if (encoders.has(codec))
                    throw new MediaForgeError(
                        `Two plugins supply the ${codec} audio encoder`,
                        'INPUT',
                    );
                encoders.add(codec);
            }
        }
        for (const id of application) unique(ids.application, id, 'application video codecs');

        for (const stage of stagesOf(plugin)) {
            const { name: stageName } = checkStageDefinition(stage);
            if (stages.has(stageName))
                throw new MediaForgeError(`Two plugins supply the stage '${stageName}'`, 'INPUT');
            stages.add(stageName);
        }
    }
    return Object.freeze({
        names: Object.freeze([...seen.keys()]),
        plugins: Object.freeze([...seen.values()]),
    });
}
