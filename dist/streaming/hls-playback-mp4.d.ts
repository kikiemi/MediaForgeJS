interface PlaybackTrack {
    timescale: number;
    defaultDuration: number;
    defaultFlags: number;
    video: boolean;
}
export type HlsPlaybackTracks = ReadonlyMap<number, PlaybackTrack>;
/** Borrows attached, non-shared bytes until the current append has completed. */
export declare function hlsPlaybackBytes(value: Uint8Array): Uint8Array<ArrayBuffer>;
export declare function hlsPlaybackTracks(bytes: Uint8Array<ArrayBuffer>): HlsPlaybackTracks;
/** Presentation range in seconds; all tracks share one offset so A/V skew is preserved. */
export declare function hlsPlaybackTiming(bytes: Uint8Array<ArrayBuffer>, tracks: HlsPlaybackTracks): {
    start: number;
    end: number;
    randomAccess: number[];
};
export {};
