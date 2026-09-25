import { DiagnosticContext } from '../core/diagnostics.js';
import { recoverConversionDemux } from '../demux/conversion-recovery.js';
import { createWriters } from '../engine/formats.js';
import { BlobSource } from '../io/sources.js';
import { MediaForgeError } from '../core/errors.js';
import { awaitWithAbort } from '../core/abort.js';
import { logger } from '../core/logger.js';
export function requireConversionComponent(component, name) {
    if (!component)
        throw new MediaForgeError(`Conversion component '${name}' is not installed`, 'FORMAT');
    return component;
}
export class ConversionContext {
    metadataPolicy;
    options;
    writers;
    readers = new Map();
    constructor(options = {}, metadataPolicy = 'warn') {
        this.metadataPolicy = metadataPolicy;
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new MediaForgeError('Expected conversion options', 'FORMAT');
        }
        const { formats = [], audio, image, pipelineAudio, pipelineVideo, pipelineDom, validate } = options;
        if (!Array.isArray(formats))
            throw new MediaForgeError('Expected conversion format modules', 'FORMAT');
        for (const factory of [image, pipelineAudio, pipelineVideo, pipelineDom, validate]) {
            if (factory !== undefined && typeof factory !== 'function')
                throw new MediaForgeError('Expected conversion component factory', 'FORMAT');
        }
        const imageValidate = image?.validate;
        if (imageValidate !== undefined && typeof imageValidate !== 'function')
            throw new MediaForgeError('Expected image validation function', 'FORMAT');
        let audioSnapshot;
        if (audio !== undefined) {
            if (!audio || typeof audio !== 'object')
                throw new MediaForgeError('Expected audio conversion module', 'FORMAT');
            const { createDecoder, createEncoder, wav } = audio;
            if (typeof createDecoder !== 'function' || typeof createEncoder !== 'function') {
                throw new MediaForgeError('Audio conversion requires decoder and encoder factories', 'FORMAT');
            }
            let wavSnapshot;
            if (wav !== undefined) {
                if (!wav || typeof wav !== 'object')
                    throw new MediaForgeError('Expected WAV conversion functions', 'FORMAT');
                const { readLayout, convert } = wav;
                if (typeof readLayout !== 'function' || typeof convert !== 'function')
                    throw new MediaForgeError('Expected WAV conversion functions', 'FORMAT');
                wavSnapshot = Object.freeze({ readLayout: readLayout.bind(wav), convert: convert.bind(wav) });
            }
            audioSnapshot = Object.freeze({
                createDecoder: createDecoder.bind(audio),
                createEncoder: createEncoder.bind(audio),
                wav: wavSnapshot,
            });
        }
        this.writers = createWriters(formats);
        for (const module of formats) {
            const demuxers = module.demuxers ?? [];
            if (!Array.isArray(demuxers))
                throw new MediaForgeError('Expected format demuxers', 'FORMAT');
            for (const demuxer of demuxers) {
                if (!demuxer || typeof demuxer !== 'object')
                    throw new MediaForgeError('Expected a format demuxer', 'FORMAT');
                const { demux, formats: names } = demuxer;
                if (typeof demux !== 'function' || !Array.isArray(names) || !names.length) {
                    throw new MediaForgeError('Expected a format demuxer', 'FORMAT');
                }
                const read = demux.bind(demuxer);
                for (const name of names) {
                    if (typeof name !== 'string' || !name.trim())
                        throw new MediaForgeError('Invalid demuxer format', 'FORMAT');
                    const format = name.toLowerCase().trim();
                    if (this.readers.has(format))
                        throw new MediaForgeError(`Demuxer already registered for '${format}'`, 'FORMAT');
                    this.readers.set(format, read);
                }
            }
        }
        const formatSnapshot = Object.freeze({
            demuxers: Object.freeze([...this.readers].map(([format, demux]) => Object.freeze({ formats: Object.freeze([format]), demux }))),
            muxers: Object.freeze([...this.writers.container].map(([format, create]) => Object.freeze({ formats: Object.freeze([format]), create }))),
            audioMuxers: Object.freeze([...this.writers.audio].map(([format, create]) => Object.freeze({ formats: Object.freeze([format]), create }))),
            createSegmentWriter: this.writers.segments,
        });
        this.options = Object.freeze({
            formats: Object.freeze([formatSnapshot]),
            audio: audioSnapshot,
            image: image?.bind(options),
            pipelineAudio: pipelineAudio?.bind(options),
            pipelineVideo: pipelineVideo?.bind(options),
            pipelineDom: pipelineDom?.bind(options),
            validate: validate?.bind(options) ?? imageValidate?.bind(image),
        });
    }
    assertFormats(input, output) {
        const isImage = (format) => ['png', 'jpeg', 'webp', 'bmp', 'tiff', 'ico', 'gif', 'apng'].includes(format);
        if (!(isImage(input) ? this.options.image : this.readers.has(input))) {
            throw new MediaForgeError(`No input format module registered for '${input}'`, 'FORMAT');
        }
        if (!(isImage(output)
            ? this.options.image
            : this.writers.container.has(output) || this.writers.audio.has(output))) {
            throw new MediaForgeError(`No output format module registered for '${output}'`, 'FORMAT');
        }
    }
    demuxer(format) {
        const read = this.readers.get(format);
        if (!read)
            return null;
        return {
            demux: async (input, signal) => {
                const source = input instanceof Blob ? new BlobSource(input) : input;
                const diagnostics = new DiagnosticContext({
                    validation: 'compatible',
                    metadataPolicy: this.metadataPolicy,
                    onWarning: warning => logger.warn(warning.message),
                });
                const result = await awaitWithAbort(read(source, {
                    format,
                    signal,
                    validation: 'compatible',
                    metadataPolicy: this.metadataPolicy,
                    onWarning: warning => diagnostics.warn(warning),
                }), signal);
                await recoverConversionDemux(result, source, diagnostics, signal);
                signal?.throwIfAborted();
                return result;
            },
        };
    }
    createMuxer(config, sink) {
        const create = this.writers.container.get(config.format);
        if (!create)
            throw new MediaForgeError(`No container muxer registered for '${config.format}'`, 'FORMAT');
        return create(config, sink);
    }
    async validate(file, format, signal) {
        if (this.options.validate)
            return this.options.validate(file, format, signal);
        const demuxer = this.demuxer(format);
        if (!demuxer)
            throw new MediaForgeError(`No input format module registered for '${format}'`, 'FORMAT');
        await demuxer.demux(file, signal);
    }
}
