import { DemuxError, MediaForgeError, type ErrorCode } from '../../errors/errors';
import { AAC_SAMPLE_RATES } from './aac-sample-rates';
import { AacBitReader } from './aac-bits';

const AAC_CHANNEL_COUNTS = [0, 1, 2, 3, 4, 5, 6, 8] as const;

/** Audio object types whose AudioSpecificConfig carries a GASpecificConfig. */
export const AAC_GA_SPECIFIC_TYPES: ReadonlySet<number> = new Set([
    1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23,
]);

export interface AdtsFrameHeader {
    sampleRate: number;
    channels: number;
    audioObjectType: number;
    headerLength: number;
    frameLength: number;
    rawDataBlocks: number;
}

export function parseAdtsFrameHeader(adts: Uint8Array, offset = 0): AdtsFrameHeader | null {
    if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset + 7 > adts.length ||
        adts[offset] !== 0xff ||
        (adts[offset + 1]! & 0xf6) !== 0xf0
    )
        return null;
    const sampleRate = AAC_SAMPLE_RATES[(adts[offset + 2]! >> 2) & 0x0f];
    if (!sampleRate) return null;
    const channelConfiguration = ((adts[offset + 2]! & 1) << 2) | (adts[offset + 3]! >> 6);
    const headerLength = adts[offset + 1]! & 1 ? 7 : 9;
    const frameLength =
        ((adts[offset + 3]! & 3) << 11) | (adts[offset + 4]! << 3) | (adts[offset + 5]! >> 5);
    if (frameLength <= headerLength) return null;
    return {
        sampleRate,
        channels: AAC_CHANNEL_COUNTS[channelConfiguration]!,
        audioObjectType: (adts[offset + 2]! >> 6) + 1,
        headerLength,
        frameLength,
        rawDataBlocks: adts[offset + 6]! & 3,
    };
}

/**
 * AudioSpecificConfig for an ADTS frame with channel configuration 0, whose layout the program
 * config element opening its raw data block states (ISO/IEC 14496-3 1.6.2.1, 4.4.1.1): the element
 * is copied behind a GASpecificConfig, and its comment is realigned to the configuration. Null when
 * the frame does not start with one.
 */
export function adtsProgramConfig(
    frame: Uint8Array,
    header: AdtsFrameHeader,
): { config: Uint8Array; channels: number } | null {
    const index = AAC_SAMPLE_RATES.indexOf(header.sampleRate);
    if (index < 0 || header.audioObjectType > 4) return null;
    const block = frame.subarray(header.headerLength, header.frameLength);
    const out = new Uint8Array(frame.length + 8);
    let readAt = 0;
    let writeAt = 0;
    const reader = {
        read(count: number): number {
            if (readAt + count > block.length * 8)
                throw new RangeError('ADTS raw data block ends early');
            let value = 0;
            for (let bit = 0; bit < count; bit++, readAt++)
                value = value * 2 + ((block[readAt >> 3]! >> (7 - (readAt & 7))) & 1);
            return value;
        },
    };
    const writer = {
        put(value: number, count: number): void {
            for (let bit = count - 1; bit >= 0; bit--, writeAt++)
                if ((value >> bit) & 1) out[writeAt >> 3]! |= 0x80 >> (writeAt & 7);
        },
    };
    try {
        if (reader.read(3) !== 5) return null;
        writer.put(header.audioObjectType, 5);
        writer.put(index, 4);
        writer.put(0, 4);
        writer.put(0, 3);
        const copy = (count: number): number => {
            const value = reader.read(count);
            writer.put(value, count);
            return value;
        };
        copy(4 + 2 + 4);
        const front = copy(4);
        const side = copy(4);
        const back = copy(4);
        const lfe = copy(2);
        const assoc = copy(3);
        const cc = copy(4);
        if (copy(1)) copy(4);
        if (copy(1)) copy(4);
        if (copy(1)) copy(3);
        let channels = lfe;
        for (let element = 0; element < front + side + back; element++) {
            channels += copy(1) ? 2 : 1;
            copy(4);
        }
        for (let element = 0; element < lfe + assoc; element++) copy(4);
        for (let element = 0; element < cc; element++) copy(5);

        // byte_alignment() counts from the start of the raw data block there and of the
        // configuration here.
        reader.read((8 - (readAt & 7)) & 7);
        writeAt = (writeAt + 7) & ~7;
        const comment = copy(8);
        for (let byte = 0; byte < comment; byte++) copy(8);
        return channels > 0 ? { config: out.slice(0, writeAt >> 3), channels } : null;
    } catch (error) {
        if (error instanceof RangeError) return null;
        throw error;
    }
}

/** Split an ADTS stream (7/9-byte headers) into raw AAC access units. */
export function sliceAdtsFrames(adts: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let off = 0;
    while (off + 7 <= adts.length) {
        const header = parseAdtsFrameHeader(adts, off);
        if (!header) {
            off++;
            continue;
        }
        if (off + header.frameLength > adts.length) break;
        if (header.rawDataBlocks !== 0) {
            throw new DemuxError('ADTS frames with multiple raw_data_blocks are not supported');
        }
        frames.push(adts.subarray(off + header.headerLength, off + header.frameLength));
        off += header.frameLength;
    }
    return frames;
}

/** Sampling rate and channel count from the first ADTS header, if any. */
export function parseAdtsHeader(adts: Uint8Array): { sampleRate: number; channels: number } | null {
    for (let off = 0; off + 7 <= adts.length; off++) {
        const header = parseAdtsFrameHeader(adts, off);
        if (header && header.channels > 0) {
            return { sampleRate: header.sampleRate, channels: header.channels };
        }
    }
    return null;
}

function aacChannelConfiguration(channels: number, code: ErrorCode): number {
    if (Number.isInteger(channels) && channels >= 1 && channels <= 6) return channels;
    if (channels === 8) return 7;
    throw new MediaForgeError(
        `AAC channel count ${channels} requires an unsupported channel layout`,
        code,
    );
}

export function buildAacConfig(
    sampleRate: number,
    channels: number,
    audioObjectType: number,
): Uint8Array {
    if (!Number.isInteger(audioObjectType) || audioObjectType < 1 || audioObjectType > 4) {
        throw new MediaForgeError(`Unsupported AAC audio object type ${audioObjectType}`, 'FORMAT');
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0xffffff) {
        throw new MediaForgeError(`Invalid AAC sample rate ${sampleRate}`, 'FORMAT');
    }

    const channelConfiguration = aacChannelConfiguration(channels, 'FORMAT');
    const index = AAC_SAMPLE_RATES.indexOf(sampleRate);
    if (index >= 0) {
        return new Uint8Array([
            (audioObjectType << 3) | (index >> 1),
            ((index & 1) << 7) | (channelConfiguration << 3),
        ]);
    }
    return new Uint8Array([
        (audioObjectType << 3) | 7,
        0x80 | (sampleRate >> 17),
        (sampleRate >> 9) & 0xff,
        (sampleRate >> 1) & 0xff,
        ((sampleRate & 1) << 7) | (channelConfiguration << 3),
    ]);
}

/** Minimal AudioSpecificConfig for AAC-LC. */
export function buildAacAsc(sampleRate: number, channels: number): Uint8Array {
    return buildAacConfig(sampleRate, channels, 2);
}

export interface AdtsConfiguration {
    /** The MPEG-4 audio object type, 1 (Main) to 4 (LTP), which the profile field states. */
    audioObjectType: number;
    frequencyIndex: number;
    channelConfiguration: number;
}

/** The ADTS header fields of a stream; a stream ADTS cannot signal fails with `code`. */
export function getAdtsConfiguration(
    sampleRate: number,
    channels: number,
    code: ErrorCode,
    audioObjectType = 2,
): AdtsConfiguration {
    if (!Number.isInteger(audioObjectType) || audioObjectType < 1 || audioObjectType > 4)
        throw new MediaForgeError(`ADTS cannot signal AAC object type ${audioObjectType}`, code);
    const frequencyIndex = AAC_SAMPLE_RATES.indexOf(sampleRate);
    if (frequencyIndex < 0) {
        throw new MediaForgeError(`ADTS cannot represent sample rate ${sampleRate}`, code);
    }
    return {
        audioObjectType,
        frequencyIndex,
        channelConfiguration: aacChannelConfiguration(channels, code),
    };
}

/**
 * ADTS header fields for the raw frames an AudioSpecificConfig describes. ADTS signals the AAC
 * core, so SBR and parametric stereo stay implicit as in the LC stream they extend; layouts given
 * by a program config element and 960-sample frames have no ADTS form.
 */
export function adtsFieldsFromConfig(
    config: Uint8Array,
    code: ErrorCode,
): { sampleRate: number; channels: number; audioObjectType: number } {
    const parsed = parseAacAudioSpecificConfig(config);
    if (!parsed) throw new MediaForgeError('Invalid AAC AudioSpecificConfig', code);
    if ((parsed.samplesPerAccessUnit * parsed.coreSampleRate) / parsed.sampleRate !== 1024)
        throw new MediaForgeError('ADTS requires 1024-sample AAC access units', code);
    if (parsed.coreAudioObjectType < 1 || parsed.coreAudioObjectType > 4)
        throw new MediaForgeError(
            `ADTS cannot signal MPEG-4 audio object type ${parsed.coreAudioObjectType}`,
            code,
        );
    if (parsed.channelConfiguration === 0 || parsed.channelConfiguration > 7)
        throw new MediaForgeError('ADTS cannot carry this AAC channel layout', code);
    return {
        sampleRate: parsed.coreSampleRate,
        channels: parsed.channelCount,
        audioObjectType: parsed.coreAudioObjectType,
    };
}

export function getAdtsFrameLength(frame: Uint8Array, code: ErrorCode): number {
    if (
        !ArrayBuffer.isView(frame) ||
        Object.prototype.toString.call(frame) !== '[object Uint8Array]' ||
        frame.length < 1 ||
        frame.length > 8184
    ) {
        throw new MediaForgeError('ADTS payload must be a Uint8Array of 1 to 8184 bytes', code);
    }
    return frame.length + 7;
}

/** The raw AAC frames of one stream, with what ADTS headers signal of it. */
export interface AacFrames {
    readonly frames: readonly Uint8Array[];
    readonly sampleRate: number;
    readonly channels: number;
}

/** An ADTS stream of raw AAC-LC frames, such as encodeAacLc() returns. */
export function wrapAdts(stream: AacFrames): Uint8Array<ArrayBuffer> {
    const configuration = getAdtsConfiguration(stream.sampleRate, stream.channels, 'ENCODE');
    let total = 0;
    for (const frame of stream.frames) total += getAdtsFrameLength(frame, 'ENCODE');
    const out = new Uint8Array(new ArrayBuffer(total));
    let pos = 0;
    for (const frame of stream.frames) {
        const frameLength = frame.length + 7;
        writeAdtsHeader(out, pos, frameLength, configuration);
        out.set(frame, pos + 7);
        pos += frameLength;
    }
    return out;
}

export function writeAdtsHeader(
    out: Uint8Array,
    offset: number,
    frameLength: number,
    configuration: AdtsConfiguration,
): void {
    const { audioObjectType, frequencyIndex, channelConfiguration } = configuration;
    out[offset] = 0xff;
    out[offset + 1] = 0xf1;
    out[offset + 2] =
        ((audioObjectType - 1) << 6) | (frequencyIndex << 2) | (channelConfiguration >> 2);
    out[offset + 3] = ((channelConfiguration & 3) << 6) | (frameLength >> 11);
    out[offset + 4] = (frameLength >> 3) & 0xff;
    out[offset + 5] = ((frameLength & 7) << 5) | 0x1f;
    out[offset + 6] = 0xfc;
}

/** Syntactic element types of ISO/IEC 14496-3 table 4.85. */
export const AAC_SCE = 0;
export const AAC_CPE = 1;
export const AAC_CCE = 2;
export const AAC_LFE = 3;

/** Speaker groups of a program config element. */
export const AAC_FRONT = 1;
export const AAC_SIDE = 2;
export const AAC_BACK = 3;
export const AAC_LFE_GROUP = 4;
const AAC_COUPLING = 5;

/**
 * One element of a channel layout: syntactic element type, element instance tag and speaker group.
 */
export interface AacLayoutElement {
    readonly type: number;
    readonly tag: number;
    readonly position: number;
}

/** Channels of the indexed channel configurations 1..14 (0: given by a program config element). */
const AAC_CONFIGURATION_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8, 0, 0, 0, 7, 8, 24, 8, 0] as const;

/** Output channels of a layout: coupling elements carry none, a channel pair two. */
export function aacLayoutChannels(layout: readonly AacLayoutElement[]): number {
    let channels = 0;
    for (const element of layout)
        if (element.position !== AAC_COUPLING) channels += element.type === AAC_CPE ? 2 : 1;
    return channels;
}

/**
 * program_config_element() after its element_instance_tag (ISO/IEC 14496-3 table 4.2): the element
 * layout in front, side, back, LFE and coupling order; the comment is byte-aligned relative to bit
 * `alignOrigin`.
 */
export function readAacProgramConfig(
    reader: AacBitReader,
    alignOrigin: number,
): AacLayoutElement[] {
    reader.skip(2);
    reader.skip(4);
    const front = reader.read(4);
    const side = reader.read(4);
    const back = reader.read(4);
    const lfe = reader.read(2);
    const assocData = reader.read(3);
    const coupling = reader.read(4);
    if (reader.readBit()) reader.skip(4);
    if (reader.readBit()) reader.skip(4);
    if (reader.readBit()) reader.skip(3);

    const layout: AacLayoutElement[] = [];
    const group = (count: number, position: number): void => {
        for (let i = 0; i < count; i++) {
            const type =
                position === AAC_LFE_GROUP
                    ? AAC_LFE
                    : position === AAC_COUPLING
                      ? (reader.skip(1), AAC_CCE)
                      : reader.readBit()
                        ? AAC_CPE
                        : AAC_SCE;
            layout.push({ type, tag: reader.read(4), position });
        }
    };

    group(front, AAC_FRONT);
    group(side, AAC_SIDE);
    group(back, AAC_BACK);
    group(lfe, AAC_LFE_GROUP);
    reader.skip(4 * assocData);
    group(coupling, AAC_COUPLING);
    reader.align(alignOrigin);
    reader.skip(8 * reader.read(8));
    return layout;
}

export interface ParsedAacAudioSpecificConfig {
    audioObjectType: number;
    /** Object type of the AAC core (the one after an explicit SBR/PS signal). */
    coreAudioObjectType: number;
    /** Output rate when SBR is signalled explicitly, otherwise the core rate. */
    sampleRate: number;
    coreSampleRate: number;
    /**
     * Core channels: of the channel configuration, or of the program config element (0 when
     * unreadable).
     */
    channelCount: number;
    samplesPerAccessUnit: number;
    /** channelConfiguration field; 0 means the program config element gives the layout. */
    channelConfiguration: number;
    /** Sampling frequency index of the core; 15 means an explicit rate. */
    samplingIndex: number;
    /**
     * SBR signalled present (1), absent (0) or left to the first frame (-1, implicit signalling).
     */
    sbr: number;
    /** Parametric stereo present (1), absent (0) or implicit (-1). */
    ps: number;
    /**
     * SBR output rate signalled explicitly (the core rate itself means downsampled SBR); 0 when not
     * signalled.
     */
    extensionSampleRate: number;
    /** 960-sample core frames (frameLengthFlag). */
    frameLengthShort: boolean;
    /** Element layout of the program config element when channelConfiguration is 0. */
    programLayout?: readonly AacLayoutElement[];
}

const AAC_SYNC_EXTENSION = 0x2b7;

/**
 * MPEG-1 audio rates the MP3onMP4 draft indexes with the first three sampling frequency indices.
 */
const MP3_ON_MP4_DRAFT_RATES = [44100, 48000, 32000] as const;
const PS_SYNC_EXTENSION = 0x548;

export function parseAacAudioSpecificConfig(
    config: Uint8Array,
): ParsedAacAudioSpecificConfig | null {
    if (config.length === 0) return null;
    const reader = new AacBitReader(config);
    const available = (bits: number): boolean => reader.bitsLeft() >= bits;
    const readObjectType = (): number | null => {
        if (!available(5)) return null;
        let objectType = reader.read(5);
        if (objectType === 31) {
            if (!available(6)) return null;
            objectType = 32 + reader.read(6);
        }
        return objectType > 0 ? objectType : null;
    };
    const readFrequency = (): { index: number; rate: number } | null => {
        if (!available(4)) return null;
        const index = reader.read(4);
        if (index === 15) {
            if (!available(24)) return null;
            const explicit = reader.read(24);
            return explicit > 0 ? { index, rate: explicit } : null;
        }
        const rate = AAC_SAMPLE_RATES[index];
        return rate && rate > 0 ? { index, rate } : null;
    };

    let audioObjectType = readObjectType();
    const initial = readFrequency();
    if (audioObjectType === null || initial === null || !available(4)) return null;
    const channelConfiguration = reader.read(4);

    // MP3onMP4: object types 32..34 carry MPEG audio layers 1..3. The W6132 draft wrote layer 3 as
    // object type 29 followed by bits no parametric stereo configuration starts with (ISO/IEC
    // 14496-3 Annex YYYY draft).
    const draftBits =
        ((config[reader.bitsRead() >> 3] ?? 0) << 8) | (config[(reader.bitsRead() >> 3) + 1] ?? 0);
    const peek9 = (draftBits >> (7 - (reader.bitsRead() & 7))) & 0x1ff;
    const draftMp3 = audioObjectType === 29 && (peek9 >> 6) & 0x03 && (peek9 & 0x3f) === 0;
    if (draftMp3 || (audioObjectType >= 32 && audioObjectType <= 34)) {
        if (draftMp3) audioObjectType = 34;
        const rate =
            draftMp3 && initial.index < 3 ? MP3_ON_MP4_DRAFT_RATES[initial.index]! : initial.rate;
        return {
            audioObjectType,
            coreAudioObjectType: audioObjectType,
            sampleRate: rate,
            coreSampleRate: rate,
            channelCount: AAC_CONFIGURATION_CHANNELS[channelConfiguration] ?? 0,
            samplesPerAccessUnit: audioObjectType === 32 ? 384 : 1152,
            channelConfiguration,
            samplingIndex: initial.index,
            sbr: 0,
            ps: 0,
            extensionSampleRate: 0,
            frameLengthShort: false,
        };
    }

    let coreAudioObjectType = audioObjectType;
    let sampleRate = initial.rate;
    let sbr = -1;
    let ps = -1;
    let extensionSampleRate = 0;
    if (audioObjectType === 5 || audioObjectType === 29) {
        const extension = readFrequency();
        const extensionCoreType = readObjectType();
        if (extension === null || extensionCoreType === null) return null;
        sampleRate = extension.rate;
        extensionSampleRate = extension.rate;
        coreAudioObjectType = extensionCoreType;
        sbr = 1;
        if (audioObjectType === 29) ps = 1;
    }
    const specificStart = reader.bitsRead();

    // Backward-compatible signalling: a sync extension after the core config names SBR (and PS)
    // explicitly.
    if (sbr !== 1) {
        const scan = new AacBitReader(config);
        scan.seek(specificStart);
        while (scan.bitsLeft() > 15) {
            if (scan.peek(11) !== AAC_SYNC_EXTENSION) {
                scan.skip(1);
                continue;
            }
            scan.skip(11);
            let extensionType = scan.read(5);
            if (extensionType === 31) extensionType = 32 + scan.read(6);
            if (extensionType === 5 && (sbr = scan.read(1)) === 1) {
                const index = scan.read(4);
                const rate = index === 15 ? scan.read(24) : (AAC_SAMPLE_RATES[index] ?? 0);
                extensionSampleRate = rate;

                // SBR at the core rate is left to the first frame, which then runs it downsampled.
                if (rate === initial.rate) sbr = -1;
                else if (rate > 0) sampleRate = rate;
            }
            if (scan.bitsLeft() > 11 && scan.read(11) === PS_SYNC_EXTENSION) ps = scan.read(1);
            break;
        }
    }
    if (sbr === 0) ps = 0;
    const indexedChannels = AAC_CONFIGURATION_CHANNELS[channelConfiguration] ?? 0;
    if ((ps === -1 && coreAudioObjectType !== 2) || indexedChannels > 1) ps = 0;

    let frameLengthShort = false;
    let channelCount: number = indexedChannels;
    let programLayout: AacLayoutElement[] | undefined;
    if (AAC_GA_SPECIFIC_TYPES.has(coreAudioObjectType)) {
        try {
            frameLengthShort = reader.readBit() === 1;
            if (reader.readBit()) reader.skip(14);
            reader.skip(1);
            if (coreAudioObjectType === 6 || coreAudioObjectType === 20) reader.skip(3);
            if (channelConfiguration === 0) {
                reader.skip(4);
                programLayout = readAacProgramConfig(reader, 0);
                channelCount = aacLayoutChannels(programLayout);
            }
        } catch {
            programLayout = undefined;
        }
    }
    if (frameLengthShort && sbr === 1) {
        sbr = 0;
        ps = 0;
        sampleRate = initial.rate;
    }
    if (programLayout && aacLayoutChannels(programLayout) > 1) ps = 0;
    else if (sbr === 1 && ps === -1 && (programLayout ? channelCount : indexedChannels) <= 1)
        ps = 1;

    const expansion = Math.max(1, Math.round(sampleRate / initial.rate));
    return {
        audioObjectType,
        coreAudioObjectType,
        sampleRate,
        coreSampleRate: initial.rate,
        channelCount,
        samplesPerAccessUnit: (frameLengthShort ? 960 : 1024) * expansion,
        channelConfiguration,
        samplingIndex: initial.index,
        sbr,
        ps,
        extensionSampleRate,
        frameLengthShort,
        ...(programLayout ? { programLayout } : {}),
    };
}

/**
 * RFC 6381 codec string of an AAC stream that decodes to `sampleRate` and `channels`: mp4a.40.29
 * with parametric stereo, mp4a.40.5 with SBR (signalled, or implicit and settled by the first
 * frame), otherwise the object type.
 */
export function aacCodecString(config: Uint8Array, sampleRate: number, channels: number): string {
    const parsed = parseAacAudioSpecificConfig(config);
    if (!parsed) return 'mp4a.40.2';
    const sbr =
        parsed.sbr === 1 ||
        (parsed.sbr === -1 &&
            (sampleRate === 2 * parsed.coreSampleRate ||
                parsed.extensionSampleRate === parsed.coreSampleRate));
    const ps =
        sbr &&
        (parsed.ps === 1 || (parsed.ps === -1 && parsed.channelCount === 1 && channels === 2));
    return ps ? 'mp4a.40.29' : sbr ? 'mp4a.40.5' : `mp4a.40.${parsed.audioObjectType}`;
}

export function readAacAudioObjectType(config: Uint8Array): number | null {
    return parseAacAudioSpecificConfig(config)?.audioObjectType ?? null;
}
