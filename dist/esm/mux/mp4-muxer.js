import { isAnnexB, isValidAvccWalk, annexBToAvcc, buildAvcCFromAnnexB, buildHevcCFromAnnexB, isValidHevcWalk, } from '../core/annexb.js';
import { MediaForgeError } from '../core/errors.js';
import { isProResCodec, proResFrameError } from '../core/prores.js';
import { isProResRawCodec, proResRawFrameError } from '../core/prores-raw.js';
import { EncodeError } from '../core/errors.js';
import { parseAacAudioSpecificConfig } from '../audio/adts.js';
import { MP4SampleRuns, MP4SampleTable } from './mp4-sample-table.js';
import { mp4HandlerName, mp4TitleBox, mp4TrackFlags, mp4TrackMetadataBoxes, validateMP4TrackMetadata, } from '../core/mp4-metadata.js';
const ascii = (s) => {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++)
        a[i] = s.charCodeAt(i);
    return a;
};
function box(type, ...payloads) {
    let total = 8;
    for (const p of payloads)
        total += p.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, total, false);
    out.set(ascii(type), 4);
    let pos = 8;
    for (const p of payloads) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}
function fullBox(type, version, flags, payload) {
    const out = new Uint8Array(12 + payload.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, out.length, false);
    out.set(ascii(type), 4);
    out[8] = version;
    out[9] = (flags >> 16) & 0xff;
    out[10] = (flags >> 8) & 0xff;
    out[11] = flags & 0xff;
    out.set(payload, 12);
    return out;
}
function u32be(v) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, v >>> 0, false);
    return out;
}
function fixed16_16(v) {
    return Math.max(0, Math.round(v * 65536));
}
function checkedInteger(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new MediaForgeError(`MP4 ${label} is outside the exact integer range [${min}, ${max}]`, 'MUX');
    }
    return value;
}
function validateChunkTiming(chunk) {
    if (!Number.isFinite(chunk.timestamp) ||
        !Number.isFinite(chunk.duration ?? 0) ||
        (chunk.duration ?? 0) < 0 ||
        (chunk.decodeTimestamp !== undefined && !Number.isFinite(chunk.decodeTimestamp)) ||
        (chunk.compositionTimeOffset !== undefined && !Number.isFinite(chunk.compositionTimeOffset))) {
        throw new MediaForgeError('MP4 chunk has non-finite timing or a negative duration', 'MUX');
    }
}
function signed32Payload(value) {
    return value < 0 ? value + 0x100000000 : value;
}
function gcd(a, b) {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y !== 0) {
        const next = x % y;
        x = y;
        y = next;
    }
    return Math.max(1, x);
}
function chooseMovieTimescale(trackTimescales) {
    const MAX_EXACT = 1_000_000_000;
    let result = 1000;
    for (const raw of trackTimescales) {
        const scale = Math.round(raw);
        if (!Number.isSafeInteger(scale) || scale < 1 || scale > 0xffffffff)
            continue;
        const factor = scale / gcd(result, scale);
        if (!Number.isSafeInteger(factor) || result > MAX_EXACT / factor) {
            return 1_000_000;
        }
        result *= factor;
    }
    return result;
}
function hasCopyPresentation(track) {
    return track?.presentationMediaTimeSeconds !== undefined;
}
function copyPresentationTiming(timing, timescale, track) {
    if (!hasCopyPresentation(track))
        return timing;
    return {
        ...timing,
        startSeconds: track.presentationStartSeconds,
        mediaTimeUnits: checkedInteger(Math.round(track.presentationMediaTimeSeconds * timescale), 'copy edit media time'),
    };
}
function presentationMovieDuration(track, timing, timescale, movieTimescale, validSamples) {
    const seconds = hasCopyPresentation(track)
        ? track.presentationDurationSeconds
        : (validSamples ?? timing.durationUnits) / timescale;
    return checkedInteger(Math.round(seconds * movieTimescale), 'track presentation duration');
}
function readChunkTiming(chunks, timescale) {
    const count = chunks.length;
    const decodeDurations = new MP4SampleRuns();
    const compositionOffsets = new MP4SampleRuns();
    if (count === 0) {
        return { decodeDurations, compositionOffsets, durationUnits: 0, startSeconds: 0, mediaTimeUnits: 0 };
    }
    const firstDecode = chunks.decodeTimestamp(0);
    let decodeUnits = 0;
    let durationUnits = 0;
    let debt = 0;
    let startSeconds = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
        const nextDecodeUnits = i + 1 < count
            ? checkedInteger(Math.round((chunks.decodeTimestamp(i + 1) - firstDecode) * timescale), 'relative decode timestamp', -Number.MAX_SAFE_INTEGER)
            : 0;
        let duration = i + 1 < count
            ? nextDecodeUnits - decodeUnits
            : Math.max(1, Math.round((chunks.duration(i) ?? 0) * timescale));
        checkedInteger(duration, 'sample decode delta', -Number.MAX_SAFE_INTEGER);
        duration -= debt;
        debt = 0;
        if (duration < 1) {
            debt = 1 - duration;
            duration = 1;
        }
        decodeDurations.append(checkedInteger(duration, 'sample duration', 1, 0xffffffff));
        durationUnits = checkedInteger(durationUnits + duration, 'track decode duration');
        const presentation = chunks.timestamp(i);
        const explicitCto = chunks.compositionTimeOffset(i);
        const ctoUnits = explicitCto !== undefined
            ? Math.round(explicitCto * timescale)
            : Math.round((presentation - firstDecode) * timescale) - decodeUnits;
        compositionOffsets.append(checkedInteger(ctoUnits, 'composition offset', -0x80000000, 0xffffffff));
        checkedInteger(durationUnits + ctoUnits, 'presentation end', -Number.MAX_SAFE_INTEGER);
        if (presentation < startSeconds)
            startSeconds = presentation;
        decodeUnits = nextDecodeUnits;
    }
    const mediaTimeUnits = checkedInteger(Math.max(0, Math.round((startSeconds - firstDecode) * timescale)), 'edit media time');
    return { decodeDurations, compositionOffsets, durationUnits, startSeconds, mediaTimeUnits };
}
function applyAudioPresentationWindow(timing, timescale, primeSamples, validSamples, presentationTimestamps, label) {
    if (!Number.isSafeInteger(primeSamples) ||
        primeSamples < 0 ||
        !Number.isSafeInteger(validSamples) ||
        validSamples < 1) {
        throw new MediaForgeError(`${label} has an invalid presentation sample window`, 'MUX');
    }
    const desiredMediaDuration = checkedInteger(primeSamples + validSamples, `${label} presentation duration`);
    const lastIndex = timing.decodeDurations.length - 1;
    if (lastIndex < 0 || desiredMediaDuration > timing.durationUnits) {
        throw new MediaForgeError(`${label} presentation window ${desiredMediaDuration} cannot fit encoded duration ${timing.durationUnits}`, 'MUX');
    }
    const beforeLast = timing.durationUnits - timing.decodeDurations.lastValue;
    const decodeDurations = timing.decodeDurations;
    let durationUnits = timing.durationUnits;
    if (desiredMediaDuration > beforeLast) {
        const finalDuration = desiredMediaDuration - beforeLast;
        if (finalDuration < 1 || finalDuration > timing.decodeDurations.lastValue) {
            throw new MediaForgeError(`${label} presentation window ${desiredMediaDuration} cannot fit encoded duration ${timing.durationUnits}`, 'MUX');
        }
        decodeDurations.replaceLast(finalDuration);
        durationUnits = desiredMediaDuration;
    }
    return {
        ...timing,
        decodeDurations,
        mediaTimeUnits: checkedInteger(timing.mediaTimeUnits + primeSamples, `${label} edit media time`),
        durationUnits,
        startSeconds: timing.startSeconds +
            (presentationTimestamps
                ? primeSamples
                : Math.min(primeSamples, Math.max(0, Math.round(-timing.startSeconds * timescale)))) /
                timescale,
    };
}
function normalizeAacCodedDuration(timing, timescale, packetCount, codecConfig) {
    const samplesPerAccessUnit = codecConfig
        ? (parseAacAudioSpecificConfig(codecConfig)?.samplesPerAccessUnit ?? 0)
        : 0;
    if (samplesPerAccessUnit <= 0 || packetCount <= 0)
        return timing;
    const expected = packetCount * samplesPerAccessUnit;
    if (!Number.isSafeInteger(expected)) {
        throw new MediaForgeError('AAC coded sample count exceeds exact-integer range', 'MUX');
    }
    const difference = expected - timing.durationUnits;
    const tolerance = Math.max(2, Math.ceil(timescale / 1000));
    const lastIndex = timing.decodeDurations.length - 1;
    const adjustedLast = timing.decodeDurations.lastValue + difference;
    if (lastIndex < 0 || Math.abs(difference) > tolerance || adjustedLast < 1)
        return timing;
    const decodeDurations = timing.decodeDurations;
    decodeDurations.replaceLast(adjustedLast);
    return { ...timing, decodeDurations, durationUnits: expected };
}
export class MP4Muxer {
    use64BitOffsets = false;
    sink;
    cfg;
    videoChunks = new MP4SampleTable();
    audioChunks = new MP4SampleTable();
    videoConfig;
    audioConfig;
    extraVideoChunks = [];
    extraVideoConfigs = [];
    activeVideoCfg;
    activeVideoConfig;
    extraAudioChunks = [];
    extraAudioConfigs = [];
    activeAudioCfg;
    activeAudioConfig;
    fragmented;
    initWritten = false;
    moofSeq = 1;
    fragStartSec = null;
    pendingV = [];
    pendingA = [];
    vFirstDtsSec = null;
    aFirstDtsSec = null;
    vLastDtsSec = Number.NEGATIVE_INFINITY;
    aLastDtsSec = Number.NEGATIVE_INFINITY;
    vMinPtsSec = Number.POSITIVE_INFINITY;
    aMinPtsSec = Number.POSITIVE_INFINITY;
    fragmentedVideoSeen = false;
    fragmentedAudioSeen = false;
    fragmentedAudioPacketCount = 0;
    fragmentedAudioDurationUnits = 0;
    videoTimelineRebaseSec = 0;
    audioTimelineRebaseSec = 0;
    videoPresentationStartSec = 0;
    audioPresentationStartSec = 0;
    eagerStandard;
    standardHeaderWritten = false;
    standardMdatHeaderOffset = 0;
    standardPayloadOffset = 0;
    standardMediaBytes = 0;
    constructor(cfg, sink) {
        cfg = { ...cfg };
        this.fragmented = cfg.mode === 'fragmented';
        this.eagerStandard = !this.fragmented && typeof sink.patchAt === 'function';
        const snapshotVideo = (track) => {
            const value = { ...track };
            if (value.colour)
                value.colour = { ...value.colour };
            return value;
        };
        this.cfg = {
            ...cfg,
            ...(cfg.video ? { video: snapshotVideo(cfg.video) } : {}),
            ...(cfg.audio ? { audio: { ...cfg.audio } } : {}),
            ...(cfg.extraVideoTracks ? { extraVideoTracks: cfg.extraVideoTracks.map(snapshotVideo) } : {}),
            ...(cfg.extraAudioTracks ? { extraAudioTracks: cfg.extraAudioTracks.map(track => ({ ...track })) } : {}),
            ...(cfg.videoColour ? { videoColour: { ...cfg.videoColour } } : {}),
            ...(cfg.moovUserData ? { moovUserData: new Uint8Array(cfg.moovUserData) } : {}),
        };
        cfg = this.cfg;
        for (const track of [...(cfg.audio ? [cfg.audio] : []), ...(cfg.extraAudioTracks ?? [])]) {
            checkedInteger(track.sampleRate, 'audio timescale', 1, 0xffffffff);
        }
        const configuredTracks = [
            this.cfg.video,
            this.cfg.audio,
            ...(this.cfg.extraVideoTracks ?? []),
            ...(this.cfg.extraAudioTracks ?? []),
        ].filter((track) => track !== undefined);
        const configuredMovieTimescale = chooseMovieTimescale(configuredTracks.map(track => track.mediaTimescale ?? (track.type === 'audio' ? track.sampleRate : 90000)));
        for (const track of configuredTracks) {
            validateMP4TrackMetadata(track);
            if ((isProResCodec(track.codec) || isProResRawCodec(track.codec)) &&
                (cfg.format !== 'mov' || this.fragmented)) {
                throw new MediaForgeError('ProRes packet copy requires standard MOV output', 'MUX');
            }
            if (track?.mediaTimescale !== undefined) {
                checkedInteger(track.mediaTimescale, 'copy media timescale', 1, 0xffffffff);
                if (!hasCopyPresentation(track))
                    throw new MediaForgeError('MP4 mediaTimescale requires an authoritative copy edit', 'MUX');
            }
            if (!hasCopyPresentation(track))
                continue;
            const { presentationStartSeconds, presentationDurationSeconds, presentationMediaTimeSeconds } = track;
            if (this.fragmented ||
                !Number.isFinite(presentationStartSeconds) ||
                presentationStartSeconds < 0 ||
                !Number.isFinite(presentationDurationSeconds) ||
                presentationDurationSeconds <= 0 ||
                !Number.isFinite(presentationMediaTimeSeconds) ||
                presentationMediaTimeSeconds < 0) {
                throw new MediaForgeError('Authoritative MP4 copy edits require standard mode, nonnegative start/media time and positive duration', 'MUX');
            }
            const mediaTimescale = track.mediaTimescale ?? (track.type === 'audio' ? track.sampleRate : 90000);
            checkedInteger(Math.round(presentationMediaTimeSeconds * mediaTimescale), 'copy edit media time');
            checkedInteger(Math.round(presentationStartSeconds * configuredMovieTimescale), 'copy presentation start');
            checkedInteger(Math.round(presentationDurationSeconds * configuredMovieTimescale), 'copy presentation duration', 1);
            checkedInteger(Math.round((presentationStartSeconds + presentationDurationSeconds) * configuredMovieTimescale), 'copy presentation end');
        }
        this.sink = sink;
        if (cfg.video?.codecConfig)
            this.videoConfig = new Uint8Array(cfg.video.codecConfig);
        if (cfg.audio?.codecConfig)
            this.audioConfig = new Uint8Array(cfg.audio.codecConfig);
        for (const t of cfg.extraVideoTracks ?? []) {
            this.extraVideoChunks.push(new MP4SampleTable());
            this.extraVideoConfigs.push(t.codecConfig ? new Uint8Array(t.codecConfig) : undefined);
        }
        for (const t of cfg.extraAudioTracks ?? []) {
            this.extraAudioChunks.push(new MP4SampleTable());
            this.extraAudioConfigs.push(t.codecConfig ? new Uint8Array(t.codecConfig) : undefined);
        }
    }
    addVideoChunk(chunk, codecCfg) {
        if (chunk.trackType === undefined) {
            throw new MediaForgeError(`${'addVideoChunk'} requires chunk.trackType (got a chunk without one)`, 'MUX');
        }
        if (chunk.trackType !== 'video') {
            throw new MediaForgeError(`addVideoChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        if (this.finalized)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (!this.cfg.video)
            throw new MediaForgeError('addVideoChunk on a muxer configured without video', 'MUX');
        validateChunkTiming(chunk);
        const normalized = this.normalizeVideoChunk(chunk, this.cfg.video, this.videoConfig ?? (codecCfg ? new Uint8Array(codecCfg) : undefined));
        chunk = normalized.chunk;
        const videoConfig = normalized.config;
        this.assertVideoDecoderConfig(this.cfg.video.codec, videoConfig, 'Video track');
        this.videoConfig = videoConfig;
        if (this.fragmented) {
            const dts = chunk.decodeTimestamp ?? chunk.timestamp;
            if (this.fragmentedVideoSeen && dts <= this.vLastDtsSec) {
                throw new MediaForgeError('Fragmented MP4 video decode timestamps must strictly increase', 'MUX');
            }
            this.vLastDtsSec = dts;
            this.fragmentedVideoSeen = true;
            if (this.vFirstDtsSec === null)
                this.vFirstDtsSec = dts;
            this.vMinPtsSec = Math.min(this.vMinPtsSec, chunk.timestamp);
            const over = this.fragStartSec !== null && dts - this.fragStartSec >= 2;
            const wayOver = this.fragStartSec !== null && dts - this.fragStartSec >= 8;
            if ((chunk.isKeyframe && over) || wayOver)
                this.flushFragment();
            if (this.fragStartSec === null)
                this.fragStartSec = dts;
            this.pendingV.push({ ...chunk, data: new Uint8Array(chunk.data) });
            return;
        }
        this.storeStandardSample(this.videoChunks, chunk);
    }
    normalizeVideoChunk(chunk, track, config) {
        const codec = track.codec;
        if (isProResCodec(codec)) {
            const error = proResFrameError(chunk.data, track);
            if (error)
                throw new MediaForgeError(error, 'MUX');
        }
        if (isProResRawCodec(codec)) {
            const error = proResRawFrameError(chunk.data, track);
            if (error)
                throw new MediaForgeError(error, 'MUX');
        }
        const avc = codec.startsWith('avc');
        const hevc = codec.startsWith('hev1') || codec.startsWith('hvc1');
        if (!avc && !hevc)
            return { chunk, config };
        const configByte = config?.[hevc ? 21 : 4];
        const lengthSize = (configByte === undefined ? 4 : (configByte & 3) + 1);
        const validWalk = hevc ? isValidHevcWalk : isValidAvccWalk;
        if (!validWalk(chunk.data, lengthSize) && isAnnexB(chunk.data)) {
            if (!config)
                config = (hevc ? buildHevcCFromAnnexB : buildAvcCFromAnnexB)(chunk.data) ?? undefined;
            chunk = { ...chunk, data: annexBToAvcc(chunk.data, lengthSize) };
        }
        return { chunk, config };
    }
    addExtraVideoChunk(index, chunk, codecCfg) {
        if (chunk.trackType === undefined) {
            throw new MediaForgeError('addExtraVideoChunk requires chunk.trackType (got a chunk without one)', 'MUX');
        }
        if (chunk.trackType !== 'video') {
            throw new MediaForgeError(`addExtraVideoChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        if (this.finalized)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (this.cfg.mode !== 'standard') {
            throw new MediaForgeError('extra video tracks are supported in standard (non-fragmented) MP4 output only', 'MUX');
        }
        const list = this.extraVideoChunks[index];
        if (!list)
            throw new MediaForgeError(`addExtraVideoChunk index ${index} has no configured track`, 'MUX');
        validateChunkTiming(chunk);
        if (codecCfg && !this.extraVideoConfigs[index])
            this.extraVideoConfigs[index] = new Uint8Array(codecCfg);
        const normalized = this.normalizeVideoChunk(chunk, this.cfg.extraVideoTracks[index], this.extraVideoConfigs[index]);
        chunk = normalized.chunk;
        this.extraVideoConfigs[index] = normalized.config;
        this.assertVideoDecoderConfig(this.cfg.extraVideoTracks[index].codec, this.extraVideoConfigs[index], `Extra video track ${index}`);
        this.storeStandardSample(list, chunk);
    }
    addExtraAudioChunk(index, chunk, codecCfg) {
        if (chunk.trackType === undefined) {
            throw new MediaForgeError('addExtraAudioChunk requires chunk.trackType (got a chunk without one)', 'MUX');
        }
        if (chunk.trackType !== 'audio') {
            throw new MediaForgeError(`addExtraAudioChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        if (this.finalized)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (this.cfg.mode !== 'standard') {
            throw new MediaForgeError('extra audio tracks are supported in standard (non-fragmented) MP4 output only', 'MUX');
        }
        const list = this.extraAudioChunks[index];
        if (!list)
            throw new MediaForgeError(`addExtraAudioChunk index ${index} has no configured track`, 'MUX');
        validateChunkTiming(chunk);
        if (codecCfg && !this.extraAudioConfigs[index])
            this.extraAudioConfigs[index] = new Uint8Array(codecCfg);
        if ((this.cfg.extraAudioTracks?.[index]?.codec ?? '').startsWith('mp4a') && !this.extraAudioConfigs[index]) {
            throw new MediaForgeError(`Extra AAC track ${index} requires an ASC before its first chunk`, 'MUX');
        }
        this.storeStandardSample(list, chunk);
    }
    addAudioChunk(chunk, codecCfg) {
        if (chunk.trackType === undefined) {
            throw new MediaForgeError(`${'addAudioChunk'} requires chunk.trackType (got a chunk without one)`, 'MUX');
        }
        if (chunk.trackType !== 'audio') {
            throw new MediaForgeError(`addAudioChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        if (this.finalized)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (!this.cfg.audio)
            throw new MediaForgeError('addAudioChunk on a muxer configured without audio', 'MUX');
        validateChunkTiming(chunk);
        if (codecCfg && !this.audioConfig)
            this.audioConfig = new Uint8Array(codecCfg);
        if (this.cfg.audio.codec.startsWith('mp4a') && !this.audioConfig) {
            throw new MediaForgeError('AAC output requires an ASC before its first chunk', 'MUX');
        }
        if (this.fragmented) {
            const dts = chunk.decodeTimestamp ?? chunk.timestamp;
            if (chunk.timestamp < 0 && dts >= 0) {
                throw new MediaForgeError('Fragmented MP4 cannot preserve an audio presentation timestamp before its non-negative decode timestamp', 'MUX');
            }
            if (this.fragmentedAudioSeen && dts <= this.aLastDtsSec) {
                throw new MediaForgeError('Fragmented MP4 audio decode timestamps must strictly increase', 'MUX');
            }
            const durationUnits = checkedInteger(Math.max(1, Math.round(Math.max(0, chunk.duration ?? 0) * this.audioTimescale())), 'fragmented audio sample duration', 1, 0xffffffff);
            const nextDuration = this.fragmentedAudioDurationUnits + durationUnits;
            if (!Number.isSafeInteger(nextDuration)) {
                throw new MediaForgeError('Fragmented MP4 audio duration exceeds the exact-integer range', 'MUX');
            }
            this.aLastDtsSec = dts;
            this.fragmentedAudioSeen = true;
            this.fragmentedAudioDurationUnits = nextDuration;
            this.fragmentedAudioPacketCount++;
            if (this.aFirstDtsSec === null)
                this.aFirstDtsSec = dts;
            this.aMinPtsSec = Math.min(this.aMinPtsSec, chunk.timestamp);
            if (!this.cfg.video && this.fragStartSec !== null && dts - this.fragStartSec >= 2)
                this.flushFragment();
            if (this.fragStartSec === null)
                this.fragStartSec = dts;
            this.pendingA.push({ ...chunk, data: new Uint8Array(chunk.data) });
            return;
        }
        this.storeStandardSample(this.audioChunks, chunk);
    }
    storeStandardSample(list, chunk) {
        checkedInteger(list.length + 1, 'sample count', 1, 0xffffffff);
        checkedInteger(chunk.data.byteLength, 'sample byte length', 0, 0xffffffff);
        if (!this.eagerStandard) {
            list.add(chunk, 0, true);
            return;
        }
        this.ensureEagerStandardHeader();
        const nextBytes = this.standardMediaBytes + chunk.data.byteLength;
        if (!Number.isSafeInteger(nextBytes) || !Number.isSafeInteger(this.standardPayloadOffset + nextBytes)) {
            throw new MediaForgeError('MP4 media byte count exceeds JavaScript exact-integer range', 'MUX');
        }
        const offset = this.standardPayloadOffset + this.standardMediaBytes;
        if (!Number.isSafeInteger(offset)) {
            throw new MediaForgeError('MP4 sample offset exceeds JavaScript exact-integer range', 'MUX');
        }
        list.add(chunk, offset, false);
        try {
            this.sink.write(chunk.data);
        }
        catch (error) {
            list.removeLast();
            throw error;
        }
        this.standardMediaBytes = nextBytes;
    }
    ensureEagerStandardHeader() {
        if (this.standardHeaderWritten)
            return;
        const ftyp = this.buildFtyp();
        this.standardMdatHeaderOffset = ftyp.length;
        this.standardPayloadOffset = ftyp.length + 16;
        const header = new Uint8Array(16);
        const dv = new DataView(header.buffer);
        dv.setUint32(0, 1, false);
        header.set(ascii('mdat'), 4);
        dv.setBigUint64(8, 16n, false);
        this.sink.write(ftyp);
        this.sink.write(header);
        this.standardHeaderWritten = true;
    }
    finalized = false;
    audioPriming = null;
    setAudioPriming(primeSamples, validSamples, presentationTimestamps = false, _discardLeadingSamples = true, codecDelaySamples = 0) {
        if (this.finalized)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (!this.cfg.audio) {
            throw new MediaForgeError('setAudioPriming on a muxer configured without audio', 'MUX');
        }
        const prime = Math.round(primeSamples);
        const valid = Math.round(validSamples);
        const codecDelay = Math.round(codecDelaySamples);
        if (!Number.isFinite(primeSamples) ||
            primeSamples < 0 ||
            !Number.isSafeInteger(prime) ||
            !Number.isFinite(validSamples) ||
            validSamples <= 0 ||
            !Number.isSafeInteger(valid) ||
            valid < 1 ||
            !Number.isFinite(codecDelaySamples) ||
            codecDelaySamples < 0 ||
            !Number.isSafeInteger(codecDelay) ||
            !Number.isSafeInteger(prime + valid)) {
            throw new MediaForgeError(`Invalid audio presentation window: prime=${primeSamples}, valid=${validSamples}, codecDelay=${codecDelaySamples}`, 'MUX');
        }
        if (this.fragmented && (this.fragmentedAudioSeen || this.initWritten)) {
            throw new MediaForgeError('Fragmented MP4 audio priming must be configured before the first audio chunk and init segment', 'MUX');
        }
        this.audioPriming = {
            primeSamples: prime,
            validSamples: valid,
            presentationTimestamps,
        };
    }
    setAudioCodecConfig(codecConfig) {
        this.audioConfig = new Uint8Array(codecConfig);
    }
    async finalize() {
        if (this.finalized)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        this.finalized = true;
        if (this.fragmented) {
            if (this.cfg.video && !this.fragmentedVideoSeen) {
                throw new MediaForgeError('finalize with a declared video track but no video chunks', 'MUX');
            }
            if (this.cfg.audio && !this.fragmentedAudioSeen) {
                throw new MediaForgeError('finalize with a declared audio track but no audio chunks', 'MUX');
            }
            if (this.cfg.video) {
                this.assertVideoDecoderConfig(this.cfg.video.codec, this.videoConfig, 'Video track');
            }
            this.validateFragmentedAudioPresentationWindow();
            this.flushFragment();
            await this.sink.close?.();
            return;
        }
        if (this.cfg.video && this.videoChunks.length === 0) {
            throw new MediaForgeError('finalize with a declared video track but no video chunks', 'MUX');
        }
        if (this.cfg.audio && this.audioChunks.length === 0) {
            throw new MediaForgeError('finalize with a declared audio track but no audio chunks', 'MUX');
        }
        if (this.cfg.video)
            this.assertVideoDecoderConfig(this.cfg.video.codec, this.videoConfig, 'Video track');
        if (this.cfg.audio?.codec.startsWith('mp4a') && !this.audioConfig) {
            throw new MediaForgeError('AAC output requires a codec config (esds/ASC) before finalize', 'MUX');
        }
        for (let index = 0; index < this.extraVideoChunks.length; index++) {
            const codec = this.cfg.extraVideoTracks?.[index]?.codec ?? '';
            if (this.extraVideoChunks[index].length > 0) {
                this.assertVideoDecoderConfig(codec, this.extraVideoConfigs[index], `Extra video track ${index}`);
            }
        }
        for (let index = 0; index < this.extraAudioChunks.length; index++) {
            const codec = this.cfg.extraAudioTracks?.[index]?.codec ?? '';
            if (this.extraAudioChunks[index].length > 0 &&
                codec.startsWith('mp4a') &&
                !this.extraAudioConfigs[index]) {
                throw new MediaForgeError(`Extra AAC track ${index} requires a codec config (ASC)`, 'MUX');
            }
        }
        if (this.eagerStandard)
            this.writeEagerStandard();
        else
            this.writeStandard();
        await this.sink.close();
        for (const samples of [
            this.videoChunks,
            this.audioChunks,
            ...this.extraVideoChunks,
            ...this.extraAudioChunks,
        ]) {
            samples.clear();
        }
    }
    assertVideoDecoderConfig(codec, config, label) {
        const boxType = codec.startsWith('avc')
            ? 'avcC'
            : codec.startsWith('hvc1') || codec.startsWith('hev1')
                ? 'hvcC'
                : codec.startsWith('av01')
                    ? 'av1C'
                    : null;
        if (boxType && (!config || config.length === 0)) {
            throw new MediaForgeError(`${label} codec '${codec}' requires a ${boxType} decoder configuration`, 'MUX');
        }
    }
    writeEagerStandard() {
        if (!this.standardHeaderWritten || !this.sink.patchAt) {
            throw new MediaForgeError('Seekable standard MP4 has no media header to finalize', 'MUX');
        }
        const hasV = !!this.cfg.video && this.videoChunks.length > 0;
        const hasA = !!this.cfg.audio && this.audioChunks.length > 0;
        const MAX_U32 = 0xffffffff;
        this.use64BitOffsets =
            this.standardMediaBytes + 16 > MAX_U32 || this.standardPayloadOffset + this.standardMediaBytes > MAX_U32;
        const moov = this.buildMoov(hasV, hasA, 0);
        const sizePatch = new Uint8Array(8);
        new DataView(sizePatch.buffer).setBigUint64(0, BigInt(this.standardMediaBytes) + 16n, false);
        this.sink.patchAt(this.standardMdatHeaderOffset + 8, sizePatch);
        this.sink.write(moov);
    }
    writeStandard() {
        const hasV = !!this.cfg.video && this.videoChunks.length > 0;
        const hasA = !!this.cfg.audio && this.audioChunks.length > 0;
        const ftyp = this.buildFtyp();
        let dataLen = 0;
        const tracks = [this.videoChunks, this.audioChunks, ...this.extraVideoChunks, ...this.extraAudioChunks];
        for (const list of tracks) {
            for (let i = 0; i < list.length; i++) {
                list.setOffset(i, dataLen);
                dataLen = this.checkedStandardByteCount(dataLen, list.byteLength(i));
            }
        }
        const MAX_U32 = 0xffffffff;
        const needsLargeMdat = dataLen + 8 > MAX_U32;
        const mdatHeaderLen = needsLargeMdat ? 16 : 8;
        let moov = this.buildMoov(hasV, hasA, 0);
        let base = ftyp.length + moov.length + mdatHeaderLen;
        this.use64BitOffsets = needsLargeMdat || base + dataLen > MAX_U32;
        moov = this.buildMoov(hasV, hasA, 0);
        base = ftyp.length + moov.length + mdatHeaderLen;
        moov = this.buildMoov(hasV, hasA, base);
        this.sink.write(ftyp);
        this.sink.write(moov);
        const mdatHeader = new Uint8Array(mdatHeaderLen);
        const dv = new DataView(mdatHeader.buffer);
        if (needsLargeMdat) {
            dv.setUint32(0, 1, false);
            mdatHeader.set(ascii('mdat'), 4);
            const total = BigInt(dataLen) + 16n;
            dv.setBigUint64(8, total, false);
        }
        else {
            dv.setUint32(0, dataLen + 8, false);
            mdatHeader.set(ascii('mdat'), 4);
        }
        this.sink.write(mdatHeader);
        for (const list of tracks) {
            for (let i = 0; i < list.length; i++) {
                const data = list.data(i);
                if (!data)
                    throw new MediaForgeError('Non-seekable standard MP4 lost a buffered sample payload', 'MUX');
                this.sink.write(data);
            }
        }
    }
    checkedStandardByteCount(current, addition) {
        const next = current + addition;
        if (!Number.isSafeInteger(next)) {
            throw new MediaForgeError('MP4 media byte count exceeds JavaScript exact-integer range', 'MUX');
        }
        return next;
    }
    writeInitSegmentOnce() {
        if (this.initWritten)
            return;
        const hasV = !!this.cfg.video;
        const hasA = !!this.cfg.audio;
        if (hasV && this.isH264() && !this.videoConfig) {
            throw new MediaForgeError('fragmented MP4: H.264 codec config (avcC) missing at first flush', 'MUX');
        }
        if (hasA && (this.cfg.audio?.codec ?? '').startsWith('mp4a') && !this.audioConfig) {
            throw new MediaForgeError('fragmented MP4: AAC codec config (ASC) missing at first flush', 'MUX');
        }
        this.videoPresentationStartSec = this.fragmentPresentationStart(true);
        this.audioPresentationStartSec = this.fragmentPresentationStart(false);
        this.videoTimelineRebaseSec = this.fragmentTimelineRebase(this.vFirstDtsSec, this.videoPresentationStartSec, 0, 'video');
        const audioExtraPrime = this.audioPriming && !this.audioPriming.presentationTimestamps
            ? this.audioPriming.primeSamples / this.audioTimescale()
            : 0;
        this.audioTimelineRebaseSec = this.fragmentTimelineRebase(this.aFirstDtsSec, this.audioPresentationStartSec, audioExtraPrime, 'audio');
        const movieTimescale = chooseMovieTimescale([
            ...(hasV ? [this.videoTimescale()] : []),
            ...(hasA ? [this.audioTimescale()] : []),
        ]);
        const traks = [];
        const trexes = [];
        let id = 1;
        if (hasV) {
            traks.push(this.buildFragTrak(id, true, movieTimescale));
            trexes.push(this.buildTrex(id));
            id++;
        }
        if (hasA) {
            traks.push(this.buildFragTrak(id, false, movieTimescale));
            trexes.push(this.buildTrex(id));
        }
        const mvhd = this.buildMvhd(movieTimescale, 0, id + 1);
        const moov = box('moov', mvhd, ...traks, box('mvex', ...trexes), mp4TitleBox(this.cfg.title, this.cfg.format === 'mov'), ...(this.cfg.moovUserData ? [this.cfg.moovUserData] : []));
        this.sink.write(this.buildFtyp());
        this.sink.write(moov);
        this.initWritten = true;
    }
    fragmentPresentationStart(isVideo) {
        const cfg = isVideo ? this.cfg.video : this.cfg.audio;
        const declared = cfg?.presentationStartSeconds;
        if (declared !== undefined) {
            if (!Number.isFinite(declared) || declared < 0) {
                throw new MediaForgeError(`fragmented MP4 ${isVideo ? 'video' : 'audio'} presentation start is invalid: ${declared}`, 'MUX');
            }
            return declared;
        }
        let derived = isVideo ? this.vMinPtsSec : this.aMinPtsSec;
        if (!isVideo && Number.isFinite(derived) && this.audioPriming?.presentationTimestamps) {
            derived += this.audioPriming.primeSamples / this.audioTimescale();
        }
        return Number.isFinite(derived) ? Math.max(0, derived) : 0;
    }
    validateFragmentedAudioPresentationWindow() {
        if (!this.audioPriming)
            return;
        let encoded = this.fragmentedAudioDurationUnits;
        if (this.cfg.audio?.codec.startsWith('mp4a')) {
            const samplesPerAccessUnit = this.audioConfig
                ? (parseAacAudioSpecificConfig(this.audioConfig)?.samplesPerAccessUnit ?? 0)
                : 0;
            if (samplesPerAccessUnit > 0) {
                const nominal = this.fragmentedAudioPacketCount * samplesPerAccessUnit;
                if (!Number.isSafeInteger(nominal)) {
                    throw new MediaForgeError('Fragmented MP4 AAC sample count exceeds the exact-integer range', 'MUX');
                }
                encoded = Math.max(encoded, nominal);
            }
        }
        const required = this.audioPriming.primeSamples + this.audioPriming.validSamples;
        if (required > encoded) {
            throw new MediaForgeError(`Fragmented MP4 audio presentation window ${required} exceeds ${encoded} encoded samples`, 'MUX');
        }
    }
    fragmentTimelineRebase(firstDts, presentationStart, extraPrimeSeconds, label) {
        if (firstDts === null)
            return 0;
        const rebase = Math.max(-firstDts, -(presentationStart + extraPrimeSeconds));
        if (!Number.isFinite(rebase)) {
            throw new MediaForgeError(`fragmented MP4 ${label} timeline rebase is non-finite`, 'MUX');
        }
        return rebase;
    }
    isH264() {
        const c = this.cfg.video?.codec ?? '';
        return c.startsWith('avc1') || c.startsWith('avc3');
    }
    buildFragTrak(id, isVideo, movieTimescale) {
        const timescale = isVideo ? this.videoTimescale() : this.audioTimescale();
        const track = isVideo ? this.cfg.video : this.cfg.audio;
        const presentationStart = isVideo ? this.videoPresentationStartSec : this.audioPresentationStartSec;
        const rebase = isVideo ? this.videoTimelineRebaseSec : this.audioTimelineRebaseSec;
        const extraPrimeSeconds = !isVideo && this.audioPriming && !this.audioPriming.presentationTimestamps
            ? this.audioPriming.primeSamples / timescale
            : 0;
        const declaredDuration = !isVideo && this.audioPriming
            ? this.audioPriming.validSamples / timescale
            : track?.presentationDurationSeconds;
        if (declaredDuration !== undefined && (!Number.isFinite(declaredDuration) || declaredDuration <= 0)) {
            throw new MediaForgeError(`fragmented MP4 ${isVideo ? 'video' : 'audio'} presentation duration is invalid: ${declaredDuration}`, 'MUX');
        }
        const leadMovieUnits = Math.round(presentationStart * movieTimescale);
        const presentationDuration = declaredDuration === undefined ? 0 : Math.max(1, Math.round(declaredDuration * movieTimescale));
        const mediaTimeUnits = Math.round((rebase + presentationStart + extraPrimeSeconds) * timescale);
        if (!Number.isSafeInteger(leadMovieUnits) ||
            leadMovieUnits < 0 ||
            !Number.isSafeInteger(presentationDuration) ||
            presentationDuration < 0 ||
            !Number.isSafeInteger(mediaTimeUnits) ||
            mediaTimeUnits < 0 ||
            !Number.isSafeInteger(leadMovieUnits + presentationDuration)) {
            throw new MediaForgeError(`fragmented MP4 ${isVideo ? 'video' : 'audio'} edit exceeds the exact timeline range`, 'MUX');
        }
        const mediaHeader = isVideo
            ? fullBox('vmhd', 0, 1, new Uint8Array(8))
            : fullBox('smhd', 0, 0, new Uint8Array(4));
        const emptyU32 = new Uint8Array(4);
        const stbl = box('stbl', this.buildStsd(isVideo), fullBox('stts', 0, 0, emptyU32), fullBox('stsc', 0, 0, emptyU32), fullBox('stsz', 0, 0, new Uint8Array(8)), fullBox('stco', 0, 0, emptyU32));
        const minf = box('minf', mediaHeader, this.buildDinf(), stbl);
        const mdia = box('mdia', this.buildMdhd(timescale, 0), this.buildHdlr(isVideo), minf);
        const parts = [this.buildTkhd(id, isVideo, leadMovieUnits + presentationDuration)];
        if (leadMovieUnits > 0 ||
            mediaTimeUnits > 0 ||
            declaredDuration !== undefined ||
            (!isVideo && this.audioPriming)) {
            parts.push(this.buildEdts(leadMovieUnits, presentationDuration, mediaTimeUnits));
        }
        parts.push(mdia);
        parts.push(...mp4TrackMetadataBoxes(isVideo ? this.cfg.video : this.cfg.audio, this.cfg.format === 'mov'));
        return box('trak', ...parts);
    }
    buildTrex(id) {
        const p = new Uint8Array(20);
        const dv = new DataView(p.buffer);
        dv.setUint32(0, id, false);
        dv.setUint32(4, 1, false);
        return fullBox('trex', 0, 0, p);
    }
    fragmentDecodeBase(firstDts, rebase, timescale, label) {
        const base = Math.round((firstDts + rebase) * timescale);
        if (!Number.isSafeInteger(base) || base < 0) {
            throw new MediaForgeError(`fragmented MP4 ${label} tfdt is outside the unsigned exact-integer range: ${base}`, 'MUX');
        }
        return base;
    }
    flushFragment() {
        if (this.pendingV.length === 0 && this.pendingA.length === 0) {
            this.fragStartSec = null;
            return;
        }
        this.writeInitSegmentOnce();
        const plans = [];
        let id = 1;
        if (this.cfg.video) {
            if (this.pendingV.length > 0) {
                const first = this.pendingV[0];
                const firstDts = first.decodeTimestamp ?? first.timestamp;
                const timescale = this.videoTimescale();
                plans.push({
                    id,
                    timescale,
                    base: this.fragmentDecodeBase(firstDts, this.videoTimelineRebaseSec, timescale, 'video'),
                    chunks: this.pendingV,
                    payloadBytes: this.pendingV.reduce((n, c) => n + c.data.byteLength, 0),
                });
            }
            id++;
        }
        if (this.cfg.audio && this.pendingA.length > 0) {
            const first = this.pendingA[0];
            const firstDts = first.decodeTimestamp ?? first.timestamp;
            const timescale = this.audioTimescale();
            plans.push({
                id,
                timescale,
                base: this.fragmentDecodeBase(firstDts, this.audioTimelineRebaseSec, timescale, 'audio'),
                chunks: this.pendingA,
                payloadBytes: this.pendingA.reduce((n, c) => n + c.data.byteLength, 0),
            });
        }
        const buildTrun = (plan, dataOffset) => {
            const n = plan.chunks.length;
            const p = new Uint8Array(8 + n * 16);
            const dv = new DataView(p.buffer);
            dv.setUint32(0, n, false);
            dv.setInt32(4, checkedInteger(dataOffset, 'trun data offset', -0x80000000, 0x7fffffff), false);
            const compositionOffsets = plan.chunks.map(c => checkedInteger(Math.round((c.compositionTimeOffset ?? c.timestamp - (c.decodeTimestamp ?? c.timestamp)) * plan.timescale), 'trun composition offset', -0x80000000, 0xffffffff));
            const signed = compositionOffsets.some(value => value < 0);
            const version = !signed && compositionOffsets.some(value => value > 0x7fffffff) ? 0 : 1;
            let decodeEnd = plan.base;
            let pos = 8;
            for (let i = 0; i < n; i++) {
                const c = plan.chunks[i];
                const dts = c.decodeTimestamp ?? c.timestamp;
                const next = plan.chunks[i + 1];
                const nextDts = next ? (next.decodeTimestamp ?? next.timestamp) : dts + (c.duration || 0);
                let durUnits = Math.round(Math.max(0, nextDts - dts) * plan.timescale);
                if (durUnits <= 0)
                    durUnits = Math.max(1, Math.round((c.duration || 1 / plan.timescale) * plan.timescale));
                const isVideo = plan.id === 1 && !!this.cfg.video;
                const flags = !isVideo || c.isKeyframe ? 0x02000000 : 0x01010000;
                const cts = checkedInteger(compositionOffsets[i], 'trun composition offset', version === 1 ? -0x80000000 : 0, version === 1 ? 0x7fffffff : 0xffffffff);
                checkedInteger(durUnits, 'trun sample duration', 1, 0xffffffff);
                decodeEnd = checkedInteger(decodeEnd + durUnits, 'fragment decode end');
                checkedInteger(decodeEnd + cts, 'fragment presentation end', -Number.MAX_SAFE_INTEGER);
                dv.setUint32(pos, durUnits, false);
                dv.setUint32(pos + 4, c.data.byteLength, false);
                dv.setUint32(pos + 8, flags, false);
                if (version === 1)
                    dv.setInt32(pos + 12, cts, false);
                else
                    dv.setUint32(pos + 12, cts, false);
                pos += 16;
            }
            return fullBox('trun', version, 0x000f01, p);
        };
        const buildTraf = (plan, dataOffset) => {
            const tfhdPayload = new Uint8Array(4);
            new DataView(tfhdPayload.buffer).setUint32(0, plan.id, false);
            const tfdtPayload = new Uint8Array(8);
            const dv = new DataView(tfdtPayload.buffer);
            dv.setUint32(0, Math.floor(plan.base / 0x100000000), false);
            dv.setUint32(4, plan.base >>> 0, false);
            return box('traf', fullBox('tfhd', 0, 0x020000, tfhdPayload), fullBox('tfdt', 1, 0, tfdtPayload), buildTrun(plan, dataOffset));
        };
        const probe = box('moof', this.buildMfhd(this.moofSeq), ...plans.map(p => buildTraf(p, 0)));
        let running = probe.length + 8;
        const offsets = plans.map(p => {
            const off = running;
            running += p.payloadBytes;
            return off;
        });
        const moof = box('moof', this.buildMfhd(this.moofSeq), ...plans.map((p, i) => buildTraf(p, offsets[i])));
        if (moof.length !== probe.length) {
            throw new MediaForgeError('fragmented MP4: moof sizing pass diverged', 'MUX');
        }
        const mdatPayloads = [];
        for (const plan of plans)
            for (const c of plan.chunks)
                mdatPayloads.push(c.data);
        this.moofSeq++;
        this.sink.write(moof);
        this.sink.write(box('mdat', ...mdatPayloads));
        this.pendingV = [];
        this.pendingA = [];
        this.fragStartSec = null;
    }
    buildMfhd(seq) {
        const p = new Uint8Array(4);
        new DataView(p.buffer).setUint32(0, seq, false);
        return fullBox('mfhd', 0, 0, p);
    }
    buildFtyp() {
        const fmt = this.cfg.format;
        let major = 'isom';
        const compatible = [];
        if (fmt === 'mov') {
            major = 'qt  ';
            compatible.push('qt  ');
        }
        else if (fmt === '3gp') {
            major = '3gp6';
            compatible.push('3gp6', 'isom');
        }
        else if (fmt === 'm4a') {
            major = 'M4A ';
            compatible.push('M4A ', 'isom', 'mp42');
        }
        else if (fmt === 'm4v') {
            major = 'mp42';
            compatible.push('mp42', 'isom', 'mp41');
        }
        else {
            major = 'isom';
            compatible.push('isom', 'iso2', 'mp41');
        }
        const videoCodecs = [
            ...(this.cfg.video ? [this.cfg.video.codec] : []),
            ...(this.cfg.extraVideoTracks ?? []).map(track => track.codec),
        ];
        if (videoCodecs.some(codec => codec.startsWith('hvc1') || codec.startsWith('hev1')))
            compatible.push('iso8');
        if (videoCodecs.some(codec => codec.startsWith('av01')))
            compatible.push('av01');
        const brands = [ascii(major), u32be(0x200), ...compatible.map(ascii)];
        let total = 8;
        for (const brand of brands)
            total += brand.length;
        const out = new Uint8Array(total);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, total, false);
        out.set(ascii('ftyp'), 4);
        let pos = 8;
        for (const brand of brands) {
            out.set(brand, pos);
            pos += brand.length;
        }
        return out;
    }
    buildMoov(hasV, hasA, base) {
        const videoTimescale = this.cfg.video?.mediaTimescale ?? this.videoTimescale();
        const audioTimescale = this.cfg.audio?.mediaTimescale ?? this.audioTimescale();
        const extraVideoTimescales = (this.cfg.extraVideoTracks ?? []).map((track, index) => track.mediaTimescale ?? this.videoTimescale(this.extraVideoChunks[index]));
        const extraAudioTimescales = (this.cfg.extraAudioTracks ?? []).map(track => track.mediaTimescale ?? track.sampleRate);
        const movieTimescale = chooseMovieTimescale([
            ...(hasV ? [videoTimescale] : []),
            ...(hasA ? [audioTimescale] : []),
            ...extraVideoTimescales,
            ...extraAudioTimescales,
        ]);
        const videoTiming = hasV
            ? copyPresentationTiming(readChunkTiming(this.videoChunks, videoTimescale), videoTimescale, this.cfg.video)
            : null;
        let audioTiming = hasA ? readChunkTiming(this.audioChunks, audioTimescale) : null;
        if (audioTiming && !hasCopyPresentation(this.cfg.audio) && this.cfg.audio?.codec.startsWith('mp4a')) {
            audioTiming = normalizeAacCodedDuration(audioTiming, audioTimescale, this.audioChunks.length, this.audioConfig);
        }
        if (audioTiming && this.audioPriming && !hasCopyPresentation(this.cfg.audio)) {
            audioTiming = applyAudioPresentationWindow(audioTiming, audioTimescale, this.audioPriming.primeSamples, this.audioPriming.validSamples, this.audioPriming.presentationTimestamps, 'Primary audio');
        }
        if (audioTiming)
            audioTiming = copyPresentationTiming(audioTiming, audioTimescale, this.cfg.audio);
        const videoMovieDuration = videoTiming
            ? presentationMovieDuration(this.cfg.video, videoTiming, videoTimescale, movieTimescale)
            : 0;
        const audioMovieDuration = audioTiming
            ? presentationMovieDuration(this.cfg.audio, audioTiming, audioTimescale, movieTimescale, this.audioPriming?.validSamples)
            : 0;
        const extraAudioPlans = [];
        const extraAudios = this.cfg.extraAudioTracks ?? [];
        for (let i = 0; i < extraAudios.length; i++) {
            const chunks = this.extraAudioChunks[i];
            if (chunks.length === 0)
                continue;
            const track = extraAudios[i];
            const ts = extraAudioTimescales[i];
            let timing = readChunkTiming(chunks, ts);
            if (!hasCopyPresentation(track) && track.codec.startsWith('mp4a')) {
                timing = normalizeAacCodedDuration(timing, ts, chunks.length, this.extraAudioConfigs[i]);
            }
            if (track.validSamples !== undefined && !hasCopyPresentation(track)) {
                timing = applyAudioPresentationWindow(timing, ts, track.primingSamples ?? 0, track.validSamples, track.presentationTimestamps === true, `Extra audio track ${i}`);
            }
            timing = copyPresentationTiming(timing, ts, track);
            const dur = presentationMovieDuration(track, timing, ts, movieTimescale, track.validSamples);
            extraAudioPlans.push({ track, chunks, ts, timing, dur, index: i });
        }
        const extraVideoPlans = [];
        const extraVideos = this.cfg.extraVideoTracks ?? [];
        for (let i = 0; i < extraVideos.length; i++) {
            const chunks = this.extraVideoChunks[i];
            if (chunks.length === 0)
                continue;
            const track = extraVideos[i];
            const ts = extraVideoTimescales[i];
            const timing = copyPresentationTiming(readChunkTiming(chunks, ts), ts, track);
            const dur = presentationMovieDuration(track, timing, ts, movieTimescale);
            extraVideoPlans.push({ track, chunks, ts, timing, dur, index: i });
        }
        const starts = [];
        if (videoTiming)
            starts.push(videoTiming.startSeconds);
        if (audioTiming)
            starts.push(audioTiming.startSeconds);
        for (const plan of extraVideoPlans)
            starts.push(plan.timing.startSeconds);
        for (const plan of extraAudioPlans)
            starts.push(plan.timing.startSeconds);
        const preserveOrigin = [this.cfg.video, this.cfg.audio, ...extraVideos, ...extraAudios].some(hasCopyPresentation);
        const baseStart = preserveOrigin ? 0 : starts.length > 0 ? Math.min(...starts) : 0;
        const leadFor = (timing) => Math.max(0, Math.round((timing.startSeconds - baseStart) * movieTimescale));
        const videoLead = videoTiming ? leadFor(videoTiming) : 0;
        const audioLead = audioTiming ? leadFor(audioTiming) : 0;
        let movieDuration = Math.max(0, videoLead + videoMovieDuration, audioLead + audioMovieDuration);
        for (const plan of extraVideoPlans) {
            movieDuration = Math.max(movieDuration, leadFor(plan.timing) + plan.dur);
        }
        for (const plan of extraAudioPlans) {
            movieDuration = Math.max(movieDuration, leadFor(plan.timing) + plan.dur);
        }
        const traks = [];
        if (hasV) {
            traks.push(this.buildTrak(1, true, this.videoChunks, base, videoTimescale, videoTiming, videoMovieDuration, videoLead, hasCopyPresentation(this.cfg.video)));
        }
        if (hasA) {
            traks.push(this.buildTrak(hasV ? 2 : 1, false, this.audioChunks, base, audioTimescale, audioTiming, audioMovieDuration, audioLead, this.audioPriming !== null || hasCopyPresentation(this.cfg.audio)));
        }
        for (const plan of extraVideoPlans) {
            this.activeVideoCfg = plan.track;
            this.activeVideoConfig = this.extraVideoConfigs[plan.index];
            traks.push(this.buildTrak(traks.length + 1, true, plan.chunks, base, plan.ts, plan.timing, plan.dur, leadFor(plan.timing), hasCopyPresentation(plan.track)));
            this.activeVideoCfg = undefined;
            this.activeVideoConfig = undefined;
        }
        for (const plan of extraAudioPlans) {
            this.activeAudioCfg = plan.track;
            this.activeAudioConfig = this.extraAudioConfigs[plan.index];
            traks.push(this.buildTrak(traks.length + 1, false, plan.chunks, base, plan.ts, plan.timing, plan.dur, leadFor(plan.timing), plan.track.validSamples !== undefined || hasCopyPresentation(plan.track)));
            this.activeAudioCfg = undefined;
            this.activeAudioConfig = undefined;
        }
        const userData = this.cfg.moovUserData;
        return box('moov', this.buildMvhd(movieTimescale, movieDuration, traks.length + 1), ...traks, mp4TitleBox(this.cfg.title, this.cfg.format === 'mov'), ...(userData ? [userData] : []));
    }
    buildMvhd(timescale, duration, nextTrackId) {
        checkedInteger(duration, 'movie duration');
        if (duration >= 0xffffffff) {
            const payload = new Uint8Array(112);
            const dv = new DataView(payload.buffer);
            dv.setUint32(16, timescale, false);
            dv.setBigUint64(20, BigInt(Math.round(duration)), false);
            dv.setUint32(28, 0x00010000, false);
            dv.setUint16(32, 0x0100, false);
            dv.setUint32(44, 0x00010000, false);
            dv.setUint32(60, 0x00010000, false);
            dv.setUint32(76, 0x40000000, false);
            dv.setUint32(108, nextTrackId, false);
            return fullBox('mvhd', 1, 0, payload);
        }
        const payload = new Uint8Array(100);
        const dv = new DataView(payload.buffer);
        dv.setUint32(8, timescale, false);
        dv.setUint32(12, duration, false);
        dv.setUint32(16, 0x00010000, false);
        dv.setUint16(20, 0x0100, false);
        dv.setUint32(32, 0x00010000, false);
        dv.setUint32(48, 0x00010000, false);
        dv.setUint32(64, 0x40000000, false);
        dv.setUint32(96, nextTrackId, false);
        return fullBox('mvhd', 0, 0, payload);
    }
    buildTrak(id, isVideo, chunks, base, trackTimescale, timing, movieDuration, leadMovieUnits, forceEditList = false) {
        const tkhd = this.buildTkhd(id, isVideo, leadMovieUnits + movieDuration);
        const mdhd = this.buildMdhd(trackTimescale, timing.durationUnits, isVideo);
        const minf = this.buildMinf(isVideo, chunks, base, timing);
        const mdia = box('mdia', mdhd, this.buildHdlr(isVideo), minf);
        const metadata = mp4TrackMetadataBoxes(isVideo ? (this.activeVideoCfg ?? this.cfg.video) : (this.activeAudioCfg ?? this.cfg.audio), this.cfg.format === 'mov');
        if (forceEditList || leadMovieUnits > 0 || timing.mediaTimeUnits > 0) {
            return box('trak', tkhd, this.buildEdts(leadMovieUnits, movieDuration, timing.mediaTimeUnits), mdia, ...metadata);
        }
        return box('trak', tkhd, mdia, ...metadata);
    }
    buildEdts(leadMovieUnits, movieDuration, mediaTimeUnits) {
        checkedInteger(leadMovieUnits, 'edit lead duration');
        checkedInteger(movieDuration, 'edit presentation duration');
        checkedInteger(mediaTimeUnits, 'edit media time');
        const entryCount = leadMovieUnits > 0 ? 2 : 1;
        const version1 = leadMovieUnits >= 0x100000000 || movieDuration >= 0x100000000 || mediaTimeUnits > 0x7fffffff;
        if (version1) {
            const payload = new Uint8Array(4 + entryCount * 20);
            const dv = new DataView(payload.buffer);
            dv.setUint32(0, entryCount, false);
            let p = 4;
            if (leadMovieUnits > 0) {
                dv.setBigUint64(p, BigInt(Math.round(leadMovieUnits)), false);
                dv.setBigInt64(p + 8, -1n, false);
                dv.setUint32(p + 16, 0x00010000, false);
                p += 20;
            }
            dv.setBigUint64(p, BigInt(Math.round(movieDuration)), false);
            dv.setBigInt64(p + 8, BigInt(Math.round(mediaTimeUnits)), false);
            dv.setUint32(p + 16, 0x00010000, false);
            return box('edts', fullBox('elst', 1, 0, payload));
        }
        const payload = new Uint8Array(4 + entryCount * 12);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, entryCount, false);
        let p = 4;
        if (leadMovieUnits > 0) {
            dv.setUint32(p, leadMovieUnits, false);
            dv.setInt32(p + 4, -1, false);
            dv.setUint32(p + 8, 0x00010000, false);
            p += 12;
        }
        dv.setUint32(p, movieDuration, false);
        dv.setInt32(p + 4, mediaTimeUnits, false);
        dv.setUint32(p + 8, 0x00010000, false);
        return box('edts', fullBox('elst', 0, 0, payload));
    }
    writeTkhdMatrix(dv, base, isVideo) {
        const ONE = 0x00010000;
        const video = isVideo ? (this.activeVideoCfg ?? this.cfg.video) : undefined;
        const rot = video?.rotation ?? 0;
        const w = fixed16_16(video?.displayWidth ?? video?.width ?? 0);
        const h = fixed16_16(video?.displayHeight ?? video?.height ?? 0);
        let cells;
        switch (((rot % 360) + 360) % 360) {
            case 90:
                cells = [0, -ONE, 0, ONE, 0, 0, 0, w, 0x40000000];
                break;
            case 180:
                cells = [-ONE, 0, 0, 0, -ONE, 0, w, h, 0x40000000];
                break;
            case 270:
                cells = [0, ONE, 0, -ONE, 0, 0, h, 0, 0x40000000];
                break;
            default:
                cells = [ONE, 0, 0, 0, ONE, 0, 0, 0, 0x40000000];
                break;
        }
        for (let i = 0; i < 9; i++)
            dv.setInt32(base + i * 4, cells[i], false);
    }
    buildTkhd(id, isVideo, duration) {
        checkedInteger(duration, 'track presentation duration');
        const flags = mp4TrackFlags(isVideo ? (this.activeVideoCfg ?? this.cfg.video) : (this.activeAudioCfg ?? this.cfg.audio));
        if (duration >= 0xffffffff) {
            const payload = new Uint8Array(92);
            const dv = new DataView(payload.buffer);
            dv.setUint32(16, id, false);
            dv.setBigUint64(24, BigInt(Math.round(duration)), false);
            if (!isVideo)
                dv.setUint16(44, 0x0100, false);
            this.writeTkhdMatrix(dv, 48, isVideo);
            const video = isVideo ? (this.activeVideoCfg ?? this.cfg.video) : undefined;
            if (video) {
                const displayWidth = video.displayWidth ?? video.width;
                const displayHeight = video.displayHeight ?? video.height;
                dv.setUint32(84, fixed16_16(displayWidth), false);
                dv.setUint32(88, fixed16_16(displayHeight), false);
            }
            return fullBox('tkhd', 1, flags, payload);
        }
        const payload = new Uint8Array(80);
        const dv = new DataView(payload.buffer);
        dv.setUint32(8, id, false);
        dv.setUint32(16, duration, false);
        if (!isVideo)
            dv.setUint16(32, 0x0100, false);
        this.writeTkhdMatrix(dv, 36, isVideo);
        const video = isVideo ? (this.activeVideoCfg ?? this.cfg.video) : undefined;
        if (video) {
            const displayWidth = video.displayWidth ?? video.width;
            const displayHeight = video.displayHeight ?? video.height;
            dv.setUint32(72, fixed16_16(displayWidth), false);
            dv.setUint32(76, fixed16_16(displayHeight), false);
        }
        return fullBox('tkhd', 0, flags, payload);
    }
    languageCode(isVideo) {
        const raw = (isVideo
            ? (this.activeVideoCfg?.language ??
                (this.activeVideoCfg ? undefined : (this.cfg.videoLanguage ?? this.cfg.video?.language)))
            : (this.activeAudioCfg?.language ??
                (this.activeAudioCfg ? undefined : (this.cfg.audioLanguage ?? this.cfg.audio?.language)))) ?? '';
        const code = raw.trim().toLowerCase();
        if (!/^[a-z]{3}$/.test(code) || code === 'und')
            return 0x55c4;
        return ((code.charCodeAt(0) - 0x60) << 10) | ((code.charCodeAt(1) - 0x60) << 5) | (code.charCodeAt(2) - 0x60);
    }
    buildMdhd(timescale, duration, isVideo = false) {
        checkedInteger(timescale, 'media timescale', 1, 0xffffffff);
        checkedInteger(duration, 'media duration');
        if (duration >= 0xffffffff) {
            const payload = new Uint8Array(32);
            const dv = new DataView(payload.buffer);
            dv.setUint32(16, timescale, false);
            dv.setBigUint64(20, BigInt(Math.round(duration)), false);
            dv.setUint16(28, this.languageCode(isVideo), false);
            return fullBox('mdhd', 1, 0, payload);
        }
        const payload = new Uint8Array(20);
        const dv = new DataView(payload.buffer);
        dv.setUint32(8, timescale, false);
        dv.setUint32(12, duration, false);
        dv.setUint16(16, this.languageCode(isVideo), false);
        return fullBox('mdhd', 0, 0, payload);
    }
    buildHdlr(isVideo) {
        const name = mp4HandlerName((isVideo ? (this.activeVideoCfg ?? this.cfg.video) : (this.activeAudioCfg ?? this.cfg.audio))?.name);
        const payload = new Uint8Array(20 + name.length);
        payload.set(ascii(isVideo ? 'vide' : 'soun'), 4);
        payload.set(name, 20);
        return fullBox('hdlr', 0, 0, payload);
    }
    buildMinf(isVideo, chunks, base, timing) {
        const mediaHeader = isVideo
            ? fullBox('vmhd', 0, 1, new Uint8Array(8))
            : fullBox('smhd', 0, 0, new Uint8Array(4));
        return box('minf', mediaHeader, this.buildDinf(), this.buildStbl(isVideo, chunks, base, timing));
    }
    buildDinf() {
        const entry = fullBox('url ', 0, 1, new Uint8Array(0));
        const payload = new Uint8Array(4 + entry.length);
        new DataView(payload.buffer).setUint32(0, 1, false);
        payload.set(entry, 4);
        return box('dinf', fullBox('dref', 0, 0, payload));
    }
    buildStbl(isVideo, chunks, base, timing) {
        const parts = [
            this.buildStsd(isVideo),
            this.buildStts(timing.decodeDurations),
            this.buildStsc(),
            this.buildStsz(chunks),
            this.buildStco(chunks, base),
        ];
        const ctts = this.buildCtts(timing.compositionOffsets);
        if (ctts)
            parts.push(ctts);
        if (isVideo) {
            const stss = this.buildStss(chunks);
            if (stss)
                parts.push(stss);
        }
        return box('stbl', ...parts);
    }
    buildStsd(isVideo) {
        const entry = isVideo ? this.buildVideoSampleEntry() : this.buildAudioSampleEntry();
        const payload = new Uint8Array(4 + entry.length);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, 1, false);
        payload.set(entry, 4);
        return fullBox('stsd', 0, 0, payload);
    }
    buildVideoSampleEntry() {
        const codec = (this.activeVideoCfg ?? this.cfg.video)?.codec ?? 'avc1.640028';
        const sampleEntryType = this.resolveVideoSampleEntryType(codec);
        const configBoxType = sampleEntryType === 'av01'
            ? 'av1C'
            : sampleEntryType === 'hvc1' || sampleEntryType === 'hev1'
                ? 'hvcC'
                : sampleEntryType.startsWith('avc')
                    ? 'avcC'
                    : undefined;
        const activeVideoConfigBytes = this.activeVideoCfg ? this.activeVideoConfig : this.videoConfig;
        const width = (this.activeVideoCfg ?? this.cfg.video)?.width ?? 0;
        const height = (this.activeVideoCfg ?? this.cfg.video)?.height ?? 0;
        const payloads = [];
        if (configBoxType && activeVideoConfigBytes)
            payloads.push(box(configBoxType, activeVideoConfigBytes));
        const colour = this.activeVideoCfg
            ? this.activeVideoCfg.colour
            : (this.cfg.video?.colour ?? this.cfg.videoColour);
        if (colour) {
            const colr = new Uint8Array(11);
            colr.set(ascii('nclx'), 0);
            const cdv = new DataView(colr.buffer);
            cdv.setUint16(4, colour.primaries, false);
            cdv.setUint16(6, colour.transfer, false);
            cdv.setUint16(8, colour.matrix, false);
            colr[10] = colour.fullRange ? 0x80 : 0x00;
            payloads.push(box('colr', colr));
        }
        const activeVideo = this.activeVideoCfg ?? this.cfg.video;
        const parNum = activeVideo?.pixelAspectRatioNum ?? 1;
        const parDen = activeVideo?.pixelAspectRatioDen ?? 1;
        if (parNum > 0 && parDen > 0 && !(parNum === 1 && parDen === 1)) {
            payloads.push(box('pasp', u32be(parNum), u32be(parDen)));
        }
        let total = 86;
        for (const payload of payloads)
            total += payload.length;
        const out = new Uint8Array(total);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, total, false);
        out.set(ascii(sampleEntryType), 4);
        dv.setUint16(14, 1, false);
        dv.setUint16(32, width, false);
        dv.setUint16(34, height, false);
        dv.setUint32(36, 0x00480000, false);
        dv.setUint32(40, 0x00480000, false);
        dv.setUint16(48, 1, false);
        dv.setUint16(82, 0x0018, false);
        dv.setUint16(84, 0xffff, false);
        let pos = 86;
        for (const payload of payloads) {
            out.set(payload, pos);
            pos += payload.length;
        }
        return out;
    }
    buildAudioSampleEntry() {
        const codec = (this.activeAudioCfg ?? this.cfg.audio)?.codec ?? 'mp4a.40.2';
        if (codec.startsWith('mp4a'))
            return this.buildMp4aEntry();
        if (codec === 'ac-3' || codec === 'ec-3')
            return this.buildDolbyAudioEntry(codec);
        throw new EncodeError(`MP4 muxer does not support audio codec '${codec}'`);
    }
    buildMp4aEntry() {
        const active = this.activeAudioCfg ?? this.cfg.audio;
        const sampleRate = active?.sampleRate ?? 48000;
        const channelCount = active?.channelCount ?? 2;
        const esds = this.buildEsds(sampleRate, channelCount, this.activeAudioCfg ? this.activeAudioConfig : this.audioConfig);
        const out = new Uint8Array(36 + esds.length);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, out.length, false);
        out.set(ascii('mp4a'), 4);
        dv.setUint16(14, 1, false);
        dv.setUint16(24, channelCount, false);
        dv.setUint16(26, 16, false);
        dv.setUint32(32, Math.min(sampleRate, 0xffff) * 0x10000, false);
        out.set(esds, 36);
        return out;
    }
    buildDolbyAudioEntry(codec) {
        const active = this.activeAudioCfg ?? this.cfg.audio;
        const activeConfig = this.activeAudioCfg ? this.activeAudioConfig : this.audioConfig;
        const sampleRate = active?.sampleRate ?? 48000;
        const channelCount = active?.channelCount ?? 2;
        const configBoxType = codec === 'ac-3' ? 'dac3' : 'dec3';
        const configBox = activeConfig ? box(configBoxType, activeConfig) : new Uint8Array(0);
        const out = new Uint8Array(36 + configBox.length);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, out.length, false);
        out.set(ascii(codec), 4);
        dv.setUint16(14, 1, false);
        dv.setUint16(24, channelCount, false);
        dv.setUint16(26, 16, false);
        dv.setUint32(32, Math.min(sampleRate, 0xffff) * 0x10000, false);
        if (configBox.length > 0)
            out.set(configBox, 36);
        return out;
    }
    resolveVideoSampleEntryType(codec) {
        if (codec.startsWith('avc3'))
            return 'avc3';
        if (codec.startsWith('avc1') || codec.startsWith('avc'))
            return 'avc1';
        if (codec.startsWith('hvc1'))
            return 'hvc1';
        if (codec.startsWith('hev1') || codec.startsWith('hev'))
            return 'hev1';
        if (codec.startsWith('av01'))
            return 'av01';
        if (isProResCodec(codec) || isProResRawCodec(codec))
            return codec;
        throw new EncodeError(`MP4 muxer does not support video codec '${codec}'`);
    }
    buildEsds(sampleRate, channelCount, audioSpecificConfig) {
        const freqTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        const freqIndex = Math.max(0, freqTable.indexOf(sampleRate));
        const asc = audioSpecificConfig && audioSpecificConfig.length > 0
            ? new Uint8Array(audioSpecificConfig)
            : new Uint8Array([(2 << 3) | (freqIndex >> 1), ((freqIndex & 1) << 7) | (channelCount << 3)]);
        const dsi = new Uint8Array([0x05, 0x80, 0x80, 0x80, asc.length, ...asc]);
        const decoderConfig = new Uint8Array([
            0x40,
            0x15,
            0x00,
            0x00,
            0x00,
            0x00,
            0x01,
            0xf4,
            0x00,
            0x00,
            0x01,
            0xf4,
            0x00,
            ...dsi,
        ]);
        const decoderConfigDesc = new Uint8Array([0x04, 0x80, 0x80, 0x80, decoderConfig.length, ...decoderConfig]);
        const slConfig = new Uint8Array([0x06, 0x80, 0x80, 0x80, 0x01, 0x02]);
        const esPayload = new Uint8Array([0x00, 0x01, 0x00, ...decoderConfigDesc, ...slConfig]);
        const esDesc = new Uint8Array([0x03, 0x80, 0x80, 0x80, esPayload.length, ...esPayload]);
        return fullBox('esds', 0, 0, esDesc);
    }
    buildStts(runs) {
        const payload = new Uint8Array(4 + runs.length * 8);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, runs.length, false);
        for (let i = 0; i < runs.length; i++) {
            dv.setUint32(4 + i * 8, runs.count(i), false);
            dv.setUint32(8 + i * 8, checkedInteger(runs.value(i), 'stts sample duration', 1, 0xffffffff), false);
        }
        return fullBox('stts', 0, 0, payload);
    }
    buildCtts(runs) {
        if (runs.length === 0 || (runs.length === 1 && runs.value(0) === 0))
            return null;
        let version = 0;
        for (let i = 0; i < runs.length; i++) {
            if (runs.value(i) < 0) {
                version = 1;
                break;
            }
        }
        const payload = new Uint8Array(4 + runs.length * 8);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, runs.length, false);
        for (let i = 0; i < runs.length; i++) {
            dv.setUint32(4 + i * 8, runs.count(i), false);
            const value = checkedInteger(runs.value(i), 'ctts composition offset', version === 1 ? -0x80000000 : 0, version === 1 ? 0x7fffffff : 0xffffffff);
            dv.setUint32(8 + i * 8, signed32Payload(value), false);
        }
        return fullBox('ctts', version, 0, payload);
    }
    buildStsc() {
        const payload = new Uint8Array(16);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, 1, false);
        dv.setUint32(4, 1, false);
        dv.setUint32(8, 1, false);
        dv.setUint32(12, 1, false);
        return fullBox('stsc', 0, 0, payload);
    }
    buildStsz(chunks) {
        const payload = new Uint8Array(8 + chunks.length * 4);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, 0, false);
        dv.setUint32(4, chunks.length, false);
        for (let i = 0; i < chunks.length; i++)
            dv.setUint32(8 + i * 4, chunks.byteLength(i), false);
        return fullBox('stsz', 0, 0, payload);
    }
    buildStco(chunks, base) {
        if (this.use64BitOffsets) {
            const payload = new Uint8Array(4 + chunks.length * 8);
            const dv = new DataView(payload.buffer);
            dv.setUint32(0, chunks.length, false);
            for (let i = 0; i < chunks.length; i++) {
                dv.setBigUint64(4 + i * 8, BigInt(base) + BigInt(chunks.offset(i)), false);
            }
            return fullBox('co64', 0, 0, payload);
        }
        const payload = new Uint8Array(4 + chunks.length * 4);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, chunks.length, false);
        for (let i = 0; i < chunks.length; i++)
            dv.setUint32(4 + i * 4, base + chunks.offset(i), false);
        return fullBox('stco', 0, 0, payload);
    }
    buildStss(chunks) {
        let syncSampleCount = 0;
        for (let i = 0; i < chunks.length; i++)
            if (chunks.isKeyframe(i))
                syncSampleCount++;
        if (syncSampleCount === chunks.length)
            return null;
        const payload = new Uint8Array(4 + syncSampleCount * 4);
        const dv = new DataView(payload.buffer);
        dv.setUint32(0, syncSampleCount, false);
        let position = 4;
        for (let i = 0; i < chunks.length; i++) {
            if (chunks.isKeyframe(i)) {
                dv.setUint32(position, i + 1, false);
                position += 4;
            }
        }
        return fullBox('stss', 0, 0, payload);
    }
    videoTimescale(chunks = this.videoChunks) {
        let maxGapSeconds = 0;
        for (let i = 1; i < chunks.length; i++) {
            const prevDts = chunks.decodeTimestamp(i - 1);
            const curDts = chunks.decodeTimestamp(i);
            const gap = curDts - prevDts;
            if (Number.isFinite(gap) && gap > maxGapSeconds)
                maxGapSeconds = gap;
        }
        const lastDuration = chunks.length > 0 ? chunks.duration(chunks.length - 1) : 0;
        if (Number.isFinite(lastDuration) && lastDuration > maxGapSeconds) {
            maxGapSeconds = lastDuration;
        }
        const DEFAULT = 90000;
        const LIMIT = 0x7fff0000;
        if (maxGapSeconds <= 0 || DEFAULT * maxGapSeconds < LIMIT)
            return DEFAULT;
        return Math.max(1, Math.floor(LIMIT / maxGapSeconds));
    }
    audioTimescale() {
        return this.cfg.audio?.sampleRate ?? 48000;
    }
}
