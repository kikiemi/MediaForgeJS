/*
 * Alpha delta/run decoding adapted from FFmpeg 6.1 libavcodec/proresdec2.c.
 * Copyright (c) 2010-2011 Maxim Poliakovski
 * Copyright (c) 2010-2011 Elvis Presley
 * JavaScript adaptation: MediaForgeJS contributors, 2026.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 * https://ffmpeg.org/doxygen/6.1/proresdec2_8c_source.html
 *
 * This file is free software under the GNU Lesser General Public License,
 * version 2.1 or (at your option) any later version. It is distributed
 * WITHOUT ANY WARRANTY, including MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See LICENSE-LGPL-2.1 for the complete license.
 *
 * Unlike the reference decoder, this preserves all sixteen alpha bits.
 */

export function unpackAlpha16(bytes, count) {
    let bit = 0;
    const read = length => {
        if (bit + length > bytes.length * 8) throw new Error('ProRes alpha bitstream is truncated');
        // Reads are at most sixteen bits, so three bytes cover every alignment.
        const byte = bit >>> 3;
        const bits = (bytes[byte] << 16) | (bytes[byte + 1] << 8) | bytes[byte + 2];
        const value = (bits >>> (24 - (bit & 7) - length)) & ((1 << length) - 1);
        bit += length;
        return value;
    };
    const output = new Uint16Array(count);
    let position = 0;
    let alpha = 65535;
    while (position < count) {
        do {
            let delta;
            if (read(1)) delta = read(16);
            else {
                const code = read(7);
                delta = (code + 2) >> 1;
                if (code & 1) delta = -delta;
            }
            alpha = (alpha + delta) & 65535;
            output[position++] = alpha;
            if (position === count) return output;
        } while (read(1));
        const shortRun = read(4);
        const run = shortRun || read(11);
        if (run > count - position) throw new Error('ProRes alpha run exceeds its slice');
        output.fill(alpha, position, position + run);
        position += run;
    }
    return output;
}
