import type { PluginManifest } from '../../core/contracts/plugin';
import { indexOfPattern, MXF_PARTITION_KEY, MXF_RUN_IN_LIMIT } from '../detection/head-bytes';

/** What the mxf plugin adds. */
export const mxfManifest: PluginManifest = {
    name: 'mxf',
    description: 'MXF files',
    readers: [
        {
            id: 'mxf',
            formats: ['mxf'],
            // A header partition pack within the run-in, after IVF.
            priority: 110,
            sniff: head => indexOfPattern(head, MXF_PARTITION_KEY, MXF_RUN_IN_LIMIT) >= 0,
        },
    ],
};
