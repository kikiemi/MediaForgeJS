import { LOSSLESS_AUDIO_FORMATS } from './format-policy';
import { codecFamily } from '../../core/model/codec-strings';
import { MediaForgeError } from '../../core/errors/errors';
import type { MediaDiagnostic, Warn } from '../../core/errors/diagnostics';
import type { PcmSampleFormat } from '../../codecs/pcm/encoder';
import { describePcmTrack } from '../../core/codec-config/audio/pcm-format';
import { flacStreamInfoRecord } from '../../core/codec-config/audio/flac-frame';
import { alacCookie } from '../../core/codec-config/audio/alac-packet';
import type { TrackInfo } from '../../core/model/track';
import type { PcmCoding } from '../types';

/**
 * Sample depth a lossless FLAC or ALAC track declares in its configuration; undefined for other
 * codecs.
 */
function losslessBitDepth(track: TrackInfo): number | undefined {
    const config = track.codecConfig;
    if (!config) return undefined;
    if (codecFamily(track.codec) === 'flac') {
        const record = flacStreamInfoRecord(config);
        return record ? (((record[12]! & 1) << 4) | (record[13]! >> 4)) + 1 : undefined;
    }
    if (codecFamily(track.codec) === 'alac') return alacCookie(config)?.[5];
    return undefined;
}

/** Bits per sample of a track's lossless samples: PCM, FLAC or ALAC; undefined for lossy codecs. */
function sourceBitDepth(
    track: TrackInfo,
): { readonly bits: number; readonly float: boolean } | undefined {
    if (track.codec.startsWith('pcm')) {
        const format = describePcmTrack(track);
        return { bits: format.validBitsPerSample, float: format.float };
    }
    const bits = losslessBitDepth(track);
    return bits === undefined ? undefined : { bits, float: false };
}

/**
 * The sample coding of a lossless audio file from `track`: the source's precision where the format
 * keeps it (24-bit integers, 32-bit floats), 16 bits from lossy and 16-bit sources. FLAC holds
 * integers up to 24 bits; a deeper or float source is reduced with AUDIO_PRECISION_REDUCED, or
 * refused when `allowPrecisionLoss` is false. Undefined for other outputs.
 */
export function pcmSampleFormat(
    track: TrackInfo,
    output: {
        readonly format: string;
        readonly codec?: PcmCoding;
        readonly allowPrecisionLoss?: boolean;
    },
    warn: Warn,
): PcmSampleFormat | undefined {
    if (
        !LOSSLESS_AUDIO_FORMATS.has(output.format) ||
        (output.codec !== undefined && output.codec !== 'pcm')
    )
        return undefined;
    const depth = sourceBitDepth(track);
    if (!depth || (!depth.float && depth.bits <= 16)) return 's16';
    const kept: PcmSampleFormat = depth.float && output.format !== 'flac' ? 'f32' : 's24';
    const keptBits = kept === 's24' ? 24 : 32;
    if (depth.bits <= keptBits && depth.float === (kept === 'f32')) return kept;

    const source = `${depth.bits}-bit${depth.float ? ' float' : ''} ${track.codec}`;
    if (output.allowPrecisionLoss === false)
        throw new MediaForgeError(
            `${output.format} output keeps ${keptBits}-bit samples, and allowPrecisionLoss is ` +
                `false`,
            'FORMAT',
            {
                hint: "Choose 'wav' or 'caf', or copy the track into 'mkv'.",
            },
        );
    warn({
        code: 'AUDIO_PRECISION_REDUCED',
        message: `${source} samples are rounded to ${keptBits} bits for ${output.format}`,
    });
    return kept;
}

/**
 * Runtime decode and encode warnings go to `onWarning`, which defaults to the plan's diagnostics.
 */
/**
 * The coding that keeps every one of `tracks`: the widest they need; one precision warning stands
 * for all.
 */
export function widestSampleFormat(
    tracks: readonly TrackInfo[],
    output: Parameters<typeof pcmSampleFormat>[1],
    warn: Warn,
): PcmSampleFormat | undefined {
    let reduced: Omit<MediaDiagnostic, 'severity'> | undefined;
    const codings = tracks.map(track =>
        pcmSampleFormat(track, output, warning => (reduced ??= warning)),
    );
    if (reduced) warn(reduced);
    return codings.includes('f32') ? 'f32' : codings.includes('s24') ? 's24' : codings[0];
}
