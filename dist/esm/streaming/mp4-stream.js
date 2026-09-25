import { linkAbortSignals } from '../core/abort.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { StreamByteReader, TruncatedByteStreamError } from '../io/byte-reader.js';
function requireValue(value, message) {
    if (!value)
        throw new DemuxError(`MP4 stream: ${message}`);
}
function limit(value, fallback, name, min = 1, max = 0x7fffffff) {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < min || result > max) {
        throw new MediaForgeError(`MP4 stream ${name} must be an integer in ${min}..${max}`, 'FORMAT');
    }
    return result;
}
function settings(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('Invalid MP4 stream options', 'FORMAT');
    const { signal, maxBoxBytes, maxSegmentBytes, maxBoxes, maxInputChunkBytes, maxEmptyChunks, validation, onWarning, maxWarnings, } = options;
    if (signal !== undefined &&
        (!signal ||
            typeof signal.aborted !== 'boolean' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function')) {
        throw new MediaForgeError('Invalid MP4 stream AbortSignal', 'FORMAT');
    }
    return {
        signal,
        validation,
        onWarning,
        maxWarnings,
        maxBoxBytes: limit(maxBoxBytes, 64 * 1024 * 1024, 'maxBoxBytes', 8),
        maxSegmentBytes: limit(maxSegmentBytes, 128 * 1024 * 1024, 'maxSegmentBytes', 16),
        maxBoxes: limit(maxBoxes, 100_000, 'maxBoxes', 1, Number.MAX_SAFE_INTEGER),
        maxInputChunkBytes: limit(maxInputChunkBytes, 16 * 1024 * 1024, 'maxInputChunkBytes'),
        maxEmptyChunks: limit(maxEmptyChunks, 1024, 'maxEmptyChunks', 0),
    };
}
function streamIterator(input, options, walk) {
    const config = settings(options);
    const context = new DiagnosticContext(config, 'strict');
    const controller = new AbortController();
    const run = async function* () {
        const linked = linkAbortSignals(controller.signal, config.signal);
        let reader;
        let failure;
        try {
            if (linked.signal.aborted)
                throw new MediaForgeError('MP4 stream was aborted', 'ABORT');
            reader = new StreamByteReader(input, linked.signal, config.maxInputChunkBytes, config.maxEmptyChunks);
            yield* walk(reader, config, context);
            reader.checkAbort();
        }
        catch (error) {
            failure = error;
            throw error;
        }
        finally {
            reader?.close(failure);
            linked.dispose();
        }
    };
    const iterator = run();
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        get diagnostics() {
            return context.warnings;
        },
        get suppressedWarnings() {
            return context.suppressedWarnings;
        },
        next: () => {
            const next = iterator.next();
            void next.catch(() => undefined);
            return next;
        },
        return: async () => {
            controller.abort();
            try {
                return await iterator.return();
            }
            catch (error) {
                if (error instanceof MediaForgeError && error.code === 'ABORT')
                    return { done: true, value: undefined };
                throw error;
            }
        },
        throw: async (error) => {
            controller.abort(error);
            return iterator.throw(error);
        },
    };
}
function typeAt(bytes, at) {
    return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}
async function readBox(reader, config, state, remaining) {
    const offset = reader.position;
    const first = await reader.read(8, true);
    if (!first)
        return undefined;
    if (++state.count > config.maxBoxes)
        throw new MediaForgeError('MP4 input exceeds maxBoxes', 'OOM');
    const view = new DataView(first.buffer);
    let size = view.getUint32(0);
    const type = typeAt(first, 4);
    let header = first;
    let headerSize = 8;
    const maximum = Math.min(config.maxBoxBytes, remaining);
    if (size === 1) {
        const extended = (await reader.read(8));
        const value = new DataView(extended.buffer).getBigUint64(0);
        if (value > BigInt(maximum))
            throw new MediaForgeError('MP4 extended box exceeds the configured byte limit', 'OOM');
        size = Number(value);
        headerSize = 16;
        header = new Uint8Array(16);
        header.set(first);
        header.set(extended, 8);
        requireValue(size >= headerSize, 'extended box size is smaller than its header');
    }
    const toEnd = view.getUint32(0) === 0;
    if (type === 'uuid')
        headerSize += 16;
    requireValue(toEnd || size >= headerSize, `${type} box size is smaller than its header`);
    if (headerSize > maximum || (!toEnd && size > maximum))
        throw new MediaForgeError('MP4 box exceeds maxBoxBytes or maxSegmentBytes', 'OOM');
    if (type === 'uuid') {
        const uuid = (await reader.read(16));
        const combined = new Uint8Array(headerSize);
        combined.set(header);
        combined.set(uuid, header.length);
        header = combined;
    }
    let data;
    if (toEnd) {
        data = await reader.toEnd(header, maximum);
        size = data.length;
    }
    else {
        data = new Uint8Array(size);
        data.set(header);
        await reader.fill(data, headerSize, size - headerSize);
    }
    reader.checkAbort();
    state.complete++;
    return { type, offset, size, headerSize, data };
}
function truncated(error, reader, state, context) {
    if (!(error instanceof TruncatedByteStreamError) || state.complete === 0)
        return false;
    context.recover({ code: 'MP4_TRUNCATED_BOX', message: error.message, format: 'mp4', offset: error.offset });
    reader.checkAbort();
    state.truncated = true;
    return true;
}
export function iterateMp4Boxes(input, options = {}) {
    return streamIterator(input, options, async function* (reader, config, context) {
        const state = { count: 0, complete: 0, truncated: false };
        while (true) {
            let box;
            try {
                box = await readBox(reader, config, state, config.maxBoxBytes);
            }
            catch (error) {
                if (truncated(error, reader, state, context))
                    return;
                throw error;
            }
            if (!box)
                return;
            yield box;
            reader.checkAbort();
        }
    });
}
function* children(data, start, end) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (start < end) {
        requireValue(end - start >= 8, 'truncated child box header');
        const type = typeAt(data, start + 4);
        let size = view.getUint32(start);
        let headerSize = 8;
        if (size === 1) {
            requireValue(end - start >= 16, 'truncated extended child header');
            const extended = view.getBigUint64(start + 8);
            requireValue(extended <= BigInt(end - start), 'child box extends outside its parent');
            size = Number(extended);
            headerSize = 16;
        }
        else if (size === 0)
            size = end - start;
        if (type === 'uuid')
            headerSize += 16;
        requireValue(size >= headerSize && size <= end - start, 'invalid child box boundary');
        yield { type, start, end: start + size, headerSize };
        start += size;
    }
}
function one(data, parent, type) {
    let found;
    for (const box of children(data, parent.start + parent.headerSize, parent.end)) {
        if (box.type !== type)
            continue;
        requireValue(!found, `duplicate ${type} box`);
        found = box;
    }
    requireValue(found, `missing ${type} box`);
    return found;
}
function full(data, box, bytes, versions = [0]) {
    const start = box.start + box.headerSize;
    requireValue(box.end - start >= bytes && versions.includes(data[start]), `invalid ${box.type} version or size`);
    return start;
}
function initDefaults(box) {
    const data = box.data;
    const view = new DataView(data.buffer);
    const root = { type: 'moov', start: 0, end: data.length, headerSize: box.headerSize };
    const mvex = one(data, root, 'mvex');
    const tracks = new Set();
    for (const trak of children(data, box.headerSize, data.length)) {
        if (trak.type !== 'trak')
            continue;
        const tkhd = one(data, trak, 'tkhd');
        const start = full(data, tkhd, 4, [0, 1]);
        requireValue(tkhd.end - start >= (data[start] === 1 ? 96 : 84), 'truncated track header');
        const id = view.getUint32(start + (data[start] === 1 ? 20 : 12));
        requireValue(id > 0 && !tracks.has(id), 'invalid or repeated track ID');
        tracks.add(id);
        const stbl = one(data, one(data, one(data, trak, 'mdia'), 'minf'), 'stbl');
        for (const table of children(data, stbl.start + stbl.headerSize, stbl.end)) {
            if (['stsz', 'stz2'].includes(table.type)) {
                const at = full(data, table, 12);
                requireValue(view.getUint32(at + 8) === 0, 'progressive MP4 sample tables are unsupported; provide fragmented MP4');
            }
            else if (['stts', 'ctts', 'stsc', 'stco', 'co64'].includes(table.type)) {
                const at = full(data, table, 8, table.type === 'ctts' ? [0, 1] : [0]);
                requireValue(view.getUint32(at + 4) === 0, 'progressive MP4 sample tables are unsupported; provide fragmented MP4');
            }
        }
    }
    requireValue(tracks.size > 0, 'initialization has no tracks');
    const defaults = new Map();
    for (const trex of children(data, mvex.start + mvex.headerSize, mvex.end)) {
        if (trex.type !== 'trex')
            continue;
        const at = full(data, trex, 24);
        const id = view.getUint32(at + 4);
        requireValue(tracks.has(id) && !defaults.has(id), 'invalid or repeated trex track ID');
        defaults.set(id, view.getUint32(at + 16));
    }
    requireValue(defaults.size === tracks.size, 'every initialization track must have trex defaults');
    return defaults;
}
function validateFragment(moof, mdat, defaults) {
    const data = moof.data;
    const view = new DataView(data.buffer);
    const root = { type: 'moof', start: 0, end: data.length, headerSize: moof.headerSize };
    const mfhd = one(data, root, 'mfhd');
    full(data, mfhd, 8);
    const payloadStart = moof.size + mdat.headerSize;
    const payloadEnd = moof.size + mdat.size;
    let samples = 0;
    for (const traf of children(data, moof.headerSize, data.length)) {
        if (traf.type !== 'traf')
            continue;
        const tfhd = one(data, traf, 'tfhd');
        let at = full(data, tfhd, 8);
        const flags = view.getUint32(at) & 0xffffff;
        const id = view.getUint32(at + 4);
        requireValue(defaults.has(id), 'fragment references an undeclared track');
        requireValue((flags & 0x020000) !== 0 && !(flags & 1), 'fragment requires default-base-is-moof; absolute or implicit data bases are unsupported');
        requireValue((flags & ~0x03003a) === 0, 'unsupported tfhd flags');
        at += 8;
        if (flags & 2)
            at += 4;
        if (flags & 8)
            at += 4;
        let size = defaults.get(id);
        if (flags & 16) {
            requireValue(at + 4 <= tfhd.end, 'truncated tfhd default sample size');
            size = view.getUint32(at);
            at += 4;
        }
        if (flags & 32)
            at += 4;
        requireValue(at === tfhd.end, 'invalid tfhd fields');
        const tfdt = one(data, traf, 'tfdt');
        const time = full(data, tfdt, 8, [0, 1]);
        requireValue(tfdt.end - time === (data[time] === 1 ? 12 : 8), 'invalid tfdt size');
        let end;
        let runs = 0;
        for (const trun of children(data, traf.start + traf.headerSize, traf.end)) {
            if (trun.type !== 'trun')
                continue;
            runs++;
            at = full(data, trun, 8, [0, 1]);
            const fields = view.getUint32(at) & 0xffffff;
            const count = view.getUint32(at + 4);
            requireValue((fields & ~0x000f05) === 0, 'unsupported trun flags');
            requireValue(!(flags & 0x010000) || count === 0, 'duration-is-empty fragment contains samples');
            at += 8;
            let start = end;
            if (fields & 1) {
                requireValue(at + 4 <= trun.end, 'truncated trun offset');
                start = view.getInt32(at);
                at += 4;
            }
            if (fields & 4)
                at += 4;
            const stride = [0x100, 0x200, 0x400, 0x800].reduce((sum, bit) => sum + (fields & bit ? 4 : 0), 0);
            requireValue(at + count * stride === trun.end, 'invalid trun sample table length');
            requireValue(start !== undefined, 'first trun must declare its moof-relative data offset');
            let bytes = count * size;
            if (fields & 0x200) {
                bytes = 0;
                const sizeAt = at + (fields & 0x100 ? 4 : 0);
                for (let index = 0; index < count; index++)
                    bytes += view.getUint32(sizeAt + index * stride);
            }
            end = start + bytes;
            requireValue(Number.isSafeInteger(end) && start >= payloadStart && end <= payloadEnd, 'fragment sample data is outside its single mdat; multi-mdat or external data is unsupported');
            samples += count;
        }
        requireValue(runs > 0, 'track fragment has no trun');
    }
    requireValue(samples > 0, 'fragment has no samples');
}
function segment(kind, boxes, length) {
    const data = new Uint8Array(length);
    let at = 0;
    for (const box of boxes) {
        data.set(box.data, at);
        at += box.size;
    }
    return { kind, offset: boxes[0].offset, byteLength: length, data };
}
export function readCmafSegments(input, options = {}) {
    return streamIterator(input, options, async function* (reader, config, context) {
        const state = { count: 0, complete: 0, truncated: false };
        let pending = [];
        let bytes = 0;
        let ftyp = false;
        let defaults;
        let moof;
        let trailer = false;
        while (true) {
            let box;
            try {
                box = await readBox(reader, config, state, config.maxSegmentBytes - bytes);
            }
            catch (error) {
                if (!defaults || !truncated(error, reader, state, context))
                    throw error;
                break;
            }
            if (!box)
                break;
            if (trailer)
                requireValue(box.type === 'free' || box.type === 'skip', 'boxes follow the terminal fragment index');
            if (box.type === 'mfra' || trailer) {
                requireValue(defaults && pending.length === 0, 'fragment index interrupts an unfinished segment');
                context.warn({
                    code: 'MP4_TRAILER_OMITTED',
                    message: `Terminal ${box.type} box is omitted from media segments`,
                    format: 'mp4',
                    offset: box.offset,
                });
                reader.checkAbort();
                trailer = true;
                continue;
            }
            if (moof)
                requireValue(box.type === 'mdat', 'moof must be followed immediately by one mdat');
            if (box.type === 'ftyp') {
                requireValue(!ftyp && !defaults && !moof, 'repeated or misplaced ftyp');
                requireValue(box.size - box.headerSize >= 8 && (box.size - box.headerSize) % 4 === 0, 'invalid ftyp brands');
                ftyp = true;
            }
            else if (box.type === 'moov') {
                requireValue(ftyp && !defaults && !moof, 'moov requires one preceding ftyp initialization');
                defaults = initDefaults(box);
            }
            else if (box.type === 'moof') {
                requireValue(defaults && !moof, 'media fragment precedes initialization');
                moof = box;
            }
            else if (box.type === 'mdat') {
                requireValue(defaults && moof, 'orphan mdat or progressive MP4 is unsupported');
                validateFragment(moof, box, defaults);
            }
            else if (!['styp', 'emsg', 'prft', 'sidx', 'free', 'skip', 'wide'].includes(box.type)) {
                context.recover({
                    code: 'MP4_UNKNOWN_BOX',
                    message: `Retaining unknown optional ${box.type} box`,
                    format: 'mp4',
                    offset: box.offset,
                });
                reader.checkAbort();
            }
            else if (['styp', 'emsg', 'prft', 'sidx'].includes(box.type)) {
                requireValue(defaults, `${box.type} precedes initialization`);
            }
            pending.push(box);
            bytes += box.size;
            if (box.type === 'moov' || box.type === 'mdat') {
                const output = segment(box.type === 'moov' ? 'init' : 'media', pending, bytes);
                pending = [];
                bytes = 0;
                moof = undefined;
                yield output;
                reader.checkAbort();
            }
        }
        requireValue(defaults, 'stream has no complete fragmented MP4 initialization');
        if (pending.length && !state.truncated) {
            const padding = pending.every(box => ['free', 'skip', 'wide'].includes(box.type));
            const diagnostic = {
                code: padding ? 'MP4_PADDING_OMITTED' : 'MP4_TRUNCATED_FRAGMENT',
                message: padding
                    ? 'Trailing padding boxes are omitted from media segments'
                    : 'Dropping an unfinished final media segment',
                format: 'mp4',
                offset: pending[0].offset,
            };
            if (padding)
                context.warn(diagnostic);
            else
                context.recover(diagnostic);
            reader.checkAbort();
        }
    });
}
