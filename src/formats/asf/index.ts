import { definePlugin } from '../../core/contracts/plugin';
import { asfManifest } from './manifest';

/** Reads ASF, WMV and WMA; their Windows Media codecs are copied, not decoded. */
export const asf = definePlugin(asfManifest, {
    readers: {
        asf: async () => (await import('./reader')).asfReader,
    },
});
