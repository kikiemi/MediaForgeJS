import { DecodeError, MediaForgeError } from '../core/errors.js';
import { AAC_SAMPLE_RATES, SWB_OFFSET_1024, SWB_OFFSET_128, SF_HUFF_BITS, SF_HUFF_CODES, SPECTRAL_BOOKS, TNS_MAX_BANDS_1024, TNS_MAX_BANDS_128, } from './aac-tables.js';
const FRAME_LEN = 1024;
const SHORT_LEN = 128;
const SF_OFFSET = 100;
const NOISE_OFFSET = 90;
const LONG_START = 1;
const EIGHT_SHORT = 2;
const LONG_STOP = 3;
const ZERO_HCB = 0;
const NOISE_HCB = 13;
const INTENSITY_HCB2 = 14;
const INTENSITY_HCB = 15;
class BitReader {
    bytes;
    pos = 0;
    constructor(bytes) {
        this.bytes = bytes;
    }
    read(bits) {
        let value = 0;
        while (bits > 0) {
            const byteIndex = this.pos >> 3;
            if (byteIndex >= this.bytes.length)
                throw new DecodeError('AAC: bitstream exhausted');
            const bitOffset = this.pos & 7;
            const take = Math.min(bits, 8 - bitOffset);
            const chunk = (this.bytes[byteIndex] >> (8 - bitOffset - take)) & ((1 << take) - 1);
            value = (value << take) | chunk;
            this.pos += take;
            bits -= take;
        }
        return value >>> 0;
    }
    readBit() {
        return this.read(1);
    }
    skip(bits) {
        this.pos += bits;
        if (this.pos > this.bytes.length * 8)
            throw new DecodeError('AAC: bitstream exhausted');
    }
    bitsLeft() {
        return this.bytes.length * 8 - this.pos;
    }
    bitsRead() {
        return this.pos;
    }
    align() {
        this.pos = (this.pos + 7) & ~7;
    }
}
function buildHuffTree(codes, bits) {
    const tree = new Int32Array(codes.length * 4).fill(0);
    let nextNode = 1;
    for (let sym = 0; sym < codes.length; sym++) {
        const length = bits[sym];
        let node = 0;
        for (let b = length - 1; b >= 0; b--) {
            const bit = (codes[sym] >>> b) & 1;
            const slot = node * 2 + bit;
            if (b === 0) {
                tree[slot] = -(sym + 1);
            }
            else {
                if (tree[slot] === 0)
                    tree[slot] = nextNode++;
                node = tree[slot];
            }
        }
    }
    return tree;
}
function huffDecode(reader, tree) {
    let node = 0;
    for (;;) {
        const slot = node * 2 + reader.readBit();
        const entry = tree[slot];
        if (entry < 0)
            return -entry - 1;
        if (entry === 0)
            throw new DecodeError('AAC: invalid huffman code');
        node = entry;
    }
}
const SF_TREE = buildHuffTree(SF_HUFF_CODES, SF_HUFF_BITS);
const SPECTRAL_TREES = SPECTRAL_BOOKS.map(book => book ? buildHuffTree(book.codes, book.bits) : null);
function besselI0(x) {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 40; k++) {
        term *= (x * x) / (4 * k * k);
        sum += term;
        if (term < 1e-18 * sum)
            break;
    }
    return sum;
}
function kbdWindow(n, alpha) {
    const kernel = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
        const t = (2 * i) / n - 1;
        kernel[i] = besselI0(Math.PI * alpha * Math.sqrt(Math.max(0, 1 - t * t)));
    }
    let total = 0;
    for (let i = 0; i <= n; i++)
        total += kernel[i];
    const w = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
        acc += kernel[i];
        w[i] = Math.sqrt(acc / total);
    }
    return w;
}
function sineWindow(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++)
        w[i] = Math.sin((Math.PI / (2 * n)) * (i + 0.5));
    return w;
}
const SINE_LONG = sineWindow(FRAME_LEN);
const SINE_SHORT = sineWindow(SHORT_LEN);
const KBD_LONG = kbdWindow(FRAME_LEN, 4);
const KBD_SHORT = kbdWindow(SHORT_LEN, 6);
function risingWindow(shape, short) {
    return short ? (shape ? KBD_SHORT : SINE_SHORT) : shape ? KBD_LONG : SINE_LONG;
}
class Imdct {
    n;
    wr;
    wi;
    rev;
    preR;
    preI;
    postR;
    postI;
    re;
    im;
    constructor(n) {
        this.n = n;
        const n0 = n / 4 + 0.5;
        this.wr = new Float64Array(n / 2);
        this.wi = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            const a = (-2 * Math.PI * i) / n;
            this.wr[i] = Math.cos(a);
            this.wi[i] = Math.sin(a);
        }
        this.rev = new Uint32Array(n);
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1)
                j ^= bit;
            j ^= bit;
            this.rev[i] = j;
        }
        this.preR = new Float64Array(n / 2);
        this.preI = new Float64Array(n / 2);
        for (let k = 0; k < n / 2; k++) {
            const a = (2 * Math.PI * k * n0) / n;
            this.preR[k] = Math.cos(a);
            this.preI[k] = Math.sin(a);
        }
        this.postR = new Float64Array(n);
        this.postI = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const a = (Math.PI * (i + n0)) / n;
            this.postR[i] = Math.cos(a);
            this.postI[i] = Math.sin(a);
        }
        this.re = new Float64Array(n);
        this.im = new Float64Array(n);
    }
    run(spectrum, out) {
        const { n, re, im, preR, preI, postR, postI, wr, wi, rev } = this;
        const half = n >> 1;
        re.fill(0);
        im.fill(0);
        for (let k = 0; k < half; k++) {
            re[k] = spectrum[k] * preR[k];
            im[k] = -spectrum[k] * preI[k];
        }
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (i < j) {
                const tr = re[i];
                re[i] = re[j];
                re[j] = tr;
                const ti = im[i];
                im[i] = im[j];
                im[j] = ti;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const h = len >> 1;
            const step = n / len;
            for (let base = 0; base < n; base += len) {
                for (let j = 0; j < h; j++) {
                    const cr = wr[j * step];
                    const ci = wi[j * step];
                    const p = base + j;
                    const q = p + h;
                    const xr = re[q] * cr - im[q] * ci;
                    const xi = re[q] * ci + im[q] * cr;
                    re[q] = re[p] - xr;
                    im[q] = im[p] - xi;
                    re[p] += xr;
                    im[p] += xi;
                }
            }
        }
        for (let i = 0; i < n; i++) {
            out[i] = re[i] * postR[i] + im[i] * postI[i];
        }
    }
}
export class AacLcDecoder {
    srIndex;
    swbLong;
    swbShort;
    imdctLong = new Imdct(2 * FRAME_LEN);
    imdctShort = new Imdct(2 * SHORT_LEN);
    states = [];
    static newChannelState() {
        return {
            spectrum: new Float64Array(FRAME_LEN),
            overlap: new Float64Array(FRAME_LEN),
            prevShape: 0,
            bandCodebooks: new Int32Array(8 * 64),
            scalefactors: new Int32Array(8 * 64),
            info: { windowSequence: 0, windowShape: 0, maxSfb: 0, groupCount: 1, groupLengths: [1] },
            tns: null,
        };
    }
    windowedLong = new Float64Array(2 * FRAME_LEN);
    windowedShort = new Float64Array(2 * SHORT_LEN);
    noiseSeed = 0x1f2e3d4c;
    sampleRate;
    channels;
    constructor(sampleRate, channels) {
        this.srIndex = AAC_SAMPLE_RATES.indexOf(sampleRate);
        if (this.srIndex < 0)
            throw new DecodeError(`AAC: unsupported sample rate ${sampleRate}`);
        if (channels < 1 || channels > 2)
            throw new DecodeError(`AAC: unsupported channel count ${channels}`);
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.swbLong = SWB_OFFSET_1024[this.srIndex];
        this.swbShort = SWB_OFFSET_128[this.srIndex];
        for (let c = 0; c < channels; c++) {
            this.states.push(AacLcDecoder.newChannelState());
        }
    }
    lastBitsConsumed = 0;
    lastCodedBands = 0;
    decodeFrame(accessUnit) {
        const reader = new BitReader(accessUnit);
        let decodedChannels = 0;
        this.lastCodedBands = 0;
        for (;;) {
            if (reader.bitsLeft() < 3)
                break;
            const id = reader.read(3);
            if (id === 7)
                break;
            if (id === 0) {
                this.decodeSce(reader, this.states[Math.min(decodedChannels, this.states.length - 1)]);
                decodedChannels += 1;
            }
            else if (id === 1) {
                while (this.states.length < 2)
                    this.states.push(AacLcDecoder.newChannelState());
                this.decodeCpe(reader, this.states[0], this.states[1]);
                decodedChannels += 2;
            }
            else if (id === 4) {
                reader.read(4);
                const align = reader.readBit();
                let count = reader.read(8);
                if (count === 255)
                    count += reader.read(8);
                if (align)
                    reader.align();
                reader.skip(count * 8);
            }
            else if (id === 6) {
                let count = reader.read(4);
                if (count === 15)
                    count += reader.read(8) - 1;
                reader.skip(count * 8);
            }
            else if (id === 5) {
                this.readProgramConfig(reader);
            }
            else {
                throw new DecodeError(`AAC: unsupported syntax element ${id}`);
            }
            if (decodedChannels >= this.channels) {
                break;
            }
        }
        if (decodedChannels < this.channels) {
            throw new DecodeError('AAC: frame is missing channel elements');
        }
        const out = [];
        for (let c = 0; c < this.channels; c++) {
            out.push(this.filterbank(this.states[c]));
        }
        this.lastBitsConsumed = reader.bitsRead();
        return out;
    }
    readProgramConfig(reader) {
        reader.read(4);
        const objectType = reader.read(2);
        reader.read(4);
        const numFront = reader.read(4);
        const numSide = reader.read(4);
        const numBack = reader.read(4);
        const numLfe = reader.read(2);
        const numAssocData = reader.read(3);
        const numValidCc = reader.read(4);
        if (reader.readBit())
            reader.read(4);
        if (reader.readBit())
            reader.read(4);
        if (reader.readBit())
            reader.read(3);
        let declaredChannels = 0;
        for (let i = 0; i < numFront + numSide + numBack; i++) {
            const isCpe = reader.readBit();
            reader.read(4);
            declaredChannels += isCpe ? 2 : 1;
        }
        declaredChannels += numLfe;
        for (let i = 0; i < numLfe; i++)
            reader.read(4);
        for (let i = 0; i < numAssocData; i++)
            reader.read(4);
        for (let i = 0; i < numValidCc; i++) {
            reader.readBit();
            reader.read(4);
        }
        reader.align();
        const commentBytes = reader.read(8);
        reader.skip(commentBytes * 8);
        while (this.states.length < declaredChannels && this.states.length < 8) {
            this.states.push(AacLcDecoder.newChannelState());
        }
        if (objectType > 3) {
            throw new DecodeError(`AAC: program config declares object type ${objectType} (only AAC-LC and below are decoded)`);
        }
    }
    decodeSce(reader, state) {
        reader.read(4);
        this.decodeIcs(reader, state, null, false);
    }
    decodeCpe(reader, left, right) {
        reader.read(4);
        const commonWindow = reader.readBit();
        let msMaskPresent = 0;
        let msUsed = null;
        if (commonWindow) {
            const info = this.readIcsInfo(reader);
            left.info = info;
            right.info = { ...info, groupLengths: info.groupLengths.slice() };
            msMaskPresent = reader.read(2);
            if (msMaskPresent === 1) {
                msUsed = new Uint8Array(info.groupCount * info.maxSfb);
                for (let i = 0; i < msUsed.length; i++)
                    msUsed[i] = reader.readBit();
            }
            this.decodeIcs(reader, left, info, true);
            this.decodeIcs(reader, right, info, true);
        }
        else {
            this.decodeIcs(reader, left, null, false);
            this.decodeIcs(reader, right, null, false);
        }
        this.applyStereo(left, right, msMaskPresent, msUsed);
    }
    readIcsInfo(reader) {
        reader.readBit();
        const windowSequence = reader.read(2);
        const windowShape = reader.readBit();
        let maxSfb;
        let groupCount = 1;
        const groupLengths = [];
        if (windowSequence === EIGHT_SHORT) {
            maxSfb = reader.read(4);
            const grouping = reader.read(7);
            let length = 1;
            for (let bit = 6; bit >= 0; bit--) {
                if ((grouping >> bit) & 1) {
                    length++;
                }
                else {
                    groupLengths.push(length);
                    length = 1;
                }
            }
            groupLengths.push(length);
            groupCount = groupLengths.length;
        }
        else {
            maxSfb = reader.read(6);
            const predictorDataPresent = reader.readBit();
            if (predictorDataPresent)
                throw new DecodeError('AAC: prediction/LTP is not supported');
            groupLengths.push(1);
        }
        return { windowSequence, windowShape, maxSfb, groupCount, groupLengths };
    }
    bandOffsets(info) {
        return info.windowSequence === EIGHT_SHORT ? this.swbShort : this.swbLong;
    }
    decodeIcs(reader, state, sharedInfo, commonWindow) {
        const globalGain = reader.read(8);
        const info = commonWindow && sharedInfo ? state.info : this.readIcsInfo(reader);
        state.info = info;
        this.lastCodedBands += info.maxSfb * info.groupCount;
        const shortWindows = info.windowSequence === EIGHT_SHORT;
        const offsets = this.bandOffsets(info);
        const swbCount = offsets.length - 1;
        if (info.maxSfb > swbCount)
            throw new DecodeError('AAC: max_sfb exceeds band table');
        const cb = state.bandCodebooks;
        cb.fill(0);
        const lenBits = shortWindows ? 3 : 5;
        const escVal = (1 << lenBits) - 1;
        for (let g = 0; g < info.groupCount; g++) {
            let sfb = 0;
            while (sfb < info.maxSfb) {
                const bookIndex = reader.read(4);
                let run = 0;
                for (;;) {
                    const inc = reader.read(lenBits);
                    run += inc;
                    if (inc !== escVal)
                        break;
                }
                if (sfb + run > info.maxSfb)
                    throw new DecodeError('AAC: section overruns max_sfb');
                for (let i = 0; i < run; i++)
                    cb[g * 64 + sfb + i] = bookIndex;
                sfb += run;
            }
        }
        const sf = state.scalefactors;
        let sfAcc = globalGain;
        let noiseAcc = globalGain - NOISE_OFFSET;
        let isAcc = 0;
        let noiseSeen = false;
        for (let g = 0; g < info.groupCount; g++) {
            for (let sfb = 0; sfb < info.maxSfb; sfb++) {
                const book = cb[g * 64 + sfb];
                if (book === ZERO_HCB) {
                    sf[g * 64 + sfb] = 0;
                }
                else if (book === INTENSITY_HCB || book === INTENSITY_HCB2) {
                    isAcc += huffDecode(reader, SF_TREE) - 60;
                    sf[g * 64 + sfb] = isAcc;
                }
                else if (book === NOISE_HCB) {
                    if (!noiseSeen) {
                        noiseSeen = true;
                        noiseAcc += reader.read(9) - 256;
                    }
                    else {
                        noiseAcc += huffDecode(reader, SF_TREE) - 60;
                    }
                    sf[g * 64 + sfb] = noiseAcc;
                }
                else {
                    sfAcc += huffDecode(reader, SF_TREE) - 60;
                    sf[g * 64 + sfb] = sfAcc;
                }
            }
        }
        let pulseCount = 0;
        const pulseOffsets = [];
        const pulseAmps = [];
        if (reader.readBit()) {
            if (shortWindows)
                throw new DecodeError('AAC: pulse data with short windows');
            pulseCount = reader.read(2) + 1;
            const startSfb = reader.read(6);
            let position = offsets[Math.min(startSfb, swbCount)];
            for (let i = 0; i < pulseCount; i++) {
                position += reader.read(5);
                pulseOffsets.push(position);
                pulseAmps.push(reader.read(4));
            }
        }
        state.tns = reader.readBit() ? this.readTns(reader, shortWindows) : null;
        if (reader.readBit())
            throw new DecodeError('AAC: gain_control_data is not supported');
        const spec = state.spectrum;
        spec.fill(0);
        const groupStartWindow = [];
        {
            let win = 0;
            for (let g = 0; g < info.groupCount; g++) {
                groupStartWindow.push(win);
                win += info.groupLengths[g];
            }
        }
        for (let g = 0; g < info.groupCount; g++) {
            const groupLen = info.groupLengths[g];
            const w0 = groupStartWindow[g];
            for (let sfb = 0; sfb < info.maxSfb; sfb++) {
                const book = cb[g * 64 + sfb];
                if (book === ZERO_HCB || book === NOISE_HCB || book === INTENSITY_HCB || book === INTENSITY_HCB2)
                    continue;
                const spectral = SPECTRAL_BOOKS[book];
                const tree = SPECTRAL_TREES[book];
                if (!spectral || !tree)
                    throw new DecodeError(`AAC: invalid codebook ${book}`);
                const width = offsets[sfb + 1] - offsets[sfb];
                for (let w = 0; w < groupLen; w++) {
                    this.decodeSpectralRun(reader, spectral, tree, spec, (w0 + w) * SHORT_LEN + offsets[sfb], width);
                }
            }
        }
        for (let i = 0; i < pulseCount; i++) {
            const k = pulseOffsets[i];
            if (k < FRAME_LEN) {
                spec[k] = spec[k] + (spec[k] < 0 ? -pulseAmps[i] : pulseAmps[i]);
            }
        }
        for (let g = 0; g < info.groupCount; g++) {
            const groupLen = info.groupLengths[g];
            const w0 = groupStartWindow[g];
            for (let sfb = 0; sfb < info.maxSfb; sfb++) {
                const book = cb[g * 64 + sfb];
                if (book === ZERO_HCB || book === INTENSITY_HCB || book === INTENSITY_HCB2)
                    continue;
                const width = offsets[sfb + 1] - offsets[sfb];
                if (book === NOISE_HCB) {
                    for (let w = 0; w < groupLen; w++) {
                        this.fillNoise(spec, (w0 + w) * SHORT_LEN + offsets[sfb], width, sf[g * 64 + sfb]);
                    }
                    continue;
                }
                const gain = Math.pow(2, 0.25 * (sf[g * 64 + sfb] - SF_OFFSET));
                for (let w = 0; w < groupLen; w++) {
                    const base = (w0 + w) * SHORT_LEN + offsets[sfb];
                    for (let i = 0; i < width; i++) {
                        const q = spec[base + i];
                        spec[base + i] = (q < 0 ? -1 : 1) * Math.pow(Math.abs(q), 4 / 3) * gain;
                    }
                }
            }
        }
    }
    decodeSpectralRun(reader, book, tree, spec, base, count) {
        const { dim, lav, range, signed } = book;
        const escape = lav === 16;
        for (let i = 0; i < count; i += dim) {
            let index = huffDecode(reader, tree);
            const values = new Array(dim);
            for (let d = dim - 1; d >= 0; d--) {
                values[d] = index % range;
                index = (index - values[d]) / range;
            }
            if (signed) {
                for (let d = 0; d < dim; d++)
                    values[d] -= lav;
            }
            else {
                for (let d = 0; d < dim; d++) {
                    if (values[d] !== 0 && reader.readBit())
                        values[d] = -values[d];
                }
            }
            if (escape) {
                for (let d = 0; d < dim; d++) {
                    if (Math.abs(values[d]) === 16) {
                        let pre = 4;
                        while (reader.readBit())
                            pre++;
                        const mantissa = reader.read(pre);
                        const magnitude = (1 << pre) + mantissa;
                        values[d] = values[d] < 0 ? -magnitude : magnitude;
                    }
                }
            }
            for (let d = 0; d < dim && i + d < count; d++) {
                spec[base + i + d] = values[d];
            }
        }
    }
    fillNoise(spec, base, count, noiseSf) {
        let energy = 0;
        for (let i = 0; i < count; i++) {
            this.noiseSeed = (this.noiseSeed * 1664525 + 1013904223) | 0;
            const v = ((this.noiseSeed >> 9) & 0xffff) / 32768 - 1;
            spec[base + i] = v;
            energy += v * v;
        }
        const target = Math.pow(2, 0.25 * noiseSf);
        const scale = energy > 0 ? target / Math.sqrt(energy) : 0;
        for (let i = 0; i < count; i++)
            spec[base + i] *= scale;
    }
    readTns(reader, shortWindows) {
        const windowCount = shortWindows ? 8 : 1;
        const filters = [];
        for (let w = 0; w < windowCount; w++) {
            const count = reader.read(shortWindows ? 1 : 2);
            const winFilters = [];
            const coefResBits = count ? reader.readBit() : 0;
            for (let f = 0; f < count; f++) {
                const length = reader.read(shortWindows ? 4 : 6);
                const order = reader.read(shortWindows ? 3 : 5);
                let direction = 0;
                const coef = new Float64Array(order);
                if (order) {
                    direction = reader.readBit();
                    const compress = reader.readBit();
                    const resBits = coefResBits + 3;
                    const coefBits = resBits - compress;
                    const signShift = 1 << (coefBits - 1);
                    const signMask = signShift * 2;
                    const iqfacPos = ((1 << (resBits - 1)) - 0.5) / (Math.PI / 2);
                    const iqfacNeg = ((1 << (resBits - 1)) + 0.5) / (Math.PI / 2);
                    for (let i = 0; i < order; i++) {
                        let v = reader.read(coefBits);
                        if (v >= signShift)
                            v -= signMask;
                        coef[i] = Math.sin(v / (v >= 0 ? iqfacPos : iqfacNeg));
                    }
                }
                winFilters.push({ order, direction, length, coef });
            }
            filters.push(winFilters);
        }
        return { filters };
    }
    applyTns(state) {
        const tns = state.tns;
        if (!tns)
            return;
        const info = state.info;
        this.lastCodedBands += info.maxSfb * info.groupCount;
        const shortWindows = info.windowSequence === EIGHT_SHORT;
        const offsets = this.bandOffsets(info);
        const swbCount = offsets.length - 1;
        const maxTnsBand = shortWindows ? TNS_MAX_BANDS_128[this.srIndex] : TNS_MAX_BANDS_1024[this.srIndex];
        const windowLen = shortWindows ? SHORT_LEN : FRAME_LEN;
        const windowCount = shortWindows ? 8 : 1;
        for (let w = 0; w < windowCount; w++) {
            let topSfb = Math.min(info.maxSfb, swbCount);
            const winFilters = tns.filters[w] ?? [];
            for (const filter of winFilters) {
                const bottomSfb = Math.max(0, topSfb - filter.length);
                const startBand = Math.min(bottomSfb, maxTnsBand, swbCount);
                const endBand = Math.min(topSfb, maxTnsBand, swbCount);
                topSfb = bottomSfb;
                if (filter.order === 0)
                    continue;
                const start = w * windowLen + offsets[startBand];
                const end = w * windowLen + offsets[endBand];
                if (end <= start)
                    continue;
                const lpc = new Float64Array(filter.order);
                const tmp = new Float64Array(filter.order);
                for (let m = 0; m < filter.order; m++) {
                    const k = filter.coef[m];
                    tmp.set(lpc);
                    lpc[m] = k;
                    for (let i = 0; i < m; i++)
                        lpc[i] = tmp[i] + k * tmp[m - 1 - i];
                }
                const spec = state.spectrum;
                if (filter.direction === 0) {
                    for (let i = start; i < end; i++) {
                        let acc = spec[i];
                        const depth = Math.min(filter.order, i - start);
                        for (let j = 1; j <= depth; j++)
                            acc -= lpc[j - 1] * spec[i - j];
                        spec[i] = acc;
                    }
                }
                else {
                    for (let i = end - 1; i >= start; i--) {
                        let acc = spec[i];
                        const depth = Math.min(filter.order, end - 1 - i);
                        for (let j = 1; j <= depth; j++)
                            acc -= lpc[j - 1] * spec[i + j];
                        spec[i] = acc;
                    }
                }
            }
        }
    }
    applyStereo(left, right, msMaskPresent, msUsed) {
        const info = left.info;
        const offsets = this.bandOffsets(info);
        const groupStartWindow = [];
        {
            let win = 0;
            for (let g = 0; g < info.groupCount; g++) {
                groupStartWindow.push(win);
                win += info.groupLengths[g];
            }
        }
        for (let g = 0; g < info.groupCount; g++) {
            const groupLen = info.groupLengths[g];
            for (let sfb = 0; sfb < info.maxSfb; sfb++) {
                const idx = g * 64 + sfb;
                const rBook = right.bandCodebooks[idx];
                const bandWidth = offsets[sfb + 1] - offsets[sfb];
                const isIntensity = rBook === INTENSITY_HCB || rBook === INTENSITY_HCB2;
                if (isIntensity) {
                    const msBit = msMaskPresent === 2 ? 1 : msUsed ? msUsed[g * info.maxSfb + sfb] : 0;
                    let sign = rBook === INTENSITY_HCB ? 1 : -1;
                    if (msBit)
                        sign = -sign;
                    const scale = sign * Math.pow(0.5, 0.25 * right.scalefactors[idx]);
                    for (let w = 0; w < groupLen; w++) {
                        const base = (groupStartWindow[g] + w) * SHORT_LEN + offsets[sfb];
                        for (let i = 0; i < bandWidth; i++) {
                            right.spectrum[base + i] = left.spectrum[base + i] * scale;
                        }
                    }
                }
                else if (msMaskPresent !== 0) {
                    const msBit = msMaskPresent === 2 ? 1 : msUsed ? msUsed[g * info.maxSfb + sfb] : 0;
                    if (msBit && rBook !== NOISE_HCB && left.bandCodebooks[idx] !== NOISE_HCB) {
                        for (let w = 0; w < groupLen; w++) {
                            const base = (groupStartWindow[g] + w) * SHORT_LEN + offsets[sfb];
                            for (let i = 0; i < bandWidth; i++) {
                                const mid = left.spectrum[base + i];
                                const side = right.spectrum[base + i];
                                left.spectrum[base + i] = mid + side;
                                right.spectrum[base + i] = mid - side;
                            }
                        }
                    }
                }
            }
        }
        this.applyTns(left);
        this.applyTns(right);
    }
    filterbank(state) {
        const info = state.info;
        if (this.channels === 1)
            this.applyTns(state);
        const out = new Float32Array(FRAME_LEN);
        const overlap = state.overlap;
        const currShape = info.windowShape;
        const prevShape = state.prevShape;
        const normLong = 2 / (2 * FRAME_LEN) / 32768;
        const normShort = 2 / (2 * SHORT_LEN) / 32768;
        if (info.windowSequence === EIGHT_SHORT) {
            const buf = new Float64Array(2 * FRAME_LEN);
            const winPrev = risingWindow(prevShape, true);
            const winCurr = risingWindow(currShape, true);
            const shortSpec = new Float64Array(SHORT_LEN);
            for (let w = 0; w < 8; w++) {
                for (let k = 0; k < SHORT_LEN; k++)
                    shortSpec[k] = state.spectrum[w * SHORT_LEN + k];
                this.imdctShort.run(shortSpec, this.windowedShort);
                const rise = w === 0 ? winPrev : winCurr;
                const start = 448 + w * SHORT_LEN;
                for (let i = 0; i < SHORT_LEN; i++) {
                    buf[start + i] += this.windowedShort[i] * normShort * rise[i];
                    buf[start + SHORT_LEN + i] +=
                        this.windowedShort[SHORT_LEN + i] * normShort * winCurr[SHORT_LEN - 1 - i];
                }
            }
            for (let i = 0; i < FRAME_LEN; i++)
                out[i] = overlap[i] + buf[i];
            for (let i = 0; i < FRAME_LEN; i++)
                overlap[i] = buf[FRAME_LEN + i];
        }
        else {
            this.imdctLong.run(state.spectrum, this.windowedLong);
            const seq = info.windowSequence;
            const winPrevLong = risingWindow(prevShape, false);
            const winPrevShort = risingWindow(prevShape, true);
            const winCurrLong = risingWindow(currShape, false);
            const winCurrShort = risingWindow(currShape, true);
            const first = new Float64Array(FRAME_LEN);
            const second = new Float64Array(FRAME_LEN);
            for (let i = 0; i < FRAME_LEN; i++) {
                let wl;
                if (seq === LONG_STOP) {
                    wl = (i < 448 ? 0 : i < 576 ? winPrevShort[i - 448] : 1);
                }
                else {
                    wl = winPrevLong[i];
                }
                first[i] = this.windowedLong[i] * normLong * wl;
            }
            for (let i = 0; i < FRAME_LEN; i++) {
                let wr;
                if (seq === LONG_START) {
                    wr = (i < 448 ? 1 : i < 576 ? winCurrShort[SHORT_LEN - 1 - (i - 448)] : 0);
                }
                else {
                    wr = winCurrLong[FRAME_LEN - 1 - i];
                }
                second[i] = this.windowedLong[FRAME_LEN + i] * normLong * wr;
            }
            for (let i = 0; i < FRAME_LEN; i++)
                out[i] = overlap[i] + first[i];
            overlap.set(second);
        }
        state.prevShape = currShape;
        return out;
    }
}
export function decodeAacFrameForProbe(frame, sampleRate, channels) {
    const decoder = new AacLcDecoder(sampleRate, channels);
    decoder.decodeFrame(frame);
    return {
        bitsConsumed: decoder.lastBitsConsumed,
        bitsAvailable: frame.length * 8,
        codedBands: decoder.lastCodedBands,
    };
}
export async function decodeAacFrames(frames, sampleRate, channels, options = {}) {
    const decoder = new AacLcDecoder(sampleRate, channels);
    const channelData = [];
    for (let c = 0; c < channels; c++)
        channelData.push(new Float32Array(frames.length * FRAME_LEN));
    const yieldEvery = options.yieldEvery ?? 0;
    for (let f = 0; f < frames.length; f++) {
        if (options.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        const pcm = decoder.decodeFrame(frames[f]);
        for (let c = 0; c < channels; c++)
            channelData[c].set(pcm[c], f * FRAME_LEN);
        options.onProgress?.(f + 1, frames.length);
        if (yieldEvery > 0 && (f + 1) % yieldEvery === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    return { channelData, sampleRate };
}
