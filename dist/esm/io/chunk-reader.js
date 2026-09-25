import { demuxAssert } from '../core/demux-guard.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { assertSourceBytes } from './source-read.js';
export const MAX_ELEMENT_BYTES = 64 * 1024 * 1024;
export const CHUNK_BYTES = 1 << 20;
export class ChunkReader {
    source;
    size;
    readSource;
    cache = new Map();
    pending = new Map();
    constructor(source) {
        this.source = source;
        let size;
        let read;
        try {
            size = source.size;
            read = source.read;
        }
        catch {
            throw new DemuxError('ChunkReader requires a readable Source');
        }
        demuxAssert(Number.isSafeInteger(size) && size >= 0 && typeof read === 'function', 'ChunkReader requires a non-negative safe source size and read method');
        this.size = size;
        this.readSource = read;
    }
    async bytes(pos, len) {
        demuxAssert(Number.isSafeInteger(pos) &&
            Number.isSafeInteger(len) &&
            pos >= 0 &&
            len >= 0 &&
            Number.isSafeInteger(pos + len), 'read range must use non-negative safe integers');
        const end = Math.min(pos + len, this.size);
        if (end <= pos)
            return new Uint8Array(0);
        demuxAssert(end - pos <= MAX_ELEMENT_BYTES, `element of ${end - pos} bytes exceeds the ${MAX_ELEMENT_BYTES}-byte cap`);
        const firstChunk = Math.floor(pos / CHUNK_BYTES);
        const lastChunk = Math.floor((end - 1) / CHUNK_BYTES);
        if (firstChunk === lastChunk) {
            const chunk = this.cachedChunk(firstChunk) ?? (await this.chunk(firstChunk));
            return chunk.subarray(pos - firstChunk * CHUNK_BYTES, end - firstChunk * CHUNK_BYTES);
        }
        const out = new Uint8Array(end - pos);
        let cursor = 0;
        for (let c = firstChunk; c <= lastChunk; c++) {
            const chunk = this.cachedChunk(c) ?? (await this.chunk(c));
            const base = c * CHUNK_BYTES;
            const from = Math.max(pos, base) - base;
            const to = Math.min(end, base + CHUNK_BYTES) - base;
            out.set(chunk.subarray(from, to), cursor);
            cursor += to - from;
        }
        return out;
    }
    cachedChunk(index) {
        const hit = this.cache.get(index);
        if (hit) {
            this.cache.delete(index);
            this.cache.set(index, hit);
        }
        return hit;
    }
    async chunk(index) {
        const hit = this.cachedChunk(index);
        if (hit)
            return hit;
        const pending = this.pending.get(index);
        if (pending)
            return pending;
        const read = Promise.resolve().then(() => this.readChunk(index));
        this.pending.set(index, read);
        try {
            return await read;
        }
        finally {
            this.pending.delete(index);
        }
    }
    async readChunk(index) {
        const base = index * CHUNK_BYTES;
        const length = Math.min(CHUNK_BYTES, this.size - base);
        const sourceBytes = await this.readSource.call(this.source, base, length);
        try {
            assertSourceBytes(sourceBytes, length, 'ChunkReader');
        }
        catch {
            throw new DemuxError(`Malformed input: invalid read at ${base}; expected ${length} Uint8Array bytes`);
        }
        let data;
        try {
            data = new Uint8Array(sourceBytes);
        }
        catch {
            throw new MediaForgeError('ChunkReader could not copy the source page', 'OOM');
        }
        this.cache.set(index, data);
        if (this.cache.size > 3)
            this.cache.delete(this.cache.keys().next().value);
        return data;
    }
}
