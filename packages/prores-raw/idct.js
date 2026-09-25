/*
 * ProRes RAW 16-bit output integer IDCT and linearization, adapted from FFmpeg.
 * Copyright (c) 2010-2011 Maxim Poliakovski
 * Copyright (c) 2001 Michael Niedermayer <michaelni@gmx.at>
 * Based upon code by Aaron Holtzman <aholtzma@ess.engr.uvic.ca>.
 * JavaScript adaptation for MediaForgeJS, 2026.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 * See LICENSE and NOTICE. This code is provided without any warranty.
 */

// Preserve the reference transform's 32-bit modular arithmetic and rounding.
function transform(block, offset, step, column) {
    const d0 = block[offset] + (column ? 1 : 0);
    const d1 = block[offset + step],
        d2 = block[offset + step * 2],
        d3 = block[offset + step * 3];
    const d4 = block[offset + step * 4],
        d5 = block[offset + step * 5],
        d6 = block[offset + step * 6],
        d7 = block[offset + step * 7];
    const base = Math.imul(16384, d0) + (column ? 0 : 4096);
    const a0 = base + Math.imul(21407, d2) + Math.imul(16384, d4) + Math.imul(8867, d6);
    const a1 = base + Math.imul(8867, d2) - Math.imul(16384, d4) - Math.imul(21407, d6);
    const a2 = base - Math.imul(8867, d2) - Math.imul(16384, d4) + Math.imul(21407, d6);
    const a3 = base - Math.imul(21407, d2) + Math.imul(16384, d4) - Math.imul(8867, d6);
    const b0 = Math.imul(22725, d1) + Math.imul(19265, d3) + Math.imul(12873, d5) + Math.imul(4520, d7);
    const b1 = Math.imul(19265, d1) - Math.imul(4520, d3) - Math.imul(22725, d5) - Math.imul(12873, d7);
    const b2 = Math.imul(12873, d1) - Math.imul(22725, d3) + Math.imul(4520, d5) + Math.imul(19265, d7);
    const b3 = Math.imul(4520, d1) - Math.imul(12873, d3) + Math.imul(19265, d5) - Math.imul(22725, d7);
    const shift = column ? 15 : 13;
    block[offset] = (a0 + b0) >> shift;
    block[offset + step] = (a1 + b1) >> shift;
    block[offset + step * 2] = (a2 + b2) >> shift;
    block[offset + step * 3] = (a3 + b3) >> shift;
    block[offset + step * 4] = (a3 - b3) >> shift;
    block[offset + step * 5] = (a2 - b2) >> shift;
    block[offset + step * 6] = (a1 - b1) >> shift;
    block[offset + step * 7] = (a0 - b0) >> shift;
}

export function putBlock(block, offset, quantization, curve, frame, left, top) {
    for (let i = 0; i < 64; i++)
        block[offset + i] = Math.max(-32768, Math.min(32767, block[offset + i] * quantization[i]));
    for (let i = 0; i < 8; i++) transform(block, offset + i * 8, 1, false);
    for (let i = 0; i < 8; i++) transform(block, offset + i, 8, true);
    for (let row = 0; row < 8; row++) {
        const y = top + row * 2;
        if (y >= frame.height) break;
        for (let column = 0; column < 8; column++) {
            const x = left + column * 2;
            if (x >= frame.width) break;
            const value = Math.max(0, Math.min(65535, block[offset + row * 8 + column] + 32768));
            const segment = value >>> 13;
            const fraction = value & 8191;
            const first = curve[segment];
            const next = segment < 7 ? curve[segment + 1] : 0;
            frame.data[y * frame.stride + x] = Math.min(
                65535,
                (first * 8192 + ((next - first) & 65535) * fraction + 4096) >>> 13,
            );
        }
    }
}
