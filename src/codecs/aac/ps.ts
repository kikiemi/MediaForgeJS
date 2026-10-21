import { MediaForgeError } from '../../core/errors/errors';
import { AacBitReader, decodeHuffman, huffmanCode } from '../../core/codec-config/audio/aac-bits';

/**
 * Parametric stereo (ISO/IEC 14496-3 section 8.6.4): a mono QMF signal, split further by the hybrid
 * filterbank, is decorrelated and mixed into two channels by the transmitted intensity, coherence
 * and phase parameters. Both the 20-band and the 34-band configurations and IPD/OPD are decoded.
 */

const MAX_NUM_ENV = 5;
const MAX_PAR = 34;
const SLOTS = 32;
const MAX_DELAY = 14;
const AP_LINKS = 3;
const MAX_AP_DELAY = 5;
const DELAY_LEN = SLOTS + MAX_DELAY;
const AP_LEN = SLOTS + MAX_AP_DELAY;

const NR_PAR_BANDS = [20, 34];
const NR_IPDOPD_BANDS = [11, 17];
const NR_BANDS = [71, 91];
const DECAY_CUTOFF = [10, 32];
const NR_ALLPASS_BANDS = [30, 50];
const SHORT_DELAY_BAND = [42, 62];
const NUM_ENV_TAB = [
    [0, 1, 2, 4],
    [1, 2, 3, 4],
];
const NR_IIDICC_PAR = [10, 20, 34, 10, 20, 34];
const NR_IPDOPD_PAR = [5, 11, 17, 5, 11, 17];

// Huffman tables of ISO/IEC 14496-3 table 8.B.1 in the order iid_df1, iid_dt1, iid_df0, iid_dt0,
// icc_df, icc_dt, ipd_df, ipd_dt, opd_df, opd_dt.
const HUFF_BITS: readonly (readonly number[])[] = [
    [
        18, 18, 18, 18, 18, 18, 18, 18, 18, 17, 18, 17, 17, 16, 16, 15, 14, 14, 13, 12, 12, 11, 10,
        10, 8, 7, 6, 5, 4, 3, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 12, 13, 14, 14, 15, 16, 16, 17,
        17, 18, 17, 18, 18, 18, 18, 18, 18, 18, 18, 18,
    ],
    [
        16, 16, 16, 16, 16, 16, 16, 16, 16, 15, 15, 15, 15, 15, 15, 14, 14, 13, 13, 13, 12, 12, 11,
        10, 9, 9, 7, 6, 5, 3, 1, 2, 5, 6, 7, 8, 9, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15,
        15, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
    ],
    [
        17, 17, 17, 17, 16, 15, 13, 10, 9, 7, 6, 5, 4, 3, 1, 3, 4, 5, 6, 6, 8, 11, 13, 14, 14, 15,
        17, 18, 18,
    ],
    [
        19, 19, 19, 20, 20, 20, 17, 15, 12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13, 14, 17, 19, 20,
        20, 20, 20, 20,
    ],
    [14, 14, 12, 10, 7, 5, 3, 1, 2, 4, 6, 8, 9, 11, 13],
    [14, 13, 11, 9, 7, 5, 3, 1, 2, 4, 6, 8, 10, 12, 14],
    [1, 3, 4, 4, 4, 4, 4, 4],
    [1, 3, 4, 5, 5, 4, 4, 3],
    [1, 3, 4, 4, 5, 5, 4, 3],
    [1, 3, 4, 5, 5, 4, 4, 3],
];
const HUFF_CODES: readonly (readonly number[])[] = [
    [
        0x1feb4, 0x1feb5, 0x1fd76, 0x1fd77, 0x1fd74, 0x1fd75, 0x1fe8a, 0x1fe8b, 0x1fe88, 0xfe80,
        0x1feb6, 0xfe82, 0xfeb8, 0x7f42, 0x7fae, 0x3faf, 0x1fd1, 0x1fe9, 0xfe9, 0x7ea, 0x7fb, 0x3fb,
        0x1fb, 0x1ff, 0x7c, 0x3c, 0x1c, 0xc, 0x0, 0x1, 0x1, 0x2, 0x1, 0xd, 0x1d, 0x3d, 0x7d, 0xfc,
        0x1fc, 0x3fc, 0x3f4, 0x7eb, 0xfea, 0x1fea, 0x1fd6, 0x3fd0, 0x7faf, 0x7f43, 0xfeb9, 0xfe83,
        0x1feb7, 0xfe81, 0x1fe89, 0x1fe8e, 0x1fe8f, 0x1fe8c, 0x1fe8d, 0x1feb2, 0x1feb3, 0x1feb0,
        0x1feb1,
    ],
    [
        0x4ed4, 0x4ed5, 0x4ece, 0x4ecf, 0x4ecc, 0x4ed6, 0x4ed8, 0x4f46, 0x4f60, 0x2718, 0x2719,
        0x2764, 0x2765, 0x276d, 0x27b1, 0x13b7, 0x13d6, 0x9c7, 0x9e9, 0x9ed, 0x4ee, 0x4f7, 0x278,
        0x139, 0x9a, 0x9f, 0x20, 0x11, 0xa, 0x3, 0x1, 0x0, 0xb, 0x12, 0x21, 0x4c, 0x9b, 0x13a,
        0x279, 0x270, 0x4ef, 0x4e2, 0x9ea, 0x9d8, 0x13d7, 0x13d0, 0x27b2, 0x27a2, 0x271a, 0x271b,
        0x4f66, 0x4f67, 0x4f61, 0x4f47, 0x4ed9, 0x4ed7, 0x4ecd, 0x4ed2, 0x4ed3, 0x4ed0, 0x4ed1,
    ],
    [
        0x1fffb, 0x1fffc, 0x1fffd, 0x1fffa, 0xfffc, 0x7ffc, 0x1ffd, 0x3fe, 0x1fe, 0x7e, 0x3c, 0x1d,
        0xd, 0x5, 0x0, 0x4, 0xc, 0x1c, 0x3d, 0x3e, 0xfe, 0x7fe, 0x1ffc, 0x3ffc, 0x3ffd, 0x7ffd,
        0x1fffe, 0x3fffe, 0x3ffff,
    ],
    [
        0x7fff9, 0x7fffa, 0x7fffb, 0xffff8, 0xffff9, 0xffffa, 0x1fffd, 0x7ffe, 0xffe, 0x3fe, 0xfe,
        0x3e, 0xe, 0x2, 0x0, 0x6, 0x1e, 0x7e, 0x1fe, 0x7fe, 0x1ffe, 0x3ffe, 0x1fffc, 0x7fff8,
        0xffffb, 0xffffc, 0xffffd, 0xffffe, 0xfffff,
    ],
    [
        0x3fff, 0x3ffe, 0xffe, 0x3fe, 0x7e, 0x1e, 0x6, 0x0, 0x2, 0xe, 0x3e, 0xfe, 0x1fe, 0x7fe,
        0x1ffe,
    ],
    [
        0x3ffe, 0x1ffe, 0x7fe, 0x1fe, 0x7e, 0x1e, 0x6, 0x0, 0x2, 0xe, 0x3e, 0xfe, 0x3fe, 0xffe,
        0x3fff,
    ],
    [0x01, 0x00, 0x06, 0x04, 0x02, 0x03, 0x05, 0x07],
    [0x01, 0x02, 0x02, 0x03, 0x02, 0x00, 0x03, 0x03],
    [0x01, 0x01, 0x06, 0x04, 0x0f, 0x0e, 0x05, 0x00],
    [0x01, 0x02, 0x01, 0x07, 0x06, 0x00, 0x02, 0x03],
];
const HUFF_OFFSET = [30, 30, 14, 14, 7, 7, 0, 0, 0, 0];
const HUFF_TREES = HUFF_CODES.map((codes, index) => huffmanCode(codes, HUFF_BITS[index]!));
const IID_DF1 = 0;
const IID_DT1 = 1;
const IID_DF0 = 2;
const IID_DT0 = 3;
const ICC_DF = 4;
const ICC_DT = 5;
const IPD_DF = 6;
const IPD_DT = 7;
const OPD_DF = 8;
const OPD_DT = 9;
const HUFF_IID = [IID_DF0, IID_DF1, IID_DT0, IID_DT1];

/** Parameter band of each hybrid band (tables 8.48 and 8.49). */
const K_TO_I = [
    [
        1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 14, 15, 15, 15, 16, 16, 16, 16, 17,
        17, 17, 17, 17, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 19, 19, 19, 19, 19, 19, 19,
        19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19,
    ],
    [
        0, 1, 2, 3, 4, 5, 6, 6, 7, 2, 1, 0, 10, 10, 4, 5, 6, 7, 8, 9, 10, 11, 12, 9, 14, 11, 12, 13,
        14, 15, 16, 13, 16, 17, 18, 19, 20, 21, 22, 22, 23, 23, 24, 24, 25, 25, 26, 26, 27, 27, 27,
        28, 28, 28, 29, 29, 29, 30, 30, 30, 31, 31, 31, 31, 32, 32, 32, 32, 33, 33, 33, 33, 33, 33,
        33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33,
    ],
];

const f32 = Math.fround;

/**
 * Tables derived as in ISO/IEC 14496-3 8.6.4.5-8.6.4.6, in single precision like the reference
 * decoders.
 */
const TABLES = (() => {
    const ipdopdSin = [0, Math.SQRT1_2, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2];
    const ipdopdCos = [1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2];
    const pdReSmooth = new Float64Array(512);
    const pdImSmooth = new Float64Array(512);
    for (let pd0 = 0; pd0 < 8; pd0++)
        for (let pd1 = 0; pd1 < 8; pd1++)
            for (let pd2 = 0; pd2 < 8; pd2++) {
                const re = f32(
                    f32(0.25 * f32(ipdopdCos[pd0]!)) +
                        f32(0.5 * f32(ipdopdCos[pd1]!)) +
                        f32(ipdopdCos[pd2]!),
                );
                const im = f32(
                    f32(0.25 * f32(ipdopdSin[pd0]!)) +
                        f32(0.5 * f32(ipdopdSin[pd1]!)) +
                        f32(ipdopdSin[pd2]!),
                );
                const mag = f32(1 / Math.hypot(im, re));
                pdReSmooth[pd0 * 64 + pd1 * 8 + pd2] = f32(re * mag);
                pdImSmooth[pd0 * 64 + pd1 * 8 + pd2] = f32(im * mag);
            }
    const iidDequant = [
        0.05623413251903, 0.12589254117942, 0.19952623149689, 0.31622776601684, 0.44668359215096,
        0.63095734448019, 0.79432823472428, 1, 1.25892541179417, 1.58489319246111, 2.23872113856834,
        3.16227766016838, 5.01187233627272, 7.94328234724282, 17.7827941003892, 0.00316227766017,
        0.0056234132519, 0.01, 0.01778279410039, 0.03162277660168, 0.05623413251903,
        0.07943282347243, 0.1122018454302, 0.15848931924611, 0.22387211385683, 0.31622776601684,
        0.3981071705535, 0.50118723362727, 0.63095734448019, 0.79432823472428, 1, 1.25892541179417,
        1.58489319246111, 1.99526231496888, 2.51188643150958, 3.16227766016838, 4.46683592150963,
        6.30957344480193, 8.91250938133745, 12.5892541179417, 17.7827941003892, 31.6227766016838,
        56.2341325190349, 100, 177.827941003892, 316.227766016837,
    ];
    const iccInvq = [1, 0.937, 0.84118, 0.60092, 0.36764, 0, -0.589, -1];
    const acosIccInvq = [
        0,
        0.35685527,
        0.57133466,
        0.92614472,
        1.1943263,
        Math.PI / 2,
        2.2006171,
        Math.PI,
    ];
    const ha = new Float64Array(46 * 8 * 4);
    const hb = new Float64Array(46 * 8 * 4);
    for (let iid = 0; iid < 46; iid++) {
        const c = f32(iidDequant[iid]!);
        const c1 = f32(f32(Math.SQRT2) / f32(Math.sqrt(f32(1 + f32(c * c)))));
        const c2 = f32(c * c1);
        for (let icc = 0; icc < 8; icc++) {
            const at = (iid * 8 + icc) * 4;
            const alpha = f32(0.5 * f32(acosIccInvq[icc]!));
            const beta = f32(f32(alpha * f32(c1 - c2)) * f32(Math.SQRT1_2));
            ha[at] = f32(c2 * f32(Math.cos(f32(beta + alpha))));
            ha[at + 1] = f32(c1 * f32(Math.cos(f32(beta - alpha))));
            ha[at + 2] = f32(c2 * f32(Math.sin(f32(beta + alpha))));
            ha[at + 3] = f32(c1 * f32(Math.sin(f32(beta - alpha))));
            const rho = f32(Math.max(f32(iccInvq[icc]!), f32(0.05)));
            let a = f32(0.5 * f32(Math.atan2(f32(f32(2 * c) * rho), f32(f32(c * c) - 1))));
            let mu = f32(c + f32(1 / c));
            mu = f32(Math.sqrt(f32(1 + f32(f32(f32(f32(4 * rho) * rho) - 4) / f32(mu * mu)))));
            const gamma = f32(Math.atan(f32(Math.sqrt(f32(f32(1 - mu) / f32(1 + mu))))));
            if (a < 0) a = f32(a + Math.PI / 2);
            const ac = f32(Math.cos(a));
            const as = f32(Math.sin(a));
            const gc = f32(Math.cos(gamma));
            const gs = f32(Math.sin(gamma));
            hb[at] = f32(Math.SQRT2 * ac * gc);
            hb[at + 1] = f32(Math.SQRT2 * as * gc);
            hb[at + 2] = f32(-Math.SQRT2 * as * gs);
            hb[at + 3] = f32(Math.SQRT2 * ac * gs);
        }
    }
    const fCenter20 = [-3, -1, 1, 3, 5, 7, 10, 14, 18, 22];
    const fCenter34 = [
        2, 6, 10, 14, 18, 22, 26, 30, 34, -10, -6, -2, 51, 57, 15, 21, 27, 33, 39, 45, 54, 66, 78,
        42, 102, 66, 78, 90, 102, 114, 126, 90,
    ];
    const links = [f32(0.43), f32(0.75), f32(0.347)];
    const delayGain = f32(0.39);
    /** [is34][band][link] complex, [is34][band] complex. */
    const qFract = [new Float64Array(50 * AP_LINKS * 2), new Float64Array(50 * AP_LINKS * 2)];
    const phiFract = [new Float64Array(50 * 2), new Float64Array(50 * 2)];
    for (let is34 = 0; is34 < 2; is34++) {
        for (let k = 0; k < NR_ALLPASS_BANDS[is34]!; k++) {
            const center = is34
                ? k < fCenter34.length
                    ? fCenter34[k]! / 24
                    : k - 26.5
                : k < fCenter20.length
                  ? fCenter20[k]! * 0.125
                  : k - 6.5;
            for (let m = 0; m < AP_LINKS; m++) {
                const theta = -Math.PI * links[m]! * center;
                qFract[is34]![(k * AP_LINKS + m) * 2] = f32(Math.cos(theta));
                qFract[is34]![(k * AP_LINKS + m) * 2 + 1] = f32(Math.sin(theta));
            }
            const theta = -Math.PI * delayGain * center;
            phiFract[is34]![k * 2] = f32(Math.cos(theta));
            phiFract[is34]![k * 2 + 1] = f32(Math.sin(theta));
        }
    }
    /** Complex hybrid filters [q][n], n < 8, from a real prototype. */
    const filters = (proto: readonly number[], bands: number): Float64Array => {
        const out = new Float64Array(bands * 8 * 2);
        for (let q = 0; q < bands; q++)
            for (let n = 0; n < 7; n++) {
                const theta = (2 * Math.PI * (q + 0.5) * (n - 6)) / bands;
                out[(q * 8 + n) * 2] = f32(f32(proto[n]!) * Math.cos(theta));
                out[(q * 8 + n) * 2 + 1] = f32(f32(proto[n]!) * -Math.sin(theta));
            }
        return out;
    };
    const g0Q8 = [
        0.00746082949812, 0.02270420949825, 0.04546865930473, 0.07266113929591, 0.09885108575264,
        0.11793710567217, 0.125,
    ];
    const g0Q12 = [
        0.04081179924692, 0.03812810994926, 0.05144908135699, 0.06399831151592, 0.07428313801106,
        0.08100347892914, 0.08333333333333,
    ];
    const g1Q8 = [
        0.01565675600122, 0.03752716391991, 0.05417891378782, 0.08417044116767, 0.10307344158036,
        0.12222452249753, 0.125,
    ];
    const g2Q4 = [
        -0.05908211155639, -0.04871498374946, 0.0, 0.07778723915851, 0.16486303567403,
        0.23279856662996, 0.25,
    ];
    return {
        pdReSmooth,
        pdImSmooth,
        ha,
        hb,
        qFract,
        phiFract,
        f20: filters(g0Q8, 8),
        f34_12: filters(g0Q12, 12),
        f34_8: filters(g1Q8, 8),
        f34_4: filters(g2Q4, 4),
    };
})();
const G1_Q2 = [0, 0.01899487526049, 0, -0.07293139167538, 0, 0.30596630545168, 0.5].map(f32);
const ALLPASS_A = [0.65143905753106, 0.56471812200776, 0.48954165955695].map(f32);

class PsError extends Error {}

/** Parameter arrays [envelope][band] of 34 bands. */
function parArray(): Int8Array {
    return new Int8Array(MAX_NUM_ENV * MAX_PAR);
}

export class AacParametricStereo {
    /** True once a PS header has been read. */
    started = false;
    private enableIid = 0;
    private iidQuant = 0;
    private nrIidPar = 0;
    private nrIpdopdPar = 0;
    private enableIcc = 0;
    private iccMode = 0;
    private nrIccPar = 0;
    private enableExt = 0;
    private frameClass = 0;
    private numEnvOld = 0;
    private numEnv = 0;
    private enableIpdopd = 0;
    private readonly borderPosition = new Int32Array(MAX_NUM_ENV + 1);
    private readonly iidPar = parArray();
    private readonly iccPar = parArray();
    private readonly ipdPar = parArray();
    private readonly opdPar = parArray();
    private is34 = 0;
    private is34Old = 0;

    private readonly inRe = new Float64Array(5 * 44);
    private readonly inIm = new Float64Array(5 * 44);
    private readonly delayRe = new Float64Array(91 * DELAY_LEN);
    private readonly delayIm = new Float64Array(91 * DELAY_LEN);
    private readonly apRe = new Float64Array(50 * AP_LINKS * AP_LEN);
    private readonly apIm = new Float64Array(50 * AP_LINKS * AP_LEN);
    private readonly peakDecayNrg = new Float64Array(34);
    private readonly powerSmooth = new Float64Array(34);
    private readonly peakDecayDiffSmooth = new Float64Array(34);
    /** H11, H12, H21, H22: [real/imaginary][envelope 6][band 34]. */
    private readonly h = [0, 1, 2, 3].map(() => new Float64Array(2 * (MAX_NUM_ENV + 1) * MAX_PAR));
    private readonly lRe = new Float64Array(91 * SLOTS);
    private readonly lIm = new Float64Array(91 * SLOTS);
    private readonly rRe = new Float64Array(91 * SLOTS);
    private readonly rIm = new Float64Array(91 * SLOTS);
    private readonly opdHist = new Int8Array(MAX_PAR);
    private readonly ipdHist = new Int8Array(MAX_PAR);

    /**
     * ps_data() of at most `bitsLeft` bits; returns the bits consumed (all of them on invalid
     * data).
     */
    read(reader: AacBitReader, bitsLeft: number): number {
        const start = reader.bitsRead();
        try {
            const header = this.readData(reader);
            const consumed = reader.bitsRead() - start;
            if (consumed <= bitsLeft) {
                if (header) this.started = true;
                return consumed;
            }
        } catch (error) {
            if (!(error instanceof PsError || error instanceof MediaForgeError)) throw error;
        }
        this.started = false;
        reader.seek(start);
        reader.skip(bitsLeft);
        this.iidPar.fill(0);
        this.iccPar.fill(0);
        this.ipdPar.fill(0);
        this.opdPar.fill(0);
        return bitsLeft;
    }

    private readPar(
        reader: AacBitReader,
        par: Int8Array,
        table: number,
        e: number,
        dt: number,
        count: number,
        mask: number,
        check: (value: number) => boolean,
    ): void {
        const tree = HUFF_TREES[table]!;
        const offset = HUFF_OFFSET[table]!;
        if (dt) {
            const previous = Math.max(e ? e - 1 : this.numEnvOld - 1, 0);
            for (let b = 0; b < count; b++) {
                let value = par[previous * MAX_PAR + b]! + decodeHuffman(reader, tree) - offset;
                if (mask) value &= mask;
                par[e * MAX_PAR + b] = value;
                if (check(par[e * MAX_PAR + b]!))
                    throw new PsError('illegal parametric stereo parameter');
            }
        } else {
            let value = 0;
            for (let b = 0; b < count; b++) {
                value += decodeHuffman(reader, tree) - offset;
                if (mask) value &= mask;
                par[e * MAX_PAR + b] = value;
                if (check(par[e * MAX_PAR + b]!))
                    throw new PsError('illegal parametric stereo parameter');
            }
        }
    }

    private readData(reader: AacBitReader): boolean {
        const header = reader.readBit() === 1;
        if (header) {
            this.enableIid = reader.readBit();
            if (this.enableIid) {
                const mode = reader.read(3);
                if (mode > 5) throw new PsError(`iid_mode ${mode} is reserved`);
                this.nrIidPar = NR_IIDICC_PAR[mode]!;
                this.iidQuant = mode > 2 ? 1 : 0;
                this.nrIpdopdPar = NR_IPDOPD_PAR[mode]!;
            }
            this.enableIcc = reader.readBit();
            if (this.enableIcc) {
                this.iccMode = reader.read(3);
                if (this.iccMode > 5) throw new PsError(`icc_mode ${this.iccMode} is reserved`);
                this.nrIccPar = NR_IIDICC_PAR[this.iccMode]!;
            }
            this.enableExt = reader.readBit();
        }
        this.frameClass = reader.readBit();
        this.numEnvOld = this.numEnv;
        this.numEnv = NUM_ENV_TAB[this.frameClass]![reader.read(2)]!;
        this.borderPosition[0] = -1;
        if (this.frameClass) {
            for (let e = 1; e <= this.numEnv; e++) {
                this.borderPosition[e] = reader.read(5);
                if (this.borderPosition[e]! < this.borderPosition[e - 1]!)
                    throw new PsError('border positions are not monotone');
            }
        } else {
            const log2 = [0, 0, 1, 1, 2][this.numEnv]!;
            for (let e = 1; e <= this.numEnv; e++)
                this.borderPosition[e] = ((e * SLOTS) >> log2) - 1;
        }
        const iidLimit = 7 + 8 * this.iidQuant;
        if (this.enableIid) {
            for (let e = 0; e < this.numEnv; e++) {
                const dt = reader.readBit();
                this.readPar(
                    reader,
                    this.iidPar,
                    HUFF_IID[2 * dt + this.iidQuant]!,
                    e,
                    dt,
                    this.nrIidPar,
                    0,
                    v => Math.abs(v) > iidLimit,
                );
            }
        } else {
            this.iidPar.fill(0);
        }
        if (this.enableIcc) {
            for (let e = 0; e < this.numEnv; e++) {
                const dt = reader.readBit();
                this.readPar(
                    reader,
                    this.iccPar,
                    dt ? ICC_DT : ICC_DF,
                    e,
                    dt,
                    this.nrIccPar,
                    0,
                    v => v < 0 || v > 7,
                );
            }
        } else {
            this.iccPar.fill(0);
        }
        if (this.enableExt) {
            let count = reader.read(4);
            if (count === 15) count += reader.read(8);
            count *= 8;
            while (count > 7) {
                const id = reader.read(2);
                const from = reader.bitsRead();
                if (!id) {
                    this.enableIpdopd = reader.readBit();
                    if (this.enableIpdopd) {
                        for (let e = 0; e < this.numEnv; e++) {
                            let dt = reader.readBit();
                            this.readPar(
                                reader,
                                this.ipdPar,
                                dt ? IPD_DT : IPD_DF,
                                e,
                                dt,
                                this.nrIpdopdPar,
                                7,
                                () => false,
                            );
                            dt = reader.readBit();
                            this.readPar(
                                reader,
                                this.opdPar,
                                dt ? OPD_DT : OPD_DF,
                                e,
                                dt,
                                this.nrIpdopdPar,
                                7,
                                () => false,
                            );
                        }
                    }
                    reader.skip(1);
                }
                count -= 2 + (reader.bitsRead() - from);
            }
            if (count < 0) throw new PsError('parametric stereo extension overflow');
            reader.skip(count);
        }
        if (!this.numEnv || this.borderPosition[this.numEnv]! < SLOTS - 1) {
            const source = this.numEnv ? this.numEnv - 1 : this.numEnvOld - 1;
            if (source >= 0 && source !== this.numEnv) {
                const copy = (par: Int8Array): void => {
                    par.copyWithin(
                        this.numEnv * MAX_PAR,
                        source * MAX_PAR,
                        source * MAX_PAR + MAX_PAR,
                    );
                };
                if (this.enableIid) copy(this.iidPar);
                if (this.enableIcc) copy(this.iccPar);
                if (this.enableIpdopd) {
                    copy(this.ipdPar);
                    copy(this.opdPar);
                }
            }
            if (this.enableIid)
                for (let b = 0; b < this.nrIidPar; b++)
                    if (Math.abs(this.iidPar[this.numEnv * MAX_PAR + b]!) > iidLimit)
                        throw new PsError('iid_par invalid');
            if (this.enableIcc)
                for (let b = 0; b < this.nrIidPar; b++) {
                    const value = this.iccPar[this.numEnv * MAX_PAR + b]!;
                    if (value < 0 || value > 7) throw new PsError('icc_par invalid');
                }
            this.numEnv++;
            this.borderPosition[this.numEnv] = SLOTS - 1;
        }
        this.is34Old = this.is34;
        if (this.enableIid || this.enableIcc)
            this.is34 =
                (this.enableIid && this.nrIidPar === 34) || (this.enableIcc && this.nrIccPar === 34)
                    ? 1
                    : 0;
        if (!this.enableIpdopd) {
            this.ipdPar.fill(0);
            this.opdPar.fill(0);
        }
        return header;
    }

    /**
     * Hybrid analysis of the lowest QMF bands (8.6.4.3) into L; the other QMF bands pass through.
     */
    private hybridAnalysis(xRe: Float64Array, xIm: Float64Array): void {
        const is34 = this.is34;
        const inRe = this.inRe;
        const inIm = this.inIm;
        for (let i = 0; i < 5; i++)
            for (let j = 0; j < 38; j++) {
                inRe[i * 44 + j + 6] = xRe[j * 64 + i]!;
                inIm[i * 44 + j + 6] = xIm[j * 64 + i]!;
            }
        const outRe = this.lRe;
        const outIm = this.lIm;
        const temp = new Float64Array(24);
        /** Slot n of QMF band `band` through a complex hybrid filterbank of `bands` filters. */
        const complexFilter = (
            band: number,
            filter: Float64Array,
            bands: number,
            n: number,
            store: (q: number, re: number, im: number) => void,
        ): void => {
            const base = band * 44 + n;
            for (let q = 0; q < bands; q++) {
                const f = q * 16;
                let sumRe = filter[f + 12]! * inRe[base + 6]!;
                let sumIm = filter[f + 12]! * inIm[base + 6]!;
                for (let j = 0; j < 6; j++) {
                    const re0 = inRe[base + j]! + inRe[base + 12 - j]!;
                    const re1 = inIm[base + j]! - inIm[base + 12 - j]!;
                    const im0 = inIm[base + j]! + inIm[base + 12 - j]!;
                    const im1 = inRe[base + j]! - inRe[base + 12 - j]!;
                    sumRe += filter[f + 2 * j]! * re0 - filter[f + 2 * j + 1]! * re1;
                    sumIm += filter[f + 2 * j]! * im0 + filter[f + 2 * j + 1]! * im1;
                }
                store(q, sumRe, sumIm);
            }
        };
        for (let n = 0; n < SLOTS; n++) {
            if (is34) {
                const groups: [number, Float64Array, number, number][] = [
                    [0, TABLES.f34_12, 12, 0],
                    [1, TABLES.f34_8, 8, 12],
                    [2, TABLES.f34_4, 4, 20],
                    [3, TABLES.f34_4, 4, 24],
                    [4, TABLES.f34_4, 4, 28],
                ];
                for (const [band, filter, bands, first] of groups)
                    complexFilter(band, filter, bands, n, (q, re, im) => {
                        outRe[(first + q) * SLOTS + n] = re;
                        outIm[(first + q) * SLOTS + n] = im;
                    });
            } else {
                complexFilter(0, TABLES.f20, 8, n, (q, re, im) => {
                    temp[2 * q] = re;
                    temp[2 * q + 1] = im;
                });
                const put = (band: number, re: number, im: number): void => {
                    outRe[band * SLOTS + n] = re;
                    outIm[band * SLOTS + n] = im;
                };
                put(0, temp[12]!, temp[13]!);
                put(1, temp[14]!, temp[15]!);
                put(2, temp[0]!, temp[1]!);
                put(3, temp[2]!, temp[3]!);
                put(4, temp[4]! + temp[10]!, temp[5]! + temp[11]!);
                put(5, temp[6]! + temp[8]!, temp[7]! + temp[9]!);
                for (const [band, first, reverse] of [
                    [1, 6, 1],
                    [2, 8, 0],
                ] as const) {
                    const base = band * 44 + n;
                    const reIn = G1_Q2[6]! * inRe[base + 6]!;
                    const imIn = G1_Q2[6]! * inIm[base + 6]!;
                    let reOp = 0;
                    let imOp = 0;
                    for (let j = 0; j < 6; j += 2) {
                        reOp += G1_Q2[j + 1]! * (inRe[base + j + 1]! + inRe[base + 12 - j - 1]!);
                        imOp += G1_Q2[j + 1]! * (inIm[base + j + 1]! + inIm[base + 12 - j - 1]!);
                    }
                    put(first + reverse, reIn + reOp, imIn + imOp);
                    put(first + 1 - reverse, reIn - reOp, imIn - imOp);
                }
            }
        }
        const firstQmf = is34 ? 5 : 3;
        const offset = is34 ? 27 : 7;
        for (let i = firstQmf; i < 64; i++)
            for (let j = 0; j < SLOTS; j++) {
                outRe[(offset + i) * SLOTS + j] = xRe[j * 64 + i]!;
                outIm[(offset + i) * SLOTS + j] = xIm[j * 64 + i]!;
            }
        for (let i = 0; i < 5; i++) {
            inRe.copyWithin(i * 44, i * 44 + 32, i * 44 + 38);
            inIm.copyWithin(i * 44, i * 44 + 32, i * 44 + 38);
        }
    }

    /** Hybrid synthesis of hybrid bands `re`/`im` back into the QMF slots of X (8.6.4.8). */
    private hybridSynthesis(
        xRe: Float64Array,
        xIm: Float64Array,
        re: Float64Array,
        im: Float64Array,
    ): void {
        const is34 = this.is34;
        const sum = (first: number, count: number, n: number, source: Float64Array): number => {
            let value = 0;
            for (let i = 0; i < count; i++) value += source[(first + i) * SLOTS + n]!;
            return value;
        };
        for (let n = 0; n < SLOTS; n++) {
            const row = n * 64;
            if (is34) {
                const groups: [number, number, number][] = [
                    [0, 0, 12],
                    [1, 12, 8],
                    [2, 20, 4],
                    [3, 24, 4],
                    [4, 28, 4],
                ];
                for (const [qmf, first, count] of groups) {
                    xRe[row + qmf] = sum(first, count, n, re);
                    xIm[row + qmf] = sum(first, count, n, im);
                }
            } else {
                xRe[row] = sum(0, 6, n, re);
                xIm[row] = sum(0, 6, n, im);
                xRe[row + 1] = sum(6, 2, n, re);
                xIm[row + 1] = sum(6, 2, n, im);
                xRe[row + 2] = sum(8, 2, n, re);
                xIm[row + 2] = sum(8, 2, n, im);
            }
        }
        const firstQmf = is34 ? 5 : 3;
        const offset = is34 ? 27 : 7;
        for (let i = firstQmf; i < 64; i++)
            for (let n = 0; n < SLOTS; n++) {
                xRe[n * 64 + i] = re[(offset + i) * SLOTS + n]!;
                xIm[n * 64 + i] = im[(offset + i) * SLOTS + n]!;
            }
    }

    /** Decorrelated signal R from L: all-pass chain for low bands, plain delays above (8.6.4.5). */
    private decorrelation(): void {
        const is34 = this.is34;
        const kToI = K_TO_I[is34]!;
        const power = new Float64Array(34 * SLOTS);
        const transientGain = new Float64Array(34 * SLOTS);
        const sRe = this.lRe;
        const sIm = this.lIm;
        if (is34 !== this.is34Old) {
            this.peakDecayNrg.fill(0);
            this.powerSmooth.fill(0);
            this.peakDecayDiffSmooth.fill(0);
            this.delayRe.fill(0);
            this.delayIm.fill(0);
            this.apRe.fill(0);
            this.apIm.fill(0);
        }
        for (let k = 0; k < NR_BANDS[is34]!; k++) {
            const i = kToI[k]!;
            for (let n = 0; n < SLOTS; n++)
                power[i * SLOTS + n]! += sRe[k * SLOTS + n]! ** 2 + sIm[k * SLOTS + n]! ** 2;
        }
        const peakDecayFactor = f32(0.76592833836465);
        for (let i = 0; i < NR_PAR_BANDS[is34]!; i++) {
            for (let n = 0; n < SLOTS; n++) {
                const p = power[i * SLOTS + n]!;
                this.peakDecayNrg[i] = Math.max(peakDecayFactor * this.peakDecayNrg[i]!, p);
                this.powerSmooth[i]! += 0.25 * (p - this.powerSmooth[i]!);
                this.peakDecayDiffSmooth[i]! +=
                    0.25 * (this.peakDecayNrg[i]! - p - this.peakDecayDiffSmooth[i]!);
                const denom = 1.5 * this.peakDecayDiffSmooth[i]!;
                transientGain[i * SLOTS + n] =
                    denom > this.powerSmooth[i]! ? this.powerSmooth[i]! / denom : 1;
            }
        }
        const qFract = TABLES.qFract[is34]!;
        const phiFract = TABLES.phiFract[is34]!;
        const shift = (k: number): void => {
            const at = k * DELAY_LEN;
            this.delayRe.copyWithin(at, at + SLOTS, at + SLOTS + MAX_DELAY);
            this.delayIm.copyWithin(at, at + SLOTS, at + SLOTS + MAX_DELAY);
            this.delayRe.set(sRe.subarray(k * SLOTS, k * SLOTS + SLOTS), at + MAX_DELAY);
            this.delayIm.set(sIm.subarray(k * SLOTS, k * SLOTS + SLOTS), at + MAX_DELAY);
        };
        let k = 0;
        for (; k < NR_ALLPASS_BANDS[is34]!; k++) {
            const b = kToI[k]!;
            const slope = Math.min(1, Math.max(0, f32(1 - f32(0.05 * (k - DECAY_CUTOFF[is34]!)))));
            shift(k);
            for (let m = 0; m < AP_LINKS; m++) {
                const at = (k * AP_LINKS + m) * AP_LEN;
                this.apRe.copyWithin(at, at + SLOTS, at + SLOTS + MAX_AP_DELAY);
                this.apIm.copyWithin(at, at + SLOTS, at + SLOTS + MAX_AP_DELAY);
            }
            const ag = ALLPASS_A.map(a => a * slope);
            const pfRe = phiFract[k * 2]!;
            const pfIm = phiFract[k * 2 + 1]!;
            const delayAt = k * DELAY_LEN + MAX_DELAY - 2;
            for (let n = 0; n < SLOTS; n++) {
                const dRe = this.delayRe[delayAt + n]!;
                const dIm = this.delayIm[delayAt + n]!;
                let inRe = dRe * pfRe - dIm * pfIm;
                let inIm = dRe * pfIm + dIm * pfRe;
                for (let m = 0; m < AP_LINKS; m++) {
                    const at = (k * AP_LINKS + m) * AP_LEN;
                    const aRe = ag[m]! * inRe;
                    const aIm = ag[m]! * inIm;
                    const linkRe = this.apRe[at + n + 2 - m]!;
                    const linkIm = this.apIm[at + n + 2 - m]!;
                    const fRe = qFract[(k * AP_LINKS + m) * 2]!;
                    const fIm = qFract[(k * AP_LINKS + m) * 2 + 1]!;
                    const apdRe = inRe;
                    const apdIm = inIm;
                    inRe = linkRe * fRe - linkIm * fIm - aRe;
                    inIm = linkRe * fIm + linkIm * fRe - aIm;
                    this.apRe[at + n + 5] = apdRe + ag[m]! * inRe;
                    this.apIm[at + n + 5] = apdIm + ag[m]! * inIm;
                }
                const gain = transientGain[b * SLOTS + n]!;
                this.rRe[k * SLOTS + n] = gain * inRe;
                this.rIm[k * SLOTS + n] = gain * inIm;
            }
        }
        for (; k < NR_BANDS[is34]!; k++) {
            const i = kToI[k]!;
            shift(k);
            const delay = k < SHORT_DELAY_BAND[is34]! ? 14 : 1;
            const at = k * DELAY_LEN + MAX_DELAY - delay;
            for (let n = 0; n < SLOTS; n++) {
                const gain = transientGain[i * SLOTS + n]!;
                this.rRe[k * SLOTS + n] = this.delayRe[at + n]! * gain;
                this.rIm[k * SLOTS + n] = this.delayIm[at + n]! * gain;
            }
        }
    }

    /**
     * Mixing matrices per envelope and parameter band, interpolated over the slots
     * (8.6.4.6-8.6.4.7).
     */
    private stereoProcessing(): void {
        const is34 = this.is34;
        const kToI = K_TO_I[is34]!;
        const [h11, h12, h21, h22] = this.h as [
            Float64Array,
            Float64Array,
            Float64Array,
            Float64Array,
        ];
        const stride = (MAX_NUM_ENV + 1) * MAX_PAR;
        const lut = this.iccMode < 3 ? TABLES.ha : TABLES.hb;
        if (this.numEnvOld) {
            for (const matrix of this.h)
                for (let part = 0; part < 2; part++)
                    matrix.copyWithin(
                        part * stride,
                        part * stride + this.numEnvOld * MAX_PAR,
                        part * stride + this.numEnvOld * MAX_PAR + MAX_PAR,
                    );
        }
        const remap = (par: Int8Array, count: number, full: boolean): Int8Array => {
            const mapped = new Int8Array(MAX_NUM_ENV * MAX_PAR);
            for (let e = 0; e < this.numEnv; e++) {
                const src = par.subarray(e * MAX_PAR, e * MAX_PAR + MAX_PAR);
                const dst = mapped.subarray(e * MAX_PAR, e * MAX_PAR + MAX_PAR);
                if (is34) {
                    if (count === 20 || count === 11) mapIdx20To34(dst, src, full);
                    else if (count === 10 || count === 5) mapIdx10To34(dst, src, full);
                    else return par;
                } else if (count === 34 || count === 17) {
                    mapIdx34To20(dst, src, full);
                } else if (count === 10 || count === 5) {
                    mapIdx10To20(dst, src, full);
                } else {
                    return par;
                }
            }
            return mapped;
        };
        const iidMapped = remap(this.iidPar, this.nrIidPar, true);
        const iccMapped = remap(this.iccPar, this.nrIccPar, true);
        const ipdMapped = this.enableIpdopd
            ? remap(this.ipdPar, this.nrIpdopdPar, false)
            : new Int8Array(0);
        const opdMapped = this.enableIpdopd
            ? remap(this.opdPar, this.nrIpdopdPar, false)
            : new Int8Array(0);
        if (is34 && !this.is34Old) {
            for (const matrix of this.h) {
                mapVal20To34(matrix.subarray(0, MAX_PAR));
                mapVal20To34(matrix.subarray(stride, stride + MAX_PAR));
            }
            this.ipdHist.fill(0);
            this.opdHist.fill(0);
        } else if (!is34 && this.is34Old) {
            for (const matrix of this.h) {
                mapVal34To20(matrix.subarray(0, MAX_PAR));
                mapVal34To20(matrix.subarray(stride, stride + MAX_PAR));
            }
            this.ipdHist.fill(0);
            this.opdHist.fill(0);
        }
        const ipdopd = this.enableIpdopd === 1;
        for (let e = 0; e < this.numEnv; e++) {
            const next = (e + 1) * MAX_PAR;
            for (let b = 0; b < NR_PAR_BANDS[is34]!; b++) {
                const row =
                    ((iidMapped[e * MAX_PAR + b]! + 7 + 23 * this.iidQuant) * 8 +
                        iccMapped[e * MAX_PAR + b]!) *
                    4;
                let v11 = lut[row]!;
                let v12 = lut[row + 1]!;
                let v21 = lut[row + 2]!;
                let v22 = lut[row + 3]!;
                if (ipdopd && b < NR_IPDOPD_BANDS[is34]!) {
                    const opdIdx = this.opdHist[b]! * 8 + opdMapped[e * MAX_PAR + b]!;
                    const ipdIdx = this.ipdHist[b]! * 8 + ipdMapped[e * MAX_PAR + b]!;
                    const opdRe = TABLES.pdReSmooth[opdIdx]!;
                    const opdIm = TABLES.pdImSmooth[opdIdx]!;
                    const ipdRe = TABLES.pdReSmooth[ipdIdx]!;
                    const ipdIm = TABLES.pdImSmooth[ipdIdx]!;
                    this.opdHist[b] = opdIdx & 0x3f;
                    this.ipdHist[b] = ipdIdx & 0x3f;
                    const adjRe = opdRe * ipdRe + opdIm * ipdIm;
                    const adjIm = opdIm * ipdRe - opdRe * ipdIm;
                    h11[stride + next + b] = v11 * opdIm;
                    h12[stride + next + b] = v12 * adjIm;
                    h21[stride + next + b] = v21 * opdIm;
                    h22[stride + next + b] = v22 * adjIm;
                    v11 *= opdRe;
                    v12 *= adjRe;
                    v21 *= opdRe;
                    v22 *= adjRe;
                }
                h11[next + b] = v11;
                h12[next + b] = v12;
                h21[next + b] = v21;
                h22[next + b] = v22;
            }
            const start = this.borderPosition[e]!;
            const stop = this.borderPosition[e + 1]!;
            const width = 1 / (stop - start || 1);
            for (let k = 0; k < NR_BANDS[is34]!; k++) {
                const b = kToI[k]!;
                const cur = e * MAX_PAR + b;
                const nxt = next + b;
                const h = [h11[cur]!, h12[cur]!, h21[cur]!, h22[cur]!];
                const hi = [0, 0, 0, 0];
                if (ipdopd) {
                    const negate = (is34 && k <= 13 && k >= 9) || (!is34 && k <= 1) ? -1 : 1;
                    hi[0] = negate * h11[stride + cur]!;
                    hi[1] = negate * h12[stride + cur]!;
                    hi[2] = negate * h21[stride + cur]!;
                    hi[3] = negate * h22[stride + cur]!;
                }
                const step = [
                    (h11[nxt]! - h[0]!) * width,
                    (h12[nxt]! - h[1]!) * width,
                    (h21[nxt]! - h[2]!) * width,
                    (h22[nxt]! - h[3]!) * width,
                ];
                const stepI = ipdopd
                    ? [
                          (h11[stride + nxt]! - hi[0]!) * width,
                          (h12[stride + nxt]! - hi[1]!) * width,
                          (h21[stride + nxt]! - hi[2]!) * width,
                          (h22[stride + nxt]! - hi[3]!) * width,
                      ]
                    : [0, 0, 0, 0];
                if (stop === start) continue;
                for (let n = start + 1; n <= stop; n++) {
                    const at = k * SLOTS + n;
                    const lRe = this.lRe[at]!;
                    const lIm = this.lIm[at]!;
                    const rRe = this.rRe[at]!;
                    const rIm = this.rIm[at]!;
                    for (let j = 0; j < 4; j++) {
                        h[j]! += step[j]!;
                        hi[j]! += stepI[j]!;
                    }
                    if (ipdopd) {
                        this.lRe[at] = h[0]! * lRe + h[2]! * rRe - hi[0]! * lIm - hi[2]! * rIm;
                        this.lIm[at] = h[0]! * lIm + h[2]! * rIm + hi[0]! * lRe + hi[2]! * rRe;
                        this.rRe[at] = h[1]! * lRe + h[3]! * rRe - hi[1]! * lIm - hi[3]! * rIm;
                        this.rIm[at] = h[1]! * lIm + h[3]! * rIm + hi[1]! * lRe + hi[3]! * rRe;
                    } else {
                        this.lRe[at] = h[0]! * lRe + h[2]! * rRe;
                        this.lIm[at] = h[0]! * lIm + h[2]! * rIm;
                        this.rRe[at] = h[1]! * lRe + h[3]! * rRe;
                        this.rIm[at] = h[1]! * lIm + h[3]! * rIm;
                    }
                }
            }
        }
    }

    /**
     * Two channels from the mono QMF signal L (slots [38][64]); `top` is the last QMF band carrying
     * signal.
     */
    apply(
        lRe: Float64Array,
        lIm: Float64Array,
        rRe: Float64Array,
        rIm: Float64Array,
        top: number,
    ): void {
        const is34 = this.is34;
        top += NR_BANDS[is34]! - 64;
        this.delayRe.fill(0, top * DELAY_LEN, NR_BANDS[is34]! * DELAY_LEN);
        this.delayIm.fill(0, top * DELAY_LEN, NR_BANDS[is34]! * DELAY_LEN);
        if (top < NR_ALLPASS_BANDS[is34]!) {
            this.apRe.fill(0, top * AP_LINKS * AP_LEN, NR_ALLPASS_BANDS[is34]! * AP_LINKS * AP_LEN);
            this.apIm.fill(0, top * AP_LINKS * AP_LEN, NR_ALLPASS_BANDS[is34]! * AP_LINKS * AP_LEN);
        }
        this.hybridAnalysis(lRe, lIm);
        this.decorrelation();
        this.stereoProcessing();
        this.hybridSynthesis(lRe, lIm, this.lRe, this.lIm);
        this.hybridSynthesis(rRe, rIm, this.rRe, this.rIm);
    }
}

function mapIdx10To20(dst: Int8Array, par: Int8Array, full: boolean): void {
    let b = 9;
    if (!full) {
        b = 4;
        dst[10] = 0;
    }
    for (; b >= 0; b--) dst[2 * b + 1] = dst[2 * b] = par[b]!;
}

function mapIdx34To20(dst: Int8Array, p: Int8Array, full: boolean): void {
    const t = Math.trunc;
    dst[0] = t((2 * p[0]! + p[1]!) / 3);
    dst[1] = t((p[1]! + 2 * p[2]!) / 3);
    dst[2] = t((2 * p[3]! + p[4]!) / 3);
    dst[3] = t((p[4]! + 2 * p[5]!) / 3);
    dst[4] = t((p[6]! + p[7]!) / 2);
    dst[5] = t((p[8]! + p[9]!) / 2);
    dst[6] = p[10]!;
    dst[7] = p[11]!;
    dst[8] = t((p[12]! + p[13]!) / 2);
    dst[9] = t((p[14]! + p[15]!) / 2);
    dst[10] = p[16]!;
    if (full) {
        dst[11] = p[17]!;
        dst[12] = p[18]!;
        dst[13] = p[19]!;
        dst[14] = t((p[20]! + p[21]!) / 2);
        dst[15] = t((p[22]! + p[23]!) / 2);
        dst[16] = t((p[24]! + p[25]!) / 2);
        dst[17] = t((p[26]! + p[27]!) / 2);
        dst[18] = t((p[28]! + p[29]! + p[30]! + p[31]!) / 4);
        dst[19] = t((p[32]! + p[33]!) / 2);
    }
}

function mapIdx10To34(dst: Int8Array, p: Int8Array, full: boolean): void {
    if (full) {
        dst.fill(p[9]!, 28, 34);
        dst.fill(p[8]!, 24, 28);
        dst.fill(p[7]!, 20, 24);
        dst.fill(p[6]!, 18, 20);
        dst.fill(p[5]!, 16, 18);
    } else {
        dst[16] = 0;
    }
    dst.fill(p[4]!, 12, 16);
    dst.fill(p[3]!, 10, 12);
    dst.fill(p[2]!, 6, 10);
    dst.fill(p[1]!, 3, 6);
    dst.fill(p[0]!, 0, 3);
}

function mapIdx20To34(dst: Int8Array, p: Int8Array, full: boolean): void {
    if (full) {
        dst[33] = dst[32] = p[19]!;
        dst[31] = dst[30] = dst[29] = dst[28] = p[18]!;
        dst[27] = dst[26] = p[17]!;
        dst[25] = dst[24] = p[16]!;
        dst[23] = dst[22] = p[15]!;
        dst[21] = dst[20] = p[14]!;
        dst[19] = p[13]!;
        dst[18] = p[12]!;
        dst[17] = p[11]!;
    }
    dst[16] = p[10]!;
    dst[15] = dst[14] = p[9]!;
    dst[13] = dst[12] = p[8]!;
    dst[11] = p[7]!;
    dst[10] = p[6]!;
    dst[9] = dst[8] = p[5]!;
    dst[7] = dst[6] = p[4]!;
    dst[5] = p[3]!;
    dst[4] = Math.trunc((p[2]! + p[3]!) / 2);
    dst[3] = p[2]!;
    dst[2] = p[1]!;
    dst[1] = Math.trunc((p[0]! + p[1]!) / 2);
    dst[0] = p[0]!;
}

function mapVal34To20(p: Float64Array): void {
    p[0] = (2 * p[0]! + p[1]!) * 0.33333333;
    p[1] = (p[1]! + 2 * p[2]!) * 0.33333333;
    p[2] = (2 * p[3]! + p[4]!) * 0.33333333;
    p[3] = (p[4]! + 2 * p[5]!) * 0.33333333;
    p[4] = (p[6]! + p[7]!) * 0.5;
    p[5] = (p[8]! + p[9]!) * 0.5;
    p[6] = p[10]!;
    p[7] = p[11]!;
    p[8] = (p[12]! + p[13]!) * 0.5;
    p[9] = (p[14]! + p[15]!) * 0.5;
    p[10] = p[16]!;
    p[11] = p[17]!;
    p[12] = p[18]!;
    p[13] = p[19]!;
    p[14] = (p[20]! + p[21]!) * 0.5;
    p[15] = (p[22]! + p[23]!) * 0.5;
    p[16] = (p[24]! + p[25]!) * 0.5;
    p[17] = (p[26]! + p[27]!) * 0.5;
    p[18] = (p[28]! + p[29]! + p[30]! + p[31]!) * 0.25;
    p[19] = (p[32]! + p[33]!) * 0.5;
}

function mapVal20To34(p: Float64Array): void {
    p[33] = p[32] = p[19]!;
    p[31] = p[30] = p[29] = p[28] = p[18]!;
    p[27] = p[26] = p[17]!;
    p[25] = p[24] = p[16]!;
    p[23] = p[22] = p[15]!;
    p[21] = p[20] = p[14]!;
    p[19] = p[13]!;
    p[18] = p[12]!;
    p[17] = p[11]!;
    p[16] = p[10]!;
    p[15] = p[14] = p[9]!;
    p[13] = p[12] = p[8]!;
    p[11] = p[7]!;
    p[10] = p[6]!;
    p[9] = p[8] = p[5]!;
    p[7] = p[6] = p[4]!;
    p[5] = p[3]!;
    p[4] = (p[2]! + p[3]!) * 0.5;
    p[3] = p[2]!;
    p[2] = p[1]!;
    p[1] = (p[0]! + p[1]!) * 0.5;
}
