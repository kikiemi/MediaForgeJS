// The public API of 'mediaforgejs-prores-raw', from its built declarations (npm run api:report).

export interface ProResRawAsyncDecodeOptions extends ProResRawDecodeOptions {
    tilesPerYield?: number;
}

export type ProResRawCodec = 'aprn' | 'aprh';

export interface ProResRawColorMetadata {
    transfer: 'linear';
    blackLevel: number;
    whiteLevel: number;
    whiteBalance: {
        red: number;
        green: 1;
        blue: number;
        cctKelvin: number;
    };
    cameraToXYZD65: number[];
    gain: number;
    linearizationCurve: number[];
    appliedLinearization: true;
    appliedWhiteBalance: false;
    appliedColorMatrix: false;
    appliedGain: false;
    valid: boolean;
}

export interface ProResRawDecodeOptions {
    codec?: ProResRawCodec;
    maxFrameBytes?: number;
    maxPixels?: number;
    maxTiles?: number;
    signal?: AbortSignal;
}

export declare class ProResRawError extends Error {
    readonly code: 'INVALID_DATA' | 'UNSUPPORTED' | 'LIMIT';
    constructor(message: string, code?: 'INVALID_DATA' | 'UNSUPPORTED' | 'LIMIT');
}

export interface ProResRawFrame {
    width: number;
    height: number;
    stride: number;
    format: 'bayer-rggb16';
    bayerPattern: 'rggb';
    bitDepth: 16;
    data: Uint16Array;
    codec?: ProResRawCodec;
    version: 0 | 1;
    vendor: string;
    recommendedCrop: {
        left: number;
        right: number;
        top: number;
        bottom: number;
    };
    color: ProResRawColorMetadata;
    rawHeader: Uint8Array;
    vendorMetadata: Uint8Array;
}

export declare function decodeProResRaw(data: Uint8Array, options?: ProResRawDecodeOptions): ProResRawFrame;

export declare function decodeProResRawAsync(data: Uint8Array, options?: ProResRawAsyncDecodeOptions): Promise<ProResRawFrame>;
