import type { PluginManifest } from '../../core/contracts/plugin';
import { isMpeg12VideoCodec } from '../../core/model/decoder-codecs';

/** What the mpeg12 plugin adds. */
export const mpeg12Manifest: PluginManifest = {
    name: 'mpeg12',
    description: 'the built-in MPEG-1/MPEG-2 video decoder',
    decoders: [{ kind: 'video', id: 'mpeg2video', codecs: isMpeg12VideoCodec }],
};
