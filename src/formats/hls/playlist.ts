import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import { positiveLimit } from '../../core/errors/limits';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import type { DiagnosticOptions, MediaDiagnostic } from '../../core/errors/diagnostics';

const MAX_ACTIVE_KEY_FORMATS = 64;

export interface HlsByteRange {
    length: number;
    offset: number;
}

export interface HlsKey {
    method: string;
    uri?: string;
    iv?: string;
    keyFormat?: string;
    keyFormatVersions?: string;
}

export interface HlsMap {
    uri: string;
    byteRange?: HlsByteRange;
    key?: HlsKey;
    /**
     * Up to 64 active KEYFORMAT alternatives in declaration order; key is the last declared
     * alternative.
     */
    keys?: HlsKey[];
}

export interface HlsPart {
    uri: string;
    duration: number;
    independent?: boolean;
    gap?: boolean;
    byteRange?: HlsByteRange;
    /** Populated by the parser; numbering is local to the parent media sequence. */
    sequence?: number;
    partIndex?: number;
    discontinuitySequence?: number;
    discontinuity?: boolean;
    map?: HlsMap;
    key?: HlsKey;
    keys?: HlsKey[];
    programDateTime?: string;
}

export interface HlsSegment {
    uri: string;
    duration: number;
    title?: string;
    sequence: number;
    discontinuitySequence: number;
    discontinuity?: boolean;
    byteRange?: HlsByteRange;
    map?: HlsMap;
    key?: HlsKey;
    keys?: HlsKey[];
    programDateTime?: string;
    gap?: boolean;
    parts?: HlsPart[];
}

export type HlsAttributes = Record<string, string>;

export interface HlsVariant {
    uri: string;
    bandwidth: number;
    averageBandwidth?: number;
    codecs?: string;
    resolution?: { width: number; height: number };
    frameRate?: number;
    audio?: string;
    video?: string;
    subtitles?: string;
    closedCaptions?: string;
    iframe?: boolean;
    attributes?: HlsAttributes;
}

export interface HlsRendition {
    type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
    groupId: string;
    name: string;
    uri?: string;
    language?: string;
    default?: boolean;
    autoselect?: boolean;
    forced?: boolean;
    channels?: string;
    instreamId?: string;
    attributes?: HlsAttributes;
}

interface HlsPlaylistBase {
    version?: number;
    independentSegments?: boolean;
    start?: HlsAttributes;
    baseUrl?: string;
    diagnostics?: readonly MediaDiagnostic[];
}

export interface HlsMasterPlaylist extends HlsPlaylistBase {
    type: 'master';
    variants: HlsVariant[];
    renditions: HlsRendition[];
    sessionData?: HlsAttributes[];
    sessionKeys?: HlsKey[];
}

export interface HlsMediaPlaylist extends HlsPlaylistBase {
    type: 'media';
    targetDuration: number;
    mediaSequence: number;
    discontinuitySequence: number;
    segments: HlsSegment[];
    endList: boolean;
    playlistType?: 'EVENT' | 'VOD';
    iframeOnly?: boolean;
    dateRanges?: HlsAttributes[];
    partTarget?: number;
    trailingParts?: HlsPart[];
    preloadHints?: HlsAttributes[];
    serverControl?: HlsAttributes;
    renditionReports?: HlsAttributes[];
    skippedSegments?: number;
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

export interface HlsParseOptions extends DiagnosticOptions {
    baseUrl?: string;
    /** Reconstruct EXT-X-SKIP from this playlist. Missing skipped history is an error. */
    previousPlaylist?: HlsMediaPlaylist;
    /**
     * Maximum complete segments plus PART entries, including reconstructed history. Default 100000.
     */
    maxPlaylistEntries?: number;
}

// A playlist that does not follow RFC 8216 is malformed (DEMUX), one that uses what this parser
// does not read is unsupported (FORMAT), an invalid argument or option is INPUT, and a playlist
// past a size limit is OOM.

/** Refuses a playlist that does not follow RFC 8216. */
export function malformed(message: string): never {
    throw new DemuxError(`HLS: ${message}`);
}

/** Refuses a playlist that uses what this parser does not read. */
function unsupported(message: string): never {
    throw new MediaForgeError(`HLS: ${message}`, 'FORMAT');
}

function invalidArgument(message: string): never {
    throw new MediaForgeError(`HLS: ${message}`, 'INPUT');
}

function overLimit(message: string): never {
    throw new MediaForgeError(`HLS: ${message}`, 'OOM');
}

/** A decimal-integer of at least `minimum`; one past JavaScript's safe integers is unsupported. */
export function integer(value: string | number | undefined, label: string, minimum = 0): number {
    if (value === undefined || !/^\d+$/.test(String(value))) malformed(`invalid ${label}`);
    const result = Number(value);
    if (!Number.isSafeInteger(result)) unsupported(`${label} exceeds safe integer precision`);
    if (result < minimum) malformed(`invalid ${label}`);
    return result;
}

function decimal(value: string | number | undefined, label: string): number {
    if (value === undefined || !/^\d+(?:\.\d+)?$/.test(String(value)))
        malformed(`invalid ${label}`);
    const result = Number(value);
    if (!Number.isFinite(result) || result <= 0) malformed(`invalid ${label}`);
    return result;
}

export function required(value: string | undefined, label: string): string {
    if (!value || /[\r\n\x00]/.test(value)) malformed(`missing or invalid ${label}`);
    return value;
}

/** The tag that dates a segment or part. */
export function programDateTime(value: string): string {
    return `#EXT-X-PROGRAM-DATE-TIME:${required(value, 'program date time')}`;
}

function absoluteUrl(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
        new URL(value);
        return true;
    } catch {
        return false;
    }
}

function resolveUri(uri: string | undefined, baseUrl?: string): string {
    const value = required(uri, 'URI');
    if (value.includes('{$')) unsupported('variable substitution is not supported');
    if (!baseUrl) return value;
    try {
        return new URL(value, baseUrl).href;
    } catch {
        return malformed('invalid URI');
    }
}

function attributes(value: string): HlsAttributes {
    const result: HlsAttributes = Object.create(null);
    let cursor = 0;
    while (cursor < value.length) {
        const match = /^([A-Z0-9-]+)=/.exec(value.slice(cursor));
        if (!match) malformed('malformed attribute list');
        const name = match[1];
        if (Object.hasOwn(result, name)) malformed(`duplicate ${name} attribute`);
        cursor += match[0].length;
        if (value[cursor] === '"') {
            const end = value.indexOf('"', cursor + 1);
            if (end < 0) malformed(`unterminated ${name} attribute`);
            result[name] = value.slice(cursor + 1, end);
            cursor = end + 1;
        } else {
            const end = value.indexOf(',', cursor);
            result[name] = value.slice(cursor, end < 0 ? undefined : end);
            if (!result[name] || /\s/.test(result[name])) malformed(`invalid ${name} attribute`);
            cursor = end < 0 ? value.length : end;
        }

        if (cursor < value.length && value[cursor++] !== ',')
            malformed('malformed attribute separator');
        if (cursor === value.length && value.endsWith(','))
            malformed('trailing attribute separator');
    }

    return result;
}

function yesNo(value: string | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    if (value !== 'YES' && value !== 'NO') malformed('expected YES or NO');
    return value === 'YES';
}

function byteRange(
    value: string,
    uri: string,
    previous?: { uri: string; byteRange?: HlsByteRange },
): HlsByteRange {
    const match = /^(\d+)(?:@(\d+))?$/.exec(value);
    if (!match) malformed('invalid byte range');
    const length = integer(match[1], 'byte range length', 1);
    const offset =
        match[2] === undefined
            ? previous?.uri === uri && previous.byteRange
                ? previous.byteRange.offset + previous.byteRange.length
                : malformed('implicit byte range requires the previous range of the same resource')
            : integer(match[2], 'byte range offset');
    if (!Number.isSafeInteger(offset + length))
        unsupported('byte range exceeds safe integer precision');
    return { length, offset };
}

function parseKey(value: HlsAttributes, baseUrl?: string): HlsKey | undefined {
    const method = required(value.METHOD, 'key METHOD');
    if (method === 'NONE') {
        if (Object.keys(value).length !== 1) malformed('METHOD=NONE cannot have other attributes');
        return undefined;
    }
    const iv = value.IV;
    if (iv && !/^0[xX][\da-fA-F]{1,32}$/.test(iv)) malformed('invalid 128-bit key IV');
    return {
        method,
        uri: resolveUri(value.URI, baseUrl),
        iv,
        keyFormat: value.KEYFORMAT,
        keyFormatVersions: value.KEYFORMATVERSIONS,
    };
}

function parseVariant(value: HlsAttributes, uri: string, iframe = false): HlsVariant {
    let resolution: HlsVariant['resolution'];
    if (value.RESOLUTION) {
        const match = /^(\d+)x(\d+)$/.exec(value.RESOLUTION);
        if (!match) malformed('invalid variant RESOLUTION');
        resolution = {
            width: integer(match[1], 'width', 1),
            height: integer(match[2], 'height', 1),
        };
    }
    return {
        uri,
        bandwidth: integer(value.BANDWIDTH, 'BANDWIDTH', 1),
        averageBandwidth:
            value['AVERAGE-BANDWIDTH'] === undefined
                ? undefined
                : integer(value['AVERAGE-BANDWIDTH'], 'AVERAGE-BANDWIDTH', 1),
        codecs: value.CODECS,
        resolution,
        frameRate:
            value['FRAME-RATE'] === undefined
                ? undefined
                : decimal(value['FRAME-RATE'], 'FRAME-RATE'),
        audio: value.AUDIO,
        video: value.VIDEO,
        subtitles: value.SUBTITLES,
        closedCaptions: value['CLOSED-CAPTIONS'],
        iframe: iframe || undefined,
        attributes: value,
    };
}

function parsePart(value: HlsAttributes, baseUrl: string | undefined, previous?: HlsPart): HlsPart {
    const uri = resolveUri(value.URI, baseUrl);
    return {
        uri,
        duration: decimal(value.DURATION, 'PART DURATION'),
        independent: yesNo(value.INDEPENDENT),
        gap: yesNo(value.GAP),
        byteRange: value.BYTERANGE ? byteRange(value.BYTERANGE, uri, previous) : undefined,
    };
}

export function activeKeys(value: { key?: HlsKey; keys?: HlsKey[] }): HlsKey[] | undefined {
    const keys = value.keys ?? (value.key ? [value.key] : undefined);
    if (keys && keys.length > MAX_ACTIVE_KEY_FORMATS)
        overLimit('active KEYFORMAT alternative limit exceeded');
    return keys;
}

function replaceKeys(
    previous: HlsKey[] | undefined,
    declared: HlsKey[] | undefined,
): HlsKey[] | undefined {
    if (!declared?.length) return previous;
    const formats = new Set(declared.map(key => key.keyFormat ?? 'identity'));
    const retained = (previous ?? []).filter(key => !formats.has(key.keyFormat ?? 'identity'));
    if (retained.length + declared.length > MAX_ACTIVE_KEY_FORMATS)
        overLimit('active KEYFORMAT alternative limit exceeded');
    return [...retained, ...declared];
}

function requireMapIv(keys: HlsKey[] | undefined): void {
    if (keys?.some(key => key.method === 'AES-128' && !key.iv))
        malformed('encrypted initialization map requires an explicit IV');
}

export function parseHlsPlaylist(text: string, options: HlsParseOptions = {}): HlsPlaylist {
    if (typeof text !== 'string') invalidArgument('playlist must be text');
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalidArgument('parse options must be an object');
    options = {
        baseUrl: options.baseUrl,
        previousPlaylist: options.previousPlaylist,
        maxPlaylistEntries: options.maxPlaylistEntries,
        validation: options.validation,
        onWarning: options.onWarning,
        maxWarnings: options.maxWarnings,
    };
    if (options.baseUrl !== undefined && !absoluteUrl(options.baseUrl))
        invalidArgument('baseUrl must be an absolute URL');
    if (
        options.previousPlaylist !== undefined &&
        (options.previousPlaylist?.type !== 'media' ||
            !Array.isArray(options.previousPlaylist.segments))
    )
        invalidArgument('previousPlaylist must be a media playlist');

    const maxEntries = positiveLimit(options.maxPlaylistEntries, 100000, 'maxPlaylistEntries');
    let entries = 0;
    const addEntries = (count: number): void => {
        entries += count;
        if (entries > maxEntries) overLimit('playlist entry limit exceeded');
    };
    const diagnostics = new DiagnosticContext(options, 'compatible');
    if (text.startsWith('\uFEFF'))
        diagnostics.recover({
            code: 'HLS_BOM',
            message: 'Removed a UTF-8 byte order mark',
            format: 'hls',
        });

    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines[0] !== '#EXTM3U') malformed('playlist must start with #EXTM3U');
    const master: HlsMasterPlaylist = {
        type: 'master',
        variants: [],
        renditions: [],
        baseUrl: options.baseUrl,
        diagnostics: diagnostics.warnings,
    };

    const media: HlsMediaPlaylist = {
        type: 'media',
        targetDuration: 0,
        mediaSequence: 0,
        discontinuitySequence: 0,
        segments: [],
        endList: false,
        baseUrl: options.baseUrl,
        diagnostics: diagnostics.warnings,
    };

    let kind: HlsPlaylist['type'] | undefined;
    let pendingVariant: HlsAttributes | undefined;
    let duration: number | undefined;
    let title: string | undefined;
    let pendingRange: string | undefined;
    let map: HlsMap | undefined;
    let key: HlsKey | undefined;
    let keys: HlsKey[] | undefined;
    let discontinuity = false;
    let discontinuities = 0;
    let programDateTime: string | undefined;
    let gap = false;
    let parts: HlsPart[] = [];
    let previousPart: HlsPart | undefined;
    let keyDeclared = false;
    let keysCleared = false;
    let mapDeclared = false;
    let mapClearedKeys = false;
    const singletons = new Set<string>();
    const claim = (next: HlsPlaylist['type']): void => {
        if (kind && kind !== next) malformed('master and media tags cannot be mixed');
        kind = next;
    };
    for (let index = 1; index < lines.length; index++) {
        const line = lines[index];
        if (!line) continue;
        if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line))
            malformed(`control character on line ${index + 1}`);
        if (line[0] !== '#') {
            const uri = resolveUri(line, options.baseUrl);
            if (pendingVariant) {
                master.variants.push(parseVariant(pendingVariant, uri));
                pendingVariant = undefined;
                continue;
            }

            claim('media');
            if (duration === undefined) malformed('media URI requires EXTINF');
            const sequence =
                media.mediaSequence + (media.skippedSegments ?? 0) + media.segments.length;
            const discontinuitySequence = media.discontinuitySequence + discontinuities;
            if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(discontinuitySequence))
                unsupported('sequence exceeds safe integer precision');
            addEntries(1);
            media.segments.push({
                uri,
                duration,
                title,
                sequence,
                discontinuitySequence,
                discontinuity: discontinuity || undefined,
                key,
                keys,
                map,
                programDateTime,
                gap: gap || undefined,
                byteRange: pendingRange
                    ? byteRange(pendingRange, uri, media.segments.at(-1))
                    : undefined,
                parts: parts.length ? parts : undefined,
            });
            duration = undefined;
            title = undefined;
            pendingRange = undefined;
            programDateTime = undefined;
            discontinuity = false;
            gap = false;
            parts = [];
            continue;
        }

        const colon = line.indexOf(':');
        const name = line.slice(1, colon < 0 ? undefined : colon);
        const value = colon < 0 ? '' : line.slice(colon + 1);
        if (
            [
                'EXTM3U',
                'EXT-X-VERSION',
                'EXT-X-TARGETDURATION',
                'EXT-X-MEDIA-SEQUENCE',
                'EXT-X-DISCONTINUITY-SEQUENCE',
                'EXT-X-PLAYLIST-TYPE',
                'EXT-X-PART-INF',
                'EXT-X-SKIP',
                'EXT-X-SERVER-CONTROL',
                'EXT-X-START',
            ].includes(name)
        ) {
            if (singletons.has(name) || name === 'EXTM3U') malformed(`duplicate ${name}`);
            singletons.add(name);
        }

        switch (name) {
            case 'EXT-X-VERSION':
                master.version = media.version = integer(value, name, 1);
                break;
            case 'EXT-X-INDEPENDENT-SEGMENTS':
                master.independentSegments = media.independentSegments = true;
                break;
            case 'EXT-X-START':
                master.start = media.start = attributes(value);
                break;
            case 'EXT-X-STREAM-INF':
                claim('master');
                if (pendingVariant) malformed('variant URI is missing');
                pendingVariant = attributes(value);
                break;
            case 'EXT-X-I-FRAME-STREAM-INF': {
                claim('master');
                const attrs = attributes(value);
                master.variants.push(
                    parseVariant(attrs, resolveUri(attrs.URI, options.baseUrl), true),
                );
                break;
            }
            case 'EXT-X-MEDIA': {
                claim('master');
                const attrs = attributes(value);
                if (!['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS'].includes(attrs.TYPE))
                    malformed('invalid rendition TYPE');
                if (attrs.TYPE === 'SUBTITLES' && !attrs.URI)
                    malformed('subtitle rendition requires URI');
                if (attrs.TYPE === 'CLOSED-CAPTIONS' && (attrs.URI || !attrs['INSTREAM-ID']))
                    malformed('invalid closed-caption rendition');
                master.renditions.push({
                    type: attrs.TYPE as HlsRendition['type'],
                    groupId: required(attrs['GROUP-ID'], 'GROUP-ID'),
                    name: required(attrs.NAME, 'NAME'),
                    uri: attrs.URI ? resolveUri(attrs.URI, options.baseUrl) : undefined,
                    language: attrs.LANGUAGE,
                    default: yesNo(attrs.DEFAULT),
                    autoselect: yesNo(attrs.AUTOSELECT),
                    forced: yesNo(attrs.FORCED),
                    channels: attrs.CHANNELS,
                    instreamId: attrs['INSTREAM-ID'],
                    attributes: attrs,
                });
                break;
            }
            case 'EXT-X-SESSION-DATA': {
                claim('master');
                const attrs = attributes(value);
                if (attrs.URI) attrs.URI = resolveUri(attrs.URI, options.baseUrl);
                (master.sessionData ??= []).push(attrs);
                break;
            }
            case 'EXT-X-SESSION-KEY': {
                claim('master');
                const sessionKey = parseKey(attributes(value), options.baseUrl);
                if (!sessionKey) malformed('session key cannot use METHOD=NONE');
                (master.sessionKeys ??= []).push(sessionKey);
                break;
            }
            case 'EXTINF': {
                claim('media');
                if (duration !== undefined) malformed('segment URI is missing');
                const comma = value.indexOf(',');
                if (comma < 0)
                    diagnostics.recover({
                        code: 'HLS_EXTINF_COMMA',
                        message: 'Accepted EXTINF without its empty-title comma',
                        format: 'hls',
                    });

                duration = decimal(comma < 0 ? value : value.slice(0, comma), 'EXTINF duration');
                title = comma < 0 ? '' : value.slice(comma + 1);
                break;
            }
            case 'EXT-X-TARGETDURATION':
                claim('media');
                media.targetDuration = integer(value, name, 1);
                break;
            case 'EXT-X-MEDIA-SEQUENCE':
                claim('media');
                if (media.segments.length || parts.length || singletons.has('EXT-X-SKIP'))
                    malformed('MEDIA-SEQUENCE must precede segments, parts and SKIP');
                media.mediaSequence = integer(value, name);
                break;
            case 'EXT-X-DISCONTINUITY-SEQUENCE':
                claim('media');
                if (
                    media.segments.length ||
                    parts.length ||
                    discontinuities ||
                    singletons.has('EXT-X-SKIP')
                )
                    malformed(
                        'DISCONTINUITY-SEQUENCE must precede segments, parts, SKIP and ' +
                            'discontinuities',
                    );

                media.discontinuitySequence = integer(value, name);
                break;
            case 'EXT-X-DISCONTINUITY':
                claim('media');
                if (parts.length) malformed('DISCONTINUITY must precede the first PART');
                if (discontinuity) malformed('duplicate discontinuity before a segment');
                discontinuity = true;
                discontinuities++;
                break;
            case 'EXT-X-BYTERANGE':
                claim('media');
                pendingRange = value;
                break;
            case 'EXT-X-MAP': {
                claim('media');
                if (parts.length) malformed('MAP must precede the first PART');
                const attrs = attributes(value);
                const uri = resolveUri(attrs.URI, options.baseUrl);
                map = {
                    uri,
                    key,
                    keys,
                    byteRange: attrs.BYTERANGE ? byteRange(attrs.BYTERANGE, uri, map) : undefined,
                };
                mapDeclared = true;
                mapClearedKeys = keysCleared;
                requireMapIv(keys);
                break;
            }
            case 'EXT-X-KEY':
                claim('media');
                if (parts.length) malformed('KEY must precede the first PART');
                key = parseKey(attributes(value), options.baseUrl);
                keys = key ? replaceKeys(keys, [key]) : undefined;
                if (!key) keysCleared = true;
                keyDeclared = true;
                break;
            case 'EXT-X-PROGRAM-DATE-TIME':
                claim('media');
                if (parts.length) malformed('PROGRAM-DATE-TIME must precede the first PART');
                if (!Number.isFinite(Date.parse(value))) malformed('invalid PROGRAM-DATE-TIME');
                programDateTime = value;
                break;
            case 'EXT-X-DATERANGE':
                claim('media');
                (media.dateRanges ??= []).push(attributes(value));
                break;
            case 'EXT-X-GAP':
                claim('media');
                gap = true;
                break;
            case 'EXT-X-ENDLIST':
                claim('media');
                media.endList = true;
                break;
            case 'EXT-X-I-FRAMES-ONLY':
                claim('media');
                media.iframeOnly = true;
                break;
            case 'EXT-X-PLAYLIST-TYPE':
                claim('media');
                if (value !== 'VOD' && value !== 'EVENT') malformed('invalid PLAYLIST-TYPE');
                media.playlistType = value;
                break;
            case 'EXT-X-PART': {
                claim('media');
                addEntries(1);
                const part = parsePart(attributes(value), options.baseUrl, previousPart);
                part.sequence =
                    media.mediaSequence + (media.skippedSegments ?? 0) + media.segments.length;
                part.partIndex = parts.length;
                part.discontinuitySequence = media.discontinuitySequence + discontinuities;
                if (
                    !Number.isSafeInteger(part.sequence) ||
                    !Number.isSafeInteger(part.discontinuitySequence)
                )
                    unsupported('sequence exceeds safe integer precision');

                part.discontinuity = discontinuity || undefined;
                part.key = key;
                part.keys = keys;
                part.map = map;
                part.programDateTime = programDateTime;
                parts.push(part);
                previousPart = part;
                break;
            }
            case 'EXT-X-PART-INF':
                claim('media');
                media.partTarget = decimal(attributes(value)['PART-TARGET'], 'PART-TARGET');
                break;
            case 'EXT-X-SERVER-CONTROL':
                claim('media');
                media.serverControl = attributes(value);
                break;
            case 'EXT-X-PRELOAD-HINT':
            case 'EXT-X-RENDITION-REPORT': {
                claim('media');
                const attrs = attributes(value);
                attrs.URI = resolveUri(attrs.URI, options.baseUrl);
                if (name === 'EXT-X-PRELOAD-HINT') (media.preloadHints ??= []).push(attrs);
                else (media.renditionReports ??= []).push(attrs);
                break;
            }
            case 'EXT-X-SKIP': {
                claim('media');
                if (
                    media.segments.length ||
                    parts.length ||
                    duration !== undefined ||
                    discontinuities ||
                    pendingRange
                )
                    malformed('SKIP must precede segments, parts and discontinuities');

                const attrs = attributes(value);
                if (attrs['RECENTLY-REMOVED-DATERANGES'] !== undefined)
                    unsupported('date-range delta updates are unsupported');
                const skipped = integer(attrs['SKIPPED-SEGMENTS'], 'SKIPPED-SEGMENTS');
                if (!Number.isSafeInteger(media.mediaSequence + skipped))
                    unsupported('sequence exceeds safe integer precision');
                const previous = options.previousPlaylist;
                if (previous && skipped) {
                    if (previous.skippedSegments)
                        invalidArgument('cannot reconstruct a delta from incomplete history');
                    const retained = previous.segments.filter(
                        segment =>
                            segment.sequence >= media.mediaSequence &&
                            segment.sequence < media.mediaSequence + skipped,
                    );

                    if (
                        retained.length !== skipped ||
                        retained.some(
                            (segment, index) => segment.sequence !== media.mediaSequence + index,
                        )
                    ) {
                        malformed(
                            'delta reconstruction requires every skipped segment in previous ' +
                                'history',
                        );
                    }

                    const first = retained[0];
                    if (
                        first.discontinuitySequence - (first.discontinuity ? 1 : 0) !==
                        media.discontinuitySequence
                    ) {
                        malformed('delta discontinuity sequence conflicts with previous history');
                    }

                    for (const segment of retained) addEntries(1 + (segment.parts?.length ?? 0));
                    media.segments = retained;
                    const last = retained[retained.length - 1];
                    discontinuities = last.discontinuitySequence - media.discontinuitySequence;
                    if (mapDeclared && map && !mapClearedKeys) {
                        const inherited = replaceKeys(activeKeys(last), map.keys);
                        requireMapIv(inherited);
                        map = { ...map, key: inherited?.at(-1), keys: inherited };
                    }

                    if (!keyDeclared) {
                        key = last.key;
                        keys = activeKeys(last);
                    } else if (!keysCleared) {
                        keys = replaceKeys(activeKeys(last), keys);
                        key = keys?.at(-1);
                    }

                    if (!mapDeclared) map = last.map;
                    previousPart = last.parts?.at(-1);
                } else if (!previous) media.skippedSegments = skipped;
                break;
            }
        }
    }

    if (pendingVariant || duration !== undefined || pendingRange)
        malformed('playlist ends before a required URI');
    if (kind === 'master') {
        master.diagnostics = diagnostics.warnings;
        return master;
    }

    if (!media.targetDuration) malformed('media playlist requires TARGETDURATION');
    if (media.segments.some(segment => Math.round(segment.duration) > media.targetDuration))
        malformed('segment duration exceeds TARGETDURATION');
    if (parts.length) media.trailingParts = parts;
    media.diagnostics = diagnostics.warnings;
    return media;
}
