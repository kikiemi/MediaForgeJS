import type { EncodedPacket } from '../core/model/media';
import { codecDisplayName } from '../core/model/codec-names';
import type { MediaDiagnostic } from '../core/errors/diagnostics';
import { MediaForgeError } from '../core/errors/errors';
import { BLOB_PART_BYTES, MemorySink } from '../core/io/sinks/sinks';
import { closeQuietly, type PcmBlock, type Pull } from './frame-streams';
import { canMuxCodec } from '../formats/shared/capabilities';
import { createWriters } from '../formats/shared/contract';
import { CORE_FORMATS } from '../formats/core-formats';
import { CodecLifetime } from '../codecs/shared/codec-lifetime';
import { hostVideoEncoderConfig } from '../codecs/webcodecs/video';
import type { HostVideoEncoderOptions } from '../codecs/webcodecs/video-options';
import { hostCodecAvailable, queryHostCodec } from '../codecs/webcodecs/support';
import { copyAudioPlanes } from '../codecs/webcodecs/audio-data';
import type { ReplayablePcmSource } from '../codecs/pcm/pcm-source';
import { OptionNormalizer } from '../core/errors/option-policy';
import { audioEncoderOrder, builtinAudioEncoding } from '../pipeline/codecs/router';
import { createStages, type StageFactory } from '../stages/chain';
import type { VideoPicture, VideoStage } from '../core/contracts/stage';
import { Picture, sdrReport } from '../stages/picture';
import { transformStage } from '../stages/video';
import { resolveVideoGeometry, type VideoGeometry } from '../stages/frame-geometry';
import {
    autoAudioCodecs,
    autoVideoFamilies,
    chooseVideoEncoderCodec,
    hostVideoEncoderCodec,
    otherVideoFamilies,
    substitutedMessage,
} from '../pipeline/plan/codec-choice';
import type { FRAME_ENCODE_FORMATS } from '../pipeline/plan/format-policy';
import type { MediaProgress } from '../core/model/media';
import type { CodecPreference, MediaPlan, TrackPlan } from '../pipeline/api-types';
import {
    defaultVideoBitrate,
    qualityBitrate,
    type VideoQuality,
} from '../pipeline/plan/encode-settings';
import {
    NO_PLUGINS,
    type FormatWriters,
    type MissingParts,
} from '../pipeline/plugins/missing-parts';
import {
    createContainerAudioEncoder,
    type ContainerAudioEncoder,
} from '../pipeline/codecs/container-audio';
import type { StreamingAudioCodecs } from '../pipeline/codecs/streaming-audio-output-core';
import { mp4aAudioObjectType } from '../core/model/codec-strings';
import { createVideoStages } from '../pipeline/parts';
import { openMuxer, openVideoEncoderPart } from '../pipeline/codecs/part-codecs';
import type { Muxer, VideoEncoderPart } from '../pipeline/codecs/part-options';

/**
 * Encoding pictures and sound that the application produces into one file: the codec and size
 * choices and the shared clock of the two tracks, assembled from the parts (stages, a video
 * encoder, encodeAudio() and a muxer). The API hands over a request whose every setting it has read
 * and checked.
 */

/** Video of an encode run, its settings resolved. */
export interface EncodeVideoRequest extends HostVideoEncoderOptions {
    /** 'auto' or a canonical codec name or string. */
    readonly codec: string;
    readonly width?: number;
    readonly height?: number;
    readonly fps: number;
    readonly bitrate?: number;
    readonly quality?: VideoQuality;
    readonly keyframeInterval: number;
    /** Stages each picture runs through at the output size. */
    readonly stages?: readonly StageFactory<VideoStage>[];
}

/** An encode run with its settings resolved. */
export interface EncodeRequest {
    readonly format: (typeof FRAME_ENCODE_FORMATS)[number];
    readonly video: EncodeVideoRequest;
    /**
     * Audio settings: 'auto' or a canonical codec, and bits per second; absent leaves the sound
     * out.
     */
    readonly audio?: { readonly codec: string; readonly bitrate: number };
    readonly duration?: number;
    readonly maxBytes: number;
    readonly preference: CodecPreference;
    /** The strict option policy: a codec the host cannot encode fails instead of being replaced. */
    readonly strict?: boolean;
    readonly signal?: AbortSignal;
    readonly onPlan?: (plan: MediaPlan) => void;
    readonly onProgress?: (progress: MediaProgress) => void;
    readonly onWarning: (warning: MediaDiagnostic) => void;
    /** The audio encoders of the plugins in use; the aac plugin's AAC-LC encoder among them. */
    readonly audioEncoders?: StreamingAudioCodecs;
    /** Names the plugin of an encoder that is not in use; default none. */
    readonly missing?: MissingParts;
}

/** The pulled sources of an encode run. */
export interface PulledSources {
    readonly video?: Pull<VideoFrame>;
    readonly audio?: Pull<AudioData | PcmBlock>;
}

/** The writers of the core containers, loaded with the first recording to one. */
function coreWriters(): FormatWriters {
    return {
        ...createWriters(CORE_FORMATS.writers, CORE_FORMATS.segments),
        missing: NO_PLUGINS,
    };
}

/**
 * Microseconds between the first video and audio timestamps beyond which the tracks count as
 * separately clocked.
 */
const CLOCK_TOLERANCE = 1_000_000;

/** Chosen output of one encode run. */
interface EncodeChoice {
    readonly video?: {
        readonly config: VideoEncoderConfig;
        readonly width: number;
        readonly height: number;
    };
    readonly audio?: {
        readonly codec: string;
        readonly sampleRate: number;
        readonly channels: number;
        readonly bitrate: number;
        readonly host: boolean;
    };
}

/**
 * Float planes of an AudioData (copyAudioPlanes), which is closed; at most `channels` planes are
 * kept.
 */
function planesOf(data: AudioData, channels: number): PcmBlock {
    try {
        const planes = Array.from(
            { length: Math.min(channels, data.numberOfChannels) },
            () => new Float32Array(data.numberOfFrames),
        );
        copyAudioPlanes(data, planes, 0);
        while (planes.length < channels) planes.push(planes[0]!.slice());
        return { planes, sampleRate: data.sampleRate, timestamp: data.timestamp };
    } finally {
        data.close();
    }
}

function isAudioData(value: unknown): value is AudioData {
    return typeof AudioData === 'function' && value instanceof AudioData;
}

/**
 * The next item of a source, or undefined at its end. When the lifetime ends first, the item the
 * read still delivers is closed instead of lost.
 */
async function pull<T>(
    source: Pull<T> | undefined,
    lifetime: CodecLifetime,
): Promise<T | undefined> {
    if (!source) return undefined;
    const next = source.next();
    try {
        return await lifetime.waitFor(next);
    } catch (error) {
        void next.then(
            value => closeQuietly(value as { close?(): void } | undefined),
            () => undefined,
        );
        throw error;
    }
}

/**
 * The sound of a pulled audio source as a one-pass PCM source at the first block's rate with
 * `channels` planes.
 */
function pulledPcm(
    first: PcmBlock,
    source: Pull<AudioData | PcmBlock> | undefined,
    channels: number,
    lifetime: CodecLifetime,
): ReplayablePcmSource {
    let used = false;
    return {
        sampleRate: first.sampleRate,
        channels,
        estimatedFrames: first.planes[0]?.length || 1,
        async *chunks() {
            if (used) throw new MediaForgeError('Handed-in sound can be read once', 'ENCODE');
            used = true;
            for (let block: PcmBlock | undefined = first; block;) {
                if (block.sampleRate !== first.sampleRate)
                    throw new MediaForgeError(
                        `The sound changed from ${first.sampleRate} Hz to ${block.sampleRate} Hz ` +
                            `mid-stream`,
                        'INPUT',
                        { hint: 'Hand in AudioData or PCM blocks at one sample rate.' },
                    );

                const planes = block.planes.slice(0, channels);
                while (planes.length < channels) planes.push(planes[0]!.slice());
                if (planes[0]?.length) yield planes;
                const next = await pull(source, lifetime);
                block =
                    next === undefined
                        ? undefined
                        : isAudioData(next)
                          ? planesOf(next, channels)
                          : next;
            }
        },
    };
}

/** Encodes the sources into one file; the sources are stopped when the run fails. */
export async function encodeStreams(
    sources: PulledSources,
    request: EncodeRequest,
): Promise<{ readonly blob: Blob; readonly plan: MediaPlan }> {
    const { format, video: videoSettings, audio: audioSettings, duration, onWarning } = request;
    const lifetime = new CodecLifetime(
        request.signal,
        new MediaForgeError('Encoding stopped', 'ENCODE'),
    );
    const warn = (code: string, message: string): void =>
        onWarning(Object.freeze({ code, message, severity: 'warning' }));
    let firstFrame: VideoFrame | undefined;
    let encoder: VideoEncoderPart | undefined;
    let muxer: Muxer | undefined;
    const stopSources = (): Promise<unknown> =>
        Promise.all([sources.video?.stop(), sources.audio?.stop()]);
    try {
        if (!audioSettings) await sources.audio?.stop();
        let firstAudio: AudioData | PcmBlock | undefined;
        [firstFrame, firstAudio] = await Promise.all([
            pull(sources.video, lifetime),
            audioSettings ? pull(sources.audio, lifetime) : undefined,
        ]);
        if (!firstFrame && !firstAudio)
            throw new MediaForgeError('There are no frames to encode', 'INPUT', {
                hint: 'The video and audio sources ended before their first frame.',
            });
        const firstBlock =
            firstAudio === undefined
                ? undefined
                : isAudioData(firstAudio)
                  ? planesOf(firstAudio, Math.min(2, firstAudio.numberOfChannels))
                  : firstAudio;

        // First timestamps within a second of each other share a clock and keep their offset;
        // otherwise (a canvas capture and a Web Audio track, say) each track starts at 0.
        const shared =
            !firstFrame ||
            !firstBlock ||
            Math.abs(firstFrame.timestamp - firstBlock.timestamp) <= CLOCK_TOLERANCE;
        const origin = Math.min(
            firstFrame?.timestamp ?? Infinity,
            firstBlock?.timestamp ?? Infinity,
        );
        const videoOrigin = shared ? origin : firstFrame!.timestamp;
        const audioOrigin = shared ? origin : firstBlock!.timestamp;
        if (!shared) {
            const apart = Math.abs(firstFrame!.timestamp - firstBlock!.timestamp) / 1e6;
            warn(
                'TIMESTAMPS_REALIGNED',
                `Video and audio clocks differ by ${apart.toFixed(1)} s; both now start at 0`,
            );
        }
        const library = createContainerAudioEncoder(
            request.audioEncoders ?? {},
            request.missing ?? NO_PLUGINS,
        );
        const chosen = await chooseEncoders(request, library, firstFrame, firstBlock);
        const stageNames = videoSettings.stages?.map(stage => stage.name);
        const plan: MediaPlan = {
            format,
            action: 'reencode',
            tracks: [
                ...(chosen.video
                    ? [
                          {
                              trackId: 1,
                              type: 'video',
                              action: 'encode',
                              sourceCodec: 'raw',
                              codec: chosen.video.config.codec,
                              encoder: 'webcodecs',
                              ...(stageNames ? { stages: stageNames } : {}),
                          } satisfies TrackPlan,
                      ]
                    : []),
                ...(chosen.audio
                    ? [
                          {
                              trackId: 2,
                              type: 'audio',
                              action: 'encode',
                              sourceCodec: 'pcm',
                              codec: chosen.audio.codec,
                              encoder: chosen.audio.host ? 'webcodecs' : 'builtin',
                          } satisfies TrackPlan,
                      ]
                    : []),
            ],
            ...(duration !== undefined ? { duration } : {}),
        };
        request.onPlan?.(plan);
        const sink = new MemorySink({ maxBytes: request.maxBytes, blobPartBytes: BLOB_PART_BYTES });

        // The writer of the target container loads with the first recording to it.
        muxer = await openMuxer(
            coreWriters(),
            format,
            sink,
            {
                signal: request.signal,
                ...(chosen.video
                    ? {
                          video: {
                              codec: chosen.video.config.codec,
                              width: chosen.video.width,
                              height: chosen.video.height,
                              framerate: videoSettings.fps,
                          },
                      }
                    : {}),
                ...(chosen.audio
                    ? {
                          audio: {
                              codec: chosen.audio.codec,
                              sampleRate: chosen.audio.sampleRate,
                              channels: chosen.audio.channels,
                          },
                      }
                    : {}),
            },
            library,
        );
        const output = muxer;
        let mediaTime = 0;
        const advance = (seconds: number): void => {
            mediaTime = Math.max(mediaTime, seconds);
            request.onProgress?.({
                fraction: duration ? mediaTime / duration : 0,
                time: mediaTime,
            });
        };
        const videoTask = async (): Promise<void> => {
            if (!chosen.video) return;
            const { width, height, config } = chosen.video;
            encoder = await openVideoEncoderPart({
                codec: config.codec,
                width,
                height,
                framerate: videoSettings.fps,
                bitrate: config.bitrate,
                keyframeInterval: videoSettings.keyframeInterval,
                container: format,
                hardwareAcceleration: videoSettings.hardwareAcceleration,
                latencyMode: videoSettings.latencyMode,
                bitrateMode: videoSettings.bitrateMode,
                signal: request.signal,
                onWarning,
            });

            // Each picture is drawn at the output size, stretched like fit 'fill', then runs
            // through the stages.
            const geometryOf = (sourceWidth: number, sourceHeight: number): VideoGeometry =>
                resolveVideoGeometry(
                    { width: sourceWidth, height: sourceHeight },
                    { width, height },
                    new OptionNormalizer('strict', 'encode'),
                    true,
                );
            const sourceWidth = firstFrame!.displayWidth || firstFrame!.codedWidth;
            const sourceHeight = firstFrame!.displayHeight || firstFrame!.codedHeight;
            const stages = createVideoStages(
                [
                    transformStage(geometryOf(sourceWidth, sourceHeight), { resolve: geometryOf }),
                    ...createStages('video', videoSettings.stages),
                ],
                { width: sourceWidth, height: sourceHeight, fps: videoSettings.fps },
                { onWarning },
            );
            const toSdr = sdrReport({ strict: request.strict === true, warn });
            const write = async (pictures: readonly VideoPicture[]): Promise<void> => {
                for (let index = 0; index < pictures.length; index++) {
                    const picture = pictures[index]!;
                    const end = picture.timestamp + picture.duration;
                    let packets: EncodedPacket[];
                    try {
                        packets = await encoder!.encode(picture);
                    } catch (error) {
                        for (const rest of pictures.slice(index + 1)) rest.close();
                        throw error;
                    }
                    for (const packet of packets) await output.addVideo(packet);
                    advance(end);
                }
            };
            try {
                let frame = firstFrame;
                firstFrame = undefined;
                for (; frame; frame = await pull(sources.video, lifetime)) {
                    const timestamp = (frame.timestamp - videoOrigin) / 1e6;
                    const length = frame.duration ? frame.duration / 1e6 : 1 / videoSettings.fps;
                    await write(
                        await stages.push(
                            new Picture({ kind: 'frame', frame, toSdr }, timestamp, length),
                        ),
                    );
                }
                await write(await stages.flush());
                for (const packet of await encoder.flush()) await output.addVideo(packet);
            } finally {
                stages.close();
            }
        };
        const audioTask = async (): Promise<void> => {
            if (!chosen.audio) return;
            const audio = chosen.audio;
            const start = Math.max(0, (firstBlock!.timestamp - audioOrigin) / 1e6);
            const sound = pulledPcm(firstBlock!, sources.audio, audio.channels, lifetime);
            let frames = 0;
            await output.encodeAudio(
                {
                    ...sound,
                    async *chunks(signal) {
                        for await (const planes of sound.chunks(signal)) {
                            yield planes;
                            frames += planes[0]?.length ?? 0;
                            advance(start + frames / sound.sampleRate);
                        }
                    },
                },
                {
                    bitrate: audio.bitrate,
                    codecPreference: request.preference,
                    start,
                    signal: request.signal,
                    onWarning,
                },
            );
        };
        await Promise.all([videoTask(), audioTask()]);
        lifetime.check();
        await output.finish();
        return { blob: sink.toBlob(''), plan };
    } catch (error) {
        muxer?.abort(error);
        await stopSources();
        throw lifetime.record(error);
    } finally {
        lifetime.stop();
        closeQuietly(firstFrame);
        await encoder?.close();
    }
}

/** Codec and size choices for one encode run, asked of the host encoders. */
async function chooseEncoders(
    request: EncodeRequest,
    library: ContainerAudioEncoder,
    frame: VideoFrame | undefined,
    block: PcmBlock | undefined,
): Promise<EncodeChoice> {
    const { format, video: settings, signal } = request;
    let video: EncodeChoice['video'];
    if (frame) {
        if (!hostCodecAvailable('VideoEncoder'))
            throw new MediaForgeError('This host has no WebCodecs VideoEncoder', 'ENCODE', {
                hint: 'Encode in a current browser.',
            });
        const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
        const sourceWidth = frame.displayWidth || frame.codedWidth;
        const sourceHeight = frame.displayHeight || frame.codedHeight;
        const width = even(
            settings.width ??
                (settings.height ? (sourceWidth * settings.height) / sourceHeight : sourceWidth),
        );
        const height = even(
            settings.height ??
                (settings.width ? (sourceHeight * settings.width) / sourceWidth : sourceHeight),
        );
        const requested = settings.codec;
        const bitrateFor = (codec: string): number =>
            settings.bitrate ??
            (settings.quality
                ? qualityBitrate(settings.quality, codec, width, height, settings.fps)
                : defaultVideoBitrate(codec, width, height, settings.fps));
        const query = {
            width,
            height,
            framerate: settings.fps,
            container: format,
            hardwareAcceleration: settings.hardwareAcceleration,
            latencyMode: settings.latencyMode,
            bitrateMode: settings.bitrateMode,
        };
        let codec: string | undefined;
        if (requested === 'auto') {
            const families = autoVideoFamilies(format);
            codec = await chooseVideoEncoderCodec(
                families,
                { ...query, bitrate: settings.bitrate },
                signal,
            );
            if (!codec)
                throw new MediaForgeError(
                    `This browser cannot encode ${format} video at ${width}×${height}`,
                    'ENCODE',
                    {
                        hint:
                            format === 'webm'
                                ? "Try to: 'mp4' or a smaller size."
                                : "Try to: 'webm' or a smaller size.",
                    },
                );
        } else {
            if (!canMuxCodec(format, 'video', requested))
                throw new MediaForgeError(
                    `${format} cannot carry ${codecDisplayName(requested)} video`,
                    'FORMAT',
                    {
                        hint: "Use video: { codec: 'auto' }, or a container such as 'mkv'.",
                    },
                );
            codec = await hostVideoEncoderCodec(
                requested,
                { ...query, bitrate: bitrateFor(requested) },
                signal,
            );
            if (!codec && !request.strict) {
                codec = await chooseVideoEncoderCodec(
                    otherVideoFamilies(format, requested),
                    { ...query, bitrate: settings.bitrate },
                    signal,
                );
                if (codec)
                    request.onWarning(
                        Object.freeze({
                            code: 'CODEC_SUBSTITUTED',
                            message: substitutedMessage('video', codec, requested),
                            severity: 'warning',
                        }),
                    );
            }
            if (!codec)
                throw new MediaForgeError(
                    `VideoEncoder does not support ${requested} at ${width}×${height}`,
                    'ENCODE',
                    { hint: "Use video: { codec: 'auto' }, or a smaller size." },
                );
        }
        video = {
            width,
            height,
            config: hostVideoEncoderConfig(codec, {
                ...query,
                bitrate: bitrateFor(codec),
                framerate: settings.fps,
            }),
        };
    }
    let audio: EncodeChoice['audio'];
    if (block && request.audio) {
        const { bitrate } = request.audio;
        const sampleRate = block.sampleRate;
        const channels = Math.max(1, Math.min(2, block.planes.length));
        const candidates =
            request.audio.codec === 'auto'
                ? autoAudioCodecs(format).filter(codec => codec !== 'pcm' && codec !== 'flac')
                : [request.audio.codec];
        for (const codec of candidates) {
            if (!canMuxCodec(format, 'audio', codec)) continue;

            // The library's own encoders here are the plugins' (AAC, FLAC, MP2 and MP3), which take
            // over from a missing or refusing host.
            const encoding = builtinAudioEncoding(codec, sampleRate, channels, library.codecs);
            const builtin = encoding === 'aac' || encoding === 'container';
            const order = audioEncoderOrder(codec, builtin, request.preference);
            const config = { codec, sampleRate, numberOfChannels: channels, bitrate };
            const host =
                order[0] === 'webcodecs' &&
                hostCodecAvailable('AudioEncoder') &&
                (await queryHostCodec('AudioEncoder', config)).supported;
            if (host || builtin) {
                audio = { codec, sampleRate, channels, bitrate, host };
                break;
            }
        }
        const unavailable =
            `No ${candidates.map(codecDisplayName).join(' or ')} audio encoder is available ` +
            `for ${format} at ${sampleRate} Hz`;
        const aacLc = candidates.find(codec => mp4aAudioObjectType(codec) === 2);
        if (!audio && aacLc && !library.codecs.includes('aac'))
            throw (request.missing ?? NO_PLUGINS).audioEncoder(aacLc, unavailable, 'ENCODE');
        if (!audio)
            throw new MediaForgeError(unavailable, 'ENCODE', {
                hint:
                    format === 'mp4' || format === 'mov' || format === 'm4v'
                        ? 'Pass audio: false to leave the sound out.'
                        : "Encode into 'mp4', or pass audio: false.",
            });
    }
    return { video, audio };
}
