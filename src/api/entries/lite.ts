import { MediaForge, functionsOf } from '../forge';

/**
 * The API without plugins, for applications that count every byte: the core containers (MP4/MOV,
 * Matroska/WebM, MPEG-TS, the audio files) and codecs, with the host WebCodecs. Add plugins from
 * 'mediaforgejs/plugins' with the `plugins` option.
 */
export * from '../surface';

export { MediaForge };
export const {
    inspect,
    open,
    convert,
    check,
    thumbnail,
    frames,
    packageMedia,
    edit,
    encodeFrames,
    recordStream,
    play,
    createPlayer,
    capabilities,
} = functionsOf(new MediaForge());
