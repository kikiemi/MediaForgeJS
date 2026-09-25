export type ProResRawCodec = 'aprn' | 'aprh';

export interface ProResRawDecodeOptions {
    /** Container sample-entry tag, if known. Both RAW profiles use the same decoder. */
    codec?: ProResRawCodec;
    /** Default 128 MiB. Checked before parsing tables or allocating a frame. */
    maxFrameBytes?: number;
    /** Default 64 MiPixels. Output storage uses two bytes per visible pixel. */
    maxPixels?: number;
    /** Default 262,144. Each tile has at most sixteen 16×16 Bayer macroblocks. */
    maxTiles?: number;
    signal?: AbortSignal;
}

export interface ProResRawAsyncDecodeOptions extends ProResRawDecodeOptions {
    /** Yield to the event loop after this many tiles. Default 32, maximum 4096. */
    tilesPerYield?: number;
}

export interface ProResRawColorMetadata {
    transfer: 'linear';
    /** Sensor code levels in the 16-bit linear output domain, not normalized RGB. */
    blackLevel: number;
    whiteLevel: number;
    whiteBalance: { red: number; green: 1; blue: number; cctKelvin: number };
    /** Nine row-major floats describing camera RGB → CIE 1931 XYZ, D65. */
    cameraToXYZD65: number[];
    /** Post-matrix multiplicative gain, preserved but not applied. */
    gain: number;
    /** Eight control points used by the decoder to linearize its 16-bit IDCT output. */
    linearizationCurve: number[];
    appliedLinearization: true;
    appliedWhiteBalance: false;
    appliedColorMatrix: false;
    appliedGain: false;
    /** False for missing, nonfinite, degenerate or nonsensical camera color metadata. */
    valid: boolean;
}

export interface ProResRawFrame {
    width: number;
    height: number;
    /** Number of Uint16 elements per row; always width. */
    stride: number;
    format: 'bayer-rggb16';
    bayerPattern: 'rggb';
    bitDepth: 16;
    /** Owned, native-endian Uint16Array. Includes the recommended crop margins. */
    data: Uint16Array;
    codec?: ProResRawCodec;
    version: 0 | 1;
    vendor: string;
    recommendedCrop: { left: number; right: number; top: number; bottom: number };
    color: ProResRawColorMetadata;
    /** Owned copies preserve all camera-specific header bytes and trailing metadata. */
    rawHeader: Uint8Array;
    vendorMetadata: Uint8Array;
}

export class ProResRawError extends Error {
    readonly code: 'INVALID_DATA' | 'UNSUPPORTED' | 'LIMIT';
    constructor(message: string, code?: 'INVALID_DATA' | 'UNSUPPORTED' | 'LIMIT');
}

/** Decode one complete size/prrf packet. No global WebCodecs shims or native process. */
export function decodeProResRaw(data: Uint8Array, options?: ProResRawDecodeOptions): ProResRawFrame;
/** Snapshot the packet, decode in tile batches and allow event-loop cancellation. */
export function decodeProResRawAsync(data: Uint8Array, options?: ProResRawAsyncDecodeOptions): Promise<ProResRawFrame>;
