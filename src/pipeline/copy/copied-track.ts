import type { TrackInfo } from '../../core/model/track';
import { MP4_FAMILY, TX3G_SOURCE_CODECS, isIsoOutput } from '../../formats/shared/capabilities';
import { getCompactSampleIndex, sampleAt, sampleCount } from '../../core/model/sample-index';
import type {
    AudioTrackConfig,
    Mp4PresentationEdit,
    MuxerConfig,
    VideoTrackConfig,
} from '../../core/contracts/writer';
import type { ContainerFormat } from '../../core/model/media';
import { parseAacAudioSpecificConfig } from '../../core/codec-config/audio/adts';
import { assertPresentationWindow, editPresentationSamples } from '../../core/model/audio-window';
import { MediaForgeError } from '../../core/errors/errors';
import { mpegVideoFamily } from '../../core/model/codec-strings';
import { windowsMediaVideoFourcc } from '../../core/codec-config/windows-media';
import type { MediaDiagnostic } from '../../core/errors/diagnostics';
import type { FilePacket } from '../media-types';
import { decodeTime } from '../../core/model/media-time';
import { tx3gSampleEntryBody } from '../../formats/text/timed-text';

function audioTimingRate(track: TrackInfo): number {
    return track.codec.startsWith('opus') ? 48000 : Math.max(1, track.sampleRate || 48000);
}

/** Authoritative MP4 copy edit: the exact source elst plus the seconds fields derived from it. */
interface CopiedPresentation {
    presentationStartSeconds: number;
    presentationDurationSeconds: number;
    presentationMediaTimeSeconds: number;
    mediaTimescale: number;
    presentationEdit: Mp4PresentationEdit;
}

/**
 * Source edit relative to the first coded decode time; a negative media time means the edit starts
 * before it. The media edits after the first of a spliced edit list follow as splices, whose
 * packets `splicedMediaTimes` places.
 */
function copiedPresentation(track: TrackInfo): CopiedPresentation | undefined {
    const edit = track.editList;
    if (!edit || !sampleCount(track)) return undefined;
    const [mediaEntry, ...splices] = edit.entries.filter(entry => entry.mediaTime >= 0);
    if (!mediaEntry || mediaEntry.segmentDuration <= 0) return undefined;
    const leadMovieUnits = edit.entries[0]!.mediaTime === -1 ? edit.entries[0]!.segmentDuration : 0;
    const index = getCompactSampleIndex(track);
    let firstDecode = index ? index.decodeTimeAt(0) : Infinity;
    if (!index)
        for (const sample of track.samples) firstDecode = Math.min(firstDecode, decodeTime(sample));

    // Decode times carry the edit shift in seconds; the first coded decode time is a whole media
    // tick.
    const firstDecodeUnits = Math.round(
        (firstDecode - (track.editTimelineShiftSeconds ?? 0)) * edit.mediaTimescale,
    );
    const mediaTimeUnits = mediaEntry.mediaTime - firstDecodeUnits;
    const presented = splices.reduce(
        (sum, entry) => sum + entry.segmentDuration,
        mediaEntry.segmentDuration,
    );
    return {
        presentationStartSeconds: leadMovieUnits / edit.movieTimescale,
        presentationDurationSeconds: presented / edit.movieTimescale,
        presentationMediaTimeSeconds: mediaTimeUnits / edit.mediaTimescale,
        mediaTimescale: edit.mediaTimescale,
        presentationEdit: {
            leadMovieUnits,
            movieDuration: mediaEntry.segmentDuration,
            mediaTimeUnits,
            movieTimescale: edit.movieTimescale,
            mediaTimescale: edit.mediaTimescale,
            version: edit.version,
            ...(splices.length
                ? {
                      splices: splices.map(entry => ({
                          movieDuration: entry.segmentDuration,
                          mediaTimeUnits: entry.mediaTime - firstDecodeUnits,
                      })),
                  }
                : {}),
        },
    };
}

/**
 * The packets of a copied track with a spliced edit list on the media timeline its edits refer to:
 * each splice moves the packets from its start on by its shift. Undefined for other tracks.
 */
export function splicedMediaTimes(
    track: TrackInfo,
): ((packet: FilePacket) => FilePacket) | undefined {
    const splices = track.editSplices;
    if (!splices?.length) return undefined;
    const media = (time: number): number => {
        let shift = 0;
        for (const splice of splices) if (time >= splice.start - 1e-9) shift = splice.shift;
        return time + shift;
    };
    return packet => {
        const timestamp = media(packet.timestamp);
        const decodeTimestamp =
            packet.decodeTimestamp === undefined ? undefined : media(packet.decodeTimestamp);
        return {
            ...packet,
            timestamp,
            decodeTimestamp,
            compositionTimeOffset:
                decodeTimestamp === undefined ? undefined : timestamp - decodeTimestamp,
        };
    };
}

/**
 * The warning of a copy that cannot keep a spliced edit list: the decode-only samples between edits
 * are shown.
 */
export function splicedCopyLoss(
    track: TrackInfo,
    format: string,
): Omit<MediaDiagnostic, 'severity'> | undefined {
    if (!track.editSplices?.length) return undefined;
    let hidden = 0;
    for (let index = 0, count = sampleCount(track); index < count; index++)
        if (sampleAt(track, index)!.decodeOnly) hidden++;
    if (!hidden) return undefined;
    return {
        code: 'MP4_EDIT_SPLICE_NOT_KEPT',
        message: `${format} has no edit list, so ${hidden} hidden picture(s) flash briefly`,
        format,
        trackId: track.id,
    };
}

/** Copyable source edit; undefined when the edit starts before the first coded sample. */
function copiedExactPresentation(track: TrackInfo): CopiedPresentation | undefined {
    const copied = copiedPresentation(track);
    return copied && copied.presentationEdit.mediaTimeUnits >= 0 ? copied : undefined;
}

function copiedOutputPresentation(
    track: TrackInfo,
    outputFormat?: ContainerFormat,
): CopiedPresentation | undefined {
    return outputFormat !== undefined && MP4_FAMILY.has(outputFormat)
        ? copiedExactPresentation(track)
        : undefined;
}

export function encodedAudioSampleCount(track: TrackInfo, targetRate: number): number {
    const sourceRate = audioTimingRate(track);
    let sourceSamples = 0;
    if (track.codec.startsWith('mp4a') || track.codec === 'aac') {
        const parsedAac = track.codecConfig ? parseAacAudioSpecificConfig(track.codecConfig) : null;
        const samplesPerAccessUnit = parsedAac?.samplesPerAccessUnit ?? 1024;
        sourceSamples = sampleCount(track) * samplesPerAccessUnit;

        const explicitSbr =
            parsedAac?.audioObjectType === 5 ||
            parsedAac?.audioObjectType === 29 ||
            track.codec === 'mp4a.40.5' ||
            track.codec === 'mp4a.40.29';
        if (explicitSbr && track.editPresentationDurationSeconds !== undefined) {
            let durationSamples = 0;
            for (let index = 0, length = sampleCount(track); index < length; index++) {
                const sample = sampleAt(track, index)!;
                if (!Number.isFinite(sample.duration) || sample.duration < 0) {
                    throw new MediaForgeError(
                        `Audio track '${track.codec}' has an invalid encoded packet duration`,
                        'FORMAT',
                    );
                }
                durationSamples += Math.max(0, Math.round(sample.duration * sourceRate));
                if (!Number.isSafeInteger(durationSamples)) {
                    throw new MediaForgeError(
                        `Audio track '${track.codec}' encoded sample count exceeds the safe range`,
                        'FORMAT',
                    );
                }
            }
            sourceSamples = Math.max(sourceSamples, durationSamples);
        }
    } else {
        for (let index = 0, length = sampleCount(track); index < length; index++) {
            const sample = sampleAt(track, index)!;
            if (!Number.isFinite(sample.duration) || sample.duration < 0) {
                throw new MediaForgeError(
                    `Audio track '${track.codec}' has an invalid encoded packet duration`,
                    'FORMAT',
                );
            }
            sourceSamples += Math.max(0, Math.round(sample.duration * sourceRate));
            if (!Number.isSafeInteger(sourceSamples)) {
                throw new MediaForgeError(
                    `Audio track '${track.codec}' encoded sample count exceeds the safe range`,
                    'FORMAT',
                );
            }
        }
    }
    const scaled = Math.round((sourceSamples * Math.max(1, targetRate)) / sourceRate);
    if (!Number.isSafeInteger(scaled) || scaled < 0) {
        throw new MediaForgeError(
            `Audio track '${track.codec}' encoded sample count is invalid`,
            'FORMAT',
        );
    }
    return scaled;
}

function requirePossibleWindow(
    track: TrackInfo,
    encoded: number,
    head: number,
    valid: number,
): void {
    assertPresentationWindow(`Audio track '${track.codec}'`, encoded, head, valid);
}

function editValidSamples(track: TrackInfo, rate: number, available: number): number {
    return editPresentationSamples(track, rate, available, `Audio track '${track.codec}'`);
}

/** Finest decode-time grid laid out in frame slots; finer steps keep the mean rate. */
const MAX_SLOT_GRID_FPS = 240;

/**
 * MPEG and Windows Media video keep one frame per slot of a fixed rate where a container stores no
 * times (AVI), empty slots holding the gaps: the rate of the coarsest grid of 1 µs steps that every
 * decode time falls on, when it is no finer than MAX_SLOT_GRID_FPS. Undefined for other codecs,
 * whose frames follow each other at the nominal rate.
 */
function slotGridRate(track: TrackInfo, count: number): number | undefined {
    if (!mpegVideoFamily(track.codec) && !windowsMediaVideoFourcc(track.codec)) return undefined;
    let grid = 0;
    let previous = Number.NaN;
    for (let index = 0; index < count; index++) {
        const sample = sampleAt(track, index)!;
        const time = decodeTime(sample);
        const step = Math.round((time - previous) * 1e6);
        previous = time;
        if (!(step > 0)) continue;
        let a = grid;
        let b = step;
        while (b) [a, b] = [b, a % b];
        grid = a;
    }
    return grid > 0 && 1e6 / grid <= MAX_SLOT_GRID_FPS ? 1e6 / grid : undefined;
}

/**
 * Nominal frames per second of a copied track: the median frame duration when every duration is a
 * whole multiple of it (constant rate with dropped frames), else the mean of the durations near it,
 * else the slot grid of MPEG and Windows Media video, else the mean over the coded span.
 */
function copiedFramerate(track: TrackInfo): number {
    const count = sampleCount(track);
    if (count < 2) return 30;
    const step = Math.max(1, Math.ceil(count / 4096));
    const durations: number[] = [];
    for (let index = 0; index < count; index += step) {
        const duration = sampleAt(track, index)?.duration ?? 0;
        if (duration > 0 && Number.isFinite(duration)) durations.push(duration);
    }
    if (!durations.length) return 30;
    durations.sort((a, b) => a - b);
    const frame = durations[durations.length >> 1]!;
    if (
        durations.every(
            duration =>
                Math.round(duration / frame) >= 1 &&
                Math.abs(duration / frame - Math.round(duration / frame)) < 0.01,
        )
    )
        return 1 / frame;

    // Durations rounded to a coarse clock (Matroska milliseconds) alternate around the frame: their
    // mean is the rate, without frames held longer (a variable-rate still) that the whole span
    // would count.
    const regular = durations.filter(duration => Math.abs(duration / frame - 1) < 0.25);
    if (regular.length * 2 >= durations.length)
        return regular.length / regular.reduce((sum, duration) => sum + duration, 0);
    const grid = slotGridRate(track, count);
    if (grid) return grid;
    const first = sampleAt(track, 0)!;
    const last = sampleAt(track, count - 1)!;
    const span = decodeTime(last) + last.duration - decodeTime(first);
    return span > 0 ? count / span : 1 / frame;
}

/**
 * The forced flag a copied sound or picture track keeps in `target`: MP4 states it only for
 * subtitles (the forced-subtitle role), so MP4-family output leaves it out and the copy reports it
 * lost (trackDispositionLoss).
 */
export function keptForced(
    track: { readonly forced?: boolean },
    target?: string,
): boolean | undefined {
    return target !== undefined && isIsoOutput(target) ? undefined : track.forced;
}

/** Preserve the independent metadata of a byte-copied secondary video track. */
function copiedVideoTrackConfig(
    track: TrackInfo,
    outputFormat?: ContainerFormat,
): VideoTrackConfig {
    return {
        id: 0,
        matroskaTrackUid: track.matroskaTrackUid,
        type: 'video',
        alphaMode: track.alphaMode,
        codec: track.codec,
        width: track.width,
        height: track.height,
        rotation: track.rotation,
        displayWidth: track.displayWidth,
        displayHeight: track.displayHeight,
        pixelAspectRatioNum: track.pixelAspectRatioNum,
        pixelAspectRatioDen: track.pixelAspectRatioDen,
        language: track.language,
        default: track.default,
        forced: keptForced(track, outputFormat),
        name: track.name,
        title: track.title,
        commentary: track.commentary,
        dispositions: track.dispositions,
        colour: track.colour,
        fieldOrder: track.fieldOrder,
        framerate: copiedFramerate(track),
        codecConfig: track.codecConfig,
        dolbyVisionConfig: track.dolbyVisionConfig,
        spatialBoxes: track.spatialBoxes,
        ...copiedOutputPresentation(track, outputFormat),
    };
}

/**
 * Vorbis pre-roll, MPEG audio encoder delay (LAME/Xing) and AAC gapless delay (iTunSMPB) are stated
 * as priming samples on streams without an edit list.
 */
function hasPrimingSamples(track: TrackInfo): boolean {
    return (
        track.audioPrimingSamples !== undefined &&
        track.editList === undefined &&
        (['vorbis', 'mp1', 'mp2', 'mp3'].includes(track.codec) || /^mp4a\.40\./.test(track.codec))
    );
}

/**
 * Opus pre-skip in 48 kHz samples from an OpusHead (little-endian) or an MP4 dOps payload
 * (big-endian).
 */
function opusPreSkipOf(config: Uint8Array | undefined): number | undefined {
    if (!config) return undefined;
    if (config.length >= 19 && String.fromCharCode(...config.subarray(0, 8)) === 'OpusHead')
        return config[10]! | (config[11]! << 8);
    return config.length >= 11 && config[0] === 0 ? (config[2]! << 8) | config[3]! : undefined;
}

/**
 * Whether the leading discard of copiedAudioTrackConfig() comes from the track's header alone
 * (priming, an edit or a codec delay) rather than from the time of its first sample.
 */
export function headerAudioDiscard(track: TrackInfo): boolean {
    const preSkip =
        track.codec.startsWith('opus') && track.matroskaCodecDelaySeconds === undefined
            ? opusPreSkipOf(track.codecConfig)
            : undefined;
    return (
        hasPrimingSamples(track) ||
        track.editMediaTimeSeconds !== undefined ||
        (track.matroskaCodecDelaySeconds ?? (preSkip ?? 0) / 48000) > 0
    );
}

/**
 * The samples (at `rate`) an MP4 writer times a copied audio track over: `span` seconds from its
 * first packet to its last, then the last's `duration`. The writer stretches an AAC track that
 * comes within a millisecond of its coded samples to them (normalizeAacCodedDuration).
 */
function mp4WrittenSamples(track: TrackInfo, rate: number, span: number, duration: number): number {
    const timed = Math.round(span * rate) + Math.max(1, Math.round(duration * rate));
    if (!track.codec.startsWith('mp4a') && track.codec !== 'aac') return timed;
    const perUnit = track.codecConfig
        ? (parseAacAudioSpecificConfig(track.codecConfig)?.samplesPerAccessUnit ?? 0)
        : 0;
    const coded = sampleCount(track) * perUnit;
    return perUnit > 0 && Math.abs(coded - timed) <= Math.max(2, Math.ceil(rate / 1000))
        ? coded
        : timed;
}

/** Preserve the independent metadata of a byte-copied secondary audio track. */
export function copiedAudioTrackConfig(
    track: TrackInfo,
    outputFormat?: ContainerFormat,
): AudioTrackConfig {
    const rate = track.sampleRate || 48000;
    const first = sampleAt(track, 0)?.timestamp ?? 0;
    const last = sampleAt(track, sampleCount(track) - 1);
    const end = last ? last.timestamp + last.duration : first;

    // An MP4 Opus track states its pre-skip in dOps and covers it again with its edit list.
    const opusPreSkip =
        track.codec.startsWith('opus') && track.matroskaCodecDelaySeconds === undefined
            ? opusPreSkipOf(track.codecConfig)
            : undefined;
    const codecDelaySeconds = Math.max(
        0,
        track.matroskaCodecDelaySeconds ?? (opusPreSkip ?? 0) / 48000,
    );
    const primed = hasPrimingSamples(track);
    const explicitDiscardSeconds = Math.max(
        0,
        (primed
            ? track.audioPrimingSamples! / rate
            : track.editMediaTimeSeconds !== undefined
              ? track.editMediaTimeSeconds - (opusPreSkip ?? 0) / 48000
              : undefined) ?? (codecDelaySeconds > 0 ? 0 : Math.max(0, -first)),
    );
    const codecDelaySamples = Math.max(0, Math.round(codecDelaySeconds * rate));
    const isMatroska = outputFormat === 'mkv' || outputFormat === 'webm';

    // Matroska carries a codec delay other than Opus pre-skip in CodecDelay; every other target
    // folds it into the leading discard (the MP4 edit start), since the delay samples are not
    // presented either.
    const delayInPriming =
        track.codec.startsWith('opus') || (outputFormat !== undefined && !isMatroska);

    const primingSamples = Math.max(
        0,
        Math.round(
            (delayInPriming ? codecDelaySeconds + explicitDiscardSeconds : explicitDiscardSeconds) *
                rate,
        ),
    );
    const trailingSamples = Math.max(
        0,
        Math.round(
            Math.max(track.audioTrailingPaddingSamples ?? 0, track.opusTrailingPaddingSamples ?? 0),
        ),
    );
    const hasWindow =
        primingSamples > 0 ||
        codecDelaySamples > 0 ||
        trailingSamples > 0 ||
        track.editPresentationDurationSeconds !== undefined;
    const codedSamples = encodedAudioSampleCount(track, rate);
    const wanted = Math.round(
        isMatroska && track.editPresentationDurationSeconds === undefined
            ? codedSamples - primingSamples - trailingSamples
            : track.editPresentationDurationSeconds !== undefined
              ? editValidSamples(track, rate, codedSamples - primingSamples)
              : track.codec.startsWith('mp4a') ||
                  track.codec === 'aac' ||
                  track.codec.startsWith('opus') ||
                  primed
                ? codedSamples - primingSamples - trailingSamples
                : Math.round((end - Math.max(0, first)) * rate) -
                  (track.presentationTimestampsIncludeEdits === true
                      ? 0
                      : Math.round(Math.max(0, track.editMediaTimeSeconds ?? 0) * rate)) -
                  trailingSamples,
    );
    // MP4 times a copied packet by the step to the next one and the last by its duration, so on
    // times coarser than the samples (Matroska's milliseconds) the written track can be shorter
    // than the samples it codes: the window then ends where the track does.
    const written =
        last && outputFormat !== undefined && MP4_FAMILY.has(outputFormat)
            ? mp4WrittenSamples(track, rate, last.timestamp - first, last.duration)
            : Infinity;
    const validSamples =
        wanted > written - primingSamples && written - primingSamples >= 1
            ? written - primingSamples
            : wanted;
    if (hasWindow) requirePossibleWindow(track, codedSamples, primingSamples, validSamples);
    return {
        id: 0,
        matroskaTrackUid: track.matroskaTrackUid,
        type: 'audio',
        codec: track.codec === 'aac' ? 'mp4a.40.2' : track.codec,
        sampleRate: track.sampleRate || 48000,
        channelCount: track.channelCount || 2,
        codecConfig: track.codecConfig,
        language: track.language,
        default: track.default,
        forced: keptForced(track, outputFormat),
        name: track.name,
        title: track.title,
        commentary: track.commentary,
        dispositions: track.dispositions,
        ...(hasWindow
            ? {
                  primingSamples,
                  validSamples,
                  presentationTimestamps: track.presentationTimestampsIncludeEdits === true,
                  discardLeadingSamples: explicitDiscardSeconds > 0,
                  ...(outputFormat === undefined ||
                  outputFormat === 'mkv' ||
                  outputFormat === 'webm'
                      ? { codecDelaySamples }
                      : {}),
              }
            : {}),
        ...copiedOutputPresentation(track, outputFormat),
    };
}

interface SourceAudioWindow {
    head: number;
    valid: number;
    startOffset: number;
}

/** Exact coded-to-presentation sample window for a source audio track. */
export function sourceAudioWindow(src: TrackInfo, rate: number): SourceAudioWindow {
    const sourceRate = src.codec.startsWith('opus') ? 48000 : src.sampleRate || rate || 48000;
    const first = sampleAt(src, 0)?.timestamp ?? 0;
    const last = sampleAt(src, sampleCount(src) - 1);
    const end = last ? last.timestamp + last.duration : 0;
    const codecDelay = Math.max(0, src.matroskaCodecDelaySeconds ?? 0);
    const explicitDiscard = Math.max(
        0,
        (hasPrimingSamples(src)
            ? src.audioPrimingSamples! / sourceRate
            : src.editMediaTimeSeconds) ?? (codecDelay > 0 ? 0 : Math.max(0, -first)),
    );

    const totalSkip = src.codec.startsWith('opus') ? codecDelay + explicitDiscard : explicitDiscard;
    const head = Math.max(0, Math.round(totalSkip * rate));
    const startOffset = Math.max(0, first);
    const sourceTail = Math.max(
        src.audioTrailingPaddingSamples ?? 0,
        src.opusTrailingPaddingSamples ?? 0,
    );
    const tail = Math.max(0, Math.round((sourceTail * rate) / sourceRate));
    const codedSamples = encodedAudioSampleCount(src, rate);
    const hasCodedWindow =
        src.editPresentationDurationSeconds !== undefined ||
        codecDelay > 0 ||
        totalSkip > 0 ||
        tail > 0;
    const valid = Math.max(
        1,
        src.editPresentationDurationSeconds !== undefined
            ? editValidSamples(src, rate, codedSamples - head - tail)
            : hasCodedWindow
              ? codedSamples - head - tail
              : Math.round((end - startOffset) * rate) -
                (src.presentationTimestampsIncludeEdits === true
                    ? 0
                    : Math.round(Math.max(0, src.editMediaTimeSeconds ?? 0) * rate)) -
                tail,
    );
    return { head, valid, startOffset };
}

/** True only for an explicit leading presentation discard, not CodecDelay alone. */
export function hasSourceAudioPriming(src: TrackInfo): boolean {
    if (hasPrimingSamples(src) && src.audioPrimingSamples! > 0) return true;
    if ((src.editMediaTimeSeconds ?? 0) > 0) return true;
    if ((src.matroskaCodecDelaySeconds ?? 0) > 0) return false;
    return (sampleAt(src, 0)?.timestamp ?? 0) < 0;
}

/** Derive a Matroska DiscardPadding window from encoded packet durations. */
function sourceAudioRemuxWindow(
    src: TrackInfo,
    rate: number,
    fmt: ContainerFormat,
): SourceAudioWindow {
    const window = sourceAudioWindow(src, rate);
    if (fmt !== 'mkv' && fmt !== 'webm') {
        // Outside Matroska a codec delay other than Opus pre-skip is part of the leading discard.
        const delay = src.codec.startsWith('opus')
            ? 0
            : Math.max(0, Math.round((src.matroskaCodecDelaySeconds ?? 0) * rate));
        if (!delay) return window;
        const valid =
            src.editPresentationDurationSeconds !== undefined ? window.valid : window.valid - delay;
        requirePossibleWindow(src, encodedAudioSampleCount(src, rate), window.head + delay, valid);
        return { ...window, head: window.head + delay, valid };
    }

    const sourceRate = audioTimingRate(src);
    const tailAtSourceRate = Math.max(
        src.audioTrailingPaddingSamples ?? 0,
        src.opusTrailingPaddingSamples ?? 0,
    );
    const tail = Math.max(0, Math.round((tailAtSourceRate * rate) / sourceRate));
    const encoded = encodedAudioSampleCount(src, rate);
    const valid =
        src.editPresentationDurationSeconds !== undefined
            ? editValidSamples(src, rate, encoded - window.head - tail)
            : encoded - window.head - tail;
    requirePossibleWindow(src, encoded, window.head, valid);
    return { ...window, valid };
}

export function matroskaAudioWindowFitsFinalPacket(track: TrackInfo): boolean {
    const rate = audioTimingRate(track);
    const window = sourceAudioRemuxWindow(track, rate, 'mkv');
    const encoded = encodedAudioSampleCount(track, rate);
    const trailing = Math.max(0, encoded - window.head - window.valid);
    if (trailing === 0) return true;
    const last = sampleAt(track, sampleCount(track) - 1);
    if (!last) return false;
    const parsedAac = track.codecConfig ? parseAacAudioSpecificConfig(track.codecConfig) : null;
    const finalPacketSamples =
        track.codec.startsWith('mp4a') || track.codec === 'aac'
            ? (parsedAac?.samplesPerAccessUnit ?? 1024)
            : Math.max(0, Math.round(last.duration * rate));
    return trailing <= finalPacketSamples;
}

/** The exact MP4 edit of a track copied from MP4 into MP4; undefined between other containers. */
function presentation(
    track: TrackInfo,
    source: string,
    target: string,
): CopiedPresentation | undefined {
    if (!MP4_FAMILY.has(source) || !MP4_FAMILY.has(target)) return undefined;
    const copied = copiedPresentation(track);
    if (copied && copied.presentationEdit.mediaTimeUnits < 0)
        throw new MediaForgeError(
            'Cannot copy an MP4 edit beginning before the first coded sample',
            'FORMAT',
        );
    return copied;
}

/** Tracks that switch decoder configurations write one sample description per configuration. */
const changes = (track: TrackInfo) =>
    (track.codecConfigurations?.length ?? 0) > 1 ? { codecConfigChanges: true } : {};

/**
 * The muxer configuration of a copied video track, with its MP4 edit when both containers are MP4.
 */
export function copiedVideoTrack(
    track: TrackInfo,
    source: string,
    target: string,
): VideoTrackConfig {
    return {
        ...copiedVideoTrackConfig(track),
        forced: keptForced(track, target),
        ...presentation(track, source, target),
        ...changes(track),
    };
}

/**
 * The muxer configuration of a copied text subtitle track with the output track ID `id`: in MP4
 * output, other text becomes 3GPP timed text with ffmpeg's default sample entry.
 */
export function copiedSubtitleTrack(
    track: TrackInfo,
    id: number,
    format?: string,
): NonNullable<MuxerConfig['subtitleTracks']>[number] {
    const timedText = !!format && MP4_FAMILY.has(format) && TX3G_SOURCE_CODECS.has(track.codec);
    return {
        id,
        codec: timedText ? 'tx3g' : track.codec,
        matroskaTrackUid: track.matroskaTrackUid,
        codecConfig: timedText ? tx3gSampleEntryBody() : track.codecConfig,
        language: track.language,
        default: track.default,
        forced: track.forced,
        name: track.name,
        title: track.title,
        commentary: track.commentary,
        dispositions: track.dispositions,
    };
}

/**
 * The muxer configuration of a copied audio track, with its MP4 edit when both containers are MP4.
 */
export function copiedAudioTrack(
    track: TrackInfo,
    source: string,
    target: ContainerFormat,
): AudioTrackConfig {
    const edit = presentation(track, source, target);
    if (!edit) return { ...copiedAudioTrackConfig(track, target), ...changes(track) };
    return {
        id: 0,
        matroskaTrackUid: track.matroskaTrackUid,
        type: 'audio',
        codec: track.codec,
        sampleRate: track.sampleRate,
        channelCount: track.channelCount,
        codecConfig: track.codecConfig,
        language: track.language,
        default: track.default,
        forced: keptForced(track, target),
        name: track.name,
        title: track.title,
        commentary: track.commentary,
        dispositions: track.dispositions,
        ...edit,
        ...changes(track),
    };
}
