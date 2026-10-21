import type { Source } from '../../core/model/types';
import type { TrackInfo } from '../../core/model/track';
import { readSampleBytes, sampleAt, sampleCount } from '../../core/model/sample-index';
import { awaitWithAbort } from '../../core/io/abort';
import { assertSourceBytes } from '../../core/io/sources/source-read';
import { throwIfAborted } from '../../core/errors/errors';
import { isDtsCodec } from '../../core/model/codec-strings';
import { dtsSpecificBox, parseDtsFrame } from '../../core/codec-config/audio/dts-header';
import { parseTrueHdAccessUnit } from '../../core/codec-config/audio/truehd-header';
import {
    ac3SpecificBox,
    eac3SpecificBox,
    parseDolbyFrameHeader,
} from '../../core/codec-config/audio/dolby-audio-header';

/**
 * describeSyncAudioTracks() for one DTS, AC-3, E-AC-3 or TrueHD track: its first frame within eight
 * packets.
 */
export async function describeSyncAudioTrack(
    track: TrackInfo,
    source: Source,
    maxPacketBytes: number,
    signal?: AbortSignal,
): Promise<void> {
    const dts = isDtsCodec(track.codec);
    const dolby = track.codec === 'ac-3' || track.codec === 'ec-3';
    for (let index = 0, length = Math.min(8, sampleCount(track)); index < length; index++) {
        const sample = sampleAt(track, index)!;
        throwIfAborted(signal);
        if (sample.size > maxPacketBytes) break;
        const bytes = await awaitWithAbort(readSampleBytes(track, sample, source, signal), signal);
        assertSourceBytes(bytes, sample.size, 'Audio configuration scan');
        if (dts) {
            const frame = parseDtsFrame(bytes, 0);
            if (!frame) continue;
            track.codec = frame.codec;
            track.sampleRate = frame.sampleRate;
            track.channelCount = frame.channels;
            if (!(track.codecConfig && track.codecConfig.length >= 20))
                track.codecConfig = dtsSpecificBox(bytes, 0);
            break;
        }
        if (dolby) {
            track.codecConfig = track.codec === 'ac-3' ? ac3Config(bytes) : eac3SpecificBox(bytes);
            break;
        }
        const format = parseTrueHdAccessUnit(bytes, 0)?.format;
        if (!format) continue;
        track.sampleRate = format.sampleRate;
        track.channelCount = format.channels;

        // dmlp: the major sync format_info, the 15-bit peak data rate and reserved bits.
        if (!track.codecConfig && bytes.length >= 20) {
            const dmlp = new Uint8Array(10);
            dmlp.set(bytes.subarray(8, 12));
            const peak = ((bytes[18]! & 0x7f) << 8) | bytes[19]!;
            dmlp[4] = peak >> 7;
            dmlp[5] = (peak << 1) & 0xff;
            track.codecConfig = dmlp;
        }
        break;
    }
}

function ac3Config(bytes: Uint8Array): Uint8Array | undefined {
    return parseDolbyFrameHeader(bytes, 0)?.codec === 'ac-3' ? ac3SpecificBox(bytes, 0) : undefined;
}
