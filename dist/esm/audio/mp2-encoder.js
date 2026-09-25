import { MemorySink } from '../io/sinks.js';
import { EncodeError } from '../core/errors.js';
import { yieldToEventLoop } from './audio-buffer-tools.js';
import { analysisFilterbank, BitWriter, FrameSizer, MPEG1_SAMPLE_RATES } from './mpeg-common.js';
import { InterleavedPcmQueue } from './streaming-pcm.js';
import { QUANT_CLASSES, chooseAllocTable, SCF_VALUES } from './mpeg-layer12-tables.js';
const MP2_BITRATES_MONO = [32, 48, 56, 64, 80, 96, 112, 128, 160, 192];
const MP2_BITRATES_STEREO = [64, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const MP2_HEADER_BITRATES = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
export function legalMp2Bitrates(channels) {
    return channels === 1 ? MP2_BITRATES_MONO : MP2_BITRATES_STEREO;
}
function scalefactorIndex(peak) {
    if (!(peak > 0))
        return 62;
    let index = 0;
    while (index < 62 && SCF_VALUES[index + 1] >= peak)
        index++;
    return index;
}
function quantizeSample(x, qc) {
    const clamped = x >= 1 ? 1 : x <= -1 ? -1 : x;
    const d = qc.a * clamped + qc.b;
    const half = 1 << (qc.sampleBits - 1);
    let code = d >= 0 ? Math.floor(d * half) + half : Math.floor((d + 1) * half);
    if (code > qc.nlevels - 1)
        code = qc.nlevels - 1;
    else if (code < 0)
        code = 0;
    return code;
}
function chooseScfsi(s0, s1, s2) {
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
function absoluteThresholdDbfs(frequencyHz) {
    const khz = Math.max(frequencyHz, 20) / 1000;
    const spl = 3.64 * Math.pow(khz, -0.8) - 6.5 * Math.exp(-0.6 * (khz - 3.3) * (khz - 3.3)) + 1e-3 * Math.pow(khz, 4);
    return Math.max(spl - 96, -100);
}
class Mp2FrameCore {
    sampleRate;
    channels;
    bitrate;
    nch;
    srIdx;
    brIdx;
    mode;
    table;
    sblimit;
    bands;
    sizer;
    frame;
    vbuf = [];
    win64 = new Float64Array(64);
    subs;
    scfsiChoices;
    alloc;
    smr;
    mnr;
    active;
    ath;
    constructor(sampleRate, channels, bitrate) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.bitrate = bitrate;
        if (channels !== 1 && channels !== 2) {
            throw new EncodeError(`encodeMP2: channels must be 1 or 2, got ${channels}`);
        }
        this.srIdx = MPEG1_SAMPLE_RATES.indexOf(sampleRate);
        if (this.srIdx < 0) {
            throw new EncodeError(`encodeMP2: unsupported sample rate ${sampleRate} (need 32000/44100/48000)`);
        }
        if (!legalMp2Bitrates(channels).includes(bitrate)) {
            throw new EncodeError(`encodeMP2: ${bitrate} kbps is not a legal Layer II bitrate for ${channels}ch`);
        }
        this.brIdx = MP2_HEADER_BITRATES.indexOf(bitrate);
        this.nch = channels;
        this.mode = channels === 1 ? 3 : 0;
        this.table = chooseAllocTable(sampleRate, bitrate, channels);
        this.sblimit = this.table.sblimit;
        this.bands = channels * this.sblimit;
        this.sizer = new FrameSizer(bitrate, sampleRate);
        this.frame = new Uint8Array(this.sizer.maxFrameSize);
        for (let channel = 0; channel < channels; channel++)
            this.vbuf.push(new Float64Array(512));
        this.subs = new Float64Array(channels * 36 * 32);
        this.scfsiChoices = new Array(this.bands);
        this.alloc = new Uint8Array(this.bands);
        this.smr = new Float64Array(this.bands);
        this.mnr = new Float64Array(this.bands);
        this.active = new Uint8Array(this.bands);
        this.ath = new Float64Array(this.sblimit);
        for (let sb = 0; sb < this.sblimit; sb++) {
            this.ath[sb] = absoluteThresholdDbfs(((sb + 0.5) * sampleRate) / 64);
        }
    }
    encode(pcm) {
        if (pcm.length !== 1152 * this.nch) {
            throw new EncodeError(`MP2 frame needs ${1152 * this.nch} PCM samples, got ${pcm.length}`);
        }
        const { size: frameSize, padding } = this.sizer.next();
        this.frame.fill(0, 0, frameSize);
        this.frame[0] = 0xff;
        this.frame[1] = 0xfd;
        this.frame[2] = (this.brIdx << 4) | (this.srIdx << 2) | (padding << 1);
        this.frame[3] = this.mode << 6;
        for (let channel = 0; channel < this.nch; channel++) {
            const channelBase = channel * 36 * 32;
            for (let slot = 0; slot < 36; slot++) {
                analysisFilterbank(pcm, slot * 32 * this.nch + channel, this.nch, this.vbuf[channel], this.subs, channelBase + slot * 32, this.win64);
            }
        }
        let allocBits = 32;
        for (let sb = 0; sb < this.sblimit; sb++)
            allocBits += this.table.nbal[sb] * this.nch;
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
                        const value = Math.abs(this.subs[base + slot * 32]);
                        if (value > peak)
                            peak = value;
                    }
                    if (peak > framePeak)
                        framePeak = peak;
                    const index = scalefactorIndex(peak);
                    if (part === 0)
                        s0 = index;
                    else if (part === 1)
                        s1 = index;
                    else
                        s2 = index;
                }
                this.scfsiChoices[band] = chooseScfsi(s0, s1, s2);
                if (framePeak > 1e-9) {
                    this.active[band] = 1;
                    this.smr[band] = 20 * Math.log10(framePeak) - this.ath[sb];
                }
                else {
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
                if (!this.active[band])
                    continue;
                const sb = band % this.sblimit;
                if (this.alloc[band] + 1 >= this.table.rows[sb].length)
                    continue;
                const currentMnr = this.alloc[band] === 0 ? -this.smr[band] : this.mnr[band];
                if (currentMnr < bestMnr) {
                    bestMnr = currentMnr;
                    best = band;
                }
            }
            if (best < 0)
                break;
            const row = this.table.rows[best % this.sblimit];
            const current = this.alloc[best];
            const nextClass = QUANT_CLASSES.get(row[current + 1]);
            if (!nextClass) {
                this.active[best] = 0;
                continue;
            }
            let cost = nextClass.grouped ? 12 * nextClass.wordBits : 36 * nextClass.wordBits;
            if (current === 0) {
                cost += 2 + this.scfsiChoices[best].scfBits;
            }
            else {
                const currentClass = QUANT_CLASSES.get(row[current]);
                if (currentClass) {
                    cost -= currentClass.grouped ? 12 * currentClass.wordBits : 36 * currentClass.wordBits;
                }
            }
            if (cost > bitsLeft) {
                this.active[best] = 0;
                continue;
            }
            bitsLeft -= cost;
            this.alloc[best] = current + 1;
            this.mnr[best] = nextClass.snrDb - this.smr[best];
        }
        const bits = new BitWriter(this.frame, 4);
        for (let sb = 0; sb < this.sblimit; sb++) {
            for (let channel = 0; channel < this.nch; channel++) {
                bits.put(this.alloc[channel * this.sblimit + sb], this.table.nbal[sb]);
            }
        }
        for (let sb = 0; sb < this.sblimit; sb++) {
            for (let channel = 0; channel < this.nch; channel++) {
                const band = channel * this.sblimit + sb;
                if (this.alloc[band])
                    bits.put(this.scfsiChoices[band].scfsi, 2);
            }
        }
        for (let sb = 0; sb < this.sblimit; sb++) {
            for (let channel = 0; channel < this.nch; channel++) {
                const band = channel * this.sblimit + sb;
                if (!this.alloc[band])
                    continue;
                const choice = this.scfsiChoices[band];
                if (choice.scfsi === 2) {
                    bits.put(choice.part0, 6);
                }
                else if (choice.scfsi === 1) {
                    bits.put(choice.part0, 6);
                    bits.put(choice.part2, 6);
                }
                else if (choice.scfsi === 3) {
                    bits.put(choice.part0, 6);
                    bits.put(choice.part1, 6);
                }
                else {
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
                    const allocIndex = this.alloc[band];
                    if (!allocIndex)
                        continue;
                    const quant = QUANT_CLASSES.get(this.table.rows[sb][allocIndex]);
                    if (!quant)
                        throw new EncodeError(`encodeMP2: invalid allocation state at sb=${sb}`);
                    const choice = this.scfsiChoices[band];
                    const scfIndex = part === 0 ? choice.part0 : part === 1 ? choice.part1 : choice.part2;
                    const inverse = 1 / SCF_VALUES[scfIndex];
                    const base = channel * 36 * 32 + slotBase * 32 + sb;
                    const q0 = quantizeSample(this.subs[base] * inverse, quant);
                    const q1 = quantizeSample(this.subs[base + 32] * inverse, quant);
                    const q2 = quantizeSample(this.subs[base + 64] * inverse, quant);
                    if (quant.grouped) {
                        bits.put(q0 + quant.nlevels * (q1 + quant.nlevels * q2), quant.wordBits);
                    }
                    else {
                        bits.put(q0, quant.wordBits);
                        bits.put(q1, quant.wordBits);
                        bits.put(q2, quant.wordBits);
                    }
                }
            }
        }
        if (bits.pos > frameSize * 8) {
            throw new EncodeError(`encodeMP2: frame overflow (${bits.pos} > ${frameSize * 8} bits)`);
        }
        return this.frame.slice(0, frameSize);
    }
}
export class StreamingMp2Encoder {
    sampleRate;
    channels;
    bitrate;
    options;
    queue;
    core;
    sink;
    expectedCodecFrames;
    inputFrames = 0;
    encodedFrames = 0;
    sealed = false;
    constructor(sampleRate, channels, bitrate = 192, options = {}) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.bitrate = bitrate;
        this.options = options;
        this.queue = new InterleavedPcmQueue(channels);
        this.core = new Mp2FrameCore(sampleRate, channels, bitrate);
        this.sink = options.collectOutput === false ? null : new MemorySink();
        this.expectedCodecFrames =
            options.expectedInputFrames === undefined
                ? null
                : Math.ceil(Math.max(0, options.expectedInputFrames) / 1152);
    }
    get framesReceived() {
        return this.inputFrames;
    }
    get framesProduced() {
        return this.encodedFrames;
    }
    get peakBufferedFrames() {
        return this.queue.peakBufferedFrames;
    }
    pushPlanar(planes) {
        this.assertOpen();
        const frames = planes[0]?.length ?? 0;
        this.queue.pushPlanar(planes);
        this.inputFrames += frames;
        this.drain();
    }
    pushInterleaved(pcm) {
        this.assertOpen();
        const frames = pcm.length / this.channels;
        this.queue.pushInterleaved(pcm);
        this.inputFrames += frames;
        this.drain();
    }
    finish() {
        this.assertOpen();
        this.sealed = true;
        if (this.inputFrames === 0)
            throw new EncodeError('encodeMP2: empty input');
        if (this.queue.bufferedFrames > 0)
            this.emit(this.queue.takeFrames(1152, true));
        return this.sink?.toBlob('audio/mpeg') ?? new Blob([], { type: 'audio/mpeg' });
    }
    assertOpen() {
        if (this.sealed)
            throw new EncodeError('MP2 encoder received PCM after finish');
        this.options.signal?.throwIfAborted();
    }
    drain() {
        while (this.queue.bufferedFrames >= 1152)
            this.emit(this.queue.takeFrames(1152));
    }
    emit(pcm) {
        const frame = this.core.encode(pcm);
        this.sink?.write(frame);
        this.options.onFrame?.(frame, this.encodedFrames);
        this.encodedFrames++;
        this.options.onProgress?.({
            completedFrames: this.encodedFrames,
            totalFrames: this.expectedCodecFrames ?? this.encodedFrames,
        });
    }
}
function* encodeMP2Frames(pcm, sampleRate, channels, bitrate, options) {
    if (channels < 1 || pcm.length % channels !== 0) {
        throw new EncodeError('encodeMP2: PCM input is not channel-aligned');
    }
    const totalInputFrames = pcm.length / channels;
    const encoder = new StreamingMp2Encoder(sampleRate, channels, bitrate, {
        ...options,
        expectedInputFrames: totalInputFrames,
    });
    const samplesPerFrame = 1152 * channels;
    for (let at = 0; at < pcm.length; at += samplesPerFrame) {
        options.signal?.throwIfAborted();
        encoder.pushInterleaved(pcm.subarray(at, Math.min(pcm.length, at + samplesPerFrame)));
        yield;
    }
    return encoder.finish();
}
export function encodeMP2(pcm, sampleRate, channels, bitrate = 192, options = {}) {
    const it = encodeMP2Frames(pcm, sampleRate, channels, bitrate, options);
    for (;;) {
        const step = it.next();
        if (step.done)
            return step.value;
    }
}
export async function encodeMP2Async(pcm, sampleRate, channels, bitrate = 192, options = {}) {
    const it = encodeMP2Frames(pcm, sampleRate, channels, bitrate, options);
    for (;;) {
        const step = it.next();
        if (step.done)
            return step.value;
        options.signal?.throwIfAborted();
        await yieldToEventLoop();
        options.signal?.throwIfAborted();
    }
}
