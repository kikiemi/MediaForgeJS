import { demuxRawAudio } from '../../demux/raw-audio-demuxer.js';
import { demuxStandaloneAudio } from '../../demux/standalone-audio-demuxer.js';
import { AUDIO_COPY_FORMATS, createAudioCopyMuxer } from '../audio-remux.js';
import { builtinDemuxer } from '../demux-ownership.js';
export const audio = Object.freeze({
    demuxers: Object.freeze([
        builtinDemuxer({
            formats: ['aac', 'mp1', 'mp2', 'mp3'],
            demux: (source, options) => demuxRawAudio(source, { ...options, format: options.format }),
        }),
        builtinDemuxer({
            formats: ['wav', 'aiff', 'au', 'caf', 'flac', 'ogg', 'opus'],
            demux: (source, options) => demuxStandaloneAudio(source, {
                ...options,
                format: options.format,
            }),
        }),
    ]),
    audioMuxers: Object.freeze([{ formats: Object.freeze([...AUDIO_COPY_FORMATS]), create: createAudioCopyMuxer }]),
});
