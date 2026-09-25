import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { MediaForgeError } from '../core/errors.js';
import { copiedAudioTrackConfig } from '../core/pipeline-track-config.js';
import { RawMuxer } from '../mux/raw-muxer.js';
import { FLACMuxer } from '../mux/flac-muxer.js';
import { OGGMuxer } from '../mux/ogg-muxer.js';
import { VorbisMuxer } from '../mux/vorbis-muxer.js';
import { ADTSMuxer } from '../mux/adts-muxer.js';
import { assertSink } from '../io/sink-backpressure.js';
import { createPcmCopyMuxer } from './pcm-copy.js';
export const AUDIO_COPY_FORMATS = new Set([
    'aac',
    'mp1',
    'mp2',
    'mp3',
    'wav',
    'aiff',
    'au',
    'caf',
    'flac',
    'ogg',
]);
function unsupported(message) {
    throw new MediaForgeError(message, 'FORMAT');
}
function opusHeader(config) {
    if (!config)
        return unsupported('Ogg Opus output requires decoder configuration');
    if (config.length >= 19 && String.fromCharCode(...config.subarray(0, 8)) === 'OpusHead')
        return config.slice();
    if (config.length < 11 || config[0] !== 0)
        return unsupported('Invalid Opus dOps configuration');
    const extra = config[10] === 0 ? 0 : 2 + config[1];
    if (config.length !== 11 + extra)
        return unsupported('Invalid Opus channel mapping length');
    const output = new Uint8Array(19 + extra);
    output.set([79, 112, 117, 115, 72, 101, 97, 100, 1, config[1]]);
    const source = new DataView(config.buffer, config.byteOffset, config.byteLength);
    const target = new DataView(output.buffer);
    target.setUint16(10, source.getUint16(2), true);
    target.setUint32(12, source.getUint32(4), true);
    target.setInt16(16, source.getInt16(8), true);
    output[18] = config[10];
    if (extra)
        output.set(config.subarray(11), 19);
    return output;
}
function flacHeader(config) {
    if (!config)
        return unsupported('FLAC copying requires STREAMINFO');
    if (config.length >= 42 && String.fromCharCode(...config.subarray(0, 4)) === 'fLaC')
        return config.slice();
    if (config.length !== 34)
        return unsupported('Invalid FLAC STREAMINFO');
    const result = new Uint8Array(42);
    result.set([102, 76, 97, 67, 128, 0, 0, 34]);
    result.set(config, 8);
    return result;
}
export function createAudioCopyMuxer(format, track, sink) {
    assertSink(sink);
    if (format === 'wav' || format === 'aiff' || format === 'au' || format === 'caf')
        return createPcmCopyMuxer(format, track, sink);
    if (format === 'flac') {
        if (track.codec !== 'flac')
            return unsupported('FLAC copy requires FLAC packets');
        const config = flacHeader(track.codecConfig);
        const bits = (((config[20] & 1) << 4) | (config[21] >>> 4)) + 1;
        return new FLACMuxer(sink, track.sampleRate, track.channelCount, bits, config);
    }
    if (format === 'ogg') {
        if (track.codec !== 'opus' && track.codec !== 'vorbis')
            return unsupported('Ogg copy supports Opus or Vorbis audio');
        const audio = copiedAudioTrackConfig(track, 'ogg');
        if (track.codec === 'opus')
            audio.codecConfig = opusHeader(track.codecConfig);
        const writer = track.codec === 'opus'
            ? new OGGMuxer({ format: 'ogg', mode: 'standard', maxFragmentDuration: 2, autoSync: true, audio }, sink)
            : new VorbisMuxer(sink, audio);
        if (track.codec === 'vorbis') {
            const count = sampleCount(track);
            const last = count ? sampleAt(track, count - 1) : undefined;
            if (last)
                writer.setValidSamples(Math.round((last.timestamp + last.duration) * track.sampleRate) -
                    (track.audioTrailingPaddingSamples ?? 0));
        }
        else if (audio.validSamples !== undefined)
            writer.setValidSamples(audio.validSamples);
        return writer;
    }
    if (format === 'aac') {
        if (track.codec !== 'mp4a.40.2')
            return unsupported('ADTS copying supports AAC-LC audio');
        return new ADTSMuxer(sink, track.sampleRate, track.channelCount);
    }
    if (!['mp1', 'mp2', 'mp3'].includes(format) || track.codec !== format)
        return unsupported('Raw output requires a matching MPEG audio layer');
    return new RawMuxer(sink);
}
