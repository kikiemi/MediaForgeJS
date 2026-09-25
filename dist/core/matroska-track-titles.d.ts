interface TitleTrack {
    readonly matroskaTrackUid: bigint;
    readonly title?: string;
}
export declare function readMatroskaTrackTitles(bytes?: Uint8Array): ReadonlyMap<bigint, string>;
export declare function preservesMatroskaTrackTitles(bytes: Uint8Array, tracks: readonly {
    readonly matroskaTrackUid?: bigint;
    readonly title?: string;
}[]): boolean;
export declare function mergeMatroskaTrackTitles(bytes: Uint8Array | undefined, tracks: readonly TitleTrack[]): Uint8Array | undefined;
export {};
