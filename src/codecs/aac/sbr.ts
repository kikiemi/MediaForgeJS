import { MediaForgeError } from '../../core/errors/errors';
import { AacBitReader, decodeHuffman, huffmanCode } from '../../core/codec-config/audio/aac-bits';
import { AacParametricStereo } from './ps';
import { Dct4 } from './transform';
import { SBR_HUFFMAN_TABLES, SBR_NOISE_TABLE, SBR_OFFSET, SBR_QMF_WINDOW } from './sbr-tables';

/**
 * Spectral band replication (ISO/IEC 14496-3 section 4.6.18): QMF analysis of the core output,
 * high-band reconstruction from the envelope and noise data of the SBR extension, and QMF synthesis
 * at twice the core rate (or at the core rate for downsampled SBR). Numerical choices where the
 * standard leaves room (inverse-filter guard terms, gain limits) follow the common open-source
 * decoder so that outputs agree.
 */

const SCE = 0;
const CPE = 1;
const CCE = 2;

const FIXFIX = 0;
const FIXVAR = 1;
const VARFIX = 2;

const EXTENSION_ID_PS = 2;

/** First QMF slot of the current frame in the X_low/X_high buffers. */
const ADJ = 2;
const NOISE_FLOOR_OFFSET = 6;
const SYNTHESIS_BUF = (1280 - 128) * 2;
const FLT_EPSILON = 1.1920928955078125e-7;
const FLT_MIN = 1.1754943508222875e-38;

const HUFFMAN_TREES = SBR_HUFFMAN_TABLES.map(table => huffmanCode(table.codes, table.bits));
const T_ENV_15 = 0;
const F_ENV_15 = 1;
const T_ENV_BAL_15 = 2;
const F_ENV_BAL_15 = 3;
const T_ENV_30 = 4;
const F_ENV_30 = 5;
const T_ENV_BAL_30 = 6;
const F_ENV_BAL_30 = 7;
const T_NOISE_30 = 8;
const T_NOISE_BAL_30 = 9;

const WINDOW_DS = Float64Array.from({ length: 320 }, (_, n) => SBR_QMF_WINDOW[2 * n]!);

const DCT64 = new Dct4(64);

/**
 * out[n] = scale * sum_k input[from + k] * -cos(pi/64 (n + 64.5)(k + 0.5)): the middle half of a
 * 128-point inverse MDCT in the sign convention that makes the shuffled transforms below equal the
 * QMF formulas of 4.6.18.4 (noise and sinusoids are added in that QMF domain, so the sign matters).
 * It is the DCT-IV of the input written backwards.
 */
function imdctHalf64(input: Float64Array, from: number, out: Float64Array, scale: number): void {
    DCT64.run(input, from, out, 63, -1, scale);
}

const LIMITER_GAINS = [0.70795, 1.0, 1.41254, 10000000000];
const H_SMOOTH = [
    0.33333333333333, 0.30150283239582, 0.21816949906249, 0.11516383427084, 0.03183050093751,
];
const BANDS_WARPED = [1.32715174233856803909, 1.18509277094158210129, 1.11987160404675912501];
const CEIL_LOG2 = [0, 1, 2, 2, 3, 3];
const f32 = Math.fround;

/** SBR state of one channel of an element. */
class SbrChannel {
    frameClass = 0;
    addHarmonicFlag = 0;
    numEnv = 0;
    readonly freqRes = new Uint8Array(7);
    numNoise = 0;
    readonly dfEnv = new Uint8Array(5);
    readonly dfNoise = new Uint8Array(2);
    readonly invfMode = [new Uint8Array(5), new Uint8Array(5)];
    readonly addHarmonic = new Uint8Array(48);
    ampRes = 0;
    readonly synthesis = new Float64Array(SYNTHESIS_BUF);
    synthesisOffset = SYNTHESIS_BUF - (1280 - 128);
    readonly analysis = new Float64Array(1312);
    readonly eA = [-1, -1];
    readonly bwArray = new Float64Array(5);
    /** QMF analysis output of the last two frames: [buffer][slot 32][band 32] complex. */
    readonly wRe = new Float64Array(2 * 32 * 32);
    readonly wIm = new Float64Array(2 * 32 * 32);
    yPos = 0;
    /** HF adjuster output of the last two frames: [buffer][slot 38][band 64] complex. */
    readonly yRe = new Float64Array(2 * 38 * 64);
    readonly yIm = new Float64Array(2 * 38 * 64);
    readonly gTemp = new Float64Array(42 * 48);
    readonly qTemp = new Float64Array(42 * 48);
    readonly sIndexMapped = new Uint8Array(8 * 48);
    readonly envFacsQ = new Int32Array(6 * 48);
    readonly envFacs = new Float64Array(6 * 48);
    readonly noiseFacsQ = new Int32Array(3 * 5);
    readonly noiseFacs = new Float64Array(3 * 5);
    readonly tEnv = new Uint8Array(8);
    tEnvNumEnvOld = 0;
    readonly tQ = new Uint8Array(3);
    fIndexNoise = 0;
    fIndexSine = 0;
}

class SbrError extends Error {}

export class AacSbr {
    /** SBR sampling rate (twice the core rate); zero until the first extension. */
    private sampleRate = 0;
    private start = false;
    private readyForDequant = false;
    private idAac: number;
    private reset = false;
    private readonly spectrum = {
        startFreq: -1,
        stopFreq: -1,
        xoverBand: -1,
        freqScale: -1,
        alterScale: -1,
        noiseBands: -1,
    };
    private ampResHeader = 0;
    private limiterBands = 0;
    private limiterGains = 0;
    private interpolFreq = 0;
    private smoothingMode = 0;
    private coupling = 0;
    private readonly k = [0, 0, 0];
    private readonly kx = [0, 32];
    private readonly m = [0, 0];
    private kxAndMPushed = false;
    private nMaster = 0;
    private readonly n = [0, 0];
    private nQ = 0;
    private nLim = 0;
    private readonly fMaster = new Int32Array(49);
    private readonly fTableLow = new Int32Array(25);
    private readonly fTableHigh = new Int32Array(49);
    private readonly fTableNoise = new Int32Array(6);
    private readonly fTableLim = new Int32Array(30);
    private numPatches = 0;
    private readonly patchNumSubbands = new Int32Array(6);
    private readonly patchStartSubband = new Int32Array(6);
    private readonly data = [new SbrChannel(), new SbrChannel()];
    private readonly ps = new AacParametricStereo();
    private readonly xLowRe = new Float64Array(32 * 40);
    private readonly xLowIm = new Float64Array(32 * 40);
    private readonly xHighRe = new Float64Array(64 * 40);
    private readonly xHighIm = new Float64Array(64 * 40);
    /** Synthesis input per channel: [slot 38][band 64] complex. */
    private readonly xRe = [new Float64Array(38 * 64), new Float64Array(38 * 64)];
    private readonly xIm = [new Float64Array(38 * 64), new Float64Array(38 * 64)];
    private readonly alpha0 = new Float64Array(64 * 2);
    private readonly alpha1 = new Float64Array(64 * 2);
    private readonly eOrigMapped = new Float64Array(7 * 48);
    private readonly qMapped = new Float64Array(7 * 48);
    private readonly sMapped = new Uint8Array(7 * 48);
    private readonly eCurr = new Float64Array(7 * 48);
    private readonly qM = new Float64Array(7 * 48);
    private readonly sM = new Float64Array(7 * 48);
    private readonly gain = new Float64Array(7 * 48);
    private readonly z = new Float64Array(320);
    private readonly mdctA = new Float64Array(64);
    private readonly mdctB = new Float64Array(64);

    constructor(idAac: number) {
        this.idAac = idAac;
        this.turnOff();
    }

    /** Pure upsampling until a valid header arrives. */
    private turnOff(): void {
        this.start = false;
        this.readyForDequant = false;
        this.kx[1] = 32;
        this.m[1] = 0;
        this.data[0]!.eA[1] = -1;
        this.data[1]!.eA[1] = -1;
        const s = this.spectrum;
        s.startFreq = s.stopFreq = s.xoverBand = s.freqScale = s.alterScale = s.noiseBands = -1;
    }

    /**
     * sbr_extension_data() of a fill element of `count` bytes whose 4-bit extension type was just
     * read; the caller repositions after the element. `ps` is the parametric stereo signal (-1
     * implicit, 0 absent, 1 present).
     */
    readExtension(
        reader: AacBitReader,
        crc: boolean,
        count: number,
        idAac: number,
        sampleRate: number,
        ps: number,
    ): void {
        const origin = reader.bitsRead();
        this.reset = false;
        if (!this.sampleRate) this.sampleRate = sampleRate;
        this.kx[0] = this.kx[1];
        this.m[0] = this.m[1];
        this.kxAndMPushed = true;
        try {
            if (crc) reader.skip(10);
            if (reader.readBit()) this.readHeader(reader);
            if (this.reset) this.resetTables();
            if (this.start)
                this.readData(reader, idAac, ps, 8 * count - 4 - (reader.bitsRead() - origin));
            if (reader.bitsRead() - origin > 8 * count - 4) this.turnOff();
        } catch (error) {
            if (!(error instanceof SbrError || error instanceof MediaForgeError)) throw error;
            this.turnOff();
        }
    }

    private readHeader(reader: AacBitReader): void {
        const s = this.spectrum;
        const old = { ...s };
        const oldLimiterBands = this.limiterBands;
        this.start = true;
        this.readyForDequant = false;
        this.ampResHeader = reader.readBit();
        s.startFreq = reader.read(4);
        s.stopFreq = reader.read(4);
        s.xoverBand = reader.read(3);
        reader.skip(2);
        const extra1 = reader.readBit();
        const extra2 = reader.readBit();
        if (extra1) {
            s.freqScale = reader.read(2);
            s.alterScale = reader.readBit();
            s.noiseBands = reader.read(2);
        } else {
            s.freqScale = 2;
            s.alterScale = 1;
            s.noiseBands = 2;
        }
        if (
            old.startFreq !== s.startFreq ||
            old.stopFreq !== s.stopFreq ||
            old.xoverBand !== s.xoverBand ||
            old.freqScale !== s.freqScale ||
            old.alterScale !== s.alterScale ||
            old.noiseBands !== s.noiseBands
        )
            this.reset = true;
        if (extra2) {
            this.limiterBands = reader.read(2);
            this.limiterGains = reader.read(2);
            this.interpolFreq = reader.readBit();
            this.smoothingMode = reader.readBit();
        } else {
            this.limiterBands = 2;
            this.limiterGains = 2;
            this.interpolFreq = 1;
            this.smoothingMode = 1;
        }
        if (this.limiterBands !== oldLimiterBands && !this.reset) this.makeLimiterTable();
    }

    private resetTables(): void {
        try {
            this.makeMasterTable();
            this.makeDerivedTables();
        } catch (error) {
            if (!(error instanceof SbrError)) throw error;
            this.turnOff();
        }
    }

    /** Master frequency band table (4.6.18.3.2). */
    private makeMasterTable(): void {
        const rate = this.sampleRate;
        const s = this.spectrum;
        const classIndex =
            rate === 16000
                ? 0
                : rate === 22050
                  ? 1
                  : rate === 24000
                    ? 2
                    : rate === 32000
                      ? 3
                      : rate === 44100 || rate === 48000 || rate === 64000
                        ? 4
                        : rate === 88200 ||
                            rate === 96000 ||
                            rate === 128000 ||
                            rate === 176400 ||
                            rate === 192000
                          ? 5
                          : -1;
        if (classIndex < 0) throw new SbrError(`unsupported SBR sample rate ${rate}`);
        const temp = rate < 32000 ? 3000 : rate < 64000 ? 4000 : 5000;
        const startMin = Math.floor((temp * 128 + (rate >> 1)) / rate);
        const stopMin = Math.floor((temp * 256 + (rate >> 1)) / rate);
        this.k[0] = startMin + SBR_OFFSET[classIndex]![s.startFreq]!;
        if (s.stopFreq < 14) {
            this.k[2] = stopMin;
            const stopDk = makeBands(stopMin, 64, 13).sort((a, b) => a - b);
            for (let k = 0; k < s.stopFreq; k++) this.k[2] += stopDk[k]!;
        } else if (s.stopFreq === 14) {
            this.k[2] = 2 * this.k[0];
        } else {
            this.k[2] = 3 * this.k[0];
        }
        this.k[2] = Math.min(64, this.k[2]);
        const maxQmfSubbands = rate <= 32000 ? 48 : rate === 44100 ? 35 : rate >= 48000 ? 32 : -1;
        if (maxQmfSubbands < 0 || this.k[2] - this.k[0] > maxQmfSubbands)
            throw new SbrError('too many QMF subbands');
        const checkMaster = (): void => {
            if (this.nMaster <= 0 || s.xoverBand >= this.nMaster)
                throw new SbrError('invalid master table');
        };
        if (!s.freqScale) {
            const dk = s.alterScale + 1;
            this.nMaster = ((this.k[2] - this.k[0] + (dk & 2)) >> dk) << 1;
            checkMaster();
            for (let k = 1; k <= this.nMaster; k++) this.fMaster[k] = dk;
            const k2diff = this.k[2] - this.k[0] - this.nMaster * dk;
            if (k2diff < 0) {
                this.fMaster[1]!--;
                this.fMaster[2]! -= k2diff < -1 ? 1 : 0;
            } else if (k2diff) {
                this.fMaster[this.nMaster]!++;
            }
            this.fMaster[0] = this.k[0];
            for (let k = 1; k <= this.nMaster; k++) this.fMaster[k]! += this.fMaster[k - 1]!;
            return;
        }
        const halfBands = 7 - s.freqScale;
        const twoRegions = 49 * this.k[2] > 110 * this.k[0];
        this.k[1] = twoRegions ? 2 * this.k[0] : this.k[2];
        const numBands0 = rint(f32(halfBands * f32(Math.log2(f32(this.k[1] / this.k[0]))))) * 2;
        if (numBands0 <= 0) throw new SbrError('invalid num_bands_0');
        const vk0 = [0, ...makeBands(this.k[0], this.k[1], numBands0).sort((a, b) => a - b)];
        const vdk0Max = vk0[numBands0]!;
        vk0[0] = this.k[0];
        for (let k = 1; k <= numBands0; k++) {
            if (vk0[k]! <= 0) throw new SbrError('invalid vDk0');
            vk0[k]! += vk0[k - 1]!;
        }
        if (!twoRegions) {
            this.nMaster = numBands0;
            checkMaster();
            this.fMaster.set(vk0.slice(0, numBands0 + 1));
            return;
        }
        const invwarp = s.alterScale ? 0.76923076923076923077 : 1;
        const numBands1 =
            rint(f32(f32(halfBands * f32(invwarp)) * f32(Math.log2(f32(this.k[2] / this.k[1]))))) *
            2;
        const vk1 = [0, ...makeBands(this.k[1], this.k[2], numBands1)];
        let vdk1Min = vk1[1]!;
        for (let k = 2; k <= numBands1; k++) vdk1Min = Math.min(vdk1Min, vk1[k]!);
        if (vdk1Min < vdk0Max) {
            const sorted = vk1.slice(1).sort((a, b) => a - b);
            for (let k = 0; k < numBands1; k++) vk1[k + 1] = sorted[k]!;
            const change = Math.min(vdk0Max - vk1[1]!, (vk1[numBands1]! - vk1[1]!) >> 1);
            vk1[1]! += change;
            vk1[numBands1]! -= change;
        }
        const sorted = vk1.slice(1).sort((a, b) => a - b);
        for (let k = 0; k < numBands1; k++) vk1[k + 1] = sorted[k]!;
        vk1[0] = this.k[1];
        for (let k = 1; k <= numBands1; k++) {
            if (vk1[k]! <= 0) throw new SbrError('invalid vDk1');
            vk1[k]! += vk1[k - 1]!;
        }
        this.nMaster = numBands0 + numBands1;
        checkMaster();
        this.fMaster.set(vk0.slice(0, numBands0 + 1));
        this.fMaster.set(vk1.slice(1, numBands1 + 1), numBands0 + 1);
    }

    /** Patch construction (4.6.18.6.3, figure 4.48). */
    private makePatches(): void {
        let lastK = -1;
        let lastMsb = -1;
        let sb = 0;
        let msb = this.k[0];
        let usb = this.kx[1];
        const goalSb = Math.floor((1000 * 2048 + (this.sampleRate >> 1)) / this.sampleRate);
        this.numPatches = 0;
        let k = 0;
        if (goalSb < this.kx[1] + this.m[1]) {
            while (this.fMaster[k]! < goalSb) k++;
        } else {
            k = this.nMaster;
        }
        do {
            let odd = 0;
            if (k === lastK && msb === lastMsb) throw new SbrError('patch construction failed');
            lastK = k;
            lastMsb = msb;
            for (let i = k; i === k || sb > this.k[0] - 1 + msb - odd; i--) {
                sb = this.fMaster[i]!;
                odd = (sb + this.k[0]) & 1;
            }
            if (this.numPatches > 5) throw new SbrError('too many patches');
            const subbands = Math.max(sb - usb, 0);
            this.patchNumSubbands[this.numPatches] = subbands;
            this.patchStartSubband[this.numPatches] = this.k[0] - odd - subbands;
            if (subbands > 0) {
                usb = sb;
                msb = sb;
                this.numPatches++;
            } else {
                msb = this.kx[1];
            }
            if (this.fMaster[k]! - sb < 3) k = this.nMaster;
        } while (sb !== this.kx[1] + this.m[1]);
        if (this.numPatches > 1 && this.patchNumSubbands[this.numPatches - 1]! < 3)
            this.numPatches--;
    }

    /** Derived frequency band tables (4.6.18.3.2). */
    private makeDerivedTables(): void {
        const s = this.spectrum;
        this.n[1] = this.nMaster - s.xoverBand;
        this.n[0] = (this.n[1] + 1) >> 1;
        for (let i = 0; i <= this.n[1]; i++) this.fTableHigh[i] = this.fMaster[s.xoverBand + i]!;
        this.m[1] = this.fTableHigh[this.n[1]]! - this.fTableHigh[0]!;
        this.kx[1] = this.fTableHigh[0]!;
        if (this.kx[1] + this.m[1] > 64) throw new SbrError('stop frequency border too high');
        if (this.kx[1] > 32) throw new SbrError('start frequency border too high');
        this.fTableLow[0] = this.fTableHigh[0]!;
        const odd = this.n[1] & 1;
        for (let k = 1; k <= this.n[0]; k++) this.fTableLow[k] = this.fTableHigh[2 * k - odd]!;
        this.nQ = Math.max(
            1,
            rint(f32(s.noiseBands * f32(Math.log2(f32(this.k[2] / this.kx[1]!))))),
        );
        if (this.nQ > 5) throw new SbrError('too many noise floor bands');
        this.fTableNoise[0] = this.fTableLow[0]!;
        let temp = 0;
        for (let k = 1; k <= this.nQ; k++) {
            temp += Math.trunc((this.n[0] - temp) / (this.nQ + 1 - k));
            this.fTableNoise[k] = this.fTableLow[temp]!;
        }
        this.makePatches();
        this.makeLimiterTable();
        this.data[0]!.fIndexNoise = 0;
        this.data[1]!.fIndexNoise = 0;
    }

    /** Limiter frequency band table (4.6.18.3.2). */
    private makeLimiterTable(): void {
        if (this.limiterBands > 0) {
            const warped = BANDS_WARPED[this.limiterBands - 1]!;
            const borders = [this.kx[1]];
            for (let k = 1; k <= this.numPatches; k++)
                borders.push(borders[k - 1]! + this.patchNumSubbands[k - 1]!);
            const table: number[] = [];
            for (let k = 0; k <= this.n[0]; k++) table.push(this.fTableLow[k]!);
            for (let k = 1; k < this.numPatches; k++) table.push(borders[k]!);
            table.sort((a, b) => a - b);
            this.nLim = this.n[0] + this.numPatches - 1;
            let out = 0;
            let input = 1;
            const isBorder = (value: number): boolean =>
                borders.slice(0, this.numPatches + 1).includes(value);
            while (out < this.nLim) {
                if (table[input]! >= table[out]! * warped) {
                    table[++out] = table[input++]!;
                } else if (table[input] === table[out] || !isBorder(table[input]!)) {
                    input++;
                    this.nLim--;
                } else if (!isBorder(table[out]!)) {
                    table[out] = table[input++]!;
                    this.nLim--;
                } else {
                    table[++out] = table[input++]!;
                }
            }
            for (let k = 0; k < table.length && k < 30; k++) this.fTableLim[k] = table[k]!;
        } else {
            this.fTableLim[0] = this.fTableLow[0]!;
            this.fTableLim[1] = this.fTableLow[this.n[0]]!;
            this.nLim = 1;
        }
    }

    private readData(reader: AacBitReader, idAac: number, ps: number, bitsLeft: number): void {
        const origin = reader.bitsRead();
        this.idAac = idAac;
        this.readyForDequant = true;
        try {
            if (idAac === SCE || idAac === CCE) this.readSingleChannel(reader);
            else if (idAac === CPE) this.readChannelPair(reader);
            else throw new SbrError(`SBR cannot apply to element type ${idAac}`);
        } catch (error) {
            if (!(error instanceof SbrError)) throw error;
            this.turnOff();
            return;
        }
        if (reader.readBit()) {
            let size = reader.read(4);
            if (size === 15) size += reader.read(8);
            let left = 8 * size;
            while (left > 7) {
                left -= 2;
                const id = reader.read(2);
                if (id === EXTENSION_ID_PS && ps !== 0) {
                    left -= this.ps.read(reader, left);
                } else {
                    reader.skip(left);
                    left = 0;
                }
            }
            if (left > 0) reader.skip(left);
        }
        void origin;
        void bitsLeft;
    }

    private readSingleChannel(reader: AacBitReader): void {
        const data = this.data[0]!;
        if (reader.readBit()) reader.skip(4);
        this.readGrid(reader, data);
        this.readDtdf(reader, data);
        this.readInvf(reader, data);
        this.readEnvelope(reader, data, 0);
        this.readNoise(reader, data, 0);
        data.addHarmonicFlag = reader.readBit();
        if (data.addHarmonicFlag)
            for (let i = 0; i < this.n[1]; i++) data.addHarmonic[i] = reader.readBit();
    }

    private readChannelPair(reader: AacBitReader): void {
        const [left, right] = this.data as [SbrChannel, SbrChannel];
        if (reader.readBit()) reader.skip(8);
        this.coupling = reader.readBit();
        if (this.coupling) {
            this.readGrid(reader, left);
            copyGrid(right, left);
            this.readDtdf(reader, left);
            this.readDtdf(reader, right);
            this.readInvf(reader, left);
            right.invfMode[1]!.set(right.invfMode[0]!);
            right.invfMode[0]!.set(left.invfMode[0]!);
            this.readEnvelope(reader, left, 0);
            this.readNoise(reader, left, 0);
            this.readEnvelope(reader, right, 1);
            this.readNoise(reader, right, 1);
        } else {
            this.readGrid(reader, left);
            this.readGrid(reader, right);
            this.readDtdf(reader, left);
            this.readDtdf(reader, right);
            this.readInvf(reader, left);
            this.readInvf(reader, right);
            this.readEnvelope(reader, left, 0);
            this.readEnvelope(reader, right, 1);
            this.readNoise(reader, left, 0);
            this.readNoise(reader, right, 1);
        }
        left.addHarmonicFlag = reader.readBit();
        if (left.addHarmonicFlag)
            for (let i = 0; i < this.n[1]; i++) left.addHarmonic[i] = reader.readBit();
        right.addHarmonicFlag = reader.readBit();
        if (right.addHarmonicFlag)
            for (let i = 0; i < this.n[1]; i++) right.addHarmonic[i] = reader.readBit();
    }

    /** sbr_grid() (table 4.64): envelope and noise time borders. */
    private readGrid(reader: AacBitReader, data: SbrChannel): void {
        let pointer = 0;
        let absBordTrail = 16;
        const numEnvOld = data.numEnv;
        data.freqRes[0] = data.freqRes[numEnvOld]!;
        data.ampRes = this.ampResHeader;
        data.tEnvNumEnvOld = data.tEnv[numEnvOld]!;
        const frameClass = reader.read(2);
        switch (frameClass) {
            case FIXFIX: {
                const numEnv = 1 << reader.read(2);
                if (numEnv > 4) throw new SbrError('too many SBR envelopes');
                data.numEnv = numEnv;
                if (numEnv === 1) data.ampRes = 0;
                data.tEnv[0] = 0;
                data.tEnv[numEnv] = absBordTrail;
                const step = Math.trunc((absBordTrail + (numEnv >> 1)) / numEnv);
                for (let i = 0; i < numEnv - 1; i++) data.tEnv[i + 1] = data.tEnv[i]! + step;
                data.freqRes[1] = reader.readBit();
                for (let i = 1; i < numEnv; i++) data.freqRes[i + 1] = data.freqRes[1]!;
                break;
            }
            case FIXVAR: {
                absBordTrail += reader.read(2);
                const numRelTrail = reader.read(2);
                data.numEnv = numRelTrail + 1;
                data.tEnv[0] = 0;
                data.tEnv[data.numEnv] = absBordTrail;
                for (let i = 0; i < numRelTrail; i++)
                    data.tEnv[data.numEnv - 1 - i] =
                        data.tEnv[data.numEnv - i]! - 2 * reader.read(2) - 2;
                pointer = reader.read(CEIL_LOG2[data.numEnv]!);
                for (let i = 0; i < data.numEnv; i++)
                    data.freqRes[data.numEnv - i] = reader.readBit();
                break;
            }
            case VARFIX: {
                data.tEnv[0] = reader.read(2);
                const numRelLead = reader.read(2);
                data.numEnv = numRelLead + 1;
                data.tEnv[data.numEnv] = absBordTrail;
                for (let i = 0; i < numRelLead; i++)
                    data.tEnv[i + 1] = data.tEnv[i]! + 2 * reader.read(2) + 2;
                pointer = reader.read(CEIL_LOG2[data.numEnv]!);
                for (let i = 0; i < data.numEnv; i++) data.freqRes[i + 1] = reader.readBit();
                break;
            }
            default: {
                data.tEnv[0] = reader.read(2);
                absBordTrail += reader.read(2);
                const numRelLead = reader.read(2);
                const numRelTrail = reader.read(2);
                const numEnv = numRelLead + numRelTrail + 1;
                if (numEnv > 5) throw new SbrError('too many SBR envelopes');
                data.numEnv = numEnv;
                data.tEnv[numEnv] = absBordTrail;
                for (let i = 0; i < numRelLead; i++)
                    data.tEnv[i + 1] = data.tEnv[i]! + 2 * reader.read(2) + 2;
                for (let i = 0; i < numRelTrail; i++)
                    data.tEnv[numEnv - 1 - i] = data.tEnv[numEnv - i]! - 2 * reader.read(2) - 2;
                pointer = reader.read(CEIL_LOG2[numEnv]!);
                for (let i = 0; i < numEnv; i++) data.freqRes[i + 1] = reader.readBit();
                break;
            }
        }
        data.frameClass = frameClass;
        if (pointer > data.numEnv + 1) throw new SbrError('bs_pointer outside the time borders');
        for (let i = 1; i <= data.numEnv; i++)
            if (data.tEnv[i - 1]! >= data.tEnv[i]!)
                throw new SbrError('time borders are not monotone');
        data.numNoise = data.numEnv > 1 ? 2 : 1;
        data.tQ[0] = data.tEnv[0]!;
        data.tQ[data.numNoise] = data.tEnv[data.numEnv]!;
        if (data.numNoise > 1) {
            let idx: number;
            if (frameClass === FIXFIX) idx = data.numEnv >> 1;
            else if (frameClass & 1) idx = data.numEnv - Math.max(pointer - 1, 1);
            else idx = !pointer ? 1 : pointer === 1 ? data.numEnv - 1 : pointer - 1;
            data.tQ[1] = data.tEnv[idx]!;
        }
        data.eA[0] = data.eA[1] !== numEnvOld ? -1 : 0;
        data.eA[1] = -1;
        if (frameClass & 1 && pointer) data.eA[1] = data.numEnv + 1 - pointer;
        else if (frameClass === VARFIX && pointer > 1) data.eA[1] = pointer - 1;
    }

    private readDtdf(reader: AacBitReader, data: SbrChannel): void {
        for (let i = 0; i < data.numEnv; i++) data.dfEnv[i] = reader.readBit();
        for (let i = 0; i < data.numNoise; i++) data.dfNoise[i] = reader.readBit();
    }

    private readInvf(reader: AacBitReader, data: SbrChannel): void {
        data.invfMode[1]!.set(data.invfMode[0]!);
        for (let i = 0; i < this.nQ; i++) data.invfMode[0]![i] = reader.read(2);
    }

    private readEnvelope(reader: AacBitReader, data: SbrChannel, ch: number): void {
        const balance = this.coupling && ch === 1;
        const delta = balance ? 2 : 1;
        const odd = this.n[1] & 1;
        let bits: number;
        let tTable: number;
        let fTable: number;
        if (balance) {
            bits = data.ampRes ? 5 : 6;
            tTable = data.ampRes ? T_ENV_BAL_30 : T_ENV_BAL_15;
            fTable = data.ampRes ? F_ENV_BAL_30 : F_ENV_BAL_15;
        } else {
            bits = data.ampRes ? 6 : 7;
            tTable = data.ampRes ? T_ENV_30 : T_ENV_15;
            fTable = data.ampRes ? F_ENV_30 : F_ENV_15;
        }
        const tTree = HUFFMAN_TREES[tTable]!;
        const tLav = SBR_HUFFMAN_TABLES[tTable]!.lav;
        const fTree = HUFFMAN_TREES[fTable]!;
        const fLav = SBR_HUFFMAN_TABLES[fTable]!.lav;
        const q = data.envFacsQ;
        const check = (value: number): number => {
            if (value < 0 || value > 127)
                throw new SbrError(`envelope scalefactor ${value} is invalid`);
            return value;
        };
        for (let i = 0; i < data.numEnv; i++) {
            const res = data.freqRes[i + 1]!;
            const bands = this.n[res]!;
            const row = (i + 1) * 48;
            const prev = i * 48;
            if (data.dfEnv[i]) {
                for (let j = 0; j < bands; j++) {
                    const k =
                        res === data.freqRes[i] ? j : res ? (j + odd) >> 1 : j ? 2 * j - odd : 0;
                    q[row + j] = check(
                        q[prev + k]! + delta * (decodeHuffman(reader, tTree) - tLav),
                    );
                }
            } else {
                q[row] = delta * reader.read(bits);
                for (let j = 1; j < bands; j++)
                    q[row + j] = check(
                        q[row + j - 1]! + delta * (decodeHuffman(reader, fTree) - fLav),
                    );
            }
        }
        q.copyWithin(0, data.numEnv * 48, data.numEnv * 48 + 48);
    }

    private readNoise(reader: AacBitReader, data: SbrChannel, ch: number): void {
        const balance = this.coupling && ch === 1;
        const delta = balance ? 2 : 1;
        const tTable = balance ? T_NOISE_BAL_30 : T_NOISE_30;
        const fTable = balance ? F_ENV_BAL_30 : F_ENV_30;
        const tTree = HUFFMAN_TREES[tTable]!;
        const tLav = SBR_HUFFMAN_TABLES[tTable]!.lav;
        const fTree = HUFFMAN_TREES[fTable]!;
        const fLav = SBR_HUFFMAN_TABLES[fTable]!.lav;
        const q = data.noiseFacsQ;
        const check = (value: number): number => {
            if (value < 0 || value > 30)
                throw new SbrError(`noise scalefactor ${value} is invalid`);
            return value;
        };
        for (let i = 0; i < data.numNoise; i++) {
            const row = (i + 1) * 5;
            if (data.dfNoise[i]) {
                for (let j = 0; j < this.nQ; j++)
                    q[row + j] = check(
                        q[i * 5 + j]! + delta * (decodeHuffman(reader, tTree) - tLav),
                    );
            } else {
                q[row] = delta * reader.read(5);
                for (let j = 1; j < this.nQ; j++)
                    q[row + j] = check(
                        q[row + j - 1]! + delta * (decodeHuffman(reader, fTree) - fLav),
                    );
            }
        }
        q.copyWithin(0, data.numNoise * 5, data.numNoise * 5 + 5);
    }

    /** Dequantization and stereo decoding of the envelope and noise floor data (4.6.18.3.5). */
    private dequant(idAac: number): void {
        const exp2 = (value: number): number => f32(2 ** value);
        if (idAac === CPE && this.coupling) {
            const [left, right] = this.data as [SbrChannel, SbrChannel];
            const panOffset = left.ampRes ? 12 : 24;
            for (let e = 1; e <= left.numEnv; e++) {
                for (let k = 0; k < this.n[left.freqRes[e]!]!; k++) {
                    const q0 = left.envFacsQ[e * 48 + k]!;
                    const q1 = panOffset - right.envFacsQ[e * 48 + k]!;
                    let temp1: number;
                    let temp2: number;
                    if (left.ampRes) {
                        temp1 = exp2(q0 + 7);
                        temp2 = exp2(q1);
                    } else {
                        temp1 = f32(exp2((q0 >> 1) + 7) * (q0 & 1 ? Math.SQRT2 : 1));
                        temp2 = f32(exp2(q1 >> 1) * (q1 & 1 ? Math.SQRT2 : 1));
                    }
                    if (temp1 > 1e20) temp1 = 1;
                    const fac = f32(temp1 / f32(1 + temp2));
                    left.envFacs[e * 48 + k] = fac;
                    right.envFacs[e * 48 + k] = f32(fac * temp2);
                }
            }
            for (let e = 1; e <= left.numNoise; e++) {
                for (let k = 0; k < this.nQ; k++) {
                    const temp1 = exp2(NOISE_FLOOR_OFFSET - left.noiseFacsQ[e * 5 + k]! + 1);
                    const temp2 = exp2(12 - right.noiseFacsQ[e * 5 + k]!);
                    const fac = f32(temp1 / f32(1 + temp2));
                    left.noiseFacs[e * 5 + k] = fac;
                    right.noiseFacs[e * 5 + k] = f32(fac * temp2);
                }
            }
            return;
        }
        for (let ch = 0; ch < (idAac === CPE ? 2 : 1); ch++) {
            const data = this.data[ch]!;
            for (let e = 1; e <= data.numEnv; e++) {
                for (let k = 0; k < this.n[data.freqRes[e]!]!; k++) {
                    const q = data.envFacsQ[e * 48 + k]!;
                    let value = data.ampRes
                        ? exp2(q + 6)
                        : f32(exp2((q >> 1) + 6) * (q & 1 ? Math.SQRT2 : 1));
                    if (value > 1e20) value = 1;
                    data.envFacs[e * 48 + k] = value;
                }
            }
            for (let e = 1; e <= data.numNoise; e++)
                for (let k = 0; k < this.nQ; k++)
                    data.noiseFacs[e * 5 + k] = exp2(
                        NOISE_FLOOR_OFFSET - data.noiseFacsQ[e * 5 + k]!,
                    );
        }
    }

    /** 32-band analysis QMF bank of 1024 core samples into W[buffer] (4.6.18.4.1). */
    private analysis(input: Float64Array, data: SbrChannel): void {
        const x = data.analysis;
        const z = this.z;
        x.copyWithin(0, 1024, 1024 + 288);
        x.set(input.subarray(0, 1024), 288);
        const pre = this.mdctA;
        const out = this.mdctB;
        const base = data.yPos * 32 * 32;
        for (let i = 0; i < 32; i++) {
            const offset = i * 32;
            for (let n = 0; n < 320; n++) z[n] = WINDOW_DS[n]! * x[offset + 319 - n]!;
            for (let k = 0; k < 64; k++)
                z[k] = z[k]! + z[k + 64]! + z[k + 128]! + z[k + 192]! + z[k + 256]!;
            pre[0] = z[0]!;
            pre[1] = z[1]!;
            for (let k = 1; k < 31; k += 2) {
                pre[2 * k] = -z[64 - k]!;
                pre[2 * k + 1] = z[k + 1]!;
                pre[2 * k + 2] = -z[63 - k]!;
                pre[2 * k + 3] = z[k + 2]!;
            }
            pre[62] = -z[33]!;
            pre[63] = z[32]!;
            imdctHalf64(pre, 0, out, -2 * 32768);
            const row = base + i * 32;
            for (let k = 0; k < 32; k++) {
                data.wRe[row + k] = -out[63 - k]!;
                data.wIm[row + k] = out[k]!;
            }
        }
    }

    /** 64-band synthesis QMF bank (32-band when downsampled) of X[ch] into `out` (4.6.18.4.2). */
    private synthesis(out: Float64Array, ch: number, downsampled: boolean): void {
        const data = this.data[ch]!;
        const re = this.xRe[ch]!;
        const im = this.xIm[ch]!;
        const v0 = data.synthesis;
        const div = downsampled ? 1 : 0;
        const window = downsampled ? WINDOW_DS : SBR_QMF_WINDOW;
        const step = 128 >> div;
        const bufA = this.mdctA;
        const bufB = this.mdctB;
        const width = 64 >> div;
        const scale = 1 / (64 * 32768);
        let at = 0;
        for (let i = 0; i < 32; i++) {
            if (data.synthesisOffset < step) {
                const saved = (1280 - 128) >> div;
                v0.copyWithin(SYNTHESIS_BUF - saved, 0, saved);
                data.synthesisOffset = SYNTHESIS_BUF - saved - step;
            } else {
                data.synthesisOffset -= step;
            }
            const v = data.synthesisOffset;
            const row = i * 64;
            if (downsampled) {
                for (let n = 0; n < 32; n++) {
                    re[row + n] = -re[row + n]!;
                    re[row + 32 + n] = im[row + 31 - n]!;
                }
                imdctHalf64(re, row, bufA, scale);
                for (let n = 0; n < 32; n++) {
                    v0[v + n] = bufA[63 - 2 * n]!;
                    v0[v + 63 - n] = -bufA[63 - 2 * n - 1]!;
                }
            } else {
                for (let k = 1; k < 64; k += 2) im[row + k] = -im[row + k]!;
                imdctHalf64(re, row, bufA, scale);
                imdctHalf64(im, row, bufB, scale);
                for (let n = 0; n < 64; n++) {
                    v0[v + n] = bufB[n]! - bufA[63 - n]!;
                    v0[v + 127 - n] = bufB[n]! + bufA[63 - n]!;
                }
            }

            // Ten taps per sample, summed in the order of the standard's formula: the 256- and
            // 192-sample offsets into V meet the window at 128-sample steps (halved when
            // downsampled).
            const v1 = v + (192 >> div);
            const vStep = 256 >> div;
            const wStep = 128 >> div;
            const w1 = 64 >> div;
            for (let n = 0; n < width; n++) {
                const a = v + n;
                const b = v1 + n;
                let sum = 0;
                sum += v0[a]! * window[n]!;
                sum += v0[b]! * window[w1 + n]!;
                sum += v0[a + vStep]! * window[wStep + n]!;
                sum += v0[b + vStep]! * window[wStep + w1 + n]!;
                sum += v0[a + 2 * vStep]! * window[2 * wStep + n]!;
                sum += v0[b + 2 * vStep]! * window[2 * wStep + w1 + n]!;
                sum += v0[a + 3 * vStep]! * window[3 * wStep + n]!;
                sum += v0[b + 3 * vStep]! * window[3 * wStep + w1 + n]!;
                sum += v0[a + 4 * vStep]! * window[4 * wStep + n]!;
                sum += v0[b + 4 * vStep]! * window[4 * wStep + w1 + n]!;
                out[at + n] = sum;
            }
            at += width;
        }
    }

    /**
     * X_low: this frame's 32 slots of the analysed low band plus 8 slots of the previous frame
     * (4.6.18.5).
     */
    private lowBand(data: SbrChannel): void {
        const re = this.xLowRe;
        const im = this.xLowIm;
        re.fill(0);
        im.fill(0);
        const current = data.yPos * 1024;
        const previous = (1 - data.yPos) * 1024;
        for (let k = 0; k < this.kx[1]!; k++) {
            for (let i = 8; i < 40; i++) {
                re[k * 40 + i] = data.wRe[current + (i - 8) * 32 + k]!;
                im[k * 40 + i] = data.wIm[current + (i - 8) * 32 + k]!;
            }
        }
        for (let k = 0; k < this.kx[0]!; k++) {
            for (let i = 0; i < 8; i++) {
                re[k * 40 + i] = data.wRe[previous + (i + 24) * 32 + k]!;
                im[k * 40 + i] = data.wIm[previous + (i + 24) * 32 + k]!;
            }
        }
    }

    /** Inverse filtering: complex second-order linear prediction of each low band (4.6.18.6.2). */
    private inverseFilter(): void {
        const re = this.xLowRe;
        const im = this.xLowIm;
        for (let k = 0; k < this.k[0]!; k++) {
            const b = k * 40;
            let realSum2 = re[b]! * re[b + 2]! + im[b]! * im[b + 2]!;
            let imagSum2 = re[b]! * im[b + 2]! - im[b]! * re[b + 2]!;
            let realSum1 = 0;
            let imagSum1 = 0;
            let realSum0 = 0;
            for (let i = 1; i < 38; i++) {
                const xr = re[b + i]!;
                const xi = im[b + i]!;
                realSum0 += xr * xr + xi * xi;
                realSum1 += xr * re[b + i + 1]! + xi * im[b + i + 1]!;
                imagSum1 += xr * im[b + i + 1]! - xi * re[b + i + 1]!;
                realSum2 += xr * re[b + i + 2]! + xi * im[b + i + 2]!;
                imagSum2 += xr * im[b + i + 2]! - xi * re[b + i + 2]!;
            }
            const phi00r = realSum1 + re[b + 38]! * re[b + 39]! + im[b + 38]! * im[b + 39]!;
            const phi00i = imagSum1 + re[b + 38]! * im[b + 39]! - im[b + 38]! * re[b + 39]!;
            const phi01r = realSum2;
            const phi01i = imagSum2;
            const phi10r = realSum0 + re[b + 38]! * re[b + 38]! + im[b + 38]! * im[b + 38]!;
            const phi11r = realSum1 + re[b]! * re[b + 1]! + im[b]! * im[b + 1]!;
            const phi11i = imagSum1 + re[b]! * im[b + 1]! - im[b]! * re[b + 1]!;
            const phi21r = realSum0 + re[b]! * re[b]! + im[b]! * im[b]!;
            const dk = phi21r * phi10r - (phi11r * phi11r + phi11i * phi11i) / 1.000001;
            let a1r = 0;
            let a1i = 0;
            if (dk) {
                a1r = (phi00r * phi11r - phi00i * phi11i - phi01r * phi10r) / dk;
                a1i = (phi00r * phi11i + phi00i * phi11r - phi01i * phi10r) / dk;
            }
            let a0r = 0;
            let a0i = 0;
            if (phi10r) {
                a0r = -(phi00r + a1r * phi11r + a1i * phi11i) / phi10r;
                a0i = -(phi00i + a1i * phi11r - a1r * phi11i) / phi10r;
            }
            if (a1r * a1r + a1i * a1i >= 16 || a0r * a0r + a0i * a0i >= 16) {
                a0r = a0i = a1r = a1i = 0;
            }
            this.alpha0[2 * k] = a0r;
            this.alpha0[2 * k + 1] = a0i;
            this.alpha1[2 * k] = a1r;
            this.alpha1[2 * k + 1] = a1i;
        }
    }

    /** Chirp factors (bandwidth) per noise band (4.6.18.6.2). */
    private chirp(data: SbrChannel): void {
        const table = [0, 0.75, 0.9, 0.98];
        for (let i = 0; i < this.nQ; i++) {
            let bw =
                data.invfMode[0]![i]! + data.invfMode[1]![i]! === 1
                    ? f32(0.6)
                    : f32(table[data.invfMode[0]![i]!]!);
            const old = data.bwArray[i]!;
            bw =
                bw < old
                    ? f32(f32(0.75 * bw) + f32(0.25 * old))
                    : f32(f32(0.90625 * bw) + f32(0.09375 * old));
            data.bwArray[i] = bw < 0.015625 ? 0 : bw;
        }
    }

    /** HF generation: patches of the low band, filtered by the chirped predictors (4.6.18.6.3). */
    private highBand(data: SbrChannel): void {
        let g = 0;
        let k = this.kx[1]!;
        const start = 2 * data.tEnv[0]!;
        const end = 2 * data.tEnv[data.numEnv]!;
        for (let j = 0; j < this.numPatches; j++) {
            for (let x = 0; x < this.patchNumSubbands[j]!; x++, k++) {
                const p = this.patchStartSubband[j]! + x;
                while (g <= this.nQ && k >= this.fTableNoise[g]!) g++;
                g--;
                if (g < 0) return;
                const bw = data.bwArray[g]!;
                const a0r = this.alpha1[2 * p]! * bw * bw;
                const a0i = this.alpha1[2 * p + 1]! * bw * bw;
                const a1r = this.alpha0[2 * p]! * bw;
                const a1i = this.alpha0[2 * p + 1]! * bw;
                const lr = this.xLowRe;
                const li = this.xLowIm;
                const src = p * 40 + ADJ;
                const dst = k * 40 + ADJ;
                for (let i = start; i < end; i++) {
                    this.xHighRe[dst + i] =
                        lr[src + i - 2]! * a0r -
                        li[src + i - 2]! * a0i +
                        lr[src + i - 1]! * a1r -
                        li[src + i - 1]! * a1i +
                        lr[src + i]!;
                    this.xHighIm[dst + i] =
                        li[src + i - 2]! * a0r +
                        lr[src + i - 2]! * a0i +
                        li[src + i - 1]! * a1r +
                        lr[src + i - 1]! * a1i +
                        li[src + i]!;
                }
            }
        }
        if (k < this.m[1]! + this.kx[1]!) {
            this.xHighRe.fill(0, k * 40, (this.m[1]! + this.kx[1]!) * 40);
            this.xHighIm.fill(0, k * 40, (this.m[1]! + this.kx[1]!) * 40);
        }
    }

    /** Frequency mapping of the envelope, noise and sinusoid data (4.6.18.7.2). */
    private mapping(data: SbrChannel): void {
        const kx = this.kx[1]!;
        data.sIndexMapped.fill(0, 48, 8 * 48);
        for (let e = 0; e < data.numEnv; e++) {
            const high = data.freqRes[e + 1]!;
            const bands = this.n[high]!;
            const table = high ? this.fTableHigh : this.fTableLow;
            if (kx !== table[0]) throw new SbrError('frequency tables are stale');
            for (let i = 0; i < bands; i++)
                for (let m = table[i]!; m < table[i + 1]!; m++)
                    this.eOrigMapped[e * 48 + m - kx] = data.envFacs[(e + 1) * 48 + i]!;
            const noiseIndex = data.numNoise > 1 && data.tEnv[e]! >= data.tQ[1]! ? 1 : 0;
            for (let i = 0; i < this.nQ; i++)
                for (let m = this.fTableNoise[i]!; m < this.fTableNoise[i + 1]!; m++)
                    this.qMapped[e * 48 + m - kx] = data.noiseFacs[(noiseIndex + 1) * 5 + i]!;
            if (data.addHarmonicFlag) {
                for (let i = 0; i < this.n[1]!; i++) {
                    const mid = (this.fTableHigh[i]! + this.fTableHigh[i + 1]!) >> 1;
                    data.sIndexMapped[(e + 1) * 48 + mid - kx] =
                        data.addHarmonic[i]! *
                        (e >= data.eA[1]! || data.sIndexMapped[mid - kx] === 1 ? 1 : 0);
                }
            }
            for (let i = 0; i < bands; i++) {
                let present = 0;
                for (let m = table[i]!; m < table[i + 1]!; m++) {
                    if (data.sIndexMapped[(e + 1) * 48 + m - kx]) {
                        present = 1;
                        break;
                    }
                }
                this.sMapped.fill(present, e * 48 + table[i]! - kx, e * 48 + table[i + 1]! - kx);
            }
        }
        data.sIndexMapped.copyWithin(0, data.numEnv * 48, data.numEnv * 48 + 48);
    }

    /** Estimated energy of the generated high band per envelope (4.6.18.7.3). */
    private estimateEnvelope(data: SbrChannel): void {
        const kx = this.kx[1]!;
        const re = this.xHighRe;
        const im = this.xHighIm;
        const sumSquare = (k: number, from: number, to: number): number => {
            let sum = 0;
            for (let i = from; i < to; i++) sum += re[k * 40 + i]! ** 2 + im[k * 40 + i]! ** 2;
            return sum;
        };
        for (let e = 0; e < data.numEnv; e++) {
            const lower = 2 * data.tEnv[e]! + ADJ;
            const upper = 2 * data.tEnv[e + 1]! + ADJ;
            if (this.interpolFreq) {
                const recip = 0.5 / (data.tEnv[e + 1]! - data.tEnv[e]!);
                for (let m = 0; m < this.m[1]!; m++)
                    this.eCurr[e * 48 + m] = sumSquare(m + kx, lower, upper) * recip;
            } else {
                const size = 2 * (data.tEnv[e + 1]! - data.tEnv[e]!);
                const high = data.freqRes[e + 1]!;
                const table = high ? this.fTableHigh : this.fTableLow;
                for (let p = 0; p < this.n[high]!; p++) {
                    let sum = 0;
                    for (let k = table[p]!; k < table[p + 1]!; k++)
                        sum += sumSquare(k, lower, upper);
                    sum /= size * (table[p + 1]! - table[p]!);
                    for (let k = table[p]!; k < table[p + 1]!; k++)
                        this.eCurr[e * 48 + k - kx] = sum;
                }
            }
        }
    }

    /** Gains, limited per limiter band, and the noise and sinusoid levels (4.6.18.7.4). */
    private gainCalc(data: SbrChannel): void {
        const kx = this.kx[1]!;
        for (let e = 0; e < data.numEnv; e++) {
            const delta = e === data.eA[1] || e === data.eA[0] ? 0 : 1;
            const row = e * 48;
            for (let k = 0; k < this.nLim; k++) {
                const from = this.fTableLim[k]! - kx;
                const to = this.fTableLim[k + 1]! - kx;
                for (let m = from; m < to; m++) {
                    const orig = this.eOrigMapped[row + m]!;
                    const q = this.qMapped[row + m]!;
                    const temp = orig / (1 + q);
                    this.qM[row + m] = Math.sqrt(temp * q);
                    this.sM[row + m] = Math.sqrt(temp * data.sIndexMapped[(e + 1) * 48 + m]!);
                    const curr = this.eCurr[row + m]!;
                    this.gain[row + m] =
                        (this.sMapped[row + m]
                            ? Math.sqrt((orig * q) / ((1 + curr) * (1 + q)))
                            : Math.sqrt(orig / ((1 + curr) * (1 + q * delta)))) + FLT_MIN;
                }
                let sum0 = 0;
                let sum1 = 0;
                for (let m = from; m < to; m++) {
                    sum0 += this.eOrigMapped[row + m]!;
                    sum1 += this.eCurr[row + m]!;
                }
                let gainMax =
                    LIMITER_GAINS[this.limiterGains]! *
                    Math.sqrt((FLT_EPSILON + sum0) / (FLT_EPSILON + sum1));
                gainMax = Math.min(100000, gainMax);
                for (let m = from; m < to; m++) {
                    const qMax = (this.qM[row + m]! * gainMax) / this.gain[row + m]!;
                    this.qM[row + m] = Math.min(this.qM[row + m]!, qMax);
                    this.gain[row + m] = Math.min(this.gain[row + m]!, gainMax);
                }
                sum0 = 0;
                sum1 = 0;
                for (let m = from; m < to; m++) {
                    sum0 += this.eOrigMapped[row + m]!;
                    const s = this.sM[row + m]!;
                    sum1 +=
                        this.eCurr[row + m]! * this.gain[row + m]! * this.gain[row + m]! +
                        s * s +
                        (delta && !s ? this.qM[row + m]! * this.qM[row + m]! : 0);
                }
                const boost = Math.min(
                    1.584893192,
                    Math.sqrt((FLT_EPSILON + sum0) / (FLT_EPSILON + sum1)),
                );
                for (let m = from; m < to; m++) {
                    this.gain[row + m]! *= boost;
                    this.qM[row + m]! *= boost;
                    this.sM[row + m]! *= boost;
                }
            }
        }
    }

    /**
     * HF signal assembly: gains with time smoothing, noise floor and sinusoids into Y[yPos]
     * (4.6.18.7.5).
     */
    private assemble(data: SbrChannel): void {
        const smoothing = this.smoothingMode ? 0 : 4;
        const kx = this.kx[1]!;
        const mMax = this.m[1]!;
        const gTemp = data.gTemp;
        const qTemp = data.qTemp;
        let indexNoise = data.fIndexNoise;
        let indexSine = data.fIndexSine;
        const t0 = 2 * data.tEnv[0]!;
        if (this.reset) {
            for (let i = 0; i < smoothing; i++) {
                gTemp.set(this.gain.subarray(0, mMax), (i + t0) * 48);
                qTemp.set(this.qM.subarray(0, mMax), (i + t0) * 48);
            }
        } else if (smoothing) {
            for (let i = 0; i < 4; i++) {
                gTemp.copyWithin(
                    (i + t0) * 48,
                    (i + 2 * data.tEnvNumEnvOld) * 48,
                    (i + 2 * data.tEnvNumEnvOld + 1) * 48,
                );
                qTemp.copyWithin(
                    (i + t0) * 48,
                    (i + 2 * data.tEnvNumEnvOld) * 48,
                    (i + 2 * data.tEnvNumEnvOld + 1) * 48,
                );
            }
        }
        for (let e = 0; e < data.numEnv; e++) {
            for (let i = 2 * data.tEnv[e]!; i < 2 * data.tEnv[e + 1]!; i++) {
                gTemp.set(this.gain.subarray(e * 48, e * 48 + mMax), (smoothing + i) * 48);
                qTemp.set(this.qM.subarray(e * 48, e * 48 + mMax), (smoothing + i) * 48);
            }
        }
        const yBase = data.yPos * 38 * 64;
        const gFilt = new Float64Array(48);
        const qFilt = new Float64Array(48);
        for (let e = 0; e < data.numEnv; e++) {
            const transient = e === data.eA[0] || e === data.eA[1];
            for (let i = 2 * data.tEnv[e]!; i < 2 * data.tEnv[e + 1]!; i++) {
                if (smoothing && !transient) {
                    for (let m = 0; m < mMax; m++) {
                        let g = 0;
                        let q = 0;
                        for (let j = 0; j <= smoothing; j++) {
                            g += gTemp[(i + smoothing - j) * 48 + m]! * H_SMOOTH[j]!;
                            q += qTemp[(i + smoothing - j) * 48 + m]! * H_SMOOTH[j]!;
                        }
                        gFilt[m] = g;
                        qFilt[m] = q;
                    }
                } else {
                    gFilt.set(gTemp.subarray((i + smoothing) * 48, (i + smoothing) * 48 + 48));
                    qFilt.set(qTemp.subarray(i * 48, i * 48 + 48));
                }
                const row = yBase + i * 64 + kx;
                for (let m = 0; m < mMax; m++) {
                    data.yRe[row + m] = this.xHighRe[(kx + m) * 40 + i + ADJ]! * gFilt[m]!;
                    data.yIm[row + m] = this.xHighIm[(kx + m) * 40 + i + ADJ]! * gFilt[m]!;
                }
                const sm = e * 48;
                if (!transient) {
                    const phiRe = indexSine === 0 ? 1 : indexSine === 2 ? -1 : 0;
                    let phiIm = indexSine & 1 ? (1 - 2 * (kx & 1)) * (indexSine === 3 ? -1 : 1) : 0;
                    let noise = indexNoise;
                    for (let m = 0; m < mMax; m++) {
                        noise = (noise + 1) & 0x1ff;
                        const s = this.sM[sm + m]!;
                        if (s) {
                            data.yRe[row + m]! += s * phiRe;
                            data.yIm[row + m]! += s * phiIm;
                        } else {
                            data.yRe[row + m]! += qFilt[m]! * SBR_NOISE_TABLE[2 * noise]!;
                            data.yIm[row + m]! += qFilt[m]! * SBR_NOISE_TABLE[2 * noise + 1]!;
                        }
                        phiIm = -phiIm;
                    }
                } else {
                    const imaginary = indexSine & 1;
                    const a = 1 - ((indexSine + (kx & 1)) & 2);
                    const b = imaginary ? -a : a;
                    for (let m = 0; m < mMax; m++) {
                        const s = this.sM[sm + m]! * (m & 1 ? b : a);
                        if (imaginary) data.yIm[row + m]! += s;
                        else data.yRe[row + m]! += s;
                    }
                }
                indexNoise = (indexNoise + mMax) & 0x1ff;
                indexSine = (indexSine + 1) & 3;
            }
        }
        data.fIndexNoise = indexNoise;
        data.fIndexSine = indexSine;
    }

    /**
     * X for synthesis: low band from X_low, high band from Y of this and (for the leading slots)
     * the last frame.
     */
    private assembleX(data: SbrChannel, ch: number): void {
        const re = this.xRe[ch]!;
        const im = this.xIm[ch]!;
        re.fill(0);
        im.fill(0);
        const iTemp = Math.max(2 * data.tEnvNumEnvOld - 32, 0);
        const oldY = (1 - data.yPos) * 38 * 64;
        const newY = data.yPos * 38 * 64;
        let k = 0;
        for (; k < this.kx[0]!; k++) {
            for (let i = 0; i < iTemp; i++) {
                re[i * 64 + k] = this.xLowRe[k * 40 + i + ADJ]!;
                im[i * 64 + k] = this.xLowIm[k * 40 + i + ADJ]!;
            }
        }
        for (; k < this.kx[0]! + this.m[0]!; k++) {
            for (let i = 0; i < iTemp; i++) {
                re[i * 64 + k] = data.yRe[oldY + (i + 32) * 64 + k]!;
                im[i * 64 + k] = data.yIm[oldY + (i + 32) * 64 + k]!;
            }
        }
        for (k = 0; k < this.kx[1]!; k++) {
            for (let i = iTemp; i < 38; i++) {
                re[i * 64 + k] = this.xLowRe[k * 40 + i + ADJ]!;
                im[i * 64 + k] = this.xLowIm[k * 40 + i + ADJ]!;
            }
        }
        for (; k < this.kx[1]! + this.m[1]!; k++) {
            for (let i = iTemp; i < 32; i++) {
                re[i * 64 + k] = data.yRe[newY + i * 64 + k]!;
                im[i * 64 + k] = data.yIm[newY + i * 64 + k]!;
            }
        }
    }

    /**
     * Replaces the core output of the element (1024 samples in `left`, and `right` for a pair or
     * parametric stereo) with the SBR output: 2048 samples, or 1024 when `extensionRate` is below
     * the SBR rate (downsampled SBR).
     */
    apply(
        idAac: number,
        left: Float64Array,
        right: Float64Array,
        extensionRate: number,
        ps: boolean,
    ): void {
        const downsampled = extensionRate < this.sampleRate;
        let channels = idAac === CPE ? 2 : 1;
        if (idAac !== this.idAac) this.turnOff();
        if (this.start && !this.readyForDequant) this.turnOff();
        if (!this.kxAndMPushed) {
            this.kx[0] = this.kx[1]!;
            this.m[0] = this.m[1]!;
        } else {
            this.kxAndMPushed = false;
        }
        if (this.start) {
            this.dequant(idAac);
            this.readyForDequant = false;
        }
        for (let ch = 0; ch < channels; ch++) {
            const data = this.data[ch]!;
            this.analysis(ch ? right : left, data);
            this.lowBand(data);
            data.yPos ^= 1;
            if (this.start) {
                try {
                    this.inverseFilter();
                    this.chirp(data);
                    this.highBand(data);
                    this.mapping(data);
                    this.estimateEnvelope(data);
                    this.gainCalc(data);
                    this.assemble(data);
                } catch (error) {
                    if (!(error instanceof SbrError)) throw error;
                    this.turnOff();
                }
            }
            this.assembleX(data, ch);
        }
        if (ps) {
            if (this.ps.started) {
                this.ps.apply(
                    this.xRe[0]!,
                    this.xIm[0]!,
                    this.xRe[1]!,
                    this.xIm[1]!,
                    this.kx[1]! + this.m[1]!,
                );
            } else {
                this.xRe[1]!.set(this.xRe[0]!);
                this.xIm[1]!.set(this.xIm[0]!);
            }
            channels = 2;
        }
        this.synthesis(left, 0, downsampled);
        if (channels === 2) this.synthesis(right, 1, downsampled);
    }
}

function copyGrid(dst: SbrChannel, src: SbrChannel): void {
    dst.freqRes[0] = dst.freqRes[dst.numEnv]!;
    dst.tEnvNumEnvOld = dst.tEnv[dst.numEnv]!;
    dst.eA[0] = dst.eA[1] !== dst.numEnv ? -1 : 0;
    dst.freqRes.set(src.freqRes.subarray(1), 1);
    dst.tEnv.set(src.tEnv);
    dst.tQ.set(src.tQ);
    dst.numEnv = src.numEnv;
    dst.ampRes = src.ampRes;
    dst.numNoise = src.numNoise;
    dst.frameClass = src.frameClass;
    dst.eA[1] = src.eA[1]!;
}

/** Round half to even, as lrintf does in the default rounding mode. */
function rint(value: number): number {
    const floor = Math.floor(value);
    const diff = value - floor;
    return diff > 0.5 || (diff === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}

/**
 * Band widths of `bands` bands between `start` and `stop` on a logarithmic scale, in single
 * precision.
 */
function makeBands(start: number, stop: number, bands: number): number[] {
    const base = f32(Math.pow(f32(stop / start), f32(1 / bands)));
    let product = start;
    let previous = start;
    const out: number[] = [];
    for (let k = 0; k < bands - 1; k++) {
        product = f32(product * base);
        const present = rint(product);
        out.push(present - previous);
        previous = present;
    }
    out.push(stop - previous);
    return out;
}
