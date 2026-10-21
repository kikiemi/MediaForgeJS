import type { Source } from '../../model/types';
import { IOError } from '../../errors/errors';
import {
    SourceRope,
    captureSourceRoot,
    joinSourceRoots,
    sliceSourceRoot,
    sourceRangeLength,
    type SourceNode,
} from './source-rope';

export interface SourceRange {
    readonly offset: number;
    /** Omit to select through the end of the source. */
    readonly length?: number;
}

function arrayLength(values: readonly unknown[], name: string): number {
    let count: number;
    try {
        if (!Array.isArray(values)) throw new IOError(`${name} requires an array`);
        count = values.length;
    } catch {
        throw new IOError(`${name} requires a readable array`);
    }
    if (!Number.isInteger(count) || count < 0 || count > 0xffffffff) {
        throw new IOError(`${name} requires a valid array length`);
    }
    return count;
}

/** Concatenates stable byte sources without reading them; each read returns an independent copy. */
export class ConcatSource extends SourceRope {
    constructor(sources: readonly Source[]) {
        const count = arrayLength(sources, 'ConcatSource');
        let root: SourceNode | null = null;
        for (let index = 0; index < count; index++) {
            let source: Source;
            try {
                source = sources[index]!;
            } catch {
                throw new IOError('ConcatSource requires readable Sources');
            }
            root = joinSourceRoots(root, captureSourceRoot(source, 'ConcatSource'));
        }
        super(root, 'ConcatSource');
    }

    /** Lazily joins selected byte intervals in supplied order, including overlaps and repeats. */
    static fromRanges(source: Source, ranges: readonly SourceRange[]): ConcatSource {
        const base = captureSourceRoot(source, 'ConcatSource');
        const size = base?.size ?? 0;
        const count = arrayLength(ranges, 'ConcatSource ranges');
        let root: SourceNode | null = null;
        for (let index = 0; index < count; index++) {
            let offset: number;
            let length: number | undefined;
            try {
                const range = ranges[index]!;
                offset = range.offset;
                length = range.length;
            } catch {
                throw new IOError('ConcatSource requires readable byte ranges');
            }
            const lengthInSource = sourceRangeLength(size, offset, length, 'ConcatSource range');
            root = joinSourceRoots(root, sliceSourceRoot(base, offset, lengthInSource));
        }
        return new ConcatSource([new SourceRope(root, 'ConcatSource')]);
    }
}
