import type { PluginManifest } from '../../core/contracts/plugin';
import { startsWith } from '../detection/head-bytes';

/** The GUID of the ASF header object, which starts every ASF file. */
const ASF_HEADER_GUID = [
    0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
];

/** What the asf plugin adds. */
export const asfManifest: PluginManifest = {
    name: 'asf',
    description: 'ASF, WMV and WMA files',
    readers: [
        {
            id: 'asf',
            formats: ['asf', 'wmv', 'wma'],
            // After the MP4 family's ftyp.
            priority: 90,
            sniff: head => startsWith(head, ASF_HEADER_GUID),
        },
    ],
};
