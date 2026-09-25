import { snapshotOpenOptions } from './open-options.js';
import { DemuxerRegistry } from '../demux/registry.js';
import { BlobSource, BufferSource, RangeSource } from '../io/sources.js';
import { MemorySink } from '../io/sinks.js';
import { createValidationSink } from '../io/validation-sink.js';
import { CachedSource, readCachedSource } from '../io/cached-source.js';
import { assertSourceBytes } from '../io/source-read.js';
import { copyOutputBytes } from '../io/output-data.js';
import { assertSink, drainSink } from '../io/sink-backpressure.js';
import { assertAbortSignal, awaitWithAbort, linkAbortSignals } from '../core/abort.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { withTrackJson } from '../core/track-json.js';
import { MediaForgeError } from '../core/errors.js';
import { normalizeVideoPacket } from '../core/video-packet.js';
import { isProResCodec } from '../core/prores.js';
import { CodecRegistry } from '../codecs/registry.js';
import { PacketHeap, decodeTime, lowerBound } from './packet-index.js';
import { bindCompactSampleIndex, enableCompactMP4Index, getCompactSampleIndex, sampleAt, } from '../demux/sample-index.js';
import { CmafPacketAdapter } from './cmaf-adapter.js';
import { recoverVideoConfigurations } from './video-config.js';
import { createWriters } from './formats.js';
import { resolveDemuxBudget } from '../core/demux-guard.js';
import { isBuiltinDemuxer } from './demux-ownership.js';
import { RemuxPlanner } from './remux-plan.js';
import { bindMediaFileState, forgetMediaFileState } from './file-state.js';
const REMUX_FORMATS = [
    'mp4',
    'mov',
    'm4a',
    'm4v',
    '3gp',
    'mkv',
    'webm',
    'ts',
    'flv',
    'avi',
    'fmp4',
    'aac',
    'mp1',
    'mp2',
    'mp3',
    'wav',
    'aiff',
    'au',
    'caf',
    'flac',
    'ogg',
];
const ownedDemuxResults = new WeakSet();
const closedSource = Object.freeze({
    size: 0,
    async read() {
        throw new MediaForgeError('Media file is closed', 'ABORT');
    },
});
function positiveInteger(value, fallback, label) {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1)
        throw new MediaForgeError(`${label} must be a positive safe integer`, 'INPUT');
    return result;
}
function aborted(signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
function snapshotTrack(track, owned = false) {
    if (!track || typeof track !== 'object')
        throw new MediaForgeError('Invalid media track', 'DEMUX');
    const compact = owned ? getCompactSampleIndex(track) : undefined;
    const { id, matroskaTrackUid, language, name, title, colour, default: defaultTrack, forced, commentary, alphaMode, opusTrailingPaddingSamples, audioTrailingPaddingSamples, audioPrimingSamples, incomplete, matroskaCodecDelaySeconds, editLeadTimeSeconds, editAbsoluteMediaTimeSeconds, editTimelineShiftSeconds, editMediaTimeSeconds, editPresentationDurationSeconds, presentationTimestampsIncludeEdits, codec, width, height, displayWidth, displayHeight, pixelAspectRatioNum, pixelAspectRatioDen, rotation, sampleRate, channelCount, duration, codecConfig, codecConfigurations, timescale, timestampResolutionSeconds, } = track;
    const snapshot = {
        id,
        matroskaTrackUid,
        language,
        name,
        title,
        colour,
        default: defaultTrack,
        forced,
        commentary,
        alphaMode,
        opusTrailingPaddingSamples,
        audioTrailingPaddingSamples,
        audioPrimingSamples,
        incomplete,
        matroskaCodecDelaySeconds,
        editLeadTimeSeconds,
        editAbsoluteMediaTimeSeconds,
        editTimelineShiftSeconds,
        editMediaTimeSeconds,
        editPresentationDurationSeconds,
        presentationTimestampsIncludeEdits,
        codec,
        width,
        height,
        displayWidth,
        displayHeight,
        pixelAspectRatioNum,
        pixelAspectRatioDen,
        rotation,
        sampleRate,
        channelCount,
        duration,
        samples: compact ? [] : track.samples,
        codecConfig,
        codecConfigurations,
        timescale,
        timestampResolutionSeconds,
    };
    if (compact)
        bindCompactSampleIndex(snapshot, compact);
    return snapshot;
}
export class MediaEngine {
    codecs;
    demuxers = new Map();
    ownedDemuxers = new WeakSet();
    formatDemuxers = new Map();
    writers;
    constructor(options = {}) {
        if (!options || typeof options !== 'object')
            throw new MediaForgeError('Expected engine options', 'INPUT');
        const { codecs, formats = [], demuxers = [] } = options;
        if (!Array.isArray(formats) || !Array.isArray(demuxers))
            throw new MediaForgeError('Expected format and demuxer arrays', 'INPUT');
        this.codecs = codecs ?? new CodecRegistry();
        this.writers = createWriters(formats);
        for (const format of formats)
            for (const demuxer of format.demuxers ?? [])
                this.addDemuxer(this.formatDemuxers, demuxer);
        for (const demuxer of demuxers)
            this.registerDemuxer(demuxer);
    }
    registerDemuxer(demuxer) {
        this.addDemuxer(this.demuxers, demuxer);
    }
    addDemuxer(registry, demuxer) {
        if (!demuxer || typeof demuxer !== 'object')
            throw new MediaForgeError('Expected a demuxer', 'INPUT');
        const { formats: requestedFormats, demux } = demuxer;
        if (!Array.isArray(requestedFormats) || requestedFormats.length === 0 || typeof demux !== 'function') {
            throw new MediaForgeError('Demuxer requires formats and demux()', 'INPUT');
        }
        const formats = [];
        const count = requestedFormats.length;
        for (let index = 0; index < count; index++) {
            const format = requestedFormats[index];
            if (typeof format !== 'string' || !format.trim())
                throw new MediaForgeError('Invalid demuxer format', 'INPUT');
            formats.push(format.trim().toLowerCase());
        }
        const read = Function.prototype.bind.call(demux, demuxer);
        const registered = { formats: Object.freeze(formats), demux: read };
        if (isBuiltinDemuxer(demuxer))
            this.ownedDemuxers.add(registered);
        for (const format of formats) {
            if (registry.has(format))
                throw new MediaForgeError(`Demuxer already registered for ${format}`, 'INPUT');
        }
        for (const format of formats)
            registry.set(format, registered);
    }
    async open(input, options = {}) {
        const snapshot = snapshotOpenOptions(options);
        const { format: requestedFormat, maxSamples: requestedSamples, maxIndexBytes, cacheBytes, readPageBytes, } = snapshot;
        const diagnostics = new DiagnosticContext(snapshot, 'compatible');
        const demuxOptions = {
            ...snapshot,
            validation: diagnostics.validation,
            onWarning: warning => diagnostics.warn(warning),
        };
        if (requestedFormat !== undefined && (typeof requestedFormat !== 'string' || !requestedFormat.trim())) {
            throw new MediaForgeError('format must be a nonempty string', 'INPUT');
        }
        const limit = positiveInteger(snapshot.maxPacketBytes, 64 * 1024 * 1024, 'maxPacketBytes');
        const budget = resolveDemuxBudget({ maxSamples: requestedSamples, maxIndexBytes }, 2_000_000);
        const { maxSamples } = budget;
        aborted(snapshot.signal);
        let source = input && typeof input.read === 'function'
            ? new RangeSource(input)
            : typeof Blob !== 'undefined' && input instanceof Blob
                ? new BlobSource(input)
                : new BufferSource(input);
        const cache = new CachedSource(source, { maxBytes: cacheBytes, pageBytes: readPageBytes });
        if (cacheBytes !== 0)
            source = cache;
        const format = snapshot.format?.trim().toLowerCase() ?? (await DemuxerRegistry.detectFromSource(source, snapshot.signal));
        let result;
        const demuxer = this.demuxers.get(format) ?? this.formatDemuxers.get(format);
        if (!demuxer)
            throw new MediaForgeError(`No packet demuxer registered for '${format}'`, 'FORMAT');
        const request = { ...demuxOptions, ...budget, format, maxPacketBytes: limit };
        if (this.ownedDemuxers.has(demuxer))
            enableCompactMP4Index(request);
        result = await awaitWithAbort(demuxer.demux(source, request), snapshot.signal);
        aborted(snapshot.signal);
        await recoverVideoConfigurations(result, source, diagnostics, limit, snapshot.signal);
        if (this.ownedDemuxers.has(demuxer))
            ownedDemuxResults.add(result);
        return this.createFile(source, format, result, diagnostics, limit, maxSamples, () => cache.clear(), budget.maxIndexBytes);
    }
    createFile(source, format, result, diagnostics, maxPacketBytes, maxSamples, releaseSource, maxIndexBytes) {
        return new MediaFile(source, format, result, diagnostics, maxPacketBytes, maxSamples, releaseSource, this.writers, maxIndexBytes);
    }
    async remux(file, sink, options) {
        return file.remux(sink, options);
    }
}
export class MediaFile {
    source;
    diagnostics;
    maxPacketBytes;
    releaseSource;
    writers;
    maxIndexBytes;
    format;
    title;
    indexed;
    descriptions;
    byId = new Map();
    lifetime = new AbortController();
    matroskaPassThrough;
    matroskaUnsupportedTags;
    retainedIndexBytes = 0;
    remuxPlan;
    constructor(source, format, result, diagnostics, maxPacketBytes, maxSamples, releaseSource, writers = createWriters([]), maxIndexBytes = Infinity) {
        this.source = source;
        this.diagnostics = diagnostics;
        this.maxPacketBytes = maxPacketBytes;
        this.releaseSource = releaseSource;
        this.writers = writers;
        this.maxIndexBytes = maxIndexBytes;
        const ownsSamples = ownedDemuxResults.delete(result);
        this.format = format;
        if (result.title !== undefined && typeof result.title !== 'string')
            throw new MediaForgeError('Media title must be a string', 'DEMUX');
        this.title = result.title ?? result.matroskaPassThrough?.title;
        const { matroskaPassThrough, matroskaUnsupportedTags } = result;
        this.matroskaUnsupportedTags = matroskaUnsupportedTags === true;
        if (matroskaPassThrough) {
            const { title, tags, chapters, attachments } = matroskaPassThrough;
            if (title !== undefined && typeof title !== 'string')
                throw new MediaForgeError('Matroska title must be a string', 'DEMUX');
            this.matroskaPassThrough = {
                title,
                tags: tags ? copyOutputBytes(tags) : undefined,
                chapters: chapters ? copyOutputBytes(chapters) : undefined,
                attachments: attachments ? copyOutputBytes(attachments) : undefined,
            };
        }
        const requestedGroups = [
            ['video', result.videoTracks],
            ['audio', result.audioTracks],
            ['subtitle', result.subtitleTracks ?? []],
        ];
        const groups = [];
        let trackCount = 0;
        for (const [type, tracks] of requestedGroups) {
            if (!Array.isArray(tracks))
                throw new MediaForgeError('Expected a media track array', 'DEMUX');
            const length = tracks.length;
            trackCount += length;
            if (trackCount > 128)
                throw new MediaForgeError('Too many media tracks', 'DEMUX');
            const snapshots = [];
            for (let index = 0; index < length; index++)
                snapshots.push(snapshotTrack(tracks[index], ownsSamples));
            groups.push([type, snapshots]);
        }
        const list = [];
        const reserved = new Set();
        for (const [, tracks] of groups)
            for (const track of tracks) {
                if (Number.isSafeInteger(track.id) && track.id > 0)
                    reserved.add(track.id);
            }
        let nextId = 1;
        let totalSampleCount = 0;
        let indexBytes = 0;
        for (const [type, tracks] of groups)
            for (const raw of tracks) {
                if (typeof raw.codec !== 'string' || !raw.codec || !Number.isFinite(raw.duration) || raw.duration < 0) {
                    throw new MediaForgeError('Invalid media track description', 'DEMUX');
                }
                for (const value of [raw.default, raw.forced, raw.commentary, raw.alphaMode]) {
                    if (value !== undefined && typeof value !== 'boolean')
                        throw new MediaForgeError('Track default, forced, commentary and alphaMode must be booleans', 'DEMUX');
                }
                for (const field of ['name', 'title'])
                    if (raw[field] !== undefined && typeof raw[field] !== 'string')
                        throw new MediaForgeError(`Track ${field} must be a string`, 'DEMUX');
                const compact = ownsSamples ? getCompactSampleIndex(raw) : undefined;
                const rawSamples = compact ? [] : raw.samples;
                if (!Array.isArray(rawSamples))
                    throw new MediaForgeError('Expected a media sample array', 'DEMUX');
                const length = compact?.length ?? rawSamples.length;
                totalSampleCount += length;
                indexBytes += compact?.byteLength ?? length * 256;
                if (totalSampleCount > maxSamples)
                    throw new MediaForgeError('Sample index exceeds maxSamples', 'OOM');
                if (indexBytes > maxIndexBytes)
                    throw new MediaForgeError('Sample index exceeds maxIndexBytes', 'OOM');
                if (compact && compact.maxSampleSize > maxPacketBytes)
                    throw new MediaForgeError('Packet exceeds maxPacketBytes', 'OOM');
                let id = raw.id;
                if (!Number.isSafeInteger(id) || id < 1 || this.byId.has(id)) {
                    while (reserved.has(nextId) || this.byId.has(nextId))
                        nextId++;
                    id = nextId++;
                }
                let ordered = compact?.decodeSorted ?? true;
                let presentationSorted = compact?.presentationSorted ?? true;
                let allKeyframes = compact?.allKeyframes ?? true;
                let previousDts = -Infinity;
                let previousPts = -Infinity;
                const samples = ownsSamples ? rawSamples : new Array(length);
                for (let sampleIndex = 0; !compact && sampleIndex < length; sampleIndex++) {
                    const input = rawSamples[sampleIndex];
                    if (!input || typeof input !== 'object')
                        throw new MediaForgeError(`Invalid sample in track ${id}`, 'DEMUX');
                    let sample;
                    if (ownsSamples)
                        sample = input;
                    else {
                        const { offset, size, timestamp, duration, isKeyframe, decodeTimestamp, compositionTimeOffset, codecConfigIndex, data, leadingDiscard, alphaOffset, alphaSize, nalUnitFormat, proResHeaderless, } = input;
                        sample = { offset, size, timestamp, duration, isKeyframe };
                        if (decodeTimestamp !== undefined)
                            sample.decodeTimestamp = decodeTimestamp;
                        if (compositionTimeOffset !== undefined)
                            sample.compositionTimeOffset = compositionTimeOffset;
                        if (codecConfigIndex !== undefined)
                            sample.codecConfigIndex = codecConfigIndex;
                        if (leadingDiscard !== undefined)
                            sample.leadingDiscard = leadingDiscard;
                        sample.data = data;
                        if (alphaOffset !== undefined)
                            sample.alphaOffset = alphaOffset;
                        if (alphaSize !== undefined)
                            sample.alphaSize = alphaSize;
                        if (nalUnitFormat !== undefined)
                            sample.nalUnitFormat = nalUnitFormat;
                        if (proResHeaderless !== undefined)
                            sample.proResHeaderless = proResHeaderless;
                    }
                    if (!Number.isFinite(sample.timestamp) ||
                        !Number.isFinite(sample.duration) ||
                        sample.duration < 0 ||
                        !Number.isFinite(decodeTime(sample)) ||
                        typeof sample.isKeyframe !== 'boolean' ||
                        !Number.isSafeInteger(sample.size) ||
                        sample.size < 0 ||
                        !Number.isSafeInteger(sample.offset) ||
                        sample.offset < 0 ||
                        (sample.compositionTimeOffset !== undefined &&
                            !Number.isFinite(sample.compositionTimeOffset)) ||
                        (sample.leadingDiscard !== undefined && typeof sample.leadingDiscard !== 'boolean') ||
                        (sample.proResHeaderless !== undefined &&
                            (typeof sample.proResHeaderless !== 'boolean' ||
                                type !== 'video' ||
                                !isProResCodec(raw.codec))) ||
                        (sample.nalUnitFormat !== undefined &&
                            (type !== 'video' ||
                                !/^(avc|hev1|hvc1)/.test(raw.codec) ||
                                (sample.nalUnitFormat !== 'annexb' && sample.nalUnitFormat !== 'avcc'))) ||
                        (sample.codecConfigIndex !== undefined &&
                            (!Number.isInteger(sample.codecConfigIndex) ||
                                sample.codecConfigIndex < 0 ||
                                sample.codecConfigIndex >= (raw.codecConfigurations?.length ?? 0))) ||
                        (!sample.data && sample.size > source.size - sample.offset)) {
                        throw new MediaForgeError(`Invalid sample in track ${id}`, 'DEMUX');
                    }
                    if (sample.alphaOffset !== undefined || sample.alphaSize !== undefined) {
                        if (type !== 'video' ||
                            raw.alphaMode !== true ||
                            !Number.isSafeInteger(sample.alphaOffset) ||
                            sample.alphaOffset < 0 ||
                            !Number.isSafeInteger(sample.alphaSize) ||
                            sample.alphaSize < 1 ||
                            sample.alphaSize > source.size - sample.alphaOffset) {
                            throw new MediaForgeError(`Invalid alpha sample in track ${id}`, 'DEMUX');
                        }
                    }
                    if (sample.size + (sample.alphaSize ?? 0) > maxPacketBytes)
                        throw new MediaForgeError('Packet exceeds maxPacketBytes', 'OOM');
                    if (sample.data)
                        assertSourceBytes(sample.data, sample.size, 'sample');
                    const dts = decodeTime(sample);
                    if (dts < previousDts)
                        ordered = false;
                    if (sample.timestamp < previousPts)
                        presentationSorted = false;
                    if (!sample.isKeyframe)
                        allKeyframes = false;
                    previousDts = dts;
                    previousPts = sample.timestamp;
                    if (sample.data)
                        sample.data = copyOutputBytes(sample.data);
                    samples[sampleIndex] = sample;
                }
                const defaultConfig = raw.codecConfig ??
                    (raw.codecConfigurations?.length === 1 ? raw.codecConfigurations[0].codecConfig : undefined);
                const info = raw;
                info.id = id;
                if (!compact)
                    info.samples = samples;
                info.colour = raw.colour ? { ...raw.colour } : undefined;
                info.codecConfig = defaultConfig ? copyOutputBytes(defaultConfig) : undefined;
                info.codecConfigurations = raw.codecConfigurations?.map(value => ({
                    ...value,
                    codecConfig: copyOutputBytes(value.codecConfig),
                }));
                const order = ordered
                    ? undefined
                    : samples
                        .map((_, i) => i)
                        .sort((a, b) => decodeTime(samples[a]) - decodeTime(samples[b]) || a - b);
                const description = Object.freeze({
                    id: id,
                    type,
                    codec: raw.codec,
                    matroskaTrackUid: raw.matroskaTrackUid,
                    width: raw.width || undefined,
                    height: raw.height || undefined,
                    displayWidth: raw.displayWidth,
                    displayHeight: raw.displayHeight,
                    pixelAspectRatioNum: raw.pixelAspectRatioNum,
                    pixelAspectRatioDen: raw.pixelAspectRatioDen,
                    sampleRate: raw.sampleRate || undefined,
                    channelCount: raw.channelCount || undefined,
                    language: raw.language,
                    default: raw.default,
                    forced: raw.forced,
                    name: raw.name,
                    title: raw.title,
                    commentary: raw.commentary,
                    alphaMode: raw.alphaMode,
                    incomplete: raw.incomplete,
                    timescale: raw.timescale,
                    duration: raw.duration,
                    sampleCount: length,
                    codecConfig: info.codecConfig,
                });
                const indexed = {
                    description,
                    info,
                    type,
                    order,
                    presentationSorted,
                    allKeyframes,
                    sampleIndex: compact,
                };
                this.byId.set(id, indexed);
                list.push(indexed);
            }
        if (list.length === 0)
            throw new MediaForgeError('No media tracks', 'DEMUX');
        this.indexed = list;
        this.descriptions = list.map(track => track.description);
        this.retainedIndexBytes = indexBytes;
        this.remuxPlan = new RemuxPlanner(format, writers, this.matroskaPassThrough, this.matroskaUnsupportedTags, this.title);
        bindMediaFileState(this, {
            source: this.source,
            title: this.title,
            matroskaPassThrough: this.matroskaPassThrough,
            matroskaUnsupportedTags: this.matroskaUnsupportedTags,
            tracks: this.indexed,
            signal: this.lifetime.signal,
            diagnostics,
            planner: this.remuxPlan,
            remux: async (sink, options, context) => {
                assertSink(sink);
                await this.executeRemux(sink, snapshotRemux(options), context);
            },
        });
    }
    get tracks() {
        return this.descriptions.map(description => Object.freeze(withTrackJson({ ...description, codecConfig: description.codecConfig?.slice() })));
    }
    get warnings() {
        return this.diagnostics.warnings;
    }
    close() {
        if (this.lifetime.signal.aborted)
            return;
        this.lifetime.abort();
        forgetMediaFileState(this);
        const release = this.releaseSource;
        this.releaseSource = undefined;
        this.source = closedSource;
        this.indexed.length = 0;
        this.byId.clear();
        this.matroskaPassThrough = undefined;
        this.remuxPlan = new RemuxPlanner(this.format, this.writers);
        this.retainedIndexBytes = 0;
        release?.();
    }
    track(id) {
        aborted(this.lifetime.signal);
        const track = this.byId.get(id);
        if (!track)
            throw new MediaForgeError(`Unknown track ${id}`, 'INPUT');
        return track;
    }
    allocateSampleOrder(length) {
        const bytes = length * 4;
        if (bytes > this.maxIndexBytes - this.retainedIndexBytes)
            throw new MediaForgeError('Sample order exceeds maxIndexBytes', 'OOM');
        const order = new Uint32Array(length);
        this.retainedIndexBytes += bytes;
        return order;
    }
    selected(ids) {
        aborted(this.lifetime.signal);
        if (ids === undefined)
            return [...this.indexed];
        if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) {
            throw new MediaForgeError('trackIds must contain unique existing track IDs', 'INPUT');
        }
        return ids.map(id => this.track(id));
    }
    findSample(trackId, time, options = {}) {
        if (!options || typeof options !== 'object')
            throw new MediaForgeError('Expected sample search options', 'INPUT');
        const { keyframe = false, mode = 'before' } = options;
        if (!Number.isFinite(time) || typeof keyframe !== 'boolean' || (mode !== 'before' && mode !== 'after')) {
            throw new MediaForgeError('Invalid sample search', 'INPUT');
        }
        const track = this.track(trackId);
        const length = track.description.sampleCount;
        const timestampAt = (index) => track.sampleIndex?.timestampAt(index) ?? track.info.samples[index].timestamp;
        const keyframeAt = (index) => track.sampleIndex?.isKeyframeAt(index) ?? track.info.samples[index].isKeyframe;
        let order;
        if (!track.presentationSorted || (keyframe && !track.allKeyframes)) {
            const key = keyframe && !track.allKeyframes ? 'keyframeOrder' : 'presentationOrder';
            if (!track[key]) {
                const indices = this.allocateSampleOrder(length);
                let count = 0;
                for (let index = 0; index < length; index++) {
                    if (!keyframe || keyframeAt(index))
                        indices[count++] = index;
                }
                const selected = indices.subarray(0, count);
                if (!track.presentationSorted)
                    selected.sort((a, b) => timestampAt(a) - timestampAt(b) || a - b);
                track[key] = selected;
            }
            order = track[key];
        }
        const orderedLength = order?.length ?? length;
        const index = lowerBound(orderedLength, time, position => timestampAt(order?.[position] ?? position));
        const after = index < orderedLength ? (order?.[index] ?? index) : undefined;
        if (mode === 'after')
            return after;
        return after !== undefined && timestampAt(after) === time
            ? after
            : index > 0
                ? (order?.[index - 1] ?? index - 1)
                : undefined;
    }
    async readPacket(trackId, sampleIndex, signal) {
        const track = this.track(trackId);
        if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 0 || sampleIndex >= track.description.sampleCount) {
            throw new MediaForgeError('Sample index is out of range', 'INPUT');
        }
        const linked = linkAbortSignals(this.lifetime.signal, signal);
        try {
            return await this.readIndexedPacket(track, sampleIndex, linked.signal);
        }
        finally {
            linked.dispose();
        }
    }
    async readIndexedPacket(track, sampleIndex, signal) {
        aborted(signal);
        const sample = track.sampleIndex?.get(sampleIndex) ?? track.info.samples[sampleIndex];
        if (sample.size + (sample.alphaSize ?? 0) > this.maxPacketBytes)
            throw new MediaForgeError('Packet exceeds maxPacketBytes', 'OOM');
        let data = sample.data?.slice() ??
            readCachedSource(this.source, sample.offset, sample.size) ??
            (await awaitWithAbort(this.source.read(sample.offset, sample.size), signal));
        assertSourceBytes(data, sample.size, 'MediaFile packet');
        aborted(signal);
        const alphaData = sample.alphaOffset === undefined
            ? undefined
            : (readCachedSource(this.source, sample.alphaOffset, sample.alphaSize) ??
                (await awaitWithAbort(this.source.read(sample.alphaOffset, sample.alphaSize), signal)));
        if (alphaData)
            assertSourceBytes(alphaData, sample.alphaSize, 'MediaFile alpha packet');
        aborted(signal);
        const config = sample.codecConfigIndex === undefined
            ? track.info.codecConfig
            : track.info.codecConfigurations?.[sample.codecConfigIndex]?.codecConfig;
        if (sample.nalUnitFormat === 'annexb' || sample.proResHeaderless) {
            data = normalizeVideoPacket(data, track.info.codec, config, sample.nalUnitFormat, sample.proResHeaderless);
            if (data.length + (alphaData?.length ?? 0) > this.maxPacketBytes)
                throw new MediaForgeError('Packet exceeds maxPacketBytes after video normalization', 'OOM');
        }
        return {
            trackId: track.description.id,
            sampleIndex,
            data,
            alphaData,
            timestamp: sample.timestamp,
            duration: sample.duration,
            isKeyframe: sample.isKeyframe,
            trackType: track.type,
            decodeTimestamp: sample.decodeTimestamp,
            compositionTimeOffset: sample.compositionTimeOffset,
            leadingDiscard: sample.leadingDiscard,
            codecConfig: config?.slice(),
        };
    }
    packets(options = {}) {
        if (!options || typeof options !== 'object')
            throw new MediaForgeError('Expected packet options', 'INPUT');
        const { trackIds, start, end, keyframesOnly, signal } = options;
        const selected = this.selected(trackIds).map(track => track.description.id);
        return this.iteratePackets({ trackIds: selected, start, end, keyframesOnly, signal });
    }
    async *iteratePackets(options) {
        aborted(options.signal);
        aborted(this.lifetime.signal);
        const { start = -Infinity, end = Infinity, keyframesOnly = false, signal } = options;
        if ((options.start !== undefined && !Number.isFinite(start)) ||
            (options.end !== undefined && !Number.isFinite(end)) ||
            end < start ||
            typeof keyframesOnly !== 'boolean')
            throw new MediaForgeError('Invalid packet range', 'INPUT');
        if (start === end)
            return;
        const tracks = this.selected(options.trackIds).map(track => {
            let order = track.order;
            if (keyframesOnly && !track.allKeyframes) {
                if (!track.decodeKeyframeOrder) {
                    const indices = this.allocateSampleOrder(track.description.sampleCount);
                    let count = 0;
                    for (let position = 0; position < track.description.sampleCount; position++) {
                        const index = order?.[position] ?? position;
                        if (track.sampleIndex?.isKeyframeAt(index) ?? track.info.samples[index].isKeyframe)
                            indices[count++] = index;
                    }
                    track.decodeKeyframeOrder = indices.subarray(0, count);
                }
                order = track.decodeKeyframeOrder;
            }
            return { track, order, length: order?.length ?? track.description.sampleCount };
        });
        const heap = new PacketHeap();
        const timeAt = (item, position) => {
            const index = item.order?.[position] ?? position;
            return item.track.sampleIndex?.decodeTimeAt(index) ?? decodeTime(item.track.info.samples[index]);
        };
        tracks.forEach((item, index) => {
            const position = lowerBound(item.length, start, i => timeAt(item, i));
            if (position < item.length)
                heap.push({ track: index, position, time: timeAt(item, position) });
        });
        const linked = linkAbortSignals(this.lifetime.signal, signal);
        try {
            for (let cursor = heap.pop(); cursor && cursor.time < end; cursor = heap.pop()) {
                aborted(linked.signal);
                const item = tracks[cursor.track];
                yield this.readIndexedPacket(item.track, item.order?.[cursor.position] ?? cursor.position, linked.signal);
                cursor.position++;
                if (cursor.position < item.length) {
                    cursor.time = timeAt(item, cursor.position);
                    heap.push(cursor);
                }
            }
            aborted(linked.signal);
        }
        finally {
            linked.dispose();
        }
    }
    segments(options = {}) {
        const snapshot = snapshotSegments(options);
        const trackIds = this.selected(snapshot.trackIds).map(track => track.description.id);
        return this.iterateSegments({ ...snapshot, trackIds });
    }
    async *iterateSegments(options, onProgress, diagnostics = this.diagnostics) {
        const { trackIds, targetDuration, requireKeyframe = false, signal } = options;
        const tracks = this.selected(trackIds?.slice());
        this.remuxPlan.checkCopy(tracks);
        const target = targetDuration ?? 2;
        if (!Number.isFinite(target) || target <= 0)
            throw new MediaForgeError('targetDuration must be positive', 'INPUT');
        if (typeof requireKeyframe !== 'boolean')
            throw new MediaForgeError('requireKeyframe must be boolean', 'INPUT');
        const { writer, configs, byteLimit, sampleLimit } = this.remuxPlan.prepareSegments(tracks, options, diagnostics);
        let origin = 0;
        for (const track of tracks) {
            const first = sampleAt(track.info, track.order?.[0] ?? 0);
            if (first)
                origin = Math.min(origin, decodeTime(first));
        }
        const adapters = new Map(tracks.map((track, index) => [
            track.description.id,
            new CmafPacketAdapter(configs[index], this.format, track.info.timestampResolutionSeconds ?? 1 / (track.info.timescale ?? configs[index].timescale), origin, () => diagnostics.recover({
                code: 'FMP4_AUDIO_CLOCK',
                message: 'Reconstructed coded audio durations and aligned timestamp rounding within one source clock tick',
                trackId: track.description.id,
                format: 'fmp4',
            })),
        ]));
        const main = tracks.find(track => track.type === 'video')?.description.id;
        aborted(signal);
        aborted(this.lifetime.signal);
        yield {
            kind: 'init',
            data: writer.createInitSegment(),
            tracks: configs.map(track => ({ ...track, codecConfig: track.codecConfig?.slice() })),
        };
        let segmentStart;
        let packets = 0;
        let packetBytes = 0;
        for await (const packet of this.packets({ trackIds: tracks.map(track => track.description.id), signal })) {
            const prepared = adapters.get(packet.trackId).prepare(packet);
            const time = prepared.time;
            if (prepared.sample.data.length > byteLimit)
                throw new MediaForgeError('Single packet exceeds maxBufferedBytes', 'OOM');
            const capacity = writer.bufferedSamples >= sampleLimit || writer.bufferedBytes + prepared.sample.data.length > byteLimit;
            if (writer.bufferedSamples &&
                (capacity ||
                    prepared.discontinuity ||
                    (segmentStart !== undefined &&
                        time - segmentStart >= target &&
                        (main === undefined || (packet.trackId === main && packet.isKeyframe))))) {
                yield { kind: 'media', ...writer.flush({ requireKeyframe }) };
                segmentStart = undefined;
            }
            aborted(signal);
            aborted(this.lifetime.signal);
            segmentStart ??= time;
            writer.addSample(prepared.sample);
            packets++;
            packetBytes += packet.data.length;
            onProgress?.({ packets, packetBytes });
            aborted(signal);
            aborted(this.lifetime.signal);
        }
        aborted(signal);
        aborted(this.lifetime.signal);
        if (writer.bufferedSamples)
            yield { kind: 'media', ...writer.flush({ requireKeyframe }) };
        aborted(signal);
        aborted(this.lifetime.signal);
    }
    checkRemux(options) {
        const diagnostics = new DiagnosticContext({
            validation: this.diagnostics.validation,
            metadataPolicy: this.diagnostics.metadataPolicy,
        });
        try {
            options = snapshotRemux(options);
            aborted(this.lifetime.signal);
            aborted(options.signal);
            const tracks = this.selected(options.trackIds);
            this.remuxPlan.checkCopy(tracks);
            const outputFormat = this.remuxPlan.resolveRemuxFormat(tracks, options);
            options = { ...options, format: outputFormat };
            const sink = { write() { }, patchAt() { }, async close() { } };
            let layout;
            if (outputFormat === 'fmp4') {
                this.remuxPlan.prepareSegments(tracks, options, diagnostics);
                layout = 'fragmented';
            }
            else {
                this.remuxPlan.checkTrackMetadata(tracks, outputFormat, diagnostics);
                if (this.writers.audio.has(outputFormat)) {
                    if (tracks.length !== 1 || tracks[0].type !== 'audio') {
                        throw new MediaForgeError('Audio-only output requires exactly one audio track', 'FORMAT');
                    }
                    this.writers.audio.get(outputFormat)(outputFormat, tracks[0].info, sink);
                    layout = 'audio';
                }
                else
                    layout = this.remuxPlan.prepareContainer(tracks, sink, options, diagnostics).layout;
            }
            return { supported: true, outputFormat, layout, warnings: diagnostics.warnings };
        }
        catch (error) {
            if (!(error instanceof MediaForgeError))
                throw error;
            return { supported: false, code: error.code, reason: error.message, warnings: diagnostics.warnings };
        }
    }
    async validateRemux(options, validation = {}) {
        const diagnostics = new DiagnosticContext({
            validation: this.diagnostics.validation,
            metadataPolicy: this.diagnostics.metadataPolicy,
        });
        try {
            if (!validation || typeof validation !== 'object' || Array.isArray(validation))
                throw new MediaForgeError('Expected validation options', 'INPUT');
            const sink = createValidationSink(validation.maxBytes);
            const snapshot = snapshotRemux(options);
            const result = await this.executeRemux(sink, { ...snapshot, onProgress: undefined }, diagnostics);
            return { supported: true, ...result, warnings: diagnostics.warnings };
        }
        catch (error) {
            if (!(error instanceof MediaForgeError))
                throw error;
            return { supported: false, code: error.code, reason: error.message, warnings: diagnostics.warnings };
        }
    }
    async remux(sink, options) {
        assertSink(sink);
        await this.executeRemux(sink, snapshotRemux(options), this.diagnostics);
    }
    async executeRemux(sink, options, diagnostics) {
        const tracks = this.selected(options.trackIds);
        this.remuxPlan.checkCopy(tracks);
        options = { ...options, format: this.remuxPlan.resolveRemuxFormat(tracks, options) };
        const linked = linkAbortSignals(this.lifetime.signal, options.signal, sink.signal);
        try {
            aborted(linked.signal);
            if (options.format !== 'fmp4')
                this.remuxPlan.checkTrackMetadata(tracks, options.format, diagnostics);
            if (this.writers.audio.has(options.format)) {
                const track = tracks[0];
                if (tracks.length !== 1 || track.type !== 'audio') {
                    throw new MediaForgeError('Audio-only output requires exactly one audio track', 'FORMAT');
                }
                const muxer = this.writers.audio.get(options.format)(options.format, track.info, sink);
                let packets = 0;
                let packetBytes = 0;
                for await (const packet of this.packets({ trackIds: [track.description.id], signal: linked.signal })) {
                    muxer.addAudioChunk(packet);
                    packets++;
                    packetBytes += packet.data.length;
                    await drainSink(sink, linked.signal);
                    options.onProgress?.({ packets, packetBytes });
                }
                aborted(linked.signal);
                await awaitWithAbort(muxer.finalize(), linked.signal);
                return { outputFormat: options.format, layout: 'audio' };
            }
            if (options.format === 'fmp4') {
                for await (const segment of this.iterateSegments({ ...options, signal: linked.signal }, options.onProgress, diagnostics)) {
                    sink.write(segment.data);
                    await drainSink(sink, linked.signal);
                }
                aborted(linked.signal);
                await awaitWithAbort(sink.close(), linked.signal);
                return { outputFormat: options.format, layout: 'fragmented' };
            }
            const { muxer, routes, layout } = this.remuxPlan.prepareContainer(tracks, sink, options, diagnostics);
            let packets = 0;
            let packetBytes = 0;
            for await (const packet of this.packets({
                trackIds: tracks.map(track => track.description.id),
                signal: linked.signal,
            })) {
                routes.get(packet.trackId)(packet);
                packets++;
                packetBytes += packet.data.length;
                if (sink.drain)
                    await drainSink(sink, linked.signal);
                else
                    aborted(linked.signal);
                options.onProgress?.({ packets, packetBytes });
            }
            aborted(linked.signal);
            await awaitWithAbort(muxer.finalize(), linked.signal);
            return { outputFormat: options.format, layout };
        }
        catch (error) {
            try {
                Promise.resolve(sink.abort?.(error)).catch(() => undefined);
            }
            catch { }
            throw error;
        }
        finally {
            linked.dispose();
        }
    }
    async toBlob(options) {
        const sink = new MemorySink({ maxBytes: options.maxBytes ?? 256 * 1024 * 1024 });
        const snapshot = snapshotRemux(options);
        await this.remux(sink, snapshot);
        return sink.toBlob(snapshot.format === 'fmp4' ? 'video/mp4' : DemuxerRegistry.getMimeType(snapshot.format));
    }
}
function snapshotRemux(options) {
    if (!options || typeof options !== 'object')
        throw new MediaForgeError('Expected remux options', 'INPUT');
    const { format, trackIds, targetDuration, maxBufferedBytes, maxBufferedSamples, requireKeyframe, signal, onProgress, mp4Mode, } = options;
    assertAbortSignal(signal);
    if (!REMUX_FORMATS.includes(format)) {
        throw new MediaForgeError('Unsupported remux format', 'FORMAT');
    }
    if ((targetDuration !== undefined && (!Number.isFinite(targetDuration) || targetDuration <= 0)) ||
        (requireKeyframe !== undefined && typeof requireKeyframe !== 'boolean') ||
        (onProgress !== undefined && typeof onProgress !== 'function') ||
        (trackIds !== undefined && !Array.isArray(trackIds)))
        throw new MediaForgeError('Invalid remux options', 'INPUT');
    if (maxBufferedBytes !== undefined)
        positiveInteger(maxBufferedBytes, 1, 'maxBufferedBytes');
    if (maxBufferedSamples !== undefined)
        positiveInteger(maxBufferedSamples, 1, 'maxBufferedSamples');
    if (mp4Mode !== undefined &&
        (!['auto', 'standard', 'fragmented'].includes(mp4Mode) || !['mp4', 'm4a', 'm4v'].includes(format)))
        throw new MediaForgeError('mp4Mode requires MP4/M4A/M4V and a valid layout', 'INPUT');
    return {
        format,
        mp4Mode,
        trackIds: trackIds?.slice(),
        targetDuration,
        maxBufferedBytes,
        maxBufferedSamples,
        requireKeyframe,
        signal,
        onProgress,
    };
}
function snapshotSegments(options) {
    if (!options || typeof options !== 'object')
        throw new MediaForgeError('Expected segment options', 'INPUT');
    const { trackIds, targetDuration, maxBufferedBytes, maxBufferedSamples, requireKeyframe, signal } = options;
    assertAbortSignal(signal);
    if ((targetDuration !== undefined && (!Number.isFinite(targetDuration) || targetDuration <= 0)) ||
        (requireKeyframe !== undefined && typeof requireKeyframe !== 'boolean') ||
        (trackIds !== undefined && !Array.isArray(trackIds)))
        throw new MediaForgeError('Invalid segment options', 'INPUT');
    if (maxBufferedBytes !== undefined)
        positiveInteger(maxBufferedBytes, 1, 'maxBufferedBytes');
    if (maxBufferedSamples !== undefined)
        positiveInteger(maxBufferedSamples, 1, 'maxBufferedSamples');
    return {
        trackIds: trackIds?.slice(),
        targetDuration,
        maxBufferedBytes,
        maxBufferedSamples,
        requireKeyframe,
        signal,
    };
}
