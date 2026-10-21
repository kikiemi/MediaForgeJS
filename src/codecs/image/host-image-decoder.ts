import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { awaitWithAbort } from '../../core/io/abort';
import { copyOutputBytes } from '../../core/bytes/output-data';
import { assertPixels, type AnimatedImage } from './rgba-image';

interface HostImageTrack {
    readonly frameCount: number;
    readonly repetitionCount: number;
    readonly animated: boolean;
}

interface HostImageDecoder {
    readonly tracks: {
        readonly ready: Promise<void>;
        readonly selectedTrack: HostImageTrack | null;
    };
    readonly completed: Promise<void>;
    decode(options?: { frameIndex?: number; completeFramesOnly?: boolean }): Promise<{
        image: {
            readonly displayWidth: number;
            readonly displayHeight: number;
            readonly duration: number | null;
            close(): void;
        };
    }>;
    close(): void;
}

interface HostImageDecoderConstructor {
    new (init: { data: BufferSource | ReadableStream; type: string }): HostImageDecoder;
    isTypeSupported(type: string): Promise<boolean>;
}

function hostImageDecoder(): HostImageDecoderConstructor | undefined {
    const candidate = (globalThis as { ImageDecoder?: unknown }).ImageDecoder;
    return typeof candidate === 'function' ? (candidate as HostImageDecoderConstructor) : undefined;
}

/** Whether the host WebCodecs ImageDecoder exists and accepts the MIME type. */
export async function hostDecodesImage(type: string): Promise<boolean> {
    const decoder = hostImageDecoder();
    if (!decoder) return false;
    try {
        return await decoder.isTypeSupported(type);
    } catch {
        return false;
    }
}

/** RGBA pixels of a decoded host frame, read back through a 2D canvas. */
function readFrame(frame: { displayWidth: number; displayHeight: number }): Uint8ClampedArray {
    const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new MediaForgeError('No 2D context for image frames', 'DECODE');
    context.drawImage(frame as unknown as CanvasImageSource, 0, 0);
    return context.getImageData(0, 0, frame.displayWidth, frame.displayHeight).data;
}

/**
 * Decodes a still or animated image with the host ImageDecoder; frames are returned as straight
 * RGBA. Returns undefined when the host lacks ImageDecoder or the type.
 */
export async function decodeImageWithHost(
    bytes: Uint8Array,
    type: string,
    maxTotalPixels: number,
    signal?: AbortSignal,
): Promise<AnimatedImage | undefined> {
    const Decoder = hostImageDecoder();
    if (!Decoder || !(await hostDecodesImage(type)) || typeof OffscreenCanvas === 'undefined')
        return undefined;
    const decoder = new Decoder({ data: copyOutputBytes(bytes), type });
    try {
        await awaitWithAbort(decoder.tracks.ready, signal);
        const track = decoder.tracks.selectedTrack;
        if (!track)
            throw new MediaForgeError(
                `Host ImageDecoder found no image track in ${type}`,
                'DECODE',
            );
        const count = Math.max(1, track.frameCount || 1);
        const frames: AnimatedImage['frames'] = [];
        let width = 0;
        let height = 0;
        for (let index = 0; index < count; index++) {
            throwIfAborted(signal);
            const { image } = await awaitWithAbort(decoder.decode({ frameIndex: index }), signal);
            try {
                width ||= image.displayWidth;
                height ||= image.displayHeight;
                assertPixels(type, width, height, index + 1, maxTotalPixels);
                frames.push({
                    data: readFrame(image),
                    delayMs: image.duration === null ? 0 : image.duration / 1000,
                });
            } finally {
                image.close();
            }
        }

        const repetitions = track.repetitionCount;
        return {
            width,
            height,
            frames,
            loopCount: !Number.isFinite(repetitions) || repetitions < 0 ? 0 : repetitions + 1,
        };
    } finally {
        decoder.close();
    }
}
