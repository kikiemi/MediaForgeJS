import type { MediaTags } from '../../core/model/media';
import { hasMediaTags } from '../../core/model/media-tags';
import { dataView } from '../../core/bytes/byte-fields';
import {
    flacPictureBody,
    vorbisCommentPayload,
    vorbisCommentTags,
} from '../metadata/vorbis-comment';

/**
 * The FLAC header with a VORBIS_COMMENT block and PICTURE blocks of `tags` added where the source's
 * metadata chain has none (a FLAC input keeps its own blocks as they are). Pictures a kept comment
 * block carries as METADATA_BLOCK_PICTURE (Ogg FLAC, some taggers) are the source's own too.
 */
export function flacHeaderWithTags(header: Uint8Array, tags: MediaTags | undefined): Uint8Array {
    if (!hasMediaTags(tags)) return header;

    const blocks: { type: number; body: Uint8Array }[] = [];
    for (let at = 4; at + 4 <= header.length;) {
        const type = header[at]! & 0x7f;
        const size = (header[at + 1]! << 16) | (header[at + 2]! << 8) | header[at + 3]!;
        blocks.push({ type, body: header.subarray(at + 4, at + 4 + size) });
        if (header[at]! & 0x80) break;
        at += 4 + size;
    }

    const comment = blocks.find(block => block.type === 4);
    if (!comment)
        blocks.push({
            type: 4,
            body: vorbisCommentPayload('MediaForgeJS', { ...tags, pictures: [] }),
        });
    const pictured =
        blocks.some(block => block.type === 6) ||
        !!(comment && vorbisCommentTags(comment.body)?.pictures?.length);
    if (!pictured)
        for (const picture of tags.pictures ?? [])
            blocks.push({ type: 6, body: flacPictureBody(picture) });

    const kept = blocks.filter(block => block.body.length < 1 << 24);
    const out = new Uint8Array(4 + kept.reduce((sum, block) => sum + 4 + block.body.length, 0));
    out.set(header.subarray(0, 4));
    let at = 4;
    kept.forEach((block, index) => {
        out[at] = block.type | (index === kept.length - 1 ? 0x80 : 0);
        out.set(
            [block.body.length >> 16, (block.body.length >> 8) & 255, block.body.length & 255],
            at + 1,
        );
        out.set(block.body, at + 4);
        at += 4 + block.body.length;
    });
    return out;
}

/**
 * A WAVE header with a LIST/INFO chunk before its data chunk, the RIFF (or RF64 ds64) size grown to
 * include it.
 */
export function riffWithInfo(header: Uint8Array, info: Uint8Array | undefined): Uint8Array {
    if (!info) return header;
    const view = dataView(header);
    let at = 12;
    while (
        at + 8 <= header.length &&
        String.fromCharCode(...header.subarray(at, at + 4)) !== 'data'
    )
        at += 8 + view.getUint32(at + 4, true) + (view.getUint32(at + 4, true) & 1);
    if (at + 8 > header.length) return header;
    const out = new Uint8Array(header.length + info.length);
    out.set(header.subarray(0, at));
    out.set(info, at);
    out.set(header.subarray(at), at + info.length);
    const target = new DataView(out.buffer);
    if (String.fromCharCode(...out.subarray(0, 4)) === 'RF64')
        target.setBigUint64(20, target.getBigUint64(20, true) + BigInt(info.length), true);
    else target.setUint32(4, target.getUint32(4, true) + info.length, true);
    return out;
}
