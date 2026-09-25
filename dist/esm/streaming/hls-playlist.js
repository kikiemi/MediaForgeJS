import { MediaForgeError } from '../core/errors.js';
import { DiagnosticContext } from '../core/diagnostics.js';
const MAX_ACTIVE_KEY_FORMATS = 64;
function invalid(message) {
    throw new MediaForgeError(`HLS: ${message}`, 'FORMAT');
}
function integer(value, label, minimum = 0) {
    if (value === undefined || !/^\d+$/.test(String(value)))
        invalid(`invalid ${label}`);
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < minimum)
        invalid(`invalid ${label}`);
    return result;
}
function decimal(value, label) {
    if (value === undefined || !/^\d+(?:\.\d+)?$/.test(String(value)))
        invalid(`invalid ${label}`);
    const result = Number(value);
    if (!Number.isFinite(result) || result <= 0)
        invalid(`invalid ${label}`);
    return result;
}
function required(value, label) {
    if (!value || /[\r\n\x00]/.test(value))
        invalid(`missing or invalid ${label}`);
    return value;
}
function resolveUri(uri, baseUrl) {
    const value = required(uri, 'URI');
    if (value.includes('{$'))
        invalid('variable substitution is unsupported');
    if (!baseUrl)
        return value;
    try {
        return new URL(value, baseUrl).href;
    }
    catch {
        return invalid('invalid URI or base URL');
    }
}
function attributes(value) {
    const result = Object.create(null);
    let cursor = 0;
    while (cursor < value.length) {
        const match = /^([A-Z0-9-]+)=/.exec(value.slice(cursor));
        if (!match)
            invalid('malformed attribute list');
        const name = match[1];
        if (Object.hasOwn(result, name))
            invalid(`duplicate ${name} attribute`);
        cursor += match[0].length;
        if (value[cursor] === '"') {
            const end = value.indexOf('"', cursor + 1);
            if (end < 0)
                invalid(`unterminated ${name} attribute`);
            result[name] = value.slice(cursor + 1, end);
            cursor = end + 1;
        }
        else {
            const end = value.indexOf(',', cursor);
            result[name] = value.slice(cursor, end < 0 ? undefined : end);
            if (!result[name] || /\s/.test(result[name]))
                invalid(`invalid ${name} attribute`);
            cursor = end < 0 ? value.length : end;
        }
        if (cursor < value.length && value[cursor++] !== ',')
            invalid('malformed attribute separator');
        if (cursor === value.length && value.endsWith(','))
            invalid('trailing attribute separator');
    }
    return result;
}
function yesNo(value) {
    if (value === undefined)
        return undefined;
    if (value !== 'YES' && value !== 'NO')
        invalid('expected YES or NO');
    return value === 'YES';
}
function byteRange(value, uri, previous) {
    const match = /^(\d+)(?:@(\d+))?$/.exec(value);
    if (!match)
        invalid('invalid byte range');
    const length = integer(match[1], 'byte range length', 1);
    const offset = match[2] === undefined
        ? previous?.uri === uri && previous.byteRange
            ? previous.byteRange.offset + previous.byteRange.length
            : invalid('implicit byte range requires the previous range of the same resource')
        : integer(match[2], 'byte range offset');
    if (!Number.isSafeInteger(offset + length))
        invalid('byte range exceeds safe integer precision');
    return { length, offset };
}
function parseKey(value, baseUrl) {
    const method = required(value.METHOD, 'key METHOD');
    if (method === 'NONE') {
        if (Object.keys(value).length !== 1)
            invalid('METHOD=NONE cannot have other attributes');
        return undefined;
    }
    const iv = value.IV;
    if (iv && !/^0[xX][\da-fA-F]{1,32}$/.test(iv))
        invalid('invalid 128-bit key IV');
    return {
        method,
        uri: resolveUri(value.URI, baseUrl),
        iv,
        keyFormat: value.KEYFORMAT,
        keyFormatVersions: value.KEYFORMATVERSIONS,
    };
}
function parseVariant(value, uri, iframe = false) {
    let resolution;
    if (value.RESOLUTION) {
        const match = /^(\d+)x(\d+)$/.exec(value.RESOLUTION);
        if (!match)
            invalid('invalid variant RESOLUTION');
        resolution = { width: integer(match[1], 'width', 1), height: integer(match[2], 'height', 1) };
    }
    return {
        uri,
        bandwidth: integer(value.BANDWIDTH, 'BANDWIDTH', 1),
        averageBandwidth: value['AVERAGE-BANDWIDTH'] === undefined
            ? undefined
            : integer(value['AVERAGE-BANDWIDTH'], 'AVERAGE-BANDWIDTH', 1),
        codecs: value.CODECS,
        resolution,
        frameRate: value['FRAME-RATE'] === undefined ? undefined : decimal(value['FRAME-RATE'], 'FRAME-RATE'),
        audio: value.AUDIO,
        video: value.VIDEO,
        subtitles: value.SUBTITLES,
        closedCaptions: value['CLOSED-CAPTIONS'],
        iframe: iframe || undefined,
        attributes: value,
    };
}
function parsePart(value, baseUrl, previous) {
    const uri = resolveUri(value.URI, baseUrl);
    return {
        uri,
        duration: decimal(value.DURATION, 'PART DURATION'),
        independent: yesNo(value.INDEPENDENT),
        gap: yesNo(value.GAP),
        byteRange: value.BYTERANGE ? byteRange(value.BYTERANGE, uri, previous) : undefined,
    };
}
function activeKeys(value) {
    const keys = value.keys ?? (value.key ? [value.key] : undefined);
    if (keys && keys.length > MAX_ACTIVE_KEY_FORMATS)
        invalid('active KEYFORMAT alternative limit exceeded');
    return keys;
}
function replaceKeys(previous, declared) {
    if (!declared?.length)
        return previous;
    const formats = new Set(declared.map(key => key.keyFormat ?? 'identity'));
    const retained = (previous ?? []).filter(key => !formats.has(key.keyFormat ?? 'identity'));
    if (retained.length + declared.length > MAX_ACTIVE_KEY_FORMATS)
        invalid('active KEYFORMAT alternative limit exceeded');
    return [...retained, ...declared];
}
function requireMapIv(keys) {
    if (keys?.some(key => key.method === 'AES-128' && !key.iv))
        invalid('encrypted initialization map requires an explicit IV');
}
export function parseHlsPlaylist(text, options = {}) {
    if (typeof text !== 'string')
        invalid('playlist must be text');
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalid('parse options must be an object');
    options = {
        baseUrl: options.baseUrl,
        previousPlaylist: options.previousPlaylist,
        maxPlaylistEntries: options.maxPlaylistEntries,
        validation: options.validation,
        onWarning: options.onWarning,
        maxWarnings: options.maxWarnings,
    };
    if (options.baseUrl !== undefined && typeof options.baseUrl !== 'string')
        invalid('baseUrl must be a string');
    if (options.previousPlaylist !== undefined &&
        (options.previousPlaylist?.type !== 'media' || !Array.isArray(options.previousPlaylist.segments)))
        invalid('previousPlaylist must be a media playlist');
    const maxEntries = integer(options.maxPlaylistEntries ?? 100000, 'maxPlaylistEntries', 1);
    let entries = 0;
    const addEntries = (count) => {
        entries += count;
        if (entries > maxEntries)
            invalid('playlist entry limit exceeded');
    };
    const diagnostics = new DiagnosticContext(options, 'compatible');
    if (text.startsWith('\uFEFF'))
        diagnostics.recover({ code: 'HLS_BOM', message: 'Removed a UTF-8 byte order mark', format: 'hls' });
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines[0] !== '#EXTM3U')
        invalid('playlist must start with #EXTM3U');
    const master = {
        type: 'master',
        variants: [],
        renditions: [],
        baseUrl: options.baseUrl,
        diagnostics: diagnostics.warnings,
    };
    const media = {
        type: 'media',
        targetDuration: 0,
        mediaSequence: 0,
        discontinuitySequence: 0,
        segments: [],
        endList: false,
        baseUrl: options.baseUrl,
        diagnostics: diagnostics.warnings,
    };
    let kind;
    let pendingVariant;
    let duration;
    let title;
    let pendingRange;
    let map;
    let key;
    let keys;
    let discontinuity = false;
    let discontinuities = 0;
    let programDateTime;
    let gap = false;
    let parts = [];
    let previousPart;
    let keyDeclared = false;
    let keysCleared = false;
    let mapDeclared = false;
    let mapClearedKeys = false;
    const singletons = new Set();
    const claim = (next) => {
        if (kind && kind !== next)
            invalid('master and media tags cannot be mixed');
        kind = next;
    };
    for (let index = 1; index < lines.length; index++) {
        const line = lines[index];
        if (!line)
            continue;
        if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line))
            invalid(`control character on line ${index + 1}`);
        if (line[0] !== '#') {
            const uri = resolveUri(line, options.baseUrl);
            if (pendingVariant) {
                master.variants.push(parseVariant(pendingVariant, uri));
                pendingVariant = undefined;
                continue;
            }
            claim('media');
            if (duration === undefined)
                invalid('media URI requires EXTINF');
            const sequence = media.mediaSequence + (media.skippedSegments ?? 0) + media.segments.length;
            const discontinuitySequence = media.discontinuitySequence + discontinuities;
            if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(discontinuitySequence))
                invalid('sequence exceeds safe integer precision');
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
                byteRange: pendingRange ? byteRange(pendingRange, uri, media.segments.at(-1)) : undefined,
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
        if ([
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
        ].includes(name)) {
            if (singletons.has(name) || name === 'EXTM3U')
                invalid(`duplicate ${name}`);
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
                if (pendingVariant)
                    invalid('variant URI is missing');
                pendingVariant = attributes(value);
                break;
            case 'EXT-X-I-FRAME-STREAM-INF': {
                claim('master');
                const attrs = attributes(value);
                master.variants.push(parseVariant(attrs, resolveUri(attrs.URI, options.baseUrl), true));
                break;
            }
            case 'EXT-X-MEDIA': {
                claim('master');
                const attrs = attributes(value);
                if (!['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS'].includes(attrs.TYPE))
                    invalid('invalid rendition TYPE');
                if (attrs.TYPE === 'SUBTITLES' && !attrs.URI)
                    invalid('subtitle rendition requires URI');
                if (attrs.TYPE === 'CLOSED-CAPTIONS' && (attrs.URI || !attrs['INSTREAM-ID']))
                    invalid('invalid closed-caption rendition');
                master.renditions.push({
                    type: attrs.TYPE,
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
                if (attrs.URI)
                    attrs.URI = resolveUri(attrs.URI, options.baseUrl);
                (master.sessionData ??= []).push(attrs);
                break;
            }
            case 'EXT-X-SESSION-KEY': {
                claim('master');
                const sessionKey = parseKey(attributes(value), options.baseUrl);
                if (!sessionKey)
                    invalid('session key cannot use METHOD=NONE');
                (master.sessionKeys ??= []).push(sessionKey);
                break;
            }
            case 'EXTINF': {
                claim('media');
                if (duration !== undefined)
                    invalid('segment URI is missing');
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
                    invalid('MEDIA-SEQUENCE must precede segments, parts and SKIP');
                media.mediaSequence = integer(value, name);
                break;
            case 'EXT-X-DISCONTINUITY-SEQUENCE':
                claim('media');
                if (media.segments.length || parts.length || discontinuities || singletons.has('EXT-X-SKIP'))
                    invalid('DISCONTINUITY-SEQUENCE must precede segments, parts, SKIP and discontinuities');
                media.discontinuitySequence = integer(value, name);
                break;
            case 'EXT-X-DISCONTINUITY':
                claim('media');
                if (parts.length)
                    invalid('DISCONTINUITY must precede the first PART');
                if (discontinuity)
                    invalid('duplicate discontinuity before a segment');
                discontinuity = true;
                discontinuities++;
                break;
            case 'EXT-X-BYTERANGE':
                claim('media');
                pendingRange = value;
                break;
            case 'EXT-X-MAP': {
                claim('media');
                if (parts.length)
                    invalid('MAP must precede the first PART');
                const attrs = attributes(value);
                const uri = resolveUri(attrs.URI, options.baseUrl);
                map = { uri, key, keys, byteRange: attrs.BYTERANGE ? byteRange(attrs.BYTERANGE, uri, map) : undefined };
                mapDeclared = true;
                mapClearedKeys = keysCleared;
                requireMapIv(keys);
                break;
            }
            case 'EXT-X-KEY':
                claim('media');
                if (parts.length)
                    invalid('KEY must precede the first PART');
                key = parseKey(attributes(value), options.baseUrl);
                keys = key ? replaceKeys(keys, [key]) : undefined;
                if (!key)
                    keysCleared = true;
                keyDeclared = true;
                break;
            case 'EXT-X-PROGRAM-DATE-TIME':
                claim('media');
                if (parts.length)
                    invalid('PROGRAM-DATE-TIME must precede the first PART');
                if (!Number.isFinite(Date.parse(value)))
                    invalid('invalid PROGRAM-DATE-TIME');
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
                if (value !== 'VOD' && value !== 'EVENT')
                    invalid('invalid PLAYLIST-TYPE');
                media.playlistType = value;
                break;
            case 'EXT-X-PART': {
                claim('media');
                addEntries(1);
                const part = parsePart(attributes(value), options.baseUrl, previousPart);
                part.sequence = media.mediaSequence + (media.skippedSegments ?? 0) + media.segments.length;
                part.partIndex = parts.length;
                part.discontinuitySequence = media.discontinuitySequence + discontinuities;
                if (!Number.isSafeInteger(part.sequence) || !Number.isSafeInteger(part.discontinuitySequence))
                    invalid('sequence exceeds safe integer precision');
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
                if (name === 'EXT-X-PRELOAD-HINT')
                    (media.preloadHints ??= []).push(attrs);
                else
                    (media.renditionReports ??= []).push(attrs);
                break;
            }
            case 'EXT-X-SKIP': {
                claim('media');
                if (media.segments.length || parts.length || duration !== undefined || discontinuities || pendingRange)
                    invalid('SKIP must precede segments, parts and discontinuities');
                const attrs = attributes(value);
                if (attrs['RECENTLY-REMOVED-DATERANGES'] !== undefined)
                    invalid('date-range delta updates are unsupported');
                const skipped = integer(attrs['SKIPPED-SEGMENTS'], 'SKIPPED-SEGMENTS');
                if (!Number.isSafeInteger(media.mediaSequence + skipped))
                    invalid('sequence exceeds safe integer precision');
                const previous = options.previousPlaylist;
                if (previous && skipped) {
                    if (previous.skippedSegments)
                        invalid('cannot reconstruct a delta from incomplete history');
                    const retained = previous.segments.filter(segment => segment.sequence >= media.mediaSequence && segment.sequence < media.mediaSequence + skipped);
                    if (retained.length !== skipped ||
                        retained.some((segment, index) => segment.sequence !== media.mediaSequence + index)) {
                        invalid('delta reconstruction requires every skipped segment in previous history');
                    }
                    const first = retained[0];
                    if (first.discontinuitySequence - (first.discontinuity ? 1 : 0) !== media.discontinuitySequence) {
                        invalid('delta discontinuity sequence conflicts with previous history');
                    }
                    for (const segment of retained)
                        addEntries(1 + (segment.parts?.length ?? 0));
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
                    }
                    else if (!keysCleared) {
                        keys = replaceKeys(activeKeys(last), keys);
                        key = keys?.at(-1);
                    }
                    if (!mapDeclared)
                        map = last.map;
                    previousPart = last.parts?.at(-1);
                }
                else if (!previous)
                    media.skippedSegments = skipped;
                break;
            }
        }
    }
    if (pendingVariant || duration !== undefined || pendingRange)
        invalid('playlist ends before a required URI');
    if (kind === 'master') {
        master.diagnostics = diagnostics.warnings;
        return master;
    }
    if (!media.targetDuration)
        invalid('media playlist requires TARGETDURATION');
    if (media.segments.some(segment => Math.round(segment.duration) > media.targetDuration))
        invalid('segment duration exceeds TARGETDURATION');
    if (parts.length)
        media.trailingParts = parts;
    media.diagnostics = diagnostics.warnings;
    return media;
}
function quote(value) {
    if (/["\r\n\x00]/.test(value))
        invalid('attribute contains a quote or control character');
    return `"${value}"`;
}
const unquotedAttributes = new Set([
    'TYPE',
    'METHOD',
    'IV',
    'BANDWIDTH',
    'AVERAGE-BANDWIDTH',
    'RESOLUTION',
    'FRAME-RATE',
    'DEFAULT',
    'AUTOSELECT',
    'FORCED',
    'DURATION',
    'PRECISE',
    'TIME-OFFSET',
    'INDEPENDENT',
    'GAP',
    'PART-TARGET',
    'CAN-SKIP-UNTIL',
    'CAN-BLOCK-RELOAD',
    'CAN-SKIP-DATERANGES',
    'HOLD-BACK',
    'PART-HOLD-BACK',
    'BYTERANGE-START',
    'BYTERANGE-LENGTH',
    'LAST-MSN',
    'LAST-PART',
    'SKIPPED-SEGMENTS',
    'END-ON-NEXT',
    'PLANNED-DURATION',
    'SCTE35-CMD',
    'SCTE35-OUT',
    'SCTE35-IN',
    'VIDEO-RANGE',
    'HDCP-LEVEL',
    'SCORE',
]);
function serializeAttributes(values) {
    return Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => {
        if (!/^[A-Z0-9-]+$/.test(name))
            invalid('invalid attribute name');
        const text = typeof value === 'boolean' ? (value ? 'YES' : 'NO') : String(value);
        if (/[\r\n\x00]/.test(text))
            invalid('attribute contains a control character');
        const unquoted = unquotedAttributes.has(name) || (name === 'CLOSED-CAPTIONS' && text === 'NONE');
        if (unquoted && /[",\s]/.test(text))
            invalid(`invalid ${name} attribute`);
        return `${name}=${unquoted ? text : quote(text)}`;
    })
        .join(',');
}
function rangeText(range) {
    const length = integer(range.length, 'byte range length', 1);
    const offset = integer(range.offset, 'byte range offset');
    if (!Number.isSafeInteger(offset + length))
        invalid('byte range exceeds safe integer precision');
    return `${length}@${offset}`;
}
function keyText(key) {
    return key
        ? serializeAttributes({
            METHOD: key.method,
            URI: key.uri,
            IV: key.iv,
            KEYFORMAT: key.keyFormat,
            KEYFORMATVERSIONS: key.keyFormatVersions,
        })
        : 'METHOD=NONE';
}
function keySetText(value) {
    return JSON.stringify((activeKeys(value) ?? []).map(key => keyText(key)));
}
function partText(part) {
    return `#EXT-X-PART:${serializeAttributes({
        URI: part.uri,
        DURATION: part.duration,
        INDEPENDENT: part.independent,
        GAP: part.gap,
        BYTERANGE: part.byteRange ? rangeText(part.byteRange) : undefined,
    })}`;
}
export function serializeHlsPlaylist(playlist) {
    const lines = ['#EXTM3U'];
    const media = playlist.type === 'media' ? playlist : undefined;
    const minimumVersion = media?.partTarget !== undefined ||
        media?.trailingParts?.length ||
        media?.serverControl ||
        media?.preloadHints?.length ||
        media?.renditionReports?.length ||
        media?.skippedSegments !== undefined ||
        media?.segments.some(segment => segment.parts?.length)
        ? 9
        : 7;
    lines.push(`#EXT-X-VERSION:${Math.max(minimumVersion, playlist.version ?? 1)}`);
    if (playlist.independentSegments)
        lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
    if (playlist.start)
        lines.push(`#EXT-X-START:${serializeAttributes(playlist.start)}`);
    if (playlist.type === 'master') {
        for (const rendition of playlist.renditions) {
            lines.push(`#EXT-X-MEDIA:${serializeAttributes({
                ...rendition.attributes,
                TYPE: rendition.type,
                'GROUP-ID': rendition.groupId,
                NAME: rendition.name,
                URI: rendition.uri,
                LANGUAGE: rendition.language,
                DEFAULT: rendition.default,
                AUTOSELECT: rendition.autoselect,
                FORCED: rendition.forced,
                CHANNELS: rendition.channels,
                'INSTREAM-ID': rendition.instreamId,
            })}`);
        }
        for (const data of playlist.sessionData ?? [])
            lines.push(`#EXT-X-SESSION-DATA:${serializeAttributes(data)}`);
        for (const key of playlist.sessionKeys ?? [])
            lines.push(`#EXT-X-SESSION-KEY:${keyText(key)}`);
        for (const variant of playlist.variants) {
            const attrs = serializeAttributes({
                ...variant.attributes,
                URI: variant.iframe ? variant.uri : undefined,
                BANDWIDTH: variant.bandwidth,
                'AVERAGE-BANDWIDTH': variant.averageBandwidth,
                CODECS: variant.codecs,
                RESOLUTION: variant.resolution ? `${variant.resolution.width}x${variant.resolution.height}` : undefined,
                'FRAME-RATE': variant.frameRate,
                AUDIO: variant.audio,
                VIDEO: variant.video,
                SUBTITLES: variant.subtitles,
                'CLOSED-CAPTIONS': variant.closedCaptions,
            });
            lines.push(`#EXT-X-${variant.iframe ? 'I-FRAME-STREAM-INF' : 'STREAM-INF'}:${attrs}`);
            if (!variant.iframe)
                lines.push(required(variant.uri, 'variant URI'));
        }
    }
    else {
        lines.push(`#EXT-X-TARGETDURATION:${playlist.targetDuration}`, `#EXT-X-MEDIA-SEQUENCE:${playlist.mediaSequence}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${playlist.discontinuitySequence}`);
        if (playlist.playlistType)
            lines.push(`#EXT-X-PLAYLIST-TYPE:${playlist.playlistType}`);
        if (playlist.iframeOnly)
            lines.push('#EXT-X-I-FRAMES-ONLY');
        if (playlist.serverControl)
            lines.push(`#EXT-X-SERVER-CONTROL:${serializeAttributes(playlist.serverControl)}`);
        if (playlist.partTarget !== undefined)
            lines.push(`#EXT-X-PART-INF:PART-TARGET=${playlist.partTarget}`);
        if (playlist.skippedSegments !== undefined)
            lines.push(`#EXT-X-SKIP:SKIPPED-SEGMENTS=${playlist.skippedSegments}`);
        for (const range of playlist.dateRanges ?? [])
            lines.push(`#EXT-X-DATERANGE:${serializeAttributes(range)}`);
        let currentKeys;
        let currentMap;
        let discontinuitySequence = playlist.discontinuitySequence;
        const emitKeys = (value) => {
            const next = activeKeys(value);
            if (keySetText({ keys: currentKeys }) === keySetText({ keys: next }))
                return;
            if (currentKeys?.some(key => !next?.some(item => (item.keyFormat ?? 'identity') === (key.keyFormat ?? 'identity')))) {
                lines.push('#EXT-X-KEY:METHOD=NONE');
            }
            for (const key of next ?? [])
                lines.push(`#EXT-X-KEY:${keyText(key)}`);
            currentKeys = next;
        };
        const emitMap = (map) => {
            if (map) {
                const nextMap = serializeAttributes({
                    URI: map.uri,
                    BYTERANGE: map.byteRange ? rangeText(map.byteRange) : undefined,
                });
                const identity = `${nextMap}|${keySetText(map)}`;
                if (identity !== currentMap) {
                    emitKeys(map);
                    lines.push(`#EXT-X-MAP:${nextMap}`);
                    currentMap = identity;
                }
            }
            else if (currentMap)
                invalid('an initialization map cannot be removed within a playlist');
        };
        const emitPart = (part, index, sequence, context) => {
            if ((part.sequence !== undefined && part.sequence !== sequence) ||
                (part.partIndex !== undefined && part.partIndex !== index) ||
                (part.discontinuitySequence !== undefined && part.discontinuitySequence !== discontinuitySequence) ||
                ((Object.hasOwn(part, 'key') || Object.hasOwn(part, 'keys')) &&
                    keySetText(part) !== keySetText(context)) ||
                (Object.hasOwn(part, 'map') && JSON.stringify(part.map) !== JSON.stringify(context.map)))
                invalid('part context is inconsistent with its parent');
            lines.push(partText(part));
        };
        for (let index = 0; index < playlist.segments.length; index++) {
            const segment = playlist.segments[index];
            if (segment.sequence !== playlist.mediaSequence + (playlist.skippedSegments ?? 0) + index)
                invalid('segment sequence is not contiguous');
            if (segment.discontinuity) {
                lines.push('#EXT-X-DISCONTINUITY');
                discontinuitySequence++;
            }
            if (segment.discontinuitySequence !== discontinuitySequence)
                invalid('segment discontinuity sequence is inconsistent');
            emitMap(segment.map);
            emitKeys(segment);
            if (segment.programDateTime)
                lines.push(`#EXT-X-PROGRAM-DATE-TIME:${required(segment.programDateTime, 'program date time')}`);
            for (const [index, part] of (segment.parts ?? []).entries())
                emitPart(part, index, segment.sequence, segment);
            if (segment.gap)
                lines.push('#EXT-X-GAP');
            if (segment.byteRange)
                lines.push(`#EXT-X-BYTERANGE:${rangeText(segment.byteRange)}`);
            if (/[\r\n\x00]/.test(segment.title ?? ''))
                invalid('segment title contains a control character');
            lines.push(`#EXTINF:${segment.duration},${segment.title ?? ''}`, required(segment.uri, 'segment URI'));
        }
        const trailing = playlist.trailingParts ?? [];
        if (trailing.length) {
            const first = trailing[0];
            if (first.discontinuity) {
                lines.push('#EXT-X-DISCONTINUITY');
                discontinuitySequence++;
            }
            if (first.discontinuitySequence !== undefined && first.discontinuitySequence !== discontinuitySequence)
                invalid('part discontinuity sequence is inconsistent');
            if (Object.hasOwn(first, 'map'))
                emitMap(first.map);
            if (Object.hasOwn(first, 'key') || Object.hasOwn(first, 'keys'))
                emitKeys(first);
            if (first.programDateTime)
                lines.push(`#EXT-X-PROGRAM-DATE-TIME:${required(first.programDateTime, 'program date time')}`);
            const parent = playlist.segments.at(-1);
            const key = Object.hasOwn(first, 'key') ? first.key : parent?.key;
            const keys = Object.hasOwn(first, 'keys')
                ? first.keys
                : Object.hasOwn(first, 'key')
                    ? undefined
                    : activeKeys(parent ?? {});
            const map = Object.hasOwn(first, 'map') ? first.map : parent?.map;
            const sequence = playlist.mediaSequence + (playlist.skippedSegments ?? 0) + playlist.segments.length;
            for (const [index, part] of trailing.entries())
                emitPart(part, index, sequence, { key, keys, map });
        }
        for (const hint of playlist.preloadHints ?? [])
            lines.push(`#EXT-X-PRELOAD-HINT:${serializeAttributes(hint)}`);
        for (const report of playlist.renditionReports ?? [])
            lines.push(`#EXT-X-RENDITION-REPORT:${serializeAttributes(report)}`);
        if (playlist.endList)
            lines.push('#EXT-X-ENDLIST');
    }
    const result = `${lines.join('\n')}\n`;
    parseHlsPlaylist(result, { validation: 'strict' });
    return result;
}
