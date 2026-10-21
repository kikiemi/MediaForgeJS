import { rshiftRound, sat16, smlabb, smlawb, smulbb, smulwb, smulww } from './silk-math';

const UP2_HQ_0 = [1746, 14986, 39083 - 65536];
const UP2_HQ_1 = [6854, 25769, 55542 - 65536];
const FRAC_FIR_12 = new Int16Array([
    189, -600, 617, 30567, 117, -159, -1070, 29704, 52, 221, -2392, 28276, -4, 529, -3350, 26341,
    -48, 758, -3956, 23973, -80, 905, -4235, 21254, -99, 972, -4222, 18278, -107, 967, -3957, 15143,
    -103, 896, -3487, 11950, -91, 773, -2865, 8798, -71, 611, -2143, 5784, -46, 425, -1375, 2996,
]);
const FIR_ORDER = 8;
const BATCH_MS = 10;

/** Decoder input delay per internal rate (8, 12, 16 kHz) when the output rate is 48 kHz. */
const INPUT_DELAY_48K = [0, 4, 7];

/**
 * SILK 8/12/16 kHz to 48 kHz resampler of the reference decoder (2x IIR upsampling followed by
 * fractional FIR interpolation); the state carries across frames.
 */
export class SilkResampler {
    private readonly iir = new Int32Array(6);
    private readonly fir = new Int16Array(FIR_ORDER);
    private readonly delayBuf = new Int16Array(48);
    private buf = new Int16Array(0);
    private inputDelay = 0;
    private batchSize = 0;
    private invRatioQ16 = 0;
    private fsInKHz = 0;
    private fsOutKHz = 48;

    init(fsInKHz: number): void {
        this.iir.fill(0);
        this.fir.fill(0);
        this.delayBuf.fill(0);
        this.inputDelay = INPUT_DELAY_48K[(fsInKHz - 8) >> 2]!;
        this.fsInKHz = fsInKHz;
        this.batchSize = fsInKHz * BATCH_MS;
        const fsIn = fsInKHz * 1000;
        const fsOut = this.fsOutKHz * 1000;
        this.invRatioQ16 = Math.floor((fsIn * 2 ** 15) / fsOut) << 2;
        while (smulww(this.invRatioQ16, fsOut) < fsIn << 1) this.invRatioQ16++;
        if (this.buf.length < 2 * this.batchSize + FIR_ORDER)
            this.buf = new Int16Array(2 * this.batchSize + FIR_ORDER);
    }

    /**
     * Resamples `inLen` samples of `input` (from `inOffset`) into `out` at `outOffset`; returns
     * samples written.
     */
    process(
        out: Int16Array,
        outOffset: number,
        input: Int16Array,
        inOffset: number,
        inLen: number,
    ): number {
        const nSamples = this.fsInKHz - this.inputDelay;
        this.delayBuf.set(input.subarray(inOffset, inOffset + nSamples), this.inputDelay);
        this.iirFir(out, outOffset, this.delayBuf, 0, this.fsInKHz);
        this.iirFir(
            out,
            outOffset + this.fsOutKHz,
            input,
            inOffset + nSamples,
            inLen - this.fsInKHz,
        );
        this.delayBuf.set(input.subarray(inOffset + inLen - this.inputDelay, inOffset + inLen), 0);
        return (inLen * this.fsOutKHz) / this.fsInKHz;
    }

    private iirFir(
        out: Int16Array,
        outOffset: number,
        input: Int16Array,
        inOffset: number,
        inLen: number,
    ): void {
        const buf = this.buf;
        buf.set(this.fir, 0);
        let nSamplesIn = 0;
        for (;;) {
            nSamplesIn = Math.min(inLen, this.batchSize);
            this.up2Hq(buf, FIR_ORDER, input, inOffset, nSamplesIn);
            outOffset = this.interpolate(out, outOffset, buf, nSamplesIn * 2 ** 17);
            inOffset += nSamplesIn;
            inLen -= nSamplesIn;
            if (inLen > 0) buf.copyWithin(0, nSamplesIn << 1, (nSamplesIn << 1) + FIR_ORDER);
            else break;
        }
        this.fir.set(buf.subarray(nSamplesIn << 1, (nSamplesIn << 1) + FIR_ORDER));
    }

    private interpolate(
        out: Int16Array,
        outOffset: number,
        buf: Int16Array,
        maxIndexQ16: number,
    ): number {
        const increment = this.invRatioQ16;
        for (let indexQ16 = 0; indexQ16 < maxIndexQ16; indexQ16 += increment) {
            const tableIndex = smulwb(indexQ16 & 0xffff, 12);
            const at = indexQ16 >> 16;
            const t0 = tableIndex * 4;
            const t1 = (11 - tableIndex) * 4;
            let res = smulbb(buf[at]!, FRAC_FIR_12[t0]!);
            res = smlabb(res, buf[at + 1]!, FRAC_FIR_12[t0 + 1]!);
            res = smlabb(res, buf[at + 2]!, FRAC_FIR_12[t0 + 2]!);
            res = smlabb(res, buf[at + 3]!, FRAC_FIR_12[t0 + 3]!);
            res = smlabb(res, buf[at + 4]!, FRAC_FIR_12[t1 + 3]!);
            res = smlabb(res, buf[at + 5]!, FRAC_FIR_12[t1 + 2]!);
            res = smlabb(res, buf[at + 6]!, FRAC_FIR_12[t1 + 1]!);
            res = smlabb(res, buf[at + 7]!, FRAC_FIR_12[t1]!);
            out[outOffset++] = sat16(rshiftRound(res, 15));
        }
        return outOffset;
    }

    private up2Hq(
        out: Int16Array,
        outOffset: number,
        input: Int16Array,
        inOffset: number,
        len: number,
    ): void {
        const S = this.iir;
        for (let k = 0; k < len; k++) {
            const in32 = input[inOffset + k]! << 10;
            let Y = (in32 - S[0]!) | 0;
            let X = smulwb(Y, UP2_HQ_0[0]!);
            let out1 = (S[0]! + X) | 0;
            S[0] = (in32 + X) | 0;
            Y = (out1 - S[1]!) | 0;
            X = smulwb(Y, UP2_HQ_0[1]!);
            const out2 = (S[1]! + X) | 0;
            S[1] = (out1 + X) | 0;
            Y = (out2 - S[2]!) | 0;
            X = smlawb(Y, Y, UP2_HQ_0[2]!);
            out1 = (S[2]! + X) | 0;
            S[2] = (out2 + X) | 0;
            out[outOffset + 2 * k] = sat16(rshiftRound(out1, 10));
            Y = (in32 - S[3]!) | 0;
            X = smulwb(Y, UP2_HQ_1[0]!);
            out1 = (S[3]! + X) | 0;
            S[3] = (in32 + X) | 0;
            Y = (out1 - S[4]!) | 0;
            X = smulwb(Y, UP2_HQ_1[1]!);
            const out2b = (S[4]! + X) | 0;
            S[4] = (out1 + X) | 0;
            Y = (out2b - S[5]!) | 0;
            X = smlawb(Y, Y, UP2_HQ_1[2]!);
            out1 = (S[5]! + X) | 0;
            S[5] = (out2b + X) | 0;
            out[outOffset + 2 * k + 1] = sat16(rshiftRound(out1, 10));
        }
    }

    copyFrom(other: SilkResampler): void {
        this.iir.set(other.iir);
        this.fir.set(other.fir);
        this.delayBuf.set(other.delayBuf);
        this.inputDelay = other.inputDelay;
        this.batchSize = other.batchSize;
        this.invRatioQ16 = other.invRatioQ16;
        this.fsInKHz = other.fsInKHz;
        if (this.buf.length < other.buf.length) this.buf = new Int16Array(other.buf.length);
    }
}
