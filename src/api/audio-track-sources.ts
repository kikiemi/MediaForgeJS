import type { TrackInfo } from '../core/model/track';
import { decodeAudioTrack } from '../pipeline/codecs/audio-track-source';
import { flacAudioCodec } from '../codecs/flac/decoder';
import { mpegAudioCodec } from '../codecs/mpeg-audio/mp3-decoder';
import type { ReplayablePcmSource } from '../codecs/pcm/pcm-source';

/**
 * Built-in MP3 decoding of a demuxed track, trimmed by its priming, padding and presentation edit.
 */
export function createMp3TrackPcmSource(
    track: TrackInfo,
    readPacket: (index: number, signal?: AbortSignal) => Promise<Uint8Array>,
    signal?: AbortSignal,
): ReplayablePcmSource {
    return decodeAudioTrack(
        track,
        (_sample, index, readSignal) => readPacket(index, readSignal),
        { signal, builtinOnly: true },
        mpegAudioCodec(track),
    );
}

/** Built-in FLAC decoding of demuxed frames (raw FLAC, Ogg, Matroska or MP4 fLaC tracks). */
export function createFlacTrackPcmSource(
    track: TrackInfo,
    readPacket: (index: number, signal?: AbortSignal) => Promise<Uint8Array>,
): ReplayablePcmSource {
    return decodeAudioTrack(
        track,
        (_sample, index, readSignal) => readPacket(index, readSignal),
        { builtinOnly: true },
        flacAudioCodec(track),
    );
}
