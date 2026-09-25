import { ConversionContext, requireConversionComponent } from './conversion/context.js';
import { reportConversionMetadata } from './conversion/metadata.js';
import { normalizePipelineConfig } from './core/pipeline-config.js';
import { PipelinePlanner } from './core/pipeline-planner.js';
import { PipelineRemuxPlanner } from './core/pipeline-remux-planner.js';
import { PipelineMuxerFactory } from './core/pipeline-muxer-factory.js';
import { canMuxCodec } from './core/mux-codecs.js';
import { sampleAt, sampleCount } from './demux/sample-index.js';
import { DemuxerRegistry } from './demux/registry.js';
import { MemorySink } from './io/sinks.js';
import { BlobSource, RangeSource } from './io/sources.js';
import { MediaForgeError } from './core/errors.js';
import { logger } from './core/logger.js';
import { assertAlphaCopy, matroskaOutputMetadata } from './core/track-metadata.js';
import { yieldToEventLoop } from './audio/audio-buffer-tools.js';
import { drainSink, assertSink } from './io/sink-backpressure.js';
import { createCancellableSink } from './io/cancellable-sink.js';
import { awaitWithAbort, linkAbortSignals } from './core/abort.js';
import { ReadableStreamSink } from './io/readable-stream-sink.js';
import { assertSinkContainerSupport, assertSinkTrackSupport } from './core/pipeline-sink-policy.js';
import { copiedAudioTrackConfig, copiedVideoTrackConfig, matroskaAudioWindowFitsFinalPacket, sourceAudioWindow, } from './core/pipeline-track-config.js';
const MP4_FAMILY = new Set(['mp4', 'mov', '3gp', 'm4v', 'm4a']);
export function toInputBlob(input) {
    if (input instanceof Blob)
        return input;
    if (input instanceof ArrayBuffer)
        return new Blob([input]);
    if (ArrayBuffer.isView(input))
        return new Blob([input]);
    throw new MediaForgeError('expected a File, Blob, ArrayBuffer, or ArrayBufferView input', 'FORMAT');
}
function toPipelineInput(input) {
    if (input && typeof input.read === 'function')
        return new RangeSource(input);
    return toInputBlob(input);
}
function pipelineSource(input, signal) {
    const source = input instanceof Blob ? new BlobSource(input) : input;
    return {
        size: source.size,
        async read(offset, length) {
            if (signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            const bytes = await awaitWithAbort(source.read(offset, length), signal);
            if (signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            return bytes;
        },
    };
}
export class Pipeline {
    externalSink = null;
    running = false;
    operationFailure = null;
    runAudioLanguage;
    runVideoLanguage;
    runTitle;
    runVideoColour;
    audioComponent;
    get audio() {
        return requireConversionComponent(this.audioComponent, 'pipeline audio');
    }
    components;
    videoComponent;
    get video() {
        return requireConversionComponent(this.videoComponent, 'pipeline video');
    }
    domComponent;
    get dom() {
        return requireConversionComponent(this.domComponent, 'DOM fallback');
    }
    planner;
    remuxPlanner;
    muxerFactory;
    beginRun(entry) {
        if (this.running) {
            throw new MediaForgeError(`${entry}() is already running on this Pipeline. Overlapping runs on one instance ` +
                'share the sink and native-fallback state and would interleave two outputs into ' +
                'one destination. Create a separate Pipeline per concurrent run. The rejected ' +
                "call's sink is not touched: ownership is only taken once a run is accepted.", 'FORMAT');
        }
        this.running = true;
        this.operationFailure = null;
        this.lastNativeError = null;
        this.runAudioLanguage = this.cfg.audioLanguage;
        this.runVideoLanguage = this.cfg.videoLanguage;
        this.runVideoColour = this.cfg.videoColour;
        this.runTitle = undefined;
    }
    async runToSink(input, sink) {
        assertSink(sink);
        const prepared = toPipelineInput(input);
        this.beginRun('runToSink');
        const originalSignal = this.cfg.signal;
        let linked;
        let output;
        let observingFailure = true;
        try {
            linked = linkAbortSignals(originalSignal, sink.signal);
            this.cfg.signal = linked.signal;
            output = createCancellableSink(sink, linked.signal, (reason, aborted) => {
                if (observingFailure)
                    this.recordFailure(reason, aborted);
            });
            this.externalSink = output;
            this.checkAbort();
            assertSinkContainerSupport(this.cfg, output);
            await this.runInner(prepared);
            this.checkAbort();
        }
        catch (e) {
            const finalError = this.operationFailure
                ? this.operationFailure.reason
                : e instanceof MediaForgeError
                    ? e
                    : this.cfg.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')
                        ? new MediaForgeError('Aborted', 'ABORT')
                        : e;
            try {
                await output?.abort(finalError);
            }
            catch { }
            throw finalError;
        }
        finally {
            observingFailure = false;
            linked?.dispose();
            this.cfg.signal = originalSignal;
            this.running = false;
            this.operationFailure = null;
            this.externalSink = null;
        }
    }
    runToReadableStream(input, options = {}) {
        const sink = new ReadableStreamSink(options);
        void this.runToSink(input, sink).catch(error => sink.abort(error));
        return sink.stream;
    }
    lastNativeError = null;
    cfg;
    constructor(cfg, options = {}) {
        cfg = normalizePipelineConfig(cfg);
        this.components = new ConversionContext(options, cfg.metadataPolicy);
        this.cfg = cfg;
        this.planner = new PipelinePlanner(cfg);
        this.remuxPlanner = new PipelineRemuxPlanner(cfg);
        this.muxerFactory = new PipelineMuxerFactory(cfg, {
            title: () => this.runTitle,
            videoColour: () => this.runVideoColour,
            audioLanguage: () => this.runAudioLanguage,
            videoLanguage: () => this.runVideoLanguage,
            hasExternalSink: () => this.externalSink !== null,
            estimateFps: samples => this.estimateFps(samples),
            estimateFpsFromDurations: samples => this.estimateFpsFromDurations(samples),
        }, this.components.writers);
        this.audioComponent = this.components.options.pipelineAudio?.({
            get signal() {
                return cfg.signal;
            },
            audioBitrateFor: () => this.audioBitrateFor(),
            targetAudioParams: (rate, channels, codec) => this.targetAudioParams(rate, channels, codec),
            hasDynamicCodecConfiguration: track => this.hasDynamicCodecConfiguration(track),
            sourceAudioShape: track => this.sourceAudioShape(track),
            sourceAudioWindow,
            report: (percent, message) => this.report(percent, message),
            checkAbort: () => this.checkAbort(),
            yield: () => this.yield(),
        });
        this.videoComponent = this.components.options.pipelineVideo?.({
            get signal() {
                return cfg.signal;
            },
            videoBitrateFor: () => this.videoBitrateFor(),
            encoderFps: samples => this.encoderFps(samples),
            targetVideoDimensions: (width, height) => this.targetVideoDimensions(width, height),
            videoPayloadForSample: (track, sample, payload, previousConfigIndex) => this.videoPayloadForSample(track, sample, payload, previousConfigIndex),
            report: (percent, message) => this.report(percent, message),
            checkAbort: () => this.checkAbort(),
            yield: () => this.yield(),
        });
        this.domComponent = this.components.options.pipelineDom?.(cfg, {
            encoderFps: () => this.encoderFps(),
            targetVideoDimensions: (width, height) => this.targetVideoDimensions(width, height),
            targetAudioParams: (rate, channels, codec) => this.targetAudioParams(rate, channels, codec),
            videoBitrateFor: () => this.videoBitrateFor(),
            makeMuxer: (format, sink, videoCodec, audioCodec, hasVideo, hasAudio, width, height, sampleRate, channels) => this.makeMuxer(format, sink, null, null, videoCodec, audioCodec, hasVideo, hasAudio, width, height, sampleRate, channels),
            encodeAudioBuffer: (audio, codec, muxer) => this.encodeAudioBuffer(audio, codec, muxer),
            report: (percent, message) => this.report(percent, message),
            checkAbort: () => this.checkAbort(),
            yield: () => this.yield(),
        });
    }
    videoBitrateFor() {
        return this.planner.videoBitrateFor();
    }
    audioBitrateFor() {
        return this.planner.audioBitrateFor();
    }
    targetAudioParams(sourceRate, sourceChannels, codec) {
        return this.planner.targetAudioParams(sourceRate, sourceChannels, codec);
    }
    hasDynamicCodecConfiguration(track) {
        return this.planner.hasDynamicCodecConfiguration(track);
    }
    sourceAudioShape(track) {
        return this.planner.sourceAudioShape(track);
    }
    videoPayloadForSample(track, sample, payload, previousConfigIndex) {
        return this.planner.videoPayloadForSample(track, sample, payload, previousConfigIndex);
    }
    estimateFps(samples) {
        return this.planner.estimateFps(samples);
    }
    encoderFps(samples) {
        return this.planner.encoderFps(samples);
    }
    estimateFpsFromDurations(samples) {
        return this.planner.estimateFpsFromDurations(samples);
    }
    targetVideoDimensions(sourceWidth, sourceHeight) {
        return this.planner.targetVideoDimensions(sourceWidth, sourceHeight);
    }
    async run(input) {
        const prepared = toPipelineInput(input);
        this.beginRun('run');
        try {
            this.checkAbort();
            const result = await this.runInner(prepared);
            this.checkAbort();
            return result;
        }
        catch (error) {
            if (this.operationFailure)
                throw this.operationFailure.reason;
            if (error instanceof MediaForgeError)
                throw error;
            if (this.isAbort(error))
                throw new MediaForgeError('Aborted', 'ABORT');
            throw error;
        }
        finally {
            this.running = false;
            this.operationFailure = null;
        }
    }
    async runInner(input) {
        const source = pipelineSource(input, this.cfg.signal);
        const inputFmt = await awaitWithAbort(DemuxerRegistry.detectFromSource(source, this.cfg.signal), this.cfg.signal);
        const outFmt = this.cfg.outputFormat;
        this.components.assertFormats(inputFmt, outFmt);
        const demuxer = this.chooseDemuxer(inputFmt);
        if (demuxer) {
            try {
                if (this.cfg.preDemuxedError !== undefined)
                    throw this.cfg.preDemuxedError;
                return await this.runWebCodecsGeneric(source, outFmt, demuxer, inputFmt);
            }
            catch (e) {
                if (this.operationFailure)
                    throw this.operationFailure.reason;
                if (this.isAbort(e))
                    throw e;
                if (e instanceof MediaForgeError && ['FORMAT', 'IO', 'MUX', 'OUTPUT', 'OOM'].includes(e.code))
                    throw e;
                const detail = e instanceof Error ? e.message : String(e);
                logger.warn(this.cfg.allowDomFallback && input instanceof Blob
                    ? `[Pipeline] native pipeline (${inputFmt}) failed, falling back to DOM: ${detail}`
                    : `[Pipeline] native pipeline (${inputFmt}) failed and DOM fallback is disabled: ${detail}`);
                this.lastNativeError = e;
            }
        }
        this.checkAbort();
        if (!this.cfg.allowDomFallback) {
            const orig = this.lastNativeError;
            const origCode = orig instanceof MediaForgeError ? orig.code : 'DECODE';
            throw new MediaForgeError('Native pipeline failed and the media-element fallback is disabled. ' +
                'Pass allowDomFallback: true to opt in to the slower DOM re-encode path. ' +
                `Original error: ${orig instanceof Error ? orig.message : String(orig ?? 'unknown')}`, origCode);
        }
        if (this.externalSink) {
            const orig = this.lastNativeError;
            const origCode = orig instanceof MediaForgeError ? orig.code : 'DECODE';
            throw new MediaForgeError('Native pipeline failed; the opted-in media-element fallback is buffered and cannot ' +
                'honor runToSink()/convertToSink() without reordering video and audio. Use run()/convert() ' +
                'or choose a codec/container supported by the native pipeline. ' +
                `Original error: ${orig instanceof Error ? orig.message : String(orig ?? 'unknown')}`, origCode);
        }
        if (!(input instanceof Blob)) {
            const orig = this.lastNativeError;
            throw new MediaForgeError('The media-element fallback requires Blob or File input; Source input uses the native pipeline. ' +
                `Original error: ${orig instanceof Error ? orig.message : String(orig ?? 'unknown')}`, orig instanceof MediaForgeError ? orig.code : 'DECODE');
        }
        return this.runDOM(input, outFmt);
    }
    chooseDemuxer(fmt) {
        return this.components.demuxer(fmt);
    }
    async runWebCodecsGeneric(source, fmt, demuxer, inputFmt) {
        this.report(5, 'Demuxing...');
        const result = this.cfg.preDemuxed ?? (await demuxer.demux(source, this.cfg.signal));
        this.runTitle = result.title ?? result.matroskaPassThrough?.title;
        if (this.externalSink)
            assertSinkTrackSupport(result);
        const srcV = result.videoTracks[0] ?? null;
        const audioIdx = this.cfg.audioTrackIndex ?? 0;
        if (this.cfg.audioTrackIndex !== undefined &&
            (!Number.isInteger(audioIdx) || audioIdx < 0 || audioIdx >= result.audioTracks.length)) {
            throw new MediaForgeError(`audioTrackIndex ${audioIdx} is out of range (input has ${result.audioTracks.length} audio track(s))`, 'FORMAT');
        }
        if (result.audioTracks.length > 1 && this.cfg.audioTrackIndex !== undefined) {
            logger.warn(`[Pipeline] input has ${result.audioTracks.length} audio tracks; using #${audioIdx} (set audioTrackIndex to choose)`);
        }
        const srcA = result.audioTracks[audioIdx] ?? null;
        if (!srcV && !srcA)
            throw new MediaForgeError('No tracks found', 'DECODE');
        const extraVideoSources = [];
        if ((result.videoTracks?.length ?? 0) > 1) {
            for (let i = 1; i < result.videoTracks.length; i++) {
                const track = result.videoTracks[i];
                if (!(MP4_FAMILY.has(fmt) || fmt === 'mkv' || fmt === 'webm') ||
                    !this.canDirectRemuxVideo(inputFmt, fmt, track, track.codec)) {
                    throw new MediaForgeError(`Secondary video track #${i} (${track.codec}) cannot be copied into ${fmt} with the requested settings; select tracks with Workflow`, 'FORMAT');
                }
                extraVideoSources.push(track);
            }
        }
        const extraAudioSources = [];
        const extraCapable = MP4_FAMILY.has(fmt) || fmt === 'mkv' || fmt === 'webm' || fmt === 'ts';
        if (extraCapable && this.cfg.audioTrackIndex === undefined) {
            for (let i = 0; i < result.audioTracks.length; i++) {
                if (i === audioIdx)
                    continue;
                const t = result.audioTracks[i];
                const c = t.codec || '';
                if (!canMuxCodec(fmt, 'audio', c)) {
                    throw new MediaForgeError(`Secondary audio track #${i} (${c}) cannot be copied into ${fmt}; select audioTrackIndex to transcode one track`, 'FORMAT');
                }
                if ((fmt === 'mkv' || fmt === 'webm') && !matroskaAudioWindowFitsFinalPacket(t)) {
                    throw new MediaForgeError(`Secondary audio track #${i} has a trailing edit that crosses its final packet; ` +
                        `${fmt} cannot preserve it without transcoding that secondary track`, 'FORMAT');
                }
                extraAudioSources.push(t);
            }
        }
        else if (result.audioTracks.length > 1 && this.cfg.audioTrackIndex === undefined) {
            throw new MediaForgeError(`Secondary audio tracks cannot be preserved in ${fmt}; select audioTrackIndex to use one track`, 'FORMAT');
        }
        const subtitleCapable = fmt === 'mkv' ||
            (fmt === 'webm' &&
                (result.subtitleTracks ?? []).every(t => t.codec === 'text/webvtt' || t.codec === 'text/utf8'));
        const subtitleTracks = subtitleCapable ? (result.subtitleTracks ?? []) : [];
        const selectedTracks = [srcV, srcA, ...extraVideoSources, ...extraAudioSources, ...subtitleTracks].filter((track) => track !== null);
        this.runAudioLanguage ??= srcA?.language;
        this.runVideoLanguage ??= srcV?.language;
        this.runVideoColour ??= srcV?.colour;
        reportConversionMetadata(result, fmt, selectedTracks.map(track => ({
            id: track.id,
            matroskaTrackUid: track.matroskaTrackUid,
            name: track.name,
            title: track.title,
            default: track.default,
            forced: track.forced,
            commentary: track.commentary,
            language: track === srcA ? this.runAudioLanguage : track === srcV ? this.runVideoLanguage : track.language,
        })), this.cfg.metadataPolicy, 'Pipeline');
        const resolvedCodecs = this.planner.resolveRunCodecs(fmt, srcV, srcA);
        const directVideo = !!srcV && this.canDirectRemuxVideo(inputFmt, fmt, srcV, resolvedCodecs.video);
        const directAudio = !!srcA && this.canDirectRemuxAudio(inputFmt, fmt, srcA, resolvedCodecs.audio);
        const vCodec = directVideo ? srcV.codec : resolvedCodecs.video;
        const aCodec = directAudio ? srcA.codec : resolvedCodecs.audio;
        const directAudioStart = srcA && directAudio ? this.directAudioStartIndex(srcA, fmt) : 0;
        if (fmt === 'ts' &&
            extraAudioSources.length > 0 &&
            (!directAudio ||
                (srcV && !directVideo) ||
                extraAudioSources.some(track => !this.canDirectRemuxAudio(inputFmt, fmt, track, track.codec)))) {
            throw new MediaForgeError('TS with multiple audio tracks requires packet copy; select audioTrackIndex before transcoding', 'FORMAT');
        }
        const interleaveTransport = fmt === 'ts' && (!srcV || directVideo) && (!srcA || directAudio);
        for (const track of [srcV, srcA, ...extraVideoSources, ...extraAudioSources]) {
            if (!track)
                continue;
            assertAlphaCopy(track, fmt, track === srcV ? directVideo : true);
        }
        if (srcV && !directVideo) {
            this.targetVideoDimensions(srcV.width || 0, srcV.height || 0);
            if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
                throw new MediaForgeError('Video WebCodecs are unavailable for transcoding', 'DECODE');
            }
            const WEBCODECS_VIDEO = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp8', 'vp09', 'vp9', 'av01'];
            if (!WEBCODECS_VIDEO.some(c => srcV.codec.startsWith(c))) {
                throw new MediaForgeError(`WebCodecs does not support video codec: ${srcV.codec}`, 'DECODE');
            }
            try {
                const support = await VideoDecoder.isConfigSupported({
                    codec: srcV.codec,
                    codedWidth: srcV.width || 1920,
                    codedHeight: srcV.height || 1080,
                    ...(srcV.codecConfig ? { description: srcV.codecConfig } : {}),
                });
                if (!support.supported) {
                    throw new MediaForgeError(`VideoDecoder does not support: ${srcV.codec}`, 'DECODE');
                }
            }
            catch (e) {
                if (e instanceof MediaForgeError)
                    throw e;
                throw new MediaForgeError(`Codec check failed: ${srcV.codec}`, 'DECODE');
            }
        }
        if (srcA &&
            !directAudio &&
            typeof AudioDecoder === 'undefined' &&
            !(srcA.codec.startsWith('mp4a') ||
                srcA.codec === 'aac' ||
                srcA.codec === 'pcm' ||
                srcA.codec.startsWith('pcm-'))) {
            throw new MediaForgeError('Audio WebCodecs are unavailable for transcoding', 'DECODE');
        }
        const sink = this.externalSink ?? new MemorySink();
        const dynamicAudioShape = srcA ? this.sourceAudioShape(srcA) : null;
        const audioOut = srcA && !directAudio
            ? this.targetAudioParams(dynamicAudioShape?.rate ?? srcA.sampleRate, dynamicAudioShape?.channels ?? srcA.channelCount, aCodec)
            : null;
        const videoOut = srcV && !directVideo ? this.targetVideoDimensions(srcV.width, srcV.height) : null;
        if ((result.subtitleTracks?.length ?? 0) > 0 && !subtitleCapable) {
            logger.warn(`[Pipeline] ${result.subtitleTracks.length} subtitle track(s) preserved for mkv output only; dropping for ${fmt}`);
        }
        const muxer = this.makeMuxer(fmt, sink, srcV, srcA, vCodec, aCodec, false, false, videoOut?.w ?? 0, videoOut?.h ?? 0, audioOut?.rate ?? 0, audioOut?.channels ?? 0, directVideo, directAudio, subtitleTracks, extraVideoSources.map(copiedVideoTrackConfig), extraAudioSources.map(track => copiedAudioTrackConfig(track, fmt)));
        if ((fmt === 'mkv' || fmt === 'webm') && result.matroskaPassThrough) {
            muxer.setMatroskaPassThrough?.(matroskaOutputMetadata(result.matroskaPassThrough, fmt, selectedTracks));
        }
        if (extraVideoSources.length > 0 && !muxer.addExtraVideoChunk)
            throw new MediaForgeError('Selected muxer cannot preserve additional video tracks', 'FORMAT');
        if (extraVideoSources.length > 0 && muxer.addExtraVideoChunk) {
            for (let ti = 0; ti < extraVideoSources.length; ti++) {
                const track = extraVideoSources[ti];
                let previousConfigIndex = null;
                for (let index = 0, count = sampleCount(track); index < count; index++) {
                    this.checkAbort();
                    const sample = sampleAt(track, index);
                    const data = sample.data ?? (await source.read(sample.offset, sample.size));
                    const payload = this.planner.videoPayloadForSample(track, sample, data, previousConfigIndex);
                    previousConfigIndex = payload.configIndex;
                    muxer.addExtraVideoChunk(ti, {
                        data: payload.data,
                        alphaData: sample.alphaOffset === undefined
                            ? undefined
                            : await source.read(sample.alphaOffset, sample.alphaSize),
                        timestamp: sample.timestamp,
                        decodeTimestamp: sample.decodeTimestamp,
                        compositionTimeOffset: sample.compositionTimeOffset,
                        duration: sample.duration,
                        isKeyframe: sample.isKeyframe ?? true,
                        trackType: 'video',
                    }, payload.codecConfig);
                    await this.drainOutput();
                    if ((index & 63) === 0)
                        await yieldToEventLoop();
                }
            }
        }
        if (extraAudioSources.length > 0 && !muxer.addExtraAudioChunk) {
            throw new MediaForgeError('Selected muxer cannot preserve additional audio tracks', 'FORMAT');
        }
        if (!interleaveTransport && extraAudioSources.length > 0 && muxer.addExtraAudioChunk) {
            for (let ti = 0; ti < extraAudioSources.length; ti++) {
                const track = extraAudioSources[ti];
                for (let index = 0, count = sampleCount(track); index < count; index++) {
                    this.checkAbort();
                    const sample = sampleAt(track, index);
                    const data = sample.data ?? (await source.read(sample.offset, sample.size));
                    muxer.addExtraAudioChunk(ti, {
                        data,
                        timestamp: sample.timestamp,
                        duration: sample.duration,
                        isKeyframe: true,
                        trackType: 'audio',
                    }, track.codecConfig);
                    await this.drainOutput();
                    if ((index & 63) === 0)
                        await yieldToEventLoop();
                }
            }
        }
        if (interleaveTransport) {
            this.report(10, 'Remuxing tracks...');
            await this.remuxInterleaved(srcV, srcA ? [srcA, ...extraAudioSources] : [], source, muxer, directAudioStart);
        }
        else if (srcV && srcA && directVideo && directAudio) {
            this.report(10, 'Remuxing A/V...');
            this.wireAudioPadding(srcA, muxer, fmt);
            await this.remuxInterleaved(srcV, [srcA], source, muxer, directAudioStart);
        }
        else if (srcV) {
            if (directVideo) {
                this.report(10, 'Remuxing video...');
                await this.remuxVideoTrack(srcV, source, muxer);
            }
            else {
                this.report(10, 'Encoding video...');
                await this.pipeVideo(srcV, source, vCodec, fmt, muxer);
            }
        }
        if (srcA && !interleaveTransport && !(srcV && directVideo && directAudio)) {
            if (directAudio) {
                this.report(80, 'Remuxing audio...');
                this.wireAudioPadding(srcA, muxer, fmt);
                await this.remuxAudioTrack(srcA, source, muxer, directAudioStart);
            }
            else {
                this.report(80, 'Encoding audio...');
                await this.pipeAudio(srcA, source, aCodec, muxer);
            }
        }
        if (subtitleTracks.length > 0 && muxer.addSubtitleChunk) {
            for (let t = 0; t < subtitleTracks.length; t++) {
                for (let index = 0, count = sampleCount(subtitleTracks[t]); index < count; index++) {
                    const cue = sampleAt(subtitleTracks[t], index);
                    const data = cue.data ?? (await source.read(cue.offset, cue.size));
                    muxer.addSubtitleChunk({
                        data,
                        timestamp: cue.timestamp,
                        duration: cue.duration,
                        isKeyframe: true,
                        trackType: 'subtitle',
                    }, t);
                }
            }
        }
        this.report(100, 'Finalizing output...');
        this.checkAbort();
        await muxer.finalize();
        if (this.externalSink)
            return new Blob([]);
        return sink.toBlob(DemuxerRegistry.getMimeType(fmt));
    }
    canDirectRemuxVideo(inputFormat, outputFormat, track, outputCodec) {
        return this.remuxPlanner.canDirectRemuxVideo(inputFormat, outputFormat, track, outputCodec);
    }
    canDirectRemuxAudio(inputFormat, outputFormat, track, outputCodec) {
        return this.remuxPlanner.canDirectRemuxAudio(inputFormat, outputFormat, track, outputCodec);
    }
    directAudioStartIndex(track, format) {
        return this.remuxPlanner.directAudioStartIndex(track, format);
    }
    wireAudioPadding(track, muxer, format) {
        this.remuxPlanner.wireAudioPadding(track, muxer, format);
    }
    async remuxInterleaved(srcV, audioTracks, source, muxer, audioStartIndex = 0) {
        let vi = 0;
        const audioIndices = new Uint32Array(audioTracks.length);
        if (audioTracks.length)
            audioIndices[0] = audioStartIndex;
        let lastVDts = Number.NEGATIVE_INFINITY;
        let lastVideoConfigIndex = null;
        let droppedV = 0;
        const total = (srcV ? sampleCount(srcV) : 0) +
            audioTracks.reduce((sum, track, index) => sum + Math.max(0, sampleCount(track) - audioIndices[index]), 0);
        let done = 0;
        while (true) {
            this.checkAbort();
            const v = srcV ? sampleAt(srcV, vi) : undefined;
            let audioIndex = -1;
            let a;
            let aKey = Number.POSITIVE_INFINITY;
            for (let i = 0; i < audioTracks.length; i++) {
                const candidate = sampleAt(audioTracks[i], audioIndices[i]);
                if (!candidate)
                    continue;
                const key = candidate.decodeTimestamp ?? candidate.timestamp;
                if (audioIndex < 0 || key < aKey) {
                    audioIndex = i;
                    a = candidate;
                    aKey = key;
                }
            }
            if (!v && !a)
                break;
            const vKey = v ? (v.decodeTimestamp ?? v.timestamp) : Number.POSITIVE_INFINITY;
            if (v && srcV && vKey <= aKey) {
                vi++;
                const dts = v.decodeTimestamp ?? v.timestamp;
                if (v.leadingDiscard || dts <= lastVDts) {
                    droppedV++;
                    continue;
                }
                lastVDts = dts;
                const sourceData = v.data ?? (await source.read(v.offset, v.size));
                const prepared = this.videoPayloadForSample(srcV, v, sourceData, lastVideoConfigIndex);
                lastVideoConfigIndex = prepared.configIndex;
                muxer.addVideoChunk({
                    data: prepared.data,
                    timestamp: v.timestamp,
                    decodeTimestamp: v.decodeTimestamp,
                    alphaData: v.alphaOffset === undefined ? undefined : await source.read(v.alphaOffset, v.alphaSize),
                    compositionTimeOffset: v.compositionTimeOffset,
                    duration: v.duration,
                    isKeyframe: v.isKeyframe,
                    trackType: 'video',
                }, prepared.codecConfig);
                await this.drainOutput();
            }
            else if (a) {
                audioIndices[audioIndex]++;
                const track = audioTracks[audioIndex];
                const data = a.data ?? (await source.read(a.offset, a.size));
                const chunk = {
                    data,
                    timestamp: a.timestamp,
                    decodeTimestamp: a.decodeTimestamp,
                    duration: a.duration,
                    isKeyframe: true,
                    trackType: 'audio',
                };
                if (audioIndex === 0)
                    muxer.addAudioChunk(chunk, track.codecConfig);
                else
                    muxer.addExtraAudioChunk(audioIndex - 1, chunk, track.codecConfig);
                await this.drainOutput();
            }
            if ((++done & 63) === 0) {
                this.report(10 + Math.round((done / Math.max(total, 1)) * 80), `Remux ${done}/${total}`);
                await this.yield();
            }
        }
        if (droppedV > 0)
            logger.warn(`[Pipeline] remux dropped ${droppedV} leading/non-monotone video sample(s)`);
    }
    async remuxVideoTrack(src, source, muxer) {
        let lastDts = Number.NEGATIVE_INFINITY;
        let lastConfigIndex = null;
        let dropped = 0;
        const count = sampleCount(src);
        for (let index = 0; index < count; index++) {
            this.checkAbort();
            const sample = sampleAt(src, index);
            const dts = sample.decodeTimestamp ?? sample.timestamp;
            if (sample.leadingDiscard || dts <= lastDts) {
                dropped++;
                continue;
            }
            lastDts = dts;
            const sourceData = sample.data ?? (await source.read(sample.offset, sample.size));
            const prepared = this.videoPayloadForSample(src, sample, sourceData, lastConfigIndex);
            lastConfigIndex = prepared.configIndex;
            muxer.addVideoChunk({
                data: prepared.data,
                alphaData: sample.alphaOffset === undefined
                    ? undefined
                    : await source.read(sample.alphaOffset, sample.alphaSize),
                timestamp: sample.timestamp,
                decodeTimestamp: sample.decodeTimestamp,
                compositionTimeOffset: sample.compositionTimeOffset,
                duration: sample.duration,
                isKeyframe: sample.isKeyframe,
                trackType: 'video',
            }, prepared.codecConfig);
            await this.drainOutput();
            if ((index & 31) === 0) {
                this.report(10 + Math.round((index / Math.max(count, 1)) * 65), `Video ${index}/${count}`);
                await this.yield();
            }
        }
        if (dropped > 0)
            logger.warn(`[Pipeline] remux dropped ${dropped} leading/non-monotone video sample(s)`);
    }
    async remuxAudioTrack(src, source, muxer, startIndex = 0) {
        const count = sampleCount(src);
        for (let index = startIndex; index < count; index++) {
            this.checkAbort();
            const sample = sampleAt(src, index);
            const data = sample.data ?? (await source.read(sample.offset, sample.size));
            muxer.addAudioChunk({
                data,
                timestamp: sample.timestamp,
                duration: sample.duration,
                isKeyframe: true,
                trackType: 'audio',
            }, src.codecConfig);
            await this.drainOutput();
            if ((index & 63) === 0) {
                this.report(80 + Math.round((index / Math.max(count, 1)) * 15), `Audio ${index}/${count}`);
                await this.yield();
            }
        }
    }
    async pipeVideo(src, source, outCodec, fmt, muxer) {
        return this.video.pipeVideo(src, source, outCodec, fmt, muxer, this.cfg.fps);
    }
    pipeAudio(src, source, outCodec, muxer) {
        return this.audio.pipeAudio(src, source, outCodec, muxer);
    }
    async runDOM(input, fmt) {
        return this.dom.run(input, fmt);
    }
    encodeAudioBuffer(audioBuf, codec, muxer, startOffsetSeconds = 0) {
        return this.audio.encodeAudioBuffer(audioBuf, codec, muxer, startOffsetSeconds);
    }
    makeMuxer(format, sink, sourceVideo, sourceAudio, videoCodec, audioCodec, forceVideo = false, forceAudio = false, overrideWidth = 0, overrideHeight = 0, overrideSampleRate = 0, overrideChannels = 0, videoCopy = false, audioCopy = false, subtitleTracks = [], extraVideoTracks = undefined, extraAudioTracks = undefined) {
        return this.muxerFactory.makeMuxer(format, sink, sourceVideo, sourceAudio, videoCodec, audioCodec, forceVideo, forceAudio, overrideWidth, overrideHeight, overrideSampleRate, overrideChannels, videoCopy, audioCopy, subtitleTracks, extraVideoTracks, extraAudioTracks);
    }
    report(pct, msg) {
        this.checkAbort();
        if (this.operationFailure)
            throw this.operationFailure.reason;
        try {
            this.cfg.onProgress?.(pct, msg);
        }
        catch (reason) {
            this.recordFailure(reason);
            throw reason;
        }
        this.checkAbort();
    }
    recordFailure(reason, aborted = this.cfg.signal?.aborted) {
        if (this.running && !aborted)
            this.operationFailure ??= { reason };
    }
    checkAbort() {
        if (this.cfg.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    }
    isAbort(e) {
        if (this.cfg.signal?.aborted)
            return true;
        if (e instanceof MediaForgeError && e.code === 'ABORT')
            return true;
        return e instanceof DOMException && e.name === 'AbortError';
    }
    async yield() {
        await yieldToEventLoop();
        if (this.externalSink)
            await drainSink(this.externalSink, this.cfg.signal);
        else
            this.cfg.signal?.throwIfAborted();
    }
    async drainOutput() {
        if (this.externalSink)
            await drainSink(this.externalSink, this.cfg.signal);
        else
            this.cfg.signal?.throwIfAborted();
    }
}
