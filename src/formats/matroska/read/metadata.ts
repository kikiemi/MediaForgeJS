import type { DemuxResult } from '../../../core/model/track';
import { matroskaScopedUids, matroskaTagsElement, parseMatroskaTags } from '../tags';
import { readMatroskaSegmentTitle, readMatroskaTrackTitles } from '../track-titles';
import { readMatroskaMediaTags } from '../media-tags';
import { ID } from '../ebml';

/** The Tags, Chapters and Attachments of a segment as read so far. */
export interface MatroskaMetadata {
    readonly tags: ReturnType<typeof parseMatroskaTags>['tags'];
    chapters?: Uint8Array;
    attachments?: Uint8Array;
    unsupportedTags: boolean;
}

/**
 * Reads one Tags, Chapters or Attachments element (`bytes`, its header included) into `metadata`.
 * Tags that cannot be read are reported with `lost`; Chapters and Attachments whose UIDs do not
 * hold are left out with `omitted`.
 */
export function readMetadataElement(
    id: number,
    bytes: Uint8Array,
    metadata: MatroskaMetadata,
    lost: (message: string) => void,
    omitted: (error: unknown) => void,
): void {
    if (id === ID.Tags) {
        const parsed = parseMatroskaTags(bytes);
        for (const tag of parsed.tags) metadata.tags.push(tag);
        metadata.unsupportedTags ||= parsed.unsupported;
        if (parsed.unsupported) lost('Malformed or unsupported Matroska tags were omitted');
        return;
    }
    try {
        matroskaScopedUids(bytes, id === ID.Chapters ? 'chapters' : 'attachments');
        if (id === ID.Chapters) metadata.chapters = bytes;
        else metadata.attachments = bytes;
    } catch (error) {
        omitted(error);
    }
}

/**
 * The track titles, segment title, pass-through elements and common tags of `result` from the
 * metadata read and the segment Info `title`.
 */
export function settleMetadata(
    result: DemuxResult,
    metadata: MatroskaMetadata,
    title: string | undefined,
): void {
    const tags = matroskaTagsElement(metadata.tags);
    const trackTitles = readMatroskaTrackTitles(tags);
    for (const track of [
        ...result.videoTracks,
        ...result.audioTracks,
        ...(result.subtitleTracks ?? []),
    ]) {
        if (track.matroskaTrackUid !== undefined)
            track.title = trackTitles.get(track.matroskaTrackUid);
    }

    if (title === undefined) {
        const tagged = readMatroskaSegmentTitle(tags);
        if (tagged !== undefined) result.title = tagged;
    }

    const { chapters, attachments } = metadata;
    if (chapters || attachments || title !== undefined || tags) {
        result.matroskaPassThrough = {
            ...(chapters ? { chapters } : {}),
            ...(attachments ? { attachments } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(tags ? { tags } : {}),
        };
        const common = readMatroskaMediaTags({
            ...result.matroskaPassThrough,
            title: result.title ?? title,
        });
        if (common) result.tags = common;
    }
}
