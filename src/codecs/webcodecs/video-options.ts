// The host video encoder settings the API takes, apart from the encoder behind them.

/** WebCodecs `hardwareAcceleration`: a hint the host may ignore, not a guarantee. */
export type VideoEncoderHardwareAcceleration =
    'no-preference' | 'prefer-hardware' | 'prefer-software';

/**
 * WebCodecs `latencyMode`: 'quality' (default) or 'realtime' for live capture, which may drop
 * quality.
 */
export type VideoEncoderLatencyMode = 'quality' | 'realtime';

/**
 * WebCodecs `bitrateMode`: 'variable' lets the rate follow the picture, 'constant' holds it steady.
 */
export type VideoEncoderBitrateControl = 'constant' | 'variable';

/** Settings passed through to the host VideoEncoder configuration. */
export interface HostVideoEncoderOptions {
    readonly hardwareAcceleration?: VideoEncoderHardwareAcceleration;
    readonly latencyMode?: VideoEncoderLatencyMode;
    readonly bitrateMode?: VideoEncoderBitrateControl;
}
