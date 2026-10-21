import { definePlugin } from '../../core/contracts/plugin';
import { apvManifest } from './manifest';

/**
 * Reads and writes raw APV streams (access units after their sizes), and decodes APV where the
 * host VideoDecoder cannot.
 */
export const apv = definePlugin(apvManifest, {
    readers: {
        apv: async () => (await import('./reader')).apvReader,
    },
    writers: {
        apv: async () => (await import('./writer')).createApvMuxer,
    },
    decoders: {
        apv: async () => (await import('./decoder')).createApvDecoder,
    },
});
