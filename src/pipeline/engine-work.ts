import type { FormatWriters, MissingParts } from './plugins/missing-parts';
import type { PluginSet } from './plugins/plugin';
import type { BuiltinVideoCodec } from '../core/contracts/decoder';
import type { TimelineEnvironment } from './transcode/timeline';
import type { AudioFileWriter, AudioTrackDecoder, ConversionRunner } from './types';
import type { CodecPreference } from './api-types';
import { createAudioFileWriter } from './transcode/audio-file-writer';
import { createAudioTrackDecoder } from './codecs/audio-track-decoder';
import { createConversionRunner } from './transcode/conversion-runner';
import { createContainerAudioEncoder, type ContainerAudioEncoder } from './codecs/container-audio';

export { audioPlan } from './transcode/audio-plan';
export { executeWithSink } from './execution';
export { collectedPackageRequest, collectPackage } from './package/options';

/**
 * The part of the engine that writes, decodes and packages: the conversion runner, the audio file
 * writers and the audio decoders. It loads with the first operation that needs it, so opening an
 * input and reading its packets carry only the readers; frames() and thumbnail() load the picture
 * code (frames/frames) without it.
 */
export interface EngineWork {
    readonly audio: AudioFileWriter;
    readonly audioDecoder: AudioTrackDecoder;
    readonly containerAudio: ContainerAudioEncoder;
    readonly runner: ConversionRunner;
    readonly environment: TimelineEnvironment;
}

export function createEngineWork(
    plugins: PluginSet,
    missing: MissingParts,
    writers: FormatWriters,
    videoDecoders: readonly BuiltinVideoCodec[],
    codecPreference: CodecPreference,
): EngineWork {
    const audioEncoders = plugins.audioEncoders;
    const audio = createAudioFileWriter(audioEncoders, missing);
    const audioDecoder = createAudioTrackDecoder(plugins.audioDecoders, missing);
    const containerAudio = createContainerAudioEncoder(audioEncoders, missing);
    const runner = createConversionRunner({
        writers,
        videoDecoders,
        codecPreference,
        audioDecoder,
        audioDecoders: plugins.audioDecoders,
        audioEncoders,
        providers: plugins.videoCodecs,
        stages: plugins.stages,
    });
    const environment: TimelineEnvironment = Object.freeze({
        writers,
        videoDecoders,
        codecPreference,
        audioDecoder,
        audio,
        containerAudio,
        providers: plugins.videoCodecs,
        stages: plugins.stages,
    });
    return Object.freeze({ audio, audioDecoder, containerAudio, runner, environment });
}
