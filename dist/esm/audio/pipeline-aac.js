import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { isPcmOutputMuxer } from '../core/pcm-muxer.js';
import { DecodeError, EncodeError, MediaForgeError, rethrowIfAbort } from '../core/errors.js';
import { mp4aAudioObjectType } from '../core/codec-strings.js';
import { assertAudioEncodeRequest } from '../core/format-plans.js';
import { awaitWithAbort } from '../core/abort.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { logger } from '../core/logger.js';
import { StreamingAacLcEncoder } from './aac-encoder.js';
import { buildAacAsc, readAacAudioObjectType } from './adts.js';
import { AacLcDecoder } from './aac-decoder.js';
import { createConfiguredAacTrackPcmSource } from './aac-track-decoder.js';
import { StreamingPcmTransformer } from './streaming-pcm.js';
import { downmixChannels, renderAudioBuffer } from './audio-buffer-tools.js';
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
export class SelfHostedAacMuxBridge {
    sampleRate;
    channels;
    muxer;
    encoder;
    declaredValidSamples;
    sealed = false;
    constructor(sampleRate, channels, bitrateKbps, muxer, startOffsetSeconds, expectedInputFrames) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.muxer = muxer;
        const frameSeconds = 1024 / sampleRate;
        muxer.setAudioCodecConfig?.(buildAacAsc(sampleRate, channels));
        this.declaredValidSamples =
            expectedInputFrames === undefined ? null : Math.max(1, Math.round(expectedInputFrames));
        if (this.declaredValidSamples !== null) {
            muxer.setAudioPriming?.(1024, this.declaredValidSamples);
            muxer.setValidSamples?.(this.declaredValidSamples);
        }
        this.encoder = new StreamingAacLcEncoder(sampleRate, channels, bitrateKbps, {
            expectedInputFrames,
            collectFrames: false,
            onFrame: (frame, index) => muxer.addAudioChunk({
                data: frame,
                timestamp: startOffsetSeconds + index * frameSeconds,
                duration: frameSeconds,
                isKeyframe: true,
                trackType: 'audio',
            }),
        });
    }
    get framesProduced() {
        return this.encoder.framesProduced;
    }
    get peakBufferedFrames() {
        return this.encoder.peakBufferedFrames;
    }
    push(planes) {
        this.encoder.pushPlanar(planes);
    }
    finish(validSamples) {
        if (this.sealed)
            return;
        this.sealed = true;
        this.encoder.finish();
        const actual = Math.max(1, Math.round(validSamples));
        if (this.declaredValidSamples === null) {
            this.muxer.setAudioPriming?.(1024, actual);
            this.muxer.setValidSamples?.(actual);
        }
        else {
            this.muxer.setValidSamples?.(actual);
            if (actual !== this.declaredValidSamples) {
                logger.info(`[Pipeline] corrected estimated AAC length ${this.declaredValidSamples} -> ${actual} samples`);
            }
        }
    }
}
export class PipelineAac {
    host;
    constructor(host) {
        this.host = host;
    }
    async pumpStaticAac(src, source, transformer, label, lifetime, drainOutput, recordFailure) {
        try {
            lifetime?.check();
            const decoder = new AacLcDecoder(transformer.sourceSampleRate, transformer.sourceChannels);
            this.host.report(78, label);
            const count = sampleCount(src);
            for (let index = 0; index < count; index++) {
                lifetime?.check();
                this.host.checkAbort();
                const sample = sampleAt(src, index);
                const data = sample.data ??
                    (await (lifetime
                        ? lifetime.waitFor(Promise.resolve(source.read(sample.offset, sample.size)).catch(error => {
                            throw recordFailure?.(error) ?? error;
                        }))
                        : awaitWithAbort(source.read(sample.offset, sample.size), this.host.signal)));
                lifetime?.check();
                this.host.checkAbort();
                transformer.push(decoder.decodeFrame(data));
                if (drainOutput)
                    await drainOutput();
                lifetime?.check();
                this.host.report(78 + Math.round(((index + 1) / Math.max(count, 1)) * 20), `Streaming audio ${index + 1}/${count}`);
                if ((index & 15) === 15) {
                    if (lifetime)
                        await lifetime.waitFor(this.host.yield());
                    else
                        await this.host.yield();
                }
            }
            lifetime?.check();
            this.host.checkAbort();
            transformer.flush();
            if (drainOutput)
                await drainOutput();
            lifetime?.check();
        }
        catch (error) {
            throw recordFailure?.(error) ?? lifetime?.record(error) ?? error;
        }
    }
    async tryNativeEncode(outCodec, muxer, target, startOffset, expectedFrames, pump, parentLifetime) {
        const lifetime = new CodecLifetime(this.host.signal, new EncodeError('AAC native encoder stopped'));
        let encoder = null;
        let stopped = false;
        let chunksMuxed = 0;
        let fallbackFailure = null;
        let codecConfig;
        const requestedObjectType = mp4aAudioObjectType(outCodec);
        const allowsFallback = (error) => chunksMuxed === 0 &&
            error === fallbackFailure &&
            error instanceof MediaForgeError &&
            (error.code === 'ENCODE' || error.code === 'DECODE');
        const recordFailure = (caught) => {
            const error = lifetime.record(caught);
            if (!stopped && !allowsFallback(error))
                parentLifetime?.record(error);
            return error;
        };
        const recordNative = (caught) => {
            const accepting = lifetime.acceptingOutput;
            const error = caught instanceof MediaForgeError || (caught instanceof DOMException && caught.name === 'AbortError')
                ? caught
                : new EncodeError(caught instanceof Error ? caught.message : String(caught));
            const first = lifetime.record(error);
            if (accepting && first === error)
                fallbackFailure = error;
            return recordFailure(first);
        };
        try {
            lifetime.check();
            this.host.checkAbort();
            if (typeof AudioEncoder === 'undefined' || outCodec === 'pcm')
                return false;
            const config = {
                codec: outCodec,
                sampleRate: target.rate,
                numberOfChannels: target.channels,
                bitrate: this.host.audioBitrateFor(),
            };
            if (typeof AudioEncoder.isConfigSupported === 'function') {
                const probe = await lifetime.waitFor(Promise.resolve()
                    .then(() => {
                    lifetime.check();
                    return AudioEncoder.isConfigSupported(config);
                })
                    .then(value => ({ value, error: null }), error => {
                    if (error instanceof MediaForgeError &&
                        error.code !== 'ENCODE' &&
                        error.code !== 'DECODE') {
                        throw recordFailure(error);
                    }
                    rethrowIfAbort(error);
                    return { value: null, error };
                }));
                if (probe.error) {
                    rethrowIfAbort(probe.error);
                    if (probe.error instanceof MediaForgeError &&
                        probe.error.code !== 'ENCODE' &&
                        probe.error.code !== 'DECODE')
                        throw probe.error;
                }
                if (probe.value?.supported === false)
                    return false;
            }
            lifetime.check();
            try {
                encoder = new AudioEncoder({
                    output: (chunk, metadata) => {
                        if (!lifetime.acceptingOutput)
                            return;
                        try {
                            const nextConfig = copyCodecDescription(metadata?.decoderConfig?.description);
                            if (nextConfig && !codecConfig) {
                                const actualObjectType = readAacAudioObjectType(nextConfig);
                                if (requestedObjectType !== null && actualObjectType !== requestedObjectType) {
                                    throw recordNative(new EncodeError(`AudioEncoder returned AAC object type ${actualObjectType ?? 'unknown'} for requested '${outCodec}'`));
                                }
                                codecConfig = nextConfig;
                            }
                            if (requestedObjectType !== null && requestedObjectType !== 2 && !codecConfig) {
                                throw recordNative(new EncodeError(`AudioEncoder did not provide a verifiable AudioSpecificConfig for requested '${outCodec}'`));
                            }
                            const data = new Uint8Array(chunk.byteLength);
                            chunk.copyTo(data);
                            lifetime.check();
                            muxer.addAudioChunk({
                                data,
                                timestamp: chunk.timestamp / 1e6,
                                duration: (chunk.duration ?? 0) / 1e6,
                                isKeyframe: true,
                                trackType: 'audio',
                            }, codecConfig);
                            chunksMuxed++;
                        }
                        catch (error) {
                            recordFailure(error);
                        }
                    },
                    error: recordNative,
                });
                lifetime.check();
                encoder.configure(config);
                lifetime.check();
            }
            catch (error) {
                throw recordNative(error);
            }
            if (requestedObjectType !== null) {
                muxer.setAudioPriming?.(1024, expectedFrames);
                lifetime.check();
                muxer.setValidSamples?.(expectedFrames);
                lifetime.check();
            }
            let inputFrames = 0;
            const consume = async (planes) => {
                lifetime.check();
                while (encoder.encodeQueueSize > 5) {
                    if (encoder.state === 'closed')
                        throw recordNative(new EncodeError('AAC native encoder closed'));
                    await lifetime.waitFor(this.host.yield());
                }
                lifetime.check();
                const frames = planes[0]?.length ?? 0;
                if (frames === 0)
                    return;
                const planar = new Float32Array(frames * target.channels);
                for (let channel = 0; channel < target.channels; channel++) {
                    planar.set(planes[channel], channel * frames);
                }
                let audioData = null;
                try {
                    audioData = new AudioData({
                        format: 'f32-planar',
                        sampleRate: target.rate,
                        numberOfFrames: frames,
                        numberOfChannels: target.channels,
                        timestamp: Math.round((startOffset + inputFrames / target.rate) * 1e6),
                        data: planar,
                    });
                    lifetime.check();
                    encoder.encode(audioData);
                    lifetime.check();
                }
                catch (error) {
                    throw recordNative(error);
                }
                finally {
                    if (audioData) {
                        try {
                            audioData.close();
                        }
                        catch { }
                    }
                }
                inputFrames += frames;
            };
            const frames = await lifetime.waitFor(pump(consume, lifetime, recordFailure));
            lifetime.check();
            try {
                await lifetime.waitFor(encoder.flush().catch(error => {
                    throw recordNative(error);
                }));
            }
            catch (error) {
                throw recordNative(error);
            }
            lifetime.check();
            if (chunksMuxed === 0)
                return false;
            muxer.setValidSamples?.(frames);
            lifetime.check();
            logger.info(`[Pipeline] bounded AAC->WebCodecs bridge: ${frames} PCM frames`);
            return true;
        }
        catch (caught) {
            const error = recordFailure(caught);
            if (allowsFallback(error))
                return false;
            throw error;
        }
        finally {
            stopped = true;
            lifetime.stop();
            if (encoder && encoder.state !== 'closed') {
                try {
                    encoder.close();
                }
                catch { }
            }
        }
    }
    async tryPipeStaticNative(src, source, outCodec, muxer, sourceRate, sourceChannels, parentLifetime) {
        this.host.checkAbort();
        const target = this.host.targetAudioParams(sourceRate, sourceChannels, outCodec);
        const window = this.host.sourceAudioWindow(src, target.rate);
        return this.tryNativeEncode(outCodec, muxer, target, window.startOffset, window.valid, async (consume, lifetime, recordFailure) => {
            const pending = [];
            const transformer = new StreamingPcmTransformer(sourceRate, sourceChannels, target.rate, target.channels, planes => pending.push(planes), window);
            await this.pumpStaticAac(src, source, transformer, 'Streaming audio (built-in AAC decode)...', lifetime, async () => {
                for (const planes of pending)
                    await consume(planes);
                pending.length = 0;
            }, recordFailure);
            return transformer.framesEmitted;
        }, parentLifetime);
    }
    async pumpConfiguredAac(src, source, target, consume, lifetime, recordFailure = error => lifetime.record(error)) {
        try {
            lifetime.check();
            const pcm = createConfiguredAacTrackPcmSource(src, async (sample) => {
                try {
                    lifetime.check();
                    return (sample.data ??
                        (await lifetime.waitFor(Promise.resolve(source.read(sample.offset, sample.size)).catch(error => {
                            throw recordFailure(error);
                        }))));
                }
                catch (error) {
                    throw recordFailure(error);
                }
            }, {
                targetSampleRate: target.rate,
                targetChannels: target.channels,
                signal: this.host.signal,
                onProgress: (done, total) => {
                    try {
                        lifetime.check();
                        this.host.report(78 + Math.round((done / Math.max(total, 1)) * 20), `Streaming audio ${done}/${total}`);
                        lifetime.check();
                    }
                    catch (error) {
                        throw recordFailure(error);
                    }
                },
            });
            let frames = 0;
            for await (const planes of pcm.chunks(this.host.signal)) {
                lifetime.check();
                const count = planes[0]?.length ?? 0;
                const mapped = planes.length === target.channels
                    ? planes
                    : downmixChannels(Array.from(planes), planes.length, target.channels, count);
                try {
                    await lifetime.waitFor(Promise.resolve(consume(mapped)).catch(error => {
                        throw recordFailure(error);
                    }));
                }
                catch (error) {
                    throw recordFailure(error);
                }
                lifetime.check();
                frames += count;
            }
            lifetime.check();
            return frames;
        }
        catch (error) {
            throw recordFailure(error);
        }
    }
    async tryPipeConfiguredNative(src, source, outCodec, muxer, target, parentLifetime) {
        this.host.checkAbort();
        const expectedFrames = Math.max(1, Math.round(Math.max(0, src.duration) * target.rate));
        return this.tryNativeEncode(outCodec, muxer, target, Math.max(0, sampleAt(src, 0)?.timestamp ?? 0), expectedFrames, (consume, lifetime, recordFailure) => this.pumpConfiguredAac(src, source, target, consume, lifetime, recordFailure), parentLifetime);
    }
    async pipeConfiguredSelfHosted(src, source, outCodec, muxer, lifetime) {
        const active = lifetime ?? new CodecLifetime(this.host.signal);
        try {
            active.check();
            const objectType = mp4aAudioObjectType(outCodec);
            if (objectType !== 2) {
                throw new EncodeError(`Built-in AAC encoder supports AAC-LC (mp4a.40.2) only; requested '${outCodec}'`);
            }
            const shape = this.host.sourceAudioShape(src);
            const target = this.host.targetAudioParams(shape.rate, shape.channels, outCodec);
            if (target.channels > 2) {
                throw new EncodeError('Built-in AAC encoder supports at most two output channels');
            }
            const expectedFrames = Math.max(1, Math.round(Math.max(0, src.duration) * target.rate));
            const bridge = new SelfHostedAacMuxBridge(target.rate, target.channels, Math.round(this.host.audioBitrateFor() / 1000), muxer, Math.max(0, sampleAt(src, 0)?.timestamp ?? 0), expectedFrames);
            this.host.report(78, 'Streaming AAC configuration epochs...');
            const frames = await this.pumpConfiguredAac(src, source, target, planes => bridge.push(planes), active);
            active.check();
            bridge.finish(frames);
            active.check();
            logger.info(`[Pipeline] bounded dynamic AAC bridge: ${frames} frames, ` +
                `peak encoder queue ${bridge.peakBufferedFrames} frames`);
        }
        catch (error) {
            throw active.record(error);
        }
        finally {
            if (!lifetime)
                active.stop();
        }
    }
    async pipeConfiguredPcm(src, source, outCodec, muxer, lifetime) {
        const active = lifetime ?? new CodecLifetime(this.host.signal);
        try {
            active.check();
            if (outCodec !== 'pcm' || !isPcmOutputMuxer(muxer)) {
                throw new EncodeError('PCM audio output is only supported into AVI in this build');
            }
            const shape = this.host.sourceAudioShape(src);
            const target = this.host.targetAudioParams(shape.rate, shape.channels, outCodec);
            let framesMuxed = 0;
            const startOffset = Math.max(0, sampleAt(src, 0)?.timestamp ?? 0);
            const frames = await this.pumpConfiguredAac(src, source, target, planes => {
                muxer.addPCMPlanarChunk(planes, target.rate, startOffset + framesMuxed / target.rate);
                framesMuxed += planes[0]?.length ?? 0;
            }, active);
            active.check();
            if (framesMuxed !== frames) {
                throw new EncodeError(`AVI PCM bridge wrote ${framesMuxed}/${frames} frames`);
            }
            logger.info(`[Pipeline] bounded dynamic AAC->AVI PCM bridge: ${framesMuxed} frames`);
        }
        catch (error) {
            throw active.record(error);
        }
        finally {
            if (!lifetime)
                active.stop();
        }
    }
    async pipeAudioSelfHosted(src, source, outCodec, muxer, lifetime) {
        try {
            assertAudioEncodeRequest(outCodec);
            if (this.host.hasDynamicCodecConfiguration(src)) {
                if (mp4aAudioObjectType(outCodec) === 2) {
                    await this.pipeConfiguredSelfHosted(src, source, outCodec, muxer, lifetime);
                    return;
                }
                if (outCodec === 'pcm') {
                    await this.pipeConfiguredPcm(src, source, outCodec, muxer, lifetime);
                    return;
                }
                throw new EncodeError(`No streaming audio encoder can produce '${outCodec}'`);
            }
            const sourceObjectType = mp4aAudioObjectType(src.codec);
            if (sourceObjectType !== null && sourceObjectType !== 2) {
                throw new DecodeError(`Built-in AAC decoder supports AAC-LC (mp4a.40.2) only; source is '${src.codec}'`);
            }
            const channels = Math.max(1, Math.min(2, src.channelCount || 2));
            const sampleRate = src.sampleRate || 44100;
            if (mp4aAudioObjectType(outCodec) === 2) {
                const target = this.host.targetAudioParams(sampleRate, channels, outCodec);
                if (target.channels > 2) {
                    throw new EncodeError('Built-in AAC encoder supports at most two output channels');
                }
                const win = this.host.sourceAudioWindow(src, target.rate);
                const bridge = new SelfHostedAacMuxBridge(target.rate, target.channels, Math.round(this.host.audioBitrateFor() / 1000), muxer, win.startOffset, win.valid);
                const transformer = new StreamingPcmTransformer(sampleRate, channels, target.rate, target.channels, planes => bridge.push(planes), win);
                await this.pumpStaticAac(src, source, transformer, 'Streaming audio (built-in AAC)...', lifetime);
                bridge.finish(transformer.framesEmitted);
                logger.info(`[Pipeline] bounded AAC decode/encode bridge: ${transformer.framesEmitted} frames, ` +
                    `peak transform ${transformer.peakWorkFrames}, encoder ${bridge.peakBufferedFrames}`);
                return;
            }
            if (outCodec === 'pcm') {
                if (!isPcmOutputMuxer(muxer)) {
                    throw new EncodeError('PCM audio output is only supported into AVI in this build');
                }
                const target = this.host.targetAudioParams(sampleRate, channels, outCodec);
                const window = this.host.sourceAudioWindow(src, target.rate);
                let framesMuxed = 0;
                const transformer = new StreamingPcmTransformer(sampleRate, channels, target.rate, target.channels, planes => {
                    muxer.addPCMPlanarChunk(planes, target.rate, window.startOffset + framesMuxed / target.rate);
                    framesMuxed += planes[0]?.length ?? 0;
                }, window);
                await this.pumpStaticAac(src, source, transformer, 'Streaming audio to AVI PCM...', lifetime);
                logger.info(`[Pipeline] bounded built-in AAC->AVI PCM bridge: ${framesMuxed} frames`);
                return;
            }
            if (await this.tryPipeStaticNative(src, source, outCodec, muxer, sampleRate, channels, lifetime))
                return;
            throw new EncodeError(`No streaming audio encoder can produce '${outCodec}'`);
        }
        catch (error) {
            throw lifetime?.record(error) ?? error;
        }
    }
    async encodeSelfHosted(resampled, muxer, startOffsetSeconds = 0, requestedCodec = 'mp4a.40.2', lifetime) {
        try {
            const requestedObjectType = mp4aAudioObjectType(requestedCodec);
            if (requestedObjectType !== null && requestedObjectType !== 2) {
                throw new EncodeError(`Built-in AAC encoder supports AAC-LC (mp4a.40.2) only; requested '${requestedCodec}'`);
            }
            const sampleRate = resampled.sampleRate;
            const channels = Math.min(2, resampled.numberOfChannels);
            const source = channels === resampled.numberOfChannels
                ? resampled
                : await renderAudioBuffer(resampled, sampleRate, channels, this.host.signal);
            const bridge = new SelfHostedAacMuxBridge(sampleRate, channels, Math.round(this.host.audioBitrateFor() / 1000), muxer, startOffsetSeconds, source.length);
            for (let start = 0; start < source.length; start += 16384) {
                this.host.checkAbort();
                const end = Math.min(source.length, start + 16384);
                const planes = [];
                for (let channel = 0; channel < channels; channel++) {
                    planes.push(source.getChannelData(channel).subarray(start, end));
                }
                bridge.push(planes);
                await this.host.yield();
            }
            bridge.finish(source.length);
        }
        catch (error) {
            throw lifetime?.record(error) ?? error;
        }
    }
}
