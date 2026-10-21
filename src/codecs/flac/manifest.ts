import type { PluginManifest } from '../../core/contracts/plugin';

/** What the flac plugin adds. */
export const flacManifest: PluginManifest = {
    name: 'flac',
    description: 'the built-in FLAC decoder and encoder',
    decoders: [{ kind: 'audio', id: 'flac', codecs: ['flac'] }],
    encoders: [{ kind: 'audio', id: 'flac', codecs: ['flac'] }],
};
