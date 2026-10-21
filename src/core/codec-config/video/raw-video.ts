/**
 * Stored layouts of uncompressed video. I420 and YV12 are planar 4:2:0 (YV12 stores V before U),
 * NV12 has interleaved UV, YUY2 and UYVY are packed 4:2:2, YUYS is YUY2 with signed chroma
 * (QuickTime 'yuv2'), and the RGB layouts store one pixel in 3 or 4 bytes in the named byte order.
 * RGB555 is a little-endian 16-bit BI_RGB pixel (x1r5g5b5); PAL8 and PAL4 index a BGRX palette
 * carried as the codec configuration.
 */
export type RawVideoLayout =
    | 'I420'
    | 'YV12'
    | 'NV12'
    | 'YUY2'
    | 'UYVY'
    | 'YUYS'
    | 'BGR24'
    | 'BGRX'
    | 'RGB24'
    | 'XRGB'
    | 'RGB555'
    | 'PAL8'
    | 'PAL4';

const LAYOUTS: readonly RawVideoLayout[] = [
    'I420',
    'YV12',
    'NV12',
    'YUY2',
    'UYVY',
    'YUYS',
    'BGR24',
    'BGRX',
    'RGB24',
    'XRGB',
    'RGB555',
    'PAL8',
    'PAL4',
];

/**
 * FourCCs of uncompressed YUV in AVI and Matroska (V_UNCOMPRESSED ColourSpace), and QuickTime
 * sample entries.
 */
const FOURCCS: Readonly<Record<string, RawVideoLayout>> = {
    I420: 'I420',
    IYUV: 'I420',
    YV12: 'YV12',
    NV12: 'NV12',
    YUY2: 'YUY2',
    YUYV: 'YUY2',
    yuvs: 'YUY2',
    UYVY: 'UYVY',
    HDYC: 'UYVY',
    '2vuy': 'UYVY',
    yuv2: 'YUYS',
    'BGR\x18': 'BGR24',
    'RGB\x18': 'RGB24',
    BGRA: 'BGRX',
};

/**
 * Codec string of an uncompressed track: raw.<layout>, with .flip when rows are stored bottom-up as
 * in BI_RGB bitmaps.
 */
export function rawVideoCodec(layout: RawVideoLayout, bottomUp = false): string {
    return `raw.${layout}${bottomUp ? '.flip' : ''}`;
}

/**
 * The raw codec string for a stored FourCC, or undefined when the FourCC is not uncompressed video.
 */
export function rawVideoCodecForFourcc(fourcc: string): string | undefined {
    const layout = FOURCCS[fourcc] ?? FOURCCS[fourcc.toUpperCase()];
    return layout && rawVideoCodec(layout);
}

/** Bitmap bit depths of BI_RGB pixels: 4 and 8 index a palette, 16 is x1r5g5b5. */
const BITMAP_LAYOUTS: Readonly<Record<number, RawVideoLayout>> = {
    4: 'PAL4',
    8: 'PAL8',
    16: 'RGB555',
    24: 'BGR24',
    32: 'BGRX',
};

/**
 * The raw codec string of an AVI BITMAPINFOHEADER without a YUV FourCC: BI_RGB at 4, 8, 16, 24 or
 * 32 bits, or BI_BITFIELDS at 32 bits.
 */
export function rawVideoCodecForBitmap(
    compression: number,
    bitCount: number,
    height: number,
): string | undefined {
    if (compression !== 0 && !(compression === 3 && bitCount === 32)) return undefined;
    const layout = BITMAP_LAYOUTS[bitCount];
    return layout && rawVideoCodec(layout, height > 0);
}

/** Whether a raw layout indexes a palette, which the track carries as its codec configuration. */
export function isPalettedRawVideo(codec: string): boolean {
    const layout = parseRawVideoCodec(codec)?.layout;
    return layout === 'PAL8' || layout === 'PAL4';
}

export function parseRawVideoCodec(
    codec: string,
): { layout: RawVideoLayout; bottomUp: boolean } | undefined {
    const match = /^raw\.([A-Z0-9]+)(\.flip)?$/.exec(codec);
    const layout = match?.[1] as RawVideoLayout | undefined;
    return layout && LAYOUTS.includes(layout) ? { layout, bottomUp: !!match![2] } : undefined;
}
