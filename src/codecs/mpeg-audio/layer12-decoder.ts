import {
    QUANT_CLASSES,
    TABLE_LSF,
    chooseAllocTable,
    SCF_VALUES,
    requantize,
    SYNTHESIS_WINDOW,
    type AllocTable,
} from './layer12-tables';
import { BitReader } from './common';
import { DecodeError } from '../../core/errors/errors';
import { parseMpegAudioHeader } from '../../core/codec-config/audio/mpeg-audio-header';

interface FrameHeader {
    readonly layer: 1 | 2;
    readonly lsf: boolean;
    readonly bitrateKbps: number;
    readonly sampleRate: number;
    readonly channels: number;
    readonly mode: number;
    readonly modeExtension: number;
    readonly crc: boolean;
    readonly frameBytes: number;
    readonly samplesPerFrame: number;
}

function parseHeader(data: Uint8Array, off: number): FrameHeader | null {
    const header = parseMpegAudioHeader(data, off);
    if (!header || header.format === 'mp3') return null;
    return {
        layer: header.format === 'mp1' ? 1 : 2,
        lsf: ((data[off + 1]! >> 3) & 3) !== 3,
        bitrateKbps: header.bitrateKbps,
        sampleRate: header.sampleRate,
        channels: header.channels,
        mode: (data[off + 3]! >> 6) & 3,
        modeExtension: (data[off + 3]! >> 4) & 3,
        crc: (data[off + 1]! & 1) === 0,
        frameBytes: header.frameLength,
        samplesPerFrame: header.samplesPerFrame,
    };
}

export function skipId3v2(data: Uint8Array, off: number): number {
    if (off + 10 > data.length) return off;
    if (data[off] !== 0x49 || data[off + 1] !== 0x44 || data[off + 2] !== 0x33) return off;
    const size =
        ((data[off + 6] & 0x7f) << 21) |
        ((data[off + 7] & 0x7f) << 14) |
        ((data[off + 8] & 0x7f) << 7) |
        (data[off + 9] & 0x7f);
    const footer = data[off + 5] & 0x10 ? 10 : 0;
    return Math.min(data.length, off + 10 + size + footer);
}

/** Known metadata at the end of an otherwise complete MPEG audio stream. */
export function isMpegAudioTrailer(data: Uint8Array, offset: number): boolean {
    return (
        (offset + 128 === data.length &&
            data[offset] === 0x54 &&
            data[offset + 1] === 0x41 &&
            data[offset + 2] === 0x47) ||
        (offset < data.length && skipId3v2(data, offset) === data.length)
    );
}

/**
 * cos((2k + 1)nπ/64) for k = 0..15: rows n = 0, 2, .., 30 (even) and n = 1, 3, .., 31 (odd).
 */
const SYNTHESIS_EVEN = new Float64Array(256);
const SYNTHESIS_ODD = new Float64Array(256);
for (let m = 0; m < 16; m++)
    for (let k = 0; k < 16; k++) {
        SYNTHESIS_EVEN[m * 16 + k] = Math.cos(((2 * k + 1) * 2 * m * Math.PI) / 64);
        SYNTHESIS_ODD[m * 16 + k] = Math.cos(((2 * k + 1) * (2 * m + 1) * Math.PI) / 64);
    }

/**
 * 32-band polyphase synthesis (ISO/IEC 11172-3 2.4.3.4), one stateful instance per channel. The
 * matrixing V[i] = Σ cos((16 + i)(2k + 1)π/64) x[k] is the 32-point cosine transform
 * c(n) = Σ cos((2k + 1)nπ/64) x[k] at n = 16 + i, which c(64 - n) = c(64 + n) = -c(n) folds onto
 * n = 0..31; each c(n) folds x[k] and x[31 - k] (equal cosines for even n, opposite for odd), so
 * the 64 values take 512 products instead of 2048.
 */
export class MpegSynthesisFilterbank {
    /** V as a ring: logical V[i] is v[start + i], each value stored twice so no read wraps. */
    private readonly v = new Float64Array(2048);
    private start = 0;
    private readonly sum = new Float64Array(16);
    private readonly difference = new Float64Array(16);
    private readonly cosines = new Float64Array(32);

    /** Consumes 32 subband samples and writes 32 PCM samples clipped to [-1, 1]. */
    run(subbands: Float64Array, out: Float32Array, outOff: number): void {
        const v = this.v;
        const d = SYNTHESIS_WINDOW;
        const start = (this.start = (this.start + 960) & 1023);

        // Trailing zero subbands add nothing: with 16 or fewer, the folded halves end there too.
        let limit = 32;
        while (limit > 0 && subbands[limit - 1] === 0) limit--;
        const folded = limit > 16 ? 16 : limit;

        const sum = this.sum;
        const difference = this.difference;
        for (let k = 0; k < folded; k++) {
            const low = subbands[k]!;
            const high = subbands[31 - k]!;
            sum[k] = low + high;
            difference[k] = low - high;
        }
        const c = this.cosines;
        for (let m = 0; m < 16; m += 2) {
            let even0 = 0;
            let even1 = 0;
            let odd0 = 0;
            let odd1 = 0;
            const row = m * 16;
            for (let k = 0; k < folded; k++) {
                const s = sum[k]!;
                const t = difference[k]!;
                even0 += SYNTHESIS_EVEN[row + k]! * s;
                even1 += SYNTHESIS_EVEN[row + 16 + k]! * s;
                odd0 += SYNTHESIS_ODD[row + k]! * t;
                odd1 += SYNTHESIS_ODD[row + 16 + k]! * t;
            }
            c[2 * m] = even0;
            c[2 * m + 1] = odd0;
            c[2 * m + 2] = even1;
            c[2 * m + 3] = odd1;
        }

        // V[0..15] = c(16..31), V[16] = c(32) = 0, V[17..47] = -c(31..1), V[48..63] = -c(0..15).
        for (let i = 0; i < 16; i++) {
            const value = c[16 + i]!;
            v[start + i] = value;
            v[start + i + 1024] = value;
            const negated = -c[i]!;
            v[start + 48 + i] = negated;
            v[start + 1072 + i] = negated;
        }
        v[start + 16] = 0;
        v[start + 1040] = 0;
        for (let i = 17; i < 48; i++) {
            const value = -c[48 - i]!;
            v[start + i] = value;
            v[start + i + 1024] = value;
        }
        for (let j = 0; j < 32; j += 4) {
            let s0 = 0;
            let s1 = 0;
            let s2 = 0;
            let s3 = 0;
            for (let i = 0; i < 8; i++) {
                const a = start + 128 * i + j;
                const b = a + 96;
                const w = 64 * i + j;
                s0 += v[a]! * d[w]!;
                s1 += v[a + 1]! * d[w + 1]!;
                s2 += v[a + 2]! * d[w + 2]!;
                s3 += v[a + 3]! * d[w + 3]!;
                s0 += v[b]! * d[w + 32]!;
                s1 += v[b + 1]! * d[w + 33]!;
                s2 += v[b + 2]! * d[w + 34]!;
                s3 += v[b + 3]! * d[w + 35]!;
            }
            out[outOff + j] = s0 >= 1 ? 1 : s0 <= -1 ? -1 : s0;
            out[outOff + j + 1] = s1 >= 1 ? 1 : s1 <= -1 ? -1 : s1;
            out[outOff + j + 2] = s2 >= 1 ? 1 : s2 <= -1 ? -1 : s2;
            out[outOff + j + 3] = s3 >= 1 ? 1 : s3 <= -1 ? -1 : s3;
        }
    }
}

interface DecodeState {
    readonly synth: MpegSynthesisFilterbank[];
    readonly alloc: Int32Array[];
    readonly scfsi: Int32Array[];
    readonly scf: Int32Array[];
    readonly subbands: Float64Array;
}

function makeState(channels: number): DecodeState {
    return {
        synth: Array.from({ length: channels }, () => new MpegSynthesisFilterbank()),
        alloc: Array.from({ length: channels }, () => new Int32Array(32)),
        scfsi: Array.from({ length: channels }, () => new Int32Array(32)),
        scf: Array.from({ length: channels }, () => new Int32Array(32 * 3)),
        subbands: new Float64Array(2 * 32),
    };
}

function layer2AllocTable(header: FrameHeader): AllocTable {
    if (header.lsf) return TABLE_LSF;
    return chooseAllocTable(header.sampleRate, header.bitrateKbps, header.channels);
}

function decodeLayer2Frame(
    reader: BitReader,
    header: FrameHeader,
    state: DecodeState,
    pcm: Float32Array[],
    pcmOff: number,
): void {
    const table = layer2AllocTable(header);
    const nch = header.channels;
    const sblimit = table.sblimit;
    const bound = header.mode === 1 ? Math.min((header.modeExtension + 1) * 4, sblimit) : sblimit;
    const { alloc, scfsi, scf } = state;

    for (let sb = 0; sb < bound; sb++) {
        for (let ch = 0; ch < nch; ch++) alloc[ch][sb] = reader.read(table.nbal[sb]);
    }
    for (let sb = bound; sb < sblimit; sb++) {
        const shared = reader.read(table.nbal[sb]);
        for (let ch = 0; ch < nch; ch++) alloc[ch][sb] = shared;
    }

    for (let sb = 0; sb < sblimit; sb++) {
        for (let ch = 0; ch < nch; ch++) {
            if (alloc[ch][sb]) scfsi[ch][sb] = reader.read(2);
        }
    }

    for (let sb = 0; sb < sblimit; sb++) {
        for (let ch = 0; ch < nch; ch++) {
            if (!alloc[ch][sb]) continue;
            const pattern = scfsi[ch][sb];
            const base = sb * 3;
            if (pattern === 0) {
                scf[ch][base] = reader.read(6);
                scf[ch][base + 1] = reader.read(6);
                scf[ch][base + 2] = reader.read(6);
            } else if (pattern === 1) {
                const shared = reader.read(6);
                scf[ch][base] = shared;
                scf[ch][base + 1] = shared;
                scf[ch][base + 2] = reader.read(6);
            } else if (pattern === 2) {
                const shared = reader.read(6);
                scf[ch][base] = shared;
                scf[ch][base + 1] = shared;
                scf[ch][base + 2] = shared;
            } else {
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
                if (!allocValue) continue;
                const nlevels = table.rows[sb][allocValue];
                const qc = QUANT_CLASSES.get(nlevels);
                if (!qc) continue;
                let c0: number, c1: number, c2: number;
                if (qc.grouped) {
                    let word = reader.read(qc.wordBits);
                    c0 = word % nlevels;
                    word = (word / nlevels) | 0;
                    c1 = word % nlevels;
                    c2 = (word / nlevels) | 0;
                } else {
                    c0 = reader.read(qc.wordBits);
                    c1 = reader.read(qc.wordBits);
                    c2 = reader.read(qc.wordBits);
                }
                const targets = shared ? nch : 1;
                for (let t = 0; t < targets; t++) {
                    const ch = shared ? t : chIdx;
                    if (!alloc[ch][sb]) continue;
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
                state.synth[ch].run(
                    samples.subarray(ch * 96 + s * 32, ch * 96 + s * 32 + 32),
                    pcm[ch],
                    pcmOff + (granule * 3 + s) * 32,
                );
            }
        }
    }
}

function decodeLayer1Frame(
    reader: BitReader,
    header: FrameHeader,
    state: DecodeState,
    pcm: Float32Array[],
    pcmOff: number,
): void {
    const nch = header.channels;
    const bound = header.mode === 1 ? Math.min((header.modeExtension + 1) * 4, 32) : 32;
    const { alloc, scf } = state;

    for (let sb = 0; sb < bound; sb++) {
        for (let ch = 0; ch < nch; ch++) alloc[ch][sb] = reader.read(4);
    }
    for (let sb = bound; sb < 32; sb++) {
        const shared = reader.read(4);
        for (let ch = 0; ch < nch; ch++) alloc[ch][sb] = shared;
    }
    for (let sb = 0; sb < 32; sb++) {
        for (let ch = 0; ch < nch; ch++) {
            if (alloc[ch][sb]) scf[ch][sb * 3] = reader.read(6);
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
                if (!allocValue || allocValue === 15) continue;
                const bits = allocValue + 1;
                const nlevels = (1 << bits) - 1;
                const code = reader.read(bits);
                const targets = shared ? nch : 1;
                for (let t = 0; t < targets; t++) {
                    const ch = shared ? t : chIdx;
                    if (!alloc[ch][sb]) continue;
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

/** Stateful Layer I/II decoder that emits one bounded PCM frame per call. */
export class StreamingMpegLayer12Decoder {
    private state: DecodeState | null = null;
    private rate = 0;
    private channelCount = 0;
    private layer: 1 | 2 | 0 = 0;

    get sampleRate(): number {
        return this.rate;
    }
    get channels(): number {
        return this.channelCount;
    }

    pushFrame(data: Uint8Array): readonly Float32Array[] {
        const header = parseHeader(data, 0);
        if (!header || header.frameBytes !== data.length) {
            throw new DecodeError('invalid or truncated MPEG Layer I/II frame');
        }
        if (!this.state) {
            this.rate = header.sampleRate;
            this.channelCount = header.channels;
            this.layer = header.layer;
            this.state = makeState(header.channels);
        } else if (
            header.sampleRate !== this.rate ||
            header.channels !== this.channelCount ||
            header.layer !== this.layer
        ) {
            throw new DecodeError('MPEG audio format changes mid-stream');
        }
        const reader = new BitReader(data, (header.crc ? 6 : 4) * 8);
        const pcm = Array.from(
            { length: header.channels },
            () => new Float32Array(header.samplesPerFrame),
        );
        try {
            if (header.layer === 2) decodeLayer2Frame(reader, header, this.state, pcm, 0);
            else decodeLayer1Frame(reader, header, this.state, pcm, 0);
        } catch (error) {
            // The bit reader runs past a frame whose allocation does not fit its size.
            if (error instanceof RangeError)
                throw new DecodeError(`damaged MPEG Layer ${header.layer} frame`);
            throw error;
        }
        return pcm;
    }
}
