import type { TrackInfo } from '../../core/model/track';
import type { AudioOutputMuxer } from '../../core/contracts/writer';
import type { EncodedPacket } from '../../core/model/media';
import type { Sink } from '../../core/model/types';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import {
    describePcmTrack,
    createG711Header,
    createPcmCopyHeader,
    convertPcmByteOrder,
    type PcmCopyContainer,
} from '../../core/codec-config/audio/pcm-format';
import { copyOutputBytes, outputByteLength } from '../../core/bytes/output-data';
import { assertSink } from '../../core/io/sinks/sink-backpressure';
import { getCompactSampleIndex, sampleAt, sampleCount } from '../../core/model/sample-index';
import { RawMuxer } from './raw-writer';
import { riffWithInfo } from './tags';

function invalid(message: string): never {
    throw new MediaForgeError(message, 'FORMAT');
}

/**
 * Streams complete PCM or G.711 frames with a precomputed header and lossless sign/endian
 * conversion.
 */
/** `info` is a LIST/INFO chunk a WAVE output carries (its tags). */
export function createPcmCopyMuxer(
    container: PcmCopyContainer,
    track: TrackInfo,
    sink: Sink,
    info?: Uint8Array,
): AudioOutputMuxer {
    const { write, close, drain, signal, abort, patchAt } = sink;
    assertSink({ write, close, drain, signal, abort, patchAt });
    const { codec, codecConfig, sampleRate, channelCount } = track;
    const g711 = codec === 'ulaw' || codec === 'alaw' ? codec : undefined;
    const format = g711
        ? undefined
        : describePcmTrack({ codec, codecConfig, sampleRate, channelCount });
    const blockAlign = format ? format.blockAlign : channelCount;
    if (!getCompactSampleIndex(track) && !Array.isArray(track.samples))
        return invalid('PCM copying requires a packet index');

    const count = sampleCount(track);
    let length = 0;
    for (let index = 0; index < count; index++) {
        const size = sampleAt(track, index)!.size;
        if (
            !Number.isSafeInteger(size) ||
            size < 0 ||
            size % blockAlign !== 0 ||
            size > Number.MAX_SAFE_INTEGER - 128 - length
        )
            return invalid('PCM packets must contain complete frames within the exact size range');
        length += size;
    }

    const { header, padding, convert } = format
        ? (() => {
              const copy = createPcmCopyHeader(container, format, length);
              return {
                  ...copy,
                  header: container === 'wav' ? riffWithInfo(copy.header, info) : copy.header,
                  convert: (data: Uint8Array) => convertPcmByteOrder(data, format, copy.target),
              };
          })()
        : (() => {
              const copy = createG711Header(container, g711!, sampleRate, channelCount, length);
              return {
                  ...copy,
                  header: container === 'wav' ? riffWithInfo(copy.header, info) : copy.header,
                  convert: copyOutputBytes,
              };
          })();

    let started = false;
    let remaining = length;
    let busy = false;
    let finished = false;
    let failure: { error: unknown } | undefined;

    const writer = new RawMuxer({
        signal,
        write(data): void {
            try {
                if (!started) {
                    started = true;
                    write.call(sink, header);
                }
                throwIfAborted(signal);
                if (data.length) write.call(sink, data);
                throwIfAborted(signal);
            } catch (error) {
                failure ??= { error };
                throw failure.error;
            }
        },
        close: () => close.call(sink),
        ...(drain ? { drain: () => drain.call(sink) } : {}),
    });

    const check = (): void => {
        if (failure) throw failure.error;
        throwIfAborted(signal);
        if (finished) throw new MediaForgeError('PCM writer is finalized', 'MUX');
        if (busy) throw new MediaForgeError('PCM writer operation already in progress', 'MUX');
    };

    return {
        addAudioChunk(chunk: EncodedPacket): void {
            check();
            busy = true;
            try {
                if (chunk?.trackType !== 'audio')
                    throw new MediaForgeError('PCM requires an audio chunk', 'MUX');
                const data = chunk.data;
                const count = outputByteLength(data);
                if (count % blockAlign || count > remaining)
                    return invalid('PCM packet bytes exceed the declared complete frames');
                if (count > 64 * 1024 * 1024)
                    throw new MediaForgeError(
                        'PCM copy packet exceeds the 64 MiB byte limit',
                        'OOM',
                    );
                throwIfAborted(signal);
                const owned = convert(data);
                writer.addAudioChunk({
                    trackType: 'audio',
                    data: owned,
                    timestamp: 0,
                    duration: 0,
                    isKeyframe: true,
                });
                remaining -= count;
            } finally {
                busy = false;
            }
        },
        async finalize(): Promise<void> {
            check();
            if (remaining !== 0) return invalid('PCM output is missing declared frames');
            finished = true;
            busy = true;
            try {
                if (!started || padding)
                    writer.addAudioChunk({
                        trackType: 'audio',
                        data: new Uint8Array(padding),
                        timestamp: 0,
                        duration: 0,
                        isKeyframe: true,
                    });
                await writer.finalize();
            } catch (error) {
                failure ??= { error };
                throw failure.error;
            } finally {
                busy = false;
            }
        },
    };
}
