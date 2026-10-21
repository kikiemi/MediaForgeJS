import { MediaForgeError } from '../core/errors/errors';
import type { MediaDiagnostic } from '../core/errors/diagnostics';
import { OptionNormalizer, resolveOptionPolicy } from '../core/errors/option-policy';
import { canonicalAudioCodec, canonicalVideoCodec } from '../core/model/codec-names';
import { canonicalFormat } from '../formats/shared/names';
import { captureStream } from '../recording/capture';
import {
    frameReader,
    type FrameStream,
    type PcmBlock,
    type Pull,
} from '../recording/frame-streams';
import { encodeStreams, type EncodeRequest } from '../recording/encode-frames';
import { MissingParts, type PluginCatalog } from '../pipeline/plugins/missing-parts';
import type { StreamingAudioCodecs } from '../pipeline/codecs/streaming-audio-output-core';
import { FRAME_ENCODE_FORMATS } from '../pipeline/plan/format-policy';
import { QUALITY_SCALE } from '../pipeline/plan/encode-settings';
import { codecPreferenceOf } from './options/options';
import { progressReporter } from './operation';
import { snapshotEncoderSettings } from './options/encoder-settings';
import { stageOption } from './options/requests';
import type { StageDefinition } from '../core/contracts/stage';
import { mediaResult, warningCollector } from './results';
import type { MediaPlan, MediaResult, VideoQuality } from './types';
import type {
    EncodeAudioSettings,
    EncodeFramesOptions,
    EncodeSources,
    EncodeVideoSettings,
    MediaRecording,
    RecordStreamOptions,
} from './encode-options';

/**
 * What an encode uses of the plugins of its MediaForge: their stages, their audio encoders (the
 * aac plugin's AAC-LC encoder takes over from a missing host encoder) and the catalog that names
 * a plugin left out.
 */
export interface EncodeParts {
    readonly stages: readonly StageDefinition[];
    readonly audioEncoders: StreamingAudioCodecs;
    readonly catalog: PluginCatalog;
}

/** An encode without plugins. */
const NO_PARTS: EncodeParts = { stages: [], audioEncoders: {}, catalog: [] };

/** Option keys of encodeFrames() and recordStream(); unknown ones are reported. */
const ENCODE_KEYS = [
    'to',
    'video',
    'audio',
    'duration',
    'maxBytes',
    'signal',
    'onProgress',
    'onPlan',
    'onWarning',
    'optionPolicy',
    'codecPreference',
];
const ENCODE_VIDEO_KEYS = [
    'codec',
    'width',
    'height',
    'fps',
    'bitrate',
    'quality',
    'keyframeInterval',
    'hardwareAcceleration',
    'latencyMode',
    'bitrateMode',
    'stages',
];
const ENCODE_AUDIO_KEYS = ['codec', 'bitrate'];

/**
 * Encodes pictures and sound you produce into a file: VideoFrames from a canvas, a decoder or a
 * camera, and AudioData. Frames are encoded by the host WebCodecs VideoEncoder with backpressure,
 * so a producer that awaits the loop never runs far ahead; each VideoFrame and AudioData is closed
 * once encoded. Timestamps are kept relative to the first frame. AAC falls back to the built-in
 * encoder when the host has none.
 *
 * @example
 * ```ts
 * import { encodeFrames } from 'mediaforgejs';
 *
 * async function* frames(canvas: OffscreenCanvas) {
 *     for (let index = 0; index < 90; index++) {
 *         draw(canvas, index);
 *         yield new VideoFrame(canvas, { timestamp: (index * 1e6) / 30, duration: 1e6 / 30 });
 *     }
 * }
 * const video = { codec: 'auto', fps: 30 };
 * const { blob } = await encodeFrames(frames(canvas), { to: 'mp4', video });
 * ```
 */
export async function encodeFrames(
    source: FrameStream<VideoFrame> | EncodeSources,
    options: EncodeFramesOptions = {},
    parts: EncodeParts = NO_PARTS,
): Promise<MediaResult> {
    if (!source || typeof source !== 'object')
        throw new MediaForgeError('Expected frames to encode', 'INPUT', {
            hint: 'Pass an iterable or ReadableStream of VideoFrame, or { video, audio }.',
        });
    const sources: EncodeSources =
        'video' in source || 'audio' in source
            ? (source as EncodeSources)
            : { video: source as FrameStream<VideoFrame> };
    return runEncode(
        {
            video: sources.video && frameReader(sources.video),
            audio: sources.audio && frameReader(sources.audio),
        },
        options,
        {},
        parts,
    );
}

/**
 * Records a MediaStream (camera, microphone, screen, `canvas.captureStream()`) into a file with
 * WebCodecs. Frames are read with MediaStreamTrackProcessor where the browser has it, otherwise
 * from a video element and the Web Audio API. Video defaults to `latencyMode: 'realtime'`.
 *
 * @example
 * ```ts
 * import { recordStream } from 'mediaforgejs';
 *
 * const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
 * const recording = recordStream(stream, { to: 'webm' });
 * stopButton.onclick = async () => {
 *     const { blob, filename } = await recording.stop();
 *     stream.getTracks().forEach(track => track.stop());
 *     download(blob, filename);
 * };
 * ```
 */
export function recordStream(
    stream: MediaStream,
    options: RecordStreamOptions = {},
    parts: EncodeParts = NO_PARTS,
): MediaRecording {
    const { maxDuration, ...rest } = options;
    const collector = warningCollector(options.onWarning);
    const { video, audio, audioUnavailable } = captureStream(stream, options.audio !== false);
    if (audioUnavailable)
        collector.onWarning(
            Object.freeze({
                code: 'RECORD_AUDIO_UNAVAILABLE',
                message: 'This browser cannot record MediaStream audio: the recording is silent',
                severity: 'warning',
            }),
        );

    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> =>
        (stopping ??= Promise.all([video?.stop(), audio?.stop()]).then(() => undefined));
    const timer =
        maxDuration !== undefined && Number.isFinite(maxDuration) && maxDuration > 0
            ? setTimeout(() => void stop(), maxDuration * 1000)
            : undefined;

    const result = runEncode(
        { video, audio },
        {
            ...rest,
            video: { latencyMode: 'realtime', ...rest.video },
            onWarning: collector.onWarning,
        },
        { warnings: collector.warnings },
        parts,
    ).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
    result.catch(() => undefined);

    return {
        result,
        async stop() {
            await stop();
            return result;
        },
    };
}

/**
 * Encodes the sources into one file; `recorded` shares the warnings list of recordStream's
 * collector.
 */
async function runEncode(
    sources: { readonly video?: Pull<VideoFrame>; readonly audio?: Pull<AudioData | PcmBlock> },
    options: EncodeFramesOptions,
    recorded: { readonly warnings?: MediaDiagnostic[] },
    parts: EncodeParts,
): Promise<MediaResult> {
    const collector = recorded.warnings
        ? { warnings: recorded.warnings, onWarning: options.onWarning ?? (() => undefined) }
        : warningCollector(options.onWarning);

    const normalizer = new OptionNormalizer(
        resolveOptionPolicy(options.optionPolicy),
        'encode options',
    );
    const format = (canonicalFormat(options.to ?? 'mp4') ?? 'mp4') as EncodeRequest['format'];
    if (!FRAME_ENCODE_FORMATS.includes(format))
        throw new MediaForgeError(
            `Frames are encoded into ${FRAME_ENCODE_FORMATS.join(', ')}, not ` +
                `${JSON.stringify(options.to)}`,
            'INPUT',
            {
                hint: "Encode into 'mp4' or 'webm', then convert() the file.",
            },
        );

    normalizer.keys(options, ENCODE_KEYS);
    const nested = <T extends object>(
        value: T | undefined | false,
        known: readonly string[],
        scope: string,
    ): T => {
        if (value === undefined || value === false) return {} as T;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            normalizer.ignore(scope, value, 'must be an object');
            return {} as T;
        }
        return normalizer.keys(value, known) as T;
    };
    const videoSettings = nested<EncodeVideoSettings>(options.video, ENCODE_VIDEO_KEYS, 'video');
    const audioSettings =
        options.audio === false
            ? undefined
            : nested<EncodeAudioSettings>(options.audio, ENCODE_AUDIO_KEYS, 'audio');
    const videoBitrate = normalizer.bitrate('video.bitrate', videoSettings.bitrate, 'video');
    const audioBitrate =
        normalizer.bitrate('audio.bitrate', audioSettings?.bitrate, 'audio') ?? 128_000;
    const fps = normalizer.number('video.fps', videoSettings.fps, {
        positive: true,
        max: 300,
        fallback: 30,
    })!;
    const keyframeInterval = normalizer.number(
        'video.keyframeInterval',
        videoSettings.keyframeInterval,
        {
            min: 0,
            max: 3600,
            fallback: 2,
        },
    )!;
    const size = { integer: true, positive: true, max: 16384 };
    const width = normalizer.number('video.width', videoSettings.width, size);
    const height = normalizer.number('video.height', videoSettings.height, size);
    const quality = normalizer.choice(
        'video.quality',
        videoSettings.quality,
        Object.keys(QUALITY_SCALE) as VideoQuality[],
        {
            optional: true,
        },
    );
    const encoderSettings = snapshotEncoderSettings(normalizer, videoSettings);
    const codecOf = (
        option: string,
        value: unknown,
        canonical: (name: string) => string,
    ): string => {
        if (value === undefined) return 'auto';
        if (typeof value === 'string' && value.trim()) return canonical(value);
        normalizer.ignore(option, value, 'must be a codec name');
        return 'auto';
    };
    const videoCodec = codecOf('video.codec', videoSettings.codec, canonicalVideoCodec);
    const audioCodec = codecOf('audio.codec', audioSettings?.codec, canonicalAudioCodec);
    const duration = normalizer.number('duration', options.duration, { positive: true });
    const preference = codecPreferenceOf(normalizer, options.codecPreference) ?? 'webcodecs';

    for (const finding of normalizer.findings)
        collector.onWarning(
            Object.freeze({ code: finding.code, message: finding.message, severity: 'warning' }),
        );
    const progress = progressReporter(options.onProgress, 'encode', duration);
    const { blob, plan } = await encodeStreams(sources, {
        format,
        video: {
            codec: videoCodec,
            width,
            height,
            fps,
            bitrate: videoBitrate,
            quality,
            keyframeInterval,
            stages: stageOption('video', videoSettings.stages, parts.stages),
            ...encoderSettings,
        },
        ...(audioSettings ? { audio: { codec: audioCodec, bitrate: audioBitrate } } : {}),
        duration,
        maxBytes: options.maxBytes ?? 256 * 1024 * 1024,
        preference,
        strict: normalizer.policy === 'strict',
        signal: options.signal,
        onPlan: options.onPlan as ((plan: MediaPlan) => void) | undefined,
        onProgress: progress.callback,
        onWarning: collector.onWarning,
        audioEncoders: parts.audioEncoders,
        missing: new MissingParts(parts.catalog),
    });
    progress.finish();
    return mediaResult(blob, format, plan, collector.warnings, undefined);
}
