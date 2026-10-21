import type { PluginManifest } from '../../core/contracts/plugin';

/** What the vorbis plugin adds. */
export const vorbisManifest: PluginManifest = {
    name: 'vorbis',
    description: 'the built-in Vorbis decoder',
    decoders: [{ kind: 'audio', id: 'vorbis', codecs: ['vorbis'] }],
};
