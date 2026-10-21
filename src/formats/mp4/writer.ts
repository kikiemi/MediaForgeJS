import { carriedObjectType, isMpegH } from './carried-audio';
import type { Sink } from '../../core/model/types';
import {
    isAnnexB,
    isValidAvccWalk,
    annexBToAvcc,
    buildAvcCFromAnnexB,
    isValidHevcWalk,
} from '../../core/codec-config/video/annexb';
import { buildHevcCFromAnnexB } from '../../core/codec-config/video/hevc-config';
import { MediaForgeError } from '../../core/errors/errors';
import { handOffOutput } from '../../core/bytes/output-data';
import { proResFrameError } from '../../core/codec-config/video/prores';
import {
    MJPEG_OBJECT_TYPE,
    MJPEG_QUICKTIME_ENTRY,
    MJPEG_VIDEO,
} from '../../core/codec-config/video/mjpeg';
import { isProResRawCodec, proResRawFrameError } from '../../core/codec-config/video/prores-raw';
import type {
    MuxerConfig,
    AudioTrackConfig,
    Mp4PresentationEdit,
    VideoTrackConfig,
    OutputMuxer,
} from '../../core/contracts/writer';
import type { EncodedPacket, VideoColour } from '../../core/model/media';
import { parseAacAudioSpecificConfig } from '../../core/codec-config/audio/adts';
import { AAC_SAMPLE_RATES } from '../../core/codec-config/audio/aac-sample-rates';
import { alacCookie } from '../../core/codec-config/audio/alac-packet';
import { flacStreamInfoAt, flacStreamInfoRecord } from '../../core/codec-config/audio/flac-frame';
import { sameBytes } from '../../core/bytes/bytes';
import {
    ac3SpecificBox,
    parseDolbyFrameHeader,
} from '../../core/codec-config/audio/dolby-audio-header';
import {
    audioHasKeyframes,
    codecFamily,
    isDtsCodec,
    mpegVideoObjectType,
    isProResCodec,
    isHevcCodec,
} from '../../core/model/codec-strings';
import { vpcCFor } from '../../core/codec-config/video/vp9-config';
import { opusDopsPayload } from '../../core/codec-config/audio/opus-head';
import { hevcLengthSize, stripHevcParameterSets } from '../../core/codec-config/video/hevc-codec';
import {
    dolbyVisionBoxType,
    dolbyVisionSampleEntry,
    parseDolbyVisionConfig,
} from '../../core/codec-config/video/dolby-vision';
import { buildVvcCFromAnnexB, isVvcCodec, parseVvcC } from '../../core/codec-config/video/vvc';
import {
    checkedInteger,
    Mp4SampleRuns,
    Mp4SampleTable,
    presentedFromEdit,
    type SampleTiming,
} from './write/sample-table';
import { isoPcmEntry, pcmShape, quickTimePcmEntry } from './write/pcm-entry';
import { EMPTY_TEXT_SAMPLE, TEXT_TIMESCALE, textSampleEntry } from './write/text-track';
import { isPcmCodec } from '../../core/model/codec-strings';
import {
    checkedFieldOrder,
    snapshotVideoColour,
    visualSampleEntryBoxes,
} from '../shared/video-colour';
import {
    mp4HandlerPayload,
    mp4Language,
    mp4TitleBox,
    mp4TrackFlags,
    mp4TrackMetadataBoxes,
    validateMp4TrackMetadata,
    type Mp4TrackMetadata,
} from './metadata';
import { gcd } from '../../core/bytes/gcd';
import { decodeTime, secondsToTicks } from '../../core/model/media-time';
import {
    audioSampleEntry,
    dinfBox,
    editListBox,
    esdsBox,
    flacSampleEntry,
    fragmentedSampleTable,
    iacbBox,
    mdhdBox,
    mediaHeaderBox,
    mvhdBox,
    paspBox,
    stsdBox,
    tkhdBox,
    trexBox,
    visualSampleEntry,
} from './iso-boxes';
import { isoFullBox as fullBox, latin1, uint32 } from '../shared/iso-box';
import { assertOpen, checkChunk, unfedTrack } from '../shared/chunk-checks';

/**
 * A box written once into the bytes of the box holding it: the sample tables of a long track, and
 * the boxes holding them, are filled into the one buffer of the moov rather than each built and
 * then copied into its parent.
 */
interface DeferredBox {
    readonly size: number;
    writeInto(target: Uint8Array, at: number): void;
}

type BoxPart = Uint8Array | DeferredBox;

/** The rate Opus decodes to, which times its MP4 track and fills its sample entry. */
const OPUS_RATE = 48000;

/** The box of a video sample entry that holds the decoder configuration, if the entry has one. */
function videoConfigBoxType(entry: string): string | undefined {
    if (entry === 'av01') return 'av1C';
    if (entry === 'vp09') return 'vpcC';
    if (entry === 'apv1') return 'apvC';
    if (isHevcCodec(entry)) return 'hvcC';
    if (entry.startsWith('avc')) return 'avcC';
    return isVvcCodec(entry) ? 'vvcC' : undefined;
}

/** The metadata of a text track: a subtitle, which MP4 lets carry the forced disposition. */
function textTrackMetadata(
    track: NonNullable<MuxerConfig['subtitleTracks']>[number],
): Mp4TrackMetadata {
    return { ...track, type: 'subtitle' };
}

function partSize(part: BoxPart): number {
    return part instanceof Uint8Array ? part.length : part.size;
}

function writePart(part: BoxPart, target: Uint8Array, at: number): void {
    if (part instanceof Uint8Array) target.set(part, at);
    else part.writeInto(target, at);
}

/** The bytes of `part`, in one new buffer. */
function serializeBox(part: BoxPart): Uint8Array {
    if (part instanceof Uint8Array) return part;
    const out = new Uint8Array(part.size);
    part.writeInto(out, 0);
    return out;
}

function writeBoxHeader(target: Uint8Array, at: number, type: string, size: number): void {
    new DataView(target.buffer, target.byteOffset).setUint32(at, size, false);
    target.set(latin1(type), at + 4);
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array;
function box(type: string, ...payloads: BoxPart[]): BoxPart;
function box(type: string, ...payloads: BoxPart[]): BoxPart {
    let total = 8;
    for (const p of payloads) total += partSize(p);
    const deferred: DeferredBox = {
        size: total,
        writeInto: (target, at) => {
            writeBoxHeader(target, at, type, total);
            let pos = at + 8;
            for (const part of payloads) {
                writePart(part, target, pos);
                pos += partSize(part);
            }
        },
    };
    return payloads.every(part => part instanceof Uint8Array) ? serializeBox(deferred) : deferred;
}

/**
 * A full box of `head` fields and then `count` entries of `entryBytes`, which `fill` writes for
 * entry `index` at `at` of `view`.
 */
function tableBox(
    type: string,
    version: number,
    head: Uint8Array,
    count: number,
    entryBytes: number,
    fill: (view: DataView, at: number, index: number) => void,
): DeferredBox {
    const size = 12 + head.length + count * entryBytes;
    return {
        size,
        writeInto: (target, at) => {
            writeBoxHeader(target, at, type, size);
            target[at + 8] = version;
            target.set(head, at + 12);
            const view = new DataView(target.buffer, target.byteOffset);
            const first = at + 12 + head.length;
            for (let index = 0; index < count; index++)
                fill(view, first + index * entryBytes, index);
        },
    };
}

function fixed16_16(v: number): number {
    return Math.max(0, Math.round(v * 65536));
}

function validateChunkTiming(chunk: EncodedPacket): void {
    if (
        !Number.isFinite(chunk.timestamp) ||
        !Number.isFinite(chunk.duration ?? 0) ||
        (chunk.duration ?? 0) < 0 ||
        (chunk.decodeTimestamp !== undefined && !Number.isFinite(chunk.decodeTimestamp)) ||
        (chunk.compositionTimeOffset !== undefined && !Number.isFinite(chunk.compositionTimeOffset))
    ) {
        throw new MediaForgeError('MP4 chunk has non-finite timing or a negative duration', 'MUX');
    }
}

function signed32Payload(value: number): number {
    return value < 0 ? value + 0x100000000 : value;
}

/**
 * Exact edits copied from one source movie keep its timescale; otherwise every timescale divides
 * the result.
 */
function chooseMovieTimescale(
    trackTimescales: readonly number[],
    editMovieTimescales: readonly number[] = [],
): number {
    const MAX_EXACT = 1_000_000_000;
    const shared = editMovieTimescales[0];
    if (shared !== undefined && editMovieTimescales.every(scale => scale === shared)) return shared;
    let result = 1000;
    for (const raw of [...trackTimescales, ...editMovieTimescales]) {
        const scale = Math.round(raw);
        if (!Number.isSafeInteger(scale) || scale < 1 || scale > 0xffffffff) continue;
        const factor = scale / gcd(result, scale);
        if (!Number.isSafeInteger(factor) || result > MAX_EXACT / factor) {
            return 1_000_000;
        }
        result *= factor;
    }
    return result;
}

/**
 * Integer rescaling of edit units; exact whenever `to` is a multiple of `from`, nearest integer
 * otherwise.
 */
function rescaleEditUnits(value: number, from: number, to: number, label: string): number {
    if (from === to) return checkedInteger(value, label);
    const scaled = BigInt(checkedInteger(value, label)) * BigInt(to);
    const divisor = BigInt(from);
    const quotient = scaled / divisor;
    const rounded = (scaled % divisor) * 2n >= divisor ? quotient + 1n : quotient;
    return checkedInteger(Number(rounded), label);
}

/** Movie units an edit presents: its first media edit and every splice after it. */
function editMovieDuration(edit: Mp4PresentationEdit): number {
    return (edit.splices ?? []).reduce(
        (sum, splice) => sum + splice.movieDuration,
        edit.movieDuration,
    );
}

function validatePresentationEdit(edit: Mp4PresentationEdit): void {
    checkedInteger(edit.movieTimescale, 'copy edit movie timescale', 1, 0xffffffff);
    checkedInteger(edit.mediaTimescale, 'copy edit media timescale', 1, 0xffffffff);
    checkedInteger(edit.leadMovieUnits, 'copy edit lead duration');
    checkedInteger(edit.movieDuration, 'copy presentation duration', 1);
    checkedInteger(edit.mediaTimeUnits, 'copy edit media time');
    checkedInteger(editMovieDuration(edit) + edit.leadMovieUnits, 'copy presentation end');
    for (const splice of edit.splices ?? []) {
        checkedInteger(splice.movieDuration, 'copy splice duration', 1);
        checkedInteger(splice.mediaTimeUnits, 'copy splice media time');
    }
    if (edit.version !== undefined && edit.version !== 0 && edit.version !== 1) {
        throw new MediaForgeError('MP4 copy edit version must be 0 or 1', 'FORMAT');
    }
}

interface TrackTiming extends SampleTiming {
    readonly edit?: Mp4PresentationEdit;
}

function hasCopyPresentation(track: VideoTrackConfig | AudioTrackConfig | undefined): boolean {
    return (
        track?.presentationMediaTimeSeconds !== undefined || track?.presentationEdit !== undefined
    );
}

function copyPresentationTiming(
    timing: TrackTiming,
    timescale: number,
    track: VideoTrackConfig | AudioTrackConfig | undefined,
): TrackTiming {
    if (!hasCopyPresentation(track)) return timing;
    const edit = track!.presentationEdit;
    if (edit) {
        return {
            ...timing,
            startSeconds: edit.leadMovieUnits / edit.movieTimescale,
            mediaTimeUnits: rescaleEditUnits(
                edit.mediaTimeUnits,
                edit.mediaTimescale,
                timescale,
                'copy edit media time',
            ),
            edit,
        };
    }

    return {
        ...timing,
        startSeconds: track!.presentationStartSeconds!,
        mediaTimeUnits: secondsToTicks(
            track!.presentationMediaTimeSeconds!,
            timescale,
            'MP4 copy edit media time',
            { min: 0 },
        ),
    };
}

/**
 * Audio has no reordering, so composition offsets on audio samples (some fragmented writers set
 * them on the first packets) only move where the track starts. The track is placed by its decode
 * start with an edit from media time 0, which presents the same samples at the same movie times;
 * readers that apply audio edits on the decode clock (FFmpeg) then place it as the others do.
 * Tracks whose composition offsets continue to the last sample keep their edit.
 */
function audioOnDecodeClock(timing: TrackTiming, timescale: number): TrackTiming {
    if (
        timing.edit ||
        timing.mediaTimeUnits <= 0 ||
        Math.abs(timing.compositionOffsets.lastValue) > 1
    )
        return timing;
    return {
        ...timing,
        startSeconds: timing.startSeconds - timing.mediaTimeUnits / timescale,
        mediaTimeUnits: 0,
    };
}

function presentationMovieDuration(
    track: VideoTrackConfig | AudioTrackConfig | undefined,
    timing: TrackTiming,
    timescale: number,
    movieTimescale: number,
    validSamples?: number,
): number {
    const edit = track?.presentationEdit;
    if (edit)
        return rescaleEditUnits(
            editMovieDuration(edit),
            edit.movieTimescale,
            movieTimescale,
            'track presentation duration',
        );
    const seconds = hasCopyPresentation(track)
        ? track!.presentationDurationSeconds!
        : (validSamples ?? timing.durationUnits) / timescale;
    return secondsToTicks(seconds, movieTimescale, 'MP4 track presentation duration', { min: 0 });
}

function editMovieTimescales(
    tracks: readonly (VideoTrackConfig | AudioTrackConfig | undefined)[],
): number[] {
    return tracks.flatMap(track =>
        track?.presentationEdit ? [track.presentationEdit.movieTimescale] : [],
    );
}

function applyAudioPresentationWindow(
    timing: TrackTiming,
    timescale: number,
    primeSamples: number,
    validSamples: number,
    presentationTimestamps: boolean,
    label: string,
): TrackTiming {
    if (
        !Number.isSafeInteger(primeSamples) ||
        primeSamples < 0 ||
        !Number.isSafeInteger(validSamples) ||
        validSamples < 1
    ) {
        throw new MediaForgeError(`${label} has an invalid presentation sample window`, 'FORMAT');
    }
    const desiredMediaDuration = checkedInteger(
        primeSamples + validSamples,
        `${label} presentation duration`,
    );
    const lastIndex = timing.decodeDurations.length - 1;
    if (lastIndex < 0 || desiredMediaDuration > timing.durationUnits) {
        throw new MediaForgeError(`${label} edit is longer than its encoded media`, 'MUX');
    }
    const beforeLast = timing.durationUnits - timing.decodeDurations.lastValue;
    const decodeDurations = timing.decodeDurations;
    let durationUnits = timing.durationUnits;

    if (desiredMediaDuration > beforeLast) {
        const finalDuration = desiredMediaDuration - beforeLast;
        if (finalDuration < 1 || finalDuration > timing.decodeDurations.lastValue) {
            throw new MediaForgeError(`${label} edit is longer than its encoded media`, 'MUX');
        }
        decodeDurations.replaceLast(finalDuration);
        durationUnits = desiredMediaDuration;
    }
    return {
        ...timing,
        decodeDurations,
        mediaTimeUnits: checkedInteger(
            timing.mediaTimeUnits + primeSamples,
            `${label} edit media time`,
        ),
        durationUnits,
        startSeconds:
            timing.startSeconds +
            (presentationTimestamps
                ? primeSamples
                : Math.min(
                      primeSamples,
                      Math.max(0, secondsToTicks(-timing.startSeconds, timescale, `${label} lead`)),
                  )) /
                timescale,
    };
}

function normalizeAacCodedDuration(
    timing: TrackTiming,
    timescale: number,
    packetCount: number,
    codecConfig: Uint8Array | undefined,
): TrackTiming {
    const samplesPerAccessUnit = codecConfig
        ? (parseAacAudioSpecificConfig(codecConfig)?.samplesPerAccessUnit ?? 0)
        : 0;
    if (samplesPerAccessUnit <= 0 || packetCount <= 0) return timing;
    const expected = packetCount * samplesPerAccessUnit;
    if (!Number.isSafeInteger(expected)) {
        throw new MediaForgeError('AAC coded sample count exceeds exact-integer range', 'MUX');
    }
    const difference = expected - timing.durationUnits;
    const tolerance = Math.max(2, Math.ceil(timescale / 1000));
    const lastIndex = timing.decodeDurations.length - 1;
    const adjustedLast = timing.decodeDurations.lastValue + difference;
    if (lastIndex < 0 || Math.abs(difference) > tolerance || adjustedLast < 1) return timing;
    const decodeDurations = timing.decodeDurations;
    decodeDurations.replaceLast(adjustedLast);
    return { ...timing, decodeDurations, durationUnits: expected };
}

export class Mp4Muxer implements OutputMuxer {
    /** co64 + 64-bit mdat once the file passes the 32-bit box limits. */
    private use64BitOffsets = false;

    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;
    private readonly videoChunks: Mp4SampleTable;
    private readonly audioChunks: Mp4SampleTable;
    private videoConfig?: Uint8Array;
    private audioConfig?: Uint8Array;
    /**
     * Where a fragmented init segment states the FLAC STREAMINFO record it was written with: one
     * given since (an encoder's, completed at the end) replaces it at finalize on a sink that
     * patches.
     */
    private flacInit?: { readonly at: number; readonly record: Uint8Array };
    private readonly extraVideoChunks: Mp4SampleTable[] = [];
    private readonly extraVideoConfigs: (Uint8Array | undefined)[] = [];
    private activeVideoCfg: VideoTrackConfig | undefined;
    private activeVideoConfig: Uint8Array | undefined;
    private readonly extraAudioChunks: Mp4SampleTable[] = [];
    private readonly extraAudioConfigs: (Uint8Array | undefined)[] = [];
    private activeAudioCfg: AudioTrackConfig | undefined;
    private activeAudioConfig: Uint8Array | undefined;
    /** Text tracks (3GPP timed text), and where the latest sample of each ends, in seconds. */
    private readonly textChunks: Mp4SampleTable[] = [];
    private readonly textEnds: number[] = [];
    /** Text tracks whose latest sample shows text, which an empty sample ends at finalize. */
    private readonly textShown: boolean[] = [];
    /**
     * Text tracks whose last sample is an instant: the empty sample of no duration that ends the
     * last cue, added at finalize or copied.
     */
    private readonly textInstant: boolean[] = [];

    private readonly fragmented: boolean;
    private initWritten = false;
    private moofSeq = 1;
    private fragStartSec: number | null = null;
    private pendingV: EncodedPacket[] = [];
    private pendingA: EncodedPacket[] = [];
    private vFirstDtsSec: number | null = null;
    private aFirstDtsSec: number | null = null;
    private vLastDtsSec = Number.NEGATIVE_INFINITY;
    private aLastDtsSec = Number.NEGATIVE_INFINITY;
    private vMinPtsSec = Number.POSITIVE_INFINITY;
    private aMinPtsSec = Number.POSITIVE_INFINITY;
    private fragmentedVideoSeen = false;
    private fragmentedAudioSeen = false;
    private fragmentedAudioPacketCount = 0;
    private fragmentedAudioDurationUnits = 0;

    private videoTimelineRebaseSec = 0;
    private audioTimelineRebaseSec = 0;
    private videoPresentationStartSec = 0;
    private audioPresentationStartSec = 0;

    private readonly eagerStandard: boolean;
    private standardHeaderWritten = false;
    private standardMdatHeaderOffset = 0;
    private standardPayloadOffset = 0;
    private standardMediaBytes = 0;

    constructor(cfg: MuxerConfig, sink: Sink) {
        cfg = { ...cfg };
        this.fragmented = cfg.mode === 'fragmented';
        this.eagerStandard = !this.fragmented && typeof sink.patchAt === 'function';
        const snapshotAudio = (track: AudioTrackConfig): AudioTrackConfig => {
            // Uncompressed audio counts one frame per sample, timed at its sample rate; Opus is
            // timed at 48 kHz, the rate it decodes to.
            const value = {
                ...track,
                ...(isPcmCodec(track.codec) ? { mediaTimescale: undefined } : {}),
                ...(track.codec === 'opus' ? { sampleRate: OPUS_RATE } : {}),
            };
            if (value.presentationEdit) value.presentationEdit = { ...value.presentationEdit };
            return value;
        };
        const snapshotVideo = (track: VideoTrackConfig): VideoTrackConfig => {
            const value = { ...track };
            if (value.colour) value.colour = snapshotVideoColour(value.colour);
            value.fieldOrder = checkedFieldOrder(value.fieldOrder);
            if (value.spatialBoxes) value.spatialBoxes = value.spatialBoxes.slice();
            if (value.presentationEdit) value.presentationEdit = { ...value.presentationEdit };
            return value;
        };
        this.cfg = {
            ...cfg,
            ...(cfg.video ? { video: snapshotVideo(cfg.video) } : {}),
            ...(cfg.audio ? { audio: snapshotAudio(cfg.audio) } : {}),
            ...(cfg.extraVideoTracks
                ? { extraVideoTracks: cfg.extraVideoTracks.map(snapshotVideo) }
                : {}),
            ...(cfg.extraAudioTracks
                ? { extraAudioTracks: cfg.extraAudioTracks.map(snapshotAudio) }
                : {}),
            ...(cfg.videoColour ? { videoColour: snapshotVideoColour(cfg.videoColour) } : {}),
            ...(cfg.moovUserData ? { moovUserData: new Uint8Array(cfg.moovUserData) } : {}),
            ...(cfg.subtitleTracks
                ? {
                      subtitleTracks: cfg.subtitleTracks.map(track => ({
                          ...track,
                          codecConfig: track.codecConfig && new Uint8Array(track.codecConfig),
                      })),
                  }
                : {}),
        };
        cfg = this.cfg;
        for (const track of [...(cfg.audio ? [cfg.audio] : []), ...(cfg.extraAudioTracks ?? [])]) {
            checkedInteger(track.sampleRate, 'audio timescale', 1, 0xffffffff);
        }
        const configuredTracks = [
            this.cfg.video,
            this.cfg.audio,
            ...(this.cfg.extraVideoTracks ?? []),
            ...(this.cfg.extraAudioTracks ?? []),
        ].filter((track): track is VideoTrackConfig | AudioTrackConfig => track !== undefined);
        for (const track of configuredTracks) {
            validateMp4TrackMetadata(track);
            if (
                (isProResCodec(track.codec) || isProResRawCodec(track.codec)) &&
                (cfg.format !== 'mov' || this.fragmented)
            ) {
                throw new MediaForgeError(
                    'ProRes packet copy requires standard MOV output',
                    'FORMAT',
                );
            }
            if (track?.mediaTimescale !== undefined) {
                checkedInteger(track.mediaTimescale, 'copy media timescale', 1, 0xffffffff);
                if (!hasCopyPresentation(track))
                    throw new MediaForgeError(
                        'MP4 mediaTimescale requires an authoritative copy edit',
                        'MUX',
                    );
            }
            if (track.presentationEdit) validatePresentationEdit(track.presentationEdit);
        }
        const configuredMovieTimescale = chooseMovieTimescale(
            configuredTracks.map(
                track =>
                    track.mediaTimescale ?? (track.type === 'audio' ? track.sampleRate : 90000),
            ),
            editMovieTimescales(configuredTracks),
        );
        for (const track of configuredTracks) {
            if (!hasCopyPresentation(track)) continue;
            const mediaTimescale =
                track.mediaTimescale ?? (track.type === 'audio' ? track.sampleRate : 90000);
            const edit = track.presentationEdit;
            if (edit && !this.fragmented) {
                rescaleEditUnits(
                    edit.mediaTimeUnits,
                    edit.mediaTimescale,
                    mediaTimescale,
                    'copy edit media time',
                );
                rescaleEditUnits(
                    edit.leadMovieUnits + editMovieDuration(edit),
                    edit.movieTimescale,
                    configuredMovieTimescale,
                    'copy presentation end',
                );
                continue;
            }
            const {
                presentationStartSeconds,
                presentationDurationSeconds,
                presentationMediaTimeSeconds,
            } = track;
            if (
                this.fragmented ||
                !Number.isFinite(presentationStartSeconds) ||
                presentationStartSeconds! < 0 ||
                !Number.isFinite(presentationDurationSeconds) ||
                presentationDurationSeconds! <= 0 ||
                !Number.isFinite(presentationMediaTimeSeconds) ||
                presentationMediaTimeSeconds! < 0
            ) {
                throw new MediaForgeError(
                    'MP4 copy edits need standard mode, times from zero and a duration',
                    'MUX',
                );
            }
            secondsToTicks(
                presentationMediaTimeSeconds!,
                mediaTimescale,
                'MP4 copy edit media time',
                {
                    min: 0,
                },
            );
            secondsToTicks(
                presentationStartSeconds!,
                configuredMovieTimescale,
                'MP4 copy presentation start',
                { min: 0 },
            );
            secondsToTicks(
                presentationDurationSeconds!,
                configuredMovieTimescale,
                'MP4 copy presentation duration',
                { min: 1 },
            );
            secondsToTicks(
                presentationStartSeconds! + presentationDurationSeconds!,
                configuredMovieTimescale,
                'MP4 copy presentation end',
                { min: 0 },
            );
        }
        this.sink = sink;
        if (cfg.video?.codecConfig) this.videoConfig = new Uint8Array(cfg.video.codecConfig);
        if (cfg.audio?.codecConfig) this.audioConfig = new Uint8Array(cfg.audio.codecConfig);

        // A track whose timescale is known from the start keeps its timing as runs; video timed by
        // its decode steps waits for them.
        this.videoChunks = new Mp4SampleTable(this.cfg.video?.mediaTimescale);
        this.audioChunks = new Mp4SampleTable(
            this.cfg.audio?.mediaTimescale ?? this.audioTimescale(),
        );
        for (const t of cfg.extraVideoTracks ?? []) {
            this.extraVideoChunks.push(new Mp4SampleTable(t.mediaTimescale));
            this.extraVideoConfigs.push(t.codecConfig ? new Uint8Array(t.codecConfig) : undefined);
        }
        for (const t of cfg.extraAudioTracks ?? []) {
            this.extraAudioChunks.push(new Mp4SampleTable(t.mediaTimescale ?? t.sampleRate));
            this.extraAudioConfigs.push(t.codecConfig ? new Uint8Array(t.codecConfig) : undefined);
        }
        for (const track of this.cfg.subtitleTracks ?? []) {
            if (this.fragmented || track.codec !== 'tx3g' || !track.codecConfig?.length)
                throw new MediaForgeError(
                    'MP4 text is 3GPP timed text in standard output',
                    'FORMAT',
                );
            validateMp4TrackMetadata(textTrackMetadata(track));
            this.textChunks.push(new Mp4SampleTable(TEXT_TIMESCALE));
            this.textEnds.push(0);
            this.textShown.push(false);
            this.textInstant.push(false);
        }
    }

    /**
     * Appends one encoded video chunk; `codecConfig` on the first call carries the decoder
     * configuration record.
     */
    addVideoChunk(chunk: EncodedPacket, codecCfg?: Uint8Array): void {
        checkChunk('addVideoChunk', chunk, 'video', this.finalized);
        if (!this.cfg.video)
            throw new MediaForgeError('addVideoChunk on a muxer configured without video', 'MUX');

        validateChunkTiming(chunk);
        const normalized = this.normalizeVideoChunk(
            chunk,
            this.cfg.video,
            this.videoConfig ?? (codecCfg ? new Uint8Array(codecCfg) : undefined),
        );
        chunk = normalized.chunk;
        const videoConfig = normalized.config;
        this.assertVideoDecoderConfig(this.cfg.video.codec, videoConfig, 'Video track');
        this.videoConfig = videoConfig;

        if (this.cfg.video.codecConfigChanges && codecCfg && !this.fragmented)
            this.videoChunks.describeNext(videoConfig, codecCfg);
        if (this.fragmented) {
            const dts = decodeTime(chunk);
            if (this.fragmentedVideoSeen && dts <= this.vLastDtsSec) {
                throw new MediaForgeError(
                    'Fragmented MP4 video decode timestamps must strictly increase',
                    'MUX',
                );
            }
            this.vLastDtsSec = dts;
            this.fragmentedVideoSeen = true;
            if (this.vFirstDtsSec === null) this.vFirstDtsSec = dts;
            this.vMinPtsSec = Math.min(this.vMinPtsSec, chunk.timestamp);

            const over = this.fragStartSec !== null && dts - this.fragStartSec >= 2;
            const wayOver = this.fragStartSec !== null && dts - this.fragStartSec >= 8;
            if ((chunk.isKeyframe && over) || wayOver) this.flushFragment();
            if (this.fragStartSec === null) this.fragStartSec = dts;
            this.pendingV.push({ ...chunk, data: new Uint8Array(chunk.data) });
            return;
        }

        this.storeStandardSample(this.videoChunks, chunk);
    }

    private normalizeVideoChunk(
        chunk: EncodedPacket,
        track: VideoTrackConfig,
        config?: Uint8Array,
    ): {
        chunk: EncodedPacket;
        config: Uint8Array | undefined;
    } {
        const codec = track.codec;
        if (isProResCodec(codec)) {
            const error = proResFrameError(chunk.data, track);
            if (error) throw new MediaForgeError(error, 'MUX');
        }
        if (isProResRawCodec(codec)) {
            const error = proResRawFrameError(chunk.data, track);
            if (error) throw new MediaForgeError(error, 'MUX');
        }
        const avc = codec.startsWith('avc');
        const hevc = isHevcCodec(codec);
        const vvc = isVvcCodec(codec);
        if (!avc && !hevc && !vvc) return { chunk, config };
        const lengthSize = vvc
            ? ((config && parseVvcC(config)?.lengthSize) ?? 4)
            : hevc
              ? hevcLengthSize(config)
              : ((((config?.[4] ?? 3) & 3) + 1) as 1 | 2 | 3 | 4);
        const validWalk = avc ? isValidAvccWalk : isValidHevcWalk;
        if (!validWalk(chunk.data, lengthSize) && isAnnexB(chunk.data)) {
            if (!config)
                config =
                    (vvc ? buildVvcCFromAnnexB : hevc ? buildHevcCFromAnnexB : buildAvcCFromAnnexB)(
                        chunk.data,
                    ) ?? undefined;
            chunk = { ...chunk, data: annexBToAvcc(chunk.data, lengthSize) };
        }

        // hvc1 and dvh1 entries carry parameter sets out of band only; hev1 and dvhe may keep them
        // in band.
        if (hevc && config && (codec.startsWith('hvc1') || codec.startsWith('dvh1'))) {
            const stripped = stripHevcParameterSets(chunk.data, lengthSize);
            if (stripped !== chunk.data) chunk = { ...chunk, data: stripped };
        }
        return { chunk, config };
    }

    addExtraVideoChunk(index: number, chunk: EncodedPacket, codecCfg?: Uint8Array): void {
        checkChunk('addExtraVideoChunk', chunk, 'video', this.finalized);
        if (this.cfg.mode !== 'standard') {
            throw new MediaForgeError(
                'Extra video tracks need standard, not fragmented, MP4',
                'FORMAT',
            );
        }

        const list = this.extraVideoChunks[index];
        if (!list)
            throw new MediaForgeError(
                `addExtraVideoChunk index ${index} has no configured track`,
                'MUX',
            );

        validateChunkTiming(chunk);
        if (codecCfg && !this.extraVideoConfigs[index])
            this.extraVideoConfigs[index] = new Uint8Array(codecCfg);
        const normalized = this.normalizeVideoChunk(
            chunk,
            this.cfg.extraVideoTracks![index]!,
            this.extraVideoConfigs[index],
        );
        chunk = normalized.chunk;
        this.extraVideoConfigs[index] = normalized.config;
        this.assertVideoDecoderConfig(
            this.cfg.extraVideoTracks![index]!.codec,
            this.extraVideoConfigs[index],
            `Extra video track ${index}`,
        );

        if (this.cfg.extraVideoTracks![index]!.codecConfigChanges && codecCfg)
            list.describeNext(this.extraVideoConfigs[index], codecCfg);
        this.storeStandardSample(list, chunk);
    }

    /**
     * Appends a 3GPP timed-text sample (a cue) to the text track at `trackIndex`. A sample lasts
     * until the next one, so the time since the previous cue ended (or since zero) becomes an empty
     * sample, as ffmpeg writes it, and a cue that starts before the previous one ends cuts it
     * short.
     */
    addSubtitleChunk(chunk: EncodedPacket, trackIndex = 0): void {
        assertOpen(this.finalized);
        const list = this.textChunks[trackIndex];
        if (!list)
            throw new MediaForgeError(
                `addSubtitleChunk index ${trackIndex} has no configured track`,
                'MUX',
            );
        validateChunkTiming(chunk);
        const end = this.textEnds[trackIndex]!;
        const sample = { ...chunk, decodeTimestamp: undefined, compositionTimeOffset: undefined };
        if (Math.round((chunk.timestamp - end) * TEXT_TIMESCALE) > 0)
            this.storeStandardSample(list, {
                trackType: 'subtitle',
                data: EMPTY_TEXT_SAMPLE,
                timestamp: end,
                duration: chunk.timestamp - end,
                isKeyframe: true,
            });

        this.storeStandardSample(list, { ...sample, isKeyframe: true });
        this.textEnds[trackIndex] = chunk.timestamp + Math.max(0, chunk.duration ?? 0);
        this.textShown[trackIndex] =
            chunk.data.length >= 2 && (chunk.data[0]! | chunk.data[1]!) > 0;
        this.textInstant[trackIndex] = !this.textShown[trackIndex] && chunk.duration === 0;
    }

    /** Appends a chunk to the extra (copied) audio track at `index`. */
    addExtraAudioChunk(index: number, chunk: EncodedPacket, codecCfg?: Uint8Array): void {
        checkChunk('addExtraAudioChunk', chunk, 'audio', this.finalized);
        if (this.cfg.mode !== 'standard') {
            throw new MediaForgeError(
                'Extra audio tracks need standard, not fragmented, MP4',
                'FORMAT',
            );
        }

        const list = this.extraAudioChunks[index];
        if (!list)
            throw new MediaForgeError(
                `addExtraAudioChunk index ${index} has no configured track`,
                'MUX',
            );

        validateChunkTiming(chunk);
        if (codecCfg && !this.extraAudioConfigs[index])
            this.extraAudioConfigs[index] = new Uint8Array(codecCfg);
        if (
            (this.cfg.extraAudioTracks?.[index]?.codec ?? '').startsWith('mp4a') &&
            !this.extraAudioConfigs[index]
        ) {
            throw new MediaForgeError(
                `Extra AAC track ${index} requires an ASC before its first chunk`,
                'FORMAT',
            );
        }

        if (this.cfg.extraAudioTracks![index]!.codecConfigChanges && codecCfg)
            list.describeNext(this.extraAudioConfigs[index], codecCfg);
        this.storeStandardSample(list, chunk);
    }

    /**
     * Appends one encoded audio chunk; `codecConfig` on the first call carries decoder
     * configuration where the container stores it.
     */
    addAudioChunk(chunk: EncodedPacket, codecCfg?: Uint8Array): void {
        checkChunk('addAudioChunk', chunk, 'audio', this.finalized);
        if (!this.cfg.audio)
            throw new MediaForgeError('addAudioChunk on a muxer configured without audio', 'MUX');
        validateChunkTiming(chunk);
        if (codecCfg && !this.audioConfig) this.audioConfig = new Uint8Array(codecCfg);

        // AC-3 from Matroska, MPEG-TS or AVI has no dac3; the first syncframe describes the stream.
        if (this.cfg.audio.codec === 'ac-3' && !this.audioConfig && !this.fragmented) {
            if (parseDolbyFrameHeader(chunk.data, 0)?.codec !== 'ac-3')
                throw new MediaForgeError(
                    'AC-3 output without a dac3 record needs an AC-3 syncframe first',
                    'MUX',
                );
            this.audioConfig = ac3SpecificBox(chunk.data, 0);
        }
        if (this.cfg.audio.codec.startsWith('mp4a') && !this.audioConfig) {
            throw new MediaForgeError(
                'AAC output requires an ASC before its first chunk',
                'FORMAT',
            );
        }
        if (this.fragmented) {
            const dts = decodeTime(chunk);
            if (chunk.timestamp < 0 && dts >= 0) {
                throw new MediaForgeError(
                    'Fragmented MP4 cannot present audio before its decode time',
                    'MUX',
                );
            }
            if (this.fragmentedAudioSeen && dts <= this.aLastDtsSec) {
                throw new MediaForgeError(
                    'Fragmented MP4 audio decode timestamps must strictly increase',
                    'MUX',
                );
            }
            const durationUnits = Math.max(
                1,
                secondsToTicks(
                    Math.max(0, chunk.duration ?? 0),
                    this.audioTimescale(),
                    'MP4 fragmented audio sample duration',
                    { max: 0xffffffff },
                ),
            );
            const nextDuration = this.fragmentedAudioDurationUnits + durationUnits;
            if (!Number.isSafeInteger(nextDuration)) {
                throw new MediaForgeError(
                    'Fragmented MP4 audio duration exceeds the exact-integer range',
                    'MUX',
                );
            }
            this.aLastDtsSec = dts;
            this.fragmentedAudioSeen = true;
            this.fragmentedAudioDurationUnits = nextDuration;
            this.fragmentedAudioPacketCount++;
            if (this.aFirstDtsSec === null) this.aFirstDtsSec = dts;
            this.aMinPtsSec = Math.min(this.aMinPtsSec, chunk.timestamp);
            if (!this.cfg.video && this.fragStartSec !== null && dts - this.fragStartSec >= 2)
                this.flushFragment();
            if (this.fragStartSec === null) this.fragStartSec = dts;
            this.pendingA.push({ ...chunk, data: new Uint8Array(chunk.data) });
            return;
        }
        if (this.cfg.audio.codecConfigChanges && codecCfg)
            this.audioChunks.describeNext(this.audioConfig, codecCfg);
        this.storeStandardSample(this.audioChunks, chunk);
    }

    private storeStandardSample(list: Mp4SampleTable, chunk: EncodedPacket): void {
        checkedInteger(list.length + 1, 'sample count', 1, 0xffffffff);
        checkedInteger(chunk.data.byteLength, 'sample byte length', 0, 0xffffffff);
        if (!this.eagerStandard) {
            list.add(chunk, 0, true);
            return;
        }

        this.ensureEagerStandardHeader();
        const nextBytes = this.standardMediaBytes + chunk.data.byteLength;
        if (
            !Number.isSafeInteger(nextBytes) ||
            !Number.isSafeInteger(this.standardPayloadOffset + nextBytes)
        ) {
            throw new MediaForgeError(
                'MP4 media byte count exceeds JavaScript exact-integer range',
                'MUX',
            );
        }
        const offset = this.standardPayloadOffset + this.standardMediaBytes;
        if (!Number.isSafeInteger(offset)) {
            throw new MediaForgeError(
                'MP4 sample offset exceeds JavaScript exact-integer range',
                'MUX',
            );
        }

        list.add(chunk, offset, false);
        try {
            this.sink.write(chunk.data);
        } catch (error) {
            list.removeLast();
            throw error;
        }
        this.standardMediaBytes = nextBytes;
    }

    private ensureEagerStandardHeader(): void {
        if (this.standardHeaderWritten) return;
        const ftyp = this.buildFtyp();
        this.standardMdatHeaderOffset = ftyp.length;
        this.standardPayloadOffset = ftyp.length + 16;
        const header = new Uint8Array(16);
        const dv = new DataView(header.buffer);
        dv.setUint32(0, 1, false);
        header.set(latin1('mdat'), 4);
        dv.setBigUint64(8, 16n, false);
        this.sink.write(ftyp);
        this.sink.write(header);
        this.standardHeaderWritten = true;
    }

    private finalized = false;
    /**
     * The audio's priming and, once the encoder states it, the length of the sound after it
     * (undefined until then: a fragmented init hides the priming and presents to the end).
     */
    private audioPriming: {
        primeSamples: number;
        validSamples: number | undefined;
        presentationTimestamps: boolean;
    } | null = null;

    setAudioPriming(
        primeSamples: number,
        validSamples: number | undefined,
        presentationTimestamps = false,
        _discardLeadingSamples = true,
        codecDelaySamples = 0,
    ): void {
        assertOpen(this.finalized);
        if (!this.cfg.audio) {
            throw new MediaForgeError('setAudioPriming on a muxer configured without audio', 'MUX');
        }

        // Sound of unknown length states its priming first and its length when it ends. The edit
        // list hides the priming from the start; a fragmented MP4, whose init is written before
        // the end, presents the sound to the end of its media then.
        const prime = Math.round(primeSamples);
        const valid = validSamples === undefined ? undefined : Math.round(validSamples);
        const codecDelay = Math.round(codecDelaySamples);
        if (
            !Number.isFinite(primeSamples) ||
            primeSamples < 0 ||
            !Number.isSafeInteger(prime) ||
            (valid !== undefined &&
                (!Number.isFinite(validSamples) ||
                    validSamples! <= 0 ||
                    !Number.isSafeInteger(valid) ||
                    valid < 1 ||
                    !Number.isSafeInteger(prime + valid))) ||
            !Number.isFinite(codecDelaySamples) ||
            codecDelaySamples < 0 ||
            !Number.isSafeInteger(codecDelay)
        ) {
            throw new MediaForgeError('Audio priming, length or codec delay is invalid', 'INPUT');
        }
        // Without priming, a length to come leaves nothing to hide yet.
        if (valid === undefined && prime === 0) return;

        const current = this.audioPriming;
        const same =
            current?.primeSamples === prime &&
            current.presentationTimestamps === presentationTimestamps;
        if (same && current.validSamples === valid) return;
        const started = this.fragmented && (this.fragmentedAudioSeen || this.initWritten);
        // The init's edit is written: a length stated after it leaves the edit as it is.
        if (same && started && current.validSamples === undefined) return;
        if (started) {
            throw new MediaForgeError(
                'Set fragmented MP4 audio priming before the first audio chunk',
                'MUX',
            );
        }

        this.audioPriming = {
            primeSamples: prime,
            validSamples: valid,
            presentationTimestamps,
        };
    }

    /**
     * Supplies the audio decoder configuration (e.g. AAC AudioSpecificConfig) before finalize().
     */
    setAudioCodecConfig(codecConfig: Uint8Array): void {
        this.audioConfig = new Uint8Array(codecConfig);
    }

    setVideoColour(colour: VideoColour): void {
        if (this.fragmentedVideoSeen || this.videoChunks.length)
            throw new MediaForgeError(
                'video colour must be set before the first MP4 video chunk',
                'MUX',
            );
        const value = snapshotVideoColour(colour)!;
        this.cfg.videoColour = value;
        if (this.cfg.video) this.cfg.video.colour = value;
    }

    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    async finalize(): Promise<void> {
        assertOpen(this.finalized);
        this.finalized = true;
        if (this.fragmented) {
            if (this.cfg.video && !this.fragmentedVideoSeen) {
                throw unfedTrack('video');
            }
            if (this.cfg.audio && !this.fragmentedAudioSeen) {
                throw unfedTrack('audio');
            }
            if (this.cfg.video) {
                this.assertVideoDecoderConfig(
                    this.cfg.video.codec,
                    this.videoConfig,
                    'Video track',
                );
            }

            this.validateFragmentedAudioPresentationWindow();
            this.flushFragment();
            const init = this.flacInit;
            const record = this.audioConfig && flacStreamInfoRecord(this.audioConfig);
            if (init && record && this.sink.patchAt && !sameBytes(record, init.record))
                this.sink.patchAt(init.at, record);
            await (this.sink as { close?: () => Promise<void> | void }).close?.();
            return;
        }

        if (this.cfg.video && this.videoChunks.length === 0) {
            throw unfedTrack('video');
        }
        if (this.cfg.audio && this.audioChunks.length === 0) {
            throw unfedTrack('audio');
        }
        if (this.cfg.video)
            this.assertVideoDecoderConfig(this.cfg.video.codec, this.videoConfig, 'Video track');
        if (this.cfg.audio?.codec.startsWith('mp4a') && !this.audioConfig) {
            throw new MediaForgeError(
                'AAC output needs its codec config (ASC) before finalize',
                'FORMAT',
            );
        }
        for (let index = 0; index < this.extraVideoChunks.length; index++) {
            const codec = this.cfg.extraVideoTracks?.[index]?.codec ?? '';
            if (this.extraVideoChunks[index]!.length > 0) {
                this.assertVideoDecoderConfig(
                    codec,
                    this.extraVideoConfigs[index],
                    `Extra video track ${index}`,
                );
            }
        }
        for (let index = 0; index < this.extraAudioChunks.length; index++) {
            const codec = this.cfg.extraAudioTracks?.[index]?.codec ?? '';
            if (
                this.extraAudioChunks[index]!.length > 0 &&
                codec.startsWith('mp4a') &&
                !this.extraAudioConfigs[index]
            ) {
                throw new MediaForgeError(
                    `Extra AAC track ${index} needs its codec config (ASC)`,
                    'FORMAT',
                );
            }
        }

        // An empty sample of no duration ends the last cue, which players otherwise show to the end
        // of the movie.
        this.textChunks.forEach((list, index) => {
            if (!this.textShown[index]) return;
            this.storeStandardSample(list, {
                trackType: 'subtitle',
                data: EMPTY_TEXT_SAMPLE,
                timestamp: this.textEnds[index]!,
                duration: 0,
                isKeyframe: true,
            });
            this.textInstant[index] = true;
        });
        if (this.eagerStandard) this.writeEagerStandard();
        else this.writeStandard();
        await this.sink.close();

        for (const samples of [
            this.videoChunks,
            this.audioChunks,
            ...this.extraVideoChunks,
            ...this.extraAudioChunks,
            ...this.textChunks,
        ]) {
            samples.clear();
        }
    }

    private assertVideoDecoderConfig(
        codec: string,
        config: Uint8Array | undefined,
        label: string,
    ): void {
        const boxType = codec.startsWith('avc')
            ? 'avcC'
            : isHevcCodec(codec)
              ? 'hvcC'
              : isVvcCodec(codec)
                ? 'vvcC'
                : codec.startsWith('av01')
                  ? 'av1C'
                  : null;
        if (boxType && (!config || config.length === 0)) {
            throw new MediaForgeError(
                `${label} codec '${codec}' requires a ${boxType} decoder configuration`,
                'FORMAT',
            );
        }
    }

    private writeEagerStandard(): void {
        if (!this.standardHeaderWritten || !this.sink.patchAt) {
            throw new MediaForgeError(
                'Seekable standard MP4 has no media header to finalize',
                'MUX',
            );
        }
        const hasV = !!this.cfg.video && this.videoChunks.length > 0;
        const hasA = !!this.cfg.audio && this.audioChunks.length > 0;
        const MAX_U32 = 0xffffffff;
        this.use64BitOffsets =
            this.standardMediaBytes + 16 > MAX_U32 ||
            this.standardPayloadOffset + this.standardMediaBytes > MAX_U32;

        const moov = this.buildMoov(hasV, hasA, 0);

        const sizePatch = new Uint8Array(8);
        new DataView(sizePatch.buffer).setBigUint64(
            0,
            BigInt(this.standardMediaBytes) + 16n,
            false,
        );
        this.sink.patchAt(this.standardMdatHeaderOffset + 8, sizePatch);
        this.sink.write(handOffOutput(serializeBox(moov)));
    }

    private writeStandard(): void {
        const hasV = !!this.cfg.video && this.videoChunks.length > 0;
        const hasA = !!this.cfg.audio && this.audioChunks.length > 0;

        const ftyp = this.buildFtyp();
        let dataLen = 0;
        const tracks = [
            this.videoChunks,
            this.audioChunks,
            ...this.extraVideoChunks,
            ...this.extraAudioChunks,
            ...this.textChunks,
        ];
        for (const list of tracks) {
            for (let i = 0; i < list.length; i++) {
                list.setOffset(i, dataLen);
                dataLen = this.checkedStandardByteCount(dataLen, list.byteLength(i));
            }
        }

        const MAX_U32 = 0xffffffff;
        const needsLargeMdat = dataLen + 8 > MAX_U32;
        const mdatHeaderLen = needsLargeMdat ? 16 : 8;
        let moov = this.buildMoov(hasV, hasA, 0);
        let base = ftyp.length + partSize(moov) + mdatHeaderLen;
        this.use64BitOffsets = needsLargeMdat || base + dataLen > MAX_U32;
        moov = this.buildMoov(hasV, hasA, 0);
        base = ftyp.length + partSize(moov) + mdatHeaderLen;
        moov = this.buildMoov(hasV, hasA, base);

        this.sink.write(ftyp);
        this.sink.write(handOffOutput(serializeBox(moov)));

        const mdatHeader = new Uint8Array(mdatHeaderLen);
        const dv = new DataView(mdatHeader.buffer);
        if (needsLargeMdat) {
            dv.setUint32(0, 1, false);
            mdatHeader.set(latin1('mdat'), 4);
            const total = BigInt(dataLen) + 16n;
            dv.setBigUint64(8, total, false);
        } else {
            dv.setUint32(0, dataLen + 8, false);
            mdatHeader.set(latin1('mdat'), 4);
        }
        this.sink.write(mdatHeader);

        for (const list of tracks) {
            for (let i = 0; i < list.length; i++) {
                const data = list.data(i);
                if (!data)
                    throw new MediaForgeError(
                        'Non-seekable standard MP4 lost a buffered sample payload',
                        'MUX',
                    );
                this.sink.write(handOffOutput(data));
            }
        }
    }

    private checkedStandardByteCount(current: number, addition: number): number {
        const next = current + addition;
        if (!Number.isSafeInteger(next)) {
            throw new MediaForgeError(
                'MP4 media byte count exceeds JavaScript exact-integer range',
                'MUX',
            );
        }
        return next;
    }

    private writeInitSegmentOnce(): void {
        if (this.initWritten) return;
        const hasV = !!this.cfg.video;
        const hasA = !!this.cfg.audio;
        if (hasV && this.isH264() && !this.videoConfig) {
            throw new MediaForgeError(
                'Fragmented MP4 needs the H.264 codec config (avcC) before the first flush',
                'FORMAT',
            );
        }
        if (hasA && (this.cfg.audio?.codec ?? '').startsWith('mp4a') && !this.audioConfig) {
            throw new MediaForgeError(
                'Fragmented MP4 needs the AAC codec config (ASC) before the first flush',
                'FORMAT',
            );
        }

        this.videoPresentationStartSec = this.fragmentPresentationStart(true);
        this.audioPresentationStartSec = this.fragmentPresentationStart(false);
        this.videoTimelineRebaseSec = this.fragmentTimelineRebase(
            this.vFirstDtsSec,
            this.videoPresentationStartSec,
            0,
            'video',
        );
        const audioExtraPrime =
            this.audioPriming && !this.audioPriming.presentationTimestamps
                ? this.audioPriming.primeSamples / this.audioTimescale()
                : 0;
        this.audioTimelineRebaseSec = this.fragmentTimelineRebase(
            this.aFirstDtsSec,
            this.audioPresentationStartSec,
            audioExtraPrime,
            'audio',
        );

        const movieTimescale = chooseMovieTimescale([
            ...(hasV ? [this.videoTimescale()] : []),
            ...(hasA ? [this.audioTimescale()] : []),
        ]);

        const traks: Uint8Array[] = [];
        const trexes: Uint8Array[] = [];
        let id = 1;
        if (hasV) {
            traks.push(this.buildFragTrak(id, true, movieTimescale));
            trexes.push(trexBox(id));
            id++;
        }
        if (hasA) {
            traks.push(this.buildFragTrak(id, false, movieTimescale));
            trexes.push(trexBox(id));
        }

        const mvhd = this.buildMvhd(movieTimescale, 0, id + 1);
        const moov = box(
            'moov',
            mvhd,
            ...traks,
            box('mvex', ...trexes),
            mp4TitleBox(this.cfg.title, this.cfg.format === 'mov', this.cfg.tags),
            ...(this.cfg.moovUserData ? [this.cfg.moovUserData] : []),
        );

        const ftyp = this.buildFtyp();
        const flac = this.cfg.audio?.codec === 'flac' && this.audioConfig;
        const record = flac && flacStreamInfoRecord(flac);
        const recordAt = flac ? flacStreamInfoAt(moov, flac) : -1;
        if (record && recordAt >= 0)
            this.flacInit = { at: ftyp.length + recordAt, record: record.slice() };
        this.sink.write(ftyp);
        this.sink.write(moov);
        this.initWritten = true;
    }

    private fragmentPresentationStart(isVideo: boolean): number {
        const cfg = isVideo ? this.cfg.video : this.cfg.audio;
        const declared = cfg?.presentationStartSeconds;
        if (declared !== undefined) {
            if (!Number.isFinite(declared) || declared < 0) {
                throw new MediaForgeError(
                    `fragmented MP4 ${isVideo ? 'video' : 'audio'} presentation start is ` +
                        `invalid: ${declared}`,
                    'MUX',
                );
            }
            return declared;
        }
        let derived = isVideo ? this.vMinPtsSec : this.aMinPtsSec;
        if (!isVideo && Number.isFinite(derived) && this.audioPriming?.presentationTimestamps) {
            derived += this.audioPriming.primeSamples / this.audioTimescale();
        }
        return Number.isFinite(derived) ? Math.max(0, derived) : 0;
    }

    private validateFragmentedAudioPresentationWindow(): void {
        if (!this.audioPriming) return;
        let encoded = this.fragmentedAudioDurationUnits;
        if (this.cfg.audio?.codec.startsWith('mp4a')) {
            const samplesPerAccessUnit = this.audioConfig
                ? (parseAacAudioSpecificConfig(this.audioConfig)?.samplesPerAccessUnit ?? 0)
                : 0;
            if (samplesPerAccessUnit > 0) {
                const nominal = this.fragmentedAudioPacketCount * samplesPerAccessUnit;
                if (!Number.isSafeInteger(nominal)) {
                    throw new MediaForgeError(
                        'Fragmented MP4 AAC sample count exceeds the exact-integer range',
                        'MUX',
                    );
                }
                encoded = Math.max(encoded, nominal);
            }
        }

        const required = this.audioPriming.primeSamples + (this.audioPriming.validSamples ?? 0);
        if (required > encoded) {
            throw new MediaForgeError(
                'Fragmented MP4 audio edit is longer than its encoded samples',
                'MUX',
            );
        }
    }

    private fragmentTimelineRebase(
        firstDts: number | null,
        presentationStart: number,
        extraPrimeSeconds: number,
        label: string,
    ): number {
        if (firstDts === null) return 0;
        const rebase = Math.max(-firstDts, -(presentationStart + extraPrimeSeconds));
        if (!Number.isFinite(rebase)) {
            throw new MediaForgeError(
                `fragmented MP4 ${label} timeline rebase is non-finite`,
                'MUX',
            );
        }
        return rebase;
    }

    private isH264(): boolean {
        const c = this.cfg.video?.codec ?? '';
        return c.startsWith('avc1') || c.startsWith('avc3');
    }

    private buildFragTrak(id: number, isVideo: boolean, movieTimescale: number): Uint8Array {
        const timescale = isVideo ? this.videoTimescale() : this.audioTimescale();
        const track = isVideo ? this.cfg.video : this.cfg.audio;
        const presentationStart = isVideo
            ? this.videoPresentationStartSec
            : this.audioPresentationStartSec;
        const rebase = isVideo ? this.videoTimelineRebaseSec : this.audioTimelineRebaseSec;
        const extraPrimeSeconds =
            !isVideo && this.audioPriming && !this.audioPriming.presentationTimestamps
                ? this.audioPriming.primeSamples / timescale
                : 0;
        // Sound whose length is not known yet is presented to the end of its media.
        const validSamples = this.audioPriming?.validSamples;
        const declaredDuration =
            !isVideo && this.audioPriming
                ? validSamples === undefined
                    ? undefined
                    : validSamples / timescale
                : track?.presentationDurationSeconds;

        if (
            declaredDuration !== undefined &&
            (!Number.isFinite(declaredDuration) || declaredDuration <= 0)
        ) {
            throw new MediaForgeError(
                `fragmented MP4 ${isVideo ? 'video' : 'audio'} presentation duration is invalid: ` +
                    `${declaredDuration}`,
                'MUX',
            );
        }

        const edit = `Fragmented MP4 ${isVideo ? 'video' : 'audio'} edit`;
        const leadMovieUnits = secondsToTicks(presentationStart, movieTimescale, edit, { min: 0 });
        const presentationDuration =
            declaredDuration === undefined
                ? 0
                : Math.max(1, secondsToTicks(declaredDuration, movieTimescale, edit, { min: 0 }));
        const mediaTimeUnits = secondsToTicks(
            rebase + presentationStart + extraPrimeSeconds,
            timescale,
            edit,
            { min: 0 },
        );
        if (!Number.isSafeInteger(leadMovieUnits + presentationDuration))
            throw new MediaForgeError(`${edit} exceeds the exact timeline range`, 'MUX');

        const minf = box(
            'minf',
            mediaHeaderBox(isVideo ? 'video' : 'audio'),
            dinfBox(),
            fragmentedSampleTable(this.buildStsd(isVideo)),
        );
        const mdia = box(
            'mdia',
            this.buildMdhd(timescale, 0, isVideo),
            this.language(isVideo).elng,
            this.buildHdlr(isVideo),
            minf,
        );

        const parts: Uint8Array[] = [
            this.buildTkhd(id, isVideo, leadMovieUnits + presentationDuration),
        ];
        if (
            leadMovieUnits > 0 ||
            mediaTimeUnits > 0 ||
            declaredDuration !== undefined ||
            (!isVideo && this.audioPriming)
        ) {
            parts.push(
                this.buildEdts(leadMovieUnits, [
                    { duration: presentationDuration, mediaTime: mediaTimeUnits },
                ]),
            );
        }

        parts.push(mdia);
        parts.push(
            ...mp4TrackMetadataBoxes(
                isVideo ? this.cfg.video : this.cfg.audio,
                this.cfg.format === 'mov',
            ),
        );
        return box('trak', ...parts);
    }

    private fragmentDecodeBase(
        firstDts: number,
        rebase: number,
        timescale: number,
        label: string,
    ): number {
        return secondsToTicks(firstDts + rebase, timescale, `Fragmented MP4 ${label} decode time`, {
            min: 0,
        });
    }

    private flushFragment(): void {
        if (this.pendingV.length === 0 && this.pendingA.length === 0) {
            this.fragStartSec = null;
            return;
        }
        this.writeInitSegmentOnce();
        interface TrafPlan {
            id: number;
            timescale: number;
            base: number;
            chunks: EncodedPacket[];
            payloadBytes: number;
            /** Whether sample flags mark keyframes: video, and audio with keyframes. */
            keyed: boolean;
        }
        const plans: TrafPlan[] = [];
        let id = 1;
        if (this.cfg.video) {
            if (this.pendingV.length > 0) {
                const first = this.pendingV[0]!;
                const firstDts = decodeTime(first);
                const timescale = this.videoTimescale();
                plans.push({
                    id,
                    timescale,
                    base: this.fragmentDecodeBase(
                        firstDts,
                        this.videoTimelineRebaseSec,
                        timescale,
                        'video',
                    ),
                    chunks: this.pendingV,
                    payloadBytes: this.pendingV.reduce((n, c) => n + c.data.byteLength, 0),
                    keyed: true,
                });
            }
            id++;
        }
        if (this.cfg.audio && this.pendingA.length > 0) {
            const first = this.pendingA[0]!;
            const firstDts = decodeTime(first);
            const timescale = this.audioTimescale();
            plans.push({
                id,
                timescale,
                base: this.fragmentDecodeBase(
                    firstDts,
                    this.audioTimelineRebaseSec,
                    timescale,
                    'audio',
                ),
                chunks: this.pendingA,
                payloadBytes: this.pendingA.reduce((n, c) => n + c.data.byteLength, 0),
                keyed: audioHasKeyframes((this.activeAudioCfg ?? this.cfg.audio).codec),
            });
        }

        const buildTrun = (plan: TrafPlan, dataOffset: number): Uint8Array => {
            const n = plan.chunks.length;
            const p = new Uint8Array(8 + n * 16);
            const dv = new DataView(p.buffer);
            dv.setUint32(0, n, false);
            dv.setInt32(
                4,
                checkedInteger(dataOffset, 'trun data offset', -0x80000000, 0x7fffffff),
                false,
            );

            const compositionOffsets = plan.chunks.map(c =>
                secondsToTicks(
                    c.compositionTimeOffset ?? c.timestamp - decodeTime(c),
                    plan.timescale,
                    'MP4 trun composition offset',
                    { min: -0x80000000, max: 0xffffffff },
                ),
            );

            const signed = compositionOffsets.some(value => value < 0);
            const version = !signed && compositionOffsets.some(value => value > 0x7fffffff) ? 0 : 1;

            let decodeEnd = plan.base;
            let pos = 8;
            for (let i = 0; i < n; i++) {
                const c = plan.chunks[i]!;
                const dts = decodeTime(c);
                const next = plan.chunks[i + 1];
                const nextDts = next ? decodeTime(next) : dts + (c.duration || 0);
                const sampleDuration = (seconds: number): number =>
                    secondsToTicks(seconds, plan.timescale, 'MP4 trun sample duration', {
                        max: 0xffffffff,
                    });
                let durUnits = sampleDuration(Math.max(0, nextDts - dts));
                if (durUnits <= 0)
                    durUnits = Math.max(1, sampleDuration(c.duration || 1 / plan.timescale));

                const flags = !plan.keyed || c.isKeyframe ? 0x02000000 : 0x01010000;
                const cts = checkedInteger(
                    compositionOffsets[i]!,
                    'trun composition offset',
                    version === 1 ? -0x80000000 : 0,
                    version === 1 ? 0x7fffffff : 0xffffffff,
                );

                decodeEnd = checkedInteger(decodeEnd + durUnits, 'fragment decode end');
                checkedInteger(
                    decodeEnd + cts,
                    'fragment presentation end',
                    -Number.MAX_SAFE_INTEGER,
                );

                dv.setUint32(pos, durUnits, false);
                dv.setUint32(pos + 4, c.data.byteLength, false);
                dv.setUint32(pos + 8, flags, false);
                if (version === 1) dv.setInt32(pos + 12, cts, false);
                else dv.setUint32(pos + 12, cts, false);
                pos += 16;
            }
            return fullBox('trun', version, 0x000f01, p);
        };
        const buildTraf = (plan: TrafPlan, dataOffset: number): Uint8Array => {
            const tfhdPayload = new Uint8Array(4);
            new DataView(tfhdPayload.buffer).setUint32(0, plan.id, false);
            const tfdtPayload = new Uint8Array(8);
            const dv = new DataView(tfdtPayload.buffer);
            dv.setUint32(0, Math.floor(plan.base / 0x100000000), false);
            dv.setUint32(4, plan.base >>> 0, false);
            return box(
                'traf',
                fullBox('tfhd', 0, 0x020000, tfhdPayload),
                fullBox('tfdt', 1, 0, tfdtPayload),
                buildTrun(plan, dataOffset),
            );
        };

        const probe = box('moof', this.buildMfhd(this.moofSeq), ...plans.map(p => buildTraf(p, 0)));
        let running = probe.length + 8;
        const offsets = plans.map(p => {
            const off = running;
            running += p.payloadBytes;
            return off;
        });
        const moof = box(
            'moof',
            this.buildMfhd(this.moofSeq),
            ...plans.map((p, i) => buildTraf(p, offsets[i]!)),
        );
        if (moof.length !== probe.length) {
            throw new MediaForgeError('fragmented MP4: moof sizing pass diverged', 'MUX');
        }
        const mdatPayloads: Uint8Array[] = [];
        for (const plan of plans) for (const c of plan.chunks) mdatPayloads.push(c.data);
        this.moofSeq++;
        this.sink.write(moof);
        this.sink.write(handOffOutput(box('mdat', ...mdatPayloads)));
        this.pendingV = [];
        this.pendingA = [];
        this.fragStartSec = null;
    }

    private buildMfhd(seq: number): Uint8Array {
        const p = new Uint8Array(4);
        new DataView(p.buffer).setUint32(0, seq, false);
        return fullBox('mfhd', 0, 0, p);
    }

    private buildFtyp(): Uint8Array {
        const fmt = this.cfg.format;
        let major = 'isom';
        const compatible: string[] = [];
        if (fmt === 'mov') {
            major = 'qt  ';
            compatible.push('qt  ');
        } else if (fmt === '3gp') {
            major = '3gp6';
            compatible.push('3gp6', 'isom');
        } else if (fmt === 'm4a') {
            major = 'M4A ';
            compatible.push('M4A ', 'isom', 'mp42');
        } else if (fmt === 'm4v') {
            // Apple's video brand, as iTunes and ffmpeg's ipod muxer write it: it reads as M4V.
            major = 'M4V ';
            compatible.push('M4V ', 'mp42', 'isom');
        } else {
            major = 'isom';
            compatible.push('isom', 'iso2', 'mp41');
        }
        const videoCodecs = [
            ...(this.cfg.video ? [this.cfg.video.codec] : []),
            ...(this.cfg.extraVideoTracks ?? []).map(track => track.codec),
        ];
        if (videoCodecs.some(codec => isHevcCodec(codec))) compatible.push('iso8');
        if (videoCodecs.some(codec => codec.startsWith('av01'))) compatible.push('av01');

        const brands = [latin1(major), uint32(0x200), ...compatible.map(latin1)];
        let total = 8;
        for (const brand of brands) total += brand.length;
        const out = new Uint8Array(total);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, total, false);
        out.set(latin1('ftyp'), 4);
        let pos = 8;
        for (const brand of brands) {
            out.set(brand, pos);
            pos += brand.length;
        }
        return out;
    }

    private buildMoov(hasV: boolean, hasA: boolean, base: number): BoxPart {
        const videoTimescale = this.cfg.video?.mediaTimescale ?? this.videoTimescale();
        const audioTimescale = this.cfg.audio?.mediaTimescale ?? this.audioTimescale();
        const extraVideoTimescales = (this.cfg.extraVideoTracks ?? []).map(
            (track, index) =>
                track.mediaTimescale ?? this.videoTimescale(this.extraVideoChunks[index]!),
        );
        const extraAudioTimescales = (this.cfg.extraAudioTracks ?? []).map(
            track => track.mediaTimescale ?? track.sampleRate,
        );
        const movieTimescale = chooseMovieTimescale(
            [
                ...(hasV ? [videoTimescale] : []),
                ...(hasA ? [audioTimescale] : []),
                ...extraVideoTimescales,
                ...extraAudioTimescales,
            ],
            editMovieTimescales([
                hasV ? this.cfg.video : undefined,
                hasA ? this.cfg.audio : undefined,
                ...(this.cfg.extraVideoTracks ?? []),
                ...(this.cfg.extraAudioTracks ?? []),
            ]),
        );
        const videoTiming = hasV
            ? copyPresentationTiming(
                  this.videoChunks.timing(videoTimescale),
                  videoTimescale,
                  this.cfg.video,
              )
            : null;
        let audioTiming = hasA ? this.audioChunks.timing(audioTimescale) : null;
        if (
            audioTiming &&
            !hasCopyPresentation(this.cfg.audio) &&
            this.cfg.audio?.codec.startsWith('mp4a')
        ) {
            audioTiming = normalizeAacCodedDuration(
                audioTiming,
                audioTimescale,
                this.audioChunks.length,
                this.audioConfig,
            );
        }
        if (audioTiming && this.audioPriming && !hasCopyPresentation(this.cfg.audio)) {
            // A length never stated is the sound after the priming to the end of the media.
            this.audioPriming.validSamples ??= Math.max(
                1,
                audioTiming.durationUnits - this.audioPriming.primeSamples,
            );
            audioTiming = applyAudioPresentationWindow(
                audioTiming,
                audioTimescale,
                this.audioPriming.primeSamples,
                this.audioPriming.validSamples,
                this.audioPriming.presentationTimestamps,
                'Primary audio',
            );
        }
        if (audioTiming)
            audioTiming = copyPresentationTiming(audioTiming, audioTimescale, this.cfg.audio);
        if (audioTiming && !this.audioPriming && !hasCopyPresentation(this.cfg.audio))
            audioTiming = audioOnDecodeClock(audioTiming, audioTimescale);
        const videoMovieDuration = videoTiming
            ? presentationMovieDuration(this.cfg.video, videoTiming, videoTimescale, movieTimescale)
            : 0;
        const audioMovieDuration = audioTiming
            ? presentationMovieDuration(
                  this.cfg.audio,
                  audioTiming,
                  audioTimescale,
                  movieTimescale,
                  this.audioPriming?.validSamples,
              )
            : 0;

        interface ExtraAudioPlan {
            track: AudioTrackConfig;
            chunks: Mp4SampleTable;
            ts: number;
            timing: TrackTiming;
            dur: number;
            index: number;
        }
        interface ExtraVideoPlan {
            track: VideoTrackConfig;
            chunks: Mp4SampleTable;
            ts: number;
            timing: TrackTiming;
            dur: number;
            index: number;
        }
        const extraAudioPlans: ExtraAudioPlan[] = [];
        const extraAudios = this.cfg.extraAudioTracks ?? [];
        for (let i = 0; i < extraAudios.length; i++) {
            const chunks = this.extraAudioChunks[i]!;
            if (chunks.length === 0) continue;
            const track = extraAudios[i]!;
            const ts = extraAudioTimescales[i]!;
            let timing: TrackTiming = chunks.timing(ts);
            if (!hasCopyPresentation(track) && track.codec.startsWith('mp4a')) {
                timing = normalizeAacCodedDuration(
                    timing,
                    ts,
                    chunks.length,
                    this.extraAudioConfigs[i],
                );
            }
            if (track.validSamples !== undefined && !hasCopyPresentation(track)) {
                timing = applyAudioPresentationWindow(
                    timing,
                    ts,
                    track.primingSamples ?? 0,
                    track.validSamples,
                    track.presentationTimestamps === true,
                    `Extra audio track ${i}`,
                );
            }
            timing = copyPresentationTiming(timing, ts, track);
            if (track.validSamples === undefined && !hasCopyPresentation(track))
                timing = audioOnDecodeClock(timing, ts);
            const dur = presentationMovieDuration(
                track,
                timing,
                ts,
                movieTimescale,
                track.validSamples,
            );
            extraAudioPlans.push({ track, chunks, ts, timing, dur, index: i });
        }
        const extraVideoPlans: ExtraVideoPlan[] = [];
        const extraVideos = this.cfg.extraVideoTracks ?? [];
        for (let i = 0; i < extraVideos.length; i++) {
            const chunks = this.extraVideoChunks[i]!;
            if (chunks.length === 0) continue;
            const track = extraVideos[i]!;
            const ts = extraVideoTimescales[i]!;
            const timing = copyPresentationTiming(chunks.timing(ts), ts, track);
            const dur = presentationMovieDuration(track, timing, ts, movieTimescale);
            extraVideoPlans.push({ track, chunks, ts, timing, dur, index: i });
        }

        const starts: number[] = [];
        if (videoTiming) starts.push(videoTiming.startSeconds);
        if (audioTiming) starts.push(audioTiming.startSeconds);
        for (const plan of extraVideoPlans) starts.push(plan.timing.startSeconds);
        for (const plan of extraAudioPlans) starts.push(plan.timing.startSeconds);
        const preserveOrigin = [
            this.cfg.video,
            this.cfg.audio,
            ...extraVideos,
            ...extraAudios,
        ].some(hasCopyPresentation);
        const baseStart = preserveOrigin ? 0 : starts.length > 0 ? Math.min(...starts) : 0;
        const leadFor = (timing: TrackTiming): number =>
            timing.edit
                ? rescaleEditUnits(
                      timing.edit.leadMovieUnits,
                      timing.edit.movieTimescale,
                      movieTimescale,
                      'edit lead duration',
                  )
                : Math.max(
                      0,
                      secondsToTicks(
                          timing.startSeconds - baseStart,
                          movieTimescale,
                          'MP4 edit lead duration',
                      ),
                  );
        const videoLead = videoTiming ? leadFor(videoTiming) : 0;
        const audioLead = audioTiming ? leadFor(audioTiming) : 0;
        let movieDuration = Math.max(
            0,
            videoLead + videoMovieDuration,
            audioLead + audioMovieDuration,
        );
        for (const plan of extraVideoPlans) {
            movieDuration = Math.max(movieDuration, leadFor(plan.timing) + plan.dur);
        }
        for (const plan of extraAudioPlans) {
            movieDuration = Math.max(movieDuration, leadFor(plan.timing) + plan.dur);
        }

        // Text tracks start at zero; cues before the others start are skipped by an edit list.
        const textPlans = (this.cfg.subtitleTracks ?? []).flatMap((track, index) => {
            const chunks = this.textChunks[index]!;
            if (!chunks.length) return [];
            let timing = chunks.timing(TEXT_TIMESCALE);
            if (this.textInstant[index]) {
                const decodeDurations = timing.decodeDurations.clone();
                decodeDurations.replaceLast(0);
                const durationUnits = timing.durationUnits - timing.decodeDurations.lastValue;
                timing = { ...timing, decodeDurations, durationUnits };
            }
            const skip = Math.max(
                0,
                Math.round((baseStart - timing.startSeconds) * TEXT_TIMESCALE),
            );
            const shown = { ...timing, mediaTimeUnits: Math.min(skip, timing.durationUnits) };
            const dur = Math.round(
                ((timing.durationUnits - shown.mediaTimeUnits) / TEXT_TIMESCALE) * movieTimescale,
            );
            return [{ track, chunks, timing: shown, dur, lead: leadFor(timing) }];
        });
        for (const plan of textPlans) movieDuration = Math.max(movieDuration, plan.lead + plan.dur);

        const traks: BoxPart[] = [];
        if (hasV) {
            traks.push(
                this.buildTrak(
                    1,
                    true,
                    this.videoChunks,
                    base,
                    videoTimescale,
                    videoTiming!,
                    movieTimescale,
                    videoMovieDuration,
                    videoLead,
                    hasCopyPresentation(this.cfg.video),
                ),
            );
        }
        if (hasA) {
            traks.push(
                this.buildTrak(
                    hasV ? 2 : 1,
                    false,
                    this.audioChunks,
                    base,
                    audioTimescale,
                    audioTiming!,
                    movieTimescale,
                    audioMovieDuration,
                    audioLead,
                    this.audioPriming !== null || hasCopyPresentation(this.cfg.audio),
                ),
            );
        }
        for (const plan of extraVideoPlans) {
            this.activeVideoCfg = plan.track;
            this.activeVideoConfig = this.extraVideoConfigs[plan.index];
            traks.push(
                this.buildTrak(
                    traks.length + 1,
                    true,
                    plan.chunks,
                    base,
                    plan.ts,
                    plan.timing,
                    movieTimescale,
                    plan.dur,
                    leadFor(plan.timing),
                    hasCopyPresentation(plan.track),
                ),
            );
            this.activeVideoCfg = undefined;
            this.activeVideoConfig = undefined;
        }
        for (const plan of extraAudioPlans) {
            this.activeAudioCfg = plan.track;
            this.activeAudioConfig = this.extraAudioConfigs[plan.index];
            traks.push(
                this.buildTrak(
                    traks.length + 1,
                    false,
                    plan.chunks,
                    base,
                    plan.ts,
                    plan.timing,
                    movieTimescale,
                    plan.dur,
                    leadFor(plan.timing),
                    plan.track.validSamples !== undefined || hasCopyPresentation(plan.track),
                ),
            );
            this.activeAudioCfg = undefined;
            this.activeAudioConfig = undefined;
        }
        for (const plan of textPlans)
            traks.push(this.buildTextTrak(traks.length + 1, plan, base, plan.dur));
        const userData = this.cfg.moovUserData;
        return box(
            'moov',
            this.buildMvhd(movieTimescale, movieDuration, traks.length + 1),
            ...traks,
            mp4TitleBox(this.cfg.title, this.cfg.format === 'mov', this.cfg.tags),
            ...(userData ? [userData] : []),
        );
    }

    /** The movie header (mvhd), its duration checked against the field. */
    private buildMvhd(timescale: number, duration: number, nextTrackId: number): Uint8Array {
        checkedInteger(duration, 'movie duration');
        return mvhdBox(timescale, duration, nextTrackId);
    }

    private buildTrak(
        id: number,
        isVideo: boolean,
        chunks: Mp4SampleTable,
        base: number,
        trackTimescale: number,
        timing: TrackTiming,
        movieTimescale: number,
        movieDuration: number,
        leadMovieUnits: number,
        forceEditList = false,
    ): BoxPart {
        const edited = forceEditList || leadMovieUnits > 0 || timing.mediaTimeUnits > 0;
        if (edited && isVideo) timing = presentedFromEdit(timing);
        const tkhd = this.buildTkhd(id, isVideo, leadMovieUnits + movieDuration);
        const mdhd = this.buildMdhd(trackTimescale, timing.durationUnits, isVideo);
        const minf = this.buildMinf(isVideo, chunks, base, timing);
        const mdia = box('mdia', mdhd, this.language(isVideo).elng, this.buildHdlr(isVideo), minf);
        const metadata = mp4TrackMetadataBoxes(
            isVideo
                ? (this.activeVideoCfg ?? this.cfg.video)
                : (this.activeAudioCfg ?? this.cfg.audio),
            this.cfg.format === 'mov',
        );

        if (edited) {
            // The splices of a copied edit list follow its first media edit, which presents the
            // rest.
            const splices = (timing.edit?.splices ?? []).map(splice => ({
                duration: rescaleEditUnits(
                    splice.movieDuration,
                    timing.edit!.movieTimescale,
                    movieTimescale,
                    'copy splice duration',
                ),
                mediaTime: rescaleEditUnits(
                    splice.mediaTimeUnits,
                    timing.edit!.mediaTimescale,
                    trackTimescale,
                    'copy splice media time',
                ),
            }));
            const firstDuration =
                movieDuration - splices.reduce((sum, splice) => sum + splice.duration, 0);
            return box(
                'trak',
                tkhd,
                this.buildEdts(
                    leadMovieUnits,
                    [{ duration: firstDuration, mediaTime: timing.mediaTimeUnits }, ...splices],
                    timing.edit?.version,
                ),
                mdia,
                ...metadata,
            );
        }
        return box('trak', tkhd, mdia, ...metadata);
    }

    /** The trak of a text track: a 'sbtl' handler, a null media header and a 'tx3g' entry. */
    private buildTextTrak(
        id: number,
        plan: {
            readonly track: NonNullable<MuxerConfig['subtitleTracks']>[number];
            readonly chunks: Mp4SampleTable;
            readonly timing: SampleTiming;
            readonly lead: number;
        },
        base: number,
        movieDuration: number,
    ): BoxPart {
        const { track, chunks, timing, lead } = plan;
        const quickTime = this.cfg.format === 'mov';
        const language = mp4Language(track.language);
        checkedInteger(lead + movieDuration, 'track presentation duration');
        checkedInteger(timing.durationUnits, 'media duration');
        const stbl = box(
            'stbl',
            stsdBox([textSampleEntry(track.codecConfig!)]),
            this.buildStts(timing.decodeDurations, true),
            this.buildStsc(chunks),
            this.buildStsz(chunks),
            this.buildStco(chunks, base),
        );

        const mdia = box(
            'mdia',
            mdhdBox(TEXT_TIMESCALE, timing.durationUnits, language.code),
            language.elng,
            fullBox('hdlr', 0, 0, mp4HandlerPayload('sbtl', track.name, quickTime)),
            box('minf', mediaHeaderBox('subtitle'), dinfBox(), stbl),
        );

        const edits =
            lead > 0 || timing.mediaTimeUnits > 0
                ? [
                      this.buildEdts(lead, [
                          { duration: movieDuration, mediaTime: timing.mediaTimeUnits },
                      ]),
                  ]
                : [];

        const tkhd = tkhdBox(id, mp4TrackFlags(track), lead + movieDuration, false, 0, 0, 0);
        const metadata = mp4TrackMetadataBoxes(textTrackMetadata(track), quickTime);
        return box('trak', tkhd, ...edits, mdia, ...metadata);
    }

    private buildEdts(
        leadMovieUnits: number,
        edits: readonly { readonly duration: number; readonly mediaTime: number }[],
        version = 0,
    ): Uint8Array {
        checkedInteger(leadMovieUnits, 'edit lead duration');
        for (const edit of edits) {
            checkedInteger(edit.duration, 'edit presentation duration');
            checkedInteger(edit.mediaTime, 'edit media time');
        }
        return editListBox(
            [
                ...(leadMovieUnits > 0 ? [{ duration: leadMovieUnits, mediaTime: -1 }] : []),
                ...edits,
            ],
            version,
        );
    }

    private buildTkhd(id: number, isVideo: boolean, duration: number): Uint8Array {
        checkedInteger(duration, 'track presentation duration');
        const flags = mp4TrackFlags(
            isVideo
                ? (this.activeVideoCfg ?? this.cfg.video)
                : (this.activeAudioCfg ?? this.cfg.audio),
        );
        const video = isVideo ? (this.activeVideoCfg ?? this.cfg.video) : undefined;
        return tkhdBox(
            id,
            flags,
            duration,
            !isVideo,
            video?.rotation ?? 0,
            video ? fixed16_16(video.displayWidth ?? video.width) : 0,
            video ? fixed16_16(video.displayHeight ?? video.height) : 0,
        );
    }

    /** The track's language: the mdhd ISO 639-2 code and an elng box for a longer BCP 47 tag. */
    private language(isVideo: boolean): ReturnType<typeof mp4Language> {
        return mp4Language(
            isVideo
                ? (this.activeVideoCfg?.language ??
                      (this.activeVideoCfg
                          ? undefined
                          : (this.cfg.videoLanguage ?? this.cfg.video?.language)))
                : (this.activeAudioCfg?.language ??
                      (this.activeAudioCfg
                          ? undefined
                          : (this.cfg.audioLanguage ?? this.cfg.audio?.language))),
        );
    }

    private buildMdhd(timescale: number, duration: number, isVideo = false): Uint8Array {
        checkedInteger(timescale, 'media timescale', 1, 0xffffffff);
        checkedInteger(duration, 'media duration');
        return mdhdBox(timescale, duration, this.language(isVideo).code);
    }

    private buildHdlr(isVideo: boolean): Uint8Array {
        const track = isVideo
            ? (this.activeVideoCfg ?? this.cfg.video)
            : (this.activeAudioCfg ?? this.cfg.audio);
        return fullBox(
            'hdlr',
            0,
            0,
            mp4HandlerPayload(isVideo ? 'vide' : 'soun', track?.name, this.cfg.format === 'mov'),
        );
    }

    private buildMinf(
        isVideo: boolean,
        chunks: Mp4SampleTable,
        base: number,
        timing: TrackTiming,
    ): BoxPart {
        const mediaHeader = mediaHeaderBox(isVideo ? 'video' : 'audio');
        return box('minf', mediaHeader, dinfBox(), this.buildStbl(isVideo, chunks, base, timing));
    }

    private buildStbl(
        isVideo: boolean,
        chunks: Mp4SampleTable,
        base: number,
        timing: TrackTiming,
    ): BoxPart {
        const audio = isVideo ? undefined : (this.activeAudioCfg ?? this.cfg.audio);
        const pcm =
            audio && isPcmCodec(audio.codec)
                ? this.pcmFrameTables(chunks, pcmShape(audio).blockAlign)
                : null;
        const parts: BoxPart[] = [
            this.buildStsd(isVideo, chunks),
            ...(pcm ?? [
                this.buildStts(timing.decodeDurations),
                this.buildStsc(chunks),
                this.buildStsz(chunks),
            ]),
            this.buildStco(chunks, base),
        ];

        const ctts = this.buildCtts(timing.compositionOffsets);
        if (ctts) parts.push(ctts);
        if (isVideo || (audio && audioHasKeyframes(audio.codec))) {
            const stss = this.buildStss(chunks);
            if (stss) parts.push(stss);
        }

        return box('stbl', ...parts);
    }

    private buildStsd(isVideo: boolean, chunks?: Mp4SampleTable): Uint8Array {
        const build = (): Uint8Array =>
            isVideo ? this.buildVideoSampleEntry() : this.buildAudioSampleEntry();
        return stsdBox([
            build(),
            ...(chunks?.descriptionConfigs ?? []).map(config =>
                this.withEntryConfig(isVideo, config, build),
            ),
        ]);
    }

    /**
     * Builds a sample entry of the active track with `config` in place of its decoder
     * configuration.
     */
    private withEntryConfig(
        isVideo: boolean,
        config: Uint8Array,
        build: () => Uint8Array,
    ): Uint8Array {
        const key = isVideo
            ? this.activeVideoCfg
                ? 'activeVideoConfig'
                : 'videoConfig'
            : this.activeAudioCfg
              ? 'activeAudioConfig'
              : 'audioConfig';
        const saved = this[key];
        this[key] = config;
        try {
            return build();
        } finally {
            this[key] = saved;
        }
    }

    private buildVideoSampleEntry(): Uint8Array {
        const codec = (this.activeVideoCfg ?? this.cfg.video)?.codec ?? 'avc1.640028';
        const dolbyVision = (this.activeVideoCfg ?? this.cfg.video)?.dolbyVisionConfig;
        const hevcEntry = this.resolveVideoSampleEntryType(codec);
        const dolbyParsed = isHevcCodec(hevcEntry)
            ? parseDolbyVisionConfig(dolbyVision)
            : undefined;

        // A Dolby Vision base layer without cross-compatibility is labelled dvh1/dvhe; compatible
        // ones keep hvc1/hev1.
        const sampleEntryType = dolbyParsed
            ? dolbyVisionSampleEntry(
                  dolbyParsed,
                  hevcEntry === 'hvc1' || hevcEntry === 'dvh1' ? 'hvc1' : 'hev1',
              )
            : hevcEntry;
        const configBoxType = videoConfigBoxType(sampleEntryType);
        const colour = this.activeVideoCfg
            ? this.activeVideoCfg.colour
            : (this.cfg.video?.colour ?? this.cfg.videoColour);
        const storedConfig = this.activeVideoCfg ? this.activeVideoConfig : this.videoConfig;

        // VP9 keeps a vpcC record, converts a WebM feature list and builds one from the codec
        // string when the track has neither (VP Codec ISO Media File Format Binding, 2.3).
        const activeVideoConfigBytes =
            sampleEntryType === 'vp09' ? vpcCFor(codec, storedConfig, colour) : storedConfig;
        if (sampleEntryType === 'vp09' && !activeVideoConfigBytes)
            throw new MediaForgeError(`VP9 codec '${codec}' states no profile and level`, 'MUX');
        const width = (this.activeVideoCfg ?? this.cfg.video)?.width ?? 0;
        const height = (this.activeVideoCfg ?? this.cfg.video)?.height ?? 0;
        const payloads: Uint8Array[] = [];

        if ((configBoxType === 'vvcC' || configBoxType === 'apvC') && activeVideoConfigBytes)
            payloads.push(fullBox(configBoxType, 0, 0, activeVideoConfigBytes));
        else if (configBoxType && activeVideoConfigBytes)
            payloads.push(box(configBoxType, activeVideoConfigBytes));
        if (dolbyVision && dolbyParsed)
            payloads.push(box(dolbyVisionBoxType(dolbyParsed), dolbyVision));
        const spatialBoxes = (this.activeVideoCfg ?? this.cfg.video)?.spatialBoxes;
        if (spatialBoxes) payloads.push(spatialBoxes);

        // Motion JPEG is QuickTime's 'jpeg' entry in MOV, and in MP4 an 'mp4v' entry naming JPEG
        // pictures.
        const objectType =
            codec === MJPEG_VIDEO
                ? sampleEntryType === 'mp4v'
                    ? MJPEG_OBJECT_TYPE
                    : null
                : mpegVideoObjectType(codec);
        if (objectType !== null)
            payloads.push(esdsBox(objectType, 4, 0, activeVideoConfigBytes, true));
        const activeVideo = this.activeVideoCfg ?? this.cfg.video;
        payloads.push(
            ...visualSampleEntryBoxes(colour, activeVideo?.fieldOrder, this.cfg.format === 'mov'),
        );
        const parNum = activeVideo?.pixelAspectRatioNum ?? 1;
        const parDen = activeVideo?.pixelAspectRatioDen ?? 1;
        if (parNum > 0 && parDen > 0 && !(parNum === 1 && parDen === 1)) {
            payloads.push(paspBox(parNum, parDen));
        }

        return visualSampleEntry(sampleEntryType, width, height, payloads);
    }

    /**
     * The audio sample entry: AAC, or another MPEG-4 systems object type carried as stated, in
     * 'mp4a' with its esds; MPEG-1/2 Layer I-III in 'mp4a' (object type 0x6B, 0x69 below 32 kHz,
     * without decoder info); MPEG-H 3D audio with 'mhaC' and a zero channel count; AC-3/E-AC-3
     * (dac3/dec3), DTS (ddts; the entry type names the variant) and TrueHD ('mlpa' with dmlp, whose
     * rate field is a plain 32-bit integer); ALAC (its 24-byte cookie in 'alac') and QuickTime
     * G.711, whose rates above 65535 Hz leave the 16.16 rate field zero; FLAC (flacSampleEntry())
     * and Opus ('Opus' with its dOps record, at 48 kHz).
     */
    private buildAudioSampleEntry(): Uint8Array {
        const active = this.activeAudioCfg ?? this.cfg.audio;
        const config = this.activeAudioCfg ? this.activeAudioConfig : this.audioConfig;
        const codec = active?.codec ?? 'mp4a.40.2';
        if (active && isPcmCodec(codec)) {
            const format = pcmShape(active);
            return this.cfg.format === 'mov' ? quickTimePcmEntry(format) : isoPcmEntry(format);
        }
        const sampleRate = active?.sampleRate ?? 48000;
        let channelCount = active?.channelCount ?? 2;
        let kind = codec;
        let child: Uint8Array = new Uint8Array(0);
        let sampleSize = 16;
        let rate = Math.min(sampleRate, 0xffff) * 0x10000;

        const carried = carriedObjectType(codec);
        if (
            carried !== undefined ||
            codec.startsWith('mp4a') ||
            codec === 'mp1' ||
            codec === 'mp2' ||
            codec === 'mp3'
        ) {
            kind = 'mp4a';
            child =
                carried !== undefined
                    ? esdsBox(carried, 5, 0, config, true)
                    : codec.startsWith('mp4a')
                      ? this.buildEsds(sampleRate, channelCount, config)
                      : esdsBox(sampleRate < 32000 ? 0x69 : 0x6b, 5, 0, undefined, true);
        } else if (isMpegH(codec)) {
            kind = codec.slice(0, 4);
            channelCount = 0;
            if (config?.length) child = box('mhaC', config);
        } else if (codec.startsWith('iamf')) {
            if (!config?.length)
                throw new MediaForgeError('IAMF output requires its descriptors', 'FORMAT');
            kind = 'iamf';
            [channelCount, rate] = [0, 0];
            child = iacbBox(config);
        } else if (codec === 'ac-3' || codec === 'ec-3' || codec === 'mlpa' || isDtsCodec(codec)) {
            const type =
                codec === 'ac-3'
                    ? 'dac3'
                    : codec === 'ec-3'
                      ? 'dec3'
                      : codec === 'mlpa'
                        ? 'dmlp'
                        : 'ddts';
            if (config) child = box(type, config);
            if (codec === 'mlpa') rate = sampleRate;
        } else if (codec === 'flac') {
            const record = config && flacStreamInfoRecord(config);
            if (!record) throw new MediaForgeError('FLAC output requires STREAMINFO', 'FORMAT');
            return flacSampleEntry(record);
        } else if (codec === 'alac' || codec === 'ulaw' || codec === 'alaw') {
            if (sampleRate > 0xffff) rate = 0;
            if (codec === 'alac') {
                const cookie = config && alacCookie(config);
                if (!cookie)
                    throw new MediaForgeError(
                        'ALAC output requires its 24-byte magic cookie',
                        'FORMAT',
                    );
                child = fullBox('alac', 0, 0, cookie);
                sampleSize = cookie[5]!;
            }
        } else if (codec === 'opus') {
            kind = 'Opus';
            child = box('dOps', opusDopsPayload(config, channelCount));
        } else throw new MediaForgeError(`MP4 cannot carry audio codec '${codec}'`, 'FORMAT');

        return audioSampleEntry(kind, channelCount, sampleSize, rate, child.length ? [child] : []);
    }

    private resolveVideoSampleEntryType(codec: string): string {
        if (codec.startsWith('avc3')) return 'avc3';
        if (codec.startsWith('avc1') || codec.startsWith('avc')) return 'avc1';
        if (codec.startsWith('hvc1')) return 'hvc1';
        if (codec.startsWith('hev1') || codec.startsWith('hev')) return 'hev1';
        if (codec.startsWith('dvh1')) return 'dvh1';
        if (codec.startsWith('dvhe')) return 'dvhe';
        if (codec.startsWith('vvc1')) return 'vvc1';
        if (codec.startsWith('vvi1')) return 'vvi1';
        if (codec.startsWith('av01')) return 'av01';
        if (codecFamily(codec) === 'vp09') return 'vp09';
        if (codec.startsWith('apv1')) return 'apv1';
        if (mpegVideoObjectType(codec) !== null) return 'mp4v';
        if (codec === MJPEG_VIDEO)
            return this.cfg.format === 'mov' ? MJPEG_QUICKTIME_ENTRY : 'mp4v';
        if (isProResCodec(codec) || isProResRawCodec(codec)) return codec;
        throw new MediaForgeError(`MP4 cannot carry video codec '${codec}'`, 'FORMAT');
    }

    private buildEsds(
        sampleRate: number,
        channelCount: number,
        audioSpecificConfig?: Uint8Array,
    ): Uint8Array {
        const freqIndex = Math.max(0, AAC_SAMPLE_RATES.indexOf(sampleRate));
        const asc =
            audioSpecificConfig && audioSpecificConfig.length > 0
                ? new Uint8Array(audioSpecificConfig)
                : new Uint8Array([
                      (2 << 3) | (freqIndex >> 1),
                      ((freqIndex & 1) << 7) | (channelCount << 3),
                  ]);
        return esdsBox(0x40, 5, 128000, asc, true);
    }

    /** The stts of `runs`; `lastMayBeZero` lets the final sample (ending a cue) last nothing. */
    private buildStts(runs: Mp4SampleRuns, lastMayBeZero = false): DeferredBox {
        return tableBox('stts', 0, uint32(runs.length), runs.length, 8, (view, at, index) => {
            view.setUint32(at, runs.count(index), false);
            const least = lastMayBeZero && index === runs.length - 1 && runs.count(index) === 1;
            view.setUint32(
                at + 4,
                checkedInteger(
                    runs.value(index),
                    'stts sample duration',
                    least ? 0 : 1,
                    0xffffffff,
                ),
                false,
            );
        });
    }

    private buildCtts(runs: Mp4SampleRuns): DeferredBox | null {
        if (runs.length === 0 || (runs.length === 1 && runs.value(0) === 0)) return null;
        let version = 0;
        for (let i = 0; i < runs.length; i++) {
            if (runs.value(i) < 0) {
                version = 1;
                break;
            }
        }
        return tableBox('ctts', version, uint32(runs.length), runs.length, 8, (view, at, index) => {
            view.setUint32(at, runs.count(index), false);
            const value = checkedInteger(
                runs.value(index),
                'ctts composition offset',
                version === 1 ? -0x80000000 : 0,
                version === 1 ? 0x7fffffff : 0xffffffff,
            );
            view.setUint32(at + 4, signed32Payload(value), false);
        });
    }

    /**
     * The time-to-sample, sample-to-chunk and size tables of uncompressed audio: one sample per PCM
     * frame of `frameBytes`, one duration unit each at the sample rate, every packet a chunk of its
     * frames.
     */
    private pcmFrameTables(chunks: Mp4SampleTable, frameBytes: number): Uint8Array[] {
        let frames = 0;
        const runs: { first: number; frames: number }[] = [];
        for (let index = 0; index < chunks.length; index++) {
            const bytes = chunks.byteLength(index);
            if (bytes % frameBytes !== 0)
                throw new MediaForgeError('MP4 PCM packets must hold whole channel frames', 'MUX');
            const count = bytes / frameBytes;
            if (runs.at(-1)?.frames !== count) runs.push({ first: index, frames: count });
            frames += count;
        }

        const stts = new Uint8Array(12);
        new DataView(stts.buffer).setUint32(0, frames ? 1 : 0);
        new DataView(stts.buffer).setUint32(
            4,
            checkedInteger(frames, 'PCM frame count', 0, 0xffffffff),
        );
        new DataView(stts.buffer).setUint32(8, 1);
        const stsc = new Uint8Array(4 + runs.length * 12);
        const view = new DataView(stsc.buffer);
        view.setUint32(0, runs.length);
        runs.forEach((run, index) => {
            view.setUint32(4 + index * 12, run.first + 1);
            view.setUint32(8 + index * 12, run.frames);
            view.setUint32(12 + index * 12, 1);
        });
        const stsz = new Uint8Array(8);
        new DataView(stsz.buffer).setUint32(0, frameBytes);
        new DataView(stsz.buffer).setUint32(4, frames);
        return [
            fullBox('stts', 0, 0, frames ? stts : stts.subarray(0, 4)),
            fullBox('stsc', 0, 0, stsc),
            fullBox('stsz', 0, 0, stsz),
        ];
    }

    /** One sample per chunk; each run of samples of another sample description starts an entry. */
    private buildStsc(chunks: Mp4SampleTable): Uint8Array {
        const runs = chunks.descriptionRuns[0]?.first === 0 ? [] : [{ first: 0, description: 0 }];
        runs.push(...chunks.descriptionRuns);
        const payload = new Uint8Array(4 + runs.length * 12);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, runs.length, false);
        runs.forEach((run, index) => {
            dv.setUint32(4 + index * 12, run.first + 1, false);
            dv.setUint32(8 + index * 12, 1, false);
            dv.setUint32(12 + index * 12, run.description + 1, false);
        });
        return fullBox('stsc', 0, 0, payload);
    }

    private buildStsz(chunks: Mp4SampleTable): DeferredBox {
        return tableBox('stsz', 0, uint32(0, chunks.length), chunks.length, 4, (view, at, index) =>
            view.setUint32(at, chunks.byteLength(index), false),
        );
    }

    private buildStco(chunks: Mp4SampleTable, base: number): DeferredBox {
        if (this.use64BitOffsets)
            return tableBox('co64', 0, uint32(chunks.length), chunks.length, 8, (view, at, index) =>
                view.setBigUint64(at, BigInt(base) + BigInt(chunks.offset(index)), false),
            );
        return tableBox('stco', 0, uint32(chunks.length), chunks.length, 4, (view, at, index) =>
            view.setUint32(at, base + chunks.offset(index), false),
        );
    }

    private buildStss(chunks: Mp4SampleTable): DeferredBox | null {
        let syncSampleCount = 0;
        for (let i = 0; i < chunks.length; i++) if (chunks.isKeyframe(i)) syncSampleCount++;
        if (syncSampleCount === chunks.length) return null;
        let next = 0;
        return tableBox(
            'stss',
            0,
            uint32(syncSampleCount),
            syncSampleCount,
            4,
            (view, at, index) => {
                if (index === 0) next = 0;
                while (!chunks.isKeyframe(next)) next++;
                view.setUint32(at, ++next, false);
            },
        );
    }

    private videoTimescale(chunks: Mp4SampleTable = this.videoChunks): number {
        const maxGapSeconds = chunks.largestDecodeStep;
        const DEFAULT = 90000;
        const LIMIT = 0x7fff0000;
        if (maxGapSeconds <= 0 || DEFAULT * maxGapSeconds < LIMIT) return DEFAULT;
        return Math.max(1, Math.floor(LIMIT / maxGapSeconds));
    }

    private audioTimescale(): number {
        return this.cfg.audio?.sampleRate ?? 48000;
    }
}
