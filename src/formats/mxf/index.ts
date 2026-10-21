import { definePlugin } from '../../core/contracts/plugin';
import { mxfManifest } from './manifest';

/** Reads SMPTE MXF (OP1a, OP-Atom, D-10). */
export const mxf = definePlugin(mxfManifest, {
    readers: {
        mxf: async () => (await import('./reader')).mxfReader,
    },
});
