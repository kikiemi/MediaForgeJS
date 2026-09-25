/*
 * ProRes RAW entropy decoder adapted from FFmpeg libavcodec/prores_raw.c.
 * Copyright (c) 2023-2025 Paul B Mahol
 * Copyright (c) 2025 Lynne
 * Scan table: Copyright (c) 2010-2011 Maxim Poliakovski
 * JavaScript adaptation for MediaForgeJS, 2026.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 * See LICENSE and NOTICE. This code is provided without any warranty.
 */
import { ProResRawError, parsePacket, checkAbort, checkInput } from './packet.js';
import { putBlock } from './idct.js';
export { ProResRawError } from './packet.js';

const DC = [0x010, 0x021, 0x032, 0x033, 0x033, 0x033, 0x044, 0x044, 0x044, 0x044, 0x044, 0x044, 0x076];
const AC = [
    0x000,
    0x211,
    0x111,
    0x111,
    0x222,
    0x222,
    0x222,
    0x122,
    0x122,
    0x122,
    0x233,
    0x233,
    0x233,
    0x233,
    0x233,
    0x233,
    0x233,
    0x233,
    0x133,
    0x133,
    ...Array(22).fill(0x244),
    ...Array(52).fill(0x355),
    0x166,
];
const RN = [
    0x200, 0x100, 0x000, 0x000, 0x211, 0x211, 0x111, 0x111, 0x011, 0x011, 0x021, 0x021, 0x222, 0x022, 0x022, 0x022,
    0x022, 0x022, 0x022, 0x022, 0x022, 0x022, 0x022, 0x022, 0x022, 0x032, 0x032, 0x044,
];
const LN = [0x100, 0x111, 0x222, 0x222, 0x122, 0x122, 0x433, 0x433, 0x233, 0x233, 0x233, 0x233, 0x233, 0x233, 0x033];
const SCAN = [
    0, 8, 1, 9, 16, 24, 17, 25, 2, 10, 3, 11, 18, 26, 19, 27, 32, 40, 33, 34, 41, 48, 56, 49, 42, 35, 43, 50, 57, 58,
    51, 59, 4, 12, 5, 6, 13, 20, 28, 21, 14, 7, 15, 22, 29, 36, 44, 37, 30, 23, 31, 38, 45, 52, 60, 53, 46, 39, 47, 54,
    61, 62, 55, 63,
];

class BitReader {
    constructor(data, offset, length) {
        this.data = data.subarray(offset, offset + length);
        this.position = 0;
        this.bits = length * 8;
    }
    value(codebook) {
        const left = this.bits - this.position;
        if (left <= 0) return -1;
        const byte = this.position >>> 3;
        const shift = this.position & 7;
        const data = this.data;
        let word = ((data[byte] << 24) | (data[byte + 1] << 16) | (data[byte + 2] << 8) | data[byte + 3]) >>> 0;
        if (shift) word = ((word << shift) | ((data[byte + 4] ?? 0) >>> (8 - shift))) >>> 0;
        if (!word) return -1; // all-zero remainder terminates a component
        const rice = codebook & 15;
        const exp = (codebook >> 4) & 15;
        const change = codebook >> 8;
        const zeros = Math.clz32(word);
        const length = zeros <= change ? 1 + rice + zeros : exp + zeros * 2 - change;
        if (length > 32 || length > left) throw new ProResRawError('truncated or invalid entropy symbol');
        this.position += length;
        if (zeros <= change) return zeros * 2 ** rice + (((word << (zeros + 1)) >>> 1) >>> (31 - rice));
        return (length === 32 ? word : word >>> (32 - length)) + (change + 1) * 2 ** rice - 2 ** exp;
    }
    sign() {
        if (this.position >= this.bits) throw new ProResRawError('truncated coefficient sign');
        const value = (this.data[this.position >>> 3] >>> (7 - (this.position & 7))) & 1;
        this.position++;
        return value ? -1 : 1;
    }
}

function decodeComponent(data, offset, length, tile, component, quantization, frame, block) {
    const blocks = 1 << tile.log2Blocks;
    const count = blocks * 64;
    block.fill(0, 0, count);
    const reader = new BitReader(data, offset, length);
    let dc = reader.value(700);
    let ended = dc < 0;
    let previous = ended ? 0 : (dc >>> 1) ^ -(dc & 1);
    block[0] = previous;
    let sign = 0;
    for (let n = 1; n < blocks && !ended; n++) {
        dc = reader.value(n === 1 ? 100 : DC[Math.min(Math.floor((dc + 1) / 2), 12)]);
        if (dc < 0) {
            ended = true;
            break;
        }
        sign ^= dc & 1;
        const delta = sign ? -Math.floor((dc + 1) / 2) : Math.floor((dc + 1) / 2);
        sign = delta < 0 ? 1 : 0;
        previous += delta;
        if (previous < -2147483648 || previous > 2147483647) throw new ProResRawError('DC coefficient overflow');
        block[n * 64] = previous;
    }
    let acBook = 49,
        runBook = 0,
        lengthBook = 66;
    const putAC = (n, value) => {
        if (value >= 2147483647) throw new ProResRawError('AC coefficient overflow');
        block[SCAN[n >> tile.log2Blocks] + ((n & (blocks - 1)) << 6)] = (value + 1) * reader.sign();
    };
    for (let n = blocks; n < count && !ended;) {
        const consecutive = reader.value(lengthBook);
        if (consecutive < 0) break;
        if (consecutive > count - n) throw new ProResRawError('AC run exceeds component');
        for (let i = 0; i < consecutive; i++) {
            const ac = reader.value(acBook);
            if (ac < 0) {
                ended = true;
                break;
            }
            acBook = AC[Math.min(ac, 94)];
            putAC(n++, ac);
        }
        if (ended || n === count) break;
        const run = reader.value(runBook);
        if (run < 0) break;
        runBook = RN[Math.min(run, 27)];
        n += run + 1;
        if (n >= count) break;
        const ac = reader.value(acBook);
        if (ac < 0) break;
        acBook = AC[Math.min(ac, 94)];
        lengthBook = LN[Math.min(ac, 14)];
        putAC(n++, ac);
    }
    for (let n = 0; n < blocks; n++) {
        putBlock(
            block,
            n * 64,
            quantization,
            frame.color.linearizationCurve,
            frame,
            tile.x + n * 16 + (component & 1),
            tile.y + (component > 1 ? 1 : 0),
        );
    }
}

function decodeTile(data, tile, quantization, frame, block, scaled) {
    for (let i = 0; i < 64; i++) scaled[i] = quantization[i] * tile.scale;
    let offset = tile.offset;
    const components = [2, 1, 3, 0];
    for (let i = 0; i < 4; i++) {
        decodeComponent(data, offset, tile.lengths[i], tile, components[i], scaled, frame, block);
        offset += tile.lengths[i];
    }
}

export function decodeProResRaw(data, options = {}) {
    const { frame, tiles, quantization } = parsePacket(data, options);
    const block = new Int32Array(1024);
    const scaled = new Int16Array(64);
    for (const tile of tiles) {
        checkAbort(options.signal);
        decodeTile(data, tile, quantization, frame, block, scaled);
    }
    return frame;
}

export async function decodeProResRawAsync(data, options = {}) {
    checkInput(data, options);
    const batch = options.tilesPerYield ?? 32;
    if (!Number.isInteger(batch) || batch < 1 || batch > 4096)
        throw new ProResRawError('tilesPerYield must be between 1 and 4096', 'LIMIT');
    // A caller can mutate its input while an async decoder yields. Snapshot once.
    const snapshot = data.slice();
    const { frame, tiles, quantization } = parsePacket(snapshot, options);
    const block = new Int32Array(1024);
    const scaled = new Int16Array(64);
    for (let i = 0; i < tiles.length; i++) {
        checkAbort(options.signal);
        decodeTile(snapshot, tiles[i], quantization, frame, block, scaled);
        if ((i + 1) % batch === 0 && i + 1 < tiles.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
    checkAbort(options.signal);
    return frame;
}
