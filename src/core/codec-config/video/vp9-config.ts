/**
 * VP9 decoder configuration in its two container spellings: the ISO BMFF vpcC record (version 1, 12
 * bytes including the full-box header) and the WebM CodecPrivate feature list (one-byte id,
 * one-byte length, value TLVs).
 */
interface Vp9Features {
    readonly profile: number;
    readonly level: number;
    readonly bitDepth: number;
    /** vpcC chromaSubsampling: 0/1 = 4:2:0, 2 = 4:2:2, 3 = 4:4:4. */
    readonly chromaSubsampling: number;
}

interface Vp9Colour {
    readonly primaries: number;
    readonly transfer: number;
    readonly matrix: number;
    readonly fullRange?: boolean;
}

const VP9_LEVELS = Object.freeze([10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 52, 60, 61, 62]);
const VP9_BIT_DEPTHS = Object.freeze([8, 10, 12]);
const VPCC_LENGTH = 12;

function validFeatures(features: Vp9Features): boolean {
    const { profile, level, bitDepth, chromaSubsampling } = features;
    return (
        Number.isInteger(profile) &&
        profile >= 0 &&
        profile <= 3 &&
        VP9_LEVELS.includes(level) &&
        VP9_BIT_DEPTHS.includes(bitDepth) &&
        (profile < 2 ? bitDepth === 8 : bitDepth >= 10) &&
        (profile % 2 === 0
            ? chromaSubsampling <= 1
            : chromaSubsampling === 2 || chromaSubsampling === 3)
    );
}

/** vp9, or vp09.PP.LL.DD with the optional chroma, colour and range fields. */
const VP9_CODEC_STRING = new RegExp(
    String.raw`^vp(?:9|09)(?:\.(\d{2})\.(\d{2})\.(\d{2})` +
        String.raw`(?:\.(\d{2})(?:\.\d{2}\.\d{2}\.\d{2}\.\d{2})?)?)?$`,
    'i',
);

/**
 * Profile, level and bit depth from an RFC 6381 string such as vp09.02.51.10; plain vp9/vp09 is
 * profile 0.
 */
function parseVp9CodecString(codec: string): Vp9Features | undefined {
    const match = VP9_CODEC_STRING.exec(codec.trim());
    if (!match) return undefined;
    const profile = match[1] === undefined ? 0 : Number(match[1]);
    const features = {
        profile,
        level: match[2] === undefined ? 10 : Number(match[2]),
        bitDepth: match[3] === undefined ? 8 : Number(match[3]),
        chromaSubsampling: match[4] === undefined ? (profile % 2 === 0 ? 1 : 3) : Number(match[4]),
    };
    return validFeatures(features) ? features : undefined;
}

export function vp9CodecString(
    features: Pick<Vp9Features, 'profile' | 'level' | 'bitDepth'>,
): string {
    return `vp09.${[features.profile, features.level, features.bitDepth]
        .map(value => String(value).padStart(2, '0'))
        .join('.')}`;
}

/** True for a version-1 vpcC payload; WebM feature lists and other blobs are not. */
export function isVpcC(config: Uint8Array | undefined): config is Uint8Array {
    return (
        config !== undefined &&
        config.length === VPCC_LENGTH &&
        config[0] === 1 &&
        config[1] === 0 &&
        config[2] === 0 &&
        config[3] === 0 &&
        config[10] === 0 &&
        config[11] === 0 &&
        parseVpcC(config) !== undefined
    );
}

export function parseVpcC(config: Uint8Array): (Vp9Features & { colour: Vp9Colour }) | undefined {
    if (config.length < VPCC_LENGTH || config[0] !== 1) return undefined;
    const features = {
        profile: config[4]!,
        level: config[5]!,
        bitDepth: config[6]! >>> 4,
        chromaSubsampling: (config[6]! >>> 1) & 7,
    };
    if (!validFeatures(features)) return undefined;
    const matrix = config[9]!;
    if (matrix === 0 && features.chromaSubsampling !== 3) return undefined;
    return {
        ...features,
        colour: {
            primaries: config[7]!,
            transfer: config[8]!,
            matrix,
            fullRange: (config[6]! & 1) === 1,
        },
    };
}

/**
 * WebM VP9 CodecPrivate features; undefined for a malformed list, a contradictory one, or an
 * incomplete triple.
 */
export function parseWebmVp9Features(config: Uint8Array | undefined): Vp9Features | undefined {
    if (!config?.length) return undefined;
    const features = new Map<number, number>();
    for (let offset = 0; offset < config.length;) {
        if (offset + 2 > config.length) return undefined;
        const id = config[offset++]!;
        const length = config[offset++]!;
        if (length > config.length - offset) return undefined;
        if (id >= 1 && id <= 4) {
            if (length !== 1 || (features.has(id) && features.get(id) !== config[offset]))
                return undefined;
            features.set(id, config[offset]!);
        }
        offset += length;
    }

    const profile = features.get(1);
    const level = features.get(2);
    const bitDepth = features.get(3);
    if (profile === undefined || level === undefined || bitDepth === undefined) return undefined;
    const result = {
        profile,
        level,
        bitDepth,
        chromaSubsampling: features.get(4) ?? (profile % 2 === 0 ? 1 : 3),
    };
    return validFeatures(result) ? result : undefined;
}

/**
 * The codec string a VP9 track reports: from its vpcC or WebM features when present, else the
 * declared string.
 */
export function vp9CodecFromConfig(codec: string, config: Uint8Array | undefined): string {
    const features = isVpcC(config) ? parseVpcC(config) : parseWebmVp9Features(config);
    return features ? vp9CodecString(features) : codec;
}

/**
 * Version-1 vpcC payload; colour defaults to BT.709 limited range, which is what unlabeled VP9
 * streams assume.
 */
function buildVpcC(features: Vp9Features, colour?: Vp9Colour): Uint8Array<ArrayBuffer> {
    if (!validFeatures(features))
        throw new RangeError(`invalid VP9 features ${JSON.stringify(features)}`);
    const primaries = colour?.primaries ?? 1;
    const transfer = colour?.transfer ?? 1;
    const matrix =
        colour?.matrix === undefined || (colour.matrix === 0 && features.chromaSubsampling !== 3)
            ? 1
            : colour.matrix;
    const config = new Uint8Array(VPCC_LENGTH);
    config[0] = 1;
    config[4] = features.profile;
    config[5] = features.level;
    config[6] =
        (features.bitDepth << 4) | (features.chromaSubsampling << 1) | (colour?.fullRange ? 1 : 0);
    config[7] = primaries & 0xff;
    config[8] = transfer & 0xff;
    config[9] = matrix & 0xff;
    return config;
}

/**
 * A vpcC for any VP9 track: an existing record is kept, a WebM feature list is converted, and a
 * bare codec string (the common WebM case without CodecPrivate) supplies profile, level and bit
 * depth.
 */
export function vpcCFor(
    codec: string,
    config: Uint8Array | undefined,
    colour?: Vp9Colour,
): Uint8Array<ArrayBuffer> | undefined {
    if (isVpcC(config)) return new Uint8Array(config);
    const features = parseWebmVp9Features(config) ?? parseVp9CodecString(codec);
    return features ? buildVpcC(features, colour) : undefined;
}

/**
 * WebM CodecPrivate feature list (profile, level, bit depth, chroma subsampling) for a vpcC record.
 */
export function webmVp9Features(vpcC: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
    const parsed = parseVpcC(vpcC);
    if (!parsed) return undefined;
    return Uint8Array.of(
        1,
        1,
        parsed.profile,
        2,
        1,
        parsed.level,
        3,
        1,
        parsed.bitDepth,
        4,
        1,
        parsed.chromaSubsampling,
    );
}
