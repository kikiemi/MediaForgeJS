import { definePlugin } from '../../core/contracts/plugin';
import { ivfManifest } from './manifest';

/** Reads and writes IVF, and reads raw AV1 OBU streams in low-overhead or Annex B format. */
export const ivf = definePlugin(ivfManifest, {
    readers: {
        ivf: async () => (await import('./reader')).ivfReader,
        obu: async () => (await import('./obu-reader')).obuReader,
    },
    writers: {
        ivf: async () => (await import('./writer')).createIvfMuxer,
    },
});
