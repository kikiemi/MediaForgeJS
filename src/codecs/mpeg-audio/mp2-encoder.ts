import { MemorySink } from '../../core/io/sinks/sinks';
import { EncodeError, throwIfAborted } from '../../core/errors/errors';
import {
    MPEG1_LAYER2_BITRATES,
    mpegBitrates,
} from '../../core/codec-config/audio/mpeg-audio-header';
import type { MpegAudioEncodeOptions } from './types';
import { ANALYSIS_HISTORY, analysisFilterbank } from './analysis-filterbank';
import { BitWriter, FrameSizer, MPEG1_SAMPLE_RATES } from './common';
import { InterleavedPcmQueue } from '../pcm/pcm-queue';
import { type QuantClass, QUANT_CLASSES, chooseAllocTable, SCF_VALUES } from './layer12-tables';

function scalefactorIndex(peak: number): number {
    if (!(peak > 0)) return 62;
    let index = 0;
    while (index < 62 && SCF_VALUES[index + 1] >= peak) index++;
    return index;
}

function quantizeSample(x: number, qc: QuantClass): number {
    const clamped = x >= 1 ? 1 : x <= -1 ? -1 : x;
    const d = qc.a * clamped + qc.b;
    const half = 1 << (qc.sampleBits - 1);
    let code = d >= 0 ? Math.floor(d * half) + half : Math.floor((d + 1) * half);
    if (code > qc.nlevels - 1) code = qc.nlevels - 1;
    else if (code < 0) code = 0;
    return code;
}

interface ScfsiChoice {
    readonly scfsi: number;
    readonly part0: number;
    readonly part1: number;
    readonly part2: number;
    readonly scfBits: number;
}

function chooseScfsi(s0: number, s1: number, s2: number): ScfsiChoice {
    const d01 = Math.abs(s0 - s1);
    const d12 = Math.abs(s1 - s2);
    if (d01 <= 1 && d12 <= 1 && Math.abs(s0 - s2) <= 2) {
        const shared = Math.min(s0, s1, s2);
        return { scfsi: 2, part0: shared, part1: shared, part2: shared, scfBits: 6 };
    }
    if (d01 <= 1) {
        const shared = Math.min(s0, s1);
        return { scfsi: 1, part0: shared, part1: shared, part2: s2, scfBits: 12 };
    }
    if (d12 <= 1) {
        const shared = Math.min(s1, s2);
        return { scfsi: 3, part0: s0, part1: shared, part2: shared, scfBits: 12 };
    }
    return { scfsi: 0, part0: s0, part1: s1, part2: s2, scfBits: 18 };
}

function absoluteThresholdDbfs(frequencyHz: number): number {
    const khz = Math.max(frequencyHz, 20) / 1000;
    const spl =
        3.64 * Math.pow(khz, -0.8) -
        6.5 * Math.exp(-0.6 * (khz - 3.3) * (khz - 3.3)) +
        1e-3 * Math.pow(khz, 4);
    return Math.max(spl - 96, -100);
}

class Mp2FrameCore {
    private readonly nch: number;
    private readonly srIdx: number;
    private readonly brIdx: number;
    private readonly mode: number;
    private readonly table: ReturnType<typeof chooseAllocTable>;
    private readonly sblimit: number;
    private readonly bands: number;
    private readonly sizer: FrameSizer;
    private readonly frame: Uint8Array;
    private readonly history: Float64Array[] = [];
    private readonly subs: Float64Array;
    private readonly scfsiChoices: ScfsiChoice[];
    private readonly alloc: Uint8Array;
    private readonly smr: Float64Array;
    private readonly mnr: Float64Array;
    private readonly active: Uint8Array;
    private readonly ath: Float64Array;

    constructor(
        readonly sampleRate: number,
        readonly channels: number,
        readonly bitrate: number,
    ) {
        if (channels !== 1 && channels !== 2) {
            throw new EncodeError(`encodeMp2: channels must be 1 or 2, got ${channels}`);
        }

        this.srIdx = MPEG1_SAMPLE_RATES.indexOf(sampleRate);
        if (this.srIdx < 0) {
            throw new EncodeError(`encodeMp2: sample rate ${sampleRate} is not supported`, {
                hint: 'Use 32000, 44100 or 48000 Hz.',
            });
        }

        if (!mpegBitrates('mp2', channels).includes(bitrate)) {
            throw new EncodeError(
                `encodeMp2: ${bitrate} kbps is not a legal Layer II bitrate for ${channels}ch`,
            );
        }

        this.brIdx = MPEG1_LAYER2_BITRATES.indexOf(bitrate);
        this.nch = channels;
        this.mode = channels === 1 ? 3 : 0;
        this.table = chooseAllocTable(sampleRate, bitrate, channels);
        this.sblimit = this.table.sblimit;
        this.bands = channels * this.sblimit;
        this.sizer = new FrameSizer(bitrate, sampleRate);
        this.frame = new Uint8Array(this.sizer.maxFrameSize);
        for (let channel = 0; channel < channels; channel++) {
            this.history.push(new Float64Array(ANALYSIS_HISTORY + 1152));
        }
        this.subs = new Float64Array(channels * 36 * 32);
        this.scfsiChoices = new Array<ScfsiChoice>(this.bands);
        this.alloc = new Uint8Array(this.bands);
        this.smr = new Float64Array(this.bands);
        this.mnr = new Float64Array(this.bands);
        this.active = new Uint8Array(this.bands);
        this.ath = new Float64Array(this.sblimit);
        for (let sb = 0; sb < this.sblimit; sb++) {
            this.ath[sb] = absoluteThresholdDbfs(((sb + 0.5) * sampleRate) / 64);
        }
    }

    encode(pcm: Float32Array): Uint8Array<ArrayBuffer> {
        if (pcm.length !== 1152 * this.nch) {
            throw new EncodeError(
                `MP2 frame needs ${1152 * this.nch} PCM samples, got ${pcm.length}`,
            );
        }
        const { size: frameSize, padding } = this.sizer.next();
        this.frame.fill(0, 0, frameSize);
        this.frame[0] = 0xff;
        this.frame[1] = 0xfd;
        this.frame[2] = (this.brIdx << 4) | (this.srIdx << 2) | (padding << 1);
        this.frame[3] = this.mode << 6;

        for (let channel = 0; channel < this.nch; channel++) {
            analysisFilterbank(
                pcm,
                channel,
                this.nch,
                36,
                this.history[channel]!,
                this.subs,
                channel * 36 * 32,
            );
        }

        let allocBits = 32;
        for (let sb = 0; sb < this.sblimit; sb++) allocBits += this.table.nbal[sb]! * this.nch;

        for (let channel = 0; channel < this.nch; channel++) {
            for (let sb = 0; sb < this.sblimit; sb++) {
                const band = channel * this.sblimit + sb;
                let framePeak = 0;
                let s0 = 62;
                let s1 = 62;
                let s2 = 62;
                for (let part = 0; part < 3; part++) {
                    let peak = 0;
                    const base = channel * 36 * 32 + part * 12 * 32 + sb;
                    for (let slot = 0; slot < 12; slot++) {
                        const value = Math.abs(this.subs[base + slot * 32]!);
                        if (value > peak) peak = value;
                    }
                    if (peak > framePeak) framePeak = peak;
                    const index = scalefactorIndex(peak);
                    if (part === 0) s0 = index;
                    else if (part === 1) s1 = index;
                    else s2 = index;
                }
                this.scfsiChoices[band] = chooseScfsi(s0, s1, s2);
                if (framePeak > 1e-9) {
                    this.active[band] = 1;
                    this.smr[band] = 20 * Math.log10(framePeak) - this.ath[sb]!;
                } else {
                    this.active[band] = 0;
                    this.smr[band] = Number.NEGATIVE_INFINITY;
                }
                this.alloc[band] = 0;
                this.mnr[band] = Number.NEGATIVE_INFINITY;
            }
        }

        let bitsLeft = frameSize * 8 - allocBits;
        for (;;) {
            let best = -1;
            let bestMnr = Number.POSITIVE_INFINITY;
            for (let band = 0; band < this.bands; band++) {
                if (!this.active[band]) continue;
                const sb = band % this.sblimit;
                if (this.alloc[band]! + 1 >= this.table.rows[sb]!.length) continue;
                const currentMnr = this.alloc[band] === 0 ? -this.smr[band]! : this.mnr[band]!;
                if (currentMnr < bestMnr) {
                    bestMnr = currentMnr;
                    best = band;
                }
            }
            if (best < 0) break;
            const row = this.table.rows[best % this.sblimit]!;
            const current = this.alloc[best]!;
            const nextClass = QUANT_CLASSES.get(row[current + 1]!);
            if (!nextClass) {
                this.active[best] = 0;
                continue;
            }
            let cost = nextClass.grouped ? 12 * nextClass.wordBits : 36 * nextClass.wordBits;
            if (current === 0) {
                cost += 2 + this.scfsiChoices[best]!.scfBits;
            } else {
                const currentClass = QUANT_CLASSES.get(row[current]!);
                if (currentClass) {
                    cost -= currentClass.grouped
                        ? 12 * currentClass.wordBits
                        : 36 * currentClass.wordBits;
                }
            }
            if (cost > bitsLeft) {
                this.active[best] = 0;
                continue;
            }
            bitsLeft -= cost;
            this.alloc[best] = current + 1;
            this.mnr[best] = nextClass.snrDb - this.smr[best]!;
        }

        const bits = new BitWriter(this.frame, 4);
        for (let sb = 0; sb < this.sblimit; sb++) {
            for (let channel = 0; channel < this.nch; channel++) {
                bits.put(this.alloc[channel * this.sblimit + sb]!, this.table.nbal[sb]!);
            }
        }
        for (let sb = 0; sb < this.sblimit; sb++) {
            for (let channel = 0; channel < this.nch; channel++) {
                const band = channel * this.sblimit + sb;
                if (this.alloc[band]) bits.put(this.scfsiChoices[band]!.scfsi, 2);
            }
        }
        for (let sb = 0; sb < this.sblimit; sb++) {
            for (let channel = 0; channel < this.nch; channel++) {
                const band = channel * this.sblimit + sb;
                if (!this.alloc[band]) continue;
                const choice = this.scfsiChoices[band]!;
                if (choice.scfsi === 2) {
                    bits.put(choice.part0, 6);
                } else if (choice.scfsi === 1) {
                    bits.put(choice.part0, 6);
                    bits.put(choice.part2, 6);
                } else if (choice.scfsi === 3) {
                    bits.put(choice.part0, 6);
                    bits.put(choice.part1, 6);
                } else {
                    bits.put(choice.part0, 6);
                    bits.put(choice.part1, 6);
                    bits.put(choice.part2, 6);
                }
            }
        }
        for (let granule = 0; granule < 12; granule++) {
            const part = granule >> 2;
            const slotBase = granule * 3;
            for (let sb = 0; sb < this.sblimit; sb++) {
                for (let channel = 0; channel < this.nch; channel++) {
                    const band = channel * this.sblimit + sb;
                    const allocIndex = this.alloc[band]!;
                    if (!allocIndex) continue;
                    const quant = QUANT_CLASSES.get(this.table.rows[sb]![allocIndex]!);
                    if (!quant) throw new EncodeError('encodeMp2: bit allocation is invalid');
                    const choice = this.scfsiChoices[band]!;
                    const scfIndex =
                        part === 0 ? choice.part0 : part === 1 ? choice.part1 : choice.part2;
                    const inverse = 1 / SCF_VALUES[scfIndex]!;
                    const base = channel * 36 * 32 + slotBase * 32 + sb;
                    const q0 = quantizeSample(this.subs[base]! * inverse, quant);
                    const q1 = quantizeSample(this.subs[base + 32]! * inverse, quant);
                    const q2 = quantizeSample(this.subs[base + 64]! * inverse, quant);
                    if (quant.grouped) {
                        bits.put(q0 + quant.nlevels * (q1 + quant.nlevels * q2), quant.wordBits);
                    } else {
                        bits.put(q0, quant.wordBits);
                        bits.put(q1, quant.wordBits);
                        bits.put(q2, quant.wordBits);
                    }
                }
            }
        }
        if (bits.pos > frameSize * 8) {
            throw new EncodeError('encodeMp2: frame overflows its size');
        }
        return this.frame.slice(0, frameSize);
    }
}

interface StreamingMp2EncodeOptions extends MpegAudioEncodeOptions {
    readonly expectedInputFrames?: number;
    readonly onFrame?: (frame: Uint8Array, frameIndex: number) => void;
    /** False when frames are handed directly to an external sink. */
    readonly collectOutput?: boolean;
}

/** Incremental Layer II encoder retaining one partial 1,152-frame PCM block. */
export class StreamingMp2Encoder {
    private readonly queue: InterleavedPcmQueue;
    private readonly core: Mp2FrameCore;
    private readonly sink: MemorySink | null;
    private readonly expectedCodecFrames: number | null;
    private inputFrames = 0;
    private encodedFrames = 0;
    private sealed = false;

    constructor(
        readonly sampleRate: number,
        readonly channels: number,
        readonly bitrate = 192,
        private readonly options: StreamingMp2EncodeOptions = {},
    ) {
        this.queue = new InterleavedPcmQueue(channels);
        this.core = new Mp2FrameCore(sampleRate, channels, bitrate);
        this.sink = options.collectOutput === false ? null : new MemorySink();
        this.expectedCodecFrames =
            options.expectedInputFrames === undefined
                ? null
                : Math.ceil(Math.max(0, options.expectedInputFrames) / 1152);
    }

    get framesReceived(): number {
        return this.inputFrames;
    }
    get framesProduced(): number {
        return this.encodedFrames;
    }
    get peakBufferedFrames(): number {
        return this.queue.peakBufferedFrames;
    }

    pushPlanar(planes: readonly Float32Array[]): void {
        this.assertOpen();
        const frames = planes[0]?.length ?? 0;
        this.queue.pushPlanar(planes);
        this.inputFrames += frames;
        this.drain();
    }

    /** The stream, empty when the frames went to `onFrame` only. */
    finish(): Uint8Array<ArrayBuffer> {
        this.assertOpen();
        this.sealed = true;
        if (this.inputFrames === 0) throw new EncodeError('encodeMp2: empty input');
        if (this.queue.bufferedFrames > 0) this.emit(this.queue.takeFrames(1152, true));
        return this.sink?.toUint8Array() ?? new Uint8Array(0);
    }

    private assertOpen(): void {
        if (this.sealed) throw new EncodeError('MP2 encoder received PCM after finish');
        throwIfAborted(this.options.signal);
    }

    private drain(): void {
        while (this.queue.bufferedFrames >= 1152) this.emit(this.queue.takeFrames(1152));
    }

    private emit(pcm: Float32Array): void {
        const frame = this.core.encode(pcm);
        this.sink?.write(frame);
        this.options.onFrame?.(frame, this.encodedFrames);
        this.encodedFrames++;
        this.options.onProgress?.(
            this.encodedFrames,
            this.expectedCodecFrames ?? this.encodedFrames,
        );
    }
}
