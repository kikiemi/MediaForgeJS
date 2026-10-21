import { H264BitReader, displayDimensions, gcd } from './video-sps';

/**
 * Start code syntax: MPEG-1/2 video (ISO/IEC 11172-2, 13818-2) or MPEG-4 Part 2 visual (ISO/IEC
 * 14496-2).
 */
export type MpegVideoSyntax = 'mpeg12' | 'mpeg4';

export interface MpegVideoFormat {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly pixelAspectRatioNum: number;
    readonly pixelAspectRatioDen: number;
    readonly displayWidth: number;
    readonly displayHeight: number;
    /**
     * Frame rate stated by the headers; the numerator is 0 when the stream leaves it to the
     * container.
     */
    readonly frameRateNum: number;
    readonly frameRateDen: number;
    readonly colour?: { primaries: number; transfer: number; matrix: number; fullRange: boolean };
}

/** Picture coding types in MPEG-1/2 numbering; MPEG-4 P- and S-VOPs are both predicted anchors. */
export const PICTURE_I = 1;
export const PICTURE_P = 2;
export const PICTURE_B = 3;

export const SEQUENCE_HEADER = 0xb3;
export const SEQUENCE_END = 0xb7;
export const EXTENSION = 0xb5;
export const GROUP = 0xb8;
export const PICTURE = 0x00;
export const VOP = 0xb6;
const VOS = 0xb0;
const VISUAL_OBJECT = 0xb5;
const GOV = 0xb3;

/** frame_rate_code 1..8 as num/den. */
const MPEG12_FRAME_RATES: readonly (readonly [number, number])[] = [
    [0, 1],
    [24000, 1001],
    [24, 1],
    [25, 1],
    [30000, 1001],
    [30, 1],
    [50, 1],
    [60000, 1001],
    [60, 1],
];

/** MPEG-1 pel aspect ratio codes as sample aspect ratios, rounded to 255 like ffmpeg's av_d2q. */
const MPEG1_PIXEL_ASPECT: readonly (readonly [number, number])[] = [
    [1, 1],
    [1, 1],
    [49, 33],
    [64, 45],
    [239, 182],
    [36, 29],
    [32, 27],
    [169, 151],
    [178, 163],
    [54, 53],
    [196, 201],
    [187, 200],
    [200, 219],
    [127, 147],
    [134, 161],
];

/** MPEG-2 aspect_ratio_information 2..4 as display aspect ratios. */
const MPEG2_DISPLAY_ASPECT: readonly (readonly [number, number])[] = [
    [0, 1],
    [1, 1],
    [4, 3],
    [16, 9],
    [221, 100],
];

/** MPEG-4 Part 2 aspect_ratio_info 1..5. */
const MPEG4_PIXEL_ASPECT: readonly (readonly [number, number])[] = [
    [1, 1],
    [1, 1],
    [12, 11],
    [10, 11],
    [16, 11],
    [40, 33],
];

/** Offset of the next `00 00 01` prefix in [from, end), or -1. */
export function findStartCode(data: Uint8Array, from: number, end = data.length): number {
    for (let index = Math.max(0, from); index + 2 < end;) {
        const third = data[index + 2]!;
        if (third > 1) index += 3;
        else if (third === 1 && data[index] === 0 && data[index + 1] === 0) return index;
        else index++;
    }
    return -1;
}

/**
 * Out-of-band decoder configuration taken from the headers in front of the first picture, as ffmpeg
 * splits extradata: an MPEG-1/2 sequence header with its extensions, or MPEG-4 VOS/VO/VOL headers
 * with their user data.
 */
export function mpegVideoConfig(syntax: MpegVideoSyntax, data: Uint8Array): Uint8Array | undefined {
    let start = -1;
    let end = data.length;
    let hasLayer = false;

    for (
        let at = findStartCode(data, 0);
        at >= 0 && at + 3 < data.length;
        at = findStartCode(data, at + 3)
    ) {
        const code = data[at + 3]!;
        if (syntax === 'mpeg12') {
            if (code === SEQUENCE_HEADER) {
                if (start < 0) start = at;
                hasLayer = true;
            } else if (start >= 0 && code !== EXTENSION) {
                end = at;
                break;
            }
        } else {
            if (code === GOV || code === VOP) {
                end = at;
                break;
            }
            if (start < 0 && (code === VOS || code === VISUAL_OBJECT || code <= 0x2f)) start = at;
            if (code >= 0x20 && code <= 0x2f) hasLayer = true;
        }
    }

    return start >= 0 && hasLayer ? data.slice(start, end) : undefined;
}

function withAspect(
    width: number,
    height: number,
    num: number,
    den: number,
): {
    pixelAspectRatioNum: number;
    pixelAspectRatioDen: number;
    displayWidth: number;
    displayHeight: number;
} {
    const divisor = gcd(num, den);
    const display = displayDimensions(width, height, num / divisor, den / divisor);
    return {
        pixelAspectRatioNum: num / divisor,
        pixelAspectRatioDen: den / divisor,
        displayWidth: display.num,
        displayHeight: display.den,
    };
}

function mpeg2ObjectType(profileAndLevel: number): number {
    if (profileAndLevel >> 7)
        return profileAndLevel === 0x82 || profileAndLevel === 0x85 ? 0x65 : 0x61;
    const profile = (profileAndLevel >> 4) & 7;
    return profile >= 1 && profile <= 5 ? 0x65 - profile : 0x61;
}

function parseMpeg12Config(data: Uint8Array): MpegVideoFormat | null {
    const header = findStartCode(data, 0);
    if (header < 0 || data[header + 3] !== SEQUENCE_HEADER) return null;
    const bits = new H264BitReader(data.subarray(header + 4));
    let width = bits.readBits(12);
    let height = bits.readBits(12);
    const aspect = bits.readBits(4);
    let [rateNum, rateDen] = MPEG12_FRAME_RATES[bits.readBits(4)] ?? [0, 1];
    let profile = -1;
    let panWidth = 0;
    let panHeight = 0;
    let colour: MpegVideoFormat['colour'];
    for (let at = findStartCode(data, header + 4); at >= 0; at = findStartCode(data, at + 3)) {
        if (data[at + 3] !== EXTENSION) break;
        const ext = new H264BitReader(data.subarray(at + 4));
        const id = ext.readBits(4);
        if (id === 1) {
            profile = ext.readBits(8);
            ext.skipBits(3);
            width |= ext.readBits(2) << 12;
            height |= ext.readBits(2) << 12;
            ext.skipBits(22);
            rateNum *= ext.readBits(2) + 1;
            rateDen *= ext.readBits(5) + 1;
        } else if (id === 2) {
            ext.skipBits(3);
            if (ext.readBits(1)) {
                const primaries = ext.readBits(8);
                const transfer = ext.readBits(8);
                const matrix = ext.readBits(8);
                colour = { primaries, transfer, matrix, fullRange: false };
            }
            panWidth = ext.readBits(14);
            ext.skipBits(1);
            panHeight = ext.readBits(14);
        }
    }
    if (width < 1 || height < 1) return null;
    let sar: readonly [number, number] = [1, 1];
    if (profile < 0) sar = MPEG1_PIXEL_ASPECT[aspect] ?? sar;
    else if (aspect >= 2 && aspect <= 4) {
        const [darNum, darDen] = MPEG2_DISPLAY_ASPECT[aspect]!;

        // Like ffmpeg, the display extension is honoured only when it yields exactly 4:3 or 16:9.
        const panScan =
            panWidth > 0 &&
            panHeight > 0 &&
            [
                [4, 3],
                [16, 9],
            ].some(
                ([num, den]) =>
                    darNum * panHeight * width * den! === num! * darDen * panWidth * height,
            );
        sar = panScan ? [darNum * panHeight, darDen * panWidth] : [darNum * height, darDen * width];
    }
    return {
        codec: profile < 0 ? 'mp4v.6a' : `mp4v.${mpeg2ObjectType(profile).toString(16)}`,
        width,
        height,
        ...withAspect(width, height, sar[0], sar[1]),
        frameRateNum: rateNum,
        frameRateDen: rateDen,
        colour,
    };
}

/** Bits of vop_time_increment for a VOL time resolution, as ffmpeg derives them. */
function mpeg4TimeIncrementBits(resolution: number): number {
    return resolution > 1 ? Math.floor(Math.log2(resolution - 1)) + 1 : 1;
}

function parseMpeg4Config(data: Uint8Array): MpegVideoFormat | null {
    let level = -1;
    let colour: MpegVideoFormat['colour'];

    for (
        let at = findStartCode(data, 0);
        at >= 0 && at + 4 < data.length;
        at = findStartCode(data, at + 3)
    ) {
        const code = data[at + 3]!;
        const bits = new H264BitReader(data.subarray(at + 4));
        if (code === VOS) level = data[at + 4]!;
        else if (code === VISUAL_OBJECT) {
            if (bits.readBits(1)) bits.skipBits(7);
            const type = bits.readBits(4);
            if ((type === 1 || type === 2) && bits.readBits(1)) {
                bits.skipBits(3);
                const fullRange = bits.readBits(1) === 1;
                if (bits.readBits(1)) {
                    const primaries = bits.readBits(8);
                    const transfer = bits.readBits(8);
                    const matrix = bits.readBits(8);
                    colour = { primaries, transfer, matrix, fullRange };
                }
            }
        } else if (code >= 0x20 && code <= 0x2f) {
            bits.skipBits(9);
            let verid = 1;
            if (bits.readBits(1)) {
                verid = bits.readBits(4);
                bits.skipBits(3);
            }

            const aspect = bits.readBits(4);
            let sar: readonly [number, number] = MPEG4_PIXEL_ASPECT[aspect] ?? [1, 1];
            if (aspect === 15) sar = [bits.readBits(8), bits.readBits(8)];
            if (bits.readBits(1)) {
                bits.skipBits(3);
                if (bits.readBits(1)) bits.skipBits(79);
            }

            const shape = bits.readBits(2);
            if (shape === 3 && verid !== 1) bits.skipBits(4);
            bits.skipBits(1);
            const resolution = bits.readBits(16);
            bits.skipBits(1);

            let rateNum = 0;
            let rateDen = 1;
            if (bits.readBits(1)) {
                const increment = bits.readBits(mpeg4TimeIncrementBits(resolution));
                if (increment > 0 && resolution > 0) [rateNum, rateDen] = [resolution, increment];
            }

            if (shape !== 0) return null;
            bits.skipBits(1);
            const width = bits.readBits(13);
            bits.skipBits(1);
            const height = bits.readBits(13);
            if (width < 1 || height < 1) return null;
            return {
                codec: `mp4v.20.${level >= 0 ? level : 9}`,
                width,
                height,
                ...withAspect(width, height, sar[0] || 1, sar[1] || 1),
                frameRateNum: rateNum,
                frameRateDen: rateDen,
                colour,
            };
        }
    }
    return null;
}

/** Stream format from a sequence header or VOL in `data`; null when absent or malformed. */
export function parseMpegVideoConfig(
    syntax: MpegVideoSyntax,
    data: Uint8Array,
): MpegVideoFormat | null {
    try {
        return syntax === 'mpeg12' ? parseMpeg12Config(data) : parseMpeg4Config(data);
    } catch (error) {
        if (error instanceof RangeError) return null;
        throw error;
    }
}

interface MpegPicture {
    /** Offset of the picture or VOP start code inside the access unit. */
    readonly offset: number;
    readonly type: number;
    /** An I-picture after a sequence or GOP header, or an I-VOP. */
    readonly keyframe: boolean;
}

/** First coded picture of an access unit; null when it holds none. */
export function inspectMpegPicture(syntax: MpegVideoSyntax, data: Uint8Array): MpegPicture | null {
    let headers = false;
    for (
        let at = findStartCode(data, 0);
        at >= 0 && at + 4 < data.length;
        at = findStartCode(data, at + 3)
    ) {
        const code = data[at + 3]!;
        if (syntax === 'mpeg4') {
            if (code !== VOP) continue;
            const coding = data[at + 4]! >> 6;
            return {
                offset: at,
                type: coding === 0 ? PICTURE_I : coding === 2 ? PICTURE_B : PICTURE_P,
                keyframe: coding === 0,
            };
        }

        if (code === SEQUENCE_HEADER || code === GROUP) headers = true;
        else if (code === PICTURE) {
            if (at + 5 >= data.length) return null;
            const type = (data[at + 5]! >> 3) & 7;
            return { offset: at, type, keyframe: type === PICTURE_I && headers };
        }
    }
    return null;
}

/**
 * Codec string of an MPEG-4 systems video objectTypeIndication; Part 2 takes its level from the VOS
 * header.
 */
export function mpegVideoCodec(objectType: number, config?: Uint8Array): string | null {
    if (objectType === 0x20)
        return (config && parseMpegVideoConfig('mpeg4', config)?.codec) ?? 'mp4v.20.9';
    if (objectType === 0x6a || (objectType >= 0x60 && objectType <= 0x65))
        return `mp4v.${objectType.toString(16)}`;
    if (objectType === 0x6c) return 'mjpeg';
    if (objectType === 0x6d) return 'png';
    return null;
}

const VFW_MPEG4 =
    'FMP4 DIVX DX50 XVID XVIX MP4S M4S2 MP4V DIV1 BLZ0 UMP4 WV1F SEDG RMP4 3IV2 WAWV FFDS FVFW ' +
    'DCOD MVXM PM4V SMP4 DXGM VIDM M4T3 GEOX HDX4 DM4V DMK2 DYM4 DIGI EPHV EM4A M4CC SN40 VSPX ' +
    'ULDX GEOV SIPP SM4V DREX QMP4 PLV1 GLV4 GMP4 MNM4 GTM4 ZMP4';
const VFW_CODECS: ReadonlyMap<string, string> = new Map([
    ...VFW_MPEG4.split(' ').map(fourcc => [fourcc, 'mp4v.20.9'] as const),
    ...'MPG2 MPEG PIM2 MMES LMP2 SLIF EM2V M701 M702 M703 M704 M705 MPGV'
        .split(' ')
        .map(fourcc => [fourcc, 'mp4v.61'] as const),
    ...'MPG1 PIM1 VCR2 BW10 XMPG'.split(' ').map(fourcc => [fourcc, 'mp4v.6a'] as const),
    ...'H263 X263 T263 L263 M263 VX1K ZYGO LSVM U263 VIV1'
        .split(' ')
        .map(fourcc => [fourcc, 'h263'] as const),
    ...'MP43 DIV3 MPG3 DIV4 DIV5 DIV6 DVX3 AP41 COL0 COL1'
        .split(' ')
        .map(fourcc => [fourcc, 'msmpeg4v3'] as const),
    ...'MP42 DIV2'.split(' ').map(fourcc => [fourcc, 'msmpeg4v2'] as const),
    ...'MPG4 MP41'.split(' ').map(fourcc => [fourcc, 'msmpeg4v1'] as const),
    ['DVR ', 'mp4v.61'],
    ['\x04\0\0\0', 'mp4v.20.9'],
    ['\x04\0\0\x10', 'mp4v.20.9'],
    ['\x02\0\0\x10', 'mp4v.61'],
    ['\x01\0\0\x10', 'mp4v.6a'],
]);

/**
 * Codec for a Video for Windows FourCC (AVI, Matroska V_MS/VFW/FOURCC) of MPEG-1/2, MPEG-4 Part 2
 * or H.263, matched case-insensitively. 'msmpeg4v1'..'msmpeg4v3' name Microsoft's MPEG-4 v1-v3, a
 * different bitstream than MPEG-4 Part 2 that is read without a built-in decoder.
 */
export function vfwVideoCodec(fourcc: string): string | null {
    return VFW_CODECS.get(fourcc.toUpperCase()) ?? null;
}

/** Video for Windows FourCCs of H.264 (AVI, Matroska V_MS/VFW/FOURCC). */
export function isVfwAvcFourcc(value: string): boolean {
    return /^(H264|X264|AVC1|DAVC|VSSH|GAVC|SMV2|Q264|V264|UMSV|TSHD|INMC)$/.test(
        value.toUpperCase().trim(),
    );
}

/**
 * Whether a Microsoft MPEG-4 v1-v3 picture header codes an intra picture: its first two bits code
 * the picture type (0 intra), after a 32-bit 0x00000100 start code and a 5-bit frame number in v1.
 */
export function msmpeg4Intra(codec: string, data: Uint8Array): boolean {
    if (codec === 'msmpeg4v1') {
        if (data.length < 5 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1 || data[3] !== 0)
            return false;
        return ((data[4]! >> 1) & 3) === 0;
    }
    return data.length > 0 && data[0]! >> 6 === 0;
}

/** Whether an H.263 picture header (baseline PTYPE or H.263+ PLUSPTYPE) codes an intra picture. */
export function h263Intra(data: Uint8Array): boolean {
    if (data.length < 8 || data[0] !== 0 || data[1] !== 0 || (data[2]! & 0xfc) !== 0x80)
        return false;
    const bits = new H264BitReader(data);
    bits.skipBits(35);
    if (bits.readBits(3) !== 7) return bits.readBits(1) === 0;
    if (bits.readBits(3) === 1) bits.skipBits(18);
    return bits.readBits(3) === 0;
}

/**
 * Whether a coded picture is intra by its own header, for indexes that list predicted pictures as
 * sync samples (QuickTime H.263 tracks list every tenth picture, Xirlink AVIs every one). Undefined
 * when the codec's pictures are not read here or hold no picture header, in which case the index is
 * trusted.
 */
export function pictureIsIntra(codec: string, data: Uint8Array): boolean | undefined {
    if (/^[hs]263$/i.test(codec)) return h263Intra(data);
    const syntax = /^mp4v\.20/i.test(codec)
        ? 'mpeg4'
        : /^mp4v\.6[0-5a]$/i.test(codec)
          ? 'mpeg12'
          : undefined;
    const picture = syntax && inspectMpegPicture(syntax, data);
    return picture ? picture.type === PICTURE_I : undefined;
}

/** Whether pictureIsIntra() reads the pictures of `codec`: a keyframe is worth reading for it. */
export function readsPictureType(codec: string): boolean {
    return /^(?:[hs]263$|mp4v\.(?:20|6[0-5a]$))/i.test(codec);
}

interface Mpeg4PacketScan {
    readonly vops: number;
    /** Offset of the second VOP start code, or -1. */
    readonly second: number;
    /** Offset of the 'p' closing a DivX user data string that marks packed B-frames, or -1. */
    readonly packedMarker: number;
}

/**
 * VOPs and the DivX packed marker of one container packet, as ffmpeg's mpeg4_unpack_bframes scans
 * them.
 */
export function scanMpeg4Packet(data: Uint8Array): Mpeg4PacketScan {
    let vops = 0;
    let second = -1;
    let packedMarker = -1;
    for (
        let at = findStartCode(data, 0);
        at >= 0 && at + 3 < data.length;
        at = findStartCode(data, at + 4)
    ) {
        const code = data[at + 3];
        if (code === VOP && ++vops === 2) second = at;
        else if (code === 0xb2 && packedMarker < 0) {
            const next = findStartCode(data, at + 4);
            const end = Math.min(at + 4 + 255, next < 0 ? data.length - 1 : next);
            for (let index = at + 4; index < end; index++)
                if (data[index] === 0x70 && data[index + 1] === 0) {
                    packedMarker = index;
                    break;
                }
        }
    }
    return { vops, second, packedMarker };
}
