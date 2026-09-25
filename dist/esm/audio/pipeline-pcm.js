import { createPcmTrackSource } from './pcm-track-source.js';
import { StreamingPcmTransformer } from './streaming-pcm.js';
import { SelfHostedAacMuxBridge } from './pipeline-aac.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { EncodeError } from '../core/errors.js';
import { mp4aAudioObjectType } from '../core/codec-strings.js';
import { isPcmOutputMuxer } from '../core/pcm-muxer.js';
import { AAC_SAMPLE_RATES } from './aac-tables.js';
import { sampleAt } from '../demux/sample-index.js';
export async function pipePcmTrack(host, track, source, codec, muxer) {
    const lifetime = new CodecLifetime(host.signal);
    let encoder;
    try {
        lifetime.check();
        const pcm = createPcmTrackSource(track, sample => lifetime.waitFor(source.read(sample.offset, sample.size)), host.signal);
        const target = host.targetAudioParams(pcm.sampleRate, pcm.channels, codec);
        const valid = Math.round((pcm.estimatedFrames * target.rate) / pcm.sampleRate);
        const startOffset = Math.max(0, sampleAt(track, 0)?.timestamp ?? 0);
        let frames = 0;
        let chunks = 0;
        let consume;
        let bridge;
        if (mp4aAudioObjectType(codec) === 2 && target.channels <= 2 && AAC_SAMPLE_RATES.includes(target.rate)) {
            bridge = new SelfHostedAacMuxBridge(target.rate, target.channels, Math.round(host.audioBitrateFor() / 1000), muxer, startOffset, valid);
            consume = planes => bridge.push(planes);
        }
        else if (codec === 'pcm' && isPcmOutputMuxer(muxer)) {
            consume = planes => {
                muxer.addPCMPlanarChunk(planes, target.rate, startOffset + frames / target.rate);
                frames += planes[0]?.length ?? 0;
            };
        }
        else {
            if (typeof AudioEncoder !== 'function' || typeof AudioData !== 'function')
                throw new EncodeError(`Audio WebCodecs are unavailable for '${codec}' output`);
            const config = {
                codec,
                sampleRate: target.rate,
                numberOfChannels: target.channels,
                bitrate: host.audioBitrateFor(),
            };
            const supported = await lifetime.waitFor(AudioEncoder.isConfigSupported(config));
            if (!supported.supported)
                throw new EncodeError(`AudioEncoder does not support '${codec}'`);
            encoder = new AudioEncoder({
                output(chunk, metadata) {
                    if (!lifetime.acceptingOutput)
                        return;
                    try {
                        const data = new Uint8Array(chunk.byteLength);
                        chunk.copyTo(data);
                        const description = metadata?.decoderConfig?.description;
                        const codecConfig = description
                            ? ArrayBuffer.isView(description)
                                ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice()
                                : new Uint8Array(description).slice()
                            : undefined;
                        muxer.addAudioChunk({
                            data,
                            timestamp: chunk.timestamp / 1e6,
                            duration: (chunk.duration ?? 0) / 1e6,
                            isKeyframe: true,
                            trackType: 'audio',
                        }, codecConfig);
                        chunks++;
                    }
                    catch (error) {
                        lifetime.record(error);
                    }
                },
                error: error => {
                    lifetime.record(new EncodeError(error.message));
                },
            });
            encoder.configure(config);
            consume = planes => {
                lifetime.check();
                const count = planes[0]?.length ?? 0;
                if (!count)
                    return;
                const data = new Float32Array(count * target.channels);
                for (let channel = 0; channel < target.channels; channel++)
                    data.set(planes[channel], channel * count);
                const audio = new AudioData({
                    format: 'f32-planar',
                    sampleRate: target.rate,
                    numberOfFrames: count,
                    numberOfChannels: target.channels,
                    timestamp: Math.round((startOffset + frames / target.rate) * 1e6),
                    data,
                });
                try {
                    encoder.encode(audio);
                }
                finally {
                    audio.close();
                }
                frames += count;
            };
        }
        const transformer = new StreamingPcmTransformer(pcm.sampleRate, pcm.channels, target.rate, target.channels, consume, { valid });
        for await (const planes of pcm.chunks(host.signal)) {
            lifetime.check();
            while (encoder && encoder.encodeQueueSize > 8)
                await lifetime.waitFor(host.yield());
            transformer.push(planes);
            host.report(78 + Math.round((transformer.framesEmitted / Math.max(1, valid)) * 20), 'Streaming PCM audio');
            await lifetime.waitFor(host.yield());
        }
        lifetime.check();
        transformer.flush();
        bridge?.finish(transformer.framesEmitted);
        if (encoder) {
            await lifetime.waitFor(encoder.flush());
            if (!chunks)
                throw new EncodeError('AudioEncoder produced no output');
        }
        lifetime.check();
    }
    catch (error) {
        throw lifetime.record(error);
    }
    finally {
        lifetime.stop();
        if (encoder && encoder.state !== 'closed') {
            try {
                encoder.close();
            }
            catch { }
        }
    }
}
