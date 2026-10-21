import type { PluginManifest } from '../../core/contracts/plugin';

/** What the opus plugin adds. */
export const opusManifest: PluginManifest = {
    name: 'opus',
    description: 'the built-in Opus decoder',
    decoders: [{ kind: 'audio', id: 'opus', codecs: ['opus'] }],
};
