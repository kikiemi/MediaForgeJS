import { IOError } from '../core/errors.js';
import { captureSourceRoot, joinSourceRoots, readSourceRoot, registerSourceRoot, sliceSourceRoot, sourceRangeLength, } from './source-rope.js';
function arrayLength(values, name) {
    let count;
    try {
        if (!Array.isArray(values))
            throw new IOError(`${name} requires an array`);
        count = values.length;
    }
    catch {
        throw new IOError(`${name} requires a readable array`);
    }
    if (!Number.isInteger(count) || count < 0 || count > 0xffffffff) {
        throw new IOError(`${name} requires a valid array length`);
    }
    return count;
}
export class ConcatSource {
    size;
    root;
    static readConcat = ConcatSource.prototype.read;
    constructor(sources) {
        const count = arrayLength(sources, 'ConcatSource');
        let root = null;
        for (let index = 0; index < count; index++) {
            let source;
            try {
                source = sources[index];
            }
            catch {
                throw new IOError('ConcatSource requires readable Sources');
            }
            root = joinSourceRoots(root, captureSourceRoot(source, 'ConcatSource'));
        }
        this.size = root?.size ?? 0;
        this.root = root;
        registerSourceRoot(this, ConcatSource.readConcat, root);
    }
    static fromRanges(source, ranges) {
        const base = captureSourceRoot(source, 'ConcatSource');
        const size = base?.size ?? 0;
        const count = arrayLength(ranges, 'ConcatSource ranges');
        let root = null;
        for (let index = 0; index < count; index++) {
            let offset;
            let length;
            try {
                const range = ranges[index];
                offset = range.offset;
                length = range.length;
            }
            catch {
                throw new IOError('ConcatSource requires readable byte ranges');
            }
            const lengthInSource = sourceRangeLength(size, offset, length, 'ConcatSource range');
            root = joinSourceRoots(root, sliceSourceRoot(base, offset, lengthInSource));
        }
        const selected = {
            size: root?.size ?? 0,
            read: (offset, length) => readSourceRoot(root, root?.size ?? 0, offset, length, 'ConcatSource'),
        };
        registerSourceRoot(selected, selected.read, root);
        return new ConcatSource([selected]);
    }
    read(offset, length) {
        return readSourceRoot(this.root, this.size, offset, length, 'ConcatSource');
    }
}
