import type { PluginManifest } from '../../core/contracts/plugin';
import { isMpeg4VisualCodec } from '../../core/model/decoder-codecs';

/** What the mpeg4 plugin adds. */
export const mpeg4Manifest: PluginManifest = {
    name: 'mpeg4',
    description: 'the built-in MPEG-4 Part 2 and H.263 decoder',
    decoders: [{ kind: 'video', id: 'mpeg4-part2', codecs: isMpeg4VisualCodec }],
};
