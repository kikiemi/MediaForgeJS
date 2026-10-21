import { codecFamily } from './codec-strings';

/** Output a video encoder has to handle; bitrate in bits per second. */
export interface VideoEncodeShape {
    readonly width: number;
    readonly height: number;
    readonly framerate: number;
    readonly bitrate: number;
    /** 10 for high-dynamic-range sources that need a 10-bit profile. */
    readonly bitDepth?: 8 | 10;
}

/**
 * [level_idc, MaxMBPS, MaxFS, MaxBR in kbps] from H.264 Table A-1; High profile allows 1.25 ×
 * MaxBR.
 */
const AVC_LEVELS: readonly (readonly [number, number, number, number])[] = [
    [10, 1485, 99, 64],
    [11, 3000, 396, 192],
    [12, 6000, 396, 384],
    [13, 11880, 396, 768],
    [20, 11880, 396, 2000],
    [21, 19800, 792, 4000],
    [22, 20250, 1620, 4000],
    [30, 40500, 1620, 10000],
    [31, 108000, 3600, 14000],
    [32, 216000, 5120, 20000],
    [40, 245760, 8192, 20000],
    [41, 245760, 8192, 50000],
    [42, 522240, 8704, 50000],
    [50, 589824, 22080, 135000],
    [51, 983040, 36864, 240000],
    [52, 2073600, 36864, 240000],
    [60, 4177920, 139264, 240000],
    [61, 8355840, 139264, 480000],
    [62, 16711680, 139264, 800000],
];

/**
 * [general_level_idc, MaxLumaPs, MaxLumaSr, Main tier MaxBR in kbps] from H.265 Tables A.8 and A.9.
 */
const HEVC_LEVELS: readonly (readonly [number, number, number, number])[] = [
    [30, 36864, 552960, 128],
    [60, 122880, 3686400, 1500],
    [63, 245760, 7372800, 3000],
    [90, 552960, 16588800, 6000],
    [93, 983040, 33177600, 10000],
    [120, 2228224, 66846720, 12000],
    [123, 2228224, 133693440, 20000],
    [150, 8912896, 267386880, 25000],
    [153, 8912896, 534773760, 40000],
    [156, 8912896, 1069547520, 60000],
    [180, 35651584, 1069547520, 60000],
    [183, 35651584, 2139095040, 120000],
    [186, 35651584, 4278190080, 240000],
];

/**
 * [level × 10, MaxLumaSampleRate, MaxLumaPictureSize, MaxBitrate in kbps, max side] from the VP9
 * level definitions.
 */
const VP9_LEVELS: readonly (readonly [number, number, number, number, number])[] = [
    [10, 829440, 36864, 200, 512],
    [11, 2764800, 73728, 800, 768],
    [20, 4608000, 122880, 1800, 960],
    [21, 9216000, 245760, 3600, 1344],
    [30, 20736000, 552960, 7200, 2048],
    [31, 36864000, 983040, 12000, 2752],
    [40, 83558400, 2228224, 18000, 4160],
    [41, 160432128, 2228224, 30000, 4160],
    [50, 311951360, 8912896, 60000, 8384],
    [51, 588251136, 8912896, 120000, 8384],
    [52, 1176502272, 8912896, 180000, 8384],
    [60, 1176502272, 35651584, 180000, 16832],
    [61, 2353004544, 35651584, 240000, 16832],
    [62, 4706009088, 35651584, 480000, 16832],
];

/**
 * [seq_level_idx, MaxPicSize, MaxHSize, MaxVSize, MaxDisplayRate, Main tier MaxBitrate in kbps]
 * from AV1 Annex A.
 */
const AV1_LEVELS: readonly (readonly [number, number, number, number, number, number])[] = [
    [0, 147456, 2048, 1152, 4423680, 1500],
    [1, 278784, 2816, 1584, 8363520, 3000],
    [4, 665856, 4352, 2448, 19975680, 6000],
    [5, 1065024, 5504, 3096, 31950720, 10000],
    [8, 2359296, 6144, 3456, 70778880, 12000],
    [9, 2359296, 6144, 3456, 141557760, 20000],
    [12, 8912896, 8192, 4352, 267386880, 30000],
    [13, 8912896, 8192, 4352, 534773760, 40000],
    [14, 8912896, 8192, 4352, 1069547520, 60000],
    [15, 8912896, 8192, 4352, 1069547520, 60000],
    [16, 35651584, 16384, 8704, 1069547520, 60000],
    [17, 35651584, 16384, 8704, 2139095040, 100000],
    [18, 35651584, 16384, 8704, 4278190080, 160000],
    [19, 35651584, 16384, 8704, 4278190080, 160000],
];

const hex = (value: number): string => value.toString(16).padStart(2, '0');

function avcLevel(shape: VideoEncodeShape, high: boolean): number | undefined {
    const widthMbs = Math.ceil(shape.width / 16);
    const heightMbs = Math.ceil(shape.height / 16);
    const frameMbs = widthMbs * heightMbs;
    const kbps = shape.bitrate / 1000;
    return AVC_LEVELS.find(
        ([, maxMbps, maxFs, maxBr]) =>
            frameMbs <= maxFs &&
            widthMbs * widthMbs <= 8 * maxFs &&
            heightMbs * heightMbs <= 8 * maxFs &&
            frameMbs * shape.framerate <= maxMbps &&
            kbps <= maxBr * (high ? 1.25 : 1),
    )?.[0];
}

function hevcLevel(shape: VideoEncodeShape): number | undefined {
    const picture = shape.width * shape.height;
    return HEVC_LEVELS.find(
        ([, maxPs, maxSr, maxBr]) =>
            picture <= maxPs &&
            shape.width * shape.width <= 8 * maxPs &&
            shape.height * shape.height <= 8 * maxPs &&
            picture * shape.framerate <= maxSr &&
            shape.bitrate / 1000 <= maxBr,
    )?.[0];
}

function vp9Level(shape: VideoEncodeShape): number | undefined {
    const picture = shape.width * shape.height;
    return VP9_LEVELS.find(
        ([, maxSr, maxPs, maxBr, maxSide]) =>
            picture <= maxPs &&
            Math.max(shape.width, shape.height) <= maxSide &&
            picture * shape.framerate <= maxSr &&
            shape.bitrate / 1000 <= maxBr,
    )?.[0];
}

function av1Level(shape: VideoEncodeShape): number | undefined {
    const picture = shape.width * shape.height;
    return AV1_LEVELS.find(
        ([, maxPs, maxH, maxV, maxRate, maxBr]) =>
            picture <= maxPs &&
            shape.width <= maxH &&
            shape.height <= maxV &&
            picture * shape.framerate <= maxRate &&
            shape.bitrate / 1000 <= maxBr,
    )?.[0];
}

/**
 * Codec strings an encoder is asked for, most preferred first. A string with an explicit profile
 * keeps it and only raises a level below the one the output needs; a bare family or a default also
 * tries the other common profiles. An output beyond every level keeps the highest one.
 */
export function videoEncoderCodecs(
    codec: string,
    shape: VideoEncodeShape,
    explicit: boolean,
): string[] {
    const family = codecFamily(codec);
    const deep = shape.bitDepth === 10;
    if (family === 'avc') {
        const prefix = codec.startsWith('avc3') ? 'avc3' : 'avc1';
        const match = /^avc[13]\.([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(codec);
        const requested = match ? [[match[1]!, match[2]!, parseInt(match[3]!, 16)] as const] : [];
        const profiles: (readonly [string, string, number])[] =
            explicit && match
                ? [...requested]
                : [...requested, ['64', '00', 0], ['4d', '00', 0], ['42', 'e0', 0]];

        const seen = new Set<string>();
        const result: string[] = [];
        for (const [profile, constraints, level] of profiles) {
            const needed = avcLevel(shape, profile.toLowerCase() === '64') ?? 62;
            const value =
                `${prefix}.${profile}${constraints}${hex(Math.max(level, needed))}`.toLowerCase();
            if (!seen.has(value)) result.push(value);
            seen.add(value);
        }

        return result;
    }

    if (family === 'hvc1' || family === 'hev1') {
        const match =
            /^(hvc1|hev1)\.([A-Ca-c]?\d{1,3})\.([0-9a-fA-F]{1,8})\.([LH])(\d{1,3})(.*)$/.exec(
                codec,
            );
        const needed = hevcLevel(shape) ?? 186;
        if (match && explicit) {
            const [, entry, profile, compatibility, tier, level, rest] = match;
            const raised = Math.max(Number(level), needed);
            return [`${entry}.${profile}.${compatibility}.${tier}${raised}${rest}`];
        }
        return deep
            ? [`${family}.2.4.L${needed}.B0`]
            : [`${family}.1.6.L${needed}.B0`, `${family}.2.4.L${needed}.B0`];
    }

    if (family === 'vp09') {
        const match = /^vp09\.(\d{2})\.(\d{2})\.(\d{2})(.*)$/.exec(codec);
        const needed = vp9Level(shape) ?? 62;
        if (match && explicit) {
            const level = String(Math.max(Number(match[2]), needed)).padStart(2, '0');
            return [`vp09.${match[1]}.${level}.${match[3]}${match[4]}`];
        }
        return [deep ? `vp09.02.${needed}.10` : `vp09.00.${needed}.08`];
    }

    if (family === 'av01') {
        const match = /^av01\.([0-2])\.(\d{2})([MH])\.(\d{2})(.*)$/.exec(codec);
        const needed = av1Level(shape) ?? 19;
        if (match && explicit) {
            const level = String(Math.max(Number(match[2]), needed)).padStart(2, '0');
            return [`av01.${match[1]}.${level}${match[3]}.${match[4]}${match[5]}`];
        }
        return [`av01.0.${String(needed).padStart(2, '0')}M.${deep ? '10' : '08'}`];
    }

    return [codec];
}
