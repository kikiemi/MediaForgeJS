import type { MediaProgress, MediaProgressStage } from '../core/model/media';

/**
 * Reports of one operation: never a smaller fraction than before, with the stage, the media time
 * and duration, and a final report of 1 from `finish()`.
 */
export function progressReporter(
    callback: ((progress: MediaProgress) => void) | undefined,
    stage: MediaProgressStage,
    duration?: number,
): { readonly callback?: (progress: MediaProgress) => void; finish(): void } {
    if (typeof callback !== 'function') return { finish() {} };
    let last = 0;
    let finished = false;
    const emit = (progress: MediaProgress): void => {
        const value = Number.isFinite(progress.fraction) ? Math.min(1, progress.fraction) : last;
        last = Math.max(last, value);
        finished ||= last === 1;
        const known = duration !== undefined && Number.isFinite(duration) && duration > 0;
        callback({
            ...progress,
            fraction: last,
            stage: progress.stage ?? stage,
            ...(known ? { duration, time: progress.time ?? last * duration! } : {}),
        });
    };

    return {
        callback: emit,
        finish() {
            if (!finished) emit({ fraction: 1 });
        },
    };
}
