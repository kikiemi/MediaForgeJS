import type { Source } from '../../model/types';
import { IOError, MediaForgeError } from '../../errors/errors';
import {
    assertSourceBytes,
    registerOwnedReads,
    returnsOwnedBytes,
    sourceReadEnd,
} from './source-read';
import { readerInto, registerReadInto } from '../../bytes/read-into';

interface SourceLeaf {
    readonly source: Source;
    readonly read: Source['read'];
    readonly offset: number;
    readonly size: number;
    readonly height: 1;
}

interface SourceBranch {
    readonly left: SourceNode;
    readonly right: SourceNode;
    readonly size: number;
    readonly height: number;
}

export type SourceNode = SourceLeaf | SourceBranch;

/**
 * A source whose bytes are a tree of ranges of other sources, read by gathering those ranges. A
 * rope built over another rope shares its tree rather than reading through it. The tree is a field
 * of the rope rather than the value of a weakly keyed registry: V8 clears such entries only in full
 * collections, so a registry would keep the bytes of every short-lived rope (one per window of a
 * stream) until then.
 */
export class SourceRope implements Source {
    readonly size: number;
    readonly #tree: SourceNode | null;
    readonly #name: string;

    constructor(tree: SourceNode | null, name: string) {
        this.size = tree?.size ?? 0;
        this.#tree = tree;
        this.#name = name;
        registerOwnedReads(this, intrinsicRead);
        registerReadInto(this, intrinsicRead, SourceRope.prototype.readInto);
    }

    read(offset: number, length: number): Promise<Uint8Array> {
        return readSourceRoot(this.#tree, this.size, offset, length, this.#name);
    }

    /**
     * Fills `target` from `offset`: each range reads into its part, or is read and copied there.
     */
    async readInto(offset: number, target: Uint8Array): Promise<void> {
        const end = sourceReadEnd(offset, target.length, this.size);
        if (end - offset !== target.length) throw new IOError(`${this.#name} read past its end`);
        await visitRanges(this.#tree, offset, end, async (leaf, from, count) => {
            const part = target.subarray(from - offset, from - offset + count);
            const into = readerInto(leaf.source, leaf.read);
            if (into) return into(leaf.offset + (from - leaf.start), part);
            const bytes = await leaf.read.call(
                leaf.source,
                leaf.offset + (from - leaf.start),
                count,
            );
            assertSourceBytes(bytes, count, this.#name);
            part.set(bytes);
        });
    }

    /**
     * The tree of a rope read with its own `read` and of `size` bytes; undefined for any other
     * source.
     */
    static treeOf(
        source: Source,
        read: Source['read'],
        size: number,
    ): SourceNode | null | undefined {
        return #tree in source && read === intrinsicRead && source.#tree?.size === size
            ? source.#tree
            : undefined;
    }
}

const intrinsicRead = SourceRope.prototype.read;

/** The tree of `source`: a rope's own, else the whole source as one leaf. */
export function captureSourceRoot(source: Source, name: string): SourceNode | null {
    let size: number;
    let read: Source['read'];
    try {
        size = source.size;
        read = source.read;
    } catch {
        throw new MediaForgeError(`${name} requires a readable Source`, 'INPUT');
    }
    if (!Number.isSafeInteger(size) || size < 0 || typeof read !== 'function') {
        throw new MediaForgeError(
            `${name} requires a non-negative safe source size and read method`,
            'INPUT',
        );
    }
    if (size === 0) return null;
    return SourceRope.treeOf(source, read, size) ?? { source, read, offset: 0, size, height: 1 };
}

export function sourceRangeLength(
    size: number,
    offset: number,
    length: number | undefined,
    name: string,
): number {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
        throw new MediaForgeError(`${name} offset must be within the source`, 'INPUT');
    }
    const count = length === undefined ? size - offset : length;
    if (!Number.isSafeInteger(count) || count < 0 || count > size - offset) {
        throw new MediaForgeError(`${name} length must fit within the source`, 'INPUT');
    }
    return count;
}

function branch(left: SourceNode, right: SourceNode): SourceBranch {
    return {
        left,
        right,
        size: left.size + right.size,
        height: 1 + Math.max(left.height, right.height),
    };
}

function balance(left: SourceNode, right: SourceNode): SourceNode {
    if ('left' in left && left.height > right.height + 1) {
        if (left.left.height >= left.right.height)
            return branch(left.left, branch(left.right, right));
        const middle = left.right as SourceBranch;
        return branch(branch(left.left, middle.left), branch(middle.right, right));
    }
    if ('left' in right && right.height > left.height + 1) {
        if (right.right.height >= right.left.height)
            return branch(branch(left, right.left), right.right);
        const middle = right.left as SourceBranch;
        return branch(branch(left, middle.left), branch(middle.right, right.right));
    }
    return branch(left, right);
}

function join(left: SourceNode, right: SourceNode): SourceNode {
    if ('left' in left && left.height > right.height + 1)
        return balance(left.left, join(left.right, right));
    if ('left' in right && right.height > left.height + 1)
        return balance(join(left, right.left), right.right);
    return branch(left, right);
}

export function joinSourceRoots(
    left: SourceNode | null,
    right: SourceNode | null,
): SourceNode | null {
    if (!left) return right;
    if (!right) return left;
    if (right.size > Number.MAX_SAFE_INTEGER - left.size)
        throw new IOError('ConcatSource size exceeds the safe integer limit');
    return join(left, right);
}

export function sliceSourceRoot(
    root: SourceNode | null,
    offset: number,
    count: number,
): SourceNode | null {
    if (!root || count === 0) return null;
    if (offset === 0 && count === root.size) return root;
    if (!('left' in root)) return { ...root, offset: root.offset + offset, size: count };
    const middle = root.left.size;
    if (offset >= middle) return sliceSourceRoot(root.right, offset - middle, count);
    if (count <= middle - offset) return sliceSourceRoot(root.left, offset, count);
    return joinSourceRoots(
        sliceSourceRoot(root.left, offset, middle - offset),
        sliceSourceRoot(root.right, 0, count - (middle - offset)),
    );
}

function leafCovering(
    root: SourceNode,
    offset: number,
    end: number,
): { node: SourceLeaf; start: number } | null {
    let node = root;
    let start = 0;
    while ('left' in node) {
        const middle = start + node.left.size;
        if (end <= middle) node = node.left;
        else if (offset >= middle) {
            node = node.right;
            start = middle;
        } else return null;
    }
    return { node, start };
}

async function readSourceRoot(
    root: SourceNode | null,
    size: number,
    offset: number,
    length: number,
    name: string,
): Promise<Uint8Array> {
    const end = sourceReadEnd(offset, length, size);
    if (end <= offset || !root) return new Uint8Array(0);
    const leaf = leafCovering(root, offset, end);
    if (leaf && returnsOwnedBytes(leaf.node.source)) {
        const count = end - offset;
        const bytes = await leaf.node.read.call(
            leaf.node.source,
            leaf.node.offset + (offset - leaf.start),
            count,
        );
        assertSourceBytes(bytes, count, name);
        return bytes;
    }
    const output = new Uint8Array(end - offset);
    await visitRanges(root, offset, end, async (leaf, from, count) => {
        const bytes = await leaf.read.call(leaf.source, leaf.offset + (from - leaf.start), count);
        assertSourceBytes(bytes, count, name);
        output.set(bytes, from - offset);
    });
    return output;
}

/**
 * Calls `part` in order for each leaf covering bytes of [offset, end): the leaf, where it starts,
 * the first byte and count.
 */
async function visitRanges(
    root: SourceNode | null,
    offset: number,
    end: number,
    part: (
        leaf: SourceLeaf & { readonly start: number },
        from: number,
        count: number,
    ) => Promise<void>,
): Promise<void> {
    if (!root || end <= offset) return;
    const pending: Array<{ node: SourceNode; start: number }> = [{ node: root, start: 0 }];
    while (pending.length > 0) {
        const { node, start } = pending.pop()!;
        if ('left' in node) {
            const middle = start + node.left.size;
            if (end > middle) pending.push({ node: node.right, start: middle });
            if (offset < middle) pending.push({ node: node.left, start });
        } else {
            const from = Math.max(offset, start);
            await part({ ...node, start }, from, Math.min(end, start + node.size) - from);
        }
    }
}
