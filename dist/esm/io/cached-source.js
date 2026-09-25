import { IOError, MediaForgeError } from '../core/errors.js';
import { assertSourceBytes, sourceReadEnd } from './source-read.js';
const cachedReads = new WeakMap();
export function readCachedSource(source, offset, length) {
    const entry = cachedReads.get(source);
    return entry && source.read === entry.read ? entry.cached(offset, length) : undefined;
}
export class CachedSource {
    source;
    size;
    readSource;
    pageBytes;
    maxBytes;
    pages = new Map();
    pending = new Map();
    generation = {};
    newest = null;
    oldest = null;
    retainedBytes = 0;
    constructor(source, options = {}) {
        this.source = source;
        let size;
        let read;
        let pageBytes;
        let maxBytes;
        try {
            size = source.size;
            read = source.read;
            if (!options || typeof options !== 'object')
                throw new Error();
            pageBytes = options.pageBytes;
            maxBytes = options.maxBytes;
        }
        catch {
            throw new IOError('CachedSource requires a readable Source and options');
        }
        if (!Number.isSafeInteger(size) || size < 0 || typeof read !== 'function') {
            throw new IOError('CachedSource requires a non-negative safe source size and read method');
        }
        if (pageBytes === undefined)
            pageBytes = 64 * 1024;
        if (maxBytes === undefined)
            maxBytes = 4 * 1024 * 1024;
        if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
            throw new IOError('CachedSource pageBytes must be a positive safe integer and maxBytes a non-negative safe integer');
        }
        this.size = size;
        this.readSource = read;
        this.pageBytes = pageBytes;
        this.maxBytes = maxBytes;
        cachedReads.set(this, { read: intrinsicRead, cached: (offset, length) => this.readRetained(offset, length) });
    }
    get cachedBytes() {
        return this.retainedBytes;
    }
    clear() {
        this.generation = {};
        this.pages.clear();
        this.pending.clear();
        this.newest = null;
        this.oldest = null;
        this.retainedBytes = 0;
    }
    async read(offset, length) {
        const end = sourceReadEnd(offset, length, this.size);
        const count = Math.max(0, end - offset);
        let output;
        try {
            output = new Uint8Array(count);
        }
        catch {
            throw new MediaForgeError('CachedSource could not allocate the requested output', 'OOM');
        }
        if (this.maxBytes === 0 && count > 0) {
            const bytes = await this.readSource.call(this.source, offset, count);
            assertSourceBytes(bytes, count, 'CachedSource');
            output.set(bytes);
            return output;
        }
        const generation = this.generation;
        let written = 0;
        while (written < count) {
            const position = offset + written;
            const index = Math.floor(position / this.pageBytes);
            const start = index * this.pageBytes;
            const cached = generation === this.generation ? this.pages.get(index) : undefined;
            if (cached) {
                this.detach(cached);
                this.prepend(cached);
            }
            const page = cached?.bytes ?? (await this.getPage(index, start, count - written, generation));
            const relative = position - start;
            const take = Math.min(count - written, page.byteLength - relative);
            output.set(page.subarray(relative, relative + take), written);
            written += take;
        }
        return output;
    }
    readRetained(offset, length) {
        const end = sourceReadEnd(offset, length, this.size);
        const count = Math.max(0, end - offset);
        if (count === 0)
            return new Uint8Array(0);
        const index = Math.floor(offset / this.pageBytes);
        const page = this.pages.get(index);
        const relative = offset - index * this.pageBytes;
        if (!page || count > page.bytes.byteLength - relative)
            return undefined;
        this.detach(page);
        this.prepend(page);
        try {
            return page.bytes.slice(relative, relative + count);
        }
        catch {
            throw new MediaForgeError('CachedSource could not copy the cached output', 'OOM');
        }
    }
    getPage(index, start, remaining, generation) {
        if (generation === this.generation) {
            const page = this.pages.get(index);
            if (page) {
                this.detach(page);
                this.prepend(page);
                return Promise.resolve(page.bytes);
            }
            const pending = this.pending.get(index);
            if (pending)
                return pending;
        }
        let count = Math.min(this.pageBytes, this.size - start);
        let pages = 1;
        const limit = Math.min(this.maxBytes, remaining, 1024 * 1024, this.size - start);
        while (pages < 64 && count < limit) {
            const next = index + pages;
            const nextCount = Math.min(this.pageBytes, this.size - start - count);
            if (nextCount > limit - count ||
                (generation === this.generation && (this.pages.has(next) || this.pending.has(next))))
                break;
            count += nextCount;
            pages++;
        }
        const read = Promise.resolve()
            .then(() => this.readSource.call(this.source, start, count))
            .then(bytes => {
            assertSourceBytes(bytes, count, 'CachedSource');
            try {
                return new Uint8Array(bytes);
            }
            catch {
                throw new MediaForgeError('CachedSource could not copy the source page', 'OOM');
            }
        });
        let first;
        for (let page = 0; page < pages; page++) {
            const pageIndex = index + page;
            const offset = page * this.pageBytes;
            const length = Math.min(this.pageBytes, count - offset);
            const pending = read
                .then(bytes => {
                let copy;
                try {
                    copy = pages === 1 ? bytes : bytes.slice(offset, offset + length);
                }
                catch {
                    throw new MediaForgeError('CachedSource could not copy the source page', 'OOM');
                }
                if (generation === this.generation && length <= this.maxBytes)
                    this.retain(pageIndex, copy);
                return copy;
            })
                .finally(() => {
                if (this.pending.get(pageIndex) === pending)
                    this.pending.delete(pageIndex);
            });
            void pending.catch(() => undefined);
            if (generation === this.generation)
                this.pending.set(pageIndex, pending);
            first ??= pending;
        }
        return first;
    }
    retain(index, bytes) {
        while (bytes.byteLength > this.maxBytes - this.retainedBytes) {
            const page = this.oldest;
            this.detach(page);
            this.pages.delete(page.index);
            this.retainedBytes -= page.bytes.byteLength;
        }
        const page = { index, bytes, newer: null, older: null };
        this.pages.set(index, page);
        this.prepend(page);
        this.retainedBytes += bytes.byteLength;
    }
    detach(page) {
        if (page.newer)
            page.newer.older = page.older;
        else
            this.newest = page.older;
        if (page.older)
            page.older.newer = page.newer;
        else
            this.oldest = page.newer;
        page.newer = null;
        page.older = null;
    }
    prepend(page) {
        page.older = this.newest;
        if (this.newest)
            this.newest.newer = page;
        else
            this.oldest = page;
        this.newest = page;
    }
}
const intrinsicRead = CachedSource.prototype.read;
