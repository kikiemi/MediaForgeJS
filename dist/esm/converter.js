import { MediaForgeConverter as ConverterCore } from './converter-core.js';
import { defaultConversionOptions } from './conversion/defaults.js';
export { readFlacMetaBlocks, injectFlacMetaBlocks, readId3v2Prefix } from './core/audio-metadata.js';
export class MediaForgeConverter extends ConverterCore {
    constructor(config = {}) {
        super(config, defaultConversionOptions);
    }
}
