import { MediaEngine as CoreEngine, MediaFile as CoreFile } from './engine-core.js';
import { MediaForgeError } from '../core/errors.js';
import { builtinFormats } from './builtin-formats.js';
import { createWriters } from './formats.js';
export class MediaEngine extends CoreEngine {
    constructor(options = {}) {
        if (!options || typeof options !== 'object')
            throw new MediaForgeError('Expected engine options', 'INPUT');
        const { formats = builtinFormats, codecs, demuxers } = options;
        super({ formats, codecs, demuxers });
    }
    open(input, options = {}) {
        return super.open(input, options);
    }
    createFile(source, format, result, diagnostics, maxPacketBytes, maxSamples, releaseSource, maxIndexBytes) {
        return new MediaFile(source, format, result, diagnostics, maxPacketBytes, maxSamples, releaseSource, this.writers, maxIndexBytes);
    }
}
export class MediaFile extends CoreFile {
    constructor(source, format, result, diagnostics, maxPacketBytes, maxSamples, releaseSource, writers = createWriters(builtinFormats), maxIndexBytes = Infinity) {
        super(source, format, result, diagnostics, maxPacketBytes, maxSamples, releaseSource, writers, maxIndexBytes);
    }
}
