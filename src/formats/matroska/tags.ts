import { DemuxError } from '../../core/errors/errors';
import { malformedInput } from '../../core/errors/demux-guard';
import { crc32 } from '../../core/bytes/crc32';
import { ebmlElement } from './ebml-write';
import type { MatroskaPassThrough } from '../../core/model/media';
import { MATROSKA_METADATA_LIMIT, matroskaUid } from '../metadata/matroska-values';
const MAX_NODES = 100000;
const MAX_DEPTH = 32;
const TAGS = 0x1254c367;
const TAG = 0x7373;
const TARGETS = 0x63c0;
const SIMPLE_TAG = 0x67c8;
const TARGET_KINDS = new Map<number, TargetKind>([
    [0x63c5, 'track'],
    [0x63c9, 'edition'],
    [0x63c4, 'chapter'],
    [0x63c6, 'attachment'],
]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

type TargetKind = 'track' | 'edition' | 'chapter' | 'attachment';

interface Element {
    id: number;
    start: number;
    dataStart: number;
    end: number;
}

interface Budget {
    nodes: number;
    crcBytes: number;
    crcLimit: number;
}

interface Tag {
    bytes: Uint8Array;
    targets: Array<{ kind: TargetKind; uid: bigint }>;
}

interface ParsedTags {
    tags: Tag[];
    unsupported: boolean;
}

export interface MatroskaTrackIdentity {
    readonly matroskaTrackUid?: bigint;
    readonly title?: string;
}

function invalid(message: string): never {
    malformedInput(`Matroska metadata ${message}`);
}

function header(bytes: Uint8Array, start: number, end: number): Element {
    let pos = start;
    const vint = (id: boolean): number => {
        if (pos >= end || bytes[pos] === 0) invalid('has a truncated element header');
        let width = 1;
        let mask = 0x80;
        while ((bytes[pos]! & mask) === 0) {
            width++;
            mask >>= 1;
        }

        if (width > (id ? 4 : 8) || pos + width > end) invalid('has an invalid element header');
        let value = BigInt(id ? bytes[pos]! : bytes[pos]! & (mask - 1));
        for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[pos + i]!);
        pos += width;
        if (!id && value === (1n << BigInt(7 * width)) - 1n) invalid('has an unknown-size element');
        if (value > BigInt(Number.MAX_SAFE_INTEGER))
            invalid('element size exceeds the safe integer range');
        return Number(value);
    };

    const id = vint(true);
    const size = vint(false);
    if (size > end - pos) invalid('element exceeds its parent');
    return { id, start, dataStart: pos, end: pos + size };
}

function children(bytes: Uint8Array, start: number, end: number, budget: Budget): Element[] {
    const result: Element[] = [];
    let crc: Element | undefined;
    for (let pos = start; pos < end;) {
        if (++budget.nodes > MAX_NODES) invalid('exceeds the element count limit');
        const el = header(bytes, pos, end);
        if (el.id === 0xbf) {
            if (crc || el.end - el.dataStart !== 4) invalid('has an invalid CRC-32 element');
            crc = el;
        }

        result.push(el);
        pos = el.end;
    }

    if (crc) {
        const count = end - start - (crc.end - crc.start);
        if (count > budget.crcLimit - budget.crcBytes) invalid('exceeds the CRC work limit');
        budget.crcBytes += count;
        const value = crc32(bytes.subarray(crc.end, end), crc32(bytes.subarray(start, crc.start)));
        const expected = new DataView(bytes.buffer, bytes.byteOffset + crc.dataStart, 4).getUint32(
            0,
            true,
        );
        if (value !== expected) invalid('CRC-32 does not match');
    }

    return result;
}

function text(bytes: Uint8Array, el: Element): void {
    let value: string;
    try {
        value = UTF8.decode(bytes.subarray(el.dataStart, el.end));
    } catch {
        invalid('text is not valid UTF-8');
    }
    if (value!.replace(/\0+$/, '').includes('\0')) invalid('text contains an embedded NUL');
}

function simpleTag(bytes: Uint8Array, parent: Element, budget: Budget, depth: number): void {
    if (depth > MAX_DEPTH) invalid('exceeds the nesting depth limit');
    let names = 0;
    let values = 0;
    for (const el of children(bytes, parent.dataStart, parent.end, budget)) {
        if (el.id === SIMPLE_TAG) simpleTag(bytes, el, budget, depth + 1);
        else if (el.id === 0x45a3 || el.id === 0x4487 || el.id === 0x447a || el.id === 0x447b) {
            text(bytes, el);
            if (el.id === 0x45a3) names++;
            if (el.id === 0x4487) values++;
        } else if (el.id === 0x4485) values++;
        else if (el.id === 0x4484 && matroskaUid(bytes, el.dataStart, el.end) > 1n)
            invalid('TagDefault must be zero or one');
    }
    if (names !== 1 || values > 1) invalid('SimpleTag has an invalid name or value count');
}

function parseTag(bytes: Uint8Array, parent: Element, budget: Budget): Tag {
    const targets: Tag['targets'] = [];
    let targetCount = 0;
    let simpleCount = 0;
    for (const field of children(bytes, parent.dataStart, parent.end, budget)) {
        if (field.id === TARGETS) {
            if (++targetCount > 1) invalid('Tag contains multiple Targets elements');
            for (const el of children(bytes, field.dataStart, field.end, budget)) {
                const kind = TARGET_KINDS.get(el.id);
                if (kind) targets.push({ kind, uid: matroskaUid(bytes, el.dataStart, el.end) });
                else if (el.id === 0x63ca) text(bytes, el);
                else if (el.id === 0x68ca) matroskaUid(bytes, el.dataStart, el.end);
                else if (el.id !== 0xec && el.id !== 0xbf)
                    invalid('contains an unsupported target');
            }
        } else if (field.id === SIMPLE_TAG) {
            simpleTag(bytes, field, budget, 1);
            simpleCount++;
        } else if (field.id !== 0xec && field.id !== 0xbf)
            invalid('contains an unsupported Tag field');
    }

    if (!simpleCount) invalid('Tag does not contain a SimpleTag');
    return { bytes: bytes.slice(parent.start, parent.end), targets };
}

export function parseMatroskaTags(bytes: Uint8Array, payload = false): ParsedTags {
    const tags: Tag[] = [];
    let unsupported = false;
    if (bytes.length > MATROSKA_METADATA_LIMIT) return { tags, unsupported: true };
    const budget = {
        nodes: 0,
        crcBytes: 0,
        crcLimit: Math.min(bytes.length * 4, MATROSKA_METADATA_LIMIT * 4),
    };

    try {
        const root = payload ? { dataStart: 0, end: bytes.length } : header(bytes, 0, bytes.length);
        if (!payload && ((root as Element).id !== TAGS || root.end !== bytes.length))
            invalid('must be a complete Tags element');
        for (const el of children(bytes, root.dataStart, root.end, budget)) {
            if (el.id === 0xec || el.id === 0xbf) continue;
            try {
                if (el.id !== TAG) invalid('contains an unsupported Tags child');
                tags.push(parseTag(bytes, el, budget));
            } catch (error) {
                if (!(error instanceof DemuxError)) throw error;
                unsupported = true;
            }
        }
    } catch (error) {
        if (!(error instanceof DemuxError)) throw error;
        unsupported = true;
    }

    return { tags, unsupported };
}

export function matroskaTagsElement(
    tags: readonly { bytes: Uint8Array }[],
): Uint8Array | undefined {
    if (!tags.length) return undefined;
    const size = tags.reduce((total, tag) => total + tag.bytes.length, 0);
    if (size > MATROSKA_METADATA_LIMIT) invalid('Tags exceed the byte limit');
    return ebmlElement(TAGS, ...tags.map(tag => tag.bytes));
}

export function matroskaScopedUids(
    bytes: Uint8Array,
    kind: 'chapters' | 'attachments',
): Map<TargetKind, Set<bigint>> {
    if (bytes.length > MATROSKA_METADATA_LIMIT) invalid('exceeds the byte limit');
    const result = new Map<TargetKind, Set<bigint>>();
    const root = header(bytes, 0, bytes.length);
    if (root.id !== (kind === 'chapters' ? 0x1043a770 : 0x1941a469) || root.end !== bytes.length)
        invalid('has an invalid outer element');
    const masters = new Set(
        kind === 'chapters' ? [0x45b9, 0xb6, 0x80, 0x6944, 0x6911, 0x8f] : [0x61a7],
    );
    const uidKinds = new Map<number, TargetKind>(
        kind === 'chapters'
            ? [
                  [0x45bc, 'edition'],
                  [0x73c4, 'chapter'],
              ]
            : [[0x46ae, 'attachment']],
    );

    const budget = {
        nodes: 0,
        crcBytes: 0,
        crcLimit: Math.min(bytes.length * 4, MATROSKA_METADATA_LIMIT * 4),
    };

    const visit = (parent: Element, depth: number): void => {
        if (depth > MAX_DEPTH) invalid('exceeds the nesting depth limit');
        for (const el of children(bytes, parent.dataStart, parent.end, budget)) {
            const targetKind = uidKinds.get(el.id);
            if (targetKind) {
                const uid = matroskaUid(bytes, el.dataStart, el.end);
                let set = result.get(targetKind);
                if (!set) result.set(targetKind, (set = new Set()));
                if (uid === 0n || set.has(uid)) invalid('contains a zero or duplicate UID');
                set.add(uid);
            } else if (masters.has(el.id)) visit(el, depth + 1);
        }
    };

    visit(root, 0);
    return result;
}

export function filterMatroskaTags(
    pass: MatroskaPassThrough,
    format: string,
    tracks?: readonly MatroskaTrackIdentity[],
): { tags?: Uint8Array; unsupported: boolean } {
    if (!pass.tags) return { unsupported: false };
    const parsed = parseMatroskaTags(pass.tags);
    const uids = new Map<TargetKind, Set<bigint>>();
    if (tracks) {
        const counts = new Map<bigint, number>();
        for (const track of tracks)
            if (track.matroskaTrackUid !== undefined) {
                counts.set(track.matroskaTrackUid, (counts.get(track.matroskaTrackUid) ?? 0) + 1);
            }
        uids.set(
            'track',
            new Set([...counts].filter(([, count]) => count === 1).map(([uid]) => uid)),
        );
    }

    for (const kind of ['chapters', 'attachments'] as const) {
        const bytes = pass[kind];
        if (format !== 'mkv' || !bytes) continue;
        try {
            for (const [target, set] of matroskaScopedUids(bytes, kind)) uids.set(target, set);
        } catch (error) {
            if (!(error instanceof DemuxError)) throw error;
            parsed.unsupported = true;
        }
    }

    const kept = parsed.tags.filter(tag => {
        const keep = tag.targets.every(({ kind, uid }) => {
            if (kind === 'track') {
                if (!tracks) return true;
                if (uid === 0n) return tracks.length > 0;
            }
            const set = uids.get(kind);
            return uid === 0n ? !!set?.size : set?.has(uid) === true;
        });
        if (!keep) parsed.unsupported = true;
        return keep;
    });

    return { tags: matroskaTagsElement(kept), unsupported: parsed.unsupported };
}
