import { builtinFormats } from '../engine/builtin-formats.js';
import { PipelineAudio } from '../audio/pipeline-audio.js';
import { PipelineVideo } from '../video/pipeline-video.js';
import { PipelineDom } from '../video/pipeline-dom.js';
export const defaultPipelineOptions = Object.freeze({
    formats: builtinFormats,
    pipelineAudio: host => new PipelineAudio(host),
    pipelineVideo: host => new PipelineVideo(host),
    pipelineDom: (config, host) => new PipelineDom(config, host),
});
