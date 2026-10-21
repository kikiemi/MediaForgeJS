import type { PluginManifest } from '../../core/contracts/plugin';
import { asciiAt } from '../detection/head-bytes';

/** What the ivf plugin adds. */
export const ivfManifest: PluginManifest = {
    name: 'ivf',
    description: 'IVF files and AV1 OBU streams',
    readers: [
        {
            id: 'ivf',
            formats: ['ivf'],
            // The 'DKIF' signature, after ASF.
            priority: 100,
            sniff: head => asciiAt(head, 0, 'DKIF'),
        },
        { id: 'obu', formats: ['obu', 'av1'] },
    ],
    writers: [{ kind: 'container', id: 'ivf', formats: ['ivf'] }],
};
