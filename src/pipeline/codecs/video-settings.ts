import { codecFamily } from '../../core/model/codec-strings';

/**
 * Default bitrate in bits per second: 6.5 Mbit/s for 1080p30 H.264, scaled by pixel count and frame
 * rate to the power 0.75 and by codec efficiency, never below 100 kbit/s.
 */
export function defaultVideoBitrate(
    codec: string,
    width: number,
    height: number,
    framerate: number,
): number {
    const family = codecFamily(codec);
    const efficiency =
        family === 'av01'
            ? 0.5
            : family === 'vp09' || family === 'hvc1' || family === 'hev1'
              ? 0.6
              : 1;
    const pixels = Math.max(1, width * height) / (1920 * 1080);
    const rate = Math.max(1, framerate || 30) / 30;
    return Math.max(100_000, Math.round(6_500_000 * pixels ** 0.75 * rate ** 0.75 * efficiency));
}
