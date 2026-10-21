import {
    dolbyFrameLocations,
    parseDolbyFrameHeader,
} from '../../core/codec-config/audio/dolby-audio-header';
import { parseDtsFrame } from '../../core/codec-config/audio/dts-header';
import { parseMpegAudioHeader } from '../../core/codec-config/audio/mpeg-audio-header';
import { parseTrueHdAccessUnit } from '../../core/codec-config/audio/truehd-header';

/** Elementary streams framed by sync words: Dolby AC-3/E-AC-3, DTS, Dolby TrueHD and MPEG audio. */
export type SyncAudioKind = 'ac3' | 'eac3' | 'dts' | 'truehd' | 'mpeg';

interface SyncFrame {
    readonly codec: string;
    readonly bytes: number;
    /** Continues the previous access unit (E-AC-3 dependent or additional substreams). */
    readonly continuation?: boolean;
    readonly sampleRate?: number;
    readonly channels?: number;
    readonly samples?: number;
    /**
     * Dolby channel locations as chanmap bits; an access unit carries the union of its frames'
     * locations.
     */
    readonly locations?: number;
}

/**
 * Frame at `offset` of a 16-bit big-endian stream of `kind`, or null when no valid header starts
 * there.
 */
export function syncAudioFrame(
    kind: SyncAudioKind,
    data: Uint8Array,
    offset: number,
): SyncFrame | null {
    if (kind === 'ac3' || kind === 'eac3') {
        const header = parseDolbyFrameHeader(data, offset);
        if (!header || header.frameBytes < 7) return null;
        return {
            codec: header.codec,
            bytes: header.frameBytes,
            continuation: header.streamType === 1 || header.substreamId > 0,
            sampleRate: header.sampleRate,
            channels: header.channels,
            samples: header.samples,
            locations: dolbyFrameLocations(data, offset, header),
        };
    }

    if (kind === 'dts') {
        const frame = parseDtsFrame(data, offset);
        return frame && { ...frame, bytes: frame.frameBytes };
    }

    if (kind === 'truehd') {
        const unit = parseTrueHdAccessUnit(data, offset);
        return unit && { codec: 'mlpa', bytes: unit.bytes, ...unit.format };
    }

    const header = parseMpegAudioHeader(data, offset);
    return (
        header && {
            codec: header.format,
            bytes: header.frameLength,
            sampleRate: header.sampleRate,
            channels: header.channels,
            samples: header.samplesPerFrame,
        }
    );
}
