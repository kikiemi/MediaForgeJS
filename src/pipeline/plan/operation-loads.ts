import { CORE_FORMATS } from '../../formats/core-formats';

/**
 * What an operation runs once its input is open, started as soon as the operation's own code has
 * loaded: a browser then requests it in one round with the input's reader instead of one round
 * for each import the operation would reach in turn. A failed load fails the operation that
 * needs it. test/suites/browser-bundle.mjs holds these to the chunks the operations load. The
 * picture operations start theirs themselves (api/picture-operations): they load without the
 * conversion API, and this module loads with it, so the loads here request nothing the conversion
 * API's chunks hold already.
 */
function start(loads: readonly Promise<unknown>[]): void {
    for (const load of loads) load.catch(() => undefined);
}

/**
 * convert(): the packet copy (its chunk loads with the operations; this is the import that opens
 * it), the copy of a probed input's tracks, and the core writers of the target format `to` (none
 * when it keeps the input's).
 */
export function prefetchConversion(to: unknown): void {
    const format = typeof to === 'string' ? to.toLowerCase() : undefined;
    start([
        import('../copy/packet-copy'),
        import('../copy/copied-track'),
        ...CORE_FORMATS.writers
            .filter(writer => format !== undefined && writer.formats.includes(format))
            .map(writer => writer.load()),
    ]);
}
