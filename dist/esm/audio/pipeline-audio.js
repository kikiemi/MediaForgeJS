import { assertAudioEncodeRequest } from '../core/format-plans.js';
import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { isPcmOutputMuxer } from '../core/pcm-muxer.js';
import { DecodeError, EncodeError, MediaForgeError, rethrowIfAbort } from '../core/errors.js';
import { webCodecsAudioCodec, mp4aAudioObjectType } from '../core/codec-strings.js';
import { logger } from '../core/logger.js';
import { readAacAudioObjectType } from './adts.js';
import { WebCodecsAudioTranscoder } from './webcodecs-audio-transcoder.js';
import { StreamingPcmTransformer } from './streaming-pcm.js';
import { PipelineAac, SelfHostedAacMuxBridge } from './pipeline-aac.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { awaitWithAbort } from '../core/abort.js';
import { encodeAudioBufferWithEncoder, renderAudioBuffer, yieldToEventLoop } from './audio-buffer-tools.js';
import { pipePcmTrack } from './pipeline-pcm.js';
function copyCodecDescription(description) {
    if (!description)
        return undefined;
    if (description instanceof ArrayBuffer)
        return new Uint8Array(description.slice(0));
    if (ArrayBuffer.isView(description)) {
        return new Uint8Array(description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength));
    }
    return undefined;
}
function copyAudioDataPlanar(audioData) {
    const planes = [];
    for (let channel = 0; channel < audioData.numberOfChannels; channel++) {
        const plane = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
        planes.push(plane);
    }
    return planes;
}
function nativeAudioFailure(error, kind) {
    if (error instanceof MediaForgeError)
        return error;
    if (error instanceof DOMException && error.name === 'AbortError')
        return error;
    const message = error instanceof Error ? error.message : String(error);
    return kind === 'decode' ? new DecodeError(message) : new EncodeError(message);
}
function allowsAudioFallback(error) {
    return error instanceof MediaForgeError && (error.code === 'DECODE' || error.code === 'ENCODE');
}
async function probeAudioSupport(lifetime, probe) {
    lifetime.check();
    const result = await lifetime.waitFor(Promise.resolve()
        .then(() => {
        lifetime.check();
        return probe();
    })
        .then(value => ({ value, error: null }), error => ({ value: null, error })));
    if (result.error) {
        rethrowIfAbort(result.error);
        if (result.error instanceof MediaForgeError && !allowsAudioFallback(result.error))
            throw result.error;
    }
    return result.value;
}
async function runAudioFallback(signal, run) {
    const lifetime = new CodecLifetime(signal);
    try {
        lifetime.check();
        await lifetime.waitFor(Promise.resolve().then(() => {
            lifetime.check();
            return run(lifetime);
        }));
    }
    finally {
        lifetime.stop();
    }
}
function audioOutput(lifetime, codec, muxer, maxChunks, startOffsetSeconds = 0) {
    let chunksMuxed = 0;
    let stopped = false;
    let codecConfig;
    const requestedObjectType = mp4aAudioObjectType(codec);
    return {
        get chunksMuxed() {
            return chunksMuxed;
        },
        stop() {
            stopped = true;
        },
        output: (chunk, meta) => {
            if (stopped || !lifetime.acceptingOutput || chunksMuxed >= maxChunks)
                return;
            try {
                const nextConfig = copyCodecDescription(meta?.decoderConfig?.description);
                if (nextConfig && !codecConfig) {
                    const actualObjectType = readAacAudioObjectType(nextConfig);
                    if (requestedObjectType !== null && actualObjectType !== requestedObjectType) {
                        throw new EncodeError(`AudioEncoder returned AAC object type ${actualObjectType ?? 'unknown'} for requested '${codec}'`);
                    }
                    codecConfig = nextConfig;
                }
                if (requestedObjectType !== null && requestedObjectType !== 2 && !codecConfig) {
                    throw new EncodeError(`AudioEncoder did not provide a verifiable AudioSpecificConfig for requested '${codec}'`);
                }
                const data = new Uint8Array(chunk.byteLength);
                chunk.copyTo(data);
                lifetime.check();
                muxer.addAudioChunk({
                    data,
                    timestamp: chunk.timestamp / 1e6 + startOffsetSeconds,
                    duration: (chunk.duration ?? 0) / 1e6,
                    isKeyframe: true,
                    trackType: 'audio',
                }, codecConfig);
                chunksMuxed++;
            }
            catch (error) {
                lifetime.record(error);
            }
        },
    };
}
export class PipelineAudio {
    host;
    cfg;
    aac;
    constructor(host) {
        this.host = host;
        this.cfg = {
            get signal() {
                return host.signal;
            },
        };
        this.aac = new PipelineAac({
            get signal() {
                return host.signal;
            },
            audioBitrateFor: () => host.audioBitrateFor(),
            targetAudioParams: (rate, channels, codec) => host.targetAudioParams(rate, channels, codec),
            hasDynamicCodecConfiguration: track => host.hasDynamicCodecConfiguration(track),
            sourceAudioShape: track => host.sourceAudioShape(track),
            sourceAudioWindow: (track, rate) => host.sourceAudioWindow(track, rate),
            report: (percent, message) => host.report(percent, message),
            checkAbort: () => host.checkAbort(),
            yield: async () => {
                host.checkAbort();
                await awaitWithAbort(host.yield(), host.signal);
                host.checkAbort();
            },
        });
    }
    audioBitrateFor() {
        return this.host.audioBitrateFor();
    }
    targetAudioParams(sourceRate, sourceChannels, codec) {
        return this.host.targetAudioParams(sourceRate, sourceChannels, codec);
    }
    hasDynamicCodecConfiguration(track) {
        return this.host.hasDynamicCodecConfiguration(track);
    }
    sourceAudioShape(track) {
        return this.host.sourceAudioShape(track);
    }
    sourceAudioWindow(track, rate) {
        return this.host.sourceAudioWindow(track, rate);
    }
    checkAbort() {
        this.host.checkAbort();
    }
    yield() {
        return this.host.yield();
    }
    async pipeAudio(src, source, outCodec, muxer) {
        assertAudioEncodeRequest(outCodec);
        if (src.codec === 'pcm' || src.codec.startsWith('pcm-'))
            return pipePcmTrack(this.host, src, source, outCodec, muxer);
        const lifetime = new CodecLifetime(this.cfg.signal);
        let decoder = null;
        let directEncoder = null;
        let decoderClosed = false;
        let encoderClosed = false;
        let output = null;
        let selfHostedBridge = null;
        let pcmFramesMuxed = 0;
        const closeDecoder = () => {
            if (!decoder || decoderClosed)
                return;
            decoderClosed = true;
            if (decoder.state !== 'closed') {
                try {
                    decoder.close();
                }
                catch { }
            }
        };
        const closeEncoder = () => {
            output?.stop();
            if (!directEncoder || encoderClosed)
                return;
            encoderClosed = true;
            if (directEncoder.state !== 'closed') {
                try {
                    directEncoder.close();
                }
                catch { }
            }
        };
        const stop = () => {
            lifetime.stop();
            closeDecoder();
            closeEncoder();
        };
        try {
            lifetime.check();
            this.checkAbort();
            if (this.hasDynamicCodecConfiguration(src) && (src.codec.startsWith('mp4a') || src.codec === 'aac')) {
                const shape = this.sourceAudioShape(src);
                const target = this.targetAudioParams(shape.rate, shape.channels, outCodec);
                const outputObjectType = mp4aAudioObjectType(outCodec);
                if (await lifetime.waitFor(this.aac.tryPipeConfiguredNative(src, source, outCodec, muxer, target, lifetime)))
                    return;
                if (outputObjectType === 2 && target.channels <= 2) {
                    await lifetime.waitFor(this.aac.pipeConfiguredSelfHosted(src, source, outCodec, muxer, lifetime));
                    return;
                }
                if (outCodec === 'pcm') {
                    await lifetime.waitFor(this.aac.pipeConfiguredPcm(src, source, outCodec, muxer, lifetime));
                    return;
                }
                throw new EncodeError(`No streaming audio encoder can produce '${outCodec}'`);
            }
            if (typeof AudioDecoder === 'undefined') {
                await lifetime.waitFor(this.aac.pipeAudioSelfHosted(src, source, outCodec, muxer, lifetime));
                return;
            }
            const { rate: targetRate, channels: targetCh } = this.targetAudioParams(src.sampleRate, src.channelCount, outCodec);
            const requestedAacObjectType = mp4aAudioObjectType(outCodec);
            const streamingWindow = this.sourceAudioWindow(src, targetRate);
            const maxStreamingAacChunks = requestedAacObjectType === null
                ? Number.POSITIVE_INFINITY
                : Math.ceil((streamingWindow.valid + 1024) / 1024);
            let encoderUsable = typeof AudioEncoder !== 'undefined' && outCodec !== 'pcm';
            if (encoderUsable && typeof AudioEncoder.isConfigSupported === 'function') {
                const probe = await probeAudioSupport(lifetime, () => AudioEncoder.isConfigSupported({
                    codec: outCodec,
                    sampleRate: targetRate,
                    numberOfChannels: targetCh,
                    bitrate: this.audioBitrateFor(),
                }));
                if (probe?.supported === false)
                    encoderUsable = false;
            }
            let encoderSetupError = null;
            let streamingTranscoder = null;
            let selfHostedTransformer = null;
            let pcmTransformer = null;
            if (encoderUsable) {
                lifetime.check();
                output = audioOutput(lifetime, outCodec, muxer, maxStreamingAacChunks);
                try {
                    directEncoder = new AudioEncoder({
                        output: output.output,
                        error: error => {
                            if (!encoderClosed)
                                lifetime.record(nativeAudioFailure(error, 'encode'));
                        },
                    });
                    directEncoder.configure({
                        codec: outCodec,
                        sampleRate: targetRate,
                        numberOfChannels: targetCh,
                        bitrate: this.audioBitrateFor(),
                    });
                }
                catch (error) {
                    lifetime.check();
                    encoderSetupError = nativeAudioFailure(error, 'encode');
                    if (!allowsAudioFallback(encoderSetupError))
                        throw encoderSetupError;
                    closeEncoder();
                    directEncoder = null;
                    logger.warn('[Pipeline] streaming audio encode unavailable:', error);
                }
                lifetime.check();
                if (directEncoder) {
                    if (requestedAacObjectType !== null)
                        muxer.setAudioPriming?.(1024, streamingWindow.valid);
                    streamingTranscoder = new WebCodecsAudioTranscoder(directEncoder, targetRate, targetCh, streamingWindow);
                }
            }
            if (!directEncoder && requestedAacObjectType === 2 && targetCh <= 2) {
                selfHostedBridge = new SelfHostedAacMuxBridge(targetRate, targetCh, Math.round(this.audioBitrateFor() / 1000), muxer, streamingWindow.startOffset, streamingWindow.valid);
                selfHostedTransformer = new StreamingPcmTransformer(src.sampleRate, src.channelCount, targetRate, targetCh, planes => selfHostedBridge.push(planes), streamingWindow);
            }
            if (!directEncoder && !selfHostedTransformer && outCodec === 'pcm') {
                if (!isPcmOutputMuxer(muxer)) {
                    throw new EncodeError('PCM audio output is only supported into AVI in this build');
                }
                pcmTransformer = new StreamingPcmTransformer(src.sampleRate, src.channelCount, targetRate, targetCh, planes => {
                    muxer.addPCMPlanarChunk(planes, targetRate, streamingWindow.startOffset + pcmFramesMuxed / targetRate);
                    pcmFramesMuxed += planes[0]?.length ?? 0;
                }, streamingWindow);
            }
            if (!directEncoder && !selfHostedTransformer && !pcmTransformer) {
                throw new EncodeError(`No streaming audio encoder can produce '${outCodec}'` +
                    (encoderSetupError ? `: ${encoderSetupError.message}` : ''));
            }
            lifetime.check();
            try {
                decoder = new AudioDecoder({
                    output: ad => {
                        const accepting = !decoderClosed && lifetime.acceptingOutput;
                        try {
                            if (!accepting)
                                return;
                            if (directEncoder) {
                                if (directEncoder.state === 'closed')
                                    throw new EncodeError('AudioEncoder closed during decoding');
                                streamingTranscoder.push(ad);
                            }
                            else if (selfHostedTransformer) {
                                selfHostedTransformer.push(copyAudioDataPlanar(ad));
                            }
                            else if (pcmTransformer) {
                                pcmTransformer.push(copyAudioDataPlanar(ad));
                            }
                            else {
                                throw new EncodeError('decoded audio has no bounded output consumer');
                            }
                        }
                        catch (error) {
                            lifetime.record(directEncoder ? nativeAudioFailure(error, 'encode') : error);
                        }
                        finally {
                            try {
                                ad.close();
                            }
                            catch (error) {
                                if (accepting)
                                    lifetime.record(error);
                            }
                        }
                    },
                    error: error => {
                        if (!decoderClosed)
                            lifetime.record(nativeAudioFailure(error, 'decode'));
                    },
                });
            }
            catch (error) {
                throw nativeAudioFailure(error, 'decode');
            }
            const decCfg = {
                codec: webCodecsAudioCodec(src.codec),
                sampleRate: src.sampleRate,
                numberOfChannels: src.channelCount,
            };
            if (src.codecConfig)
                decCfg.description = src.codecConfig;
            if (src.codec.startsWith('mp4a') || src.codec === 'aac') {
                const supported = await probeAudioSupport(lifetime, () => AudioDecoder.isConfigSupported(decCfg));
                if (!supported || supported.supported === false) {
                    throw new DecodeError('AudioDecoder does not support the AAC configuration');
                }
            }
            lifetime.check();
            try {
                decoder.configure(decCfg);
            }
            catch (error) {
                throw nativeAudioFailure(error, 'decode');
            }
            const checkCodecs = () => {
                lifetime.check();
                if (decoder.state === 'closed')
                    throw lifetime.record(new DecodeError(`AudioDecoder closed for '${src.codec}'`));
                if (directEncoder?.state === 'closed')
                    throw lifetime.record(new EncodeError('AudioEncoder closed during conversion'));
            };
            await lifetime.waitFor(this.yield());
            checkCodecs();
            for (let index = 0, count = sampleCount(src); index < count; index++) {
                const sample = sampleAt(src, index);
                checkCodecs();
                while (decoder.decodeQueueSize > 8 || (directEncoder !== null && directEncoder.encodeQueueSize > 8)) {
                    await lifetime.waitFor(this.yield());
                    checkCodecs();
                }
                const sampleData = sample.data ?? (await lifetime.waitFor(source.read(sample.offset, sample.size)));
                checkCodecs();
                try {
                    decoder.decode(new EncodedAudioChunk({
                        type: 'key',
                        timestamp: sample.timestamp * 1e6,
                        duration: sample.duration * 1e6,
                        data: sampleData,
                    }));
                }
                catch (error) {
                    throw nativeAudioFailure(error, 'decode');
                }
                checkCodecs();
            }
            try {
                await lifetime.waitFor(decoder.flush().catch(error => {
                    throw nativeAudioFailure(error, 'decode');
                }));
            }
            catch (error) {
                throw nativeAudioFailure(error, 'decode');
            }
            checkCodecs();
            closeDecoder();
            if (selfHostedBridge && selfHostedTransformer) {
                selfHostedTransformer.flush();
                selfHostedBridge.finish(selfHostedTransformer.framesEmitted);
                lifetime.check();
                if (selfHostedBridge.framesProduced > 0)
                    return;
            }
            if (pcmTransformer) {
                pcmTransformer.flush();
                lifetime.check();
                if (pcmFramesMuxed > 0)
                    return;
            }
            if (directEncoder && streamingTranscoder) {
                try {
                    streamingTranscoder.flush();
                }
                catch (error) {
                    throw nativeAudioFailure(error, 'encode');
                }
                lifetime.check();
                muxer.setValidSamples?.(streamingTranscoder.framesEncoded);
                lifetime.check();
                try {
                    await lifetime.waitFor(directEncoder.flush().catch(error => {
                        throw nativeAudioFailure(error, 'encode');
                    }));
                }
                catch (error) {
                    throw nativeAudioFailure(error, 'encode');
                }
                lifetime.check();
                if (output.chunksMuxed > 0)
                    return;
                throw new EncodeError('streaming AudioEncoder produced no output');
            }
            throw new DecodeError('Audio pipeline produced no decoded frames');
        }
        catch (caught) {
            const error = lifetime.record(caught);
            const selfAacEligible = decoder !== null &&
                (src.codec.startsWith('mp4a') || src.codec === 'aac') &&
                (output?.chunksMuxed ?? 0) === 0 &&
                (selfHostedBridge?.framesProduced ?? 0) === 0 &&
                pcmFramesMuxed === 0;
            if (selfAacEligible && allowsAudioFallback(error) && !this.cfg.signal?.aborted) {
                stop();
                logger.warn('[Pipeline] native audio failed before output, using built-in AAC path:', error);
                await runAudioFallback(this.cfg.signal, fallback => this.aac.pipeAudioSelfHosted(src, source, outCodec, muxer, fallback));
                return;
            }
            throw error;
        }
        finally {
            stop();
        }
    }
    async encodeAudioBuffer(audioBuf, codec, muxer, startOffsetSeconds = 0) {
        assertAudioEncodeRequest(codec);
        const lifetime = new CodecLifetime(this.cfg.signal, new EncodeError('Audio encoding stopped'));
        let encoder = null;
        let encoderClosed = false;
        let output = null;
        let resampled = audioBuf;
        const stop = () => {
            lifetime.stop();
            if (!encoder || encoderClosed)
                return;
            encoderClosed = true;
            if (encoder.state !== 'closed') {
                try {
                    encoder.close();
                }
                catch { }
            }
        };
        try {
            lifetime.check();
            this.checkAbort();
            const params = this.targetAudioParams(audioBuf.sampleRate, audioBuf.numberOfChannels, codec);
            const targetRate = params.rate;
            const targetCh = Math.max(1, Math.min(8, params.channels));
            if (audioBuf.numberOfChannels !== targetCh || audioBuf.sampleRate !== targetRate) {
                resampled = await lifetime.waitFor(renderAudioBuffer(audioBuf, targetRate, targetCh, this.cfg.signal));
            }
            lifetime.check();
            if (codec === 'pcm') {
                if (!isPcmOutputMuxer(muxer))
                    throw new EncodeError('PCM audio output is only supported into AVI in this build');
                muxer.addPCMBuffer(resampled);
                lifetime.check();
                return;
            }
            if (codec.startsWith('mp4a')) {
                muxer.setAudioPriming?.(1024, resampled.length);
                lifetime.check();
                if (typeof AudioEncoder === 'undefined')
                    throw new EncodeError('AudioEncoder is unavailable');
                const probe = await probeAudioSupport(lifetime, () => AudioEncoder.isConfigSupported({
                    codec,
                    sampleRate: resampled.sampleRate,
                    numberOfChannels: resampled.numberOfChannels,
                    bitrate: this.audioBitrateFor(),
                }));
                if (!probe || probe.supported === false)
                    throw new EncodeError('AudioEncoder does not support the AAC configuration');
            }
            const maxAacChunks = codec.startsWith('mp4a')
                ? Math.ceil((resampled.length + 1024) / 1024)
                : Number.POSITIVE_INFINITY;
            output = audioOutput(lifetime, codec, muxer, maxAacChunks, startOffsetSeconds);
            lifetime.check();
            try {
                encoder = new AudioEncoder({
                    output: output.output,
                    error: error => {
                        if (!encoderClosed)
                            lifetime.record(nativeAudioFailure(error, 'encode'));
                    },
                });
                encoder.configure({
                    codec,
                    sampleRate: resampled.sampleRate,
                    numberOfChannels: resampled.numberOfChannels,
                    bitrate: this.audioBitrateFor(),
                });
            }
            catch (error) {
                throw nativeAudioFailure(error, 'encode');
            }
            const checkEncoder = () => {
                lifetime.check();
                if (encoder.state !== 'configured')
                    throw lifetime.record(new EncodeError('AudioEncoder closed during encoding'));
            };
            await lifetime.waitFor(encodeAudioBufferWithEncoder(resampled, 1024, async (audioData) => {
                checkEncoder();
                while (encoder.encodeQueueSize > 8) {
                    await lifetime.waitFor(yieldToEventLoop());
                    checkEncoder();
                }
                try {
                    encoder.encode(audioData);
                }
                catch (error) {
                    throw lifetime.record(nativeAudioFailure(error, 'encode'));
                }
                checkEncoder();
            }).catch(error => {
                throw nativeAudioFailure(error, 'encode');
            }));
            checkEncoder();
            try {
                await lifetime.waitFor(encoder.flush().catch(error => {
                    throw nativeAudioFailure(error, 'encode');
                }));
            }
            catch (error) {
                throw nativeAudioFailure(error, 'encode');
            }
            checkEncoder();
            if (output.chunksMuxed === 0)
                throw new EncodeError('AudioEncoder produced no output');
            muxer.setValidSamples?.(resampled.length);
            lifetime.check();
        }
        catch (caught) {
            const error = lifetime.record(caught);
            if (codec.startsWith('mp4a') &&
                (output?.chunksMuxed ?? 0) === 0 &&
                allowsAudioFallback(error) &&
                !this.cfg.signal?.aborted) {
                stop();
                logger.warn('[Pipeline] native AAC failed before output, using built-in encoder:', error);
                await runAudioFallback(this.cfg.signal, fallback => this.aac.encodeSelfHosted(resampled, muxer, startOffsetSeconds, codec, fallback));
                return;
            }
            throw error;
        }
        finally {
            stop();
        }
    }
}
