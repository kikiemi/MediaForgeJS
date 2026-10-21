import { definePlugin } from '../../core/contracts/plugin';
import { aviManifest } from './manifest';

/** Reads and writes AVI, OpenDML included. */
export const avi = definePlugin(aviManifest, {
    readers: {
        avi: async () => (await import('./reader')).aviReader,
    },
    writers: {
        avi: async () => (await import('./writer')).createAviMuxer,
    },
});
