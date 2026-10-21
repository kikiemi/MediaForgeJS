import { pow43Table } from '../shared/pow43';
import { DecodeError, throwIfAborted } from '../../core/errors/errors';
import {
    MP3_DECODER_DELAY,
    parseMpegAudioHeader,
    parseMpegGaplessInfo,
} from '../../core/codec-config/audio/mpeg-audio-header';
import {
    ALIAS_CA,
    ALIAS_CS,
    MDCT_COS,
    MDCT_COS12,
    MDCT_WIN,
    MDCT_WIN_SHORT12,
    MDCT_WIN_START,
    MDCT_WIN_STOP,
    SFC_SLEN,
    applyFrequencyInversion,
} from './mp3-tables';
import {
    GAIN_OFFSET,
    GAIN_POW,
    INTENSITY_LSF,
    INTENSITY_MPEG1,
    LSF_SCALEFACTOR_BANDS,
    PRETAB,
    PRIMARY_BITS,
    QUAD_A_LOOKUP,
    SCALEFACTOR_POW,
    SFB_LONG,
    SFB_SHORT,
    pairLookup,
    type HuffmanLookup,
} from './mp3-decoder-tables';
import type { TrackInfo } from '../../core/model/track';
import { yieldEventLoop } from '../../core/io/event-loop';
import {
    MpegSynthesisFilterbank,
    StreamingMpegLayer12Decoder,
    isMpegAudioTrailer,
    skipId3v2,
} from './layer12-decoder';
import type { BuiltinAudioCodec, DecodeOptions } from '../../core/contracts/decoder';
import { StreamingResampler } from '../pcm/streaming-resampler';
import { downmixChannels } from '../pcm/audio-buffer-tools';

export interface Mp3FrameHeader {
    /** MPEG-1 (true) or the MPEG-2 / MPEG-2.5 low sample-rate extension (false). */
    readonly mpeg1: boolean;
    readonly sampleRate: number;
    readonly channels: number;
    /** 0 stereo, 1 joint stereo, 2 dual channel, 3 mono. */
    readonly mode: number;
    readonly modeExtension: number;
    readonly crc: boolean;
    readonly frameLength: number;
    /** 1152 for MPEG-1, 576 for the low sample-rate extension. */
    readonly samplesPerFrame: number;
    readonly sideInfoLength: number;
}

export interface DecodedMp3 {
    readonly sampleRate: number;
    readonly channels: number;
    readonly sampleFrames: number;
    /** Planar samples in [-1, 1]. */
    readonly channelData: readonly Float32Array[];
    /** Audio frames decoded, excluding a Xing/Info frame. */
    readonly frames: number;
}

/** Frames decodeMp3() decodes between yields to the event loop. */
const YIELD_FRAMES = 64;
const RESERVOIR_BYTES = 511;
const MAX_FRAME_BYTES = 1441;
const MAIN_DATA_PADDING = 8;

/** Parses a Layer III header; free-format streams (bitrate index 0) raise a DecodeError. */
export function parseMp3FrameHeader(data: Uint8Array, offset: number): Mp3FrameHeader | null {
    if (offset + 4 > data.length || data[offset] !== 0xff || (data[offset + 1]! & 0xe6) !== 0xe2)
        return null;
    const versionBits = (data[offset + 1]! >> 3) & 0x03;
    if (versionBits === 1 || ((data[offset + 2]! >> 2) & 0x03) === 3) return null;
    if ((data[offset + 2]! & 0xf0) === 0)
        throw new DecodeError('MP3 free-format bitrate is not supported');
    const header = parseMpegAudioHeader(data, offset);
    if (!header || header.format !== 'mp3') return null;
    const mpeg1 = versionBits === 3;
    const mode = (data[offset + 3]! >> 6) & 0x03;
    return {
        mpeg1,
        sampleRate: header.sampleRate,
        channels: header.channels,
        mode,
        modeExtension: (data[offset + 3]! >> 4) & 0x03,
        crc: (data[offset + 1]! & 0x01) === 0,
        frameLength: header.frameLength,
        samplesPerFrame: header.samplesPerFrame,
        sideInfoLength: mpeg1 ? (mode === 3 ? 17 : 32) : mode === 3 ? 9 : 17,
    };
}

/** True for a Xing/Info frame, which carries stream metadata instead of audio. */
export function isMp3InfoFrame(frame: Uint8Array): boolean {
    return parseMpegGaplessInfo(frame) !== null;
}

/**
 * CRC-16 with polynomial 0x8005 and initial value 0xffff over the given byte ranges (ISO/IEC
 * 11172-3 2.4.3.1).
 */
function mpegCrc16(data: Uint8Array, ranges: ReadonlyArray<readonly [number, number]>): number {
    let crc = 0xffff;
    for (const [start, end] of ranges) {
        for (let index = start; index < end; index++) {
            crc ^= data[index]! << 8;
            for (let bit = 0; bit < 8; bit++)
                crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
        }
    }
    return crc;
}

/** MSB-first reader; peeks assume at least four readable bytes past any legal position. */
class BitReader {
    position = 0;
    constructor(private readonly data: Uint8Array) {}

    peek(count: number): number {
        if (count === 0) return 0;
        const byte = this.position >>> 3;
        const data = this.data;
        const word =
            (data[byte]! << 24) |
            (data[byte + 1]! << 16) |
            (data[byte + 2]! << 8) |
            (data[byte + 3]! | 0);
        return (word << (this.position & 7)) >>> (32 - count);
    }

    bits(count: number): number {
        const value = this.peek(count);
        this.position += count;
        return value;
    }
}

class GranuleInfo {
    part23Length = 0;
    bigValues = 0;
    globalGain = 0;
    scalefacCompress = 0;
    windowSwitching = 0;
    blockType = 0;
    mixed = 0;
    readonly tableSelect = new Int32Array(3);
    readonly subblockGain = new Int32Array(3);
    region0Count = 0;
    region1Count = 0;
    preflag = 0;
    scalefacScale = 0;
    count1Table = 0;
}

function readSideInfo(
    reader: BitReader,
    header: Mp3FrameHeader,
    granules: readonly (readonly GranuleInfo[])[],
    scfsi: Int32Array,
): number {
    const channels = header.channels;
    const mainDataBegin = reader.bits(header.mpeg1 ? 9 : 8);
    reader.bits(header.mpeg1 ? (channels === 1 ? 5 : 3) : channels === 1 ? 1 : 2);
    if (header.mpeg1) {
        for (let channel = 0; channel < channels; channel++) {
            for (let band = 0; band < 4; band++) scfsi[channel * 4 + band] = reader.bits(1);
        }
    } else scfsi.fill(0);

    const granuleCount = header.mpeg1 ? 2 : 1;
    for (let granule = 0; granule < granuleCount; granule++) {
        for (let channel = 0; channel < channels; channel++) {
            const info = granules[granule]![channel]!;
            info.part23Length = reader.bits(12);
            info.bigValues = reader.bits(9);
            info.globalGain = reader.bits(8);
            info.scalefacCompress = reader.bits(header.mpeg1 ? 4 : 9);
            info.windowSwitching = reader.bits(1);
            if (info.windowSwitching) {
                info.blockType = reader.bits(2);
                info.mixed = reader.bits(1);
                info.tableSelect[0] = reader.bits(5);
                info.tableSelect[1] = reader.bits(5);
                info.tableSelect[2] = 0;
                info.subblockGain[0] = reader.bits(3);
                info.subblockGain[1] = reader.bits(3);
                info.subblockGain[2] = reader.bits(3);
                info.region0Count = info.blockType === 2 && !info.mixed ? 8 : 7;
                info.region1Count = 20 - info.region0Count;
                if (info.blockType === 0)
                    throw new DecodeError('MP3 window switching with block type 0 is invalid');
            } else {
                info.blockType = 0;
                info.mixed = 0;
                info.tableSelect[0] = reader.bits(5);
                info.tableSelect[1] = reader.bits(5);
                info.tableSelect[2] = reader.bits(5);
                info.subblockGain.fill(0);
                info.region0Count = reader.bits(4);
                info.region1Count = reader.bits(3);
            }

            info.preflag = header.mpeg1 ? reader.bits(1) : 0;
            info.scalefacScale = reader.bits(1);
            info.count1Table = reader.bits(1);
            if (info.bigValues > 288) throw new DecodeError('MP3 big_values exceeds 288');
        }
    }

    return mainDataBegin;
}

interface ChannelState {
    readonly overlap: Float64Array;
    readonly synth: MpegSynthesisFilterbank;
    readonly scalefac: Int32Array;
    readonly previousScalefac: Int32Array;
    readonly quantized: Int32Array;
    readonly spectrum: Float64Array;
    nonZeroEnd: number;
}

function makeChannel(): ChannelState {
    return {
        overlap: new Float64Array(32 * 18),
        synth: new MpegSynthesisFilterbank(),
        scalefac: new Int32Array(40),
        previousScalefac: new Int32Array(40),
        quantized: new Int32Array(576),
        spectrum: new Float64Array(576),
        nonZeroEnd: 0,
    };
}

const SCFSI_BANDS = [0, 6, 11, 16, 21];

function readScalefactorsMpeg1(
    reader: BitReader,
    info: GranuleInfo,
    channel: ChannelState,
    granule: number,
    scfsi: Int32Array,
    channelIndex: number,
): void {
    const [slen1, slen2] = SFC_SLEN[info.scalefacCompress]!;
    const scalefac = channel.scalefac;
    scalefac.fill(0);
    if (info.blockType === 2) {
        let index = 0;
        if (info.mixed) {
            for (let sfb = 0; sfb < 8; sfb++) scalefac[sfb] = reader.bits(slen1);
            index = 9;
        }

        const start = info.mixed ? 3 : 0;
        for (let sfb = start; sfb < 12; sfb++) {
            const slen = sfb < 6 ? slen1 : slen2;
            for (let window = 0; window < 3; window++) scalefac[index++] = reader.bits(slen);
        }

        return;
    }

    for (let band = 0; band < 4; band++) {
        const slen = band < 2 ? slen1 : slen2;
        const end = SCFSI_BANDS[band + 1]!;
        if (granule === 1 && scfsi[channelIndex * 4 + band]) {
            for (let sfb = SCFSI_BANDS[band]!; sfb < end; sfb++)
                scalefac[sfb] = channel.previousScalefac[sfb]!;
        } else {
            for (let sfb = SCFSI_BANDS[band]!; sfb < end; sfb++) scalefac[sfb] = reader.bits(slen);
        }
    }

    channel.previousScalefac.set(scalefac);
}

function readScalefactorsLsf(
    reader: BitReader,
    info: GranuleInfo,
    channel: ChannelState,
    intensityChannel: boolean,
): void {
    const scalefac = channel.scalefac;
    scalefac.fill(0);
    let compress = info.scalefacCompress;
    const slen = [0, 0, 0, 0];
    let table: number;
    info.preflag = 0;
    if (!intensityChannel) {
        if (compress < 400) {
            slen[0] = Math.floor((compress >> 4) / 5);
            slen[1] = (compress >> 4) % 5;
            slen[2] = (compress & 15) >> 2;
            slen[3] = compress & 3;
            table = 0;
        } else if (compress < 500) {
            compress -= 400;
            slen[0] = Math.floor((compress >> 2) / 5);
            slen[1] = (compress >> 2) % 5;
            slen[2] = compress & 3;
            table = 1;
        } else {
            compress -= 500;
            slen[0] = Math.floor(compress / 3);
            slen[1] = compress % 3;
            table = 2;
            info.preflag = 1;
        }
    } else {
        compress >>= 1;
        if (compress < 180) {
            slen[0] = Math.floor(compress / 36);
            slen[1] = Math.floor((compress % 36) / 6);
            slen[2] = (compress % 36) % 6;
            table = 3;
        } else if (compress < 244) {
            compress -= 180;
            slen[0] = (compress & 63) >> 4;
            slen[1] = (compress & 15) >> 2;
            slen[2] = compress & 3;
            table = 4;
        } else {
            compress -= 244;
            slen[0] = Math.floor(compress / 3);
            slen[1] = compress % 3;
            table = 5;
        }
    }

    // Mixed blocks transmit six long bands and then short bands from band 3, stored at 3 * band +
    // window.
    const layout = info.blockType === 2 ? (info.mixed ? 2 : 1) : 0;
    const counts = LSF_SCALEFACTOR_BANDS[table]![layout]!;
    let position = 0;
    for (let group = 0; group < 4; group++) {
        const bits = slen[group]!;
        for (let count = counts[group]!; count > 0; count--, position++) {
            const index = layout === 2 && position >= 6 ? position + 3 : position;
            const value = reader.bits(bits);
            scalefac[index] = value;
        }
    }
}

function decodeCount1(
    reader: BitReader,
    info: GranuleInfo,
    quantized: Int32Array,
    start: number,
    end: number,
): number {
    let index = start;
    while (index + 4 <= 576 && reader.position < end) {
        let v: number;
        let w: number;
        let x: number;
        let y: number;
        if (info.count1Table === 0) {
            const entry = QUAD_A_LOOKUP[reader.peek(8)]!;
            reader.position += entry >> 8;
            const bits = entry & 15;
            v = bits >> 3;
            w = (bits >> 2) & 1;
            x = (bits >> 1) & 1;
            y = bits & 1;
        } else {
            const bits = reader.bits(4) ^ 15;
            v = bits >> 3;
            w = (bits >> 2) & 1;
            x = (bits >> 1) & 1;
            y = bits & 1;
        }
        if (v && reader.bits(1)) v = -1;
        if (w && reader.bits(1)) w = -1;
        if (x && reader.bits(1)) x = -1;
        if (y && reader.bits(1)) y = -1;
        if (reader.position > end) break;
        quantized[index] = v;
        quantized[index + 1] = w;
        quantized[index + 2] = x;
        quantized[index + 3] = y;
        index += 4;
    }
    return index;
}

function decodePairs(
    reader: BitReader,
    tableId: number,
    quantized: Int32Array,
    start: number,
    end: number,
): void {
    if (tableId === 0) {
        quantized.fill(0, start, end);
        return;
    }
    const lookup: HuffmanLookup | null = pairLookup(tableId);
    if (!lookup) throw new DecodeError('MP3 table_select names a reserved Huffman table');
    const { primary, secondary, secondaryBits, linbits } = lookup;
    for (let index = start; index < end; index += 2) {
        let entry = primary[reader.peek(PRIMARY_BITS)]!;
        if (entry < 0) {
            const table = secondary[-entry - 1]!;
            reader.position += PRIMARY_BITS;
            entry = table[reader.peek(secondaryBits)]!;
            if (entry === 0) throw new DecodeError('MP3 Huffman code is invalid');
            reader.position += (entry >> 8) - PRIMARY_BITS;
        } else {
            if (entry === 0) throw new DecodeError('MP3 Huffman code is invalid');
            reader.position += entry >> 8;
        }
        let x = (entry >> 4) & 15;
        let y = entry & 15;
        if (x === 15 && linbits) x += reader.bits(linbits);
        if (x && reader.bits(1)) x = -x;
        if (y === 15 && linbits) y += reader.bits(linbits);
        if (y && reader.bits(1)) y = -y;
        quantized[index] = x;
        quantized[index + 1] = y;
    }
}

function decodeHuffman(
    reader: BitReader,
    info: GranuleInfo,
    channel: ChannelState,
    header: Mp3FrameHeader,
    end: number,
): void {
    const quantized = channel.quantized;
    const long = SFB_LONG[header.sampleRate]!;
    const short = SFB_SHORT[header.sampleRate]!;
    const bigEnd = info.bigValues * 2;
    let region1Start: number;
    let region2Start: number;
    if (info.windowSwitching) {
        region1Start = info.blockType === 2 ? 3 * short[3]! : long[8]!;
        region2Start = 576;
    } else {
        region1Start = long[Math.min(22, info.region0Count + 1)]!;
        region2Start = long[Math.min(22, info.region0Count + info.region1Count + 2)]!;
    }

    region1Start = Math.min(region1Start, bigEnd);
    region2Start = Math.max(region1Start, Math.min(region2Start, bigEnd));
    decodePairs(reader, info.tableSelect[0]!, quantized, 0, region1Start);
    decodePairs(reader, info.tableSelect[1]!, quantized, region1Start, region2Start);
    decodePairs(reader, info.tableSelect[2]!, quantized, region2Start, bigEnd);
    if (reader.position > end) throw new DecodeError('MP3 big_values data overruns part2_3_length');
    const count1End = decodeCount1(reader, info, quantized, bigEnd, end);
    quantized.fill(0, count1End, 576);
    let nonZeroEnd = count1End;
    while (nonZeroEnd > 0 && quantized[nonZeroEnd - 1] === 0) nonZeroEnd--;
    channel.nonZeroEnd = nonZeroEnd;
}

function requantizeBand(
    quantized: Int32Array,
    spectrum: Float64Array,
    start: number,
    end: number,
    gain: number,
): void {
    const POW43 = pow43Table();
    for (let index = start; index < end; index++) {
        const value = quantized[index]!;
        spectrum[index] =
            value === 0 ? 0 : value < 0 ? -POW43[-value]! * gain : POW43[value]! * gain;
    }
}

function requantize(info: GranuleInfo, channel: ChannelState, header: Mp3FrameHeader): void {
    const { quantized, spectrum, scalefac, nonZeroEnd } = channel;
    const long = SFB_LONG[header.sampleRate]!;
    const short = SFB_SHORT[header.sampleRate]!;
    const scale = SCALEFACTOR_POW[info.scalefacScale]!;
    const globalGain = GAIN_POW[info.globalGain + GAIN_OFFSET]!;
    spectrum.fill(0, nonZeroEnd, 576);
    if (info.blockType !== 2 || info.mixed) {
        const longBands = info.blockType === 2 ? (header.mpeg1 ? 8 : 6) : 22;
        for (let sfb = 0; sfb < longBands; sfb++) {
            const start = long[sfb]!;
            if (start >= nonZeroEnd) break;
            const gain = globalGain * scale[scalefac[sfb]! + (info.preflag ? PRETAB[sfb]! : 0)]!;
            requantizeBand(quantized, spectrum, start, Math.min(long[sfb + 1]!, nonZeroEnd), gain);
        }
    }
    if (info.blockType === 2) {
        const firstShort = info.mixed ? 3 : 0;
        for (let sfb = firstShort; sfb < 13; sfb++) {
            const width = short[sfb + 1]! - short[sfb]!;
            const base = 3 * short[sfb]!;
            if (base >= nonZeroEnd) break;
            for (let window = 0; window < 3; window++) {
                const start = base + window * width;
                if (start >= nonZeroEnd) break;
                const gain =
                    GAIN_POW[info.globalGain - 8 * info.subblockGain[window]! + GAIN_OFFSET]! *
                    scale[scalefac[sfb * 3 + window]!]!;
                requantizeBand(
                    quantized,
                    spectrum,
                    start,
                    Math.min(start + width, nonZeroEnd),
                    gain,
                );
            }
        }
    }
}

function applyMidSide(left: Float64Array, right: Float64Array, start: number, end: number): void {
    for (let index = start; index < end; index++) {
        const mid = left[index]!;
        const side = right[index]!;
        left[index] = (mid + side) * Math.SQRT1_2;
        right[index] = (mid - side) * Math.SQRT1_2;
    }
}

function hasNonZero(values: Float64Array, start: number, end: number): boolean {
    for (let index = start; index < end; index++) if (values[index] !== 0) return true;
    return false;
}

/**
 * Joint stereo of one granule. Intensity positions at or above `positions` (7 for MPEG-1) keep the
 * band as it is coded; MPEG-2/2.5 streams use all 16 table entries, as FFmpeg's decoder and the
 * encoders tuned against it do, instead of reserving each scalefactor's largest value.
 */
function processStereo(
    header: Mp3FrameHeader,
    info: GranuleInfo,
    left: ChannelState,
    right: ChannelState,
    intensityTable: Float64Array,
    positions: number,
): void {
    const msStereo = (header.modeExtension & 2) !== 0;
    const intensity = (header.modeExtension & 1) !== 0;
    const nonZeroEnd = Math.max(left.nonZeroEnd, right.nonZeroEnd);
    if (!intensity) {
        if (msStereo) applyMidSide(left.spectrum, right.spectrum, 0, nonZeroEnd);
        left.nonZeroEnd = nonZeroEnd;
        right.nonZeroEnd = nonZeroEnd;
        return;
    }
    const long = SFB_LONG[header.sampleRate]!;
    const short = SFB_SHORT[header.sampleRate]!;
    const scalefac = right.scalefac;
    const band = (index: number, start: number, end: number, nonZeroFound: boolean): void => {
        if (nonZeroFound) {
            if (msStereo) applyMidSide(left.spectrum, right.spectrum, start, end);
            return;
        }
        const position = scalefac[index]!;
        if (position >= positions) {
            if (msStereo) applyMidSide(left.spectrum, right.spectrum, start, end);
            return;
        }
        const leftGain = intensityTable[position * 2]!;
        const rightGain = intensityTable[position * 2 + 1]!;
        for (let line = start; line < end; line++) {
            const value = left.spectrum[line]!;
            left.spectrum[line] = value * leftGain;
            right.spectrum[line] = value * rightGain;
        }
    };
    let longBands = 22;
    let anyShortFound = false;
    if (info.blockType === 2) {
        const firstShort = info.mixed ? 3 : 0;
        longBands = info.mixed ? (header.mpeg1 ? 8 : 6) : 0;
        for (let window = 0; window < 3; window++) {
            let found = false;
            for (let sfb = 12; sfb >= firstShort; sfb--) {
                const width = short[sfb + 1]! - short[sfb]!;
                const start = 3 * short[sfb]! + window * width;
                if (!found && hasNonZero(right.spectrum, start, start + width)) found = true;

                // The top band carries no scalefactor of its own; it takes the intensity position
                // of the one below.
                band(Math.min(sfb, 11) * 3 + window, start, start + width, found);
            }
            anyShortFound ||= found;
        }
    }
    let found = anyShortFound;
    for (let sfb = longBands - 1; sfb >= 0; sfb--) {
        const start = long[sfb]!;
        const end = long[sfb + 1]!;
        if (!found && hasNonZero(right.spectrum, start, end)) found = true;
        band(Math.min(sfb, 20), start, end, found);
    }
    left.nonZeroEnd = 576;
    right.nonZeroEnd = 576;
}

function reorderShort(
    spectrum: Float64Array,
    reordered: Float64Array,
    header: Mp3FrameHeader,
    mixed: boolean,
    nonZeroEnd: number,
): void {
    const short = SFB_SHORT[header.sampleRate]!;
    const firstShort = mixed ? 3 : 0;
    let position = 3 * short[firstShort]!;
    reordered.fill(0, position);
    if (mixed) reordered.set(spectrum.subarray(0, position));
    for (let sfb = firstShort; sfb < 13 && position < nonZeroEnd; sfb++) {
        for (let window = 0; window < 3; window++) {
            for (let line = short[sfb]!, stop = short[sfb + 1]!; line < stop; line++) {
                const subband = (line / 6) | 0;
                reordered[subband * 18 + window * 6 + (line - subband * 6)] = spectrum[position++]!;
            }
        }
    }
}

/**
 * Alias-reduction butterflies between adjacent long-coded subbands (ISO/IEC 11172-3 2.4.3.4.10.1).
 */
function antialias(spectrum: Float64Array, boundaries: number): void {
    for (let subband = 1; subband <= boundaries; subband++) {
        const lower = subband * 18 - 1;
        const upper = subband * 18;
        for (let index = 0; index < 8; index++) {
            const low = spectrum[lower - index]!;
            const high = spectrum[upper + index]!;
            spectrum[lower - index] = low * ALIAS_CS[index]! - high * ALIAS_CA[index]!;
            spectrum[upper + index] = high * ALIAS_CS[index]! + low * ALIAS_CA[index]!;
        }
    }
}

const IMDCT_SCRATCH = new Float64Array(36);

/**
 * `used` counts the subband's lines up to its last nonzero one; the zero lines after it add nothing
 * to the sums. Before the window, long-block output 17 - i is minus output i and 35 - i equals
 * 18 + i, so 18 sums give all 36.
 */
function imdctSubband(
    spectrum: Float64Array,
    offset: number,
    blockType: number,
    out: Float64Array,
    used: number,
): void {
    if (blockType === 2) {
        out.fill(0);
        for (let window = 0; window < 3; window++) {
            const base = 6 + 6 * window;
            const input = offset + window * 6;
            for (let sample = 0; sample < 12; sample++) {
                let sum = 0;
                const row = sample * 6;
                for (let k = 0; k < 6; k++) sum += spectrum[input + k]! * MDCT_COS12[row + k]!;
                out[base + sample] += sum * MDCT_WIN_SHORT12[sample]!;
            }
        }
        return;
    }
    const win = blockType === 1 ? MDCT_WIN_START : blockType === 3 ? MDCT_WIN_STOP : MDCT_WIN;

    // Outputs i and 18 + i with the next pair, for i = 0, 2, 4, 6; then 8 and 26 alone.
    for (let sample = 0; sample < 8; sample += 2) {
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let s3 = 0;
        const low = sample * 18;
        const high = low + 324;
        for (let k = 0; k < used; k++) {
            const x = spectrum[offset + k]!;
            s0 += x * MDCT_COS[low + k]!;
            s1 += x * MDCT_COS[low + 18 + k]!;
            s2 += x * MDCT_COS[high + k]!;
            s3 += x * MDCT_COS[high + 18 + k]!;
        }
        out[sample] = s0 * win[sample]!;
        out[17 - sample] = -s0 * win[17 - sample]!;
        out[sample + 1] = s1 * win[sample + 1]!;
        out[16 - sample] = -s1 * win[16 - sample]!;
        out[18 + sample] = s2 * win[18 + sample]!;
        out[35 - sample] = s2 * win[35 - sample]!;
        out[19 + sample] = s3 * win[19 + sample]!;
        out[34 - sample] = s3 * win[34 - sample]!;
    }
    let s0 = 0;
    let s2 = 0;
    for (let k = 0; k < used; k++) {
        const x = spectrum[offset + k]!;
        s0 += x * MDCT_COS[144 + k]!;
        s2 += x * MDCT_COS[468 + k]!;
    }
    out[8] = s0 * win[8]!;
    out[9] = -s0 * win[9]!;
    out[26] = s2 * win[26]!;
    out[27] = s2 * win[27]!;
}

function hybridSynthesis(
    spectrum: Float64Array,
    info: GranuleInfo,
    header: Mp3FrameHeader,
    channel: ChannelState,
    timeSamples: Float64Array,
    output: Float32Array,
    outputOffset: number,
): void {
    const longSubbands =
        info.blockType !== 2 ? 32 : info.mixed ? (header.sampleRate === 8000 ? 4 : 2) : 0;
    if (longSubbands > 1) antialias(spectrum, longSubbands - 1);
    const overlap = channel.overlap;
    const z = IMDCT_SCRATCH;
    for (let subband = 0; subband < 32; subband++) {
        const offset = subband * 18;
        const blockType =
            subband < longSubbands ? (info.blockType === 2 ? 0 : info.blockType) : info.blockType;
        let used = 18;
        while (used > 0 && spectrum[offset + used - 1] === 0) used--;
        if (used === 0) {
            for (let sample = 0; sample < 18; sample++) {
                timeSamples[sample * 32 + subband] = overlap[offset + sample]!;
                overlap[offset + sample] = 0;
            }
            continue;
        }
        imdctSubband(spectrum, offset, blockType, z, used);
        for (let sample = 0; sample < 18; sample++) {
            timeSamples[sample * 32 + subband] = z[sample]! + overlap[offset + sample]!;
            overlap[offset + sample] = z[sample + 18]!;
        }
    }
    applyFrequencyInversion(timeSamples, 0);
    for (let slot = 0; slot < 18; slot++) {
        channel.synth.run(
            timeSamples.subarray(slot * 32, slot * 32 + 32),
            output,
            outputOffset + slot * 32,
        );
    }
}

/**
 * Stateful Layer III decoder: one coded frame in, one planar PCM frame out; keeps the bit
 * reservoir.
 */
export class StreamingMp3Decoder {
    private rate = 0;
    private channelCount = 0;
    private mpeg1: boolean | null = null;
    private readonly reservoir = new Uint8Array(RESERVOIR_BYTES);
    private reservoirLength = 0;
    private readonly mainData = new Uint8Array(
        RESERVOIR_BYTES + MAX_FRAME_BYTES + MAIN_DATA_PADDING,
    );
    private readonly granules: GranuleInfo[][] = [
        [new GranuleInfo(), new GranuleInfo()],
        [new GranuleInfo(), new GranuleInfo()],
    ];
    private readonly scfsi = new Int32Array(8);
    private readonly channelStates: ChannelState[] = [];
    private readonly reordered = new Float64Array(576);
    private readonly timeSamples = new Float64Array(18 * 32);

    get sampleRate(): number {
        return this.rate;
    }
    get channels(): number {
        return this.channelCount;
    }
    /**
     * Coded frames decoded so far, including frames that produced silence for a missing reservoir.
     */
    frames = 0;

    /** Forgets the reservoir and filterbank history, as after a seek. */
    reset(): void {
        this.reservoirLength = 0;
        for (const channel of this.channelStates) {
            channel.overlap.fill(0);
            channel.previousScalefac.fill(0);
        }
        this.channelStates.length = 0;
        this.rate = 0;
        this.channelCount = 0;
        this.mpeg1 = null;
        this.frames = 0;
    }

    pushFrame(data: Uint8Array): readonly Float32Array[] {
        const header = parseMp3FrameHeader(data, 0);
        if (!header) throw new DecodeError('MP3 frame header is invalid');
        if (header.frameLength !== data.length)
            throw new DecodeError('MP3 frame length differs from its header');
        if (this.mpeg1 === null) {
            this.rate = header.sampleRate;
            this.channelCount = header.channels;
            this.mpeg1 = header.mpeg1;
            for (let channel = 0; channel < header.channels; channel++)
                this.channelStates.push(makeChannel());
        } else if (
            header.sampleRate !== this.rate ||
            header.channels !== this.channelCount ||
            header.mpeg1 !== this.mpeg1
        ) {
            throw new DecodeError('MP3 format changes mid-stream');
        }

        const sideInfoStart = header.crc ? 6 : 4;
        const mainStart = sideInfoStart + header.sideInfoLength;
        if (mainStart > data.length)
            throw new DecodeError('MP3 frame is shorter than its side information');
        if (header.crc) {
            const declared = (data[4]! << 8) | data[5]!;
            const computed = mpegCrc16(data, [
                [2, 4],
                [sideInfoStart, mainStart],
            ]);
            if (declared !== computed) throw new DecodeError('MP3 frame fails CRC-16');
        }

        const sideReader = new BitReader(data);
        sideReader.position = sideInfoStart * 8;
        const mainDataBegin = readSideInfo(sideReader, header, this.granules, this.scfsi);
        const output = Array.from(
            { length: header.channels },
            () => new Float32Array(header.samplesPerFrame),
        ) as Float32Array[];
        const frameMain = data.subarray(mainStart);
        const available = this.reservoirLength;
        const main = this.mainData;
        let startBit = 0;
        let firstGranule = 0;
        let mainBytes: number;
        if (mainDataBegin <= available) {
            main.set(this.reservoir.subarray(available - mainDataBegin, available), 0);
            main.set(frameMain, mainDataBegin);
            mainBytes = mainDataBegin + frameMain.length;
        } else {
            // The reservoir lacks the start of the main data (a stream cut mid-reservoir): like the
            // reference decoders, granules that begin in the missing bytes are silent and the later
            // ones decode.
            let bits = available * 8;
            const granuleCount = header.mpeg1 ? 2 : 1;
            for (; firstGranule < granuleCount && bits >> 3 < mainDataBegin; firstGranule++)
                for (let channel = 0; channel < header.channels; channel++)
                    bits += this.granules[firstGranule]![channel]!.part23Length;

            startBit = bits - 8 * mainDataBegin;
            main.set(this.reservoir.subarray(0, available), 0);
            main.set(frameMain, available);
            mainBytes = available + frameMain.length;
        }

        main.fill(0, mainBytes, mainBytes + MAIN_DATA_PADDING);
        this.decodeGranules(header, mainBytes, output, startBit, firstGranule);
        this.storeReservoir(frameMain);
        this.frames++;
        return output;
    }

    private storeReservoir(frameMain: Uint8Array): void {
        const reservoir = this.reservoir;
        if (frameMain.length >= RESERVOIR_BYTES) {
            reservoir.set(frameMain.subarray(frameMain.length - RESERVOIR_BYTES));
            this.reservoirLength = RESERVOIR_BYTES;
            return;
        }
        const keep = Math.min(this.reservoirLength, RESERVOIR_BYTES - frameMain.length);
        reservoir.copyWithin(0, this.reservoirLength - keep, this.reservoirLength);
        reservoir.set(frameMain, keep);
        this.reservoirLength = keep + frameMain.length;
    }

    private decodeGranules(
        header: Mp3FrameHeader,
        mainBytes: number,
        output: Float32Array[],
        startBit: number,
        firstGranule: number,
    ): void {
        const reader = new BitReader(this.mainData);
        reader.position = startBit;
        const mainBits = mainBytes * 8;
        const granuleCount = header.mpeg1 ? 2 : 1;
        const jointStereo =
            header.channels === 2 && header.mode === 1 && header.modeExtension !== 0;
        for (let granule = 0; granule < granuleCount; granule++) {
            const infos = this.granules[granule]!;
            for (
                let channelIndex = 0;
                channelIndex < header.channels && granule < firstGranule;
                channelIndex++
            ) {
                const channel = this.channelStates[channelIndex]!;
                channel.spectrum.fill(0);
                channel.nonZeroEnd = 0;
            }

            for (
                let channelIndex = 0;
                channelIndex < header.channels && granule >= firstGranule;
                channelIndex++
            ) {
                const info = infos[channelIndex]!;
                const channel = this.channelStates[channelIndex]!;
                const part2Start = reader.position;
                const end = part2Start + info.part23Length;
                if (end > mainBits)
                    throw new DecodeError('MP3 part2_3_length exceeds the available main data');
                if (header.mpeg1) {
                    readScalefactorsMpeg1(reader, info, channel, granule, this.scfsi, channelIndex);
                } else {
                    readScalefactorsLsf(
                        reader,
                        info,
                        channel,
                        channelIndex === 1 && jointStereo && (header.modeExtension & 1) !== 0,
                    );
                }

                if (reader.position > end)
                    throw new DecodeError('MP3 scalefactors overrun part2_3_length');
                decodeHuffman(reader, info, channel, header, end);
                reader.position = end;
                requantize(info, channel, header);
            }

            if (jointStereo && granule >= firstGranule) {
                const right = infos[1]!;
                processStereo(
                    header,
                    right,
                    this.channelStates[0]!,
                    this.channelStates[1]!,
                    header.mpeg1 ? INTENSITY_MPEG1 : INTENSITY_LSF[right.scalefacCompress & 1]!,
                    header.mpeg1 ? 7 : 16,
                );
            }

            for (let channelIndex = 0; channelIndex < header.channels; channelIndex++) {
                const info = infos[channelIndex]!;
                const channel = this.channelStates[channelIndex]!;
                let spectrum = channel.spectrum;
                if (info.blockType === 2) {
                    reorderShort(
                        spectrum,
                        this.reordered,
                        header,
                        info.mixed === 1,
                        channel.nonZeroEnd,
                    );
                    spectrum = this.reordered;
                }

                hybridSynthesis(
                    spectrum,
                    info,
                    header,
                    channel,
                    this.timeSamples,
                    output[channelIndex]!,
                    granule * 576,
                );
            }
        }
    }
}

/**
 * Decodes a whole MP3 stream held in memory, yielding to the event loop between frames; ID3 tags
 * are skipped and LAME gapless trims are applied.
 */
export async function decodeMp3(
    bytes: Uint8Array,
    options: DecodeOptions = {},
): Promise<DecodedMp3> {
    let offset = skipId3v2(bytes, 0);
    const decoder = new StreamingMp3Decoder();
    const chunks: (readonly Float32Array[])[] = [];
    let synchronized = false;
    let priming = 0;
    let trailing = 0;
    let coded = 0;
    while (offset + 4 <= bytes.length) {
        throwIfAborted(options.signal);
        if (isMpegAudioTrailer(bytes, offset)) break;
        let header: Mp3FrameHeader | null;
        try {
            header = parseMp3FrameHeader(bytes, offset);
        } catch (error) {
            if (chunks.length > 0) header = null;
            else throw error;
        }

        if (!header) {
            offset++;
            synchronized = false;
            continue;
        }

        const next = offset + header.frameLength;
        if (next > bytes.length) {
            if (synchronized) break;
            offset++;
            continue;
        }

        if (!synchronized && next + 4 <= bytes.length && !isMpegAudioTrailer(bytes, next)) {
            let peek: Mp3FrameHeader | null = null;
            try {
                peek = parseMp3FrameHeader(bytes, next);
            } catch {
                peek = null;
            }
            if (!peek && skipId3v2(bytes, next) === next) {
                offset++;
                continue;
            }
        }

        const frame = bytes.subarray(offset, next);
        if (decoder.frames === 0 && chunks.length === 0) {
            const info = parseMpegGaplessInfo(frame);
            if (info) {
                if (info.encoderDelay !== undefined && info.padding !== undefined) {
                    priming = info.encoderDelay + MP3_DECODER_DELAY;
                    trailing = Math.max(0, info.padding - MP3_DECODER_DELAY);
                }

                offset = next;
                synchronized = true;
                continue;
            }
        }

        chunks.push(decoder.pushFrame(frame));
        coded += header.samplesPerFrame;
        offset = next;
        synchronized = true;
        if (chunks.length % YIELD_FRAMES === 0) await yieldEventLoop();
    }

    throwIfAborted(options.signal);
    if (chunks.length === 0)
        throw new DecodeError('MP3 stream contains no complete Layer III frames');
    if (priming + trailing >= coded) {
        priming = 0;
        trailing = 0;
    }

    const sampleFrames = coded - priming - trailing;
    const channelData = Array.from(
        { length: decoder.channels },
        () => new Float32Array(sampleFrames),
    );
    let written = -priming;
    for (const planes of chunks) {
        const length = planes[0]!.length;
        const start = Math.max(0, -written);
        const stop = Math.min(length, sampleFrames - written);
        if (stop > start) {
            for (let channel = 0; channel < decoder.channels; channel++)
                channelData[channel]!.set(planes[channel]!.subarray(start, stop), written + start);
        }

        written += length;
    }

    return {
        sampleRate: decoder.sampleRate,
        channels: decoder.channels,
        sampleFrames,
        channelData,
        frames: chunks.length,
    };
}

/**
 * Length of the Layer III frame starting at `offset` of a packet, or 0 when no valid header starts
 * there.
 */
function packedFrameLength(packet: Uint8Array, offset: number): number {
    try {
        return parseMp3FrameHeader(packet, offset)?.frameLength ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Built-in MPEG Layer I/II/III decoding. A stream that switches rate or channel count mid-way (a
 * capture spliced from different broadcasts) is decoded on, as ffmpeg presents it: each run of
 * frames in another shape starts a fresh decoder and is converted to the track's shape (mono
 * becomes both sides and stereo the mean of its sides, by downmixChannels as the host decoder's
 * output; the rate resampled), with one AUDIO_FORMAT_CHANGED warning.
 */
export function mpegAudioCodec(track: TrackInfo): BuiltinAudioCodec {
    const layer3 = track.codec === 'mp3';
    const fresh = (): StreamingMp3Decoder | StreamingMpegLayer12Decoder =>
        layer3 ? new StreamingMp3Decoder() : new StreamingMpegLayer12Decoder();
    return {
        create(warn) {
            let decoder = fresh();
            let resampler: StreamingResampler | undefined;
            let reported = false;
            /**
             * The resampled end of a run in a foreign rate, which the resampler holds back until
             * the run ends.
             */
            const endRun = (units: (readonly Float32Array[])[]): void => {
                const tail = resampler?.flush();
                resampler = undefined;
                if (tail?.[0]!.length) units.push(tail);
            };
            const toTrackShape = (
                planes: readonly Float32Array[],
                units: (readonly Float32Array[])[],
            ): void => {
                const rate = decoder.sampleRate;
                if (rate === track.sampleRate && planes.length === track.channelCount) {
                    units.push(planes);
                    return;
                }

                if (!reported) {
                    reported = true;
                    warn?.(
                        'AUDIO_FORMAT_CHANGED',
                        `${track.codec} frames change format and are converted back`,
                    );
                }

                const remixed =
                    planes.length === track.channelCount
                        ? planes
                        : downmixChannels(
                              [...planes],
                              planes.length,
                              track.channelCount,
                              planes[0]!.length,
                          );
                if (rate === track.sampleRate) {
                    units.push(remixed);
                    return;
                }

                resampler ??= new StreamingResampler(rate, track.sampleRate, track.channelCount);
                const resampled = resampler.process(remixed);
                if (resampled[0]!.length) units.push(resampled);
            };
            return {
                decode(packet) {
                    const units: (readonly Float32Array[])[] = [];

                    // A packet may hold several frames back to back (FLV and MP4 writers group
                    // them).
                    for (let offset = 0; offset < packet.length;) {
                        const length = layer3 ? packedFrameLength(packet, offset) : 0;
                        if (offset > 0 && !length) break;
                        const end =
                            length && offset + length < packet.length
                                ? offset + length
                                : packet.length;
                        const frame = packet.subarray(offset, end);
                        const header = parseMpegAudioHeader(frame, 0);
                        if (
                            header &&
                            decoder.sampleRate &&
                            (header.sampleRate !== decoder.sampleRate ||
                                header.channels !== decoder.channels)
                        ) {
                            endRun(units);
                            decoder = fresh();
                        }
                        toTrackShape(decoder.pushFrame(frame), units);
                        offset = end;
                    }
                    return units;
                },
                flush() {
                    const units: (readonly Float32Array[])[] = [];
                    endRun(units);
                    return units;
                },
                reset: () => {
                    decoder = fresh();
                    resampler = undefined;
                },
            };
        },
    };
}
