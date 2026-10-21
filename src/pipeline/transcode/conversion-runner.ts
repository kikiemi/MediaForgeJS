import { audioEncoderOrder, plannedAudioEncoder } from '../codecs/router';
import type { FormatWriters } from '../plugins/missing-parts';
import { createContainerAudioEncoder } from '../codecs/container-audio';
import type { StreamingAudioCodecs } from '../codecs/streaming-audio-output-core';
import type { RemuxOptions, RemuxTrack } from '../media-types';
import type { MediaFile } from '../read/media-file';
import { presentationEnd } from '../copy/trim-plan';
import { matroskaOutputMetadata } from '../copy/track-metadata';
import type { Source } from '../../core/model/types';
import { mediaFileState } from '../read/file-state';
import { DiagnosticContext, type MediaDiagnostic } from '../../core/errors/diagnostics';
import { MediaForgeError } from '../../core/errors/errors';
import { DEFAULT_AUDIO_BITRATE } from '../plan/encode-settings';
import { coveredDuration, speedDuration } from '../plan/media-plan';
import { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import { awaitWithAbort, linkAbortSignals } from '../../core/io/abort';
import { hostAudioDecoderConfig } from '../../codecs/webcodecs/audio';
import { queryHostCodec } from '../../codecs/webcodecs/support';
import type { BuiltinVideoCodec, BuiltinAudioDecoder } from '../../core/contracts/decoder';
import { selectEncoderConfig, hostVideoDecoderConfig } from '../../codecs/webcodecs/video';
import type { HostVideoEncoderOptions } from '../../codecs/webcodecs/video-options';
import { chooseVideoDecoder } from '../codecs/frame-codecs';
import type { ConvertRequest, ConversionRunner, AudioTrackDecoder } from '../types';
import type { TrackPlan } from '../api-types';
import type { TimelineEnvironment, TimelineJob } from './timeline';
import {
    planConversion,
    encodedAudioTarget,
    forwardDiagnostics,
    type ConversionPlan,
    type VideoDecoderPreference,
} from '../plan/conversion-plan';
import type { VideoCodecProvider } from '../../core/contracts/encoder';
import type { StageFactory } from '../../stages/chain';
import type { AudioStage, StageDefinition, VideoStage } from '../../core/contracts/stage';
import { changesSpeed, outputFps } from '../plan/conversion-plan';

interface ConversionRunnerOptions {
    readonly writers: FormatWriters;
    /**
     * Software video decoders tried when the host VideoDecoder is missing or rejects the stream;
     * default none.
     */
    readonly videoDecoders?: readonly BuiltinVideoCodec[];
    /**
     * webcodecs (default) tries the host VideoDecoder first, builtin the software decoders first.
     */
    readonly codecPreference?: 'webcodecs' | 'builtin';
    /** Decodes audio for trimmed re-encodes; omitted leaves their audio undecodable. */
    readonly audioDecoder?: AudioTrackDecoder;
    /**
     * Built-in encoders for FLAC, MP2 and MP3 container tracks the host AudioEncoder cannot write;
     * default none.
     */
    readonly audioEncoders?: StreamingAudioCodecs;
    /** Plugin audio decoders for re-encoded audio tracks, besides the core's; default none. */
    readonly audioDecoders?: readonly BuiltinAudioDecoder[];
    /**
     * Application video codecs, which decode and encode their codecs before the host's; default
     * none.
     */
    readonly providers?: readonly VideoCodecProvider[];
    /** The plugins' processing stages, which `video.stages` and `audio.stages` name. */
    readonly stages?: readonly StageDefinition[];
}

/** The host VideoEncoder settings a request names. */
function encoderOptions(request: HostVideoEncoderOptions): HostVideoEncoderOptions {
    return {
        hardwareAcceleration: request.hardwareAcceleration,
        latencyMode: request.latencyMode,
        bitrateMode: request.bitrateMode,
    };
}

/**
 * Fails with `code` unless the host codec accepts `config`; a rejected configuration names the
 * host's reason.
 */
async function requireHostCodec(
    kind: 'AudioDecoder' | 'AudioEncoder',
    config: AudioDecoderConfig | AudioEncoderConfig | null,
    signal: AbortSignal,
    code: 'DECODE' | 'ENCODE',
    codec: string,
): Promise<void> {
    const support = config ? await awaitWithAbort(queryHostCodec(kind, config), signal) : undefined;
    if (support?.error)
        throw new MediaForgeError(
            `The host rejected the codec configuration: ${support.error}`,
            code,
        );
    if (!support?.supported) throw new MediaForgeError(`${kind} does not support '${codec}'`, code);
}

async function checkCapabilities(
    plan: ConversionPlan,
    signal: AbortSignal,
    videoDecoders: VideoDecoderPreference,
    encoder: HostVideoEncoderOptions,
    request: ConvertRequest,
): Promise<void> {
    if (plan.video && !plan.videoCopy && plan.geometry) {
        const track = plan.video.info;
        const configs = track.codecConfigurations?.length ? track.codecConfigurations : [track];
        for (const config of plan.videoDecoder ? [] : configs)
            await chooseVideoDecoder(
                hostVideoDecoderConfig({
                    codec: config.codec,
                    width: config.width ?? track.width,
                    height: config.height ?? track.height,
                    codecConfig: config.codecConfig,
                    colour: track.colour,
                }),
                videoDecoders.decoders,
                videoDecoders.preference,
                pending => awaitWithAbort(pending, signal),
                videoDecoders.missing,
            );

        const lifetime = new CodecLifetime(
            signal,
            new MediaForgeError('Video capability check stopped', 'ENCODE'),
        );
        try {
            if (!plan.videoEncoder) {
                const selected = await selectEncoderConfig(
                    {
                        codec: plan.videoCodec,
                        explicit: !!plan.videoProfileSet,
                        width: plan.geometry.width,
                        height: plan.geometry.height,
                        framerate: plan.framerate!,
                        bitrate: plan.videoBitrate!,
                        bitDepth:
                            track.colour?.transfer === 16 || track.colour?.transfer === 18 ? 10 : 8,
                        container: request.format,
                        ...encoder,
                    },
                    lifetime,
                );
                plan.videoCodec = selected.codec;
            }
        } finally {
            lifetime.stop();
        }
    }

    if (plan.audio && !plan.audioCopy) {
        const track = plan.audio.info;
        if (!plan.builtinAudioDecode) {
            const configs = track.codecConfigurations?.length ? track.codecConfigurations : [track];
            for (const config of configs)
                await requireHostCodec(
                    'AudioDecoder',
                    hostAudioDecoderConfig({
                        ...track,
                        codec: config.codec,
                        sampleRate: config.sampleRate ?? track.sampleRate,
                        channelCount: config.channelCount ?? track.channelCount,
                        codecConfig: config.codecConfig,
                    }),
                    signal,
                    'DECODE',
                    config.codec,
                );
        }

        if (!plan.builtinAudioEncode) {
            const target = encodedAudioTarget(track, plan.audioCodec, request);
            await requireHostCodec(
                'AudioEncoder',
                {
                    codec: plan.audioCodec,
                    sampleRate: target.rate,
                    numberOfChannels: target.channels,
                    bitrate: request.audioBitrate || DEFAULT_AUDIO_BITRATE,
                },
                signal,
                'ENCODE',
                plan.audioCodec,
            );
        }
    }
}

/**
 * The names of a lane's stages for its report entry: the target's, then those of the speed and the
 * rate.
 */
function stageNames(
    stages: readonly StageFactory<VideoStage | AudioStage>[] | undefined,
    added: readonly string[] = [],
): { stages?: string[] } {
    const names = [...(stages ?? []).map(stage => stage.name), ...added];
    return names.length ? { stages: names } : {};
}

/** The stages a speed or frame rate adds to the video lane, after the target's. */
function retimeStageNames(request: ConvertRequest, fps: number | undefined): string[] {
    const names = changesSpeed(request) ? ['speed'] : [];
    if (fps !== undefined) names.push('fps');
    return names;
}

/** The stage a speed adds to the sound. */
function soundSpeedStageNames(request: ConvertRequest): string[] {
    return changesSpeed(request)
        ? [request.audioSpeed === 'shift-pitch' ? 'resample' : 'time-stretch']
        : [];
}

/** What the plan does with each selected track; `encoder` names the implementation tried first. */
function trackPlans(
    plan: ConversionPlan,
    request: ConvertRequest,
    preference: 'webcodecs' | 'builtin',
): TrackPlan[] {
    const fps = plan.video ? outputFps(request, plan.video.info) : undefined;
    return plan.tracks.map(track => {
        const copy: TrackPlan = {
            trackId: track.description.id,
            type: track.type,
            action: 'copy',
            sourceCodec: track.info.codec,
            codec: track.info.codec,
        };
        if (plan.copy) return copy;
        if (track === plan.video && !plan.videoCopy)
            return {
                ...copy,
                action: 'encode',
                codec: plan.videoCodec,
                encoder: plan.videoEncoder ? 'plugin' : 'webcodecs',
                ...(plan.geometry
                    ? { width: plan.geometry.width, height: plan.geometry.height }
                    : {}),
                ...(fps !== undefined ? { fps } : {}),
                ...stageNames(request.videoStages, retimeStageNames(request, fps)),
            };

        if (track === plan.audio && !plan.audioCopy) {
            const codec = plan.audioCodec;
            const encoder = plannedAudioEncoder(
                audioEncoderOrder(
                    codec,
                    plan.builtinAudioEncode,
                    preference,
                    plan.audioSampleFormat,
                ),
            );
            const target = encodedAudioTarget(track.info, codec, request);
            return {
                ...copy,
                action: 'encode',
                codec,
                encoder,
                sampleRate: target.rate,
                channels: target.channels,
                ...stageNames(request.audioStages, soundSpeedStageNames(request)),
            };
        }
        return copy;
    });
}

/**
 * The single-clip timeline a native conversion runs: the selected range of one video and one audio
 * track.
 */
function conversionJob(
    file: MediaFile,
    plan: ConversionPlan,
    request: ConvertRequest,
    encoder: HostVideoEncoderOptions,
): TimelineJob {
    const state = mediaFileState(file);
    const base = file.timelineStart;
    const lanes = [plan.video, plan.audio].filter(
        (track): track is RemuxTrack => track !== undefined,
    );
    const start = base + (request.start ?? 0);
    const end = request.end === undefined ? undefined : base + request.end;
    const trackEnd = Math.max(...lanes.map(presentationEnd));
    if (!Number.isFinite(trackEnd))
        throw new MediaForgeError(
            'The selected tracks hold no complete samples to convert',
            'FORMAT',
        );

    const stop = Math.min(end ?? trackEnd, trackEnd);
    if (start >= stop)
        throw new MediaForgeError(
            `start ${request.start ?? 0} s is at or after the end at ${(stop - base).toFixed(3)} s`,
            'INPUT',
        );

    const video = plan.video?.info;
    const format = request.format;
    const speed = request.speed ?? 1;

    return {
        sink: { kind: 'container', format },
        clips: [
            {
                input: file as unknown as Source,
                file,
                picture: plan.video,
                sound: plan.audio,
                start,
                ...(end === undefined ? {} : { end }),
                stop,
                speed,
                offset: 0,
                duration: (stop - start) / speed,
                geometry: plan.geometry,
                video: {
                    fade: { in: 0, out: 0 },
                    changed: false,
                },
                audio: {
                    volume: 1,
                    fade: { in: 0, out: 0 },
                    mute: false,
                    speed: request.audioSpeed,
                },
            },
        ],
        layers: [],
        copies: plan.copies,
        overlays: [],
        background: '#000',
        video: !video
            ? undefined
            : plan.videoCopy
              ? { action: 'copy' }
              : {
                    action: 'encode',
                    codec: plan.videoCodec,
                    explicit: !!plan.videoProfileSet,
                    fps: outputFps(request, video),
                    framerate: plan.framerate!,
                    bitrate: plan.videoEncoder ? request.videoBitrate : plan.videoBitrate,
                    keyframeInterval: request.keyframeInterval ?? 2,
                    encoder,
                    bitDepth:
                        video.colour?.transfer === 16 || video.colour?.transfer === 18 ? 10 : 8,
                    rotation: plan.videoRotation,
                    stages: request.videoStages ?? [],
                    encodeWith: plan.videoEncoder,
                    allowPrecisionLoss: request.allowPrecisionLoss,
                },
        audio: !plan.audio
            ? undefined
            : plan.audioCopy
              ? { action: 'copy' }
              : {
                    action: 'encode',
                    codec: plan.audioCodec,
                    sampleRate: request.audioSampleRate,
                    channels: request.audioChannels,
                    bitrate: request.audioBitrate,
                    ...(plan.audioSampleFormat ? { sampleFormat: plan.audioSampleFormat } : {}),
                    stages: request.audioStages ?? [],
                },
        metadata: {
            title: state.title,
            tags: state.tags,
            matroskaPassThrough:
                (format === 'mkv' || format === 'webm') && state.matroskaPassThrough
                    ? matroskaOutputMetadata(
                          state.matroskaPassThrough,
                          format,
                          lanes.map(track => track.info),
                      )
                    : undefined,
            video,
            audio: plan.audio?.info,
        },
    };
}

/** The conversion transform: plans a conversion and runs it as a one-clip timeline. */
export function createConversionRunner(options: ConversionRunnerOptions): ConversionRunner {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('Expected native conversion options', 'INPUT');
    const {
        writers,
        videoDecoders = [],
        codecPreference = 'webcodecs',
        audioDecoder,
        audioEncoders,
        audioDecoders = [],
        providers = [],
        stages = [],
    } = options;

    const decoders: VideoDecoderPreference = Object.freeze({
        decoders: videoDecoders,
        preference: codecPreference,
        missing: writers.missing,
        audioDecoders: Object.freeze([...audioDecoders]),
        providers,
    });

    const containerAudio = audioEncoders ? createContainerAudioEncoder(audioEncoders) : undefined;
    const containerCodecs = containerAudio?.codecs ?? [];
    const environment: TimelineEnvironment = Object.freeze({
        writers,
        videoDecoders: decoders.decoders,
        codecPreference: decoders.preference,
        audioDecoder,
        containerAudio,
        providers,
        stages,
    });

    const planned = (
        file: MediaFile,
        request: ConvertRequest,
        diagnostics: DiagnosticContext,
    ): ConversionPlan =>
        planConversion(file, request, writers, diagnostics, decoders, containerCodecs);

    return Object.freeze({
        probe(file, request, diagnostics) {
            const plan = planned(file, request, diagnostics);
            const tracks = trackPlans(plan, request, plan.codecPreference ?? decoders.preference);
            return {
                format: request.format,
                action: tracks.some(track => track.action === 'encode') ? 'reencode' : 'copy',
                tracks,
                duration: speedDuration(
                    coveredDuration(
                        plan.tracks.map(track => track.description),
                        request.start,
                        request.end,
                    ),
                    request.speed,
                ),
            };
        },
        copies(file, request) {
            return planned(file, request, mediaFileState(file).diagnostics.fresh()).copy;
        },
        async write(file, sink, request, diagnostics) {
            const state = mediaFileState(file);
            const local = diagnostics.fresh();
            const plan = planned(file, request, local);
            forwardDiagnostics(local, diagnostics);
            const forwardWarning = (warning: MediaDiagnostic): void => {
                const pending = diagnostics.fresh();
                pending.warn(warning);
                forwardDiagnostics(pending, diagnostics);
            };

            const linked = linkAbortSignals(state.signal, request.signal, sink.signal);
            try {
                if (plan.copy) {
                    const delivered = new DiagnosticContext({
                        validation: diagnostics.validation,
                        metadataPolicy: diagnostics.metadataPolicy,
                        onWarning: forwardWarning,
                    });
                    const count = file.packetTotal(plan.tracks.map(track => track.description.id));
                    await state.remux(
                        sink,
                        {
                            format: request.format as RemuxOptions['format'],
                            trackIds: plan.tracks.map(track => track.description.id),
                            start: request.start,
                            end: request.end,
                            signal: linked.signal,
                            onProgress: request.onProgress
                                ? value =>
                                      request.onProgress!({
                                          fraction: Math.min(1, value.packets / count),
                                          message: 'Copying media packets',
                                          ...value,
                                      })
                                : undefined,
                        },
                        delivered,
                        plan.videoRotation,
                    );
                    return;
                }

                const encoder = encoderOptions(request);
                await checkCapabilities(plan, linked.signal, decoders, encoder, request);
                const { runTimeline } = await import('./timeline');
                await runTimeline(environment, conversionJob(file, plan, request, encoder), {
                    sink,
                    diagnostics,
                    signal: linked.signal,
                    codecPreference: plan.codecPreference ?? decoders.preference,
                    onProgress: request.onProgress,
                });
            } finally {
                linked.dispose();
            }
        },
    } satisfies ConversionRunner);
}
