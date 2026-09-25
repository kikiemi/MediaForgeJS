import type { HlsKey } from './hls-playlist.js';
import type { HlsDrmInitData } from './hls-drm.js';
export declare function drmKeyFormats(keySystem: string): readonly string[];
export declare function drmInitData(key: HlsKey, limit: number): HlsDrmInitData | undefined;
