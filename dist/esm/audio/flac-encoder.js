import { EncodeError } from '../core/errors.js';
import { yieldToEventLoop } from './audio-buffer-tools.js';
import { InterleavedPcmQueue } from './streaming-pcm.js';
const BLOCK_SIZE = 4096;
const MAX_LPC_ORDER = 8;
const LPC_PRECISION = 14;
const MAX_PARTITION_ORDER = 6;
const MAX_RICE_PARAM = 14;
const MAX_TOTAL_SAMPLES = 2 ** 36 - 1;
class Md5 {
    state = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
    buffer = new Uint8Array(64);
    buffered = 0;
    totalBytes = 0;
    static S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
        20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
        10, 15, 21,
    ];
    static K = (() => {
        const k = new Int32Array(64);
        for (let i = 0; i < 64; i++)
            k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
        return k;
    })();
    update(data) {
        this.totalBytes += data.length;
        let off = 0;
        if (this.buffered > 0) {
            const take = Math.min(64 - this.buffered, data.length);
            this.buffer.set(data.subarray(0, take), this.buffered);
            this.buffered += take;
            off = take;
            if (this.buffered === 64) {
                this.processBlock(this.buffer, 0);
                this.buffered = 0;
            }
        }
        while (off + 64 <= data.length) {
            this.processBlock(data, off);
            off += 64;
        }
        if (off < data.length) {
            this.buffer.set(data.subarray(off), 0);
            this.buffered = data.length - off;
        }
    }
    digest() {
        const bitLength = this.totalBytes * 8;
        const pad = new Uint8Array((this.buffered < 56 ? 56 : 120) - this.buffered + 8);
        pad[0] = 0x80;
        const lo = bitLength >>> 0;
        const hi = Math.floor(bitLength / 4294967296);
        for (let i = 0; i < 4; i++)
            pad[pad.length - 8 + i] = (lo >>> (i * 8)) & 0xff;
        for (let i = 0; i < 4; i++)
            pad[pad.length - 4 + i] = (hi >>> (i * 8)) & 0xff;
        this.update(pad);
        const out = new Uint8Array(16);
        for (let i = 0; i < 4; i++) {
            const v = this.state[i];
            out[i * 4] = v & 0xff;
            out[i * 4 + 1] = (v >>> 8) & 0xff;
            out[i * 4 + 2] = (v >>> 16) & 0xff;
            out[i * 4 + 3] = (v >>> 24) & 0xff;
        }
        return out;
    }
    processBlock(data, off) {
        const m = new Int32Array(16);
        for (let i = 0; i < 16; i++) {
            const b = off + i * 4;
            m[i] = data[b] | (data[b + 1] << 8) | (data[b + 2] << 16) | (data[b + 3] << 24);
        }
        let [a, b, c, d] = this.state;
        for (let i = 0; i < 64; i++) {
            let f, g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            }
            else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) & 15;
            }
            else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) & 15;
            }
            else {
                f = c ^ (b | ~d);
                g = (7 * i) & 15;
            }
            const tmp = d;
            d = c;
            c = b;
            const sum = (a + f + Md5.K[i] + m[g]) | 0;
            const s = Md5.S[i];
            b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
            a = tmp;
        }
        this.state[0] = (this.state[0] + a) | 0;
        this.state[1] = (this.state[1] + b) | 0;
        this.state[2] = (this.state[2] + c) | 0;
        this.state[3] = (this.state[3] + d) | 0;
    }
}
class FlacBits {
    buf = new Uint8Array(new ArrayBuffer(1 << 10));
    len = 0;
    acc = 0;
    accBits = 0;
    write(value, bits) {
        while (bits > 0) {
            const take = Math.min(bits, 24);
            const chunk = bits > 24 ? Math.floor(value / 2 ** (bits - take)) & ((1 << take) - 1) : value & ((1 << take) - 1);
            this.acc = (this.acc << take) | chunk;
            this.accBits += take;
            bits -= take;
            while (this.accBits >= 8) {
                this.push((this.acc >>> (this.accBits - 8)) & 0xff);
                this.accBits -= 8;
            }
            this.acc &= (1 << this.accBits) - 1;
        }
    }
    writeUnary(value) {
        while (value >= 32) {
            this.write(0, 32);
            value -= 32;
        }
        this.write(1, value + 1);
    }
    alignByte() {
        if (this.accBits > 0)
            this.write(0, 8 - this.accBits);
    }
    get bytePosition() {
        return this.len;
    }
    bytes() {
        return this.buf.subarray(0, this.len);
    }
    push(byte) {
        if (this.len === this.buf.length) {
            const next = new Uint8Array(new ArrayBuffer(this.buf.length * 2));
            next.set(this.buf);
            this.buf = next;
        }
        this.buf[this.len++] = byte;
    }
}
const CRC8_TABLE = (() => {
    const table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        table[i] = crc;
    }
    return table;
})();
const CRC16_TABLE = (() => {
    const table = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i << 8;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
        table[i] = crc;
    }
    return table;
})();
function crc8(data) {
    let crc = 0;
    for (let i = 0; i < data.length; i++)
        crc = CRC8_TABLE[crc ^ data[i]];
    return crc;
}
function crc16(data) {
    let crc = 0;
    for (let i = 0; i < data.length; i++)
        crc = (CRC16_TABLE[(crc >> 8) ^ data[i]] ^ (crc << 8)) & 0xffff;
    return crc;
}
function writeUtf8Number(bits, value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOTAL_SAMPLES) {
        throw new EncodeError(`FLAC frame/sample number is outside the 36-bit range (${value})`);
    }
    if (value < 0x80) {
        bits.write(value, 8);
        return;
    }
    const bytes = [];
    let v = value;
    let mask = 0x80;
    let max = 0x40;
    while (v >= max && max > 1) {
        bytes.unshift(0x80 | (v & 0x3f));
        v = Math.floor(v / 64);
        mask = (mask >> 1) | 0x80;
        max >>= 1;
    }
    bytes.unshift((mask & 0xff) | v);
    for (const byte of bytes)
        bits.write(byte, 8);
}
function fixedResidual(samples, i, order) {
    switch (order) {
        case 0:
            return samples[i];
        case 1:
            return samples[i] - samples[i - 1];
        case 2:
            return samples[i] - 2 * samples[i - 1] + samples[i - 2];
        case 3:
            return samples[i] - 3 * samples[i - 1] + 3 * samples[i - 2] - samples[i - 3];
        default:
            return samples[i] - 4 * samples[i - 1] + 6 * samples[i - 2] - 4 * samples[i - 3] + samples[i - 4];
    }
}
function computeLpc(samples, maxOrder) {
    const n = samples.length;
    if (n <= maxOrder * 2)
        return null;
    const windowed = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const w = 1 - ((i - (n - 1) / 2) / ((n + 1) / 2)) ** 2;
        windowed[i] = samples[i] * w;
    }
    const autoc = new Float64Array(maxOrder + 1);
    for (let lag = 0; lag <= maxOrder; lag++) {
        let sum = 0;
        for (let i = lag; i < n; i++)
            sum += windowed[i] * windowed[i - lag];
        autoc[lag] = sum;
    }
    if (autoc[0] <= 0)
        return null;
    const lpc = new Float64Array(maxOrder);
    let error = autoc[0];
    let order = 0;
    for (let i = 0; i < maxOrder; i++) {
        let acc = autoc[i + 1];
        for (let j = 0; j < i; j++)
            acc -= lpc[j] * autoc[i - j];
        const reflection = acc / error;
        error *= 1 - reflection * reflection;
        lpc[i] = reflection;
        for (let j = 0; j < i >> 1; j++) {
            const tmp = lpc[j];
            lpc[j] = tmp - reflection * lpc[i - 1 - j];
            lpc[i - 1 - j] -= reflection * tmp;
        }
        if (i & 1)
            lpc[i >> 1] -= lpc[i >> 1] * reflection;
        order = i + 1;
        if (error <= 0)
            break;
    }
    if (order === 0)
        return null;
    let maxCoef = 0;
    for (let i = 0; i < order; i++)
        maxCoef = Math.max(maxCoef, Math.abs(lpc[i]));
    if (!(maxCoef > 0) || !Number.isFinite(maxCoef))
        return null;
    let shift = LPC_PRECISION - 1 - Math.max(0, Math.floor(Math.log2(maxCoef)) + 1);
    shift = Math.max(1, Math.min(15, shift));
    const limit = (1 << (LPC_PRECISION - 1)) - 1;
    const coefficients = new Int32Array(order);
    let err = 0;
    for (let i = 0; i < order; i++) {
        const ideal = lpc[i] * (1 << shift) + err;
        let q = Math.round(ideal);
        if (q > limit)
            q = limit;
        else if (q < -limit - 1)
            q = -limit - 1;
        err = ideal - q;
        coefficients[i] = q;
    }
    return { order, shift, coefficients };
}
function lpcResiduals(samples, model, out) {
    const { order, shift, coefficients } = model;
    for (let i = order; i < samples.length; i++) {
        let prediction = 0;
        for (let j = 0; j < order; j++)
            prediction += coefficients[j] * samples[i - 1 - j];
        out[i - order] = samples[i] - Math.floor(prediction / (1 << shift));
    }
}
function riceParamFor(sumAbs, count) {
    if (count === 0 || sumAbs === 0)
        return 0;
    const mean = sumAbs / count;
    let k = 0;
    while (1 << (k + 1) < mean * 2 && k < MAX_RICE_PARAM)
        k++;
    return k;
}
function riceCost(residuals, start, end, k) {
    let bits = 0;
    for (let i = start; i < end; i++) {
        const v = residuals[i];
        const zigzag = v >= 0 ? v * 2 : -v * 2 - 1;
        bits += (zigzag >>> k) + 1 + k;
    }
    return bits;
}
function planRice(residuals, blockSize, predictorOrder) {
    let best = null;
    for (let po = 0; po <= MAX_PARTITION_ORDER; po++) {
        const partitions = 1 << po;
        if (blockSize % partitions !== 0)
            continue;
        const partSize = blockSize / partitions;
        if (partSize <= predictorOrder)
            break;
        const params = [];
        let bits = po === 0 ? 0 : 0;
        let ok = true;
        for (let p = 0; p < partitions; p++) {
            const start = p === 0 ? 0 : p * partSize - predictorOrder;
            const end = (p + 1) * partSize - predictorOrder;
            if (end > residuals.length) {
                ok = false;
                break;
            }
            let sumAbs = 0;
            for (let i = start; i < end; i++)
                sumAbs += Math.abs(residuals[i]);
            let k = riceParamFor(sumAbs, end - start);
            let cost = riceCost(residuals, start, end, k);
            if (k > 0) {
                const lower = riceCost(residuals, start, end, k - 1);
                if (lower < cost) {
                    k--;
                    cost = lower;
                }
            }
            if (k + 1 <= MAX_RICE_PARAM) {
                const higher = riceCost(residuals, start, end, k + 1);
                if (higher < cost) {
                    k++;
                    cost = higher;
                }
            }
            params.push(k);
            bits += 4 + cost;
        }
        if (!ok)
            continue;
        const total = bits + 3;
        if (!best || total < best.bits)
            best = { partitionOrder: po, params, bits: total };
    }
    if (!best)
        throw new EncodeError('FLAC: no valid Rice partitioning');
    return best;
}
function writeResidual(bits, residuals, plan, blockSize, predictorOrder) {
    bits.write(0, 2);
    bits.write(plan.partitionOrder, 4);
    const partitions = 1 << plan.partitionOrder;
    const partSize = blockSize / partitions;
    for (let p = 0; p < partitions; p++) {
        const k = plan.params[p];
        bits.write(k, 4);
        const start = p === 0 ? 0 : p * partSize - predictorOrder;
        const end = (p + 1) * partSize - predictorOrder;
        for (let i = start; i < end; i++) {
            const v = residuals[i];
            const zigzag = v >= 0 ? v * 2 : -v * 2 - 1;
            bits.writeUnary(zigzag >>> k);
            if (k > 0)
                bits.write(zigzag & ((1 << k) - 1), k);
        }
    }
}
function planSubframe(samples, sampleBits) {
    const n = samples.length;
    let constant = true;
    for (let i = 1; i < n; i++) {
        if (samples[i] !== samples[0]) {
            constant = false;
            break;
        }
    }
    if (constant) {
        return {
            kind: 'constant',
            order: 0,
            lpc: null,
            residuals: new Int32Array(0),
            rice: null,
            bits: 8 + sampleBits,
        };
    }
    let best = {
        kind: 'verbatim',
        order: 0,
        lpc: null,
        residuals: new Int32Array(0),
        rice: null,
        bits: 8 + n * sampleBits,
    };
    let bestFixedOrder = 0;
    let bestFixedCost = Number.POSITIVE_INFINITY;
    for (let order = 0; order <= 4 && order < n; order++) {
        let cost = 0;
        for (let i = order; i < n; i++)
            cost += Math.abs(fixedResidual(samples, i, order));
        if (cost < bestFixedCost) {
            bestFixedCost = cost;
            bestFixedOrder = order;
        }
    }
    {
        const order = bestFixedOrder;
        const residuals = new Int32Array(n - order);
        for (let i = order; i < n; i++)
            residuals[i - order] = fixedResidual(samples, i, order);
        const rice = planRice(residuals, n, order);
        const bits = 8 + order * sampleBits + rice.bits;
        if (bits < best.bits)
            best = { kind: 'fixed', order, lpc: null, residuals, rice, bits };
    }
    const lpc = computeLpc(samples, Math.min(MAX_LPC_ORDER, n >> 1));
    if (lpc) {
        const residuals = new Int32Array(n - lpc.order);
        lpcResiduals(samples, lpc, residuals);
        const rice = planRice(residuals, n, lpc.order);
        const bits = 8 + lpc.order * sampleBits + 4 + 5 + lpc.order * LPC_PRECISION + rice.bits;
        if (bits < best.bits)
            best = { kind: 'lpc', order: lpc.order, lpc, residuals, rice, bits };
    }
    return best;
}
function writeSubframe(bits, samples, plan, sampleBits) {
    bits.write(0, 1);
    if (plan.kind === 'constant') {
        bits.write(0, 6);
        bits.write(0, 1);
        bits.write(samples[0] & ((1 << sampleBits) - 1), sampleBits);
        return;
    }
    if (plan.kind === 'verbatim') {
        bits.write(1, 6);
        bits.write(0, 1);
        const mask = (1 << sampleBits) - 1;
        for (let i = 0; i < samples.length; i++)
            bits.write(samples[i] & mask, sampleBits);
        return;
    }
    const mask = (1 << sampleBits) - 1;
    if (plan.kind === 'fixed') {
        bits.write(0b001000 | plan.order, 6);
        bits.write(0, 1);
        for (let i = 0; i < plan.order; i++)
            bits.write(samples[i] & mask, sampleBits);
        writeResidual(bits, plan.residuals, plan.rice, samples.length, plan.order);
        return;
    }
    const lpc = plan.lpc;
    bits.write(0b100000 | (lpc.order - 1), 6);
    bits.write(0, 1);
    for (let i = 0; i < lpc.order; i++)
        bits.write(samples[i] & mask, sampleBits);
    bits.write(LPC_PRECISION - 1, 4);
    bits.write(lpc.shift, 5);
    const coefMask = (1 << LPC_PRECISION) - 1;
    for (let i = 0; i < lpc.order; i++)
        bits.write(lpc.coefficients[i] & coefMask, LPC_PRECISION);
    writeResidual(bits, plan.residuals, plan.rice, samples.length, lpc.order);
}
function sampleRateCode(rate) {
    switch (rate) {
        case 88200:
            return { code: 1, tail: 'none' };
        case 176400:
            return { code: 2, tail: 'none' };
        case 192000:
            return { code: 3, tail: 'none' };
        case 8000:
            return { code: 4, tail: 'none' };
        case 16000:
            return { code: 5, tail: 'none' };
        case 22050:
            return { code: 6, tail: 'none' };
        case 24000:
            return { code: 7, tail: 'none' };
        case 32000:
            return { code: 8, tail: 'none' };
        case 44100:
            return { code: 9, tail: 'none' };
        case 48000:
            return { code: 10, tail: 'none' };
        case 96000:
            return { code: 11, tail: 'none' };
        default:
            if (rate % 1000 === 0 && rate / 1000 <= 0xff) {
                return { code: 12, tail: 'khz8', value: rate / 1000 };
            }
            if (rate <= 0xffff)
                return { code: 13, tail: 'hz16', value: rate };
            if (rate % 10 === 0 && rate / 10 <= 0xffff) {
                return { code: 14, tail: 'tensHz16', value: rate / 10 };
            }
            return { code: 0, tail: 'none' };
    }
}
function quantizePcm16(value) {
    let sample = Math.round((value >= 1 ? 1 : value <= -1 ? -1 : value) * 32767);
    if (sample > 32767)
        sample = 32767;
    else if (sample < -32768)
        sample = -32768;
    return sample;
}
class FlacFrameCore {
    sampleRate;
    channels;
    quantized = [];
    mid = new Int32Array(BLOCK_SIZE);
    side = new Int32Array(BLOCK_SIZE);
    constructor(sampleRate, channels) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        for (let channel = 0; channel < channels; channel++) {
            this.quantized.push(new Int32Array(BLOCK_SIZE));
        }
    }
    encode(pcm, blockSize, frameIndex) {
        const blocks = [];
        for (let channel = 0; channel < this.channels; channel++) {
            blocks.push(this.quantized[channel].subarray(0, blockSize));
        }
        for (let frame = 0; frame < blockSize; frame++) {
            for (let channel = 0; channel < this.channels; channel++) {
                blocks[channel][frame] = quantizePcm16(pcm[frame * this.channels + channel]);
            }
        }
        let channelAssignment = this.channels - 1;
        let plans;
        let subframeBits;
        if (this.channels === 2) {
            const left = blocks[0];
            const right = blocks[1];
            const middle = this.mid.subarray(0, blockSize);
            const difference = this.side.subarray(0, blockSize);
            for (let frame = 0; frame < blockSize; frame++) {
                difference[frame] = left[frame] - right[frame];
                middle[frame] = (left[frame] + right[frame]) >> 1;
            }
            const planL = planSubframe(left, 16);
            const planR = planSubframe(right, 16);
            const planM = planSubframe(middle, 16);
            const planS = planSubframe(difference, 17);
            const modes = [
                { assignment: 1, plans: [planL, planR], bits: [16, 16], cost: planL.bits + planR.bits },
                { assignment: 8, plans: [planL, planS], bits: [16, 17], cost: planL.bits + planS.bits },
                { assignment: 9, plans: [planS, planR], bits: [17, 16], cost: planS.bits + planR.bits },
                { assignment: 10, plans: [planM, planS], bits: [16, 17], cost: planM.bits + planS.bits },
            ];
            modes.sort((a, b) => a.cost - b.cost);
            channelAssignment = modes[0].assignment;
            plans = modes[0].plans;
            subframeBits = modes[0].bits;
        }
        else {
            plans = blocks.map(block => planSubframe(block, 16));
            subframeBits = blocks.map(() => 16);
        }
        const frame = new FlacBits();
        frame.write(0b11111111111110, 14);
        frame.write(0, 1);
        frame.write(0, 1);
        const partialBlock = blockSize !== BLOCK_SIZE;
        frame.write(partialBlock ? 7 : 12, 4);
        const rate = sampleRateCode(this.sampleRate);
        frame.write(rate.code, 4);
        frame.write(channelAssignment, 4);
        frame.write(4, 3);
        frame.write(0, 1);
        writeUtf8Number(frame, frameIndex);
        if (partialBlock)
            frame.write(blockSize - 1, 16);
        if (rate.tail === 'khz8')
            frame.write(rate.value, 8);
        else if (rate.tail === 'hz16' || rate.tail === 'tensHz16') {
            frame.write(rate.value, 16);
        }
        frame.write(crc8(frame.bytes()), 8);
        if (this.channels === 2) {
            const sources = channelAssignment === 1
                ? [blocks[0], blocks[1]]
                : channelAssignment === 8
                    ? [blocks[0], this.side.subarray(0, blockSize)]
                    : channelAssignment === 9
                        ? [this.side.subarray(0, blockSize), blocks[1]]
                        : [this.mid.subarray(0, blockSize), this.side.subarray(0, blockSize)];
            for (let channel = 0; channel < 2; channel++) {
                writeSubframe(frame, sources[channel], plans[channel], subframeBits[channel]);
            }
        }
        else {
            for (let channel = 0; channel < this.channels; channel++) {
                writeSubframe(frame, blocks[channel], plans[channel], subframeBits[channel]);
            }
        }
        frame.alignByte();
        frame.write(crc16(frame.bytes()), 16);
        return frame.bytes().slice();
    }
}
export class StreamingFlacEncoder {
    sampleRate;
    channels;
    options;
    queue;
    core;
    md5 = new Md5();
    md5Scratch;
    encodedFrames;
    expectedCodecFrames;
    totalInputFrames = 0;
    frameIndex = 0;
    minFrameSize = Number.POSITIVE_INFINITY;
    maxFrameSize = 0;
    sealed = false;
    constructor(sampleRate, channels, options = {}) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.options = options;
        if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
            throw new EncodeError(`encodeFlac: unsupported channel count ${channels}`);
        }
        if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 655350) {
            throw new EncodeError(`encodeFlac: unsupported sample rate ${sampleRate}`);
        }
        sampleRateCode(sampleRate);
        if (options.expectedInputFrames !== undefined &&
            (!Number.isSafeInteger(options.expectedInputFrames) ||
                options.expectedInputFrames < 0 ||
                options.expectedInputFrames > MAX_TOTAL_SAMPLES)) {
            throw new EncodeError(`encodeFlac: expected sample count is invalid or exceeds the FLAC 36-bit limit (${options.expectedInputFrames})`);
        }
        this.queue = new InterleavedPcmQueue(channels);
        this.core = new FlacFrameCore(sampleRate, channels);
        this.md5Scratch = new Uint8Array(new ArrayBuffer(BLOCK_SIZE * channels * 2));
        this.encodedFrames = options.collectFrames === false ? null : [];
        this.expectedCodecFrames =
            options.expectedInputFrames === undefined
                ? null
                : Math.ceil(Math.max(0, options.expectedInputFrames) / BLOCK_SIZE);
    }
    get framesReceived() {
        return this.totalInputFrames;
    }
    get framesProduced() {
        return this.frameIndex;
    }
    get peakBufferedFrames() {
        return this.queue.peakBufferedFrames;
    }
    pushPlanar(planes) {
        this.assertOpen();
        if (planes.length !== this.channels) {
            throw new EncodeError(`FLAC expected ${this.channels} channels, got ${planes.length}`);
        }
        const frames = planes[0]?.length ?? 0;
        for (let channel = 1; channel < planes.length; channel++) {
            if (planes[channel].length !== frames) {
                throw new EncodeError('FLAC PCM channel planes have different lengths');
            }
        }
        if (frames === 0)
            return;
        this.reserveInputFrames(frames);
        for (let start = 0; start < frames; start += BLOCK_SIZE) {
            const count = Math.min(BLOCK_SIZE, frames - start);
            const interleaved = new Float32Array(count * this.channels);
            let at = 0;
            for (let frame = 0; frame < count; frame++) {
                for (let channel = 0; channel < this.channels; channel++) {
                    interleaved[at++] = planes[channel][start + frame];
                }
            }
            this.consumeInterleaved(interleaved);
        }
    }
    pushInterleaved(pcm) {
        this.assertOpen();
        if (pcm.length % this.channels !== 0) {
            throw new EncodeError('FLAC PCM input is not channel-aligned');
        }
        const frames = pcm.length / this.channels;
        if (frames === 0)
            return;
        this.reserveInputFrames(frames);
        this.consumeInterleaved(pcm);
    }
    reserveInputFrames(frames) {
        if (frames > MAX_TOTAL_SAMPLES - this.totalInputFrames) {
            throw new EncodeError(`encodeFlac: total sample count exceeds the FLAC 36-bit limit (${MAX_TOTAL_SAMPLES})`);
        }
        this.totalInputFrames += frames;
    }
    consumeInterleaved(pcm) {
        let sampleOffset = 0;
        let remainingFrames = pcm.length / this.channels;
        if (this.queue.bufferedFrames > 0) {
            const takeFrames = Math.min(BLOCK_SIZE - this.queue.bufferedFrames, remainingFrames);
            const takeSamples = takeFrames * this.channels;
            const owned = pcm.slice(sampleOffset, sampleOffset + takeSamples);
            this.updateMd5Block(owned);
            this.queue.pushInterleaved(owned);
            sampleOffset += takeSamples;
            remainingFrames -= takeFrames;
            if (this.queue.bufferedFrames === BLOCK_SIZE) {
                this.emit(this.queue.takeFrames(BLOCK_SIZE), BLOCK_SIZE);
            }
        }
        while (remainingFrames >= BLOCK_SIZE) {
            const samples = BLOCK_SIZE * this.channels;
            const block = pcm.subarray(sampleOffset, sampleOffset + samples);
            this.updateMd5Block(block);
            this.emit(block, BLOCK_SIZE);
            sampleOffset += samples;
            remainingFrames -= BLOCK_SIZE;
        }
        if (remainingFrames > 0) {
            const owned = pcm.slice(sampleOffset);
            this.updateMd5Block(owned);
            this.queue.pushInterleaved(owned);
        }
    }
    updateMd5Block(pcm) {
        if (pcm.length > BLOCK_SIZE * this.channels) {
            throw new EncodeError('FLAC internal PCM block exceeds the codec block size');
        }
        let at = 0;
        for (let sampleIndex = 0; sampleIndex < pcm.length; sampleIndex++) {
            const sample = quantizePcm16(pcm[sampleIndex]);
            this.md5Scratch[at++] = sample & 0xff;
            this.md5Scratch[at++] = (sample >> 8) & 0xff;
        }
        this.md5.update(this.md5Scratch.subarray(0, at));
    }
    finish() {
        const parts = this.finishParts();
        const total = parts.reduce((sum, part) => sum + part.length, 0);
        const output = new Uint8Array(new ArrayBuffer(total));
        let at = 0;
        for (const part of parts) {
            output.set(part, at);
            at += part.length;
        }
        return output;
    }
    finishBlob() {
        return new Blob(this.finishParts(), { type: 'audio/flac' });
    }
    finishHeader() {
        this.assertOpen();
        this.sealed = true;
        if (this.totalInputFrames === 0)
            throw new EncodeError('encodeFlac: empty input');
        if (this.queue.bufferedFrames > 0) {
            const frames = this.queue.bufferedFrames;
            this.emit(this.queue.takeFrames(frames), frames);
        }
        return this.buildHeader();
    }
    finishParts() {
        const header = this.finishHeader();
        return [header, ...(this.encodedFrames ?? [])];
    }
    assertOpen() {
        if (this.sealed)
            throw new EncodeError('FLAC encoder received PCM after finish');
        this.options.signal?.throwIfAborted();
    }
    emit(pcm, blockSize) {
        const frame = this.core.encode(pcm, blockSize, this.frameIndex);
        this.encodedFrames?.push(frame);
        this.options.onFrame?.(frame, this.frameIndex);
        this.frameIndex++;
        this.minFrameSize = Math.min(this.minFrameSize, frame.length);
        this.maxFrameSize = Math.max(this.maxFrameSize, frame.length);
        this.options.onProgress?.(this.frameIndex, this.expectedCodecFrames ?? this.frameIndex);
    }
    buildHeader() {
        const output = new FlacBits();
        output.write(0x66, 8);
        output.write(0x4c, 8);
        output.write(0x61, 8);
        output.write(0x43, 8);
        output.write(1, 1);
        output.write(0, 7);
        output.write(34, 24);
        output.write(BLOCK_SIZE, 16);
        output.write(BLOCK_SIZE, 16);
        output.write(this.minFrameSize, 24);
        output.write(this.maxFrameSize, 24);
        output.write(this.sampleRate, 20);
        output.write(this.channels - 1, 3);
        output.write(15, 5);
        output.write(Math.floor(this.totalInputFrames / 4294967296) & 0xf, 4);
        output.write(this.totalInputFrames >>> 0, 32);
        const digest = this.md5.digest();
        for (let index = 0; index < 16; index++)
            output.write(digest[index], 8);
        return output.bytes().slice();
    }
}
function* encodeFlacStreamingFrames(pcm, sampleRate, channels, options) {
    if (pcm.length % channels !== 0) {
        throw new EncodeError('encodeFlac: PCM input is not channel-aligned');
    }
    const totalFrames = pcm.length / channels;
    const encoder = new StreamingFlacEncoder(sampleRate, channels, {
        ...options,
        expectedInputFrames: totalFrames,
    });
    const samplesPerBlock = BLOCK_SIZE * channels;
    for (let at = 0; at < pcm.length; at += samplesPerBlock) {
        options.signal?.throwIfAborted();
        encoder.pushInterleaved(pcm.subarray(at, Math.min(pcm.length, at + samplesPerBlock)));
        yield;
    }
    return encoder.finish();
}
export function encodeFlac(pcm, sampleRate, channels, options = {}) {
    const it = encodeFlacStreamingFrames(pcm, sampleRate, channels, options);
    for (;;) {
        const step = it.next();
        if (step.done)
            return step.value;
    }
}
export async function encodeFlacAsync(pcm, sampleRate, channels, options = {}) {
    const it = encodeFlacStreamingFrames(pcm, sampleRate, channels, options);
    for (;;) {
        const step = it.next();
        if (step.done)
            return step.value;
        options.signal?.throwIfAborted();
        await yieldToEventLoop();
        options.signal?.throwIfAborted();
    }
}
