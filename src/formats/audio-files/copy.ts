import type { TrackInfo } from '../../core/model/track';
import { sampleAt, sampleCount } from '../../core/model/sample-index';
import type { AudioOutputMuxer, AudioTrackConfig } from '../../core/contracts/writer';
import type { Sink } from '../../core/model/types';
import { MediaForgeError } from '../../core/errors/errors';
import { RawMuxer } from './raw-writer';
import { mp3GaplessFrame } from './mp3-gapless';
import { FlacMuxer } from './flac-writer';
import { OggMuxer, oggOpusHead } from '../ogg/writer';
import { VorbisMuxer } from '../ogg/vorbis-writer';
import { AdtsMuxer } from './adts-writer';
import { adtsFieldsFromConfig } from '../../core/codec-config/audio/adts';
import { assertSink } from '../../core/io/sinks/sink-backpressure';
import { createPcmCopyMuxer } from './pcm-copy';
import { createCafAlacCopyMuxer } from './caf-alac-copy';
import type { MediaTags } from '../../core/model/media';
import { hasMediaTags } from '../../core/model/media-tags';
import { riffInfoChunk } from '../metadata/riff-info';
import { vorbisCommentPayload } from '../metadata/vorbis-comment';
import { id3TagFromMediaTags } from '../metadata/id3';
import { dataView } from '../../core/bytes/byte-fields';

function unsupported(message: string): never {
    throw new MediaForgeError(message, 'FORMAT');
}

function opusHeader(config: Uint8Array | undefined): Uint8Array {
    if (!config) return unsupported('Ogg Opus output requires decoder configuration');
    return oggOpusHead(config);
}

function flacHeader(config: Uint8Array | undefined): Uint8Array {
    if (!config) return unsupported('FLAC copying requires STREAMINFO');
    if (config.length >= 42 && String.fromCharCode(...config.subarray(0, 4)) === 'fLaC')
        return config.slice();
    if (config.length !== 34) return unsupported('Invalid FLAC STREAMINFO');
    const result = new Uint8Array(42);
    result.set([102, 76, 97, 67, 128, 0, 0, 34]);
    result.set(config, 8);
    return result;
}

/**
 * Fixed-blocking FLAC places frame n at n times the one block size, which only the last frame may
 * fall short of. Frames joined from chained Ogg links (a short final block inside the stream) or of
 * differing sizes are declared variable-blocking instead: the STREAMINFO block sizes span the
 * frames before the last, which the FLAC writer then numbers by first sample; the frame sizes
 * become unknown because those headers change length.
 */
function declareFlacBlocking(header: Uint8Array, track: TrackInfo): void {
    const view = dataView(header);
    const declared = view.getUint16(8);
    if (declared !== view.getUint16(10)) return;
    const count = sampleCount(track);
    let smallest = declared;
    let largest = declared;
    for (let position = 0; position < count - 1; position++) {
        const sample = sampleAt(track, position);
        if (!sample) return;
        const size = Math.round(sample.duration * track.sampleRate);
        if (size < 16 || size > 65535) return;
        smallest = Math.min(smallest, size);
        largest = Math.max(largest, size);
    }
    if (smallest === largest) return;
    view.setUint16(8, smallest);
    view.setUint16(10, largest);
    header.fill(0, 12, 18);
}

/**
 * Creates an audio-only copy writer without retaining the complete output. Ogg declares the priming
 * and presented samples of `copied`, the track configuration the engine derived for the copy.
 */
export function createAudioCopyMuxer(
    format: string,
    track: TrackInfo,
    sink: Sink,
    copied?: () => AudioTrackConfig,
    tags?: MediaTags,
): AudioOutputMuxer {
    assertSink(sink);
    if (format === 'caf' && track.codec === 'alac') return createCafAlacCopyMuxer(track, sink);
    if (format === 'wav' || format === 'aiff' || format === 'au' || format === 'caf')
        return createPcmCopyMuxer(
            format,
            track,
            sink,
            format === 'wav' ? riffInfoChunk(tags) : undefined,
        );
    if (format === 'flac') {
        if (track.codec !== 'flac') return unsupported('FLAC copy requires FLAC packets');
        const config = flacHeader(track.codecConfig);
        declareFlacBlocking(config, track);
        const bits = (((config[20]! & 1) << 4) | (config[21]! >>> 4)) + 1;
        return new FlacMuxer(sink, track.sampleRate, track.channelCount, bits, config, tags);
    }
    if (format === 'ogg') {
        if (track.codec !== 'opus' && track.codec !== 'vorbis' && track.codec !== 'flac')
            return unsupported('Ogg copy supports Opus, Vorbis or FLAC audio');
        if (!copied) return unsupported('Ogg copying requires the copied track configuration');
        const audio = copied();
        if (track.codec === 'opus') audio.codecConfig = opusHeader(track.codecConfig);
        if (track.codec === 'flac') audio.codecConfig = flacHeader(track.codecConfig);
        const language = track.language && track.language !== 'und' ? track.language : undefined;
        const comments =
            hasMediaTags(tags) || language
                ? vorbisCommentPayload('MediaForgeJS', tags, language)
                : undefined;
        const writer =
            track.codec !== 'vorbis'
                ? new OggMuxer(
                      {
                          format: 'ogg',
                          mode: 'standard',
                          maxFragmentDuration: 2,
                          autoSync: true,
                          audio,
                          ...(comments ? { oggCommentPayload: comments } : {}),
                      },
                      sink,
                  )
                : new VorbisMuxer(sink, audio, comments);
        if (track.codec === 'vorbis') {
            const count = sampleCount(track);
            const last = count ? sampleAt(track, count - 1) : undefined;
            if (last)
                writer.setValidSamples(
                    Math.round((last.timestamp + last.duration) * track.sampleRate) -
                        (track.audioTrailingPaddingSamples ?? 0),
                );
        } else if (audio.validSamples !== undefined) writer.setValidSamples(audio.validSamples);
        return writer;
    }
    if (format === 'aac') {
        if (track.codec !== 'mp4a.40.2') return unsupported('ADTS copying supports AAC-LC audio');
        const fields = track.codecConfig
            ? adtsFieldsFromConfig(track.codecConfig, 'FORMAT')
            : undefined;
        return new AdtsMuxer(
            sink,
            fields?.sampleRate ?? track.sampleRate,
            fields?.channels ?? track.channelCount,
        );
    }
    if (!['mp1', 'mp2', 'mp3'].includes(format) || track.codec !== format)
        return unsupported('Raw output requires a matching MPEG audio layer');

    // MPEG audio files carry their tags, chapters and cover art in a leading ID3v2 tag, then for
    // MP3 the encoder delay and padding the copy presents in a Xing/Info frame.
    const id3 = id3TagFromMediaTags(tags);
    const info = format === 'mp3' && copied ? copiedGaplessFrame(track, copied()) : undefined;
    if (!info) return new RawMuxer(sink, id3);
    const leading = new Uint8Array((id3?.length ?? 0) + info.length);
    if (id3) leading.set(id3);
    leading.set(info, id3?.length ?? 0);
    return new RawMuxer(sink, leading);
}

/** The Info frame of a whole MP3 copy whose source states its priming, or undefined. */
function copiedGaplessFrame(track: TrackInfo, copied: AudioTrackConfig): Uint8Array | undefined {
    if (copied.primingSamples === undefined || copied.validSamples === undefined) return undefined;
    const frames = sampleCount(track);
    let bytes = 0;
    let first = 0;
    let variable = false;
    for (let position = 0; position < frames; position++) {
        const size = sampleAt(track, position)?.size ?? 0;
        if (position === 0) first = size;
        else if (Math.abs(size - first) > 1) variable = true;
        bytes += size;
    }

    return mp3GaplessFrame({
        sampleRate: track.sampleRate,
        channels: track.channelCount,
        frames,
        bytes,
        priming: copied.primingSamples,
        valid: copied.validSamples,
        variable,
    });
}
