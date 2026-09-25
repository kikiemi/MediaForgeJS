import { MediaForgeError } from '../core/errors.js';
import { runReplayableAudio } from './replayable-audio-lifetime.js';
import { drainSink } from '../io/sink-backpressure.js';
import { M4ASampleSizeLedger, StreamingM4AMuxer } from '../mux/m4a-streaming-muxer.js';
import { buildAacAsc } from './adts.js';
import { createStreamingAudioOutput } from './streaming-audio-output-core.js';
import { StreamingAacLcEncoder } from './aac-encoder.js';
import { snapshotMP4TrackMetadata } from '../core/mp4-metadata.js';
const { streamReplayableAac } = createStreamingAudioOutput({ aac: StreamingAacLcEncoder });
function sameBytes(left, right) {
    if (left.length !== right.length)
        return false;
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index])
            return false;
    }
    return true;
}
export async function encodeReplayableM4AToSink(source, sink, options = {}) {
    const resolved = { ...options };
    for (const key of [
        'bitrateKbps',
        'moovUserData',
        'audioLanguage',
        'title',
        'audioTrack',
        'signal',
        'onProgress',
    ]) {
        if (!Object.prototype.hasOwnProperty.call(resolved, key)) {
            const value = options[key];
            if (value !== undefined)
                Object.defineProperty(resolved, key, { value, enumerable: true });
        }
    }
    if (resolved.audioLanguage !== undefined && typeof resolved.audioLanguage !== 'string') {
        throw new MediaForgeError('audioLanguage must be a string', 'FORMAT');
    }
    resolved.audioTrack = snapshotMP4TrackMetadata(resolved.audioTrack, 'audio');
    if (resolved.title !== undefined && typeof resolved.title !== 'string')
        throw new MediaForgeError('M4A title must be a string', 'FORMAT');
    return runReplayableAudio(source, sink, resolved, (input, output, guarded) => encodeReplayableM4AToSinkInternal(input, output, guarded));
}
async function encodeReplayableM4AToSinkInternal(source, sink, options = {}) {
    const asc = buildAacAsc(source.sampleRate, source.channels);
    let planned;
    let dryFrames = 0;
    let dryPeak = 0;
    if (!sink.patchAt) {
        planned = new M4ASampleSizeLedger();
        const dry = await streamReplayableAac(source, frame => planned.push(frame.length), {
            bitrateKbps: options.bitrateKbps,
            signal: options.signal,
            afterPcmChunk: () => drainSink(sink, options.signal),
            onProgress: (fraction, message) => options.onProgress?.(fraction * 0.45, `Planning M4A: ${message}`),
        });
        if (!sameBytes(dry.audioSpecificConfig, asc)) {
            throw new MediaForgeError('AAC configuration changed during M4A planning', 'ENCODE');
        }
        dryFrames = dry.inputFrames;
        dryPeak = dry.peakPcmFrames;
    }
    const muxer = new StreamingM4AMuxer(sink, {
        sampleRate: source.sampleRate,
        channels: source.channels,
        audioSpecificConfig: asc,
        primingSamples: 1024,
        moovUserData: options.moovUserData,
        audioLanguage: options.audioLanguage,
        title: options.title,
        audioTrack: options.audioTrack,
        plannedSizes: planned,
        signal: options.signal,
    });
    const base = planned ? 0.45 : 0;
    const scale = planned ? 0.54 : 0.99;
    const encoded = await streamReplayableAac(source, frame => muxer.addFrame(frame), {
        bitrateKbps: options.bitrateKbps,
        signal: options.signal,
        afterPcmChunk: () => drainSink(sink, options.signal),
        onProgress: (fraction, message) => options.onProgress?.(base + fraction * scale, message),
    });
    if (!sameBytes(encoded.audioSpecificConfig, asc) || (planned && encoded.inputFrames !== dryFrames)) {
        throw new MediaForgeError(`PCM/AAC replay changed during M4A output (${dryFrames} -> ${encoded.inputFrames})`, 'ENCODE');
    }
    options.onProgress?.(1, 'Finalizing output...');
    await muxer.finalize(encoded.inputFrames);
    return {
        passes: planned ? 2 : 1,
        inputFrames: encoded.inputFrames,
        packets: muxer.packets,
        peakPcmFrames: Math.max(dryPeak, encoded.peakPcmFrames),
        planningBytes: muxer.planningBytes,
    };
}
