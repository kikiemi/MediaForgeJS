import { AAC_SAMPLE_RATES } from './aac-sample-rates';
import { leb128 } from '../video/av1-config';

/**
 * IAMF (AOM Immersive Audio Model and Formats): the OBUs of an IA sequence and what its descriptors
 * say about it. MP4 stores the descriptors in the 'iacb' box of its 'iamf' sample entry and one
 * temporal unit per sample; a raw IA sequence starts with them.
 */

/** OBU types of IAMF § 3.2; 5 to 23 are audio frames, 6 to 23 of substreams 0 to 17. */
export const IAMF_SEQUENCE_HEADER = 31;
export const IAMF_TEMPORAL_DELIMITER = 4;

/** An OBU of an IA sequence: its type, flags and the byte range of its payload. */
export interface IamfObu {
    readonly type: number;
    readonly redundant: boolean;
    /** is_not_key_frame of a temporal delimiter. */
    readonly notKey: boolean;
    /** Audio frames: their substream, explicit or from their type. */
    readonly substream?: number;
    readonly payload: number;
    readonly end: number;
}

/** The OBU at `at` of `bytes`, or undefined when its header is malformed or the bytes end in it. */
export function iamfObuAt(bytes: Uint8Array, at: number): IamfObu | undefined {
    const header = bytes[at] ?? 0;
    const size = leb128(bytes, at + 1, bytes.length);
    if (at >= bytes.length || !size || at + 1 + size.length + size.value > bytes.length)
        return undefined;
    const type = header >> 3;
    const end = at + 1 + size.length + size.value;
    let payload = at + 1 + size.length;
    const field = (): number => {
        const value = leb128(bytes, payload, end);
        payload = value ? payload + value.length : end;
        return value?.value ?? 0;
    };

    // Audio frames that trim samples state how many at the end and the start; then come the
    // extension header and an audio frame's explicit substream.
    const frame = type >= 5 && type <= 23;
    if (frame && header & 2) {
        field();
        field();
    }
    if (header & 1) {
        const extension = field();
        payload += extension;
    }
    const substream = type === 5 ? field() : type - 6;
    return {
        type,
        redundant: !!(header & 4),
        notKey: type === IAMF_TEMPORAL_DELIMITER && !!(header & 2),
        ...(frame ? { substream } : {}),
        payload,
        end,
    };
}

/** What the descriptors of an IA sequence state. */
export interface IamfDescription {
    /** `iamf.<primary profile>.<additional profile>.<codec of the substreams>` (IAMF § 6.4). */
    readonly codec: string;
    readonly sampleRate: number;
    /** Channels of the first audio element: its loudspeakers or ambisonic components. */
    readonly channelCount: number;
    /** Samples of every audio frame. */
    readonly frameSamples: number;
}

/** The codec strings of the substreams' codecs as their own tracks would state them. */
const SUBSTREAM_CODECS: Readonly<Record<string, string>> = {
    Opus: 'Opus',
    mp4a: 'mp4a.40.2',
    fLaC: 'fLaC',
    ipcm: 'ipcm',
};

/**
 * The description of an IA sequence from its descriptor OBUs (sequence header, codec config, audio
 * elements, mix presentations), or undefined without a sequence header and a codec config.
 */
export function iamfDescription(descriptors: Uint8Array): IamfDescription | undefined {
    let profiles: string | undefined;
    let codec: string | undefined;
    let sampleRate = 0;
    let channelCount = 0;
    let frameSamples = 0;
    for (let obu = iamfObuAt(descriptors, 0); obu; obu = iamfObuAt(descriptors, obu.end)) {
        const { type, payload: at, end } = obu;
        if (type === IAMF_SEQUENCE_HEADER && end - at >= 6 && !profiles)
            profiles = [at + 4, at + 5]
                .map(index => String(descriptors[index]).padStart(3, '0'))
                .join('.');
        else if (type === 0 && !codec)
            ({ codec, sampleRate, frameSamples } = codecConfig(descriptors, at, end));
        else if (type === 1 && !channelCount) channelCount = elementChannels(descriptors, at, end);
    }
    return profiles && codec
        ? { codec: `iamf.${profiles}.${codec}`, sampleRate, channelCount, frameSamples }
        : undefined;
}

/** The substreams' codec, sample rate and frame length of a codec config OBU (IAMF § 3.5, 3.13). */
function codecConfig(
    bytes: Uint8Array,
    at: number,
    end: number,
): { codec: string; sampleRate: number; frameSamples: number } {
    at += leb128(bytes, at, end)?.length ?? 0;
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const frame = leb128(bytes, at + 4, end);
    const config = at + 4 + (frame?.length ?? 0) + 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // AAC states its rate in the AudioSpecificConfig of a DecoderConfigDescriptor, FLAC in the
    // STREAMINFO after its block header, LPCM after its format flags and sample size.
    const pastDescriptor = (index: number): number => {
        index++;
        while ((bytes[index] ?? 0) & 0x80) index++;
        return index + 1;
    };
    const asc = pastDescriptor(pastDescriptor(config) + 13);
    const aacRate = AAC_SAMPLE_RATES[(((bytes[asc] ?? 0) & 7) << 1) | ((bytes[asc + 1] ?? 0) >> 7)];
    let sampleRate = 48000;
    if (id === 'mp4a') sampleRate = aacRate ?? 0;
    else if (id === 'fLaC' && config + 18 <= end) sampleRate = view.getUint32(config + 14) >>> 12;
    else if (id === 'ipcm' && config + 6 <= end) sampleRate = view.getUint32(config + 2);
    return { codec: SUBSTREAM_CODECS[id] ?? id, sampleRate, frameSamples: frame?.value ?? 0 };
}

/**
 * The channels of an audio element OBU (IAMF § 3.6): the coded channels of a channel-based element
 * (two per coupled substream), the output channels of an ambisonic one, 0 for other kinds.
 */
function elementChannels(bytes: Uint8Array, at: number, end: number): number {
    const next = (): number => {
        const value = leb128(bytes, at, end);
        at = value ? at + value.length : end;
        return value?.value ?? 0;
    };
    next();
    const kind = (bytes[at++] ?? 0) >> 5;
    next();
    for (let substreams = next(); substreams > 0; substreams--) next();

    // Parameter definitions: demixing (1) and recon gain (2) definitions, other types sized.
    for (let parameters = next(); parameters > 0 && at < end; parameters--) {
        const type = next();
        if (type > 9) {
            at += next();
            continue;
        }
        next();
        next();
        if (!((bytes[at++] ?? 0) & 0x80)) {
            next();
            if (next() === 0) for (let blocks = next(); blocks > 0; blocks--) next();
        }
        if (type === 1) at += 2;
    }
    if (kind === 1) {
        next();
        return bytes[at] ?? 0;
    }
    let channels = 0;
    for (let layers = kind === 0 ? (bytes[at++] ?? 0) >> 5 : 0; layers > 0 && at + 3 <= end;) {
        const flags = bytes[at]!;
        channels += bytes[at + 1]! + bytes[at + 2]!;
        at += 3 + (flags & 8 ? 3 : 0) + (flags >> 4 === 15 ? 1 : 0);
        layers--;
    }
    return channels;
}
