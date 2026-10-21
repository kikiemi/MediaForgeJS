import { DecodeError } from '../../core/errors/errors';
import {
    DOLBY_ACMOD_CHANNELS,
    DOLBY_SAMPLE_RATES,
    ac3FrameWords,
} from '../../core/codec-config/audio/dolby-audio-header';
import type { FrameBits } from './bits';

/** The sync information and bit stream information of an AC-3 or E-AC-3 frame. */
export interface FrameHeader {
    readonly eac3: boolean;
    /** E-AC-3 stream type: 0 independent, 1 dependent, 2 converted from AC-3 (also AC-3). */
    readonly frameType: number;
    readonly substreamId: number;
    readonly frameBytes: number;
    readonly sampleRate: number;
    /** fscod of the bit allocation tables, and the halvings of half- and quarter-rate streams. */
    readonly rateCode: number;
    readonly rateShift: number;
    readonly blocks: number;
    readonly acmod: number;
    readonly lfe: boolean;
    /** Full-bandwidth channels. */
    readonly fbw: number;
    /** A dependent substream's custom channel map, location 0 (L) in bit 15. */
    readonly channelMap?: number;
}

/** Reads the sync information and bsi of the frame `bits` starts at, AC-3 or E-AC-3. */
export function readFrameHeader(bits: FrameBits, available: number): FrameHeader {
    if (bits.read(16) !== 0x0b77) throw new DecodeError('AC-3 frame has no sync word');
    const start = bits.position;
    bits.skip(24);
    const bsid = bits.read(5);
    bits.position = start;
    if (bsid <= 10) return readAc3Header(bits, available, bsid);
    if (bsid <= 16) return readEac3Header(bits, available);
    throw new DecodeError(`AC-3 bitstream id ${bsid} is not supported`);
}

/** Dialogue normalization and heavy compression of each program, which output does not use. */
function skipVolume(bits: FrameBits, acmod: number): void {
    for (let program = 0; program < (acmod ? 1 : 2); program++) {
        bits.skip(5);
        if (bits.flag()) bits.skip(8);
    }
}

/** A/52 5.3.1-2: the AC-3 header after the sync word. */
function readAc3Header(bits: FrameBits, available: number, bsid: number): FrameHeader {
    bits.skip(16);
    const rateCode = bits.read(2);
    const sizeCode = bits.read(6);
    if (rateCode === 3 || sizeCode > 37) throw new DecodeError('AC-3 frame has a reserved code');
    bits.skip(8);
    const acmod = bits.read(3);
    if (acmod === 2) bits.skip(2);
    else {
        if (acmod & 1 && acmod !== 1) bits.skip(2);
        if (acmod & 4) bits.skip(2);
    }
    const lfe = bits.flag();

    // Volume, language and production information (twice for 1+1).
    for (let program = 0; program < (acmod ? 1 : 2); program++) {
        skipVolume(bits, 1);
        if (bits.flag()) bits.skip(8);
        if (bits.flag()) bits.skip(7);
    }
    bits.skip(2);

    // Time codes, or the alternate syntax's extended bit stream information (14 bits each).
    if (bits.flag()) bits.skip(14);
    if (bits.flag()) bits.skip(14);
    if (bits.flag()) bits.skip((bits.read(6) + 1) * 8);

    const rateShift = Math.max(bsid, 8) - 8;
    const frameBytes = ac3FrameWords(sizeCode, rateCode) * 2;
    if (frameBytes > available) throw new DecodeError('AC-3 frame is cut short');
    return {
        eac3: false,
        frameType: 2,
        substreamId: 0,
        frameBytes,
        sampleRate: DOLBY_SAMPLE_RATES[rateCode]! >> rateShift,
        rateCode,
        rateShift,
        blocks: 6,
        acmod,
        lfe,
        fbw: DOLBY_ACMOD_CHANNELS[acmod]!,
    };
}

/** ETSI TS 102 366 E.1.2.2: the E-AC-3 bsi after the sync word. */
function readEac3Header(bits: FrameBits, available: number): FrameHeader {
    const frameType = bits.read(2);
    if (frameType === 3) throw new DecodeError('E-AC-3 stream type 3 is reserved');
    const substreamId = bits.read(3);
    const frameBytes = (bits.read(11) + 1) * 2;
    const rateCode = bits.read(2);
    if (rateCode === 3) throw new DecodeError('E-AC-3 at a reduced sample rate is not supported');
    const blocks = [1, 2, 3, 6][bits.read(2)]!;
    const acmod = bits.read(3);
    const lfe = bits.flag();
    bits.skip(5);
    skipVolume(bits, acmod);
    const channelMap = frameType === 1 && bits.flag() ? bits.read(16) : undefined;

    // Mixing metadata.
    if (bits.flag()) {
        if (acmod > 2) bits.skip(2);
        if (acmod & 1 && acmod > 2) bits.skip(6);
        if (acmod & 4) bits.skip(6);
        if (lfe && bits.flag()) bits.skip(5);
        if (frameType === 0) {
            for (let program = 0; program < (acmod ? 1 : 2); program++)
                if (bits.flag()) bits.skip(6);
            if (bits.flag()) bits.skip(6);
            const mixing = bits.read(2);
            if (mixing === 1) bits.skip(5);
            else if (mixing === 2) bits.skip(12);
            else if (mixing === 3) bits.skip((bits.read(5) + 2) * 8);
            if (acmod < 2)
                for (let program = 0; program < (acmod ? 1 : 2); program++)
                    if (bits.flag()) bits.skip(14);
            if (bits.flag())
                for (let block = 0; block < blocks; block++)
                    if (blocks === 1 || bits.flag()) bits.skip(5);
        }
    }

    // Informational metadata.
    if (bits.flag()) {
        bits.skip(5);
        if (acmod === 2) bits.skip(4);
        if (acmod >= 6) bits.skip(2);
        for (let program = 0; program < (acmod ? 1 : 2); program++) if (bits.flag()) bits.skip(8);
        bits.skip(1);
    }
    if (frameType === 0 && blocks !== 6) bits.skip(1);
    if (frameType === 2 && (blocks === 6 || bits.flag())) bits.skip(6);
    if (bits.flag()) bits.skip((bits.read(6) + 1) * 8);

    if (frameBytes > available) throw new DecodeError('E-AC-3 frame is cut short');
    return {
        eac3: true,
        frameType,
        substreamId,
        frameBytes,
        sampleRate: DOLBY_SAMPLE_RATES[rateCode]!,
        rateCode,
        rateShift: 0,
        blocks,
        acmod,
        lfe,
        fbw: DOLBY_ACMOD_CHANNELS[acmod]!,
        ...(channelMap !== undefined ? { channelMap } : {}),
    };
}
