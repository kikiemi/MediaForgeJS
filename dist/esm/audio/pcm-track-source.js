import { awaitWithAbort, linkAbortSignals } from '../core/abort.js';
import { MediaForgeError } from '../core/errors.js';
import { describePcmTrack } from '../core/pcm-format.js';
import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { sampleClockTolerance } from './sample-clock.js';
export const MAX_PCM_PACKET_BYTES = 64 * 1024 * 1024;
export function* decodePcmPacket(bytes, format, signal) {
    const { channels, blockAlign, bitsPerSample, float, signed, littleEndian } = format;
    const width = bitsPerSample / 8;
    if (bytes.byteLength > MAX_PCM_PACKET_BYTES || bytes.byteLength % blockAlign !== 0)
        throw new MediaForgeError('PCM decoding requires bounded complete sample frames', 'DECODE');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const packetFrames = bytes.byteLength / blockAlign;
    for (let start = 0; start < packetFrames; start += 16384) {
        signal?.throwIfAborted();
        const frames = Math.min(16384, packetFrames - start);
        const planes = [];
        for (let channel = 0; channel < channels; channel++) {
            const plane = new Float32Array(frames);
            let at = start * blockAlign + channel * width;
            if (float) {
                for (let frame = 0; frame < frames; frame++, at += blockAlign) {
                    const value = Math.fround(bitsPerSample === 64 ? view.getFloat64(at, littleEndian) : view.getFloat32(at, littleEndian));
                    if (!Number.isFinite(value))
                        throw new MediaForgeError('PCM contains nonfinite samples', 'DECODE');
                    plane[frame] = value;
                }
            }
            else if (bitsPerSample === 16) {
                for (let frame = 0; frame < frames; frame++, at += blockAlign)
                    plane[frame] = view.getInt16(at, littleEndian) / 32768;
            }
            else if (bitsPerSample === 8) {
                for (let frame = 0; frame < frames; frame++, at += blockAlign)
                    plane[frame] = signed ? view.getInt8(at) / 128 : (bytes[at] - 128) / 128;
            }
            else if (bitsPerSample === 24) {
                for (let frame = 0; frame < frames; frame++, at += blockAlign) {
                    const raw = littleEndian
                        ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
                        : bytes[at + 2] | (bytes[at + 1] << 8) | (bytes[at] << 16);
                    plane[frame] = ((raw << 8) >> 8) / 8388608;
                }
            }
            else {
                for (let frame = 0; frame < frames; frame++, at += blockAlign)
                    plane[frame] = view.getInt32(at, littleEndian) / 2147483648;
            }
            planes.push(plane);
        }
        yield planes;
    }
    signal?.throwIfAborted();
}
export function createPcmTrackSource(track, readSample, signal) {
    signal?.throwIfAborted();
    const format = describePcmTrack(track);
    const { sampleRate, channels, blockAlign } = format;
    let totalFrames = 0;
    const count = sampleCount(track);
    const firstTime = sampleAt(track, 0)?.timestamp ?? 0;
    const clockTolerance = sampleClockTolerance(track);
    if ((track.editMediaTimeSeconds ?? 0) !== 0 ||
        (track.audioTrailingPaddingSamples ?? 0) !== 0 ||
        (track.matroskaCodecDelaySeconds ?? 0) !== 0 ||
        firstTime < 0 ||
        track.editPresentationDurationSeconds !== undefined ||
        (track.editLeadTimeSeconds ?? 0) !== 0) {
        throw new MediaForgeError('PCM replay does not support edited or trimmed packet timelines', 'FORMAT');
    }
    for (let index = 0; index < count; index++) {
        const sample = sampleAt(track, index);
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(sample.size) ||
            sample.size < 0 ||
            sample.size > MAX_PCM_PACKET_BYTES ||
            sample.size % blockAlign !== 0 ||
            !Number.isFinite(sample.timestamp) ||
            Math.abs((sample.timestamp - firstTime) * sampleRate - totalFrames) > clockTolerance) {
            throw new MediaForgeError('PCM replay requires bounded complete frames on a contiguous timeline', 'DEMUX');
        }
        totalFrames += sample.size / blockAlign;
        if (!Number.isSafeInteger(totalFrames))
            throw new MediaForgeError('PCM frame count exceeds the exact integer range', 'OOM');
    }
    return {
        sampleRate,
        channels,
        estimatedFrames: totalFrames,
        async *chunks(replaySignal) {
            const linked = linkAbortSignals(signal, replaySignal);
            try {
                for (let index = 0; index < count; index++) {
                    const sample = sampleAt(track, index);
                    linked.signal.throwIfAborted();
                    const bytes = sample.data ?? (await awaitWithAbort(readSample(sample), linked.signal));
                    linked.signal.throwIfAborted();
                    if (bytes.byteLength !== sample.size)
                        throw new MediaForgeError('PCM packet read returned an incorrect byte count', 'DECODE');
                    yield* decodePcmPacket(bytes, format, linked.signal);
                }
                linked.signal.throwIfAborted();
            }
            finally {
                linked.dispose();
            }
        },
    };
}
