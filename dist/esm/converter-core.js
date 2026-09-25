import { ConversionContext, requireConversionComponent } from './conversion/context.js';
import { reportConversionMetadata } from './conversion/metadata.js';
import { normalizeMediaForgeConfig } from './core/converter-config.js';
import { createCarriedMetadata } from './core/converter-context.js';
import { DemuxerRegistry } from './demux/registry.js';
import { Pipeline, toInputBlob } from './pipeline-core.js';
import { MemorySink } from './io/sinks.js';
import { MediaForgeError, DemuxError, rethrowIfAbort, normalizeBitrateBps } from './core/errors.js';
import { codecFamily } from './core/codec-strings.js';
import { logger } from './core/logger.js';
import { readMp4Udta } from './core/mp4-meta.js';
import { readOggCommentPayload } from './core/ogg-meta.js';
import { IMAGE_FORMATS, AUDIO_ONLY, AUDIO_INPUT, VIDEO_CONTAINERS, CONTAINER_CODEC_PLANS, resolveSupportedCodec, } from './core/format-plans.js';
export { readFlacMetaBlocks, injectFlacMetaBlocks, readId3v2Prefix } from './core/audio-metadata.js';
import { BlobSource } from './io/sources.js';
import { yieldToEventLoop } from './audio/audio-buffer-tools.js';
import { ReadableStreamSink } from './io/readable-stream-sink.js';
import { copiedAudioTrackConfig } from './core/pipeline-track-config.js';
import { awaitWithAbort, linkAbortSignals } from './core/abort.js';
import { drainSink, assertSink } from './io/sink-backpressure.js';
import { createCancellableSink } from './io/cancellable-sink.js';
export class MediaForgeConverter {
    config;
    audioDecoderComponent;
    get audioDecoder() {
        return requireConversionComponent(this.audioDecoderComponent, 'audio decoder');
    }
    components;
    inFlight = false;
    operationFailure = null;
    carried = createCarriedMetadata();
    audioEncoderComponent;
    get audioEncoder() {
        return requireConversionComponent(this.audioEncoderComponent, 'audio encoder');
    }
    imageComponent;
    get image() {
        return requireConversionComponent(this.imageComponent, 'image conversion');
    }
    detected = null;
    constructor(config = {}, options = {}) {
        this.config = normalizeMediaForgeConfig(config);
        this.components = new ConversionContext(options, this.config.metadataPolicy);
        const onProgress = this.config.onProgress;
        if (onProgress) {
            this.config.onProgress = (progress, message) => {
                if (this.operationFailure)
                    throw this.operationFailure.reason;
                try {
                    onProgress.call(this.config, progress, message);
                }
                catch (reason) {
                    this.recordFailure(reason);
                    throw reason;
                }
            };
        }
        this.audioDecoderComponent = this.components.options.audio?.createDecoder(this.config, this.components);
        this.imageComponent = this.components.options.image?.(this.config, {
            detectFormat: file => this.detectFormat(file),
        });
        this.audioEncoderComponent = this.components.options.audio?.createEncoder(this.config, {
            getCarried: () => this.carried,
            getDemuxed: file => (this.planningDemux?.file === file ? this.planningDemux.result : undefined),
            decodeAudioToBuffer: (file, inputFormat) => this.decodeAudioToBuffer(file, inputFormat),
            tryDirectAudioRemux: (file, inputFormat, outputFormat) => this.tryDirectAudioRemux(file, inputFormat, outputFormat),
            audioBitrateBps: () => this.audioBitrateBps(),
        }, this.components);
    }
    async detectFormat(input) {
        const file = toInputBlob(input);
        if (this.inFlight && this.detected?.file === file)
            return this.detected.result;
        const result = awaitWithAbort(DemuxerRegistry.detectFromFile(file, this.config.signal), this.config.signal);
        if (this.inFlight)
            this.detected = { file, result };
        return result;
    }
    hasTransformOptions() {
        const c = this.config;
        return Boolean(c.width ||
            c.height ||
            c.fps ||
            c.videoBitrate ||
            c.audioBitrate ||
            c.audioSampleRate ||
            c.audioChannels ||
            c.videoCodec ||
            c.audioCodec ||
            c.audioVbr ||
            c.audioTrackIndex !== undefined ||
            c.imageQuality !== undefined ||
            c.imageResize !== undefined ||
            c.imageFit !== undefined ||
            c.imageOptimizeFrames !== undefined ||
            c.imageDither !== undefined ||
            c.maxAnimationPixels !== undefined);
    }
    beginCall(name) {
        if (this.inFlight) {
            throw new MediaForgeError(`${name}() is already running on this MediaForgeConverter. Overlapping calls on one ` +
                "instance would mix the files' metadata and copied audio tracks. Create a separate " +
                'MediaForgeConverter per concurrent conversion.', 'FORMAT');
        }
        this.operationFailure = null;
        this.inFlight = true;
    }
    async convertToSink(file, sink) {
        assertSink(sink);
        const blob = toInputBlob(file);
        this.beginCall('convertToSink');
        const originalSignal = this.config.signal;
        let linked;
        let output;
        let observingFailure = true;
        try {
            linked = linkAbortSignals(originalSignal, sink.signal);
            this.config.signal = linked.signal;
            output = createCancellableSink(sink, linked.signal, (reason, aborted) => {
                if (observingFailure)
                    this.recordFailure(reason, aborted);
            });
            this.config.signal.throwIfAborted();
            await this.convertToSinkInner(blob, output);
            this.checkCompletion();
        }
        catch (e) {
            const finalError = this.normalizeCancellation(e);
            if (!this.sinkDelegated) {
                try {
                    await output?.abort(finalError);
                }
                catch { }
            }
            throw finalError;
        }
        finally {
            observingFailure = false;
            linked?.dispose();
            this.config.signal = originalSignal;
            this.sinkDelegated = false;
            this.inFlight = false;
            this.operationFailure = null;
            this.detected = null;
            this.carried = createCarriedMetadata();
            this.planningDemux = null;
            this.planningDemuxError = null;
        }
    }
    convertToReadableStream(file, options = {}) {
        const sink = new ReadableStreamSink(options);
        void this.convertToSink(file, sink).catch(error => sink.abort(error));
        return sink.stream;
    }
    sinkDelegated = false;
    recordFailure(reason, aborted = this.config.signal?.aborted) {
        if (this.inFlight && !aborted && !this.operationFailure)
            this.operationFailure = { reason };
    }
    normalizeCancellation(e) {
        if (this.operationFailure)
            return this.operationFailure.reason;
        if (e instanceof MediaForgeError)
            return e;
        if (this.config.signal?.aborted)
            return new MediaForgeError('Aborted', 'ABORT');
        if (e instanceof DOMException && e.name === 'AbortError')
            return new MediaForgeError('Aborted', 'ABORT');
        return e;
    }
    checkCompletion() {
        if (this.operationFailure)
            throw this.operationFailure.reason;
        if (this.config.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    }
    async convertToSinkInner(file, sink) {
        const inputFmt = await this.detectFormat(file);
        const outputFmt = this.config.outputFormat;
        this.components.assertFormats(inputFmt, outputFmt);
        if (inputFmt === outputFmt && !this.hasTransformOptions()) {
            await this.validatePassthrough(file, inputFmt);
            const step = 1024 * 1024;
            for (let offset = 0; offset < file.size; offset += step) {
                const data = await awaitWithAbort(file.slice(offset, offset + step).arrayBuffer(), this.config.signal);
                this.config.signal?.throwIfAborted();
                sink.write(new Uint8Array(data));
                await drainSink(sink, this.config.signal);
                this.config.onProgress?.(Math.min(99, ((offset + data.byteLength) / file.size) * 100), 'Copying media...');
            }
            this.config.onProgress?.(100, 'Conversion complete');
            this.config.signal?.throwIfAborted();
            await sink.close();
            return;
        }
        if (outputFmt === 'wav') {
            const streamed = await this.streamWavToSink(file, sink);
            if (streamed)
                return;
        }
        if (AUDIO_ONLY.has(outputFmt)) {
            await this.checkOutputMetadata(file, inputFmt, outputFmt);
            const streamed = await this.audioEncoder.extractAudioToSink(file, sink, outputFmt, inputFmt);
            if (streamed)
                return;
            throw new MediaForgeError(`convertToSink has no bounded '${inputFmt}' -> '${outputFmt}' route in this environment; ` +
                'bounded sink outputs are WAV, AIFF, AU, CAF, AAC, FLAC, MP2, MP3, Ogg Opus and normal mdat-first M4A ' +
                '(codec availability depends on this browser)', 'FORMAT');
        }
        if (IMAGE_FORMATS.has(inputFmt) ||
            IMAGE_FORMATS.has(outputFmt) ||
            (AUDIO_INPUT.has(inputFmt) && outputFmt !== 'ts')) {
            throw new MediaForgeError(`convertToSink streams the video-container pipeline; '${inputFmt}' -> '${outputFmt}' is not a streaming route (use convert())`, 'FORMAT');
        }
        try {
            await this.convertVideo(file, sink);
        }
        finally {
            this.planningDemux = null;
            this.planningDemuxError = null;
            this.carried = createCarriedMetadata();
        }
    }
    async convert(file) {
        const blob = toInputBlob(file);
        this.beginCall('convert');
        try {
            this.config.signal?.throwIfAborted();
            const result = await this.convertInner(blob);
            this.checkCompletion();
            return result;
        }
        catch (e) {
            throw this.normalizeCancellation(e);
        }
        finally {
            this.planningDemux = null;
            this.planningDemuxError = null;
            this.carried = createCarriedMetadata();
            this.inFlight = false;
            this.operationFailure = null;
            this.detected = null;
        }
    }
    async convertInner(file) {
        this.carried = createCarriedMetadata();
        this.components.assertFormats(await this.detectFormat(file), this.config.outputFormat);
        const streamed = await this.tryStreamingWav(file);
        if (streamed)
            return streamed;
        const inputFmt = await this.detectFormat(file);
        const outputFmt = this.config.outputFormat;
        this.components.assertFormats(inputFmt, outputFmt);
        logger.info(`[Converter] convert: ${inputFmt} → ${outputFmt}`);
        const MP4_META_FAMILY = ['mp4', 'm4a', 'mov', '3gp', 'm4v'];
        this.carried.udta =
            MP4_META_FAMILY.includes(inputFmt) && MP4_META_FAMILY.includes(outputFmt)
                ? await readMp4Udta(file, this.config.signal)
                : null;
        this.carried.oggComments =
            inputFmt === 'ogg' && outputFmt === 'ogg' ? await readOggCommentPayload(file, this.config.signal) : null;
        if (inputFmt === outputFmt && !this.hasTransformOptions()) {
            if (this.config.signal?.aborted)
                throw new DOMException('Aborted', 'AbortError');
            await this.validatePassthrough(file, inputFmt);
            this.config.signal?.throwIfAborted();
            this.config.onProgress?.(100, 'Conversion complete');
            logger.info('[Converter] passthrough: same format, no conversion options');
            return file.slice(0, file.size, DemuxerRegistry.getMimeType(outputFmt));
        }
        if (IMAGE_FORMATS.has(inputFmt)) {
            if (IMAGE_FORMATS.has(outputFmt)) {
                return this.image.convertImage(file, outputFmt);
            }
            throw new MediaForgeError(`Cannot convert image (${inputFmt}) to non-image format (${outputFmt})`, 'FORMAT');
        }
        if (AUDIO_ONLY.has(outputFmt) || (IMAGE_FORMATS.has(outputFmt) && this.config.metadataPolicy === 'error')) {
            await this.checkOutputMetadata(file, inputFmt, outputFmt);
        }
        if (AUDIO_INPUT.has(inputFmt)) {
            if (inputFmt !== 'm4a' && inputFmt !== 'ogg')
                this.assertSingleAudioTrack();
            if (AUDIO_ONLY.has(outputFmt)) {
                return this.extractAudio(file, outputFmt, undefined, inputFmt);
            }
            if (outputFmt === 'ts')
                return this.convertVideo(file);
            throw new MediaForgeError(`Cannot convert audio-only input (${inputFmt}) to video format (${outputFmt})`, 'FORMAT');
        }
        if (VIDEO_CONTAINERS.has(inputFmt)) {
            if (AUDIO_ONLY.has(outputFmt)) {
                try {
                    return await this.extractAudio(file, outputFmt, undefined, inputFmt);
                }
                catch (e) {
                    if (this.operationFailure)
                        throw this.operationFailure.reason;
                    if (e instanceof MediaForgeError && this.config.signal?.aborted)
                        throw e;
                    rethrowIfAbort(e, this.config.signal);
                    if (e instanceof MediaForgeError &&
                        (e.code === 'FORMAT' || e.code === 'ENCODE' || e.code === 'DEMUX'))
                        throw e;
                    logger.warn('[Converter] extractAudio failed, trying Pipeline:', e);
                }
            }
            if (IMAGE_FORMATS.has(outputFmt)) {
                try {
                    return await this.videoToImage(file, outputFmt);
                }
                catch (e) {
                    if (e instanceof MediaForgeError && this.config.signal?.aborted)
                        throw e;
                    rethrowIfAbort(e, this.config.signal);
                    if (e instanceof MediaForgeError && e.code === 'FORMAT')
                        throw e;
                    logger.warn('[Converter] videoToImage failed:', e);
                    try {
                        return await this.image.convertImage(file, outputFmt);
                    }
                    catch {
                        throw e;
                    }
                }
            }
            return this.convertVideo(file);
        }
        throw new MediaForgeError(`Unsupported input format: ${inputFmt}`, 'FORMAT');
    }
    async validateLinearPcmWav(file) {
        const fmt = await this.detectFormat(file).catch(() => null);
        if (fmt === 'wav')
            await this.components.validate(file, 'wav', this.config.signal);
    }
    async streamWavToSink(file, sink) {
        const wav = this.components.options.audio?.wav;
        if (!wav)
            return false;
        if (this.config.width || this.config.height || this.config.fps || this.config.audioBitrate)
            return false;
        await this.validateLinearPcmWav(file);
        const layout = await wav.readLayout(file, this.config.signal).catch((e) => {
            rethrowIfAbort(e, this.config.signal);
            return null;
        });
        if (!layout)
            return false;
        this.assertSingleAudioTrack();
        const targetRate = this.config.audioSampleRate || layout.sampleRate;
        const targetChannels = this.config.audioChannels || layout.channels;
        if (targetChannels < 1 || targetChannels > 8)
            return false;
        await wav.convert(file, layout, targetRate, targetChannels, {
            signal: this.config.signal,
            onProgress: fraction => this.config.onProgress?.(Math.round(fraction * 100), 'Converting audio...'),
            sink,
        });
        this.config.signal?.throwIfAborted();
        await sink.close();
        return true;
    }
    async tryStreamingWav(file) {
        const wav = this.components.options.audio?.wav;
        if (!wav)
            return null;
        if (this.config.outputFormat !== 'wav')
            return null;
        await this.validateLinearPcmWav(file);
        if (this.config.width || this.config.height || this.config.fps)
            return null;
        if (this.config.audioBitrate)
            return null;
        const layout = await wav.readLayout(file, this.config.signal).catch((e) => {
            rethrowIfAbort(e, this.config.signal);
            return null;
        });
        if (!layout)
            return null;
        this.assertSingleAudioTrack();
        const targetRate = this.config.audioSampleRate || layout.sampleRate;
        const targetChannels = this.config.audioChannels || layout.channels;
        if (targetChannels < 1 || targetChannels > 8)
            return null;
        if (targetRate === layout.sampleRate && targetChannels === layout.channels)
            return null;
        try {
            const { blob } = await wav.convert(file, layout, targetRate, targetChannels, {
                signal: this.config.signal,
                onProgress: fraction => this.config.onProgress?.(Math.round(fraction * 100), 'Converting audio...'),
            });
            return blob;
        }
        catch (error) {
            if (this.operationFailure)
                throw this.operationFailure.reason;
            if (error?.name === 'AbortError')
                throw error;
            if (error instanceof MediaForgeError && error.code === 'ABORT')
                throw error;
            logger.warn('[Converter] streaming wav path failed; falling back to the buffered one:', error);
            return null;
        }
    }
    audioBitrateBps() {
        return normalizeBitrateBps(this.config.audioBitrate, 'audio');
    }
    assertSingleAudioTrack() {
        if (this.config.audioTrackIndex !== undefined && this.config.audioTrackIndex !== 0) {
            throw new MediaForgeError(`audioTrackIndex ${this.config.audioTrackIndex} is out of range (input has 1 audio track)`, 'FORMAT');
        }
    }
    async convertImage(file, format) {
        const blob = toInputBlob(file);
        this.beginCall('convertImage');
        try {
            const inputFormat = await this.detectFormat(blob);
            const outputFormat = format ?? this.config.outputFormat;
            this.components.assertFormats(inputFormat, outputFormat);
            if (this.config.metadataPolicy === 'error')
                await this.checkOutputMetadata(blob, inputFormat, outputFormat);
            const result = await this.image.convertImage(blob, format);
            this.checkCompletion();
            return result;
        }
        catch (error) {
            throw this.normalizeCancellation(error);
        }
        finally {
            this.inFlight = false;
            this.operationFailure = null;
            this.detected = null;
            this.planningDemux = null;
            this.planningDemuxError = null;
            this.carried = createCarriedMetadata();
        }
    }
    chooseNativeDemuxer(format) {
        if (!VIDEO_CONTAINERS.has(format) && format !== 'm4a')
            return null;
        return this.components.demuxer(format);
    }
    async validatePassthrough(file, fmt) {
        const demuxer = this.chooseNativeDemuxer(fmt);
        if (demuxer) {
            const result = await demuxer.demux(file, this.config.signal);
            this.planningDemux = { file, result };
            if (result.videoTracks.length + result.audioTracks.length === 0) {
                throw new DemuxError(`${fmt} input contains no tracks`);
            }
            return;
        }
        await this.components.validate(file, fmt, this.config.signal);
    }
    planningDemux = null;
    planningDemuxError = null;
    async checkOutputMetadata(file, inputFormat, outputFormat) {
        const demuxer = this.chooseNativeDemuxer(inputFormat);
        if (!demuxer)
            return;
        const result = this.planningDemux?.file === file
            ? this.planningDemux.result
            : await demuxer.demux(file, this.config.signal);
        this.planningDemux = { file, result };
        const track = IMAGE_FORMATS.has(outputFormat)
            ? result.videoTracks[0]
            : result.audioTracks[this.config.audioTrackIndex ?? 0];
        if (AUDIO_ONLY.has(outputFormat)) {
            this.carried.title = result.title ?? result.matroskaPassThrough?.title;
            this.carried.audioLanguage = track?.language;
            if (track) {
                const { name, title, default: isDefault, forced, commentary, language } = track;
                this.carried.audioTrack = { name, title, default: isDefault, forced, commentary, language };
            }
        }
        reportConversionMetadata(result, outputFormat, track ? [track] : [], this.config.metadataPolicy, 'Converter');
    }
    async inspectPrimaryTracks(file) {
        const inputFormat = await this.detectFormat(file);
        const demuxer = this.chooseNativeDemuxer(inputFormat);
        if (!demuxer)
            return null;
        try {
            const result = await demuxer.demux(file, this.config.signal);
            this.planningDemux = { file, result };
            return {
                video: result.videoTracks[0] ?? null,
                audio: result.audioTracks[this.config.audioTrackIndex ?? 0] ?? result.audioTracks[0] ?? null,
            };
        }
        catch (error) {
            rethrowIfAbort(error, this.config.signal);
            if (error instanceof MediaForgeError && error.code === 'FORMAT')
                throw error;
            this.planningDemuxError = { file, error };
            logger.warn('[Converter] track inspection failed:', error);
            return null;
        }
    }
    async resolvePipelineCodecs(file, format) {
        const plan = CONTAINER_CODEC_PLANS[format];
        if (!plan?.defaultVideo || !plan.defaultAudio) {
            throw new MediaForgeError(`No codec profile for format: ${format}`, 'FORMAT');
        }
        const inspectedTracks = !this.config.videoCodec || !this.config.audioCodec ? await this.inspectPrimaryTracks(file) : null;
        const inspectedVideo = inspectedTracks?.video;
        const inspectedAudio = inspectedTracks?.audio;
        const preferredVideoCodec = this.config.videoCodec ??
            (inspectedVideo &&
                plan.video?.some(candidate => codecFamily(candidate) === codecFamily(inspectedVideo.codec))
                ? inspectedVideo.codec
                : plan.defaultVideo);
        const preferredAudioCodec = this.config.audioCodec ??
            (inspectedAudio &&
                plan.audio?.some(candidate => codecFamily(candidate) === codecFamily(inspectedAudio.codec))
                ? inspectedAudio.codec
                : plan.defaultAudio);
        const resolvedVideo = resolveSupportedCodec(preferredVideoCodec, plan.video, plan.defaultVideo, `${format} video`);
        const resolvedAudio = resolveSupportedCodec(preferredAudioCodec, plan.audio, plan.defaultAudio, `${format} audio`);
        if (resolvedVideo === null && !this.config.videoCodec) {
            logger.warn(`[Converter] ${format} video: '${preferredVideoCodec}' unsupported, using '${plan.defaultVideo}'`);
        }
        if (resolvedAudio === null && !this.config.audioCodec) {
            logger.warn(`[Converter] ${format} audio: '${preferredAudioCodec}' unsupported, using '${plan.defaultAudio}'`);
        }
        if (this.config.videoCodec && resolvedVideo === null) {
            throw new MediaForgeError(`Unsupported video codec '${this.config.videoCodec}' for ${format}. Supported: ${(plan.video ?? [plan.defaultVideo]).join(', ')}`, 'FORMAT');
        }
        if (this.config.audioCodec && resolvedAudio === null) {
            throw new MediaForgeError(`Unsupported audio codec '${this.config.audioCodec}' for ${format}. Supported: ${(plan.audio ?? [plan.defaultAudio]).join(', ')}`, 'FORMAT');
        }
        return {
            videoCodec: resolvedVideo ?? plan.defaultVideo,
            audioCodec: resolvedAudio ?? plan.defaultAudio,
        };
    }
    async tryDirectAudioRemux(file, inputFormat, outputFormat) {
        if (!inputFormat)
            return null;
        const demuxer = this.chooseNativeDemuxer(inputFormat);
        if (!demuxer)
            return null;
        const plan = CONTAINER_CODEC_PLANS[outputFormat];
        if (!plan?.defaultAudio || !plan.audio)
            return null;
        try {
            const result = this.planningDemux?.file === file
                ? this.planningDemux.result
                : await demuxer.demux(file, this.config.signal);
            this.planningDemux = { file, result };
            const nIdx = this.config.audioTrackIndex ?? 0;
            if (this.config.audioTrackIndex !== undefined &&
                (!Number.isInteger(nIdx) || nIdx < 0 || nIdx >= result.audioTracks.length)) {
                throw new MediaForgeError(`audioTrackIndex ${nIdx} is out of range (input has ${result.audioTracks.length} audio track(s))`, 'FORMAT');
            }
            if (result.audioTracks.length > 1) {
                logger.warn(`[Converter] input has ${result.audioTracks.length} audio tracks; using #${nIdx} (set audioTrackIndex to choose)`);
            }
            const audioTrack = result.audioTracks[nIdx];
            if (!audioTrack)
                return null;
            if ((audioTrack.codecConfigurations?.length ?? 0) > 1)
                return null;
            const preferredCodec = this.config.audioCodec ??
                (plan.audio.some(candidate => codecFamily(candidate) === codecFamily(audioTrack.codec))
                    ? audioTrack.codec
                    : plan.defaultAudio);
            const outputCodec = resolveSupportedCodec(preferredCodec, plan.audio, plan.defaultAudio, `${outputFormat} audio`);
            if (this.config.audioCodec && outputCodec === null) {
                throw new MediaForgeError(`Unsupported audio codec '${this.config.audioCodec}' for ${outputFormat}. Supported: ${(plan.audio ?? [plan.defaultAudio]).join(', ')}`, 'FORMAT');
            }
            if (!outputCodec || codecFamily(outputCodec) !== codecFamily(audioTrack.codec))
                return null;
            if (this.config.audioCodec &&
                this.config.audioCodec.includes('.') &&
                this.config.audioCodec.toLowerCase() !== audioTrack.codec.toLowerCase()) {
                return null;
            }
            if (this.config.audioBitrate)
                return null;
            if (this.config.audioChannels &&
                audioTrack.channelCount &&
                this.config.audioChannels !== audioTrack.channelCount)
                return null;
            if (this.config.audioSampleRate &&
                audioTrack.sampleRate &&
                this.config.audioSampleRate !== audioTrack.sampleRate)
                return null;
            if ((audioTrack.codec === 'ac-3' || audioTrack.codec === 'ec-3') && !audioTrack.codecConfig)
                return null;
            const source = new BlobSource(file);
            const sink = new MemorySink();
            const muxer = this.components.createMuxer({
                title: result.title ?? result.matroskaPassThrough?.title,
                moovUserData: this.carried.udta ?? undefined,
                audioLanguage: audioTrack.language,
                extraAudioTracks: this.carried.extraAudio.length > 0 ? this.carried.extraAudio.map(t => t.config) : undefined,
                format: outputFormat,
                mode: 'standard',
                maxFragmentDuration: 2.0,
                autoSync: true,
                audio: {
                    ...copiedAudioTrackConfig(audioTrack, outputFormat),
                    id: 1,
                    type: 'audio',
                    codec: outputCodec,
                    sampleRate: audioTrack.sampleRate || (this.config.audioSampleRate ?? 48000),
                    channelCount: audioTrack.channelCount || (this.config.audioChannels ?? 2),
                    codecConfig: audioTrack.codecConfig,
                },
            }, sink);
            if (this.carried.extraAudio.length && !muxer.addExtraAudioChunk) {
                throw new MediaForgeError('Selected muxer cannot preserve additional audio tracks', 'FORMAT');
            }
            const copiedAudio = copiedAudioTrackConfig(audioTrack, outputFormat);
            if ((audioTrack.codec.startsWith('mp4a') || audioTrack.codec === 'aac') &&
                copiedAudio.validSamples !== undefined) {
                if (!muxer.setAudioPriming)
                    throw new MediaForgeError('Selected muxer cannot preserve audio priming and presentation length', 'FORMAT');
                muxer.setAudioPriming(copiedAudio.primingSamples ?? 0, copiedAudio.validSamples, copiedAudio.presentationTimestamps === true, copiedAudio.discardLeadingSamples !== false, copiedAudio.codecDelaySamples ?? 0);
            }
            for (let index = 0; index < audioTrack.samples.length; index++) {
                const sample = audioTrack.samples[index];
                const data = sample.data ?? (await source.read(sample.offset, sample.size));
                muxer.addAudioChunk({
                    data,
                    timestamp: sample.timestamp,
                    duration: sample.duration,
                    isKeyframe: true,
                    trackType: 'audio',
                });
                if ((index & 63) === 0) {
                    if (this.config.signal?.aborted)
                        throw new MediaForgeError('Aborted', 'ABORT');
                    this.config.onProgress?.(20 + Math.round((index / Math.max(audioTrack.samples.length, 1)) * 60), `Remux audio ${index}/${audioTrack.samples.length}`);
                    await yieldToEventLoop();
                }
            }
            for (let ti = 0; ti < this.carried.extraAudio.length; ti++) {
                const extra = this.carried.extraAudio[ti];
                for (const chunk of extra.chunks)
                    muxer.addExtraAudioChunk(ti, chunk, extra.config.codecConfig);
            }
            this.carried.extraAudio = [];
            this.carried.udta = null;
            this.config.onProgress?.(100, 'Finalizing output...');
            await muxer.finalize();
            return sink.toBlob('audio/mp4');
        }
        catch (error) {
            rethrowIfAbort(error, this.config.signal);
            if (error instanceof DemuxError) {
                this.planningDemuxError = { file, error };
                throw error;
            }
            if (error instanceof MediaForgeError && error.code === 'FORMAT')
                throw error;
            logger.warn('[Converter] direct audio remux failed:', error);
            return null;
        }
    }
    async convertVideo(file, streamSink) {
        const fmt = this.config.outputFormat;
        logger.debug('convertVideo fmt=', fmt, 'size=', file.size);
        if (IMAGE_FORMATS.has(fmt)) {
            try {
                return await this.videoToImage(file, fmt);
            }
            catch (origErr) {
                rethrowIfAbort(origErr, this.config.signal);
                if (origErr instanceof MediaForgeError && origErr.code === 'FORMAT')
                    throw origErr;
                logger.warn('[Converter] videoToImage failed:', origErr);
                try {
                    return await this.image.convertImage(file, fmt);
                }
                catch {
                    throw origErr;
                }
            }
        }
        if (AUDIO_ONLY.has(fmt)) {
            try {
                return await this.demuxAndExtractAudio(file, fmt);
            }
            catch (e) {
                rethrowIfAbort(e, this.config.signal);
                if (e instanceof MediaForgeError && (e.code === 'FORMAT' || e.code === 'ENCODE' || e.code === 'DEMUX'))
                    throw e;
                logger.warn('[Converter] demuxAndExtractAudio failed, trying extractAudio:', e);
            }
            return this.extractAudio(file, fmt);
        }
        if (VIDEO_CONTAINERS.has(fmt)) {
            const resolvedCodecs = await this.resolvePipelineCodecs(file, fmt);
            const { videoCodec: vCodec, audioCodec: aCodec } = resolvedCodecs;
            if (this.config.videoCodec && codecFamily(this.config.videoCodec) !== codecFamily(vCodec)) {
                logger.warn(`[Converter] ${fmt} only supports ${vCodec} video — ignoring '${this.config.videoCodec}'`);
            }
            if (this.config.audioCodec && codecFamily(this.config.audioCodec) !== codecFamily(aCodec)) {
                logger.warn(`[Converter] ${fmt} only supports ${aCodec} audio — ignoring '${this.config.audioCodec}'`);
            }
            logger.debug('creating Pipeline:', fmt, vCodec, aCodec);
            const pipeline = new Pipeline({
                moovUserData: this.carried.udta ?? undefined,
                outputFormat: fmt,
                metadataPolicy: this.config.metadataPolicy,
                allowDomFallback: this.config.allowDomFallback ?? false,
                videoCodec: vCodec,
                audioCodec: aCodec,
                width: this.config.width ?? 0,
                height: this.config.height ?? 0,
                fps: this.config.fps ?? 0,
                videoBitrate: this.config.videoBitrate ?? 0,
                audioBitrate: this.config.audioBitrate ?? 0,
                audioSampleRate: this.config.audioSampleRate ?? 0,
                audioChannels: this.config.audioChannels ?? 0,
                audioTrackIndex: this.config.audioTrackIndex,
                videoCodecUserSet: this.config.videoCodec !== undefined,
                audioCodecUserSet: this.config.audioCodec !== undefined,
                videoCodecRequested: this.config.videoCodec,
                audioCodecRequested: this.config.audioCodec,
                preDemuxed: this.planningDemux?.file === file ? this.planningDemux.result : undefined,
                preDemuxedError: this.planningDemuxError?.file === file ? this.planningDemuxError.error : undefined,
                signal: this.config.signal,
                onProgress: this.config.onProgress,
            }, this.components.options);
            if (streamSink) {
                this.sinkDelegated = true;
                await pipeline.runToSink(file, streamSink);
                return new Blob([]);
            }
            return pipeline.run(file);
        }
        throw new MediaForgeError(`Unsupported output format: ${fmt}`, 'FORMAT');
    }
    async videoToImage(file, fmt) {
        return this.image.videoToImage(file, fmt);
    }
    assertAnimatedImageBudget(totalFrames, w, h, fmt) {
        this.image.assertAnimatedImageBudget(totalFrames, w, h, fmt);
    }
    async demuxAndExtractAudio(file, fmt) {
        const inputFmt = await this.detectFormat(file);
        const demuxer = this.chooseNativeDemuxer(inputFmt);
        if (!demuxer)
            throw new MediaForgeError(`No demuxer registered for '${inputFmt}'`, 'FORMAT');
        this.config.onProgress?.(5, 'Demuxing audio...');
        const result = this.planningDemux?.file === file
            ? this.planningDemux.result
            : await demuxer.demux(file, this.config.signal);
        const srcA = this.selectAudioTrack(result);
        this.config.onProgress?.(20, 'Decoding audio...');
        const decoded = await this.decodeDemuxedAudioTrack(file, srcA);
        this.config.onProgress?.(60, 'Encoding audio...');
        return this.extractAudio(new Blob([]), fmt, decoded);
    }
    selectAudioTrack(result) {
        return this.audioDecoder.selectAudioTrack(result);
    }
    decodeDemuxedAudioTrack(file, track) {
        return this.audioDecoder.decodeDemuxedAudioTrack(file, track);
    }
    decodeAudioToBuffer(file, inputFormat) {
        return this.audioDecoder.decodeAudioToBuffer(file, inputFormat);
    }
    extractAudio(file, format, preDecodedBuffer, inputFormat) {
        return this.audioEncoder.extractAudio(file, format, preDecodedBuffer, inputFormat);
    }
}
