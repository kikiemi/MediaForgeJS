import type { PluginManifest } from '../../core/contracts/plugin';
import { isH264Codec } from '../../core/model/decoder-codecs';

/** What the h264 plugin adds. */
export const h264Manifest: PluginManifest = {
    name: 'h264',
    description: 'the built-in H.264 decoder',
    decoders: [{ kind: 'video', id: 'h264', codecs: isH264Codec }],
};
