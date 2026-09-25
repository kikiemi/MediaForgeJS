import { IOError } from '../core/errors.js';
import { assertSourceBytes, sourceReadEnd } from './source-read.js';
const roots = new WeakMap();
export function registerSourceRoot(source, read, root) {
    roots.set(source, { read, root });
}
export function captureSourceRoot(source, name) {
    let size;
    let read;
    try {
        size = source.size;
        read = source.read;
    }
    catch {
        throw new IOError(`${name} requires a readable Source`);
    }
    if (!Number.isSafeInteger(size) || size < 0 || typeof read !== 'function') {
        throw new IOError(`${name} requires a non-negative safe source size and read method`);
    }
    if (size === 0)
        return null;
    const shared = roots.get(source);
    return shared?.read === read && shared.root?.size === size
        ? shared.root
        : { source, read, offset: 0, size, height: 1 };
}
export function sourceRangeLength(size, offset, length, name) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
        throw new IOError(`${name} offset must be within the source`);
    }
    const count = length === undefined ? size - offset : length;
    if (!Number.isSafeInteger(count) || count < 0 || count > size - offset) {
        throw new IOError(`${name} length must fit within the source`);
    }
    return count;
}
function branch(left, right) {
    return { left, right, size: left.size + right.size, height: 1 + Math.max(left.height, right.height) };
}
function balance(left, right) {
    if ('left' in left && left.height > right.height + 1) {
        if (left.left.height >= left.right.height)
            return branch(left.left, branch(left.right, right));
        const middle = left.right;
        return branch(branch(left.left, middle.left), branch(middle.right, right));
    }
    if ('left' in right && right.height > left.height + 1) {
        if (right.right.height >= right.left.height)
            return branch(branch(left, right.left), right.right);
        const middle = right.left;
        return branch(branch(left, middle.left), branch(middle.right, right.right));
    }
    return branch(left, right);
}
function join(left, right) {
    if ('left' in left && left.height > right.height + 1)
        return balance(left.left, join(left.right, right));
    if ('left' in right && right.height > left.height + 1)
        return balance(join(left, right.left), right.right);
    return branch(left, right);
}
export function joinSourceRoots(left, right) {
    if (!left)
        return right;
    if (!right)
        return left;
    if (right.size > Number.MAX_SAFE_INTEGER - left.size)
        throw new IOError('ConcatSource size exceeds the safe integer limit');
    return join(left, right);
}
export function sliceSourceRoot(root, offset, count) {
    if (!root || count === 0)
        return null;
    if (offset === 0 && count === root.size)
        return root;
    if (!('left' in root))
        return { ...root, offset: root.offset + offset, size: count };
    const middle = root.left.size;
    if (offset >= middle)
        return sliceSourceRoot(root.right, offset - middle, count);
    if (count <= middle - offset)
        return sliceSourceRoot(root.left, offset, count);
    return joinSourceRoots(sliceSourceRoot(root.left, offset, middle - offset), sliceSourceRoot(root.right, 0, count - (middle - offset)));
}
export async function readSourceRoot(root, size, offset, length, name) {
    const end = sourceReadEnd(offset, length, size);
    if (end <= offset || !root)
        return new Uint8Array(0);
    const output = new Uint8Array(end - offset);
    const pending = [{ node: root, start: 0 }];
    while (pending.length > 0) {
        const { node, start } = pending.pop();
        if ('left' in node) {
            const middle = start + node.left.size;
            if (end > middle)
                pending.push({ node: node.right, start: middle });
            if (offset < middle)
                pending.push({ node: node.left, start });
        }
        else {
            const from = Math.max(offset, start);
            const count = Math.min(end, start + node.size) - from;
            const bytes = await node.read.call(node.source, node.offset + (from - start), count);
            assertSourceBytes(bytes, count, name);
            output.set(bytes, from - offset);
        }
    }
    return output;
}
