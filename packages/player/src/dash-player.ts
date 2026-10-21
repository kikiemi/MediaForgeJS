import { MediaForgeError, type PlayerFactory, type PlayerSettings } from 'mediaforgejs/plugins';
import {
    type DashRepresentation,
    type DashResource,
    type HlsSegment,
    iterateDashSegments,
    resolveDashManifest,
} from 'mediaforgejs/streaming';
import type { HlsPartData } from './hls-client.js';
import { fetchResource, networkUri } from './fetch-resource.js';
import { highestOf, malformed, playableOf, unsupported } from './support.js';
import { type PlaybackStream, playStreams } from './hls-playback.js';

/** Largest manifest read; a larger one fails with OOM. */
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

/** Largest segment read. */
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

/** Refuses a manifest whose streams the player does not play. */
function invalid(message: string): never {
    return unsupported(`DASH playback: ${message}`);
}

/** The bytes of one resource (the byte range of it the manifest names), within the deadline. */
async function fetchDash(
    resource: DashResource,
    settings: PlayerSettings,
    signal: AbortSignal,
    limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
    const { bytes } = await fetchResource({
        fetcher: (settings.fetch ?? globalThis.fetch).bind(globalThis),
        url: networkUri(resource.url, 'DASH'),
        limit,
        signal,
        timeoutMs: settings.requestTimeoutMs ?? 30000,
        ...(resource.byteRange ? { range: resource.byteRange } : {}),
        label: 'DASH',
    });
    return bytes as Uint8Array<ArrayBuffer>;
}

/**
 * The representation of an adaptation set the player plays: the one of the highest bandwidth among
 * those the browser's MSE plays, as for an HLS variant (playableOf, highestOf).
 */
function chosen(representations: readonly DashRepresentation[]): DashRepresentation | undefined {
    const playable = (representation: DashRepresentation): boolean => {
        const { mimeType, codecs } = representation;
        if (!mimeType || !codecs || /["\r\n]/.test(codecs) || typeof MediaSource !== 'function')
            return true;
        return MediaSource.isTypeSupported(`${mimeType}; codecs="${codecs}"`);
    };
    return highestOf(
        playableOf(representations, playable),
        representation => representation.bandwidth ?? 0,
    );
}

/** The MSE type of a representation, from its MIME type and codecs. */
function mseType(representation: DashRepresentation): string {
    const { mimeType, codecs } = representation;
    if (!mimeType || !/^(?:audio|video)\/mp4$/i.test(mimeType))
        invalid(`representation ${representation.id ?? ''} is not fMP4 (${mimeType ?? 'no type'})`);
    if (!codecs || /["\r\n]/.test(codecs))
        invalid(`representation ${representation.id ?? ''} names no codecs`);
    return `${mimeType}; codecs="${codecs}"`;
}

/** The units of one representation: its initialization segment, then its media segments. */
async function* representationUnits(
    representation: DashRepresentation,
    settings: PlayerSettings,
    signal: AbortSignal,
): AsyncGenerator<HlsPartData, void> {
    const initialization = representation.initialization;
    if (!initialization) invalid(`representation ${representation.id ?? ''} has no initialization`);
    const map = { uri: initialization.url, byteRange: initialization.byteRange };
    let initData: Uint8Array | undefined = await fetchDash(
        initialization,
        settings,
        signal,
        MAX_SEGMENT_BYTES,
    );

    let sequence = 0;
    for (const segment of iterateDashSegments(representation)) {
        const data = await fetchDash(segment, settings, signal, MAX_SEGMENT_BYTES);
        const entry = {
            uri: segment.url,
            duration: Number(segment.duration) / segment.timescale,
            sequence: sequence++,
            discontinuitySequence: 0,
            map,
        } as HlsSegment;

        yield { type: 'segment', segment: entry, data, ...(initData ? { initData } : {}) };
        initData = undefined;
    }
}

/**
 * The player plugin's DASH player for static MPDs of fMP4 (CMAF) segments: the first period's
 * video and audio adaptation sets play together, each from its representation of the highest
 * bandwidth, through one MediaSource with a SourceBuffer for each.
 */
export const playDashStream: PlayerFactory = async ({ url, media, settings, signal }) => {
    if (settings.drm)
        throw new MediaForgeError('DASH playback takes no drm options', 'INPUT', {
            hint: 'Play the DASH stream unencrypted, or use encrypted HLS.',
        });
    const text = new TextDecoder().decode(
        await fetchDash({ url }, settings, signal, MAX_MANIFEST_BYTES),
    );

    // SegmentBase representations list their segments in a sidx box, read here.
    const manifest = await resolveDashManifest(text, {
        baseUrl: url,
        signal,
        readIndex: (resource, indexSignal) =>
            fetchDash(resource, settings, indexSignal ?? signal, MAX_SEGMENT_BYTES),
    });

    const period = manifest.periods[0];
    if (!period) malformed('DASH playback: the manifest has no period');
    const streams: PlaybackStream[] = [];
    for (const kind of ['video', 'audio'] as const) {
        const set = period.adaptationSets.find(
            candidate =>
                (candidate.contentType ?? candidate.representations[0]?.contentType) === kind,
        );
        const representation = set && chosen(set.representations);
        if (!representation) continue;
        streams.push({
            units: representationUnits(representation, settings, signal),
            mimeType: mseType(representation),
        });
    }

    if (!streams.length) invalid('the first period has no video or audio adaptation set');
    await playStreams(media, streams, {
        autoplay: settings.autoplay,
        bufferAhead: settings.bufferAhead,
        bufferBehind: settings.bufferBehind,
        operationTimeoutMs: settings.operationTimeoutMs,
        signal,
    });
};
