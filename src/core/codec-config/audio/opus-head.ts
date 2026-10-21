import { MediaForgeError } from '../../errors/errors';
import { dataView } from '../../bytes/byte-fields';

/**
 * Decoder configuration of an Opus track (RFC 7845 section 5.1 OpusHead or the ISO-BMFF dOps
 * payload).
 */
export interface OpusHeadInfo {
    readonly channels: number;
    /** 48 kHz samples discarded from the start of the decoder output. */
    readonly preSkip: number;
    readonly inputSampleRate: number;
    /** Q7.8 dB applied to the decoded output. */
    readonly outputGain: number;
    readonly mappingFamily: number;
    readonly layout: OpusLayout;
}

function invalid(message: string): never {
    throw new MediaForgeError(`Opus configuration is invalid: ${message}`, 'FORMAT');
}

function layoutOf(family: number, channels: number, table: Uint8Array | null): OpusLayout {
    if (family === 0) {
        if (channels < 1 || channels > 2) invalid('mapping family 0 carries one or two channels');
        return { channels, streams: 1, coupledStreams: channels - 1, mapping: Uint8Array.of(0, 1) };
    }
    if (family !== 1 && family !== 255) invalid(`mapping family ${family} is not supported`);
    if (family === 1 && (channels < 1 || channels > 8))
        invalid('mapping family 1 carries one to eight channels');
    if (!table || table.length < 2 + channels) invalid('the channel mapping table is truncated');
    const streams = table[0]!;
    const coupledStreams = table[1]!;
    if (streams < 1 || coupledStreams > streams || streams + coupledStreams > 255)
        invalid('stream counts');
    const mapping = table.slice(2, 2 + channels);
    for (const index of mapping)
        if (index !== 255 && index >= streams + coupledStreams)
            invalid('the mapping names a missing stream');
    return { channels, streams, coupledStreams, mapping };
}

/**
 * Parses an OpusHead packet (little-endian fields after the 8-byte magic) or a dOps payload
 * (version byte first, big-endian fields); without any configuration a mapping family 0 stream of
 * `fallbackChannels` is assumed.
 */
export function parseOpusHead(
    config: Uint8Array | undefined,
    fallbackChannels: number,
): OpusHeadInfo {
    if (!config || config.length === 0) {
        return {
            channels: fallbackChannels,
            preSkip: 0,
            inputSampleRate: 48000,
            outputGain: 0,
            mappingFamily: 0,
            layout: layoutOf(0, fallbackChannels, null),
        };
    }

    const view = dataView(config);
    const magic =
        config.length >= 8 && String.fromCharCode(...config.subarray(0, 8)) === 'OpusHead';
    if (magic) {
        if (config.length < 19) invalid('OpusHead is shorter than 19 bytes');
        if (config[8]! >> 4 !== 0) invalid(`OpusHead version ${config[8]} is not supported`);
        const channels = config[9]!;
        const mappingFamily = config[18]!;
        return {
            channels,
            preSkip: view.getUint16(10, true),
            inputSampleRate: view.getUint32(12, true),
            outputGain: view.getInt16(16, true),
            mappingFamily,
            layout: layoutOf(
                mappingFamily,
                channels,
                mappingFamily === 0 ? null : config.subarray(19),
            ),
        };
    }

    if (config.length < 11 || config[0] !== 0)
        invalid('neither an OpusHead packet nor a version-0 dOps payload');
    const channels = config[1]!;
    const mappingFamily = config[10]!;
    return {
        channels,
        preSkip: view.getUint16(2, false),
        inputSampleRate: view.getUint32(4, false),
        outputGain: view.getInt16(8, false),
        mappingFamily,
        layout: layoutOf(mappingFamily, channels, mappingFamily === 0 ? null : config.subarray(11)),
    };
}

/**
 * The fields of `head` laid out as an OpusHead packet (RFC 7845 section 5.1: magic, version 1,
 * little-endian) or as the dOps payload of an MP4 'Opus' sample entry (Encapsulation of Opus in ISO
 * Base Media File Format, 4.3.2: version 0, big-endian), with `preSkip` as its pre-skip.
 */
function opusRecord(head: OpusHeadInfo, dops: boolean, preSkip: number): Uint8Array<ArrayBuffer> {
    // The fields after the version byte sit at the same offsets from it in both layouts.
    const at = dops ? 0 : 8;
    const table = head.mappingFamily === 0 ? 0 : 2 + head.channels;
    const out = new Uint8Array(at + 11 + table);
    const view = new DataView(out.buffer);
    if (!dops) out.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1]);
    out[at + 1] = head.channels;
    view.setUint16(at + 2, preSkip, !dops);
    view.setUint32(at + 4, head.inputSampleRate, !dops);
    view.setInt16(at + 8, head.outputGain, !dops);
    out[at + 10] = head.mappingFamily;
    if (table) {
        out[at + 11] = head.layout.streams;
        out[at + 12] = head.layout.coupledStreams;
        out.set(head.layout.mapping, at + 13);
    }
    return out;
}

/**
 * The OpusHead packet of an OpusHead or dOps configuration (Ogg pages, hosts), with `preSkip` in
 * place of its own when given: a host AudioDecoder gets 0, as the track's trims already remove the
 * pre-skip from the decoded samples.
 */
export function opusHeadPacket(
    config: Uint8Array | undefined,
    fallbackChannels: number,
    preSkip?: number,
): Uint8Array<ArrayBuffer> {
    const head = parseOpusHead(config, fallbackChannels);
    return opusRecord(head, false, preSkip ?? head.preSkip);
}

/** The dOps payload of an MP4 'Opus' sample entry for an OpusHead or dOps configuration. */
export function opusDopsPayload(
    config: Uint8Array | undefined,
    fallbackChannels: number,
): Uint8Array<ArrayBuffer> {
    const head = parseOpusHead(config, fallbackChannels);
    return opusRecord(head, true, head.preSkip);
}

/** Channel mapping of an Opus multistream configuration (RFC 7845 section 5.1.1). */
export interface OpusLayout {
    readonly channels: number;
    readonly streams: number;
    readonly coupledStreams: number;
    /**
     * Per output channel the decoded channel index (2s / 2s+1 for coupled stream s, coupled + s for
     * mono) or 255.
     */
    readonly mapping: Uint8Array;
}
