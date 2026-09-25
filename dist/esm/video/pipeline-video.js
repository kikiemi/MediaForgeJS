import { CodecLifetime } from '../core/codec-lifetime.js';
import { DecodeError, EncodeError, MediaForgeError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { sampleAt, sampleCount } from '../demux/sample-index.js';
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
function avcFormatFor(format) {
    return ['mp4', 'mov', '3gp', 'm4v', 'flv'].includes(format) ? 'avc' : 'annexb';
}
export class PipelineVideo {
    host;
    constructor(host) {
        this.host = host;
    }
    async pipeVideo(sourceTrack, source, outputCodec, format, muxer, requestedFps) {
        let codecConfig;
        let decoded = 0;
        let encoded = 0;
        const count = sampleCount(sourceTrack);
        const pipelineError = (caught) => caught instanceof MediaForgeError || (caught instanceof DOMException && caught.name === 'AbortError')
            ? caught
            : new EncodeError(`Video pipeline failed: ${caught instanceof Error ? caught.message : String(caught)}`);
        const lifetime = new CodecLifetime(this.host.signal, new EncodeError('Video pipeline stopped'));
        const recordError = (caught) => {
            lifetime.record(pipelineError(caught));
        };
        const waitFor = (pending) => lifetime.waitFor(pending);
        const checkError = () => {
            lifetime.check();
            this.host.checkAbort();
        };
        let ownedEncoder = null;
        let decoder = null;
        let heldFrame = null;
        const frameQueue = new Map();
        let frameIndex = 0;
        let nextFrameIndex = 0;
        let drainTask = null;
        try {
            checkError();
            const encoder = new VideoEncoder({
                output: (chunk, metadata) => {
                    if (!lifetime.acceptingOutput)
                        return;
                    try {
                        encoded++;
                        if (metadata?.decoderConfig?.description && !codecConfig) {
                            codecConfig = copyCodecDescription(metadata.decoderConfig.description);
                        }
                        const data = new Uint8Array(chunk.byteLength);
                        chunk.copyTo(data);
                        muxer.addVideoChunk({
                            data,
                            timestamp: chunk.timestamp / 1e6,
                            duration: (chunk.duration ?? 0) / 1e6,
                            isKeyframe: chunk.type === 'key',
                            trackType: 'video',
                        }, codecConfig);
                    }
                    catch (caught) {
                        recordError(caught);
                    }
                },
                error: (caught) => {
                    recordError(caught);
                    logger.warn('[Pipeline] VideoEncoder error:', caught);
                },
            });
            ownedEncoder = encoder;
            const checkReady = () => {
                checkError();
                if (encoder.state === 'closed' || decoder?.state === 'closed') {
                    throw new EncodeError('Video codec closed before pipeline completion');
                }
            };
            const { w: encodedWidth, h: encodedHeight } = this.host.targetVideoDimensions(sourceTrack.width, sourceTrack.height);
            try {
                encoder.configure({
                    codec: outputCodec,
                    width: encodedWidth,
                    height: encodedHeight,
                    bitrate: this.host.videoBitrateFor(),
                    framerate: this.host.encoderFps(Array.from({ length: Math.min(121, count) }, (_, index) => sampleAt(sourceTrack, index))),
                    ...(outputCodec.startsWith('avc') ? { avc: { format: avcFormatFor(format) } } : {}),
                });
            }
            catch (caught) {
                throw new EncodeError(`VideoEncoder configure failed for '${outputCodec}': ${caught}`);
            }
            await waitFor(this.host.yield());
            const decoderConfig = {
                codec: sourceTrack.codec,
                codedWidth: sourceTrack.width,
                codedHeight: sourceTrack.height,
            };
            if (sourceTrack.codecConfig)
                decoderConfig.description = sourceTrack.codecConfig;
            logger.warn(`[Pipeline] pipeVideo: codec=${sourceTrack.codec}, ${sourceTrack.width}x${sourceTrack.height}, ` +
                `samples=${count}, hasConfig=${!!sourceTrack.codecConfig}`);
            const frameStep = requestedFps > 0 ? 1 / requestedFps : 0;
            const stepUs = frameStep * 1e6;
            let nextEmitTime = Number.NEGATIVE_INFINITY;
            let kept = 0;
            let scaleCanvas = null;
            let scaleContext = null;
            let emissionsSinceYield = 0;
            const waitToEncode = async () => {
                checkReady();
                while (encoder.encodeQueueSize > 5) {
                    await waitFor(this.host.yield());
                    checkReady();
                }
                if (++emissionsSinceYield >= 64) {
                    emissionsSinceYield = 0;
                    await waitFor(this.host.yield());
                    checkReady();
                }
            };
            const emitFrame = (frame, timestampUs, durationUs) => {
                checkReady();
                kept++;
                const needsScale = frame.displayWidth !== encodedWidth || frame.displayHeight !== encodedHeight;
                const needsRestamp = timestampUs !== frame.timestamp || durationUs !== (frame.duration ?? undefined);
                if (!needsScale && !needsRestamp) {
                    encoder.encode(frame, { keyFrame: kept % 60 === 1 });
                    return;
                }
                let frameToEncode;
                if (needsScale) {
                    if (!scaleCanvas) {
                        scaleCanvas = new OffscreenCanvas(encodedWidth, encodedHeight);
                        scaleContext = scaleCanvas.getContext('2d');
                    }
                    if (!scaleContext) {
                        throw new EncodeError('2D context unavailable for rescale');
                    }
                    scaleContext.drawImage(frame, 0, 0, encodedWidth, encodedHeight);
                    frameToEncode = new VideoFrame(scaleCanvas, { timestamp: timestampUs, duration: durationUs });
                }
                else {
                    frameToEncode = new VideoFrame(frame, { timestamp: timestampUs, duration: durationUs });
                }
                try {
                    encoder.encode(frameToEncode, { keyFrame: kept % 60 === 1 });
                }
                finally {
                    frameToEncode.close();
                }
            };
            const emitGridUpTo = async (limitUs) => {
                while (heldFrame && nextEmitTime <= limitUs + stepUs * 0.25) {
                    await waitToEncode();
                    emitFrame(heldFrame, Math.round(nextEmitTime), Math.round(stepUs));
                    nextEmitTime += stepUs;
                }
            };
            const drainFrames = async () => {
                while (frameQueue.size > 0) {
                    const frame = frameQueue.get(frameIndex);
                    frameQueue.delete(frameIndex++);
                    try {
                        checkReady();
                        if (frameStep <= 0) {
                            await waitToEncode();
                            emitFrame(frame, frame.timestamp, frame.duration ?? undefined);
                        }
                        else {
                            if (nextEmitTime === Number.NEGATIVE_INFINITY)
                                nextEmitTime = frame.timestamp;
                            await emitGridUpTo(frame.timestamp - stepUs);
                            heldFrame?.close();
                            heldFrame = frame;
                        }
                    }
                    finally {
                        if (heldFrame !== frame)
                            frame.close();
                    }
                }
                frameIndex = 0;
                nextFrameIndex = 0;
            };
            const startDrain = () => {
                if (drainTask)
                    return;
                drainTask = drainFrames()
                    .catch(recordError)
                    .finally(() => {
                    drainTask = null;
                    if (lifetime.acceptingOutput && frameQueue.size > 0)
                        startDrain();
                });
            };
            decoder = new VideoDecoder({
                output: (frame) => {
                    decoded++;
                    try {
                        checkReady();
                        frameQueue.set(nextFrameIndex++, frame);
                        startDrain();
                    }
                    catch (caught) {
                        recordError(caught);
                        frame.close();
                    }
                },
                error: (caught) => {
                    recordError(new DecodeError(`VideoDecoder failed: ${caught.message}`));
                    logger.warn('[Pipeline] VideoDecoder error:', caught);
                },
            });
            try {
                decoder.configure(decoderConfig);
            }
            catch (caught) {
                throw new DecodeError(`VideoDecoder configure failed for '${sourceTrack.codec}': ${caught}`);
            }
            await waitFor(this.host.yield());
            let previousConfigIndex = null;
            for (let index = 0; index < count; index++) {
                checkReady();
                while (encoder.encodeQueueSize > 5 || decoder.decodeQueueSize + frameQueue.size > 8) {
                    await waitFor(this.host.yield());
                    checkReady();
                }
                const sample = sampleAt(sourceTrack, index);
                const sourceData = sample.data ?? (await waitFor(source.read(sample.offset, sample.size)));
                checkReady();
                const prepared = this.host.videoPayloadForSample(sourceTrack, sample, sourceData, previousConfigIndex);
                previousConfigIndex = prepared.configIndex;
                decoder.decode(new EncodedVideoChunk({
                    type: sample.isKeyframe ? 'key' : 'delta',
                    timestamp: sample.timestamp * 1e6,
                    duration: sample.duration * 1e6,
                    data: !decoderConfig.description && sample.nalUnitFormat === 'annexb'
                        ? sourceData
                        : prepared.data,
                }));
                if (index % 10 === 0) {
                    this.host.report(10 + Math.round((index / count) * 65), `Video ${index}/${count}`);
                }
            }
            if (decoder.state !== 'closed') {
                try {
                    await waitFor(decoder.flush().catch(caught => {
                        throw pipelineError(caught);
                    }));
                }
                catch (caught) {
                    recordError(caught);
                }
            }
            checkError();
            while (drainTask)
                await waitFor(drainTask);
            checkReady();
            const finalFrame = heldFrame;
            if (finalFrame) {
                const finalDuration = finalFrame.duration ?? stepUs;
                await emitGridUpTo(finalFrame.timestamp + Math.max(finalDuration, stepUs) - stepUs);
                finalFrame.close();
                heldFrame = null;
            }
            if (encoder.state !== 'closed') {
                try {
                    await waitFor(encoder.flush().catch(caught => {
                        throw pipelineError(caught);
                    }));
                }
                catch (caught) {
                    recordError(caught);
                }
            }
            logger.debug(`[Pipeline] pipeVideo done: samples=${count}, decoded=${decoded}, encoded=${encoded}`);
            checkError();
            if (encoded === 0 && count > 0) {
                throw new EncodeError('Video pipeline produced no output');
            }
        }
        catch (caught) {
            throw lifetime.record(caught);
        }
        finally {
            lifetime.stop();
            if (decoder && decoder.state !== 'closed') {
                try {
                    decoder.close();
                }
                catch { }
            }
            if (ownedEncoder && ownedEncoder.state !== 'closed') {
                try {
                    ownedEncoder.close();
                }
                catch { }
            }
            if (drainTask)
                await drainTask;
            const unconsumedFrame = heldFrame;
            unconsumedFrame?.close();
            for (const frame of frameQueue.values())
                frame.close();
            frameQueue.clear();
        }
    }
}
