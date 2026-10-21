/** Audio bitrate in bits per second of lossy encoders when the request sets none. */
export const DEFAULT_AUDIO_BITRATE = 128_000;

/**
 * Kilobits per second of a bitrate in bits per second, as the audio encoders take it: rounded, at
 * least 1.
 */
export function bitrateKbps(bitsPerSecond: number): number {
    return Math.max(1, Math.round(bitsPerSecond / 1000));
}

/** Kilobits per second of an optional bitrate. */
export function optionalKbps(bitsPerSecond: number | undefined): number | undefined {
    return bitsPerSecond === undefined ? undefined : bitrateKbps(bitsPerSecond);
}
