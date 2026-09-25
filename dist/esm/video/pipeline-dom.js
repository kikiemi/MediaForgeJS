import { awaitWithAbort, linkAbortSignals } from '../core/abort.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { DecodeError, EncodeError, MediaForgeError } from '../core/errors.js';
import { renderAudioBuffer } from '../audio/audio-buffer-tools.js';
import { DOMDemuxer } from '../demux/dom-demuxer.js';
import { DemuxerRegistry } from '../demux/registry.js';
import { MemorySink } from '../io/sinks.js';
import { isPcmOutputMuxer } from '../core/pcm-muxer.js';
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
export class PipelineDom {
    config;
    host;
    constructor(config, host) {
        this.config = config;
        this.host = host;
    }
    async run(input, format) {
        const fps = this.host.encoderFps();
        const stop = new AbortController();
        const linked = linkAbortSignals(this.config.signal, stop.signal);
        const demuxer = new DOMDemuxer({
            fps,
            signal: linked.signal,
            onProgress: this.config.onProgress,
        });
        try {
            const info = await demuxer.open(input);
            if (!info.hasVideo && !info.hasAudio)
                throw new MediaForgeError('No media tracks', 'DECODE');
            const sink = new MemorySink();
            const videoCodec = this.config.videoCodec;
            const audioCodec = this.config.audioCodec;
            const { w, h } = this.host.targetVideoDimensions(info.videoWidth, info.videoHeight);
            const audio = this.host.targetAudioParams(info.audioSampleRate, info.audioChannels, audioCodec);
            const muxer = this.host.makeMuxer(format, sink, videoCodec, audioCodec, info.hasVideo, info.hasAudio, w, h, audio.rate, Math.max(1, Math.min(8, audio.channels)));
            if (info.hasVideo)
                await this.encodeVideo(demuxer, muxer, videoCodec, format, w, h, stop);
            if (info.hasAudio) {
                this.host.report(85, 'Encoding audio...');
                const audioBuffer = await demuxer.decodeAudio(input);
                if (!audioBuffer)
                    throw new DecodeError('Audio track present but produced no PCM');
                if (audioCodec === 'pcm' && isPcmOutputMuxer(muxer)) {
                    const targetRate = this.config.audioSampleRate || audioBuffer.sampleRate;
                    const targetChannels = Math.max(1, Math.min(audioBuffer.numberOfChannels, this.config.audioChannels || audioBuffer.numberOfChannels));
                    const rendered = audioBuffer.sampleRate === targetRate && audioBuffer.numberOfChannels === targetChannels
                        ? audioBuffer
                        : await renderAudioBuffer(audioBuffer, targetRate, targetChannels, this.config.signal);
                    muxer.addPCMBuffer(rendered);
                }
                else {
                    await this.host.encodeAudioBuffer(audioBuffer, audioCodec, muxer);
                }
            }
            this.host.checkAbort();
            await awaitWithAbort(muxer.finalize(), this.config.signal);
            this.host.checkAbort();
            const blob = sink.toBlob(DemuxerRegistry.getMimeType(format));
            if (blob.size < 100)
                throw new MediaForgeError('Output too small', 'OUTPUT');
            this.host.report(100, 'Done');
            this.host.checkAbort();
            return blob;
        }
        finally {
            stop.abort();
            linked.dispose();
            demuxer.close();
        }
    }
    async encodeVideo(demuxer, muxer, codec, format, width, height, stop) {
        this.host.report(10, 'Encoding video...');
        let codecConfig;
        let encoded = 0;
        const pipelineError = (caught) => caught instanceof MediaForgeError || (caught instanceof DOMException && caught.name === 'AbortError')
            ? caught
            : new EncodeError(`Video encoding failed: ${caught instanceof Error ? caught.message : String(caught)}`);
        const lifetime = new CodecLifetime(this.config.signal, new EncodeError('Video encoding stopped'));
        const recordError = (caught) => {
            const interruptDemuxer = lifetime.acceptingOutput;
            const error = lifetime.record(pipelineError(caught));
            if (interruptDemuxer)
                stop.abort();
            return error;
        };
        const waitFor = (pending) => lifetime.waitFor(pending);
        let ownedEncoder = null;
        try {
            lifetime.check();
            const encoder = new VideoEncoder({
                output: (chunk, metadata) => {
                    if (!lifetime.acceptingOutput)
                        return;
                    try {
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
                        encoded++;
                    }
                    catch (caught) {
                        recordError(caught);
                    }
                },
                error: recordError,
            });
            ownedEncoder = encoder;
            const checkReady = () => {
                lifetime.check();
                this.host.checkAbort();
                if (encoder.state === 'closed')
                    throw new EncodeError('VideoEncoder closed before video encoding completed');
            };
            try {
                encoder.configure({
                    codec,
                    width,
                    height,
                    bitrate: this.host.videoBitrateFor(),
                    framerate: this.host.encoderFps(),
                    ...(codec.startsWith('avc') ? { avc: { format: avcFormatFor(format) } } : {}),
                });
            }
            catch (caught) {
                throw recordError(caught);
            }
            await waitFor(this.host.yield());
            checkReady();
            let frameIndex = 0;
            for await (const frame of demuxer.videoFrames()) {
                try {
                    checkReady();
                    while (encoder.encodeQueueSize > 5) {
                        await waitFor(this.host.yield());
                        checkReady();
                    }
                    try {
                        encoder.encode(frame, { keyFrame: frameIndex % 60 === 0 });
                    }
                    catch (caught) {
                        throw recordError(caught);
                    }
                    frameIndex++;
                }
                finally {
                    frame.close();
                }
            }
            checkReady();
            try {
                await waitFor(encoder.flush().catch(caught => {
                    throw pipelineError(caught);
                }));
            }
            catch (caught) {
                throw pipelineError(caught);
            }
            checkReady();
            if (encoded === 0)
                throw new EncodeError('Video encoding produced no output');
        }
        catch (caught) {
            throw lifetime.record(caught);
        }
        finally {
            lifetime.stop();
            if (ownedEncoder && ownedEncoder.state !== 'closed') {
                try {
                    ownedEncoder.close();
                }
                catch { }
            }
        }
    }
}
