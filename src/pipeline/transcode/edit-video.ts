import type { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import { MediaForgeError, errorMessage } from '../../core/errors/errors';
import type { FramePainter } from '../../stages/frame-transform';
import type { ResolvedFade, ResolvedOverlay } from './edit-types';

/** An overlay with its decoded picture, ready to draw. */
export interface PaintedOverlay {
    readonly overlay: ResolvedOverlay;
    readonly bitmap?: ImageBitmap;
}

/** Decodes the encoded overlay images; text overlays need no picture. */
export async function loadOverlays(
    overlays: readonly ResolvedOverlay[],
    lifetime: CodecLifetime,
): Promise<PaintedOverlay[]> {
    const loaded: PaintedOverlay[] = [];
    for (const overlay of overlays) {
        if (overlay.kind === 'text') {
            loaded.push({ overlay });
            continue;
        }
        if (typeof createImageBitmap !== 'function')
            throw new MediaForgeError('Image overlays need the host createImageBitmap', 'ENCODE');

        const input = overlay.input;
        const blob =
            typeof Blob !== 'undefined' && input instanceof Blob
                ? input
                : new Blob([
                      (input instanceof ArrayBuffer
                          ? input
                          : new Uint8Array(
                                (input as ArrayBufferView).buffer,
                                (input as ArrayBufferView).byteOffset,
                                (input as ArrayBufferView).byteLength,
                            )) as BlobPart,
                  ]);

        try {
            loaded.push({ overlay, bitmap: await lifetime.waitFor(createImageBitmap(blob)) });
        } catch (error) {
            for (const entry of loaded) entry.bitmap?.close();
            if (error instanceof MediaForgeError) throw error;
            throw new MediaForgeError(
                `Overlay image could not be decoded: ${errorMessage(error)}`,
                'DECODE',
            );
        }
    }
    return loaded;
}

export function releaseOverlays(overlays: readonly PaintedOverlay[]): void {
    for (const entry of overlays) entry.bitmap?.close();
}

/**
 * Gain of a fade at `time` seconds into a span of `duration` seconds, from 0 (background) to 1
 * (picture).
 */
function fadeGain(fade: ResolvedFade, time: number, duration: number): number {
    let gain = 1;
    if (fade.in > 0) gain = Math.min(gain, time / fade.in);
    if (fade.out > 0) gain = Math.min(gain, (duration - time) / fade.out);
    return Math.max(0, Math.min(1, gain));
}

/**
 * What to draw over the picture of a clip shown at an output time: the clip's fades toward
 * `background` and the overlays shown then; undefined when the picture passes through untouched.
 */
export function overlayPainter(
    overlays: readonly PaintedOverlay[],
    background: string,
    width: number,
    height: number,
): (
    clip: { readonly offset: number; readonly duration: number; readonly fade: ResolvedFade },
    time: number,
) => FramePainter | undefined {
    return (clip, time) => {
        const gain = fadeGain(clip.fade, time - clip.offset, clip.duration);
        const shown = overlays.filter(
            ({ overlay }) =>
                time >= overlay.start && (overlay.end === undefined || time < overlay.end),
        );
        if (gain >= 1 && !shown.length) return undefined;
        return context => {
            if (gain < 1) {
                context.globalAlpha = 1 - gain;
                context.fillStyle = background;
                context.fillRect(0, 0, width, height);
            }

            for (const { overlay, bitmap } of shown) {
                context.globalAlpha = overlay.opacity;
                if (overlay.kind === 'text') {
                    context.font = `${overlay.size}px ${overlay.font}`;
                    context.fillStyle = overlay.color;
                    context.textBaseline = 'top';
                    context.fillText(overlay.text, overlay.x, overlay.y);
                } else if (bitmap) {
                    const drawWidth =
                        overlay.width ??
                        (overlay.height === undefined
                            ? bitmap.width
                            : (overlay.height * bitmap.width) / bitmap.height);
                    const drawHeight =
                        overlay.height ??
                        (overlay.width === undefined
                            ? bitmap.height
                            : (overlay.width * bitmap.height) / bitmap.width);
                    context.drawImage(bitmap, overlay.x, overlay.y, drawWidth, drawHeight);
                }
            }
            context.globalAlpha = 1;
        };
    };
}
