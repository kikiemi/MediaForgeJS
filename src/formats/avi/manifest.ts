import type { PluginManifest } from '../../core/contracts/plugin';
import { riffForm } from '../detection/head-bytes';

/** What the avi plugin adds. */
export const aviManifest: PluginManifest = {
    name: 'avi',
    description: 'AVI files',
    readers: [
        {
            id: 'avi',
            formats: ['avi'],
            // A RIFF file of the form AVI (or the 'AVI\x19' of some cameras), after WAVE and WebP.
            priority: 42,
            sniff: head => riffForm(head) === 'AVI ' || riffForm(head) === 'AVI\x19',
        },
    ],
    writers: [{ kind: 'container', id: 'avi', formats: ['avi'] }],
};
