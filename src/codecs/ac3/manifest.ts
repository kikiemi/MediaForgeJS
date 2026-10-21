import type { PluginManifest } from '../../core/contracts/plugin';

/** What the ac3 plugin adds. */
export const ac3Manifest: PluginManifest = {
    name: 'ac3',
    description: 'the built-in AC-3 and E-AC-3 decoder',
    decoders: [{ kind: 'audio', id: 'ac3', codecs: ['ac-3', 'ec-3'] }],
};
