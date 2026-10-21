import { carriesTrackMetadata, isIsoOutput } from '../../formats/shared/capabilities';
import type { MediaDiagnostic } from '../../core/errors/diagnostics';
import type {
    MatroskaPassThrough,
    MediaTags,
    SpatialVideo,
    TrackDispositions,
} from '../../core/model/media';
import { lostTagParts } from '../../core/model/media-tags';
import { keptTags } from '../../formats/kept-tags';
import { matroskaExtras } from '../../formats/matroska/media-tags';
import { filterMatroskaTags } from '../../formats/matroska/tags';
import type { MatroskaTrackIdentity } from '../../formats/matroska/tags';
import { isDefaultHandlerName } from '../../formats/mp4/metadata';
import { uncarriedVideoDescription } from '../../formats/shared/video-description';
import { isPcmCodec } from '../../core/model/codec-strings';
import { defaultChannelMask } from '../../core/model/channel-layout';

interface TrackMetadata {
    readonly id?: number;
    readonly default?: boolean;
    readonly forced?: boolean;
    readonly name?: string;
    readonly title?: string;
    readonly commentary?: boolean;
    readonly dispositions?: TrackDispositions;
    readonly alphaMode?: boolean;
}

export function trackDispositionLoss(
    track: TrackMetadata,
    format: string,
    type?: string,
): Omit<MediaDiagnostic, 'severity'> | undefined {
    // Only Matroska stores the accessibility and origin flags.
    const flags = Object.entries(track.dispositions ?? {})
        .filter(([, value]) => value)
        .map(([key]) => key);
    // MP4 states forced only for subtitle tracks.
    if (track.forced && type !== undefined && type !== 'subtitle' && isIsoOutput(format))
        flags.unshift('forced');
    if (carriesTrackMetadata(format)) {
        if (format === 'mkv' || !flags.length) return undefined;
        return {
            code: 'TRACK_DISPOSITION_LOSS',
            message: `${format} cannot keep the track's ${flags.join(', ')} disposition`,
            trackId: track.id,
            format,
        };
    }

    const dispositions =
        track.default === false ||
        track.forced === true ||
        track.commentary === true ||
        flags.length > 0;
    const named =
        track.name !== undefined && track.name !== '' && !isDefaultHandlerName(track.name);
    if (!dispositions && !named && track.title === undefined) return undefined;
    return {
        code: dispositions ? 'TRACK_DISPOSITION_LOSS' : 'TRACK_METADATA_LOSS',
        message: `${format} cannot keep the track's name or dispositions`,
        trackId: track.id,
        format,
    };
}

/**
 * The TRACK_METADATA_LOSS of copying a video track into `format`, which has no field for what its
 * input stated.
 */
export function videoDescriptionLoss(
    track: Parameters<typeof uncarriedVideoDescription>[1] & { readonly id?: number },
    format: string,
): Omit<MediaDiagnostic, 'severity'> | undefined {
    const lost = uncarriedVideoDescription(format, track);
    if (!lost.length) return undefined;
    return {
        code: 'TRACK_METADATA_LOSS',
        message: `${format} cannot store the video track's ${lost.join(', ')}`,
        trackId: track.id,
        format,
    };
}

/**
 * The CONTAINER_METADATA_LOSS of copying a file's tags, chapters and pictures into `format`: what
 * its writer has no field for. What only a Matroska input states is reported by
 * matroskaMetadataLoss.
 */
export function containerTagLoss(
    tags: MediaTags | undefined,
    format: string,
    pass?: MatroskaPassThrough,
): Omit<MediaDiagnostic, 'severity'> | undefined {
    // A Matroska input's own elements go into Matroska output as they are.
    if (pass && (format === 'mkv' || format === 'webm')) return undefined;
    const lost = lostTagParts(tags, keptTags(format));
    if (!lost.length) return undefined;
    return {
        code: 'CONTAINER_METADATA_LOSS',
        message: `${format} cannot keep the container's ${lost.join(', ')}`,
        format,
    };
}

export function matroskaMetadataLoss(
    pass: MatroskaPassThrough | undefined,
    unsupportedTags: boolean | undefined,
    format: string,
    tracks?: readonly MatroskaTrackIdentity[],
): Omit<MediaDiagnostic, 'severity'> | undefined {
    const lost: string[] = [];
    if (unsupportedTags) lost.push('malformed or unsupported metadata');
    if (
        pass &&
        (format === 'mkv' || format === 'webm') &&
        filterMatroskaTags(pass, format, tracks).unsupported
    ) {
        lost.push('tags with missing, ambiguous or unsupported targets');
    }

    // Other containers take the common tags, chapters and pictures (containerTagLoss reports their
    // limits); what only Matroska states is lost: other tags and targets, and attachments that are
    // not pictures.
    const extras = pass && format !== 'mkv' ? matroskaExtras(pass) : undefined;
    if (format !== 'mkv' && format !== 'webm' && extras?.tags) lost.push('tags');
    if (format === 'webm') {
        if (pass?.chapters !== undefined) lost.push('chapters');
        if (pass?.attachments !== undefined) lost.push('attachments');
    } else if (extras?.attachments) lost.push('attachments');
    if (lost.length === 0) return undefined;
    return {
        code: 'MATROSKA_METADATA_LOSS',
        message: `${format} cannot keep the Matroska ${lost.join(', ')}`,
        format,
    };
}

export function matroskaOutputMetadata(
    pass: MatroskaPassThrough,
    format: 'mkv' | 'webm',
    tracks?: readonly MatroskaTrackIdentity[],
): MatroskaPassThrough {
    const tags = filterMatroskaTags(pass, format, tracks).tags;
    return format === 'mkv' ? { ...pass, tags } : { title: pass.title, tags };
}

/**
 * The loss of VP8/VP9 alpha, which only a copy into MKV or WebM keeps: elsewhere, and when the
 * video is re-encoded, the colour pictures are written without it.
 */
export function alphaLoss(
    track: TrackMetadata,
    format: string,
    copied = true,
): Omit<MediaDiagnostic, 'severity'> | undefined {
    if (!track.alphaMode || (copied && (format === 'mkv' || format === 'webm'))) return undefined;
    return { code: 'ALPHA_DROPPED', message: `${format} cannot keep the alpha channel`, format };
}

/**
 * The loss of the second view of an MV-HEVC spatial video: only MP4-family copies keep its layer
 * configuration, and a re-encode keeps the base view.
 */
export function stereoViewLoss(
    track: { readonly spatial?: SpatialVideo },
    format: string,
    copied = true,
): Omit<MediaDiagnostic, 'severity'> | undefined {
    if (track.spatial?.views !== 'layer' || (copied && isIsoOutput(format))) return undefined;
    return {
        code: 'STEREO_VIEW_DROPPED',
        message: copied ? `${format} cannot keep the second view` : 'Re-encoding keeps one view',
        format,
    };
}

/**
 * The loss of the speaker layout of PCM that a WAVE_FORMAT_EXTENSIBLE description states in MKV,
 * which states none: its readers take the default layout of the channel count.
 */
export function pcmLayoutLoss(
    track: {
        readonly codec: string;
        readonly channelCount: number;
        readonly codecConfig?: Uint8Array;
    },
    format: string,
): Omit<MediaDiagnostic, 'severity'> | undefined {
    const config = track.codecConfig;
    if (format !== 'mkv' || !isPcmCodec(track.codec) || !config || config.length < 24)
        return undefined;
    if ((config[0]! | (config[1]! << 8)) !== 0xfffe) return undefined;
    const mask = new DataView(config.buffer, config.byteOffset + 20, 4).getUint32(0, true);
    if (!mask || mask === defaultChannelMask(track.channelCount)) return undefined;
    return {
        code: 'CHANNEL_LAYOUT_DROPPED',
        message: 'mkv cannot keep the speaker layout',
        format,
    };
}
