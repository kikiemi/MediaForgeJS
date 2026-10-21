/**
 * The formats both scripts carry: subtitles (WebVTT, SRT, ASS, TTML) and metadata (ID3, emsg,
 * track JSON). mediaforgejs/formats adds the readers and writers of every container.
 */
export type {
    SubtitleCue,
    SubtitleBlock,
    SubtitleTimestampMap,
    SubtitleDocument,
    SubtitleOptions,
    SubtitleTrackConfig,
    SubtitleFormat,
    SubtitleFormatInput,
    AssCueData,
    AssDocumentData,
    AssSubtitleOptions,
    TtmlSpan,
    TtmlCueData,
    TtmlDocumentData,
    ParseSubtitleOptions,
} from '../formats/text/types';
export {
    parseSubtitleTimestamp,
    formatSubtitleTimestamp,
    parseWebVtt,
    parseSrt,
    writeWebVtt,
    writeSrt,
    makeWebVttCodecConfig,
} from '../formats/text/subtitles';
export type { WebVttSampleCue, WebVttSample } from '../formats/text/webvtt-mp4';
export {
    encodeWebVttSample,
    decodeWebVttSample,
    encodeWebVttBlock,
    decodeWebVttBlock,
    subtitleTrackConfig,
    toSubtitleChunks,
} from '../formats/text/webvtt-mp4';
export { parseAssTimestamp, formatAssTimestamp, parseAss, writeAss } from '../formats/text/ass';
export type { TtmlTimingParameters } from '../formats/text/ttml';
export { parseTtmlTimestamp, parseTtml, writeTtml } from '../formats/text/ttml';
export { detectSubtitleFormat, parseSubtitles, writeSubtitles } from '../formats/text/interchange';

export { editSubtitles } from '../formats/text/edit';
export type { SubtitleEditOptions } from '../formats/text/edit';
export type {
    MetadataValue,
    MetadataEntry,
    MetadataChapter,
    OpaqueMetadata,
    MediaMetadata,
    MetadataInput,
    MetadataOptions,
} from '../formats/metadata/types';
export { normalizeMetadata } from '../formats/metadata/normalized';
export { serializeTracks, deserializeTracks } from '../formats/metadata/track-json';
export type { Id3Frame, Id3Tag } from '../formats/metadata/id3';
export { parseId3Tag, writeId3Tag, createId3Tag } from '../formats/metadata/id3';
export type { EventMessage } from '../formats/metadata/emsg';
export { encodeEventMessage, decodeEventMessage, eventMessageTime } from '../formats/metadata/emsg';
