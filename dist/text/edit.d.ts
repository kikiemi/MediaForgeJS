import type { SubtitleDocument } from './types.js';
export interface SubtitleEditOptions {
    /** Source interval in seconds; intersecting cues are clipped before offset is added. */
    startTime?: number;
    endTime?: number;
    offset?: number;
}
/** Does not mutate input. Unchanged styling, headers and diagnostics may share references. */
export declare function editSubtitles(document: SubtitleDocument, options?: SubtitleEditOptions): SubtitleDocument;
