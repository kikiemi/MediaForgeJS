import type { HlsMasterPlaylist, HlsRendition, HlsVariant } from './hls-playlist.js';
export interface HlsRenditionSelectionOptions {
    readonly type: HlsRendition['type'];
    readonly languages?: readonly string[];
    /** An exact NAME permits explicit selection of AUTOSELECT=NO renditions. */
    readonly name?: string;
    readonly forced?: boolean;
    readonly channels?: string;
}
/** Returns the referenced group, including manual and in-band renditions, in playlist order. */
export declare function getHlsRenditions(master: HlsMasterPlaylist, variant: HlsVariant, type: HlsRendition['type']): HlsRendition[];
export declare function selectHlsRendition(master: HlsMasterPlaylist, variant: HlsVariant, options: HlsRenditionSelectionOptions): HlsRendition | undefined;
