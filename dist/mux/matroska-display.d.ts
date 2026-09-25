import type { VideoTrackConfig } from '../types/container.js';
export interface MatroskaDisplay {
    readonly width: number;
    readonly height: number;
    readonly unit: 0 | 3;
}
/** Returns integral pixel dimensions or an exact display aspect ratio for Matroska Video elements. */
export declare function normalizeMatroskaDisplay(video: Pick<VideoTrackConfig, 'width' | 'height' | 'displayWidth' | 'displayHeight' | 'pixelAspectRatioNum' | 'pixelAspectRatioDen'>): MatroskaDisplay | undefined;
