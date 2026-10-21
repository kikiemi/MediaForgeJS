import type { MediaFile } from '../read/media-file';
import type { SpatialVideo, VideoProjection } from '../../core/model/media';
import { parseHlsPlaylist } from '../../formats/hls/playlist';
import type { HlsRendition, HlsVariant } from '../../formats/hls/playlist';
import {
    PACKAGE_MAX_SEGMENTS,
    TickClock,
    ceilSeconds,
    decimalUnits,
    demuxedNaming,
    packageError,
    packageSegments,
    snapshotPackageOptions,
} from './segments';
import type {
    PackageContainer,
    PackageLedger,
    PackageNaming,
    PackageOptions,
    PackageSummary,
    PackagedFile,
    PackagedRepresentation,
    ResolvedPackageOptions,
} from './types';
import { HlsSegmentEncryptor, hlsKeyTag, resolveHlsEncryption } from '../../formats/hls/aes';
import { mediaFileState } from '../read/file-state';
import { tx3gText, webVttBlockCue } from '../../formats/text/timed-text';
import type { HlsEncryptionOptions, ResolvedHlsEncryption } from '../../formats/hls/aes';

export type { HlsEncryptionOptions } from '../../formats/hls/aes';

export type {
    PackageContainer,
    PackageLedger,
    PackageOptions,
    PackageProgress,
    PackageSegmentTiming,
    PackageSummary,
    PackagedFile,
    PackagedFileKind,
    PackagedRepresentation,
    PackagedSegment,
} from './types';
import { formatSubtitleTimestamp } from '../../formats/text/subtitles';

interface HlsPackageOptions extends PackageOptions {
    /** Default fmp4. MPEG-TS segments carry PAT/PMT at their start and are always multiplexed. */
    readonly container?: PackageContainer;
    /**
     * fMP4 only: one playlist and segment series per track, with an EXT-X-MEDIA audio group.
     * Default false.
     */
    readonly demuxed?: boolean;
    /** AES-128 whole-segment encryption announced by EXT-X-KEY. */
    readonly encryption?: HlsEncryptionOptions;
    /** Wall-clock time of the first segment, written as EXT-X-PROGRAM-DATE-TIME. */
    readonly programDateTime?: Date | string | number;
}

/** Playlist details that apply to every media playlist of a package. */
interface HlsPlaylistExtras {
    readonly encryption?: ResolvedHlsEncryption;
    readonly programDateTime?: number;
}

export interface HlsPackageSummary extends PackageSummary {
    readonly masterPlaylist: string;
    /** Variants and renditions with URIs relative to the package directory. */
    readonly variants: readonly HlsVariant[];
    readonly renditions: readonly HlsRendition[];
}

interface HlsMasterEntry {
    readonly summary: HlsPackageSummary;
    /** Prefix for this package's playlist URIs, such as a subdirectory ending in a slash. */
    readonly uri?: string;
}

interface ResolvedHlsOptions {
    readonly base: ResolvedPackageOptions;
    readonly container: PackageContainer;
    readonly demuxed: boolean;
    readonly naming: PackageNaming;
    readonly extras: HlsPlaylistExtras;
}

function resolveExtras(options: HlsPackageOptions): HlsPlaylistExtras {
    const encryption = options.encryption ? resolveHlsEncryption(options.encryption) : undefined;
    let programDateTime: number | undefined;
    if (options.programDateTime !== undefined) {
        programDateTime = new Date(options.programDateTime).getTime();
        if (!Number.isFinite(programDateTime)) packageError('programDateTime is not a valid date');
    }
    return { encryption, programDateTime };
}

const MASTER_PLAYLIST = 'master.m3u8';
const MEDIA_PLAYLIST = 'index.m3u8';
const AUDIO_GROUP = 'audio';
const SUBTITLE_GROUP = 'subs';

function snapshotHlsOptions(options: HlsPackageOptions): ResolvedHlsOptions {
    const base = snapshotPackageOptions(options);
    const { container = 'fmp4', demuxed = false } = options;
    if (container !== 'fmp4' && container !== 'ts') packageError('container must be fmp4 or ts');
    if (typeof demuxed !== 'boolean') packageError('demuxed must be boolean');
    if (demuxed && container === 'ts') packageError('demuxed output requires the fmp4 container');

    const extras = resolveExtras(options);
    if (demuxed) return { base, container, demuxed, naming: demuxedNaming, extras };
    const extension = container === 'ts' ? 'ts' : 'm4s';
    return {
        base,
        container,
        demuxed,
        naming: {
            init: () => 'init.mp4',
            segment: (_representation, number) =>
                `segment-${String(number).padStart(5, '0')}.${extension}`,
            firstNumber: 0,
        },
        extras,
    };
}

function quoted(value: string, label: string): string {
    if (/["\r\n\x00]/.test(value))
        packageError(`${label} contains a quote or control character`, 'FORMAT');
    return `"${value}"`;
}

function mediaPlaylistText(
    representation: PackagedRepresentation,
    extras: HlsPlaylistExtras = {},
): string {
    const targetDuration = ceilSeconds(representation.segments.map(segment => segment.timing));
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-INDEPENDENT-SEGMENTS',
    ];

    if (representation.init)
        lines.push(`#EXT-X-MAP:URI=${quoted(representation.init, 'init name')}`);
    if (extras.encryption) lines.push(hlsKeyTag(extras.encryption));
    if (extras.programDateTime !== undefined && representation.segments.length)
        lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(extras.programDateTime).toISOString()}`);

    const clock = new TickClock();
    let previous = 0n;
    for (const segment of representation.segments) {
        clock.add(segment.timing.duration, segment.timing.timescale);
        const elapsed = clock.units(6);
        if (elapsed <= previous) packageError('segment shorter than one microsecond', 'FORMAT');
        lines.push(`#EXTINF:${decimalUnits(elapsed - previous, 6)},`, segment.name);
        previous = elapsed;
    }

    lines.push('#EXT-X-ENDLIST');
    const text = `${lines.join('\n')}\n`;
    parseHlsPlaylist(text, { validation: 'strict', maxPlaylistEntries: PACKAGE_MAX_SEGMENTS });
    return text;
}

function renditionName(representation: PackagedRepresentation, used: Set<string>): string {
    const preferred = representation.name?.trim() || representation.language || representation.id;
    const name = used.has(preferred) ? `${preferred} (${representation.id})` : preferred;
    used.add(name);
    return name;
}

function variantCodecs(
    video: PackagedRepresentation,
    audio: readonly PackagedRepresentation[],
): string {
    return [
        ...new Set([...video.codecs, ...audio.flatMap(representation => representation.codecs)]),
    ].join(',');
}

function frameRateValue(representation: PackagedRepresentation): number | undefined {
    const rate = representation.frameRate;
    return rate ? Math.round((rate.num / rate.den) * 1000) / 1000 : undefined;
}

/** HLS projection specifiers of the projections REQ-VIDEO-LAYOUT names. */
const HLS_PROJECTIONS: Readonly<Partial<Record<VideoProjection, string>>> = {
    equirectangular: 'PROJ-EQUI',
    'half-equirectangular': 'PROJ-HEQU',
    parametric: 'PROJ-PRIM',
};

/**
 * The REQ-VIDEO-LAYOUT of a spatial video variant: both eyes and a projection other than
 * rectilinear; none for monoscopic rectilinear video, the default.
 */
function variantLayout(spatial: SpatialVideo | undefined): Pick<HlsVariant, 'attributes'> {
    const specifiers = [
        spatial?.eyes.length === 2 && 'CH-STEREO',
        spatial?.projection && HLS_PROJECTIONS[spatial.projection],
    ].filter(Boolean);
    return specifiers.length ? { attributes: { 'REQ-VIDEO-LAYOUT': specifiers.join('/') } } : {};
}

function playlistEntries(
    representations: readonly PackagedRepresentation[],
): Pick<HlsPackageSummary, 'variants' | 'renditions'> {
    const video = representations.filter(representation => representation.type !== 'audio');
    const audio = representations.filter(representation => representation.type === 'audio');
    const grouped = audio.length > 0 && (video.length > 0 || audio.length > 1);
    const used = new Set<string>();
    const renditions: HlsRendition[] = grouped
        ? audio.map((representation, index) => ({
              type: 'AUDIO',
              groupId: AUDIO_GROUP,
              name: renditionName(representation, used),
              uri: representation.playlist!,
              language: representation.language,
              default: index === 0,
              autoselect: true,
              channels: representation.channelCount
                  ? String(representation.channelCount)
                  : undefined,
          }))
        : [];

    const audioPeak = Math.max(0, ...audio.map(representation => representation.bandwidth));
    const audioAverage = Math.max(
        0,
        ...audio.map(representation => representation.averageBandwidth),
    );
    const variants: HlsVariant[] = video.length
        ? video.map(representation => ({
              uri: representation.playlist!,
              bandwidth: Math.max(1, representation.bandwidth + audioPeak),
              averageBandwidth: Math.max(1, representation.averageBandwidth + audioAverage),
              codecs: variantCodecs(representation, audio),
              resolution:
                  representation.displayWidth && representation.displayHeight
                      ? { width: representation.displayWidth, height: representation.displayHeight }
                      : undefined,
              frameRate: frameRateValue(representation),
              audio: grouped ? AUDIO_GROUP : undefined,
              ...variantLayout(representation.spatial),
          }))
        : [
              {
                  uri: audio[0]!.playlist!,
                  bandwidth: Math.max(1, audioPeak),
                  averageBandwidth: Math.max(1, audioAverage),
                  codecs: [...new Set(audio.flatMap(representation => representation.codecs))].join(
                      ',',
                  ),
                  audio: grouped ? AUDIO_GROUP : undefined,
              },
          ];
    return { variants, renditions };
}

function masterPlaylistText(entries: readonly HlsMasterEntry[]): string {
    if (!Array.isArray(entries) || !entries.length)
        packageError('expected at least one package to combine');
    const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
    const groups = entries.map((entry, index) => {
        if (
            !entry ||
            typeof entry !== 'object' ||
            !entry.summary ||
            typeof entry.summary !== 'object'
        )
            packageError('expected a package summary');
        const prefix = entry.uri ?? '';
        if (typeof prefix !== 'string' || /["\r\n\x00\s]/.test(prefix))
            packageError('invalid playlist URI prefix');
        const suffix = entries.length > 1 ? `-${index}` : '';
        return {
            prefix,
            group: `${AUDIO_GROUP}${suffix}`,
            subtitles: `${SUBTITLE_GROUP}${suffix}`,
        };
    });

    entries.forEach((entry, index) => {
        const { prefix, group, subtitles } = groups[index]!;
        for (const rendition of entry.summary.renditions) {
            const groupId = rendition.type === 'SUBTITLES' ? subtitles : group;
            const attributes = [
                `TYPE=${rendition.type}`,
                `GROUP-ID=${quoted(groupId, 'GROUP-ID')}`,
                `NAME=${quoted(rendition.name, 'NAME')}`,
            ];
            if (rendition.language !== undefined)
                attributes.push(`LANGUAGE=${quoted(rendition.language, 'LANGUAGE')}`);
            attributes.push(`DEFAULT=${rendition.default ? 'YES' : 'NO'}`, 'AUTOSELECT=YES');
            if (rendition.type === 'SUBTITLES' && rendition.forced) attributes.push('FORCED=YES');
            if (rendition.channels !== undefined)
                attributes.push(`CHANNELS=${quoted(rendition.channels, 'CHANNELS')}`);
            if (rendition.uri === undefined) packageError('rendition requires a URI', 'FORMAT');
            attributes.push(`URI=${quoted(`${prefix}${rendition.uri}`, 'URI')}`);
            lines.push(`#EXT-X-MEDIA:${attributes.join(',')}`);
        }
    });

    entries.forEach((entry, index) => {
        const { prefix, group, subtitles } = groups[index]!;
        for (const variant of entry.summary.variants) {
            const attributes = [`BANDWIDTH=${variant.bandwidth}`];
            if (variant.averageBandwidth !== undefined)
                attributes.push(`AVERAGE-BANDWIDTH=${variant.averageBandwidth}`);
            if (variant.codecs) attributes.push(`CODECS=${quoted(variant.codecs, 'CODECS')}`);
            if (variant.resolution)
                attributes.push(
                    `RESOLUTION=${variant.resolution.width}x${variant.resolution.height}`,
                );
            if (variant.frameRate !== undefined)
                attributes.push(`FRAME-RATE=${variant.frameRate.toFixed(3)}`);
            const layout = variant.attributes?.['REQ-VIDEO-LAYOUT'];
            if (layout) attributes.push(`REQ-VIDEO-LAYOUT=${quoted(layout, 'REQ-VIDEO-LAYOUT')}`);
            if (variant.audio !== undefined) attributes.push(`AUDIO=${quoted(group, 'AUDIO')}`);
            if (variant.subtitles !== undefined)
                attributes.push(`SUBTITLES=${quoted(subtitles, 'SUBTITLES')}`);
            lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`, `${prefix}${variant.uri}`);
        }
    });

    const text = `${lines.join('\n')}\n`;
    const parsed = parseHlsPlaylist(text, { validation: 'strict' });
    if (parsed.type !== 'master' || !parsed.variants.length)
        packageError('master playlist has no variants', 'FORMAT');
    return text;
}

function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

/**
 * Combines finished packages into one master playlist, one variant per package plus its audio
 * renditions.
 */
export function hlsMasterPlaylist(entries: readonly HlsMasterEntry[]): PackagedFile {
    return { kind: 'playlist', name: MASTER_PLAYLIST, data: encode(masterPlaylistText(entries)) };
}

/**
 * Writes one media playlist per representation and the master playlist for segments already
 * emitted.
 */
export function* hlsPlaylists(
    ledger: PackageLedger,
    playlistName: (representation: PackagedRepresentation) => string,
    extras: HlsPlaylistExtras = {},
    subtitles: readonly HlsRendition[] = [],
): Generator<PackagedFile, HlsPackageSummary> {
    const representations = ledger.representations.map(representation => ({
        ...representation,
        playlist: playlistName(representation),
    }));

    const used = new Set<string>();
    if (extras.encryption?.keyFile) {
        used.add(extras.encryption.keyFile);
        yield ledger.accept({
            kind: 'key',
            name: extras.encryption.keyFile,
            data: extras.encryption.key.slice(),
        });
    }

    for (const representation of representations) {
        if (used.has(representation.playlist))
            packageError('duplicate media playlist name', 'FORMAT');
        used.add(representation.playlist);
        yield ledger.accept({
            kind: 'playlist',
            name: representation.playlist,
            data: encode(mediaPlaylistText(representation, extras)),
            representation: representation.id,
        });
    }

    const played = playlistEntries(representations);
    const entries = subtitles.length
        ? {
              variants: played.variants.map(variant => ({ ...variant, subtitles: SUBTITLE_GROUP })),
              renditions: [...played.renditions, ...subtitles],
          }
        : played;

    const summary: HlsPackageSummary = {
        representations,
        files: ledger.files,
        bytes: ledger.bytes,
        duration: Math.max(0, ...representations.map(representation => representation.duration)),
        targetDuration: ceilSeconds(
            representations.flatMap(representation =>
                representation.segments.map(segment => segment.timing),
            ),
        ),
        masterPlaylist: MASTER_PLAYLIST,
        ...entries,
    };
    yield ledger.accept(hlsMasterPlaylist([{ summary }]));
    return { ...summary, files: ledger.files, bytes: ledger.bytes };
}

/**
 * Packages an open file as an HLS VOD presentation: init/segments, then media playlists, then
 * master.m3u8.
 */
export async function* packageHls(
    file: MediaFile,
    options: HlsPackageOptions = {},
): AsyncGenerator<PackagedFile, HlsPackageSummary> {
    const resolved = snapshotHlsOptions(options);
    const encryptor = resolved.extras.encryption
        ? new HlsSegmentEncryptor(resolved.extras.encryption)
        : undefined;
    const ledger = yield* packageSegments({
        file,
        options: resolved.base,
        container: resolved.container,
        demuxed: resolved.demuxed,
        naming: resolved.naming,
        transformSegment: encryptor
            ? async (segment, sequence) => ({
                  ...segment,
                  data: await encryptor.encrypt(segment.data, sequence),
              })
            : undefined,
    });

    const subtitles = yield* subtitleRenditions(
        file,
        ledger,
        resolved.extras,
        resolved.base.trackIds,
    );
    return yield* hlsPlaylists(
        ledger,
        representation => (resolved.demuxed ? `${representation.id}.m3u8` : MEDIA_PLAYLIST),
        resolved.extras,
        subtitles,
    );
}

interface Cue {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

/**
 * Cue text of a text subtitle sample, or undefined for codecs the WebVTT renditions do not carry.
 */
function cueText(codec: string, data: Uint8Array): string | undefined {
    if (codec === 'tx3g') return new TextDecoder().decode(tx3gText(data));
    if (codec === 'text/utf8') return new TextDecoder().decode(data);
    // A WebVTT block holds the cue identifier and settings lines before its text.
    if (codec === 'text/webvtt') return webVttBlockCue(new TextDecoder().decode(data)).text;
    return undefined;
}

/** WebVTT timestamp hh:mm:ss.ttt of a time in seconds. */
function vttTime(seconds: number): string {
    return formatSubtitleTimestamp(Math.max(0, seconds));
}

/**
 * One WebVTT segment: the cues that overlap it, on the media timeline (X-TIMESTAMP-MAP maps it to
 * itself).
 */
function vttSegment(cues: readonly Cue[]): Uint8Array {
    const blocks = cues.map(
        cue =>
            `${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text
                .replace(/\r\n?/g, '\n')
                .replace(/\n{2,}/g, '\n')
                .replace(/-->/g, '--&gt;')
                .trim()}`,
    );
    return encode(
        [
            'WEBVTT',
            'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000',
            '',
            ...blocks.map(block => `${block}\n`),
        ].join('\n'),
    );
}

/**
 * WebVTT renditions of the file's text subtitle tracks (SRT, WebVTT and MP4 timed text) of
 * `trackIds`, or all, cut on the segment grid of the first representation so every subtitle
 * segment lines up with a media segment. Other subtitle codecs are left out with a warning.
 */
export async function* subtitleRenditions(
    file: MediaFile,
    ledger: PackageLedger,
    extras: HlsPlaylistExtras,
    trackIds: readonly number[] | undefined,
): AsyncGenerator<PackagedFile, HlsRendition[]> {
    const state = mediaFileState(file);
    const grid = ledger.representations[0];
    const tracks = state.tracks.filter(
        track =>
            track.type === 'subtitle' &&
            (trackIds === undefined || trackIds.includes(track.description.id)),
    );
    const renditions: HlsRendition[] = [];
    if (!grid || !tracks.length) return renditions;

    const used = new Set<string>();
    for (const track of tracks) {
        const id = track.description.id;
        if (cueText(track.info.codec, new Uint8Array(0)) === undefined) {
            state.diagnostics.warn({
                code: 'HLS_SUBTITLES_SKIPPED',
                message: `Subtitle track ${id} is left out: HLS carries WebVTT only`,
                trackId: id,
            });
            continue;
        }

        const cues: Cue[] = [];
        for await (const packet of file.packets({ trackIds: [id] })) {
            const text = cueText(track.info.codec, packet.data)!.trim();
            if (text)
                cues.push({
                    start: packet.timestamp,
                    end: packet.timestamp + packet.duration,
                    text,
                });
        }

        const segments = grid.segments.map((segment, index) => {
            const start = Number(segment.timing.time) / segment.timing.timescale;
            const end = start + Number(segment.timing.duration) / segment.timing.timescale;
            const last = index === grid.segments.length - 1;
            return {
                ...segment,
                name: `subtitles-${id}-${String(index).padStart(5, '0')}.vtt`,
                data: vttSegment(cues.filter(cue => cue.end > start && (last || cue.start < end))),
            };
        });
        for (const segment of segments)
            yield ledger.accept({
                kind: 'segment',
                name: segment.name,
                data: segment.data,
                number: segment.number,
            });

        const playlist = `subtitles-${id}.m3u8`;
        yield ledger.accept({
            kind: 'playlist',
            name: playlist,
            data: encode(
                mediaPlaylistText(
                    { ...grid, init: undefined, segments },
                    { programDateTime: extras.programDateTime },
                ),
            ),
        });

        const language = track.description.language;
        renditions.push({
            type: 'SUBTITLES',
            groupId: SUBTITLE_GROUP,
            name: renditionName(
                { ...grid, id: `subtitles-${id}`, name: track.info.name, language },
                used,
            ),
            uri: playlist,
            language,
            default: false,
            autoselect: true,
            forced: track.info.forced,
        });
    }
    return renditions;
}
