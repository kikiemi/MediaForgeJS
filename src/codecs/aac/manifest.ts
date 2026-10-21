import type { PluginManifest } from '../../core/contracts/plugin';

/** What the aac plugin adds. */
export const aacManifest: PluginManifest = {
    name: 'aac',
    description: 'the built-in AAC decoder (LC, HE-AAC, HE-AACv2) and AAC-LC encoder',
    decoders: [{ kind: 'audio', id: 'aac', codecs: ['mp4a'] }],
    encoders: [{ kind: 'audio', id: 'aac', codecs: ['aac'] }],
};
