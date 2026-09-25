import { IOError } from '../core/errors.js';
import { sourceReadEnd } from './source-read.js';
import { captureSourceRoot, readSourceRoot, registerSourceRoot, sliceSourceRoot, sourceRangeLength, } from './source-rope.js';
const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const typedArrayValues = Uint8Array.prototype.values;
function viewBytes(input) {
    try {
        typedArrayValues.call(input);
        return new Uint8Array(typedArrayBuffer.call(input), typedArrayByteOffset.call(input), typedArrayByteLength.call(input));
    }
    catch {
        return new Uint8Array(dataViewBuffer.call(input), dataViewByteOffset.call(input), dataViewByteLength.call(input));
    }
}
export class RangeSource {
    size;
    root;
    static readRange = RangeSource.prototype.read;
    constructor(source, offset = 0, length) {
        const root = captureSourceRoot(source, 'RangeSource');
        this.size = sourceRangeLength(root?.size ?? 0, offset, length, 'RangeSource');
        this.root = sliceSourceRoot(root, offset, this.size);
        registerSourceRoot(this, RangeSource.readRange, this.root);
    }
    read(offset, length) {
        return readSourceRoot(this.root, this.size, offset, length, 'RangeSource');
    }
}
export class BufferSource {
    bytes;
    size;
    constructor(input, options = {}) {
        if (!options || typeof options !== 'object')
            throw new IOError('BufferSource options must be an object');
        let copy;
        try {
            copy = options.copy;
        }
        catch {
            throw new IOError('BufferSource copy option could not be read');
        }
        if (copy !== undefined && typeof copy !== 'boolean')
            throw new IOError('BufferSource copy must be a boolean');
        try {
            const bytes = ArrayBuffer.isView(input)
                ? viewBytes(input)
                : new Uint8Array(input, 0, bufferByteLength.call(input));
            this.bytes = copy === false ? bytes : new Uint8Array(bytes);
            this.size = bytes.byteLength;
        }
        catch {
            throw new IOError('BufferSource requires an attached ArrayBuffer or ArrayBufferView');
        }
    }
    async read(offset, length) {
        const end = sourceReadEnd(offset, length, this.size);
        try {
            if (this.bytes.byteLength !== this.size) {
                throw new IOError('BufferSource storage was resized or detached');
            }
            return this.bytes.slice(Math.min(offset, this.size), Math.max(0, end));
        }
        catch (error) {
            if (error instanceof IOError)
                throw error;
            throw new IOError('BufferSource storage is no longer readable');
        }
    }
}
export class BlobSource {
    blob;
    slice;
    size;
    static WINDOW = 4 * 1024 * 1024;
    windows = [];
    pending = new Map();
    constructor(blob) {
        let size;
        let slice;
        try {
            size = blob.size;
            slice = blob.slice;
        }
        catch {
            throw new IOError('BlobSource requires a readable Blob');
        }
        if (!Number.isSafeInteger(size) || size < 0 || typeof slice !== 'function') {
            throw new IOError('BlobSource requires a non-negative safe size and slice method');
        }
        this.blob = blob;
        this.slice = slice;
        this.size = size;
    }
    async read(offset, length) {
        const end = sourceReadEnd(offset, length, this.size);
        const want = end - offset;
        if (want <= 0)
            return new Uint8Array(0);
        if (want > BlobSource.WINDOW) {
            return this.readBytes(offset, end);
        }
        for (let i = 0; i < this.windows.length; i++) {
            const win = this.windows[i];
            if (!win)
                continue;
            if (offset >= win.start && end <= win.start + win.bytes.length) {
                if (i !== 0) {
                    this.windows.splice(i, 1);
                    this.windows.unshift(win);
                }
                const rel = offset - win.start;
                return win.bytes.slice(rel, rel + want);
            }
        }
        for (const [start, pending] of this.pending) {
            if (offset >= start && end <= pending.end) {
                const bytes = await pending.bytes;
                return bytes.slice(offset - start, end - start);
            }
        }
        const winEnd = offset + Math.min(this.size - offset, BlobSource.WINDOW);
        const read = Promise.resolve().then(() => this.readWindow(offset, winEnd));
        this.pending.set(offset, { end: winEnd, bytes: read });
        try {
            return (await read).slice(0, want);
        }
        finally {
            this.pending.delete(offset);
        }
    }
    async readWindow(start, end) {
        const bytes = await this.readBytes(start, end);
        this.windows.unshift({ start, bytes });
        if (this.windows.length > 2)
            this.windows.pop();
        return bytes;
    }
    async readBytes(start, end) {
        const part = this.slice.call(this.blob, start, end);
        const read = part?.arrayBuffer;
        if (typeof read !== 'function')
            throw new IOError('BlobSource slice must provide an arrayBuffer method');
        const buffer = await read.call(part);
        try {
            if (bufferByteLength.call(buffer) !== end - start) {
                throw new IOError('BlobSource read must return exactly the requested ArrayBuffer bytes');
            }
            return new Uint8Array(buffer, 0, end - start);
        }
        catch (error) {
            if (error instanceof IOError)
                throw error;
            throw new IOError('BlobSource received an invalid or detached ArrayBuffer');
        }
    }
}
