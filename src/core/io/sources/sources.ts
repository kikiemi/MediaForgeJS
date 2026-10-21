import type { Source, MediaInput } from '../../model/types';
import { IOError, MediaForgeError } from '../../errors/errors';
import { registerOwnedReads, sourceReadEnd } from './source-read';
import { BlobSource } from './blob-source';
import { registerReadInto } from '../../bytes/read-into';
import { SourceRope, captureSourceRoot, sliceSourceRoot, sourceRangeLength } from './source-rope';
import {
    typedArrayBuffer,
    typedArrayByteLength,
    typedArrayOffset as typedArrayByteOffset,
    typedArrayValues,
} from '../../bytes/typed-array';

/** How a Blob is read is the rule of its own module (blob-source). */
export { BlobSource };

export interface BufferSourceOptions {
    /** Snapshot input by default; false borrows storage that must remain stable while in use. */
    readonly copy?: boolean;
}

const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;

function viewBytes(input: ArrayBufferView): Uint8Array {
    try {
        typedArrayValues.call(input as Uint8Array);
        return new Uint8Array(
            typedArrayBuffer.call(input),
            typedArrayByteOffset.call(input),
            typedArrayByteLength.call(input),
        );
    } catch {
        return new Uint8Array(
            dataViewBuffer.call(input),
            dataViewByteOffset.call(input),
            dataViewByteLength.call(input),
        );
    }
}

/**
 * Fixed byte interval over a stable Source; wrapping reads no data, and reads return independent
 * copies.
 */
export class RangeSource extends SourceRope {
    constructor(source: Source, offset = 0, length?: number) {
        const root = captureSourceRoot(source, 'RangeSource');
        const size = sourceRangeLength(root?.size ?? 0, offset, length, 'RangeSource');
        super(sliceSourceRoot(root, offset, size), 'RangeSource');
    }
}

/** Random-access source over the exact input byte range; every read returns an independent copy. */
export class BufferSource implements Source {
    private readonly bytes: Uint8Array;
    readonly size: number;

    constructor(input: ArrayBuffer | ArrayBufferView, options: BufferSourceOptions = {}) {
        if (!options || typeof options !== 'object')
            throw new MediaForgeError('BufferSource options must be an object', 'INPUT');
        let copy: boolean | undefined;
        try {
            copy = options.copy;
        } catch {
            throw new IOError('BufferSource copy option could not be read');
        }
        if (copy !== undefined && typeof copy !== 'boolean')
            throw new MediaForgeError('BufferSource copy must be a boolean', 'INPUT');

        try {
            const bytes = ArrayBuffer.isView(input)
                ? viewBytes(input)
                : new Uint8Array(input, 0, bufferByteLength.call(input));
            this.bytes = copy === false ? bytes : new Uint8Array(bytes);
            this.size = bytes.byteLength;
        } catch {
            throw new IOError('BufferSource requires an attached ArrayBuffer or ArrayBufferView');
        }

        registerOwnedReads(this, BufferSource.prototype.read);
        registerReadInto(this, BufferSource.prototype.read, BufferSource.prototype.readInto);
    }

    async read(offset: number, length: number): Promise<Uint8Array> {
        const end = sourceReadEnd(offset, length, this.size);
        return this.readable(bytes => bytes.slice(Math.min(offset, this.size), Math.max(0, end)));
    }

    /** Copies the bytes from `offset` into `target`, which they must fill. */
    async readInto(offset: number, target: Uint8Array): Promise<void> {
        if (sourceReadEnd(offset, target.length, this.size) - offset !== target.length)
            throw new IOError('BufferSource read past its end');
        this.readable(bytes => target.set(bytes.subarray(offset, offset + target.length)));
    }

    /** `use` of the stored bytes, failing with IOError when they were resized or detached. */
    private readable<T>(use: (bytes: Uint8Array) => T): T {
        try {
            if (this.bytes.byteLength !== this.size)
                throw new IOError('BufferSource storage was resized or detached');
            return use(this.bytes);
        } catch (error) {
            if (error instanceof IOError) throw error;
            throw new IOError('BufferSource storage is no longer readable');
        }
    }
}

/**
 * Source over bytes read once from an input and never changed afterwards, such as a window a
 * demuxer reads in one pass: reads are views of them rather than copies, which their readers keep
 * unchanged as well.
 */
export class UnchangingBytesSource implements Source {
    readonly size: number;

    constructor(private readonly bytes: Uint8Array) {
        this.size = bytes.byteLength;
        registerOwnedReads(this, UnchangingBytesSource.prototype.read);
    }

    async read(offset: number, length: number): Promise<Uint8Array> {
        const end = sourceReadEnd(offset, length, this.size);
        return this.bytes.subarray(Math.min(offset, this.size), Math.max(offset, end));
    }
}

/**
 * The Source of an input: a borrowed Source is read through a RangeSource (reads return copies and
 * never reach past its size), a Blob or File through a BlobSource, bytes through a BufferSource
 * without copying. Anything else fails with INPUT.
 */
export function sourceOf(input: Source | MediaInput): Source {
    if (input && typeof (input as Source).read === 'function')
        return new RangeSource(input as Source);
    if (typeof Blob !== 'undefined' && input instanceof Blob) return new BlobSource(input);
    if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) return new BufferSource(input);
    throw new MediaForgeError(
        'Expected a Blob, File, ArrayBuffer, typed array or Source as the input',
        'INPUT',
        {
            hint: 'Pass the file, its bytes, or a Source such as HttpSource for a URL.',
        },
    );
}

export function isMediaInput(value: unknown): value is Source | MediaInput {
    if (!value || typeof value !== 'object') return false;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
    const source = value as Source;
    return typeof source.read === 'function' && typeof source.size === 'number';
}
