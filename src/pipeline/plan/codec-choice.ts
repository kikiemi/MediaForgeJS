import { builtinAudioEncoding } from '../codecs/router';
import { MediaForgeError } from '../../core/errors/errors';
import { awaitWithAbort } from '../../core/io/abort';
import { codecFamily } from '../../core/model/codec-strings';
import { CONTAINER_CODEC_PLANS } from './format-policy';
import { videoEncoderCodecs } from '../../core/model/codec-level';
import { DEFAULT_AUDIO_BITRATE, defaultVideoBitrate } from './encode-settings';
import type { ContainerFormat } from '../../core/model/media';
import { queryHostCodec, hostCodecAvailable } from '../../codecs/webcodecs/support';
import { hostVideoEncoderConfig } from '../../codecs/webcodecs/video';
import type { HostVideoEncoderOptions } from '../../codecs/webcodecs/video-options';

/**
 * Picture size and rate a video encoder is asked about; bitrate defaults to the size's usual rate.
 */
interface VideoEncodeQuery extends HostVideoEncoderOptions {
    readonly width: number;
    readonly height: number;
    /** Frames per second; default 30. */
    readonly framerate?: number;
    /** Bits per second. */
    readonly bitrate?: number;
    /** Output container, which decides AVC/HEVC framing; default mp4. */
    readonly container?: string;
    /** True when the caller named a codec string with a profile, which is kept. */
    readonly explicit?: boolean;
}

/** Channel layout and rate an audio encoder is asked about. */
export interface AudioEncodeQuery {
    /** Hz; default 48000. */
    readonly sampleRate?: number;
    /** Default 2. */
    readonly channels?: number;
    /** Bits per second; default 128000 for lossy codecs. */
    readonly bitrate?: number;
}

/** Video codec families in the order `codec: 'auto'` tries them, per output container. */
const AUTO_VIDEO_ORDER: readonly string[] = ['avc', 'vp09', 'hvc1', 'vp8', 'av01'];
const AUTO_VIDEO_WEBM: readonly string[] = ['vp09', 'vp8', 'av01'];

/** Audio codecs in the order `codec: 'auto'` tries them; the built-in ones need no host encoder. */
const AUTO_AUDIO_ORDER: readonly string[] = ['opus', 'mp4a.40.2', 'vorbis', 'flac', 'pcm'];

/**
 * Video codec families `container` carries that re-encoding can write, in `codec: 'auto'` order.
 */
export function autoVideoFamilies(container: string): string[] {
    const carried = (CONTAINER_CODEC_PLANS[container as ContainerFormat]?.video ?? []).map(
        codecFamily,
    );
    const order = container === 'webm' ? AUTO_VIDEO_WEBM : AUTO_VIDEO_ORDER;
    return order.filter(family => carried.includes(family));
}

/** Audio codecs `container` carries that re-encoding can write, in `codec: 'auto'` order. */
export function autoAudioCodecs(container: string): string[] {
    const carried = CONTAINER_CODEC_PLANS[container as ContainerFormat]?.audio ?? [];
    return AUTO_AUDIO_ORDER.filter(codec => carried.includes(codec));
}

/** The video codec families `container` tries in place of `codec`: its `'auto'` order, less it. */
export function otherVideoFamilies(container: string, codec: string): string[] {
    return autoVideoFamilies(container).filter(family => family !== codecFamily(codec));
}

/** The audio codecs `container` tries in place of `codec`: its `'auto'` order without it. */
export function otherAudioCodecs(container: string, codec: string): string[] {
    return autoAudioCodecs(container).filter(candidate => candidate !== codec);
}

/** The message of CODEC_SUBSTITUTED: `chosen` is encoded as this host cannot encode `codec`. */
export function substitutedMessage(kind: 'video' | 'audio', chosen: string, codec: string) {
    const media = kind === 'video' ? 'Video' : 'Audio';
    return `${media} is encoded as ${chosen}: this host cannot encode ${codec}`;
}

/** The query of an audio encoder for a track: its rate, at most two of its channels, a bitrate. */
export function audioEncodeQuery(
    sampleRate: number | undefined,
    channels: number | undefined,
    bitrate: number | undefined,
): AudioEncodeQuery {
    return { sampleRate, channels: Math.min(2, channels ?? 2), bitrate };
}

/** A codec an encoder writes for a track, and whether it stands in for the one asked. */
export interface EncodableCodec {
    readonly codec: string;
    readonly substituted: boolean;
}

/**
 * The video codec the host VideoEncoder writes for `codec` into `container` at `query`: the codec
 * string it accepts for `codec`, else, for a profile the caller did not name (a source's), another
 * profile of its family (4:4:4 H.264 as H.264 High), else the first other family of the
 * container's `'auto'` order it accepts (substituted); undefined when it accepts none. Conversions
 * and edits replace a codec by this rule, and recordings by its parts.
 */
export async function encodableVideoCodec(
    codec: string,
    container: string,
    query: VideoEncodeQuery,
    signal?: AbortSignal,
): Promise<EncodableCodec | undefined> {
    const accepted = await hostVideoEncoderCodec(codec, query, signal);
    if (accepted) return { codec: accepted, substituted: false };
    const families = otherVideoFamilies(container, codec);
    if (codec.includes('.') && !query.explicit) families.unshift(codecFamily(codec));
    const chosen = await chooseVideoEncoderCodec(families, query, signal);
    return chosen === undefined ? undefined : { codec: chosen, substituted: true };
}

/**
 * The audio codec encoded for `codec` into `container` at `query`: `codec` itself where the host or
 * the `installed` library encoders encode it, else the first other codec of the container's
 * `'auto'` order they do (substituted); undefined when they encode none.
 */
export async function encodableAudioCodec(
    codec: string,
    container: string,
    installed: readonly string[],
    query: AudioEncodeQuery,
    signal?: AbortSignal,
): Promise<EncodableCodec | undefined> {
    if (await canEncodeAudioCodec(codec, installed, query, signal))
        return { codec, substituted: false };
    const chosen = await chooseAudioEncoderCodec(
        otherAudioCodecs(container, codec),
        installed,
        query,
        signal,
    );
    return chosen === undefined ? undefined : { codec: chosen, substituted: true };
}

/** A codec string for one family, as the encoder is asked for it. */
function familyCodec(family: string): string {
    return family === 'avc' ? 'avc1' : family;
}

/**
 * The first codec string of `codec` (a family such as 'avc1' or a full string) the host
 * VideoEncoder accepts for `query`, with the level the size needs; undefined when the host has no
 * VideoEncoder or accepts none.
 */
export async function hostVideoEncoderCodec(
    codec: string,
    query: VideoEncodeQuery,
    signal?: AbortSignal,
): Promise<string | undefined> {
    if (!hostCodecAvailable('VideoEncoder')) return undefined;
    const framerate = query.framerate || 30;
    const width = Math.max(2, Math.round(query.width / 2) * 2);
    const height = Math.max(2, Math.round(query.height / 2) * 2);
    const bitrate = query.bitrate ?? defaultVideoBitrate(codec, width, height, framerate);
    const shape = { width, height, framerate, bitrate };
    for (const candidate of videoEncoderCodecs(codec, shape, codec.includes('.'))) {
        const config = hostVideoEncoderConfig(candidate, {
            ...shape,
            container: query.container ?? 'mp4',
            hardwareAcceleration: query.hardwareAcceleration,
            latencyMode: query.latencyMode,
            bitrateMode: query.bitrateMode,
        });
        if ((await awaitWithAbort(queryHostCodec('VideoEncoder', config), signal)).supported)
            return candidate;
    }
    return undefined;
}

/**
 * The first family of `families` the host VideoEncoder accepts for `query`, as its codec string;
 * undefined for none.
 */
export async function chooseVideoEncoderCodec(
    families: readonly string[],
    query: VideoEncodeQuery,
    signal?: AbortSignal,
): Promise<string | undefined> {
    for (const family of families) {
        const codec = await hostVideoEncoderCodec(familyCodec(family), query, signal);
        if (codec) return codec;
    }
    return undefined;
}

/**
 * True when the library encodes `codec` itself for `query` (with the installed library encoders of
 * `installed`, see libraryAudioCodecs), or the host AudioEncoder accepts it. The library resamples
 * AAC to an AAC rate.
 */
export async function canEncodeAudioCodec(
    codec: string,
    installed: readonly string[],
    query: AudioEncodeQuery = {},
    signal?: AbortSignal,
): Promise<boolean> {
    const channels = query.channels ?? 2;
    if (builtinAudioEncoding(codec, 48000, channels, installed) !== undefined) return true;
    if (!hostCodecAvailable('AudioEncoder')) return false;
    const answer = await awaitWithAbort(
        queryHostCodec('AudioEncoder', {
            codec,
            sampleRate: query.sampleRate ?? 48000,
            numberOfChannels: channels,
            ...(codec === 'flac' || codec.startsWith('pcm')
                ? {}
                : { bitrate: query.bitrate ?? DEFAULT_AUDIO_BITRATE }),
        }),
        signal,
    );
    return answer.supported;
}

/** The everyday name of an audio codec a target can require: Opus. */
const REQUIRED_CODEC_NAMES: Readonly<Record<string, string>> = { opus: 'Opus' };

/**
 * The ENCODE error of a target that holds one audio codec (an 'opus' target) on a host that cannot
 * encode it.
 */
export function requiredEncoderError(codec: string): MediaForgeError {
    const name = REQUIRED_CODEC_NAMES[codec] ?? codec;
    return new MediaForgeError(
        `${codec} output holds ${name} audio only, which this host cannot encode`,
        'ENCODE',
        { hint: `Convert to 'ogg', or run in a browser that encodes ${name}.` },
    );
}

/**
 * The first of `codecs` that can be encoded for `query` with the host or the `installed` library
 * encoders; undefined for none.
 */
export async function chooseAudioEncoderCodec(
    codecs: readonly string[],
    installed: readonly string[],
    query: AudioEncodeQuery = {},
    signal?: AbortSignal,
): Promise<string | undefined> {
    for (const codec of codecs)
        if (await canEncodeAudioCodec(codec, installed, query, signal)) return codec;
    return undefined;
}

/** Video codecs asked about by name: a codec string for a small 30 fps picture. */
const VIDEO_PROBES: readonly (readonly [string, string])[] = [
    ['h264', 'avc1.42e01e'],
    ['hevc', 'hvc1.1.6.L93.B0'],
    ['vp8', 'vp8'],
    ['vp9', 'vp09.00.10.08'],
    ['av1', 'av01.0.04M.08'],
];

/**
 * Video codec names the host VideoDecoder and VideoEncoder accept at 640×480, asked once per host.
 */
export async function hostVideoCodecs(
    signal?: AbortSignal,
): Promise<{ decode: string[]; encode: string[] }> {
    const decode = hostCodecAvailable('VideoDecoder')
        ? await Promise.all(
              VIDEO_PROBES.map(([, codec]) =>
                  awaitWithAbort(
                      queryHostCodec('VideoDecoder', { codec, codedWidth: 640, codedHeight: 480 }),
                      signal,
                  ).then(answer => answer.supported),
              ),
          )
        : VIDEO_PROBES.map(() => false);

    const encode = await Promise.all(
        VIDEO_PROBES.map(([, codec]) =>
            hostVideoEncoderCodec(codec, { width: 640, height: 480, framerate: 30 }, signal).then(
                accepted => accepted !== undefined,
            ),
        ),
    );
    return {
        decode: VIDEO_PROBES.filter((_, index) => decode[index]).map(([name]) => name),
        encode: VIDEO_PROBES.filter((_, index) => encode[index]).map(([name]) => name),
    };
}
