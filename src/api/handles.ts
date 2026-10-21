import type { MediaDiagnostic } from '../core/errors/diagnostics';
import { MediaForgeError } from '../core/errors/errors';
import type { Engine } from '../pipeline/engine';
import type { MediaContext, MediaReading, MediaReads } from './media-reads';

/**
 * What the classes of the API hand to the code behind them, out of their declarations: the engine
 * of a MediaForge and the making of a Media (its constructor is private). The classes set them in
 * their static blocks; this module names neither class, which import it.
 */
export const handles = {} as {
    /** The engine of a MediaForge, which the parts of api/parts.ts that need no input run on. */
    engineOf(forge: object): Promise<Engine>;
    /** The Media of an input open() opened. */
    openedMedia(
        context: MediaContext,
        collected: { current?: MediaDiagnostic[] },
        reads: MediaReads,
    ): object;
};

/** How each Media reads its input, for the parts that work on an opened input. */
export const readings = new WeakMap<object, MediaReading>();

/** How `media`, a Media, reads its input; anything else fails with INPUT. */
export function mediaReading(media: object): MediaReading {
    const reading = readings.get(media);
    if (!reading) throw new MediaForgeError('Expected a Media from open()', 'INPUT');
    return reading;
}

/** The engine and file behind `media`, a Media; anything else fails with INPUT. */
export function mediaContext(media: object): MediaContext {
    return mediaReading(media).context;
}
