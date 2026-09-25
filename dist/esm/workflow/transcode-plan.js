import { mediaFileState } from '../engine/file-state.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { MediaForgeError } from '../core/errors.js';
import { normalizePipelineConfig } from '../core/pipeline-config.js';
import { PipelinePlanner } from '../core/pipeline-planner.js';
import { PipelineRemuxPlanner } from '../core/pipeline-remux-planner.js';
import { CONTAINER_CODEC_PLANS, assertAudioEncodeRequest, resolveSupportedCodec } from '../core/format-plans.js';
import { codecFamily, mp4aAudioObjectType } from '../core/codec-strings.js';
import { assertMuxCodec } from '../core/mux-codecs.js';
import { assertAlphaCopy } from '../core/track-metadata.js';
import { parseAacAudioSpecificConfig } from '../audio/adts.js';
import { AAC_SAMPLE_RATES } from '../audio/aac-tables.js';
export function freshDiagnostics(context) {
    return new DiagnosticContext({ validation: context.validation, metadataPolicy: context.metadataPolicy });
}
export function forwardDiagnostics(from, to) {
    for (const warning of from.warnings) {
        if (!to.warnings.some(entry => entry.code === warning.code &&
            entry.trackId === warning.trackId &&
            entry.format === warning.format &&
            entry.message === warning.message))
            to.warn(warning);
    }
}
function sameCodec(source, requested) {
    if (requested === undefined)
        return true;
    const input = source.toLowerCase();
    const output = requested.toLowerCase();
    return (input === output ||
        input.replace(/^avc3/, 'avc1') === output.replace(/^avc3/, 'avc1') ||
        (!output.includes('.') && codecFamily(input) === codecFamily(output)));
}
function unchanged(track, request) {
    if (track.type === 'video')
        return (!request.fps &&
            !request.videoBitrate &&
            (!request.width || request.width === track.info.width) &&
            (!request.height || request.height === track.info.height) &&
            sameCodec(track.info.codec, request.videoCodec));
    if (track.type === 'audio')
        return (!request.audioBitrate &&
            (!request.audioSampleRate || request.audioSampleRate === track.info.sampleRate) &&
            (!request.audioChannels || request.audioChannels === track.info.channelCount) &&
            sameCodec(track.info.codec, request.audioCodec));
    return true;
}
export function nativeConversionPlan(file, request, context, maxInputBytes, diagnostics) {
    const state = mediaFileState(file);
    const config = normalizePipelineConfig({
        outputFormat: request.format,
        videoCodec: request.videoCodec ?? '',
        audioCodec: request.audioCodec ?? '',
        videoCodecUserSet: request.videoCodec !== undefined,
        audioCodecUserSet: request.audioCodec !== undefined,
        videoCodecRequested: request.videoCodec,
        audioCodecRequested: request.audioCodec,
        width: request.width ?? 0,
        height: request.height ?? 0,
        fps: request.fps ?? 0,
        videoBitrate: request.videoBitrate ?? 0,
        audioBitrate: request.audioBitrate ?? 0,
        audioSampleRate: request.audioSampleRate ?? 0,
        audioChannels: request.audioChannels ?? 0,
        signal: request.signal,
        onProgress: request.onProgress
            ? (percent, message) => request.onProgress({ fraction: percent / 100, message })
            : undefined,
        allowDomFallback: false,
        metadataPolicy: diagnostics.metadataPolicy,
    });
    if (!context.writers.container.has(request.format))
        throw new MediaForgeError(`No conversion output format registered for '${request.format}'`, 'FORMAT');
    const ids = request.trackIds;
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length))
        throw new MediaForgeError('trackIds must contain unique existing track IDs', 'INPUT');
    const tracks = ids === undefined
        ? [...state.tracks]
        : ids.map(id => {
            const track = state.tracks.find(value => value.description.id === id);
            if (!track)
                throw new MediaForgeError(`Unknown track ${id}`, 'INPUT');
            return track;
        });
    const videos = tracks.filter(track => track.type === 'video');
    const audios = tracks.filter(track => track.type === 'audio');
    if (!videos.length &&
        [request.videoCodec, request.width, request.height, request.fps, request.videoBitrate].some(value => value !== undefined))
        throw new MediaForgeError('Video options require a selected video track', 'FORMAT');
    if (!audios.length &&
        [request.audioCodec, request.audioSampleRate, request.audioChannels, request.audioBitrate].some(value => value !== undefined))
        throw new MediaForgeError('Audio options require a selected audio track', 'FORMAT');
    if (tracks.every(track => unchanged(track, request))) {
        const copy = file.checkRemux({
            format: request.format,
            trackIds: tracks.map(track => track.description.id),
            signal: request.signal,
        });
        if (copy.supported) {
            for (const warning of copy.warnings)
                diagnostics.warn(warning);
            return {
                copy: true,
                tracks,
                config,
                videoCopy: true,
                audioCopy: true,
                nativeAudioDecode: false,
                nativeAudioEncode: false,
            };
        }
    }
    if (videos.length > 1 || audios.length > 1 || tracks.some(track => track.type === 'subtitle'))
        throw new MediaForgeError('Native conversion requires at most one video and one audio track; select trackIds explicitly', 'FORMAT');
    const video = videos[0];
    const audio = audios[0];
    if (!video && !audio)
        throw new MediaForgeError('Native conversion requires a video or audio track', 'FORMAT');
    context.assertFormats(file.format, request.format);
    if (maxInputBytes !== undefined && state.source.size > maxInputBytes)
        throw new MediaForgeError(`Native conversion input exceeds maxInputBytes (${maxInputBytes})`, 'OOM');
    const defaults = CONTAINER_CODEC_PLANS[request.format];
    config.videoCodec =
        resolveSupportedCodec(config.videoCodec || video?.info.codec, defaults.video, defaults.defaultVideo, 'video') ??
            config.videoCodec;
    config.audioCodec =
        resolveSupportedCodec(config.audioCodec || audio?.info.codec, defaults.audio, defaults.defaultAudio, 'audio') ??
            config.audioCodec;
    if (video && !config.videoCodec)
        config.videoCodec = defaults.defaultVideo ?? '';
    if (audio && !config.audioCodec)
        config.audioCodec = defaults.defaultAudio ?? '';
    const planner = new PipelinePlanner(config);
    const copier = new PipelineRemuxPlanner(config);
    const videoCopy = !!video &&
        copier.canDirectRemuxVideo(file.format, request.format, video.info, config.videoCodec);
    const audioCopy = !!audio &&
        copier.canDirectRemuxAudio(file.format, request.format, audio.info, config.audioCodec);
    state.planner.checkTrackMetadata(tracks, request.format, diagnostics);
    if (video) {
        assertMuxCodec(request.format, 'video', videoCopy ? video.info.codec : config.videoCodec);
        assertAlphaCopy(video.info, request.format, videoCopy);
        if (!videoCopy) {
            const { w, h } = planner.targetVideoDimensions(video.info.width, video.info.height);
            if (typeof VideoDecoder !== 'function' ||
                typeof VideoEncoder !== 'function' ||
                typeof EncodedVideoChunk !== 'function' ||
                typeof VideoFrame !== 'function')
                throw new MediaForgeError('Video WebCodecs are unavailable for native conversion', 'DECODE');
            if (typeof VideoDecoder.isConfigSupported !== 'function' ||
                typeof VideoEncoder.isConfigSupported !== 'function')
                throw new MediaForgeError('WebCodecs configuration checks are unavailable', 'DECODE');
            if ((w !== video.info.width || h !== video.info.height) && typeof OffscreenCanvas !== 'function')
                throw new MediaForgeError('OffscreenCanvas is unavailable for native video resizing', 'ENCODE');
        }
    }
    let nativeAudioDecode = false;
    let nativeAudioEncode = false;
    if (audio) {
        assertMuxCodec(request.format, 'audio', audioCopy ? audio.info.codec : config.audioCodec);
        if (!audioCopy) {
            assertAudioEncodeRequest(config.audioCodec);
            const configs = audio.info.codecConfigurations ?? [{ codecConfig: audio.info.codecConfig }];
            nativeAudioDecode =
                audio.info.codec === 'pcm' ||
                    audio.info.codec.startsWith('pcm-') ||
                    (codecFamily(audio.info.codec) === 'mp4a' &&
                        configs.every(value => {
                            const parsed = value.codecConfig && parseAacAudioSpecificConfig(value.codecConfig);
                            return parsed?.audioObjectType === 2 && parsed.channelCount > 0 && parsed.channelCount <= 2;
                        }));
            const shape = planner.sourceAudioShape(audio.info);
            const target = planner.targetAudioParams(shape.rate, shape.channels, config.audioCodec);
            nativeAudioEncode =
                config.audioCodec === 'pcm' ||
                    (mp4aAudioObjectType(config.audioCodec) === 2 &&
                        target.channels <= 2 &&
                        AAC_SAMPLE_RATES.includes(target.rate));
            if (!nativeAudioDecode && (typeof AudioDecoder !== 'function' || typeof EncodedAudioChunk !== 'function'))
                throw new MediaForgeError('Audio WebCodecs are unavailable for this source codec', 'DECODE');
            if (!nativeAudioEncode && (typeof AudioEncoder !== 'function' || typeof AudioData !== 'function'))
                throw new MediaForgeError('Audio WebCodecs are unavailable for this output codec', 'ENCODE');
        }
    }
    return { copy: false, tracks, config, video, audio, videoCopy, audioCopy, nativeAudioDecode, nativeAudioEncode };
}
