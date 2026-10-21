import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import {
    activeKeys,
    integer,
    parseHlsPlaylist,
    programDateTime,
    required,
    type HlsByteRange,
    type HlsKey,
    type HlsMap,
    type HlsPart,
    type HlsPlaylist,
} from './playlist';

// Playlists written back as text (mediaforgejs/streaming); the reading half of the library only
// parses them. A playlist HLS cannot state is refused with FORMAT, as a writer refuses a track its
// container cannot carry.

function unwritable(message: string): never {
    throw new MediaForgeError(`HLS: ${message}`, 'FORMAT');
}

function quote(value: string): string {
    if (/["\r\n\x00]/.test(value)) unwritable('attribute contains a quote or control character');
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

function serializeAttributes(
    values: Record<string, string | number | boolean | undefined>,
): string {
    return Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => {
            if (!/^[A-Z0-9-]+$/.test(name)) unwritable('invalid attribute name');
            const text = typeof value === 'boolean' ? (value ? 'YES' : 'NO') : String(value);
            if (/[\r\n\x00]/.test(text)) unwritable('attribute contains a control character');
            const unquoted =
                unquotedAttributes.has(name) || (name === 'CLOSED-CAPTIONS' && text === 'NONE');
            if (unquoted && /[",\s]/.test(text)) unwritable(`invalid ${name} attribute`);
            return `${name}=${unquoted ? text : quote(text)}`;
        })
        .join(',');
}

function rangeText(range: HlsByteRange): string {
    const length = integer(range.length, 'byte range length', 1);
    const offset = integer(range.offset, 'byte range offset');
    if (!Number.isSafeInteger(offset + length))
        unwritable('byte range exceeds safe integer precision');
    return `${length}@${offset}`;
}

function keyText(key?: HlsKey): string {
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

function keySetText(value: { key?: HlsKey; keys?: HlsKey[] }): string {
    return JSON.stringify((activeKeys(value) ?? []).map(key => keyText(key)));
}

function partText(part: HlsPart): string {
    return `#EXT-X-PART:${serializeAttributes({
        URI: part.uri,
        DURATION: part.duration,
        INDEPENDENT: part.independent,
        GAP: part.gap,
        BYTERANGE: part.byteRange ? rangeText(part.byteRange) : undefined,
    })}`;
}

export function serializeHlsPlaylist(playlist: HlsPlaylist): string {
    try {
        return playlistText(playlist);
    } catch (error) {
        // The parser's checks of its values, and of the text read back, refuse what HLS cannot
        // state.
        if (error instanceof DemuxError)
            throw new MediaForgeError(error.message, 'FORMAT', { cause: error });
        throw error;
    }
}

function playlistText(playlist: HlsPlaylist): string {
    const lines = ['#EXTM3U'];
    const media = playlist.type === 'media' ? playlist : undefined;
    const minimumVersion =
        media?.partTarget !== undefined ||
        media?.trailingParts?.length ||
        media?.serverControl ||
        media?.preloadHints?.length ||
        media?.renditionReports?.length ||
        media?.skippedSegments !== undefined ||
        media?.segments.some(segment => segment.parts?.length)
            ? 9
            : 7;

    lines.push(`#EXT-X-VERSION:${Math.max(minimumVersion, playlist.version ?? 1)}`);
    if (playlist.independentSegments) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
    if (playlist.start) lines.push(`#EXT-X-START:${serializeAttributes(playlist.start)}`);
    if (playlist.type === 'master') {
        for (const rendition of playlist.renditions) {
            lines.push(
                `#EXT-X-MEDIA:${serializeAttributes({
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
                })}`,
            );
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
                RESOLUTION: variant.resolution
                    ? `${variant.resolution.width}x${variant.resolution.height}`
                    : undefined,
                'FRAME-RATE': variant.frameRate,
                AUDIO: variant.audio,
                VIDEO: variant.video,
                SUBTITLES: variant.subtitles,
                'CLOSED-CAPTIONS': variant.closedCaptions,
            });
            lines.push(`#EXT-X-${variant.iframe ? 'I-FRAME-STREAM-INF' : 'STREAM-INF'}:${attrs}`);
            if (!variant.iframe) lines.push(required(variant.uri, 'variant URI'));
        }
    } else {
        lines.push(
            `#EXT-X-TARGETDURATION:${playlist.targetDuration}`,
            `#EXT-X-MEDIA-SEQUENCE:${playlist.mediaSequence}`,
            `#EXT-X-DISCONTINUITY-SEQUENCE:${playlist.discontinuitySequence}`,
        );
        if (playlist.playlistType) lines.push(`#EXT-X-PLAYLIST-TYPE:${playlist.playlistType}`);
        if (playlist.iframeOnly) lines.push('#EXT-X-I-FRAMES-ONLY');
        if (playlist.serverControl)
            lines.push(`#EXT-X-SERVER-CONTROL:${serializeAttributes(playlist.serverControl)}`);
        if (playlist.partTarget !== undefined)
            lines.push(`#EXT-X-PART-INF:PART-TARGET=${playlist.partTarget}`);
        if (playlist.skippedSegments !== undefined)
            lines.push(`#EXT-X-SKIP:SKIPPED-SEGMENTS=${playlist.skippedSegments}`);
        for (const range of playlist.dateRanges ?? [])
            lines.push(`#EXT-X-DATERANGE:${serializeAttributes(range)}`);
        let currentKeys: HlsKey[] | undefined;
        let currentMap: string | undefined;
        let discontinuitySequence = playlist.discontinuitySequence;
        const emitKeys = (value: { key?: HlsKey; keys?: HlsKey[] }): void => {
            const next = activeKeys(value);
            if (keySetText({ keys: currentKeys }) === keySetText({ keys: next })) return;
            if (
                currentKeys?.some(
                    key =>
                        !next?.some(
                            item =>
                                (item.keyFormat ?? 'identity') === (key.keyFormat ?? 'identity'),
                        ),
                )
            ) {
                lines.push('#EXT-X-KEY:METHOD=NONE');
            }

            for (const key of next ?? []) lines.push(`#EXT-X-KEY:${keyText(key)}`);
            currentKeys = next;
        };

        const emitMap = (map?: HlsMap): void => {
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
            } else if (currentMap)
                unwritable('an initialization map cannot be removed within a playlist');
        };

        const emitPart = (
            part: HlsPart,
            index: number,
            sequence: number,
            context: { key?: HlsKey; keys?: HlsKey[]; map?: HlsMap },
        ): void => {
            if (
                (part.sequence !== undefined && part.sequence !== sequence) ||
                (part.partIndex !== undefined && part.partIndex !== index) ||
                (part.discontinuitySequence !== undefined &&
                    part.discontinuitySequence !== discontinuitySequence) ||
                ((Object.hasOwn(part, 'key') || Object.hasOwn(part, 'keys')) &&
                    keySetText(part) !== keySetText(context)) ||
                (Object.hasOwn(part, 'map') &&
                    JSON.stringify(part.map) !== JSON.stringify(context.map))
            )
                unwritable('part context is inconsistent with its parent');
            lines.push(partText(part));
        };

        for (let index = 0; index < playlist.segments.length; index++) {
            const segment = playlist.segments[index];
            if (
                segment.sequence !==
                playlist.mediaSequence + (playlist.skippedSegments ?? 0) + index
            )
                unwritable('segment sequence is not contiguous');

            if (segment.discontinuity) {
                lines.push('#EXT-X-DISCONTINUITY');
                discontinuitySequence++;
            }

            if (segment.discontinuitySequence !== discontinuitySequence)
                unwritable('segment discontinuity sequence is inconsistent');
            emitMap(segment.map);
            emitKeys(segment);
            if (segment.programDateTime) lines.push(programDateTime(segment.programDateTime));
            for (const [index, part] of (segment.parts ?? []).entries())
                emitPart(part, index, segment.sequence, segment);
            if (segment.gap) lines.push('#EXT-X-GAP');
            if (segment.byteRange) lines.push(`#EXT-X-BYTERANGE:${rangeText(segment.byteRange)}`);
            if (/[\r\n\x00]/.test(segment.title ?? ''))
                unwritable('segment title contains a control character');
            lines.push(
                `#EXTINF:${segment.duration},${segment.title ?? ''}`,
                required(segment.uri, 'segment URI'),
            );
        }

        const trailing = playlist.trailingParts ?? [];
        if (trailing.length) {
            const first = trailing[0];
            if (first.discontinuity) {
                lines.push('#EXT-X-DISCONTINUITY');
                discontinuitySequence++;
            }

            if (
                first.discontinuitySequence !== undefined &&
                first.discontinuitySequence !== discontinuitySequence
            )
                unwritable('part discontinuity sequence is inconsistent');

            if (Object.hasOwn(first, 'map')) emitMap(first.map);
            if (Object.hasOwn(first, 'key') || Object.hasOwn(first, 'keys')) emitKeys(first);
            if (first.programDateTime) lines.push(programDateTime(first.programDateTime));
            const parent = playlist.segments.at(-1);
            const key = Object.hasOwn(first, 'key') ? first.key : parent?.key;
            const keys = Object.hasOwn(first, 'keys')
                ? first.keys
                : Object.hasOwn(first, 'key')
                  ? undefined
                  : activeKeys(parent ?? {});

            const map = Object.hasOwn(first, 'map') ? first.map : parent?.map;
            const sequence =
                playlist.mediaSequence + (playlist.skippedSegments ?? 0) + playlist.segments.length;
            for (const [index, part] of trailing.entries())
                emitPart(part, index, sequence, { key, keys, map });
        }

        for (const hint of playlist.preloadHints ?? [])
            lines.push(`#EXT-X-PRELOAD-HINT:${serializeAttributes(hint)}`);
        for (const report of playlist.renditionReports ?? [])
            lines.push(`#EXT-X-RENDITION-REPORT:${serializeAttributes(report)}`);
        if (playlist.endList) lines.push('#EXT-X-ENDLIST');
    }

    const result = `${lines.join('\n')}\n`;
    parseHlsPlaylist(result, { validation: 'strict' });
    return result;
}
