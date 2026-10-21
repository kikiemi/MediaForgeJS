import {
    assertMuxCodec,
    canFragmentCodec,
    canMuxCodec,
    containerLayout,
    isIsoOutput,
    MP4_FAMILY,
    TX3G_SOURCE_CODECS,
} from '../../formats/shared/capabilities';
import {
    codecFamily,
    isPcmCodec,
    isProResCodec,
    isHevcCodec,
} from '../../core/model/codec-strings';
import { vpcCFor } from '../../core/codec-config/video/vp9-config';
import type { FormatWriters } from '../plugins/missing-parts';
import type { Sink } from '../../core/model/types';
import type { ContainerFormat, MatroskaPassThrough, MediaTags } from '../../core/model/media';
import type { MuxerConfig, AudioTrackConfig, VideoTrackConfig } from '../../core/contracts/writer';
import type { TrackInfo } from '../../core/model/track';
import type { FilePacket, RemuxOptions, TrimPlan, RemuxTrack } from '../media-types';
import type { SegmentOptions } from '../packet-types';
import type { DiagnosticContext, MediaDiagnostic } from '../../core/errors/diagnostics';
import { MediaForgeError } from '../../core/errors/errors';
import {
    alphaLoss,
    containerTagLoss,
    pcmLayoutLoss,
    stereoViewLoss,
    trackDispositionLoss,
    videoDescriptionLoss,
    matroskaMetadataLoss,
    matroskaOutputMetadata,
} from './track-metadata';
import {
    copiedAudioTrack,
    copiedSubtitleTrack,
    copiedVideoTrack,
    encodedAudioSampleCount,
    keptForced,
    matroskaAudioWindowFitsFinalPacket,
    splicedCopyLoss,
    splicedMediaTimes,
} from './copied-track';
import { sampleCount, sampleAt } from '../../core/model/sample-index';
import { cmafTrackConfig } from './cmaf-timing';
import type { CmafTrack } from '../../formats/mp4/write/cmaf-boxes';
import { mp4KeepsLanguage } from '../../formats/mp4/tags';
import { carriedAudioShape } from '../../formats/mp4/carried-audio';
import { tx3gSample, tx3gSampleEntryBody } from '../../formats/text/timed-text';
import { isProResRawCodec } from '../../core/codec-config/video/prores-raw';
import { keepsExactTrim, presentationEnd } from './trim-plan';
import { presentedStart } from './copy-timeline';
import { leadingTime } from '../read/track-start';
import { annexBToAvcc, avcConfigToSamplePrefix } from '../../core/codec-config/video/annexb';
import { hevcConfigToAnnexB, hevcLengthSize } from '../../core/codec-config/video/hevc-codec';
import { decodeTime } from '../../core/model/media-time';

/**
 * Length-prefixed parameter sets of each decoder configuration of an H.264 or HEVC track that
 * switches configurations, for outputs that keep one configuration per track: a switch re-sends the
 * new parameter sets in band. Null when a configuration cannot be carried in band with the track's
 * NAL length size.
 */
function inBandParameterSets(info: TrackInfo): Uint8Array[] | null {
    const configurations = info.codecConfigurations;
    const hevc = isHevcCodec(info.codec);
    if (!configurations || configurations.length < 2 || (!info.codec.startsWith('avc') && !hevc))
        return null;
    const lengthSize = (config: Uint8Array | undefined): number =>
        hevc ? hevcLengthSize(config) : ((config?.[4] ?? 3) & 3) + 1;
    const size = lengthSize(info.codecConfig);
    const sets: Uint8Array[] = [];
    for (const { codecConfig } of configurations) {
        if (lengthSize(codecConfig) !== size) return null;
        const annexB = hevc ? hevcConfigToAnnexB(codecConfig)?.paramSets : undefined;
        const prefix = hevc
            ? annexB?.length
                ? annexBToAvcc(annexB, size as 1 | 2 | 3 | 4)
                : null
            : avcConfigToSamplePrefix(codecConfig);
        if (!prefix) return null;
        sets.push(prefix);
    }
    return sets;
}

/**
 * Routes the packets of a track that switches H.264/HEVC configurations to an output with one
 * configuration: every switch, and every later keyframe, carries its configuration's parameter sets
 * in front of its NAL units.
 */
function inBandRoute(
    track: RemuxTrack,
    sets: readonly Uint8Array[],
    route: (packet: FilePacket) => void,
): (packet: FilePacket) => void {
    let previous = 0;
    let switched = false;
    return packet => {
        const index = sampleAt(track.info, packet.sampleIndex)?.codecConfigIndex ?? 0;
        switched ||= index !== 0;
        let data = packet.data;
        if (index !== previous || (switched && packet.isKeyframe)) {
            const prefix = sets[index]!;
            data = new Uint8Array(prefix.length + packet.data.length);
            data.set(prefix);
            data.set(packet.data, prefix.length);
        }
        previous = index;
        route({ ...packet, data, codecConfig: track.info.codecConfig });
    };
}

/**
 * The route of a copied track's packets into `format`: a track that switches H.264/HEVC
 * configurations re-sends its parameter sets in band where the output keeps one configuration per
 * track, and an MP4 copy that keeps a spliced edit list (`keepsEdit`, an untrimmed copy) writes the
 * packets on the media timeline of the edits. Text goes into MP4 as 3GPP timed text at the times it
 * is presented: a copy cut by `trim` writes the other tracks from its first decode time and
 * presents them from the in-point through edit lists.
 */
export function copyRoute(
    track: RemuxTrack,
    format: string,
    route: (packet: FilePacket) => void,
    keepsEdit: boolean,
    trim?: TrimPlan,
): (packet: FilePacket) => void {
    if (MP4_FAMILY.has(format)) {
        if (track.type === 'subtitle') {
            const text = timedTextConverter(track.info.codec, 'tx3g');
            const shift = trim ? trim.start - trim.origin : 0;
            const end = presentedTextEnd(track) - (trim?.origin ?? 0);
            return packet => {
                if (packet.timestamp >= end) return;
                route({
                    ...packet,
                    timestamp: packet.timestamp - shift,
                    duration: Math.min(packet.duration, end - packet.timestamp),
                    decodeTimestamp: undefined,
                    data: text ? text(packet.data) : packet.data,
                });
            };
        }
        const media = keepsEdit ? splicedMediaTimes(track.info) : undefined;
        return media ? packet => route(media(packet)) : route;
    }
    const sets = track.type === 'video' ? inBandParameterSets(track.info) : null;
    return sets ? inBandRoute(track, sets, route) : route;
}

/**
 * Where an MP4 edit from a text track's first sample ends its presentation before its media ends (a
 * last cue cut short), in seconds; otherwise no end.
 */
function presentedTextEnd(track: RemuxTrack): number {
    const presented = track.info.editPresentationDurationSeconds;
    if (presented === undefined || (track.info.editMediaTimeSeconds ?? 0) > 0) return Infinity;
    const last = sampleAt(track.info, sampleCount(track.info) - 1);
    return last && presented > 0 && presented < last.timestamp + last.duration - 0.001
        ? presented
        : Infinity;
}

/**
 * Whether MP4 copies a track without a decoder configuration from the input: ProRes, G.711, MPEG
 * audio, Motion JPEG and PCM, whose frames or sample entries say all a decoder needs, the speech
 * codecs whose shape their object type fixes (carriedAudioShape(): EVRC, QCELP), which have no
 * decoder configuration, and VP9 whose codec string states the profile, level and bit depth of the
 * vpcC record the writer builds.
 */
function describesItself(info: TrackInfo): boolean {
    const { codec } = info;
    return (
        isProResCodec(codec) ||
        isProResRawCodec(codec) ||
        ['ulaw', 'alaw', 'mp1', 'mp2', 'mp3', 'mjpeg'].includes(codec) ||
        isPcmCodec(codec) ||
        carriedAudioShape(codec) !== undefined ||
        (codecFamily(codec) === 'vp09' && vpcCFor(codec, info.codecConfig) !== undefined)
    );
}

/**
 * Whether `format`, of the MP4 family, cannot copy `info` for want of a decoder configuration: a
 * track that does not describe itself needs the input's, except AC-3 where `ac3FromFrame` lets the
 * writer describe it from its first syncframe (the first audio track). The one rule of a copy, the
 * tracks a conversion copies and an edit's copied lanes.
 */
export function lacksMp4Configuration(
    info: TrackInfo,
    type: RemuxTrack['type'],
    format: string,
    ac3FromFrame: boolean,
): boolean {
    return (
        MP4_FAMILY.has(format) &&
        type !== 'subtitle' &&
        !describesItself(info) &&
        !(info.codec === 'ac-3' && ac3FromFrame) &&
        !info.codecConfig?.length
    );
}

/**
 * Whether `format` holds several tracks of `type` (subtitles: any): MP4 and Matroska hold several
 * of each kind, MPEG-TS several audio tracks, the other containers one video and one audio track
 * and no subtitles. The one rule of a copy's tracks and of those a conversion copies beside the
 * tracks it encodes.
 */
function holdsSeveral(format: string, type: RemuxTrack['type']): boolean {
    if (MP4_FAMILY.has(format) || format === 'mkv' || format === 'webm') return true;
    return type === 'audio' && format === 'ts';
}

/**
 * Why a track cannot be copied into `format` next to the tracks a conversion re-encodes, or
 * undefined when it can: the container must carry its codec and hold another track of its kind, and
 * the packets must be copyable as they are.
 */
export function extraTrackBlocker(track: RemuxTrack, format: string): string | undefined {
    const { info, type } = track;
    if (!sampleCount(info)) return 'it has no packets';
    if (!canMuxCodec(format, type, info.codec)) return `${format} cannot carry ${info.codec}`;

    const mp4 = MP4_FAMILY.has(format);
    const matroska = format === 'mkv' || format === 'webm';
    if (!holdsSeveral(format, type)) return `${format} holds one ${type} track`;
    if (format === 'm4a' && type === 'video') return 'm4a holds audio only';
    if (lacksMp4Configuration(info, type, format, false))
        return `the input lacks the decoder configuration ${format} needs`;
    if ((info.codecConfigurations?.length ?? 0) > 1 && !mp4 && !inBandParameterSets(info))
        return 'it changes decoder configuration, which only MP4 output can follow';
    if (type === 'audio' && matroska && !matroskaAudioWindowFitsFinalPacket(info))
        return `its trailing edit crosses its final packet, which ${format} cannot keep`;
    return undefined;
}

/**
 * Seconds removed from every timestamp written to fragmented MP4: a positive start, as MPEG-TS and
 * program streams carry, so it counts from the first decode time.
 */
function rebasedStart(format: string, tracks: readonly RemuxTrack[], fragmented = false): number {
    if (!fragmented || !MP4_FAMILY.has(format)) return 0;
    // Subtitle cues keep their times: a file of subtitles alone starts at zero with its first cue
    // where it was.
    return Math.max(
        0,
        leadingTime(
            tracks.filter(track => track.type !== 'subtitle'),
            true,
        ),
    );
}

/**
 * Seconds removed from every timestamp of a whole copy: `presentedStart`, except standard MP4,
 * which keeps the input's times and presents them from zero through edit lists, and fragmented MP4
 * (`rebasedStart`).
 */
export function copyStart(
    format: string,
    tracks: readonly RemuxTrack[],
    fragmented = false,
): number {
    return MP4_FAMILY.has(format)
        ? rebasedStart(format, tracks, fragmented)
        : presentedStart(format, tracks);
}

/** The TIMESTAMPS_REALIGNED warning of a copy whose every timestamp moves by `-start` seconds. */
function timelineShift(format: string, start: number): Omit<MediaDiagnostic, 'severity'> {
    const moved =
        `${(Math.abs(start) * 1000).toFixed(3).replace(/\.?0+$/, '')} ms ` +
        `${start > 0 ? 'earlier' : 'later'}`;
    return {
        code: 'TIMESTAMPS_REALIGNED',
        message:
            start > 0
                ? `${format} output starts at zero: every timestamp moves ${moved}`
                : `${format} output cannot start before zero: every timestamp moves ${moved}`,
        format,
    };
}

/**
 * Matroska trims a tail only inside the final block. A longer trailing trim would need re-encoding,
 * so the tail is kept and reported as metadata loss instead of failing the copy.
 */
function representableMatroskaWindow(
    track: AudioTrackConfig,
    info: TrackInfo,
    format: string,
    diagnostics: DiagnosticContext,
): AudioTrackConfig {
    if (track.validSamples === undefined || matroskaAudioWindowFitsFinalPacket(info)) return track;
    const rate = track.codec.startsWith('opus') ? 48000 : Math.max(1, track.sampleRate || 48000);
    const priming = track.primingSamples ?? 0;
    const encoded = encodedAudioSampleCount(info, rate);
    const kept = encoded - priming;
    if (kept < 1) return track;
    diagnostics.metadata({
        code: 'MATROSKA_TAIL_TRIM_LOSS',
        message:
            `${format} keeps ${kept - track.validSamples} trailing audio samples it cannot ` +
            `trim`,
        trackId: track.id,
        format,
    });
    return { ...track, validSamples: kept };
}

/**
 * The track declaration of a trimmed copy presenting `duration` seconds. MP4-family output gets an
 * edit list that starts the presentation at the requested time inside the first written packet;
 * other containers drop the audio window that the whole track described, keeping the leading
 * discard only when the copy starts at the first packet.
 */
export function trimmedTrack<T extends VideoTrackConfig | AudioTrackConfig>(
    config: T,
    track: RemuxTrack,
    trim: TrimPlan,
    format: string,
    duration: number,
): T {
    const cut = trim.cuts.get(track.description.id)!;
    const audio = config.type === 'audio' ? (config as AudioTrackConfig) : undefined;
    const rate = audio?.codec.startsWith('opus') ? 48000 : (audio?.sampleRate ?? 1);
    const firstPacket = sampleAt(track.info, track.order?.[0] ?? 0)!;
    const atFirstPacket = Math.abs(cut.time - firstPacket.timestamp) < 1e-9;
    if (!keepsExactTrim(format)) {
        if (!audio) return config;
        return {
            ...config,
            validSamples: undefined,
            ...(atFirstPacket
                ? {}
                : {
                      primingSamples: undefined,
                      discardLeadingSamples: undefined,
                      presentationTimestamps: undefined,
                  }),
        };
    }

    // Packet timestamps of a source without presentation edits run ahead of its movie by the
    // discarded priming.
    const priming = audio && audio.presentationEdit === undefined ? (audio.primingSamples ?? 0) : 0;
    const shown = audio?.presentationTimestamps
        ? priming
        : Math.min(priming, Math.max(0, -firstPacket.timestamp) * rate);
    const mediaTime = trim.start - cut.decodeStart + (priming - shown) / rate;

    // A track whose first packet comes after the start (audio that begins after the picture) is
    // presented from there.
    const lead = Math.max(0, -mediaTime);
    return {
        ...config,
        presentationStartSeconds: lead,
        presentationDurationSeconds: Math.max(1e-6, duration - lead),
        presentationMediaTimeSeconds: Math.max(0, mediaTime),
        presentationEdit: undefined,
        ...(audio ? { primingSamples: undefined, validSamples: undefined } : {}),
    };
}

/**
 * The edit list that keeps a copied non-Opus track's MP4 presentation window in fragmented output:
 * its start in the track timescale and, when it ends before the media on a whole millisecond, its
 * presented duration in movie ticks (1/1000 s). Opus starts at the pre-skip of its configuration
 * (opusWindow). A copied `range` ends where it does: the input's edit gives only its start.
 */
function presentationEdit(
    track: RemuxTrack,
    config: CmafTrack,
    range: boolean,
): { readonly mediaTime: number; readonly duration?: number } | undefined {
    const start = track.info.editMediaTimeSeconds ?? 0;
    if (!(start > 0) && !track.info.editList) return leadingEdit(track, config);
    if (config.codec === 'opus' || config.codec === 'Opus') return undefined;
    if (range && !(start > 0)) return undefined;

    // An edit from the first sample that ends the presentation before the media ends (a last
    // subtitle cue cut short) keeps that end.
    if (!(start > 0)) {
        const presented = track.info.editPresentationDurationSeconds;
        const last = sampleAt(track.info, sampleCount(track.info) - 1);
        const media = last ? last.timestamp + last.duration : undefined;
        const milliseconds = presented === undefined ? undefined : Math.round(presented * 1000);
        return milliseconds !== undefined &&
            milliseconds > 0 &&
            media !== undefined &&
            presented! < media - 0.001
            ? { mediaTime: 0, duration: milliseconds }
            : undefined;
    }
    const mediaTime = Math.round(start * config.timescale);
    if (
        Math.abs(mediaTime - start * config.timescale) > 1e-6 * config.timescale ||
        mediaTime > 0xffffffff
    )
        return undefined;
    const duration = range ? undefined : presentedMilliseconds(track);
    return duration === undefined ? { mediaTime } : { mediaTime, duration };
}

/**
 * The presented duration of `track`'s MP4 edit in movie ticks (1/1000 s), when it is a whole
 * number of them.
 */
function presentedMilliseconds(track: RemuxTrack): number | undefined {
    const presented = track.info.editPresentationDurationSeconds;
    if (presented === undefined) return undefined;
    const milliseconds = Math.round(presented * 1000);
    return Math.abs(presented * 1000 - milliseconds) < 1e-6 && milliseconds <= 0xffffffff
        ? milliseconds
        : undefined;
}

/**
 * The edit that presents a track without an MP4 edit list from its first presented sample: the
 * decode times of a reordered video track start before its presentation by the reorder delay, and
 * audio presented before zero (AAC priming read from Matroska) starts the presentation later,
 * neither of which a fragment can store as a negative decode time. Opus states its pre-skip in its
 * configuration instead.
 */
function leadingEdit(
    track: RemuxTrack,
    config: CmafTrack,
): { readonly mediaTime: number } | undefined {
    if (track.type === 'subtitle' || config.codec === 'opus' || config.codec === 'Opus')
        return undefined;
    const first = sampleAt(track.info, track.order?.[0] ?? 0);
    if (!first) return undefined;
    let presented = Infinity;
    for (
        let position = 0, count = Math.min(sampleCount(track.info), 64);
        position < count;
        position++
    )
        presented = Math.min(
            presented,
            sampleAt(track.info, track.order?.[position] ?? position)?.timestamp ?? Infinity,
        );
    const lead = track.type === 'video' ? presented - decodeTime(first) : -presented;
    const mediaTime = Math.round(lead * config.timescale);
    return mediaTime > 0 && mediaTime <= 0xffffffff ? { mediaTime } : undefined;
}

/**
 * The configuration and edit list of an Opus track copied from MP4 into fragmented output,
 * which players start at the pre-skip of its dOps configuration: the pre-skip moves to where the
 * input's edit starts when that is later (in 48 kHz samples), so what the edit hid stays hidden,
 * and the edit list keeps that start and the edit's presented duration. Undefined when the
 * pre-skip cannot state the start: an edit that starts before it, or past what its 16 bits hold.
 */
function opusWindow(
    track: RemuxTrack,
    config: CmafTrack,
): (CmafTrack & { readonly edit: NonNullable<CmafTrack['edit']> }) | undefined {
    const dops = config.codecConfig;
    const edit = track.info.editMediaTimeSeconds;
    if ((config.codec !== 'opus' && config.codec !== 'Opus') || !dops || edit === undefined)
        return undefined;
    const start = Math.round(edit * 48000);
    if (dops.length < 11 || start < dops[2]! * 256 + dops[3]! || start > 0xffff) return undefined;
    const codecConfig = dops.slice();
    codecConfig[2] = start >> 8;
    codecConfig[3] = start & 255;
    const mediaTime = Math.round((start * config.timescale) / 48000);
    const duration = presentedMilliseconds(track);
    return {
        ...config,
        codecConfig,
        edit: duration === undefined ? { mediaTime } : { mediaTime, duration },
    };
}

/**
 * The payload rewrite of a text subtitle track written as 3GPP timed text, or undefined for a
 * copied track.
 */
export function timedTextConverter(
    source: string,
    target: string,
): ((data: Uint8Array) => Uint8Array) | undefined {
    if (target !== 'tx3g' || !TX3G_SOURCE_CODECS.has(source)) return undefined;
    return data => tx3gSample(source, data).sample;
}

export class RemuxPlanner {
    constructor(
        private readonly format: string,
        private readonly writers: FormatWriters,
        private readonly matroskaPassThrough?: MatroskaPassThrough,
        private readonly matroskaUnsupportedTags = false,
        private readonly title?: string,
        private readonly tags?: MediaTags,
    ) {}

    checkTrackMetadata(
        tracks: readonly RemuxTrack[],
        format: string,
        diagnostics: DiagnosticContext,
    ): void {
        const metadataLoss = matroskaMetadataLoss(
            this.matroskaPassThrough,
            this.matroskaUnsupportedTags,
            format,
            tracks.map(track => track.info),
        );
        if (metadataLoss) diagnostics.metadata(metadataLoss);

        const tagLoss = containerTagLoss(this.tags, format, this.matroskaPassThrough);
        if (tagLoss) diagnostics.metadata(tagLoss);

        const mp4 = MP4_FAMILY.has(format);
        for (const track of tracks) {
            const alpha = alphaLoss(track.info, format);
            if (alpha) diagnostics.lose({ ...alpha, trackId: track.description.id });
            const views = stereoViewLoss(track.info, format);
            if (views) diagnostics.lose({ ...views, trackId: track.description.id });
            const layout = track.type === 'audio' ? pcmLayoutLoss(track.info, format) : undefined;
            if (layout) diagnostics.lose({ ...layout, trackId: track.description.id });
            const loss = trackDispositionLoss(track.info, format, track.type);
            if (loss) diagnostics.metadata(loss);
            const language = track.info.language;
            if (
                language &&
                (mp4
                    ? !mp4KeepsLanguage(language)
                    : format === 'ts' && !/^[a-z]{3}$/i.test(language))
            )
                diagnostics.metadata({
                    code: mp4 ? 'MP4_LANGUAGE_LOSS' : 'TS_LANGUAGE_LOSS',
                    message: `${format} cannot store the language tag '${language}'`,
                    trackId: track.description.id,
                    format,
                });
            const videoLoss =
                track.type === 'video' ? videoDescriptionLoss(track.info, format) : undefined;
            if (videoLoss) diagnostics.metadata(videoLoss);
            if (track.type === 'subtitle' && track.info.codec === 'tx3g' && format === 'mkv')
                diagnostics.metadata({
                    code: 'SUBTITLE_SETTINGS_LOSS',
                    message: '3GPP text becomes SubRip without fonts, sizes, colours or placement',
                    trackId: track.description.id,
                    format,
                });
            const ass = track.info.codec === 'text/ass' || track.info.codec === 'text/ssa';
            if (track.type === 'subtitle' && ass && isIsoOutput(format))
                diagnostics.metadata({
                    code: 'SUBTITLE_SETTINGS_LOSS',
                    message: 'ASS/SSA becomes 3GPP text without styles, positions or effects',
                    trackId: track.description.id,
                    format,
                });
        }
    }

    /**
     * Rejects tracks whose decoder configuration changes when `format` cannot follow the change:
     * standard MP4/MOV writes a sample description per configuration, and other containers except
     * fragmented MP4 re-send H.264/HEVC parameter sets in band.
     */
    checkCopy(tracks: readonly RemuxTrack[], format?: string): void {
        for (const track of tracks) {
            if ((track.info.codecConfigurations?.length ?? 0) > 1) {
                if (format && MP4_FAMILY.has(format)) continue;
                if (format && format !== 'fmp4' && inBandParameterSets(track.info)) continue;
                throw new MediaForgeError(
                    'A changing codec configuration needs separate init segments',
                    'FORMAT',
                );
            }
        }
    }

    /**
     * Fragmented MP4 copies and HLS/DASH packages alike write each track's presentation window as
     * its edit list, as ffmpeg does: the reorder delay of video, the priming of audio and what the
     * input's edit list hid. `videoRotation` replaces the copied counter-clockwise display rotation
     * of the first video track; `use` tells a whole file from a copied range, whose cut already
     * ends what the input's edit hid, and from an HLS or DASH package.
     */
    prepareSegments(
        tracks: readonly RemuxTrack[],
        options: SegmentOptions,
        diagnostics: DiagnosticContext,
        videoRotation?: number,
        use: 'file' | 'range' | 'package' = 'file',
    ) {
        this.checkCopy(tracks);
        this.checkTrackMetadata(tracks, 'fmp4', diagnostics);
        for (const track of tracks) {
            const loss = splicedCopyLoss(track.info, 'fmp4');
            if (loss) diagnostics.warn(loss);
        }

        // A fragmented file copy counts from its first decode time; packages start at zero by
        // design.
        const shift = use === 'package' ? 0 : rebasedStart('mp4', tracks, true);
        if (shift) diagnostics.warn(timelineShift('fmp4', shift));
        const firstVideo = tracks.find(track => track.type === 'video');
        const configs = tracks.map(track => {
            const rotation =
                track === firstVideo ? (videoRotation ?? track.info.rotation) : track.info.rotation;

            // Text subtitles (SubRip, ASS/SSA, WebVTT) are written as 3GPP timed text, which MP4
            // readers know.
            const timedText = track.type === 'subtitle' && TX3G_SOURCE_CODECS.has(track.info.codec);
            const written = cmafTrackConfig({
                ...track.description,
                ...(track.type === 'subtitle'
                    ? {}
                    : { forced: keptForced(track.description, 'fmp4') }),
                colour: track.info.colour,
                fieldOrder: track.info.fieldOrder,
                spatialBoxes: track.info.spatialBoxes,
                timescale:
                    track.info.timescale ??
                    (track.type === 'audio' ? track.info.sampleRate : 90000),
                rotation: track.type === 'video' && rotation ? rotation : undefined,
                ...(timedText ? { codec: 'tx3g', codecConfig: tx3gSampleEntryBody() } : {}),
            });
            const opus = use === 'range' ? undefined : opusWindow(track, written);
            const config = opus ?? written;
            const edit = opus ? opus.edit : presentationEdit(track, config, use === 'range');
            if (
                (edit === undefined && (track.info.editMediaTimeSeconds ?? 0) > 0) ||
                (track.info.matroskaCodecDelaySeconds ?? 0) > 0 ||
                (edit?.duration === undefined &&
                    ((track.info.audioTrailingPaddingSamples ?? 0) > 0 ||
                        (track.info.opusTrailingPaddingSamples ?? 0) > 0))
            ) {
                diagnostics.recover({
                    code: 'FMP4_PRESENTATION_WINDOW',
                    message: "Fragmented output cannot keep this track's gapless trim",
                    trackId: track.description.id,
                    format: 'fmp4',
                });
            }
            return edit ? { ...config, edit } : config;
        });
        const byteLimit = options.maxBufferedBytes ?? 16 * 1024 * 1024;
        const sampleLimit = options.maxBufferedSamples ?? 100_000;
        const factory = this.writers.segments;
        if (!factory) throw new MediaForgeError('No fragmented MP4 writer registered', 'FORMAT');

        // Every player of a package loads its initialization segment before any media, and ffmpeg's
        // HLS and DASH readers fail on one that holds megabytes of cover art: a package leaves the
        // pictures out.
        const pictures = use === 'package' ? this.tags?.pictures : undefined;
        if (pictures?.length)
            diagnostics.metadata({
                code: 'CONTAINER_METADATA_LOSS',
                message:
                    `HLS and DASH init segments leave out ${pictures.length} attached ` +
                    `picture(s)`,
                format: 'fmp4',
            });
        const writer = factory({
            tracks: configs,
            maxBufferedBytes: byteLimit,
            maxBufferedSamples: sampleLimit,
            title: this.title,
            tags: pictures?.length ? { ...this.tags!, pictures: undefined } : this.tags,
        });
        return { writer, configs, byteLimit, sampleLimit };
    }

    /**
     * `videoRotation` replaces the copied counter-clockwise display rotation of the first video
     * track; `trim` is the copy range of a start/end request, whose exact start MP4 output keeps in
     * an edit list.
     */
    prepareContainer(
        tracks: readonly RemuxTrack[],
        sink: Sink,
        options: RemuxOptions,
        diagnostics: DiagnosticContext,
        videoRotation?: number,
        trim?: TrimPlan,
    ) {
        if (options.format === 'fmp4')
            throw new MediaForgeError('Fragmented MP4 requires the segment writer', 'FORMAT');
        const video = tracks.filter(track => track.type === 'video');
        const audio = tracks.filter(track => track.type === 'audio');
        const subtitles = tracks.filter(track => track.type === 'subtitle');
        for (const track of tracks) assertMuxCodec(options.format, track.type, track.info.codec);

        for (const track of tracks) {
            if (sampleCount(track.info) === 0)
                throw new MediaForgeError(
                    'Container copy requires samples in every selected track',
                    'FORMAT',
                );
            if (lacksMp4Configuration(track.info, track.type, options.format, track === audio[0])) {
                throw new MediaForgeError(
                    `MP4 ${track.type} codec '${track.info.codec}' lacks its decoder configuration`,
                    'FORMAT',
                );
            }
        }

        const matroska = options.format === 'mkv' || options.format === 'webm';
        if (
            (video.length > 1 && !holdsSeveral(options.format, 'video')) ||
            (audio.length > 1 && !holdsSeveral(options.format, 'audio')) ||
            (subtitles.length > 0 && !holdsSeveral(options.format, 'subtitle')) ||
            (options.format === 'm4a' && video.length > 0)
        ) {
            throw new MediaForgeError('This output cannot carry the selected tracks', 'FORMAT', {
                hint: "Choose 'fmp4', or select other tracks.",
            });
        }

        const cfg: MuxerConfig = {
            title: this.title,
            tags: this.tags,
            format: options.format,
            // A copy into MP4 writes into a sink that can patch, or into the record of its
            // measuring pass (executeRemux()).
            mode: containerLayout(
                options.format,
                sink,
                video.length > 1 || audio.length > 1 || subtitles.length > 0,
            ),
            maxFragmentDuration: options.targetDuration ?? 2,
            autoSync: true,
            videoColour: video[0]?.info.colour,
            videoLanguage: video[0]?.info.language,
            audioLanguage: audio[0]?.info.language,
            video: video[0]
                ? {
                      ...copiedVideoTrack(video[0].info, this.format, options.format),
                      id: video[0].description.id,
                      ...(videoRotation === undefined ? {} : { rotation: videoRotation }),
                  }
                : undefined,
            audio: audio[0]
                ? {
                      ...copiedAudioTrack(audio[0].info, this.format, options.format),
                      id: audio[0].description.id,
                  }
                : undefined,
            extraVideoTracks: video.slice(1).map(track => ({
                ...copiedVideoTrack(track.info, this.format, options.format),
                id: track.description.id,
            })),
            extraAudioTracks: audio.slice(1).map(track => ({
                ...copiedAudioTrack(track.info, this.format, options.format as ContainerFormat),
                id: track.description.id,
            })),
            subtitleTracks: subtitles.map(track =>
                copiedSubtitleTrack(track.info, track.description.id, options.format),
            ),
        };

        if (matroska && !trim) {
            if (cfg.audio)
                cfg.audio = representableMatroskaWindow(
                    cfg.audio,
                    audio[0]!.info,
                    options.format,
                    diagnostics,
                );
            cfg.extraAudioTracks = cfg.extraAudioTracks?.map((track, index) =>
                representableMatroskaWindow(
                    track,
                    audio[index + 1]!.info,
                    options.format,
                    diagnostics,
                ),
            );
        }
        if (trim) {
            const cut = <T extends VideoTrackConfig | AudioTrackConfig>(
                config: T,
                track: RemuxTrack,
            ): T =>
                trimmedTrack(
                    config,
                    track,
                    trim,
                    options.format,
                    Math.min(trim.duration, presentationEnd(track) - trim.start),
                );
            if (cfg.video) cfg.video = cut(cfg.video, video[0]!);
            if (cfg.audio) cfg.audio = cut(cfg.audio, audio[0]!);
            cfg.extraVideoTracks = cfg.extraVideoTracks?.map((track, index) =>
                cut(track, video[index + 1]!),
            );
            cfg.extraAudioTracks = cfg.extraAudioTracks?.map((track, index) =>
                cut(track, audio[index + 1]!),
            );
        }

        const factory = this.writers.container.get(options.format);
        if (!factory)
            throw this.writers.missing.format(
                options.format,
                `No writer for '${options.format}'`,
                true,
            );
        const muxer = factory(cfg, sink);
        if (matroska && this.matroskaPassThrough)
            muxer.setMatroskaPassThrough?.(
                matroskaOutputMetadata(
                    this.matroskaPassThrough,
                    options.format as 'mkv' | 'webm',
                    tracks.map(track => track.info),
                ),
            );
        if (cfg.audio?.validSamples !== undefined)
            muxer.setAudioPriming?.(
                cfg.audio.primingSamples ?? 0,
                cfg.audio.validSamples,
                cfg.audio.presentationTimestamps,
                cfg.audio.discardLeadingSamples,
                cfg.audio.codecDelaySamples,
            );

        const routes = new Map<number, (packet: FilePacket) => void>();
        video.forEach((track, i) =>
            routes.set(
                track.description.id,
                copyRoute(
                    track,
                    options.format,
                    packet =>
                        i === 0
                            ? muxer.addVideoChunk(packet, packet.codecConfig)
                            : muxer.addExtraVideoChunk!(i - 1, packet, packet.codecConfig),
                    !trim,
                ),
            ),
        );
        audio.forEach((track, i) =>
            routes.set(track.description.id, packet =>
                i === 0
                    ? muxer.addAudioChunk(packet, packet.codecConfig)
                    : muxer.addExtraAudioChunk!(i - 1, packet, packet.codecConfig),
            ),
        );
        subtitles.forEach((track, i) =>
            routes.set(
                track.description.id,
                copyRoute(
                    track,
                    options.format,
                    packet => muxer.addSubtitleChunk!(packet, i),
                    false,
                    trim,
                ),
            ),
        );

        if (!MP4_FAMILY.has(options.format) || trim)
            for (const track of video) {
                const loss = splicedCopyLoss(track.info, options.format);
                if (loss) diagnostics.warn(loss);
            }

        const shift = trim ? 0 : copyStart(options.format, tracks, cfg.mode === 'fragmented');
        if (shift) diagnostics.warn(timelineShift(options.format, shift));
        return { muxer, routes, layout: cfg.mode };
    }

    resolveRemuxFormat(
        tracks: readonly RemuxTrack[],
        options: RemuxOptions,
    ): RemuxOptions['format'] {
        if (options.format === 'm4a' && tracks.some(track => track.type !== 'audio')) {
            throw new MediaForgeError('M4A requires audio-only tracks', 'FORMAT');
        }
        if (!['mp4', 'm4a', 'm4v'].includes(options.format)) return options.format;
        try {
            for (const track of tracks)
                assertMuxCodec(options.format, track.type, track.info.codec);
            return options.format;
        } catch (error) {
            if (!(error instanceof MediaForgeError) || error.code !== 'FORMAT') throw error;
            // Fragments carry Opus, VP9 and text; a track they cannot carry either keeps this
            // error.
            const lost = (track: RemuxTrack) =>
                !canMuxCodec(options.format, track.type, track.info.codec) &&
                !canFragmentCodec(track.type, track.info.codec);
            if (tracks.some(lost)) throw error;
            return 'fmp4';
        }
    }
}

/** What a copy of an open media file is planned from: its state (file-state). */
interface PlannedFile {
    readonly format: string;
    readonly writers: FormatWriters;
    readonly matroskaPassThrough?: MatroskaPassThrough;
    readonly matroskaUnsupportedTags: boolean;
    readonly title?: string;
    readonly tags?: MediaTags;
}

const planners = new WeakMap<PlannedFile, RemuxPlanner>();

/** The copy planner of an open media file, made once from its format, writers, title and tags. */
export function filePlanner(state: PlannedFile): RemuxPlanner {
    let planner = planners.get(state);
    if (!planner) {
        const { format, writers, matroskaPassThrough, matroskaUnsupportedTags, title, tags } =
            state;
        planner = new RemuxPlanner(
            format,
            writers,
            matroskaPassThrough,
            matroskaUnsupportedTags,
            title,
            tags,
        );
        planners.set(state, planner);
    }
    return planner;
}
