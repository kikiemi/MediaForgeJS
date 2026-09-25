import { sampleAt, sampleCount } from '../demux/sample-index.js';
import { MediaForgeError } from '../core/errors.js';
import { yieldEventLoop } from '../core/demux-guard.js';
import { linkAbortSignals } from '../core/abort.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { parseAacAudioSpecificConfig } from './adts.js';
import { AacLcDecoder } from './aac-decoder.js';
import { createPcmAudioBufferFromChannels } from './audio-buffer-tools.js';
import { normalizePcmSource } from './pcm-source.js';
import { StreamingPcmTransformer } from './streaming-pcm.js';
function effectiveConfigurations(track) {
    if (track.codecConfigurations && track.codecConfigurations.length > 0) {
        return track.codecConfigurations;
    }
    if (!track.codecConfig)
        return [];
    return [
        {
            codec: track.codec,
            codecConfig: track.codecConfig,
            sampleRate: track.sampleRate,
            channelCount: track.channelCount,
            samplesPerAccessUnit: parseAacAudioSpecificConfig(track.codecConfig)?.samplesPerAccessUnit,
        },
    ];
}
function configuredEpochs(track, configs) {
    const epochs = [];
    for (let sampleIndex = 0, count = sampleCount(track); sampleIndex < count; sampleIndex++) {
        const sample = sampleAt(track, sampleIndex);
        const configIndex = sample.codecConfigIndex ?? 0;
        const config = configs[configIndex];
        if (!config) {
            throw new MediaForgeError(`AAC sample references missing codec configuration ${configIndex}`, 'DEMUX');
        }
        const last = epochs[epochs.length - 1];
        if (last && last.configIndex === configIndex) {
            last.endIndex = sampleIndex + 1;
        }
        else {
            if (epochs.length >= 65536) {
                throw new MediaForgeError('AAC track changes decoder configuration more than 65,536 times', 'DEMUX');
            }
            epochs.push({
                configIndex,
                config,
                startIndex: sampleIndex,
                endIndex: sampleIndex + 1,
                start: sample.timestamp,
                end: sample.timestamp,
                destinationFrames: 0,
                outputFrames: 0,
            });
        }
    }
    return epochs;
}
function resolveConfiguredAacLayout(track, options) {
    const configs = effectiveConfigurations(track);
    if (configs.length === 0) {
        throw new MediaForgeError('AAC track has no AudioSpecificConfig', 'DEMUX');
    }
    const epochs = configuredEpochs(track, configs);
    if (epochs.length === 0)
        throw new MediaForgeError('AAC track has no samples', 'DECODE');
    let defaultRate = 0;
    let defaultChannels = 0;
    let codedSeconds = 0;
    for (const config of configs) {
        const parsed = parseAacAudioSpecificConfig(config.codecConfig);
        if (!parsed)
            throw new MediaForgeError('Invalid AAC AudioSpecificConfig', 'DEMUX');
        if (parsed.coreAudioObjectType !== 2 || parsed.audioObjectType !== 2) {
            throw new MediaForgeError(`Built-in dynamic AAC decoder supports AAC-LC only (got object type ${parsed.audioObjectType})`, 'DECODE');
        }
        defaultRate = Math.max(defaultRate, config.sampleRate ?? parsed.sampleRate);
        defaultChannels = Math.max(defaultChannels, config.channelCount ?? parsed.channelCount);
    }
    const targetRate = Math.max(1, Math.round(options.targetSampleRate || defaultRate || track.sampleRate || 44100));
    const targetChannels = Math.max(1, Math.min(2, Math.round(options.targetChannels || defaultChannels || track.channelCount || 2)));
    let baseStart = Number.POSITIVE_INFINITY;
    let presentationEnd = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < epochs.length; index++) {
        const epoch = epochs[index];
        const parsed = parseAacAudioSpecificConfig(epoch.config.codecConfig);
        const rate = epoch.config.sampleRate ?? parsed.sampleRate;
        const samplesPerUnit = epoch.config.samplesPerAccessUnit ?? parsed.samplesPerAccessUnit ?? 1024;
        codedSeconds += ((epoch.endIndex - epoch.startIndex) * samplesPerUnit) / rate;
        const nextStart = epochs[index + 1]?.start;
        const last = sampleAt(track, epoch.endIndex - 1);
        const declaredEnd = last.timestamp + last.duration;
        epoch.end = nextStart !== undefined ? Math.max(epoch.start, nextStart) : Math.max(epoch.start, declaredEnd);
        baseStart = Math.min(baseStart, epoch.start);
        presentationEnd = Math.max(presentationEnd, epoch.end);
    }
    const spanSeconds = Math.max(0, presentationEnd - baseStart);
    const gapSeconds = Math.max(0, spanSeconds - codedSeconds);
    const maxGap = Math.max(3, codedSeconds * 4);
    if (gapSeconds > maxGap) {
        throw new MediaForgeError(`audio timeline is implausibly sparse: ${codedSeconds.toFixed(2)} s of coded audio spread over ${spanSeconds.toFixed(1)} s`, 'FORMAT');
    }
    const skipSeconds = Math.max(0, track.editMediaTimeSeconds ??
        (track.audioPrimingSamples
            ? track.audioPrimingSamples / track.sampleRate
            : track.matroskaCodecDelaySeconds
                ? 0
                : Math.max(0, -baseStart)));
    const startOffset = Math.max(0, baseStart);
    const headFrames = Math.max(0, Math.round(skipSeconds * targetRate));
    const tailFrames = Math.max(0, Math.round(((track.audioTrailingPaddingSamples ?? track.opusTrailingPaddingSamples ?? 0) * targetRate) /
        (track.sampleRate || defaultRate)));
    let rawFrames = Math.max(1, Math.round(spanSeconds * targetRate));
    for (const epoch of epochs) {
        const parsed = parseAacAudioSpecificConfig(epoch.config.codecConfig);
        const rate = epoch.config.sampleRate ?? parsed.sampleRate;
        const samplesPerUnit = epoch.config.samplesPerAccessUnit ?? parsed.samplesPerAccessUnit ?? 1024;
        epoch.destinationFrames = Math.max(0, Math.round((epoch.start - baseStart) * targetRate));
        epoch.outputFrames = Math.max(0, Math.round((epoch.end - epoch.start) * targetRate), Math.ceil((((epoch.endIndex - epoch.startIndex) * samplesPerUnit) / rate) * targetRate - 1e-7));
        rawFrames = Math.max(rawFrames, epoch.destinationFrames + epoch.outputFrames);
    }
    const codedValidFrames = Math.max(1, rawFrames - headFrames - tailFrames);
    const presentationValidFrames = Math.max(1, track.editPresentationDurationSeconds !== undefined
        ? Math.round(track.editPresentationDurationSeconds * targetRate)
        : Math.round(Math.max(0, presentationEnd - startOffset) * targetRate) - tailFrames);
    const totalFrames = track.editPresentationDurationSeconds !== undefined ? presentationValidFrames : codedValidFrames;
    if (headFrames + totalFrames > rawFrames + 1) {
        throw new MediaForgeError('AAC trim metadata exceeds the coded presentation span', 'DEMUX');
    }
    return {
        epochs,
        targetRate,
        targetChannels,
        baseStart,
        startOffset,
        rawFrames,
        headFrames,
        totalFrames,
    };
}
export function createConfiguredAacTrackPcmSource(track, readSample, options = {}) {
    const layout = resolveConfiguredAacLayout(track, options);
    const count = sampleCount(track);
    const rawSource = {
        sampleRate: layout.targetRate,
        channels: layout.targetChannels,
        estimatedFrames: layout.rawFrames,
        async *chunks(signal) {
            const linked = linkAbortSignals(options.signal, signal);
            const lifetime = new CodecLifetime(linked.signal);
            const read = (sample, index) => {
                lifetime.check();
                try {
                    return lifetime.waitFor(Promise.resolve(readSample(sample, index, linked.signal)).catch(error => {
                        throw lifetime.record(error);
                    }));
                }
                catch (error) {
                    throw lifetime.record(error);
                }
            };
            try {
                lifetime.check();
                let cursor = 0;
                let processedSamples = 0;
                for (let epochIndex = 0; epochIndex < layout.epochs.length; epochIndex++) {
                    lifetime.check();
                    const epoch = layout.epochs[epochIndex];
                    const parsed = parseAacAudioSpecificConfig(epoch.config.codecConfig);
                    const rate = epoch.config.sampleRate ?? parsed.sampleRate;
                    const channels = epoch.config.channelCount ?? parsed.channelCount;
                    if (!(rate > 0) || channels < 1 || channels > 2) {
                        throw new MediaForgeError(`Unsupported AAC epoch shape ${rate}Hz/${channels}ch`, 'DECODE');
                    }
                    const destination = epoch.destinationFrames;
                    const samplesPerUnit = epoch.config.samplesPerAccessUnit ?? parsed.samplesPerAccessUnit ?? 1024;
                    const declaredFrames = epoch.outputFrames;
                    while (destination > cursor) {
                        const count = Math.min(destination - cursor, 16384);
                        yield Array.from({ length: layout.targetChannels }, () => new Float32Array(count));
                        lifetime.check();
                        cursor += count;
                    }
                    let epochConsumed = 0;
                    const pending = [];
                    const place = (planes) => {
                        const available = planes[0]?.length ?? 0;
                        const count = Math.min(available, Math.max(0, declaredFrames - epochConsumed));
                        const from = Math.min(count, Math.max(0, cursor - destination - epochConsumed));
                        epochConsumed += count;
                        if (count <= from)
                            return;
                        pending.push(planes.map(plane => plane.subarray(from, count)));
                        cursor += count - from;
                    };
                    const drain = function* () {
                        while (pending.length > 0) {
                            lifetime.check();
                            yield pending.shift();
                            lifetime.check();
                        }
                    };
                    const padUntil = function* (end) {
                        const limit = Math.min(declaredFrames, end);
                        while (epochConsumed < limit) {
                            lifetime.check();
                            const count = Math.min(limit - epochConsumed, 16384);
                            place(Array.from({ length: layout.targetChannels }, () => new Float32Array(count)));
                            yield* drain();
                        }
                    };
                    const makeTransformer = () => new StreamingPcmTransformer(rate, channels, layout.targetRate, layout.targetChannels, place);
                    let transformer = makeTransformer();
                    const decoder = new AacLcDecoder(rate, channels);
                    const codedUnitSeconds = samplesPerUnit / rate;
                    for (let sampleIndex = epoch.startIndex; sampleIndex < epoch.endIndex; sampleIndex++) {
                        lifetime.check();
                        const sample = sampleAt(track, sampleIndex);
                        const previous = sampleIndex > epoch.startIndex ? sampleAt(track, sampleIndex - 1) : undefined;
                        if (previous && sample.timestamp - previous.timestamp - codedUnitSeconds > 0.02) {
                            transformer.flush();
                            yield* drain();
                            const sampleDestination = Math.max(destination, Math.round((sample.timestamp - layout.baseStart) * layout.targetRate));
                            yield* padUntil(sampleDestination - destination);
                            transformer = makeTransformer();
                        }
                        const data = sample.data ?? (await read(sample, sampleIndex));
                        lifetime.check();
                        transformer.push(decoder.decodeFrame(data));
                        yield* drain();
                        processedSamples++;
                        options.onProgress?.(processedSamples, count);
                        lifetime.check();
                        if ((processedSamples & 15) === 0) {
                            await lifetime.waitFor(yieldEventLoop());
                        }
                    }
                    transformer.flush();
                    yield* drain();
                    yield* padUntil(declaredFrames);
                }
                while (cursor < layout.rawFrames) {
                    const count = Math.min(layout.rawFrames - cursor, 16384);
                    yield Array.from({ length: layout.targetChannels }, () => new Float32Array(count));
                    lifetime.check();
                    cursor += count;
                }
                lifetime.check();
                options.onProgress?.(count, count);
                lifetime.check();
            }
            catch (error) {
                throw lifetime.record(error);
            }
            finally {
                lifetime.stop();
                linked.dispose();
            }
        },
    };
    const trimmed = normalizePcmSource(rawSource, layout.targetRate, layout.targetChannels, {
        head: layout.headFrames,
        valid: layout.totalFrames,
    });
    return { ...trimmed, startOffset: layout.startOffset };
}
export async function streamConfiguredAacTrack(track, readSample, consume, options = {}) {
    const source = createConfiguredAacTrackPcmSource(track, readSample, options);
    let frames = 0;
    for await (const planes of source.chunks(options.signal)) {
        consume(planes);
        frames += planes[0]?.length ?? 0;
    }
    return {
        sampleRate: source.sampleRate,
        channels: source.channels,
        frames,
        startOffset: source.startOffset,
    };
}
export async function decodeConfiguredAacTrack(track, readSample, options = {}) {
    const source = createConfiguredAacTrackPcmSource(track, readSample, options);
    const output = Array.from({ length: source.channels }, () => new Float32Array(source.estimatedFrames));
    let written = 0;
    for await (const planes of source.chunks(options.signal)) {
        const count = planes[0].length;
        if (count > source.estimatedFrames - written) {
            throw new MediaForgeError('AAC decoder exceeded its presentation window', 'DECODE');
        }
        for (let channel = 0; channel < output.length; channel++) {
            output[channel].set(planes[channel], written);
        }
        written += count;
    }
    if (written !== source.estimatedFrames) {
        throw new MediaForgeError(`AAC decoder produced ${written}/${source.estimatedFrames} presentation samples`, 'DECODE');
    }
    return createPcmAudioBufferFromChannels(output, source.sampleRate);
}
