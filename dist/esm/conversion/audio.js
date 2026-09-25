import { runReplayableAudio } from '../audio/replayable-audio-lifetime.js';
import { normalizePcmSource } from '../audio/pcm-source.js';
import { createAudioBuffer } from '../audio/audio-buffer-tools.js';
import { MemorySink } from '../io/sinks.js';
import { BlobSource } from '../io/sources.js';
import { DemuxerRegistry } from '../demux/registry.js';
import { MediaForgeError } from '../core/errors.js';
import { codecFamily } from '../core/codec-strings.js';
import { awaitWithAbort } from '../core/abort.js';
export function createAudioConversion(modules) {
    if (!Array.isArray(modules))
        throw new MediaForgeError('Expected audio codec modules', 'FORMAT');
    const decoders = new Map();
    const encoders = new Map();
    for (const module of modules) {
        if (!module || typeof module !== 'object')
            throw new MediaForgeError('Invalid audio codec module', 'FORMAT');
        const { codecs, outputs, decode, encode } = module;
        if (!Array.isArray(codecs) || !Array.isArray(outputs))
            throw new MediaForgeError('Invalid audio codec module', 'FORMAT');
        if ((decode !== undefined && typeof decode !== 'function') ||
            (encode !== undefined && typeof encode !== 'function'))
            throw new MediaForgeError('Invalid audio codec functions', 'FORMAT');
        if (decode)
            for (const codec of codecs) {
                if (typeof codec !== 'string' || !codec)
                    throw new MediaForgeError('Invalid audio codec name', 'FORMAT');
                const family = codecFamily(codec);
                if (decoders.has(family))
                    throw new MediaForgeError(`Audio decoder already installed for '${codec}'`, 'FORMAT');
                decoders.set(family, decode.bind(module));
            }
        if (encode)
            for (const format of outputs) {
                if (typeof format !== 'string' || !format)
                    throw new MediaForgeError('Invalid audio output format', 'FORMAT');
                const output = format;
                if (encoders.has(output))
                    throw new MediaForgeError(`Audio encoder already installed for '${format}'`, 'FORMAT');
                encoders.set(output, encode.bind(module));
            }
    }
    function select(result, config, bounded = false) {
        const index = config.audioTrackIndex ?? 0;
        if (bounded && result.audioTracks.length > 1 && config.audioTrackIndex === undefined) {
            throw new MediaForgeError('Multiple audio tracks require audioTrackIndex for a single-track output', 'FORMAT');
        }
        const track = result.audioTracks[index];
        if (!track || !track.samples.length)
            throw new MediaForgeError(`No audio track at audioTrackIndex ${index}`, 'FORMAT');
        return track;
    }
    async function trackSource(file, track, config) {
        const family = track.codec.startsWith('pcm') ? 'pcm' : codecFamily(track.codec);
        const decode = decoders.get(family);
        if (!decode)
            throw new MediaForgeError(`Audio decoder '${track.codec}' is not installed`, 'FORMAT');
        const input = new BlobSource(file);
        const source = await awaitWithAbort(Promise.resolve(decode(track, sample => (sample.data ? Promise.resolve(sample.data) : input.read(sample.offset, sample.size)), config)), config.signal);
        if (!source)
            throw new MediaForgeError(`Audio decoder '${track.codec}' is unavailable in this environment`, 'DECODE');
        return source;
    }
    async function fileSource(file, config, context, format, bounded = false, demuxed) {
        const inputFormat = format ?? (await DemuxerRegistry.detectFromFile(file, config.signal));
        const reader = context.demuxer(inputFormat);
        if (!reader)
            throw new MediaForgeError(`No input format module registered for '${inputFormat}'`, 'FORMAT');
        const result = demuxed ?? (await reader.demux(file, config.signal));
        const track = select(result, config, bounded);
        const { language, name, title, default: isDefault, forced, commentary } = track;
        return {
            source: await trackSource(file, track, config),
            metadata: {
                language,
                name,
                title,
                default: isDefault,
                forced,
                commentary,
                movieTitle: result.title ?? result.matroskaPassThrough?.title,
            },
        };
    }
    async function collect(source, config) {
        return runReplayableAudio(source, undefined, { signal: config.signal }, async (guarded, _sink, options) => {
            const chunks = Array.from({ length: guarded.channels }, () => []);
            let frames = 0;
            for await (const planes of guarded.chunks(options.signal)) {
                options.signal?.throwIfAborted();
                for (let channel = 0; channel < guarded.channels; channel++)
                    chunks[channel].push(planes[channel].slice());
                frames += planes[0].length;
            }
            options.signal?.throwIfAborted();
            return createAudioBuffer(chunks, frames, guarded.sampleRate);
        });
    }
    function fromBuffer(audio) {
        return {
            sampleRate: audio.sampleRate,
            channels: audio.numberOfChannels,
            estimatedFrames: audio.length,
            async *chunks(signal) {
                for (let start = 0; start < audio.length; start += 16384) {
                    signal?.throwIfAborted();
                    yield Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel).subarray(start, start + 16384));
                    signal?.throwIfAborted();
                }
            },
        };
    }
    return {
        createDecoder(config, context) {
            return {
                selectAudioTrack: result => select(result, config),
                decodeDemuxedAudioTrack: async (file, track) => collect(await trackSource(file, track, config), config),
                decodeAudioToBuffer: async (file, format) => collect((await fileSource(file, config, context, format)).source, config),
            };
        },
        createEncoder(config, host, context) {
            async function encode(file, sink, format, inputFormat, buffer) {
                const encoder = encoders.get(format);
                if (!encoder)
                    throw new MediaForgeError(`Audio encoder for '${format}' is not installed`, 'FORMAT');
                const resolved = buffer
                    ? {
                        source: fromBuffer(buffer),
                        metadata: {
                            ...host.getCarried().audioTrack,
                            language: host.getCarried().audioLanguage,
                            movieTitle: host.getCarried().title,
                        },
                    }
                    : await fileSource(file, config, context, inputFormat, true, host.getDemuxed?.(file));
                const source = resolved.source;
                const rate = config.audioSampleRate ?? source.sampleRate;
                const channels = config.audioChannels ?? source.channels;
                await awaitWithAbort(encoder(normalizePcmSource(source, rate, channels), format, sink, config, Object.freeze(resolved.metadata)), config.signal);
                config.signal?.throwIfAborted();
            }
            return {
                async extractAudio(file, format, buffer, inputFormat) {
                    const sink = new MemorySink();
                    await encode(file, sink, format, inputFormat, buffer);
                    return sink.toBlob(DemuxerRegistry.getMimeType(format));
                },
                async extractAudioToSink(file, sink, format, inputFormat) {
                    await encode(file, sink, format, inputFormat);
                    return true;
                },
            };
        },
    };
}
