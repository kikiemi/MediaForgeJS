import type { MediaDiagnostic } from 'mediaforgejs';
import { MediaForgeError } from 'mediaforgejs/plugins';
import {
    type HlsByteRange,
    type HlsKey,
    type HlsMap,
    type HlsMasterPlaylist,
    type HlsMediaPlaylist,
    type HlsPart,
    type HlsPlaylist,
    type HlsSegment,
    type HlsVariant,
    getHlsRenditions,
    parseHlsPlaylist,
} from 'mediaforgejs/streaming';
import {
    type WarningOptions,
    Warnings,
    awaitWithAbort,
    codecsType,
    highestOf,
    ioError,
    linkAbortSignals,
    playableOf,
    throwIfAborted,
} from './support.js';
import { AdaptiveQualityController, type AdaptiveQualityOptions } from './adaptive-quality.js';
import {
    checkedChunkLength,
    delay,
    fetchResource,
    monotonicNow,
    networkUri,
} from './fetch-resource.js';
import type { HlsEncryptionContext, HlsEncryptionHandler, HlsKeyLoader } from './encryption.js';

export interface HlsVariantChange {
    previous?: HlsVariant;
    variant: HlsVariant;
    /** First media sequence to be downloaded from this variant; numbering is variant-local. */
    sequence: number;
    /** Present when the first downloaded unit is a PART; numbering is parent-local. */
    partIndex?: number;
    bandwidthEstimate?: number;
    reason: 'initial' | 'up' | 'down';
}

export interface HlsAdaptiveOptions extends AdaptiveQualityOptions {
    /**
     * Awaited before initial/segment downloads and before delivery of staged PART switches;
     * rejection stops iteration.
     */
    onVariantChange?: (event: HlsVariantChange) => void | PromiseLike<void>;
    /**
     * Also switch to variants of other AUDIO and SUBTITLES groups, for a caller that follows their
     * renditions, as play() does: of the same codecs, with the main sound in a playlist of its own
     * where the current variant's is. Default false.
     */
    switchGroups?: boolean;
    /**
     * Also switch to variants of other codecs of the same kinds (picture, sound), for a caller that
     * changes its decoders' types at the switch, as play() does with SourceBuffer.changeType()
     * where the browser has it. Default false: the same codecs only.
     */
    switchCodecs?: boolean;
}

export interface HlsClientOptions extends WarningOptions {
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    maxPlaylistBytes?: number;
    maxSegmentBytes?: number;
    /** Ordered handlers are tried before built-in identity AES-128. */
    encryptionHandlers?: readonly HlsEncryptionHandler[];
    keyLoader?: HlsKeyLoader;
    /** Maximum bytes returned by a key request. Default 65536. */
    maxKeyBytes?: number;
    /** Completed keys retained per iterator; zero disables caching. Default 8. */
    maxCachedKeys?: number;
    /** Bounds segments plus PART entries retained across delta refreshes. Default 100000. */
    maxPlaylistEntries?: number;
    refreshIntervalMs?: number;
    /** Deadline for each resource, including its body. Default 30000 ms. */
    requestTimeoutMs?: number;
    /**
     * Opt-in adaptation after loading a master. PART/live switching requires matching PDT or
     * discontinuity anchors.
     */
    adaptive?: boolean | HlsAdaptiveOptions;
    /**
     * The variants the caller can play (a browser's MSE types): the client starts on and switches
     * to these only, or to any when none is.
     */
    playable?: (variant: HlsVariant) => boolean;
}

export interface HlsSegmentOptions {
    live?: boolean;
    startSequence?: number;
    signal?: AbortSignal;
    /** Stop normally after this many playlist refreshes; zero reads the loaded snapshot only. */
    maxRefreshes?: number;
    /**
     * Fail after this many refreshes without progress. parts() and adaptive live segments() default
     * to 10.
     */
    maxIdleRefreshes?: number;
}

export type HlsPartOptions = HlsSegmentOptions;

export type HlsPartData =
    | {
          type: 'part';
          part: HlsPart;
          sequence: number;
          partIndex: number;
          discontinuitySequence: number;
          /** Metadata snapshot of the variant that supplied this PART in adaptive mode. */
          variant?: HlsVariant;
          data: Uint8Array;
          initData?: Uint8Array;
          encryption?: HlsKey;
      }
    | ({ type: 'segment' } & HlsSegmentData);

export interface HlsSegmentData {
    segment: HlsSegment;
    data: Uint8Array;
    /**
     * Present for adaptive downloads; metadata snapshot of the variant that supplied this segment.
     */
    variant?: HlsVariant;
    /** Present when the initialization map changes, including after a discontinuity. */
    initData?: Uint8Array;
    /** Selected key when a handler leaves media or initialization bytes encrypted. */
    encryption?: HlsKey;
}

interface AdaptiveSession {
    controller: AdaptiveQualityController;
    variants: HlsVariant[];
    variant: HlsVariant;
    current: AdaptiveSnapshot;
    alternate?: {
        variant: HlsVariant;
        snapshot?: AdaptiveSnapshot;
        checkedAt: number;
        generation: number;
        warned?: boolean;
    };
    generation: number;
    completeTimeline: boolean;
    masterIndependent: boolean;
    initialNotified: boolean;
}

interface AdaptiveSnapshot {
    playlist: HlsMediaPlaylist;
    url: string;
    loadedAt: number;
    timeline: AdaptivePosition[];
}

interface AdaptivePosition {
    date?: number;
    boundary?: number;
}

interface DownloadedUnit {
    data: Uint8Array;
    initData?: Uint8Array;
    map?: string;
    discontinuity: number;
    byteLength: number;
    elapsedMs: number;
    encryption?: HlsKey;
    mapEncryption?: HlsKey;
}

interface SelectedEncryption {
    context: HlsEncryptionContext;
    handler?: HlsEncryptionHandler;
}

function playlistEntry(
    playlist: HlsMediaPlaylist,
    index: number,
): HlsSegment | HlsPart | undefined {
    return (
        playlist.segments[index] ??
        (index === playlist.segments.length ? playlist.trailingParts?.[0] : undefined)
    );
}

function playlistParts(playlist: HlsMediaPlaylist, index: number): HlsPart[] | undefined {
    return (
        playlist.segments[index]?.parts ??
        (index === playlist.segments.length ? playlist.trailingParts : undefined)
    );
}

function adaptiveTimeline(
    playlist: HlsMediaPlaylist,
    previous?: AdaptiveSnapshot,
): AdaptivePosition[] {
    const positions: AdaptivePosition[] = [];
    const count = playlist.segments.length + (playlist.trailingParts?.length ? 1 : 0);
    for (let first = 0; first < count;) {
        const discontinuity = playlistEntry(playlist, first)!.discontinuitySequence;
        let end = first;
        let elapsed = 0;
        let date: number | undefined;
        let boundary: number | undefined = playlistEntry(playlist, first)!.discontinuity
            ? 0
            : undefined;
        let inconsistent = false;

        const offsets: number[] = [];
        while (
            end < count &&
            playlistEntry(playlist, end)!.discontinuitySequence === discontinuity
        ) {
            const segment = playlistEntry(playlist, end)!;
            offsets.push(elapsed);
            let knownDate = segment.programDateTime
                ? Date.parse(segment.programDateTime)
                : undefined;
            const oldIndex = previous ? segment.sequence! - previous.playlist.mediaSequence : -1;
            const old = previous ? playlistEntry(previous.playlist, oldIndex) : undefined;

            if (old?.discontinuitySequence === discontinuity) {
                const position = previous!.timeline[oldIndex];
                if (position.date !== undefined) {
                    if (knownDate !== undefined && Math.abs(knownDate - position.date) > 1)
                        inconsistent = true;
                    knownDate ??= position.date;
                }
                if (position.boundary !== undefined) boundary ??= position.boundary - elapsed;
            }

            if (knownDate !== undefined) {
                const origin = knownDate - elapsed;
                if (date !== undefined && Math.abs(origin - date) > 1) inconsistent = true;
                date ??= origin;
            }

            elapsed += segment.duration * 1000;
            end++;
        }

        for (const offset of offsets)
            positions.push(
                inconsistent
                    ? {}
                    : {
                          date: date === undefined ? undefined : date + offset,
                          boundary: boundary === undefined ? undefined : boundary + offset,
                      },
            );
        first = end;
    }
    return positions;
}

function alignedPositionStart(
    candidate: AdaptiveSnapshot,
    position: AdaptivePosition,
    discontinuity: number | undefined,
    count = candidate.timeline.length,
): number {
    if (
        discontinuity === undefined ||
        (position.date === undefined && position.boundary === undefined)
    )
        return -1;
    let low = 0;
    let high = count;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (playlistEntry(candidate.playlist, middle)!.discontinuitySequence! < discontinuity)
            low = middle + 1;
        else high = middle;
    }
    const first = low;
    if (
        first === count ||
        playlistEntry(candidate.playlist, first)!.discontinuitySequence !== discontinuity
    )
        return -1;
    high = count;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (playlistEntry(candidate.playlist, middle)!.discontinuitySequence! <= discontinuity)
            low = middle + 1;
        else high = middle;
    }
    const end = low;
    const other = candidate.timeline[first];
    const key = position.date !== undefined && other.date !== undefined ? 'date' : 'boundary';
    const time = position[key];
    if (time === undefined || other[key] === undefined) return -1;
    low = first;
    high = end;

    // Timeline clocks are ordered within each discontinuity run; the 1 ms tolerance can cover
    // several parents.
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (candidate.timeline[middle][key]! < time - 1) low = middle + 1;
        else high = middle;
    }
    return low < end && candidate.timeline[low][key]! <= time + 1 ? low : -1;
}

function alignedLiveIndex(
    current: AdaptiveSnapshot,
    candidate: AdaptiveSnapshot,
    index: number,
): number {
    const before = current.playlist.segments[index];
    const position = current.timeline[index];
    let matched = -1;
    const start = alignedPositionStart(
        candidate,
        position,
        before.discontinuitySequence,
        candidate.playlist.segments.length,
    );
    if (start < 0) return -1;

    for (let afterIndex = start; afterIndex < candidate.playlist.segments.length; afterIndex++) {
        const after = candidate.playlist.segments[afterIndex];
        const other = candidate.timeline[afterIndex];
        if (before.discontinuitySequence !== after.discontinuitySequence) break;
        const distance =
            position.date !== undefined && other.date !== undefined
                ? position.date - other.date
                : position.boundary !== undefined && other.boundary !== undefined
                  ? position.boundary - other.boundary
                  : undefined;
        if (distance === undefined || Math.abs(distance) > 1) break;
        if (
            matched !== -1 ||
            Math.abs(before.duration - after.duration) > 0.001 ||
            Boolean(before.gap) !== Boolean(after.gap)
        )
            return -1;
        matched = afterIndex;
    }

    if (matched < 0) return -1;
    if (
        candidate.playlist.endList &&
        candidate.playlist.segments.length - matched < current.playlist.segments.length - index
    )
        return -1;

    let beforeTime = 0;
    let afterTime = 0;
    for (
        let offset = 0;
        index + offset < current.playlist.segments.length &&
        matched + offset < candidate.playlist.segments.length;
        offset++
    ) {
        const beforeSegment = current.playlist.segments[index + offset];
        const afterSegment = candidate.playlist.segments[matched + offset];
        if (
            beforeSegment.discontinuitySequence !== afterSegment.discontinuitySequence ||
            Boolean(beforeSegment.gap) !== Boolean(afterSegment.gap)
        )
            return -1;
        const beforeDate = current.timeline[index + offset].date;
        const afterDate = candidate.timeline[matched + offset].date;
        if (
            beforeDate !== undefined &&
            afterDate !== undefined &&
            Math.abs(beforeDate - afterDate) > 1
        )
            return -1;
        beforeTime += beforeSegment.duration;
        afterTime += afterSegment.duration;
        if (Math.abs(beforeTime - afterTime) > 0.001) return -1;
    }
    return matched;
}

function alignedPartBoundary(
    current: AdaptiveSnapshot,
    candidate: AdaptiveSnapshot,
    index: number,
    offset: number,
    part: HlsPart,
    masterIndependent: boolean,
    canRefresh: boolean,
): { index: number; partIndex: number } | undefined {
    const before = playlistEntry(current.playlist, index)!;
    const position = current.timeline[index];
    let match: { index: number; partIndex: number } | undefined;
    const start = alignedPositionStart(candidate, position, before.discontinuitySequence);
    if (start < 0) return undefined;

    for (let otherIndex = start; otherIndex < candidate.timeline.length; otherIndex++) {
        const after = playlistEntry(candidate.playlist, otherIndex)!;
        const other = candidate.timeline[otherIndex];
        if (before.discontinuitySequence !== after.discontinuitySequence) break;
        const distance =
            position.date !== undefined && other.date !== undefined
                ? position.date - other.date
                : position.boundary !== undefined && other.boundary !== undefined
                  ? position.boundary - other.boundary
                  : undefined;
        if (distance === undefined || Math.abs(distance) > 1) break;

        const beforeSegment = current.playlist.segments[index];
        const afterSegment = candidate.playlist.segments[otherIndex];
        if (
            afterSegment?.gap ||
            (beforeSegment &&
                afterSegment &&
                Math.abs(beforeSegment.duration - afterSegment.duration) > 0.001)
        )
            continue;

        const parts = playlistParts(candidate.playlist, otherIndex) ?? [];
        let elapsed = 0;
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const target = parts[partIndex];
            if (
                Math.abs(elapsed - offset) <= 0.001 &&
                Math.abs(target.duration - part.duration) <= 0.001 &&
                !target.gap &&
                (target.independent === true ||
                    (partIndex === 0 &&
                        target.independent !== false &&
                        (masterIndependent || candidate.playlist.independentSegments)))
            ) {
                if (match) return undefined;
                match = { index: otherIndex, partIndex };
            }
            elapsed += target.duration;
        }
        if (afterSegment && Math.abs(elapsed - afterSegment.duration) > 0.001) return undefined;
    }

    if (!match) return undefined;
    const remaining = current.timeline.length - index;
    const requireCoverage = !canRefresh || candidate.playlist.endList;
    if (requireCoverage && candidate.timeline.length - match.index < remaining) return undefined;

    for (
        let ahead = 0;
        ahead < remaining && match.index + ahead < candidate.timeline.length;
        ahead++
    ) {
        const before = playlistEntry(current.playlist, index + ahead)!;
        const after = playlistEntry(candidate.playlist, match.index + ahead)!;
        if (before.discontinuitySequence !== after.discontinuitySequence) return undefined;

        const beforeSegment = current.playlist.segments[index + ahead];
        const afterSegment = candidate.playlist.segments[match.index + ahead];
        const afterParts = playlistParts(candidate.playlist, match.index + ahead);
        if (
            afterParts?.some(
                (item, partIndex) => item.gap && (ahead > 0 || partIndex >= match.partIndex),
            )
        )
            return undefined;
        if (
            beforeSegment &&
            afterSegment &&
            (Math.abs(beforeSegment.duration - afterSegment.duration) > 0.001 ||
                Boolean(beforeSegment.gap) !== Boolean(afterSegment.gap))
        )
            return undefined;

        const beforeDate = current.timeline[index + ahead].date;
        const afterDate = candidate.timeline[match.index + ahead].date;
        if (
            beforeDate !== undefined &&
            afterDate !== undefined &&
            Math.abs(beforeDate - afterDate) > 1
        )
            return undefined;
        if (requireCoverage || afterSegment) {
            const available =
                afterSegment?.duration ??
                (playlistParts(candidate.playlist, match.index + ahead) ?? []).reduce(
                    (sum, item) => sum + item.duration,
                    0,
                );
            const required =
                beforeSegment?.duration ??
                (playlistParts(current.playlist, index + ahead) ?? []).reduce(
                    (sum, item) => sum + item.duration,
                    0,
                );
            if (available + 0.001 < required) return undefined;
        }
    }
    return match;
}

function variantSnapshot(variant: HlsVariant): HlsVariant {
    return {
        ...variant,
        resolution: variant.resolution ? { ...variant.resolution } : undefined,
        attributes: variant.attributes ? { ...variant.attributes } : undefined,
    };
}

/** Whether the main sound of `variant` (its group's DEFAULT=YES rendition) has a playlist apart. */
function soundApart(master: HlsMasterPlaylist, variant: HlsVariant): boolean {
    const group = getHlsRenditions(master, variant, 'AUDIO');
    const main = group.find(rendition => rendition.default) ?? group[0];
    return main?.uri !== undefined && main.uri !== variant.uri;
}

/** Whether two variants' CODECS name the same kinds: a picture or none, a sound or none. */
function sameKinds(reference: HlsVariant, candidate: HlsVariant): boolean {
    return (['video', 'audio'] as const).every(
        kind =>
            (codecsType(reference.codecs, kind) === undefined) ===
            (codecsType(candidate.codecs, kind) === undefined),
    );
}

/**
 * Whether adaptive quality may switch from `reference` to `candidate`: the same codecs and
 * groups; with `follow.codecs` (a caller that changes its decoders' types) other codecs of the
 * same kinds; with `follow.master` (a caller that follows renditions) other AUDIO and SUBTITLES
 * groups, whose main sound is apart from the variant as the reference's is or is not.
 */
function compatibleVariant(
    reference: HlsVariant,
    candidate: HlsVariant,
    follow: { readonly master?: HlsMasterPlaylist; readonly codecs: boolean },
): boolean {
    const { master } = follow;
    const codecs = (value?: string): string | undefined =>
        value
            ?.split(',')
            .map(codec => codec.trim().toLowerCase())
            .sort()
            .join(',');
    return (
        !candidate.iframe &&
        Boolean(reference.codecs) &&
        (codecs(reference.codecs) === codecs(candidate.codecs) ||
            (follow.codecs && !!candidate.codecs && sameKinds(reference, candidate))) &&
        (reference.audio === candidate.audio ||
            (!!master && soundApart(master, reference) === soundApart(master, candidate))) &&
        reference.video === candidate.video &&
        (!!master || reference.subtitles === candidate.subtitles) &&
        reference.closedCaptions === candidate.closedCaptions
    );
}

function alignedVod(
    reference: HlsMediaPlaylist,
    candidate: HlsMediaPlaylist,
    masterIndependent: boolean,
): boolean {
    if (
        !candidate.endList ||
        candidate.iframeOnly ||
        candidate.skippedSegments ||
        !(masterIndependent || (reference.independentSegments && candidate.independentSegments)) ||
        reference.mediaSequence !== candidate.mediaSequence ||
        reference.discontinuitySequence !== candidate.discontinuitySequence ||
        reference.segments.length !== candidate.segments.length
    )
        return false;

    let referenceTime = 0;
    let candidateTime = 0;
    let referenceDate: number | undefined;
    let candidateDate: number | undefined;
    for (let index = 0; index < reference.segments.length; index++) {
        const before = reference.segments[index];
        const after = candidate.segments[index];
        if (
            before.sequence !== after.sequence ||
            before.discontinuitySequence !== after.discontinuitySequence ||
            Boolean(before.discontinuity) !== Boolean(after.discontinuity) ||
            Boolean(before.gap) !== Boolean(after.gap)
        )
            return false;

        if (before.programDateTime)
            referenceDate = Date.parse(before.programDateTime) - referenceTime * 1000;
        if (after.programDateTime)
            candidateDate = Date.parse(after.programDateTime) - candidateTime * 1000;
        if (
            referenceDate !== undefined &&
            candidateDate !== undefined &&
            (!Number.isFinite(referenceDate) ||
                !Number.isFinite(candidateDate) ||
                Math.abs(referenceDate - candidateDate) > 1)
        )
            return false;

        referenceTime += before.duration;
        candidateTime += after.duration;
        if (Math.abs(referenceTime - candidateTime) > 0.001) return false;
    }
    return true;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new MediaForgeError(`HLS: invalid ${label}`, 'INPUT');
    return value;
}

function timerInteger(value: number, label: string): number {
    if (positiveInteger(value, label) > 0x7fffffff)
        throw new MediaForgeError(`HLS: invalid ${label}`, 'INPUT');
    return value;
}

function segmentOptions(options: HlsSegmentOptions): HlsSegmentOptions {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('HLS: iterator options must be an object', 'INPUT');
    const result = {
        live: options.live,
        startSequence: options.startSequence,
        signal: options.signal,
        maxRefreshes: options.maxRefreshes,
        maxIdleRefreshes: options.maxIdleRefreshes,
    };

    if (result.live !== undefined && typeof result.live !== 'boolean')
        throw new MediaForgeError('HLS: live must be a boolean', 'INPUT');
    for (const name of ['startSequence', 'maxRefreshes'] as const) {
        const value = result[name];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
            throw new MediaForgeError(`HLS: ${name} must be a non-negative safe integer`, 'INPUT');
    }

    if (result.maxIdleRefreshes !== undefined)
        positiveInteger(result.maxIdleRefreshes, 'maxIdleRefreshes');
    return result;
}

function cancellableIterator<T>(
    factory: (signal: AbortSignal) => AsyncGenerator<T, void>,
): AsyncIterableIterator<T> {
    const controller = new AbortController();
    const iterator = factory(controller.signal);
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        next: () => iterator.next(),
        return: async () => {
            controller.abort();
            try {
                return await iterator.return();
            } catch (error) {
                if (error instanceof MediaForgeError && error.code === 'ABORT')
                    return { done: true, value: undefined };
                throw error;
            }
        },
        throw: async (error?: unknown) => {
            controller.abort(error);
            return iterator.throw(error);
        },
    };
}

function mapIdentity(map: HlsMap): string {
    return JSON.stringify([map.uri, map.byteRange, activeKeys(map)]);
}

function activeKeys(value: { key?: HlsKey; keys?: HlsKey[] }): HlsKey[] {
    return value.keys ?? (value.key ? [value.key] : []);
}

function sameRange(a: HlsByteRange | undefined, b: HlsByteRange | undefined): boolean {
    return a === b || (!!a && !!b && a.offset === b.offset && a.length === b.length);
}

function sameKey(a: HlsKey | undefined, b: HlsKey | undefined): boolean {
    return (
        a === b ||
        (!!a &&
            !!b &&
            a.method === b.method &&
            a.uri === b.uri &&
            a.iv === b.iv &&
            a.keyFormat === b.keyFormat &&
            a.keyFormatVersions === b.keyFormatVersions)
    );
}

function sameMap(a: HlsMap | undefined, b: HlsMap | undefined): boolean {
    return (
        a === b ||
        (!!a && !!b && a.uri === b.uri && sameRange(a.byteRange, b.byteRange) && sameKeys(a, b))
    );
}

function sameKeys(
    a: { key?: HlsKey; keys?: HlsKey[] },
    b: { key?: HlsKey; keys?: HlsKey[] },
): boolean {
    const before = activeKeys(a);
    const after = activeKeys(b);
    return (
        before.length === after.length && before.every((key, index) => sameKey(key, after[index]))
    );
}

function keyIdentity(key: HlsKey): string {
    return JSON.stringify([
        key.method,
        key.uri,
        key.keyFormat ?? 'identity',
        key.keyFormatVersions,
    ]);
}

function encryptionContext(
    context: HlsEncryptionContext,
    signal: AbortSignal,
): HlsEncryptionContext {
    return {
        ...context,
        key: { ...context.key },
        signal,
        map: context.map
            ? {
                  ...context.map,
                  byteRange: context.map.byteRange ? { ...context.map.byteRange } : undefined,
                  key: context.map.key ? { ...context.map.key } : undefined,
                  keys: context.map.keys?.map(key => ({ ...key })),
              }
            : undefined,
    };
}

function keyIv(key: HlsKey, sequence: number): Uint8Array<ArrayBuffer> {
    const iv = new Uint8Array(16);
    if (key.iv) {
        const hex = key.iv.slice(2).padStart(32, '0');
        for (let i = 0; i < 16; i++) iv[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    } else {
        let value = BigInt(sequence);
        for (let i = 15; i >= 0; i--) {
            iv[i] = Number(value & 255n);
            value >>= 8n;
        }
    }
    return iv;
}

/** Fetches HLS media; alternative rendition fetching and media decoding remain caller-owned. */
export class HlsClient {
    private readonly fetcher: typeof globalThis.fetch;
    private readonly options: HlsClientOptions;
    private readonly context: Warnings;
    private readonly controller = new AbortController();
    private readonly maxPlaylistBytes: number;
    private readonly maxSegmentBytes: number;
    private readonly encryptionHandlers: readonly HlsEncryptionHandler[];
    private readonly keyLoader: HlsKeyLoader | undefined;
    private readonly maxKeyBytes: number;
    private readonly maxCachedKeys: number;
    private readonly requestTimeoutMs: number;
    private readonly adaptiveOptions: AdaptiveQualityOptions | undefined;
    private readonly onVariantChange: HlsAdaptiveOptions['onVariantChange'];
    private readonly switchGroups: boolean = false;
    private readonly switchCodecs: boolean = false;
    private readonly playable: ((variant: HlsVariant) => boolean) | undefined;
    private adaptiveMaster: HlsMasterPlaylist | undefined;
    /** The variant chosen to start on when a multivariant playlist loaded. */
    private start: HlsVariant | undefined;
    private current: HlsPlaylist | undefined;
    private playlistUrl: string | undefined;
    private active = false;
    private loading = false;

    constructor(options: HlsClientOptions = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options))
            throw new MediaForgeError('HLS: client options must be an object', 'INPUT');
        const receiver = options;
        this.options = options = {
            fetch: options.fetch,
            signal: options.signal,
            maxPlaylistBytes: options.maxPlaylistBytes,
            maxSegmentBytes: options.maxSegmentBytes,
            maxPlaylistEntries: options.maxPlaylistEntries,
            encryptionHandlers: options.encryptionHandlers,
            keyLoader: options.keyLoader,
            maxKeyBytes: options.maxKeyBytes,
            maxCachedKeys: options.maxCachedKeys,
            refreshIntervalMs: options.refreshIntervalMs,
            requestTimeoutMs: options.requestTimeoutMs,
            validation: options.validation,
            metadataPolicy: options.metadataPolicy,
            onWarning: options.onWarning,
            maxWarnings: options.maxWarnings,
            adaptive: options.adaptive,
            playable: options.playable,
        };
        if (options.playable !== undefined && typeof options.playable !== 'function')
            throw new MediaForgeError('HLS: playable must be a function', 'INPUT');
        this.playable = options.playable?.bind(receiver);

        const fetcher = options.fetch === undefined ? globalThis.fetch : options.fetch;
        if (typeof fetcher !== 'function' && options.fetch !== undefined)
            throw new MediaForgeError('HLS: fetch must be a function', 'INPUT');
        if (typeof fetcher !== 'function')
            throw new MediaForgeError('HLS: this host has no fetch', 'FORMAT', {
                hint: 'Pass a fetch implementation.',
            });
        this.fetcher = fetcher.bind(globalThis);

        this.context = new Warnings(options, 'compatible');
        this.maxPlaylistBytes = positiveInteger(
            options.maxPlaylistBytes ?? 2 * 1024 * 1024,
            'maxPlaylistBytes',
        );
        this.maxSegmentBytes = positiveInteger(
            options.maxSegmentBytes ?? 64 * 1024 * 1024,
            'maxSegmentBytes',
        );
        this.maxKeyBytes = positiveInteger(options.maxKeyBytes ?? 65536, 'maxKeyBytes');
        this.maxCachedKeys = options.maxCachedKeys ?? 8;
        if (!Number.isSafeInteger(this.maxCachedKeys) || this.maxCachedKeys < 0)
            throw new MediaForgeError('HLS: invalid maxCachedKeys', 'INPUT');
        if (options.keyLoader !== undefined && typeof options.keyLoader !== 'function')
            throw new MediaForgeError('HLS: keyLoader must be a function', 'INPUT');
        this.keyLoader = options.keyLoader?.bind(receiver);
        if (options.encryptionHandlers !== undefined && !Array.isArray(options.encryptionHandlers))
            throw new MediaForgeError('HLS: encryptionHandlers must be an array', 'INPUT');
        this.encryptionHandlers = Array.from(options.encryptionHandlers ?? [], handler => {
            if (!handler || typeof handler !== 'object' || Array.isArray(handler))
                throw new MediaForgeError('HLS: encryption handler must be an object', 'INPUT');
            const supports = handler.supports;
            const decrypt = handler.decrypt;
            const retainsEncryption = handler.retainsEncryption;
            if (typeof supports !== 'function' || typeof decrypt !== 'function')
                throw new MediaForgeError(
                    'HLS: encryption handler requires supports and decrypt functions',
                    'INPUT',
                );
            if (retainsEncryption !== undefined && typeof retainsEncryption !== 'boolean')
                throw new MediaForgeError('HLS: retainsEncryption must be a boolean', 'INPUT');
            return {
                supports: supports.bind(handler),
                decrypt: decrypt.bind(handler),
                retainsEncryption,
            };
        });

        if (options.maxPlaylistEntries !== undefined)
            positiveInteger(options.maxPlaylistEntries, 'maxPlaylistEntries');
        this.requestTimeoutMs = timerInteger(options.requestTimeoutMs ?? 30000, 'requestTimeoutMs');
        if (options.refreshIntervalMs !== undefined)
            timerInteger(options.refreshIntervalMs, 'refreshIntervalMs');

        const adaptive = options.adaptive;
        if (adaptive !== undefined && adaptive !== false) {
            if (
                adaptive !== true &&
                (!adaptive || typeof adaptive !== 'object' || Array.isArray(adaptive))
            ) {
                throw new MediaForgeError(
                    'HLS: adaptive must be a boolean or options object',
                    'INPUT',
                );
            }
            const settings = adaptive === true ? {} : adaptive;
            this.adaptiveOptions = {
                initialBandwidth: settings.initialBandwidth,
                bandwidthSafetyFactor: settings.bandwidthSafetyFactor,
                upSwitchSegments: settings.upSwitchSegments,
            };
            new AdaptiveQualityController(this.adaptiveOptions);
            const listener = settings.onVariantChange;
            if (listener !== undefined && typeof listener !== 'function')
                throw new MediaForgeError('HLS: onVariantChange must be a function', 'INPUT');
            this.onVariantChange = listener?.bind(settings);
            const groups = settings.switchGroups;
            if (groups !== undefined && typeof groups !== 'boolean')
                throw new MediaForgeError('HLS: switchGroups must be a boolean', 'INPUT');
            this.switchGroups = groups ?? false;
            const codecs = settings.switchCodecs;
            if (codecs !== undefined && typeof codecs !== 'boolean')
                throw new MediaForgeError('HLS: switchCodecs must be a boolean', 'INPUT');
            this.switchCodecs = codecs ?? false;
        }
    }

    /**
     * The variants of `master` to choose among: those that are not I-frame playlists and that the
     * caller can play, or all of the first kind when it can play none.
     */
    private candidates(master: HlsMasterPlaylist): HlsVariant[] {
        const complete = master.variants.filter(variant => !variant.iframe).map(variantSnapshot);
        const playable = this.playable;
        if (!playable) return complete;
        return playableOf(complete, variant => {
            const result = playable(variantSnapshot(variant));
            if (typeof result !== 'boolean')
                throw new MediaForgeError('HLS: playable must return a boolean', 'INPUT');
            return result;
        });
    }

    /**
     * The variant to start on: with adaptive quality, the one of the bandwidth the controller
     * selects before any measurement (the lowest, or by initialBandwidth); otherwise the one of the
     * highest bandwidth.
     */
    private startOf(master: HlsMasterPlaylist): HlsVariant | undefined {
        const candidates = this.candidates(master);
        if (!candidates.length) return undefined;
        if (!this.adaptiveOptions) return highestOf(candidates, variant => variant.bandwidth);
        const bandwidth = new AdaptiveQualityController(this.adaptiveOptions).selectBandwidth(
            candidates.map(variant => variant.bandwidth),
        );
        return candidates.find(candidate => candidate.bandwidth === bandwidth);
    }

    /**
     * The variant of the multivariant playlist last loaded that the client starts on, chosen once
     * as it loads: with adaptive quality the first one its segments come from (each unit names the
     * variant it comes from after a switch), otherwise the one to load and play, of the highest
     * bandwidth. It stays while the playlist loaded is that variant's; undefined otherwise.
     */
    get variant(): HlsVariant | undefined {
        return this.start && variantSnapshot(this.start);
    }

    get playlist(): HlsPlaylist | undefined {
        return this.current;
    }
    get diagnostics(): readonly MediaDiagnostic[] {
        return this.context.warnings;
    }

    async load(url: string, options: { signal?: AbortSignal } = {}): Promise<HlsPlaylist> {
        if (this.active || this.loading)
            throw new MediaForgeError('HLS: another playlist operation is active', 'INPUT');
        const linked = linkAbortSignals(
            this.controller.signal,
            this.options.signal,
            options.signal,
        );

        this.loading = true;
        try {
            const requested = networkUri(url);
            const result = await this.readPlaylist(requested, linked.signal);
            throwIfAborted(linked.signal);
            const master = result.playlist.type === 'master' ? result.playlist : undefined;
            // The start is chosen once, with its playlist; loading that variant keeps it.
            const start = master
                ? this.startOf(master)
                : this.start && [requested, result.url].includes(this.start.uri)
                  ? this.start
                  : undefined;
            this.current = result.playlist;
            this.playlistUrl = result.url;
            this.adaptiveMaster = master;
            this.start = start;
            return result.playlist;
        } finally {
            linked.dispose();
            this.loading = false;
        }
    }

    async refresh(options: { signal?: AbortSignal } = {}): Promise<HlsPlaylist> {
        if (!this.playlistUrl)
            throw new MediaForgeError('HLS: load a playlist before refreshing', 'INPUT');
        if (this.active || this.loading)
            throw new MediaForgeError('HLS: another playlist operation is active', 'INPUT');

        const linked = linkAbortSignals(
            this.controller.signal,
            this.options.signal,
            options.signal,
        );
        this.loading = true;
        try {
            const result = await this.readPlaylist(
                this.playlistUrl,
                linked.signal,
                this.current?.type === 'media' ? this.current : undefined,
            );
            throwIfAborted(linked.signal);
            if (this.current?.type === 'media') {
                if (result.playlist.type !== 'media')
                    throw new MediaForgeError('HLS: a refresh changed the playlist type', 'DEMUX');
                this.validateRefresh(this.current, result.playlist);
            }
            this.current = result.playlist;
            this.playlistUrl = result.url;
            if (result.playlist.type === 'master') this.adaptiveMaster = result.playlist;
            return result.playlist;
        } finally {
            linked.dispose();
            this.loading = false;
        }
    }

    close(reason?: unknown): void {
        this.controller.abort(reason);
    }

    segments(options: HlsSegmentOptions = {}): AsyncIterableIterator<HlsSegmentData> {
        const settings = segmentOptions(options);
        if (this.adaptiveOptions && settings.live) settings.maxIdleRefreshes ??= 10;
        return cancellableIterator(signal => this.readSegments(settings, signal));
    }

    /** Polls published PARTs; complete segments are fallback units, never duplicates.
     * Identity AES-128 PARTs (including byte ranges) must be independently CBC/PKCS7 encrypted. */
    parts(options: HlsPartOptions = {}): AsyncIterableIterator<HlsPartData> {
        const settings = segmentOptions(options);
        settings.maxIdleRefreshes ??= 10;
        return cancellableIterator(signal => this.readMedia(settings, signal, true));
    }

    private async *readSegments(
        options: HlsSegmentOptions,
        iteratorSignal: AbortSignal,
    ): AsyncGenerator<HlsSegmentData, void> {
        for await (const unit of this.readMedia(options, iteratorSignal, false)) {
            if (unit.type === 'segment')
                yield {
                    segment: unit.segment,
                    data: unit.data,
                    initData: unit.initData,
                    variant: unit.variant,
                    encryption: unit.encryption,
                };
        }
    }

    private async *readMedia(
        options: HlsSegmentOptions,
        iteratorSignal: AbortSignal,
        useParts: boolean,
    ): AsyncGenerator<HlsPartData, void> {
        if (this.active || this.loading)
            throw new MediaForgeError('HLS: another playlist operation is active', 'INPUT');
        if (this.adaptiveOptions && !this.adaptiveMaster)
            throw new MediaForgeError(
                'HLS: adaptive mode requires loading a master playlist',
                'INPUT',
            );
        if (
            !this.current ||
            !this.playlistUrl ||
            (this.current.type !== 'media' && !this.adaptiveOptions)
        ) {
            throw new MediaForgeError('HLS: no media playlist is loaded', 'INPUT', {
                hint: 'Load a media playlist, or select a variant or rendition.',
            });
        }

        const linked = linkAbortSignals(
            this.controller.signal,
            this.options.signal,
            options.signal,
            iteratorSignal,
        );
        this.active = true;
        let adaptive: AdaptiveSession | undefined;
        let playlist: HlsMediaPlaylist;
        let sequence: number;
        let partIndex = 0;
        let partDuration = 0;
        let refreshes = 0;
        let idleRefreshes = 0;
        let progress = 0;
        let lastMap: string | undefined;
        let lastMapEncryption: HlsKey | undefined;
        let lastDiscontinuity: number | undefined;

        const keys = new Map<string, Uint8Array>();
        const importedKeys = new Map<string, CryptoKey>();
        const pendingKeys = new Map<string, Promise<Uint8Array>>();
        let acceptingKeys = true;

        const loadKey = async (context: HlsEncryptionContext): Promise<Uint8Array> => {
            throwIfAborted(context.signal);
            if (!acceptingKeys) throw new MediaForgeError('Aborted', 'ABORT');
            const identity = keyIdentity(context.key);
            const cached = keys.get(identity);
            if (cached) {
                keys.delete(identity);
                keys.set(identity, cached);
                return new Uint8Array(cached);
            }

            let pending = pendingKeys.get(identity);
            if (!pending) {
                pending = this.runEncryptionOperation(signal => {
                    const snapshot = (bytes: Uint8Array): Uint8Array => {
                        throwIfAborted(signal);
                        checkedChunkLength(bytes, this.maxKeyBytes);
                        return new Uint8Array(bytes);
                    };
                    if (this.keyLoader) {
                        const result = this.keyLoader(encryptionContext(context, signal));
                        return ArrayBuffer.isView(result)
                            ? snapshot(result as Uint8Array)
                            : Promise.resolve(result).then(snapshot);
                    }
                    return this.readResource(
                        networkUri(context.key.uri!),
                        this.maxKeyBytes,
                        signal,
                    ).then(result => snapshot(result.bytes));
                }, context.signal).then(bytes => {
                    throwIfAborted(context.signal);
                    if (!acceptingKeys) throw new MediaForgeError('Aborted', 'ABORT');
                    if (this.maxCachedKeys) {
                        keys.set(identity, bytes);
                        if (keys.size > this.maxCachedKeys) {
                            const oldest = keys.keys().next().value!;
                            keys.delete(oldest);
                            importedKeys.delete(oldest);
                        }
                    }
                    return bytes;
                });
                pendingKeys.set(identity, pending);
                void pending
                    .finally(() => {
                        if (pendingKeys.get(identity) === pending) pendingKeys.delete(identity);
                    })
                    .catch(() => undefined);
            }

            const bytes = await awaitWithAbort(pending, context.signal);
            throwIfAborted(context.signal);
            return new Uint8Array(bytes);
        };

        const selectEncryption = async (
            value: { key?: HlsKey; keys?: HlsKey[] },
            context: Omit<HlsEncryptionContext, 'key'>,
        ): Promise<SelectedEncryption | undefined> => {
            const alternatives = activeKeys(value);
            for (const handler of this.encryptionHandlers) {
                for (const key of alternatives) {
                    const candidate = { ...context, key: { ...key } };
                    const supported = await this.runEncryptionOperation(signal => {
                        const result = handler.supports(encryptionContext(candidate, signal));
                        if (typeof result !== 'boolean')
                            throw new MediaForgeError(
                                'HLS: supports must return a boolean',
                                'INPUT',
                            );
                        return result;
                    }, linked.signal);
                    if (supported) return { context: candidate, handler };
                }
            }

            if (!alternatives.length) return undefined;
            const key =
                alternatives.find(key => this.isBuiltinEncryption(key, playlist.iframeOnly)) ??
                alternatives[alternatives.length - 1];
            this.checkEncryption(key, playlist.iframeOnly);
            return { context: { ...context, key: { ...key } } };
        };

        const decrypt = async (
            bytes: Uint8Array,
            selected: SelectedEncryption | undefined,
        ): Promise<Uint8Array> => {
            if (!selected) return bytes;
            return this.runEncryptionOperation(async signal => {
                const context = encryptionContext(selected.context, signal);
                let result: Uint8Array;
                if (selected.handler) {
                    result = await selected.handler.decrypt({
                        ...context,
                        data: bytes,
                        loadKey: () => loadKey(encryptionContext(selected.context, signal)),
                    });
                } else {
                    const raw = await loadKey(context);
                    if (raw.length !== 16)
                        throw new MediaForgeError(
                            'HLS: AES-128 keys must contain exactly 16 bytes',
                            'DEMUX',
                        );

                    const identity = keyIdentity(context.key);
                    let imported = importedKeys.get(identity);
                    if (!imported) {
                        imported = await awaitWithAbort(
                            globalThis.crypto.subtle.importKey(
                                'raw',
                                raw as Uint8Array<ArrayBuffer>,
                                'AES-CBC',
                                false,
                                ['decrypt'],
                            ),
                            signal,
                        );
                        throwIfAborted(signal);
                        if (this.maxCachedKeys) importedKeys.set(identity, imported);
                    }

                    try {
                        const plaintext = await awaitWithAbort(
                            globalThis.crypto.subtle.decrypt(
                                { name: 'AES-CBC', iv: keyIv(context.key, context.sequence) },
                                imported,
                                bytes as Uint8Array<ArrayBuffer>,
                            ),
                            signal,
                        );
                        result = new Uint8Array(plaintext);
                    } catch (error) {
                        throwIfAborted(signal);
                        throw new MediaForgeError(
                            `HLS: AES-128 decryption ` +
                                `failed${error instanceof Error ? `: ${error.message}` : ''}`,
                            'DECODE',
                        );
                    }
                }
                throwIfAborted(signal);
                checkedChunkLength(result, this.maxSegmentBytes);
                return result;
            }, linked.signal);
        };

        const readUnit = async (
            unit: HlsSegment | HlsPart,
            number: number,
            discontinuity: number,
            switching = false,
        ): Promise<DownloadedUnit> => {
            const selected = await selectEncryption(unit, {
                kind: 'partIndex' in unit ? 'part' : 'segment',
                sequence: number,
                partIndex: 'partIndex' in unit ? unit.partIndex : undefined,
                uri: unit.uri,
                map: unit.map,
                signal: linked.signal,
            });

            let initData: Uint8Array | undefined;
            const identity = unit.map ? mapIdentity(unit.map) : undefined;
            let mapEncryption =
                identity === lastMap && discontinuity === lastDiscontinuity && !switching
                    ? lastMapEncryption
                    : undefined;
            const mediaEncryption = selected?.handler?.retainsEncryption
                ? { ...selected.context.key }
                : undefined;
            const checkMapEncryption = (): void => {
                if (
                    mapEncryption &&
                    mediaEncryption &&
                    (mapEncryption.method !== mediaEncryption.method ||
                        (mapEncryption.keyFormat ?? 'identity') !==
                            (mediaEncryption.keyFormat ?? 'identity'))
                ) {
                    throw new MediaForgeError(
                        'HLS: the init map and media use different encryption',
                        'FORMAT',
                    );
                }
            };

            if (unit.map) {
                if (switching || identity !== lastMap || discontinuity !== lastDiscontinuity) {
                    const mapSelected = await selectEncryption(unit.map, {
                        kind: 'map',
                        sequence: number,
                        uri: unit.map.uri,
                        map: unit.map,
                        signal: linked.signal,
                    });
                    if (mapSelected?.handler?.retainsEncryption)
                        mapEncryption = { ...mapSelected.context.key };
                    checkMapEncryption();
                    const result = await this.readResource(
                        networkUri(unit.map.uri),
                        this.maxSegmentBytes,
                        linked.signal,
                        unit.map.byteRange,
                    );
                    initData = await decrypt(result.bytes, mapSelected);
                }
            }

            checkMapEncryption();
            const started = monotonicNow();
            const result = await this.readResource(
                networkUri(unit.uri),
                this.maxSegmentBytes,
                linked.signal,
                unit.byteRange,
            );
            const elapsedMs = Math.max(0, monotonicNow() - started);
            const data = await decrypt(result.bytes, selected);
            throwIfAborted(linked.signal);

            const encryption = mediaEncryption ?? (initData ? mapEncryption : undefined);
            return {
                data,
                initData,
                encryption,
                mapEncryption,
                map: identity,
                discontinuity,
                byteLength: result.bytes.byteLength,
                elapsedMs,
            };
        };

        const commitUnit = (
            unit: DownloadedUnit,
        ): { data: Uint8Array; initData?: Uint8Array; encryption?: HlsKey } => {
            lastMap = unit.map;
            lastMapEncryption = unit.mapEncryption;
            lastDiscontinuity = unit.discontinuity;
            if (adaptive) adaptive.controller.addSample(unit.byteLength, unit.elapsedMs);
            return { data: unit.data, initData: unit.initData, encryption: unit.encryption };
        };

        const preparePart = useParts
            ? (part: HlsPart) => readUnit(part, part.sequence!, part.discontinuitySequence!, true)
            : undefined;

        const notifyInitial = async (sequence: number, partIndex?: number): Promise<void> => {
            if (!adaptive || adaptive.initialNotified) return;
            await this.notifyVariant(
                {
                    variant: variantSnapshot(adaptive.variant),
                    sequence,
                    partIndex,
                    bandwidthEstimate: adaptive.controller.bandwidthEstimate,
                    reason: 'initial',
                },
                linked.signal,
            );
            adaptive.initialNotified = true;
        };

        try {
            if (this.adaptiveOptions) {
                adaptive = await this.prepareAdaptive(options, linked.signal, useParts);
                playlist = adaptive.current.playlist;
            } else playlist = this.current as HlsMediaPlaylist;
            sequence = options.startSequence ?? playlist.mediaSequence;
            while (true) {
                throwIfAborted(linked.signal);
                const beforeProgress = progress;
                if (sequence < playlist.mediaSequence) {
                    this.context.recover({
                        code: 'HLS_LIVE_WINDOW',
                        message: `Live playlist skipped ahead past segment ${sequence}`,
                        format: 'hls',
                    });
                    throwIfAborted(linked.signal);
                    sequence = playlist.mediaSequence;
                    partIndex = 0;
                    partDuration = 0;
                }

                while (true) {
                    let index = sequence - playlist.mediaSequence;
                    let segment = playlist.segments[index];
                    let parts = useParts ? playlistParts(playlist, index) : undefined;
                    let part = parts?.[partIndex];
                    let downloaded: DownloadedUnit | undefined;
                    if (!segment && !part) break;
                    throwIfAborted(linked.signal);

                    if (adaptive && (part || !partIndex)) {
                        const updated = await this.selectAdaptive(
                            adaptive,
                            playlist,
                            index,
                            linked.signal,
                            part
                                ? {
                                      part,
                                      offset: partDuration,
                                      canRefresh:
                                          options.live === true &&
                                          (options.maxRefreshes === undefined ||
                                              refreshes < options.maxRefreshes),
                                  }
                                : undefined,
                            preparePart,
                        );
                        throwIfAborted(linked.signal);
                        if (updated) {
                            playlist = updated.playlist;
                            index = updated.index;
                            sequence = playlist.mediaSequence + index;
                            partIndex = updated.partIndex ?? 0;
                            parts = useParts ? playlistParts(playlist, index) : undefined;
                            part = parts?.[partIndex];
                            partDuration =
                                parts
                                    ?.slice(0, partIndex)
                                    .reduce((sum, item) => sum + item.duration, 0) ?? 0;
                            segment = playlist.segments[index];
                            downloaded = updated.downloaded;
                            this.current = playlist;
                            this.playlistUrl = updated.url;
                            lastMap = undefined;
                        }
                    }

                    if (part && !segment?.gap) {
                        if (
                            part.sequence !== sequence ||
                            part.partIndex !== partIndex ||
                            part.discontinuitySequence === undefined
                        ) {
                            throw new MediaForgeError('HLS: inconsistent PART context', 'DEMUX');
                        }
                        if (segment && partDuration + part.duration > segment.duration + 0.001) {
                            throw new MediaForgeError(
                                'HLS: PART durations exceed their parent segment',
                                'DEMUX',
                            );
                        }

                        const index = partIndex++;
                        partDuration += part.duration;
                        progress++;
                        if (part.gap) {
                            this.context.recover({
                                code: 'HLS_GAP',
                                message: `Skipped unavailable part ${sequence}:${index}`,
                                format: 'hls',
                            });
                        } else {
                            await notifyInitial(sequence, index);
                            const data = commitUnit(
                                downloaded ??
                                    (await readUnit(part, sequence, part.discontinuitySequence)),
                            );
                            yield {
                                type: 'part',
                                part,
                                sequence,
                                partIndex: index,
                                discontinuitySequence: part.discontinuitySequence,
                                ...data,
                                variant: adaptive ? variantSnapshot(adaptive.variant) : undefined,
                            };
                        }
                        throwIfAborted(linked.signal);
                        continue;
                    }

                    if (!segment) break;
                    if (segment.gap) {
                        this.context.recover({
                            code: 'HLS_GAP',
                            message: `Skipped unavailable segment ${segment.sequence}`,
                            format: 'hls',
                        });
                        throwIfAborted(linked.signal);
                    } else if (useParts && partIndex) {
                        if (partDuration + 0.001 < segment.duration) {
                            this.context.recover({
                                code: 'HLS_PART_WINDOW',
                                message: `The remaining parts of segment ${sequence} are gone`,
                                format: 'hls',
                            });
                            throwIfAborted(linked.signal);
                        }
                    } else {
                        await notifyInitial(segment.sequence);
                        const data = commitUnit(
                            await readUnit(
                                segment,
                                segment.sequence,
                                segment.discontinuitySequence,
                            ),
                        );
                        yield {
                            type: 'segment',
                            segment,
                            ...data,
                            variant: adaptive ? variantSnapshot(adaptive.variant) : undefined,
                        };
                    }

                    throwIfAborted(linked.signal);
                    sequence = segment.sequence + 1;
                    progress++;
                    if (!Number.isSafeInteger(sequence))
                        throw new MediaForgeError(
                            'HLS: segment sequence exhausted safe integer precision',
                            'FORMAT',
                        );
                    partIndex = 0;
                    partDuration = 0;
                }

                if (!options.live || playlist.endList) return;
                if (refreshes) idleRefreshes = progress !== beforeProgress ? 0 : idleRefreshes + 1;
                if (options.maxRefreshes !== undefined && refreshes >= options.maxRefreshes) return;
                if (
                    options.maxIdleRefreshes !== undefined &&
                    idleRefreshes >= options.maxIdleRefreshes
                )
                    throw ioError('HLS: live playlist did not advance within maxIdleRefreshes');

                const interval =
                    this.options.refreshIntervalMs ??
                    (useParts
                        ? (playlist.partTarget ?? playlist.targetDuration)
                        : playlist.targetDuration) * 1000;
                await delay(Math.max(1, Math.min(interval, 0x7fffffff)), linked.signal);

                const previous = playlist;
                const updated = await this.readPlaylist(this.playlistUrl!, linked.signal, previous);
                throwIfAborted(linked.signal);
                if (updated.playlist.type !== 'media')
                    throw new MediaForgeError(
                        'HLS: a live refresh changed the playlist type',
                        'DEMUX',
                    );
                playlist = updated.playlist;
                this.validateRefresh(previous, playlist);
                if (adaptive) {
                    adaptive.current = {
                        playlist,
                        url: updated.url,
                        loadedAt: monotonicNow(),
                        timeline: adaptiveTimeline(playlist, adaptive.current),
                    };
                    adaptive.generation++;
                }

                this.current = playlist;
                this.playlistUrl = updated.url;
                refreshes++;
            }
        } finally {
            acceptingKeys = false;
            keys.clear();
            importedKeys.clear();
            pendingKeys.clear();
            linked.dispose();
            this.active = false;
        }
    }

    private async notifyVariant(event: HlsVariantChange, signal: AbortSignal): Promise<void> {
        throwIfAborted(signal);
        if (this.onVariantChange)
            await awaitWithAbort(Promise.resolve(this.onVariantChange(event)), signal);
        throwIfAborted(signal);
    }

    private async prepareAdaptive(
        options: HlsSegmentOptions,
        signal: AbortSignal,
        useParts: boolean,
    ): Promise<AdaptiveSession> {
        const master = this.adaptiveMaster!;
        const candidates = this.candidates(master);
        if (!candidates.length)
            throw new MediaForgeError('HLS: no complete-segment variants are available', 'FORMAT');

        // The variant chosen when the playlist loaded, which the caller read as the start.
        const controller = new AdaptiveQualityController(this.adaptiveOptions);
        this.start ??= this.startOf(master);
        const variant =
            candidates.find(candidate => candidate.uri === this.start!.uri) ?? candidates[0]!;
        const result = await this.readPlaylist(networkUri(variant.uri), signal);
        throwIfAborted(signal);
        if (result.playlist.type !== 'media' || result.playlist.iframeOnly) {
            throw new MediaForgeError(
                'HLS: adaptive mode requires non-I-frame media playlists',
                'FORMAT',
            );
        }

        const reference = result.playlist;
        const sequence = Math.max(
            options.startSequence ?? reference.mediaSequence,
            reference.mediaSequence,
        );
        if (!useParts)
            await this.notifyVariant(
                {
                    variant: variantSnapshot(variant),
                    sequence,
                    bandwidthEstimate: controller.bandwidthEstimate,
                    reason: 'initial',
                },
                signal,
            );

        this.current = reference;
        this.playlistUrl = result.url;
        return {
            controller,
            variant,
            variants: candidates.filter(
                candidate =>
                    candidate === variant ||
                    compatibleVariant(variant, candidate, {
                        ...(this.switchGroups ? { master } : {}),
                        codecs: this.switchCodecs,
                    }),
            ),
            current: {
                playlist: reference,
                url: result.url,
                loadedAt: monotonicNow(),
                timeline: adaptiveTimeline(reference),
            },
            generation: 0,
            completeTimeline: reference.endList,
            masterIndependent: master.independentSegments === true,
            initialNotified: !useParts,
        };
    }

    private async selectAdaptive(
        session: AdaptiveSession,
        current: HlsMediaPlaylist,
        index: number,
        signal: AbortSignal,
        partBoundary?: { part: HlsPart; offset: number; canRefresh: boolean },
        preparePart?: (part: HlsPart) => Promise<DownloadedUnit>,
    ): Promise<
        | {
              playlist: HlsMediaPlaylist;
              url: string;
              index: number;
              partIndex?: number;
              downloaded?: DownloadedUnit;
          }
        | undefined
    > {
        if (!session.initialNotified) return undefined;
        const bandwidth = session.controller.selectBandwidth(
            session.variants.map(variant => variant.bandwidth),
            session.variant.bandwidth,
        );
        if (bandwidth === session.variant.bandwidth) return undefined;
        const candidate = session.variants.find(variant => variant.bandwidth === bandwidth)!;

        let alternate = session.alternate;
        const now = monotonicNow();
        const interval =
            this.options.refreshIntervalMs ??
            (partBoundary
                ? (current.partTarget ?? current.targetDuration)
                : current.targetDuration) * 1000;

        if (
            !alternate ||
            alternate.variant !== candidate ||
            (!alternate.snapshot?.playlist.endList &&
                (alternate.generation !== session.generation ||
                    now - alternate.checkedAt >= interval))
        ) {
            const old = alternate?.variant === candidate ? alternate.snapshot : undefined;
            alternate = { variant: candidate, checkedAt: now, generation: session.generation };
            session.alternate = alternate;
            const warnings: MediaDiagnostic[] = [];
            try {
                const result = await this.readPlaylist(
                    old?.url ?? networkUri(candidate.uri),
                    signal,
                    old?.playlist,
                    warning => warnings.push(warning),
                );
                throwIfAborted(signal);
                if (result.playlist.type === 'media') {
                    if (old) this.validateRefresh(old.playlist, result.playlist);
                    alternate.snapshot = {
                        playlist: result.playlist,
                        url: result.url,
                        loadedAt: monotonicNow(),
                        timeline: adaptiveTimeline(result.playlist, old),
                    };
                }
            } catch {
                throwIfAborted(signal);
                this.context.warn({
                    code: 'HLS_ADAPTIVE_UNAVAILABLE',
                    message: `Variant ${candidate.uri} could not be refreshed`,
                    format: 'hls',
                });
                throwIfAborted(signal);
                alternate.warned = true;
                return undefined;
            }

            for (const warning of warnings) {
                this.context.warn(warning);
                throwIfAborted(signal);
            }
        }

        const snapshot = alternate.snapshot;
        let candidateIndex = -1;
        let candidatePartIndex: number | undefined;
        if (
            partBoundary &&
            snapshot &&
            !snapshot.playlist.iframeOnly &&
            current.targetDuration === snapshot.playlist.targetDuration
        ) {
            const match = alignedPartBoundary(
                session.current,
                snapshot,
                index,
                partBoundary.offset,
                partBoundary.part,
                session.masterIndependent,
                partBoundary.canRefresh,
            );
            candidateIndex = match?.index ?? -1;
            candidatePartIndex = match?.partIndex;
        } else if (
            !partBoundary &&
            snapshot &&
            !snapshot.playlist.iframeOnly &&
            current.targetDuration === snapshot.playlist.targetDuration &&
            (session.masterIndependent ||
                (current.independentSegments && snapshot.playlist.independentSegments))
        ) {
            if (session.completeTimeline) {
                if (alignedVod(current, snapshot.playlist, session.masterIndependent))
                    candidateIndex = index;
            } else candidateIndex = alignedLiveIndex(session.current, snapshot, index);
        }

        if (preparePart && snapshot && candidateIndex >= 0 && candidatePartIndex === undefined) {
            const parts = playlistParts(snapshot.playlist, candidateIndex);
            const first = parts?.[0];
            if (first) {
                const independent =
                    first.independent === true ||
                    (first.independent !== false &&
                        (session.masterIndependent || snapshot.playlist.independentSegments));
                const duration = parts!.reduce((sum, item) => sum + item.duration, 0);
                if (
                    !independent ||
                    first.gap ||
                    Math.abs(duration - snapshot.playlist.segments[candidateIndex].duration) > 0.001
                )
                    candidateIndex = -1;
                else candidatePartIndex = 0;
            }
        }

        if (!snapshot || candidateIndex < 0) {
            if (!alternate.warned)
                this.context.warn({
                    code: 'HLS_ADAPTIVE_ALIGNMENT',
                    message: `Variant ${candidate.uri} has no aligned switch point`,
                    format: 'hls',
                });
            alternate.warned = true;
            throwIfAborted(signal);
            return undefined;
        }

        let downloaded: DownloadedUnit | undefined;
        if (preparePart && candidatePartIndex !== undefined) {
            try {
                downloaded = await preparePart(
                    playlistParts(snapshot.playlist, candidateIndex)![candidatePartIndex],
                );
                throwIfAborted(signal);
            } catch {
                throwIfAborted(signal);
                this.context.warn({
                    code: 'HLS_ADAPTIVE_UNAVAILABLE',
                    message: `A part of variant ${candidate.uri} could not be loaded`,
                    format: 'hls',
                });
                throwIfAborted(signal);
                return undefined;
            }
        }

        const previous = session.variant;
        await this.notifyVariant(
            {
                previous: variantSnapshot(previous),
                variant: variantSnapshot(candidate),
                sequence: snapshot.playlist.mediaSequence + candidateIndex,
                partIndex: candidatePartIndex,
                bandwidthEstimate: session.controller.bandwidthEstimate,
                reason: bandwidth > previous.bandwidth ? 'up' : 'down',
            },
            signal,
        );

        session.alternate = {
            variant: previous,
            snapshot: session.current,
            checkedAt: session.current.loadedAt,
            generation: session.generation,
        };
        session.variant = candidate;
        session.current = snapshot;
        return {
            playlist: snapshot.playlist,
            url: snapshot.url,
            index: candidateIndex,
            partIndex: candidatePartIndex,
            downloaded,
        };
    }

    private async runEncryptionOperation<T>(
        operation: (signal: AbortSignal) => T | PromiseLike<T>,
        signal: AbortSignal,
    ): Promise<T> {
        throwIfAborted(signal);
        const timeout = new AbortController();
        const linked = linkAbortSignals(signal, timeout.signal);
        const started = monotonicNow();
        const deadline = ioError('HLS: encryption operation exceeded requestTimeoutMs');

        const check = (): void => {
            throwIfAborted(signal);
            if (timeout.signal.aborted || monotonicNow() - started >= this.requestTimeoutMs)
                throw deadline;
        };

        let onAbort = (): void => undefined;
        const stopped = new Promise<never>((_resolve, reject) => {
            onAbort = (): void =>
                reject(signal.aborted ? new MediaForgeError('Aborted', 'ABORT') : deadline);
            linked.signal.addEventListener('abort', onAbort, { once: true });
        });

        const timer = setTimeout(() => timeout.abort(), this.requestTimeoutMs);
        try {
            const result = await Promise.race([
                Promise.resolve().then(() => {
                    check();
                    return operation(linked.signal);
                }),
                stopped,
            ]);
            check();
            return result;
        } finally {
            clearTimeout(timer);
            linked.signal.removeEventListener('abort', onAbort);
            timeout.abort();
            linked.dispose();
        }
    }

    private isBuiltinEncryption(key: HlsKey, iframeOnly?: boolean): boolean {
        return (
            key.method === 'AES-128' &&
            (!key.keyFormat || key.keyFormat === 'identity') &&
            (!key.keyFormatVersions || key.keyFormatVersions.split('/').includes('1')) &&
            !iframeOnly
        );
    }

    private checkEncryption(key: HlsKey, iframeOnly?: boolean): void {
        if (!this.isBuiltinEncryption(key, iframeOnly)) {
            throw new MediaForgeError(
                `HLS: unsupported encryption ${key.method}` +
                    (key.keyFormat ? ` (${key.keyFormat})` : '') +
                    (iframeOnly ? ' in an I-frame playlist' : ''),
                'FORMAT',
            );
        }
        if (!globalThis.crypto?.subtle)
            throw new MediaForgeError('HLS: AES-128 requires WebCrypto SubtleCrypto', 'FORMAT');
    }

    private validateRefresh(previous: HlsMediaPlaylist, next: HlsMediaPlaylist): void {
        if (
            next.mediaSequence < previous.mediaSequence ||
            next.discontinuitySequence < previous.discontinuitySequence
        ) {
            throw new MediaForgeError('HLS: live playlist sequence moved backwards', 'DEMUX');
        }

        if (next.targetDuration !== previous.targetDuration)
            throw new MediaForgeError('HLS: live TARGETDURATION changed', 'DEMUX');
        if (
            previous.partTarget !== undefined &&
            next.partTarget !== undefined &&
            previous.partTarget !== next.partTarget
        )
            throw new MediaForgeError('HLS: live PART-TARGET changed', 'DEMUX');
        if (previous.endList && !next.endList)
            throw new MediaForgeError('HLS: refresh removed ENDLIST', 'DEMUX');

        const previousEnd = previous.mediaSequence + previous.segments.length;
        const nextEnd = next.mediaSequence + next.segments.length;
        if (nextEnd < previousEnd)
            throw new MediaForgeError('HLS: live playlist end moved backwards', 'DEMUX');
        for (const segment of next.segments) {
            const old = previous.segments[segment.sequence - previous.mediaSequence];
            if (old === segment) continue;
            if (
                old &&
                (old.uri !== segment.uri ||
                    old.duration !== segment.duration ||
                    old.gap !== segment.gap ||
                    old.discontinuitySequence !== segment.discontinuitySequence ||
                    !sameRange(old.byteRange, segment.byteRange) ||
                    !sameKeys(old, segment) ||
                    !sameMap(old.map, segment.map))
            ) {
                throw new MediaForgeError('HLS: live refresh changed an existing segment', 'DEMUX');
            }
        }

        for (let group = 0; group <= previous.segments.length; group++) {
            const sequence = previous.mediaSequence + group;
            if (sequence < next.mediaSequence) continue;
            const parts = playlistParts(previous, group);
            if (!parts?.length) continue;
            const updated = playlistParts(next, sequence - next.mediaSequence);
            if (updated === parts) continue;
            if (!updated?.length && sequence < nextEnd) continue;
            if (!updated || updated.length < parts.length)
                throw new MediaForgeError('HLS: live refresh removed published PARTs', 'DEMUX');
            for (let index = 0; index < parts.length; index++) {
                const old = parts[index];
                const part = updated[index];
                if (
                    old.uri !== part.uri ||
                    old.duration !== part.duration ||
                    old.gap !== part.gap ||
                    old.independent !== part.independent ||
                    old.discontinuitySequence !== part.discontinuitySequence ||
                    !sameRange(old.byteRange, part.byteRange) ||
                    !sameKeys(old, part) ||
                    !sameMap(old.map, part.map)
                ) {
                    throw new MediaForgeError(
                        'HLS: live refresh changed an existing PART',
                        'DEMUX',
                    );
                }
            }
        }

        if (previous.trailingParts?.length) {
            const completed = next.segments[previousEnd - next.mediaSequence];
            const part = previous.trailingParts[0];
            if (
                completed &&
                (completed.discontinuitySequence !== part.discontinuitySequence ||
                    !sameKeys(completed, part) ||
                    !sameMap(completed.map, part.map))
            ) {
                throw new MediaForgeError(
                    'HLS: completed segment changed its PART context',
                    'DEMUX',
                );
            }
        }
    }

    private async readPlaylist(
        url: string,
        signal: AbortSignal,
        previousPlaylist?: HlsMediaPlaylist,
        onWarning: (diagnostic: MediaDiagnostic) => void = diagnostic =>
            this.context.warn(diagnostic),
    ): Promise<{ playlist: HlsPlaylist; url: string }> {
        const result = await this.readResource(url, this.maxPlaylistBytes, signal);
        let text: string;
        try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.bytes);
        } catch {
            throw new MediaForgeError('HLS: playlist is not valid UTF-8', 'DEMUX');
        }

        const playlist = parseHlsPlaylist(text, {
            ...this.options,
            baseUrl: result.url,
            previousPlaylist,
            onWarning,
        });

        throwIfAborted(signal);
        if (playlist.type === 'media' && playlist.skippedSegments)
            throw new MediaForgeError(
                'HLS: delta reconstruction requires previous playlist history',
                'DEMUX',
            );
        return { playlist, url: result.url };
    }

    private readResource(
        url: string,
        limit: number,
        signal: AbortSignal,
        range?: HlsByteRange,
    ): Promise<{ bytes: Uint8Array; url: string }> {
        const timeoutMs = this.requestTimeoutMs;
        return fetchResource({ fetcher: this.fetcher, url, limit, signal, range, timeoutMs });
    }
}
