import { EncodeError, MediaForgeError } from '../../core/errors/errors';
import { parseWebpInfo, riffChunk, webpFile } from '../../core/codec-config/image-info';
import { encodeCanvas, type AnimationEncoderOptions } from './encoders';
import type { RgbaImage } from './rgba-image';

/** The options of AnimatedWebpEncoder. */
export interface AnimatedWebpEncoderOptions extends AnimationEncoderOptions {
    /** The quality the host encodes each frame at, 0 to 1; 0.9 by default. */
    readonly quality?: number;
}

interface EncodedFrame {
    readonly chunks: Uint8Array[];
    readonly alpha: boolean;
    readonly durationMs: number;
}

function le24(value: number): [number, number, number] {
    return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

/**
 * Animated WebP writer: each frame is encoded as a still WebP by the host canvas (lossy VP8 with
 * the given quality) and wrapped into ANMF chunks. Frames cover the whole canvas; durations are
 * whole milliseconds.
 */
export class AnimatedWebpEncoder {
    private readonly frames: EncodedFrame[] = [];
    private canvas?: OffscreenCanvas;
    /** The first frame as the host encoded it: a one-frame animation is written as this still. */
    private firstStill?: Uint8Array<ArrayBuffer>;

    /** Total plays; 0 loops forever. */
    readonly loopCount: number;
    private readonly quality?: number;

    /** `width`x`height` frames, at most 16384 a side; loopCount plays, 0 to 65535. */
    constructor(
        readonly width: number,
        readonly height: number,
        options: AnimatedWebpEncoderOptions = {},
    ) {
        if (
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width < 1 ||
            height < 1 ||
            width > 16384 ||
            height > 16384
        )
            throw new MediaForgeError(
                'animated WebP dimensions must be integers from 1 to 16384',
                'INPUT',
            );
        const loopCount = options.loopCount ?? 0;
        if (!Number.isSafeInteger(loopCount) || loopCount < 0 || loopCount > 0xffff)
            throw new MediaForgeError(
                'animated WebP loopCount must be an integer from 0 to 65535',
                'INPUT',
            );
        this.loopCount = loopCount;
        this.quality = options.quality;
    }

    /** True when the host canvas encodes still WebP, which this writer needs for every frame. */
    static async supported(): Promise<boolean> {
        if (typeof OffscreenCanvas === 'undefined') return false;
        try {
            // convertToBlob rejects a canvas that has no rendering context yet.
            const canvas = new OffscreenCanvas(1, 1);
            canvas.getContext('2d');
            const blob = await canvas.convertToBlob({ type: 'image/webp' });
            return blob.type === 'image/webp';
        } catch {
            return false;
        }
    }

    /** Adds a picture of the encoder's size shown for `delayMs`, encoded by the host canvas. */
    async addFrame(image: RgbaImage, delayMs: number): Promise<void> {
        if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 0xffffff)
            throw new MediaForgeError(
                'animated WebP frame delays must be milliseconds from 0 to 16777215',
                'INPUT',
            );
        const rgba = image?.data;
        if (
            !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) ||
            image.width !== this.width ||
            image.height !== this.height ||
            rgba.length !== this.width * this.height * 4
        )
            throw new MediaForgeError('animated WebP frames are RGBA of the encoder size', 'INPUT');
        if (typeof OffscreenCanvas === 'undefined')
            throw new EncodeError(
                'animated WebP output needs the host OffscreenCanvas WebP encoder',
            );
        this.canvas ??= new OffscreenCanvas(this.width, this.height);
        const context = this.canvas.getContext('2d');
        if (!context) throw new MediaForgeError('No 2D context', 'ENCODE');
        const pixels =
            rgba instanceof Uint8ClampedArray && rgba.buffer instanceof ArrayBuffer
                ? rgba
                : new Uint8ClampedArray(rgba);
        context.putImageData(
            new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, this.width, this.height),
            0,
            0,
        );
        const still = await encodeCanvas(this.canvas, 'webp', this.quality);
        const info = parseWebpInfo(still);
        const chunks = (info.stillChunks ?? []).map(chunk =>
            still.slice(chunk.start, chunk.end + ((chunk.end - chunk.start) & 1)),
        );
        if (!chunks.length) throw new EncodeError('host WebP encoder returned no image chunk');
        if (!this.frames.length) this.firstStill = still;
        this.frames.push({
            chunks,
            alpha: info.hasAlpha === true,
            durationMs: Math.round(delayMs),
        });
    }

    /** The WebP of the frames added. */
    async encode(): Promise<Uint8Array<ArrayBuffer>> {
        if (!this.frames.length) throw new EncodeError('animated WebP needs at least one frame');

        // One frame is a still: written as one, which every WebP reader shows (ffmpeg's reads no
        // animated WebP).
        if (this.frames.length === 1 && this.firstStill) return this.firstStill;
        const alpha = this.frames.some(frame => frame.alpha);
        const vp8x = new Uint8Array(10);
        vp8x[0] = 0x02 | (alpha ? 0x10 : 0);
        vp8x.set(le24(this.width - 1), 4);
        vp8x.set(le24(this.height - 1), 7);
        const anim = new Uint8Array(6);
        anim[4] = this.loopCount & 0xff;
        anim[5] = (this.loopCount >> 8) & 0xff;
        const parts: Uint8Array[] = [riffChunk('VP8X', vp8x), riffChunk('ANIM', anim)];
        for (const frame of this.frames) {
            const body = frame.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const payload = new Uint8Array(16 + body);
            payload.set(le24(this.width - 1), 6);
            payload.set(le24(this.height - 1), 9);
            payload.set(le24(frame.durationMs), 12);

            // Full-canvas frames replace the previous one: no alpha blending, no dispose.
            payload[15] = 0x02;
            let at = 16;
            for (const chunk of frame.chunks) {
                payload.set(chunk, at);
                at += chunk.length;
            }
            parts.push(riffChunk('ANMF', payload));
        }
        return webpFile(parts);
    }
}
