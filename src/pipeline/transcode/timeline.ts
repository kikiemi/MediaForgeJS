import type { FormatWriters } from '../plugins/missing-parts';
import { mp4aAudioObjectType } from '../../core/model/codec-strings';
import { sampleAt, sampleCount } from '../../core/model/sample-index';
import { encodedAudioTrack } from '../codecs/part-codecs';
import { normalizePcmSource, type ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { isPcmOutputMuxer } from '../../formats/audio-files/pcm-writer';
import { yieldEventLoop } from '../../core/io/event-loop';
import { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import type { DiagnosticContext, MediaDiagnostic } from '../../core/errors/diagnostics';
import { MediaForgeError } from '../../core/errors/errors';
import { MP4_FAMILY, containerLayout, isIsoOutput } from '../../formats/shared/capabilities';
import type { MediaFile } from '../read/media-file';
import type { FilePacket, RemuxTrack, TrimPlan } from '../media-types';
import {
    copiedAudioTrack,
    copiedSubtitleTrack,
    copiedVideoTrack,
    keptForced,
    splicedCopyLoss,
} from '../copy/copied-track';
import { copyRoute, trimmedTrack } from '../copy/remux-plan';
import { copiedEnd, keepsExactTrim, planTrim, reportTrimCuts } from '../copy/trim-plan';
import { drainSink } from '../../core/io/sinks/sink-backpressure';
import { copySink } from '../copy/copy-sink';
import type {
    AudioTrackConfig,
    MuxerConfig,
    OutputMuxer,
    VideoTrackConfig,
} from '../../core/contracts/writer';
import type { Sink } from '../../core/model/types';
import type {
    EncodedPacket,
    MatroskaPassThrough,
    MediaTags,
    OutputContainerFormat,
} from '../../core/model/media';
import type { TrackInfo } from '../../core/model/track';
import type { BuiltinVideoCodec } from '../../core/contracts/decoder';
import { DEFAULT_AUDIO_BITRATE, encodedAudioShape } from '../plan/encode-settings';
import type { HostVideoEncoderOptions } from '../../codecs/webcodecs/video-options';
import { Interleaver } from '../copy/interleave';
import type { AudioFileWriter, AudioTrackDecoder, AudioFileFormat, PcmCoding } from '../types';
import type { MediaProgress } from '../../core/model/media';
import type { CodecPreference } from '../api-types';
import type { VideoGeometry } from '../../stages/frame-geometry';
import type { ResolvedAudioTrack, ResolvedClip, ResolvedOverlay } from './edit-types';
import { loadOverlays, overlayPainter, releaseOverlays } from './edit-video';
import { AudioTrackEncoder } from '../codecs/track-encoder';
import type { ContainerAudioEncoder } from '../codecs/container-audio';
import { sameBytes } from '../../core/bytes/bytes';
import type { AudioStage, StageDefinition, VideoStage } from '../../core/contracts/stage';
import {
    createStages,
    stagedPcmSource,
    VideoStageChain,
    type StageFactory,
} from '../../stages/chain';
import { frameRateStage } from '../../stages/video';
import { renderVideoClips, type VideoClip } from './video-lane';
import { openVideoEncoder, signalPictures, type EncoderPort } from '../codecs/video-codecs';
import type { VideoCodecProvider } from '../../core/contracts/encoder';
import { timelineSound, type SoundSpan } from './audio-lane';
import { trackPcm, type PcmSettings } from './track-pcm';
import type { TrackPacketRead } from './pcm-source';
import { ClipRead } from './shared-read';
import { audioFileSettings } from './audio-plan';
import { widestSampleFormat } from '../plan/sample-coding';
import type { PcmSampleFormat } from '../../codecs/pcm/encoder';

/** The codecs and writers a timeline runs with. */
export interface TimelineEnvironment {
    readonly writers: FormatWriters;
    readonly videoDecoders: readonly BuiltinVideoCodec[];
    readonly codecPreference: CodecPreference;
    readonly audioDecoder?: AudioTrackDecoder;
    /** Writers of audio files. */
    readonly audio?: AudioFileWriter;
    /** Built-in FLAC, MP2 and MP3 encoders for container tracks. */
    readonly containerAudio?: ContainerAudioEncoder;
    /** Application video codecs; one that decodes a clip's codec decodes it. */
    readonly providers?: readonly VideoCodecProvider[];
    /** The plugins' processing stages, which `video.stages` and `audio.stages` name. */
    readonly stages?: readonly StageDefinition[];
}

/** A clip of the timeline resolved against its opened input. */
export interface TimelineClip extends ResolvedClip {
    readonly file: MediaFile;
    readonly picture?: RemuxTrack;
    readonly sound?: RemuxTrack;
    /** Resolved packet-layer end of the source range. */
    readonly stop: number;
    /** Output seconds where the clip starts, and the seconds it covers. */
    readonly offset: number;
    readonly duration: number;
    /** The pixel transform of an encoded picture. */
    readonly geometry?: VideoGeometry;
}

/** Re-encoded video of a timeline. */
export interface VideoEncodeLane {
    readonly action: 'encode';
    /** Codec family or string; the host VideoEncoder settles the profile and level. */
    readonly codec: string;
    /** The codec string names a profile, which is kept. */
    readonly explicit: boolean;
    /**
     * Constant output rate; omitted keeps the source timing (each clip's pictures retimed by its
     * speed).
     */
    readonly fps?: number;
    /** Nominal rate the encoder is configured for. */
    readonly framerate: number;
    readonly bitrate?: number;
    readonly keyframeInterval: number;
    readonly encoder: HostVideoEncoderOptions;
    /** 10 for high-dynamic-range sources. */
    readonly bitDepth: 8 | 10;
    /** Counter-clockwise display rotation of the output track. */
    readonly rotation?: number;
    /** The caller's stages, run after the clip transform and before the frame rate. */
    readonly stages: readonly StageFactory<VideoStage>[];
    /** An application codec that encodes instead of the host VideoEncoder. */
    readonly encodeWith?: VideoCodecProvider;
    /** false refuses pictures that an application codec would reduce to 8 bits. */
    readonly allowPrecisionLoss?: boolean;
}

/** Re-encoded audio of a timeline. */
export interface AudioEncodeLane {
    readonly action: 'encode';
    readonly codec: string;
    readonly sampleRate?: number;
    readonly channels?: number;
    /** Bits per second. */
    readonly bitrate?: number;
    /** Samples of encoded FLAC: 24-bit kept from deeper sources; default 16-bit. */
    readonly sampleFormat?: PcmSampleFormat;
    readonly stages: readonly StageFactory<AudioStage>[];
}

export type Lane<T> = { readonly action: 'copy' } | T;

/** Where the timeline is written: a container, or an audio file. */
export type TimelineSink =
    | { readonly kind: 'container'; readonly format: OutputContainerFormat }
    | {
          readonly kind: 'audio';
          readonly format: AudioFileFormat;
          readonly codec?: PcmCoding;
          readonly sampleRate?: number;
          readonly channels?: number;
          /** Bits per second. */
          readonly bitrate?: number;
          readonly vbr?: boolean;
          readonly stages: readonly StageFactory<AudioStage>[];
          /** false refuses output that would hold fewer bits than the sources. */
          readonly allowPrecisionLoss?: boolean;
      };

/** What a single-input output keeps of its input. */
export interface TimelineMetadata {
    readonly title?: string;
    /** The input's tags, chapters and pictures. */
    readonly tags?: MediaTags;
    readonly matroskaPassThrough?: MatroskaPassThrough;
    /** Source tracks whose identity, names, languages and dispositions the output tracks keep. */
    readonly video?: TrackInfo;
    readonly audio?: TrackInfo;
}

export interface TimelineJob {
    readonly sink: TimelineSink;
    readonly clips: readonly TimelineClip[];
    /** Sound mixed under the clips, its inputs opened. */
    readonly layers: readonly (ResolvedAudioTrack & {
        readonly file: MediaFile;
        readonly track: RemuxTrack;
    })[];
    readonly overlays: readonly ResolvedOverlay[];
    readonly background: string;
    readonly video?: Lane<VideoEncodeLane>;
    readonly audio?: Lane<AudioEncodeLane>;
    /** Further tracks of the first clip, copied as they are next to the lanes. */
    readonly copies?: readonly RemuxTrack[];
    readonly metadata: TimelineMetadata;
}

export interface TimelineRun {
    readonly sink: Sink;
    readonly diagnostics: DiagnosticContext;
    readonly signal: AbortSignal;
    readonly codecPreference?: CodecPreference;
    readonly onProgress?: (progress: MediaProgress) => void;
}

interface CopySpan {
    readonly clip: TimelineClip;
    readonly trim: TrimPlan;
    /** Media seconds of the output where the clip's packets are placed. */
    readonly offset: number;
    readonly presentedStart: number;
    readonly presentedEnd: number;
    /** Where each copied track's presentation ends on the output's timeline. */
    readonly trackEnds: ReadonlyMap<RemuxTrack, number>;
}

/**
 * Which copied tracks of a clip a copy lane routes: its picture, its sound and the job's other
 * copied tracks.
 */
interface CopySelection {
    readonly video: boolean;
    readonly audio: boolean;
    readonly extras: readonly RemuxTrack[];
}

function copiedTracks(clip: TimelineClip, selection: CopySelection, first: boolean): RemuxTrack[] {
    const tracks: RemuxTrack[] = [];
    if (selection.video && clip.picture) tracks.push(clip.picture);
    if (selection.audio && clip.sound) tracks.push(clip.sound);
    if (first) tracks.push(...selection.extras);
    return tracks;
}

/**
 * Lays copied clips end to end on one decode timeline; the first clip keeps its own packet timing.
 */
function copySpans(
    clips: readonly TimelineClip[],
    format: string,
    tracks: (clip: TimelineClip) => RemuxTrack[],
): CopySpan[] {
    const spans: CopySpan[] = [];
    let media = 0;
    const lastDecode = new Map<string, number>();
    for (const [index, clip] of clips.entries()) {
        const selected = tracks(clip);
        const range = { start: clip.start, end: clip.end };
        const video = selected.filter(track => track.type === 'video');

        // Audio runs on to the last picture, which reordered video may show past the range end. The
        // last clip's runs to its own end when the range has none, as its encoded sound does.
        const audioEnd =
            video.length && (clip.end !== undefined || index < clips.length - 1)
                ? [...planTrim(clip.file, video, range, format).cuts.entries()].reduce(
                      (end, [id, cut]) =>
                          Math.max(
                              end,
                              copiedEnd(
                                  video.find(track => track.description.id === id)!,
                                  cut,
                                  cut.decodeEnd ?? clip.end,
                              ).presented,
                          ),
                      clip.end ?? 0,
                  )
                : undefined;
        const trim = planTrim(clip.file, selected, range, format, {
            audioAfter: index > 0,
            audioEnd,
        });

        // Copied pictures and sound continue from clip to clip: each clip must hold packets of
        // them.
        const empty = selected.find(
            track => track.type !== 'subtitle' && !trim.cuts.has(track.description.id),
        );
        if (empty)
            throw new MediaForgeError(
                `clip ${index + 1} holds no packets of ${empty.type} track ` +
                    `${empty.description.id} in its range`,
                'INPUT',
            );
        const lead = video[0] ?? selected[0]!;
        const cut = trim.cuts.get(lead.description.id)!;

        // The lead track's first packet lands where the previous clip ended; the first clip keeps
        // its own timing.
        let offset = index === 0 ? 0 : media - (cut.time - trim.origin);
        const leadDecode = cut.decodeStart - trim.origin + offset;
        const previous = lastDecode.get(lead.type) ?? Number.NEGATIVE_INFINITY;
        if (leadDecode <= previous) offset += previous - leadDecode + 1e-6;

        // A track without a cut (a subtitle track with no cue in the range) copies nothing.
        const ends = selected.flatMap(track => {
            const own = trim.cuts.get(track.description.id);
            return own
                ? [{ track, type: track.type, ...copiedEnd(track, own, own.decodeEnd ?? clip.end) }]
                : [];
        });
        const presentedStart =
            index === 0 && keepsExactTrim(format)
                ? clip.start - trim.origin + offset
                : cut.time - trim.origin + offset;
        let presentedEnd =
            Math.max(...ends.filter(end => end.type === lead.type).map(end => end.presented)) -
            trim.origin +
            offset;

        // An edit list ends the presentation exactly at the last clip's end.
        const exactEnd =
            index === clips.length - 1 && keepsExactTrim(format) && clip.end !== undefined
                ? clip.end - trim.origin + offset
                : Infinity;
        presentedEnd = Math.min(presentedEnd, exactEnd);
        const trackEnds = new Map(
            ends.map(end => [end.track, Math.min(end.presented - trim.origin + offset, exactEnd)]),
        );
        for (const end of ends)
            lastDecode.set(
                end.type,
                Math.max(lastDecode.get(end.type) ?? -Infinity, end.decode - trim.origin + offset),
            );
        media = presentedEnd;
        spans.push({ clip, trim, offset, presentedStart, presentedEnd, trackEnds });
    }
    return spans;
}

/** Track identity and labels of an output track in `format` taken from its source track. */
function trackLabels(
    info: TrackInfo | undefined,
    format: string,
): Pick<
    VideoTrackConfig,
    | 'matroskaTrackUid'
    | 'language'
    | 'default'
    | 'forced'
    | 'name'
    | 'title'
    | 'commentary'
    | 'dispositions'
> {
    if (!info) return {};
    return {
        matroskaTrackUid: info.matroskaTrackUid,
        language: info.language,
        default: info.default,
        forced: keptForced(info, format),
        name: info.name,
        title: info.title,
        commentary: info.commentary,
        dispositions: info.dispositions,
    };
}

/** Reads the packets of the track a clip or a mixed-in track (its owner) sounds. */
type SoundRead = (owner: object, file: MediaFile, track: RemuxTrack) => TrackPacketRead;

/**
 * The sounding spans of the timeline, every unmuted clip's sound and then the mixed-in tracks, with
 * their sound read through `read`.
 */
function soundSources(
    job: TimelineJob,
    total: number,
    clipSpan: (clip: TimelineClip) => {
        start: number;
        end: number;
        offset: number;
        length: number;
    },
    settings: PcmSettings,
    read: SoundRead,
): { readonly span: SoundSpan; readonly source: ReplayablePcmSource }[] {
    const sources: { span: SoundSpan; source: ReplayablePcmSource }[] = [];
    const add = (owner: object, span: SoundSpan): void => {
        const source = trackPcm(
            span.file,
            span.track,
            settings,
            read(owner, span.file, span.track),
        );
        sources.push({ span, source });
    };
    for (const clip of job.clips) {
        if (!clip.sound || clip.audio.mute) continue;
        const range = clipSpan(clip);
        add(clip, {
            file: clip.file,
            track: clip.sound,
            start: range.start,
            end: range.end,
            speed: clip.speed,
            stretch: clip.audio.speed !== 'shift-pitch',
            offset: range.offset,
            length: range.length,
            volume: clip.audio.volume,
            fade: clip.audio.fade,
            loop: false,
        });
    }

    for (const layer of job.layers) {
        const end = layer.end ?? Infinity;
        if (layer.start >= end || layer.offset >= total) continue;
        add(layer, {
            file: layer.file,
            track: layer.track,
            start: layer.start,
            end: Number.isFinite(end) ? end : undefined,
            speed: 1,
            stretch: false,
            offset: layer.offset,
            length: layer.loop
                ? total - layer.offset
                : Math.min(end - layer.start, total - layer.offset),
            volume: layer.volume,
            fade: layer.fade,
            loop: layer.loop,
        });
    }
    return sources;
}

/**
 * Writes a timeline: clips one after another, sound mixed under them and overlays on top, with
 * every lane either copied from the source packets or decoded, run through its stages and encoded.
 * Lanes meet in one interleaved muxer, or the sound is written as an audio file.
 */
export async function runTimeline(
    environment: TimelineEnvironment,
    job: TimelineJob,
    run: TimelineRun,
): Promise<void> {
    const lifetime = new CodecLifetime(
        run.signal,
        new MediaForgeError('The conversion stopped', 'ENCODE'),
    );
    try {
        lifetime.check();
        if (job.sink.kind === 'audio')
            await writeAudioFile(environment, job, job.sink, run, lifetime);
        else await writeContainer(environment, job, job.sink.format, run, lifetime);
    } catch (error) {
        throw lifetime.record(error);
    } finally {
        lifetime.stop();
    }
}

function pcmSettings(environment: TimelineEnvironment, run: TimelineRun) {
    return {
        decoder: environment.audioDecoder,
        codecPreference: run.codecPreference ?? environment.codecPreference,
        validation: run.diagnostics.validation,
        onWarning: (warning: { code: string; message: string }) =>
            run.diagnostics.warn({ code: warning.code, message: warning.message }),
    };
}

/**
 * The earliest presentation time among the first packets of a track (its decode order may reorder
 * them).
 */
function firstPresented(track: RemuxTrack): number {
    let first = Infinity;
    for (let index = 0, count = Math.min(16, sampleCount(track.info)); index < count; index++)
        first = Math.min(first, sampleAt(track.info, track.order?.[index] ?? index)!.timestamp);
    return first;
}

function clipSpan(clip: TimelineClip): {
    start: number;
    end: number;
    offset: number;
    length: number;
} {
    return { start: clip.start, end: clip.stop, offset: clip.offset, length: clip.duration };
}

function totalOf(clips: readonly TimelineClip[]): number {
    const last = clips[clips.length - 1]!;
    return last.offset + last.duration;
}

async function writeAudioFile(
    environment: TimelineEnvironment,
    job: TimelineJob,
    sink: Extract<TimelineSink, { kind: 'audio' }>,
    run: TimelineRun,
    lifetime: CodecLifetime,
): Promise<void> {
    const total = totalOf(job.clips);
    const settings = pcmSettings(environment, run);
    // Each sounding track is read in a pass of its own.
    const reads: ClipRead[] = [];
    const sources = soundSources(job, total, clipSpan, settings, (_owner, file, track) => {
        const read = new ClipRead(file);
        reads.push(read);
        return read.reader(track);
    });
    if (!sources.length) throw new MediaForgeError('The project has no audio to write', 'FORMAT');
    const warn = (warning: Omit<MediaDiagnostic, 'severity'>): void =>
        run.diagnostics.warn({ ...warning, format: sink.format });
    const first = sources[0]!.source;

    // Several spans mix in at most stereo. Stages see the mix at the first source's rate; without
    // stages the mix is made at the output rate and channels in one pass.
    const natural = sources.length === 1 ? first.channels : Math.min(2, first.channels);
    const staged = sink.stages.length
        ? stagedPcmSource(
              timelineSound(sources, first.sampleRate, natural, total),
              sink.stages,
              (code, message) => warn({ code, message }),
          )
        : undefined;
    const { sampleRate, channels, bitrateKbps, vbr } = audioFileSettings(
        sink,
        staged ?? {
            sampleRate: first.sampleRate,
            channels: natural,
            channelMask: sources.length === 1 ? first.channelMask : undefined,
        },
        run.diagnostics.validation !== 'strict',
        warn,
    );
    const sound = !staged
        ? timelineSound(sources, sampleRate, channels, total)
        : staged.sampleRate === sampleRate && staged.channels === channels
          ? staged
          : normalizePcmSource(staged, sampleRate, channels);
    const audio = environment.audio;
    if (!audio?.formats.includes(sink.format))
        throw environment.writers.missing.audioEncoder(
            sink.format,
            `No audio encoder for '${sink.format}' is installed`,
        );
    const sampleFormat = widestSampleFormat(
        sources.map(({ span }) => span.track.info),
        sink,
        warn,
    );
    const config = {
        format: sink.format,
        sampleRate: sound.sampleRate,
        channels: sound.channels,
        estimatedFrames: sound.estimatedFrames,
        bitrateKbps,
        vbr,
        codec: sink.codec,
        sampleFormat,
        codecPreference: settings.codecPreference,
        signal: run.signal,
        onProgress: run.onProgress
            ? (progress: MediaProgress) =>
                  run.onProgress!({
                      ...progress,
                      fraction: Math.max(0, Math.min(1, progress.fraction)),
                  })
            : undefined,
        onWarning: settings.onWarning,
    };
    audio.check(config);
    try {
        await lifetime.waitFor(audio.encode(sound, run.sink, config));
    } finally {
        for (const read of reads) read.close();
    }
}

/** What the steps of writing one container output share. */
interface ContainerWrite {
    readonly environment: TimelineEnvironment;
    readonly job: TimelineJob;
    readonly format: OutputContainerFormat;
    readonly run: TimelineRun;
    readonly lifetime: CodecLifetime;
    /** The output, written through for copied packets that view reused buffers. */
    readonly sink: Sink;
    readonly warn: (code: string, message: string) => void;
}

/** Where the copied clips of a container output land, and the seconds it presents. */
interface CopyLayout {
    readonly copied: CopySelection;
    readonly spans: readonly CopySpan[];
    /**
     * Sound encoded under copied pictures that begins before the first of them (a recording whose
     * picture starts a few frames late) keeps that lead in a container without an edit list: the
     * copied pictures move later by it.
     */
    readonly soundLead: number;
    readonly presentedTotal: number;
}

function copyLayout(
    { job, format, run, sink }: ContainerWrite,
    audioPlan: AudioEncodeLane | undefined,
): CopyLayout {
    const clips = job.clips;
    const first = clips[0]!;
    const videoCopied = job.video?.action === 'copy';
    // A destination that cannot be patched takes MP4 as fragments, which hold no text track here.
    const fragments = MP4_FAMILY.has(format) && containerLayout(format, sink) === 'fragmented';
    const text = fragments ? (job.copies ?? []).filter(track => track.type === 'subtitle') : [];
    if (text.length)
        run.diagnostics.warn({
            code: 'TARGET_TRACKS_DROPPED',
            format,
            message: `Fragmented ${format} leaves out ${text.length} subtitle track(s)`,
        });
    const extras = (job.copies ?? []).filter(track => !text.includes(track));
    const copied: CopySelection = {
        video: videoCopied,
        audio: job.audio?.action === 'copy',
        extras,
    };
    const spans =
        videoCopied || copied.audio || extras.length
            ? copySpans(clips, format, clip => copiedTracks(clip, copied, clip === first))
            : [];
    const soundLead =
        videoCopied &&
        audioPlan &&
        spans.length &&
        !keepsExactTrim(format) &&
        first.picture &&
        first.sound
            ? Math.max(
                  0,
                  spans[0]!.trim.cuts.get(first.picture.description.id)!.time -
                      Math.max(first.start, firstPresented(first.sound)),
              )
            : 0;
    const presentedTotal =
        (spans.length
            ? spans[spans.length - 1]!.presentedEnd - spans[0]!.presentedStart
            : totalOf(clips)) + soundLead;
    return { copied, spans, soundLead, presentedTotal };
}

/**
 * Audio mixed under copied pictures follows them: the source range they present of `clip` and where
 * it lands.
 */
function soundUnderCopies(
    { spans, soundLead }: CopyLayout,
    format: OutputContainerFormat,
    clip: TimelineClip,
): { start: number; end: number; offset: number; length: number } {
    const span = spans.find(entry => entry.clip === clip);
    if (!span || !clip.picture) return clipSpan(clip);
    const cut = span.trim.cuts.get(clip.picture.description.id)!;
    const opening = span === spans[0];
    const base = opening && keepsExactTrim(format) ? clip.start : cut.time;
    const start = base - (opening ? soundLead : 0);
    // The sound of the last clip runs to its own end when it outlasts the pictures.
    const end = Math.max(
        base + (span.presentedEnd - span.presentedStart),
        span === spans.at(-1) ? clip.stop : 0,
    );
    const offset = opening ? 0 : span.presentedStart - spans[0]!.presentedStart + soundLead;
    return { start, end, offset, length: end - start };
}

/** The sound of the timeline mixed and run through the lane's stages; undefined when silent. */
function timelineMix(
    { environment, job, run, format, warn }: ContainerWrite,
    layout: CopyLayout,
    audioPlan: AudioEncodeLane,
    read: SoundRead,
): ReplayablePcmSource | undefined {
    const sources = soundSources(
        job,
        layout.presentedTotal,
        layout.copied.video ? clip => soundUnderCopies(layout, format, clip) : clipSpan,
        pcmSettings(environment, run),
        read,
    );
    if (!sources.length) return undefined;
    const source = sources[0]!.source;
    const channels = sources.length === 1 ? source.channels : Math.min(2, source.channels);
    const soundTotal = Math.max(
        layout.presentedTotal,
        ...sources.map(({ span }) => span.offset + span.length),
    );
    const sound = timelineSound(sources, source.sampleRate, channels, soundTotal);
    return stagedPcmSource(sound, audioPlan.stages, warn);
}

/** The encoder of the video lane behind its stages, and the track it writes. */
async function openTimelineVideo(
    { job, format, run, lifetime, sink, warn }: ContainerWrite,
    videoPlan: VideoEncodeLane,
    presentedTotal: number,
    /** Waits until the interleaver takes another picture. */
    drained: () => Promise<void>,
    deliver: (packet: EncodedPacket) => void,
): Promise<{ tail: VideoStageChain; port: EncoderPort; config: VideoTrackConfig }> {
    const { signal } = run;
    const labels = job.metadata;
    const geometry = job.clips[0]!.geometry!;
    const framerate = videoPlan.fps ?? videoPlan.framerate;
    let port: EncoderPort | undefined;
    const tail = new VideoStageChain(
        [
            ...createStages('video', videoPlan.stages),
            ...(videoPlan.fps ? [frameRateStage(videoPlan.fps, presentedTotal)] : []),
        ],
        { width: geometry.width, height: geometry.height, fps: framerate },
        async picture => {
            try {
                await drained();
                await port!.ready();
                await lifetime.waitFor(drainSink(sink, signal));
            } catch (error) {
                picture.close();
                throw error;
            }
            await port!.write(picture);
        },
        warn,
    );
    const output = tail.output;
    port = await openVideoEncoder(
        {
            ...videoPlan.encoder,
            codec: videoPlan.codec,
            explicit: videoPlan.explicit,
            width: output.width,
            height: output.height,
            framerate: output.fps ?? framerate,
            bitrate: videoPlan.bitrate,
            bitDepth: videoPlan.bitDepth,
            container: format,
            keyframeInterval: videoPlan.keyframeInterval,
            provider: videoPlan.encodeWith,
            strict: run.diagnostics.validation === 'strict',
            signal,
        },
        lifetime,
        deliver,
        warn,
    );
    const config: VideoTrackConfig = {
        ...trackLabels(labels.video, format),
        id: labels.video?.id ?? 1,
        type: 'video',
        codec: port.codec,
        width: output.width,
        height: output.height,
        framerate: output.fps ?? framerate,
        ...(videoPlan.rotation ? { rotation: videoPlan.rotation } : {}),
    };
    return { tail, port, config };
}

/** The tracks a container output declares, copied or encoded, trimmed to the copied range. */
interface ContainerTracks {
    readonly muxerConfig: MuxerConfig;
    readonly audioConfig: AudioTrackConfig | undefined;
    readonly extraVideo: readonly RemuxTrack[];
    readonly extraAudio: readonly RemuxTrack[];
    readonly subtitles: readonly RemuxTrack[];
}

function containerTracks(
    { job, format, run }: ContainerWrite,
    { copied, spans, soundLead, presentedTotal }: CopyLayout,
    mode: MuxerConfig['mode'],
    encodedVideo: VideoTrackConfig | undefined,
    mixed: ReplayablePcmSource | undefined,
    audioTarget: ReturnType<typeof encodedAudioShape> | undefined,
    audioPlan: AudioEncodeLane | undefined,
): ContainerTracks {
    const first = job.clips[0]!;
    const labels = job.metadata;
    let videoConfig = copied.video
        ? {
              ...copiedVideoTrack(first.picture!.info, first.file.format, format),
              id: first.picture!.description.id,
          }
        : encodedVideo;
    let audioConfig: AudioTrackConfig | undefined = copied.audio
        ? {
              ...copiedAudioTrack(first.sound!.info, first.file.format, format),
              id: first.sound!.description.id,
          }
        : mixed && audioTarget
          ? {
                ...trackLabels(labels.audio, format),
                // The encoder that runs declares its delay (a host's AAC may have none) and length.
                ...encodedAudioTrack(audioPlan!.codec, audioTarget.rate, audioTarget.channels),
                id: labels.audio?.id ?? 2,
            }
          : undefined;
    const { extras } = copied;
    const extraVideo = extras.filter(track => track.type === 'video');
    const extraAudio = extras.filter(track => track.type === 'audio');
    const subtitles = extras.filter(track => track.type === 'subtitle');
    let extraVideoConfigs = extraVideo.map(track => ({
        ...copiedVideoTrack(track.info, first.file.format, format),
        id: track.description.id,
    }));
    let extraAudioConfigs = extraAudio.map(track => ({
        ...copiedAudioTrack(track.info, first.file.format, format),
        id: track.description.id,
    }));
    if (spans.length) {
        const span = spans[0]!;
        const last = spans[spans.length - 1]!;
        // The pictures are presented to the last one; copied sound to its own end in the last clip,
        // or that clip's end, as a plain copy presents each track.
        const presented = (track: RemuxTrack): number => {
            if (track.type !== 'audio') return presentedTotal;
            const end = last.trackEnds.get(track === first.sound ? last.clip.sound! : track);
            return end === undefined ? presentedTotal : end - span.presentedStart + soundLead;
        };
        const cut = <T extends VideoTrackConfig | AudioTrackConfig>(
            config: T,
            track: RemuxTrack,
        ): T => trimmedTrack(config, track, span.trim, format, presented(track));
        if (copied.video && videoConfig) videoConfig = cut(videoConfig, first.picture!);
        if (copied.audio && audioConfig) audioConfig = cut(audioConfig, first.sound!);
        extraVideoConfigs = extraVideoConfigs.map((config, index) =>
            cut(config, extraVideo[index]!),
        );
        extraAudioConfigs = extraAudioConfigs.map((config, index) =>
            cut(config, extraAudio[index]!),
        );
        reportTrimCuts(
            span.trim,
            copiedTracks(first, copied, true),
            format,
            run.diagnostics,
            first.file.timelineStart,
        );
    }
    if (!videoConfig && !audioConfig)
        throw new MediaForgeError('The project produces neither video nor audio', 'FORMAT');

    // Tracks of different inputs may share an ID; the output numbers the sound after the picture
    // then.
    if (videoConfig && audioConfig && audioConfig.id === videoConfig.id)
        audioConfig = { ...audioConfig, id: videoConfig.id + 1 };
    const muxerConfig: MuxerConfig = {
        title: labels.title,
        tags: labels.tags,
        format,
        mode,
        maxFragmentDuration: 2,
        autoSync: true,
        videoColour: copied.video ? first.picture!.info.colour : undefined,
        videoLanguage: videoConfig?.language,
        audioLanguage: audioConfig?.language,
        video: videoConfig,
        audio: audioConfig,
        ...(extraVideoConfigs.length ? { extraVideoTracks: extraVideoConfigs } : {}),
        ...(extraAudioConfigs.length ? { extraAudioTracks: extraAudioConfigs } : {}),
        ...(subtitles.length
            ? {
                  subtitleTracks: subtitles.map(track =>
                      copiedSubtitleTrack(track.info, track.description.id, format),
                  ),
              }
            : {}),
    };
    return { muxerConfig, audioConfig, extraVideo, extraAudio, subtitles };
}

/** The muxer of a container output, and where a copied packet of each track goes in it. */
function openMuxer(
    { job, format, run, sink }: ContainerWrite,
    create: NonNullable<ReturnType<FormatWriters['container']['get']>>,
    { muxerConfig, audioConfig, extraVideo, extraAudio, subtitles }: ContainerTracks,
    { copied, spans }: CopyLayout,
): { muxer: OutputMuxer; copyRoutes: Map<number, (packet: FilePacket) => void> } {
    const muxer: OutputMuxer = create(muxerConfig, sink, { deferCodecConfig: true });
    if (
        (extraVideo.length && !muxer.addExtraVideoChunk) ||
        (extraAudio.length && !muxer.addExtraAudioChunk)
    )
        throw new MediaForgeError(
            `The ${format} writer cannot hold more than one track of a kind`,
            'FORMAT',
        );
    if (subtitles.length && !muxer.addSubtitleChunk)
        throw new MediaForgeError(`The ${format} writer cannot hold subtitle tracks`, 'FORMAT');
    const copyRoutes = new Map<number, (packet: FilePacket) => void>();
    const add = (track: RemuxTrack, write: (packet: FilePacket) => void): void => {
        copyRoutes.set(
            track.description.id,
            copyRoute(track, format, write, false, spans[0]?.trim),
        );
    };
    for (const clip of job.clips) {
        const loss = copied.video && clip.picture && splicedCopyLoss(clip.picture.info, format);
        if (loss) run.diagnostics.warn(loss);
        if (copied.video && clip.picture)
            add(clip.picture, packet => muxer.addVideoChunk(packet, packet.codecConfig));
        if (copied.audio && clip.sound)
            add(clip.sound, packet => muxer.addAudioChunk(packet, packet.codecConfig));
    }
    extraVideo.forEach((track, index) =>
        add(track, packet => muxer.addExtraVideoChunk!(index, packet, packet.codecConfig)),
    );
    extraAudio.forEach((track, index) =>
        add(track, packet => muxer.addExtraAudioChunk!(index, packet, packet.codecConfig)),
    );
    subtitles.forEach((track, index) =>
        add(track, packet => muxer.addSubtitleChunk!(packet, index)),
    );
    const labels = job.metadata;
    if ((format === 'mkv' || format === 'webm') && labels.matroskaPassThrough)
        muxer.setMatroskaPassThrough?.(labels.matroskaPassThrough);
    if (audioConfig?.validSamples !== undefined)
        muxer.setAudioPriming?.(
            audioConfig.primingSamples ?? 0,
            audioConfig.validSamples,
            audioConfig.presentationTimestamps,
            audioConfig.discardLeadingSamples,
            audioConfig.codecDelaySamples,
        );
    return { muxer, copyRoutes };
}

/** Decodes, draws and encodes the pictures of the clips through the video lane's stages. */
async function renderTimelineVideo(
    { environment, job, format, run, lifetime, warn }: ContainerWrite,
    videoPlan: VideoEncodeLane,
    { tail, port }: { tail: VideoStageChain; port: EncoderPort },
    spans: readonly CopySpan[],
    readOf: (clip: TimelineClip) => ClipRead,
    overlays: Awaited<ReturnType<typeof loadOverlays>>,
    onFrame: () => void,
): Promise<void> {
    const { clips } = job;
    const first = clips[0]!;
    const geometry = first.geometry!;
    const painter =
        overlays.length || clips.some(clip => clip.video.fade.in > 0 || clip.video.fade.out > 0)
            ? overlayPainter(overlays, job.background, geometry.width, geometry.height)
            : undefined;

    // Copied sound starts at its packet at or before the first clip's start, which a container
    // without an edit list presents at zero: the pictures follow it there.
    const copiedLead =
        spans.length && !isIsoOutput(format)
            ? Math.max(0, first.start - spans[0]!.trim.origin + spans[0]!.offset)
            : 0;
    const videoClips: VideoClip[] = clips.map((clip, index) => {
        if (!clip.picture || !clip.geometry)
            throw new MediaForgeError(`clips[${index}] has no video track to draw`, 'FORMAT');
        return {
            file: clip.file,
            track: clip.picture,
            geometry: clip.geometry,
            start: clip.start,
            end: clip.stop,
            speed: clip.speed,
            offset: clip.offset + copiedLead,
            duration: clip.duration,
            fade: clip.video.fade,
            read: readOf(clip),
        };
    });

    const { diagnostics, signal } = run;
    await renderVideoClips(videoClips, tail, {
        decoders: environment.videoDecoders,
        preference: run.codecPreference ?? environment.codecPreference,
        missing: environment.writers.missing,
        providers: environment.providers,
        allowPrecisionLoss: videoPlan.allowPrecisionLoss,
        signal,
        prepare: videoPlan.encodeWith
            ? signalPictures(lifetime, warn, videoPlan.allowPrecisionLoss)
            : undefined,
        recovery: {
            strict: diagnostics.validation === 'strict',
            warn: (code, message) =>
                diagnostics.warn({
                    code,
                    message,
                    format,
                    trackId: first.picture?.description.id,
                }),
        },
        lifetime,
        background: job.background,
        paint: painter,
        onFrame,
    });

    await port.flush();
    lifetime.check();
}

/** Encodes the mixed sound into the muxer's audio track through the interleaver's lane 1. */
async function encodeTimelineAudio(
    audioPipeline: AudioTrackEncoder,
    mixed: ReplayablePcmSource,
    audioTarget: NonNullable<ReturnType<typeof encodedAudioShape>>,
    codec: string,
    muxer: OutputMuxer,
    interleaver: Interleaver,
    declaredAudio: Uint8Array | undefined,
    lifetime: CodecLifetime,
    counts: { audioFrames: number },
): Promise<void> {
    const counted: ReplayablePcmSource = {
        ...mixed,
        async *chunks(replaySignal) {
            counts.audioFrames = 0;
            for await (const planes of mixed.chunks(replaySignal)) {
                counts.audioFrames += planes[0]!.length;
                yield planes;
            }
        },
    };

    let described = false;
    const verify = (config: Uint8Array): void => {
        if (declaredAudio && mp4aAudioObjectType(codec) === 2 && !sameBytes(config, declaredAudio))
            throw new MediaForgeError(
                'Audio encoder configuration differs from the declared AAC-LC output',
                'ENCODE',
            );
    };

    const pcm = isPcmOutputMuxer(muxer)
        ? {
              addPcmBuffer: muxer.addPcmBuffer.bind(muxer),
              addPcmPlanarChunk: muxer.addPcmPlanarChunk.bind(muxer),
          }
        : {};

    await audioPipeline.encodePcm(
        counted,
        audioTarget,
        0,
        Math.max(1, Math.round((mixed.estimatedFrames * audioTarget.rate) / mixed.sampleRate)),
        codec,
        {
            ...pcm,
            addVideoChunk: (chunk, config) => muxer.addVideoChunk(chunk, config),
            finalize: () => muxer.finalize(),
            setAudioPriming: muxer.setAudioPriming?.bind(muxer),
            setValidSamples: muxer.setValidSamples?.bind(muxer),
            setAudioCodecConfig: config => {
                verify(config);
                muxer.setAudioCodecConfig?.(config);
            },
            addAudioChunk: (chunk, config) => {
                // Matroska writes its header with the first chunk of any track, so the
                // configuration reaches the muxer before the queued chunks do.
                if (config && !described) {
                    described = true;
                    verify(config);
                    muxer.setAudioCodecConfig?.(config);
                }
                interleaver.push(
                    1,
                    config ? ({ ...chunk, codecConfig: config } as EncodedPacket) : chunk,
                );
            },
        },
        lifetime,
    );
}

async function writeContainer(
    environment: TimelineEnvironment,
    job: TimelineJob,
    format: OutputContainerFormat,
    run: TimelineRun,
    lifetime: CodecLifetime,
): Promise<void> {
    const { diagnostics, signal } = run;
    const warn = (code: string, message: string): void =>
        diagnostics.warn({ code, message, format });

    // Copied packets may view reused buffers; the muxer writes them through.
    const sink = copySink(run.sink);
    const create = environment.writers.container.get(format);
    if (!create)
        throw environment.writers.missing.format(format, `No writer for '${format}'`, true);
    const clips = job.clips;
    const first = clips[0]!;
    const videoPlan = job.video?.action === 'encode' ? job.video : undefined;
    const audioPlan = job.audio?.action === 'encode' ? job.audio : undefined;
    if (format === 'avi' && !sink.patchAt)
        throw new MediaForgeError('AVI output needs a sink with patchAt()', 'FORMAT', {
            hint: 'Write AVI to a FileSink or a Blob, or choose MP4 or MKV.',
        });
    const w: ContainerWrite = { environment, job, format, run, lifetime, sink, warn };
    const layout = copyLayout(w, audioPlan);
    const { copied, spans, soundLead, presentedTotal } = layout;
    // Lanes: 0 the picture, 1 the sound, 2 the other copied tracks. Encoded chunks go to the
    // muxer's main tracks; copied packets go where their track's route sends them.
    const interleaver = new Interleaver(
        3,
        (lane, chunk) => {
            const packet = chunk as FilePacket;
            const route =
                lane === 2 || (lane === 0 ? copied.video : copied.audio)
                    ? copyRoutes.get(packet.trackId)
                    : undefined;
            if (route) route(packet);
            else if (lane === 0) muxer.addVideoChunk(chunk, packet.codecConfig);
            else muxer.addAudioChunk(chunk, packet.codecConfig);
        },
        lifetime,
    );
    // Every lane that reads a clip, or a mixed-in track, takes its packets from one read of it;
    // the tracks the lanes decode are declared before any lane starts (ClipRead.expect()).
    const reads = new Map<object, ClipRead>();
    const readOf = (owner: object, file: MediaFile): ClipRead => {
        let read = reads.get(owner);
        if (!read) reads.set(owner, (read = new ClipRead(file, sink, interleaver)));
        return read;
    };
    if (videoPlan)
        for (const clip of clips)
            if (clip.picture) readOf(clip, clip.file).expect(clip.picture, true);
    const mixed = audioPlan
        ? timelineMix(w, layout, audioPlan, (owner, file, track) =>
              readOf(owner, file).reader(track),
          )
        : undefined;
    const audioPipeline = new AudioTrackEncoder({
        signal,
        codecPreference: run.codecPreference ?? environment.codecPreference,
        bitrate: audioPlan?.bitrate ?? DEFAULT_AUDIO_BITRATE,
        ...(audioPlan?.sampleFormat ? { sampleFormat: audioPlan.sampleFormat } : {}),
        container: environment.containerAudio,
        report: () => report('Encoding audio'),
        yield: async () => {
            await interleaver.drain(1);
            await lifetime.waitFor(drainSink(sink, signal));
            await yieldEventLoop();
        },
        warn,
    });
    const audioTarget =
        mixed && audioPlan
            ? encodedAudioShape(mixed.sampleRate, mixed.channels, audioPlan.codec, audioPlan)
            : undefined;
    if (audioTarget?.downmixed)
        diagnostics.warn({
            code: 'AUDIO_DOWNMIXED',
            format,
            message:
                `${audioPlan!.codec} output folds ${mixed!.channels} channels down to ` +
                `${audioTarget.channels}`,
        });

    // Standard MP4 writes its index after the media, which a forward-only sink cannot patch:
    // fragments then.
    const mode = containerLayout(format, sink, copied.extras.length > 0);
    if (MP4_FAMILY.has(format) && mode === 'fragmented')
        diagnostics.warn({
            code: 'MP4_FRAGMENTED',
            format,
            message: `${format} is written fragmented: the destination cannot be patched`,
        });
    /**
     * Takes the encoded video once the muxer exists; packets only come after the pictures start.
     */
    let deliverVideo: (packet: EncodedPacket) => void = () => {
        throw new MediaForgeError('Video was encoded before the output was ready', 'ENCODE');
    };
    const encodedVideo = videoPlan
        ? await openTimelineVideo(
              w,
              videoPlan,
              presentedTotal,
              () => interleaver.drain(0),
              packet => deliverVideo(packet),
          )
        : undefined;
    const tracks = containerTracks(
        w,
        layout,
        mode,
        encodedVideo?.config,
        mixed,
        audioTarget,
        audioPlan,
    );
    const { muxer, copyRoutes } = openMuxer(w, create, tracks, layout);
    const declaredAudio = copied.audio ? undefined : tracks.audioConfig?.codecConfig;

    const expectedFrames = Math.max(
        1,
        Math.round((tracks.muxerConfig.video?.framerate || 30) * presentedTotal),
    );
    let frames = 0;
    const counts = { audioFrames: 0 };
    const report = (message: string): void => {
        if (!run.onProgress) return;
        const video = !videoPlan ? 1 : Math.min(1, frames / expectedFrames);
        const audio = mixed ? Math.min(1, counts.audioFrames / mixed.estimatedFrames) : 1;
        const fraction = !videoPlan ? audio : !mixed ? video : 0.7 * video + 0.3 * audio;
        run.onProgress({ fraction: Math.max(0, Math.min(1, fraction)), message });
    };
    /**
     * Routes the copied packets of `selection` in decode order: straight into the muxer when
     * nothing is encoded, otherwise into `lane` of the interleaver.
     */
    const copyLane = async (selection: CopySelection, lane?: number): Promise<void> => {
        for (const span of spans) {
            const tracks = copiedTracks(span.clip, selection, span.clip === first);
            if (!tracks.length) continue;
            await lifetime.waitFor(
                readOf(span.clip, span.clip.file).route(
                    {
                        trackIds: tracks.map(track => track.description.id),
                        trim: span.trim,
                        offset: span.offset + soundLead,
                        route:
                            lane === undefined
                                ? packet => copyRoutes.get(packet.trackId)!(packet)
                                : packet => interleaver.push(lane, packet),
                    },
                    lane,
                ),
            );
            if (lane !== undefined) await interleaver.drain(lane);
            lifetime.check();
        }
    };
    const none: CopySelection = { video: false, audio: false, extras: [] };
    const overlays = videoPlan ? await loadOverlays(job.overlays, lifetime) : [];
    try {
        lifetime.check();
        if (!videoPlan && !mixed) await copyLane(copied);
        else {
            const extrasTask = async (): Promise<void> => {
                try {
                    await copyLane({ ...none, extras: copied.extras }, 2);
                } finally {
                    interleaver.end(2);
                }
            };
            const videoTask = async (): Promise<void> => {
                try {
                    if (copied.video) await copyLane({ ...none, video: true }, 0);
                    else if (videoPlan && encodedVideo) {
                        let described = false;
                        let codecConfig: Uint8Array | undefined;
                        deliverVideo = packet => {
                            if (!described) {
                                described = true;
                                if (packet.colour) muxer.setVideoColour?.(packet.colour);
                            }
                            codecConfig = packet.codecConfig ?? codecConfig;
                            interleaver.push(0, codecConfig ? { ...packet, codecConfig } : packet);
                        };
                        await renderTimelineVideo(
                            w,
                            videoPlan,
                            encodedVideo,
                            spans,
                            clip => readOf(clip, clip.file),
                            overlays,
                            () => {
                                frames++;
                                if ((frames & 15) === 0) report('Encoding video');
                            },
                        );
                        if (encodedVideo.port.encoded === 0 && frames > 0)
                            throw new MediaForgeError(
                                'The video encoder produced no output',
                                'ENCODE',
                            );
                    }
                } finally {
                    interleaver.end(0);
                }
            };
            const audioTask = async (): Promise<void> => {
                try {
                    if (copied.audio) return await copyLane({ ...none, audio: true }, 1);
                    if (!mixed || !audioTarget || !audioPlan) return;
                    await encodeTimelineAudio(
                        audioPipeline,
                        mixed,
                        audioTarget,
                        audioPlan.codec,
                        muxer,
                        interleaver,
                        declaredAudio,
                        lifetime,
                        counts,
                    );
                } finally {
                    interleaver.end(1);
                    for (const clip of clips) if (clip.sound) reads.get(clip)?.done(clip.sound);
                }
            };
            await Promise.all([videoTask(), audioTask(), extrasTask()]);
        }
        lifetime.check();
        report('Finalizing output');
        await lifetime.waitFor(muxer.finalize());
        run.onProgress?.({ fraction: 1, message: 'Done' });
    } finally {
        for (const read of reads.values()) read.close();
        await encodedVideo?.port.close();
        encodedVideo?.tail.close();
        releaseOverlays(overlays);
    }
}
