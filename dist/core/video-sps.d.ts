export interface ParsedSps {
    width: number;
    height: number;
    pixelAspectRatioNum: number;
    pixelAspectRatioDen: number;
    displayWidth: number;
    displayHeight: number;
}
export declare class H264BitReader {
    private readonly data;
    private bitOffset;
    constructor(data: Uint8Array);
    readBit(): number;
    skipBits(count: number): void;
    readBits(count: number): number;
    readUE(): number;
    readSE(): number;
    skipScalingList(size: number): void;
}
export declare function nalToRbsp(nal: Uint8Array, headerBytes: number): Uint8Array;
export declare function avcCodecStringFromSps(sps: Uint8Array): string;
export declare function parseH264Sps(sps: Uint8Array): ParsedSps | null;
export interface ParsedHevcSps extends ParsedSps {
    codec: string;
    videoParameterSetId: number;
    sequenceParameterSetId: number;
    profileSpace: number;
    tierFlag: number;
    profileIdc: number;
    profileCompatibilityFlags: number;
    constraintIndicatorFlags: Uint8Array;
    levelIdc: number;
    maxSubLayersMinus1: number;
    temporalIdNestingFlag: number;
    chromaFormatIdc: number;
    bitDepthLumaMinus8: number;
    bitDepthChromaMinus8: number;
}
export declare function parseHevcSps(sps: Uint8Array): ParsedHevcSps | null;
export declare function gcd(a: number, b: number): number;
export declare function displayDimensions(width: number, height: number, parNum: number, parDen: number): {
    num: number;
    den: number;
};
