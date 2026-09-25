import { awaitWithAbort, linkAbortSignals } from '../core/abort.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { IOError, MediaForgeError } from '../core/errors.js';
import { assertSourceBytes } from '../io/source-read.js';
import { AdaptiveQualityController } from './adaptive-quality.js';
import { parseHlsPlaylist } from './hls-playlist.js';
function playlistEntry(playlist, index) {
    return playlist.segments[index] ?? (index === playlist.segments.length ? playlist.trailingParts?.[0] : undefined);
}
function playlistParts(playlist, index) {
    return playlist.segments[index]?.parts ?? (index === playlist.segments.length ? playlist.trailingParts : undefined);
}
function adaptiveTimeline(playlist, previous) {
    const positions = [];
    const count = playlist.segments.length + (playlist.trailingParts?.length ? 1 : 0);
    for (let first = 0; first < count;) {
        const discontinuity = playlistEntry(playlist, first).discontinuitySequence;
        let end = first;
        let elapsed = 0;
        let date;
        let boundary = playlistEntry(playlist, first).discontinuity ? 0 : undefined;
        let inconsistent = false;
        const offsets = [];
        while (end < count && playlistEntry(playlist, end).discontinuitySequence === discontinuity) {
            const segment = playlistEntry(playlist, end);
            offsets.push(elapsed);
            let knownDate = segment.programDateTime ? Date.parse(segment.programDateTime) : undefined;
            const oldIndex = previous ? segment.sequence - previous.playlist.mediaSequence : -1;
            const old = previous ? playlistEntry(previous.playlist, oldIndex) : undefined;
            if (old?.discontinuitySequence === discontinuity) {
                const position = previous.timeline[oldIndex];
                if (position.date !== undefined) {
                    if (knownDate !== undefined && Math.abs(knownDate - position.date) > 1)
                        inconsistent = true;
                    knownDate ??= position.date;
                }
                if (position.boundary !== undefined)
                    boundary ??= position.boundary - elapsed;
            }
            if (knownDate !== undefined) {
                const origin = knownDate - elapsed;
                if (date !== undefined && Math.abs(origin - date) > 1)
                    inconsistent = true;
                date ??= origin;
            }
            elapsed += segment.duration * 1000;
            end++;
        }
        for (const offset of offsets)
            positions.push(inconsistent
                ? {}
                : {
                    date: date === undefined ? undefined : date + offset,
                    boundary: boundary === undefined ? undefined : boundary + offset,
                });
        first = end;
    }
    return positions;
}
function alignedPositionStart(candidate, position, discontinuity, count = candidate.timeline.length) {
    if (discontinuity === undefined || (position.date === undefined && position.boundary === undefined))
        return -1;
    let low = 0;
    let high = count;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (playlistEntry(candidate.playlist, middle).discontinuitySequence < discontinuity)
            low = middle + 1;
        else
            high = middle;
    }
    const first = low;
    if (first === count || playlistEntry(candidate.playlist, first).discontinuitySequence !== discontinuity)
        return -1;
    high = count;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (playlistEntry(candidate.playlist, middle).discontinuitySequence <= discontinuity)
            low = middle + 1;
        else
            high = middle;
    }
    const end = low;
    const other = candidate.timeline[first];
    const key = position.date !== undefined && other.date !== undefined ? 'date' : 'boundary';
    const time = position[key];
    if (time === undefined || other[key] === undefined)
        return -1;
    low = first;
    high = end;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (candidate.timeline[middle][key] < time - 1)
            low = middle + 1;
        else
            high = middle;
    }
    return low < end && candidate.timeline[low][key] <= time + 1 ? low : -1;
}
function alignedLiveIndex(current, candidate, index) {
    const before = current.playlist.segments[index];
    const position = current.timeline[index];
    let matched = -1;
    const start = alignedPositionStart(candidate, position, before.discontinuitySequence, candidate.playlist.segments.length);
    if (start < 0)
        return -1;
    for (let afterIndex = start; afterIndex < candidate.playlist.segments.length; afterIndex++) {
        const after = candidate.playlist.segments[afterIndex];
        const other = candidate.timeline[afterIndex];
        if (before.discontinuitySequence !== after.discontinuitySequence)
            break;
        const distance = position.date !== undefined && other.date !== undefined
            ? position.date - other.date
            : position.boundary !== undefined && other.boundary !== undefined
                ? position.boundary - other.boundary
                : undefined;
        if (distance === undefined || Math.abs(distance) > 1)
            break;
        if (matched !== -1 ||
            Math.abs(before.duration - after.duration) > 0.001 ||
            Boolean(before.gap) !== Boolean(after.gap))
            return -1;
        matched = afterIndex;
    }
    if (matched < 0)
        return -1;
    if (candidate.playlist.endList &&
        candidate.playlist.segments.length - matched < current.playlist.segments.length - index)
        return -1;
    let beforeTime = 0;
    let afterTime = 0;
    for (let offset = 0; index + offset < current.playlist.segments.length && matched + offset < candidate.playlist.segments.length; offset++) {
        const beforeSegment = current.playlist.segments[index + offset];
        const afterSegment = candidate.playlist.segments[matched + offset];
        if (beforeSegment.discontinuitySequence !== afterSegment.discontinuitySequence ||
            Boolean(beforeSegment.gap) !== Boolean(afterSegment.gap))
            return -1;
        const beforeDate = current.timeline[index + offset].date;
        const afterDate = candidate.timeline[matched + offset].date;
        if (beforeDate !== undefined && afterDate !== undefined && Math.abs(beforeDate - afterDate) > 1)
            return -1;
        beforeTime += beforeSegment.duration;
        afterTime += afterSegment.duration;
        if (Math.abs(beforeTime - afterTime) > 0.001)
            return -1;
    }
    return matched;
}
function alignedPartBoundary(current, candidate, index, offset, part, masterIndependent, canRefresh) {
    const before = playlistEntry(current.playlist, index);
    const position = current.timeline[index];
    let match;
    const start = alignedPositionStart(candidate, position, before.discontinuitySequence);
    if (start < 0)
        return undefined;
    for (let otherIndex = start; otherIndex < candidate.timeline.length; otherIndex++) {
        const after = playlistEntry(candidate.playlist, otherIndex);
        const other = candidate.timeline[otherIndex];
        if (before.discontinuitySequence !== after.discontinuitySequence)
            break;
        const distance = position.date !== undefined && other.date !== undefined
            ? position.date - other.date
            : position.boundary !== undefined && other.boundary !== undefined
                ? position.boundary - other.boundary
                : undefined;
        if (distance === undefined || Math.abs(distance) > 1)
            break;
        const beforeSegment = current.playlist.segments[index];
        const afterSegment = candidate.playlist.segments[otherIndex];
        if (afterSegment?.gap ||
            (beforeSegment && afterSegment && Math.abs(beforeSegment.duration - afterSegment.duration) > 0.001))
            continue;
        const parts = playlistParts(candidate.playlist, otherIndex) ?? [];
        let elapsed = 0;
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const target = parts[partIndex];
            if (Math.abs(elapsed - offset) <= 0.001 &&
                Math.abs(target.duration - part.duration) <= 0.001 &&
                !target.gap &&
                (target.independent === true ||
                    (partIndex === 0 &&
                        target.independent !== false &&
                        (masterIndependent || candidate.playlist.independentSegments)))) {
                if (match)
                    return undefined;
                match = { index: otherIndex, partIndex };
            }
            elapsed += target.duration;
        }
        if (afterSegment && Math.abs(elapsed - afterSegment.duration) > 0.001)
            return undefined;
    }
    if (!match)
        return undefined;
    const remaining = current.timeline.length - index;
    const requireCoverage = !canRefresh || candidate.playlist.endList;
    if (requireCoverage && candidate.timeline.length - match.index < remaining)
        return undefined;
    for (let ahead = 0; ahead < remaining && match.index + ahead < candidate.timeline.length; ahead++) {
        const before = playlistEntry(current.playlist, index + ahead);
        const after = playlistEntry(candidate.playlist, match.index + ahead);
        if (before.discontinuitySequence !== after.discontinuitySequence)
            return undefined;
        const beforeSegment = current.playlist.segments[index + ahead];
        const afterSegment = candidate.playlist.segments[match.index + ahead];
        const afterParts = playlistParts(candidate.playlist, match.index + ahead);
        if (afterParts?.some((item, partIndex) => item.gap && (ahead > 0 || partIndex >= match.partIndex)))
            return undefined;
        if (beforeSegment &&
            afterSegment &&
            (Math.abs(beforeSegment.duration - afterSegment.duration) > 0.001 ||
                Boolean(beforeSegment.gap) !== Boolean(afterSegment.gap)))
            return undefined;
        const beforeDate = current.timeline[index + ahead].date;
        const afterDate = candidate.timeline[match.index + ahead].date;
        if (beforeDate !== undefined && afterDate !== undefined && Math.abs(beforeDate - afterDate) > 1)
            return undefined;
        if (requireCoverage || afterSegment) {
            const available = afterSegment?.duration ??
                (playlistParts(candidate.playlist, match.index + ahead) ?? []).reduce((sum, item) => sum + item.duration, 0);
            const required = beforeSegment?.duration ??
                (playlistParts(current.playlist, index + ahead) ?? []).reduce((sum, item) => sum + item.duration, 0);
            if (available + 0.001 < required)
                return undefined;
        }
    }
    return match;
}
function variantSnapshot(variant) {
    return {
        ...variant,
        resolution: variant.resolution ? { ...variant.resolution } : undefined,
        attributes: variant.attributes ? { ...variant.attributes } : undefined,
    };
}
function compatibleVariant(reference, candidate) {
    const codecs = (value) => value
        ?.split(',')
        .map(codec => codec.trim().toLowerCase())
        .sort()
        .join(',');
    return (!candidate.iframe &&
        Boolean(reference.codecs) &&
        codecs(reference.codecs) === codecs(candidate.codecs) &&
        reference.audio === candidate.audio &&
        reference.video === candidate.video &&
        reference.subtitles === candidate.subtitles &&
        reference.closedCaptions === candidate.closedCaptions);
}
function alignedVod(reference, candidate, masterIndependent) {
    if (!candidate.endList ||
        candidate.iframeOnly ||
        candidate.skippedSegments ||
        !(masterIndependent || (reference.independentSegments && candidate.independentSegments)) ||
        reference.mediaSequence !== candidate.mediaSequence ||
        reference.discontinuitySequence !== candidate.discontinuitySequence ||
        reference.segments.length !== candidate.segments.length)
        return false;
    let referenceTime = 0;
    let candidateTime = 0;
    let referenceDate;
    let candidateDate;
    for (let index = 0; index < reference.segments.length; index++) {
        const before = reference.segments[index];
        const after = candidate.segments[index];
        if (before.sequence !== after.sequence ||
            before.discontinuitySequence !== after.discontinuitySequence ||
            Boolean(before.discontinuity) !== Boolean(after.discontinuity) ||
            Boolean(before.gap) !== Boolean(after.gap))
            return false;
        if (before.programDateTime)
            referenceDate = Date.parse(before.programDateTime) - referenceTime * 1000;
        if (after.programDateTime)
            candidateDate = Date.parse(after.programDateTime) - candidateTime * 1000;
        if (referenceDate !== undefined &&
            candidateDate !== undefined &&
            (!Number.isFinite(referenceDate) ||
                !Number.isFinite(candidateDate) ||
                Math.abs(referenceDate - candidateDate) > 1))
            return false;
        referenceTime += before.duration;
        candidateTime += after.duration;
        if (Math.abs(referenceTime - candidateTime) > 0.001)
            return false;
    }
    return true;
}
function monotonicNow() {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}
function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new MediaForgeError(`HLS: invalid ${label}`, 'FORMAT');
    return value;
}
function timerInteger(value, label) {
    if (positiveInteger(value, label) > 0x7fffffff)
        throw new MediaForgeError(`HLS: invalid ${label}`, 'FORMAT');
    return value;
}
function segmentOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('HLS: iterator options must be an object', 'FORMAT');
    const result = {
        live: options.live,
        startSequence: options.startSequence,
        signal: options.signal,
        maxRefreshes: options.maxRefreshes,
        maxIdleRefreshes: options.maxIdleRefreshes,
    };
    if (result.live !== undefined && typeof result.live !== 'boolean')
        throw new MediaForgeError('HLS: live must be a boolean', 'FORMAT');
    for (const name of ['startSequence', 'maxRefreshes']) {
        const value = result[name];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
            throw new MediaForgeError(`HLS: ${name} must be a non-negative safe integer`, 'INPUT');
    }
    if (result.maxIdleRefreshes !== undefined)
        positiveInteger(result.maxIdleRefreshes, 'maxIdleRefreshes');
    return result;
}
function cancellableIterator(factory) {
    const controller = new AbortController();
    const iterator = factory(controller.signal);
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        next: () => iterator.next(),
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
function checkAbort(signal) {
    if (signal.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
function networkUri(value) {
    let uri;
    try {
        uri = new URL(value);
    }
    catch {
        throw new MediaForgeError('HLS: loading requires an absolute HTTP(S) URL', 'INPUT');
    }
    if (uri.protocol !== 'http:' && uri.protocol !== 'https:') {
        throw new MediaForgeError('HLS: only HTTP(S) resource URLs are supported', 'FORMAT');
    }
    return uri.href;
}
function mapIdentity(map) {
    return JSON.stringify([map.uri, map.byteRange, activeKeys(map)]);
}
function activeKeys(value) {
    return value.keys ?? (value.key ? [value.key] : []);
}
function sameRange(a, b) {
    return a === b || (!!a && !!b && a.offset === b.offset && a.length === b.length);
}
function sameKey(a, b) {
    return (a === b ||
        (!!a &&
            !!b &&
            a.method === b.method &&
            a.uri === b.uri &&
            a.iv === b.iv &&
            a.keyFormat === b.keyFormat &&
            a.keyFormatVersions === b.keyFormatVersions));
}
function sameMap(a, b) {
    return a === b || (!!a && !!b && a.uri === b.uri && sameRange(a.byteRange, b.byteRange) && sameKeys(a, b));
}
function sameKeys(a, b) {
    const before = activeKeys(a);
    const after = activeKeys(b);
    return before.length === after.length && before.every((key, index) => sameKey(key, after[index]));
}
function keyIdentity(key) {
    return JSON.stringify([key.method, key.uri, key.keyFormat ?? 'identity', key.keyFormatVersions]);
}
function encryptionContext(context, signal) {
    return {
        ...context,
        key: { ...context.key },
        signal,
        map: context.map
            ? {
                ...context.map,
                byteRange: context.map.byteRange ? { ...context.map.byteRange } : undefined,
                key: context.map.key ? { ...context.map.key } : undefined,
                keys: context.map.keys?.map(key => ({ ...key })),
            }
            : undefined,
    };
}
function keyIv(key, sequence) {
    const iv = new Uint8Array(16);
    if (key.iv) {
        const hex = key.iv.slice(2).padStart(32, '0');
        for (let i = 0; i < 16; i++)
            iv[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    else {
        let value = BigInt(sequence);
        for (let i = 15; i >= 0; i--) {
            iv[i] = Number(value & 255n);
            value >>= 8n;
        }
    }
    return iv;
}
async function delay(milliseconds, signal) {
    checkAbort(signal);
    let timer;
    try {
        await awaitWithAbort(new Promise(resolve => {
            timer = setTimeout(resolve, milliseconds);
        }), signal);
    }
    finally {
        clearTimeout(timer);
    }
}
const chunkByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
function checkedChunkLength(chunk, remaining) {
    let length;
    try {
        length = chunkByteLength.call(chunk);
    }
    catch {
        throw new IOError('HLS: response stream must contain Uint8Array chunks');
    }
    assertSourceBytes(chunk, length, 'HLS response');
    if (length > remaining)
        throw new IOError('HLS: response exceeds the configured byte limit');
    return length;
}
export class HlsClient {
    fetcher;
    options;
    context;
    controller = new AbortController();
    maxPlaylistBytes;
    maxSegmentBytes;
    encryptionHandlers;
    keyLoader;
    maxKeyBytes;
    maxCachedKeys;
    requestTimeoutMs;
    adaptiveOptions;
    onVariantChange;
    adaptiveMaster;
    current;
    playlistUrl;
    active = false;
    loading = false;
    constructor(options = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options))
            throw new MediaForgeError('HLS: client options must be an object', 'FORMAT');
        const receiver = options;
        this.options = options = {
            fetch: options.fetch,
            signal: options.signal,
            maxPlaylistBytes: options.maxPlaylistBytes,
            maxSegmentBytes: options.maxSegmentBytes,
            maxPlaylistEntries: options.maxPlaylistEntries,
            encryptionHandlers: options.encryptionHandlers,
            keyLoader: options.keyLoader,
            maxKeyBytes: options.maxKeyBytes,
            maxCachedKeys: options.maxCachedKeys,
            refreshIntervalMs: options.refreshIntervalMs,
            requestTimeoutMs: options.requestTimeoutMs,
            validation: options.validation,
            metadataPolicy: options.metadataPolicy,
            onWarning: options.onWarning,
            maxWarnings: options.maxWarnings,
            adaptive: options.adaptive,
        };
        const fetcher = options.fetch === undefined ? globalThis.fetch : options.fetch;
        if (typeof fetcher !== 'function')
            throw new MediaForgeError('HLS: fetch is unavailable; supply a fetch implementation', 'FORMAT');
        this.fetcher = fetcher.bind(globalThis);
        this.context = new DiagnosticContext(options, 'compatible');
        this.maxPlaylistBytes = positiveInteger(options.maxPlaylistBytes ?? 2 * 1024 * 1024, 'maxPlaylistBytes');
        this.maxSegmentBytes = positiveInteger(options.maxSegmentBytes ?? 64 * 1024 * 1024, 'maxSegmentBytes');
        this.maxKeyBytes = positiveInteger(options.maxKeyBytes ?? 65536, 'maxKeyBytes');
        this.maxCachedKeys = options.maxCachedKeys ?? 8;
        if (!Number.isSafeInteger(this.maxCachedKeys) || this.maxCachedKeys < 0)
            throw new MediaForgeError('HLS: invalid maxCachedKeys', 'FORMAT');
        if (options.keyLoader !== undefined && typeof options.keyLoader !== 'function')
            throw new MediaForgeError('HLS: keyLoader must be a function', 'FORMAT');
        this.keyLoader = options.keyLoader?.bind(receiver);
        if (options.encryptionHandlers !== undefined && !Array.isArray(options.encryptionHandlers))
            throw new MediaForgeError('HLS: encryptionHandlers must be an array', 'FORMAT');
        this.encryptionHandlers = Array.from(options.encryptionHandlers ?? [], handler => {
            if (!handler || typeof handler !== 'object' || Array.isArray(handler))
                throw new MediaForgeError('HLS: encryption handler must be an object', 'FORMAT');
            const supports = handler.supports;
            const decrypt = handler.decrypt;
            const retainsEncryption = handler.retainsEncryption;
            if (typeof supports !== 'function' || typeof decrypt !== 'function')
                throw new MediaForgeError('HLS: encryption handler requires supports and decrypt functions', 'FORMAT');
            if (retainsEncryption !== undefined && typeof retainsEncryption !== 'boolean')
                throw new MediaForgeError('HLS: retainsEncryption must be a boolean', 'FORMAT');
            return { supports: supports.bind(handler), decrypt: decrypt.bind(handler), retainsEncryption };
        });
        if (options.maxPlaylistEntries !== undefined)
            positiveInteger(options.maxPlaylistEntries, 'maxPlaylistEntries');
        this.requestTimeoutMs = timerInteger(options.requestTimeoutMs ?? 30000, 'requestTimeoutMs');
        if (options.refreshIntervalMs !== undefined)
            timerInteger(options.refreshIntervalMs, 'refreshIntervalMs');
        const adaptive = options.adaptive;
        if (adaptive !== undefined && adaptive !== false) {
            if (adaptive !== true && (!adaptive || typeof adaptive !== 'object' || Array.isArray(adaptive))) {
                throw new MediaForgeError('HLS: adaptive must be a boolean or options object', 'FORMAT');
            }
            const settings = adaptive === true ? {} : adaptive;
            this.adaptiveOptions = {
                initialBandwidth: settings.initialBandwidth,
                bandwidthSafetyFactor: settings.bandwidthSafetyFactor,
                upSwitchSegments: settings.upSwitchSegments,
            };
            new AdaptiveQualityController(this.adaptiveOptions);
            const listener = settings.onVariantChange;
            if (listener !== undefined && typeof listener !== 'function')
                throw new MediaForgeError('HLS: onVariantChange must be a function', 'FORMAT');
            this.onVariantChange = listener?.bind(settings);
        }
    }
    get playlist() {
        return this.current;
    }
    get diagnostics() {
        return this.context.warnings;
    }
    async load(url, options = {}) {
        if (this.active || this.loading)
            throw new MediaForgeError('HLS: another playlist operation is active', 'INPUT');
        const linked = linkAbortSignals(this.controller.signal, this.options.signal, options.signal);
        this.loading = true;
        try {
            const result = await this.readPlaylist(networkUri(url), linked.signal);
            checkAbort(linked.signal);
            this.current = result.playlist;
            this.playlistUrl = result.url;
            this.adaptiveMaster = result.playlist.type === 'master' ? result.playlist : undefined;
            return result.playlist;
        }
        finally {
            linked.dispose();
            this.loading = false;
        }
    }
    async refresh(options = {}) {
        if (!this.playlistUrl)
            throw new MediaForgeError('HLS: load a playlist before refreshing', 'INPUT');
        if (this.active || this.loading)
            throw new MediaForgeError('HLS: another playlist operation is active', 'INPUT');
        const linked = linkAbortSignals(this.controller.signal, this.options.signal, options.signal);
        this.loading = true;
        try {
            const result = await this.readPlaylist(this.playlistUrl, linked.signal, this.current?.type === 'media' ? this.current : undefined);
            checkAbort(linked.signal);
            if (this.current?.type === 'media') {
                if (result.playlist.type !== 'media')
                    throw new MediaForgeError('HLS: a refresh changed the playlist type', 'FORMAT');
                this.validateRefresh(this.current, result.playlist);
            }
            this.current = result.playlist;
            this.playlistUrl = result.url;
            if (result.playlist.type === 'master')
                this.adaptiveMaster = result.playlist;
            return result.playlist;
        }
        finally {
            linked.dispose();
            this.loading = false;
        }
    }
    close(reason) {
        this.controller.abort(reason);
    }
    segments(options = {}) {
        const settings = segmentOptions(options);
        if (this.adaptiveOptions && settings.live)
            settings.maxIdleRefreshes ??= 10;
        return cancellableIterator(signal => this.readSegments(settings, signal));
    }
    parts(options = {}) {
        const settings = segmentOptions(options);
        settings.maxIdleRefreshes ??= 10;
        return cancellableIterator(signal => this.readMedia(settings, signal, true));
    }
    async *readSegments(options, iteratorSignal) {
        for await (const unit of this.readMedia(options, iteratorSignal, false)) {
            if (unit.type === 'segment')
                yield {
                    segment: unit.segment,
                    data: unit.data,
                    initData: unit.initData,
                    variant: unit.variant,
                    encryption: unit.encryption,
                };
        }
    }
    async *readMedia(options, iteratorSignal, useParts) {
        if (this.active || this.loading)
            throw new MediaForgeError('HLS: another playlist operation is active', 'INPUT');
        if (this.adaptiveOptions && !this.adaptiveMaster)
            throw new MediaForgeError('HLS: adaptive mode requires loading a master playlist', 'INPUT');
        if (!this.current || !this.playlistUrl || (this.current.type !== 'media' && !this.adaptiveOptions)) {
            throw new MediaForgeError('HLS: load a media playlist; select a master variant or rendition explicitly', 'INPUT');
        }
        const linked = linkAbortSignals(this.controller.signal, this.options.signal, options.signal, iteratorSignal);
        this.active = true;
        let adaptive;
        let playlist;
        let sequence;
        let partIndex = 0;
        let partDuration = 0;
        let refreshes = 0;
        let idleRefreshes = 0;
        let progress = 0;
        let lastMap;
        let lastMapEncryption;
        let lastDiscontinuity;
        const keys = new Map();
        const importedKeys = new Map();
        const pendingKeys = new Map();
        let acceptingKeys = true;
        const loadKey = async (context) => {
            checkAbort(context.signal);
            if (!acceptingKeys)
                throw new MediaForgeError('Aborted', 'ABORT');
            const identity = keyIdentity(context.key);
            const cached = keys.get(identity);
            if (cached) {
                keys.delete(identity);
                keys.set(identity, cached);
                return new Uint8Array(cached);
            }
            let pending = pendingKeys.get(identity);
            if (!pending) {
                pending = this.runEncryptionOperation(signal => {
                    const snapshot = (bytes) => {
                        checkAbort(signal);
                        checkedChunkLength(bytes, this.maxKeyBytes);
                        return new Uint8Array(bytes);
                    };
                    if (this.keyLoader) {
                        const result = this.keyLoader(encryptionContext(context, signal));
                        return ArrayBuffer.isView(result)
                            ? snapshot(result)
                            : Promise.resolve(result).then(snapshot);
                    }
                    return this.readResource(networkUri(context.key.uri), this.maxKeyBytes, signal).then(result => snapshot(result.bytes));
                }, context.signal).then(bytes => {
                    checkAbort(context.signal);
                    if (!acceptingKeys)
                        throw new MediaForgeError('Aborted', 'ABORT');
                    if (this.maxCachedKeys) {
                        keys.set(identity, bytes);
                        if (keys.size > this.maxCachedKeys) {
                            const oldest = keys.keys().next().value;
                            keys.delete(oldest);
                            importedKeys.delete(oldest);
                        }
                    }
                    return bytes;
                });
                pendingKeys.set(identity, pending);
                void pending
                    .finally(() => {
                    if (pendingKeys.get(identity) === pending)
                        pendingKeys.delete(identity);
                })
                    .catch(() => undefined);
            }
            const bytes = await awaitWithAbort(pending, context.signal);
            checkAbort(context.signal);
            return new Uint8Array(bytes);
        };
        const selectEncryption = async (value, context) => {
            const alternatives = activeKeys(value);
            for (const handler of this.encryptionHandlers) {
                for (const key of alternatives) {
                    const candidate = { ...context, key: { ...key } };
                    const supported = await this.runEncryptionOperation(signal => {
                        const result = handler.supports(encryptionContext(candidate, signal));
                        if (typeof result !== 'boolean')
                            throw new MediaForgeError('HLS: supports must return a boolean', 'FORMAT');
                        return result;
                    }, linked.signal);
                    if (supported)
                        return { context: candidate, handler };
                }
            }
            if (!alternatives.length)
                return undefined;
            const key = alternatives.find(key => this.isBuiltinEncryption(key, playlist.iframeOnly)) ??
                alternatives[alternatives.length - 1];
            this.checkEncryption(key, playlist.iframeOnly);
            return { context: { ...context, key: { ...key } } };
        };
        const decrypt = async (bytes, selected) => {
            if (!selected)
                return bytes;
            return this.runEncryptionOperation(async (signal) => {
                const context = encryptionContext(selected.context, signal);
                let result;
                if (selected.handler) {
                    result = await selected.handler.decrypt({
                        ...context,
                        data: bytes,
                        loadKey: () => loadKey(encryptionContext(selected.context, signal)),
                    });
                }
                else {
                    const raw = await loadKey(context);
                    if (raw.length !== 16)
                        throw new MediaForgeError('HLS: AES-128 keys must contain exactly 16 bytes', 'FORMAT');
                    const identity = keyIdentity(context.key);
                    let imported = importedKeys.get(identity);
                    if (!imported) {
                        imported = await awaitWithAbort(globalThis.crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']), signal);
                        checkAbort(signal);
                        if (this.maxCachedKeys)
                            importedKeys.set(identity, imported);
                    }
                    try {
                        const plaintext = await awaitWithAbort(globalThis.crypto.subtle.decrypt({ name: 'AES-CBC', iv: keyIv(context.key, context.sequence) }, imported, bytes), signal);
                        result = new Uint8Array(plaintext);
                    }
                    catch (error) {
                        checkAbort(signal);
                        throw new MediaForgeError(`HLS: AES-128 decryption failed${error instanceof Error ? `: ${error.message}` : ''}`, 'DECODE');
                    }
                }
                checkAbort(signal);
                checkedChunkLength(result, this.maxSegmentBytes);
                return result;
            }, linked.signal);
        };
        const readUnit = async (unit, number, discontinuity, switching = false) => {
            const selected = await selectEncryption(unit, {
                kind: 'partIndex' in unit ? 'part' : 'segment',
                sequence: number,
                partIndex: 'partIndex' in unit ? unit.partIndex : undefined,
                uri: unit.uri,
                map: unit.map,
                signal: linked.signal,
            });
            let initData;
            const identity = unit.map ? mapIdentity(unit.map) : undefined;
            let mapEncryption = identity === lastMap && discontinuity === lastDiscontinuity && !switching
                ? lastMapEncryption
                : undefined;
            const mediaEncryption = selected?.handler?.retainsEncryption ? { ...selected.context.key } : undefined;
            const checkMapEncryption = () => {
                if (mapEncryption &&
                    mediaEncryption &&
                    (mapEncryption.method !== mediaEncryption.method ||
                        (mapEncryption.keyFormat ?? 'identity') !== (mediaEncryption.keyFormat ?? 'identity'))) {
                    throw new MediaForgeError('HLS: initialization map and media retain incompatible encryption', 'FORMAT');
                }
            };
            if (unit.map) {
                if (switching || identity !== lastMap || discontinuity !== lastDiscontinuity) {
                    const mapSelected = await selectEncryption(unit.map, {
                        kind: 'map',
                        sequence: number,
                        uri: unit.map.uri,
                        map: unit.map,
                        signal: linked.signal,
                    });
                    if (mapSelected?.handler?.retainsEncryption)
                        mapEncryption = { ...mapSelected.context.key };
                    checkMapEncryption();
                    const result = await this.readResource(networkUri(unit.map.uri), this.maxSegmentBytes, linked.signal, unit.map.byteRange);
                    initData = await decrypt(result.bytes, mapSelected);
                }
            }
            checkMapEncryption();
            const started = monotonicNow();
            const result = await this.readResource(networkUri(unit.uri), this.maxSegmentBytes, linked.signal, unit.byteRange);
            const elapsedMs = Math.max(0, monotonicNow() - started);
            const data = await decrypt(result.bytes, selected);
            checkAbort(linked.signal);
            const encryption = mediaEncryption ?? (initData ? mapEncryption : undefined);
            return {
                data,
                initData,
                encryption,
                mapEncryption,
                map: identity,
                discontinuity,
                byteLength: result.bytes.byteLength,
                elapsedMs,
            };
        };
        const commitUnit = (unit) => {
            lastMap = unit.map;
            lastMapEncryption = unit.mapEncryption;
            lastDiscontinuity = unit.discontinuity;
            if (adaptive)
                adaptive.controller.addSample(unit.byteLength, unit.elapsedMs);
            return { data: unit.data, initData: unit.initData, encryption: unit.encryption };
        };
        const preparePart = useParts
            ? (part) => readUnit(part, part.sequence, part.discontinuitySequence, true)
            : undefined;
        const notifyInitial = async (sequence, partIndex) => {
            if (!adaptive || adaptive.initialNotified)
                return;
            await this.notifyVariant({
                variant: variantSnapshot(adaptive.variant),
                sequence,
                partIndex,
                bandwidthEstimate: adaptive.controller.bandwidthEstimate,
                reason: 'initial',
            }, linked.signal);
            adaptive.initialNotified = true;
        };
        try {
            if (this.adaptiveOptions) {
                adaptive = await this.prepareAdaptive(options, linked.signal, useParts);
                playlist = adaptive.current.playlist;
            }
            else
                playlist = this.current;
            sequence = options.startSequence ?? playlist.mediaSequence;
            while (true) {
                checkAbort(linked.signal);
                const beforeProgress = progress;
                if (sequence < playlist.mediaSequence) {
                    this.context.recover({
                        code: 'HLS_LIVE_WINDOW',
                        message: `Live playlist advanced past segment ${sequence}; resumed at ${playlist.mediaSequence}`,
                        format: 'hls',
                    });
                    checkAbort(linked.signal);
                    sequence = playlist.mediaSequence;
                    partIndex = 0;
                    partDuration = 0;
                }
                while (true) {
                    let index = sequence - playlist.mediaSequence;
                    let segment = playlist.segments[index];
                    let parts = useParts ? playlistParts(playlist, index) : undefined;
                    let part = parts?.[partIndex];
                    let downloaded;
                    if (!segment && !part)
                        break;
                    checkAbort(linked.signal);
                    if (adaptive && (part || !partIndex)) {
                        const updated = await this.selectAdaptive(adaptive, playlist, index, linked.signal, part
                            ? {
                                part,
                                offset: partDuration,
                                canRefresh: options.live === true &&
                                    (options.maxRefreshes === undefined || refreshes < options.maxRefreshes),
                            }
                            : undefined, preparePart);
                        checkAbort(linked.signal);
                        if (updated) {
                            playlist = updated.playlist;
                            index = updated.index;
                            sequence = playlist.mediaSequence + index;
                            partIndex = updated.partIndex ?? 0;
                            parts = useParts ? playlistParts(playlist, index) : undefined;
                            part = parts?.[partIndex];
                            partDuration =
                                parts?.slice(0, partIndex).reduce((sum, item) => sum + item.duration, 0) ?? 0;
                            segment = playlist.segments[index];
                            downloaded = updated.downloaded;
                            this.current = playlist;
                            this.playlistUrl = updated.url;
                            lastMap = undefined;
                        }
                    }
                    if (part && !segment?.gap) {
                        if (part.sequence !== sequence ||
                            part.partIndex !== partIndex ||
                            part.discontinuitySequence === undefined) {
                            throw new MediaForgeError('HLS: inconsistent PART context', 'FORMAT');
                        }
                        if (segment && partDuration + part.duration > segment.duration + 0.001) {
                            throw new MediaForgeError('HLS: PART durations exceed their parent segment', 'FORMAT');
                        }
                        const index = partIndex++;
                        partDuration += part.duration;
                        progress++;
                        if (part.gap) {
                            this.context.recover({
                                code: 'HLS_GAP',
                                message: `Skipped unavailable part ${sequence}:${index}`,
                                format: 'hls',
                            });
                        }
                        else {
                            await notifyInitial(sequence, index);
                            const data = commitUnit(downloaded ?? (await readUnit(part, sequence, part.discontinuitySequence)));
                            yield {
                                type: 'part',
                                part,
                                sequence,
                                partIndex: index,
                                discontinuitySequence: part.discontinuitySequence,
                                ...data,
                                variant: adaptive ? variantSnapshot(adaptive.variant) : undefined,
                            };
                        }
                        checkAbort(linked.signal);
                        continue;
                    }
                    if (!segment)
                        break;
                    if (segment.gap) {
                        this.context.recover({
                            code: 'HLS_GAP',
                            message: `Skipped unavailable segment ${segment.sequence}`,
                            format: 'hls',
                        });
                        checkAbort(linked.signal);
                    }
                    else if (useParts && partIndex) {
                        if (partDuration + 0.001 < segment.duration) {
                            this.context.recover({
                                code: 'HLS_PART_WINDOW',
                                message: `Remaining parts of segment ${sequence} are unavailable; complete bytes would duplicate delivered media`,
                                format: 'hls',
                            });
                            checkAbort(linked.signal);
                        }
                    }
                    else {
                        await notifyInitial(segment.sequence);
                        const data = commitUnit(await readUnit(segment, segment.sequence, segment.discontinuitySequence));
                        yield {
                            type: 'segment',
                            segment,
                            ...data,
                            variant: adaptive ? variantSnapshot(adaptive.variant) : undefined,
                        };
                    }
                    checkAbort(linked.signal);
                    sequence = segment.sequence + 1;
                    progress++;
                    if (!Number.isSafeInteger(sequence))
                        throw new MediaForgeError('HLS: segment sequence exhausted safe integer precision', 'FORMAT');
                    partIndex = 0;
                    partDuration = 0;
                }
                if (!options.live || playlist.endList)
                    return;
                if (refreshes)
                    idleRefreshes = progress !== beforeProgress ? 0 : idleRefreshes + 1;
                if (options.maxRefreshes !== undefined && refreshes >= options.maxRefreshes)
                    return;
                if (options.maxIdleRefreshes !== undefined && idleRefreshes >= options.maxIdleRefreshes)
                    throw new IOError('HLS: live playlist did not advance within maxIdleRefreshes');
                const interval = this.options.refreshIntervalMs ??
                    (useParts ? (playlist.partTarget ?? playlist.targetDuration) : playlist.targetDuration) * 1000;
                await delay(Math.max(1, Math.min(interval, 0x7fffffff)), linked.signal);
                const previous = playlist;
                const updated = await this.readPlaylist(this.playlistUrl, linked.signal, previous);
                checkAbort(linked.signal);
                if (updated.playlist.type !== 'media')
                    throw new MediaForgeError('HLS: a live refresh changed the playlist type', 'FORMAT');
                playlist = updated.playlist;
                this.validateRefresh(previous, playlist);
                if (adaptive) {
                    adaptive.current = {
                        playlist,
                        url: updated.url,
                        loadedAt: monotonicNow(),
                        timeline: adaptiveTimeline(playlist, adaptive.current),
                    };
                    adaptive.generation++;
                }
                this.current = playlist;
                this.playlistUrl = updated.url;
                refreshes++;
            }
        }
        finally {
            acceptingKeys = false;
            keys.clear();
            importedKeys.clear();
            pendingKeys.clear();
            linked.dispose();
            this.active = false;
        }
    }
    async notifyVariant(event, signal) {
        checkAbort(signal);
        if (this.onVariantChange)
            await awaitWithAbort(Promise.resolve(this.onVariantChange(event)), signal);
        checkAbort(signal);
    }
    async prepareAdaptive(options, signal, useParts) {
        const master = this.adaptiveMaster;
        const candidates = master.variants.filter(variant => !variant.iframe).map(variantSnapshot);
        if (!candidates.length)
            throw new MediaForgeError('HLS: no complete-segment variants are available', 'FORMAT');
        const controller = new AdaptiveQualityController(this.adaptiveOptions);
        const bandwidth = controller.selectBandwidth(candidates.map(variant => variant.bandwidth));
        const variant = candidates.find(candidate => candidate.bandwidth === bandwidth);
        const result = await this.readPlaylist(networkUri(variant.uri), signal);
        checkAbort(signal);
        if (result.playlist.type !== 'media' || result.playlist.iframeOnly) {
            throw new MediaForgeError('HLS: adaptive mode requires non-I-frame media playlists', 'FORMAT');
        }
        const reference = result.playlist;
        const sequence = Math.max(options.startSequence ?? reference.mediaSequence, reference.mediaSequence);
        if (!useParts)
            await this.notifyVariant({
                variant: variantSnapshot(variant),
                sequence,
                bandwidthEstimate: controller.bandwidthEstimate,
                reason: 'initial',
            }, signal);
        this.current = reference;
        this.playlistUrl = result.url;
        return {
            controller,
            variant,
            variants: candidates.filter(candidate => candidate === variant || compatibleVariant(variant, candidate)),
            current: {
                playlist: reference,
                url: result.url,
                loadedAt: monotonicNow(),
                timeline: adaptiveTimeline(reference),
            },
            generation: 0,
            completeTimeline: reference.endList,
            masterIndependent: master.independentSegments === true,
            initialNotified: !useParts,
        };
    }
    async selectAdaptive(session, current, index, signal, partBoundary, preparePart) {
        if (!session.initialNotified)
            return undefined;
        const bandwidth = session.controller.selectBandwidth(session.variants.map(variant => variant.bandwidth), session.variant.bandwidth);
        if (bandwidth === session.variant.bandwidth)
            return undefined;
        const candidate = session.variants.find(variant => variant.bandwidth === bandwidth);
        let alternate = session.alternate;
        const now = monotonicNow();
        const interval = this.options.refreshIntervalMs ??
            (partBoundary ? (current.partTarget ?? current.targetDuration) : current.targetDuration) * 1000;
        if (!alternate ||
            alternate.variant !== candidate ||
            (!alternate.snapshot?.playlist.endList &&
                (alternate.generation !== session.generation || now - alternate.checkedAt >= interval))) {
            const old = alternate?.variant === candidate ? alternate.snapshot : undefined;
            alternate = { variant: candidate, checkedAt: now, generation: session.generation };
            session.alternate = alternate;
            const warnings = [];
            try {
                const result = await this.readPlaylist(old?.url ?? networkUri(candidate.uri), signal, old?.playlist, warning => warnings.push(warning));
                checkAbort(signal);
                if (result.playlist.type === 'media') {
                    if (old)
                        this.validateRefresh(old.playlist, result.playlist);
                    alternate.snapshot = {
                        playlist: result.playlist,
                        url: result.url,
                        loadedAt: monotonicNow(),
                        timeline: adaptiveTimeline(result.playlist, old),
                    };
                }
            }
            catch {
                checkAbort(signal);
                this.context.warn({
                    code: 'HLS_ADAPTIVE_UNAVAILABLE',
                    message: `Variant ${candidate.uri} could not be refreshed; continuing the current variant`,
                    format: 'hls',
                });
                checkAbort(signal);
                alternate.warned = true;
                return undefined;
            }
            for (const warning of warnings) {
                this.context.warn(warning);
                checkAbort(signal);
            }
        }
        const snapshot = alternate.snapshot;
        let candidateIndex = -1;
        let candidatePartIndex;
        if (partBoundary &&
            snapshot &&
            !snapshot.playlist.iframeOnly &&
            current.targetDuration === snapshot.playlist.targetDuration) {
            const match = alignedPartBoundary(session.current, snapshot, index, partBoundary.offset, partBoundary.part, session.masterIndependent, partBoundary.canRefresh);
            candidateIndex = match?.index ?? -1;
            candidatePartIndex = match?.partIndex;
        }
        else if (!partBoundary &&
            snapshot &&
            !snapshot.playlist.iframeOnly &&
            current.targetDuration === snapshot.playlist.targetDuration &&
            (session.masterIndependent || (current.independentSegments && snapshot.playlist.independentSegments))) {
            if (session.completeTimeline) {
                if (alignedVod(current, snapshot.playlist, session.masterIndependent))
                    candidateIndex = index;
            }
            else
                candidateIndex = alignedLiveIndex(session.current, snapshot, index);
        }
        if (preparePart && snapshot && candidateIndex >= 0 && candidatePartIndex === undefined) {
            const parts = playlistParts(snapshot.playlist, candidateIndex);
            const first = parts?.[0];
            if (first) {
                const independent = first.independent === true ||
                    (first.independent !== false &&
                        (session.masterIndependent || snapshot.playlist.independentSegments));
                const duration = parts.reduce((sum, item) => sum + item.duration, 0);
                if (!independent ||
                    first.gap ||
                    Math.abs(duration - snapshot.playlist.segments[candidateIndex].duration) > 0.001)
                    candidateIndex = -1;
                else
                    candidatePartIndex = 0;
            }
        }
        if (!snapshot || candidateIndex < 0) {
            if (!alternate.warned)
                this.context.warn({
                    code: 'HLS_ADAPTIVE_ALIGNMENT',
                    message: `Variant ${candidate.uri} has no matching independent media boundary; continuing the current variant`,
                    format: 'hls',
                });
            alternate.warned = true;
            checkAbort(signal);
            return undefined;
        }
        let downloaded;
        if (preparePart && candidatePartIndex !== undefined) {
            try {
                downloaded = await preparePart(playlistParts(snapshot.playlist, candidateIndex)[candidatePartIndex]);
                checkAbort(signal);
            }
            catch {
                checkAbort(signal);
                this.context.warn({
                    code: 'HLS_ADAPTIVE_UNAVAILABLE',
                    message: `Variant ${candidate.uri} PART could not be loaded; continuing the current variant`,
                    format: 'hls',
                });
                checkAbort(signal);
                return undefined;
            }
        }
        const previous = session.variant;
        await this.notifyVariant({
            previous: variantSnapshot(previous),
            variant: variantSnapshot(candidate),
            sequence: snapshot.playlist.mediaSequence + candidateIndex,
            partIndex: candidatePartIndex,
            bandwidthEstimate: session.controller.bandwidthEstimate,
            reason: bandwidth > previous.bandwidth ? 'up' : 'down',
        }, signal);
        session.alternate = {
            variant: previous,
            snapshot: session.current,
            checkedAt: session.current.loadedAt,
            generation: session.generation,
        };
        session.variant = candidate;
        session.current = snapshot;
        return {
            playlist: snapshot.playlist,
            url: snapshot.url,
            index: candidateIndex,
            partIndex: candidatePartIndex,
            downloaded,
        };
    }
    async runEncryptionOperation(operation, signal) {
        checkAbort(signal);
        const timeout = new AbortController();
        const linked = linkAbortSignals(signal, timeout.signal);
        const started = monotonicNow();
        const deadline = new IOError('HLS: encryption operation exceeded requestTimeoutMs');
        const check = () => {
            checkAbort(signal);
            if (timeout.signal.aborted || monotonicNow() - started >= this.requestTimeoutMs)
                throw deadline;
        };
        let onAbort = () => undefined;
        const stopped = new Promise((_resolve, reject) => {
            onAbort = () => reject(signal.aborted ? new MediaForgeError('Aborted', 'ABORT') : deadline);
            linked.signal.addEventListener('abort', onAbort, { once: true });
        });
        const timer = setTimeout(() => timeout.abort(), this.requestTimeoutMs);
        try {
            const result = await Promise.race([
                Promise.resolve().then(() => {
                    check();
                    return operation(linked.signal);
                }),
                stopped,
            ]);
            check();
            return result;
        }
        finally {
            clearTimeout(timer);
            linked.signal.removeEventListener('abort', onAbort);
            timeout.abort();
            linked.dispose();
        }
    }
    isBuiltinEncryption(key, iframeOnly) {
        return (key.method === 'AES-128' &&
            (!key.keyFormat || key.keyFormat === 'identity') &&
            (!key.keyFormatVersions || key.keyFormatVersions.split('/').includes('1')) &&
            !iframeOnly);
    }
    checkEncryption(key, iframeOnly) {
        if (!this.isBuiltinEncryption(key, iframeOnly)) {
            throw new MediaForgeError(`HLS: unsupported encryption ${key.method}${key.keyFormat ? ` (${key.keyFormat})` : ''}${iframeOnly ? ' in an I-frame playlist' : ''}`, 'FORMAT');
        }
        if (!globalThis.crypto?.subtle)
            throw new MediaForgeError('HLS: AES-128 requires WebCrypto SubtleCrypto', 'FORMAT');
    }
    validateRefresh(previous, next) {
        if (next.mediaSequence < previous.mediaSequence ||
            next.discontinuitySequence < previous.discontinuitySequence) {
            throw new MediaForgeError('HLS: live playlist sequence moved backwards', 'FORMAT');
        }
        if (next.targetDuration !== previous.targetDuration)
            throw new MediaForgeError('HLS: live TARGETDURATION changed', 'FORMAT');
        if (previous.partTarget !== undefined &&
            next.partTarget !== undefined &&
            previous.partTarget !== next.partTarget)
            throw new MediaForgeError('HLS: live PART-TARGET changed', 'FORMAT');
        if (previous.endList && !next.endList)
            throw new MediaForgeError('HLS: refresh removed ENDLIST', 'FORMAT');
        const previousEnd = previous.mediaSequence + previous.segments.length;
        const nextEnd = next.mediaSequence + next.segments.length;
        if (nextEnd < previousEnd)
            throw new MediaForgeError('HLS: live playlist end moved backwards', 'FORMAT');
        for (const segment of next.segments) {
            const old = previous.segments[segment.sequence - previous.mediaSequence];
            if (old === segment)
                continue;
            if (old &&
                (old.uri !== segment.uri ||
                    old.duration !== segment.duration ||
                    old.gap !== segment.gap ||
                    old.discontinuitySequence !== segment.discontinuitySequence ||
                    !sameRange(old.byteRange, segment.byteRange) ||
                    !sameKeys(old, segment) ||
                    !sameMap(old.map, segment.map))) {
                throw new MediaForgeError('HLS: live refresh changed an existing segment', 'FORMAT');
            }
        }
        for (let group = 0; group <= previous.segments.length; group++) {
            const sequence = previous.mediaSequence + group;
            if (sequence < next.mediaSequence)
                continue;
            const parts = playlistParts(previous, group);
            if (!parts?.length)
                continue;
            const updated = playlistParts(next, sequence - next.mediaSequence);
            if (updated === parts)
                continue;
            if (!updated?.length && sequence < nextEnd)
                continue;
            if (!updated || updated.length < parts.length)
                throw new MediaForgeError('HLS: live refresh removed published PARTs', 'FORMAT');
            for (let index = 0; index < parts.length; index++) {
                const old = parts[index];
                const part = updated[index];
                if (old.uri !== part.uri ||
                    old.duration !== part.duration ||
                    old.gap !== part.gap ||
                    old.independent !== part.independent ||
                    old.discontinuitySequence !== part.discontinuitySequence ||
                    !sameRange(old.byteRange, part.byteRange) ||
                    !sameKeys(old, part) ||
                    !sameMap(old.map, part.map)) {
                    throw new MediaForgeError('HLS: live refresh changed an existing PART', 'FORMAT');
                }
            }
        }
        if (previous.trailingParts?.length) {
            const completed = next.segments[previousEnd - next.mediaSequence];
            const part = previous.trailingParts[0];
            if (completed &&
                (completed.discontinuitySequence !== part.discontinuitySequence ||
                    !sameKeys(completed, part) ||
                    !sameMap(completed.map, part.map))) {
                throw new MediaForgeError('HLS: completed segment changed its PART context', 'FORMAT');
            }
        }
    }
    async readPlaylist(url, signal, previousPlaylist, onWarning = diagnostic => this.context.warn(diagnostic)) {
        const result = await this.readResource(url, this.maxPlaylistBytes, signal);
        let text;
        try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.bytes);
        }
        catch {
            throw new MediaForgeError('HLS: playlist is not valid UTF-8', 'FORMAT');
        }
        const playlist = parseHlsPlaylist(text, { ...this.options, baseUrl: result.url, previousPlaylist, onWarning });
        checkAbort(signal);
        if (playlist.type === 'media' && playlist.skippedSegments)
            throw new MediaForgeError('HLS: delta reconstruction requires previous playlist history', 'FORMAT');
        return { playlist, url: result.url };
    }
    async readResource(url, limit, signal, range) {
        const timeout = new AbortController();
        const linked = linkAbortSignals(signal, timeout.signal);
        const timer = setTimeout(() => timeout.abort(), this.requestTimeoutMs);
        const started = monotonicNow();
        const check = () => {
            checkAbort(signal);
            if (timeout.signal.aborted || monotonicNow() - started >= this.requestTimeoutMs) {
                throw new IOError('HLS: resource request exceeded requestTimeoutMs');
            }
        };
        try {
            return await this.readResourceBody(url, limit, linked.signal, check, range);
        }
        finally {
            clearTimeout(timer);
            linked.dispose();
        }
    }
    async readResourceBody(url, limit, signal, check, range) {
        check();
        if (range && range.length > limit)
            throw new IOError('HLS: byte range exceeds the configured byte limit');
        const pending = Promise.resolve().then(() => {
            check();
            return this.fetcher(url, {
                signal,
                headers: range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined,
            });
        });
        void pending.then(response => {
            if (signal.aborted) {
                try {
                    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
                }
                catch { }
            }
        }, () => undefined);
        let response;
        let reader;
        try {
            response = await awaitWithAbort(pending, signal);
            check();
            if (!response.ok)
                throw new IOError(`HLS: HTTP ${response.status} for ${url}`);
            if (range) {
                const encoding = response.headers.get('Content-Encoding');
                if (encoding && encoding.trim().toLowerCase() !== 'identity')
                    throw new IOError('HLS: encoded range responses are unsupported');
                const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('Content-Range') ?? '');
                if (response.status !== 206 ||
                    !match ||
                    Number(match[1]) !== range.offset ||
                    Number(match[2]) !== range.offset + range.length - 1 ||
                    (match[3] !== '*' &&
                        (!Number.isSafeInteger(Number(match[3])) || Number(match[2]) >= Number(match[3])))) {
                    throw new IOError('HLS: server did not honor the requested byte range');
                }
            }
            else if (response.status === 206)
                throw new IOError('HLS: unexpected partial response');
            const lengthHeader = response.headers.get('Content-Length');
            if (lengthHeader !== null && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > limit) {
                throw new IOError('HLS: response exceeds the configured byte limit');
            }
            const chunks = [];
            let page;
            let used = 0;
            let length = 0;
            let emptyChunks = 0;
            let chunksRead = 0;
            let lastYield = monotonicNow();
            let lastYieldLength = 0;
            if (response.body) {
                reader = response.body.getReader();
                while (true) {
                    if ((++chunksRead % 256 === 0 || length - lastYieldLength >= 4 * 1024 * 1024) &&
                        monotonicNow() - lastYield >= 8) {
                        await delay(0, signal);
                        lastYield = monotonicNow();
                        lastYieldLength = length;
                    }
                    const item = await awaitWithAbort(reader.read(), signal);
                    check();
                    if (item.done)
                        break;
                    const chunk = item.value;
                    const count = checkedChunkLength(chunk, limit - length);
                    if (!count) {
                        if (++emptyChunks > 1024)
                            throw new IOError('HLS: too many consecutive empty response chunks');
                        continue;
                    }
                    emptyChunks = 0;
                    if (!page || count > page.length - used) {
                        if (page && used < page.length)
                            chunks[chunks.length - 1] = page.subarray(0, used);
                        const capacity = length === 0 || count >= 65536 ? count : Math.min(limit - length, 65536);
                        page = new Uint8Array(capacity);
                        chunks.push(page);
                        used = 0;
                    }
                    page.set(chunk, used);
                    used += count;
                    length += count;
                }
            }
            if (range && length !== range.length)
                throw new IOError('HLS: truncated byte range response');
            const bytes = chunks.length === 1 ? page : new Uint8Array(length);
            if (chunks.length > 1) {
                let offset = 0;
                for (let index = 0; index < chunks.length; index++) {
                    const chunk = chunks[index];
                    const part = index === chunks.length - 1 ? chunk.subarray(0, used) : chunk;
                    bytes.set(part, offset);
                    offset += part.length;
                }
            }
            const result = {
                bytes: bytes.length === length ? bytes : bytes.slice(0, length),
                url: response.url ? networkUri(response.url) : url,
            };
            check();
            return result;
        }
        catch (error) {
            check();
            throw error;
        }
        finally {
            if (reader) {
                try {
                    void Promise.resolve(reader.cancel()).catch(() => undefined);
                }
                catch { }
                try {
                    reader.releaseLock();
                }
                catch { }
            }
            else {
                try {
                    void Promise.resolve(response?.body?.cancel()).catch(() => undefined);
                }
                catch { }
            }
        }
    }
}
