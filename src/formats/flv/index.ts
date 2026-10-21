import { definePlugin } from '../../core/contracts/plugin';
import { flvManifest } from './manifest';

/** Reads and writes FLV, the enhanced RTMP codecs included. */
export const flv = definePlugin(flvManifest, {
    readers: {
        flv: async () => (await import('./reader')).flvReader,
    },
    writers: {
        flv: async () => (await import('./writer')).createFlvMuxer,
    },
});
