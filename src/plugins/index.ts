import type { MediaForgePlugin } from '../core/contracts/plugin';
import { h264 } from '../codecs/h264/index';
import { mpeg12 } from '../codecs/mpeg12/index';
import { mpeg4 } from '../codecs/mpeg4/index';
import { aac } from '../codecs/aac/index';
import { mpegAudio } from '../codecs/mpeg-audio/index';
import { flac } from '../codecs/flac/index';
import { alac } from '../codecs/alac/index';
import { opus } from '../codecs/opus/index';
import { vorbis } from '../codecs/vorbis/index';
import { ac3 } from '../codecs/ac3/index';
import { avi } from '../formats/avi/index';
import { flv } from '../formats/flv/index';
import { asf } from '../formats/asf/index';
import { mxf } from '../formats/mxf/index';
import { mpegPs } from '../formats/mpeg-ps/index';
import { ivf } from '../formats/ivf/index';
import { iamf } from '../formats/iamf/index';
import { apv } from '../formats/apv/index';

/**
 * The plugins of the library. Each is a software codec that fills a gap in WebCodecs or a
 * container; an application leaves one out with `plugins: { exclude: [...] }`, or starts from
 * 'mediaforgejs/lite' and adds the ones it needs. The player of HLS and DASH streams is the
 * package mediaforgejs-player.
 * Each lives in its own folder, whose manifest.ts describes it and whose index.ts loads its
 * implementation on first use.
 */
export {
    aac,
    ac3,
    alac,
    apv,
    asf,
    avi,
    flac,
    flv,
    h264,
    iamf,
    ivf,
    mpeg12,
    mpeg4,
    mpegAudio,
    mpegPs,
    mxf,
    opus,
    vorbis,
};

/** Every plugin of the library, as the default entry uses them. */
export const allPlugins: readonly MediaForgePlugin[] = Object.freeze([
    h264,
    mpeg12,
    mpeg4,
    aac,
    mpegAudio,
    flac,
    alac,
    opus,
    vorbis,
    ac3,
    avi,
    flv,
    asf,
    mxf,
    mpegPs,
    ivf,
    iamf,
    apv,
]);
