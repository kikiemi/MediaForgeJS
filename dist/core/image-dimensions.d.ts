export interface SniffedDimensions {
    readonly width: number;
    readonly height: number;
}
/** Reads known geometry from an available prefix; null does not mean the complete file is invalid. */
export declare function sniffImageDimensions(head: Uint8Array): SniffedDimensions | null;
export declare function sniffTiffDimensionsAt(file: Blob): Promise<{
    width: number;
    height: number;
} | null>;
