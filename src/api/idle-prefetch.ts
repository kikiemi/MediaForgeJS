import { prefetchOpening } from '../pipeline/read/reader-modules';
import { operationStarted } from './load-hints';

interface BrowserScope {
    document?: unknown;
    importScripts?: unknown;
    requestIdleCallback?: (run: () => void, options: { timeout: number }) => unknown;
    navigator?: { connection?: { saveData?: boolean; effectiveType?: string } };
}

/**
 * Whether the user asked to save data or the connection is a 2G one (the Network Information API,
 * where the browser has it): code is then fetched only when it is needed.
 */
function savesData(scope: BrowserScope): boolean {
    const connection = scope.navigator?.connection;
    return (
        connection?.saveData === true ||
        connection?.effectiveType === 'slow-2g' ||
        connection?.effectiveType === '2g'
    );
}

/**
 * In a browser or a browser worker, where code arrives over the network, loads what the first
 * inspect() or open() of a common input runs (the engine, the MP4, MPEG audio and Matroska readers,
 * the metadata part of the Matroska reader, which the Tags of ffmpeg's and mkvmerge's files need,
 * and the AAC syntax) once the page or worker is idle after the entry has loaded, and sets the
 * engine up with `engine` (the entry's default MediaForge composes its plugins), so that a later
 * first call finds both ready. An operation that starts before then loads what it runs itself, and
 * the prefetch does not run; neither does it on a connection that saves data. Nothing waits for it;
 * failures surface when an input opens.
 */
export function prefetchWhenIdle(engine: () => Promise<unknown>): void {
    const scope = globalThis as BrowserScope;
    if (scope.document === undefined && typeof scope.importScripts !== 'function') return;
    const prefetch = (): void => {
        if (operationStarted() || savesData(scope)) return;
        engine().catch(() => undefined);
        for (const format of ['mp4', 'mp3', 'mkv']) prefetchOpening(format);
        import('../formats/matroska/read/metadata').catch(() => undefined);
    };
    if (typeof scope.requestIdleCallback === 'function')
        scope.requestIdleCallback(prefetch, { timeout: 1000 });
    else if (typeof setTimeout === 'function') setTimeout(prefetch, 0);
}
