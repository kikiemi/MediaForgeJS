import type { FieldOrder, MediaTags, TrackType, VideoColour } from '../../../core/model/media';
import { carriedObjectType, isMpegH } from '../carried-audio';
import { visualSampleEntryBoxes } from '../../shared/video-colour';
import { MediaForgeError } from '../../../core/errors/errors';
import { parseAacAudioSpecificConfig } from '../../../core/codec-config/audio/adts';
import {
    DOLBY_ACMOD_CHANNELS,
    DOLBY_SAMPLE_RATES,
} from '../../../core/codec-config/audio/dolby-audio-header';

import {
    mp4HandlerPayload,
    mp4Language,
    mp4TitleBox,
    mp4TrackFlags,
    mp4TrackMetadataBoxes,
} from '../metadata';
import { parseVpcC, vpcCFor } from '../../../core/codec-config/video/vp9-config';
import { apvConfigInfo } from '../../../core/codec-config/video/apv';
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
} from '../iso-boxes';
import { isoBox as box, isoFullBox as fullBox, latin1, uint32 } from '../../shared/iso-box';
import { dataView } from '../../../core/bytes/byte-fields';
import { readFlacStreamInfo } from '../../../core/codec-config/audio/flac-frame';

export function cmafAssert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new MediaForgeError(`Fragmented MP4: ${message}`, 'MUX');
}

/**
 * A codec fragmented MP4 does not carry is an unsupported combination (FORMAT), not a failed write.
 */
function cmafCarries(condition: unknown, message: string): asserts condition {
    if (!condition) throw new MediaForgeError(`Fragmented MP4: ${message}`, 'FORMAT');
}

export function integer(value: number, label: string, min = 0, max = 0xffffffff): number {
    cmafAssert(
        Number.isSafeInteger(value) && value >= min && value <= max,
        `${label} must be an integer in [${min}, ${max}]`,
    );
    return value;
}

export function join(parts: readonly Uint8Array[]): Uint8Array {
    const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
    integer(size, 'box size', 0, 0x7fffffff);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}

export function u32(value: number): Uint8Array {
    return uint32(integer(value, 'unsigned field'));
}

function validateNalConfig(bytes: Uint8Array, hevc: boolean): void {
    cmafAssert(
        bytes.length >= (hevc ? 23 : 7) && bytes[0] === 1,
        'invalid AVC/HEVC configuration record',
    );
    const width = (bytes[hevc ? 21 : 4]! & 3) + 1;
    cmafAssert(width !== 3, 'reserved NAL length width');
    let offset = hevc ? 23 : 6;
    const readUnits = (count: number): void => {
        for (let index = 0; index < count; index++) {
            cmafAssert(offset + 2 <= bytes.length, 'truncated NAL configuration length');
            const length = bytes[offset]! * 256 + bytes[offset + 1]!;
            offset += 2;
            cmafAssert(
                length > 0 && offset + length <= bytes.length,
                'truncated NAL configuration',
            );
            offset += length;
        }
    };

    if (hevc) {
        for (let index = 0; index < bytes[22]!; index++) {
            cmafAssert(offset + 3 <= bytes.length, 'truncated HEVC array');
            offset++;
            const count = bytes[offset]! * 256 + bytes[offset + 1]!;
            offset += 2;
            readUnits(count);
        }
        cmafAssert(offset === bytes.length, 'trailing HEVC configuration bytes');
    } else {
        cmafAssert((bytes[5]! & 31) > 0, 'AVC configuration needs SPS');
        readUnits(bytes[5]! & 31);
        cmafAssert(offset < bytes.length && bytes[offset]! > 0, 'AVC configuration needs PPS');
        readUnits(bytes[offset++]!);
    }
}

function videoEntry(track: CmafTrack): Uint8Array {
    const kind = track.codec.split('.')[0]!;
    cmafCarries(
        ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'apv1'].includes(kind),
        `unsupported video codec ${track.codec}`,
    );
    integer(track.width!, 'width', 1, 0xffff);
    integer(track.height!, 'height', 1, 0xffff);
    const config =
        kind === 'vp09' ? vpcCFor(track.codec, track.codecConfig, track.colour) : track.codecConfig;
    cmafCarries(config && config.length > 0, `${kind} requires decoder configuration`);
    let configType: string;
    if (kind === 'avc1' || kind === 'avc3') {
        validateNalConfig(config, false);
        configType = 'avcC';
    } else if (kind === 'hvc1' || kind === 'hev1') {
        validateNalConfig(config, true);
        configType = 'hvcC';
    } else if (kind === 'av01') {
        cmafAssert(config.length >= 4 && config[0] === 0x81, 'invalid AV1 configuration record');
        configType = 'av1C';
    } else if (kind === 'apv1') {
        cmafAssert(apvConfigInfo(config) !== undefined, 'invalid APV configuration record');
        configType = 'apvC';
    } else {
        cmafAssert(
            config.length === 12 &&
                config[1] === 0 &&
                config[2] === 0 &&
                config[3] === 0 &&
                config[10] === 0 &&
                config[11] === 0,
            'VP9 requires a version-1 vpcC payload including its four-byte full-box header',
        );
        cmafAssert(
            parseVpcC(config) !== undefined,
            'VP9 profile, bit depth, and chroma subsampling disagree',
        );
        configType = 'vpcC';
    }

    const children = [
        configType === 'apvC' ? fullBox(configType, 0, 0, config) : box(configType, config),
        ...(track.spatialBoxes ? [track.spatialBoxes] : []),
        ...visualSampleEntryBoxes(track.colour, track.fieldOrder, false),
    ];
    if (track.pixelAspectRatioNum !== undefined || track.pixelAspectRatioDen !== undefined) {
        children.push(
            paspBox(
                integer(track.pixelAspectRatioNum!, 'pixel aspect numerator', 1),
                integer(track.pixelAspectRatioDen!, 'pixel aspect denominator', 1),
            ),
        );
    }

    return visualSampleEntry(kind, track.width!, track.height!, children);
}

function audioEntry(track: CmafTrack): Uint8Array {
    const flac = track.codec === 'flac' || track.codec === 'fLaC';
    const maxRate = flac ? 0xfffff : 0xffff;
    cmafCarries(!(track.sampleRate! > maxRate), `sample rate above ${maxRate}`);
    const rate = integer(track.sampleRate!, 'sample rate', 1, maxRate);

    // MPEG-H 3D audio and IAMF state their layout in their configuration and zero channels in the
    // entry.
    const iamf = track.codec.startsWith('iamf');
    const channels =
        iamf || isMpegH(track.codec)
            ? 0
            : integer(track.channelCount ?? 0, 'channel count', 1, 0xffff);
    const mpegAudio = track.codec === 'mp3' || track.codec === 'mp2' || track.codec === 'mp1';
    const carried = carriedObjectType(track.codec);
    const config =
        mpegAudio || (carried !== undefined && !track.codecConfig)
            ? new Uint8Array(0)
            : track.codecConfig;
    cmafCarries(
        config && (mpegAudio || carried !== undefined || config.length > 0),
        `${track.codec} requires decoder configuration`,
    );
    let kind: string;
    let child: Uint8Array;
    let sampleSize = 16;
    let entryRate = rate;
    if (carried !== undefined) {
        kind = 'mp4a';
        child = esdsBox(carried, 5, 0, config, false);
    } else if (isMpegH(track.codec)) {
        kind = track.codec.slice(0, 4);
        child = box('mhaC', config);
    } else if (iamf) {
        kind = 'iamf';
        child = iacbBox(config);
        entryRate = 0;
    } else if (mpegAudio) {
        // ISO/IEC 14496-3 object type 0x6B is MPEG-1 audio and 0x69 its MPEG-2 half-rate extension;
        // neither has decoder-specific info because every frame header states its own layout.
        kind = 'mp4a';
        child = esdsBox(rate < 32000 ? 0x69 : 0x6b, 5, 0, config, false);
    } else if (track.codec === 'mp4a' || track.codec.startsWith('mp4a.40.')) {
        const parsed = parseAacAudioSpecificConfig(config);
        cmafAssert(
            parsed && parsed.sampleRate === rate && parsed.channelCount === channels,
            'AAC ASC does not match sample rate/channel count',
        );
        cmafAssert(
            track.codec === 'mp4a' || track.codec === `mp4a.40.${parsed.audioObjectType}`,
            'AAC codec string does not match its AudioSpecificConfig',
        );
        kind = 'mp4a';
        child = esdsBox(0x40, 5, 0, config, false);
    } else if (track.codec === 'opus' || track.codec === 'Opus') {
        cmafAssert(
            rate === 48000 && track.timescale === 48000,
            'Opus requires a 48000 Hz sample rate and timescale',
        );
        cmafAssert(
            config.length >= 11 && config[0] === 0 && config[1] === channels,
            'Opus requires a big-endian dOps payload',
        );
        cmafAssert(
            config[10] === 0
                ? channels <= 2 && config.length === 11
                : config.length === 13 + channels,
            'invalid Opus channel mapping',
        );
        if (config[10] !== 0) {
            const streams = config[11]!;
            const coupled = config[12]!;
            cmafAssert(
                streams > 0 &&
                    coupled <= streams &&
                    streams + coupled <= 255 &&
                    config
                        .subarray(13)
                        .every(channel => channel === 255 || channel < streams + coupled),
                'invalid Opus stream counts or channel map',
            );
        }
        kind = 'Opus';
        child = box('dOps', config);
    } else if (track.codec === 'ac-3' || track.codec === 'ec-3') {
        let frequency: number;
        let mode: number;
        let lfe: number;
        if (track.codec === 'ac-3') {
            cmafAssert(config.length === 3, 'AC-3 requires a three-byte dac3 payload');
            frequency = config[0]! >>> 6;
            mode = (config[1]! >>> 3) & 7;
            lfe = (config[1]! >>> 2) & 1;
            const bitstreamId = (config[0]! >>> 1) & 31;
            const bitrateCode = ((config[1]! & 3) << 3) | (config[2]! >>> 5);
            cmafAssert(
                bitstreamId <= 8 && bitrateCode <= 18 && (config[2]! & 31) === 0,
                'invalid AC-3 bitstream ID, bitrate code, or reserved bits',
            );
        } else {
            cmafAssert(
                (config.length === 5 || (config.length === 6 && config[5] === 0)) &&
                    (config[1]! & 7) === 0 &&
                    config[4] === 0,
                'E-AC-3 dec3 must hold one independent substream only',
            );
            frequency = config[2]! >>> 6;
            mode = (config[3]! >>> 1) & 7;
            lfe = config[3]! & 1;
            cmafAssert(
                config[0]! * 32 + (config[1]! >>> 3) > 0 &&
                    ((config[2]! >>> 1) & 31) === 16 &&
                    (config[2]! & 1) === 0,
                'invalid E-AC-3 bitrate, bitstream ID, or reserved bits',
            );
        }
        cmafAssert(
            DOLBY_SAMPLE_RATES[frequency] === rate &&
                DOLBY_ACMOD_CHANNELS[mode]! + lfe === channels,
            'Dolby configuration does not match sample rate/channel count',
        );
        kind = track.codec;
        child = box(kind === 'ac-3' ? 'dac3' : 'dec3', config);
    } else if (track.codec === 'alac') {
        cmafAssert(config.length === 24, 'ALAC requires a raw 24-byte AlacSpecificConfig');
        const view = dataView(config);
        cmafAssert(
            view.getUint32(0) > 0 &&
                view.getUint32(0) <= 16 * 1024 * 1024 &&
                config[4] === 0 &&
                [16, 20, 24, 32].includes(config[5]!) &&
                config[8]! > 0 &&
                config[8]! <= 31,
            'invalid ALAC frame length, version, sample size, or Rice limit',
        );
        cmafAssert(
            channels <= 8 && config[9] === channels && view.getUint32(20) === rate,
            'ALAC configuration does not match sample rate/channel count',
        );
        sampleSize = config[5]!;
        kind = 'alac';
        child = fullBox('alac', 0, 0, config);
    } else if (flac) {
        cmafAssert(config.length === 34, 'FLAC requires a raw 34-byte STREAMINFO record');
        const info = readFlacStreamInfo(config);
        cmafAssert(
            info.sampleRate === rate && info.channels === channels,
            'FLAC STREAMINFO does not match sample rate/channel count',
        );
        cmafAssert(info.bitsPerSample >= 4, 'FLAC STREAMINFO has an invalid sample size');
        return flacSampleEntry(config);
    } else {
        cmafCarries(false, `unsupported audio codec ${track.codec}`);
    }
    return audioSampleEntry(kind, channels, sampleSize, entryRate * 65536, [child]);
}

function subtitleEntry(track: CmafTrack): Uint8Array {
    const payload = new Uint8Array(8);
    payload[7] = 1;
    if (track.codec === 'wvtt') {
        const config = track.codecConfig ?? latin1('WEBVTT\n');
        cmafAssert(
            new TextDecoder().decode(config).startsWith('WEBVTT'),
            'wvtt configuration must begin with WEBVTT',
        );
        return box('wvtt', payload, box('vttC', config));
    }

    // 3GPP timed text keeps its sample entry body (display flags, box record, style and font table)
    // as its config.
    if (track.codec === 'tx3g') {
        cmafAssert(
            !!track.codecConfig && track.codecConfig.length >= 30,
            'tx3g needs its sample entry configuration',
        );
        return box('tx3g', payload, track.codecConfig!);
    }
    cmafCarries(track.codec === 'stpp', `unsupported subtitle codec ${track.codec}`);
    const fields = [
        track.namespace ?? 'http://www.w3.org/ns/ttml',
        track.schemaLocation ?? '',
        track.auxiliaryMimeTypes ?? '',
    ];
    cmafAssert(
        fields.every(field => !field.includes('\0')),
        'stpp entry strings cannot contain NUL',
    );
    return box('stpp', payload, new TextEncoder().encode(fields.join('\0') + '\0'));
}

function trackBox(track: CmafTrack): Uint8Array {
    // The track header states the display size: the coded width stretched by the pixel aspect
    // ratio.
    const aspect =
        track.pixelAspectRatioNum && track.pixelAspectRatioDen
            ? track.pixelAspectRatioNum / track.pixelAspectRatioDen
            : 1;
    const video = track.type === 'video';
    const width = video ? Math.min(0xffffffff, Math.round(track.width! * aspect * 65536)) : 0;
    const tkhd = tkhdBox(
        track.id,
        mp4TrackFlags(track, 7),
        0,
        track.type === 'audio',
        track.rotation ?? 0,
        width,
        video ? track.height! * 65536 : 0,
    );

    cmafAssert(
        track.language === undefined ||
            /^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)$/.test(track.language),
        'track language must be an ISO 639 code or a BCP 47 tag',
    );
    const { code: language, elng } = mp4Language(track.language);
    const handler = mp4HandlerPayload(
        track.type === 'video'
            ? 'vide'
            : track.type === 'audio'
              ? 'soun'
              : track.codec === 'wvtt'
                ? 'text'
                : track.codec === 'tx3g'
                  ? 'sbtl'
                  : 'subt',
        track.name,
    );

    const entry =
        track.type === 'video'
            ? videoEntry(track)
            : track.type === 'audio'
              ? audioEntry(track)
              : subtitleEntry(track);

    const stbl = fragmentedSampleTable(stsdBox([entry]));
    const edits: Uint8Array[] = [];
    if (track.edit) {
        const { duration = 0, mediaTime } = track.edit;
        edits.push(
            editListBox([
                {
                    duration: integer(duration, 'edit duration'),
                    mediaTime: integer(mediaTime, 'edit media time'),
                },
            ]),
        );
    } else if ((track.codec === 'opus' || track.codec === 'Opus') && track.codecConfig) {
        const skip = track.codecConfig[2]! * 256 + track.codecConfig[3]!;
        if (skip) edits.push(editListBox([{ duration: 0, mediaTime: skip }]));
    }

    return box(
        'trak',
        tkhd,
        ...edits,
        box(
            'mdia',
            mdhdBox(track.timescale, 0, language),
            ...(elng.length ? [elng] : []),
            fullBox('hdlr', 0, 0, handler),
            box('minf', mediaHeaderBox(track.type), dinfBox(), stbl),
        ),
        ...mp4TrackMetadataBoxes(track),
    );
}

export function buildCmafInit(
    tracks: readonly CmafTrack[],
    title?: string,
    tags?: MediaTags,
): Uint8Array {
    const trexes = tracks.map(track => trexBox(track.id));
    return join([
        box('ftyp', latin1('iso6'), u32(0), latin1('iso6'), latin1('mp41'), latin1('dash')),
        box(
            'moov',
            mvhdBox(1000, 0, Math.max(...tracks.map(track => track.id)) + 1),
            ...tracks.map(trackBox),
            box('mvex', ...trexes),
            mp4TitleBox(title, false, tags),
        ),
    ]);
}

export interface CmafTrack {
    readonly id: number;
    readonly type: TrackType;
    readonly codec: string;
    readonly timescale: number;
    readonly width?: number;
    readonly height?: number;
    /**
     * Counter-clockwise display rotation of a video track: 0, 90, 180 or 270, written as the tkhd
     * matrix.
     */
    readonly rotation?: number;
    readonly pixelAspectRatioNum?: number;
    readonly pixelAspectRatioDen?: number;
    readonly sampleRate?: number;
    readonly channelCount?: number;
    /**
     * avcC/hvcC/av1C/dOps/dac3/dec3 payload, full vpcC payload, AAC ASC, raw FLAC STREAMINFO,
     * 24-byte AlacSpecificConfig, or UTF-8 vttC. VP9 may omit it: the record is then built from the
     * codec string and colour.
     */
    readonly codecConfig?: Uint8Array;
    /**
     * Presentation window of a copied track, written as its edit list: `mediaTime` in the track
     * timescale where the presentation starts (AAC priming), and the presented `duration` in movie
     * ticks (1/1000 s) when it ends before the media. Opus takes its start from the pre-skip of its
     * configuration instead.
     */
    readonly edit?: { readonly mediaTime: number; readonly duration?: number };
    /**
     * ISO 23001-8 code points written into a synthesized vpcC; omitted means BT.709 limited range.
     */
    readonly colour?: VideoColour;
    readonly fieldOrder?: FieldOrder;
    /** The 'lhvC', 'vexu' and 'hfov' boxes of a copied spatial video, written as they are. */
    readonly spatialBoxes?: Uint8Array;
    readonly language?: string;
    readonly default?: boolean;
    readonly forced?: boolean;
    readonly commentary?: boolean;
    readonly name?: string;
    readonly title?: string;
    readonly namespace?: string;
    readonly schemaLocation?: string;
    readonly auxiliaryMimeTypes?: string;
}
