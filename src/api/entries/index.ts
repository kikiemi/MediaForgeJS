import { MediaForge as LiteForge, functionsOf } from '../forge';
import { handles } from '../handles';
import { allPlugins } from '../../plugins/index';
import { prefetchWhenIdle } from '../idle-prefetch';

export * from '../surface';

/**
 * MediaForge with every plugin of the library by default; see the `plugins` option to leave some
 * out.
 */
export class MediaForge extends LiteForge {
    static override readonly defaultPlugins = allPlugins;
}

const defaultForge = new MediaForge();

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
} = functionsOf(defaultForge);

// In a browser the code a first inspect() or open() runs loads once the page is idle, and the
// default MediaForge sets its engine up then, so the call finds both ready; the lite entry, for
// applications that count every byte, loads it with the call.
prefetchWhenIdle(() => handles.engineOf(defaultForge));
