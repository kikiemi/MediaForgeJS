import type { PluginManifest } from '../../core/contracts/plugin';

/** What the alac plugin adds. */
export const alacManifest: PluginManifest = {
    name: 'alac',
    description: 'the built-in ALAC decoder',
    decoders: [{ kind: 'audio', id: 'alac', codecs: ['alac'] }],
};
