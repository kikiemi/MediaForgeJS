import { parseRawVideoCodec, type RawVideoLayout } from '../../core/codec-config/video/raw-video';
import { MediaForgeError } from '../../core/errors/errors';
import type { EncodedPacket } from '../../core/model/media';
import type {
    BuiltinVideoCodec,
    BuiltinVideoDecoder,
    BuiltinVideoDecoderConfig,
} from '../../core/contracts/decoder';
import type { PlanarVideoFrame } from '../../core/contracts/picture';

/**
 * Copies stored rows into a new picture; packed 4:2:2 becomes I422 and 3-byte RGB gains a padding
 * byte.
 */
function unpack(
    layout: RawVideoLayout,
    bottomUp: boolean,
    data: Uint8Array,
    width: number,
    height: number,
    palette: Uint8Array | undefined,
) {
    const chromaWidth = Math.ceil(width / 2);
    const chromaHeight = Math.ceil(height / 2);
    const planar420 = width * height + 2 * chromaWidth * chromaHeight;
    if (layout === 'I420' || layout === 'YV12' || layout === 'NV12') {
        if (data.length < planar420)
            throw new MediaForgeError(`Uncompressed ${layout} frame is too short`, 'DECODE');
        const luma = width * height;
        const chroma = chromaWidth * chromaHeight;
        const output = data.slice(0, planar420);
        if (layout === 'NV12') {
            for (let index = 0; index < chroma; index++) {
                output[luma + index] = data[luma + index * 2]!;
                output[luma + chroma + index] = data[luma + index * 2 + 1]!;
            }
        }
        const [u, v] = layout === 'YV12' ? [luma + chroma, luma] : [luma, luma + chroma];
        return {
            format: 'I420' as const,
            data: output,
            layout: [
                { offset: 0, stride: width },
                { offset: u, stride: chromaWidth },
                { offset: v, stride: chromaWidth },
            ],
        };
    }
    if (layout === 'RGB555' || layout === 'PAL8' || layout === 'PAL4')
        return unpackIndexed(layout, bottomUp, data, width, height, palette);
    const packed = layout === 'YUY2' || layout === 'UYVY' || layout === 'YUYS';
    const pixelBytes = packed ? 2 : layout === 'BGR24' || layout === 'RGB24' ? 3 : 4;
    const rowBytes = packed ? chromaWidth * 4 : width * pixelBytes;
    const stride = Math.floor(data.length / height);
    if (stride < rowBytes)
        throw new MediaForgeError(
            `Uncompressed ${layout} frame holds ${data.length} bytes, fewer than ` +
                `${rowBytes * height}`,
            'DECODE',
        );
    const source = (row: number): number => (bottomUp ? height - 1 - row : row) * stride;
    if (packed) {
        const output = new Uint8Array(width * height + 2 * chromaWidth * height);
        const [y0, u, y1, v] = layout === 'UYVY' ? [1, 0, 3, 2] : [0, 1, 2, 3];
        const sign = layout === 'YUYS' ? 0x80 : 0;
        const uPlane = width * height;
        const vPlane = uPlane + chromaWidth * height;
        for (let row = 0; row < height; row++) {
            const from = source(row);
            for (let pair = 0; pair < chromaWidth; pair++) {
                const at = from + pair * 4;
                const x = pair * 2;
                output[row * width + x] = data[at + y0]!;
                if (x + 1 < width) output[row * width + x + 1] = data[at + y1]!;
                output[uPlane + row * chromaWidth + pair] = data[at + u]! ^ sign;
                output[vPlane + row * chromaWidth + pair] = data[at + v]! ^ sign;
            }
        }
        return {
            format: 'I422' as const,
            data: output,
            layout: [
                { offset: 0, stride: width },
                { offset: uPlane, stride: chromaWidth },
                { offset: vPlane, stride: chromaWidth },
            ],
        };
    }
    const output = new Uint8Array(width * height * 4);
    const [first, second, third] = layout === 'XRGB' ? [1, 2, 3] : [0, 1, 2];
    for (let row = 0; row < height; row++) {
        let from = source(row);
        let to = row * width * 4;
        for (let x = 0; x < width; x++, from += pixelBytes, to += 4) {
            output[to] = data[from + first]!;
            output[to + 1] = data[from + second]!;
            output[to + 2] = data[from + third]!;
            output[to + 3] = 255;
        }
    }
    return {
        format: layout.startsWith('BGR') ? ('BGRX' as const) : ('RGBX' as const),
        data: output,
        layout: [{ offset: 0, stride: width * 4 }],
    };
}

/**
 * BGRX pictures of 16-bit x1r5g5b5 and palette-indexed bitmaps; stored rows are padded to four
 * bytes.
 */
function unpackIndexed(
    layout: 'RGB555' | 'PAL8' | 'PAL4',
    bottomUp: boolean,
    data: Uint8Array,
    width: number,
    height: number,
    palette: Uint8Array | undefined,
) {
    const bits = layout === 'RGB555' ? 16 : layout === 'PAL8' ? 8 : 4;
    const rowBytes = Math.ceil((width * bits) / 32) * 4;
    if (data.length < rowBytes * height)
        throw new MediaForgeError(
            `Uncompressed ${layout} frame holds ${data.length} bytes, fewer than ` +
                `${rowBytes * height}`,
            'DECODE',
        );
    if (layout !== 'RGB555' && (!palette || palette.length < 4))
        throw new MediaForgeError(`Uncompressed ${layout} video needs its palette`, 'DECODE');
    const colours = palette ? palette.length >> 2 : 0;
    const output = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
        const from = (bottomUp ? height - 1 - row : row) * rowBytes;
        let to = row * width * 4;
        for (let x = 0; x < width; x++, to += 4) {
            if (layout === 'RGB555') {
                const value = data[from + x * 2]! | (data[from + x * 2 + 1]! << 8);
                const expand = (five: number) => (five << 3) | (five >> 2);
                output[to] = expand(value & 31);
                output[to + 1] = expand((value >> 5) & 31);
                output[to + 2] = expand((value >> 10) & 31);
            } else {
                const byte = data[from + (layout === 'PAL8' ? x : x >> 1)]!;
                const index = layout === 'PAL8' ? byte : x & 1 ? byte & 15 : byte >> 4;
                if (index < colours) {
                    output[to] = palette![index * 4]!;
                    output[to + 1] = palette![index * 4 + 1]!;
                    output[to + 2] = palette![index * 4 + 2]!;
                }
            }
            output[to + 3] = 255;
        }
    }
    return { format: 'BGRX' as const, data: output, layout: [{ offset: 0, stride: width * 4 }] };
}

/** Decoder for uncompressed video tracks; every packet is one complete picture. */
export const uncompressedVideoCodec: BuiltinVideoCodec = Object.freeze({
    id: 'uncompressed',
    supports: (codec: string) => parseRawVideoCodec(codec) !== undefined,
    create(config: BuiltinVideoDecoderConfig): BuiltinVideoDecoder {
        const parsed = parseRawVideoCodec(config.codec);
        const width = config.codedWidth ?? 0;
        const height = config.codedHeight ?? 0;
        if (!parsed)
            throw new MediaForgeError(`'${config.codec}' is not uncompressed video`, 'DECODE');
        if (
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width < 1 ||
            height < 1
        )
            throw new MediaForgeError('Uncompressed video needs its picture size', 'DECODE');
        if (width * height > 8192 * 8192)
            throw new MediaForgeError('Uncompressed video exceeds the pixel budget', 'OOM');
        return {
            decode(chunk: EncodedPacket): readonly PlanarVideoFrame[] {
                const picture = unpack(
                    parsed.layout,
                    parsed.bottomUp,
                    chunk.data,
                    width,
                    height,
                    config.description,
                );
                return [
                    {
                        ...picture,
                        codedWidth: width,
                        codedHeight: height,
                        visibleRect: { x: 0, y: 0, width, height },
                        displayWidth: width,
                        displayHeight: height,
                        timestamp: chunk.timestamp,
                        duration: chunk.duration,
                        keyFrame: true,
                    },
                ];
            },
            flush: () => [],
            reset() {},
            close() {},
        };
    },
});
