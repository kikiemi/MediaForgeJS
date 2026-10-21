import type { PluginManifest } from '../../core/contracts/plugin';

/** What the mpegPs plugin adds. */
export const mpegPsManifest: PluginManifest = {
    name: 'mpegPs',
    description: 'MPEG program streams (MPG, VOB)',
    readers: [{ id: 'mpeg-ps', formats: ['mpeg', 'ps', 'vob'] }],
};
