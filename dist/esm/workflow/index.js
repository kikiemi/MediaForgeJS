import { MediaWorkflow as CoreWorkflow } from './core.js';
import { builtinFormats } from '../engine/builtin-formats.js';
import { nativeAudio } from './audio.js';
import { nativeAudioDecoder } from './audio-decode.js';
import { createNativeVideoTransform } from './transcode-core.js';
import { MediaForgeError } from '../core/errors.js';
export { MediaJob } from './job.js';
export class MediaWorkflow extends CoreWorkflow {
    constructor(options = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options))
            throw new MediaForgeError('Expected workflow options', 'INPUT');
        const { formats = builtinFormats, audio = nativeAudio, audioDecoder = nativeAudioDecoder, demuxers, codecs, transform = createNativeVideoTransform({ formats }), } = options;
        super({ formats, audio, audioDecoder, demuxers, codecs, transform });
    }
}
