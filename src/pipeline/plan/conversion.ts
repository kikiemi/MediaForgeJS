import type { Warn } from '../../core/errors/diagnostics';
import { MediaForgeError, type ErrorCode } from '../../core/errors/errors';
import type { OutputContainerFormat } from '../../core/model/media';
import { codecFamily } from '../../core/model/codec-strings';
import { carriesSubtitle, copiesOnRequest, MP4_FAMILY } from '../../formats/shared/capabilities';
import {
    audioEncodeQuery,
    autoAudioCodecs,
    autoVideoFamilies,
    canEncodeAudioCodec,
    chooseAudioEncoderCodec,
    chooseVideoEncoderCodec,
    encodableAudioCodec,
    encodableVideoCodec,
    requiredEncoderError,
    substitutedMessage,
} from './codec-choice';
import { hostCodecAvailable } from '../../codecs/webcodecs/support';
import {
    REMUX_FORMATS,
    assertAudioEncodeRequest,
    targetCodec,
    trackCapacity,
} from './format-policy';
import type { Engine } from '../engine';
import type { MediaFile } from '../read/media-file';
import { mediaFileState } from '../read/file-state';
import { copyPlan, selectedTracks } from './media-plan';
import type { MediaTrack } from '../../core/model/media';
import type { AudioFileRequest, ConvertRequest, CopyRequest, OperationRequest } from '../types';
import type { CodecPreference, MediaPlan } from '../api-types';
import { qualityBitrate, type VideoQuality } from './encode-settings';

/**
 * The decisions of a conversion that depend on the input: which tracks a target keeps, whether its
 * tracks are copied or re-encoded, which codec `'auto'` names, the bitrate of a quality, and the
 * report of what each track undergoes. The API hands over a target whose every setting it has read
 * and checked; nothing here reads user options.
 */

/** A container or audio target, its settings resolved by the API. */
export interface ConversionTarget {
    readonly kind: 'remux' | 'convert' | 'audio';
    readonly format: string;
    readonly request: OperationRequest;
    /** The audio tracks are left out of a container target. */
    readonly mute?: boolean;
    /**
     * true copies every track or fails; false re-encodes every track; omitted copies what the
     * target carries.
     */
    readonly copy?: boolean;
    /** Scales the default video bitrate when the request sets none. */
    readonly quality?: VideoQuality;
    /** The codec preference of the target, which a re-encode in place of a copy keeps. */
    readonly codecPreference?: CodecPreference;
    /**
     * Allowed when a codec cannot keep the source precision; a re-encode in place of a copy keeps
     * it.
     */
    readonly allowPrecisionLoss?: boolean;
    /**
     * The strict option policy: a codec this host cannot encode fails instead of being replaced.
     */
    readonly strict?: boolean;
    /**
     * The only audio codec the target holds (Opus for an 'opus' target): other audio is encoded to
     * it, never copied or replaced by another codec, and a host without its encoder fails.
     */
    readonly exactAudioCodec?: string;
}

/** The input's own container as a target format, or mp4 when it cannot be written. */
export function sameContainer(format: string): string {
    return (REMUX_FORMATS as readonly string[]).includes(format) ? format : 'mp4';
}

/** The tracks of `file` a request selects. */
function selectedOf(
    file: MediaFile,
    trackIds: readonly number[] | undefined,
): readonly MediaTrack[] {
    return selectedTracks(file.tracks, trackIds);
}

/**
 * The request a target runs on this input. A target keeps the selected tracks it holds
 * (fittedTracks); copy targets copy when every selected track fits and re-encode otherwise (unless
 * `copy: true`); audio targets without settings copy the track when the format carries its codec;
 * `copy: false` re-encodes every kept track.
 */
async function requestFor(
    engine: Engine,
    file: MediaFile,
    target: ConversionTarget,
    warn: Warn,
): Promise<OperationRequest> {
    const request = target.request;
    if (target.kind === 'audio')
        return audioCopy(engine, file, target, request as AudioFileRequest) ?? request;
    const container = request as CopyRequest | ConvertRequest;
    const muted = mutedTracks(file, target, container);
    const selection = muted ? { ...container, trackIds: muted } : container;
    const named = container.trackIds !== undefined;
    const selected = fittedTracks(file, target, selection, named, warn) ?? muted;
    const narrowed = selected ? ({ ...request, trackIds: selected } as OperationRequest) : request;
    if (target.kind === 'remux')
        return copyOrReencode(engine, file, target, narrowed as CopyRequest, warn);
    // `copy: false` re-encodes every kept track, also those the settings leave as they are.
    return target.copy === false ? { ...(narrowed as ConvertRequest), reencode: true } : narrowed;
}

/**
 * The selected tracks the target holds: of each kind as many as it takes, first ones first, and
 * the subtitle tracks whose codec it carries. The tracks left out are reported once; under strict
 * validation a selection the request names is kept, and then fails.
 */
function fittedTracks(
    file: MediaFile,
    target: ConversionTarget,
    request: CopyRequest | ConvertRequest,
    named: boolean,
    warn: Warn,
): number[] | undefined {
    const strict = target.strict || mediaFileState(file).diagnostics.validation === 'strict';
    if (named && strict) return undefined;
    const tracks = selectedOf(file, request.trackIds);
    const held = new Map<string, number>();
    const kept = tracks.filter(track => {
        const count = held.get(track.type) ?? 0;
        const fits =
            count < trackCapacity(target.format, track.type) &&
            (track.type !== 'subtitle' || carriesSubtitle(target.format, track.codec));
        if (fits) held.set(track.type, count + 1);
        return fits;
    });
    if (!kept.length || kept.length === tracks.length) return undefined;
    const left = tracks.filter(track => !kept.includes(track));
    warn({
        code: 'TARGET_TRACKS_DROPPED',
        ...(left.length === 1 ? { trackId: left[0]!.id } : {}),
        format: target.format,
        message:
            `${target.format} cannot hold track${left.length > 1 ? 's' : ''} ` +
            left.map(track => `${track.id} (${track.type})`).join(', '),
    });
    return kept.map(track => track.id);
}

/**
 * The selected tracks without audio when the target mutes; a target left without tracks fails with
 * FORMAT.
 */
function mutedTracks(
    file: MediaFile,
    target: ConversionTarget,
    request: CopyRequest | ConvertRequest,
): number[] | undefined {
    if (!target.mute) return undefined;
    const tracks = selectedOf(file, request.trackIds);
    const kept = tracks.filter(track => track.type !== 'audio').map(track => track.id);
    if (!kept.length)
        throw new MediaForgeError('Muting leaves no track to write', 'FORMAT', {
            hint: 'Select a video track with trackIds, or drop audio.mute.',
        });
    return kept.length === tracks.length ? undefined : kept;
}

/**
 * The copy of the selected audio track into an audio target that changes nothing, when the format
 * carries it; `copy: true` fails where it does not.
 */
function audioCopy(
    engine: Engine,
    file: MediaFile,
    target: ConversionTarget,
    request: AudioFileRequest,
): CopyRequest | undefined {
    const changed = [
        request.sampleRate,
        request.channels,
        request.bitrate,
        request.vbr,
        request.codec,
        request.start,
        request.end,
        request.stages,
    ].some(value => value !== undefined);
    if (target.copy === false || changed) return undefined;

    const track =
        request.trackId !== undefined
            ? file.tracks.find(candidate => candidate.id === request.trackId)
            : file.tracks.find(candidate => candidate.type === 'audio');
    if (!track || track.type !== 'audio') return undefined;

    const copies = (REMUX_FORMATS as readonly string[]).includes(target.format);
    const copy: CopyRequest = {
        operation: 'remux',
        format: target.format as CopyRequest['format'],
        trackIds: [track.id],
        signal: request.signal,
        onProgress: request.onProgress,
    };
    const probe = copies ? engine.probe(file, copy) : undefined;
    if (probe?.supported) return copy;
    if (target.copy !== true) return undefined;
    // A copy stopped by something else (an abort, a limit) fails as that.
    if (probe && probe.code !== 'FORMAT')
        throw new MediaForgeError(probe.reason, probe.code, {
            hint: 'hint' in probe ? probe.hint : undefined,
        });
    const reason = probe ? probe.reason : `${target.format} output is always encoded`;
    throw new MediaForgeError(`copy: true cannot copy ${track.codec} audio: ${reason}`, 'FORMAT', {
        hint: `Drop copy: true to encode the audio as ${target.format}.`,
    });
}

/**
 * The copy when every selected track fits, otherwise a re-encode, reported once; `copy: true` never
 * re-encodes.
 */
async function copyOrReencode(
    engine: Engine,
    file: MediaFile,
    target: ConversionTarget,
    request: CopyRequest,
    warn: Warn,
): Promise<OperationRequest> {
    const asked = selectedOf(file, request.trackIds).find(track =>
        copiesOnRequest(target.format, track.codec),
    );
    const exact = target.exactAudioCodec;
    const foreign = exact
        ? selectedOf(file, request.trackIds).find(
              track => track.type === 'audio' && codecFamily(track.codec) !== exact,
          )
        : undefined;
    if (foreign && target.copy === true)
        throw new MediaForgeError(
            `copy: true keeps ${foreign.codec} audio, but ${exact} output holds ${exact} only`,
            'FORMAT',
            { hint: `Drop copy: true to encode the audio as ${exact}.` },
        );
    const copy = foreign
        ? {
              supported: false as const,
              reason: `${exact} output holds ${exact} audio only, not ${foreign.codec}`,
              code: 'FORMAT' as const,
          }
        : asked && target.copy !== true
          ? {
                supported: false as const,
                reason: `${asked.codec} goes into ${target.format} only with copy or audio.codec`,
                code: 'FORMAT' as const,
            }
          : engine.probe(file, request);
    if (copy.supported) {
        // A range leaves out the tracks it misses: the plan, the request and its report do so here.
        const written = copy.plan.tracks.map(track => track.trackId);
        const left = selectedOf(file, request.trackIds).filter(
            track => !written.includes(track.id),
        );
        if (!left.length) return request;
        for (const { severity: _severity, ...warning } of copy.warnings)
            if (
                warning.code === 'TARGET_TRACKS_DROPPED' &&
                left.some(t => t.id === warning.trackId)
            )
                warn(warning);
        return { ...request, trackIds: written };
    }
    if (target.copy === true) return request;
    // A request the copy refuses as such (a range past every track's end) fails as it is: a
    // re-encode would read no more of the input.
    if (copy.code === 'INPUT')
        throw new MediaForgeError(copy.reason, copy.code, {
            hint: 'hint' in copy ? copy.hint : undefined,
        });

    await engine.prepare();
    const { codecPreference, allowPrecisionLoss } = target;
    const fallback: ConvertRequest = {
        operation: 'convert',
        format: target.format as OutputContainerFormat,
        trackIds: request.trackIds,
        allowPrecisionLoss,
        start: request.start,
        end: request.end,
        signal: request.signal,
        onProgress: request.onProgress,
        ...(codecPreference !== undefined ? { codecPreference } : {}),
        ...(exact ? { audioCodec: exact } : {}),
    };

    let reencode = fallback;
    let converted = engine.probe(file, reencode);
    if (!converted.supported && !converted.plugin && !target.strict && !exact) {
        const substituted = await withoutHostAudioEncoder(
            engine,
            file,
            reencode,
            candidate => engine.probe(file, candidate).supported,
            warn,
        );
        if (substituted) {
            reencode = substituted;
            converted = engine.probe(file, reencode);
        }
    }

    if (!converted.supported) {
        const missing = await exactEncoderMissing(engine, target, reencode, foreign);
        if (missing) throw missing;
    }

    // A re-encode that needs a plugin names it: including the plugin is what makes the target work.
    if (!converted.supported && converted.plugin)
        throw new MediaForgeError(converted.reason, 'PLUGIN', {
            hint: converted.hint,
            plugin: converted.plugin,
            cause: converted.reason,
        });
    if (!converted.supported) throw neitherCopyNorReencode(target.format, copy, converted);

    // The conversion's own plan says whether it re-encodes: it may copy every track it keeps.
    if (converted.plan.tracks.some(track => track.action === 'encode'))
        warn({
            code: 'TARGET_REENCODED',
            message: `${target.format} re-encodes the tracks: ${copy.reason}`,
        });
    return reencode;
}

/**
 * Why `format` takes the tracks neither as a copy nor re-encoded, both refusals named briefly ("mp4
 * cannot copy these tracks (it cannot hold vp8) or re-encode them (it cannot keep the alpha
 * channel)"); `cause` holds both reasons in full.
 */
function neitherCopyNorReencode(
    format: string,
    copy: { readonly reason: string; readonly code: ErrorCode },
    reencode: { readonly reason: string; readonly hint?: string },
): MediaForgeError {
    const options = {
        hint: reencode.hint,
        cause: `copy: ${copy.reason}; re-encode: ${reencode.reason}`,
    };
    const copying = refusal(format, copy.reason);
    const reencoding = refusal(format, reencode.reason);
    const message =
        copying === reencoding
            ? `${format} cannot copy or re-encode these tracks (${copying})`
            : `${format} cannot copy these tracks (${copying}) or re-encode them (${reencoding})`;
    return new MediaForgeError(message, copy.code, options);
}

/**
 * A refusal as a short clause about the output (an MP4 copy may name the fragmented MP4 it falls
 * back to): "mp4 cannot mux video codec 'vp8'" becomes "it cannot hold vp8".
 */
function refusal(format: string, reason: string): string {
    const owner = /^(\S+) cannot /.exec(reason)?.[1];
    if (owner !== format && !(owner === 'fmp4' && MP4_FAMILY.has(format)))
        return /^[A-Z][a-z]+\b/.test(reason) ? reason[0]!.toLowerCase() + reason.slice(1) : reason;
    const rest = reason.slice(owner.length + 1);
    const codec = /^cannot mux \w+ codec '([^']+)'$/.exec(rest)?.[1];
    return codec ? `it cannot hold ${codec}` : `it ${rest}`;
}

/** The query of the audio encoder of `track` under the settings of `request`. */
function trackAudioQuery(request: ConvertRequest, track: MediaTrack) {
    return audioEncodeQuery(
        request.audioSampleRate ?? track.sampleRate,
        request.audioChannels ?? track.channelCount,
        request.audioBitrate,
    );
}

/** Resolves `codec: 'auto'` against the host encoders and the target's quality into a bitrate. */
async function settle(
    engine: Engine,
    file: MediaFile,
    request: OperationRequest,
    quality: VideoQuality | undefined,
    warn: Warn,
): Promise<OperationRequest> {
    if (request.operation !== 'convert') return request;
    const tracks = selectedOf(file, request.trackIds);
    const video = tracks.find(track => track.type === 'video');
    const audio = tracks.find(track => track.type === 'audio');
    let result: ConvertRequest = request;

    const sourceWidth = video?.width ?? 0;
    const sourceHeight = video?.height ?? 0;
    const width =
        request.width ??
        (request.height && sourceHeight
            ? Math.round((sourceWidth * request.height) / sourceHeight)
            : sourceWidth);
    const height =
        request.height ??
        (request.width && sourceWidth
            ? Math.round((sourceHeight * request.width) / sourceWidth)
            : sourceHeight);
    const framerate = request.fps ?? video?.framerate ?? 30;

    if (request.videoCodec === 'auto') {
        const chosen =
            video && width && height
                ? await chooseVideoEncoderCodec(
                      autoVideoFamilies(request.format),
                      {
                          width,
                          height,
                          framerate,
                          bitrate: request.videoBitrate,
                          container: request.format,
                          hardwareAcceleration: request.hardwareAcceleration,
                          latencyMode: request.latencyMode,
                          bitrateMode: request.bitrateMode,
                      },
                      request.signal,
                  )
                : undefined;
        const family = chosen === undefined ? undefined : codecFamily(chosen);
        if (chosen === undefined && video)
            warn({
                code: 'OPTION_NORMALIZED',
                message: `No ${request.format} video codec is encodable here; using the default`,
            });
        result = {
            ...result,
            videoCodec: family === undefined ? undefined : family === 'avc' ? 'avc1' : family,
        };
    }

    if (request.audioCodec === 'auto') {
        const chosen = audio
            ? await chooseAudioEncoderCodec(
                  autoAudioCodecs(request.format),
                  engine.containerAudio.codecs,
                  trackAudioQuery(request, audio),
                  request.signal,
              )
            : undefined;
        result = { ...result, audioCodec: chosen };
    }

    if (quality && result.videoBitrate === undefined && video && width && height)
        result = {
            ...result,
            videoBitrate: qualityBitrate(
                quality,
                result.videoCodec ?? video.codec,
                width,
                height,
                framerate,
            ),
        };
    return result;
}

/**
 * Without a host AudioEncoder, a re-encode into an audio codec no installed encoder writes cannot
 * be planned at all (Opus into Matroska or Ogg in Node): the target's next codec of its `'auto'`
 * order an installed encoder writes takes its place, and `request` with it, when the plan holds
 * with it.
 */
async function withoutHostAudioEncoder(
    engine: Engine,
    file: MediaFile,
    request: ConvertRequest,
    plans: (request: ConvertRequest) => boolean,
    warn: Warn,
): Promise<ConvertRequest | undefined> {
    if (hostCodecAvailable('AudioEncoder')) return undefined;
    const audio = selectedOf(file, request.trackIds).find(track => track.type === 'audio');
    if (!audio) return undefined;
    const codec = targetCodec(request.format, request.audioCodec, audio.codec, 'audio');

    // A codec no encoder writes anywhere (Vorbis) fails as it does with a host encoder.
    try {
        assertAudioEncodeRequest(codec);
    } catch {
        return undefined;
    }

    const choice = await encodableAudioCodec(
        codec,
        request.format,
        engine.containerAudio.codecs,
        trackAudioQuery(request, audio),
        request.signal,
    );
    if (!choice?.substituted) return undefined;
    const substituted: ConvertRequest = { ...request, audioCodec: choice.codec };
    if (!plans(substituted)) return undefined;
    warn({
        code: 'CODEC_SUBSTITUTED',
        trackId: audio.id,
        message: substitutedMessage('audio', choice.codec, codec),
    });

    return substituted;
}

/**
 * The request of a target that holds one audio codec, unchanged, when this host encodes what its
 * plan encodes into that codec; otherwise the error naming the missing encoder.
 */
async function exactAudioRequest(
    engine: Engine,
    file: MediaFile,
    target: ConversionTarget,
    request: ConvertRequest,
): Promise<ConvertRequest> {
    const audio = selectedOf(file, request.trackIds).filter(track => track.type === 'audio');
    let encoded: readonly MediaTrack[];
    try {
        const plans = engine.plan(file, request).tracks;
        encoded = audio.filter(track =>
            plans.some(plan => plan.trackId === track.id && plan.action === 'encode'),
        );
    } catch (error) {
        const foreign = audio.find(track => codecFamily(track.codec) !== target.exactAudioCodec);
        throw (await exactEncoderMissing(engine, target, request, foreign)) ?? error;
    }
    const missing = await exactEncoderMissing(engine, target, request, encoded[0]);
    if (missing) throw missing;
    return request;
}

/**
 * The error of a target that holds one audio codec (an 'opus' target) when this host cannot encode
 * `audio` into it, or undefined when it can: PLUGIN when a known plugin adds the encoder, else
 * ENCODE naming the gap.
 */
async function exactEncoderMissing(
    engine: Engine,
    target: ConversionTarget,
    request: ConvertRequest,
    audio: MediaTrack | undefined,
): Promise<MediaForgeError | undefined> {
    const codec = target.exactAudioCodec;
    if (!codec || !audio) return undefined;
    const installed = engine.containerAudio.codecs;
    const query = trackAudioQuery(request, audio);
    if (await canEncodeAudioCodec(codec, installed, query, request.signal)) return undefined;
    const error = requiredEncoderError(codec);
    const plugin = engine.formats.writers.missing.audioEncoder(codec, error.message, 'ENCODE');
    return plugin.code === 'PLUGIN' ? plugin : error;
}

/**
 * A re-encode whose codec this host cannot encode takes the first codec of the target's `'auto'`
 * order it can, reported as CODEC_SUBSTITUTED. The strict option policy keeps the request, which
 * then fails naming the codec; a target that holds one audio codec keeps it and fails clearly.
 */
async function substituteCodecs(
    engine: Engine,
    file: MediaFile,
    target: ConversionTarget,
    request: OperationRequest,
    warn: Warn,
): Promise<OperationRequest> {
    if (request.operation !== 'convert') return request;
    if (target.exactAudioCodec) return exactAudioRequest(engine, file, target, request);
    if (target.strict) return request;
    const tracks = file.tracks;
    let result: ConvertRequest = request;
    let plans: MediaPlan['tracks'];
    try {
        plans = engine.plan(file, request).tracks;
    } catch (error) {
        const substituted =
            error instanceof MediaForgeError && error.code === 'ENCODE'
                ? await withoutHostAudioEncoder(
                      engine,
                      file,
                      request,
                      candidate => engine.probe(file, candidate).supported,
                      warn,
                  )
                : undefined;
        if (!substituted) throw error;
        result = substituted;
        plans = engine.plan(file, result).tracks;
    }

    for (const plan of plans) {
        if (plan.action !== 'encode' || plan.encoder === 'plugin') continue;
        const track = tracks.find(candidate => candidate.id === plan.trackId)!;
        if (plan.type === 'video') {
            const width = request.width ?? track.width ?? 0;
            const height = request.height ?? track.height ?? 0;
            const query = {
                width,
                height,
                framerate: request.fps ?? track.framerate,
                bitrate: request.videoBitrate,
                container: request.format,
                hardwareAcceleration: request.hardwareAcceleration,
                latencyMode: request.latencyMode,
                bitrateMode: request.bitrateMode,
                explicit: request.videoCodec?.includes('.') === true,
            };

            const choice =
                width && height
                    ? await encodableVideoCodec(plan.codec, request.format, query, request.signal)
                    : undefined;
            if (!choice?.substituted) continue;
            warn({
                code: 'CODEC_SUBSTITUTED',
                trackId: plan.trackId,
                message: substitutedMessage('video', choice.codec, plan.codec),
            });
            result = { ...result, videoCodec: choice.codec };
        } else if (plan.type === 'audio' && plan.encoder === 'webcodecs') {
            const choice = await encodableAudioCodec(
                plan.codec,
                request.format,
                engine.containerAudio.codecs,
                trackAudioQuery(request, track),
                request.signal,
            );
            if (!choice?.substituted) continue;
            warn({
                code: 'CODEC_SUBSTITUTED',
                trackId: plan.trackId,
                message: substitutedMessage('audio', choice.codec, plan.codec),
            });
            result = { ...result, audioCodec: choice.codec };
        }
    }
    return result;
}

/**
 * The request and plan of a container or audio target on the input: tracks, copy or re-encode, the
 * codec of `'auto'` and the bitrate of the quality. `warn` receives the target's decisions
 * (TARGET_TRACKS_DROPPED, TARGET_REENCODED).
 */
export async function prepareConversion(
    engine: Engine,
    file: MediaFile,
    target: ConversionTarget,
    warn: Warn,
): Promise<{ readonly request: OperationRequest; readonly plan: MediaPlan }> {
    // The writers the copy check needs, the fragmented MP4 writer included when an MP4 copy falls
    // back to it.
    await file.loadWriter(target.format);
    const requested = await requestFor(engine, file, target, warn);
    // A copy plans without the code that decodes and encodes; anything else loads it first.
    if (requested.operation !== 'remux') await engine.prepare();
    const settled = await settle(engine, file, requested, target.quality, warn);
    const request = await substituteCodecs(engine, file, target, settled, warn);
    // A copy was checked while choosing it; its plan is the selected tracks, copied.
    const plan =
        request.operation === 'remux'
            ? copyPlan(target.format, selectedOf(file, request.trackIds), request)
            : engine.plan(file, request);
    return { request, plan };
}
