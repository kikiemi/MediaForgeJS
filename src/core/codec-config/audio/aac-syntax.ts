import { DecodeError, MediaForgeError } from '../../errors/errors';
import {
    SWB_OFFSET_1024,
    SWB_OFFSET_128,
    SWB_OFFSET_120,
    SWB_OFFSET_960,
    SF_HUFF_BITS,
    SF_HUFF_CODES,
    SPECTRAL_BOOKS,
    type SpectralBook,
    TNS_MAX_BANDS_1024,
    TNS_MAX_BANDS_128,
} from './aac-tables';
import { AAC_SAMPLE_RATES } from './aac-sample-rates';
import { AacBitReader, decodeHuffman, huffmanCode, type HuffmanCode } from './aac-bits';
import {
    AAC_BACK,
    AAC_CCE,
    AAC_CPE,
    AAC_FRONT,
    AAC_LFE,
    AAC_LFE_GROUP,
    AAC_SCE,
    AAC_SIDE,
    aacLayoutChannels,
    parseAacAudioSpecificConfig,
    readAacProgramConfig,
    type AacLayoutElement,
    type ParsedAacAudioSpecificConfig,
} from './adts';

export const FRAME_LEN = 1024;
export const SHORT_LEN = 128;
const NOISE_OFFSET = 90;

export const ONLY_LONG = 0;
export const LONG_START = 1;
export const EIGHT_SHORT = 2;
export const LONG_STOP = 3;

export const ZERO_HCB = 0;
export const NOISE_HCB = 13;
export const INTENSITY_HCB2 = 14;
export const INTENSITY_HCB = 15;

const ID_DSE = 4;
const ID_PCE = 5;
const ID_FIL = 6;
const ID_END = 7;

const EXT_FILL = 0;
const EXT_DYNAMIC_RANGE = 11;
const EXT_SBR_DATA = 13;
const EXT_SBR_DATA_CRC = 14;

export const AOT_AAC_MAIN = 1;
export const AOT_AAC_LC = 2;

/** Coupling points of a coupling channel element. */
export const BEFORE_TNS = 0;
export const BETWEEN_TNS_AND_IMDCT = 1;
export const AFTER_IMDCT = 3;

/** Maximum prediction bands per sampling index (ISO/IEC 14496-3 table 4.156). */
export const PRED_SFB_MAX = Uint8Array.from([33, 33, 38, 40, 40, 40, 41, 41, 37, 37, 37, 34, 34]);
export const MAX_PREDICTORS = 672;
const CCE_SCALE = [2 ** (1 / 8), 2 ** (1 / 4), Math.SQRT2, 2];

const SF_TREE = huffmanCode(SF_HUFF_CODES, SF_HUFF_BITS);

/**
 * A spectral codebook's prefix code, the `dim` values of each of its symbols (unsigned books:
 * magnitudes) and, for an unsigned book, how many of them are nonzero: the sign bits that follow
 * the codeword.
 */
interface SpectralCode {
    readonly code: HuffmanCode;
    readonly values: Int8Array;
    readonly signBits: Uint8Array;
}

/** The spectral codebooks' codes, each built when a frame first uses it. */
const spectralCodes: SpectralCode[] = [];

function spectralCode(book: number): SpectralCode | undefined {
    const spectral = SPECTRAL_BOOKS[book];
    if (!spectral) return undefined;
    let built = spectralCodes[book];
    if (!built) {
        const { dim, lav, range, signed, codes } = spectral;

        // A symbol holds `dim` digits base `range`, the first the most significant; signed books
        // offset them by lav.
        const values = new Int8Array(codes.length * 4);
        const signBits = new Uint8Array(codes.length);
        for (let symbol = 0; symbol < codes.length; symbol++) {
            let index = symbol;
            for (let d = dim - 1; d >= 0; d--) {
                const digit = index % range;
                values[symbol * 4 + d] = signed ? digit - lav : digit;
                if (!signed && digit !== 0) signBits[symbol]!++;
                index = (index - digit) / range;
            }
        }
        built = spectralCodes[book] = { code: huffmanCode(codes, spectral.bits), values, signBits };
    }
    return built;
}

interface Ics {
    windowSequence: [number, number];
    useKbWindow: [number, number];
    maxSfb: number;
    numWindowGroups: number;
    groupLen: Uint8Array;
    numWindows: number;
    swbOffset: Uint16Array;
    numSwb: number;
    tnsMaxBands: number;
    predictorPresent: boolean;
    predictorResetGroup: number;
    predictionUsed: Uint8Array;
}

function newIcs(): Ics {
    return {
        windowSequence: [ONLY_LONG, ONLY_LONG],
        useKbWindow: [0, 0],
        maxSfb: 0,
        numWindowGroups: 1,
        groupLen: new Uint8Array(8),
        numWindows: 1,
        swbOffset: SWB_OFFSET_1024[4]!,
        numSwb: 0,
        tnsMaxBands: 0,
        predictorPresent: false,
        predictorResetGroup: 0,
        predictionUsed: new Uint8Array(41),
    };
}

function copyIcs(target: Ics, source: Ics): void {
    const kb = target.useKbWindow[0];
    target.windowSequence = [source.windowSequence[0], source.windowSequence[1]];
    target.useKbWindow = [source.useKbWindow[0], kb];
    target.maxSfb = source.maxSfb;
    target.numWindowGroups = source.numWindowGroups;
    target.groupLen.set(source.groupLen);
    target.numWindows = source.numWindows;
    target.swbOffset = source.swbOffset;
    target.numSwb = source.numSwb;
    target.tnsMaxBands = source.tnsMaxBands;
    target.predictorPresent = source.predictorPresent;
    target.predictorResetGroup = source.predictorResetGroup;
    target.predictionUsed.set(source.predictionUsed);
}

interface Tns {
    present: boolean;
    nFilt: Uint8Array;
    length: Uint8Array;
    order: Uint8Array;
    direction: Uint8Array;
    coef: Float64Array;
}

/** Individual channel stream state: one output channel. */
export class Channel {
    readonly ics = newIcs();
    readonly bandType = new Uint8Array(128);
    readonly bandTypeRunEnd = new Uint8Array(128);
    /**
     * Scalefactor (dequantization exponent), noise energy exponent or intensity position per band.
     */
    readonly sf = new Int32Array(128);
    readonly coeffs = new Float64Array(FRAME_LEN);
    readonly saved = new Float64Array(512);
    /** Time signal of the last frame: 1024 core samples, 2048 after SBR. */
    readonly ret = new Float64Array(2 * FRAME_LEN);
    readonly tns: Tns = {
        present: false,
        nFilt: new Uint8Array(8),
        length: new Uint8Array(8 * 4),
        order: new Uint8Array(8 * 4),
        direction: new Uint8Array(8 * 4),
        coef: new Float64Array(8 * 4 * 20),
    };
    predictorState: Float32Array | null = null;
    predictorInitialized = false;
}

interface Coupling {
    couplingPoint: number;
    numCoupled: number;
    type: Uint8Array;
    idSelect: Uint8Array;
    chSelect: Uint8Array;
    gain: Float64Array[];
}

/** A syntactic element: one channel (SCE, LFE, CCE) or a pair (CPE), with its SBR state. */
export class Element {
    readonly ch: [Channel, Channel] = [new Channel(), new Channel()];
    readonly msMask = new Uint8Array(128);
    present = false;
    readonly coupling: Coupling = {
        couplingPoint: 0,
        numCoupled: 0,
        type: new Uint8Array(8),
        idSelect: new Uint8Array(8),
        chSelect: new Uint8Array(8),
        gain: Array.from({ length: 16 }, () => new Float64Array(120)),
    };
    sbr: AacSbrProcessor | null = null;
    constructor(readonly type: number) {}
}

/** SBR (with parametric stereo) of one channel element; the he-aac plugin supplies it. */
export interface AacSbrProcessor {
    readExtension(
        reader: AacBitReader,
        crc: boolean,
        count: number,
        elementType: number,
        sampleRate: number,
        ps: number,
    ): void;
    apply(
        elementType: number,
        left: Float64Array,
        right: Float64Array,
        extensionRate: number,
        ps: boolean,
    ): void;
}

/** Creates the SBR processor of a channel element (SCE, CPE or CCE). */
export interface AacSbrTools {
    readonly createSbr: (elementType: number) => AacSbrProcessor;
}

/**
 * Elements of the indexed channel configurations 1..14 in bitstream order (ISO/IEC 14496-3 table
 * 1.19).
 */
const CONFIGURATION_LAYOUTS: readonly (readonly [number, number, number][])[] = [
    [],
    [[AAC_SCE, 0, AAC_FRONT]],
    [[AAC_CPE, 0, AAC_FRONT]],
    [
        [AAC_SCE, 0, AAC_FRONT],
        [AAC_CPE, 0, AAC_FRONT],
    ],
    [
        [AAC_SCE, 0, AAC_FRONT],
        [AAC_CPE, 0, AAC_FRONT],
        [AAC_SCE, 1, AAC_BACK],
    ],
    [
        [AAC_SCE, 0, AAC_FRONT],
        [AAC_CPE, 0, AAC_FRONT],
        [AAC_CPE, 1, AAC_BACK],
    ],
    [
        [AAC_SCE, 0, AAC_FRONT],
        [AAC_CPE, 0, AAC_FRONT],
        [AAC_CPE, 1, AAC_BACK],
        [AAC_LFE, 0, AAC_LFE_GROUP],
    ],
    // Configuration 7 is decoded with the second front pair as a back pair (7.1 rather than 7.1
    // wide), as common 7.1 encoders intend.
    [
        [AAC_SCE, 0, AAC_FRONT],
        [AAC_CPE, 0, AAC_FRONT],
        [AAC_CPE, 1, AAC_BACK],
        [AAC_CPE, 2, AAC_BACK],
        [AAC_LFE, 0, AAC_LFE_GROUP],
    ],
    [],
    [],
    [],
    [
        [AAC_SCE, 0, AAC_FRONT],
        [AAC_CPE, 0, AAC_FRONT],
        [AAC_CPE, 1, AAC_BACK],
        [AAC_SCE, 1, AAC_BACK],
        [AAC_LFE, 0, AAC_LFE_GROUP],
    ],
    [
        [AAC_SCE, 0, AAC_FRONT],
        [AAC_CPE, 0, AAC_FRONT],
        [AAC_CPE, 1, AAC_BACK],
        [AAC_CPE, 2, AAC_BACK],
        [AAC_LFE, 0, AAC_LFE_GROUP],
    ],
    [],
    [
        [AAC_SCE, 0, AAC_FRONT],
        [AAC_CPE, 0, AAC_FRONT],
        [AAC_CPE, 1, AAC_BACK],
        [AAC_LFE, 0, AAC_LFE_GROUP],
        [AAC_CPE, 2, AAC_FRONT],
    ],
];
const CONFIGURATION_TAGS = [0, 1, 1, 2, 3, 3, 4, 5, 0, 0, 0, 5, 5, 16, 5, 0];

/** Speaker numbers (WAVE bit positions) per layer and speaker group; -1 none, -2 unused slot. */
const NONE = -1;
const UNUSED = -2;
const SPEAKER_MAP: readonly (readonly (readonly number[])[])[] = [
    [
        [2, 6, 7, 0, 1, NONE],
        [UNUSED, NONE, NONE, NONE, NONE, NONE],
        [UNUSED, 9, 10, 4, 5, 8],
        [3, 35, NONE, NONE, NONE, NONE],
    ],
    [
        [13, NONE, NONE, 12, 14, NONE],
        [UNUSED, 36, 37, NONE, NONE, 11],
        [UNUSED, NONE, NONE, 15, 17, 16],
        [NONE, NONE, NONE, NONE, NONE, NONE],
    ],
    [
        [38, NONE, NONE, 39, 40, NONE],
        [NONE, NONE, NONE, NONE, NONE, NONE],
        [NONE, NONE, NONE, NONE, NONE, NONE],
        [NONE, NONE, NONE, NONE, NONE, NONE],
    ],
];

interface SpeakerSlot {
    element: AacLayoutElement;
    /** Sum of the speaker bits (2^position) of the element's channels. */
    speakers: number;
}

/**
 * Speaker assignment of a layout in the common decoder convention: each group (front, side, back,
 * LFE) of each layer takes centre, then pairs from the outside in; the slots are sorted by speaker.
 * Null when the layout names speakers that do not exist.
 */
function assignSpeakers(
    layout: readonly AacLayoutElement[],
): { order: AacLayoutElement[]; mask: number } | null {
    const slots: SpeakerSlot[] = [];
    let mask = 0;
    let i = 0;
    const bit = (speaker: number): number => 2 ** speaker;
    const pairedChannels = (position: number): number => {
        let channels = 0;
        let firstCpe = false;
        let parity = false;
        for (let j = i; j < layout.length; j++) {
            const element = layout[j]!;
            if (element.position !== position) break;
            if (element.type === AAC_CPE) {
                if (parity) {
                    if (position === AAC_FRONT && !firstCpe) parity = false;
                    else return -1;
                }
                channels += 2;
                firstCpe = true;
            } else {
                channels++;
                if (position !== AAC_LFE_GROUP) parity = !parity;
            }
        }
        if (parity && position === AAC_FRONT && firstCpe) return -1;
        return channels;
    };
    const single = (speaker: number): void => {
        slots.push({ element: layout[i]!, speakers: bit(speaker) });
        mask += bit(speaker);
        i++;
    };
    const assign = (layer: number, position: number): boolean => {
        let channels = pairedChannels(position);
        if (channels < 0 || channels > 5) return true;
        const map = SPEAKER_MAP[layer]![position - 1]!;
        if (position === AAC_LFE_GROUP) {
            for (let j = 0; channels > 0; j++, channels--) {
                if (map[j] === NONE) return false;
                single(map[j]!);
            }
            return true;
        }
        while (channels & 1) {
            if (map[0] === NONE) return false;
            if (map[0] === UNUSED) break;
            single(map[0]!);
            channels--;
        }
        for (
            let j = position !== AAC_SIDE && channels <= 3 ? 3 : 1;
            channels >= 2;
            j += 2, channels -= 2
        ) {
            const left = map[j]!;
            const right = map[j + 1]!;
            if (left === NONE || right === NONE) return false;
            const element = layout[i]!;
            if (element.type === AAC_CPE) {
                slots.push({ element, speakers: bit(left) + bit(right) });
                i++;
            } else {
                slots.push({ element, speakers: bit(left) });
                slots.push({ element: layout[i + 1]!, speakers: bit(right) });
                i += 2;
            }
            mask += bit(left) + bit(right);
        }
        while (channels & 1) {
            if (map[5] === NONE) return false;
            single(map[5]!);
            channels--;
        }
        return channels === 0;
    };
    for (let layer = 0; layer < 3 && i < layout.length; layer++) {
        for (const position of [AAC_FRONT, AAC_SIDE, AAC_BACK, AAC_LFE_GROUP]) {
            if (!assign(layer, position)) return null;
        }
    }
    const sorted = slots.map((slot, index) => ({ slot, index }));
    sorted.sort((a, b) => a.slot.speakers - b.slot.speakers || a.index - b.index);
    return { order: [...sorted.map(entry => entry.slot.element), ...layout.slice(i)], mask };
}

interface OutputLayout {
    readonly elements: readonly AacLayoutElement[];
    readonly mask: number;
    readonly channels: number;
}

/**
 * Output configuration states: configured from the global header, trial from a frame, locked after
 * output.
 */
const OC_NONE = 0;
const OC_CONFIGURED = 1;
const OC_LOCKED = 2;

/** Initial decoder state of an AudioSpecificConfig, see AacDecoder. */
export interface AacDecoderConfig {
    readonly objectType: number;
    readonly samplingIndex: number;
    readonly sampleRate: number;
    readonly channelConfiguration: number;
    readonly programLayout?: readonly AacLayoutElement[];
    readonly sbr: number;
    readonly ps: number;
    readonly extensionSampleRate: number;
    /** 960-sample frames (frameLengthFlag). */
    readonly frameLengthShort?: boolean;
}

/**
 * The decoder configuration of a parsed AudioSpecificConfig; profiles other than Main and LC are
 * rejected.
 */
export function aacDecoderConfig(parsed: ParsedAacAudioSpecificConfig): AacDecoderConfig {
    const objectType = parsed.coreAudioObjectType;
    if (objectType >= 32 && objectType <= 34)
        throw new DecodeError(`AAC: MP3onMP4 audio (object type ${objectType}) is not supported`);
    if (objectType !== AOT_AAC_MAIN && objectType !== AOT_AAC_LC)
        throw new DecodeError(`AAC: audio object type ${objectType} is not supported`);
    if (parsed.samplingIndex > 12)
        throw new DecodeError('AAC: explicit core sampling rates are not supported');
    if (
        parsed.channelConfiguration === 0
            ? !parsed.programLayout
            : !CONFIGURATION_TAGS[parsed.channelConfiguration]
    )
        throw new DecodeError(
            `AAC: channel configuration ${parsed.channelConfiguration} is not supported`,
        );
    return {
        objectType,
        samplingIndex: parsed.samplingIndex,
        sampleRate: parsed.coreSampleRate,
        channelConfiguration: parsed.channelConfiguration,
        ...(parsed.programLayout ? { programLayout: parsed.programLayout } : {}),
        sbr: parsed.sbr,
        ps: parsed.ps,
        extensionSampleRate: parsed.sbr === 0 ? 0 : parsed.extensionSampleRate,
        frameLengthShort: parsed.frameLengthShort,
    };
}

/**
 * The error for a stream that uses SBR when the decoder has no SBR tools; the caller names what
 * supplies them. By default the frame fails with DECODE.
 */
export type MissingSbr = (message: string) => Error;

const NO_SBR_TOOLS: MissingSbr = message =>
    new DecodeError(`${message}, and this decoder has no SBR tools`);

/**
 * The syntax of AAC access units with the output configuration they settle: the channel elements,
 * program config, fill and SBR extension elements of each raw data block, read without dequantizing
 * or transforming. AacDecoder extends it with the synthesis; on its own it settles the output shape
 * from a first frame (aacOutputShape), so describing an input does not load the decoder.
 *
 * Self-hosted AAC decoder (ISO/IEC 14496-3 Main and LC profiles with program config elements,
 * coupling channels, SBR and parametric stereo). The output layout follows the common decoder
 * convention: planes in WAVE speaker order, mono HE-AAC with parametric stereo (explicit or
 * implicit) as stereo, implicit SBR when the first frame carries it.
 */
export class AacSyntax {
    protected readonly objectType: number;
    protected readonly samplingIndex: number;
    protected readonly coreRate: number;
    private readonly swbLong: Uint16Array;
    private readonly swbShort: Uint16Array;
    /** Core frame length: 1024, or 960 with frameLengthFlag. */
    protected readonly frameLen: number;
    private channelConfiguration: number;
    protected sbr: number;
    protected ps: number;
    protected extensionRate: number;
    private status = OC_NONE;
    private layout: OutputLayout = { elements: [], mask: 0, channels: 0 };
    /** Elements by type and allocation index. */
    protected readonly elements: Map<number, Element>[] = [
        new Map(),
        new Map(),
        new Map(),
        new Map(),
    ];
    /** Elements by type and element instance tag. */
    private tagMap: Map<number, Element>[] = [new Map(), new Map(), new Map(), new Map()];
    protected outputs: Channel[] = [];
    private tagsMapped = 0;
    private randomState = 0x1f2e3d4c;
    /**
     * The frame being read is a probe (probeFrame()), whose spectra are parsed but not dequantized.
     */
    private probing = false;
    /**
     * Output samples the first frame asks to discard (libfaac marks its 1024-sample encoder delay).
     */
    private skipRequest = 0;
    /**
     * Frames decoded so far; a libfaac mark after the first frame is a stream concatenated after
     * encoding.
     */
    private framesDecoded = 0;
    /**
     * The current frame carries a later libfaac mark: its encoder delay is dropped from this
     * frame's output.
     */
    private spliceDelay = false;
    /** Bits consumed by the last decodeFrame call (structure checks use it). */
    lastBitsConsumed = 0;
    lastCodedBands = 0;

    /**
     * The missing-SBR error last thrown, which leaves the settled output configuration in place.
     */
    protected sbrFailure?: Error;

    constructor(
        config: AacDecoderConfig,
        protected readonly sbrTools?: AacSbrTools,
        protected readonly missingSbr: MissingSbr = NO_SBR_TOOLS,
    ) {
        this.objectType = config.objectType;
        this.samplingIndex = config.samplingIndex;
        this.coreRate = config.sampleRate;
        if (AAC_SAMPLE_RATES[this.samplingIndex] === undefined)
            throw new DecodeError('AAC: invalid sampling index');
        this.frameLen = config.frameLengthShort ? 960 : FRAME_LEN;
        const short = this.frameLen === FRAME_LEN;
        this.swbLong = (short ? SWB_OFFSET_1024 : SWB_OFFSET_960)[this.samplingIndex]!;
        this.swbShort = (short ? SWB_OFFSET_128 : SWB_OFFSET_120)[this.samplingIndex]!;
        this.channelConfiguration = config.channelConfiguration;
        this.sbr = config.sbr;
        this.ps = config.ps;
        this.extensionRate = config.extensionSampleRate;
        const layout =
            config.channelConfiguration === 0
                ? config.programLayout!
                : CONFIGURATION_LAYOUTS[config.channelConfiguration]!.map(
                      ([type, tag, position]) => ({
                          type,
                          tag,
                          position,
                      }),
                  );
        this.configureOutput(layout, OC_CONFIGURED);
    }

    /** Output sample rate: twice the core rate once SBR upsamples. */
    get sampleRate(): number {
        return this.sbr === 1 && this.extensionRate > this.coreRate
            ? this.coreRate * 2
            : this.coreRate;
    }

    /** Output channels. */
    get channels(): number {
        return this.layout.channels;
    }

    /** WAVE speaker mask of the output planes, when the layout names only WAVE speakers. */
    get channelMask(): number | undefined {
        const mask = this.layout.mask;
        let count = 0;
        for (let bits = mask; bits > 0; bits = Math.floor(bits / 2)) count += bits % 2;
        return mask > 0 && mask < 0x40000 && count === this.layout.channels ? mask : undefined;
    }

    /** Samples per channel of each decoded frame. */
    get frameLength(): number {
        return this.sampleRate === this.coreRate ? this.frameLen : 2 * this.frameLen;
    }

    /**
     * Leading output samples to discard, as requested by the stream so far (libfaac's encoder
     * delay).
     */
    get leadingSkip(): number {
        return this.skipRequest;
    }

    private configureOutput(layout: readonly AacLayoutElement[], status: number): void {
        const assigned = assignSpeakers(layout);
        let mask = assigned?.mask ?? 0;
        const elements = assigned?.order ?? layout.slice();
        const counters = [0, 0, 0, 0];
        const allocation = new Map<AacLayoutElement, number>();
        for (const element of layout) allocation.set(element, counters[element.type]!++);
        const outputs: Channel[] = [];
        const tagMap: Map<number, Element>[] = [new Map(), new Map(), new Map(), new Map()];
        for (const element of elements) {
            const index = allocation.get(element)!;
            let target = this.elements[element.type]!.get(index);
            if (!target) {
                target = new Element(element.type);
                this.elements[element.type]!.set(index, target);
            }
            if (element.type !== AAC_CCE) {
                outputs.push(target.ch[0]);
                if (element.type === AAC_CPE || (element.type === AAC_SCE && this.ps === 1))
                    outputs.push(target.ch[1]);
            }
            tagMap[element.type]!.set(element.tag, target);
        }
        if (outputs.length > 8)
            throw new DecodeError(
                `AAC: ${outputs.length} output channels exceed the eight supported`,
            );
        if (this.ps === 1 && outputs.length === 2) mask = mask === 0x4 ? 0x3 : 0;
        this.outputs = outputs;
        this.tagMap = tagMap;
        this.layout = { elements: layout, mask, channels: outputs.length };
        this.status = status;
    }

    private element(type: number, index: number): Element | null {
        return this.elements[type]!.get(index) ?? null;
    }

    /**
     * The element a syntactic element of this frame decodes into (indexed layouts map by position).
     */
    private channelElement(type: number, tag: number): Element | null {
        if (this.channelConfiguration === 0) return this.tagMap[type]!.get(tag) ?? null;

        // A stereo pair in a mono configuration, or single channels in a stereo one, reconfigure
        // the output.
        if (this.tagsMapped === 0 && type === AAC_CPE && this.channelConfiguration === 1) {
            this.channelConfiguration = 2;
            this.ps = 0;
            this.configureOutput([{ type: AAC_CPE, tag: 0, position: AAC_FRONT }], OC_CONFIGURED);
        }
        if (this.tagsMapped === 0 && type === AAC_SCE && this.channelConfiguration === 2) {
            this.configureOutput(
                [
                    { type: AAC_SCE, tag: 0, position: AAC_FRONT },
                    { type: AAC_SCE, tag: 1, position: AAC_FRONT },
                ],
                OC_CONFIGURED,
            );
            if (this.sbr !== 0) this.ps = -1;
        }
        const config = this.channelConfiguration;
        const mapped = this.tagsMapped;
        const take = (targetType: number, index: number): Element | null => {
            this.tagsMapped++;
            return this.element(targetType, index);
        };
        const last =
            mapped === CONFIGURATION_TAGS[config]! - 1 && (type === AAC_LFE || type === AAC_SCE);

        // Positional mapping with the common decoder's repairs: a trailing single channel of 5.1
        // (and larger) layouts is the LFE, the trailing channel of 4.0 is the back centre.
        if (
            config >= 14 &&
            mapped > 2 &&
            ((type === AAC_CPE && tag < 3) || (type === AAC_LFE && tag < 1))
        )
            return take(type, tag);
        if (
            config >= 13 &&
            mapped > 3 &&
            ((type === AAC_CPE && tag < 8) ||
                (type === AAC_SCE && tag < 6) ||
                (type === AAC_LFE && tag < 2))
        )
            return take(type, tag);
        if ((config >= 12 || config === 7) && mapped === 3 && type === AAC_CPE)
            return take(AAC_CPE, 2);
        if (config >= 11 || config === 7) {
            if (mapped === 3 && type === AAC_SCE) return take(AAC_SCE, 1);
        }
        if (config >= 6 && last) return take(AAC_LFE, 0);
        if (config >= 5 && mapped === 2 && type === AAC_CPE) return take(AAC_CPE, 1);
        if (config >= 4) {
            if (last) return take(AAC_SCE, 1);
            if (mapped === 2 && config === 4 && type === AAC_SCE) return take(AAC_SCE, 1);
        }
        if (config >= 2) {
            if (mapped === (config !== 2 ? 1 : 0) && type === AAC_CPE) return take(AAC_CPE, 0);
            if (mapped === 1 && config === 2 && type === AAC_SCE) return take(AAC_SCE, 1);
        }
        if (mapped === 0 && type === AAC_SCE) return take(AAC_SCE, 0);
        return null;
    }

    /**
     * Reads one access unit as decodeFrame() does and settles the same output shape, without the
     * inverse transforms and PCM: for describing a stream from its first frame.
     */
    probeFrame(accessUnit: Uint8Array): void {
        this.readFrame(accessUnit, true);
    }

    protected readFrame(accessUnit: Uint8Array, probe: boolean): Float32Array[] {
        this.probing = probe;
        const saved = {
            layout: this.layout,
            outputs: this.outputs,
            tagMap: this.tagMap,
            status: this.status,
            channelConfiguration: this.channelConfiguration,
            ps: this.ps,
        };
        try {
            return this.decodeRawDataBlock(accessUnit, probe);
        } catch (error) {
            // A frame that fails leaves the output configuration as it was, unless the stream had
            // not produced output or only the SBR plugin is missing (the configuration it settled
            // is valid).
            const missingSbr = error !== undefined && error === this.sbrFailure;
            if (saved.status !== OC_NONE && !missingSbr) {
                this.layout = saved.layout;
                this.outputs = saved.outputs;
                this.tagMap = saved.tagMap;
                this.status = saved.status;
                this.channelConfiguration = saved.channelConfiguration;
                this.ps = saved.ps;
            }
            for (const elements of this.elements)
                for (const element of elements.values()) element.present = false;
            throw error;
        }
    }

    private decodeRawDataBlock(accessUnit: Uint8Array, probe: boolean): Float32Array[] {
        const reader = new AacBitReader(accessUnit);
        this.spliceDelay = false;
        this.lastCodedBands = 0;
        this.tagsMapped = 0;
        const presence = new Uint8Array(4 * 16);
        let previous: Element | null = null;
        let previousType = ID_END;
        let samples = 0;
        let audioFound = false;
        let pceFound = false;
        for (;;) {
            const type = reader.read(3);
            if (type === ID_END) break;
            let tag = reader.read(4);
            let element: Element | null = null;
            if (!this.layout.channels && type !== ID_PCE)
                throw new DecodeError('AAC: frame precedes any channel layout');
            if (type < ID_DSE) {
                const seen = presence[type * 16 + tag]!++;
                if (seen > 1)
                    throw new DecodeError(
                        `AAC: channel element ${type}.${tag} repeats within a frame`,
                    );
                element = this.channelElement(type, tag);
                if (!element)
                    throw new DecodeError(
                        `AAC: channel element ${type}.${tag} is not in the channel layout`,
                    );
                samples = this.frameLen;
                element.present = true;
            }
            switch (type) {
                case AAC_SCE:
                case AAC_LFE:
                    this.decodeIcs(reader, element!.ch[0], false);
                    audioFound = true;
                    break;
                case AAC_CPE:
                    this.decodeCpe(reader, element!);
                    audioFound = true;
                    break;
                case AAC_CCE:
                    this.decodeCce(reader, element!);
                    break;
                case ID_DSE: {
                    const align = reader.readBit();
                    let count = reader.read(8);
                    if (count === 255) count += reader.read(8);
                    if (align) reader.align();
                    reader.skip(8 * count);
                    break;
                }
                case ID_PCE: {
                    const layout = readAacProgramConfig(reader, 0);
                    if (!pceFound) {
                        if (
                            this.status === OC_LOCKED &&
                            aacLayoutChannels(layout) !== this.layout.channels
                        )
                            throw new DecodeError(
                                'AAC: program config element changes the channel count',
                            );
                        this.configureOutput(layout, OC_CONFIGURED);
                        this.channelConfiguration = 0;
                        pceFound = true;
                    }
                    break;
                }
                case ID_FIL: {
                    if (tag === 15) tag += reader.read(8) - 1;
                    if (reader.bitsLeft() < 8 * tag)
                        throw new DecodeError('AAC: fill element overruns the frame');
                    while (tag > 0)
                        tag -= this.decodeExtension(reader, tag, previous, previousType);
                    break;
                }
            }
            if (type < ID_DSE) {
                previous = element;
                previousType = type;
            }
            if (reader.bitsLeft() < 3) throw new DecodeError('AAC: bitstream exhausted');
        }
        this.lastBitsConsumed = reader.bitsRead();
        if (samples && this.sbr === 1 && this.extensionRate > this.coreRate) samples *= 2;
        if (probe) {
            for (const elements of this.elements)
                for (const element of elements.values()) element.present = false;
            if (this.status !== OC_NONE && audioFound) this.status = OC_LOCKED;
            this.framesDecoded++;
            return [];
        }
        this.spectralToSample();
        if (this.status !== OC_NONE && audioFound) this.status = OC_LOCKED;

        // A stream concatenated after encoding marks its encoder delay again; like the first
        // frame's, it is not presented (ffmpeg drops it the same way).
        const skip = this.spliceDelay ? Math.min(samples, FRAME_LEN) : 0;
        this.framesDecoded++;
        const out: Float32Array[] = [];
        for (const channel of this.outputs) {
            const plane = new Float32Array(samples - skip);
            plane.set(channel.ret.subarray(skip, samples));
            out.push(plane);
        }
        return out;
    }

    private decodeExtension(
        reader: AacBitReader,
        count: number,
        element: Element | null,
        elementType: number,
    ): number {
        const start = reader.bitsRead();
        const type = reader.read(4);
        const skip = (): number => {
            reader.seek(start + 8 * count);
            return count;
        };
        switch (type) {
            case EXT_SBR_DATA_CRC:
            case EXT_SBR_DATA: {
                if (!element || this.sbr === 0 || (this.sbr === -1 && this.status === OC_LOCKED))
                    return skip();
                if (this.ps === -1 && this.status !== OC_LOCKED && this.layout.channels === 1) {
                    this.sbr = 1;
                    this.ps = 1;
                    this.configureOutput(this.layout.elements, this.status);
                } else {
                    this.sbr = 1;
                }
                if (!this.extensionRate) this.extensionRate = 2 * this.coreRate;
                if (!this.sbrTools) return skip();
                element.sbr ??= this.sbrTools.createSbr(element.type);
                element.sbr.readExtension(
                    reader,
                    type === EXT_SBR_DATA_CRC,
                    count,
                    elementType,
                    this.coreRate * 2,
                    this.ps,
                );
                return skip();
            }
            case EXT_DYNAMIC_RANGE:
                return this.readDynamicRange(reader, count);
            case EXT_FILL:
                this.readFill(reader, 8 * count - 4);
                return skip();
            default:
                return skip();
        }
    }

    /**
     * dynamic_range_info() is parsed for its length only; like common decoders, no compression is
     * applied.
     */
    private readDynamicRange(reader: AacBitReader, count: number): number {
        let bytes = 1;
        let bands = 1;
        if (reader.readBit()) {
            reader.skip(8);
            bytes++;
        }
        if (reader.readBit()) {
            let excluded = 0;
            do {
                reader.skip(7);
                excluded += 7;
            } while (excluded < 64 - 7 && reader.readBit());
            bytes += excluded / 7;
        }
        if (reader.readBit()) {
            const increment = reader.read(4);
            reader.skip(4);
            bytes++;
            bands += increment;
            reader.skip(8 * bands);
            bytes += bands;
        }
        if (reader.readBit()) {
            reader.skip(8);
            bytes++;
        }
        reader.skip(8 * bands);
        bytes += bands;
        return Math.min(bytes, count);
    }

    /**
     * fill_element text: libfaac writes its version and starts with a 1024-sample encoder delay.
     */
    private readFill(reader: AacBitReader, bits: number): void {
        if (bits < 13 + 7 * 8) return;
        reader.skip(13);
        let text = '';
        for (let left = bits - 13; left >= 8 && text.length < 255; left -= 8)
            text += String.fromCharCode(reader.read(8));
        if (!/^libfaac\s*[+-]?\d+\.\s*[+-]?\d/.test(text.split('\0')[0]!)) return;
        this.skipRequest = FRAME_LEN;
        if (this.framesDecoded > 0) this.spliceDelay = true;
    }

    private readIcsInfo(reader: AacBitReader, ics: Ics): void {
        reader.skip(1);
        ics.windowSequence = [reader.read(2), ics.windowSequence[0]];
        ics.useKbWindow = [reader.readBit(), ics.useKbWindow[0]];
        ics.numWindowGroups = 1;
        ics.groupLen.fill(0);
        ics.groupLen[0] = 1;
        ics.predictorPresent = false;
        ics.predictorResetGroup = 0;
        if (ics.windowSequence[0] === EIGHT_SHORT) {
            ics.maxSfb = reader.read(4);
            for (let i = 0; i < 7; i++) {
                if (reader.readBit()) ics.groupLen[ics.numWindowGroups - 1]!++;
                else ics.groupLen[ics.numWindowGroups++] = 1;
            }
            ics.numWindows = 8;
            ics.swbOffset = this.swbShort;
            ics.numSwb = this.swbShort.length - 1;
            ics.tnsMaxBands = TNS_MAX_BANDS_128[this.samplingIndex]!;
        } else {
            ics.maxSfb = reader.read(6);
            ics.numWindows = 1;
            ics.swbOffset = this.swbLong;
            ics.numSwb = this.swbLong.length - 1;
            ics.tnsMaxBands = TNS_MAX_BANDS_1024[this.samplingIndex]!;
            ics.predictorPresent = reader.readBit() === 1;
            if (ics.predictorPresent) {
                if (this.objectType !== AOT_AAC_MAIN)
                    throw new DecodeError(
                        'AAC: prediction is not allowed outside the Main profile',
                    );
                if (reader.readBit()) {
                    ics.predictorResetGroup = reader.read(5);
                    if (ics.predictorResetGroup === 0 || ics.predictorResetGroup > 30)
                        throw new DecodeError('AAC: invalid predictor reset group');
                }
                const bands = Math.min(ics.maxSfb, PRED_SFB_MAX[this.samplingIndex]!);
                for (let sfb = 0; sfb < bands; sfb++) ics.predictionUsed[sfb] = reader.readBit();
            }
        }
        if (ics.maxSfb > ics.numSwb) {
            ics.maxSfb = 0;
            throw new DecodeError('AAC: max_sfb exceeds band table');
        }
    }

    private decodeCpe(reader: AacBitReader, element: Element): void {
        const [left, right] = element.ch;
        const commonWindow = reader.readBit() === 1;
        let msPresent = 0;
        if (commonWindow) {
            this.readIcsInfo(reader, left.ics);
            copyIcs(right.ics, left.ics);
            msPresent = reader.read(2);
            if (msPresent === 3) throw new DecodeError('AAC: reserved ms_mask_present value');
            const count = left.ics.numWindowGroups * left.ics.maxSfb;
            if (msPresent === 1)
                for (let i = 0; i < count; i++) element.msMask[i] = reader.readBit();
            else if (msPresent === 2) element.msMask.fill(1, 0, count);
        }
        this.decodeIcs(reader, left, commonWindow);
        this.decodeIcs(reader, right, commonWindow);
        this.joinPair(element, commonWindow, msPresent);
    }

    /**
     * Synthesis of a channel pair after its spectra: mid/side, prediction and intensity stereo
     * (AacDecoder).
     */
    protected joinPair(_element: Element, _commonWindow: boolean, _msPresent: number): void {}

    /** Prediction of a channel decoded alone in the Main profile (AacDecoder). */
    protected predict(_channel: Channel): void {}

    /** Dequantization of the spectrum read, with its pulses (AacDecoder). */
    protected dequantize(_channel: Channel, _positions: number[], _amplitudes: number[]): void {}

    /**
     * Coupling, TNS, inverse transforms and SBR of the elements present in the frame (AacDecoder).
     */
    protected spectralToSample(): void {}

    private decodeCce(reader: AacBitReader, element: Element): void {
        const coupling = element.coupling;
        let gains = 0;
        coupling.couplingPoint = 2 * reader.readBit();
        coupling.numCoupled = reader.read(3);
        for (let c = 0; c <= coupling.numCoupled; c++) {
            gains++;
            coupling.type[c] = reader.readBit() ? AAC_CPE : AAC_SCE;
            coupling.idSelect[c] = reader.read(4);
            if (coupling.type[c] === AAC_CPE) {
                coupling.chSelect[c] = reader.read(2);
                if (coupling.chSelect[c] === 3) gains++;
            } else {
                coupling.chSelect[c] = 2;
            }
        }
        coupling.couplingPoint += reader.readBit() || coupling.couplingPoint >> 1;
        const sign = reader.readBit();
        const scale = CCE_SCALE[reader.read(2)]!;
        const channel = element.ch[0];
        this.decodeIcs(reader, channel, false);
        for (let c = 0; c < gains; c++) {
            let common = 1;
            let gain = 0;
            let cache = 1;
            if (c) {
                common = coupling.couplingPoint === AFTER_IMDCT ? 1 : reader.readBit();
                gain = common ? decodeHuffman(reader, SF_TREE) - 60 : 0;
                cache = Math.pow(scale, -gain);
            }
            const gainTable = coupling.gain[c]!;
            if (coupling.couplingPoint === AFTER_IMDCT) {
                gainTable[0] = cache;
                continue;
            }
            const ics = channel.ics;
            for (let g = 0, idx = 0; g < ics.numWindowGroups; g++) {
                for (let sfb = 0; sfb < ics.maxSfb; sfb++, idx++) {
                    if (channel.bandType[idx] === ZERO_HCB) continue;
                    if (!common) {
                        let t = decodeHuffman(reader, SF_TREE) - 60;
                        if (t) {
                            let s = 1;
                            t = gain += t;
                            if (sign) {
                                s -= 2 * (t & 1);
                                t >>= 1;
                            }
                            cache = Math.pow(scale, -t) * s;
                        }
                    }
                    gainTable[idx] = cache;
                }
            }
        }
    }

    private decodeIcs(reader: AacBitReader, channel: Channel, commonWindow: boolean): void {
        const ics = channel.ics;
        const globalGain = reader.read(8);
        if (!commonWindow) this.readIcsInfo(reader, ics);
        this.lastCodedBands += ics.maxSfb * ics.numWindowGroups;
        const shortWindows = ics.windowSequence[0] === EIGHT_SHORT;
        const offsets = ics.swbOffset;

        const bandType = channel.bandType;
        const runEnd = channel.bandTypeRunEnd;
        const lenBits = shortWindows ? 3 : 5;
        const escape = (1 << lenBits) - 1;
        for (let g = 0, idx = 0; g < ics.numWindowGroups; g++) {
            let k = 0;
            while (k < ics.maxSfb) {
                let end = k;
                const book = reader.read(4);
                if (book === 12) throw new DecodeError('AAC: invalid band type');
                for (;;) {
                    const increment = reader.read(lenBits);
                    end += increment;
                    if (end > ics.maxSfb) throw new DecodeError('AAC: section overruns max_sfb');
                    if (increment !== escape) break;
                }
                for (; k < end; k++, idx++) {
                    bandType[idx] = book;
                    runEnd[idx] = end;
                }
            }
        }

        const sf = channel.sf;
        let offset = globalGain;
        let noise = globalGain - NOISE_OFFSET;
        let intensity = 0;
        let firstNoise = true;
        for (let g = 0, idx = 0; g < ics.numWindowGroups; g++) {
            for (let sfb = 0; sfb < ics.maxSfb; sfb++, idx++) {
                const book = bandType[idx]!;
                if (book === ZERO_HCB) {
                    sf[idx] = 0;
                } else if (book === INTENSITY_HCB || book === INTENSITY_HCB2) {
                    intensity += decodeHuffman(reader, SF_TREE) - 60;
                    sf[idx] = Math.max(-155, Math.min(100, intensity));
                } else if (book === NOISE_HCB) {
                    if (firstNoise) {
                        firstNoise = false;
                        noise += reader.read(9) - 256;
                    } else {
                        noise += decodeHuffman(reader, SF_TREE) - 60;
                    }
                    sf[idx] = Math.max(-100, Math.min(155, noise));
                } else {
                    offset += decodeHuffman(reader, SF_TREE) - 60;
                    if (offset < 0 || offset > 255)
                        throw new DecodeError(`AAC: scalefactor ${offset} out of range`);
                    sf[idx] = offset;
                }
            }
        }

        const pulsePositions: number[] = [];
        const pulseAmplitudes: number[] = [];
        if (reader.readBit()) {
            if (shortWindows) throw new DecodeError('AAC: pulse data with short windows');
            const count = reader.read(2) + 1;
            const startSfb = reader.read(6);
            if (startSfb >= ics.numSwb) throw new DecodeError('AAC: invalid pulse data');
            let position = offsets[startSfb]!;
            for (let i = 0; i < count; i++) {
                position += reader.read(5);
                if (position >= offsets[ics.numSwb]!)
                    throw new DecodeError('AAC: invalid pulse data');
                pulsePositions.push(position);
                pulseAmplitudes.push(reader.read(4));
            }
        }

        channel.tns.present = reader.readBit() === 1;
        if (channel.tns.present) this.readTns(reader, channel.tns, ics);
        if (reader.readBit()) throw new DecodeError('AAC: SSR gain control is not supported');

        this.decodeSpectrum(reader, channel, pulsePositions, pulseAmplitudes);
        if (this.objectType === AOT_AAC_MAIN && !commonWindow) this.predict(channel);
    }

    private decodeSpectrum(
        reader: AacBitReader,
        channel: Channel,
        positions: number[],
        amplitudes: number[],
    ): void {
        const ics = channel.ics;
        const offsets = ics.swbOffset;
        const spec = channel.coeffs;
        spec.fill(0);
        let window = 0;
        for (let g = 0, idx = 0; g < ics.numWindowGroups; g++) {
            const groupLen = ics.groupLen[g]!;
            for (let sfb = 0; sfb < ics.maxSfb; sfb++, idx++) {
                const book = channel.bandType[idx]!;
                const width = offsets[sfb + 1]! - offsets[sfb]!;
                if (book === ZERO_HCB || book === INTENSITY_HCB || book === INTENSITY_HCB2)
                    continue;
                if (book === NOISE_HCB) {
                    const target = Math.pow(2, 0.25 * channel.sf[idx]!);
                    for (let w = 0; w < groupLen; w++) {
                        const base = (window + w) * SHORT_LEN + offsets[sfb]!;
                        let energy = 0;
                        for (let i = 0; i < width; i++) {
                            this.randomState =
                                (Math.imul(this.randomState, 1664525) + 1013904223) | 0;
                            spec[base + i] = this.randomState;
                            energy += this.randomState * this.randomState;
                        }
                        const scale = target / Math.sqrt(energy);
                        for (let i = 0; i < width; i++) spec[base + i]! *= scale;
                    }
                    continue;
                }
                const spectral = SPECTRAL_BOOKS[book];
                const code = spectralCode(book);
                if (!spectral || !code) throw new DecodeError(`AAC: invalid codebook ${book}`);
                for (let w = 0; w < groupLen; w++) {
                    decodeSpectralRun(
                        reader,
                        spectral,
                        code,
                        spec,
                        (window + w) * SHORT_LEN + offsets[sfb]!,
                        width,
                    );
                }
            }
            window += groupLen;
        }

        // A probe reads the frame's syntax only: it needs no coefficient values.
        if (!this.probing) this.dequantize(channel, positions, amplitudes);
    }

    private readTns(reader: AacBitReader, tns: Tns, ics: Ics): void {
        const short = ics.windowSequence[0] === EIGHT_SHORT;
        const maxOrder = short ? 7 : this.objectType === AOT_AAC_MAIN ? 20 : 12;
        for (let w = 0; w < ics.numWindows; w++) {
            tns.nFilt[w] = reader.read(short ? 1 : 2);
            if (!tns.nFilt[w]) continue;
            const coefRes = reader.readBit();
            for (let f = 0; f < tns.nFilt[w]!; f++) {
                const slot = w * 4 + f;
                tns.length[slot] = reader.read(short ? 4 : 6);
                const order = reader.read(short ? 3 : 5);
                if (order > maxOrder)
                    throw new DecodeError(`AAC: TNS filter order ${order} exceeds ${maxOrder}`);
                tns.order[slot] = order;
                if (!order) continue;
                tns.direction[slot] = reader.readBit();
                const compress = reader.readBit();
                const resBits = coefRes + 3;
                const coefBits = resBits - compress;
                const signShift = 1 << (coefBits - 1);
                const iqfacPos = ((1 << (resBits - 1)) - 0.5) / (Math.PI / 2);
                const iqfacNeg = ((1 << (resBits - 1)) + 0.5) / (Math.PI / 2);
                for (let i = 0; i < order; i++) {
                    let v = reader.read(coefBits);
                    if (v >= signShift) v -= 2 * signShift;
                    tns.coef[slot * 20 + i] = Math.sin(v / (v >= 0 ? iqfacPos : iqfacNeg));
                }
            }
        }
    }
}

/**
 * Escape value of an escape codebook (lav 16): 16 or more follows as a prefix and that many bits.
 */
function escaped(reader: AacBitReader, value: number): number {
    if (value !== 16 && value !== -16) return value;
    let prefix = 4;
    while (reader.readBit()) {
        prefix++;
        if (prefix > 12) throw new DecodeError('AAC: escape sequence overflow');
    }
    const magnitude = (1 << prefix) + reader.read(prefix);
    return value < 0 ? -magnitude : magnitude;
}

function decodeSpectralRun(
    reader: AacBitReader,
    book: SpectralBook,
    spectral: SpectralCode,
    spec: Float64Array,
    base: number,
    count: number,
): void {
    const { dim, lav, signed } = book;
    const escape = lav === 16;
    const { code, values, signBits } = spectral;

    // The bits are read in the order of the syntax: the codeword, then a sign bit for each nonzero
    // value of an unsigned book, the first value's first, then escapes.
    if (dim === 4) {
        for (let i = 0; i < count; i += 4) {
            const symbol = decodeHuffman(reader, code);
            const at = symbol * 4;
            let a = values[at]!;
            let b = values[at + 1]!;
            let c = values[at + 2]!;
            let d = values[at + 3]!;
            let n = signed ? 0 : signBits[symbol]!;
            if (n) {
                const signs = reader.read(n);
                if (a && (signs >> --n) & 1) a = -a;
                if (b && (signs >> --n) & 1) b = -b;
                if (c && (signs >> --n) & 1) c = -c;
                if (d && (signs >> --n) & 1) d = -d;
            }
            const slot = base + i;
            spec[slot] = a;
            if (i + 1 < count) spec[slot + 1] = b;
            if (i + 2 < count) spec[slot + 2] = c;
            if (i + 3 < count) spec[slot + 3] = d;
        }
        return;
    }
    for (let i = 0; i < count; i += 2) {
        const symbol = decodeHuffman(reader, code);
        const at = symbol * 4;
        let a = values[at]!;
        let b = values[at + 1]!;
        let n = signed ? 0 : signBits[symbol]!;
        if (n) {
            const signs = reader.read(n);
            if (a && (signs >> --n) & 1) a = -a;
            if (b && (signs >> --n) & 1) b = -b;
        }
        if (escape) {
            a = escaped(reader, a);
            b = escaped(reader, b);
        }
        spec[base + i] = a;
        if (i + 1 < count) spec[base + i + 1] = b;
    }
}

/** The decoder configuration of an AudioSpecificConfig. */
export function aacConfigOf(config: Uint8Array): AacDecoderConfig {
    const parsed = parseAacAudioSpecificConfig(config);
    if (!parsed) throw new DecodeError('AAC: invalid AudioSpecificConfig');
    return aacDecoderConfig(parsed);
}

/**
 * Output shape of an AAC stream: the syntax settles implicit SBR, parametric stereo and element
 * layouts on the first frame, and libfaac streams ask to skip their encoder delay.
 */
export function aacOutputShape(
    config: Uint8Array,
    firstFrame: Uint8Array | undefined,
): {
    sampleRate: number;
    channels: number;
    channelMask?: number;
    frameLength: number;
    leadingSkip: number;
} {
    const decoder = new AacSyntax(aacConfigOf(config));
    if (firstFrame) {
        try {
            decoder.probeFrame(firstFrame);
        } catch (error) {
            if (!(error instanceof MediaForgeError)) throw error;
        }
    }
    const mask = decoder.channelMask;
    return {
        sampleRate: decoder.sampleRate,
        channels: decoder.channels,
        ...(mask !== undefined ? { channelMask: mask } : {}),
        frameLength: decoder.frameLength,
        leadingSkip: decoder.leadingSkip,
    };
}
