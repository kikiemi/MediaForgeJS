import type { PluginManifest } from '../../core/contracts/plugin';
import { asciiAt } from '../detection/head-bytes';

/** What the apv plugin adds. */
export const apvManifest: PluginManifest = {
    name: 'apv',
    description: 'APV streams',
    readers: [
        {
            id: 'apv',
            formats: ['apv'],
            // The size of the first access unit, then its 'aPv1' signature.
            priority: 100,
            sniff: head => asciiAt(head, 4, 'aPv1'),
        },
    ],
    writers: [{ kind: 'container', id: 'apv', formats: ['apv'] }],
    decoders: [{ kind: 'video', id: 'apv', codecs: codec => /^apv1(\.|$)/.test(codec) }],
};
