import { riffInfoKeeps } from './metadata/riff-info';
import { vorbisCommentKeeps } from './metadata/vorbis-comment';
import { id3KeepsTag } from './metadata/id3';
import { matroskaKeepsTag } from './matroska/media-tags';
import { mp4KeepsPicture } from './mp4/metadata';
import { mp4KeepsTag } from './mp4/tags';
import { isIsoOutput } from './shared/capabilities';

/**
 * What a format's writer keeps of a file's tags: the common keys, chapters and pictures it has
 * fields for.
 */
export interface KeptTags {
    readonly entries?: (key: string) => boolean;
    readonly chapters?: boolean;
    readonly pictures?: boolean | ((mimeType: string) => boolean);
}

/**
 * The parts of a file's tags `format` keeps when tracks are copied into it; anything left out is
 * lost.
 */
export function keptTags(format: string): KeptTags {
    if (format === 'mkv') return { entries: matroskaKeepsTag, chapters: true, pictures: true };
    if (format === 'webm') return { entries: matroskaKeepsTag };
    if (isIsoOutput(format))
        return { entries: mp4KeepsTag, chapters: true, pictures: mp4KeepsPicture };
    if (format === 'flac' || format === 'ogg')
        return { entries: vorbisCommentKeeps, chapters: true, pictures: true };
    if (format === 'mp3' || format === 'mp2' || format === 'mp1')
        return { entries: id3KeepsTag, chapters: true, pictures: true };
    if (format === 'wav' || format === 'avi') return { entries: riffInfoKeeps };
    return {};
}
