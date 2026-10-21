/**
 * How a frame worker starts: `browser` creates a worker in a browser or a bundled app (the module
 * build uses the `new Worker(new URL('./frame-worker.js', import.meta.url), { type: 'module' })`
 * form bundlers recognise; the script bundles load h264-worker.js next to the plugin script from a
 * Blob), `node` gives the module file for Node's worker_threads.
 */
interface FrameWorkerSource {
    readonly browser: (() => Worker) | null;
    readonly node: (() => URL) | null;
}

declare const __MEDIAFORGE_H264_WORKER__: FrameWorkerSource | undefined;

/** Filled in by the build; null in unbuilt sources, which then decode on one thread. */
export const frameWorker: FrameWorkerSource | null =
    typeof __MEDIAFORGE_H264_WORKER__ === 'object' ? __MEDIAFORGE_H264_WORKER__ : null;
