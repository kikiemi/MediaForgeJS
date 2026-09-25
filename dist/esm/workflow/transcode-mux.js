import { pipelineAudio } from '../conversion/pipeline-audio.js';
import { PipelineAac } from '../audio/pipeline-aac.js';
import { buildAacAsc } from '../audio/adts.js';
import { codecFamily, mp4aAudioObjectType } from '../core/codec-strings.js';
import { sourceAudioWindow } from '../core/pipeline-track-config.js';
import { MediaForgeError } from '../core/errors.js';
export function nativeConversionOptions(context, plan, title) {
    const nativeAac = !!plan.audio &&
        !plan.audioCopy &&
        plan.nativeAudioDecode &&
        plan.nativeAudioEncode &&
        mp4aAudioObjectType(plan.config.audioCodec) === 2;
    const formats = context.options.formats.map(module => ({
        ...module,
        muxers: module.muxers?.map(writer => ({
            formats: writer.formats,
            create(config, output, options) {
                config = {
                    ...config,
                    title,
                    video: config.video && {
                        ...config.video,
                        id: plan.video.description.id,
                        title: plan.video.info.title,
                    },
                    audio: config.audio && {
                        ...config.audio,
                        id: plan.audio.description.id,
                        title: plan.audio.info.title,
                    },
                };
                const audio = config.audio;
                const declared = audio && !audio.codecConfig && mp4aAudioObjectType(audio.codec) === 2
                    ? buildAacAsc(audio.sampleRate, audio.channelCount)
                    : undefined;
                if (audio && declared) {
                    const valid = nativeAac
                        ? (plan.audio.info.codecConfigurations?.length ?? 0) > 1
                            ? Math.max(1, Math.round(plan.audio.info.duration * audio.sampleRate))
                            : sourceAudioWindow(plan.audio.info, audio.sampleRate).valid
                        : undefined;
                    config = {
                        ...config,
                        audio: {
                            ...audio,
                            codecConfig: declared,
                            ...(valid !== undefined ? { primingSamples: 1024, validSamples: valid } : {}),
                        },
                    };
                }
                const muxer = writer.create(config, output, options);
                if (declared) {
                    const verify = (value) => {
                        if (value.length !== declared.length ||
                            value.some((byte, index) => byte !== declared[index]))
                            throw new MediaForgeError('Audio encoder configuration differs from the declared AAC-LC output', 'ENCODE');
                    };
                    muxer.setAudioCodecConfig = verify;
                    const addAudio = muxer.addAudioChunk.bind(muxer);
                    muxer.addAudioChunk = (chunk, codecConfig) => {
                        if (codecConfig)
                            verify(codecConfig);
                        addAudio(chunk, codecConfig);
                    };
                }
                return muxer;
            },
        })),
    }));
    return {
        ...context.options,
        formats,
        pipelineAudio: host => {
            const stage = pipelineAudio(host);
            if (!nativeAac || codecFamily(plan.audio.info.codec) !== 'mp4a')
                return stage;
            const aac = new PipelineAac(host);
            return {
                pipeAudio: (track, source, codec, muxer) => aac.pipeAudioSelfHosted(track, source, codec, muxer),
                encodeAudioBuffer: stage.encodeAudioBuffer.bind(stage),
            };
        },
    };
}
