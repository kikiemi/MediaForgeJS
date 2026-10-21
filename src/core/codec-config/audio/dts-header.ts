import type { DtsCodec } from '../../model/codec-strings';
import { u32be } from '../../bytes/byte-fields';

interface DtsFrameHeader {
    readonly codec: DtsCodec;
    /**
     * Bytes of one access unit in the 16-bit big-endian form: core frame plus any extension
     * substream.
     */
    readonly frameBytes: number;
    /** Bytes of the core frame, 0 for a substream-only access unit. */
    readonly coreBytes: number;
    readonly sampleRate: number;
    readonly channels: number;
    /** PCM samples per channel in the access unit. */
    readonly samples: number;
    readonly lfe: boolean;
}

/** Stored word layout of a DTS stream: 16-bit or 14-bit words, big- or little-endian. */
export type DtsStreamForm = 'be16' | 'le16' | 'be14' | 'le14';

const CORE_SAMPLE_RATES = [
    0, 8000, 16000, 32000, 0, 0, 11025, 22050, 44100, 0, 0, 12000, 24000, 48000, 0, 0,
];
const CORE_CHANNELS = [1, 2, 2, 2, 2, 3, 3, 4, 4, 5, 6, 6, 6, 7, 8, 8];
const EXSS_SAMPLE_RATES = [
    8000, 16000, 32000, 64000, 128000, 22050, 44100, 88200, 176400, 352800, 12000, 24000, 48000,
    96000, 192000, 384000,
];
const EXSS_REFERENCE_CLOCKS = [32000, 44100, 48000];

/**
 * DTSSpecificBox ChannelLayout of each core AMODE (1 to 9 map exactly; wider modes keep their front
 * and sides).
 */
const CORE_LAYOUT_MASKS = [0x1, 0x2, 0x2, 0x2, 0x2, 0x3, 0x12, 0x13, 0x6, 0x7];
const XLL_SYNC = 0x41a29547;
const LBR_SYNC = 0x0a801921;

class Bits {
    private position: number;
    constructor(
        private readonly data: Uint8Array,
        offset: number,
        private readonly end: number,
    ) {
        this.position = offset * 8;
    }
    read(count: number): number {
        if (this.position + count > this.end * 8) throw new RangeError('DTS header is truncated');
        let value = 0;
        for (let index = 0; index < count; index++, this.position++)
            value =
                value * 2 + ((this.data[this.position >>> 3]! >>> (7 - (this.position & 7))) & 1);
        return value;
    }
}

/**
 * Word layout of the DTS sync word at `offset` (a core sync in any layout, or the big-endian
 * extension substream sync that starts DTS Express and core-less lossless streams), or null when
 * none starts there.
 */
export function dtsStreamForm(data: Uint8Array, offset: number): DtsStreamForm | null {
    if (offset + 6 > data.length) return null;
    const word = u32be(data, offset);
    if (word === 0x7ffe8001 || word === 0x64582025) return 'be16';
    if (word === 0xfe7f0180) return 'le16';
    if (word === 0x1fffe800 && data[offset + 4] === 0x07 && (data[offset + 5]! & 0xf0) === 0xf0)
        return 'be14';
    if (word === 0xff1f00e8 && (data[offset + 4]! & 0xf0) === 0xf0 && data[offset + 5] === 0x07)
        return 'le14';
    return null;
}

/**
 * Converts a DTS stream stored as little-endian or 14-bit words to the 16-bit big-endian form the
 * codec strings and containers use. A trailing partial word is dropped.
 */
export function dtsToBigEndian16(data: Uint8Array, form: DtsStreamForm): Uint8Array {
    if (form === 'be16') return data;
    const words = data.length >> 1;
    if (form === 'le16') {
        const out = new Uint8Array(words * 2);
        for (let index = 0; index < words; index++) {
            out[index * 2] = data[index * 2 + 1]!;
            out[index * 2 + 1] = data[index * 2]!;
        }
        return out;
    }

    // Each 16-bit word carries 14 payload bits in its low bits.
    const out = new Uint8Array(Math.floor((words * 14) / 8));
    let accumulator = 0;
    let bits = 0;
    let written = 0;
    for (let index = 0; index < words; index++) {
        const high = form === 'be14' ? data[index * 2]! : data[index * 2 + 1]!;
        const low = form === 'be14' ? data[index * 2 + 1]! : data[index * 2]!;
        accumulator = ((accumulator << 14) | (((high & 0x3f) << 8) | low)) & 0x3fffff;
        bits += 14;
        while (bits >= 8) {
            bits -= 8;
            out[written++] = (accumulator >>> bits) & 0xff;
        }
    }
    return out.subarray(0, written);
}

/** Bytes that one 16-bit big-endian span of `bytes` occupies in the stored form. */
export function dtsStoredBytes(bytes: number, form: DtsStreamForm): number {
    return form === 'be14' || form === 'le14' ? Math.ceil((bytes * 8) / 14) * 2 : bytes;
}

function parseCore(
    data: Uint8Array,
    offset: number,
): Omit<DtsFrameHeader, 'codec' | 'frameBytes'> | null {
    if (offset + 11 > data.length || u32be(data, offset) !== 0x7ffe8001) return null;
    const blocks = ((data[offset + 4]! & 1) << 6) | (data[offset + 5]! >> 2);
    const bytes =
        (((data[offset + 5]! & 3) << 12) | (data[offset + 6]! << 4) | (data[offset + 7]! >> 4)) + 1;
    const mode = ((data[offset + 7]! & 15) << 2) | (data[offset + 8]! >> 6);
    const sampleRate = CORE_SAMPLE_RATES[(data[offset + 8]! >> 2) & 15]!;
    const lfe = (data[offset + 10]! >> 1) & 3;
    if (bytes < 96 || blocks < 5 || !sampleRate) return null;
    return {
        coreBytes: bytes,
        sampleRate,
        channels: (CORE_CHANNELS[mode] ?? 2) + (lfe === 1 || lfe === 2 ? 1 : 0),
        samples: (blocks + 1) * 32,
        lfe: lfe === 1 || lfe === 2,
    };
}

interface Substream {
    readonly bytes: number;
    readonly sampleRate?: number;
    readonly channels?: number;
    readonly samples?: number;
}

/**
 * Extension substream header (ETSI TS 102 114 7.5): its size and, with static fields, the first
 * asset's format.
 */
function parseSubstream(data: Uint8Array, offset: number): Substream | null {
    if (offset + 12 > data.length || u32be(data, offset) !== 0x64582025) return null;
    try {
        const bits = new Bits(data, offset + 4, data.length);
        bits.read(8);
        const index = bits.read(2);
        const wide = bits.read(1);
        const headerBytes = bits.read(8 + 4 * wide) + 1;
        const sizeBits = 16 + 4 * wide;
        const bytes = bits.read(sizeBits) + 1;
        if (headerBytes > bytes) return null;
        if (!bits.read(1)) return { bytes };

        const clock = EXSS_REFERENCE_CLOCKS[bits.read(2)];
        const duration = 512 * (bits.read(3) + 1);
        if (bits.read(1)) bits.read(36);
        const presentations = bits.read(3) + 1;
        const assets = bits.read(3) + 1;

        const masks: number[] = [];
        for (let presentation = 0; presentation < presentations; presentation++)
            masks.push(bits.read(index + 1));
        for (const mask of masks)
            for (let bit = 0; bit <= index; bit++) if ((mask >> bit) & 1) bits.read(8);
        if (bits.read(1)) {
            bits.read(2);
            const maskBits = (bits.read(2) + 1) << 2;
            const configurations = bits.read(2) + 1;
            for (let configuration = 0; configuration < configurations; configuration++)
                bits.read(maskBits);
        }

        for (let asset = 0; asset < assets; asset++) bits.read(sizeBits);
        bits.read(9);
        bits.read(3);
        if (bits.read(1)) bits.read(4);
        if (bits.read(1)) bits.read(24);
        if (bits.read(1)) {
            const text = bits.read(10) + 1;
            for (let byte = 0; byte < text; byte++) bits.read(8);
        }

        bits.read(5);
        const sampleRate = EXSS_SAMPLE_RATES[bits.read(4)]!;
        const channels = bits.read(8) + 1;
        return {
            bytes,
            sampleRate,
            channels,
            samples: clock ? Math.round((duration * sampleRate) / clock) : undefined,
        };
    } catch (error) {
        if (error instanceof RangeError) return null;
        throw error;
    }
}

function contains(data: Uint8Array, start: number, end: number, sync: number): boolean {
    for (let index = start; index + 4 <= end; index++) if (u32be(data, index) === sync) return true;
    return false;
}

/**
 * Parses the DTS access unit at `offset` in the 16-bit big-endian form: a core frame optionally
 * followed by an extension substream, or a substream alone. The codec string names the extension
 * found in the substream.
 */
export function parseDtsFrame(data: Uint8Array, offset: number): DtsFrameHeader | null {
    const core = parseCore(data, offset);
    const substreamAt = core ? offset + core.coreBytes : offset;
    const substream = parseSubstream(data, substreamAt);
    if (!core && !substream?.sampleRate) return null;

    let codec: DtsCodec = 'dtsc';
    if (substream) {
        const end = Math.min(data.length, substreamAt + substream.bytes);
        if (contains(data, substreamAt, end, XLL_SYNC)) codec = 'dtsl';
        else if (!core && contains(data, substreamAt, end, LBR_SYNC)) codec = 'dtse';
        else codec = 'dtsh';
    }

    const samples = core?.samples ?? substream!.samples;
    if (!samples) return null;
    return {
        codec,
        frameBytes: (core?.coreBytes ?? 0) + (substream?.bytes ?? 0),
        coreBytes: core?.coreBytes ?? 0,
        sampleRate: core?.sampleRate ?? substream!.sampleRate!,
        // The extension substream's asset counts every channel (a 5.1 core with 7.1 XLL is eight).
        channels: Math.max(core?.channels ?? 0, substream?.channels ?? 0),
        samples,
        lfe: core?.lfe ?? false,
    };
}

/**
 * DTSSpecificBox payload (ETSI TS 102 114 E.2.2) describing the access unit at `offset`: sampling
 * frequency, average bit rate from the frame size, 16-bit depth, frame duration code, core layout
 * and size, and the channel layout.
 */
export function dtsSpecificBox(data: Uint8Array, offset: number): Uint8Array | undefined {
    const frame = parseDtsFrame(data, offset);
    if (!frame) return undefined;
    const out = new Uint8Array(20);
    const view = new DataView(out.buffer);
    const bitrate = Math.round((frame.frameBytes * 8 * frame.sampleRate) / frame.samples);
    view.setUint32(0, frame.sampleRate);
    view.setUint32(4, bitrate);
    view.setUint32(8, bitrate);
    out[12] = 16;
    const duration = Math.max(0, Math.min(3, Math.round(Math.log2(frame.samples / 512))));

    // StreamConstruction 1 is a plain core; 0 leaves the extension mix unspecified.
    const construction = frame.codec === 'dtsc' ? 1 : 0;
    const coreSize = Math.min(frame.coreBytes, 0x3fff);

    // FrameDuration(2) StreamConstruction(5) CoreLFEPresent(1) | CoreLayout(6) CoreSize(14) ...
    out[13] = (duration << 6) | (construction << 1) | (frame.lfe ? 1 : 0);
    const coreLayout = frame.coreBytes
        ? ((data[offset + 7]! & 15) << 2) | (data[offset + 8]! >> 6)
        : 31;
    view.setUint32(14, ((coreLayout << 26) | (coreSize << 12)) >>> 0);

    // ChannelLayout bits: 0x1 C, 0x2 L/R, 0x4 Ls/Rs, 0x8 LFE, 0x10 Cs, 0x40 Lsr/Rsr.
    const layout = frame.coreBytes
        ? (CORE_LAYOUT_MASKS[coreLayout] ?? 0x7) | (frame.lfe ? 0x8 : 0)
        : frame.channels === 1
          ? 0x1
          : frame.channels === 2
            ? 0x2
            : frame.channels >= 8
              ? 0x4f
              : 0xf;
    view.setUint16(17, layout);
    return out;
}
