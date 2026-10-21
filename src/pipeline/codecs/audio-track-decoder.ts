import type { TrackInfo } from '../../core/model/track';
import { NO_PLUGINS, type MissingParts } from '../plugins/missing-parts';
import type { AudioTrackDecoder } from '../types';
import type { AudioTrackDecodeOptions } from '../api-types';
import { codecFamily } from '../../core/model/codec-strings';
import { aacTrackSource, hasBuiltinAacDecoder } from './aac-track-decoder';
import { decodeAudioTrack, type TrackDecodeSettings } from './audio-track-source';
import type {
    BuiltinAudioCodec,
    BuiltinAudioDecoder,
    EncodedAudioSampleReader,
} from '../../core/contracts/decoder';
export type { EncodedAudioSampleReader } from '../../core/contracts/decoder';
import { trackCodecLayout } from './codec-layout';
import { g711AudioCodec, isG711Codec } from '../../codecs/pcm/g711';
import { ima4AudioCodec } from '../../codecs/pcm/ima-adpcm';
import type { ReplayablePcmSource } from '../../codecs/pcm/pcm-source';
import { pcmAudioCodec } from '../../codecs/pcm/pcm-track-source';

export type { AudioTrackDecodeOptions } from '../api-types';

/**
 * Codec families the core decodes itself: every linear PCM layout, G.711 and Apple IMA4. The aac,
 * mpegAudio, flac, alac, opus and vorbis plugins add their decoders; the host AudioDecoder decodes
 * the rest.
 */
export const BUILTIN_AUDIO_DECODER_FAMILIES: readonly string[] = Object.freeze([
    'pcm',
    'ulaw',
    'alaw',
    'ima4',
]);

/**
 * Families of the plugin decoders, so hosts decoding them are asked even when no plugin is
 * installed.
 */
const PLUGIN_FAMILIES: readonly string[] = Object.freeze([
    'mp4a',
    'alac',
    'flac',
    'mp1',
    'mp2',
    'mp3',
    'opus',
    'vorbis',
]);

/**
 * Every family a track decoder takes: the core's, the plugins', and those only the host decodes.
 */
function audioDecoderFamilies(decoders: readonly BuiltinAudioDecoder[] = []): readonly string[] {
    return Object.freeze([
        ...new Set([
            ...BUILTIN_AUDIO_DECODER_FAMILIES.filter(family => family !== 'pcm'),
            ...PLUGIN_FAMILIES,
            ...decoders.flatMap(decoder => decoder.codecs),
            'ac-3',
            'ec-3',
            'dtsc',
            'dtsh',
            'dtsl',
            'dtse',
            'mlpa',
        ]),
    ]);
}

/**
 * Loads a plugin decoder on the first decoding pass; the layout comes from the track, so the host
 * shares it.
 */
function pluginAudioCodec(track: TrackInfo, decoder: BuiltinAudioDecoder): BuiltinAudioCodec {
    let loading: Promise<BuiltinAudioCodec> | undefined;
    return {
        ...trackCodecLayout(track),
        async create(warn) {
            loading ??= Promise.resolve()
                .then(() => decoder.create(track))
                .catch(error => {
                    loading = undefined;
                    throw error;
                });
            return (await loading).create(warn);
        },
    };
}

/** The library decoder of a non-AAC track (core or plugin), or null when none is installed. */
function builtinAudioCodec(
    track: TrackInfo,
    decoders: readonly BuiltinAudioDecoder[],
): BuiltinAudioCodec | null {
    if (isG711Codec(track.codec)) return g711AudioCodec(track, track.codec);
    if (track.codec === 'ima4') return ima4AudioCodec(track);
    if (track.codec === 'pcm' || track.codec.startsWith('pcm-')) return pcmAudioCodec(track);
    const family = codecFamily(track.codec);
    const decoder = decoders.find(candidate => candidate.codecs.includes(family));
    return decoder ? pluginAudioCodec(track, decoder) : null;
}

/**
 * True when the library decodes this track itself with the core or `decoders` (the host is still
 * preferred).
 */
export function hasBuiltinAudioDecoder(
    track: TrackInfo,
    decoders: readonly BuiltinAudioDecoder[] = [],
): boolean {
    try {
        if (codecFamily(track.codec) === 'mp4a') return hasBuiltinAacDecoder(track, decoders);
        return (
            (track.codecConfigurations?.length ?? 0) <= 1 &&
            builtinAudioCodec(track, decoders) !== null
        );
    } catch {
        return false;
    }
}

/**
 * Presentation PCM of any audio track the host or the library decodes, see decodeAudioTrack: host
 * AudioDecoder first unless codecPreference is 'builtin', then the core's linear PCM and G.711
 * decoders and the plugin decoders in `options.decoders`. The layout of a track with an Opus
 * or Vorbis configuration is read without decoder code, so a plugin decoder is loaded only when a
 * decoding pass runs on it.
 */
export function createAudioTrackSource(
    track: TrackInfo,
    read: EncodedAudioSampleReader,
    options: TrackDecodeSettings = {},
): ReplayablePcmSource {
    if (codecFamily(track.codec) === 'mp4a') return aacTrackSource(track, read, options);
    const codec = builtinAudioCodec(track, options.decoders ?? []);
    return decodeAudioTrack(
        track,
        read,
        options,
        codec,
        codec ? undefined : trackCodecLayout(track),
    );
}

/**
 * Host AudioDecoder first when it supports the track (unless codecPreference is 'builtin'), then
 * the library decoders: the core's linear PCM and G.711, and the plugin decoders in `decoders`
 * (AAC, MPEG audio, FLAC, ALAC, Opus, Vorbis, AC-3, E-AC-3). DTS and TrueHD need the host
 * decoder.
 */
export function createAudioTrackDecoder(
    decoders: readonly BuiltinAudioDecoder[] = [],
    missing: MissingParts = NO_PLUGINS,
): AudioTrackDecoder {
    const installed = Object.freeze([...decoders]);
    return Object.freeze({
        codecs: audioDecoderFamilies(installed),
        createSource(
            track: TrackInfo,
            readPacket: (index: number, signal?: AbortSignal) => Promise<Uint8Array>,
            options: AudioTrackDecodeOptions = {},
        ): ReplayablePcmSource {
            return createAudioTrackSource(
                track,
                (_sample, index, signal) => readPacket(index, signal),
                {
                    ...options,
                    decoders: installed,
                    missing,
                },
            );
        },
    });
}
