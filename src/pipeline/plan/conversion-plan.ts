import {
    canMuxCodec,
    carriesRotation,
    assertMuxCodec,
    copiesOnRequest,
    isIsoOutput,
    MP4_FAMILY,
} from '../../formats/shared/capabilities';
import { builtinAudioEncoding, routeAvailable } from '../codecs/router';
import type { MissingParts, FormatWriters } from '../plugins/missing-parts';
import type { MediaFile } from '../read/media-file';
import type { RemuxOptions, RemuxTrack } from '../media-types';
import { mediaFileState } from '../read/file-state';
import type { DiagnosticContext } from '../../core/errors/diagnostics';
import { MediaForgeError } from '../../core/errors/errors';
import { matroskaAudioWindowFitsFinalPacket } from '../copy/copied-track';
import {
    defaultVideoBitrate,
    encodedAudioShape,
    encoderFramerate,
    measuredFramerate,
    sourceAudioShape,
} from './encode-settings';
import { extraTrackBlocker } from '../copy/remux-plan';
import {
    CONTAINER_CODEC_PLANS,
    assertAudioEncodeRequest,
    encoderCodec,
    targetCodec,
} from './format-policy';
import { codecFamily, mpegVideoFamily } from '../../core/model/codec-strings';
import { alphaLoss, stereoViewLoss } from '../copy/track-metadata';
import { OptionNormalizer, resolveOptionPolicy } from '../../core/errors/option-policy';
import type { ContainerFormat } from '../../core/model/media';
import type { TrackInfo } from '../../core/model/track';
import { hasBuiltinAudioDecoder } from '../codecs/audio-track-decoder';
import type { BuiltinVideoCodec, BuiltinAudioDecoder } from '../../core/contracts/decoder';
import { builtinDecoderFor } from '../codecs/frame-codecs';
import type { ConvertRequest } from '../types';
import type { CodecPreference } from '../api-types';
import type { PcmSampleFormat } from '../../codecs/pcm/encoder';
import { widestSampleFormat } from './sample-coding';
import {
    clockwise,
    isCropOnlyGeometry,
    isIdentityGeometry,
    pixelAspectOf,
    resolveVideoGeometry,
    uprightRotation,
    type VideoGeometry,
} from '../../stages/frame-geometry';
import type { VideoCodecProvider } from '../../core/contracts/encoder';
import { h264ConfigFormat } from '../../core/codec-config/video/video-sps';

/**
 * What a conversion does: copy every selected track, or run one video and one audio lane (each
 * copied or encoded) with the other tracks copied beside them. The codecs and settings are
 * resolved; nothing reads the request again to decide.
 */
export interface ConversionPlan {
    readonly copy: boolean;
    readonly tracks: readonly RemuxTrack[];
    /**
     * Codec of the video lane: the source codec when copied, else the encoder's (settled by the
     * capability check).
     */
    videoCodec: string;
    /** Codec of the audio lane: the source codec when copied, else the encoder's. */
    readonly audioCodec: string;
    /** Samples of encoded FLAC: 24-bit from deeper sources, else 16-bit. */
    readonly audioSampleFormat?: PcmSampleFormat;
    /**
     * Bits per second of the encoded video: the request's, else the default for its size and frame
     * rate.
     */
    readonly videoBitrate?: number;
    /** Frames per second the video encoder is configured with. */
    readonly framerate?: number;
    readonly codecPreference?: CodecPreference;
    readonly video?: RemuxTrack;
    readonly audio?: RemuxTrack;
    readonly videoCopy: boolean;
    readonly audioCopy: boolean;
    readonly builtinAudioDecode: boolean;
    readonly builtinAudioEncode: boolean;
    /** Counter-clockwise display rotation written for the video track. */
    readonly videoRotation?: number;
    /** Pixel transform of a re-encoded video track. */
    readonly geometry?: VideoGeometry;
    /** True when the request named a video codec string with a profile, which re-encoding keeps. */
    readonly videoProfileSet?: boolean;
    /** Selected tracks besides the video and audio lanes, copied as they are. */
    readonly copies?: readonly RemuxTrack[];
    /** The application codec that encodes the video instead of the host VideoEncoder. */
    readonly videoEncoder?: VideoCodecProvider;
    /** The application codec that decodes the video, which then needs no host decoder. */
    readonly videoDecoder?: VideoCodecProvider;
}

/** Built-in video decoders and the order in which they are tried against the host decoder. */
export interface VideoDecoderPreference {
    readonly decoders: readonly BuiltinVideoCodec[];
    readonly preference: CodecPreference;
    /** Names the plugin that would decode a codec nothing in use decodes; default none. */
    readonly missing?: MissingParts;
    /** Plugin audio decoders installed besides the core's. */
    readonly audioDecoders?: readonly BuiltinAudioDecoder[];
    /** Application video codecs, which decode and encode their codecs before the host's. */
    readonly providers?: readonly VideoCodecProvider[];
}

/**
 * True when the request changes pixels, so the video track cannot be copied: a crop, a flip, a new
 * size, or a rotation the target container cannot store as display metadata.
 */
export function reshapesVideo(request: ConvertRequest, track: RemuxTrack): boolean {
    // A size is of the picture shown, as re-encoding turns it: a quarter turn swaps its sides.
    const { width, height, rotation } = track.info;
    const turn = clockwise(
        (request.rotate ?? 0) + ((request.autoRotate ?? true) ? uprightRotation(rotation) : 0),
    );
    const [shownWidth, shownHeight] = turn % 180 ? [height, width] : [width, height];
    return (
        request.crop !== undefined ||
        (!!request.rotate && !carriesRotation(request.format)) ||
        request.flip !== undefined ||
        (!!request.width && request.width !== shownWidth) ||
        (!!request.height && request.height !== shownHeight)
    );
}

/**
 * Counter-clockwise display rotation after rotating the displayed picture clockwise by `rotate`.
 */
function composedRotation(sourceRotation: number | undefined, rotate: number | undefined): number {
    return (360 - clockwise((rotate ?? 0) - (sourceRotation ?? 0))) % 360;
}

/**
 * The geometry that re-encoding applies: with autoRotate the source display rotation turns into
 * pixels and the output carries rotation 0; otherwise the source rotation is kept as metadata.
 * Repairs are noted on `normalizer`.
 */
function reencodeGeometry(
    request: ConvertRequest,
    info: {
        readonly width: number;
        readonly height: number;
        readonly rotation?: number;
        readonly pixelAspectRatioNum?: number;
        readonly pixelAspectRatioDen?: number;
    },
    normalizer: OptionNormalizer,
): { geometry: VideoGeometry; rotation: number } {
    const autoRotate = request.autoRotate ?? true;
    const geometry = resolveVideoGeometry(
        {
            width: info.width,
            height: info.height,
            rotation: autoRotate ? uprightRotation(info.rotation) : 0,
            pixelAspect: pixelAspectOf(info),
        },
        {
            crop: request.crop,
            rotate: request.rotate,
            flip: request.flip,
            width: request.width,
            height: request.height,
            fit: request.fit,
        },
        normalizer,
        true,
    );
    return { geometry, rotation: autoRotate ? 0 : (((info.rotation ?? 0) % 360) + 360) % 360 };
}

/**
 * Forwards request repairs found while planning; the strict policy has already thrown on the first
 * one.
 */
function reportFindings(normalizer: OptionNormalizer, diagnostics: DiagnosticContext): void {
    for (const finding of normalizer.findings)
        diagnostics.warn({ code: finding.code, message: finding.message });
}

export function forwardDiagnostics(from: DiagnosticContext, to: DiagnosticContext): void {
    for (const warning of from.warnings) {
        if (
            !to.warnings.some(
                entry =>
                    entry.code === warning.code &&
                    entry.trackId === warning.trackId &&
                    entry.format === warning.format &&
                    entry.message === warning.message,
            )
        )
            to.warn(warning);
    }
}

function sameCodec(source: string, requested?: string): boolean {
    if (requested === undefined) return true;
    const input = encoderCodec(source).toLowerCase();
    const output = encoderCodec(requested).toLowerCase();
    return (
        input === output ||
        input.replace(/^avc3/, 'avc1') === output.replace(/^avc3/, 'avc1') ||
        (!output.includes('.') && codecFamily(input) === codecFamily(output))
    );
}

/** Whether the copied video track satisfies `request` and the output carries it as it is. */
function canCopyVideo(request: ConvertRequest, input: ContainerFormat, track: TrackInfo): boolean {
    const output = request.format;
    if (request.reencode || retimes(request) || !canMuxCodec(output, 'video', track.codec))
        return false;
    if (!sameCodec(track.codec, request.videoCodec) || request.fps || request.videoBitrate)
        return false;
    if (
        (request.width && track.width && request.width !== track.width) ||
        (request.height && track.height && request.height !== track.height)
    )
        return false;
    if (output === 'ts') return input === 'ts' || !!track.codecConfig;
    // Motion JPEG pictures stand alone; H.264 and MPEG video from AVI need their configuration.
    if (
        input === 'avi' &&
        track.codec !== 'mjpeg' &&
        ((!track.codec.startsWith('avc') && !mpegVideoFamily(track.codec)) ||
            !track.codecConfig?.length)
    )
        return false;
    return !((input === 'ts' || input === 'mpeg') && !track.codecConfig);
}

/** Whether the copied audio track satisfies `request` and the output carries it as it is. */
function canCopyAudio(
    request: ConvertRequest,
    input: ContainerFormat,
    track: TrackInfo,
    codec: string,
): boolean {
    const output = request.format;
    if (request.reencode || changesSpeed(request) || (track.codecConfigurations?.length ?? 0) > 1)
        return false;
    if (!canMuxCodec(output, 'audio', track.codec) || !sameCodec(track.codec, request.audioCodec))
        return false;
    if (copiesOnRequest(output, track.codec) && request.audioCodec === undefined) return false;
    if (request.audioBitrate) return false;
    if (request.audioChannels && track.channelCount && request.audioChannels !== track.channelCount)
        return false;
    if ((request.audioCodec !== undefined && codec === 'opus') || track.codec === 'opus') {
        if (track.sampleRate !== 48000) return false;
    } else if (
        request.audioSampleRate &&
        track.sampleRate &&
        request.audioSampleRate !== track.sampleRate
    )
        return false;
    if (
        (track.codec === 'ac-3' || track.codec === 'ec-3') &&
        !track.codecConfig &&
        MP4_FAMILY.has(output)
    )
        return false;
    if (input === 'avi' && !track.codec.startsWith('pcm')) return false;
    return !((output === 'mkv' || output === 'webm') && !matroskaAudioWindowFitsFinalPacket(track));
}

/** The request plays the output at another speed, which moves every timestamp. */
export function changesSpeed(request: Pick<ConvertRequest, 'speed'>): boolean {
    return request.speed !== undefined && request.speed !== 1;
}

/** The request changes when pictures are shown: a speed or a frame rate. */
function retimes(request: ConvertRequest): boolean {
    return changesSpeed(request) || request.fps !== undefined;
}

/**
 * The constant rate re-encoded pictures are put on: the request's; with a speed and no rate, the
 * source's measured rate, which slow motion keeps; else none, and the pictures keep their own
 * timing.
 */
export function outputFps(request: ConvertRequest, track: TrackInfo): number | undefined {
    if (request.fps) return request.fps;
    return retimes(request) ? measuredFramerate(track) || 30 : undefined;
}

function unchanged(track: RemuxTrack, request: ConvertRequest): boolean {
    if (request.reencode) return track.type === 'subtitle';
    if (changesSpeed(request)) return false;
    if (track.type === 'video')
        return (
            !request.fps &&
            !request.videoBitrate &&
            !reshapesVideo(request, track) &&
            !request.videoStages &&
            sameCodec(track.info.codec, request.videoCodec)
        );
    if (track.type === 'audio')
        return (
            !request.audioBitrate &&
            (!request.audioSampleRate || request.audioSampleRate === track.info.sampleRate) &&
            (!request.audioChannels || request.audioChannels === track.info.channelCount) &&
            !request.audioStages &&
            sameCodec(track.info.codec, request.audioCodec) &&
            !(copiesOnRequest(request.format, track.info.codec) && request.audioCodec === undefined)
        );
    return true;
}

const VIDEO_SETTINGS = [
    'videoCodec',
    'width',
    'height',
    'fps',
    'videoBitrate',
    'crop',
    'rotate',
    'flip',
    'fit',
    'keyframeInterval',
    'videoStages',
] as const;
const AUDIO_SETTINGS = [
    'audioCodec',
    'audioSampleRate',
    'audioChannels',
    'audioBitrate',
    'audioStages',
] as const;

/**
 * The request without the settings of a kind of track the selection lacks, reported once; strict
 * validation refuses them.
 */
function withoutSettings(
    request: ConvertRequest,
    keys: readonly (keyof ConvertRequest)[],
    kind: 'video' | 'audio',
    diagnostics: DiagnosticContext,
): ConvertRequest {
    const set = keys.filter(key => request[key] !== undefined);
    if (!set.length) return request;
    diagnostics.lose({
        code: 'OPTION_IGNORED',
        message: `The ${kind} settings apply to no selected track`,
    });
    return { ...request, ...Object.fromEntries(set.map(key => [key, undefined])) };
}

export function planConversion(
    file: MediaFile,
    request: ConvertRequest,
    writers: FormatWriters,
    diagnostics: DiagnosticContext,
    videoDecoders: VideoDecoderPreference,
    containerAudio: readonly string[] = [],
): ConversionPlan {
    const state = mediaFileState(file);
    const defaults = CONTAINER_CODEC_PLANS[request.format];
    if (!defaults)
        throw new MediaForgeError(
            `Re-encoding into '${request.format}' is not supported`,
            'FORMAT',
            {
                hint: 'Copy the tracks, or choose an audio format.',
            },
        );
    if (!writers.container.has(request.format))
        throw writers.missing.format(request.format, `No writer for '${request.format}'`, true);
    const ids = request.trackIds;
    if (
        ids !== undefined &&
        (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
    )
        throw new MediaForgeError('trackIds must contain unique existing track IDs', 'INPUT');
    const tracks =
        ids === undefined
            ? [...state.tracks]
            : ids.map(id => {
                  const track = state.tracks.find(value => value.description.id === id);
                  if (!track) throw new MediaForgeError(`Unknown track ${id}`, 'INPUT');
                  return track;
              });
    const videos = tracks.filter(track => track.type === 'video');
    const audios = tracks.filter(track => track.type === 'audio');
    if (!videos.length) request = withoutSettings(request, VIDEO_SETTINGS, 'video', diagnostics);
    if (!audios.length) request = withoutSettings(request, AUDIO_SETTINGS, 'audio', diagnostics);
    const copiedVideo = (track: RemuxTrack): number => {
        if (request.keyframeInterval !== undefined)
            diagnostics.warn({
                code: 'OPTION_IGNORED',
                trackId: track.description.id,
                message: 'keyframeInterval is ignored: the video is copied',
            });
        return composedRotation(track.info.rotation, request.rotate);
    };
    if (tracks.every(track => unchanged(track, request))) {
        const copy = file.checkRemux({
            format: request.format as RemuxOptions['format'],
            trackIds: tracks.map(track => track.description.id),
            start: request.start,
            end: request.end,
            signal: request.signal,
        });
        if (copy.supported) {
            for (const warning of copy.warnings) diagnostics.warn(warning);
            return {
                copy: true,
                tracks,
                videoCodec: videos[0]?.info.codec ?? '',
                audioCodec: audios[0]?.info.codec ?? '',
                codecPreference: request.codecPreference,
                videoCopy: true,
                audioCopy: true,
                builtinAudioDecode: false,
                builtinAudioEncode: false,
                videoRotation: videos.length === 1 ? copiedVideo(videos[0]!) : undefined,
            };
        }
    }
    const video = videos[0];
    const audio = audios[0];
    if (!video && !audio)
        throw new MediaForgeError('Re-encoding needs a video or audio track', 'FORMAT');

    // Why a copy of `track` alone into the output is refused, over `range` (the request's) or
    // whole: the copy's planner decides what the conversion copies, so a track it refuses is not
    // written anyway.
    const copyRefusal = (track: RemuxTrack, range: boolean): string | undefined => {
        const support = file.checkRemux({
            format: request.format as RemuxOptions['format'],
            trackIds: [track.description.id],
            start: range ? request.start : undefined,
            end: range ? request.end : undefined,
            signal: request.signal,
        });
        if (support.supported) return undefined;
        const { reason } = support;
        return /^[A-Z][a-z]+\b/.test(reason) ? reason[0]!.toLowerCase() + reason.slice(1) : reason;
    };

    // The other tracks are copied next to the re-encoded ones where the output carries them and
    // takes their copy; any other is left out and reported (strict validation refuses to leave out
    // a selected one).
    const copies: RemuxTrack[] = [];
    for (const track of tracks) {
        if (track === video || track === audio) continue;
        const blocker = request.reencode
            ? 'only one video and one audio track are re-encoded'
            : changesSpeed(request)
              ? 'the speed change applies to the first video and audio track only'
              : (extraTrackBlocker(track, request.format) ?? copyRefusal(track, false));
        const name = `${track.type} track ${track.description.id} (${track.info.codec})`;
        if (blocker === undefined) copies.push(track);
        else if (ids !== undefined && diagnostics.validation === 'strict')
            throw new MediaForgeError(`${name} cannot be written: ${blocker}`, 'FORMAT', {
                hint: "Leave the track out of trackIds, or choose 'mkv'.",
            });
        else
            diagnostics.warn({
                code: 'TARGET_TRACKS_DROPPED',
                trackId: track.description.id,
                format: request.format,
                message: `${name} is left out: ${blocker}`,
            });
    }
    let videoCodec = video
        ? targetCodec(request.format, request.videoCodec, video.info.codec, 'video')
        : '';
    const audioCodec = audio
        ? targetCodec(request.format, request.audioCodec, audio.info.codec, 'audio')
        : '';
    const input = file.format as ContainerFormat;
    const providers = videoDecoders.providers ?? [];
    const videoDecoder =
        video && providers.find(provider => provider.supportsDecode(video.info.codec));
    const videoEncoder = video && providers.find(provider => provider.supportsEncode(videoCodec));
    const reshaped =
        !!video &&
        (reshapesVideo(request, video) || request.videoStages !== undefined || retimes(request));
    // A lane copies its track where a copy of it over the range is taken, else encodes it.
    const videoCopy =
        !!video &&
        !reshaped &&
        canCopyVideo(request, input, video.info) &&
        copyRefusal(video, true) === undefined;

    // A range whose video is re-encoded is cut exactly; copied sound would start at a packet
    // boundary instead.
    const ranged = request.start !== undefined || request.end !== undefined;
    const audioCopy =
        !!audio &&
        !request.audioStages &&
        !(ranged && video && !videoCopy) &&
        canCopyAudio(request, input, audio.info, audioCodec) &&
        copyRefusal(audio, true) === undefined;
    const kept = tracks.filter(
        track => track === video || track === audio || copies.includes(track),
    );
    state.planner().checkTrackMetadata(kept, request.format, diagnostics);
    let geometry: VideoGeometry | undefined;
    let videoRotation: number | undefined;
    let videoBitrate: number | undefined;
    let framerate: number | undefined;
    if (video) {
        if (videoCopy) videoCodec = video.info.codec;
        assertMuxCodec(request.format, 'video', videoCodec);
        // checkTrackMetadata reported the alpha of a copy elsewhere; a re-encode drops it in MKV
        // and WebM too.
        const matroska = request.format === 'mkv' || request.format === 'webm';
        const alpha = !videoCopy && matroska && alphaLoss(video.info, request.format, false);
        if (alpha) diagnostics.lose({ ...alpha, trackId: video.description.id });
        // Likewise for the second view of spatial video, which only MP4-family copies keep.
        const reencodedIso = !videoCopy && isIsoOutput(request.format);
        const views = reencodedIso && stereoViewLoss(video.info, request.format, false);
        if (views) diagnostics.lose({ ...views, trackId: video.description.id });
        if (videoCopy) videoRotation = copiedVideo(video);
        else {
            const repairs = new OptionNormalizer(
                resolveOptionPolicy(diagnostics.validation),
                'request',
            );
            ({ geometry, rotation: videoRotation } = reencodeGeometry(
                request,
                video.info,
                repairs,
            ));
            reportFindings(repairs, diagnostics);
            framerate = outputFps(request, video.info) ?? encoderFramerate(undefined, video.info);
            videoBitrate =
                request.videoBitrate ??
                defaultVideoBitrate(videoCodec, geometry.width, geometry.height, framerate);
            const encodes = routeAvailable('VideoEncoder', !!videoEncoder);
            if (
                !routeAvailable(
                    'VideoDecoder',
                    !!videoDecoder || !!builtinDecoderFor(videoDecoders.decoders, video.info.codec),
                )
            ) {
                const message = `No video decoder for '${video.info.codec}'`;

                // Without an encoder a decoder plugin would not help: the missing encoder is
                // reported below instead.
                if (encodes)
                    throw writers.missing.videoDecoder(
                        video.info.codec,
                        message,
                        h264ConfigFormat(video.info.codec, video.info.codecConfig),
                    );
                if (!writers.missing.videoDecoderPlugin(video.info.codec))
                    throw new MediaForgeError(message, 'DECODE');
            }
            if (!encodes)
                throw new MediaForgeError('This host has no WebCodecs VideoEncoder', 'ENCODE');

            // Pictures of an application decoder are RGBA, which the library transforms itself, as
            // it does host pictures of square pixels; the canvas draws those of other pixels.
            if (
                !videoDecoder &&
                pixelAspectOf(video.info) !== undefined &&
                !isIdentityGeometry(geometry) &&
                !(
                    isCropOnlyGeometry(geometry) &&
                    geometry.region.x % 2 === 0 &&
                    geometry.region.y % 2 === 0
                ) &&
                typeof OffscreenCanvas !== 'function'
            )
                throw new MediaForgeError(
                    'Video transforms of non-square pixels need OffscreenCanvas',
                    'ENCODE',
                );
        }
    }
    let builtinAudioDecode = false;
    let builtinAudioEncode = false;
    let audioSampleFormat: PcmSampleFormat | undefined;
    if (audio) {
        // A codec no encoder writes (Vorbis into Ogg) is named as such before the container.
        if (!audioCopy) assertAudioEncodeRequest(audioCodec);
        assertMuxCodec(request.format, 'audio', audioCopy ? audio.info.codec : audioCodec);
        if (!audioCopy) {
            // FLAC keeps a deeper source's samples as it does in a FLAC file.
            if (codecFamily(audioCodec) === 'flac')
                audioSampleFormat = widestSampleFormat(
                    [audio.info],
                    { format: 'flac', allowPrecisionLoss: request.allowPrecisionLoss },
                    warning =>
                        diagnostics.warn({
                            ...warning,
                            trackId: audio.description.id,
                            format: request.format,
                        }),
                );
            builtinAudioDecode = hasBuiltinAudioDecoder(audio.info, videoDecoders.audioDecoders);
            const target = encodedAudioTarget(audio.info, audioCodec, request);
            builtinAudioEncode =
                builtinAudioEncoding(audioCodec, target.rate, target.channels, containerAudio) !==
                undefined;
            if (!routeAvailable('AudioDecoder', builtinAudioDecode))
                throw writers.missing.audioDecoder(
                    audio.info.codec,
                    `No audio decoder for '${audio.info.codec}'`,
                );
            if (!routeAvailable('AudioEncoder', builtinAudioEncode))
                throw writers.missing.audioEncoder(
                    audioCodec,
                    `No audio encoder for '${audioCodec}'`,
                    'ENCODE',
                );
        }
    }
    return {
        copy: false,
        tracks: kept,
        videoCodec,
        audioCodec: audioCopy ? audio!.info.codec : audioCodec,
        ...(audioSampleFormat ? { audioSampleFormat } : {}),
        videoBitrate,
        framerate,
        codecPreference: request.codecPreference,
        video,
        audio,
        videoCopy,
        audioCopy,
        builtinAudioDecode,
        builtinAudioEncode,
        videoRotation,
        geometry,
        videoProfileSet: request.videoCodec?.includes('.') === true,
        copies,
        ...(videoEncoder && !videoCopy ? { videoEncoder } : {}),
        ...(videoDecoder && !videoCopy ? { videoDecoder } : {}),
    };
}

/** Rate and channels the audio lane encodes `track` at under `request`. */
export function encodedAudioTarget(
    track: TrackInfo,
    codec: string,
    request: Pick<ConvertRequest, 'audioSampleRate' | 'audioChannels'>,
): { rate: number; channels: number; downmixed?: boolean } {
    const shape = sourceAudioShape(track);
    return encodedAudioShape(shape.rate, shape.channels, codec, {
        sampleRate: request.audioSampleRate,
        channels: request.audioChannels,
    });
}
