import { DV_VIDEO, DV_WRITE_FOURCC } from '../../core/codec-config/video/dv-video';
import { MJPEG_VIDEO } from '../../core/codec-config/video/mjpeg';
import { tx3gSubRip } from '../text/timed-text';
import {
    isAnnexB,
    isValidAvccWalk,
    isValidHevcWalk,
    annexBToAvcc,
    buildAvcCFromAnnexB,
} from '../../core/codec-config/video/annexb';
import { buildHevcCFromAnnexB } from '../../core/codec-config/video/hevc-config';
import type { Sink } from '../../core/model/types';
import { MediaForgeError } from '../../core/errors/errors';
import { handOffOutput, retainedBytes } from '../../core/bytes/output-data';
import { releaseBytes } from '../../core/bytes/byte-holds';
import type { MuxerConfig, AudioTrackConfig, OutputMuxer } from '../../core/contracts/writer';
import type {
    EncodedPacket,
    FieldOrder,
    MatroskaPassThrough,
    TrackDispositions,
    VideoColour,
} from '../../core/model/media';
import { checkedFieldOrder, fielPayload, snapshotVideoColour } from '../shared/video-colour';
import { parseAacAudioSpecificConfig } from '../../core/codec-config/audio/adts';
import { normalizeMatroskaDisplay } from './display';
import type { MatroskaDisplay } from './display';
import { filterMatroskaTags } from './tags';
import { describeMatroskaPcm } from './pcm';
import { alacCookie } from '../../core/codec-config/audio/alac-packet';
import { g711WaveFormat } from '../../core/codec-config/audio/wave-format';
import { mergeMatroskaTrackTitles } from './track-titles';
import { matroskaMediaTagElements } from './media-tags';
import { readProResFourCC, proResFrameError } from '../../core/codec-config/video/prores';
import {
    flacStreamHeader,
    flacStreamInfoAt,
    flacStreamInfoRecord,
} from '../../core/codec-config/audio/flac-frame';
import {
    isDtsCodec,
    mpegVideoFamily,
    isProResCodec,
    isHevcCodec,
} from '../../core/model/codec-strings';
import { isVpcC, webmVp9Features } from '../../core/codec-config/video/vp9-config';
import {
    dolbyVisionBoxType,
    parseDolbyVisionConfig,
} from '../../core/codec-config/video/dolby-vision';
import { isVvcCodec } from '../../core/codec-config/video/vvc';
import {
    buildBitmapInfoHeader,
    isWindowsMediaAudio,
    isWindowsMediaVideo,
    windowsMediaVideoFourcc,
} from '../../core/codec-config/windows-media';

import { iso639Language } from '../shared/language';
import { isDefaultHandlerName } from '../mp4/metadata';
import { concatBytes } from '../../core/bytes/bytes';
import { decodeTime, secondsToTicks } from '../../core/model/media-time';
import { u32be, dataView } from '../../core/bytes/byte-fields';
import { assertOpen, checkChunk, unfedTrack } from '../shared/chunk-checks';
import {
    ebmlBinary,
    ebmlElement,
    ebmlFloat,
    ebmlSint,
    ebmlSizeBytes,
    ebmlString,
    ebmlUid,
    ebmlUint,
    ebmlUintFixed8,
    writeEbmlId,
    writeEbmlSize,
    writeUnsigned,
} from './ebml-write';

const textEncoder = new TextEncoder();

function trackLanguage(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > 255 ||
        !/^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*|[iIxX](?:-[A-Za-z0-9]{1,8})+)$/.test(value)
    ) {
        throw new MediaForgeError(
            'Matroska track language must be an ISO 639 code or a BCP 47 tag',
            'FORMAT',
        );
    }
    return value;
}

const trackConfigKeys = [
    'id',
    'matroskaTrackUid',
    'type',
    'codec',
    'codecConfig',
    'dolbyVisionConfig',
    'language',
    'name',
    'title',
    'commentary',
    'default',
    'forced',
    'dispositions',
    'alphaMode',
    'width',
    'height',
    'displayWidth',
    'displayHeight',
    'pixelAspectRatioNum',
    'pixelAspectRatioDen',
    'rotation',
    'framerate',
    'colour',
    'fieldOrder',
    'sampleRate',
    'channelCount',
    'primingSamples',
    'validSamples',
    'presentationTimestamps',
    'discardLeadingSamples',
    'codecDelaySamples',
    'presentationStartSeconds',
    'presentationDurationSeconds',
    'presentationMediaTimeSeconds',
    'mediaTimescale',
] as const;

function snapshotTrackConfig<
    T extends {
        language?: string;
        name?: string;
        commentary?: boolean;
        default?: boolean;
        forced?: boolean;
        alphaMode?: boolean;
    },
>(track: T): T {
    const snapshot: Record<string, unknown> = {};
    for (const key of trackConfigKeys) snapshot[key] = Reflect.get(track, key);
    if (typeof snapshot.codec !== 'string') {
        throw new MediaForgeError('Matroska track codec must be a string', 'FORMAT');
    }
    for (const key of ['default', 'forced', 'alphaMode', 'commentary']) {
        if (snapshot[key] !== undefined && typeof snapshot[key] !== 'boolean') {
            throw new MediaForgeError(`Matroska ${key} must be a boolean`, 'FORMAT');
        }
    }
    for (const key of ['name', 'title']) {
        if (snapshot[key] !== undefined && typeof snapshot[key] !== 'string')
            throw new MediaForgeError(`Matroska track ${key} must be a string`, 'FORMAT');
    }

    snapshot.language = trackLanguage(snapshot.language as string | undefined);
    if (snapshot.colour !== undefined) {
        if (!snapshot.colour || typeof snapshot.colour !== 'object')
            throw new MediaForgeError('Matroska colour must be an object', 'FORMAT');
        snapshot.colour = snapshotVideoColour(snapshot.colour as VideoColour);
    }
    snapshot.fieldOrder = checkedFieldOrder(snapshot.fieldOrder as FieldOrder | undefined);

    if (snapshot.codecConfig !== undefined) {
        if (!(snapshot.codecConfig instanceof Uint8Array)) {
            throw new MediaForgeError('Matroska codecConfig must be a Uint8Array', 'FORMAT');
        }
        snapshot.codecConfig = new Uint8Array(snapshot.codecConfig);
    }
    return snapshot as T;
}

/** Matroska element IDs of the TrackDispositions flags; WebM has none of them. */
const DISPOSITION_IDS: Readonly<Record<keyof TrackDispositions, number>> = {
    hearingImpaired: 0x55ab,
    visualImpaired: 0x55ac,
    textDescriptions: 0x55ad,
    original: 0x55ae,
};

function trackMetadataElements(
    track: {
        default?: boolean;
        forced?: boolean;
        name?: string;
        commentary?: boolean;
        dispositions?: TrackDispositions;
    },
    format: string,
): Uint8Array[] {
    const flags = format === 'mkv' ? Object.entries(track.dispositions ?? {}) : [];
    return [
        ...(track.default === undefined ? [] : [ebmlUint(0x88, track.default ? 1 : 0)]),
        ...(track.forced === undefined ? [] : [ebmlUint(0x55aa, track.forced ? 1 : 0)]),
        ...(track.commentary === undefined ? [] : [ebmlUint(0x55af, track.commentary ? 1 : 0)]),
        ...flags
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) =>
                ebmlUint(DISPOSITION_IDS[key as keyof TrackDispositions], value ? 1 : 0),
            ),
        // A handler name an MP4 muxer writes by default names no track.
        ...(track.name === undefined || isDefaultHandlerName(track.name)
            ? []
            : [ebmlString(0x536e, track.name)]),
    ];
}

/**
 * The Colour element: H.273 code points, the range when known, and the HDR light levels and
 * mastering display.
 */
function colourElement(colour: VideoColour): Uint8Array {
    const mastering = colour.mastering;
    const light = colour.contentLight;
    return ebmlElement(
        0x55b0,
        concatBytes([
            ...(colour.fullRange === undefined ? [] : [ebmlUint(0x55b9, colour.fullRange ? 2 : 1)]),
            ebmlUint(0x55b1, colour.matrix),
            ebmlUint(0x55ba, colour.transfer),
            ebmlUint(0x55bb, colour.primaries),
            ...(light
                ? [ebmlUint(0x55bc, light.maxContent), ebmlUint(0x55bd, light.maxAverage)]
                : []),
            ...(mastering
                ? [
                      ebmlElement(
                          0x55d0,
                          concatBytes([
                              ebmlFloat(0x55d1, mastering.red[0]),
                              ebmlFloat(0x55d2, mastering.red[1]),
                              ebmlFloat(0x55d3, mastering.green[0]),
                              ebmlFloat(0x55d4, mastering.green[1]),
                              ebmlFloat(0x55d5, mastering.blue[0]),
                              ebmlFloat(0x55d6, mastering.blue[1]),
                              ebmlFloat(0x55d7, mastering.whitePoint[0]),
                              ebmlFloat(0x55d8, mastering.whitePoint[1]),
                              ebmlFloat(0x55d9, mastering.maxLuminance),
                              ebmlFloat(0x55da, mastering.minLuminance),
                          ]),
                      ),
                  ]
                : []),
        ]),
    );
}

/**
 * FlagInterlaced, and for Matroska (WebM has no FieldOrder) the FieldOrder, whose codes match the
 * fiel box's.
 */
function fieldOrderElements(order: FieldOrder | undefined, format: string): Uint8Array[] {
    if (order === undefined) return [];
    if (order === 'progressive')
        return [ebmlUint(0x9a, 2), ...(format === 'mkv' ? [ebmlUint(0x9d, 0)] : [])];
    return [
        ebmlUint(0x9a, 1),
        ...(format === 'mkv' ? [ebmlUint(0x9d, fielPayload(order)[1]!)] : []),
    ];
}

/**
 * Language, plus LanguageBCP47 for a longer tag. An unknown language is written as 'und': readers
 * take a missing Language element (or the ISO 639-2 code alone of a longer tag) as its default,
 * eng.
 */
function languageElements(value: string | undefined): Uint8Array[] {
    if (value === undefined) return [ebmlString(0x22b59c, 'und')];
    if (/^[A-Za-z]{3}$/.test(value)) return [ebmlString(0x22b59c, value)];
    return [ebmlString(0x22b59c, iso639Language(value) ?? 'und'), ebmlString(0x22b59d, value)];
}

function trackUids(tracks: Array<{ id?: number; matroskaTrackUid?: bigint }>): bigint[] {
    const explicit = new Set<bigint>();
    for (const { id, matroskaTrackUid: uid } of tracks) {
        if (id !== undefined && (!Number.isSafeInteger(id) || id < 0)) {
            throw new MediaForgeError(
                'Matroska track id must be a non-negative safe integer',
                'FORMAT',
            );
        }
        if (uid !== undefined) {
            if (
                typeof uid !== 'bigint' ||
                uid <= 0n ||
                uid > 0xffffffffffffffffn ||
                explicit.has(uid)
            ) {
                throw new MediaForgeError(
                    'Matroska TrackUID must be a unique positive unsigned 64-bit bigint',
                    'FORMAT',
                );
            }
            explicit.add(uid);
        }
    }

    const reserved = new Set([
        ...explicit,
        ...tracks
            .filter(track => track.id && !track.matroskaTrackUid)
            .map(track => BigInt(track.id!)),
    ]);

    const used = new Set<bigint>();
    let next = 1n;
    return tracks.map(track => {
        let uid = track.matroskaTrackUid ?? BigInt(track.id ?? 0);
        if (!uid || used.has(uid) || (track.matroskaTrackUid === undefined && explicit.has(uid))) {
            while (used.has(next) || reserved.has(next)) next++;
            uid = next++;
        }
        used.add(uid);
        return uid;
    });
}

/** What the track entry of `codec` cannot be written without, or undefined. */
function requiredCodecConfig(codec: string): string | undefined {
    return codec.startsWith('avc')
        ? 'H.264 requires an avcC codec config'
        : isHevcCodec(codec)
          ? 'H.265 requires an hvcC codec config'
          : isVvcCodec(codec)
            ? 'H.266 requires a vvcC codec config'
            : codec === 'theora'
              ? 'Theora requires its Xiph-laced header packets'
              : isWindowsMediaAudio(codec)
                ? 'Windows Media Audio requires its WAVEFORMATEX'
                : codec.startsWith('mp4a')
                  ? 'AAC requires an AudioSpecificConfig'
                  : codec === 'flac'
                    ? 'FLAC requires a STREAMINFO codec config'
                    : codec === 'alac'
                      ? 'ALAC requires its magic cookie'
                      : undefined;
}

function validateCodecConfig(
    codec: string,
    config: Uint8Array | undefined,
    allowMissing: boolean,
): void {
    if (isProResCodec(codec) && config !== undefined && readProResFourCC(config) !== codec) {
        throw new MediaForgeError(
            'Matroska ProRes CodecPrivate must contain its matching four-byte FourCC',
            'FORMAT',
        );
    }

    const required = requiredCodecConfig(codec);
    if (required && ((!config && !allowMissing) || config?.length === 0)) {
        throw new MediaForgeError(`MKV ${required}`, 'FORMAT');
    }
    if (codec === 'flac' && config && config.length > 0 && flacStreamHeader(config) === null) {
        throw new MediaForgeError('MKV FLAC codec config must contain STREAMINFO', 'FORMAT');
    }
    if (codec === 'alac' && config && config.length > 0 && !alacCookie(config)) {
        throw new MediaForgeError('MKV ALAC magic cookie is shorter than 24 bytes', 'FORMAT');
    }
}

/**
 * Copy preflight requires decoder configuration; encoders may supply it with their first packet.
 */
export function validateMatroskaCodecConfigs(
    cfg: Pick<MuxerConfig, 'video' | 'audio' | 'extraAudioTracks' | 'extraVideoTracks'>,
): void {
    for (const track of [
        cfg.video,
        cfg.audio,
        ...(cfg.extraAudioTracks ?? []),
        ...(cfg.extraVideoTracks ?? []),
    ]) {
        if (track) validateCodecConfig(track.codec, track.codecConfig, false);
    }
}

interface BufferedPacket {
    readonly chunk: EncodedPacket;
    readonly trackNum: number;
}

interface AudioPacketStats {
    first: BufferedPacket;
    last: BufferedPacket;
    count: number;
    samples: number;
    rate: number;
}

interface OpusInfo {
    readonly head: Uint8Array;
    readonly channels: number;
    readonly inputSampleRate: number;
    readonly preSkip: number;
}

function buildSeekHeadForCues(cuesPosFromSegmentStart: number): Uint8Array {
    return ebmlElement(
        0x114d9b74,
        ebmlElement(
            0x4dbb,
            concatBytes([
                ebmlBinary(0x53ab, Uint8Array.from([0x1c, 0x53, 0xbb, 0x6b])),
                ebmlUintFixed8(0x53ac, cuesPosFromSegmentStart),
            ]),
        ),
    );
}

function buildCues(
    startTimesTicks: number[],
    clusterOffsets: number[],
    cueTracks: number[],
): Uint8Array {
    const points: Uint8Array[] = [];
    for (let i = 0; i < startTimesTicks.length; i++) {
        points.push(
            ebmlElement(
                0xbb,
                concatBytes([
                    ebmlUint(0xb3, Math.max(0, startTimesTicks[i]!)),
                    ebmlElement(
                        0xb7,
                        concatBytes([
                            ebmlUint(0xf7, cueTracks[i]!),
                            ebmlUint(0xf1, clusterOffsets[i]!),
                        ]),
                    ),
                ]),
            ),
        );
    }
    return ebmlElement(0x1c53bb6b, concatBytes([...points]));
}

function findDurationPayloadOffset(segmentInfo: Uint8Array): number {
    for (let i = 0; i + 11 <= segmentInfo.length; i++) {
        if (segmentInfo[i] === 0x44 && segmentInfo[i + 1] === 0x89 && segmentInfo[i + 2] === 0x88) {
            return i + 3;
        }
    }
    return -1;
}

function buildOpusHead(channels: number, inputSampleRate: number, preSkip: number): Uint8Array {
    const head = new Uint8Array(19);
    head.set(textEncoder.encode('OpusHead'), 0);
    head[8] = 1;
    head[9] = channels & 0xff;
    new DataView(head.buffer).setUint16(10, preSkip & 0xffff, true);
    new DataView(head.buffer).setUint32(12, inputSampleRate >>> 0, true);
    new DataView(head.buffer).setInt16(16, 0, true);
    head[18] = 0;
    return head;
}

function parseOpusHead(
    config: Uint8Array | undefined,
    fallbackChannels: number,
    fallbackRate: number,
): OpusInfo {
    if (config && config.length >= 19) {
        const magic = String.fromCharCode(...config.subarray(0, 8));
        if (magic === 'OpusHead') {
            const view = dataView(config);
            return {
                head: new Uint8Array(config),
                channels: Math.max(1, config[9] || fallbackChannels || 2),
                inputSampleRate: view.getUint32(12, true) || fallbackRate || 48000,
                preSkip: view.getUint16(10, true),
            };
        }
    }

    if (config && config.length >= 11 && config[0] === 0) {
        const view = dataView(config);
        const channels = Math.max(1, config[1] || fallbackChannels || 2);
        const family = config[10]!;
        const extensionLength = family === 0 ? 0 : 2 + channels;
        if (config.length >= 11 + extensionLength) {
            const preSkip = view.getUint16(2, false);
            const inputSampleRate = view.getUint32(4, false) || fallbackRate || 48000;
            const head = buildOpusHead(channels, inputSampleRate, preSkip);
            const expanded =
                extensionLength > 0 ? new Uint8Array(head.length + extensionLength) : head;
            if (expanded !== head) expanded.set(head);
            new DataView(expanded.buffer).setInt16(16, view.getInt16(8, false), true);
            expanded[18] = family;
            if (extensionLength > 0) expanded.set(config.subarray(11, 11 + extensionLength), 19);
            return { head: expanded, channels, inputSampleRate, preSkip };
        }
    }
    return {
        head: buildOpusHead(
            Math.max(1, fallbackChannels || 2),
            Math.max(1, fallbackRate || 48000),
            312,
        ),
        channels: Math.max(1, fallbackChannels || 2),
        inputSampleRate: Math.max(1, fallbackRate || 48000),
        preSkip: 312,
    };
}

function hasAudioPresentationWindow(track: AudioTrackConfig): boolean {
    return (
        track.primingSamples !== undefined ||
        track.validSamples !== undefined ||
        track.presentationTimestamps !== undefined ||
        track.discardLeadingSamples !== undefined ||
        track.codecDelaySamples !== undefined
    );
}

function validateAudioPresentationWindow(track: AudioTrackConfig, label: string): void {
    if (
        track.primingSamples !== undefined &&
        (!Number.isSafeInteger(track.primingSamples) || track.primingSamples < 0)
    ) {
        throw new MediaForgeError(`${label} has invalid primingSamples`, 'MUX');
    }
    if (
        track.validSamples !== undefined &&
        (!Number.isSafeInteger(track.validSamples) || track.validSamples < 1)
    ) {
        throw new MediaForgeError(`${label} has invalid validSamples`, 'MUX');
    }
    if (
        track.codecDelaySamples !== undefined &&
        (!Number.isSafeInteger(track.codecDelaySamples) || track.codecDelaySamples < 0)
    ) {
        throw new MediaForgeError(`${label} has invalid codecDelaySamples`, 'MUX');
    }
    if (
        track.presentationTimestamps !== undefined &&
        typeof track.presentationTimestamps !== 'boolean'
    ) {
        throw new MediaForgeError(`${label} has invalid presentationTimestamps`, 'MUX');
    }
    if (
        track.discardLeadingSamples !== undefined &&
        typeof track.discardLeadingSamples !== 'boolean'
    ) {
        throw new MediaForgeError(`${label} has invalid discardLeadingSamples`, 'MUX');
    }

    const priming = track.primingSamples ?? 0;
    if (track.validSamples !== undefined && !Number.isSafeInteger(priming + track.validSamples)) {
        throw new MediaForgeError(
            `${label} presentation window exceeds the safe integer range`,
            'MUX',
        );
    }
}

function configuredCodecDelaySamples(
    track: AudioTrackConfig,
    primingSamples: number,
    codecConfig: Uint8Array | undefined = track.codecConfig,
): number {
    if (track.codec.startsWith('opus')) {
        const preSkip = parseOpusHead(
            codecConfig,
            track.channelCount || 2,
            track.sampleRate || 48000,
        ).preSkip;
        if (track.codecDelaySamples !== undefined && track.codecDelaySamples !== preSkip) {
            throw new MediaForgeError(
                `Opus codecDelaySamples ${track.codecDelaySamples} must equal OpusHead pre-skip ` +
                    `${preSkip}`,
                'MUX',
            );
        }
        return preSkip;
    }
    if (track.codecDelaySamples !== undefined) return track.codecDelaySamples;

    return track.codec.startsWith('mp4a') ? primingSamples : 0;
}

/**
 * Samples an audio track's block timestamps move later. Opus and a declared CodecDelay move by that
 * delay, which readers subtract again (by the priming too when timestamps already present the
 * priming before zero); other audio moves by its priming only when it would start before zero, as a
 * copy otherwise moves every track together.
 */
function audioTimelineShiftSamples(
    codec: string,
    priming: number,
    codecDelay: number,
    presentationTimestamps: boolean,
    startsBeforeZero: boolean,
): number {
    if (codec.startsWith('opus') || codecDelay > 0)
        return presentationTimestamps ? Math.max(priming, codecDelay) : codecDelay;
    return startsBeforeZero ? priming : 0;
}

/** Refuses a chunk whose times the writer's clock of `rate` ticks per second cannot state. */
function validateChunkTiming(chunk: EncodedPacket, rate: number): void {
    const duration = chunk.duration ?? 0;
    const decodeTimestamp = decodeTime(chunk);
    if (!(duration >= 0))
        throw new MediaForgeError('Matroska chunk duration must be at or after zero', 'MUX');
    for (const seconds of [chunk.timestamp, decodeTimestamp, duration, chunk.timestamp + duration])
        secondsToTicks(seconds, rate, 'Matroska chunk timing');
}

/**
 * Retains only the fields the writer reads, with owned copies of the borrowed payloads; `briefly`
 * keeps unchanging payloads uncopied for writers that flush within one cluster.
 */
function snapshotChunk(chunk: EncodedPacket, briefly = false): EncodedPacket {
    return {
        trackType: chunk.trackType,
        timestamp: chunk.timestamp,
        decodeTimestamp: chunk.decodeTimestamp,
        duration: chunk.duration,
        isKeyframe: chunk.isKeyframe,
        data: briefly ? retainedBytes(chunk.data) : new Uint8Array(chunk.data),
        alphaData: chunk.alphaData ? new Uint8Array(chunk.alphaData) : undefined,
        ...(chunk.trailingDiscard ? { trailingDiscard: chunk.trailingDiscard } : {}),
    };
}

/**
 * WebM/MKV muxer (incremental clusters, SeekHead/Cues, DiscardPadding, subtitles,
 * chapters/attachments pass-through).
 */
export class WebMMuxer implements OutputMuxer {
    private readonly trackUids: readonly bigint[];
    private readonly trackNumbers: readonly number[];
    private readonly subtitleNumbers = new Set<number>();
    private readonly extraAudioIndices = new Map<number, number>();
    private readonly titledTracks: ReadonlyArray<{ matroskaTrackUid: bigint; title?: string }>;
    private readonly pcmFormats = new Map<
        number,
        NonNullable<ReturnType<typeof describeMatroskaPcm>>
    >();
    private readonly timeUnitsPerSecond: number;
    private readonly display: MatroskaDisplay | undefined;
    private readonly extraVideoDisplays: (MatroskaDisplay | undefined)[] = [];
    private validAudioSamples: number | null = null;
    private audioPrimingSamples = 0;
    private audioCodecDelaySamples = 0;
    private audioPrimingConfigured = false;
    private audioPrimingPresentationTimestamps = false;
    private audioLeadingDiscardEnabled = true;
    private audioTimelineShiftSeconds: number | null = null;
    private audioCodecDelayExplicit = false;
    /** A live encoder declared its priming after the sound started; its window is left out. */
    private audioWindowMissed = false;

    setValidSamples(samples: number): void {
        if (!Number.isSafeInteger(samples) || samples < 0) {
            throw new MediaForgeError(
                'Matroska valid sample count must be a non-negative safe integer',
                'INPUT',
            );
        }
        // Without the priming the count would cut the wrong samples.
        if (this.audioWindowMissed) return;
        this.validAudioSamples = samples;
    }

    /**
     * Configure a codec-independent Matroska presentation window. Without `validSamples` (a live
     * source) the priming applies from the first chunk and the length follows by a second call or
     * setValidSamples(); a declaration that comes after the sound started is left out, as is the
     * window that completes it.
     */
    setAudioPriming(
        primingSamples: number,
        validSamples: number | undefined,
        presentationTimestamps = false,
        discardLeadingSamples = true,
        codecDelaySamples?: number,
    ): void {
        const delayTrack =
            this.cfg.audio && codecDelaySamples !== undefined
                ? { ...this.cfg.audio, codecDelaySamples }
                : this.cfg.audio;
        const resolvedCodecDelay = delayTrack
            ? configuredCodecDelaySamples(delayTrack, primingSamples, this.audioConfig)
            : 0;
        const open = validSamples === undefined;

        if (
            !Number.isSafeInteger(primingSamples) ||
            primingSamples < 0 ||
            (!open && (!Number.isSafeInteger(validSamples) || validSamples < 1)) ||
            !Number.isSafeInteger(primingSamples + (validSamples ?? 0)) ||
            !Number.isSafeInteger(resolvedCodecDelay) ||
            resolvedCodecDelay < 0 ||
            typeof presentationTimestamps !== 'boolean' ||
            typeof discardLeadingSamples !== 'boolean'
        ) {
            throw new MediaForgeError('Matroska priming/valid sample window is invalid', 'INPUT');
        }

        const priming = primingSamples;
        const valid = validSamples;
        const codecDelay = resolvedCodecDelay;

        if (this.audioPrimingConfigured) {
            if (
                this.audioPrimingSamples === priming &&
                this.audioCodecDelaySamples === codecDelay &&
                (open || this.validAudioSamples === null || this.validAudioSamples === valid) &&
                this.audioPrimingPresentationTimestamps === presentationTimestamps &&
                this.audioLeadingDiscardEnabled === discardLeadingSamples
            ) {
                if (valid !== undefined) this.validAudioSamples = valid;
                return;
            }
            throw new MediaForgeError(
                'Matroska audio window was configured twice with different values',
                'MUX',
            );
        }

        if (
            this.sawAudioChunk ||
            (this.streamingHeaderWritten && codecDelay !== this.audioCodecDelaySamples)
        ) {
            if (open) this.audioWindowMissed = true;
            if (open || this.audioWindowMissed) return;
            throw new MediaForgeError(
                'Matroska audio window must be configured before the first audio chunk',
                'MUX',
            );
        }

        this.audioPrimingConfigured = true;
        this.audioPrimingSamples = priming;
        this.audioCodecDelaySamples = codecDelay;
        this.audioCodecDelayExplicit = codecDelaySamples !== undefined;
        this.validAudioSamples = valid ?? null;
        this.audioPrimingPresentationTimestamps = presentationTimestamps;
        this.audioLeadingDiscardEnabled = discardLeadingSamples;
    }

    private finalizedFlag = false;
    private sawVideoChunk = false;
    private sawAudioChunk = false;
    private readonly sink: Sink;
    private readonly cfg: MuxerConfig;
    private videoConfig?: Uint8Array;
    private audioConfig?: Uint8Array;
    /**
     * The STREAMINFO record of a FLAC configuration given after the header (an encoder's, completed
     * at the end), and where the header written to a sink that patches holds the one it replaces at
     * finalize.
     */
    private lateFlacRecord?: Uint8Array;
    private flacRecordAt = -1;
    private readonly extraAudioConfigs: (Uint8Array | undefined)[] = [];
    private readonly extraVideoConfigs: (Uint8Array | undefined)[] = [];
    private readonly seenExtraVideo = new Set<number>();
    private readonly seenExtraAudio = new Set<number>();
    private readonly extraEncodedAudioSamples: number[] = [];
    private readonly extraLeadingDiscardWritten = new Set<number>();

    private readonly extraAudioTimelineShiftSeconds: (number | null)[] = [];
    private passThrough: MatroskaPassThrough = {};
    private readonly subtitlePackets: Array<{ chunk: EncodedPacket; trackNum: number }> = [];
    private streamingHeaderWritten = false;
    private pendingPackets: BufferedPacket[] = [];
    private pendingStartTicks = 0;
    private streamEncodedAudioSamples = 0;
    private audioPacketCount = 0;
    private leadingAudioDiscardWritten = false;
    private readonly lastBlockTimestamps = new Map<number, number>();
    private scratchTicks = new Int32Array(0);
    /**
     * Standard output on a seekable sink: patch positions and the Cues of the clusters written so
     * far.
     */
    private indexed: {
        readonly sizeOffset: number;
        readonly seekHeadOffset: number;
        readonly dataStart: number;
        readonly times: number[];
        readonly offsets: number[];
        readonly tracks: number[];
    } | null = null;

    constructor(cfg: MuxerConfig, sink: Sink) {
        const {
            video: inputVideo,
            audio: inputAudio,
            subtitleTracks,
            extraAudioTracks,
            videoColour,
            videoLanguage,
            audioLanguage,
            format,
            mode,
            extraVideoTracks,
            ...rest
        } = cfg;
        const video = inputVideo ? snapshotTrackConfig(inputVideo) : undefined;
        const audio = inputAudio ? snapshotTrackConfig(inputAudio) : undefined;
        cfg = {
            ...rest,
            format,
            mode,
            video,
            audio,
            extraVideoTracks: extraVideoTracks?.map(snapshotTrackConfig),
            videoLanguage: trackLanguage(videoLanguage ?? video?.language),
            audioLanguage: trackLanguage(audioLanguage ?? audio?.language),
            videoColour: snapshotVideoColour(videoColour),
            extraAudioTracks: extraAudioTracks?.map(snapshotTrackConfig),
            subtitleTracks: subtitleTracks?.map(snapshotTrackConfig),
        };
        if (cfg.format !== 'mkv' && cfg.format !== 'webm') {
            throw new MediaForgeError('Matroska output format must be mkv or webm', 'FORMAT');
        }
        if (cfg.mode !== 'standard' && cfg.mode !== 'fragmented') {
            throw new MediaForgeError('Matroska mode must be standard or fragmented', 'FORMAT');
        }
        this.display = video ? normalizeMatroskaDisplay(video) : undefined;
        for (const track of [video, ...(cfg.extraVideoTracks ?? [])]) {
            if (!track) continue;
            if (isProResCodec(track.codec) && cfg.format !== 'mkv')
                throw new MediaForgeError(
                    'WebM cannot carry ProRes; use Matroska output',
                    'FORMAT',
                );
            if (!Number.isFinite(track.framerate) || track.framerate < 0) {
                throw new MediaForgeError(
                    'Matroska framerate must be finite and non-negative',
                    'FORMAT',
                );
            }
            if (track.rotation !== undefined && !Number.isFinite(track.rotation)) {
                throw new MediaForgeError('Matroska rotation must be finite', 'FORMAT');
            }
            if (track.alphaMode && !/^(?:vp8|vp9|vp09)(?:\.|$)/.test(track.codec)) {
                throw new MediaForgeError('Matroska alpha requires VP8/VP9 video', 'FORMAT');
            }
        }
        for (const track of [audio, ...(cfg.extraAudioTracks ?? [])]) {
            if (!track) continue;
            if (
                !Number.isFinite(track.sampleRate) ||
                track.sampleRate <= 0 ||
                !Number.isSafeInteger(track.channelCount) ||
                track.channelCount <= 0
            ) {
                throw new MediaForgeError(
                    'Matroska audio needs a positive sample rate and channel count',
                    'FORMAT',
                );
            }
            validateAudioPresentationWindow(track, 'Matroska audio track');
        }
        this.cfg = cfg;
        this.sink = sink;
        const tracks = [
            ...(this.cfg.video ? [this.cfg.video] : []),
            ...(this.cfg.audio ? [this.cfg.audio] : []),
            ...(this.cfg.subtitleTracks ?? []),
            ...(this.cfg.extraAudioTracks ?? []),
            ...(this.cfg.extraVideoTracks ?? []),
        ];
        this.trackUids = trackUids(tracks);
        this.titledTracks = tracks.map((track, index) => ({
            matroskaTrackUid: this.trackUids[index]!,
            title: track.title,
        }));

        // Tags of another container; a Matroska input's own elements replace them
        // (setMatroskaPassThrough).
        const own = matroskaMediaTagElements(cfg.tags, cfg.format);
        this.passThrough.tags = mergeMatroskaTrackTitles(own.tags, this.titledTracks);
        if (own.chapters) this.passThrough.chapters = own.chapters;
        if (own.attachments) this.passThrough.attachments = own.attachments;
        const reserved = new Set(tracks.filter(track => track.id).map(track => track.id!));
        const used = new Set<number>();
        let next = 1;
        this.trackNumbers = tracks.map(track => {
            let number = track.id ?? 0;
            if (!number || used.has(number)) {
                while (reserved.has(next) || used.has(next)) next++;
                number = next++;
            }
            used.add(number);
            return number;
        });
        cfg.subtitleTracks?.forEach((_, index) =>
            this.subtitleNumbers.add(this.subtitleTrackNumber(index)),
        );
        cfg.extraAudioTracks?.forEach((_, index) =>
            this.extraAudioIndices.set(this.extraAudioTrackNumber(index), index),
        );
        for (const [index, track] of [cfg.audio, ...(cfg.extraAudioTracks ?? [])].entries()) {
            if (!track) continue;
            const pcm = describeMatroskaPcm(track);
            if (pcm) {
                if (cfg.format !== 'mkv')
                    throw new MediaForgeError('PCM requires Matroska output', 'FORMAT');
                this.pcmFormats.set(
                    index === 0
                        ? this.primaryAudioTrackNumber()
                        : this.extraAudioTrackNumber(index - 1),
                    pcm,
                );
            }
        }
        this.timeUnitsPerSecond = this.pcmFormats.size ? 1_000_000 : 1000;
        if (cfg.title !== undefined) {
            if (typeof cfg.title !== 'string')
                throw new MediaForgeError('Matroska title must be a string', 'FORMAT');
            this.passThrough.title = cfg.title;
        }
        if (cfg.video?.codecConfig) this.videoConfig = new Uint8Array(cfg.video.codecConfig);
        if (cfg.audio?.codecConfig) this.audioConfig = new Uint8Array(cfg.audio.codecConfig);
        if (cfg.audio?.codec.startsWith('opus')) {
            this.audioCodecDelaySamples = configuredCodecDelaySamples(
                cfg.audio,
                cfg.audio.primingSamples ?? 0,
                this.audioConfig,
            );
            this.audioCodecDelayExplicit = cfg.audio.codecDelaySamples !== undefined;
        }
        if (cfg.audio && hasAudioPresentationWindow(cfg.audio)) {
            const priming = cfg.audio.primingSamples ?? 0;
            this.audioPrimingSamples = priming;
            this.audioCodecDelaySamples = configuredCodecDelaySamples(
                cfg.audio,
                priming,
                this.audioConfig,
            );
            this.audioCodecDelayExplicit = cfg.audio.codecDelaySamples !== undefined;
            this.validAudioSamples = cfg.audio.validSamples ?? null;
            this.audioPrimingPresentationTimestamps = cfg.audio.presentationTimestamps === true;
            this.audioLeadingDiscardEnabled = cfg.audio.discardLeadingSamples !== false;
            this.audioPrimingConfigured = true;
        }
        for (const track of cfg.extraAudioTracks ?? []) {
            const config = track.codecConfig ? new Uint8Array(track.codecConfig) : undefined;
            if (track.codec.startsWith('opus')) {
                configuredCodecDelaySamples(track, track.primingSamples ?? 0, config);
            }
            this.extraAudioConfigs.push(config);
            this.extraAudioTimelineShiftSeconds.push(null);
            this.extraEncodedAudioSamples.push(0);
        }
        for (const track of cfg.extraVideoTracks ?? []) {
            this.extraVideoConfigs.push(track.codecConfig);
            this.extraVideoDisplays.push(normalizeMatroskaDisplay(track));
        }

        // The track entries are built once ahead: a configuration they cannot state is one
        // Matroska does not carry (FORMAT), not a failed write.
        try {
            this.buildTracks(true);
        } catch (error) {
            if (error instanceof MediaForgeError && error.code === 'MUX')
                throw new MediaForgeError(error.message, 'FORMAT', { cause: error });
            throw error;
        }
    }

    setMatroskaPassThrough(pass: MatroskaPassThrough): void {
        if (this.streamingHeaderWritten || this.finalizedFlag) {
            throw new MediaForgeError(
                'Matroska metadata must be configured before writing the header',
                'MUX',
            );
        }

        const { chapters, attachments, title, tags } = pass;
        if (title !== undefined && typeof title !== 'string') {
            throw new MediaForgeError('Matroska title must be a string', 'FORMAT');
        }
        for (const bytes of [chapters, attachments, tags]) {
            if (bytes !== undefined && !(bytes instanceof Uint8Array)) {
                throw new MediaForgeError(
                    'Matroska metadata elements must be Uint8Array values',
                    'FORMAT',
                );
            }
        }
        if (this.cfg.format === 'webm' && (chapters !== undefined || attachments !== undefined)) {
            throw new MediaForgeError(
                'Matroska chapters and attachments require mkv output',
                'FORMAT',
            );
        }

        const filtered = filterMatroskaTags(
            { chapters, attachments, tags },
            this.cfg.format,
            this.trackUids.map(matroskaTrackUid => ({ matroskaTrackUid })),
        );

        this.passThrough = {
            chapters: chapters ? new Uint8Array(chapters) : undefined,
            attachments: attachments ? new Uint8Array(attachments) : undefined,
            title: title ?? this.cfg.title,
            tags: mergeMatroskaTrackTitles(filtered.tags, this.titledTracks),
        };
    }

    setVideoColour(colour: VideoColour): void {
        if (this.streamingHeaderWritten || this.sawVideoChunk)
            throw new MediaForgeError(
                'video colour must be set before the first MKV/WebM video chunk',
                'MUX',
            );
        const value = snapshotVideoColour(colour);
        this.cfg.videoColour = value;
        if (this.cfg.video) this.cfg.video.colour = value;
    }

    setAudioCodecConfig(codecConfig: Uint8Array): void {
        // FLAC frames do not depend on STREAMINFO: one given after the first chunk goes into the
        // header, or over it at finalize.
        const flac = this.cfg.audio?.codec === 'flac' && flacStreamInfoRecord(codecConfig);
        if (flac) {
            if (this.streamingHeaderWritten) this.lateFlacRecord = flac.slice();
            else this.audioConfig = new Uint8Array(codecConfig);
            return;
        }
        if (
            this.sawAudioChunk ||
            (this.streamingHeaderWritten && !this.headerDeclaresOpusHead(codecConfig))
        ) {
            throw new MediaForgeError(
                'Set the audio codec configuration before the first audio chunk',
                'MUX',
            );
        }

        const next = new Uint8Array(codecConfig);
        if (this.streamingHeaderWritten) {
            this.audioConfig = next;
            return;
        }

        if (this.cfg.audio) describeMatroskaPcm({ ...this.cfg.audio, codecConfig: next });
        if (this.cfg.audio?.codec.startsWith('opus')) {
            const preSkip = parseOpusHead(
                next,
                this.cfg.audio.channelCount || 2,
                this.cfg.audio.sampleRate || 48000,
            ).preSkip;
            if (this.audioCodecDelayExplicit && this.audioCodecDelaySamples !== preSkip) {
                throw new MediaForgeError(
                    `Opus codecDelaySamples ${this.audioCodecDelaySamples} must equal OpusHead ` +
                        `pre-skip ${preSkip}`,
                    'MUX',
                );
            }
            this.audioCodecDelaySamples = preSkip;
        }
        this.audioConfig = next;
    }

    /**
     * Whether a streamed header written before the Opus configuration arrived already declares this
     * OpusHead; the input sample rate field is informational and may differ.
     */
    private headerDeclaresOpusHead(codecConfig: Uint8Array): boolean {
        const audio = this.cfg.audio;
        if (!audio?.codec.startsWith('opus') || this.audioConfig) return false;
        const written = parseOpusHead(
            new Uint8Array(0),
            audio.channelCount || 2,
            audio.sampleRate || 48000,
        ).head;
        const actual = parseOpusHead(
            codecConfig,
            audio.channelCount || 2,
            audio.sampleRate || 48000,
        ).head;
        return (
            actual.length === written.length &&
            actual.every((byte, index) => (index >= 12 && index < 16) || byte === written[index])
        );
    }

    addSubtitleChunk(chunk: EncodedPacket, trackIndex = 0): void {
        assertOpen(this.finalizedFlag);
        const subs = this.cfg.subtitleTracks ?? [];
        if (subs.length === 0)
            throw new MediaForgeError(
                'addSubtitleChunk on a muxer configured without subtitle tracks',
                'MUX',
            );
        if (this.cfg.format !== 'mkv' && this.cfg.format !== 'webm') {
            throw new MediaForgeError(
                'Subtitle tracks are written for mkv/webm output only',
                'FORMAT',
            );
        }
        if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= subs.length) {
            throw new MediaForgeError(`subtitle track ${trackIndex} is not configured`, 'MUX');
        }

        validateChunkTiming(chunk, this.timeUnitsPerSecond);
        if (subs[trackIndex]!.codec === 'tx3g') {
            // 3GPP timed text becomes S_TEXT/UTF8: the cue text, its bold, italic and underline
            // styles as SubRip tags. An empty sample only ends the previous cue, which the block
            // duration already does.
            const text = tx3gSubRip(chunk.data);
            if (!text.length) return;
            chunk = { ...chunk, data: new TextEncoder().encode(text) };
        }

        if (this.streaming)
            this.subtitlePackets.push({
                chunk: snapshotChunk(chunk),
                trackNum: this.subtitleTrackNumber(trackIndex),
            });
        else this.intake({ chunk, trackNum: this.subtitleTrackNumber(trackIndex) });
    }

    private primaryAudioTrackNumber(): number {
        return this.trackNumbers[this.cfg.video ? 1 : 0]!;
    }

    private isPrimaryAudio(packet: BufferedPacket): boolean {
        return (
            this.cfg.audio !== undefined &&
            packet.chunk.trackType === 'audio' &&
            packet.trackNum === this.primaryAudioTrackNumber()
        );
    }

    private extraAudioTrackNumber(index: number): number {
        return this.trackNumbers[
            (this.cfg.video ? 1 : 0) +
                (this.cfg.audio ? 1 : 0) +
                (this.cfg.subtitleTracks?.length ?? 0) +
                index
        ]!;
    }

    private subtitleTrackNumber(index: number): number {
        return this.trackNumbers[(this.cfg.video ? 1 : 0) + (this.cfg.audio ? 1 : 0) + index]!;
    }

    private extraVideoTrackNumber(index: number): number {
        return this.trackNumbers[
            (this.cfg.video ? 1 : 0) +
                (this.cfg.audio ? 1 : 0) +
                (this.cfg.subtitleTracks?.length ?? 0) +
                (this.cfg.extraAudioTracks?.length ?? 0) +
                index
        ]!;
    }

    private get streaming(): boolean {
        return this.cfg.mode === 'fragmented';
    }

    /**
     * Appends one encoded video chunk; `codecConfig` on the first call carries the decoder
     * configuration record.
     */
    addVideoChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        this.addVideoPacket(-1, chunk, codecConfig);
    }

    addExtraVideoChunk(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= (this.cfg.extraVideoTracks?.length ?? 0)
        )
            throw new MediaForgeError(
                `addExtraVideoChunk index ${index} has no configured track`,
                'MUX',
            );
        this.addVideoPacket(index, chunk, codecConfig);
    }

    private addVideoPacket(index: number, chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        const video = index < 0 ? this.cfg.video : this.cfg.extraVideoTracks?.[index];
        let config = index < 0 ? this.videoConfig : this.extraVideoConfigs[index];
        checkChunk('addVideoChunk', chunk, 'video', this.finalizedFlag);
        if (!video)
            throw new MediaForgeError('addVideoChunk on a muxer configured without video', 'MUX');
        validateChunkTiming(chunk, this.timeUnitsPerSecond);
        if (
            chunk.alphaData !== undefined &&
            (!video.alphaMode ||
                !(chunk.alphaData instanceof Uint8Array) ||
                chunk.alphaData.length === 0)
        ) {
            throw new MediaForgeError(
                'Alpha packet requires non-empty bytes and a video track with alphaMode',
                'MUX',
            );
        }
        const codec = video.codec;
        if (isProResCodec(codec)) {
            const error = proResFrameError(chunk.data, video);
            if (error) throw new MediaForgeError(error, 'MUX');
            if (codecConfig) validateCodecConfig(codec, codecConfig, false);
            chunk = { ...chunk, data: chunk.data.subarray(8) };
        }
        if (
            (codec.startsWith('vp8') || codec.startsWith('vp09') || codec.startsWith('vp9')) &&
            chunk.data.length >= 5
        ) {
            const d = chunk.data;
            const annexB = d[0] === 0 && d[1] === 0 && (d[2] === 1 || (d[2] === 0 && d[3] === 1));
            const avccLen = u32be(d, 0);
            const looksAvcc =
                avccLen > 0 &&
                avccLen === d.length - 4 &&
                (d[4]! & 0x1f) >= 1 &&
                (d[4]! & 0x1f) <= 23;
            if (annexB || looksAvcc) {
                throw new MediaForgeError(
                    `Video payload looks like H.264 but the track is declared '${codec}'`,
                    'MUX',
                );
            }
        }
        if (codecConfig && !config) config = new Uint8Array(codecConfig);
        const hevc = codec.startsWith('hev1') || codec.startsWith('hvc1');
        if (hevc || codec.startsWith('avc')) {
            const configByte = config?.[hevc ? 21 : 4];
            const width = (configByte === undefined ? 4 : (configByte & 3) + 1) as 1 | 2 | 3 | 4;
            const validWalk = hevc ? isValidHevcWalk : isValidAvccWalk;
            if (!validWalk(chunk.data, width) && isAnnexB(chunk.data)) {
                if (!config)
                    config =
                        (hevc ? buildHevcCFromAnnexB : buildAvcCFromAnnexB)(chunk.data) ??
                        undefined;
                chunk = { ...chunk, data: annexBToAvcc(chunk.data, width) };
            }
        }
        if (index < 0) {
            this.sawVideoChunk = true;
            this.videoConfig = config;
        } else {
            this.seenExtraVideo.add(index);
            this.extraVideoConfigs[index] = config;
        }

        // V_MS/VFW/FOURCC keeps AVI's timing: readers take its block times as decode times and
        // reorder the pictures themselves, so B-picture streams are stamped in decode order.
        if (isWindowsMediaVideo(codec) && chunk.decodeTimestamp !== undefined)
            chunk = { ...chunk, timestamp: chunk.decodeTimestamp, compositionTimeOffset: 0 };
        this.intake({
            chunk,
            trackNum: index < 0 ? this.trackNumbers[0]! : this.extraVideoTrackNumber(index),
        });
    }

    /** Copied secondary audio tracks, same contract as Mp4Muxer. */
    addExtraAudioChunk(index: number, chunk: EncodedPacket, codecCfg?: Uint8Array): void {
        checkChunk('addExtraAudioChunk', chunk, 'audio', this.finalizedFlag);
        const extras = this.cfg.extraAudioTracks ?? [];
        if (!Number.isInteger(index) || index < 0 || index >= extras.length) {
            throw new MediaForgeError(
                `addExtraAudioChunk index ${index} has no configured track`,
                'MUX',
            );
        }
        validateChunkTiming(chunk, this.timeUnitsPerSecond);
        this.validatePcmChunk(chunk, this.extraAudioTrackNumber(index));
        if (codecCfg && !this.extraAudioConfigs[index]) {
            const next = new Uint8Array(codecCfg);
            const track = extras[index]!;
            describeMatroskaPcm({ ...track, codecConfig: next });
            if (track.codec.startsWith('opus')) {
                configuredCodecDelaySamples(track, track.primingSamples ?? 0, next);
            }
            this.extraAudioConfigs[index] = next;
        }
        if (this.extraAudioTimelineShiftSeconds[index] === null) {
            const track = extras[index]!;
            const rate = this.audioTimingRateFor(track);
            const tolerance = 0.5 / rate;
            const priming = this.extraAudioPrimingSamples(index);
            const codecDelay = this.extraAudioCodecDelaySamples(index);

            const shiftSamples = audioTimelineShiftSamples(
                track.codec,
                priming,
                codecDelay,
                track.presentationTimestamps === true,
                chunk.timestamp < -tolerance,
            );
            this.extraAudioTimelineShiftSeconds[index] = shiftSamples / rate;
        }
        this.seenExtraAudio.add(index);
        this.intake({ chunk, trackNum: this.extraAudioTrackNumber(index) });
    }

    /**
     * Appends one encoded audio chunk; `codecConfig` on the first call carries decoder
     * configuration where the container stores it.
     */
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        checkChunk('addAudioChunk', chunk, 'audio', this.finalizedFlag);
        if (!this.cfg.audio)
            throw new MediaForgeError('addAudioChunk on a muxer configured without audio', 'MUX');

        validateChunkTiming(chunk, this.timeUnitsPerSecond);
        this.validatePcmChunk(chunk, this.primaryAudioTrackNumber());
        const aCodec = this.cfg.audio.codec;
        if (aCodec.startsWith('opus') && chunk.data.length >= 2) {
            const d = chunk.data;
            const looksAdts = d[0] === 0xff && (d[1]! & 0xf0) === 0xf0;
            const looksLoas = d[0] === 0x56 && (d[1]! & 0xe0) === 0xe0;
            if (looksAdts || looksLoas) {
                const framing = looksAdts ? 'ADTS' : 'LOAS';
                throw new MediaForgeError(
                    `Audio looks like ${framing} AAC, but the track is '${aCodec}'`,
                    'MUX',
                );
            }
        }

        if (codecConfig && !this.audioConfig) this.setAudioCodecConfig(codecConfig);
        this.sawAudioChunk = true;
        if (this.audioTimelineShiftSeconds === null) {
            const tolerance = 0.5 / this.audioTimingRate();
            const shiftSamples = audioTimelineShiftSamples(
                this.cfg.audio.codec,
                this.audioPrimingSamples,
                this.audioCodecDelaySamples,
                this.audioPrimingPresentationTimestamps,
                chunk.timestamp < -tolerance,
            );
            this.audioTimelineShiftSeconds = shiftSamples / this.audioTimingRate();
        }

        this.intake({ chunk, trackNum: this.primaryAudioTrackNumber() });
    }

    private validatePcmChunk(chunk: EncodedPacket, trackNum: number): void {
        const pcm = this.pcmFormats.get(trackNum);
        if (!pcm) return;
        if (chunk.data.length === 0 || chunk.data.length % pcm.blockAlign !== 0)
            throw new MediaForgeError(
                'Matroska PCM chunks must contain complete channel frames',
                'MUX',
            );
        if (Math.abs(chunk.duration * pcm.sampleRate - chunk.data.length / pcm.blockAlign) > 0.5)
            throw new MediaForgeError(
                'Matroska PCM duration must match its complete channel frames',
                'MUX',
            );
    }

    private audioTimingRate(): number {
        return this.audioTimingRateFor(this.cfg.audio);
    }

    private audioTimingRateFor(track: AudioTrackConfig | undefined): number {
        if (track?.codec.startsWith('opus')) return 48000;
        return Math.max(1, track?.sampleRate || 48000);
    }

    private aacSamplesPerAccessUnit(): number {
        if (!this.cfg.audio?.codec.startsWith('mp4a')) return 0;
        return this.aacSamplesPerAccessUnitFor(this.cfg.audio, this.audioConfig);
    }

    private aacSamplesPerAccessUnitFor(
        track: AudioTrackConfig,
        config: Uint8Array | undefined,
    ): number {
        if (!track.codec.startsWith('mp4a')) return 0;
        return (
            (config ? parseAacAudioSpecificConfig(config)?.samplesPerAccessUnit : undefined) ?? 1024
        );
    }

    private encodedAudioSamples(): number {
        if (this.cfg.audio?.codec.startsWith('mp4a')) {
            return this.audioPacketCount * this.aacSamplesPerAccessUnit();
        }
        return this.streamEncodedAudioSamples;
    }

    private leadingDiscardPaddingNs(): number {
        if (!this.audioLeadingDiscardEnabled || this.audioPrimingSamples <= 0) return 0;
        if (this.cfg.audio?.codec.startsWith('opus')) {
            const preSkip = parseOpusHead(
                this.audioConfig,
                this.cfg.audio.channelCount || 2,
                this.cfg.audio.sampleRate || 48000,
            ).preSkip;
            const explicit = Math.max(0, this.audioPrimingSamples - preSkip);
            return -Math.round(explicit * (1_000_000_000 / 48000));
        }
        return -Math.round(this.audioPrimingSamples * (1_000_000_000 / this.audioTimingRate()));
    }

    private extraAudioIndex(packet: BufferedPacket): number | null {
        if (packet.chunk.trackType !== 'audio') return null;
        return this.extraAudioIndices.get(packet.trackNum) ?? null;
    }

    private audioPacketStats(packets: readonly BufferedPacket[]): Map<number, AudioPacketStats> {
        const result = new Map<number, AudioPacketStats>();
        for (const packet of packets) {
            if (packet.chunk.trackType !== 'audio') continue;
            let stats = result.get(packet.trackNum);
            if (!stats) {
                const index = this.extraAudioIndex(packet);
                const rate =
                    index === null
                        ? this.audioTimingRate()
                        : this.audioTimingRateFor(this.cfg.extraAudioTracks![index]!);
                stats = { first: packet, last: packet, count: 0, samples: 0, rate };
                result.set(packet.trackNum, stats);
            }
            stats.last = packet;
            stats.count++;
            stats.samples += Math.max(0, Math.round((packet.chunk.duration ?? 0) * stats.rate));
        }
        return result;
    }

    private extraAudioPrimingSamples(index: number): number {
        return Math.max(0, Math.round(this.cfg.extraAudioTracks?.[index]?.primingSamples ?? 0));
    }

    private extraAudioCodecDelaySamples(index: number): number {
        const track = this.cfg.extraAudioTracks?.[index];
        if (!track) return 0;
        return Math.max(
            0,
            Math.round(
                configuredCodecDelaySamples(
                    track,
                    this.extraAudioPrimingSamples(index),
                    this.extraAudioConfigs[index],
                ),
            ),
        );
    }

    private packetTimestamp(packet: BufferedPacket, decode = false): number {
        const base = decode ? decodeTime(packet.chunk) : packet.chunk.timestamp;
        if (this.isPrimaryAudio(packet)) return base + (this.audioTimelineShiftSeconds ?? 0);
        const extraIndex = this.extraAudioIndex(packet);
        if (extraIndex !== null)
            return base + (this.extraAudioTimelineShiftSeconds[extraIndex] ?? 0);
        return base;
    }

    private intake(packet: BufferedPacket): void {
        packet = { chunk: snapshotChunk(packet.chunk, true), trackNum: packet.trackNum };
        if (this.isPrimaryAudio(packet)) {
            this.audioPacketCount++;
            this.streamEncodedAudioSamples += Math.max(
                0,
                Math.round((packet.chunk.duration ?? 0) * this.audioTimingRate()),
            );
        }

        const extraAudio = this.extraAudioIndex(packet);
        if (extraAudio !== null) {
            const track = this.cfg.extraAudioTracks![extraAudio]!;
            this.extraEncodedAudioSamples[extraAudio]! += track.codec.startsWith('mp4a')
                ? this.aacSamplesPerAccessUnitFor(track, this.extraAudioConfigs[extraAudio])
                : Math.max(0, Math.round(packet.chunk.duration * this.audioTimingRateFor(track)));
        }

        const dtsTicks = secondsToTicks(
            this.packetTimestamp(packet, true),
            this.timeUnitsPerSecond,
            'Matroska decode timestamp',
        );
        if (!this.streamingHeaderWritten && !this.tracksDeclarable()) {
            if (this.pendingPackets.length === 0) this.pendingStartTicks = Math.max(0, dtsTicks);
            this.pendingPackets.push(packet);
            return;
        }

        this.writeStreamingHeaderOnce();
        if (this.pendingPackets.length === 0) this.pendingStartTicks = Math.max(0, dtsTicks);

        const canCut =
            (!this.cfg.video && !this.cfg.extraVideoTracks?.length) ||
            (packet.chunk.trackType === 'video' && packet.chunk.isKeyframe === true);
        const overLimit = dtsTicks - this.pendingStartTicks >= 2 * this.timeUnitsPerSecond;
        const wayOver = dtsTicks - this.pendingStartTicks >= 16000;
        if ((overLimit && canCut) || wayOver) {
            this.flushPendingCluster(false);
            this.pendingStartTicks = Math.max(0, dtsTicks);
        }

        this.pendingPackets.push(packet);
    }

    private streamBytesWritten = 0;
    private streamDurationPatchOffset = -1;
    private streamEndSec = 0;

    /**
     * Standard output waits for the decoder configuration that encoders deliver with each track's
     * first packet. Fragmented output, written as it comes, waits only for the configurations its
     * track entries need: an encoder writing Annex B gives its parameter sets with its first
     * keyframe, which may come after the first sound.
     */
    private tracksDeclarable(): boolean {
        const ready = (codec: string, config: Uint8Array | undefined, seen: boolean): boolean =>
            config !== undefined ||
            seen ||
            (this.streaming && requiredCodecConfig(codec) === undefined);
        const { video, audio } = this.cfg;
        return (
            (!video || ready(video.codec, this.videoConfig, this.sawVideoChunk)) &&
            (!audio || ready(audio.codec, this.audioConfig, this.sawAudioChunk)) &&
            (this.cfg.extraVideoTracks ?? []).every((track, index) =>
                ready(track.codec, this.extraVideoConfigs[index], this.seenExtraVideo.has(index)),
            ) &&
            (this.cfg.extraAudioTracks ?? []).every((track, index) =>
                ready(track.codec, this.extraAudioConfigs[index], this.seenExtraAudio.has(index)),
            )
        );
    }

    private streamWrite(data: Uint8Array): void {
        this.sink.write(data);
        this.streamBytesWritten += data.length;
    }

    private writeStreamingHeaderOnce(): void {
        if (this.streamingHeaderWritten) return;

        const tracks = this.buildTracks();
        const segInfo = this.buildSegmentInfo(0, typeof this.sink.patchAt === 'function');
        this.streamingHeaderWritten = true;
        const patchable = typeof this.sink.patchAt === 'function';

        this.streamWrite(this.buildEbmlHeader());
        if (patchable && !this.streaming) {
            // The segment size, the SeekHead to the Cues and the duration are patched once the
            // clusters are written.
            const sizeOffset = this.streamBytesWritten + 4;
            this.streamWrite(Uint8Array.from([0x18, 0x53, 0x80, 0x67, 0x01, 0, 0, 0, 0, 0, 0, 0]));
            const dataStart = this.streamBytesWritten;
            this.streamWrite(buildSeekHeadForCues(0));
            this.indexed = {
                sizeOffset,
                seekHeadOffset: dataStart,
                dataStart,
                times: [],
                offsets: [],
                tracks: [],
            };
        } else
            this.streamWrite(
                Uint8Array.from([
                    0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
                ]),
            );

        if (patchable) {
            const inSegInfo = findDurationPayloadOffset(segInfo);
            if (inSegInfo >= 0)
                this.streamDurationPatchOffset = this.streamBytesWritten + inSegInfo;
        }

        this.streamWrite(segInfo);
        const flac = patchable && this.cfg.audio?.codec === 'flac' && this.audioConfig;
        const flacAt = flac ? flacStreamInfoAt(tracks, flac) : -1;
        if (flacAt >= 0) this.flacRecordAt = this.streamBytesWritten + flacAt;
        this.streamWrite(tracks);
        if (this.passThrough.tags) this.streamWrite(this.passThrough.tags);
        if (this.passThrough.chapters) this.streamWrite(this.passThrough.chapters);
        if (this.passThrough.attachments) this.streamWrite(this.passThrough.attachments);
    }

    private flushPendingCluster(isFinal: boolean): void {
        if (this.pendingPackets.length === 0) return;
        let flushEnd = this.pendingPackets.length;
        if (!isFinal) {
            const last = new Map<number, number>();
            this.pendingPackets.forEach((packet, index) => {
                if (
                    (this.isPrimaryAudio(packet) && this.validAudioSamples !== null) ||
                    (this.extraAudioIndex(packet) !== null &&
                        this.cfg.extraAudioTracks![this.extraAudioIndex(packet)!]!.validSamples !==
                            undefined)
                )
                    last.set(packet.trackNum, index);
            });
            for (const index of last.values()) flushEnd = Math.min(flushEnd, index);
        }

        if (flushEnd === 0) return;
        const packets = this.pendingPackets.slice(0, flushEnd);
        if (!this.streaming) {
            const dtsOf = (p: BufferedPacket): number => this.packetTimestamp(p, true);
            packets.sort((a, b) => dtsOf(a) - dtsOf(b) || a.trackNum - b.trackNum);
        }

        const trailingPad = isFinal ? this.finalDiscardPaddingNs() : 0;
        const leadingPad = this.leadingAudioDiscardWritten ? 0 : this.leadingDiscardPaddingNs();
        const audioStats = this.audioPacketStats(packets);
        const primaryAudio = this.cfg.audio
            ? audioStats.get(this.primaryAudioTrackNumber())
            : undefined;
        const firstAudio = primaryAudio?.first;
        const lastAudio = primaryAudio?.last;

        // The duration ends with the last sound presented: readers subtract CodecDelay from the
        // block times, start the sound after the leading discard and drop the final block's
        // padding.
        const soundLead = this.cfg.audio
            ? this.audioCodecDelaySamples / this.audioTimingRate() -
              this.leadingDiscardPaddingNs() / 1e9
            : 0;

        for (const p of packets) {
            let end = this.packetTimestamp(p) + (p.chunk.duration || 0);
            if (this.isPrimaryAudio(p))
                end -= soundLead + (p === lastAudio ? trailingPad / 1e9 : 0);
            if (end > this.streamEndSec) this.streamEndSec = end;
        }

        const discardPadding = new Map<BufferedPacket, number>();
        if (leadingPad < 0 && firstAudio) {
            this.setPacketDiscardPadding(discardPadding, firstAudio, leadingPad, 'primary audio');
        }
        if (trailingPad > 0 && lastAudio) {
            this.setPacketDiscardPadding(discardPadding, lastAudio, trailingPad, 'primary audio');
        }

        for (let index = 0; index < (this.cfg.extraAudioTracks?.length ?? 0); index++) {
            const selected = audioStats.get(this.extraAudioTrackNumber(index));
            if (!selected) continue;
            const leading = this.extraLeadingDiscardWritten.has(index)
                ? 0
                : this.extraLeadingDiscardPaddingNs(index);
            const trailing = isFinal ? this.extraFinalDiscardPaddingNs(index) : 0;
            if (leading < 0)
                this.setPacketDiscardPadding(
                    discardPadding,
                    selected.first,
                    leading,
                    `extra audio track ${index}`,
                );
            if (trailing > 0)
                this.setPacketDiscardPadding(
                    discardPadding,
                    selected.last,
                    trailing,
                    `extra audio track ${index}`,
                );
            if (leading < 0) this.extraLeadingDiscardWritten.add(index);
        }

        // A packet that drops its last samples (files joined end to end) keeps its padding.
        for (const packet of packets) {
            const samples = packet.chunk.trailingDiscard;
            if (!samples || packet.chunk.trackType !== 'audio' || discardPadding.has(packet))
                continue;
            const extra = this.extraAudioIndex(packet);
            const track = extra === null ? this.cfg.audio : this.cfg.extraAudioTracks?.[extra];
            this.setPacketDiscardPadding(
                discardPadding,
                packet,
                secondsToTicks(
                    samples / this.audioTimingRateFor(track),
                    1e9,
                    'Matroska discard padding',
                ),
                extra === null ? 'primary audio' : `extra audio track ${extra}`,
            );
        }

        const indexed = this.indexed;
        this.writeClusters(packets, discardPadding, (cluster, startTicks, cueTrack) => {
            if (indexed) {
                indexed.times.push(startTicks);
                indexed.offsets.push(this.streamBytesWritten - indexed.dataStart);
                indexed.tracks.push(cueTrack);
            }
            this.streamWrite(handOffOutput(cluster));
        });

        if (leadingPad < 0 && firstAudio) this.leadingAudioDiscardWritten = true;
        for (const packet of packets) releaseBytes(packet.chunk.data);
        this.pendingPackets = this.pendingPackets.slice(flushEnd);
    }

    private extraLeadingDiscardPaddingNs(index: number): number {
        const track = this.cfg.extraAudioTracks![index]!;
        const priming = this.extraAudioPrimingSamples(index);
        const explicit = track.codec.startsWith('opus')
            ? Math.max(0, priming - this.extraAudioCodecDelaySamples(index))
            : priming;
        return track.discardLeadingSamples === false
            ? 0
            : -Math.round(explicit * (1_000_000_000 / this.audioTimingRateFor(track)));
    }

    private extraFinalDiscardPaddingNs(index: number): number {
        const track = this.cfg.extraAudioTracks![index]!;
        if (track.validSamples === undefined) return 0;
        return trailingDiscardPaddingNs(
            `Extra audio track ${index}`,
            this.extraEncodedAudioSamples[index]!,
            this.extraAudioPrimingSamples(index),
            track.validSamples,
            this.audioTimingRateFor(track),
        );
    }

    private finalDiscardPaddingNs(): number {
        if (this.validAudioSamples === null) return 0;
        return trailingDiscardPaddingNs(
            'Primary audio',
            this.encodedAudioSamples(),
            this.audioPrimingSamples,
            this.validAudioSamples,
            this.audioTimingRate(),
        );
    }

    private setPacketDiscardPadding(
        target: Map<BufferedPacket, number>,
        packet: BufferedPacket,
        paddingNs: number,
        trackLabel: string,
    ): void {
        if (paddingNs === 0) return;
        if (paddingNs > 0) {
            const extraIndex = this.extraAudioIndex(packet);
            const track =
                extraIndex === null ? this.cfg.audio : this.cfg.extraAudioTracks?.[extraIndex];
            const config =
                extraIndex === null ? this.audioConfig : this.extraAudioConfigs[extraIndex];
            const rate = this.audioTimingRateFor(track);
            const lastPacketSamples = track?.codec.startsWith('mp4a')
                ? this.aacSamplesPerAccessUnitFor(track, config)
                : Math.max(0, Math.round((packet.chunk.duration ?? 0) * rate));
            const paddingSamples = Math.max(0, Math.round((paddingNs * rate) / 1_000_000_000));
            if (paddingSamples > lastPacketSamples) {
                throw new MediaForgeError(
                    `Matroska ${trackLabel} trim is longer than the final packet`,
                    'MUX',
                );
            }
        }

        if (target.has(packet)) {
            throw new MediaForgeError(
                `A Matroska ${trackLabel} block cannot have both leading and trailing padding`,
                'MUX',
            );
        }
        target.set(packet, paddingNs);
    }

    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    async finalize(): Promise<void> {
        assertOpen(this.finalizedFlag);
        this.finalizedFlag = true;
        try {
            await this.finalizeContainer();
        } finally {
            this.pendingPackets.length = 0;
            this.subtitlePackets.length = 0;
        }
    }

    private async finalizeContainer(): Promise<void> {
        if (this.cfg.video && !this.sawVideoChunk) {
            throw unfedTrack('video');
        }
        if (this.cfg.audio && !this.sawAudioChunk) {
            throw unfedTrack('audio');
        }
        if (this.seenExtraVideo.size !== (this.cfg.extraVideoTracks?.length ?? 0))
            throw unfedTrack('video', 'extra ');
        if (this.seenExtraAudio.size !== (this.cfg.extraAudioTracks?.length ?? 0))
            throw unfedTrack('audio', 'extra ');

        this.writeStreamingHeaderOnce();
        for (const sub of this.sortedSubtitlePackets()) this.pendingPackets.push(sub);
        const dtsOf = (p: BufferedPacket): number => this.packetTimestamp(p, true);
        this.pendingPackets.sort((a, b) => dtsOf(a) - dtsOf(b) || a.trackNum - b.trackNum);
        this.flushPendingCluster(true);

        if (this.streamDurationPatchOffset >= 0 && this.sink.patchAt) {
            const d = new Uint8Array(8);
            new DataView(d.buffer).setFloat64(
                0,
                this.streamEndSec * this.timeUnitsPerSecond,
                false,
            );
            this.sink.patchAt(this.streamDurationPatchOffset, d);
        }
        if (this.lateFlacRecord && this.flacRecordAt >= 0)
            this.sink.patchAt!(this.flacRecordAt, this.lateFlacRecord);

        const indexed = this.indexed;
        if (indexed && this.sink.patchAt) {
            const cuesPos = this.streamBytesWritten - indexed.dataStart;
            this.streamWrite(buildCues(indexed.times, indexed.offsets, indexed.tracks));
            this.sink.patchAt(indexed.seekHeadOffset, buildSeekHeadForCues(cuesPos));
            const size = new Uint8Array(8);
            const view = new DataView(size.buffer);
            view.setUint32(
                0,
                0x01000000 + Math.floor((this.streamBytesWritten - indexed.dataStart) / 2 ** 32),
            );
            view.setUint32(4, (this.streamBytesWritten - indexed.dataStart) >>> 0);
            this.sink.patchAt(indexed.sizeOffset, size);
        }

        await this.sink.close();
    }

    private sortedSubtitlePackets(): BufferedPacket[] {
        return this.subtitlePackets
            .slice()
            .sort((a, b) => a.chunk.timestamp - b.chunk.timestamp)
            .map(p => ({ chunk: p.chunk, trackNum: p.trackNum }));
    }

    private buildEbmlHeader(): Uint8Array {
        const docType = this.cfg.format === 'mkv' ? 'matroska' : 'webm';
        return ebmlElement(
            0x1a45dfa3,
            concatBytes([
                ebmlUint(0x4286, 1),
                ebmlUint(0x42f7, 1),
                ebmlUint(0x42f2, 4),
                ebmlUint(0x42f3, 8),
                ebmlString(0x4282, docType),
                ebmlUint(0x4287, docType === 'matroska' ? 4 : 2),
                ebmlUint(0x4285, 2),
            ]),
        );
    }

    private buildSegmentInfo(durationSeconds: number, includeDuration = true): Uint8Array {
        return ebmlElement(
            0x1549a966,
            concatBytes([
                ebmlUint(0x2ad7b1, 1_000_000_000 / this.timeUnitsPerSecond),
                ...(includeDuration
                    ? [ebmlFloat(0x4489, durationSeconds * this.timeUnitsPerSecond)]
                    : []),
                ebmlString(0x4d80, 'MediaForgeJS'),
                ebmlString(0x5741, 'MediaForgeJS'),
                ...(this.passThrough.title === undefined
                    ? []
                    : [ebmlString(0x7ba9, this.passThrough.title)]),
            ]),
        );
    }

    private buildTracks(allowMissingConfig = false): Uint8Array {
        const entries: [number, Uint8Array][] = [];
        if (this.cfg.video)
            entries.push([
                this.trackNumbers[0]!,
                this.buildVideoTrackEntry(this.trackNumbers[0]!, allowMissingConfig),
            ]);
        if (this.cfg.audio)
            entries.push([
                this.primaryAudioTrackNumber(),
                this.buildAudioTrackEntry(
                    this.primaryAudioTrackNumber(),
                    undefined,
                    undefined,
                    allowMissingConfig,
                ),
            ]);
        const subs = this.cfg.subtitleTracks ?? [];
        for (let i = 0; i < subs.length; i++) {
            entries.push([
                this.subtitleTrackNumber(i),
                this.buildSubtitleTrackEntry(this.subtitleTrackNumber(i), subs[i]!),
            ]);
        }
        const extras = this.cfg.extraAudioTracks ?? [];
        for (let i = 0; i < extras.length; i++) {
            entries.push([
                this.extraAudioTrackNumber(i),
                this.buildAudioTrackEntry(
                    this.extraAudioTrackNumber(i),
                    extras[i]!,
                    this.extraAudioConfigs[i],
                    allowMissingConfig,
                ),
            ]);
        }
        for (let i = 0; i < (this.cfg.extraVideoTracks?.length ?? 0); i++) {
            entries.push([
                this.extraVideoTrackNumber(i),
                this.buildVideoTrackEntry(this.extraVideoTrackNumber(i), allowMissingConfig, i),
            ]);
        }

        // Entries follow their track numbers, which copies take from the source track IDs, so a
        // copy keeps the order.
        entries.sort((a, b) => a[0] - b[0]);
        return ebmlElement(0x1654ae6b, concatBytes([...entries.map(entry => entry[1])]));
    }

    private buildSubtitleTrackEntry(
        trackNum: number,
        sub: NonNullable<MuxerConfig['subtitleTracks']>[number],
    ): Uint8Array {
        const SUB_IDS: Record<string, string> = {
            'text/utf8': 'S_TEXT/UTF8',
            'text/ass': 'S_TEXT/ASS',
            'text/ssa': 'S_TEXT/SSA',
            'text/webvtt': 'S_TEXT/WEBVTT',
            tx3g: 'S_TEXT/UTF8',
        };

        if (
            this.cfg.format === 'webm' &&
            sub.codec !== 'text/webvtt' &&
            sub.codec !== 'text/utf8'
        ) {
            throw new MediaForgeError(`WebM cannot carry subtitle codec '${sub.codec}'`, 'FORMAT');
        }
        const codecId = sub.codec === 'text/webvtt' ? 'D_WEBVTT/SUBTITLES' : SUB_IDS[sub.codec];
        if (!codecId)
            throw new MediaForgeError(
                `Matroska output cannot label subtitle codec '${sub.codec}'`,
                'FORMAT',
            );

        const children: Uint8Array[] = [
            ebmlUint(0xd7, trackNum),
            ebmlUid(this.trackUids[this.trackNumbers.indexOf(trackNum)]!),
            ebmlUint(0x83, 17),
            ebmlString(0x86, codecId),
            ...languageElements(sub.language),
            ...trackMetadataElements(sub, this.cfg.format),
        ];

        if (sub.codecConfig && sub.codecConfig.length > 0 && sub.codec !== 'tx3g') {
            children.push(ebmlBinary(0x63a2, sub.codecConfig));
        }
        return ebmlElement(0xae, concatBytes([...children]));
    }

    private buildVideoTrackEntry(
        trackNum: number,
        allowMissingConfig = false,
        index = -1,
    ): Uint8Array {
        const video = index < 0 ? this.cfg.video : this.cfg.extraVideoTracks?.[index];
        if (!video) throw new MediaForgeError('The video track is not configured', 'MUX');
        const config = index < 0 ? this.videoConfig : this.extraVideoConfigs[index];
        validateCodecConfig(video.codec, config, allowMissingConfig);
        const codecId = ((): string => {
            const c = video.codec;
            if (typeof c !== 'string')
                throw new MediaForgeError('Matroska video codec must be a string', 'FORMAT');
            if (c.startsWith('vp8')) return 'V_VP8';
            if (c.startsWith('vp09') || c.startsWith('vp9')) return 'V_VP9';
            if (c.startsWith('av01')) return 'V_AV1';
            if (isProResCodec(c)) return 'V_PRORES';
            if (c === MJPEG_VIDEO) {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError(
                        "WebM cannot carry Motion JPEG; use format 'mkv'",
                        'FORMAT',
                    );
                }
                return 'V_MJPEG';
            }

            if (c.startsWith('avc')) {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError(
                        "WebM cannot carry H.264; use format 'mkv'",
                        'FORMAT',
                    );
                }
                return 'V_MPEG4/ISO/AVC';
            }

            if (isHevcCodec(c)) {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError(
                        "WebM cannot carry H.265; use format 'mkv'",
                        'FORMAT',
                    );
                }
                return 'V_MPEGH/ISO/HEVC';
            }

            if (isVvcCodec(c) || c === 'theora' || isWindowsMediaVideo(c) || c === DV_VIDEO) {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError(
                        `WebM cannot carry video codec '${c}'; use format 'mkv'`,
                        'FORMAT',
                    );
                }
                return isVvcCodec(c)
                    ? 'V_MPEGI/ISO/VVC'
                    : c === 'theora'
                      ? 'V_THEORA'
                      : 'V_MS/VFW/FOURCC';
            }

            const mpeg = mpegVideoFamily(c);
            if (mpeg) {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError(
                        `WebM cannot carry MPEG video '${c}'; use format 'mkv'`,
                        'FORMAT',
                    );
                }
                return mpeg === 'mpeg4v'
                    ? 'V_MPEG4/ISO/ASP'
                    : mpeg === 'mpeg2v'
                      ? 'V_MPEG2'
                      : 'V_MPEG1';
            }

            throw new MediaForgeError(`Matroska output cannot label video codec '${c}'`, 'FORMAT');
        })();

        const videoChildren: Uint8Array[] = [
            ebmlUint(0xb0, video.width),
            ebmlUint(0xba, video.height),
            ...(video.alphaMode ? [ebmlUint(0x53c0, 1)] : []),
        ];
        const display = index < 0 ? this.display : this.extraVideoDisplays[index];
        if (display) {
            videoChildren.push(ebmlUint(0x54b0, display.width));
            videoChildren.push(ebmlUint(0x54ba, display.height));
            videoChildren.push(ebmlUint(0x54b2, display.unit));
        }
        const colour = index < 0 ? (this.cfg.videoColour ?? video.colour) : video.colour;
        if (colour) videoChildren.push(colourElement(colour));
        videoChildren.push(...fieldOrderElements(video.fieldOrder, this.cfg.format));
        const rotation = (((video.rotation ?? 0) % 360) + 360) % 360;
        if (rotation !== 0) {
            videoChildren.push(
                ebmlElement(
                    0x7670,
                    concatBytes([
                        ebmlUint(0x7671, 0),
                        ebmlFloat(0x7675, rotation > 180 ? rotation - 360 : rotation),
                    ]),
                ),
            );
        }

        const trackChildren: Uint8Array[] = [
            ebmlUint(0xd7, trackNum),
            ebmlUid(this.trackUids[this.trackNumbers.indexOf(trackNum)]!),
            ebmlUint(0x83, 1),
            ebmlString(0x86, codecId),
            ...languageElements(index < 0 ? this.cfg.videoLanguage : video.language),
            ...trackMetadataElements(video, this.cfg.format),
            ...(video.alphaMode ? [ebmlUint(0x55ee, 1)] : []),
        ];
        if (video.framerate > 0) {
            trackChildren.push(
                ebmlUint(0x23e383, Math.max(1, Math.round(1_000_000_000 / video.framerate))),
            );
        }
        if (codecId === 'V_PRORES')
            trackChildren.push(ebmlBinary(0x63a2, textEncoder.encode(video.codec)));
        else if (codecId === 'V_VP9' && isVpcC(config))
            trackChildren.push(ebmlBinary(0x63a2, webmVp9Features(config)!));
        else if (codecId === 'V_MS/VFW/FOURCC')
            trackChildren.push(
                ebmlBinary(
                    0x63a2,
                    buildBitmapInfoHeader(
                        windowsMediaVideoFourcc(video.codec) ?? DV_WRITE_FOURCC,
                        video.width,
                        video.height,
                        config,
                    ),
                ),
            );
        else if (config && config.length > 0) trackChildren.push(ebmlBinary(0x63a2, config));
        const dolbyVision = video.dolbyVisionConfig;
        const dolbyParsed =
            codecId === 'V_MPEGH/ISO/HEVC' ? parseDolbyVisionConfig(dolbyVision) : undefined;
        if (dolbyVision && dolbyParsed) {
            const type = dolbyVisionBoxType(dolbyParsed);
            trackChildren.push(
                ebmlElement(
                    0x41e4,
                    concatBytes([
                        ebmlUint(0x41e7, type === 'dvcC' ? 0x64766343 : 0x64767643),
                        ebmlBinary(0x41ed, dolbyVision),
                    ]),
                ),
            );
        }
        trackChildren.push(ebmlElement(0xe0, concatBytes([...videoChildren])));
        return ebmlElement(0xae, concatBytes([...trackChildren]));
    }

    private buildAudioTrackEntry(
        trackNum: number,
        audioOverride?: AudioTrackConfig,
        configOverride?: Uint8Array,
        allowMissingConfig = false,
    ): Uint8Array {
        const audio = audioOverride ?? this.cfg.audio;
        if (!audio) throw new MediaForgeError('The audio track is not configured', 'MUX');
        const pcm = this.pcmFormats.get(trackNum);
        validateCodecConfig(
            audio.codec,
            audioOverride ? configOverride : this.audioConfig,
            allowMissingConfig,
        );
        const codecId = ((): string => {
            const c = audio.codec;
            if (pcm) return pcm.codecId;
            if (typeof c !== 'string')
                throw new MediaForgeError('Matroska audio codec must be a string', 'FORMAT');
            if (c.startsWith('opus')) return 'A_OPUS';
            if (c.startsWith('vorbis')) return 'A_VORBIS';
            if (c.startsWith('mp4a')) {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError("WebM cannot carry AAC; use format 'mkv'", 'FORMAT');
                }
                return 'A_AAC';
            }

            if (c === 'mp1' || c === 'mp2' || c === 'mp3') {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError(
                        "WebM cannot carry MPEG Audio; use format 'mkv'",
                        'FORMAT',
                    );
                }
                return `A_MPEG/L${c[2]}`;
            }

            if (c === 'ac-3' || c === 'ec-3') {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError(
                        `WebM cannot carry ${c.toUpperCase()}; use format 'mkv'`,
                        'FORMAT',
                    );
                }
                return c === 'ac-3' ? 'A_AC3' : 'A_EAC3';
            }

            if (
                c === 'flac' ||
                c === 'alac' ||
                c === 'ulaw' ||
                c === 'alaw' ||
                isWindowsMediaAudio(c)
            ) {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError(
                        `WebM cannot carry ${c.toUpperCase()}; use format 'mkv'`,
                        'FORMAT',
                    );
                }
                return c === 'flac' ? 'A_FLAC' : c === 'alac' ? 'A_ALAC' : 'A_MS/ACM';
            }

            if (isDtsCodec(c) || c === 'mlpa') {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError(
                        `WebM cannot carry ${c === 'mlpa' ? 'TrueHD' : 'DTS'}; use format 'mkv'`,
                        'FORMAT',
                    );
                }
                return c === 'mlpa' ? 'A_TRUEHD' : c === 'dtse' ? 'A_DTS/EXPRESS' : 'A_DTS';
            }

            throw new MediaForgeError(`Matroska output cannot label audio codec '${c}'`, 'FORMAT');
        })();
        const trackChildren: Uint8Array[] = [
            ebmlUint(0xd7, trackNum),
            ebmlUid(this.trackUids[this.trackNumbers.indexOf(trackNum)]!),
            ebmlUint(0x83, 2),
            ebmlString(0x86, codecId),
            ...languageElements(audioOverride ? audio.language : this.cfg.audioLanguage),
            ...trackMetadataElements(audio, this.cfg.format),
        ];
        if (codecId === 'A_OPUS') {
            const activeConfig = audioOverride ? configOverride : this.audioConfig;
            const opus = parseOpusHead(
                activeConfig ?? new Uint8Array(0),
                audio.channelCount || 2,
                audio.sampleRate || 48000,
            );
            trackChildren.push(ebmlBinary(0x63a2, opus.head));

            trackChildren.push(
                ebmlUint(0x56aa, Math.round((opus.preSkip * 1_000_000_000) / 48000)),
            );
            trackChildren.push(ebmlUint(0x56bb, 80_000_000));
            trackChildren.push(
                ebmlElement(
                    0xe1,
                    concatBytes([ebmlFloat(0xb5, 48000), ebmlUint(0x9f, opus.channels)]),
                ),
            );
        } else {
            const activeCfg = audioOverride ? configOverride : this.audioConfig;
            const codecPrivate =
                codecId === 'A_FLAC' && activeCfg
                    ? flacStreamHeader(activeCfg)
                    : codecId === 'A_ALAC' && activeCfg
                      ? alacCookie(activeCfg)
                      : codecId === 'A_MS/ACM' && !isWindowsMediaAudio(audio.codec)
                        ? g711WaveFormat(
                              audio.codec as 'ulaw' | 'alaw',
                              audio.sampleRate,
                              audio.channelCount,
                          )
                        : activeCfg;

            // AC-3, E-AC-3, DTS and TrueHD carry no CodecPrivate; dac3/dec3/ddts/dmlp are MP4
            // sample entry data.
            const dolby =
                codecId === 'A_AC3' ||
                codecId === 'A_EAC3' ||
                codecId.startsWith('A_DTS') ||
                codecId === 'A_TRUEHD';
            if (!pcm && !dolby && codecPrivate && codecPrivate.length > 0)
                trackChildren.push(ebmlBinary(0x63a2, codecPrivate));
            const codecDelaySamples = audioOverride
                ? Math.max(
                      0,
                      Math.round(
                          configuredCodecDelaySamples(
                              audio,
                              Math.max(0, Math.round(audio.primingSamples ?? 0)),
                              activeCfg,
                          ),
                      ),
                  )
                : this.audioCodecDelaySamples;
            if (codecDelaySamples > 0) {
                trackChildren.push(
                    ebmlUint(
                        0x56aa,
                        Math.round(
                            codecDelaySamples * (1_000_000_000 / this.audioTimingRateFor(audio)),
                        ),
                    ),
                );
            }
            trackChildren.push(
                ebmlElement(
                    0xe1,
                    concatBytes([
                        ebmlFloat(0xb5, audio.sampleRate || 48000),
                        ebmlUint(0x9f, audio.channelCount || 2),
                        ...(pcm ? [ebmlUint(0x6264, pcm.bitsPerSample)] : []),
                    ]),
                ),
            );
        }
        return ebmlElement(0xae, concatBytes([...trackChildren]));
    }

    /**
     * Cuts `packets` into clusters of up to two seconds, at video keyframes where there is video,
     * and hands each to `write` with its start time and the track its cue points at.
     */
    private writeClusters(
        packets: BufferedPacket[],
        discardPadding: ReadonlyMap<BufferedPacket, number>,
        write: (cluster: Uint8Array, startTicks: number, cueTrack: number) => void,
    ): void {
        const clusterDurationTicks = 2 * this.timeUnitsPerSecond;
        let clusterPackets: BufferedPacket[] = [];
        let clusterStartTicks = 0;

        const flush = (): void => {
            if (clusterPackets.length === 0) return;
            const cueTrack = (
                clusterPackets.find(
                    packet => packet.chunk.trackType === 'video' && packet.chunk.isKeyframe,
                ) ?? clusterPackets[0]!
            ).trackNum;
            write(
                this.serializeCluster(clusterPackets, clusterStartTicks, discardPadding),
                clusterStartTicks,
                cueTrack,
            );
            clusterPackets = [];
        };

        const hasVideo = !!this.cfg.video || !!this.cfg.extraVideoTracks?.length;
        for (const packet of packets) {
            const timestampTicks = secondsToTicks(
                this.packetTimestamp(packet),
                this.timeUnitsPerSecond,
                'Matroska block timestamp',
            );
            if (clusterPackets.length === 0) clusterStartTicks = Math.max(0, timestampTicks);
            const canCut =
                !hasVideo ||
                (packet.chunk.trackType === 'video' && packet.chunk.isKeyframe === true);
            const over = timestampTicks - clusterStartTicks >= clusterDurationTicks;
            const wayOver = timestampTicks - clusterStartTicks >= 16000;
            const beforeRange = timestampTicks - clusterStartTicks < -32768;
            if ((over && canCut) || wayOver || beforeRange) {
                flush();
                clusterStartTicks = Math.max(0, timestampTicks);
            }
            clusterPackets.push(packet);
        }
        flush();
    }

    /**
     * Serializes one Cluster in a single allocation: SimpleBlocks are written straight into the
     * output, while the rare BlockGroups (alpha, subtitles, DiscardPadding) are built first and
     * copied once.
     */
    private serializeCluster(
        clusterPackets: BufferedPacket[],
        clusterStartTicks: number,
        discardPadding: ReadonlyMap<BufferedPacket, number>,
    ): Uint8Array {
        const timecode = ebmlUint(0xe7, clusterStartTicks);
        const count = clusterPackets.length;
        if (this.scratchTicks.length < count)
            this.scratchTicks = new Int32Array(Math.max(count, 1024));
        const relativeTicks = this.scratchTicks;
        const groups: (Uint8Array | undefined)[] = [];
        let bodyBytes = timecode.length;
        for (let index = 0; index < count; index++) {
            const packet = clusterPackets[index]!;
            const absoluteTicks = secondsToTicks(
                this.packetTimestamp(packet),
                this.timeUnitsPerSecond,
                'Matroska block timestamp',
            );
            const relTicks = absoluteTicks - clusterStartTicks;
            if (!Number.isSafeInteger(relTicks) || relTicks < -32768 || relTicks > 32767) {
                throw new MediaForgeError(
                    'Matroska block timestamp cannot fit its signed 16-bit field',
                    'MUX',
                );
            }

            relativeTicks[index] = relTicks;
            const isSubtitle =
                this.subtitleNumbers.size !== 0 && this.subtitleNumbers.has(packet.trackNum);
            const blockBytes = trackNumberBytes(packet.trackNum) + 3 + packet.chunk.data.length;
            if (!packet.chunk.alphaData && !isSubtitle && !discardPadding.has(packet)) {
                bodyBytes += 1 + ebmlSizeBytes(blockBytes) + blockBytes;
            } else {
                const group = this.buildBlockGroup(
                    packet,
                    relTicks,
                    absoluteTicks,
                    isSubtitle,
                    discardPadding,
                );
                groups[index] = group;
                bodyBytes += group.length;
            }

            this.lastBlockTimestamps.set(packet.trackNum, absoluteTicks);
        }

        const output = new Uint8Array(4 + ebmlSizeBytes(bodyBytes) + bodyBytes);
        let offset = writeEbmlId(output, 0, 0x1f43b675);
        offset = writeEbmlSize(output, offset, bodyBytes);
        output.set(timecode, offset);
        offset += timecode.length;

        for (let index = 0; index < count; index++) {
            const group = groups[index];
            if (group) {
                output.set(group, offset);
                offset += group.length;
                continue;
            }

            const packet = clusterPackets[index]!;
            const data = packet.chunk.data;
            const blockBytes = trackNumberBytes(packet.trackNum) + 3 + data.length;
            output[offset++] = 0xa3;
            offset = writeEbmlSize(output, offset, blockBytes);
            offset = writeBlockHeader(
                output,
                offset,
                packet.trackNum,
                relativeTicks[index]!,
                packet.chunk.isKeyframe || packet.chunk.trackType === 'audio' ? 0x80 : 0,
            );
            output.set(data, offset);
            offset += data.length;
        }
        return output;
    }

    /** A BlockDuration of `seconds` in the writer's ticks. */
    private blockDuration(seconds: number): number {
        return secondsToTicks(seconds, this.timeUnitsPerSecond, 'Matroska block duration');
    }

    private buildBlockGroup(
        packet: BufferedPacket,
        relTicks: number,
        absoluteTicks: number,
        isSubtitle: boolean,
        discardPadding: ReadonlyMap<BufferedPacket, number>,
    ): Uint8Array {
        const trackBytes = trackNumberBytes(packet.trackNum);
        const block = new Uint8Array(trackBytes + 3 + packet.chunk.data.length);
        writeBlockHeader(block, 0, packet.trackNum, relTicks, 0);
        block.set(packet.chunk.data, trackBytes + 3);

        if (packet.chunk.alphaData) {
            return ebmlElement(
                0xa0,
                concatBytes([
                    ebmlElement(0xa1, block),
                    ebmlUint(0x9b, Math.max(1, this.blockDuration(packet.chunk.duration))),
                    ...(!packet.chunk.isKeyframe
                        ? [
                              ebmlSint(
                                  0xfb,
                                  (this.lastBlockTimestamps.get(packet.trackNum) ?? 0) -
                                      absoluteTicks,
                              ),
                          ]
                        : []),
                    ebmlElement(
                        0x75a1,
                        ebmlElement(
                            0xa6,
                            concatBytes([
                                ebmlUint(0xee, 1),
                                ebmlBinary(0xa5, packet.chunk.alphaData),
                            ]),
                        ),
                    ),
                ]),
            );
        }

        if (isSubtitle) {
            return ebmlElement(
                0xa0,
                concatBytes([
                    ebmlElement(0xa1, block),
                    ebmlUint(0x9b, Math.max(1, this.blockDuration(packet.chunk.duration ?? 0))),
                ]),
            );
        }

        return ebmlElement(
            0xa0,
            concatBytes([ebmlElement(0xa1, block), ebmlSint(0x75a2, discardPadding.get(packet)!)]),
        );
    }
}

/**
 * Trailing DiscardPadding for a priming+valid window; the window must fit the encoded samples
 * exactly.
 */
function trailingDiscardPaddingNs(
    label: string,
    encoded: number,
    priming: number,
    valid: number,
    rate: number,
): number {
    if (encoded < priming + valid) {
        throw new MediaForgeError(`${label} edit is longer than its encoded samples`, 'MUX');
    }
    return Math.max(0, Math.round((encoded - priming - valid) * (1_000_000_000 / rate)));
}

function trackNumberBytes(trackNum: number): number {
    let bytes = 1;
    while (trackNum >= 2 ** (bytes * 7)) bytes++;
    return bytes;
}

function writeBlockHeader(
    out: Uint8Array,
    pos: number,
    trackNum: number,
    relTicks: number,
    flags: number,
): number {
    const trackBytes = trackNumberBytes(trackNum);
    if (trackBytes === 1) out[pos] = trackNum | 0x80;
    else {
        writeUnsigned(out, pos, trackNum, trackBytes);
        out[pos] = out[pos]! | (0x80 >> (trackBytes - 1));
    }
    out[pos + trackBytes] = (relTicks >> 8) & 0xff;
    out[pos + trackBytes + 1] = relTicks & 0xff;
    out[pos + trackBytes + 2] = flags;
    return pos + trackBytes + 3;
}
