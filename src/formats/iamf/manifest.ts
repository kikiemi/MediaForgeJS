import type { PluginManifest } from '../../core/contracts/plugin';
import { asciiAt } from '../detection/head-bytes';

/** What the iamf plugin adds. */
export const iamfManifest: PluginManifest = {
    name: 'iamf',
    description: 'IAMF streams',
    readers: [
        {
            id: 'iamf',
            formats: ['iamf'],
            // An IA sequence header OBU (0xF8 or 0xFC, its size) holding the code 'iamf'.
            priority: 100,
            sniff: head => (head[0]! | 4) === 0xfc && head[1]! < 0x80 && asciiAt(head, 2, 'iamf'),
        },
    ],
    writers: [{ kind: 'container', id: 'iamf', formats: ['iamf'] }],
};
