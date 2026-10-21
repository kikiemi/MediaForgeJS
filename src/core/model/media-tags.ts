import type { AttachedPicture, MediaChapter, MediaTags } from './media';

/**
 * The common tag keys: what every container's writer maps to its own fields as far as it has them.
 */
export const COMMON_TAG_KEYS: ReadonlySet<string> = new Set([
    'title',
    'artist',
    'album',
    'albumArtist',
    'comment',
    'description',
    'date',
    'genre',
    'composer',
    'copyright',
    'track',
    'disc',
]);

/** True when `tags` holds anything to write. */
export function hasMediaTags(tags: MediaTags | undefined): tags is MediaTags {
    return (
        !!tags && (tags.entries.length > 0 || !!tags.chapters?.length || !!tags.pictures?.length)
    );
}

/** The first value of a common key. */
export function mediaTag(tags: MediaTags | undefined, key: string): string | undefined {
    return tags?.entries.find(entry => entry.key === key)?.value;
}

/** Tags without empty parts, or undefined when nothing is left. */
export function mediaTags(
    entries: readonly { key: string; value: string }[],
    chapters: readonly MediaChapter[] = [],
    pictures: readonly AttachedPicture[] = [],
): MediaTags | undefined {
    const kept = entries.filter(entry => entry.value.trim() !== '');
    const tags: MediaTags = {
        entries: kept,
        ...(chapters.length ? { chapters: [...chapters].sort((a, b) => a.start - b.start) } : {}),
        ...(pictures.length ? { pictures } : {}),
    };
    return hasMediaTags(tags) ? tags : undefined;
}

/**
 * Chapters whose end is unknown end where the next one starts, the last one at `duration` (the
 * file's end).
 */
export function withChapterEnds(
    tags: MediaTags | undefined,
    duration: number,
): MediaTags | undefined {
    if (!tags?.chapters?.some(chapter => chapter.end === undefined)) return tags;
    const chapters = tags.chapters.map((chapter, index) =>
        chapter.end !== undefined
            ? chapter
            : {
                  ...chapter,
                  end: Math.max(chapter.start, tags.chapters![index + 1]?.start ?? duration),
              },
    );
    return { ...tags, chapters };
}

/** Which parts of `tags` a writer that keeps only `kept` loses: their names for a loss warning. */
export function lostTagParts(
    tags: MediaTags | undefined,
    kept: {
        readonly entries?: (key: string) => boolean;
        readonly chapters?: boolean;
        readonly pictures?: boolean | ((mimeType: string) => boolean);
    },
): string[] {
    const lost: string[] = [];
    const keys = (tags?.entries ?? [])
        .filter(entry => !kept.entries?.(entry.key))
        .map(entry => entry.key);
    if (keys.length) lost.push(`tags (${[...new Set(keys)].join(', ')})`);
    if (tags?.chapters?.length && !kept.chapters) lost.push('chapters');
    const keepsPicture = kept.pictures;
    const pictureKept = (mimeType: string): boolean =>
        typeof keepsPicture === 'function' ? keepsPicture(mimeType) : keepsPicture === true;
    if (tags?.pictures?.some(picture => !pictureKept(picture.mimeType))) lost.push('pictures');
    return lost;
}
