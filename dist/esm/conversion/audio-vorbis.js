import { createWebCodecsTrackPcmSource } from '../audio/webcodecs-pcm-source.js';
export const vorbisAudio = Object.freeze({
    codecs: Object.freeze(['vorbis']),
    outputs: Object.freeze([]),
    decode: (track, read, config) => createWebCodecsTrackPcmSource(track, read, config.signal),
});
