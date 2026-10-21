import { LOSSLESS_AUDIO_FORMATS, audioFormatCodec } from '../plan/format-policy';
import { optionalKbps } from '../plan/encode-settings';
import type { MediaFile } from '../read/media-file';
import { mediaFileState } from '../read/file-state';
import type { ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { normalizePcmSource } from '../../codecs/pcm/pcm-source';
import { stagedPcmSource } from '../../stages/chain';
import { MediaForgeError } from '../../core/errors/errors';
import {
    AAC_SAMPLE_RATES,
    MPEG_SAMPLE_RATES,
    audioChannelLimit,
    carriesChannelLayout,
} from './audio-file-writer';
import { mpegBitrates } from '../../core/codec-config/audio/mpeg-audio-header';
import type { DiagnosticContext, Warn } from '../../core/errors/diagnostics';
import type {
    AudioFileWriter,
    AudioFileConfig,
    AudioTrackDecoder,
    AudioFileFormat,
    AudioFileRequest,
    PcmCoding,
} from '../types';
import type { CodecPreference, MediaPlan } from '../api-types';
import { audioEncoderOrder, plannedAudioEncoder } from '../codecs/router';
import { copiedTrackPlan, coveredDuration } from '../plan/media-plan';
import type { PcmSampleFormat } from '../../codecs/pcm/encoder';
import { trackPcm } from './track-pcm';
import { ClipRead } from './shared-read';
import { pcmSampleFormat } from '../plan/sample-coding';

function nearestOf(values: readonly number[], target: number): number {
    return values.reduce((best, value) =>
        Math.abs(value - target) < Math.abs(best - target) ? value : best,
    );
}

/** The codec a report names for an audio file: the PCM coding chosen, else the format's codec. */
export function audioFileCodec(
    format: string,
    codec: PcmCoding | undefined,
    sampleFormat: PcmSampleFormat | undefined,
): string {
    if (codec === 'ulaw' || codec === 'alaw') return codec;
    const fixed = audioFormatCodec(format) ?? format;
    return sampleFormat && fixed.startsWith('pcm') ? `pcm-${sampleFormat}` : fixed;
}

/** What an audio file is asked for: its format and the settings the request gives. */
export interface AudioFileTarget {
    readonly format: AudioFileFormat;
    readonly codec?: PcmCoding;
    readonly sampleRate?: number;
    readonly channels?: number;
    /** Bits per second. */
    readonly bitrate?: number;
    readonly vbr?: boolean;
}

/**
 * The rate, channels, bitrate and VBR an audio file of `sound` is written with: the requested
 * values, else the sound's own. A layout the format cannot carry is folded down (AUDIO_DOWNMIXED);
 * with `lenient`, a value the format does not take is replaced by the nearest it does
 * (OPTION_NORMALIZED), otherwise the encoder check refuses it.
 */
export function audioFileSettings(
    request: AudioFileTarget,
    sound: {
        readonly sampleRate: number;
        readonly channels: number;
        readonly channelMask?: number;
    },
    lenient: boolean,
    warn: Warn,
): { sampleRate: number; channels: number; bitrateKbps?: number; vbr?: boolean } {
    const { format } = request;
    const repair = (option: string, message: string): void =>
        warn({ code: 'OPTION_NORMALIZED', message: `request: ${option} ${message}` });

    let sampleRate = request.sampleRate ?? sound.sampleRate;
    const limit = audioChannelLimit(format);
    let channels = request.channels ?? sound.channels;
    if (request.channels === undefined) {
        if (!carriesChannelLayout(format, request.codec, sound.channels, sound.channelMask)) {
            channels = Math.min(2, sound.channels);
            const layout = channels === 1 ? 'mono' : 'stereo';
            warn({
                code: 'AUDIO_DOWNMIXED',
                message:
                    `${format} output folds the ${sound.channels}-channel audio down to ` +
                    `${layout}`,
            });
        }
    } else if (lenient && channels > limit) {
        repair(
            'channels',
            `${channels} exceeds the ${limit} channels of ${format} output; using ${limit}`,
        );
        channels = limit;
    }

    const mpeg = format === 'mp2' || format === 'mp3';
    const legalRates = mpeg ? MPEG_SAMPLE_RATES : format === 'aac' ? AAC_SAMPLE_RATES : undefined;
    if (lenient && legalRates && !legalRates.includes(sampleRate)) {
        const nearest = nearestOf(legalRates, sampleRate);
        repair('sampleRate', `${sampleRate} is not a ${format} rate; encoding at ${nearest}`);
        sampleRate = nearest;
    }

    let bitrateKbps = optionalKbps(request.bitrate);
    if (lenient && bitrateKbps !== undefined) {
        if (LOSSLESS_AUDIO_FORMATS.has(format)) {
            repair('bitrateKbps', `does not apply to ${format} output and was ignored`);
            bitrateKbps = undefined;
        } else if (mpeg) {
            const legal = mpegBitrates(format, channels);
            if (!legal.includes(bitrateKbps)) {
                const nearest = nearestOf(legal, bitrateKbps);
                repair(
                    'bitrateKbps',
                    `${bitrateKbps} is not a legal ${format} rate; using ${nearest}`,
                );
                bitrateKbps = nearest;
            }
        }
    }

    let vbr = request.vbr;
    if (lenient && vbr !== undefined && format !== 'mp3') {
        repair('vbr', `applies to mp3 output only and was ignored`);
        vbr = undefined;
    }
    return { sampleRate, channels, bitrateKbps, vbr };
}

/** The `start`–`end` range of `input` at its own rate. */
function keptRange(input: ReplayablePcmSource, request: AudioFileRequest): ReplayablePcmSource {
    const head = Math.round((request.start ?? 0) * input.sampleRate);
    const total = input.estimatedFrames;
    const end =
        request.end === undefined
            ? total
            : Math.min(total, Math.round(request.end * input.sampleRate));
    if (end <= head)
        throw new MediaForgeError('Audio trim selects no presentation samples', 'FORMAT');
    if (head === 0 && end === total) return input;
    return normalizePcmSource(input, input.sampleRate, input.channels, { head, valid: end - head });
}

export function audioPlan(
    file: MediaFile,
    request: AudioFileRequest,
    diagnostics: DiagnosticContext,
    audio?: AudioFileWriter,
    decoder?: AudioTrackDecoder,
    codecPreference?: CodecPreference,
    onWarning: Warn = warning => diagnostics.warn(warning),
) {
    const state = mediaFileState(file);
    if (!audio?.formats.includes(request.format))
        throw state.missing.audioEncoder(
            request.format,
            `No audio encoder for '${request.format}' is installed`,
        );
    let tracks = state.tracks.filter(
        track =>
            track.type === 'audio' &&
            (request.trackId === undefined || track.description.id === request.trackId),
    );
    if (tracks.length > 1 && request.trackId === undefined) {
        const defaults = tracks.filter(track => track.description.default === true);
        if (defaults.length === 1) tracks = defaults;
    }
    if (tracks.length !== 1)
        throw new MediaForgeError('An audio file holds one audio track', 'FORMAT');
    const track = tracks[0]!;
    const input = trackPcm(
        file,
        track,
        {
            decoder,
            codecPreference: request.codecPreference ?? codecPreference,
            validation: state.diagnostics.validation,
            onWarning: warning => onWarning(warning),
        },
        new ClipRead(file).reader(track),
    );
    const sampleFormat = pcmSampleFormat(track.info, request, warning =>
        diagnostics.warn({ ...warning, trackId: track.description.id }),
    );

    // Stages process the kept range at the source rate; the output settings then apply to what they
    // emit.
    const staged = request.stages !== undefined;
    const sound = staged
        ? stagedPcmSource(keptRange(input, request), request.stages!, (code, message) =>
              diagnostics.warn({ code, message, trackId: track.description.id }),
          )
        : input;
    const { sampleRate, channels, bitrateKbps, vbr } = audioFileSettings(
        request,
        sound,
        state.diagnostics.validation !== 'strict',
        warning =>
            diagnostics.warn(
                warning.code === 'AUDIO_DOWNMIXED'
                    ? { ...warning, trackId: track.description.id }
                    : warning,
            ),
    );
    const head = staged ? 0 : Math.round((request.start ?? 0) * sampleRate);
    const total = Math.ceil((sound.estimatedFrames * sampleRate) / sound.sampleRate);
    const end =
        request.end === undefined || staged
            ? total
            : Math.min(total, Math.round(request.end * sampleRate));
    if (end <= head)
        throw new MediaForgeError('Audio trim selects no presentation samples', 'FORMAT');
    const source =
        sampleRate === sound.sampleRate &&
        channels === sound.channels &&
        head === 0 &&
        end === total
            ? sound
            : normalizePcmSource(sound, sampleRate, channels, { head, valid: end - head });
    const config: AudioFileConfig = {
        format: request.format,
        sampleRate,
        channels,
        estimatedFrames: source.estimatedFrames,
        bitrateKbps,
        vbr,
        codec: request.codec,
        sampleFormat,
        codecPreference: request.codecPreference ?? codecPreference,
        signal: request.signal,
        onProgress: undefined,
        onWarning,
        tags: state.tags,
    };
    audio.check(config);
    state.planner().checkTrackMetadata([track], request.format, diagnostics);
    if (track.info.language)
        diagnostics.metadata({
            code: 'AUDIO_LANGUAGE_LOSS',
            message: `${request.format} encoding cannot keep the track language`,
            trackId: track.description.id,
            format: request.format,
        });
    const preference = request.codecPreference ?? codecPreference;
    const plan: MediaPlan = {
        format: request.format,
        action: 'reencode',
        tracks: [
            {
                ...copiedTrackPlan(track.description),
                action: 'encode',
                codec: audioFileCodec(request.format, request.codec, sampleFormat),
                encoder: plannedAudioEncoder(
                    audioEncoderOrder(
                        audioFormatCodec(request.format) ?? request.format,
                        true,
                        preference,
                        sampleFormat,
                    ),
                ),
                sampleRate,
                channels,
                ...(request.stages ? { stages: request.stages.map(stage => stage.name) } : {}),
            },
        ],
        duration: coveredDuration([track.description], request.start, request.end),
    };
    return { source, config, plan };
}
