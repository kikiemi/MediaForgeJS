import { readWavLayout, convertWavStreaming } from '../audio/streaming-wav.js';
import { defaultPipelineOptions } from './pipeline-defaults.js';
import { ConverterAudioDecoder } from '../audio/converter-audio-decoder.js';
import { ConverterAudioEncoder } from '../audio/converter-audio-encoder.js';
import { ConverterImage } from '../image/converter-image.js';
import { probeStructure } from '../core/structure-probe.js';
export const defaultConversionOptions = Object.freeze({
    ...defaultPipelineOptions,
    audio: Object.freeze({
        wav: Object.freeze({ readLayout: readWavLayout, convert: convertWavStreaming }),
        createDecoder: config => new ConverterAudioDecoder(config),
        createEncoder: (config, host) => new ConverterAudioEncoder(config, host),
    }),
    image: (config, host) => new ConverterImage(config, host),
    validate: probeStructure,
});
