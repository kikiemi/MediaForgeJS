/** Neighbour availability bits for intra prediction. */
export const AVAIL_A = 1;
export const AVAIL_B = 2;
export const AVAIL_C = 4;
export const AVAIL_D = 8;

/**
 * Lower half of the left column, for chroma prediction next to an MBAFF pair of the other kind
 * (8.3.4).
 */
export const AVAIL_A_LOW = 16;

/** p[x, -1] for x = -1..15 at index x + 1, then p[-1, y] for y = 0..15 at index 17 + y. */
const edge = new Int32Array(40);
const filtered = new Int32Array(40);

function clip(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Intra_4x4 prediction (8.3.1.2) of the block at `dst[o]` whose row above starts at `dst[top]`; the
 * left column is at `o - 1 + y * stride`. Unavailable top-right samples repeat p[3, -1]. Returns
 * false for an invalid mode or missing required neighbours.
 */
export function predIntra4x4(
    mode: number,
    dst: Uint8Array,
    o: number,
    stride: number,
    top: number,
    avail: number,
): boolean {
    const hasA = avail & AVAIL_A;
    const hasB = avail & AVAIL_B;
    const e = edge;
    if (hasB) {
        e[1] = dst[top];
        e[2] = dst[top + 1];
        e[3] = dst[top + 2];
        e[4] = dst[top + 3];
        if (avail & AVAIL_C) {
            e[5] = dst[top + 4];
            e[6] = dst[top + 5];
            e[7] = dst[top + 6];
            e[8] = dst[top + 7];
        } else e[5] = e[6] = e[7] = e[8] = e[4];
    }
    if (hasA) for (let y = 0; y < 4; y++) e[17 + y] = dst[o - 1 + y * stride];
    if (avail & AVAIL_D) e[0] = dst[top - 1];
    switch (mode) {
        case 0:
            if (!hasB) return false;
            for (let y = 0; y < 4; y++) {
                const p = o + y * stride;
                dst[p] = e[1];
                dst[p + 1] = e[2];
                dst[p + 2] = e[3];
                dst[p + 3] = e[4];
            }
            return true;
        case 1:
            if (!hasA) return false;
            for (let y = 0; y < 4; y++) {
                const p = o + y * stride;
                dst[p] = dst[p + 1] = dst[p + 2] = dst[p + 3] = e[17 + y];
            }
            return true;
        case 2: {
            let dc: number;
            if (hasA && hasB)
                dc = (e[1] + e[2] + e[3] + e[4] + e[17] + e[18] + e[19] + e[20] + 4) >> 3;
            else if (hasA) dc = (e[17] + e[18] + e[19] + e[20] + 2) >> 2;
            else if (hasB) dc = (e[1] + e[2] + e[3] + e[4] + 2) >> 2;
            else dc = 128;
            for (let y = 0; y < 4; y++) {
                const p = o + y * stride;
                dst[p] = dst[p + 1] = dst[p + 2] = dst[p + 3] = dc;
            }
            return true;
        }
        case 3:
            if (!hasB) return false;
            for (let y = 0; y < 4; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 4; x++) {
                    dst[p + x] =
                        x === 3 && y === 3
                            ? (e[7] + 3 * e[8] + 2) >> 2
                            : (e[x + y + 1] + 2 * e[x + y + 2] + e[x + y + 3] + 2) >> 2;
                }
            }
            return true;
        case 4:
            if (!(hasA && hasB && avail & AVAIL_D)) return false;
            for (let y = 0; y < 4; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 4; x++) {
                    let v: number;
                    if (x > y) v = (e[x - y - 1] + 2 * e[x - y] + e[x - y + 1] + 2) >> 2;
                    else if (x < y)
                        v = (sample(y - x - 2) + 2 * sample(y - x - 1) + sample(y - x) + 2) >> 2;
                    else v = (e[1] + 2 * e[0] + e[17] + 2) >> 2;
                    dst[p + x] = v;
                }
            }
            return true;
        case 5:
            if (!(hasA && hasB && avail & AVAIL_D)) return false;
            for (let y = 0; y < 4; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 4; x++) {
                    const zVR = 2 * x - y;
                    let v: number;
                    if (zVR >= 0 && (zVR & 1) === 0)
                        v = (e[x - (y >> 1)] + e[x - (y >> 1) + 1] + 1) >> 1;
                    else if (zVR >= 0)
                        v =
                            (e[x - (y >> 1) - 1] + 2 * e[x - (y >> 1)] + e[x - (y >> 1) + 1] + 2) >>
                            2;
                    else if (zVR === -1) v = (e[17] + 2 * e[0] + e[1] + 2) >> 2;
                    else v = (sample(y - 1) + 2 * sample(y - 2) + sample(y - 3) + 2) >> 2;
                    dst[p + x] = v;
                }
            }
            return true;
        case 6:
            if (!(hasA && hasB && avail & AVAIL_D)) return false;
            for (let y = 0; y < 4; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 4; x++) {
                    const zHD = 2 * y - x;
                    let v: number;
                    if (zHD >= 0 && (zHD & 1) === 0)
                        v = (sample(y - (x >> 1) - 1) + sample(y - (x >> 1)) + 1) >> 1;
                    else if (zHD >= 0)
                        v =
                            (sample(y - (x >> 1) - 2) +
                                2 * sample(y - (x >> 1) - 1) +
                                sample(y - (x >> 1)) +
                                2) >>
                            2;
                    else if (zHD === -1) v = (e[17] + 2 * e[0] + e[1] + 2) >> 2;
                    else v = (e[x] + 2 * e[x - 1] + e[x - 2] + 2) >> 2;
                    dst[p + x] = v;
                }
            }
            return true;
        case 7:
            if (!hasB) return false;
            for (let y = 0; y < 4; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 4; x++) {
                    const i = x + (y >> 1) + 1;
                    dst[p + x] =
                        y & 1
                            ? (e[i] + 2 * e[i + 1] + e[i + 2] + 2) >> 2
                            : (e[i] + e[i + 1] + 1) >> 1;
                }
            }
            return true;
        case 8:
            if (!hasA) return false;
            for (let y = 0; y < 4; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 4; x++) {
                    const zHU = x + 2 * y;
                    let v: number;
                    if (zHU > 5) v = e[20];
                    else if (zHU === 5) v = (e[19] + 3 * e[20] + 2) >> 2;
                    else if (zHU & 1)
                        v =
                            (e[17 + y + (x >> 1)] +
                                2 * e[18 + y + (x >> 1)] +
                                e[19 + y + (x >> 1)] +
                                2) >>
                            2;
                    else v = (e[17 + y + (x >> 1)] + e[18 + y + (x >> 1)] + 1) >> 1;
                    dst[p + x] = v;
                }
            }
            return true;
        default:
            return false;
    }
}

/** p[-1, y] for y >= 0 and p[-1, -1] for y = -1, from the edge buffer. */
function sample(y: number): number {
    return y < 0 ? edge[0] : edge[17 + y];
}

/**
 * Intra_8x8 prediction (8.3.2.2) with reference sample filtering; the layout of `dst`, `o`,
 * `stride` and `top` is as for the 4x4 case. Unavailable top-right samples repeat p[7, -1].
 */
export function predIntra8x8(
    mode: number,
    dst: Uint8Array,
    o: number,
    stride: number,
    top: number,
    avail: number,
): boolean {
    const hasA = avail & AVAIL_A;
    const hasB = avail & AVAIL_B;
    const hasD = avail & AVAIL_D;
    const e = edge;
    const f = filtered;
    if (hasB) {
        for (let x = 0; x < 8; x++) e[1 + x] = dst[top + x];
        if (avail & AVAIL_C) for (let x = 8; x < 16; x++) e[1 + x] = dst[top + x];
        else for (let x = 8; x < 16; x++) e[1 + x] = e[8];
    }
    if (hasA) for (let y = 0; y < 8; y++) e[17 + y] = dst[o - 1 + y * stride];
    if (hasD) e[0] = dst[top - 1];
    if (hasB) {
        f[1] = hasD ? (e[0] + 2 * e[1] + e[2] + 2) >> 2 : (3 * e[1] + e[2] + 2) >> 2;
        for (let x = 1; x < 15; x++) f[1 + x] = (e[x] + 2 * e[x + 1] + e[x + 2] + 2) >> 2;
        f[16] = (e[15] + 3 * e[16] + 2) >> 2;
    }
    if (hasD) {
        if (hasB && hasA) f[0] = (e[1] + 2 * e[0] + e[17] + 2) >> 2;
        else if (hasB) f[0] = (3 * e[0] + e[1] + 2) >> 2;
        else if (hasA) f[0] = (3 * e[0] + e[17] + 2) >> 2;
        else f[0] = e[0];
    }
    if (hasA) {
        f[17] = hasD ? (e[0] + 2 * e[17] + e[18] + 2) >> 2 : (3 * e[17] + e[18] + 2) >> 2;
        for (let y = 1; y < 7; y++) f[17 + y] = (e[16 + y] + 2 * e[17 + y] + e[18 + y] + 2) >> 2;
        f[24] = (e[23] + 3 * e[24] + 2) >> 2;
    }
    const t = (x: number) => f[1 + x];
    const l = (y: number) => (y < 0 ? f[0] : f[17 + y]);
    switch (mode) {
        case 0:
            if (!hasB) return false;
            for (let y = 0; y < 8; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 8; x++) dst[p + x] = f[1 + x];
            }
            return true;
        case 1:
            if (!hasA) return false;
            for (let y = 0; y < 8; y++) {
                const p = o + y * stride;
                const v = f[17 + y];
                for (let x = 0; x < 8; x++) dst[p + x] = v;
            }
            return true;
        case 2: {
            let dc: number;
            if (hasA && hasB) {
                let sum = 8;
                for (let i = 0; i < 8; i++) sum += f[1 + i] + f[17 + i];
                dc = sum >> 4;
            } else if (hasA) {
                let sum = 4;
                for (let i = 0; i < 8; i++) sum += f[17 + i];
                dc = sum >> 3;
            } else if (hasB) {
                let sum = 4;
                for (let i = 0; i < 8; i++) sum += f[1 + i];
                dc = sum >> 3;
            } else dc = 128;
            for (let y = 0; y < 8; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 8; x++) dst[p + x] = dc;
            }
            return true;
        }
        case 3:
            if (!hasB) return false;
            for (let y = 0; y < 8; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 8; x++) {
                    dst[p + x] =
                        x === 7 && y === 7
                            ? (t(14) + 3 * t(15) + 2) >> 2
                            : (t(x + y) + 2 * t(x + y + 1) + t(x + y + 2) + 2) >> 2;
                }
            }
            return true;
        case 4:
            if (!(hasA && hasB && hasD)) return false;
            for (let y = 0; y < 8; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 8; x++) {
                    let v: number;
                    if (x > y) v = (t(x - y - 2) + 2 * t(x - y - 1) + t(x - y) + 2) >> 2;
                    else if (x < y) v = (l(y - x - 2) + 2 * l(y - x - 1) + l(y - x) + 2) >> 2;
                    else v = (t(0) + 2 * l(-1) + l(0) + 2) >> 2;
                    dst[p + x] = v;
                }
            }
            return true;
        case 5:
            if (!(hasA && hasB && hasD)) return false;
            for (let y = 0; y < 8; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 8; x++) {
                    const zVR = 2 * x - y;
                    let v: number;
                    if (zVR >= 0 && (zVR & 1) === 0)
                        v = (t(x - (y >> 1) - 1) + t(x - (y >> 1)) + 1) >> 1;
                    else if (zVR >= 0)
                        v =
                            (t(x - (y >> 1) - 2) + 2 * t(x - (y >> 1) - 1) + t(x - (y >> 1)) + 2) >>
                            2;
                    else if (zVR === -1) v = (l(0) + 2 * l(-1) + t(0) + 2) >> 2;
                    else v = (l(y - 2 * x - 1) + 2 * l(y - 2 * x - 2) + l(y - 2 * x - 3) + 2) >> 2;
                    dst[p + x] = v;
                }
            }
            return true;
        case 6:
            if (!(hasA && hasB && hasD)) return false;
            for (let y = 0; y < 8; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 8; x++) {
                    const zHD = 2 * y - x;
                    let v: number;
                    if (zHD >= 0 && (zHD & 1) === 0)
                        v = (l(y - (x >> 1) - 1) + l(y - (x >> 1)) + 1) >> 1;
                    else if (zHD >= 0)
                        v =
                            (l(y - (x >> 1) - 2) + 2 * l(y - (x >> 1) - 1) + l(y - (x >> 1)) + 2) >>
                            2;
                    else if (zHD === -1) v = (l(0) + 2 * l(-1) + t(0) + 2) >> 2;
                    else v = (t(x - 2 * y - 1) + 2 * t(x - 2 * y - 2) + t(x - 2 * y - 3) + 2) >> 2;
                    dst[p + x] = v;
                }
            }
            return true;
        case 7:
            if (!hasB) return false;
            for (let y = 0; y < 8; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 8; x++) {
                    const i = x + (y >> 1);
                    dst[p + x] =
                        y & 1
                            ? (t(i) + 2 * t(i + 1) + t(i + 2) + 2) >> 2
                            : (t(i) + t(i + 1) + 1) >> 1;
                }
            }
            return true;
        case 8:
            if (!hasA) return false;
            for (let y = 0; y < 8; y++) {
                const p = o + y * stride;
                for (let x = 0; x < 8; x++) {
                    const zHU = x + 2 * y;
                    let v: number;
                    if (zHU > 13) v = l(7);
                    else if (zHU === 13) v = (l(6) + 3 * l(7) + 2) >> 2;
                    else if (zHU & 1)
                        v =
                            (l(y + (x >> 1)) + 2 * l(y + (x >> 1) + 1) + l(y + (x >> 1) + 2) + 2) >>
                            2;
                    else v = (l(y + (x >> 1)) + l(y + (x >> 1) + 1) + 1) >> 1;
                    dst[p + x] = v;
                }
            }
            return true;
        default:
            return false;
    }
}

/** Intra_16x16 prediction (8.3.3); modes 0 vertical, 1 horizontal, 2 DC, 3 plane. */
export function predIntra16x16(
    mode: number,
    dst: Uint8Array,
    o: number,
    stride: number,
    top: number,
    avail: number,
): boolean {
    const hasA = avail & AVAIL_A;
    const hasB = avail & AVAIL_B;
    switch (mode) {
        case 0:
            if (!hasB) return false;
            for (let y = 0; y < 16; y++) dst.copyWithin(o + y * stride, top, top + 16);
            return true;
        case 1:
            if (!hasA) return false;
            for (let y = 0; y < 16; y++) {
                const p = o + y * stride;
                dst.fill(dst[p - 1], p, p + 16);
            }
            return true;
        case 2: {
            let sum = 0;
            let dc: number;
            if (hasB) for (let x = 0; x < 16; x++) sum += dst[top + x];
            if (hasA) for (let y = 0; y < 16; y++) sum += dst[o - 1 + y * stride];
            if (hasA && hasB) dc = (sum + 16) >> 5;
            else if (hasA || hasB) dc = (sum + 8) >> 4;
            else dc = 128;
            for (let y = 0; y < 16; y++) dst.fill(dc, o + y * stride, o + y * stride + 16);
            return true;
        }
        case 3: {
            if (!(hasA && hasB && avail & AVAIL_D)) return false;
            let h = 0;
            let v = 0;
            for (let i = 0; i < 8; i++) {
                h += (i + 1) * (dst[top + 8 + i] - dst[top + 6 - i]);
                v +=
                    (i + 1) *
                    (dst[o - 1 + (8 + i) * stride] -
                        (i === 7 ? dst[top - 1] : dst[o - 1 + (6 - i) * stride]));
            }
            const a = 16 * (dst[o - 1 + 15 * stride] + dst[top + 15]);
            const b = (5 * h + 32) >> 6;
            const c = (5 * v + 32) >> 6;
            for (let y = 0; y < 16; y++) {
                const p = o + y * stride;
                const row = a + c * (y - 7) + 16;
                for (let x = 0; x < 16; x++) dst[p + x] = clip((row + b * (x - 7)) >> 5);
            }
            return true;
        }
        default:
            return false;
    }
}

/**
 * Chroma intra prediction (8.3.4) of a `width` x `height` block (8x8 for 4:2:0, 8x16 for 4:2:2);
 * modes 0 DC, 1 horizontal, 2 vertical, 3 plane.
 */
export function predIntraChroma(
    mode: number,
    dst: Uint8Array,
    o: number,
    stride: number,
    top: number,
    avail: number,
    height: number,
): boolean {
    const hasA = avail & AVAIL_A && avail & AVAIL_A_LOW;
    const hasB = avail & AVAIL_B;
    switch (mode) {
        case 0:
            for (let yO = 0; yO < height; yO += 4) {
                const hasA = avail & (yO < height >> 1 ? AVAIL_A : AVAIL_A_LOW);
                for (let xO = 0; xO < 8; xO += 4) {
                    let sumTop = 0;
                    let sumLeft = 0;
                    if (hasB) for (let x = 0; x < 4; x++) sumTop += dst[top + xO + x];
                    if (hasA) for (let y = 0; y < 4; y++) sumLeft += dst[o - 1 + (yO + y) * stride];
                    let dc: number;
                    if ((xO === 0 && yO === 0) || (xO > 0 && yO > 0)) {
                        if (hasA && hasB) dc = (sumTop + sumLeft + 4) >> 3;
                        else if (hasA) dc = (sumLeft + 2) >> 2;
                        else if (hasB) dc = (sumTop + 2) >> 2;
                        else dc = 128;
                    } else if (xO > 0) {
                        if (hasB) dc = (sumTop + 2) >> 2;
                        else if (hasA) dc = (sumLeft + 2) >> 2;
                        else dc = 128;
                    } else if (hasA) dc = (sumLeft + 2) >> 2;
                    else if (hasB) dc = (sumTop + 2) >> 2;
                    else dc = 128;
                    for (let y = 0; y < 4; y++) {
                        const p = o + (yO + y) * stride + xO;
                        dst[p] = dst[p + 1] = dst[p + 2] = dst[p + 3] = dc;
                    }
                }
            }
            return true;
        case 1:
            if (!hasA) return false;
            for (let y = 0; y < height; y++) {
                const p = o + y * stride;
                dst.fill(dst[p - 1], p, p + 8);
            }
            return true;
        case 2:
            if (!hasB) return false;
            for (let y = 0; y < height; y++) dst.copyWithin(o + y * stride, top, top + 8);
            return true;
        case 3: {
            if (!(hasA && hasB && avail & AVAIL_D)) return false;
            const yCF = height === 16 ? 4 : 0;
            let h = 0;
            let v = 0;
            for (let x = 0; x < 4; x++)
                h += (x + 1) * (dst[top + 4 + x] - (x === 3 ? dst[top - 1] : dst[top + 2 - x]));
            for (let y = 0; y < 4 + yCF; y++) {
                const below = dst[o - 1 + (4 + yCF + y) * stride];
                const above = y === 3 + yCF ? dst[top - 1] : dst[o - 1 + (2 + yCF - y) * stride];
                v += (y + 1) * (below - above);
            }
            const a = 16 * (dst[o - 1 + (height - 1) * stride] + dst[top + 7]);
            const b = (34 * h + 32) >> 6;
            const c = ((height === 16 ? 5 : 34) * v + 32) >> 6;
            for (let y = 0; y < height; y++) {
                const p = o + y * stride;
                const row = a + c * (y - 3 - yCF) + 16;
                for (let x = 0; x < 8; x++) dst[p + x] = clip((row + b * (x - 3)) >> 5);
            }
            return true;
        }
        default:
            return false;
    }
}
