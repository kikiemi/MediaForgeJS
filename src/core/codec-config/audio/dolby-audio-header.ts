interface DolbyFrameHeader {
    readonly codec: 'ac-3' | 'ec-3';
    readonly frameBytes: number;
    readonly sampleRate: number;
    readonly channels: number;
    /** PCM samples per channel in the frame. */
    readonly samples: number;
    /**
     * E-AC-3 stream type (0 independent, 1 dependent, 2 converted AC-3) and substream id; 0 for
     * AC-3.
     */
    readonly streamType: number;
    readonly substreamId: number;
}

/** Sample rate by fscod and main channels by acmod (ETSI TS 102 366 Tables 4.1 and 4.3). */
export const DOLBY_SAMPLE_RATES: readonly number[] = [48000, 44100, 32000];
export const DOLBY_ACMOD_CHANNELS: readonly number[] = [2, 1, 2, 3, 3, 4, 4, 5];
const AC3_BITRATES_KBPS = [
    32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640,
] as const;

/** 16-bit words of an AC-3 frame of frmsizecod `sizeCode` at fscod `rateCode` (Table 5.18). */
export function ac3FrameWords(sizeCode: number, rateCode: number): number {
    const kbps = AC3_BITRATES_KBPS[sizeCode >> 1]!;
    if (rateCode === 0) return kbps * 2;
    if (rateCode === 2) return kbps * 3;
    return Math.floor((kbps * 320) / 147) + (sizeCode & 1);
}
const EAC3_BLOCK_COUNTS = [1, 2, 3, 6] as const;

/** Bit position of lfeon in the byte holding acmod (ETSI TS 102 366 5.4.2). */
function ac3LfeShift(channelMode: number): number {
    let shift = 4;
    if ((channelMode & 1) !== 0 && channelMode !== 1) shift -= 2;
    if ((channelMode & 4) !== 0) shift -= 2;
    if (channelMode === 2) shift -= 2;
    return shift;
}

/**
 * Parses an AC-3 or E-AC-3 sync frame header; null when the sync word or a coded field is invalid.
 */
export function parseDolbyFrameHeader(data: Uint8Array, offset: number): DolbyFrameHeader | null {
    if (
        offset < 0 ||
        offset + 7 > data.length ||
        data[offset] !== 0x0b ||
        data[offset + 1] !== 0x77
    )
        return null;
    const bitstreamId = data[offset + 5]! >> 3;
    const rateCode = data[offset + 4]! >> 6;
    if (bitstreamId > 10 && bitstreamId <= 16) {
        const secondaryCode = (data[offset + 4]! >> 4) & 3;
        if (rateCode === 3 && secondaryCode === 3) return null;
        return {
            codec: 'ec-3',
            frameBytes: ((((data[offset + 2]! & 7) << 8) | data[offset + 3]!) + 1) * 2,
            sampleRate:
                rateCode === 3
                    ? DOLBY_SAMPLE_RATES[secondaryCode]! / 2
                    : DOLBY_SAMPLE_RATES[rateCode]!,
            channels: DOLBY_ACMOD_CHANNELS[(data[offset + 4]! >> 1) & 7]! + (data[offset + 4]! & 1),
            samples: rateCode === 3 ? 1536 : EAC3_BLOCK_COUNTS[secondaryCode]! * 256,
            streamType: data[offset + 2]! >> 6,
            substreamId: (data[offset + 2]! >> 3) & 7,
        };
    }

    const sizeCode = data[offset + 4]! & 63;
    if (bitstreamId > 10 || rateCode === 3 || sizeCode > 37) return null;
    const words = ac3FrameWords(sizeCode, rateCode);
    const channelMode = data[offset + 6]! >> 5;
    return {
        codec: 'ac-3',
        frameBytes: words * 2,
        sampleRate: DOLBY_SAMPLE_RATES[rateCode]! / 2 ** Math.max(0, bitstreamId - 8),
        channels:
            DOLBY_ACMOD_CHANNELS[channelMode]! +
            ((data[offset + 6]! >> ac3LfeShift(channelMode)) & 1),
        samples: 1536,
        streamType: 0,
        substreamId: 0,
    };
}

/** dac3 payload (ETSI TS 102 366 F.4) describing the AC-3 frame at `offset`. */
export function ac3SpecificBox(data: Uint8Array, offset: number): Uint8Array {
    const rateCode = data[offset + 4]! >> 6;
    const sizeCode = data[offset + 4]! & 63;
    const bitstreamId = data[offset + 5]! >> 3;
    const bitstreamMode = data[offset + 5]! & 7;
    const channelMode = data[offset + 6]! >> 5;
    const lfe = (data[offset + 6]! >> ac3LfeShift(channelMode)) & 1;
    const bitrateCode = sizeCode >> 1;
    return Uint8Array.of(
        (rateCode << 6) | (bitstreamId << 1) | (bitstreamMode >> 2),
        ((bitstreamMode & 3) << 6) | (channelMode << 3) | (lfe << 2) | (bitrateCode >> 3),
        (bitrateCode & 7) << 5,
    );
}

/**
 * chanmap bits (ETSI TS 102 366 E.1.3.1.8, location 0 in bit 15) that name a channel pair rather
 * than one.
 */
const PAIR_LOCATIONS = 0b0000_0110_0111_0100;

/** chanmap bits of the channels each acmod carries (L C R Ls Rs, a mono surround as Cs). */
const ACMOD_LOCATIONS = [0xa000, 0x4000, 0xa000, 0xe000, 0xa100, 0xe100, 0xb800, 0xf800] as const;
const LFE_LOCATION = 1;

/** acmod and lfeon of the AC-3 or E-AC-3 frame at `offset`, whose header has been validated. */
function channelMode(
    data: Uint8Array,
    offset: number,
    codec: 'ac-3' | 'ec-3',
): { acmod: number; lfe: number } {
    if (codec === 'ec-3')
        return { acmod: (data[offset + 4]! >> 1) & 7, lfe: data[offset + 4]! & 1 };
    const acmod = data[offset + 6]! >> 5;
    return { acmod, lfe: (data[offset + 6]! >> ac3LfeShift(acmod)) & 1 };
}

/**
 * The custom channel map of the E-AC-3 dependent substream frame at `offset`; undefined when it
 * carries none.
 */
function dependentChannelMap(data: Uint8Array, offset: number): number | undefined {
    if (offset + 12 > data.length) return undefined;
    // syncword(16) strmtyp(2) substreamid(3) frmsiz(11) fscod(2) numblkscod(2) precede acmod.
    let bit = offset * 8 + 36;
    const read = (count: number): number => {
        let value = 0;
        for (let index = 0; index < count; index++, bit++)
            value = (value << 1) | ((data[bit >> 3]! >> (7 - (bit & 7))) & 1);
        return value;
    };
    const acmod = read(3);
    read(1 + 5 + 5);
    if (read(1)) read(8);
    if (acmod === 0) {
        read(5);
        if (read(1)) read(8);
    }
    return read(1) ? read(16) : undefined;
}

/**
 * Channel locations of the validated AC-3/E-AC-3 frame at `offset` as chanmap bits: a dependent
 * substream's custom channel map, or the acmod and lfeon of the frame. The union over an access
 * unit gives its output channels, so a 5.1 core with a Lrs/Rrs dependent substream is 7.1.
 */
export function dolbyFrameLocations(
    data: Uint8Array,
    offset: number,
    header: DolbyFrameHeader,
): number {
    const { acmod, lfe } = channelMode(data, offset, header.codec);
    const map = header.streamType === 1 ? dependentChannelMap(data, offset) : undefined;
    return map ?? ACMOD_LOCATIONS[acmod]! | (lfe ? LFE_LOCATION : 0);
}

/**
 * Output channels of an access unit: its independent frame and the dependent substream frames after
 * it.
 */
export function dolbyAccessUnitChannels(data: Uint8Array): number {
    let locations = 0;
    for (let offset = 0; offset < data.length;) {
        const header = parseDolbyFrameHeader(data, offset);
        if (!header || header.frameBytes < 7 || header.frameBytes > data.length - offset) break;
        locations |= dolbyFrameLocations(data, offset, header);
        offset += header.frameBytes;
    }
    return dolbyLocationChannels(locations);
}

/** Channel count of a union of chanmap locations. */
export function dolbyLocationChannels(locations: number): number {
    let channels = 0;
    for (let bit = 0; bit < 16; bit++)
        if (locations & (1 << bit)) channels += PAIR_LOCATIONS & (1 << bit) ? 2 : 1;
    return channels;
}

/**
 * dec3 payload (ETSI TS 102 366 F.6) for the E-AC-3 access unit `data`: one independent substream
 * (E-AC-3, or an AC-3 core) and the dependent substreams after it. Data rate, fscod, bsid, bsmod,
 * acmod and lfeon come from the independent frame; chan_loc holds the custom channel map locations
 * 5-12 and LFE2 of the dependent frames, or their acmod when they carry no map, as ffmpeg writes
 * it. Several independent substreams are not described.
 */
export function eac3SpecificBox(data: Uint8Array): Uint8Array | undefined {
    const end = data.length;
    const header = parseDolbyFrameHeader(data, 0);
    if (!header || header.streamType === 1 || header.substreamId !== 0 || header.frameBytes > end)
        return undefined;
    let dependents = 0;
    let chanLoc = 0;
    for (let at = header.frameBytes; at < end;) {
        const next = parseDolbyFrameHeader(data, at);
        if (!next || next.streamType !== 1 || next.frameBytes > end - at) return undefined;
        dependents++;
        const map = dependentChannelMap(data, at);
        if (map === undefined) chanLoc |= channelMode(data, at, 'ec-3').acmod;
        else {
            for (let index = 0; index < 8; index++)
                if ((map >> (10 - index)) & 1) chanLoc |= 1 << index;
            if ((map >> 1) & 1) chanLoc |= 1 << 8;
        }
        at += next.frameBytes;
    }
    const rate = Math.min(
        0x1fff,
        Math.round((header.frameBytes * 8 * header.sampleRate) / header.samples / 1000),
    );
    const fscod = data[4]! >> 6;
    const { acmod, lfe } = channelMode(data, 0, header.codec);
    const bsid = data[5]! >> 3;
    const bsmod = header.codec === 'ac-3' ? data[5]! & 7 : 0;

    // data_rate(13) num_ind_sub(3) | fscod(2) bsid(5) reserved(1) | asvc(1) bsmod(3) acmod(3)
    // lfeon(1) | reserved(3) num_dep_sub(4), then chan_loc(9) with dependent substreams or
    // reserved(1) without.
    const box = [
        rate >> 5,
        (rate & 31) << 3,
        (fscod << 6) | (bsid << 1),
        (bsmod << 4) | (acmod << 1) | lfe,
        (dependents << 1) | (chanLoc >> 8),
    ];
    if (dependents) box.push(chanLoc & 0xff);
    return Uint8Array.from(box);
}
