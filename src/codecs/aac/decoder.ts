import { yieldEventLoop } from '../../core/io/event-loop';
import { DecodeError, throwIfAborted } from '../../core/errors/errors';
import type { DecodeOptions } from '../../core/contracts/decoder';
import { AAC_SAMPLE_RATES } from '../../core/codec-config/audio/aac-sample-rates';
import { AAC_CCE, AAC_CPE, type AacFrames } from '../../core/codec-config/audio/adts';
import { Dct4 } from './transform';
import { kbdWindow } from '../shared/kaiser';
import { POW43_MAX, pow43Table } from '../shared/pow43';
import {
    AFTER_IMDCT,
    AOT_AAC_LC,
    AOT_AAC_MAIN,
    AacSyntax,
    BEFORE_TNS,
    BETWEEN_TNS_AND_IMDCT,
    EIGHT_SHORT,
    FRAME_LEN,
    INTENSITY_HCB,
    INTENSITY_HCB2,
    LONG_START,
    LONG_STOP,
    MAX_PREDICTORS,
    NOISE_HCB,
    ONLY_LONG,
    PRED_SFB_MAX,
    SHORT_LEN,
    ZERO_HCB,
    aacConfigOf,
    type AacSbrTools,
    type Channel,
    type Element,
    type MissingSbr,
} from '../../core/codec-config/audio/aac-syntax';

export {
    aacDecoderConfig,
    aacOutputShape,
    type AacDecoderConfig,
    type AacSbrProcessor,
    type AacSbrTools,
    type MissingSbr,
} from '../../core/codec-config/audio/aac-syntax';

/** Rising half (n taps) of the sine window of length 2n. */
function sineWindow(n: number): Float64Array {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = Math.sin((Math.PI / (2 * n)) * (i + 0.5));
    return w;
}

/** 2^((sf - 100) / 4), the gain of a spectral band's scalefactor sf (0..255). */
const BAND_GAINS = Float64Array.from({ length: 256 }, (_, sf) => Math.pow(2, 0.25 * (sf - 100)));

/** Sine and KBD windows of one transform length (1024 or 960 long, 128 or 120 short). */
interface WindowPair {
    readonly sine: Float64Array;
    readonly kbd: Float64Array;
}
const WINDOWS = new Map<number, WindowPair>();

function windowPair(length: number): WindowPair {
    let pair = WINDOWS.get(length);
    if (!pair) {
        pair = { sine: sineWindow(length), kbd: kbdWindow(length, length > 256 ? 4 : 6) };
        WINDOWS.set(length, pair);
    }
    return pair;
}

/**
 * Inverse MDCT of n/2 coefficients whose n outputs are x[i] = sum X[k] cos(2 pi / n (i + n/4 +
 * 1/2)(k + 1/2)); half() yields the middle n/2 of them, x[n/4 + i] = -DCT-IV(X)[n/2 - 1 - i].
 */
class Imdct {
    private readonly dct: Dct4;
    private readonly size: number;

    constructor(n: number) {
        this.size = n >> 1;
        this.dct = new Dct4(this.size);
    }

    /**
     * The middle n/2 samples x[n/4 .. 3n/4) of the transform of spectrum[from, from + n/2), times
     * `scale`.
     */
    half(spectrum: Float64Array, from: number, out: Float64Array, at: number, scale: number): void {
        this.dct.run(spectrum, from, out, at + this.size - 1, -1, -scale);
    }
}

/**
 * Inverse MDCT by direct summation, for the 960- and 120-sample transforms whose lengths are not
 * powers of two.
 */
class DirectImdct {
    private readonly table: Float64Array;
    private readonly half2: number;

    constructor(n: number) {
        const half = n >> 1;
        this.half2 = half;
        this.table = new Float64Array(half * half);
        for (let i = 0; i < half; i++)
            for (let k = 0; k < half; k++)
                this.table[i * half + k] = Math.cos(
                    ((2 * Math.PI) / n) * (i + half + 0.5) * (k + 0.5),
                );
    }

    half(spectrum: Float64Array, from: number, out: Float64Array, at: number, scale: number): void {
        const half = this.half2;
        const table = this.table;
        for (let i = 0; i < half; i++) {
            let sum = 0;
            const row = i * half;
            for (let k = 0; k < half; k++) sum += spectrum[from + k]! * table[row + k]!;
            out[at + i] = sum * scale;
        }
    }
}

/**
 * Overlap of two half transforms through a window of 2len taps: dst[a] = s0[a] w[2len-1-a] -
 * s1[len-1-a] w[a] and dst[2len-1-a] = s0[a] w[a] + s1[len-1-a] w[2len-1-a].
 */
function overlapWindow(
    dst: Float64Array,
    d: number,
    src0: Float64Array,
    s0: number,
    src1: Float64Array,
    s1: number,
    win: Float64Array,
    len: number,
): void {
    for (let a = 0; a < len; a++) {
        const x0 = src0[s0 + a]!;
        const x1 = src1[s1 + len - 1 - a]!;
        const wa = win[a]!;
        const wb = win[2 * len - 1 - a]!;
        dst[d + a] = x0 * wb - x1 * wa;
        dst[d + 2 * len - 1 - a] = x0 * wa + x1 * wb;
    }
}

/** What decodeAacFrames() returns. */
export interface DecodedAac {
    readonly sampleRate: number;
    readonly channels: number;
    readonly sampleFrames: number;
    /** Planar samples, one Float32Array per channel. */
    readonly channelData: readonly Float32Array[];
}

/** The options of decodeAacFrames(). */
export interface AacDecodeOptions extends DecodeOptions {
    /** Called after each decoded frame. */
    readonly onProgress?: (decodedFrames: number, totalFrames: number) => void;
}

/**
 * Self-hosted AAC decoder (ISO/IEC 14496-3 Main and LC profiles with program config elements,
 * coupling channels, SBR and parametric stereo): AacSyntax with the synthesis. The output layout
 * follows the common decoder convention: planes in WAVE speaker order, mono HE-AAC with parametric
 * stereo (explicit or implicit) as stereo, implicit SBR when the first frame carries it.
 */
class AacDecoder extends AacSyntax {
    /** The long and short inverse transforms, made with the first frame that is transformed. */
    private transforms?: {
        readonly long: Imdct | DirectImdct;
        readonly short: Imdct | DirectImdct;
    };
    private readonly buf = new Float64Array(FRAME_LEN);
    private readonly temp = new Float64Array(128);
    /** TNS filter coefficients and the previous order's, reused by every filter. */
    private readonly lpc = new Float64Array(20);
    private readonly lpcPrevious = new Float64Array(20);

    /**
     * Decodes one raw AAC access unit into per-channel PCM for that frame (empty planes for a frame
     * without audio).
     */
    decodeFrame(accessUnit: Uint8Array): Float32Array[] {
        return this.readFrame(accessUnit, false);
    }

    protected override joinPair(element: Element, commonWindow: boolean, msPresent: number): void {
        const [left, right] = element.ch;
        if (commonWindow) {
            if (msPresent) this.applyMidSide(element);
            if (this.objectType === AOT_AAC_MAIN) {
                this.applyPrediction(left);
                this.applyPrediction(right);
            }
        }
        this.applyIntensity(element, msPresent);
    }

    protected override predict(channel: Channel): void {
        this.applyPrediction(channel);
    }

    protected override dequantize(
        channel: Channel,
        positions: number[],
        amplitudes: number[],
    ): void {
        const ics = channel.ics;
        const offsets = ics.swbOffset;
        const spec = channel.coeffs;
        const powers = pow43Table();
        let window = 0;
        for (let g = 0, idx = 0; g < ics.numWindowGroups; g++) {
            const groupLen = ics.groupLen[g]!;
            for (let sfb = 0; sfb < ics.maxSfb; sfb++, idx++) {
                const book = channel.bandType[idx]!;
                if (book === ZERO_HCB || book >= NOISE_HCB) continue;
                const sf = channel.sf[idx]!;
                const gain =
                    sf >= 0 && sf <= 255 ? BAND_GAINS[sf]! : Math.pow(2, 0.25 * (sf - 100));
                const width = offsets[sfb + 1]! - offsets[sfb]!;
                for (let w = 0; w < groupLen; w++) {
                    const base = (window + w) * SHORT_LEN + offsets[sfb]!;

                    // Without a branch on zero: 0^(4/3) * gain is the zero already there.
                    for (let i = 0; i < width; i++) {
                        const q = spec[base + i]!;
                        const magnitude = Math.abs(q);
                        const power =
                            magnitude <= POW43_MAX
                                ? powers[magnitude]!
                                : Math.pow(magnitude, 4 / 3);
                        spec[base + i] = (q < 0 ? -1 : 1) * power * gain;
                    }
                }
            }
            window += groupLen;
        }

        // Pulses (4.6.3.3) add to the quantized magnitude, away from zero and downwards for a zero
        // value. A pulse beyond max_sfb takes the band type and scalefactor the band last had, as
        // in the common decoder.
        for (let i = 0; i < positions.length; i++) {
            const k = positions[i]!;
            let band = 0;
            while (offsets[band + 1]! <= k) band++;
            const book = channel.bandType[band]!;
            if (book === NOISE_HCB || book === ZERO_HCB) continue;
            const gain =
                book >= INTENSITY_HCB2
                    ? -Math.pow(2, -0.25 * channel.sf[band]!)
                    : Math.pow(2, 0.25 * (channel.sf[band]! - 100));
            const value = spec[k]! / gain;
            const quantized = value ? Math.sign(value) * Math.pow(Math.abs(value), 3 / 4) : 0;
            const pulsed = quantized + (value > 0 ? amplitudes[i]! : -amplitudes[i]!);
            spec[k] = Math.sign(pulsed) * Math.pow(Math.abs(pulsed), 4 / 3) * gain;
        }
    }

    private applyTns(channel: Channel): void {
        const { tns, ics } = channel;
        const bandLimit = Math.min(ics.tnsMaxBands, ics.maxSfb);
        if (!bandLimit) return;
        const spec = channel.coeffs;
        const { lpc, lpcPrevious: tmp } = this;
        for (let w = 0; w < ics.numWindows; w++) {
            let bottom = ics.numSwb;
            for (let f = 0; f < tns.nFilt[w]!; f++) {
                const slot = w * 4 + f;
                const top = bottom;
                bottom = Math.max(0, top - tns.length[slot]!);
                const order = tns.order[slot]!;
                if (!order) continue;
                for (let m = 0; m < order; m++) {
                    const k = tns.coef[slot * 20 + m]!;
                    tmp.set(lpc);
                    lpc[m] = k;
                    for (let i = 0; i < m; i++) lpc[i] = tmp[i]! + k * tmp[m - 1 - i]!;
                }
                let start = ics.swbOffset[Math.min(bottom, bandLimit)]!;
                const end = ics.swbOffset[Math.min(top, bandLimit)]!;
                const size = end - start;
                if (size <= 0) continue;
                let inc = 1;
                if (tns.direction[slot]) {
                    inc = -1;
                    start = end - 1;
                }
                start += w * SHORT_LEN;
                for (let m = 0; m < size; m++, start += inc) {
                    let acc = spec[start]!;
                    for (let i = 1; i <= Math.min(m, order); i++)
                        acc -= spec[start - i * inc]! * lpc[i - 1]!;
                    spec[start] = acc;
                }
            }
        }
    }

    private applyMidSide(element: Element): void {
        const [left, right] = element.ch;
        const ics = left.ics;
        const offsets = ics.swbOffset;
        let window = 0;
        for (let g = 0, idx = 0; g < ics.numWindowGroups; g++) {
            for (let sfb = 0; sfb < ics.maxSfb; sfb++, idx++) {
                if (
                    !element.msMask[idx] ||
                    left.bandType[idx]! >= NOISE_HCB ||
                    right.bandType[idx]! >= NOISE_HCB
                )
                    continue;
                for (let w = 0; w < ics.groupLen[g]!; w++) {
                    const base = (window + w) * SHORT_LEN;
                    for (let k = offsets[sfb]!; k < offsets[sfb + 1]!; k++) {
                        const mid = left.coeffs[base + k]!;
                        const side = right.coeffs[base + k]!;
                        left.coeffs[base + k] = mid + side;
                        right.coeffs[base + k] = mid - side;
                    }
                }
            }
            window += ics.groupLen[g]!;
        }
    }

    private applyIntensity(element: Element, msPresent: number): void {
        const [left, right] = element.ch;
        const ics = right.ics;
        const offsets = ics.swbOffset;
        let window = 0;
        for (let g = 0, idx = 0; g < ics.numWindowGroups; g++) {
            for (let sfb = 0; sfb < ics.maxSfb; sfb++, idx++) {
                const book = right.bandType[idx]!;
                if (book !== INTENSITY_HCB && book !== INTENSITY_HCB2) continue;
                let c = book === INTENSITY_HCB ? 1 : -1;
                if (msPresent) c *= 1 - 2 * element.msMask[idx]!;
                const scale = c * Math.pow(2, -0.25 * right.sf[idx]!);
                for (let w = 0; w < ics.groupLen[g]!; w++) {
                    const base = (window + w) * SHORT_LEN;
                    for (let k = offsets[sfb]!; k < offsets[sfb + 1]!; k++)
                        right.coeffs[base + k] = left.coeffs[base + k]! * scale;
                }
            }
            window += ics.groupLen[g]!;
        }
    }

    /**
     * Main profile backward-adaptive prediction (ISO/IEC 14496-3 4.6.7) in the reference's 16-bit
     * float rounding.
     */
    private applyPrediction(channel: Channel): void {
        const ics = channel.ics;
        if (!channel.predictorInitialized || !channel.predictorState) {
            channel.predictorState ??= new Float32Array(MAX_PREDICTORS * 6);
            resetPredictors(channel.predictorState, 0, 1);
            channel.predictorInitialized = true;
        }
        const state = channel.predictorState;
        if (ics.windowSequence[0] === EIGHT_SHORT) {
            resetPredictors(state, 0, 1);
            return;
        }
        const bands = PRED_SFB_MAX[this.samplingIndex]!;
        for (let sfb = 0; sfb < bands; sfb++) {
            const enable = ics.predictorPresent && ics.predictionUsed[sfb] === 1;
            for (let k = ics.swbOffset[sfb]!; k < ics.swbOffset[sfb + 1]!; k++)
                channel.coeffs[k] = predict(state, k * 6, channel.coeffs[k]!, enable);
        }
        if (ics.predictorResetGroup) resetPredictors(state, ics.predictorResetGroup - 1, 30);
    }

    private applyCoupling(target: Element, type: number, tag: number, point: number): void {
        for (const cce of this.elements[AAC_CCE]!.values()) {
            const coupling = cce.coupling;
            if (coupling.couplingPoint !== point) continue;
            let index = 0;
            for (let c = 0; c <= coupling.numCoupled; c++) {
                if (coupling.type[c] === type && coupling.idSelect[c] === tag) {
                    if (coupling.chSelect[c] !== 1) {
                        this.couple(target.ch[0], cce, index, point);
                        if (coupling.chSelect[c] !== 0) index++;
                    }
                    if (coupling.chSelect[c] !== 2) this.couple(target.ch[1], cce, index++, point);
                } else {
                    index += 1 + (coupling.chSelect[c] === 3 ? 1 : 0);
                }
            }
        }
    }

    private couple(target: Channel, cce: Element, index: number, point: number): void {
        const source = cce.ch[0];
        const gains = cce.coupling.gain[index]!;
        if (point === AFTER_IMDCT) {
            const gain = gains[0]!;
            const length = this.sbr === 1 ? 2 * this.frameLen : this.frameLen;
            for (let i = 0; i < length; i++) target.ret[i] = target.ret[i]! + gain * source.ret[i]!;
            return;
        }
        const ics = source.ics;
        const offsets = ics.swbOffset;
        let window = 0;
        for (let g = 0, idx = 0; g < ics.numWindowGroups; g++) {
            for (let sfb = 0; sfb < ics.maxSfb; sfb++, idx++) {
                if (source.bandType[idx] === ZERO_HCB) continue;
                const gain = gains[idx]!;
                for (let w = 0; w < ics.groupLen[g]!; w++) {
                    const base = (window + w) * SHORT_LEN;
                    for (let k = offsets[sfb]!; k < offsets[sfb + 1]!; k++)
                        target.coeffs[base + k] =
                            target.coeffs[base + k]! + gain * source.coeffs[base + k]!;
                }
            }
            window += ics.groupLen[g]!;
        }
    }

    /**
     * Inverse transform and overlap-add; out-of-order window transitions overlap as short to short.
     */
    private imdctAndWindow(channel: Channel): void {
        const ics = channel.ics;
        const { buf, temp } = this;
        const out = channel.ret;
        const saved = channel.saved;
        const length = this.frameLen;
        const short = length / 8;
        const half = length / 2;
        const shortHalf = short / 2;
        const lead = (length - short) / 2;
        const longWindows = windowPair(length);
        const shortWindows = windowPair(short);
        const swindow = ics.useKbWindow[0] ? shortWindows.kbd : shortWindows.sine;
        const lwindowPrev = ics.useKbWindow[1] ? longWindows.kbd : longWindows.sine;
        const swindowPrev = ics.useKbWindow[1] ? shortWindows.kbd : shortWindows.sine;
        const current = ics.windowSequence[0];
        const previous = ics.windowSequence[1];
        const transforms = (this.transforms ??=
            length === FRAME_LEN
                ? { long: new Imdct(2 * FRAME_LEN), short: new Imdct(2 * SHORT_LEN) }
                : { long: new DirectImdct(2 * length), short: new DirectImdct(length / 4) });
        if (current === EIGHT_SHORT) {
            const scale = 1 / (short * 32768);
            for (let w = 0; w < 8; w++)
                transforms.short.half(channel.coeffs, w * SHORT_LEN, buf, w * short, scale);
        } else {
            transforms.long.half(channel.coeffs, 0, buf, 0, 1 / (length * 32768));
        }
        if (
            (previous === ONLY_LONG || previous === LONG_STOP) &&
            (current === ONLY_LONG || current === LONG_START)
        ) {
            overlapWindow(out, 0, saved, 0, buf, 0, lwindowPrev, half);
        } else {
            out.set(saved.subarray(0, lead));
            overlapWindow(out, lead, saved, lead, buf, 0, swindowPrev, shortHalf);
            if (current === EIGHT_SHORT) {
                for (let w = 1; w < 4; w++)
                    overlapWindow(
                        out,
                        lead + w * short,
                        buf,
                        (w - 1) * short + shortHalf,
                        buf,
                        w * short,
                        swindow,
                        shortHalf,
                    );
                overlapWindow(
                    temp,
                    0,
                    buf,
                    3 * short + shortHalf,
                    buf,
                    4 * short,
                    swindow,
                    shortHalf,
                );
                out.set(temp.subarray(0, shortHalf), lead + 4 * short);
            } else {
                out.set(buf.subarray(shortHalf, half), lead + short);
            }
        }
        if (current === EIGHT_SHORT) {
            saved.set(temp.subarray(shortHalf, short));
            for (let w = 5; w < 8; w++)
                overlapWindow(
                    saved,
                    shortHalf + (w - 5) * short,
                    buf,
                    (w - 1) * short + shortHalf,
                    buf,
                    w * short,
                    swindow,
                    shortHalf,
                );
            saved.set(buf.subarray(7 * short + shortHalf, 8 * short), lead);
        } else if (current === LONG_START) {
            saved.set(buf.subarray(half, half + lead));
            saved.set(buf.subarray(7 * short + shortHalf, 8 * short), lead);
        } else {
            saved.set(buf.subarray(half, length));
        }
    }

    protected override spectralToSample(): void {
        for (let type = 3; type >= 0; type--) {
            const elements = [...this.elements[type]!.entries()].sort((a, b) => a[0] - b[0]);
            for (const [index, element] of elements) {
                if (!element.present) continue;
                if (type <= AAC_CPE) this.applyCoupling(element, type, index, BEFORE_TNS);
                if (element.ch[0].tns.present) this.applyTns(element.ch[0]);
                if (element.ch[1].tns.present) this.applyTns(element.ch[1]);
                if (type <= AAC_CPE)
                    this.applyCoupling(element, type, index, BETWEEN_TNS_AND_IMDCT);
                if (type !== AAC_CCE || element.coupling.couplingPoint === AFTER_IMDCT) {
                    this.imdctAndWindow(element.ch[0]);
                    if (type === AAC_CPE) this.imdctAndWindow(element.ch[1]);
                    if (this.sbr > 0) {
                        if (!this.sbrTools)
                            throw (this.sbrFailure = this.missingSbr(
                                'AAC: this stream uses SBR (HE-AAC)',
                            ));
                        element.sbr ??= this.sbrTools.createSbr(type);
                        element.sbr.apply(
                            type,
                            element.ch[0].ret,
                            element.ch[1].ret,
                            this.extensionRate,
                            this.ps === 1,
                        );
                    }
                }
                if (type <= AAC_CCE) this.applyCoupling(element, type, index, AFTER_IMDCT);
                element.present = false;
            }
        }
    }
}

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const f32 = Math.fround;

function flt16Round(value: number): number {
    F32[0] = value;
    U32[0] = (U32[0]! + 0x8000) & 0xffff0000;
    return F32[0]!;
}

function flt16Even(value: number): number {
    F32[0] = value;
    U32[0] = (U32[0]! + 0x7fff + ((U32[0]! & 0x10000) >>> 16)) & 0xffff0000;
    return F32[0]!;
}

function flt16Trunc(value: number): number {
    F32[0] = value;
    U32[0] = U32[0]! & 0xffff0000;
    return F32[0]!;
}

/** Predictor state per coefficient: r0, r1, cor0, cor1, var0, var1. */
function resetPredictors(state: Float32Array, first: number, step: number): void {
    for (let i = first; i < MAX_PREDICTORS; i += step) state.set([0, 0, 0, 0, 1, 1], i * 6);
}

function predict(state: Float32Array, at: number, coef: number, output: boolean): number {
    const a = 0.953125;
    const alpha = 0.90625;
    const r0 = state[at]!;
    const r1 = state[at + 1]!;
    const cor0 = state[at + 2]!;
    const cor1 = state[at + 3]!;
    const var0 = state[at + 4]!;
    const var1 = state[at + 5]!;
    const k1 = var0 > 1 ? f32(cor0 * flt16Even(f32(a / var0))) : 0;
    const k2 = var1 > 1 ? f32(cor1 * flt16Even(f32(a / var1))) : 0;
    const pv = flt16Round(f32(f32(k1 * r0) + f32(k2 * r1)));
    const e0 = output ? f32(coef + pv) : f32(coef);
    const e1 = f32(e0 - f32(k1 * r0));
    state[at + 3] = flt16Trunc(f32(f32(alpha * cor1) + f32(r1 * e1)));
    state[at + 5] = flt16Trunc(
        f32(f32(alpha * var1) + f32(0.5 * f32(f32(r1 * r1) + f32(e1 * e1)))),
    );
    state[at + 2] = flt16Trunc(f32(f32(alpha * cor0) + f32(r0 * e0)));
    state[at + 4] = flt16Trunc(
        f32(f32(alpha * var0) + f32(0.5 * f32(f32(r0 * r0) + f32(e0 * e0)))),
    );
    state[at + 1] = flt16Trunc(f32(a * f32(r0 - f32(k1 * e0))));
    state[at] = flt16Trunc(f32(a * e0));
    return output ? e0 : coef;
}

/** The channel configuration of each channel count AacLcDecoder takes. */
const CHANNEL_CONFIGURATIONS = [0, 1, 2, 3, 4, 5, 6, 0, 7];

/** Frames decodeAacFrames() decodes between yields to the event loop. */
const YIELD_FRAMES = 8;

/**
 * AAC-LC decoder for a known rate and channel count (indexed layout, no SBR); see AacDecoder for
 * full configs.
 */
export class AacLcDecoder extends AacDecoder {
    /**
     * Creates a decoder for 1..6 or 8 channels; channel configurations 3..7 (SCE, CPE and LFE
     * elements) are returned in WAVE speaker order, see ELEMENT_ORDER_MASKS.
     */
    constructor(sampleRate: number, channels: number) {
        const samplingIndex = AAC_SAMPLE_RATES.indexOf(sampleRate);
        if (samplingIndex < 0) throw new DecodeError(`AAC: unsupported sample rate ${sampleRate}`);
        if (
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > 8 ||
            !CHANNEL_CONFIGURATIONS[channels]
        )
            throw new DecodeError(`AAC: unsupported channel count ${channels}`);
        super({
            objectType: AOT_AAC_LC,
            samplingIndex,
            sampleRate,
            channelConfiguration: CHANNEL_CONFIGURATIONS[channels]!,
            sbr: 0,
            ps: 0,
            extensionSampleRate: 0,
        });
    }
}

/**
 * A decoder for an AudioSpecificConfig; without `sbrTools` a stream that uses SBR fails with the
 * error of `missingSbr` once it does.
 */
export function createAacDecoder(
    config: Uint8Array,
    sbrTools?: AacSbrTools,
    missingSbr?: MissingSbr,
): AacDecoder {
    return new AacDecoder(aacConfigOf(config), sbrTools, missingSbr);
}

/**
 * Decodes the raw AAC-LC frames of one stream, such as encodeAacLc() returns, yielding to the
 * event loop between frames.
 */
export async function decodeAacFrames(
    stream: AacFrames,
    options: AacDecodeOptions = {},
): Promise<DecodedAac> {
    const { frames, sampleRate, channels } = stream;
    const decoder = new AacLcDecoder(sampleRate, channels);
    const channelData: Float32Array[] = [];
    for (let c = 0; c < channels; c++)
        channelData.push(new Float32Array(frames.length * FRAME_LEN));
    let at = 0;
    for (let f = 0; f < frames.length; f++) {
        throwIfAborted(options.signal);
        const pcm = decoder.decodeFrame(frames[f]!);
        if (pcm.length !== channels)
            throw new DecodeError('AAC: frame layout differs from the configured channels');
        for (let c = 0; c < channels; c++) channelData[c]!.set(pcm[c]!, at);
        at += pcm[0]?.length ?? 0;
        options.onProgress?.(f + 1, frames.length);
        if ((f + 1) % YIELD_FRAMES === 0) await yieldEventLoop();
    }

    throwIfAborted(options.signal);
    return {
        sampleRate,
        channels,
        sampleFrames: at,
        channelData: channelData.map(plane => plane.subarray(0, at)),
    };
}
