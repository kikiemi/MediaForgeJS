/** The decoded pictures that decoders hand on and application codecs take. */

export interface VideoFramePlane {
    readonly offset: number;
    readonly stride: number;
}

export interface RgbaVideoFrame {
    readonly data: Uint8Array | Uint8ClampedArray;
    readonly format: 'RGBA';
    readonly width: number;
    readonly height: number;
    readonly bitDepth?: 8;
    /** Presentation time and duration in seconds. */
    readonly timestamp: number;
    readonly duration: number;
    readonly scanType?: 'progressive';
    readonly colorPrimaries?: number;
    readonly colorTransfer?: number;
    readonly premultipliedAlpha?: false;
}

/** Owned decoded storage. The caller closes each frame after consuming it. */
export interface DecodedVideoFrame {
    readonly data: Uint8Array;
    readonly format: string;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly visibleWidth: number;
    readonly visibleHeight: number;
    readonly displayWidth?: number;
    readonly displayHeight?: number;
    readonly layout: readonly VideoFramePlane[];
    readonly bitDepth: number;
    readonly alphaBitDepth?: number;
    readonly originalAlphaBitDepth?: number;
    readonly pixelAspectRatio?: { readonly num: number; readonly den: number };
    readonly colorPrimaries?: number;
    readonly colorTransfer?: number;
    readonly colorMatrix?: number;
    readonly colorRangeFull?: boolean;
    readonly colorSpaceAssumed?: boolean;
    readonly scanType?:
        'progressive' | 'interlaced-top-field-first' | 'interlaced-bottom-field-first';
    readonly timestamp: number;
    readonly duration: number;
    readonly closed?: boolean;
    toRgba(options?: { readonly allowPrecisionLoss?: boolean; readonly signal?: AbortSignal }):
        | {
              readonly data: Uint8Array | Uint8ClampedArray;
              readonly width: number;
              readonly height: number;
          }
        | Promise<{
              readonly data: Uint8Array | Uint8ClampedArray;
              readonly width: number;
              readonly height: number;
          }>;
    close(): void;
}

export interface PlanarVideoColorSpace {
    readonly primaries?: VideoColorPrimaries;
    readonly transfer?: VideoTransferCharacteristics;
    readonly matrix?: VideoMatrixCoefficients;
    readonly fullRange?: boolean;
}

/**
 * One decoded 8-bit picture in presentation order. The frame owns `data`; the decoder keeps no
 * reference to it after returning. `layout` holds the offset and stride into `data` of each plane:
 * Y, U and V for the planar YUV formats, one plane of 4-byte pixels for BGRX and RGBX.
 */
export interface PlanarVideoFrame {
    readonly format: 'I420' | 'I422' | 'I444' | 'BGRX' | 'RGBX';
    readonly data: Uint8Array;
    readonly layout: readonly VideoFramePlane[];
    readonly codedWidth: number;
    readonly codedHeight: number;
    /** Visible region of the coded picture; x and y are even for subsampled chroma. */
    readonly visibleRect: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    };
    /** Display size after the stream's sample aspect ratio. */
    readonly displayWidth: number;
    readonly displayHeight: number;
    /**
     * Presentation time and duration in seconds, copied from the packet that carried the picture.
     */
    readonly timestamp: number;
    readonly duration: number;
    readonly keyFrame: boolean;
    readonly colorSpace?: PlanarVideoColorSpace;
    readonly interlaced?: 'top-field-first' | 'bottom-field-first';
    /** Bit depth of the coded samples when the decoder rounded them to these 8-bit pictures. */
    readonly bitDepth?: number;
}
