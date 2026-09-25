import { ConversionContext } from '../conversion/context.js';
import { mediaFileState } from '../engine/file-state.js';
import { sampleAt } from '../demux/sample-index.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { MediaForgeError } from '../core/errors.js';
import { linkAbortSignals } from '../core/abort.js';
import { matroskaOutputMetadata } from '../core/track-metadata.js';
import { drainSink } from '../io/sink-backpressure.js';
import { createNativeVideoTransform } from './transcode-core.js';
import { freshDiagnostics, forwardDiagnostics } from './transcode-plan.js';
import { providerVideoPlan } from './video-plan.js';
import { NativeVideoDecoderBridge, NativeVideoEncoderBridge } from './video-native.js';
import { snapshotTransform } from './modules.js';
function snapshotCodecs(values) {
    if (!Array.isArray(values))
        throw new MediaForgeError('Expected video codec provider instances', 'INPUT');
    const ids = new Set();
    return Object.freeze(values.map(value => {
        const { id, supportsDecode, supportsEncode, createDecoder, createEncoder } = value ?? {};
        if (!value ||
            typeof id !== 'string' ||
            !id.trim() ||
            ids.has(id) ||
            [supportsDecode, supportsEncode, createDecoder, createEncoder].some(method => typeof method !== 'function'))
            throw new MediaForgeError('Video codec providers require unique IDs and decode/encode factories', 'INPUT');
        ids.add(id);
        const support = (check) => {
            const known = new Map();
            return codec => {
                if (!known.has(codec)) {
                    const result = check.call(value, codec);
                    if (typeof result !== 'boolean')
                        throw new MediaForgeError('Video codec support checks must return a boolean', 'INPUT');
                    known.set(codec, result);
                }
                return known.get(codec);
            };
        };
        return Object.freeze({
            id,
            supportsDecode: support(supportsDecode),
            supportsEncode: support(supportsEncode),
            createDecoder: createDecoder.bind(value),
            createEncoder: createEncoder.bind(value),
        });
    }));
}
function videoFailure(error, code) {
    if (error instanceof MediaForgeError)
        return error;
    if (error instanceof DOMException && error.name === 'AbortError')
        return new MediaForgeError('Aborted', 'ABORT');
    return new MediaForgeError(`Video provider ${code === 'DECODE' ? 'decode' : 'encode'} failed: ${error instanceof Error ? error.message : String(error)}`, code);
}
export function createVideoTransform(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('Expected video transform options', 'INPUT');
    const context = new ConversionContext({ formats: options.formats });
    const codecs = snapshotCodecs(options.codecs);
    const fallback = snapshotTransform(options.fallback ?? createNativeVideoTransform({ formats: context.options.formats }));
    if (!fallback || typeof fallback.probe !== 'function' || typeof fallback.write !== 'function')
        throw new MediaForgeError('Expected a Workflow video fallback transform', 'INPUT');
    return Object.freeze({
        probe(file, request, diagnostics) {
            const plan = providerVideoPlan(file, request, codecs, diagnostics);
            if (!plan)
                return fallback.probe(file, request, diagnostics);
            if (!context.writers.container.has(request.format))
                throw new MediaForgeError(`No provider conversion writer registered for '${request.format}'`, 'FORMAT');
            return {
                supported: true,
                operation: 'convert',
                outputFormat: request.format,
                warnings: diagnostics.warnings,
            };
        },
        async write(file, sink, request, diagnostics) {
            const local = freshDiagnostics(diagnostics);
            const plan = providerVideoPlan(file, request, codecs, local);
            if (!plan)
                return fallback.write(file, sink, request, diagnostics);
            forwardDiagnostics(local, diagnostics);
            const create = context.writers.container.get(request.format);
            if (!create)
                throw new MediaForgeError(`No provider conversion writer registered for '${request.format}'`, 'FORMAT');
            const state = mediaFileState(file);
            const linked = linkAbortSignals(state.signal, request.signal, sink.signal);
            const lifetime = new CodecLifetime(linked.signal);
            const frames = new Set();
            const resources = new Set();
            const closedResources = new WeakSet();
            let decoder;
            let encoder;
            let configuration = -1;
            let active = true;
            const stopCodec = (codec) => {
                if (!codec || closedResources.has(codec))
                    return Promise.resolve();
                closedResources.add(codec);
                resources.delete(codec);
                try {
                    return Promise.resolve(codec.close());
                }
                catch (error) {
                    return Promise.reject(error);
                }
            };
            const acquire = (pending) => lifetime.waitFor(Promise.resolve(pending).then(codec => {
                if (!codec || typeof codec.close !== 'function')
                    throw new MediaForgeError('Video codec factory returned an invalid resource', 'FORMAT');
                resources.add(codec);
                if (!active || !lifetime.acceptingOutput) {
                    void stopCodec(codec).catch(() => undefined);
                    lifetime.check();
                }
                return codec;
            }));
            const call = async (kind, operation) => {
                lifetime.check();
                try {
                    return await lifetime.waitFor(Promise.resolve().then(operation));
                }
                catch (error) {
                    throw videoFailure(error, kind);
                }
            };
            try {
                lifetime.check();
                const target = plan.config.video;
                const encoderConfig = {
                    codec: target.codec,
                    width: target.width,
                    height: target.height,
                    signal: linked.signal,
                    maxPixels: 8192 * 8192,
                    bitrate: request.videoBitrate || undefined,
                    framerate: target.framerate,
                };
                if (plan.encode)
                    encoder = await call('ENCODE', () => acquire(Promise.resolve(plan.encode.createEncoder(encoderConfig))));
                else {
                    encoder = new NativeVideoEncoderBridge(lifetime);
                    resources.add(encoder);
                    await call('ENCODE', () => encoder.configure(encoderConfig));
                }
                const muxer = create(plan.config, sink, { deferCodecConfig: true });
                const copiedAudio = plan.tracks.filter(track => track.type === 'audio');
                const subtitles = plan.tracks.filter(track => track.type === 'subtitle');
                if (copiedAudio.length > 1 && !muxer.addExtraAudioChunk)
                    throw new MediaForgeError('Selected writer cannot preserve extra audio tracks', 'FORMAT');
                if (subtitles.length && !muxer.addSubtitleChunk)
                    throw new MediaForgeError('Selected writer cannot preserve subtitle tracks', 'FORMAT');
                if ((request.format === 'mkv' || request.format === 'webm') && state.matroskaPassThrough)
                    muxer.setMatroskaPassThrough?.(matroskaOutputMetadata(state.matroskaPassThrough, request.format, plan.tracks.map(track => track.info)));
                const primaryAudio = plan.config.audio;
                if (primaryAudio?.validSamples !== undefined)
                    muxer.setAudioPriming?.(primaryAudio.primingSamples ?? 0, primaryAudio.validSamples, primaryAudio.presentationTimestamps, primaryAudio.discardLeadingSamples, primaryAudio.codecDelaySamples);
                const emit = async (packet) => {
                    lifetime.check();
                    if (!(packet?.data instanceof Uint8Array) ||
                        packet.trackType !== 'video' ||
                        !Number.isFinite(packet.timestamp) ||
                        !Number.isFinite(packet.duration) ||
                        packet.duration < 0)
                        throw new MediaForgeError('Video encoder returned an invalid packet', 'ENCODE');
                    muxer.addVideoChunk(packet, packet.codecConfig);
                    await lifetime.waitFor(drainSink(sink, linked.signal));
                };
                const consume = async (rgba) => {
                    lifetime.check();
                    if (rgba.width !== target.width ||
                        rgba.height !== target.height ||
                        !(rgba.data instanceof Uint8Array || rgba.data instanceof Uint8ClampedArray) ||
                        rgba.data.length !== target.width * target.height * 4)
                        throw new MediaForgeError('Decoded RGBA frame does not match the configured dimensions', 'DECODE');
                    if (!/^ap4[hx]$/.test(target.codec)) {
                        for (let at = 3; at < rgba.data.length; at += 4)
                            if (rgba.data[at] !== 255)
                                throw new MediaForgeError('This video encoder cannot preserve alpha; select an alpha-capable ProRes profile', 'FORMAT');
                    }
                    const packets = await call('ENCODE', () => encoder.encode(rgba));
                    for (const packet of Array.isArray(packets) ? packets : [packets])
                        await emit(packet);
                };
                let reportedColourAssumption = false;
                const consumeProviderFrame = async (frame, packet) => {
                    try {
                        lifetime.check();
                        if (!Number.isSafeInteger(frame.bitDepth) || frame.bitDepth <= 0 || frame.bitDepth > 32)
                            throw new MediaForgeError('Provider decoder must declare its frame bit depth', 'DECODE');
                        if (frame.scanType && frame.scanType !== 'progressive')
                            throw new MediaForgeError('Provider conversion does not deinterlace video', 'FORMAT');
                        if ((frame.bitDepth > 8 || (frame.alphaBitDepth ?? 0) > 8) &&
                            request.allowPrecisionLoss !== true)
                            throw new MediaForgeError('High-depth video requires allowPrecisionLoss for RGBA8 conversion', 'FORMAT');
                        if ((frame.colorPrimaries !== undefined && ![0, 1, 2].includes(frame.colorPrimaries)) ||
                            (frame.colorTransfer !== undefined && ![0, 1, 2, 6].includes(frame.colorTransfer)))
                            throw new MediaForgeError('Provider conversion requires BT.709 SDR colour; HDR conversion is unsupported', 'FORMAT');
                        if (frame.timestamp !== packet.timestamp || frame.duration !== packet.duration)
                            throw new MediaForgeError('Provider decoder must preserve packet timing in seconds', 'DECODE');
                        if (frame.colorSpaceAssumed && !reportedColourAssumption) {
                            reportedColourAssumption = true;
                            diagnostics.warn({
                                code: 'VIDEO_COLOUR_ASSUMED',
                                trackId: plan.video.description.id,
                                format: request.format,
                                message: 'Video provider interpreted unspecified source colour as BT.709 SDR',
                            });
                        }
                        const rgba = await call('DECODE', () => frame.toRGBA({ allowPrecisionLoss: request.allowPrecisionLoss, signal: linked.signal }));
                        await consume({
                            ...rgba,
                            format: 'RGBA',
                            bitDepth: 8,
                            timestamp: frame.timestamp,
                            duration: frame.duration,
                            scanType: 'progressive',
                            colorPrimaries: 1,
                            colorTransfer: 1,
                            premultipliedAlpha: false,
                        });
                    }
                    finally {
                        frames.delete(frame);
                        frame.close();
                    }
                };
                let done = 0;
                const total = plan.tracks.reduce((value, track) => value + track.description.sampleCount, 0);
                for await (const packet of file.packets({
                    trackIds: plan.tracks.map(track => track.description.id),
                    signal: linked.signal,
                })) {
                    lifetime.check();
                    if (packet.trackId === plan.video.description.id) {
                        const sample = sampleAt(plan.video.info, packet.sampleIndex);
                        const next = sample.codecConfigIndex ?? 0;
                        if (next !== configuration) {
                            if (decoder) {
                                await call('DECODE', () => decoder.flush?.());
                                await lifetime.waitFor(stopCodec(decoder));
                                decoder = undefined;
                            }
                            const config = plan.video.info.codecConfigurations?.[next] ?? plan.video.info;
                            const input = {
                                codec: config.codec,
                                width: config.width ?? plan.video.info.width,
                                height: config.height ?? plan.video.info.height,
                                description: config.codecConfig?.slice(),
                                signal: linked.signal,
                                maxPixels: 8192 * 8192,
                            };
                            if (plan.decode)
                                decoder = await call('DECODE', () => acquire(Promise.resolve(plan.decode.createDecoder(input))));
                            else {
                                decoder = new NativeVideoDecoderBridge(lifetime, consume, request.allowPrecisionLoss === true);
                                resources.add(decoder);
                                await call('DECODE', () => decoder.configure(input));
                            }
                            configuration = next;
                        }
                        if (decoder instanceof NativeVideoDecoderBridge)
                            await call('DECODE', () => decoder.decode(packet));
                        else {
                            const frame = await call('DECODE', () => Promise.resolve(decoder.decode(packet)).then(frame => {
                                if (!frame ||
                                    typeof frame.close !== 'function' ||
                                    typeof frame.toRGBA !== 'function')
                                    throw new MediaForgeError('Provider decoder returned an invalid frame', 'DECODE');
                                if (!active || !lifetime.acceptingOutput) {
                                    frame.close();
                                    lifetime.check();
                                }
                                frames.add(frame);
                                return frame;
                            }));
                            await consumeProviderFrame(frame, packet);
                        }
                    }
                    else {
                        const audio = copiedAudio.findIndex(track => track.description.id === packet.trackId);
                        if (audio === 0)
                            muxer.addAudioChunk(packet, packet.codecConfig);
                        else if (audio > 0)
                            muxer.addExtraAudioChunk(audio - 1, packet, packet.codecConfig);
                        else
                            muxer.addSubtitleChunk(packet, subtitles.findIndex(track => track.description.id === packet.trackId));
                        await lifetime.waitFor(drainSink(sink, linked.signal));
                    }
                    request.onProgress?.({
                        fraction: ++done / total,
                        message: 'Converting video with supplied codecs',
                        packets: done,
                    });
                }
                if (decoder)
                    await call('DECODE', () => decoder.flush?.());
                if (encoder instanceof NativeVideoEncoderBridge) {
                    const packets = await call('ENCODE', () => encoder.flush());
                    for (const packet of packets)
                        await emit(packet);
                }
                else if (encoder)
                    await call('ENCODE', () => encoder.flush?.());
                lifetime.check();
                await lifetime.waitFor(muxer.finalize());
            }
            finally {
                active = false;
                lifetime.stop();
                for (const frame of frames) {
                    try {
                        frame.close();
                    }
                    catch { }
                }
                frames.clear();
                const closing = Promise.allSettled([...resources].map(stopCodec));
                if (!linked.signal.aborted) {
                    for (const result of await closing) {
                        if (result.status !== 'rejected')
                            continue;
                        try {
                            diagnostics.warn({
                                code: 'CODEC_CLOSE_FAILED',
                                format: request.format,
                                message: `Video codec cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
                            });
                        }
                        catch {
                        }
                    }
                }
                linked.dispose();
            }
        },
    });
}
