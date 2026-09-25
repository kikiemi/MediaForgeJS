import { MediaForgeConverter as ConverterCore } from './converter-core.js';
import type { MediaForgeJSConfig } from './core/converter-config.js';
export type { MediaForgeJSConfig } from './core/converter-config.js';
export { readFlacMetaBlocks, injectFlacMetaBlocks, readId3v2Prefix } from './core/audio-metadata.js';
/** Complete built-in composition; use converter-core to select individual components. */
export declare class MediaForgeConverter extends ConverterCore {
    constructor(config?: Partial<MediaForgeJSConfig>);
}
