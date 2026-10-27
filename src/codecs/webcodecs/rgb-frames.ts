import type { CodecLifetime } from '../shared/codec-lifetime';
import { closeCodec } from './codec';

// RGB frames for host video encoders that turn them into Y'CbCr with another matrix than the one
// they report; loaded only where an RGB frame is encoded.

/** The bytes of red, green and blue in a pixel of each 8-bit RGB frame format. */
const CHANNELS: Readonly<Record<string, readonly [number, number, number]>> = {
    RGBA: [0, 1, 2],
    RGBX: [0, 1, 2],
    BGRA: [2, 1, 0],
    BGRX: [2, 1, 0],
};

/** Luma coefficient of red in the matrices an encoder may report. */
const RED_LUMA: Readonly<Record<string, number>> = {
    bt709: 0.2126,
    bt470bg: 0.299,
    smpte170m: 0.299,
    'bt2020-ncl': 0.2627,
};

const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } as const;

/** Whether the host's video encoders convert RGB as they report, by VideoEncoder class. */
const rgbChecks = new WeakMap<object, Promise<boolean>>();

/**
 * Whether the host's video encoders turn RGB frames into Y'CbCr with the matrix and range they
 * report, probed once on VP8: the luma of a canvas painted red tells the matrix. Safari converts
 * with BT.601 and reports BT.709, so its pictures decode with shifted colours. Encoders that report
 * no matrix, and a host without VP8 or OffscreenCanvas, are taken to.
 */
function encodesRgbAsReported(): Promise<boolean> {
    const host = globalThis.VideoEncoder;
    let known = rgbChecks.get(host);
    if (!known) rgbChecks.set(host, (known = probeRgbMatrix()));
    return known;
}

async function probeRgbMatrix(): Promise<boolean> {
    if (typeof OffscreenCanvas !== 'function') return true;
    const [width, height] = [32, 16];
    const chunks: EncodedVideoChunk[] = [];
    const pictures: VideoFrame[] = [];
    let reported: VideoColorSpaceInit | undefined;
    let frame: VideoFrame | undefined;
    let encoder: VideoEncoder | undefined;
    let decoder: VideoDecoder | undefined;
    try {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#f00';
        context.fillRect(0, 0, width, height);
        frame = new VideoFrame(canvas, { timestamp: 0 });
        encoder = new VideoEncoder({
            output: (chunk, metadata) => {
                chunks.push(chunk);
                reported ??= metadata?.decoderConfig?.colorSpace;
            },
            error: () => {},
        });
        encoder.configure({ codec: 'vp8', width, height });
        encoder.encode(frame, { keyFrame: true });
        await encoder.flush();
        const coefficient = RED_LUMA[reported?.matrix ?? ''];
        if (coefficient === undefined) return true;
        decoder = new VideoDecoder({ output: picture => pictures.push(picture), error: () => {} });
        decoder.configure({ codec: 'vp8' });
        for (const chunk of chunks) decoder.decode(chunk);
        await decoder.flush();
        const [picture] = pictures;
        if (!picture?.format || CHANNELS[picture.format]) return true;
        const data = new Uint8Array(picture.allocationSize());
        const [luma] = await picture.copyTo(data);
        const measured = data[luma!.offset + (height / 2) * luma!.stride + width / 2]!;
        const expected = reported!.fullRange ? 255 * coefficient : 16 + 219 * coefficient;
        return Math.abs(measured - expected) <= 8;
    } catch {
        return true;
    } finally {
        frame?.close();
        for (const picture of pictures) picture.close();
        closeCodec(encoder);
        closeCodec(decoder);
    }
}

/**
 * The visible picture of `frame`, of an 8-bit RGB format, as BT.709 I420 of limited range where
 * the host's encoders convert RGB otherwise than they report: a copy, which the caller closes.
 * Undefined where they convert it as reported, or for another format.
 */
export async function reportedYuvFrame(
    frame: VideoFrame,
    lifetime: CodecLifetime,
): Promise<VideoFrame | undefined> {
    const channels = CHANNELS[frame.format ?? ''];
    if (!channels || !frame.visibleRect || (await lifetime.waitFor(encodesRgbAsReported())))
        return undefined;
    const { width, height } = frame.visibleRect;
    const data = new Uint8Array(frame.allocationSize());
    const [plane] = await lifetime.waitFor(frame.copyTo(data));
    return new VideoFrame(i420Of(data, plane!, width, height, channels), {
        format: 'I420',
        codedWidth: width,
        codedHeight: height,
        timestamp: frame.timestamp,
        duration: frame.duration ?? undefined,
        displayWidth: frame.displayWidth,
        displayHeight: frame.displayHeight,
        colorSpace: BT709,
    });
}

/**
 * BT.709 I420 of limited range from 8-bit RGB pixels at `plane`, whose bytes of red, green and
 * blue are `channels`; each chroma sample is that of the mean of the pixels it covers.
 */
function i420Of(
    data: Uint8Array,
    plane: PlaneLayout,
    width: number,
    height: number,
    [red, green, blue]: readonly [number, number, number],
): Uint8Array<ArrayBuffer> {
    const [kr, kb] = [0.2126, 0.0722];
    const kg = 1 - kr - kb;
    const chromaWidth = (width + 1) >> 1;
    const chromaHeight = (height + 1) >> 1;
    const out = new Uint8Array(width * height + 2 * chromaWidth * chromaHeight);
    const uPlane = width * height;
    const vPlane = uPlane + chromaWidth * chromaHeight;
    for (let cy = 0; cy < chromaHeight; cy++)
        for (let cx = 0; cx < chromaWidth; cx++) {
            let [sumR, sumG, sumB, count] = [0, 0, 0, 0];
            for (let y = 2 * cy; y < Math.min(height, 2 * cy + 2); y++)
                for (let x = 2 * cx; x < Math.min(width, 2 * cx + 2); x++) {
                    const at = plane.offset + y * plane.stride + 4 * x;
                    const [r, g, b] = [data[at + red]!, data[at + green]!, data[at + blue]!];
                    out[y * width + x] = Math.round(16 + (219 * (kr * r + kg * g + kb * b)) / 255);
                    [sumR, sumG, sumB] = [sumR + r, sumG + g, sumB + b];
                    count++;
                }
            const [r, g, b] = [sumR / count, sumG / count, sumB / count];
            const luma = kr * r + kg * g + kb * b;
            const at = cy * chromaWidth + cx;
            out[uPlane + at] = Math.round(128 + (224 * (b - luma)) / (2 * (1 - kb)) / 255);
            out[vPlane + at] = Math.round(128 + (224 * (r - luma)) / (2 * (1 - kr)) / 255);
        }
    return out;
}
