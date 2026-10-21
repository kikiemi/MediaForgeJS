import { AAC_SAMPLE_RATES } from '../../core/codec-config/audio/aac-sample-rates';
import { isPcmCodec, mp4aAudioObjectType } from '../../core/model/codec-strings';
import { hostCodecAvailable, type HostCodecKind } from '../../codecs/webcodecs/support';
import type { CodecPreference } from '../api-types';
import type { PcmSampleFormat } from '../../codecs/pcm/encoder';

/**
 * Who decodes and encodes: the one place that decides between the host WebCodecs and the library's
 * codecs (its own and its plugins'), for the work itself, for the plan that predicts it and for the
 * report that announces it.
 */

/** Who runs a codec: the host WebCodecs, or the library. */
export type CodecRoute = 'host' | 'builtin';

/** Whether the library's decoder goes before the host's: there is one and it is preferred. */
export function builtinFirst(preference: CodecPreference | undefined, builtin: boolean): boolean {
    return builtin && preference === 'builtin';
}

/**
 * The decoders tried for a track, in order, among those that can decode it (`host`: the host
 * supports its configuration; `builtin`: the library has a decoder for its codec). The host goes
 * first unless the library's decoder is preferred; the second takes over where the first fails.
 */
export function decoderOrder(
    preference: CodecPreference | undefined,
    host: boolean,
    builtin: boolean,
): readonly CodecRoute[] {
    const order: readonly CodecRoute[] = builtinFirst(preference, builtin)
        ? ['builtin', 'host']
        : ['host', 'builtin'];
    return order.filter(route => (route === 'host' ? host : builtin));
}

/**
 * Whether a codec can run at all, before any configuration is asked: the library has one for it
 * (`builtin`), or the host has the WebCodecs interface. Plans fail early on false, naming the part
 * that is missing.
 */
export function routeAvailable(kind: HostCodecKind, builtin: boolean): boolean {
    return builtin || hostCodecAvailable(kind);
}

/** Codecs the library writes without asking the host: linear PCM, G.711 and MPEG audio. */
const LIBRARY_ONLY: ReadonlySet<string> = new Set(['pcm', 'pcm-s16', 'ulaw', 'alaw', 'mp3', 'mp2']);

/**
 * Whether the library reads a track's samples instead of decoding them: linear PCM, whose packets
 * are its samples, read exactly at every depth. No decoder is asked, the host's or a plugin's,
 * whatever the preference: a host decoder would only convert the sample format, at an AudioData
 * and a copy per packet (and Chromium's 24- and 32-bit AudioData crash in copyTo()). Every other
 * codec is decoded, on the routes of decoderOrder.
 */
export function readsLinearPcm(codec: string): boolean {
    return isPcmCodec(codec);
}

/** The codecs of the library's own encoders, which the aac, mpegAudio and flac plugins add. */
const LIBRARY_ENCODED = ['aac', 'flac', 'mp2', 'mp3'] as const;

/** A codec the library's own encoders write. */
export type LibraryAudioCodec = (typeof LIBRARY_ENCODED)[number];

/** The codecs the file encoders also write into container tracks: the stream is read back. */
const CONTAINER_ENCODED: readonly string[] = ['flac', 'mp2', 'mp3'];

/** The codecs of the installed library encoders (`encoders` keyed by codec). */
export function libraryAudioCodecs(encoders: {
    readonly [K in LibraryAudioCodec]?: unknown;
}): readonly LibraryAudioCodec[] {
    return LIBRARY_ENCODED.filter(codec => encoders[codec] !== undefined);
}

/** How the library encodes a container audio track itself. */
export type BuiltinAudioEncoding = 'pcm' | 'g711' | 'aac' | 'container';

/**
 * The library's encoding of `codec` at `rate` and `channels`: PCM and G.711 always, then the
 * installed library encoders (`installed`, see libraryAudioCodecs): AAC-LC up to two channels at an
 * AAC rate, FLAC, MP2 and MP3. Undefined when it has none.
 */
export function builtinAudioEncoding(
    codec: string,
    rate: number,
    channels: number,
    installed: readonly string[],
): BuiltinAudioEncoding | undefined {
    if (codec === 'pcm') return 'pcm';
    if (codec === 'ulaw' || codec === 'alaw') return 'g711';
    const aacLc = mp4aAudioObjectType(codec) === 2;
    if (aacLc && installed.includes('aac') && channels <= 2 && AAC_SAMPLE_RATES.includes(rate))
        return 'aac';
    if (CONTAINER_ENCODED.includes(codec) && installed.includes(codec)) return 'container';
    return undefined;
}

/** An encoder of an audio track or file. */
export type AudioEncoderKind = 'webcodecs' | 'builtin';

/**
 * The encoders tried for `codec`, in order: the library alone for the codecs it writes without the
 * host, when it is preferred, and for FLAC of 24-bit samples (`sampleFormat` 's24'), which the
 * library keeps while the host's encoder chooses its own depth; the host alone without a built-in
 * encoder; else the host with the library taking over when the host fails before any output. The
 * runs and the plans that report them all take their order here.
 */
export function audioEncoderOrder(
    codec: string,
    builtin: boolean,
    preference: CodecPreference | undefined,
    sampleFormat?: PcmSampleFormat,
): readonly AudioEncoderKind[] {
    if (!builtin) return ['webcodecs'];
    if (
        LIBRARY_ONLY.has(codec) ||
        preference === 'builtin' ||
        (codec === 'flac' && sampleFormat === 's24')
    )
        return ['builtin'];
    return ['webcodecs', 'builtin'];
}

/** The encoder a report names before the work: the first of `order` this host can run. */
export function plannedAudioEncoder(order: readonly AudioEncoderKind[]): AudioEncoderKind {
    return order[0] === 'webcodecs' && (order.length === 1 || hostCodecAvailable('AudioEncoder'))
        ? 'webcodecs'
        : 'builtin';
}
