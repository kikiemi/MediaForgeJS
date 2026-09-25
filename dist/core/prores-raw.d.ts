/** Structural packet checks only. Decoding is supplied by the optional mediaforgejs-prores-raw package. */
export interface ProResRawLimits {
    maxFrameBytes?: number;
    maxPixels?: number;
    maxTiles?: number;
}
export interface ProResRawFrameHeader {
    version: 0 | 1;
    width: number;
    height: number;
    /** Header bytes beginning with the two-byte length at packet offset 8. */
    headerSize: number;
    tileAlignment: number;
    tileCount: number;
    bayerPattern: 0;
    flags: number;
}
export declare function isProResRawCodec(codec: string): boolean;
export declare function hasProResRawFrameHeader(data: Uint8Array): boolean;
export declare function proResRawFrameError(data: Uint8Array, track?: {
    codec?: string;
    width?: number;
    height?: number;
}, limits?: ProResRawLimits): string | undefined;
/** Validate a complete packet before returning its structural header. */
export declare function readProResRawFrameHeader(data: Uint8Array, track?: {
    codec?: string;
    width?: number;
    height?: number;
}, limits?: ProResRawLimits): ProResRawFrameHeader;
