import { codecFamily } from '../core/model/codec-strings';
import { canMuxCodec } from '../formats/shared/capabilities';
import { hostCodecAvailable } from '../codecs/webcodecs/support';
import { DiagnosticContext } from '../core/errors/diagnostics';
import { MediaForgeError } from '../core/errors/errors';
import { checkSignal, linkAbortSignals } from '../core/io/abort';
import { assertSink } from '../core/io/sinks/sink-backpressure';
import { OptionNormalizer, resolveOptionPolicy } from '../core/errors/option-policy';
import { sameBytes } from '../core/bytes/bytes';
import { sampleAt, sampleCount } from '../core/model/sample-index';
import { measuredFramerate } from '../pipeline/plan/encode-settings';
import {
    audioEncodeQuery,
    encodableAudioCodec,
    encodableVideoCodec,
    requiredEncoderError,
    substitutedMessage,
} from '../pipeline/plan/codec-choice';
import type { OutputContainerFormat } from '../core/model/media';
import type { Sink, Source, MediaInput } from '../core/model/types';
import type { OpenOptions } from '../core/contracts/reader';
import type { Engine } from '../pipeline/engine';
import {
    AUDIO_FILE_FORMATS,
    CONTAINER_CODEC_PLANS,
    assertAudioEncodeRequest,
    audioFormatCodec,
    resolveSupportedCodec,
} from '../pipeline/plan/format-policy';
import type { MediaFile } from '../pipeline/read/media-file';
import { mediaFileState } from '../pipeline/read/file-state';
import type { RemuxTrack } from '../pipeline/media-types';
import { keepsExactTrim, presentationEnd } from '../pipeline/copy/trim-plan';
import { lacksMp4Configuration } from '../pipeline/copy/remux-plan';
import type { AudioFileRequest, ConvertRequest, OperationRequest } from '../pipeline/types';
import type { TrackPlan } from '../pipeline/api-types';
import type { MediaPlan } from '../pipeline/api-types';
import {
    audioEncoderOrder,
    builtinAudioEncoding,
    plannedAudioEncoder,
} from '../pipeline/codecs/router';
import { audioFileCodec } from '../pipeline/transcode/audio-plan';
import { widestSampleFormat } from '../pipeline/plan/sample-coding';
import { pixelAspectOf, resolveVideoGeometry, uprightRotation } from '../stages/frame-geometry';
import type { ResolvedProject } from '../pipeline/transcode/edit-types';
import type { PcmSampleFormat } from '../codecs/pcm/encoder';
import {
    runTimeline,
    type AudioEncodeLane,
    type Lane,
    type TimelineClip,
    type TimelineEnvironment,
    type TimelineJob,
    type VideoEncodeLane,
} from '../pipeline/transcode/timeline';

interface EditRunOptions {
    /** Copy packets where the output allows it (default true); false re-encodes every track. */
    readonly copy?: boolean;
    /** Receives the report once the work is decided, before output is written. */
    readonly onPlan?: (plan: MediaPlan) => void;
    readonly sink: Sink;
    readonly diagnostics: DiagnosticContext;
    /** Open inputs by identity; the caller closes them. */
    readonly files: ReadonlyMap<Source | MediaInput, MediaFile>;
    /** The only audio codec the output holds (an 'opus' target), never replaced by another. */
    readonly exactAudioCodec?: string;
}

function firstTrack(file: MediaFile, type: 'video' | 'audio'): RemuxTrack | undefined {
    const tracks = mediaFileState(file).tracks.filter(
        track => track.type === type && sampleCount(track.info),
    );
    return tracks.find(track => track.description.default) ?? tracks[0];
}

/** Nominal frames per second of a track from its median frame duration. */
function trackFps(track: RemuxTrack): number {
    const count = sampleCount(track.info);
    const durations: number[] = [];
    for (let index = 0; index < Math.min(count, 121); index++) {
        const duration = sampleAt(track.info, index)!.duration;
        if (duration > 0) durations.push(duration);
    }
    durations.sort((a, b) => a - b);
    const frame = durations[durations.length >> 1];
    return frame ? Math.round(1 / frame) || 30 : 30;
}

/**
 * A copy of a clip must start at a keyframe unless the edit list of the first clip hides the
 * lead-in.
 */
function keyframeAt(clip: TimelineClip): boolean {
    if (!clip.picture) return true;
    const index = clip.file.findSample(clip.picture.description.id, clip.start, {
        keyframe: true,
        mode: 'before',
    });
    return (
        index !== undefined &&
        Math.abs(sampleAt(clip.picture.info, index)!.timestamp - clip.start) < 1e-6
    );
}

/** Resolves the clips against their opened inputs and lays them out one after another. */
function timeline(project: ResolvedProject, files: EditRunOptions['files']): TimelineClip[] {
    let offset = 0;
    return project.clips.map((clip, index) => {
        const file = files.get(clip.input);
        if (!file) throw new MediaForgeError(`clips[${index}] input was not opened`, 'INPUT');
        const picture = firstTrack(file, 'video');
        const sound = firstTrack(file, 'audio');
        const master = picture ?? sound;
        if (!master)
            throw new MediaForgeError(
                `clips[${index}] has neither a video nor an audio track`,
                'FORMAT',
            );

        // Clip seconds count from the input's start; packet times carry an MPEG-TS clock.
        const base = file.timelineStart;
        const start = clip.start + base;
        const trackEnd = presentationEnd(master);
        const stop = Math.min(clip.end === undefined ? trackEnd : clip.end + base, trackEnd);
        if (start >= stop)
            throw new MediaForgeError(
                `clips[${index}] starts at ${clip.start} s, at or after its end at ` +
                    `${(stop - base).toFixed(3)} s`,
                'INPUT',
            );
        const duration = (stop - start) / clip.speed;
        const entry = {
            ...clip,
            start,
            ...(clip.end === undefined ? {} : { end: clip.end + base }),
            file,
            picture,
            sound,
            stop,
            offset,
            duration,
        };
        offset += duration;
        return entry;
    });
}

/**
 * Why the video of the project cannot be copied, or undefined when every clip's packets can pass
 * through.
 */
function videoCopyBlocker(
    clips: readonly TimelineClip[],
    project: ResolvedProject,
    request: ConvertRequest,
    options: EditRunOptions,
): string | undefined {
    const first = clips[0]!.picture;
    if (!first) return 'the first clip has no video';
    if (options.copy === false) return 'copying was turned off';
    if (project.overlays.length) return 'overlays are drawn';
    if (project.fps !== undefined) return 'a constant frame rate was requested';
    if (request.videoBitrate) return 'a video bitrate was requested';
    if (
        request.videoCodec !== undefined &&
        codecFamily(request.videoCodec) !== codecFamily(first.info.codec)
    )
        return `the output codec ${request.videoCodec} differs from the source ${first.info.codec}`;
    if (!canMuxCodec(request.format, 'video', first.info.codec))
        return `${request.format} cannot carry ${first.info.codec}`;
    if (lacksMp4Configuration(first.info, 'video', request.format, false))
        return `the input lacks the decoder configuration ${request.format} needs`;

    const { width, height } = first.info;
    if (
        (project.width !== undefined && project.width !== width) ||
        (project.height !== undefined && project.height !== height)
    )
        return 'the output size differs from the source';

    for (const [index, clip] of clips.entries()) {
        const video = clip.picture;
        if (!video) return `clips[${index}] has no video`;
        if (clip.speed !== 1) return `clips[${index}] changes speed`;
        if (clip.video.changed) return `clips[${index}] changes the picture`;
        const differs =
            video.info.codec !== first.info.codec
                ? 'codec'
                : video.info.width !== width || video.info.height !== height
                  ? 'size'
                  : (video.info.rotation ?? 0) !== (first.info.rotation ?? 0)
                    ? 'rotation'
                    : !sameBytes(video.info.codecConfig, first.info.codecConfig) ||
                        (video.info.codecConfigurations?.length ?? 0) > 1
                      ? 'codec configuration'
                      : undefined;
        if (differs) return `clips[${index}] differs from the first clip in ${differs}`;
        if (index > 0 && !keyframeAt(clip))
            return `clips[${index}] starts at ${clip.start} s, which is not a keyframe`;
        if (index === 0 && !keepsExactTrim(request.format) && !keyframeAt(clip))
            return (
                `${request.format} cannot present a copy from ${clip.start} s, which is not a ` +
                `keyframe`
            );
    }
    return undefined;
}

/**
 * Why the audio cannot be copied; every clip must carry the same untouched audio and nothing is
 * mixed in.
 */
function audioCopyBlocker(
    clips: readonly TimelineClip[],
    project: ResolvedProject,
    request: ConvertRequest,
    options: EditRunOptions,
    videoBlocker: string | undefined,
): string | undefined {
    const first = clips[0]!.sound;
    if (!first) return 'the first clip has no audio';
    if (options.copy === false) return 'copying was turned off';
    if (project.audio.length) return 'extra audio is mixed in';
    if (clips.some(clip => clip.picture) && videoBlocker !== undefined)
        return 'the video is re-encoded';

    if (
        request.audioBitrate ||
        (request.audioSampleRate && request.audioSampleRate !== first.info.sampleRate) ||
        (request.audioChannels && request.audioChannels !== first.info.channelCount)
    )
        return 'audio settings were requested';
    if (
        request.audioCodec !== undefined &&
        codecFamily(request.audioCodec) !== codecFamily(first.info.codec)
    )
        return `the output codec ${request.audioCodec} differs from the source ${first.info.codec}`;
    if (!canMuxCodec(request.format, 'audio', first.info.codec))
        return `${request.format} cannot carry ${first.info.codec}`;
    if (lacksMp4Configuration(first.info, 'audio', request.format, true))
        return `the input lacks the decoder configuration ${request.format} needs`;

    for (const [index, clip] of clips.entries()) {
        const sound = clip.sound;
        if (!sound) return `clips[${index}] has no audio`;
        if (clip.audio.mute) return `clips[${index}] is muted`;
        if (clip.speed !== 1) return `clips[${index}] changes speed`;
        if (clip.audio.volume !== 1 || clip.audio.fade.in > 0 || clip.audio.fade.out > 0)
            return `clips[${index}] changes its audio level`;
        if (
            sound.info.codec !== first.info.codec ||
            sound.info.sampleRate !== first.info.sampleRate ||
            sound.info.channelCount !== first.info.channelCount ||
            !sameBytes(sound.info.codecConfig, first.info.codecConfig) ||
            (sound.info.codecConfigurations?.length ?? 0) > 1
        )
            return `clips[${index}] differs from the first clip in audio codec or layout`;
    }
    return undefined;
}

/** The audio tracks mixed under the clips, each with its opened input and first audio track. */
function layersOf(project: ResolvedProject, files: EditRunOptions['files']): TimelineJob['layers'] {
    return project.audio.map((track, index) => {
        const file = files.get(track.input);
        if (!file) throw new MediaForgeError(`audio[${index}] input was not opened`, 'INPUT');
        const sound = firstTrack(file, 'audio');
        if (!sound) throw new MediaForgeError(`audio[${index}] has no audio track`, 'FORMAT');
        const end = Math.min(track.end ?? Infinity, presentationEnd(sound));
        return { ...track, end, file, track: sound };
    });
}

/** The encoded video lane of a project: one geometry per clip, contained in the output size. */
function videoLane(
    clips: TimelineClip[],
    project: ResolvedProject,
    request: ConvertRequest,
    diagnostics: DiagnosticContext,
): VideoEncodeLane {
    const first = clips[0]!;
    const repairs = new OptionNormalizer(resolveOptionPolicy(diagnostics.validation), 'project');
    const natural = resolveVideoGeometry(
        {
            width: first.picture!.info.width,
            height: first.picture!.info.height,
            rotation: uprightRotation(first.picture!.info.rotation),
            pixelAspect: pixelAspectOf(first.picture!.info),
        },
        { crop: first.video.crop, rotate: first.video.rotate, flip: first.video.flip },
        repairs,
        true,
    );
    const width =
        project.width ??
        request.width ??
        (project.height !== undefined ? undefined : natural.width);
    const height =
        project.height ??
        request.height ??
        (project.width !== undefined ? undefined : natural.height);
    for (const [index, clip] of clips.entries()) {
        if (!clip.picture)
            throw new MediaForgeError(`clips[${index}] has no video track to draw`, 'FORMAT');
        clips[index] = {
            ...clip,
            geometry: resolveVideoGeometry(
                {
                    width: clip.picture.info.width,
                    height: clip.picture.info.height,
                    rotation: uprightRotation(clip.picture.info.rotation),
                    pixelAspect: pixelAspectOf(clip.picture.info),
                },
                {
                    crop: clip.video.crop,
                    rotate: clip.video.rotate,
                    flip: clip.video.flip,
                    width: width ?? natural.width,
                    height: height ?? natural.height,
                    fit: clip.video.fit ?? 'contain',
                },
                repairs,
                true,
            ),
        };
    }
    for (const finding of repairs.findings)
        diagnostics.warn({ code: finding.code, message: finding.message });
    if (!hostCodecAvailable('VideoEncoder'))
        throw new MediaForgeError('Editing video needs a WebCodecs VideoEncoder', 'ENCODE', {
            hint: 'Edit in a current browser.',
        });
    const plan = CONTAINER_CODEC_PLANS[request.format];
    const codec =
        (request.videoCodec
            ? request.videoCodec
            : resolveSupportedCodec(first.picture!.info.codec, plan?.video, plan?.defaultVideo)) ||
        plan?.defaultVideo ||
        first.picture!.info.codec;

    // Clips that change speed keep the first clip's frame rate unless the project sets one.
    const fps =
        project.fps ??
        (clips.some(clip => clip.speed !== 1)
            ? measuredFramerate(first.picture!.info) || 30
            : undefined);
    return {
        action: 'encode',
        codec,
        explicit: request.videoCodec?.includes('.') === true,
        fps,
        framerate: fps ?? trackFps(first.picture!),
        bitrate: request.videoBitrate,
        keyframeInterval: request.keyframeInterval ?? 2,
        encoder: {
            hardwareAcceleration: request.hardwareAcceleration,
            latencyMode: request.latencyMode,
            bitrateMode: request.bitrateMode,
        },
        bitDepth: 8,
        stages: request.videoStages ?? [],
    };
}

/**
 * Reports the clips' tracks an edit leaves out: it keeps each clip's first video and audio track.
 */
function reportUnusedTracks(
    clips: readonly TimelineClip[],
    diagnostics: DiagnosticContext,
    format: string,
): void {
    const left = new Map<string, number>();
    const seen = new Set<MediaFile>();
    for (const clip of clips) {
        if (seen.has(clip.file)) continue;
        seen.add(clip.file);
        for (const track of mediaFileState(clip.file).tracks)
            if (track !== clip.picture && track !== clip.sound && sampleCount(track.info))
                left.set(track.type, (left.get(track.type) ?? 0) + 1);
    }
    if (!left.size) return;
    const list = [...left].map(([type, count]) => `${count} ${type}`).join(', ');
    diagnostics.warn({
        code: 'TARGET_TRACKS_DROPPED',
        format,
        message: `Edit leaves out extra tracks: ${list}`,
    });
}

/**
 * The container job of a project: copied lanes where the clips allow it, encoded lanes otherwise.
 */
function containerJob(
    project: ResolvedProject,
    clips: TimelineClip[],
    request: ConvertRequest,
    options: EditRunOptions,
): TimelineJob {
    const { diagnostics } = options;
    const format = request.format;
    reportUnusedTracks(clips, diagnostics, format);
    const hasVideo = clips.some(clip => clip.picture);
    const videoBlocker = !hasVideo
        ? 'the project has no video'
        : request.videoStages
          ? 'video stages process the pictures'
          : videoCopyBlocker(clips, project, request, options);
    const videoCopied = hasVideo && videoBlocker === undefined;
    if (
        hasVideo &&
        !videoCopied &&
        videoBlocker &&
        /keyframe|differs|cannot carry|no video/.test(videoBlocker)
    )
        diagnostics.warn({
            code: 'EDIT_REENCODED',
            format,
            message: `video is re-encoded because ${videoBlocker}`,
        });

    const audioCopied =
        !request.audioStages &&
        audioCopyBlocker(clips, project, request, options, videoBlocker) === undefined;
    const silent = clips.every(clip => !clip.sound || clip.audio.mute) && !project.audio.length;
    const video: Lane<VideoEncodeLane> | undefined = !hasVideo
        ? undefined
        : videoCopied
          ? { action: 'copy' }
          : videoLane(clips, project, request, diagnostics);

    let audio: Lane<AudioEncodeLane> | undefined;
    if (audioCopied) audio = { action: 'copy' };
    else if (!silent) {
        const plan = CONTAINER_CODEC_PLANS[format];
        const first = clips[0]!.sound;
        const codec =
            request.audioCodec ||
            resolveSupportedCodec(first?.info.codec, plan?.audio, plan?.defaultAudio) ||
            plan?.defaultAudio ||
            'mp4a.40.2';
        assertAudioEncodeRequest(codec);

        const sampleFormat = flacSampleFormat(
            codec,
            clips,
            layersOf(project, options.files),
            request,
            diagnostics,
        );
        audio = {
            action: 'encode',
            codec,
            sampleRate: request.audioSampleRate,
            channels: request.audioChannels,
            bitrate: request.audioBitrate,
            ...(sampleFormat ? { sampleFormat } : {}),
            stages: request.audioStages ?? [],
        };
    }

    const only = clips.length === 1 ? clips[0]! : undefined;
    const state = only ? mediaFileState(only.file) : undefined;
    return {
        sink: { kind: 'container', format: format as OutputContainerFormat },
        clips,
        layers: layersOf(project, options.files),
        overlays: project.overlays,
        background: project.background,
        video,
        audio,
        metadata: {
            title: state?.title,
            video: clips[0]!.picture?.info,
            audio: project.audio.length ? undefined : clips[0]!.sound?.info,
        },
    };
}

/**
 * What an edit does with its tracks: the first clip's picture and sound are reported for their
 * lanes.
 */
function editPlan(
    environment: TimelineEnvironment,
    job: TimelineJob,
    request: ConvertRequest | AudioFileRequest,
): MediaPlan {
    const picture = job.clips.find(clip => clip.picture)?.picture;
    const sound = job.clips.find(clip => clip.sound)?.sound;
    const preference = request.codecPreference ?? environment.codecPreference;
    const entry = (track: RemuxTrack, codec: string): TrackPlan => ({
        trackId: track.description.id,
        type: track.type as TrackPlan['type'],
        action: codec === track.info.codec ? 'copy' : 'encode',
        sourceCodec: track.info.codec,
        codec,
    });
    const audioEncoder = (
        codec: string,
        native: boolean,
        sampleFormat: PcmSampleFormat | undefined,
    ): TrackPlan['encoder'] =>
        plannedAudioEncoder(audioEncoderOrder(codec, native, preference, sampleFormat));
    const names = (
        stages: readonly { readonly name: string }[],
        added: readonly string[] = [],
    ): { stages?: string[] } =>
        stages.length || added.length
            ? { stages: [...stages.map(stage => stage.name), ...added] }
            : {};
    const speeds = job.clips.some(clip => clip.speed !== 1);

    // The stages a speed or a frame rate adds: retiming, the rate's own stage, and the sound's
    // stretch or resampling.
    const videoAdded = (fps: number | undefined): string[] => [
        ...(speeds ? ['speed'] : []),
        ...(fps === undefined ? [] : ['fps']),
    ];
    const soundAdded = [
        ...new Set(
            job.clips
                .filter(clip => clip.speed !== 1 && clip.sound && !clip.audio.mute)
                .map(clip => (clip.audio.speed === 'shift-pitch' ? 'resample' : 'time-stretch')),
        ),
    ];
    const tracks: TrackPlan[] = [];
    const { sink, video, audio } = job;
    if (sink.kind === 'audio') {
        if (sound) {
            const sounds = job.clips.flatMap(clip => (clip.sound ? [clip.sound.info] : []));
            const sampleFormat = widestSampleFormat(sounds, sink, () => undefined);
            const codec = audioFileCodec(sink.format, sink.codec, sampleFormat);
            tracks.push({
                ...entry(sound, codec),
                action: 'encode',
                encoder: audioEncoder(
                    audioFormatCodec(sink.format) ?? sink.format,
                    true,
                    sampleFormat,
                ),
                ...names(sink.stages, soundAdded),
            });
        }
    } else {
        if (picture && video)
            tracks.push(
                video.action === 'copy'
                    ? entry(picture, picture.info.codec)
                    : {
                          ...entry(picture, video.codec),
                          action: 'encode',
                          encoder: video.encodeWith ? 'plugin' : 'webcodecs',
                          ...(video.fps !== undefined ? { fps: video.fps } : {}),
                          ...names(video.stages, videoAdded(video.fps)),
                      },
            );
        if (sound && audio)
            tracks.push(
                audio.action === 'copy'
                    ? entry(sound, sound.info.codec)
                    : {
                          ...entry(sound, audio.codec),
                          action: 'encode',
                          encoder: audioEncoder(
                              audio.codec,
                              builtinAudioEncoding(
                                  audio.codec,
                                  48000,
                                  2,
                                  environment.containerAudio?.codecs ?? [],
                              ) !== undefined,
                              audio.sampleFormat,
                          ),
                          ...names(audio.stages, soundAdded),
                      },
            );
    }
    return {
        format: sink.format,
        action: tracks.every(track => track.action === 'copy') ? 'copy' : 'reencode',
        tracks,
        duration: Math.max(0, ...job.clips.map(clip => clip.offset + clip.duration)),
    };
}

/** FLAC keeps the deepest source's samples, as a FLAC file does; other codecs take none. */
function flacSampleFormat(
    codec: string,
    clips: readonly TimelineClip[],
    layers: TimelineJob['layers'],
    request: ConvertRequest,
    diagnostics: DiagnosticContext,
): PcmSampleFormat | undefined {
    if (codecFamily(codec) !== 'flac') return undefined;
    return widestSampleFormat(
        [
            ...clips.flatMap(clip => (clip.sound && !clip.audio.mute ? [clip.sound.info] : [])),
            ...layers.map(layer => layer.track.info),
        ],
        { format: 'flac', allowPrecisionLoss: request.allowPrecisionLoss },
        warning => diagnostics.warn({ ...warning, format: request.format }),
    );
}

/**
 * An encoded audio lane whose codec neither the host nor an installed encoder writes takes the
 * first codec of the container's `'auto'` order one does, reported as CODEC_SUBSTITUTED, as
 * conversions do (Opus into Ogg in Node becomes FLAC); the strict option policy keeps the request,
 * and a target that holds one codec (`exact`, an 'opus' target) fails naming it.
 */
async function substituteAudioCodec(
    environment: TimelineEnvironment,
    job: TimelineJob,
    request: ConvertRequest,
    diagnostics: DiagnosticContext,
    exact?: string,
): Promise<TimelineJob> {
    const lane = job.audio;
    if (
        lane?.action !== 'encode' ||
        (resolveOptionPolicy(diagnostics.validation) === 'strict' && !exact)
    )
        return job;
    const sound = job.clips.find(clip => clip.sound)?.sound?.info;
    const choice = await encodableAudioCodec(
        lane.codec,
        request.format,
        environment.containerAudio?.codecs ?? [],
        audioEncodeQuery(
            lane.sampleRate ?? sound?.sampleRate ?? 48000,
            lane.channels ?? sound?.channelCount,
            lane.bitrate,
        ),
        request.signal,
    );
    if (choice && !choice.substituted) return job;
    if (exact) throw requiredEncoderError(exact);
    if (!choice) return job;
    const chosen = choice.codec;
    diagnostics.warn({
        code: 'CODEC_SUBSTITUTED',
        format: request.format,
        message: substitutedMessage('audio', chosen, lane.codec),
    });

    const sampleFormat = flacSampleFormat(chosen, job.clips, job.layers, request, diagnostics);
    const { sampleFormat: _previous, ...rest } = lane;
    return { ...job, audio: { ...rest, codec: chosen, ...(sampleFormat ? { sampleFormat } : {}) } };
}

/**
 * A host that cannot encode the encoded lane's codec at the output size takes the first codec of
 * the container's `'auto'` order it can, reported as CODEC_SUBSTITUTED, as conversions do; the
 * strict option policy keeps the request, which then fails naming the codec.
 */
async function substituteVideoCodec(
    job: TimelineJob,
    request: ConvertRequest,
    diagnostics: DiagnosticContext,
): Promise<TimelineJob> {
    const lane = job.video;
    const geometry = job.clips[0]?.geometry;
    if (
        lane?.action !== 'encode' ||
        !geometry ||
        lane.encodeWith ||
        resolveOptionPolicy(diagnostics.validation) === 'strict'
    )
        return job;
    const query = {
        width: geometry.width,
        height: geometry.height,
        framerate: lane.framerate,
        bitrate: lane.bitrate,
        container: request.format,
        explicit: lane.explicit,
        ...lane.encoder,
    };

    const choice = await encodableVideoCodec(lane.codec, request.format, query, request.signal);
    if (!choice?.substituted) return job;
    diagnostics.warn({
        code: 'CODEC_SUBSTITUTED',
        format: request.format,
        message: substitutedMessage('video', choice.codec, lane.codec),
    });
    return { ...job, video: { ...lane, codec: choice.codec, explicit: true } };
}

/**
 * Produces one output from a project: clips are copied when their packets fit the output and
 * re-encoded through the host codecs otherwise; audio is mixed unless every clip carries the same
 * untouched audio track.
 */
export async function runEdit(
    environment: TimelineEnvironment,
    project: ResolvedProject,
    request: ConvertRequest | AudioFileRequest,
    options: EditRunOptions,
): Promise<MediaPlan> {
    const { sink, diagnostics, files } = options;
    const clips = timeline(project, files);
    const linked = linkAbortSignals(
        request.signal,
        sink.signal,
        ...[...files.values()].map(file => mediaFileState(file).signal),
    );
    try {
        const job: TimelineJob =
            request.operation === 'audio'
                ? {
                      sink: {
                          kind: 'audio',
                          format: request.format,
                          codec: request.codec,
                          sampleRate: request.sampleRate,
                          channels: request.channels,
                          bitrate: request.bitrate,
                          vbr: request.vbr,
                          stages: request.stages ?? [],
                          allowPrecisionLoss: request.allowPrecisionLoss,
                      },
                      clips,
                      layers: layersOf(project, files),
                      overlays: [],
                      background: project.background,
                      metadata: {},
                  }
                : await substituteAudioCodec(
                      environment,
                      await substituteVideoCodec(
                          containerJob(project, clips, request, options),
                          request,
                          diagnostics,
                      ),
                      request,
                      diagnostics,
                      options.exactAudioCodec,
                  );

        const plan = editPlan(environment, job, request);
        options.onPlan?.(plan);
        await runTimeline(environment, job, {
            sink,
            diagnostics,
            signal: linked.signal,
            codecPreference: request.codecPreference,
            onProgress: request.onProgress,
        });
        return plan;
    } finally {
        linked.dispose();
    }
}

/** How an edit opens its inputs and what it reports. */
export interface EditProjectOptions {
    readonly open?: OpenOptions;
    readonly copy?: boolean;
    readonly onPlan?: (plan: MediaPlan) => void;
    /** The only audio codec the output holds (an 'opus' target): encoded, never replaced. */
    readonly exactAudioCodec?: string;
}

/**
 * Writes one file from a project into `sink` (closed on success) on `engine`: clips in order, extra
 * audio mixed under them and overlays drawn on top. Packets are copied where the output allows it
 * and re-encoded otherwise.
 */
export async function editProject(
    engine: Engine,
    resolved: ResolvedProject,
    sink: Sink,
    request: OperationRequest,
    options: EditProjectOptions = {},
): Promise<MediaPlan> {
    assertSink(sink);
    const open = options.open ?? {};
    checkSignal(open.signal);
    checkSignal(sink.signal);
    const diagnostics = new DiagnosticContext(open, 'compatible');
    const target =
        request.operation !== 'remux'
            ? request
            : (AUDIO_FILE_FORMATS as readonly string[]).includes(request.format)
              ? {
                    operation: 'audio' as const,
                    format: request.format as (typeof AUDIO_FILE_FORMATS)[number],
                }
              : { operation: 'convert' as const, format: request.format as OutputContainerFormat };
    const exact = options.exactAudioCodec;
    const output =
        exact && target.operation === 'convert' ? { ...target, audioCodec: exact } : target;

    if (output.operation !== 'audio') await engine.loadWriter(output.format);
    const linked = linkAbortSignals(open.signal, request.signal, sink.signal);
    const files = new Map<ResolvedProject['clips'][number]['input'], MediaFile>();
    try {
        const environment = await engine.timelineEnvironment();
        // A large MPEG-TS or Matroska input whose clips all end is read from its start to after
        // the last of them, as a converted range is, instead of indexed whole.
        const spans = new Map<ResolvedProject['clips'][number]['input'], number | undefined>();
        for (const entry of [...resolved.clips, ...resolved.audio]) {
            const end = spans.has(entry.input) ? spans.get(entry.input) : 0;
            spans.set(
                entry.input,
                end === undefined || entry.end === undefined ? undefined : Math.max(end, entry.end),
            );
        }
        for (const [input, end] of spans) {
            files.set(
                input,
                await engine.open(
                    input,
                    { ...open, signal: linked.signal },
                    [],
                    end === undefined ? undefined : { range: { start: 0, end, fromStart: true } },
                ),
            );
            checkSignal(linked.signal);
        }
        return await runEdit(
            environment,
            resolved,
            { ...output, signal: linked.signal, onProgress: request.onProgress },
            {
                copy: options.copy,
                onPlan: options.onPlan,
                sink,
                diagnostics,
                files,
                exactAudioCodec: exact,
            },
        );
    } finally {
        for (const file of files.values()) file.close();
        linked.dispose();
    }
}
