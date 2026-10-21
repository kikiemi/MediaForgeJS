import type { PluginManifest } from '../../core/contracts/plugin';

/** What the mpegAudio plugin adds. */
export const mpegAudioManifest: PluginManifest = {
    name: 'mpegAudio',
    description: 'the built-in MPEG audio (MP3, MP2, MP1) decoder and MP2 and MP3 encoders',
    decoders: [{ kind: 'audio', id: 'mpegAudio', codecs: ['mp1', 'mp2', 'mp3'] }],
    encoders: [
        { kind: 'audio', id: 'mp2', codecs: ['mp2'] },
        { kind: 'audio', id: 'mp3', codecs: ['mp3'] },
    ],
};
