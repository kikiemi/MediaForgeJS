import { MediaForgeError } from '../core/errors.js';
import { describePcmTrack, createPcmCopyHeader, convertPcmByteOrder } from '../core/pcm-format.js';
import { outputByteLength } from '../io/output-data.js';
import { assertSink } from '../io/sink-backpressure.js';
import { RawMuxer } from '../mux/raw-muxer.js';
function invalid(message) {
    throw new MediaForgeError(message, 'FORMAT');
}
export function createPcmCopyMuxer(container, track, sink) {
    const { write, close, drain, signal, abort, patchAt } = sink;
    assertSink({ write, close, drain, signal, abort, patchAt });
    const { codec, codecConfig, sampleRate, channelCount, samples } = track;
    const format = describePcmTrack({ codec, codecConfig, sampleRate, channelCount });
    if (!Array.isArray(samples))
        return invalid('PCM copying requires a packet index');
    let length = 0;
    for (const sample of samples) {
        const size = sample.size;
        if (!Number.isSafeInteger(size) ||
            size < 0 ||
            size % format.blockAlign !== 0 ||
            size > Number.MAX_SAFE_INTEGER - 128 - length)
            return invalid('PCM packets must contain complete frames within the exact size range');
        length += size;
    }
    const { header, target, padding } = createPcmCopyHeader(container, format, length);
    let started = false;
    let remaining = length;
    let busy = false;
    let finished = false;
    let failure;
    const writer = new RawMuxer({
        signal,
        write(data) {
            try {
                if (!started) {
                    started = true;
                    write.call(sink, header);
                }
                if (signal?.aborted)
                    throw new MediaForgeError('Aborted', 'ABORT');
                if (data.length)
                    write.call(sink, data);
                if (signal?.aborted)
                    throw new MediaForgeError('Aborted', 'ABORT');
            }
            catch (error) {
                failure ??= { error };
                throw failure.error;
            }
        },
        close: () => close.call(sink),
        ...(drain ? { drain: () => drain.call(sink) } : {}),
    });
    const check = () => {
        if (failure)
            throw failure.error;
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        if (finished)
            throw new MediaForgeError('PCM writer is finalized', 'MUX');
        if (busy)
            throw new MediaForgeError('PCM writer operation already in progress', 'MUX');
    };
    return {
        addAudioChunk(chunk) {
            check();
            busy = true;
            try {
                if (chunk?.trackType !== 'audio')
                    throw new MediaForgeError('PCM requires an audio chunk', 'MUX');
                const data = chunk.data;
                const count = outputByteLength(data);
                if (count % format.blockAlign || count > remaining)
                    return invalid('PCM packet bytes exceed the declared complete frames');
                if (count > 64 * 1024 * 1024)
                    throw new MediaForgeError('PCM copy packet exceeds the 64 MiB byte limit', 'OOM');
                if (signal?.aborted)
                    throw new MediaForgeError('Aborted', 'ABORT');
                const owned = convertPcmByteOrder(data, format, target);
                writer.addAudioChunk({ trackType: 'audio', data: owned, timestamp: 0, duration: 0, isKeyframe: true });
                remaining -= count;
            }
            finally {
                busy = false;
            }
        },
        async finalize() {
            check();
            if (remaining !== 0)
                return invalid('PCM output is missing declared frames');
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
            }
            catch (error) {
                failure ??= { error };
                throw failure.error;
            }
            finally {
                busy = false;
            }
        },
    };
}
