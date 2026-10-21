import { definePlugin } from '../../core/contracts/plugin';
import { iamfManifest } from './manifest';

/** Reads and writes raw IAMF (IA sequences of OBUs). */
export const iamf = definePlugin(iamfManifest, {
    readers: {
        iamf: async () => (await import('./reader')).iamfReader,
    },
    writers: {
        iamf: async () => (await import('./writer')).createIamfMuxer,
    },
});
