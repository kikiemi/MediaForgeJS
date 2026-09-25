export interface MP4TrackMetadata {
    readonly type?: string;
    readonly default?: boolean;
    readonly forced?: boolean;
    readonly commentary?: boolean;
    readonly name?: string;
    readonly title?: string;
    readonly language?: string;
}
export declare function readMP4Title(bytes: Uint8Array, start: number, end: number): string | undefined;
export declare function readMP4TrackMetadata(bytes: Uint8Array, start: number, end: number, subtitle: boolean): MP4TrackMetadata;
export declare function readMP4HandlerName(bytes: Uint8Array, offset: number, size: number): string | undefined;
export declare function validateMP4TrackMetadata(track: MP4TrackMetadata): void;
export declare function snapshotMP4TrackMetadata(track: MP4TrackMetadata | undefined, type: string): MP4TrackMetadata | undefined;
export declare function mp4TrackFlags(track: MP4TrackMetadata | undefined, flags?: number): number;
export declare function mp4HandlerName(name: string | undefined): Uint8Array;
export declare function mp4TitleBox(title: string | undefined, quickTime?: boolean): Uint8Array;
export declare function mp4TrackMetadataBoxes(track: MP4TrackMetadata | undefined, quickTime?: boolean): Uint8Array[];
