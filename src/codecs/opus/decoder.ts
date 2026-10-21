import type { OpusLayout } from '../../core/codec-config/audio/opus-head';
import { DecodeError } from '../../core/errors/errors';
import { CeltDecoder } from './celt-decoder';
import { RangeDecoder } from './range-decoder';
import {
    FLAG_DECODE_NORMAL,
    FLAG_PACKET_LOST,
    SilkDecoder,
    type SilkDecodeControl,
} from './silk-decoder';

// Opus decoder of RFC 6716: TOC/frame packing (section 3), SILK, CELT and hybrid frames (section 4)
// at 48 kHz.

const OPUS_SAMPLE_RATE = 48000;

/** 120 ms, the longest packet (RFC 6716 section 3.2.5). */
export const OPUS_MAX_FRAME_SAMPLES = 5760;
const MAX_FRAME_SAMPLES = OPUS_MAX_FRAME_SAMPLES;
const MODE_SILK_ONLY = 1000;
const MODE_HYBRID = 1001;
const MODE_CELT_ONLY = 1002;
const BANDWIDTH_NARROWBAND = 1101;
const BANDWIDTH_MEDIUMBAND = 1102;
const BANDWIDTH_WIDEBAND = 1103;
const BANDWIDTH_SUPERWIDEBAND = 1104;
const BANDWIDTH_FULLBAND = 1105;
const F20 = 960;
const F10 = 480;
const F5 = 240;
const F2_5 = 120;
const SILENCE = new Uint8Array([0xff, 0xff]);

/** One packet's TOC and frame boundaries (opus_packet_parse_impl); reused across packets. */
export class OpusPacket {
    toc = 0;
    count = 0;
    /** Byte offsets of the frames within the buffer that was parsed. */
    readonly offsets = new Int32Array(48);
    readonly sizes = new Int32Array(48);
    /**
     * Bytes consumed from the start, including padding (the next stream of a multistream packet
     * begins here).
     */
    packetLength = 0;

    get mode(): number {
        if (this.toc & 0x80) return MODE_CELT_ONLY;
        if ((this.toc & 0x60) === 0x60) return MODE_HYBRID;
        return MODE_SILK_ONLY;
    }

    get bandwidth(): number {
        const toc = this.toc;
        if (toc & 0x80) {
            const bandwidth = BANDWIDTH_MEDIUMBAND + ((toc >> 5) & 0x3);
            return bandwidth === BANDWIDTH_MEDIUMBAND ? BANDWIDTH_NARROWBAND : bandwidth;
        }
        if ((toc & 0x60) === 0x60) return toc & 0x10 ? BANDWIDTH_FULLBAND : BANDWIDTH_SUPERWIDEBAND;
        return BANDWIDTH_NARROWBAND + ((toc >> 5) & 0x3);
    }

    get streamChannels(): number {
        return this.toc & 0x4 ? 2 : 1;
    }

    /** 48 kHz samples of one frame. */
    get frameSamples(): number {
        return opusFrameSamples(this.toc);
    }

    /**
     * Parses the packet at data[start, start + length); self-delimited packets (all but the last
     * stream of a multistream packet) carry their last frame's length explicitly. Throws DECODE on
     * malformed packing.
     */
    parse(data: Uint8Array, start: number, length: number, selfDelimited: boolean): void {
        if (length < 1) throw new DecodeError('Opus packet is empty');
        const sizes = this.sizes;
        const offsets = this.offsets;
        const toc = data[start]!;
        this.toc = toc;
        let at = start + 1;
        let len = length - 1;
        let lastSize = len;
        let count: number;
        let cbr = false;
        let pad = 0;
        const invalid = (): never => {
            throw new DecodeError('Opus packet has invalid frame packing');
        };
        const parseSize = (index: number): void => {
            if (len < 1) invalid();
            const first = data[at]!;
            if (first < 252) {
                sizes[index] = first;
                at++;
                len--;
            } else {
                if (len < 2) invalid();
                sizes[index] = 4 * data[at + 1]! + first;
                at += 2;
                len -= 2;
            }
        };

        switch (toc & 0x3) {
            case 0:
                count = 1;
                break;
            case 1:
                count = 2;
                cbr = true;
                if (!selfDelimited) {
                    if (len & 0x1) invalid();
                    lastSize = len >> 1;
                    sizes[0] = lastSize;
                }
                break;
            case 2:
                count = 2;
                parseSize(0);
                if (sizes[0]! > len) invalid();
                lastSize = len - sizes[0]!;
                break;
            default: {
                if (len < 1) invalid();
                const ch = data[at++]!;
                count = ch & 0x3f;
                if (count <= 0 || opusFrameSamples(toc) * count > MAX_FRAME_SAMPLES) invalid();
                len--;
                if (ch & 0x40) {
                    let p: number;
                    do {
                        if (len <= 0) invalid();
                        p = data[at++]!;
                        len--;
                        const tmp = p === 255 ? 254 : p;
                        len -= tmp;
                        pad += tmp;
                    } while (p === 255);
                }

                if (len < 0) invalid();
                cbr = !(ch & 0x80);
                if (!cbr) {
                    lastSize = len;
                    for (let i = 0; i < count - 1; i++) {
                        const before = len;
                        parseSize(i);
                        if (sizes[i]! > len) invalid();
                        lastSize -= before - len + sizes[i]!;
                    }
                    if (lastSize < 0) invalid();
                } else if (!selfDelimited) {
                    lastSize = Math.floor(len / count);
                    if (lastSize * count !== len) invalid();
                    for (let i = 0; i < count - 1; i++) sizes[i] = lastSize;
                }
            }
        }

        if (selfDelimited) {
            const before = len;
            parseSize(count - 1);
            if (sizes[count - 1]! > len) invalid();
            if (cbr) {
                if (sizes[count - 1]! * count > len) invalid();
                for (let i = 0; i < count - 1; i++) sizes[i] = sizes[count - 1]!;
            } else if (before - len + sizes[count - 1]! > lastSize) invalid();
        } else {
            if (lastSize > 1275) invalid();
            sizes[count - 1] = lastSize;
        }

        for (let i = 0; i < count; i++) {
            offsets[i] = at;
            at += sizes[i]!;
        }

        if (at - start > length) invalid();
        this.count = count;
        this.packetLength = pad + (at - start);
    }
}

/** 48 kHz samples per frame of a TOC byte. */
function opusFrameSamples(toc: number): number {
    if (toc & 0x80) return (480 << ((toc >> 3) & 0x3)) >> 2;
    if ((toc & 0x60) === 0x60) return toc & 0x08 ? 960 : 480;
    const size = (toc >> 3) & 0x3;
    return size === 3 ? 2880 : 480 << size;
}

/**
 * 48 kHz samples of a whole packet (frame count times frame size), or 0 for an unparsable packet.
 */
export function opusPacketSamples(data: Uint8Array): number {
    if (data.length < 1) return 0;
    const code = data[0]! & 0x3;
    let count: number;
    if (code === 0) count = 1;
    else if (code !== 3) count = 2;
    else if (data.length < 2) return 0;
    else count = data[1]! & 0x3f;
    const samples = count * opusFrameSamples(data[0]!);
    return samples > MAX_FRAME_SAMPLES ? 0 : samples;
}

/** One elementary Opus stream (mono or stereo) decoded at 48 kHz, mirroring opus_decoder.c. */
class OpusStreamDecoder {
    readonly channels: number;
    private readonly silk = new SilkDecoder();
    private readonly celt: CeltDecoder;
    private readonly rangeDecoder = new RangeDecoder();
    private readonly scratchDecoder = new RangeDecoder();
    private readonly control: SilkDecodeControl = {
        nChannelsAPI: 1,
        nChannelsInternal: 1,
        internalSampleRate: 16000,
        payloadSizeMs: 20,
    };
    private streamChannels: number;
    private bandwidth = 0;
    private mode = 0;
    private prevMode = 0;
    private frameSize = F2_5;
    private prevRedundancy = false;
    private readonly packet = new OpusPacket();
    private readonly pcmSilk: Int16Array;
    private readonly transition: Float32Array;
    private readonly redundant: Float32Array;

    constructor(channels: number) {
        if (channels !== 1 && channels !== 2)
            throw new DecodeError('Opus streams are mono or stereo');
        this.channels = channels;
        this.streamChannels = channels;
        this.celt = new CeltDecoder(channels);
        this.control.nChannelsAPI = channels;
        this.pcmSilk = new Int16Array(MAX_FRAME_SAMPLES * channels);
        this.transition = new Float32Array(F5 * channels);
        this.redundant = new Float32Array(F5 * channels);
    }

    reset(): void {
        this.silk.reset();
        this.celt.reset();
        this.streamChannels = this.channels;
        this.bandwidth = 0;
        this.mode = 0;
        this.prevMode = 0;
        this.frameSize = F2_5;
        this.prevRedundancy = false;
    }

    /**
     * Decodes one packet (parsed as `packet`, frames in `data`) into `pcm` interleaved at `pcmAt`;
     * returns the samples per channel written. `pcm` must hold the packet's samples.
     */
    decodePacket(data: Uint8Array, packet: OpusPacket, pcm: Float32Array, pcmAt: number): number {
        this.mode = packet.mode;
        this.bandwidth = packet.bandwidth;
        this.frameSize = packet.frameSamples;
        this.streamChannels = packet.streamChannels;
        let samples = 0;
        for (let i = 0; i < packet.count; i++) {
            const written = this.decodeFrame(
                data,
                packet.offsets[i]!,
                packet.sizes[i]!,
                pcm,
                pcmAt + samples * this.channels,
                this.frameSize,
            );
            samples += written;
        }
        return samples;
    }

    /** Decodes a whole single-stream packet held in `data`. */
    decode(data: Uint8Array, pcm: Float32Array, pcmAt = 0): number {
        this.packet.parse(data, 0, data.length, false);
        return this.decodePacket(data, this.packet, pcm, pcmAt);
    }

    /** Conceals `frameSize` lost samples (a multiple of 120) into `pcm` at `pcmAt`. */
    conceal(pcm: Float32Array, pcmAt: number, frameSize: number): number {
        let count = 0;
        while (count < frameSize) {
            count += this.decodeFrame(
                null,
                0,
                0,
                pcm,
                pcmAt + count * this.channels,
                frameSize - count,
            );
        }
        return count;
    }

    private decodeFrame(
        data: Uint8Array | null,
        start: number,
        len: number,
        pcm: Float32Array,
        pcmAt: number,
        frameSize: number,
    ): number {
        const channels = this.channels;
        frameSize = Math.min(frameSize, MAX_FRAME_SAMPLES);
        if (len <= 1) {
            data = null;
            frameSize = Math.min(frameSize, this.frameSize);
        }

        let audiosize: number;
        let mode: number;
        let bandwidth: number;
        const dec = this.rangeDecoder;
        if (data !== null) {
            audiosize = this.frameSize;
            mode = this.mode;
            bandwidth = this.bandwidth;
            dec.init(data, start, len);
        } else {
            audiosize = frameSize;
            mode = this.prevMode;
            bandwidth = 0;
            if (mode === 0) {
                pcm.fill(0, pcmAt, pcmAt + audiosize * channels);
                return audiosize;
            }

            if (audiosize > F20) {
                do {
                    const ret = this.decodeFrame(null, 0, 0, pcm, pcmAt, Math.min(audiosize, F20));
                    pcmAt += ret * channels;
                    audiosize -= ret;
                } while (audiosize > 0);
                return frameSize;
            } else if (audiosize < F20) {
                if (audiosize > F10) audiosize = F10;
                else if (mode !== MODE_SILK_ONLY && audiosize > F5 && audiosize < F10)
                    audiosize = F5;
            }
        }

        let transition = false;
        let transitionPcm: Float32Array | null = null;
        if (
            data !== null &&
            this.prevMode > 0 &&
            ((mode === MODE_CELT_ONLY &&
                this.prevMode !== MODE_CELT_ONLY &&
                !this.prevRedundancy) ||
                (mode !== MODE_CELT_ONLY && this.prevMode === MODE_CELT_ONLY))
        )
            transition = true;

        if (transition && mode === MODE_CELT_ONLY) {
            transitionPcm = this.transition;
            this.decodeFrame(null, 0, 0, transitionPcm, 0, Math.min(F5, audiosize));
        }

        if (audiosize > frameSize)
            throw new DecodeError('Opus frame is longer than its packet declares');
        frameSize = audiosize;
        const pcmSilk = this.pcmSilk;
        if (mode !== MODE_CELT_ONLY) {
            if (this.prevMode === MODE_CELT_ONLY) this.silk.reset();
            const control = this.control;
            control.payloadSizeMs = Math.max(10, Math.floor((1000 * audiosize) / OPUS_SAMPLE_RATE));
            if (data !== null) {
                control.nChannelsInternal = this.streamChannels;
                if (mode === MODE_SILK_ONLY) {
                    if (bandwidth === BANDWIDTH_NARROWBAND) control.internalSampleRate = 8000;
                    else if (bandwidth === BANDWIDTH_MEDIUMBAND) control.internalSampleRate = 12000;
                    else control.internalSampleRate = 16000;
                } else control.internalSampleRate = 16000;
            }

            const lostFlag = data === null ? FLAG_PACKET_LOST : FLAG_DECODE_NORMAL;
            let decoded = 0;
            do {
                decoded += this.silk.decode(
                    control,
                    lostFlag,
                    decoded === 0,
                    data === null ? null : dec,
                    pcmSilk,
                    decoded * channels,
                );
            } while (decoded < frameSize);
        }

        let startBand = 0;
        let redundancy = false;
        let redundancyBytes = 0;
        let celtToSilk = false;
        if (
            mode !== MODE_CELT_ONLY &&
            data !== null &&
            dec.tell() + 17 + 20 * (this.mode === MODE_HYBRID ? 1 : 0) <= 8 * len
        ) {
            if (mode === MODE_HYBRID) redundancy = dec.decodeBitLogp(12) === 1;
            else redundancy = true;
            if (redundancy) {
                celtToSilk = dec.decodeBitLogp(1) === 1;
                redundancyBytes =
                    mode === MODE_HYBRID ? dec.decodeUint(256) + 2 : len - ((dec.tell() + 7) >> 3);
                len -= redundancyBytes;
                if (len * 8 < dec.tell()) {
                    len = 0;
                    redundancyBytes = 0;
                    redundancy = false;
                }

                dec.shrink(redundancyBytes);
            }
        }

        if (mode !== MODE_CELT_ONLY) startBand = 17;
        if (redundancy) transition = false;
        if (transition && mode !== MODE_CELT_ONLY) {
            transitionPcm = this.transition;
            this.decodeFrame(null, 0, 0, transitionPcm, 0, Math.min(F5, audiosize));
        }

        const celt = this.celt;
        if (bandwidth) {
            let endband = 21;
            if (bandwidth === BANDWIDTH_NARROWBAND) endband = 13;
            else if (bandwidth === BANDWIDTH_MEDIUMBAND || bandwidth === BANDWIDTH_WIDEBAND)
                endband = 17;
            else if (bandwidth === BANDWIDTH_SUPERWIDEBAND) endband = 19;
            celt.setEndBand(endband);
        }

        celt.setStreamChannels(this.streamChannels);
        const redundant = this.redundant;
        if (redundancy && celtToSilk) {
            celt.setStartBand(0);
            celt.decode(
                data,
                start + len,
                redundancyBytes,
                redundant,
                0,
                F5,
                null,
                false,
                this.scratchDecoder,
            );
        }

        celt.setStartBand(startBand);
        if (mode !== MODE_SILK_ONLY) {
            const celtFrameSize = Math.min(F20, frameSize);
            if (mode !== this.prevMode && this.prevMode > 0 && !this.prevRedundancy) celt.reset();
            celt.decode(
                data,
                start,
                len,
                pcm,
                pcmAt,
                celtFrameSize,
                data === null ? null : dec,
                false,
                this.scratchDecoder,
            );
        } else {
            pcm.fill(0, pcmAt, pcmAt + frameSize * channels);
            if (
                this.prevMode === MODE_HYBRID &&
                !(redundancy && celtToSilk && this.prevRedundancy)
            ) {
                celt.setStartBand(0);
                celt.decode(SILENCE, 0, 2, pcm, pcmAt, F2_5, null, false, this.scratchDecoder);
            }
        }

        if (mode !== MODE_CELT_ONLY) {
            const total = frameSize * channels;
            for (let i = 0; i < total; i++) pcm[pcmAt + i] += pcmSilk[i]! / 32768;
        }

        const window = celt.window;
        if (redundancy && !celtToSilk) {
            celt.reset();
            celt.setStartBand(0);
            celt.decode(
                data,
                start + len,
                redundancyBytes,
                redundant,
                0,
                F5,
                null,
                false,
                this.scratchDecoder,
            );
            smoothFade(
                pcm,
                pcmAt + channels * (frameSize - F2_5),
                redundant,
                channels * F2_5,
                pcm,
                pcmAt + channels * (frameSize - F2_5),
                F2_5,
                channels,
                window,
            );
        }

        if (redundancy && celtToSilk) {
            for (let i = 0; i < channels * F2_5; i++) pcm[pcmAt + i] = redundant[i]!;
            smoothFade(
                redundant,
                channels * F2_5,
                pcm,
                pcmAt + channels * F2_5,
                pcm,
                pcmAt + channels * F2_5,
                F2_5,
                channels,
                window,
            );
        }

        if (transition && transitionPcm) {
            if (audiosize >= F5) {
                for (let i = 0; i < channels * F2_5; i++) pcm[pcmAt + i] = transitionPcm[i]!;
                smoothFade(
                    transitionPcm,
                    channels * F2_5,
                    pcm,
                    pcmAt + channels * F2_5,
                    pcm,
                    pcmAt + channels * F2_5,
                    F2_5,
                    channels,
                    window,
                );
            } else smoothFade(transitionPcm, 0, pcm, pcmAt, pcm, pcmAt, F2_5, channels, window);
        }

        this.prevMode = mode;
        this.prevRedundancy = redundancy && !celtToSilk;
        return audiosize;
    }
}

function smoothFade(
    in1: Float32Array,
    in1At: number,
    in2: Float32Array,
    in2At: number,
    out: Float32Array,
    outAt: number,
    overlap: number,
    channels: number,
    window: Float32Array,
): void {
    for (let c = 0; c < channels; c++) {
        for (let i = 0; i < overlap; i++) {
            const w = window[i]! * window[i]!;
            out[outAt + i * channels + c] =
                w * in2[in2At + i * channels + c]! + (1 - w) * in1[in1At + i * channels + c]!;
        }
    }
}

/** Decodes every stream of an Opus packet and scatters the results into planar 48 kHz output. */
export class OpusMultistreamDecoder {
    readonly layout: OpusLayout;
    private readonly decoders: OpusStreamDecoder[] = [];
    private readonly packet = new OpusPacket();
    private readonly streamPcm = new Float32Array(2 * MAX_FRAME_SAMPLES);

    constructor(layout: OpusLayout) {
        const { channels, streams, coupledStreams, mapping } = layout;
        if (
            channels < 1 ||
            channels > 255 ||
            streams < 1 ||
            coupledStreams > streams ||
            streams + coupledStreams > 255
        )
            throw new DecodeError('Opus channel mapping is invalid');
        for (let i = 0; i < channels; i++)
            if (mapping[i]! >= streams + coupledStreams && mapping[i] !== 255)
                throw new DecodeError('Opus channel mapping names a missing stream');
        this.layout = layout;
        for (let s = 0; s < streams; s++)
            this.decoders.push(new OpusStreamDecoder(s < coupledStreams ? 2 : 1));
    }

    reset(): void {
        for (const decoder of this.decoders) decoder.reset();
    }

    /** 48 kHz samples the packet decodes to, validating that every stream agrees. */
    packetSamples(data: Uint8Array): number {
        let at = 0;
        let len = data.length;
        let samples = 0;
        for (let s = 0; s < this.layout.streams; s++) {
            if (len <= 0) throw new DecodeError('Opus multistream packet is truncated');
            this.packet.parse(data, at, len, s !== this.layout.streams - 1);
            const streamSamples = this.packet.count * this.packet.frameSamples;
            if (s !== 0 && streamSamples !== samples)
                throw new DecodeError('Opus multistream packet has streams of different durations');
            samples = streamSamples;
            at += this.packet.packetLength;
            len -= this.packet.packetLength;
        }
        return samples;
    }

    /**
     * Decodes a packet into `planes` (one Float32Array per output channel, at least the packet's
     * samples long).
     */
    decode(data: Uint8Array, planes: readonly Float32Array[]): number {
        const frameSize = this.packetSamples(data);
        let at = 0;
        let len = data.length;
        for (let s = 0; s < this.layout.streams; s++) {
            const decoder = this.decoders[s]!;
            this.packet.parse(data, at, len, s !== this.layout.streams - 1);
            const written = decoder.decodePacket(data, this.packet, this.streamPcm, 0);
            if (written !== frameSize)
                throw new DecodeError('Opus stream decoded to an unexpected length');
            at += this.packet.packetLength;
            len -= this.packet.packetLength;
            this.scatter(s, decoder.channels, frameSize, planes);
        }
        this.fillSilence(planes, frameSize);
        return frameSize;
    }

    /**
     * Conceals `frameSize` lost samples (a multiple of 120, at most 5760) in every stream into
     * `planes` at `at`.
     */
    conceal(planes: readonly Float32Array[], frameSize: number, at = 0): number {
        for (let s = 0; s < this.layout.streams; s++) {
            const decoder = this.decoders[s]!;
            decoder.conceal(this.streamPcm, 0, frameSize);
            this.scatter(s, decoder.channels, frameSize, planes, at);
        }
        this.fillSilence(planes, frameSize, at);
        return frameSize;
    }

    private scatter(
        stream: number,
        channels: number,
        frameSize: number,
        planes: readonly Float32Array[],
        at = 0,
    ): void {
        const { mapping, coupledStreams } = this.layout;
        const pcm = this.streamPcm;
        for (let channel = 0; channel < this.layout.channels; channel++) {
            const target = mapping[channel]!;
            let source: number;
            if (channels === 2) {
                if (target === stream * 2) source = 0;
                else if (target === stream * 2 + 1) source = 1;
                else continue;
            } else if (target === stream + coupledStreams) source = 0;
            else continue;
            const plane = planes[channel]!;
            for (let i = 0; i < frameSize; i++) plane[at + i] = pcm[i * channels + source]!;
        }
    }

    private fillSilence(planes: readonly Float32Array[], frameSize: number, at = 0): void {
        for (let channel = 0; channel < this.layout.channels; channel++)
            if (this.layout.mapping[channel] === 255) planes[channel]!.fill(0, at, at + frameSize);
    }
}
