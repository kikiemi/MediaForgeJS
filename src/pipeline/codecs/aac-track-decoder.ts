import { NO_PLUGINS } from '../plugins/missing-parts';
import type { Mp4CodecConfiguration, Sample, TrackInfo } from '../../core/model/track';
import { sampleAt, sampleCount } from '../../core/model/sample-index';
import { DecodeError, MediaForgeError, errorMessage } from '../../core/errors/errors';
import { editPresentationSamples } from '../../core/model/audio-window';
import { yieldEventLoop } from '../../core/io/event-loop';
import { linkAbortSignals } from '../../core/io/abort';
import { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import {
    parseAacAudioSpecificConfig,
    type ParsedAacAudioSpecificConfig,
} from '../../core/codec-config/audio/adts';
import { aacDecoderConfig, aacOutputShape } from '../../core/codec-config/audio/aac-syntax';
import { normalizePcmSource, type ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { StreamingPcmTransformer } from '../../codecs/pcm/streaming-pcm';
import {
    decodeAudioTrack,
    MAX_CONSECUTIVE_CONCEALMENTS,
    type TrackDecodeSettings,
} from './audio-track-source';
import type {
    BuiltinAudioCodec,
    BuiltinAudioDecoder,
    EncodedAudioSampleReader,
} from '../../core/contracts/decoder';

interface AacEpoch {
    configIndex: number;
    config: Mp4CodecConfiguration;
    startIndex: number;
    endIndex: number;
    start: number;
    end: number;
    destinationFrames: number;
    outputFrames: number;
}

interface ConfiguredAacLayout {
    readonly epochs: AacEpoch[];
    readonly targetRate: number;
    readonly targetChannels: number;
    readonly baseStart: number;
    readonly startOffset: number;
    readonly rawFrames: number;
    readonly headFrames: number;
    readonly totalFrames: number;
}

interface ConfiguredAacPcmSource extends ReplayablePcmSource {
    readonly startOffset: number;
}

/**
 * Output samples of one access unit at the output `rate`: the core frame, doubled when SBR
 * upsamples.
 */
function unitFrames(parsed: ParsedAacAudioSpecificConfig, rate: number): number {
    return (
        (parsed.frameLengthShort ? 960 : 1024) *
        Math.max(1, Math.round(rate / parsed.coreSampleRate))
    );
}

/**
 * WAVE speaker mask of the decoded planes of a configuration that decodes to `channels` channels.
 */
function aacChannelMask(config: Uint8Array, channels: number): number | undefined {
    const shape = aacOutputShape(config, undefined);
    if (shape.channels === channels) return shape.channelMask;
    return channels === 2 ? 0x3 : undefined;
}

/** The software AAC decoder among `decoders` (the aac plugin's), if one is installed. */
function aacDecoderOf(
    decoders: readonly BuiltinAudioDecoder[] = [],
): BuiltinAudioDecoder | undefined {
    return decoders.find(decoder => decoder.codecs.includes('mp4a'));
}

/**
 * The software decoder of one configuration of `track`: the track as it would be with that
 * configuration alone.
 */
function configurationCodec(
    decoder: BuiltinAudioDecoder,
    track: TrackInfo,
    config: Uint8Array,
): Promise<BuiltinAudioCodec> {
    // A view over the track rather than a copy: copying would read its sample index, which a
    // compact index builds only on demand.
    const view: TrackInfo = Object.create(track, {
        codecConfig: { value: config, enumerable: true },
        codecConfigurations: { value: undefined, enumerable: true },
    });
    return Promise.resolve(decoder.create(view));
}

/** Why the software decoder cannot decode a configuration, or null when it can. */
function builtinAacProblem(config: Uint8Array | undefined): string | null {
    const parsed = config && parseAacAudioSpecificConfig(config);
    if (!parsed) return 'Invalid AAC AudioSpecificConfig';
    try {
        aacDecoderConfig(parsed);
        return aacOutputShape(config, undefined).channels <= 8
            ? null
            : 'AAC layouts beyond eight channels are not decoded';
    } catch (error) {
        if (error instanceof MediaForgeError) return error.message;
        throw error;
    }
}

function effectiveConfigurations(track: TrackInfo): Mp4CodecConfiguration[] {
    if (track.codecConfigurations && track.codecConfigurations.length > 0) {
        return track.codecConfigurations;
    }
    if (!track.codecConfig) return [];
    return [
        {
            codec: track.codec,
            codecConfig: track.codecConfig,
            sampleRate: track.sampleRate,
            channelCount: track.channelCount,
            samplesPerAccessUnit: parseAacAudioSpecificConfig(track.codecConfig)
                ?.samplesPerAccessUnit,
        },
    ];
}

function configuredEpochs(track: TrackInfo, configs: Mp4CodecConfiguration[]): AacEpoch[] {
    const epochs: AacEpoch[] = [];
    for (let sampleIndex = 0, count = sampleCount(track); sampleIndex < count; sampleIndex++) {
        const sample = sampleAt(track, sampleIndex)!;
        const configIndex = sample.codecConfigIndex ?? 0;
        const config = configs[configIndex];
        if (!config) {
            throw new MediaForgeError(
                `AAC sample references missing codec configuration ${configIndex}`,
                'DEMUX',
            );
        }

        const last = epochs[epochs.length - 1];
        if (last && last.configIndex === configIndex) {
            last.endIndex = sampleIndex + 1;
        } else {
            if (epochs.length >= 65536) {
                throw new MediaForgeError(
                    'AAC track changes decoder configuration more than 65,536 times',
                    'DEMUX',
                );
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

function resolveConfiguredAacLayout(track: TrackInfo): ConfiguredAacLayout {
    const configs = effectiveConfigurations(track);
    if (configs.length === 0) {
        throw new MediaForgeError('AAC track has no AudioSpecificConfig', 'DEMUX');
    }
    const epochs = configuredEpochs(track, configs);
    if (epochs.length === 0) throw new MediaForgeError('AAC track has no samples', 'DECODE');

    let defaultRate = 0;
    let defaultChannels = 0;
    let codedSeconds = 0;
    for (const config of configs) {
        const parsed = parseAacAudioSpecificConfig(config.codecConfig);
        if (!parsed) throw new MediaForgeError('Invalid AAC AudioSpecificConfig', 'DEMUX');
        const problem = builtinAacProblem(config.codecConfig);
        if (problem) throw new MediaForgeError(problem, 'DECODE');
        defaultRate = Math.max(defaultRate, config.sampleRate ?? parsed.sampleRate);
        defaultChannels = Math.max(defaultChannels, config.channelCount ?? parsed.channelCount);
    }
    const targetRate = Math.max(1, Math.round(defaultRate || track.sampleRate || 44100));
    const targetChannels = Math.max(
        1,
        Math.min(8, Math.round(defaultChannels || track.channelCount || 2)),
    );

    let baseStart = Number.POSITIVE_INFINITY;
    let presentationEnd = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < epochs.length; index++) {
        const epoch = epochs[index]!;
        const parsed = parseAacAudioSpecificConfig(epoch.config.codecConfig)!;
        const rate = epoch.config.sampleRate ?? parsed.sampleRate;
        const samplesPerUnit = unitFrames(parsed, rate);
        codedSeconds += ((epoch.endIndex - epoch.startIndex) * samplesPerUnit) / rate;
        const nextStart = epochs[index + 1]?.start;
        const last = sampleAt(track, epoch.endIndex - 1)!;
        const declaredEnd = last.timestamp + last.duration;
        epoch.end =
            nextStart !== undefined
                ? Math.max(epoch.start, nextStart)
                : Math.max(epoch.start, declaredEnd);
        baseStart = Math.min(baseStart, epoch.start);
        presentationEnd = Math.max(presentationEnd, epoch.end);
    }
    const spanSeconds = Math.max(0, presentationEnd - baseStart);
    const gapSeconds = Math.max(0, spanSeconds - codedSeconds);
    const maxGap = Math.max(3, codedSeconds * 4);
    if (gapSeconds > maxGap) {
        throw new MediaForgeError('audio timeline has implausibly long gaps', 'FORMAT');
    }
    const skipSeconds = Math.max(
        0,
        track.editMediaTimeSeconds ??
            (track.audioPrimingSamples
                ? track.audioPrimingSamples / track.sampleRate
                : track.matroskaCodecDelaySeconds
                  ? 0
                  : Math.max(0, -baseStart)),
        (track.decoderDelaySamples ?? 0) / track.sampleRate,
    );
    const startOffset = Math.max(0, baseStart);
    const headFrames = Math.max(0, Math.round(skipSeconds * targetRate));
    const tailFrames = Math.max(
        0,
        Math.round(
            ((track.audioTrailingPaddingSamples ?? track.opusTrailingPaddingSamples ?? 0) *
                targetRate) /
                (track.sampleRate || defaultRate),
        ),
    );

    let rawFrames = Math.max(1, Math.round(spanSeconds * targetRate));
    for (const epoch of epochs) {
        const parsed = parseAacAudioSpecificConfig(epoch.config.codecConfig)!;
        const rate = epoch.config.sampleRate ?? parsed.sampleRate;
        const samplesPerUnit = unitFrames(parsed, rate);
        epoch.destinationFrames = Math.max(0, Math.round((epoch.start - baseStart) * targetRate));
        epoch.outputFrames = Math.max(
            0,
            Math.round((epoch.end - epoch.start) * targetRate),
            Math.ceil(
                (((epoch.endIndex - epoch.startIndex) * samplesPerUnit) / rate) * targetRate - 1e-7,
            ),
        );
        rawFrames = Math.max(rawFrames, epoch.destinationFrames + epoch.outputFrames);
    }
    const codedValidFrames = Math.max(1, rawFrames - headFrames - tailFrames);
    const presentationValidFrames = Math.max(
        1,
        track.editPresentationDurationSeconds !== undefined
            ? editPresentationSamples(
                  track,
                  targetRate,
                  rawFrames - headFrames,
                  'AAC trim metadata',
              )
            : Math.round(Math.max(0, presentationEnd - startOffset) * targetRate) - tailFrames,
    );

    const totalFrames =
        track.editPresentationDurationSeconds !== undefined
            ? presentationValidFrames
            : codedValidFrames;
    if (headFrames + totalFrames > rawFrames) {
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

/**
 * Presentation window of a single-configuration AAC-LC track whose access units play back to back,
 * so that any decoder emitting every coded sample can be trimmed to it; null for tracks that need
 * the configured decoder.
 */
function contiguousAacWindow(
    track: TrackInfo,
): { head: number; valid: number; frames: number } | null {
    let layout: ConfiguredAacLayout;
    try {
        layout = resolveConfiguredAacLayout(track);
    } catch (error) {
        if (error instanceof MediaForgeError && (error.code === 'DECODE' || error.code === 'DEMUX'))
            return null;
        throw error;
    }
    const epoch = layout.epochs[0]!;
    const parsed = parseAacAudioSpecificConfig(epoch.config.codecConfig)!;
    const rate = epoch.config.sampleRate ?? parsed.sampleRate;
    const unit = unitFrames(parsed, rate);
    const count = sampleCount(track);
    const frames = count * unit;
    if (layout.epochs.length !== 1 || rate !== layout.targetRate || layout.rawFrames !== frames)
        return null;
    for (let index = 1; index < count; index++)
        if (
            sampleAt(track, index)!.timestamp -
                sampleAt(track, index - 1)!.timestamp -
                unit / rate >
            0.02
        )
            return null;
    return { head: layout.headFrames, valid: layout.totalFrames, frames };
}

/**
 * Whether the access unit `index` that failed to decode with `error` is concealed with silence of
 * its length; `run` counts the failures in a row, including this one.
 */
type AacConcealment = (index: number, error: unknown, run: number) => boolean;

/**
 * The concealment of decodeAudioTrack for the configured decoder: undecodable access units become
 * silence with one AUDIO_FRAME_CONCEALED warning unless validation is 'strict', and a complete
 * track fails after MAX_CONSECUTIVE_CONCEALMENTS in a row.
 */
function aacConcealment(track: TrackInfo, options: TrackDecodeSettings): AacConcealment {
    let reported = false;
    return (index, error, run) => {
        if (options.validation === 'strict') return false;
        if (error instanceof MediaForgeError && error.code !== 'DECODE') return false;
        if (!track.incomplete && run > MAX_CONSECUTIVE_CONCEALMENTS) return false;
        if (!reported) {
            reported = true;
            options.onWarning?.({
                code: 'AUDIO_FRAME_CONCEALED',
                message: `${track.codec} unit ${index} is undecodable; silence replaces it`,
            });
        }
        return true;
    };
}

/** Planes of silence for one access unit. */
function silentUnit(channels: number, frames: number): Float32Array[] {
    return Array.from({ length: channels }, () => new Float32Array(frames));
}

function createConfiguredAacTrackPcmSource(
    track: TrackInfo,
    readSample: (sample: Sample, index: number, signal?: AbortSignal) => Promise<Uint8Array>,
    aacDecoder: BuiltinAudioDecoder,
    conceal: AacConcealment,
): ConfiguredAacPcmSource {
    const layout = resolveConfiguredAacLayout(track);
    const rawSource: ReplayablePcmSource = {
        sampleRate: layout.targetRate,
        channels: layout.targetChannels,
        estimatedFrames: layout.rawFrames,
        channelMask: aacChannelMask(layout.epochs[0]!.config.codecConfig, layout.targetChannels),
        async *chunks(signal?: AbortSignal): AsyncIterable<readonly Float32Array[]> {
            const lifetime = new CodecLifetime(signal);
            const read = (sample: Sample, index: number): Promise<Uint8Array> => {
                lifetime.check();
                try {
                    return lifetime.waitFor(
                        Promise.resolve(readSample(sample, index, signal)).catch(error => {
                            throw lifetime.record(error);
                        }),
                    );
                } catch (error) {
                    throw lifetime.record(error);
                }
            };
            try {
                lifetime.check();
                let cursor = 0;
                let processedSamples = 0;
                // Units concealed before any unit of a complete track decoded are held back: a
                // track none decodes from is undecodable, not damaged, and fails.
                let decodedAny = !!track.incomplete;
                let held = 0;
                let heldError: unknown;

                for (let epochIndex = 0; epochIndex < layout.epochs.length; epochIndex++) {
                    lifetime.check();
                    const epoch = layout.epochs[epochIndex]!;
                    const parsed = parseAacAudioSpecificConfig(epoch.config.codecConfig)!;
                    const rate = epoch.config.sampleRate ?? parsed.sampleRate;
                    const channels = epoch.config.channelCount ?? parsed.channelCount;
                    if (!(rate > 0) || channels < 1 || channels > 8) {
                        throw new MediaForgeError(
                            `Unsupported AAC epoch shape ${rate}Hz/${channels}ch`,
                            'DECODE',
                        );
                    }
                    const destination = epoch.destinationFrames;
                    const samplesPerUnit = unitFrames(parsed, rate);
                    const declaredFrames = epoch.outputFrames;
                    while (destination > cursor) {
                        const count = Math.min(destination - cursor, 16384);
                        yield Array.from(
                            { length: layout.targetChannels },
                            () => new Float32Array(count),
                        );
                        lifetime.check();
                        cursor += count;
                    }

                    let epochConsumed = 0;
                    const pending: Array<readonly Float32Array[]> = [];
                    const place = (planes: readonly Float32Array[]): void => {
                        const available = planes[0]?.length ?? 0;
                        const count = Math.min(
                            available,
                            Math.max(0, declaredFrames - epochConsumed),
                        );
                        const from = Math.min(
                            count,
                            Math.max(0, cursor - destination - epochConsumed),
                        );
                        epochConsumed += count;
                        if (count <= from) return;
                        pending.push(planes.map(plane => plane.subarray(from, count)));
                        cursor += count - from;
                    };
                    const drain = function* (): Generator<readonly Float32Array[]> {
                        while (pending.length > 0) {
                            lifetime.check();
                            yield pending.shift()!;
                            lifetime.check();
                        }
                    };
                    const padUntil = function* (end: number): Generator<readonly Float32Array[]> {
                        const limit = Math.min(declaredFrames, end);
                        while (epochConsumed < limit) {
                            lifetime.check();
                            const count = Math.min(limit - epochConsumed, 16384);
                            place(
                                Array.from(
                                    { length: layout.targetChannels },
                                    () => new Float32Array(count),
                                ),
                            );
                            yield* drain();
                        }
                    };
                    const makeTransformer = (): StreamingPcmTransformer =>
                        new StreamingPcmTransformer(
                            rate,
                            channels,
                            layout.targetRate,
                            layout.targetChannels,
                            place,
                            {},
                            aacChannelMask(epoch.config.codecConfig, channels),
                        );
                    let transformer = makeTransformer();
                    const codec = await lifetime.waitFor(
                        configurationCodec(aacDecoder, track, epoch.config.codecConfig),
                    );
                    const newDecoder = () => lifetime.waitFor(Promise.resolve(codec.create()));
                    let decoder = await newDecoder();
                    let failures = 0;
                    const codedUnitSeconds = samplesPerUnit / rate;
                    for (
                        let sampleIndex = epoch.startIndex;
                        sampleIndex < epoch.endIndex;
                        sampleIndex++
                    ) {
                        lifetime.check();
                        const sample = sampleAt(track, sampleIndex)!;
                        const previous =
                            sampleIndex > epoch.startIndex
                                ? sampleAt(track, sampleIndex - 1)
                                : undefined;

                        if (
                            previous &&
                            sample.timestamp - previous.timestamp - codedUnitSeconds > 0.02
                        ) {
                            transformer.flush();
                            yield* drain();
                            const sampleDestination = Math.max(
                                destination,
                                Math.round(
                                    (sample.timestamp - layout.baseStart) * layout.targetRate,
                                ),
                            );
                            yield* padUntil(sampleDestination - destination);
                            transformer = makeTransformer();
                        }
                        const data = sample.data ?? (await read(sample, sampleIndex));
                        lifetime.check();
                        let decoded: readonly (readonly Float32Array[])[];
                        try {
                            decoded = [...decoder.decode(data)];
                            for (const planes of decoded)
                                if (planes.length !== channels)
                                    throw new DecodeError(
                                        `AAC unit ${sampleIndex} has another channel count`,
                                    );
                            failures = 0;
                            for (; held > 0; held--)
                                transformer.push(silentUnit(channels, samplesPerUnit));
                            decodedAny = true;
                        } catch (error) {
                            if (!conceal(sampleIndex, error, ++failures)) throw error;
                            decoder = await newDecoder();
                            decoded = decodedAny ? [silentUnit(channels, samplesPerUnit)] : [];
                            if (!decodedAny) {
                                held++;
                                heldError ??= error;
                            }
                        }
                        for (const planes of decoded) transformer.push(planes);
                        yield* drain();
                        processedSamples++;
                        lifetime.check();
                        if ((processedSamples & 15) === 0) {
                            await lifetime.waitFor(yieldEventLoop());
                        }
                    }
                    if (held) throw heldError;
                    transformer.flush();
                    yield* drain();
                    yield* padUntil(declaredFrames);
                }
                while (cursor < layout.rawFrames) {
                    const count = Math.min(layout.rawFrames - cursor, 16384);
                    yield Array.from(
                        { length: layout.targetChannels },
                        () => new Float32Array(count),
                    );
                    lifetime.check();
                    cursor += count;
                }
                lifetime.check();
            } catch (error) {
                throw lifetime.record(error);
            } finally {
                lifetime.stop();
            }
        },
    };
    const trimmed = normalizePcmSource(rawSource, layout.targetRate, layout.targetChannels, {
        head: layout.headFrames,
        valid: layout.totalFrames,
    });
    return { ...trimmed, startOffset: layout.startOffset };
}

/** The configurations of a track with their decoded shapes. */
function trackConfigurations(
    track: TrackInfo,
): { config: Uint8Array | undefined; rate: number; channels: number }[] {
    return track.codecConfigurations?.length
        ? track.codecConfigurations.map(configuration => ({
              config: configuration.codecConfig,
              rate: configuration.sampleRate ?? track.sampleRate,
              channels: configuration.channelCount ?? track.channelCount,
          }))
        : [{ config: track.codecConfig, rate: track.sampleRate, channels: track.channelCount }];
}

/**
 * True when `decoders` hold a software AAC decoder (the aac plugin's) and it handles every
 * configuration of the track: Main and LC, with SBR and parametric stereo (HE-AAC, HE-AACv2).
 */
export function hasBuiltinAacDecoder(
    track: TrackInfo,
    decoders: readonly BuiltinAudioDecoder[] = [],
): boolean {
    return (
        aacDecoderOf(decoders) !== undefined &&
        trackConfigurations(track).every(({ config }) => !builtinAacProblem(config))
    );
}

/**
 * AAC decoding: single-configuration tracks whose access units play back to back decode host-first
 * like any other track; tracks with configuration changes or holes use the software decoder of the
 * aac plugin on a configured timeline. Without that plugin, and for object types it lacks (LTP,
 * SSR, low delay), single-configuration tracks need the host AudioDecoder.
 */
export function aacTrackSource(
    track: TrackInfo,
    read: EncodedAudioSampleReader,
    options: TrackDecodeSettings,
): ReplayablePcmSource {
    const configurations = track.codecConfigurations?.length ?? 0;
    const aacDecoder = aacDecoderOf(options.decoders);
    if (configurations <= 1 && (!aacDecoder || builtinAacProblem(track.codecConfig)))
        return decodeAudioTrack(track, read, options, null);
    if (!aacDecoder)
        throw (options.missing ?? NO_PLUGINS).audioDecoder(
            track.codec,
            'AAC configuration changes mid-track, which only the built-in decoder follows',
        );

    const window = configurations <= 1 ? contiguousAacWindow(track) : null;
    if (window) {
        const config = track.codecConfig!;
        const channelMask = aacChannelMask(config, track.channelCount);
        return decodeAudioTrack(track, read, options, {
            window,
            ...(channelMask !== undefined ? { channelMask } : {}),
            create: async warn =>
                (await configurationCodec(aacDecoder, track, config)).create(warn),
        });
    }

    if (track.incomplete && options.validation === 'strict')
        throw new MediaForgeError(
            'Strict validation refuses to decode a damaged audio track',
            'FORMAT',
        );
    const prepared = createConfiguredAacTrackPcmSource(
        track,
        read,
        aacDecoder,
        aacConcealment(track, options),
    );

    return {
        sampleRate: prepared.sampleRate,
        channels: prepared.channels,
        estimatedFrames: prepared.estimatedFrames,
        ...(prepared.channelMask !== undefined ? { channelMask: prepared.channelMask } : {}),
        async *chunks(replaySignal) {
            const linked = linkAbortSignals(options.signal, replaySignal);
            try {
                yield* prepared.chunks(linked.signal);
            } catch (error) {
                if (error instanceof MediaForgeError || linked.signal.aborted) throw error;
                throw new DecodeError(`AAC decode failed: ${errorMessage(error)}`);
            } finally {
                linked.dispose();
            }
        },
    };
}
