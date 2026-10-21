// The MP2 and MP3 encoders' polyphase analysis filterbank (ISO/IEC 11172-3 annex C).
import { ANALYSIS_WIN } from './common';

/** Samples of a channel analysisFilterbank() keeps between calls, ahead of the new ones. */
export const ANALYSIS_HISTORY = 480;

// The matrixing S[k] = sum z[u] cos(pi (2k + 1) u / 64) of the 32 folded values z: S[31 - k]
// takes the odd terms of S[k] negated, and so does the even half's (a 16-point sum over z[2m])
// k-th from the end; so S comes from three tables: the odd u (k, u < 16 by 16), and u = 4j and
// u = 4j + 2 (k < 8 by 8).
const COS_ODD = new Float64Array(16 * 16);
const COS_EVEN0 = new Float64Array(8 * 8);
const COS_EVEN2 = new Float64Array(8 * 8);
for (let k = 0; k < 16; k++) {
    for (let j = 0; j < 16; j++) {
        COS_ODD[k * 16 + j] = Math.cos((Math.PI / 64) * (2 * k + 1) * (2 * j + 1));
    }
}
for (let k = 0; k < 8; k++) {
    for (let j = 0; j < 8; j++) {
        COS_EVEN0[k * 8 + j] = Math.cos((Math.PI / 64) * (2 * k + 1) * 4 * j);
        COS_EVEN2[k * 8 + j] = Math.cos((Math.PI / 64) * (2 * k + 1) * (4 * j + 2));
    }
}
const WINDOWED = new Float64Array(64);
const FOLDED = new Float64Array(32);
const EVEN = new Float64Array(16);

/**
 * The polyphase analysis of `slots` blocks of 32 samples of one channel, pcm[off + i * stride]
 * (zero past its end), into subs[sbOff + slot * 32 + sb]. history (ANALYSIS_HISTORY + 32 * slots
 * values) starts with the channel's last ANALYSIS_HISTORY samples and keeps them for the next call.
 */
export function analysisFilterbank(
    pcm: Float32Array,
    off: number,
    stride: number,
    slots: number,
    history: Float64Array,
    subs: Float64Array,
    sbOff: number,
): void {
    const count = slots * 32;
    for (let i = 0; i < count; i++) {
        const idx = off + i * stride;
        history[ANALYSIS_HISTORY + i] = idx < pcm.length ? pcm[idx]! : 0;
    }
    const win64 = WINDOWED;
    const z = FOLDED;
    const even = EVEN;
    for (let slot = 0; slot < slots; slot++) {
        // The 512 samples ending with the slot's last, newest first: newest - n at last - n.
        const last = slot * 32 + 511;
        // The eight taps of each output summed in pairs, so the additions do not wait in a chain.
        for (let i = 0; i < 64; i++) {
            const at = last - i;
            win64[i] =
                ANALYSIS_WIN[i]! * history[at]! +
                ANALYSIS_WIN[i + 64]! * history[at - 64]! +
                (ANALYSIS_WIN[i + 128]! * history[at - 128]! +
                    ANALYSIS_WIN[i + 192]! * history[at - 192]!) +
                (ANALYSIS_WIN[i + 256]! * history[at - 256]! +
                    ANALYSIS_WIN[i + 320]! * history[at - 320]! +
                    (ANALYSIS_WIN[i + 384]! * history[at - 384]! +
                        ANALYSIS_WIN[i + 448]! * history[at - 448]!));
        }
        z[0] = win64[16]!;
        for (let u = 1; u <= 16; u++) z[u] = win64[16 + u]! + win64[16 - u]!;
        for (let u = 17; u < 32; u++) z[u] = win64[16 + u]! - win64[80 - u]!;
        for (let k = 0; k < 8; k++) {
            let e0 = 0;
            let e2 = 0;
            for (let j = 0; j < 8; j++) {
                e0 += z[4 * j]! * COS_EVEN0[k * 8 + j]!;
                e2 += z[4 * j + 2]! * COS_EVEN2[k * 8 + j]!;
            }
            even[k] = e0 + e2;
            even[15 - k] = e0 - e2;
        }
        const out = sbOff + slot * 32;
        for (let k = 0; k < 16; k += 4) {
            let o0 = 0;
            let o1 = 0;
            let o2 = 0;
            let o3 = 0;
            for (let j = 0; j < 16; j++) {
                const w = z[2 * j + 1]!;
                o0 += w * COS_ODD[k * 16 + j]!;
                o1 += w * COS_ODD[k * 16 + 16 + j]!;
                o2 += w * COS_ODD[k * 16 + 32 + j]!;
                o3 += w * COS_ODD[k * 16 + 48 + j]!;
            }
            subs[out + k] = even[k]! + o0;
            subs[out + k + 1] = even[k + 1]! + o1;
            subs[out + k + 2] = even[k + 2]! + o2;
            subs[out + k + 3] = even[k + 3]! + o3;
            subs[out + 31 - k] = even[k]! - o0;
            subs[out + 30 - k] = even[k + 1]! - o1;
            subs[out + 29 - k] = even[k + 2]! - o2;
            subs[out + 28 - k] = even[k + 3]! - o3;
        }
    }
    history.copyWithin(0, count, count + ANALYSIS_HISTORY);
}
