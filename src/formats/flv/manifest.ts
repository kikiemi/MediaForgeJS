import type { PluginManifest } from '../../core/contracts/plugin';
import { asciiAt } from '../detection/head-bytes';

/** What the flv plugin adds. */
export const flvManifest: PluginManifest = {
    name: 'flv',
    description: 'FLV files',
    readers: [
        {
            id: 'flv',
            formats: ['flv'],
            // 'FLV', after the JPEG XL codestream.
            priority: 130,
            sniff: head => head.length >= 4 && asciiAt(head, 0, 'FLV'),
        },
    ],
    writers: [{ kind: 'container', id: 'flv', formats: ['flv'] }],
};
