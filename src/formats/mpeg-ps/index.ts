import { definePlugin } from '../../core/contracts/plugin';
import { mpegPsManifest } from './manifest';

/** Reads MPEG program streams (.mpg, .mpeg, .m2p, .vob, .mod, .vro). */
export const mpegPs = definePlugin(mpegPsManifest, {
    readers: {
        'mpeg-ps': async () => (await import('./reader')).mpegPsReader,
    },
});
