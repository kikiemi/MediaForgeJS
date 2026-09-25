import { awaitWithAbort, linkAbortSignals } from '../core/abort.js';
import { MediaForgeError } from '../core/errors.js';
import { assertSourceBytes } from '../io/source-read.js';
import { DASH_U64, dashError, dashLimit } from './dash-common.js';
import { registerDashRepresentation } from './dash-segments.js';
import { parseSidx } from './sidx.js';
const arrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(arrayPrototype, 'byteLength').get;
const byteOffset = Object.getOwnPropertyDescriptor(arrayPrototype, 'byteOffset').get;
const buffer = Object.getOwnPropertyDescriptor(arrayPrototype, 'buffer').get;
function aborted(signal) {
    if (signal.aborted)
        throw new MediaForgeError('DASH index resolution was aborted', 'ABORT');
}
function readIndexRange(input, request, maximumReferences) {
    assertSourceBytes(input, request.index.byteRange.length, 'DASH index');
    const length = byteLength.call(input);
    const inputBuffer = buffer.call(input), inputOffset = byteOffset.call(input);
    const parseAt = (start, size) => parseSidx(new Uint8Array(inputBuffer, inputOffset + start, size), {
        offset: BigInt(request.index.byteRange.offset) + BigInt(start),
        maxReferences: maximumReferences,
    });
    if (request.exact)
        return parseAt(0, length);
    const view = new DataView(inputBuffer, inputOffset, length);
    let cursor = 0, count = 0;
    let result;
    while (cursor < length) {
        if (++count > 4096)
            dashError('index range exceeds the 4096-box scan limit');
        if (length - cursor < 8)
            dashError('truncated index-range box header');
        let size = view.getUint32(cursor), header = 8;
        const type = view.getUint32(cursor + 4);
        if (size === 1) {
            if (length - cursor < 16)
                dashError('truncated extended index-range header');
            const extended = view.getBigUint64(cursor + 8);
            if (extended > BigInt(length - cursor))
                dashError('index-range box exceeds the supplied bytes');
            size = Number(extended);
            header = 16;
        }
        else if (size === 0)
            size = length - cursor;
        if (type === 0x75756964)
            header += 16;
        if (size < header || size > length - cursor)
            dashError('invalid index-range box boundary');
        if (type === 0x73696478) {
            if (result)
                dashError('multiple sidx boxes in one SegmentBase index are unsupported');
            result = parseAt(cursor, size);
        }
        cursor += size;
    }
    if (!result)
        dashError('index range contains no complete sidx');
    return result;
}
function resolvedRepresentation(request, sidx, prepared) {
    const count = sidx.references.length;
    if (!count)
        dashError('SegmentBase index contains no media references');
    if (count > request.maxSegments)
        dashError('SegmentBase index exceeds maxSegments');
    const scaledOffset = request.presentationTimeOffset * BigInt(sidx.timescale);
    if (scaledOffset % BigInt(request.timescale))
        dashError('SegmentBase PTO cannot be represented as integral sidx ticks');
    const presentationTimeOffset = scaledOffset / BigInt(request.timescale);
    if (presentationTimeOffset > DASH_U64)
        dashError('normalized SegmentBase PTO exceeds uint64');
    for (const reference of sidx.references) {
        if (reference.referenceType !== 0)
            dashError('hierarchical sidx references are unsupported for media planning');
        if (!reference.size || reference.duration <= 0n)
            dashError('sidx media references require positive size and duration');
        if (reference.offset + BigInt(reference.size) > BigInt(Number.MAX_SAFE_INTEGER))
            dashError('sidx byte range exceeds safe integer precision');
    }
    prepared.reserveEntries(count);
    prepared.reserveCharacters(request.index.url.length * count);
    const resources = [];
    const entries = [];
    for (const reference of sidx.references) {
        const previous = entries.at(-1);
        if (previous?.duration === reference.duration)
            previous.repeat++;
        else {
            prepared.reserveEntries(1);
            entries.push({ time: reference.time, duration: reference.duration, repeat: 0n });
        }
        resources.push(Object.freeze({
            url: request.index.url,
            byteRange: Object.freeze({ offset: Number(reference.offset), length: reference.size }),
        }));
    }
    const timeline = Object.freeze(entries.map(entry => Object.freeze(entry)));
    const segmentInfo = Object.freeze({
        type: 'list',
        sourceType: 'segment-base',
        index: request.index,
        sidx,
        timescale: sidx.timescale,
        presentationTimeOffset,
        startNumber: 1n,
        timeline,
        resources: Object.freeze(resources),
    });
    return registerDashRepresentation({ ...request.description, segmentInfo, segmentCount: BigInt(count) }, { start: request.start, duration: request.duration, maxSegments: request.maxSegments });
}
export async function resolveDashIndexes(options, prepare) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        dashError('invalid resolve options');
    const { readIndex, signal, maxIndexBytes, maxIndexReferences, maxIndexRequests } = options;
    if (typeof readIndex !== 'function')
        dashError('readIndex callback is required');
    if (signal !== undefined &&
        (!signal ||
            typeof signal.aborted !== 'boolean' ||
            typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function'))
        dashError('invalid AbortSignal');
    const bytesLimit = dashLimit(maxIndexBytes, 8 * 1024 * 1024, 'maxIndexBytes', 64 * 1024 * 1024);
    const referencesLimit = dashLimit(maxIndexReferences, 200000, 'maxIndexReferences', 1000000);
    const requestsLimit = dashLimit(maxIndexRequests, 256, 'maxIndexRequests', 4096);
    const linked = linkAbortSignals(signal);
    try {
        aborted(linked.signal);
        const prepared = prepare();
        aborted(linked.signal);
        if (prepared.pending.length > requestsLimit)
            dashError('manifest exceeds maxIndexRequests');
        let declaredBytes = 0;
        for (const request of prepared.pending) {
            const length = request.index.byteRange.length;
            if (length < 32 || length > 1048576)
                dashError('index range must contain 32..1048576 bytes');
            declaredBytes += length;
            if (declaredBytes > bytesLimit)
                dashError('manifest exceeds maxIndexBytes');
        }
        const resolved = new Map();
        let references = 0;
        for (const request of prepared.pending) {
            aborted(linked.signal);
            if (references >= referencesLimit)
                dashError('manifest exceeds maxIndexReferences');
            const pending = readIndex(request.index, linked.signal);
            const data = await awaitWithAbort(Promise.resolve(pending), linked.signal);
            aborted(linked.signal);
            const sidx = readIndexRange(data, request, Math.min(65535, referencesLimit - references));
            references += sidx.references.length;
            resolved.set(request, resolvedRepresentation(request, sidx, prepared));
            aborted(linked.signal);
        }
        return prepared.finish(resolved);
    }
    finally {
        linked.dispose();
    }
}
