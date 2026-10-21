import { DecodeError } from '../../core/errors/errors';
import type { FrameBits } from './bits';
import type { FrameHeader } from './header';
import {
    allocatePointers,
    integratePsd,
    maskingCurve,
    type AllocationParameters,
    type DeltaAllocation,
} from './bit-allocation';
import {
    ASYMMETRIC_BITS,
    BAP_TABLE,
    DB_PER_BIT,
    FAST_DECAY,
    FAST_GAIN,
    FLOOR,
    REMATRIX_BANDS,
    SLOW_DECAY,
    SLOW_GAIN,
} from './tables';
import {
    DEFAULT_SPX_BAND_STRUCT,
    GAQ_REMAP_1,
    GAQ_REMAP_A,
    GAQ_REMAP_B,
    HEBAP_BITS,
    HEBAP_TABLE,
    SPX_ATTENUATION,
    VQ_VECTORS,
    frameStrategy,
} from './eac3-tables';
import { kbdWindow } from '../shared/kaiser';
import { HalfImdct, overlap } from './transform';

/**
 * The audio blocks of one AC-3 or E-AC-3 substream (A/52 5.4.3 and 7, ETSI TS 102 366 Annex E):
 * exponents, parametric bit allocation, mantissas (with E-AC-3's adaptive hybrid transform),
 * coupling, spectral extension, rematrixing, dynamic range and the synthesis filter bank. Channel
 * indexes follow the standard's order: 0 the coupling channel, 1 to `fbw` the full-bandwidth
 * channels in acmod order, then the LFE channel. E-AC-3 enhanced coupling is refused, and its
 * transient pre-noise processing (side information) is not applied, as in ffmpeg.
 */

/** The coupling channel's index. */
const CPL = 0;
/** Coupling, five full-bandwidth channels and LFE. */
const SLOTS = 7;
const REUSE = 0;
/** The state the dither generator starts from. */
const DITHER_SEED = 0x1234567;

/** Values of the grouped mantissas of bap 1, 2 and 4 (Tables 7.19-7.22), twice the levels. */
function symmetric(levels: number, code: number): number {
    return ((code - (levels >> 1)) * 4) / levels;
}
const BAP1 = Float32Array.from({ length: 32 * 3 }, (_, index) => {
    const group = (index / 3) | 0;
    return symmetric(3, ((group / [9, 3, 1][index % 3]!) | 0) % 3);
});
const BAP2 = Float32Array.from({ length: 128 * 3 }, (_, index) => {
    const group = (index / 3) | 0;
    return symmetric(5, ((group / [25, 5, 1][index % 3]!) | 0) % 5);
});
const BAP4 = Float32Array.from({ length: 128 * 2 }, (_, index) => {
    const group = index >> 1;
    return symmetric(11, index & 1 ? group % 11 : Math.floor(group / 11));
});
const BAP3 = Float32Array.from({ length: 8 }, (_, code) => symmetric(7, code));
const BAP5 = Float32Array.from({ length: 16 }, (_, code) => symmetric(15, code));
/** 2^-e for the exponents 0 to 24. */
const EXPONENT_SCALE = Float32Array.from({ length: 25 }, (_, exponent) => 2 ** -exponent);
/** The three exponent differences (-2 to 2) of each 7-bit exponent group code (7.1.3). */
const EXPONENT_DELTAS = Int8Array.from(
    { length: 375 },
    (_, index) => (((((index / 3) | 0) / [25, 5, 1][index % 3]!) | 0) % 5) - 2,
);
/** Default coupling banding structure (Table E2.16), AC-3's too. */
const DEFAULT_CPL_BAND_STRUCT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1];
/** The scale of a Q23 mantissa (24-bit fixed point) in the doubled levels above. */
const Q23 = 2 ** -22;

/** Gain of a dynamic range code (7.7.1): 2^(signed top three bits) times (32 + low five) / 32. */
function dynamicRangeGain(code: number): number {
    const shift = (code >> 5) - ((code >> 7) << 3);
    return 2 ** (shift - 5) * ((code & 31) | 32);
}

/** Grouped mantissas left over from the last group read (7.3.5). */
interface MantissaGroups {
    b1: number;
    b2: number;
    b4: number;
    b1At: number;
    b2At: number;
    b4At: number;
}

/**
 * The six-point inverse DCT of an AHT bin's Q23 mantissas over the frame's blocks, in the 24-bit
 * fixed point E-AC-3 specifies (E3.3.6), as ffmpeg computes it.
 */
function idct6(values: Int32Array, at: number): void {
    const c0 = 10273905; // sqrt(2) cos(2 pi / 12) in Q23
    const c1 = 11863283; // sqrt(2)
    const c2 = 3070444; // sqrt(2) cos(5 pi / 12)
    const p0 = values[at]!;
    const p1 = values[at + 1]!;
    const p2 = values[at + 2]!;
    const p3 = values[at + 3]!;
    const p4 = values[at + 4]!;
    const p5 = values[at + 5]!;
    const odd1 = p1 - p3 - p5;
    let even2 = Math.floor((p2 * c0) / 8388608);
    const scaled4 = Math.floor((p4 * c1) / 8388608);
    let odd0 = Math.floor(((p1 + p5) * c2) / 8388608);
    let even0 = p0 + (scaled4 >> 1);
    const even1 = p0 - scaled4;
    const sum = even0;
    even0 = sum + even2;
    even2 = sum - even2;
    const base = odd0;
    odd0 = base + p1 + p3;
    const odd2 = base + p5 - p3;
    values[at] = even0 + odd0;
    values[at + 1] = even1 + odd1;
    values[at + 2] = even2 + odd2;
    values[at + 3] = even2 - odd2;
    values[at + 4] = even1 - odd1;
    values[at + 5] = even0 - odd0;
}

export class SubstreamDecoder {
    private header!: FrameHeader;
    private bits!: FrameBits;
    private eac3 = false;
    /** Channels with LFE, the LFE index, and the full-bandwidth channels. */
    private channels = 0;
    private lfeChannel = -1;
    private fbw = 0;

    // The frame's syntax: AC-3 has every field, E-AC-3 states which ones its blocks carry.
    private blockSwitchSyntax = true;
    private ditherSyntax = true;
    private allocationSyntax = true;
    private fastGainSyntax = false;
    private deltaSyntax = true;
    private skipSyntax = true;
    /** 0: one SNR offset in the frame, 1: one per block, 2: one per channel and block. */
    private snrOffsetStrategy = 2;

    private readonly exponents = Array.from({ length: SLOTS }, () => new Int8Array(256));
    private readonly bap = Array.from({ length: SLOTS }, () => new Uint8Array(256));
    private readonly psd = Array.from({ length: SLOTS }, () => new Int16Array(256));
    private readonly bandPsd = Array.from({ length: SLOTS }, () => new Int16Array(50));
    private readonly mask = Array.from({ length: SLOTS }, () => new Int16Array(50));
    private readonly excite = new Int32Array(50);
    readonly coefficients = Array.from({ length: SLOTS }, () => new Float32Array(256));
    private readonly startFreq = new Int32Array(SLOTS);
    private readonly endFreq = new Int32Array(SLOTS);
    private readonly expGroups = new Int32Array(SLOTS);
    private readonly expStrategy = Array.from({ length: 6 }, () => new Uint8Array(SLOTS));
    private readonly blockSwitch = new Uint8Array(SLOTS);
    private readonly ditherFlag = new Uint8Array(SLOTS);
    private readonly snrOffset = new Int32Array(SLOTS);
    private readonly fastGain = new Int32Array(SLOTS);
    private readonly delta: DeltaAllocation[] = Array.from({ length: SLOTS }, () => ({
        mode: 2,
        segments: 0,
        offsets: new Uint8Array(8),
        lengths: new Uint8Array(8),
        values: new Uint8Array(8),
    }));
    private readonly params: AllocationParameters = {
        slowDecay: 0,
        fastDecay: 0,
        slowGain: 0,
        dbPerBit: 0,
        floor: 0,
        cplFastLeak: 0,
        cplSlowLeak: 0,
        rateCode: 0,
        rateShift: 0,
    };
    private readonly dynamicRange = new Float32Array([1, 1]);
    /**
     * Per channel, how much bit allocation a block redoes: 3 all, 2 from the mask, 1 the pointers.
     */
    private readonly stages = new Uint8Array(SLOTS);

    // Coupling.
    private readonly cplStrategyExists = new Uint8Array(6);
    private readonly cplInUse = new Uint8Array(6);
    private readonly channelInCpl = new Uint8Array(SLOTS);
    private readonly firstCplCoords = new Uint8Array(SLOTS);
    private firstCplLeak = false;
    private phaseFlagsInUse = false;
    private readonly phaseFlags = new Uint8Array(18);
    private cplBands = 0;
    private readonly cplBandSizes = new Uint8Array(18);
    private readonly cplBandStruct = new Uint8Array(18);
    private readonly cplCoords = Array.from({ length: SLOTS }, () => new Float32Array(18));

    // Spectral extension (E-AC-3).
    private spxInUse = false;
    private readonly channelUsesSpx = new Uint8Array(SLOTS);
    private readonly spxAttenuation = new Int8Array(SLOTS);
    private readonly firstSpxCoords = new Uint8Array(SLOTS);
    private spxDstStart = 0;
    private spxSrcStart = 0;
    private spxDstEnd = 0;
    private spxBands = 0;
    private readonly spxBandSizes = new Uint8Array(17);
    private readonly spxBandStruct = new Uint8Array(17);
    private readonly spxNoiseBlend = Array.from({ length: SLOTS }, () => new Float32Array(17));
    private readonly spxSignalBlend = Array.from({ length: SLOTS }, () => new Float32Array(17));

    // Adaptive hybrid transform (E-AC-3): each AHT channel's Q23 mantissas of the six blocks.
    private readonly usesAht = new Uint8Array(SLOTS);
    private readonly preMantissas: Int32Array[] = [];

    // Rematrixing.
    private rematrixBands = 0;
    private readonly rematrixFlags = new Uint8Array(4);

    // Synthesis.
    /** The rising half of the 512-point KBD window, alpha 5 (A/52 Table 7.33). */
    private readonly window = Float32Array.from(kbdWindow(256, 5));
    private readonly long = new HalfImdct(256);
    private readonly short = new HalfImdct(128);
    private readonly transformed = new Float32Array(256);
    private readonly second = new Float32Array(128);
    /** Overlap of each channel (1 to channels), the second half of its last transform. */
    private readonly delay = Array.from({ length: SLOTS }, () => new Float32Array(128));
    private dither = DITHER_SEED;

    /** Starts a frame of `header`; its audio frame data (E-AC-3) and blocks follow at `bits`. */
    begin(header: FrameHeader, bits: FrameBits): void {
        if (this.header && (this.header.acmod !== header.acmod || this.header.lfe !== header.lfe))
            for (const delay of this.delay) delay.fill(0);
        this.header = header;
        this.bits = bits;
        this.eac3 = header.eac3;
        this.fbw = header.fbw;
        this.channels = header.fbw + (header.lfe ? 1 : 0);
        this.lfeChannel = header.lfe ? header.fbw + 1 : -1;
        this.params.rateCode = header.rateCode;
        this.params.rateShift = header.rateShift;
        if (header.lfe) {
            this.startFreq[this.lfeChannel] = 0;
            this.endFreq[this.lfeChannel] = 7;
            this.expGroups[this.lfeChannel] = 2;
            this.channelInCpl[this.lfeChannel] = 0;
            this.blockSwitch[this.lfeChannel] = 0;
        }
        if (this.eac3) this.readAudioFrame();
        else {
            this.blockSwitchSyntax = this.ditherSyntax = this.allocationSyntax = true;
            this.deltaSyntax = this.skipSyntax = true;
            this.fastGainSyntax = false;
            this.snrOffsetStrategy = 2;
            this.firstCplLeak = false;
            this.usesAht.fill(0);
            this.spxInUse = false;
            this.channelUsesSpx.fill(0);
        }
        this.ditherFlag[CPL] = 0;
        if (header.lfe) this.ditherFlag[this.lfeChannel] = 0;
    }

    /**
     * Forgets the overlap of the previous frame and restarts the dither (after a seek or a damaged
     * frame), so that what follows decodes as a new decoder decodes it.
     */
    reset(): void {
        for (const delay of this.delay) delay.fill(0);
        this.dither = DITHER_SEED;
    }

    /** E-AC-3 audfrm (E.1.2.3): the syntax, strategies and per-frame data of the blocks. */
    private readAudioFrame(): void {
        const bits = this.bits;
        const { blocks, acmod, frameType, frameBytes } = this.header;
        const { fbw, channels } = this;
        const ac3Strategies = blocks === 6 ? bits.flag() : true;
        const aht = blocks === 6 && bits.flag();
        this.snrOffsetStrategy = bits.read(2);
        const transients = bits.flag();
        this.blockSwitchSyntax = bits.flag();
        if (!this.blockSwitchSyntax) this.blockSwitch.fill(0);
        this.ditherSyntax = bits.flag();
        if (!this.ditherSyntax) this.ditherFlag.fill(1, 1, fbw + 1);
        this.allocationSyntax = bits.flag();
        if (!this.allocationSyntax) {
            this.params.slowDecay = SLOW_DECAY[2]!;
            this.params.fastDecay = FAST_DECAY[1]!;
            this.params.slowGain = SLOW_GAIN[1]!;
            this.params.dbPerBit = DB_PER_BIT[2]!;
            this.params.floor = FLOOR[7]!;
        }
        this.fastGainSyntax = bits.flag();
        this.deltaSyntax = bits.flag();
        this.skipSyntax = bits.flag();
        const spxAttenuation = bits.flag();

        // Coupling in use per block.
        let cplBlocks = 0;
        for (let block = 0; block < blocks; block++) {
            if (acmod > 1) {
                const exists = block === 0 || bits.flag();
                this.cplStrategyExists[block] = exists ? 1 : 0;
                this.cplInUse[block] = exists ? bits.read(1) : this.cplInUse[block - 1]!;
            } else this.cplStrategyExists[block] = this.cplInUse[block] = 0;
            cplBlocks += this.cplInUse[block]!;
        }

        // Exponent strategies: per block as in AC-3, or one of the frame combinations.
        if (ac3Strategies) {
            for (let block = 0; block < blocks; block++)
                for (let ch = this.cplInUse[block] ? CPL : 1; ch <= fbw; ch++)
                    this.expStrategy[block]![ch] = bits.read(2);
        } else
            for (let ch = acmod > 1 && cplBlocks ? CPL : 1; ch <= fbw; ch++) {
                const code = bits.read(5);
                for (let block = 0; block < 6; block++)
                    this.expStrategy[block]![ch] = frameStrategy(code, block);
            }
        if (this.header.lfe)
            for (let block = 0; block < blocks; block++)
                this.expStrategy[block]![this.lfeChannel] = bits.read(1);
        // The converter's exponent strategies of a stream that came from AC-3.
        if (frameType === 0 && (blocks === 6 || bits.flag())) bits.skip(5 * fbw);

        // AHT needs exponents reused through the frame (and coupling in every block, unchanged).
        this.usesAht.fill(0);
        if (aht)
            for (let ch = cplBlocks === 6 ? CPL : 1; ch <= channels; ch++) {
                let possible = true;
                for (let block = 1; block < 6; block++)
                    if (
                        this.expStrategy[block]![ch] !== REUSE ||
                        (ch === CPL && this.cplStrategyExists[block])
                    )
                        possible = false;
                this.usesAht[ch] = possible && bits.flag() ? 1 : 0;
            }

        if (this.snrOffsetStrategy === 0) {
            const snr = (((bits.read(6) - 15) << 4) + bits.read(4)) << 2;
            this.snrOffset.fill(snr);
        }
        // Transient pre-noise processing: side information this decoder does not apply.
        if (transients) for (let ch = 1; ch <= fbw; ch++) if (bits.flag()) bits.skip(18);
        for (let ch = 1; ch <= fbw; ch++)
            this.spxAttenuation[ch] = spxAttenuation && bits.flag() ? bits.read(5) : -1;
        // Block start information.
        if (blocks > 1 && bits.flag())
            bits.skip((blocks - 1) * (4 + Math.ceil(Math.log2(frameBytes / 2))));
        this.firstSpxCoords.fill(1);
        this.firstCplCoords.fill(1);
        this.firstCplLeak = true;
    }

    /**
     * Decodes block `block` into `planes[channel - 1]` at `at`, channels in the standard's order
     * (the LFE last).
     */
    decodeBlock(block: number, planes: readonly Float32Array[], at: number): void {
        const bits = this.bits;
        const { fbw, channels, eac3 } = this;
        const acmod = this.header.acmod;
        const stages = this.stages.fill(0);

        if (this.blockSwitchSyntax)
            for (let ch = 1; ch <= fbw; ch++) this.blockSwitch[ch] = bits.read(1);
        if (this.ditherSyntax) for (let ch = 1; ch <= fbw; ch++) this.ditherFlag[ch] = bits.read(1);

        // Dynamic range (7.7.1): the second word is the second program of a 1+1 stream.
        for (let program = 0; program < (acmod ? 1 : 2); program++) {
            if (bits.flag()) this.dynamicRange[program] = dynamicRangeGain(bits.read(8));
            else if (block === 0) this.dynamicRange[program] = 1;
        }

        // Spectral extension strategy and coordinates (E-AC-3).
        if (eac3 && (block === 0 || bits.flag())) {
            this.spxInUse = bits.flag();
            if (this.spxInUse) this.spxStrategy(block);
            else {
                this.channelUsesSpx.fill(0);
                this.firstSpxCoords.fill(1);
            }
        }
        if (this.spxInUse) this.spxCoordinates();

        // Coupling strategy.
        if (eac3 ? this.cplStrategyExists[block] : bits.flag()) {
            stages.fill(3);
            this.couplingStrategy(block);
        } else if (!eac3) {
            if (block === 0) throw new DecodeError('AC-3 block 0 has no coupling strategy');
            this.cplInUse[block] = this.cplInUse[block - 1]!;
        }
        const cplInUse = this.cplInUse[block] === 1;
        if (cplInUse) this.couplingCoordinates(block);

        // Rematrixing strategy of a 2/0 stream.
        if (acmod === 2) {
            if ((eac3 && block === 0) || bits.flag()) {
                let bands = 4;
                if (cplInUse && this.startFreq[CPL]! <= 61)
                    bands -= 1 + (this.startFreq[CPL] === 37 ? 1 : 0);
                else if (this.spxInUse && this.spxSrcStart <= 61) bands--;
                this.rematrixBands = bands;
                for (let band = 0; band < bands; band++) this.rematrixFlags[band] = bits.read(1);
            } else if (block === 0) this.rematrixBands = 0;
        }

        // Exponent strategies (AC-3) and bandwidths.
        const first = cplInUse ? CPL : 1;
        const strategy = this.expStrategy[block]!;
        for (let ch = first; ch <= channels; ch++) {
            if (!eac3) strategy[ch] = bits.read(ch === this.lfeChannel ? 1 : 2);
            if (strategy[ch] !== REUSE) stages[ch] = 3;
        }
        for (let ch = 1; ch <= fbw; ch++) {
            this.startFreq[ch] = 0;
            if (strategy[ch] === REUSE) continue;
            const previous = this.endFreq[ch];
            if (this.channelInCpl[ch]) this.endFreq[ch] = this.startFreq[CPL]!;
            else if (this.channelUsesSpx[ch]) this.endFreq[ch] = this.spxSrcStart;
            else {
                const bandwidth = bits.read(6);
                if (bandwidth > 60) throw new DecodeError(`AC-3 bandwidth code ${bandwidth} > 60`);
                this.endFreq[ch] = bandwidth * 3 + 73;
            }
            const groupSize = 3 << (strategy[ch]! - 1);
            this.expGroups[ch] = Math.floor((this.endFreq[ch]! + groupSize - 4) / groupSize);
            if (block > 0 && this.endFreq[ch] !== previous) stages.fill(3);
        }
        if (cplInUse && strategy[CPL] !== REUSE)
            this.expGroups[CPL] = Math.floor(
                (this.endFreq[CPL]! - this.startFreq[CPL]!) / (3 << (strategy[CPL]! - 1)),
            );

        // Exponents (7.1.3).
        for (let ch = first; ch <= channels; ch++) {
            if (strategy[ch] === REUSE) continue;
            const absolute = bits.read(4) << (ch === CPL ? 1 : 0);
            this.exponents[ch]![0] = absolute;
            this.decodeExponents(
                strategy[ch]!,
                this.expGroups[ch]!,
                absolute,
                this.exponents[ch]!,
                this.startFreq[ch]! + (ch === CPL ? 0 : 1),
            );
            if (ch !== CPL && ch !== this.lfeChannel) bits.skip(2);
        }

        this.allocationParameters(block, first, stages);

        // Bit allocation (7.2).
        for (let ch = first; ch <= channels; ch++) {
            const start = this.startFreq[ch]!;
            const end = this.endFreq[ch]!;
            if (stages[ch]! > 2)
                integratePsd(this.exponents[ch]!, start, end, this.psd[ch]!, this.bandPsd[ch]!);
            if (
                stages[ch]! > 1 &&
                !maskingCurve(
                    this.params,
                    this.bandPsd[ch]!,
                    start,
                    end,
                    this.fastGain[ch]!,
                    ch === this.lfeChannel,
                    this.delta[ch]!,
                    this.mask[ch]!,
                    this.excite,
                )
            )
                throw new DecodeError('AC-3 delta bit allocation runs past the bands');
            if (stages[ch]! > 0)
                allocatePointers(
                    this.mask[ch]!,
                    this.psd[ch]!,
                    start,
                    end,
                    this.snrOffset[ch]!,
                    this.params.floor,
                    this.usesAht[ch] ? HEBAP_TABLE : BAP_TABLE,
                    this.bap[ch]!,
                );
        }

        if (this.skipSyntax && bits.flag()) bits.skip(bits.read(9) * 8);

        this.decodeCoefficients(block);
        if (acmod === 2) this.rematrix();

        // Dynamic range, then the spectral extension from the scaled coefficients.
        for (let ch = 1; ch <= channels; ch++) {
            const gain = this.dynamicRange[acmod === 0 && ch === 2 ? 1 : 0]!;
            if (gain === 1) continue;
            const coefficients = this.coefficients[ch]!;
            for (let bin = 0; bin < 256; bin++) coefficients[bin] = coefficients[bin]! * gain;
        }
        if (this.spxInUse) this.applySpectralExtension();
        if (bits.overrun) throw new DecodeError('AC-3 audio block runs past its frame');

        for (let ch = 1; ch <= channels; ch++) this.synthesize(ch, planes[ch - 1]!, at);
    }

    /** Bit allocation parameters, SNR offsets, fast gains, coupling leak and delta allocation. */
    private allocationParameters(block: number, first: number, stages: Uint8Array): void {
        const bits = this.bits;
        const { fbw, channels, eac3 } = this;
        const raise = (ch: number, stage: number): void => {
            stages[ch] = Math.max(stages[ch]!, stage);
        };
        if (this.allocationSyntax) {
            if (bits.flag()) {
                const shift = this.params.rateShift;
                this.params.slowDecay = SLOW_DECAY[bits.read(2)]! >> shift;
                this.params.fastDecay = FAST_DECAY[bits.read(2)]! >> shift;
                this.params.slowGain = SLOW_GAIN[bits.read(2)]!;
                this.params.dbPerBit = DB_PER_BIT[bits.read(2)]!;
                this.params.floor = FLOOR[bits.read(3)]!;
                for (let ch = first; ch <= channels; ch++) raise(ch, 2);
            } else if (block === 0)
                throw new DecodeError('AC-3 block 0 has no bit allocation parameters');
        }

        // SNR offsets: AC-3 states them with the fast gains; E-AC-3 block 0 always has them.
        if (this.snrOffsetStrategy && ((eac3 && block === 0) || bits.flag())) {
            const coarse = (bits.read(6) - 15) << 4;
            let snr = 0;
            for (let ch = first; ch <= channels; ch++) {
                if (ch === first || this.snrOffsetStrategy === 2)
                    snr = (coarse + bits.read(4)) << 2;
                if (block && this.snrOffset[ch] !== snr) raise(ch, 1);
                this.snrOffset[ch] = snr;
                if (!eac3) {
                    const previous = this.fastGain[ch];
                    this.fastGain[ch] = FAST_GAIN[bits.read(3)]!;
                    if (block && previous !== this.fastGain[ch]) raise(ch, 2);
                }
            }
        } else if (!eac3 && block === 0) throw new DecodeError('AC-3 block 0 has no SNR offsets');

        // E-AC-3 fast gains: stated, else the default code 4.
        if (eac3) {
            const stated = this.fastGainSyntax && bits.flag();
            for (let ch = first; ch <= channels; ch++) {
                const previous = this.fastGain[ch];
                this.fastGain[ch] = FAST_GAIN[stated ? bits.read(3) : 4]!;
                if (block && previous !== this.fastGain[ch]) raise(ch, 2);
            }
            // The converter's SNR offset of an independent stream.
            if (this.header.frameType === 0 && bits.flag()) bits.skip(10);
        }

        // Coupling leak.
        if (this.cplInUse[block]) {
            if (this.firstCplLeak || bits.flag()) {
                const fast = bits.read(3);
                const slow = bits.read(3);
                if (block && (fast !== this.params.cplFastLeak || slow !== this.params.cplSlowLeak))
                    raise(CPL, 2);
                this.params.cplFastLeak = fast;
                this.params.cplSlowLeak = slow;
            } else if (!eac3 && block === 0)
                throw new DecodeError('AC-3 block 0 has no coupling leak');
            this.firstCplLeak = false;
        }

        // Delta bit allocation.
        if (this.deltaSyntax && bits.flag()) {
            for (let ch = first; ch <= fbw; ch++) {
                const mode = bits.read(2);
                if (mode === 3) throw new DecodeError('AC-3 delta bit allocation is reserved');
                this.delta[ch]!.mode = mode;
                raise(ch, 2);
            }
            for (let ch = first; ch <= fbw; ch++) {
                const delta = this.delta[ch]!;
                if (delta.mode !== 1) continue;
                delta.segments = bits.read(3) + 1;
                for (let segment = 0; segment < delta.segments; segment++) {
                    delta.offsets[segment] = bits.read(5);
                    delta.lengths[segment] = bits.read(4);
                    delta.values[segment] = bits.read(3);
                }
            }
        } else if (block === 0) for (const delta of this.delta) delta.mode = 2;
    }

    private couplingStrategy(block: number): void {
        const bits = this.bits;
        const { fbw, eac3 } = this;
        if (!eac3) this.cplInUse[block] = bits.read(1);
        if (!this.cplInUse[block]) {
            for (let ch = 1; ch <= fbw; ch++) {
                this.channelInCpl[ch] = 0;
                this.firstCplCoords[ch] = 1;
            }
            this.firstCplLeak = eac3;
            this.phaseFlagsInUse = false;
            return;
        }
        if (this.header.acmod < 2) throw new DecodeError('AC-3 coupling needs two channels');
        if (eac3 && bits.flag()) throw new DecodeError('E-AC-3 enhanced coupling is not supported');
        if (eac3 && this.header.acmod === 2) this.channelInCpl.fill(1, 1, 3);
        else for (let ch = 1; ch <= fbw; ch++) this.channelInCpl[ch] = bits.read(1);
        if (this.header.acmod === 2) this.phaseFlagsInUse = bits.flag();
        const startBand = bits.read(4);
        const endBand = this.spxInUse ? (this.spxSrcStart - 37) / 12 : bits.read(4) + 3;
        if (startBand >= endBand) throw new DecodeError('AC-3 coupling range is empty');
        this.startFreq[CPL] = startBand * 12 + 37;
        this.endFreq[CPL] = endBand * 12 + 37;
        this.cplBands = this.bandStructure(
            block,
            startBand,
            endBand,
            this.cplBandStruct,
            this.cplBandSizes,
            DEFAULT_CPL_BAND_STRUCT,
        );
    }

    /**
     * Reads a banding structure over subbands `start` to `end` (12 bins each) into `structure`
     * and the band sizes into `sizes`; returns the number of bands. E-AC-3 may keep the last one.
     */
    private bandStructure(
        block: number,
        start: number,
        end: number,
        structure: Uint8Array,
        sizes: Uint8Array,
        defaults: readonly number[],
    ): number {
        const bits = this.bits;
        if (block === 0) structure.set(defaults.slice(0, structure.length));
        if (!this.eac3 || bits.flag())
            for (let subband = start + 1; subband < end; subband++)
                structure[subband] = bits.read(1);
        let bands = 0;
        sizes[0] = 12;
        for (let subband = start + 1; subband < end; subband++) {
            if (structure[subband]) sizes[bands] = sizes[bands]! + 12;
            else sizes[++bands] = 12;
        }
        return bands + 1;
    }

    private couplingCoordinates(block: number): void {
        const bits = this.bits;
        let exist = false;
        for (let ch = 1; ch <= this.fbw; ch++) {
            if (!this.channelInCpl[ch]) {
                this.firstCplCoords[ch] = 1;
                continue;
            }
            if ((this.eac3 && this.firstCplCoords[ch]) || bits.flag()) {
                this.firstCplCoords[ch] = 0;
                exist = true;
                const master = bits.read(2) * 3;
                const coords = this.cplCoords[ch]!;
                // The coordinate times the 8 of the uncoupling (7.4.3), as a power of two.
                for (let band = 0; band < this.cplBands; band++) {
                    const exponent = bits.read(4);
                    const mantissa = bits.read(4);
                    const value = exponent === 15 ? mantissa / 2 : (mantissa + 16) / 4;
                    coords[band] = value * 2 ** -(exponent + master);
                }
            } else if (block === 0)
                throw new DecodeError('AC-3 block 0 has no coupling coordinates');
        }
        if (this.header.acmod === 2 && exist)
            for (let band = 0; band < this.cplBands; band++)
                this.phaseFlags[band] = this.phaseFlagsInUse ? bits.read(1) : 0;
    }

    /** Spectral extension strategy (E.1.3.3): the channels, copy region and bands. */
    private spxStrategy(block: number): void {
        const bits = this.bits;
        for (let ch = 1; ch <= this.fbw; ch++)
            this.channelUsesSpx[ch] = this.header.acmod === 1 ? 1 : bits.read(1);
        const copyStart = bits.read(2);
        let start = bits.read(3) + 2;
        if (start > 7) start += start - 7;
        let end = bits.read(3) + 5;
        if (end > 7) end += end - 7;
        if (start >= end) throw new DecodeError('E-AC-3 spectral extension range is empty');
        this.spxDstStart = copyStart * 12 + 25;
        this.spxSrcStart = start * 12 + 25;
        this.spxDstEnd = end * 12 + 25;
        if (this.spxDstStart >= this.spxSrcStart)
            throw new DecodeError('E-AC-3 spectral extension copies from above its start');
        this.spxBands = this.bandStructure(
            block,
            start,
            end,
            this.spxBandStruct,
            this.spxBandSizes,
            DEFAULT_SPX_BAND_STRUCT,
        );
    }

    /** Spectral extension coordinates and blending of signal and noise per band (E.1.3.3.11). */
    private spxCoordinates(): void {
        const bits = this.bits;
        for (let ch = 1; ch <= this.fbw; ch++) {
            if (!this.channelUsesSpx[ch]) {
                this.firstSpxCoords[ch] = 1;
                continue;
            }
            if (!this.firstSpxCoords[ch] && !bits.flag()) continue;
            this.firstSpxCoords[ch] = 0;
            const blend = bits.read(5) / 32;
            const master = bits.read(2) * 3;
            let bin = this.spxSrcStart;
            for (let band = 0; band < this.spxBands; band++) {
                const size = this.spxBandSizes[band]!;
                const ratio = Math.min(
                    1,
                    Math.max(0, (bin + (size >> 1)) / this.spxDstEnd - blend),
                );
                bin += size;
                const exponent = bits.read(4);
                const mantissa = bits.read(2);
                const scaled = exponent === 15 ? mantissa * 2 : mantissa + 4;
                const coordinate = scaled * 2 ** (2 - exponent - master);
                // Noise is scaled by sqrt(3) to give it unit variance.
                this.spxNoiseBlend[ch]![band] = Math.sqrt(3 * ratio) * coordinate;
                this.spxSignalBlend[ch]![band] = Math.sqrt(1 - ratio) * coordinate;
            }
        }
    }

    /**
     * Spectral extension (E3.4): the coefficients above the source start are translated copies of
     * those from the copy start, notched at the wraps, scaled and blended with noise of each
     * band's energy.
     */
    private applySpectralExtension(): void {
        const sizes = this.spxBandSizes;
        const bands = this.spxBands;
        const wraps = new Uint8Array(bands);
        const copies: number[] = [];
        let bin = this.spxDstStart;
        wraps[0] = 1;
        for (let band = 0; band < bands; band++) {
            const size = sizes[band]!;
            if (bin + size > this.spxSrcStart) {
                copies.push(bin - this.spxDstStart);
                bin = this.spxDstStart;
                wraps[band] = 1;
            }
            for (let index = 0, step = 0; index < size; index += step) {
                if (bin === this.spxSrcStart) {
                    copies.push(bin - this.spxDstStart);
                    bin = this.spxDstStart;
                }
                step = Math.min(size - index, this.spxSrcStart - bin);
                bin += step;
            }
        }
        copies.push(bin - this.spxDstStart);

        const energy = new Float32Array(bands);
        for (let ch = 1; ch <= this.fbw; ch++) {
            if (!this.channelUsesSpx[ch]) continue;
            const coefficients = this.coefficients[ch]!;
            bin = this.spxSrcStart;
            for (const count of copies) {
                coefficients.copyWithin(bin, this.spxDstStart, this.spxDstStart + count);
                bin += count;
            }
            bin = this.spxSrcStart;
            for (let band = 0; band < bands; band++) {
                let sum = 0;
                for (let index = 0; index < sizes[band]!; index++, bin++)
                    sum += coefficients[bin]! * coefficients[bin]!;
                energy[band] = Math.sqrt(sum / sizes[band]!);
            }
            const code = this.spxAttenuation[ch]!;
            if (code >= 0) {
                const notch = SPX_ATTENUATION[code]!;
                bin = this.spxSrcStart - 2;
                for (let band = 0; band < bands; band++) {
                    if (wraps[band])
                        for (let index = 0; index < 5; index++)
                            coefficients[bin + index] =
                                coefficients[bin + index]! * notch[index < 3 ? index : 4 - index]!;
                    bin += sizes[band]!;
                }
            }
            bin = this.spxSrcStart;
            for (let band = 0; band < bands; band++) {
                const noise = this.spxNoiseBlend[ch]![band]! * energy[band]!;
                const signal = this.spxSignalBlend[ch]![band]!;
                for (let index = 0; index < sizes[band]!; index++, bin++)
                    coefficients[bin] = coefficients[bin]! * signal + noise * this.nextNoise();
            }
        }
    }

    private decodeExponents(
        strategy: number,
        groups: number,
        absolute: number,
        out: Int8Array,
        from: number,
    ): void {
        const bits = this.bits;
        const repeat = strategy === 3 ? 4 : strategy;
        let previous = absolute;
        let at = from;
        for (let group = 0; group < groups; group++) {
            const code = bits.read(7);
            if (code >= 125) throw new DecodeError(`AC-3 exponent group ${code} is out of range`);
            for (let digit = code * 3; digit < code * 3 + 3; digit++) {
                previous += EXPONENT_DELTAS[digit]!;
                if (previous < 0 || previous > 24)
                    throw new DecodeError(`AC-3 exponent ${previous} is out of range`);
                out.fill(previous, at, at + repeat);
                at += repeat;
            }
        }
    }

    /** Mantissas of every channel, the coupling channel after the first coupled one (7.3). */
    private decodeCoefficients(block: number): void {
        const groups: MantissaGroups = { b1: 0, b2: 0, b4: 0, b1At: 0, b2At: 0, b4At: 0 };
        let coupled = false;
        for (let ch = 1; ch <= this.channels; ch++) {
            this.channelMantissas(block, ch, groups);
            let end: number;
            if (this.channelInCpl[ch]) {
                if (!coupled) {
                    this.channelMantissas(block, CPL, groups);
                    this.uncouple();
                    coupled = true;
                }
                end = this.endFreq[CPL]!;
            } else end = this.endFreq[ch]!;
            this.coefficients[ch]!.fill(0, end);
        }

        // Coupled channels without dither keep silence where the coupling channel had none.
        for (let ch = 1; ch <= this.fbw; ch++) {
            if (this.ditherFlag[ch] || !this.channelInCpl[ch]) continue;
            const coefficients = this.coefficients[ch]!;
            const bap = this.bap[CPL]!;
            for (let bin = this.startFreq[CPL]!; bin < this.endFreq[CPL]!; bin++)
                if (!bap[bin]) coefficients[bin] = 0;
        }
    }

    /** One channel's mantissas, dequantized and scaled by their exponents. */
    private channelMantissas(block: number, ch: number, groups: MantissaGroups): void {
        if (this.usesAht[ch]) {
            this.ahtCoefficients(block, ch);
            return;
        }
        const bits = this.bits;
        const bap = this.bap[ch]!;
        const exponents = this.exponents[ch]!;
        const out = this.coefficients[ch]!;
        const dither = ch === CPL || this.ditherFlag[ch] === 1;
        for (let bin = this.startFreq[ch]!, end = this.endFreq[ch]!; bin < end; bin++) {
            const pointer = bap[bin]!;
            let value: number;
            switch (pointer) {
                case 0:
                    value = dither ? this.nextDither() : 0;
                    break;
                case 1:
                    if (groups.b1) value = BAP1[groups.b1At + 3 - groups.b1--]!;
                    else {
                        groups.b1At = bits.read(5) * 3;
                        groups.b1 = 2;
                        value = BAP1[groups.b1At]!;
                    }
                    break;
                case 2:
                    if (groups.b2) value = BAP2[groups.b2At + 3 - groups.b2--]!;
                    else {
                        groups.b2At = bits.read(7) * 3;
                        groups.b2 = 2;
                        value = BAP2[groups.b2At]!;
                    }
                    break;
                case 3:
                    value = BAP3[bits.read(3)]!;
                    break;
                case 4:
                    if (groups.b4) {
                        groups.b4 = 0;
                        value = BAP4[groups.b4At + 1]!;
                    } else {
                        groups.b4At = bits.read(7) * 2;
                        groups.b4 = 1;
                        value = BAP4[groups.b4At]!;
                    }
                    break;
                case 5:
                    value = BAP5[bits.read(4)]!;
                    break;
                default: {
                    const width = ASYMMETRIC_BITS[pointer]!;
                    value = bits.signed(width) * 2 ** (2 - width);
                }
            }
            out[bin] = value * EXPONENT_SCALE[exponents[bin]!]!;
        }
    }

    /**
     * An AHT channel's coefficients (E3.3): block 0 carries the six blocks' mantissas of each bin,
     * vector-quantized or gain-adaptive, which a six-point DCT turns into one per block.
     */
    private ahtCoefficients(block: number, ch: number): void {
        const start = this.startFreq[ch]!;
        const end = this.endFreq[ch]!;
        const values = (this.preMantissas[ch] ??= new Int32Array(256 * 6));
        if (block === 0) this.readAhtMantissas(ch, start, end, values);
        const exponents = this.exponents[ch]!;
        const out = this.coefficients[ch]!;
        for (let bin = start; bin < end; bin++)
            out[bin] = (values[bin * 6 + block]! >> exponents[bin]!) * Q23;
    }

    private readAhtMantissas(ch: number, start: number, end: number, values: Int32Array): void {
        const bits = this.bits;
        const bap = this.bap[ch]!;
        const gaqMode = bits.read(2);
        const lastGained = gaqMode < 2 ? 12 : 17;
        // Gains of the GAQ bins: one bit each (modes 1 and 2), or three per five-bit group.
        const gains: number[] = [];
        if (gaqMode === 1 || gaqMode === 2) {
            for (let bin = start; bin < end; bin++)
                if (bap[bin]! > 7 && bap[bin]! < lastGained)
                    gains.push(bits.read(1) << (gaqMode - 1));
        } else if (gaqMode === 3)
            for (let bin = start, left = 0; bin < end; bin++) {
                if (bap[bin]! <= 7 || bap[bin]! >= 17) continue;
                if (left === 0) {
                    const group = Math.min(bits.read(5), 26);
                    gains.push((group / 9) | 0, ((group / 3) | 0) % 3, group % 3);
                    left = 3;
                }
                left--;
            }
        let gainAt = 0;
        for (let bin = start; bin < end; bin++) {
            const hebap = bap[bin]!;
            const width = HEBAP_BITS[hebap]!;
            const at = bin * 6;
            if (hebap === 0)
                for (let block = 0; block < 6; block++)
                    values[at + block] = (this.nextRandom() & 0x7fffff) - 0x400000;
            else if (hebap < 8) {
                const vector = VQ_VECTORS[hebap]!;
                const index = bits.read(width) * 6;
                for (let block = 0; block < 6; block++)
                    values[at + block] = vector[index + block]! * 256;
            } else {
                const gain = gaqMode && hebap < lastGained ? gains[gainAt++]! : 0;
                const small = width - gain;
                for (let block = 0; block < 6; block++) {
                    let mantissa = bits.signed(small);
                    if (gain && mantissa === -(1 << (small - 1))) {
                        // A large mantissa follows, remapped for its asymmetric quantization.
                        const wide = width - (2 - gain);
                        mantissa = bits.signed(wide) * 2 ** (24 - wide);
                        const offset =
                            mantissa >= 0
                                ? 2 ** (23 - gain)
                                : GAQ_REMAP_B[hebap - 8]![gain - 1]! * 256;
                        mantissa +=
                            Math.floor((GAQ_REMAP_A[hebap - 8]![gain - 1]! * mantissa) / 32768) +
                            offset;
                    } else {
                        mantissa *= 2 ** (24 - width);
                        if (!gain)
                            mantissa += Math.floor((GAQ_REMAP_1[hebap - 8]! * mantissa) / 32768);
                    }
                    values[at + block] = mantissa;
                }
            }
            idct6(values, at);
        }
    }

    /** The next 32 random bits of the decoder's xorshift generator. */
    private nextRandom(): number {
        let x = this.dither;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.dither = x >>> 0;
        return this.dither;
    }

    /** Uniform dither of about +-0.707 levels (7.3.4), at the doubled scale of the mantissas. */
    private nextDither(): number {
        return ((this.nextRandom() >>> 8) / 0x1000000 - 0.5) * 2.828427;
    }

    /** Uniform noise in [-1, 1). */
    private nextNoise(): number {
        return this.nextRandom() / 0x80000000 - 1;
    }

    /** Coupled channels from the coupling channel and their coordinates (7.4.3). */
    private uncouple(): void {
        const source = this.coefficients[CPL]!;
        for (let ch = 1; ch <= this.fbw; ch++) {
            if (!this.channelInCpl[ch]) continue;
            const out = this.coefficients[ch]!;
            const coords = this.cplCoords[ch]!;
            let bin = this.startFreq[CPL]!;
            for (let band = 0; band < this.cplBands; band++) {
                const end = bin + this.cplBandSizes[band]!;
                const coord = ch === 2 && this.phaseFlags[band] ? -coords[band]! : coords[band]!;
                for (; bin < end; bin++) out[bin] = source[bin]! * coord;
            }
        }
    }

    /** Stereo rematrixing (7.5.4): sum and difference bands back to left and right. */
    private rematrix(): void {
        const left = this.coefficients[1]!;
        const right = this.coefficients[2]!;
        const end = Math.min(this.endFreq[1]!, this.endFreq[2]!);
        for (let band = 0; band < this.rematrixBands; band++) {
            if (!this.rematrixFlags[band]) continue;
            const stop = Math.min(end, REMATRIX_BANDS[band + 1]!);
            for (let bin = REMATRIX_BANDS[band]!; bin < stop; bin++) {
                const sum = left[bin]!;
                const difference = right[bin]!;
                left[bin] = sum + difference;
                right[bin] = sum - difference;
            }
        }
    }

    /** The inverse transform and overlap of one channel's block (7.9). */
    private synthesize(ch: number, out: Float32Array, at: number): void {
        const coefficients = this.coefficients[ch]!;
        const delay = this.delay[ch]!;
        const transformed = this.transformed;
        if (this.blockSwitch[ch]) {
            this.short.run(coefficients, 0, 2, transformed, 0);
            overlap(delay, transformed, this.window, out, at);
            this.short.run(coefficients, 1, 2, this.second, 0);
            delay.set(this.second);
        } else {
            this.long.run(coefficients, 0, 1, transformed, 0);
            overlap(delay, transformed, this.window, out, at);
            delay.set(transformed.subarray(128));
        }
    }
}
