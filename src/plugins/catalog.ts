import type { PluginManifest } from '../core/contracts/plugin';
import { h264Manifest } from '../codecs/h264/manifest';
import { mpeg12Manifest } from '../codecs/mpeg12/manifest';
import { mpeg4Manifest } from '../codecs/mpeg4/manifest';
import { aacManifest } from '../codecs/aac/manifest';
import { mpegAudioManifest } from '../codecs/mpeg-audio/manifest';
import { flacManifest } from '../codecs/flac/manifest';
import { alacManifest } from '../codecs/alac/manifest';
import { opusManifest } from '../codecs/opus/manifest';
import { vorbisManifest } from '../codecs/vorbis/manifest';
import { ac3Manifest } from '../codecs/ac3/manifest';
import { FORMAT_PLUGIN_MANIFESTS } from '../formats/format-plugins';

/** The plugins of the library, by name. */
export type PluginName =
    | 'h264'
    | 'mpeg12'
    | 'mpeg4'
    | 'aac'
    | 'mpegAudio'
    | 'flac'
    | 'alac'
    | 'opus'
    | 'vorbis'
    | 'ac3'
    | 'avi'
    | 'flv'
    | 'asf'
    | 'mxf'
    | 'mpegPs'
    | 'ivf'
    | 'iamf'
    | 'apv';

/**
 * What each plugin of the library adds, in the order of `allPlugins`: their manifests, so a PLUGIN
 * error names the plugin to include without loading any plugin.
 */
export const PLUGIN_CATALOG: readonly PluginManifest[] = Object.freeze([
    h264Manifest,
    mpeg12Manifest,
    mpeg4Manifest,
    aacManifest,
    mpegAudioManifest,
    flacManifest,
    alacManifest,
    opusManifest,
    vorbisManifest,
    ac3Manifest,
    ...FORMAT_PLUGIN_MANIFESTS,
]);
