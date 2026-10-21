import { MediaForgeError } from '../../core/errors/errors';
import { MATROSKA_METADATA_LIMIT } from '../metadata/matroska-values';
import { matroskaTagsElement, parseMatroskaTags } from './tags';
import { ebmlElement, ebmlString } from './ebml-write';

interface TitleTrack {
    readonly matroskaTrackUid: bigint;
    readonly title?: string;
}

function fields(bytes: Uint8Array): Array<{ id: number; bytes: Uint8Array }> {
    const output: Array<{ id: number; bytes: Uint8Array }> = [];
    let offset = 0;
    const vint = (id: boolean): number => {
        let width = 1;
        let mask = 0x80;
        while (!(bytes[offset]! & mask)) {
            width++;
            mask >>= 1;
        }

        let value = id ? bytes[offset++]! : bytes[offset++]! & (mask - 1);
        for (let i = 1; i < width; i++) value = value * 256 + bytes[offset++]!;
        return value;
    };

    while (offset < bytes.length) {
        const id = vint(true);
        const size = vint(false);
        output.push({ id, bytes: bytes.subarray(offset, offset + size) });
        offset += size;
    }

    return output;
}

type ParsedTag = ReturnType<typeof parseMatroskaTags>['tags'][number];

const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes).replace(/\0+$/, '');

/** The default, language-neutral TITLE values of one Tag. */
function tagTitles(tag: ParsedTag): string[] {
    const result: string[] = [];
    for (const field of fields(fields(tag.bytes)[0]!.bytes)) {
        if (field.id !== 0x67c8) continue;
        const simple = fields(field.bytes);
        const name = simple.find(item => item.id === 0x45a3);
        const value = simple.find(item => item.id === 0x4487);
        const language = simple.find(item => item.id === 0x447a || item.id === 0x447b);
        const isDefault = simple.find(item => item.id === 0x4484);
        if (
            !name ||
            text(name.bytes) !== 'TITLE' ||
            !value ||
            (language && !['', 'und'].includes(text(language.bytes))) ||
            (isDefault && !isDefault.bytes.some(byte => byte !== 0))
        )
            continue;
        result.push(text(value.bytes));
    }
    return result;
}

function titles(tags: readonly ParsedTag[]): Map<bigint, string> {
    const result = new Map<bigint, string>();
    const ambiguous = new Set<bigint>();
    for (const tag of tags) {
        if (
            !tag.targets.length ||
            tag.targets.some(target => target.kind !== 'track' || target.uid === 0n)
        )
            continue;
        for (const title of tagTitles(tag)) {
            for (const { uid } of tag.targets) {
                if (result.has(uid) && result.get(uid) !== title) ambiguous.add(uid);
                result.set(uid, title);
            }
        }
    }
    for (const uid of ambiguous) result.delete(uid);
    return result;
}

export function readMatroskaTrackTitles(bytes?: Uint8Array): ReadonlyMap<bigint, string> {
    return bytes ? titles(parseMatroskaTags(bytes).tags) : new Map();
}

/**
 * The TITLE of a Tag that targets the whole segment (no target UIDs, TargetTypeValue absent or 50
 * for the movie or album), which names the file when the segment Info carries no Title; undefined
 * when absent or ambiguous.
 */
export function readMatroskaSegmentTitle(bytes?: Uint8Array): string | undefined {
    if (!bytes) return undefined;
    const found = new Set<string>();
    for (const tag of parseMatroskaTags(bytes).tags) {
        if (tag.targets.length) continue;
        const targets = fields(fields(tag.bytes)[0]!.bytes).find(field => field.id === 0x63c0);
        const level = targets && fields(targets.bytes).find(field => field.id === 0x68ca);
        if (level && level.bytes.reduce((value, byte) => value * 256 + byte, 0) !== 50) continue;
        for (const title of tagTitles(tag)) found.add(title);
    }
    return found.size === 1 ? found.values().next().value : undefined;
}

export function mergeMatroskaTrackTitles(
    bytes: Uint8Array | undefined,
    tracks: readonly TitleTrack[],
): Uint8Array | undefined {
    const parsed = bytes ? parseMatroskaTags(bytes) : { tags: [], unsupported: false };
    if (parsed.unsupported) throw new MediaForgeError('Invalid Matroska title metadata', 'FORMAT');
    const existing = titles(parsed.tags);
    const tags: Array<{ bytes: Uint8Array }> = [...parsed.tags];
    for (const { matroskaTrackUid: uid, title } of tracks) {
        if (title === undefined) continue;
        if (
            typeof title !== 'string' ||
            title.includes('\0') ||
            title.length > MATROSKA_METADATA_LIMIT ||
            typeof uid !== 'bigint' ||
            uid < 1n ||
            uid > 0xffffffffffffffffn
        )
            throw new MediaForgeError('Invalid Matroska track title or UID', 'FORMAT');
        if (existing.has(uid)) {
            if (existing.get(uid) !== title)
                throw new MediaForgeError('Conflicting Matroska track titles', 'FORMAT');
            continue;
        }

        const uidBytes = new Uint8Array(8);
        new DataView(uidBytes.buffer).setBigUint64(0, uid);
        const value = new TextEncoder().encode(title);
        if (value.length > MATROSKA_METADATA_LIMIT)
            throw new MediaForgeError('Matroska track title is too large', 'FORMAT');
        tags.push({
            bytes: ebmlElement(
                0x7373,
                ebmlElement(0x63c0, ebmlElement(0x63c5, uidBytes)),
                ebmlElement(0x67c8, ebmlString(0x45a3, 'TITLE'), ebmlElement(0x4487, value)),
            ),
        });
        existing.set(uid, title);
    }

    return matroskaTagsElement(tags);
}
