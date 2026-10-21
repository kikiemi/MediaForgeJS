import type { ContainerFormat } from '../core/model/media';
import { probeTsLayout } from './mpeg-ts/layout';
import { probePesStream, probeProgramStream } from './shared/mpeg-ps-layout';
import { parseAdtsFrameHeader } from '../core/codec-config/audio/adts';
import { parseMpegAudioHeader } from '../core/codec-config/audio/mpeg-audio-header';
import { dtsStreamForm } from '../core/codec-config/audio/dts-header';
import { firstFlacFrame, parseFlacFrameHeader } from '../core/codec-config/audio/flac-frame';
import { syncAudioFrame, type SyncAudioKind } from './audio-files/sync-frame';
import { isAv1AnnexB, isAv1LowOverhead } from '../core/codec-config/video/av1-config';

/**
 * The elementary stream `h` starts with, or holds a chain of frames of, when it has no signature;
 * else null.
 */
export function streamFormat(h: Uint8Array): ContainerFormat | null {
    const shared = adtsOrFlacFrame(h);
    if (shared) return shared;
    if (probeProgramStream(h)) return 'mpeg';
    if (probeTsLayout(h)) return 'ts';
    if (probePesStream(h)) return 'mpeg';
    // A confirmed Dolby, DTS or TrueHD frame at the very start wins over MPEG-looking bytes inside
    // its payload.
    const sync = sniffSyncAudio(h);
    if (sync) return sync;
    const chain = sniffAudioFrameChain(h);
    if (chain) return chain;
    if (isAv1LowOverhead(h) || isAv1AnnexB(h)) return 'obu';
    if (firstFlacFrame(h) >= 0) return 'flac';
    return null;
}

/**
 * A head starting with the bytes FLAC frame headers and MPEG-2 ADTS headers share (0xFFF8 fixed,
 * 0xFFF9 variable blocking): ADTS unless it is a CRC-checked FLAC frame header that no agreeing
 * ADTS header follows at the frame length its ADTS reading states; null for other heads.
 */
function adtsOrFlacFrame(h: Uint8Array): 'aac' | 'flac' | null {
    if (h[0] !== 0xff || (h[1]! & 0xfe) !== 0xf8) return null;
    if (!parseFlacFrameHeader(h, 0)) return 'aac';
    const first = parseAdtsFrameHeader(h, 0);
    const next = first && parseAdtsFrameHeader(h, first.frameLength);
    return first && next?.sampleRate === first.sampleRate && next.channels === first.channels
        ? 'aac'
        : 'flac';
}

/**
 * Elementary audio streams captured mid-stream start with a partial frame; like ffmpeg's probe,
 * accept the first position in the prefix where three consecutive ADTS, MPEG audio or AC-3/E-AC-3
 * frame headers agree on their configuration.
 */
export function sniffAudioFrameChain(
    h: Uint8Array,
): 'aac' | 'mp1' | 'mp2' | 'mp3' | 'ac3' | 'eac3' | null {
    for (let index = 0; index + 4 <= h.length; index++) {
        if (h[index] === 0x0b && h[index + 1] === 0x77) {
            const dolby = syncAudioFrame('ac3', h, index);
            if (dolby && chainLength(h, index, at => syncAudioFrame('ac3', h, at)?.bytes) >= 3)
                return dolby.codec === 'ec-3' ? 'eac3' : 'ac3';
            continue;
        }

        if (h[index] !== 0xff || (h[index + 1]! & 0xe0) !== 0xe0) continue;
        const adts = parseAdtsFrameHeader(h, index);
        if (
            adts &&
            adts.channels > 0 &&
            chainLength(h, index, at => parseAdtsFrameHeader(h, at)?.frameLength) >= 3
        )
            return 'aac';
        const mpeg = parseMpegAudioHeader(h, index);
        if (
            mpeg &&
            chainLength(h, index, at => {
                const next = parseMpegAudioHeader(h, at);
                return next && next.format === mpeg.format && next.sampleRate === mpeg.sampleRate
                    ? next.frameLength
                    : undefined;
            }) >= 3
        )
            return mpeg.format;
    }
    return null;
}

/**
 * AC-3/E-AC-3, DTS (any word layout) and TrueHD elementary streams: a frame header at the start
 * that the next header confirms, or that ends exactly at the end of a short prefix.
 */
function sniffSyncAudio(h: Uint8Array): 'ac3' | 'eac3' | 'dts' | 'truehd' | null {
    const confirmed = (kind: SyncAudioKind, first: number): boolean => {
        const next = syncAudioFrame(kind, h, first);
        return next !== null || first >= h.length;
    };
    const dolby = syncAudioFrame('ac3', h, 0);
    if (dolby && confirmed('ac3', dolby.bytes)) return dolby.codec === 'ec-3' ? 'eac3' : 'ac3';
    const form = dtsStreamForm(h, 0);
    if (form === 'be16') {
        const dts = syncAudioFrame('dts', h, 0);
        if (dts && confirmed('dts', dts.bytes)) return 'dts';
    } else if (form) return 'dts';
    const truehd = syncAudioFrame('truehd', h, 0);
    if (truehd?.sampleRate && confirmed('truehd', truehd.bytes)) return 'truehd';
    return null;
}

function chainLength(
    h: Uint8Array,
    start: number,
    frameLength: (at: number) => number | undefined,
): number {
    let verified = 0;
    for (let at = start; verified < 3; verified++) {
        const length = frameLength(at);
        if (length === undefined || length <= 0 || at + length > h.length) break;
        at += length;
    }
    return verified;
}
