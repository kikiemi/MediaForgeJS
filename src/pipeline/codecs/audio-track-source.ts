import { NO_PLUGINS, type MissingParts } from '../plugins/missing-parts';
import type {
    AudioDecoderWarning,
    BuiltinAudioCodec,
    EncodedAudioSampleReader,
} from '../../core/contracts/decoder';
import type { AudioTrackDecodeOptions } from '../api-types';
import type { TrackInfo } from '../../core/model/track';
import { sampleAt, sampleCount } from '../../core/model/sample-index';
import {
    DecodeError,
    MediaForgeError,
    errorMessage,
    throwIfAborted,
} from '../../core/errors/errors';
import { awaitWithAbort, linkAbortSignals } from '../../core/io/abort';
import { yieldEventLoop } from '../../core/io/event-loop';
import { editPresentationSamples } from '../../core/model/audio-window';
import { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import { HostAudioDecoder, hostAudioDecoderConfig } from '../../codecs/webcodecs/audio';
import { codecError } from '../../codecs/webcodecs/codec';
import { hostSupports } from '../../codecs/webcodecs/support';
import { decoderOrder, readsLinearPcm, routeAvailable } from './router';
import {
    declarePacketStarts,
    normalizePcmSource,
    type ReplayablePcmSource,
} from '../../codecs/pcm/pcm-source';
import { codecFamily } from '../../core/model/codec-strings';
import { parseFlacFrameHeader } from '../../core/codec-config/audio/flac-frame';
import { sampleClockTolerance } from '../../core/model/sample-clock';

/** The engine's decode settings: the public options and the composition's missing-part errors. */
export interface TrackDecodeSettings extends AudioTrackDecodeOptions {
    /** Names the plugin that would decode a track nothing in use decodes; default none. */
    readonly missing?: MissingParts;
}

const SILENCE_FRAMES = 16384;

/**
 * Undecodable packets in a row a complete track conceals; one more is a failure, as a stream no
 * packet of decodes is not damaged but undecodable.
 */
export const MAX_CONSECUTIVE_CONCEALMENTS = 16;

/** Planes of silence for `frames` frames, in bounded work units. */
function* silentPlanes(channels: number, frames: number): Generator<Float32Array[]> {
    for (let remaining = frames; remaining > 0; remaining -= SILENCE_FRAMES) {
        const count = Math.min(remaining, SILENCE_FRAMES);
        yield Array.from({ length: channels }, () => new Float32Array(count));
    }
}

/** `units` without their last `frames` frames. */
function withoutLast(
    units: readonly (readonly Float32Array[])[],
    frames: number,
): (readonly Float32Array[])[] {
    let keep = units.reduce((sum, planes) => sum + planes[0]!.length, 0) - frames;
    return units.flatMap(planes => {
        const length = planes[0]!.length;
        const kept = Math.max(0, Math.min(length, keep));
        keep -= kept;
        if (kept === length) return [planes];
        return kept > 0 ? [planes.map(plane => plane.subarray(0, kept))] : [];
    });
}

/**
 * Every sample one host AudioDecoder emits for the track's packets, in order, with `gaps` silent
 * frames inserted before a packet (the decoder is flushed there). The stream is flushed only at
 * gaps, after a packet that drops its last samples (where files were joined, when `trims`) and at
 * its end, since a flush resets the decoder and drops the MP3 bit reservoir and every codec's
 * overlap state; the decoder queue bounds the memory. Failures are DECODE errors; the decoder is
 * closed when the iteration ends.
 */
async function* hostDecodedPlanes(
    track: TrackInfo,
    config: AudioDecoderConfig,
    gaps: ReadonlyMap<number, number>,
    read: EncodedAudioSampleReader,
    signal: AbortSignal,
    warn: AudioDecoderWarning,
    first: number,
    trims: boolean,
): AsyncGenerator<readonly Float32Array[]> {
    const lifetime = new CodecLifetime(signal);
    let decoder: HostAudioDecoder | undefined;
    try {
        decoder = new HostAudioDecoder(config, lifetime, warn);
        for (let index = first, count = sampleCount(track); index < count; index++) {
            const gap = gaps.get(index);
            if (gap) {
                await decoder.flush();
                yield* decoder.take();
                for (const planes of silentPlanes(track.channelCount, gap)) {
                    lifetime.check();
                    yield planes;
                }
            }

            const sample = sampleAt(track, index)!;
            const data = sample.data ?? (await lifetime.waitFor(read(sample, index, signal)));
            await decoder.decode(
                data,
                Math.round(sample.timestamp * 1e6),
                Math.max(0, Math.round(sample.duration * 1e6)),
            );
            if (trims && sample.trailingDiscard) {
                await decoder.flush();
                yield* withoutLast([...decoder.take()], sample.trailingDiscard);
            } else if ((index & 7) === 7) {
                yield* decoder.take();
                await lifetime.waitFor(yieldEventLoop());
            }
        }
        await decoder.flush();
        yield* decoder.take();
        lifetime.check();
        // A host can take a codec string and decode nothing of the packets (Chromium 152 given
        // MP2 as 'mp3'): the track is not decoded, so the next decoder takes it.
        if (decoder.frames === 0 && first < sampleCount(track))
            throw new MediaForgeError(
                `AudioDecoder decoded nothing of the '${track.codec}' track`,
                'DECODE',
            );
    } catch (error) {
        throw lifetime.record(
            codecError(error, 'DECODE', `AudioDecoder failed for '${track.codec}'`),
        );
    } finally {
        lifetime.stop();
        decoder?.close();
    }
}

/** Coded timeline shared by the host and built-in decoders, so both present the same samples. */
interface CodedLayout {
    /** Silent frames inserted before a packet whose timestamp leaves a hole of more than 20 ms. */
    readonly gaps: ReadonlyMap<number, number>;
    /** Frames of every coded packet plus inserted silence. */
    readonly frames: number;
    /** Leading frames discarded (priming samples or the edit start). */
    readonly head: number;
    /** Presented frames. */
    readonly valid: number;
    /** Coded frames of each packet, the length of concealing silence. */
    readonly durations: Uint32Array;
}

function codedLayout(
    track: TrackInfo,
    codec: Pick<BuiltinAudioCodec, 'window' | 'preRoll' | 'unoutputLead'>,
): CodedLayout {
    const { window } = codec;
    const rate = track.sampleRate;
    const count = sampleCount(track);
    const first = sampleAt(track, 0)!.timestamp;
    const tolerance = Math.max(sampleClockTolerance(track, 1), rate * 0.02);
    const gaps = new Map<number, number>();
    const durations = new Uint32Array(count);
    let frames = 0;

    // Packet ends are rounded from the running container time, so durations in a coarse clock
    // (Matroska milliseconds) do not drift from the packet timestamps by their accumulated
    // rounding.
    let seconds = 0;
    for (let index = 0; index < count; index++) {
        const sample = sampleAt(track, index)!;
        if ((sample.codecConfigIndex ?? 0) !== 0)
            throw new MediaForgeError(
                `${track.codec} decoder configuration changes are unsupported`,
                'FORMAT',
            );
        const start = Math.round((sample.timestamp - first) * rate);
        if (!window && index > 0 && start - frames > tolerance) {
            gaps.set(index, start - frames);
            frames = start;
            seconds = sample.timestamp - first;
        }
        const rounded = Math.round(sample.duration * rate);
        if (!Number.isSafeInteger(rounded) || rounded < 0 || rounded > 0xffffffff)
            throw new MediaForgeError(
                `${track.codec} packet ${index} has an invalid duration`,
                'FORMAT',
            );
        seconds += sample.duration;
        let duration = Math.max(0, Math.round(seconds * rate) - frames);

        // A packet that drops its last samples (where files were joined) presents the rest.
        const discard = window ? 0 : Math.min(duration, sample.trailingDiscard ?? 0);
        seconds -= discard / rate;
        duration -= discard;
        durations[index] = duration;
        frames += duration;
    }
    if (window) return { gaps, durations, ...window };
    const preRoll = track.matroskaCodecDelaySeconds === undefined ? (codec.preRoll ?? 0) : 0;
    const stated = Math.round(
        (track.editMediaTimeSeconds ??
            (track.audioPrimingSamples !== undefined
                ? track.audioPrimingSamples / rate
                : Math.max(0, -first, preRoll / rate))) * rate,
    );
    const tail = track.audioTrailingPaddingSamples ?? track.opusTrailingPaddingSamples ?? 0;
    if (![stated, tail, frames].every(Number.isSafeInteger) || stated < 0 || tail < 0)
        throw new MediaForgeError(
            `${track.codec} trim metadata exceeds the coded presentation span`,
            'DEMUX',
        );
    const valid =
        track.editPresentationDurationSeconds === undefined
            ? frames - stated - tail
            : editPresentationSamples(
                  track,
                  rate,
                  frames - stated - tail,
                  `${track.codec} trim metadata`,
              );
    const head = Math.max(0, stated - (codec.unoutputLead ?? 0));
    if (!Number.isSafeInteger(valid) || valid < 1 || stated + tail + valid > frames)
        throw new MediaForgeError(
            `${track.codec} trim metadata exceeds the coded presentation span`,
            'DEMUX',
        );
    return { gaps, frames, head, valid, durations };
}

/**
 * Codec failures that another decoder or concealment may overcome; I/O, format and abort errors are
 * final.
 */
function isDecodeFailure(error: unknown): boolean {
    if (error instanceof MediaForgeError) return error.code === 'DECODE';
    return !(error instanceof DOMException && error.name === 'AbortError');
}

/** Drops the first `skip` frames of a stream; the rest pass through unchanged. */
async function* skipFrames(
    stream: AsyncIterable<readonly Float32Array[]>,
    skip: number,
): AsyncGenerator<readonly Float32Array[]> {
    let remaining = skip;
    for await (const planes of stream) {
        const frames = planes[0]!.length;
        if (remaining >= frames) {
            remaining -= frames;
            continue;
        }
        yield remaining ? planes.map(plane => plane.subarray(remaining)) : planes;
        remaining = 0;
    }
}

/**
 * Presentation PCM of one audio track: priming, padding and edits trimmed, timeline holes filled
 * with silence and planes in WAVE speaker order. The host AudioDecoder runs first when it supports
 * the configuration (unless the preference is 'builtin'), except for linear PCM, which the library
 * reads (readsLinearPcm); a decode failure of the first decoder restarts the track on the other one
 * from where the first stopped, with one AUDIO_DECODER_FALLBACK warning, and replays repeat the
 * same switch point. Unless validation is 'strict', the built-in decoder conceals an undecodable
 * packet with silence of its coded length, as ffmpeg and video decoding go on past a damaged
 * packet; in a complete (not recovered) track more than MAX_CONSECUTIVE_CONCEALMENTS such packets
 * in a row fail. Without any usable decoder the iteration fails with DECODE naming the codec.
 */
export function decodeAudioTrack(
    track: TrackInfo,
    read: EncodedAudioSampleReader,
    options: TrackDecodeSettings,
    builtin: BuiltinAudioCodec | null,
    hostLayout: Pick<BuiltinAudioCodec, 'channelMask' | 'preRoll' | 'unoutputLead'> = {},
): ReplayablePcmSource {
    const {
        codecPreference = 'webcodecs',
        validation = 'compatible',
        signal,
        onWarning,
        builtinOnly,
    } = options;
    const count = sampleCount(track);
    const rate = track.sampleRate;
    const channels = track.channelCount;
    if (
        !count ||
        !Number.isInteger(rate) ||
        rate < 1 ||
        rate > 768000 ||
        !Number.isInteger(channels) ||
        channels < 1
    )
        throw new MediaForgeError(
            'Audio decoding requires samples, an integer sample rate and channels',
            'FORMAT',
        );
    if (channels > 8)
        throw new MediaForgeError('Audio decoding supports at most eight channels', 'FORMAT');
    if (track.incomplete && validation === 'strict')
        throw new MediaForgeError(
            'Strict validation refuses to decode a damaged audio track',
            'FORMAT',
        );
    if ((track.editLeadTimeSeconds ?? 0) !== 0)
        throw new MediaForgeError(
            'Decoded audio does not synthesize leading empty edits',
            'FORMAT',
        );
    if ((track.codecConfigurations?.length ?? 0) > 1)
        throw new MediaForgeError(
            `${track.codec} decoder configuration changes are unsupported`,
            'FORMAT',
        );
    const hostConfig =
        builtinOnly || readsLinearPcm(track.codec) ? null : hostAudioDecoderConfig(track);
    const unavailable = (): MediaForgeError =>
        (options.missing ?? NO_PLUGINS).audioDecoder(
            track.codec,
            `No audio decoder for '${track.codec}'`,
        );
    if (!routeAvailable('AudioDecoder', !!builtin) || (!builtin && !hostConfig))
        throw unavailable();
    const codec = builtin;
    const shape = codec ?? hostLayout;
    const layout = codedLayout(track, shape);
    /** Where a failing decoder handed the track to the other, by the packet decoding began at. */
    const switchPoints = new Map<number, number>();
    let fallbackReported = false;
    let concealReported = false;
    const warn = (code: string, message: string): void => onWarning?.({ code, message });
    const decoderWarnings = new Set<string>();
    const decoderWarn: AudioDecoderWarning = (code, message) => {
        if (decoderWarnings.has(code)) return;
        decoderWarnings.add(code);
        warn(code, message);
    };

    async function* builtinStream(
        stream: AbortSignal,
        first: number,
    ): AsyncGenerator<readonly Float32Array[]> {
        const decoder = await awaitWithAbort(Promise.resolve(codec!.create(decoderWarn)), stream);
        let previous = 0;
        let concealed = 0;
        // Silence for packets concealed before any packet of a complete track decoded is held
        // back: a track none decodes from is undecodable, not damaged, and fails.
        let decodedAny = !!track.incomplete;
        let held = 0;
        let heldError: unknown;
        for (let index = first; index < count; index++) {
            throwIfAborted(stream);
            const gap = layout.gaps.get(index);
            if (gap) yield* decoder.conceal ? decoder.conceal(gap) : silentPlanes(channels, gap);
            const sample = sampleAt(track, index)!;
            const data = sample.data ?? (await awaitWithAbort(read(sample, index, stream), stream));
            throwIfAborted(stream);

            let units: (readonly Float32Array[])[];
            try {
                units = [...decoder.decode(data)];
                if (!codec!.window && sample.trailingDiscard)
                    units = withoutLast(units, sample.trailingDiscard);
                for (const planes of units)
                    if (
                        planes.length !== channels ||
                        planes.some(plane => plane.length !== planes[0]!.length)
                    )
                        throw new MediaForgeError(
                            `${track.codec} packet ${index} has another channel count`,
                            'FORMAT',
                        );
                concealed = 0;
                if (held) yield* silentPlanes(channels, held);
                held = 0;
                decodedAny = true;
            } catch (error) {
                if (
                    stream.aborted ||
                    validation === 'strict' ||
                    !isDecodeFailure(error) ||
                    (!track.incomplete && ++concealed > MAX_CONSECUTIVE_CONCEALMENTS)
                ) {
                    if (error instanceof MediaForgeError) throw error;
                    throw new DecodeError(
                        `${track.codec} decode failed at packet ${index}: ${errorMessage(error)}`,
                    );
                }

                const frames = layout.durations[index] || previous;
                if (!concealReported) {
                    concealReported = true;
                    warn(
                        'AUDIO_FRAME_CONCEALED',
                        `${track.codec} packet ${index} is undecodable; silence replaces it`,
                    );
                }
                decoder.reset();
                units = decodedAny ? [...silentPlanes(channels, frames)] : [];
                if (!decodedAny) {
                    held += frames;
                    heldError ??= error;
                }
            }

            for (const planes of units) {
                previous = planes[0]!.length;
                yield planes;
            }
            if ((index & 31) === 31) await awaitWithAbort(yieldEventLoop(), stream);
        }
        if (heldError !== undefined && !decodedAny) {
            if (heldError instanceof MediaForgeError) throw heldError;
            throw new DecodeError(`${track.codec} decode failed: ${errorMessage(heldError)}`);
        }
        if (decoder.flush) yield* decoder.flush();
    }

    /** The track decoded from packet `first` on (its gap first), on the decoders in order. */
    async function* decoded(
        replaySignal?: AbortSignal,
        first = 0,
    ): AsyncGenerator<readonly Float32Array[]> {
        const linked = linkAbortSignals(signal, replaySignal);
        const stream = linked.signal;
        try {
            const host =
                hostConfig !== null && (await hostSupports('AudioDecoder', hostConfig, stream));
            throwIfAborted(stream);
            if (!codec && !host) throw unavailable();
            const usable = decoderOrder(codecPreference, host, !!codec);

            let emitted = 0;
            for (let attempt = 0; attempt < usable.length; attempt++) {
                const kind = usable[attempt]!;
                const limit =
                    attempt === 0 && usable.length > 1 ? switchPoints.get(first) : undefined;
                const source =
                    kind === 'host'
                        ? hostDecodedPlanes(
                              track,
                              hostConfig!,
                              layout.gaps,
                              read,
                              stream,
                              decoderWarn,
                              first,
                              !codec?.window,
                          )
                        : builtinStream(stream, first);
                try {
                    let switched = false;
                    for await (const planes of emitted ? skipFrames(source, emitted) : source) {
                        const frames = planes[0]!.length;
                        const keep =
                            limit === undefined ? frames : Math.min(frames, limit - emitted);
                        if (keep > 0) {
                            yield keep === frames
                                ? planes
                                : planes.map(plane => plane.subarray(0, keep));
                            emitted += keep;
                        }
                        if (limit !== undefined && emitted >= limit) {
                            switched = true;
                            break;
                        }
                    }
                    if (!switched) return;
                } catch (error) {
                    if (stream.aborted || attempt === usable.length - 1 || !isDecodeFailure(error))
                        throw error;
                    const switchAt = switchPoints.get(first);
                    if (switchAt === undefined || emitted < switchAt)
                        switchPoints.set(first, emitted);
                    if (!fallbackReported) {
                        fallbackReported = true;
                        const failed = kind === 'host' ? 'host AudioDecoder' : 'built-in decoder';
                        const next = kind === 'host' ? 'built-in decoder' : 'host AudioDecoder';
                        warn(
                            'AUDIO_DECODER_FALLBACK',
                            `${track.codec} ${failed} failed; the ${next} continues the track`,
                        );
                    }
                }
            }
        } finally {
            linked.dispose();
        }
    }

    const raw: ReplayablePcmSource = {
        sampleRate: rate,
        channels,
        estimatedFrames: layout.frames,
        ...(shape.channelMask !== undefined ? { channelMask: shape.channelMask } : {}),
        chunks: decoded,
    };

    // FLAC frames decode on their own, so in a track timed in samples a range can start decoding
    // at the frame it starts in: the frame's slot (its gap, then its samples) starts where the
    // slots before it end.
    if (codecFamily(track.codec) === 'flac' && track.timescale === rate && !codec?.window) {
        /** Where the frame headers place packet `index`; NaN when its header does not parse. */
        const numbered = async (index: number, stream: AbortSignal): Promise<number> => {
            const sample = sampleAt(track, index)!;
            const data = sample.data ?? (await awaitWithAbort(read(sample, index, stream), stream));
            const header = parseFlacFrameHeader(data, 0);
            if (!header) return NaN;
            return header.codedNumber * (header.blockingStrategy ? 1 : header.blockSize);
        };
        /**
         * The track from packet `first`, frame `from` of the track. Unless the frame headers place
         * that packet there too, it decodes from the first packet and drops the frames before.
         */
        async function* startedAt(
            first: number,
            from: number,
            replaySignal?: AbortSignal,
        ): AsyncGenerator<readonly Float32Array[]> {
            const linked = linkAbortSignals(signal, replaySignal);
            let placed: boolean;
            try {
                const at = from + (layout.gaps.get(first) ?? 0);
                placed =
                    (await numbered(first, linked.signal)) - (await numbered(0, linked.signal)) ===
                    at;
            } finally {
                linked.dispose();
            }
            yield* placed ? decoded(replaySignal, first) : skipFrames(decoded(replaySignal), from);
        }
        declarePacketStarts(
            raw,
            count,
            index => (layout.gaps.get(index) ?? 0) + layout.durations[index]!,
            (index, from) =>
                from < layout.frames
                    ? {
                          ...raw,
                          estimatedFrames: layout.frames - from,
                          chunks: replaySignal => startedAt(index, from, replaySignal),
                      }
                    : undefined,
        );
    }
    return normalizePcmSource(raw, rate, channels, { head: layout.head, valid: layout.valid });
}
