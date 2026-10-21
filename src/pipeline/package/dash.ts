import type { MediaFile } from '../read/media-file';
import { mediaFileState } from '../read/file-state';
import { xmlEscape } from '../../formats/shared/xml';
import { parseDashManifest } from '../../formats/dash/mpd';
import { hlsPlaylists, subtitleRenditions } from './hls';
import type { HlsPackageSummary } from './hls';
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
import type { PackageOptions, PackageSummary, PackagedFile, PackagedRepresentation } from './types';

export type {
    PackageOptions,
    PackageProgress,
    PackageSegmentTiming,
    PackageSummary,
    PackagedFile,
    PackagedFileKind,
    PackagedRepresentation,
    PackagedSegment,
} from './types';

interface DashPackageOptions extends PackageOptions {
    /**
     * Also write HLS media playlists and master.m3u8 that reference the same CMAF segments. Default
     * false.
     */
    readonly hlsPlaylists?: boolean;
}

interface DashPackageSummary extends PackageSummary {
    readonly manifest: string;
    readonly hls?: HlsPackageSummary;
}

const MANIFEST = 'manifest.mpd';
const INIT_TEMPLATE = demuxedNaming.init('$RepresentationID$');
const MEDIA_TEMPLATE = 'seg-$RepresentationID$-$Number$.m4s';
const DASH_NAMESPACE = 'urn:mpeg:dash:schema:mpd:2011';
const PROFILE = 'urn:mpeg:dash:profile:isoff-live:2011';
const CHANNEL_SCHEME = 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011';

function attribute(name: string, value: string | number | undefined): string {
    return value === undefined ? '' : ` ${name}="${xmlEscape(String(value))}"`;
}

function isoDuration(units: bigint): string {
    return `PT${decimalUnits(units, 6)}S`;
}

function timelineText(representation: PackagedRepresentation): string {
    const entries: string[] = [];
    let expected: bigint | undefined;
    let run: { time: bigint; duration: bigint; repeat: number } | undefined;
    const close = (): void => {
        if (run)
            entries.push(
                `<S t="${run.time}" d="${run.duration}"${run.repeat ? ` r="${run.repeat}"` : ''}/>`,
            );
        run = undefined;
    };

    for (const segment of representation.segments) {
        const { time, duration } = segment.timing;
        if (segment.timing.timescale !== representation.timescale)
            packageError('DASH representation segments must share one timescale', 'FORMAT');
        if (expected !== undefined && time < expected)
            packageError('overlapping segment timeline', 'FORMAT');
        if (run && time === expected && duration === run.duration) run.repeat++;
        else {
            close();
            run = { time, duration, repeat: 0 };
        }
        expected = time + duration;
    }

    close();
    return entries.join('');
}

function representationText(representation: PackagedRepresentation, index: number): string {
    const audio = representation.type === 'audio';
    const rate = representation.frameRate;
    const adaptation =
        attribute('id', index) +
        attribute('contentType', audio ? 'audio' : 'video') +
        attribute('mimeType', audio ? 'audio/mp4' : 'video/mp4') +
        attribute('codecs', representation.codecs.join(',')) +
        attribute('lang', representation.language) +
        attribute('segmentAlignment', 'true') +
        attribute('startWithSAP', 1) +
        attribute('width', audio ? undefined : representation.width) +
        attribute('height', audio ? undefined : representation.height) +
        attribute(
            'frameRate',
            rate ? (rate.den === 1 ? rate.num : `${rate.num}/${rate.den}`) : undefined,
        ) +
        attribute('audioSamplingRate', audio ? representation.sampleRate : undefined);

    const channels =
        audio && representation.channelCount
            ? `<AudioChannelConfiguration${attribute('schemeIdUri', CHANNEL_SCHEME)}` +
              `${attribute('value', representation.channelCount)}/>`
            : '';

    const template =
        `<SegmentTemplate${attribute('timescale', representation.timescale)}` +
        `${attribute('initialization', INIT_TEMPLATE)}${attribute('media', MEDIA_TEMPLATE)}` +
        `${attribute('startNumber', demuxedNaming.firstNumber)}>` +
        `<SegmentTimeline>${timelineText(representation)}</SegmentTimeline></SegmentTemplate>`;

    return (
        `<AdaptationSet${adaptation}>` +
        `<Representation${attribute('id', representation.id)}` +
        `${attribute('bandwidth', Math.max(1, representation.bandwidth))}>` +
        `${channels}${template}</Representation></AdaptationSet>`
    );
}

function manifestText(representations: readonly PackagedRepresentation[]): string {
    if (!representations.length) packageError('manifest requires a representation', 'FORMAT');
    // The presentation lasts until the last segment of any representation ends: one that starts
    // after zero (the video of a capture whose audio starts first) ends that much after the sum of
    // its durations.
    let longest = 0n;
    for (const representation of representations) {
        const clock = new TickClock();
        for (const segment of representation.segments)
            clock.add(segment.timing.duration, segment.timing.timescale);
        const last = representation.segments.at(-1)?.timing;
        const end = new TickClock();
        if (last) end.add(last.time + last.duration, last.timescale);
        const units = [clock.ceilUnits(6), end.ceilUnits(6)].reduce((a, b) => (a > b ? a : b));
        if (units > longest) longest = units;
    }

    const minBuffer = ceilSeconds(
        representations.flatMap(representation =>
            representation.segments.map(segment => segment.timing),
        ),
    );
    const text =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        `<MPD ` +
        `xmlns="${DASH_NAMESPACE}"${attribute('profiles', PROFILE)}${attribute('type', 'static')}` +
        attribute('mediaPresentationDuration', isoDuration(longest)) +
        `${attribute('minBufferTime', `PT${minBuffer}S`)}>` +
        `<Period${attribute('id', 0)}${attribute('start', 'PT0S')}>` +
        representations.map(representationText).join('') +
        '</Period></MPD>\n';

    parseDashManifest(text, {
        maxSegments: PACKAGE_MAX_SEGMENTS,
        maxRepresentations: representations.length,
        maxPlanEntries: PACKAGE_MAX_SEGMENTS,
    });
    return text;
}

/** Packages an open file as a static DASH presentation with one CMAF representation per track. */
export async function* packageDash(
    file: MediaFile,
    options: DashPackageOptions = {},
): AsyncGenerator<PackagedFile, DashPackageSummary> {
    const base = snapshotPackageOptions(options);
    const { hlsPlaylists: withHls = false } = options;
    if (typeof withHls !== 'boolean') packageError('hlsPlaylists must be boolean');
    // The manifest has no text: subtitle tracks trackIds names are left out, refused strictly.
    const state = mediaFileState(file);
    const left = withHls
        ? []
        : state.tracks.filter(
              track => track.type === 'subtitle' && base.trackIds?.includes(track.description.id),
          );
    if (left.length) {
        const named = left.map(track => `${track.description.id} (subtitle)`).join(', ');
        if (state.diagnostics.validation === 'strict')
            packageError(`dash cannot hold track${left.length > 1 ? 's' : ''} ${named}`, 'FORMAT');
        state.diagnostics.warn({
            code: 'TARGET_TRACKS_DROPPED',
            ...(left.length === 1 ? { trackId: left[0]!.description.id } : {}),
            format: 'dash',
            message: `dash cannot hold track${left.length > 1 ? 's' : ''} ${named}`,
        });
    }

    const ledger = yield* packageSegments({
        file,
        options: base,
        container: 'fmp4',
        demuxed: true,
        naming: demuxedNaming,
    });

    const representations = ledger.representations;
    yield ledger.accept({
        kind: 'manifest',
        name: MANIFEST,
        data: new TextEncoder().encode(manifestText(representations)),
    });

    // The HLS playlists carry the text subtitles as WebVTT renditions, as an HLS package does; the
    // manifest has no text adaptation set.
    const hls = withHls
        ? yield* hlsPlaylists(
              ledger,
              representation => `${representation.id}.m3u8`,
              {},
              yield* subtitleRenditions(file, ledger, {}, base.trackIds),
          )
        : undefined;
    return {
        representations: hls?.representations ?? representations,
        files: ledger.files,
        bytes: ledger.bytes,
        duration: Math.max(0, ...representations.map(representation => representation.duration)),
        targetDuration: ceilSeconds(
            representations.flatMap(representation =>
                representation.segments.map(segment => segment.timing),
            ),
        ),
        manifest: MANIFEST,
        hls,
    };
}
