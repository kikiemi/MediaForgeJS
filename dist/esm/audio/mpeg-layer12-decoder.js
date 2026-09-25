import { QUANT_CLASSES, TABLE_LSF, chooseAllocTable, SCF_VALUES, requantize, SYNTHESIS_WINDOW, } from './mpeg-layer12-tables.js';
import { BitReader } from './mpeg-common.js';
const L1_BITRATES_V1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448];
const L2_BITRATES_V1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const L1_BITRATES_LSF = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const L2_BITRATES_LSF = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = {
    0: [11025, 12000, 8000],
    2: [22050, 24000, 16000],
    3: [44100, 48000, 32000],
};
function parseHeader(data, off) {
    if (off + 4 > data.length)
        return null;
    if (data[off] !== 0xff || (data[off + 1] & 0xe0) !== 0xe0)
        return null;
    const versionBits = (data[off + 1] >> 3) & 3;
    const layerBits = (data[off + 1] >> 1) & 3;
    const crc = (data[off + 1] & 1) === 0;
    const brIdx = (data[off + 2] >> 4) & 15;
    const srIdx = (data[off + 2] >> 2) & 3;
    const padding = (data[off + 2] >> 1) & 1;
    const mode = (data[off + 3] >> 6) & 3;
    const modeExtension = (data[off + 3] >> 4) & 3;
    if (versionBits === 1 || srIdx === 3 || brIdx === 0 || brIdx === 15)
        return null;
    if (layerBits !== 3 && layerBits !== 2)
        return null;
    const layer = layerBits === 3 ? 1 : 2;
    const lsf = versionBits !== 3;
    const rates = SAMPLE_RATES[versionBits];
    if (!rates)
        return null;
    const sampleRate = rates[srIdx];
    const bitrateKbps = layer === 1 ? (lsf ? L1_BITRATES_LSF : L1_BITRATES_V1)[brIdx] : (lsf ? L2_BITRATES_LSF : L2_BITRATES_V1)[brIdx];
    if (!bitrateKbps)
        return null;
    const frameBytes = layer === 1
        ? (Math.floor((12000 * bitrateKbps) / sampleRate) + padding) * 4
        : Math.floor((144000 * bitrateKbps) / sampleRate) + padding;
    if (frameBytes < 8)
        return null;
    return {
        layer,
        lsf,
        bitrateKbps,
        sampleRate,
        channels: mode === 3 ? 1 : 2,
        mode,
        modeExtension,
        crc,
        frameBytes,
        samplesPerFrame: layer === 1 ? 384 : 1152,
    };
}
export function parseMpegLayer12FrameShape(data, offset = 0) {
    const header = parseHeader(data, offset);
    if (!header)
        return null;
    return {
        layer: header.layer,
        sampleRate: header.sampleRate,
        channels: header.channels,
        frameBytes: header.frameBytes,
        samplesPerFrame: header.samplesPerFrame,
    };
}
export function skipId3v2(data, off) {
    if (off + 10 > data.length)
        return off;
    if (data[off] !== 0x49 || data[off + 1] !== 0x44 || data[off + 2] !== 0x33)
        return off;
    const size = ((data[off + 6] & 0x7f) << 21) |
        ((data[off + 7] & 0x7f) << 14) |
        ((data[off + 8] & 0x7f) << 7) |
        (data[off + 9] & 0x7f);
    const footer = data[off + 5] & 0x10 ? 10 : 0;
    return Math.min(data.length, off + 10 + size + footer);
}
export function isMpegAudioTrailer(data, offset) {
    return ((offset + 128 === data.length &&
        data[offset] === 0x54 &&
        data[offset + 1] === 0x41 &&
        data[offset + 2] === 0x47) ||
        (offset < data.length && skipId3v2(data, offset) === data.length));
}
class SynthesisFilterbank {
    v = new Float64Array(1024);
    static matrix = null;
    static getMatrix() {
        if (!SynthesisFilterbank.matrix) {
            const m = new Float64Array(64 * 32);
            for (let i = 0; i < 64; i++) {
                for (let k = 0; k < 32; k++) {
                    m[i * 32 + k] = Math.cos(((16 + i) * (2 * k + 1) * Math.PI) / 64);
                }
            }
            SynthesisFilterbank.matrix = m;
        }
        return SynthesisFilterbank.matrix;
    }
    run(subbands, out, outOff) {
        const v = this.v;
        const matrix = SynthesisFilterbank.getMatrix();
        const d = SYNTHESIS_WINDOW;
        v.copyWithin(64, 0, 960);
        for (let i = 0; i < 64; i++) {
            let sum = 0;
            const base = i * 32;
            for (let k = 0; k < 32; k++)
                sum += matrix[base + k] * subbands[k];
            v[i] = sum;
        }
        for (let j = 0; j < 32; j++) {
            let sum = 0;
            for (let i = 0; i < 8; i++) {
                sum += v[128 * i + j] * d[64 * i + j];
                sum += v[128 * i + 96 + j] * d[64 * i + 32 + j];
            }
            const clipped = sum >= 1 ? 1 : sum <= -1 ? -1 : sum;
            out[outOff + j] = clipped;
        }
    }
}
function makeState(channels) {
    return {
        synth: Array.from({ length: channels }, () => new SynthesisFilterbank()),
        alloc: Array.from({ length: channels }, () => new Int32Array(32)),
        scfsi: Array.from({ length: channels }, () => new Int32Array(32)),
        scf: Array.from({ length: channels }, () => new Int32Array(32 * 3)),
        subbands: new Float64Array(2 * 32),
    };
}
function layer2AllocTable(header) {
    if (header.lsf)
        return TABLE_LSF;
    return chooseAllocTable(header.sampleRate, header.bitrateKbps, header.channels);
}
function decodeLayer2Frame(reader, header, state, pcm, pcmOff) {
    const table = layer2AllocTable(header);
    const nch = header.channels;
    const sblimit = table.sblimit;
    const bound = header.mode === 1 ? Math.min((header.modeExtension + 1) * 4, sblimit) : sblimit;
    const { alloc, scfsi, scf } = state;
    for (let sb = 0; sb < bound; sb++) {
        for (let ch = 0; ch < nch; ch++)
            alloc[ch][sb] = reader.read(table.nbal[sb]);
    }
    for (let sb = bound; sb < sblimit; sb++) {
        const shared = reader.read(table.nbal[sb]);
        for (let ch = 0; ch < nch; ch++)
            alloc[ch][sb] = shared;
    }
    for (let sb = 0; sb < sblimit; sb++) {
        for (let ch = 0; ch < nch; ch++) {
            if (alloc[ch][sb])
                scfsi[ch][sb] = reader.read(2);
        }
    }
    for (let sb = 0; sb < sblimit; sb++) {
        for (let ch = 0; ch < nch; ch++) {
            if (!alloc[ch][sb])
                continue;
            const pattern = scfsi[ch][sb];
            const base = sb * 3;
            if (pattern === 0) {
                scf[ch][base] = reader.read(6);
                scf[ch][base + 1] = reader.read(6);
                scf[ch][base + 2] = reader.read(6);
            }
            else if (pattern === 1) {
                const shared = reader.read(6);
                scf[ch][base] = shared;
                scf[ch][base + 1] = shared;
                scf[ch][base + 2] = reader.read(6);
            }
            else if (pattern === 2) {
                const shared = reader.read(6);
                scf[ch][base] = shared;
                scf[ch][base + 1] = shared;
                scf[ch][base + 2] = shared;
            }
            else {
                scf[ch][base] = reader.read(6);
                const shared = reader.read(6);
                scf[ch][base + 1] = shared;
                scf[ch][base + 2] = shared;
            }
        }
    }
    const samples = new Float64Array(nch * 3 * 32);
    for (let granule = 0; granule < 12; granule++) {
        const part = granule >> 2;
        samples.fill(0);
        for (let sb = 0; sb < sblimit; sb++) {
            const shared = sb >= bound;
            const chCount = shared ? 1 : nch;
            for (let chIdx = 0; chIdx < chCount; chIdx++) {
                const allocValue = alloc[chIdx][sb];
                if (!allocValue)
                    continue;
                const nlevels = table.rows[sb][allocValue];
                const qc = QUANT_CLASSES.get(nlevels);
                if (!qc)
                    continue;
                let c0, c1, c2;
                if (qc.grouped) {
                    let word = reader.read(qc.wordBits);
                    c0 = word % nlevels;
                    word = (word / nlevels) | 0;
                    c1 = word % nlevels;
                    c2 = (word / nlevels) | 0;
                }
                else {
                    c0 = reader.read(qc.wordBits);
                    c1 = reader.read(qc.wordBits);
                    c2 = reader.read(qc.wordBits);
                }
                const targets = shared ? nch : 1;
                for (let t = 0; t < targets; t++) {
                    const ch = shared ? t : chIdx;
                    if (!alloc[ch][sb])
                        continue;
                    const scale = SCF_VALUES[Math.min(62, scf[ch][sb * 3 + part])];
                    const base = ch * 96 + sb;
                    samples[base] = requantize(c0, nlevels) * scale;
                    samples[base + 32] = requantize(c1, nlevels) * scale;
                    samples[base + 64] = requantize(c2, nlevels) * scale;
                }
            }
        }
        for (let ch = 0; ch < nch; ch++) {
            for (let s = 0; s < 3; s++) {
                state.synth[ch].run(samples.subarray(ch * 96 + s * 32, ch * 96 + s * 32 + 32), pcm[ch], pcmOff + (granule * 3 + s) * 32);
            }
        }
    }
}
function decodeLayer1Frame(reader, header, state, pcm, pcmOff) {
    const nch = header.channels;
    const bound = header.mode === 1 ? Math.min((header.modeExtension + 1) * 4, 32) : 32;
    const { alloc, scf } = state;
    for (let sb = 0; sb < bound; sb++) {
        for (let ch = 0; ch < nch; ch++)
            alloc[ch][sb] = reader.read(4);
    }
    for (let sb = bound; sb < 32; sb++) {
        const shared = reader.read(4);
        for (let ch = 0; ch < nch; ch++)
            alloc[ch][sb] = shared;
    }
    for (let sb = 0; sb < 32; sb++) {
        for (let ch = 0; ch < nch; ch++) {
            if (alloc[ch][sb])
                scf[ch][sb * 3] = reader.read(6);
        }
    }
    const samples = new Float64Array(nch * 32);
    for (let s = 0; s < 12; s++) {
        samples.fill(0);
        for (let sb = 0; sb < 32; sb++) {
            const shared = sb >= bound;
            const chCount = shared ? 1 : nch;
            for (let chIdx = 0; chIdx < chCount; chIdx++) {
                const allocValue = alloc[chIdx][sb];
                if (!allocValue || allocValue === 15)
                    continue;
                const bits = allocValue + 1;
                const nlevels = (1 << bits) - 1;
                const code = reader.read(bits);
                const targets = shared ? nch : 1;
                for (let t = 0; t < targets; t++) {
                    const ch = shared ? t : chIdx;
                    if (!alloc[ch][sb])
                        continue;
                    const scale = SCF_VALUES[Math.min(62, scf[ch][sb * 3])];
                    samples[ch * 32 + sb] = requantize(code, nlevels) * scale;
                }
            }
        }
        for (let ch = 0; ch < nch; ch++) {
            state.synth[ch].run(samples.subarray(ch * 32, ch * 32 + 32), pcm[ch], pcmOff + s * 32);
        }
    }
}
export class StreamingMpegLayer12Decoder {
    state = null;
    rate = 0;
    channelCount = 0;
    layer = 0;
    get sampleRate() {
        return this.rate;
    }
    get channels() {
        return this.channelCount;
    }
    pushFrame(data) {
        const header = parseHeader(data, 0);
        if (!header || header.frameBytes !== data.length) {
            throw new Error('invalid or truncated MPEG Layer I/II frame');
        }
        if (!this.state) {
            this.rate = header.sampleRate;
            this.channelCount = header.channels;
            this.layer = header.layer;
            this.state = makeState(header.channels);
        }
        else if (header.sampleRate !== this.rate ||
            header.channels !== this.channelCount ||
            header.layer !== this.layer) {
            throw new Error(`MPEG audio shape changed (${this.rate}Hz/${this.channelCount}ch/L${this.layer}` +
                ` -> ${header.sampleRate}Hz/${header.channels}ch/L${header.layer})`);
        }
        const reader = new BitReader(data, (header.crc ? 6 : 4) * 8);
        const pcm = Array.from({ length: header.channels }, () => new Float32Array(header.samplesPerFrame));
        if (header.layer === 2)
            decodeLayer2Frame(reader, header, this.state, pcm, 0);
        else
            decodeLayer1Frame(reader, header, this.state, pcm, 0);
        return pcm;
    }
}
export function decodeMpegLayer12(data) {
    let off = skipId3v2(data, 0);
    let state = null;
    let sampleRate = 0;
    let channels = 0;
    const chunks = [];
    let totalSamples = 0;
    let synchronized = false;
    while (off + 4 <= data.length) {
        if (isMpegAudioTrailer(data, off))
            break;
        const header = parseHeader(data, off);
        if (!header || off + header.frameBytes > data.length) {
            off++;
            synchronized = false;
            continue;
        }
        const next = off + header.frameBytes;
        if (!synchronized && next + 4 <= data.length && !isMpegAudioTrailer(data, next)) {
            const peek = parseHeader(data, next);
            if (!peek && skipId3v2(data, next) === next) {
                off++;
                continue;
            }
        }
        if (!state) {
            sampleRate = header.sampleRate;
            channels = header.channels;
            state = makeState(channels);
        }
        else if (header.sampleRate !== sampleRate || header.channels !== channels) {
            break;
        }
        const reader = new BitReader(data, (off + (header.crc ? 6 : 4)) * 8);
        const frame = Array.from({ length: channels }, () => new Float32Array(header.samplesPerFrame));
        try {
            if (header.layer === 2)
                decodeLayer2Frame(reader, header, state, frame, 0);
            else
                decodeLayer1Frame(reader, header, state, frame, 0);
        }
        catch {
            break;
        }
        chunks.push(frame);
        totalSamples += header.samplesPerFrame;
        off = next;
        synchronized = true;
    }
    if (!state || totalSamples === 0)
        return null;
    const channelData = [];
    for (let ch = 0; ch < channels; ch++) {
        const out = new Float32Array(totalSamples);
        let pos = 0;
        for (const frame of chunks) {
            out.set(frame[ch], pos);
            pos += frame[ch].length;
        }
        channelData.push(out);
    }
    return { channelData, sampleRate };
}
