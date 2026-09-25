import { Pipeline } from '../pipeline-core.js';
import { ConversionContext } from '../conversion/context.js';
import { pipelineAudio } from '../conversion/pipeline-audio.js';
import { pipelineVideo } from '../conversion/pipeline-video.js';
import { mediaFileState } from '../engine/file-state.js';
import { bindCompactSampleIndex, getCompactSampleIndex, sampleAt, sampleCount } from '../demux/sample-index.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { MediaForgeError } from '../core/errors.js';
import { PipelinePlanner } from '../core/pipeline-planner.js';
import { awaitWithAbort, linkAbortSignals } from '../core/abort.js';
import { webCodecsAudioCodec } from '../core/codec-strings.js';
import { nativeConversionOptions } from './transcode-mux.js';
import { nativeConversionPlan, freshDiagnostics, forwardDiagnostics, } from './transcode-plan.js';
function pipelineTrack(track) {
    const output = {};
    for (const key of Object.keys(track)) {
        if (key !== 'samples')
            Reflect.set(output, key, Reflect.get(track, key));
    }
    const index = getCompactSampleIndex(track);
    if (index)
        bindCompactSampleIndex(output, index);
    else
        output.samples = track.samples;
    return output;
}
async function codecSupport(operation, signal, code) {
    try {
        return await awaitWithAbort(operation(), signal);
    }
    catch (error) {
        if (signal.aborted || error instanceof MediaForgeError)
            throw error;
        throw new MediaForgeError(`Native codec configuration was rejected: ${error instanceof Error ? error.message : String(error)}`, code);
    }
}
async function checkCapabilities(plan, signal) {
    const planner = new PipelinePlanner(plan.config);
    if (plan.video && !plan.videoCopy) {
        const track = plan.video.info;
        const configs = track.codecConfigurations?.length ? track.codecConfigurations : [track];
        for (const config of configs) {
            const supported = await codecSupport(() => VideoDecoder.isConfigSupported({
                codec: config.codec,
                codedWidth: config.width ?? track.width,
                codedHeight: config.height ?? track.height,
                ...(config.codecConfig ? { description: config.codecConfig } : {}),
            }), signal, 'DECODE');
            if (!supported.supported)
                throw new MediaForgeError(`VideoDecoder does not support '${config.codec}'`, 'DECODE');
        }
        const { w, h } = planner.targetVideoDimensions(track.width, track.height);
        const supported = await codecSupport(() => VideoEncoder.isConfigSupported({
            codec: plan.config.videoCodec,
            width: w,
            height: h,
            bitrate: planner.videoBitrateFor(),
            framerate: planner.encoderFps(Array.from({ length: Math.min(121, sampleCount(track)) }, (_, index) => sampleAt(track, index))),
            ...(plan.config.videoCodec.startsWith('avc')
                ? {
                    avc: {
                        format: (['mp4', 'mov', '3gp', 'm4v', 'flv'].includes(plan.config.outputFormat)
                            ? 'avc'
                            : 'annexb'),
                    },
                }
                : {}),
        }), signal, 'ENCODE');
        if (!supported.supported)
            throw new MediaForgeError(`VideoEncoder does not support '${plan.config.videoCodec}'`, 'ENCODE');
    }
    if (plan.audio && !plan.audioCopy) {
        const track = plan.audio.info;
        if (!plan.nativeAudioDecode) {
            const configs = track.codecConfigurations?.length ? track.codecConfigurations : [track];
            for (const config of configs) {
                const supported = await codecSupport(() => AudioDecoder.isConfigSupported({
                    codec: webCodecsAudioCodec(config.codec),
                    sampleRate: config.sampleRate ?? track.sampleRate,
                    numberOfChannels: config.channelCount ?? track.channelCount,
                    ...(config.codecConfig ? { description: config.codecConfig } : {}),
                }), signal, 'DECODE');
                if (!supported.supported)
                    throw new MediaForgeError(`AudioDecoder does not support '${config.codec}'`, 'DECODE');
            }
        }
        if (!plan.nativeAudioEncode) {
            const shape = planner.sourceAudioShape(track);
            const target = planner.targetAudioParams(shape.rate, shape.channels, plan.config.audioCodec);
            const supported = await codecSupport(() => AudioEncoder.isConfigSupported({
                codec: plan.config.audioCodec,
                sampleRate: target.rate,
                numberOfChannels: target.channels,
                bitrate: planner.audioBitrateFor(),
            }), signal, 'ENCODE');
            if (!supported.supported)
                throw new MediaForgeError(`AudioEncoder does not support '${plan.config.audioCodec}'`, 'ENCODE');
        }
    }
}
export function createNativeVideoTransform(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('Expected native conversion options', 'INPUT');
    const { formats, maxInputBytes } = options;
    if (maxInputBytes !== undefined && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1))
        throw new MediaForgeError('maxInputBytes must be a positive safe integer', 'INPUT');
    const context = new ConversionContext({ formats, pipelineAudio, pipelineVideo });
    return Object.freeze({
        probe(file, request, diagnostics) {
            nativeConversionPlan(file, request, context, maxInputBytes, diagnostics);
            return {
                supported: true,
                operation: 'convert',
                outputFormat: request.format,
                warnings: diagnostics.warnings,
            };
        },
        async write(file, sink, request, diagnostics) {
            const state = mediaFileState(file);
            const local = freshDiagnostics(diagnostics);
            const plan = nativeConversionPlan(file, request, context, maxInputBytes, local);
            forwardDiagnostics(local, diagnostics);
            const linked = linkAbortSignals(state.signal, request.signal, sink.signal);
            try {
                if (plan.copy) {
                    const delivered = new DiagnosticContext({
                        validation: diagnostics.validation,
                        metadataPolicy: diagnostics.metadataPolicy,
                        onWarning: warning => {
                            const pending = freshDiagnostics(diagnostics);
                            pending.warn(warning);
                            forwardDiagnostics(pending, diagnostics);
                        },
                    });
                    const count = plan.tracks.reduce((total, track) => total + track.description.sampleCount, 0);
                    await state.remux(sink, {
                        format: request.format,
                        trackIds: plan.tracks.map(track => track.description.id),
                        signal: linked.signal,
                        onProgress: request.onProgress
                            ? value => request.onProgress({
                                fraction: Math.min(1, value.packets / count),
                                message: 'Copying media packets',
                                ...value,
                            })
                            : undefined,
                    }, delivered);
                    return;
                }
                await checkCapabilities(plan, linked.signal);
                const result = {
                    title: state.title,
                    videoTracks: plan.video ? [pipelineTrack(plan.video.info)] : [],
                    audioTracks: plan.audio ? [pipelineTrack(plan.audio.info)] : [],
                    matroskaPassThrough: state.matroskaPassThrough,
                    matroskaUnsupportedTags: state.matroskaUnsupportedTags,
                };
                await new Pipeline({ ...plan.config, signal: linked.signal, preDemuxed: result }, nativeConversionOptions(context, plan, state.title)).runToSink(state.source, sink);
            }
            finally {
                linked.dispose();
            }
        },
    });
}
