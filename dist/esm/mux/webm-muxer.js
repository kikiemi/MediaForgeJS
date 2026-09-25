import { isAnnexB, isValidAvccWalk, isValidHevcWalk, annexBToAvcc, buildAvcCFromAnnexB, buildHevcCFromAnnexB, } from '../core/annexb.js';
import { MediaForgeError } from '../core/errors.js';
import { parseAacAudioSpecificConfig } from '../audio/adts.js';
import { normalizeMatroskaDisplay } from './matroska-display.js';
import { filterMatroskaTags } from '../core/matroska-tags.js';
import { describeMatroskaPcm } from '../core/matroska-pcm.js';
import { mergeMatroskaTrackTitles } from '../core/matroska-track-titles.js';
import { isProResCodec, readProResFourCC, proResFrameError } from '../core/prores.js';
const textEncoder = new TextEncoder();
function trackLanguage(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' ||
        value.length < 1 ||
        value.length > 255 ||
        !/^(?:[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*|[iIxX](?:-[A-Za-z0-9]{1,8})+)$/.test(value)) {
        throw new MediaForgeError('Matroska track language must be an ISO-639 code or BCP-47 tag of at most 255 ASCII bytes', 'FORMAT');
    }
    return value;
}
const trackConfigKeys = [
    'id',
    'matroskaTrackUid',
    'type',
    'codec',
    'codecConfig',
    'language',
    'name',
    'title',
    'commentary',
    'default',
    'forced',
    'alphaMode',
    'width',
    'height',
    'displayWidth',
    'displayHeight',
    'pixelAspectRatioNum',
    'pixelAspectRatioDen',
    'rotation',
    'framerate',
    'colour',
    'sampleRate',
    'channelCount',
    'primingSamples',
    'validSamples',
    'presentationTimestamps',
    'discardLeadingSamples',
    'codecDelaySamples',
    'presentationStartSeconds',
    'presentationDurationSeconds',
    'presentationMediaTimeSeconds',
    'mediaTimescale',
];
function snapshotTrackConfig(track) {
    const snapshot = {};
    for (const key of trackConfigKeys)
        snapshot[key] = Reflect.get(track, key);
    if (typeof snapshot.codec !== 'string') {
        throw new MediaForgeError('Matroska track codec must be a string', 'FORMAT');
    }
    for (const key of ['default', 'forced', 'alphaMode', 'commentary']) {
        if (snapshot[key] !== undefined && typeof snapshot[key] !== 'boolean') {
            throw new MediaForgeError(`Matroska ${key} must be a boolean`, 'FORMAT');
        }
    }
    for (const key of ['name', 'title']) {
        if (snapshot[key] !== undefined && typeof snapshot[key] !== 'string')
            throw new MediaForgeError(`Matroska track ${key} must be a string`, 'FORMAT');
    }
    snapshot.language = trackLanguage(snapshot.language);
    if (snapshot.colour !== undefined) {
        if (!snapshot.colour || typeof snapshot.colour !== 'object')
            throw new MediaForgeError('Matroska colour must be an object', 'FORMAT');
        const colour = snapshot.colour;
        snapshot.colour = {
            primaries: colour.primaries,
            transfer: colour.transfer,
            matrix: colour.matrix,
            fullRange: colour.fullRange,
        };
    }
    if (snapshot.codecConfig !== undefined) {
        if (!(snapshot.codecConfig instanceof Uint8Array)) {
            throw new MediaForgeError('Matroska codecConfig must be a Uint8Array', 'FORMAT');
        }
        snapshot.codecConfig = new Uint8Array(snapshot.codecConfig);
    }
    return snapshot;
}
function trackMetadataElements(track) {
    return [
        ...(track.default === undefined ? [] : [ebmlUint(0x88, track.default ? 1 : 0)]),
        ...(track.forced === undefined ? [] : [ebmlUint(0x55aa, track.forced ? 1 : 0)]),
        ...(track.commentary === undefined ? [] : [ebmlUint(0x55af, track.commentary ? 1 : 0)]),
        ...(track.name === undefined ? [] : [ebmlString(0x536e, track.name)]),
    ];
}
function languageElements(value) {
    if (value === undefined)
        return [];
    return [ebmlString(/^[A-Za-z]{3}$/.test(value) ? 0x22b59c : 0x22b59d, value)];
}
function trackUids(tracks) {
    const explicit = new Set();
    for (const { id, matroskaTrackUid: uid } of tracks) {
        if (id !== undefined && (!Number.isSafeInteger(id) || id < 0)) {
            throw new MediaForgeError('Matroska track id must be a non-negative safe integer', 'FORMAT');
        }
        if (uid !== undefined) {
            if (typeof uid !== 'bigint' || uid <= 0n || uid > 0xffffffffffffffffn || explicit.has(uid)) {
                throw new MediaForgeError('Matroska TrackUID must be a unique positive unsigned 64-bit bigint', 'FORMAT');
            }
            explicit.add(uid);
        }
    }
    const reserved = new Set([
        ...explicit,
        ...tracks.filter(track => track.id && !track.matroskaTrackUid).map(track => BigInt(track.id)),
    ]);
    const used = new Set();
    let next = 1n;
    return tracks.map(track => {
        let uid = track.matroskaTrackUid ?? BigInt(track.id ?? 0);
        if (!uid || used.has(uid) || (track.matroskaTrackUid === undefined && explicit.has(uid))) {
            while (used.has(next) || reserved.has(next))
                next++;
            uid = next++;
        }
        used.add(uid);
        return uid;
    });
}
function validateCodecConfig(codec, config, allowMissing) {
    if (isProResCodec(codec) && config !== undefined && readProResFourCC(config) !== codec) {
        throw new MediaForgeError('Matroska ProRes CodecPrivate must contain its matching four-byte FourCC', 'FORMAT');
    }
    const required = codec.startsWith('avc')
        ? 'H.264 requires an avcC codec config'
        : codec.startsWith('hvc1') || codec.startsWith('hev1')
            ? 'H.265 requires an hvcC codec config'
            : codec.startsWith('mp4a')
                ? 'AAC requires an AudioSpecificConfig'
                : undefined;
    if (required && ((!config && !allowMissing) || config?.length === 0)) {
        throw new MediaForgeError(`MKV ${required}`, 'FORMAT');
    }
}
export function validateMatroskaCodecConfigs(cfg) {
    for (const track of [cfg.video, cfg.audio, ...(cfg.extraAudioTracks ?? []), ...(cfg.extraVideoTracks ?? [])]) {
        if (track)
            validateCodecConfig(track.codec, track.codecConfig, false);
    }
}
function concat(...parts) {
    let total = 0;
    for (const part of parts)
        total += part.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}
function ebmlIdBytes(id) {
    if (id > 0xffffff)
        return 4;
    if (id > 0xffff)
        return 3;
    if (id > 0xff)
        return 2;
    return 1;
}
function writeEbmlId(out, pos, id) {
    if (id > 0xffffff) {
        out[pos++] = (id >>> 24) & 0xff;
        out[pos++] = (id >>> 16) & 0xff;
        out[pos++] = (id >>> 8) & 0xff;
        out[pos++] = id & 0xff;
        return pos;
    }
    if (id > 0xffff) {
        out[pos++] = (id >>> 16) & 0xff;
        out[pos++] = (id >>> 8) & 0xff;
        out[pos++] = id & 0xff;
        return pos;
    }
    if (id > 0xff) {
        out[pos++] = (id >>> 8) & 0xff;
        out[pos++] = id & 0xff;
        return pos;
    }
    out[pos++] = id & 0xff;
    return pos;
}
function unsignedBytes(value) {
    let v = BigInt(Math.max(0, Math.floor(value)));
    let bytes = 1;
    while (v > 0xffn && bytes < 8) {
        v >>= 8n;
        bytes++;
    }
    return bytes;
}
function writeUnsigned(out, pos, value, bytes) {
    let v = BigInt(Math.max(0, Math.floor(value)));
    for (let i = bytes - 1; i >= 0; i--) {
        out[pos + i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return pos + bytes;
}
function ebmlSizeBytes(size) {
    const value = BigInt(Math.max(0, Math.floor(size)));
    for (let bytes = 1; bytes <= 8; bytes++) {
        const maxValue = (1n << BigInt(bytes * 7)) - 2n;
        if (value <= maxValue)
            return bytes;
    }
    throw new Error(`EBML size too large: ${size}`);
}
function writeEbmlSize(out, pos, size) {
    const bytes = ebmlSizeBytes(size);
    let value = BigInt(Math.max(0, Math.floor(size))) | (1n << BigInt(bytes * 7));
    for (let i = bytes - 1; i >= 0; i--) {
        out[pos + i] = Number(value & 0xffn);
        value >>= 8n;
    }
    return pos + bytes;
}
function ebmlSizedHeader(id, size) {
    const idBytes = [];
    let v = id;
    while (v > 0) {
        idBytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
    }
    const sizeBytes = [];
    let sz = size;
    for (let len = 1; len <= 8; len++) {
        const max = 2 ** (7 * len) - 2;
        if (size <= max) {
            for (let i = len - 1; i >= 0; i--)
                sizeBytes.push(Math.floor(sz / 256 ** i) & 0xff);
            sizeBytes[0] = (sizeBytes[0] | (0x80 >> (len - 1))) & 0xff;
            break;
        }
    }
    return Uint8Array.from([...idBytes, ...sizeBytes]);
}
function ebmlElement(id, payload) {
    const out = new Uint8Array(ebmlIdBytes(id) + ebmlSizeBytes(payload.length) + payload.length);
    let pos = writeEbmlId(out, 0, id);
    pos = writeEbmlSize(out, pos, payload.length);
    out.set(payload, pos);
    return out;
}
function ebmlSint(id, value) {
    const rounded = Math.round(value);
    if (!Number.isSafeInteger(rounded)) {
        throw new MediaForgeError(`EBML signed integer 0x${id.toString(16)} is not safe (${value})`, 'MUX');
    }
    const signed = BigInt(rounded);
    let bytes = 1;
    for (; bytes < 8; bytes++) {
        const bits = BigInt(bytes * 8 - 1);
        const min = -(1n << bits);
        const max = (1n << bits) - 1n;
        if (signed >= min && signed <= max)
            break;
    }
    const bits = BigInt(bytes * 8);
    let encoded = signed < 0 ? (1n << bits) + signed : signed;
    const payload = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--) {
        payload[i] = Number(encoded & 0xffn);
        encoded >>= 8n;
    }
    return ebmlElement(id, payload);
}
function ebmlUint(id, value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new MediaForgeError(`EBML uint element 0x${id.toString(16)} requires a non-negative safe integer (${value})`, 'MUX');
    }
    const bytes = unsignedBytes(value);
    const payload = new Uint8Array(bytes);
    writeUnsigned(payload, 0, value, bytes);
    return ebmlElement(id, payload);
}
function ebmlUid(value) {
    let width = 1;
    while (value >= 1n << BigInt(width * 8))
        width++;
    const bytes = new Uint8Array(width);
    for (let pos = width - 1; pos >= 0; pos--) {
        bytes[pos] = Number(value & 255n);
        value >>= 8n;
    }
    return ebmlElement(0x73c5, bytes);
}
function ebmlFloat(id, value) {
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setFloat64(0, value, false);
    return ebmlElement(id, payload);
}
function ebmlString(id, value) {
    return ebmlElement(id, textEncoder.encode(value));
}
function ebmlBinary(id, payload) {
    return ebmlElement(id, payload);
}
function ebmlUintFixed8(id, value) {
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setBigUint64(0, BigInt(value), false);
    return ebmlElement(id, payload);
}
function buildSeekHeadForCues(cuesPosFromSegmentStart) {
    return ebmlElement(0x114d9b74, ebmlElement(0x4dbb, concat(ebmlBinary(0x53ab, Uint8Array.from([0x1c, 0x53, 0xbb, 0x6b])), ebmlUintFixed8(0x53ac, cuesPosFromSegmentStart))));
}
function buildCues(startTimesTicks, clusterOffsets, cueTracks) {
    const points = [];
    for (let i = 0; i < startTimesTicks.length; i++) {
        points.push(ebmlElement(0xbb, concat(ebmlUint(0xb3, Math.max(0, startTimesTicks[i])), ebmlElement(0xb7, concat(ebmlUint(0xf7, cueTracks[i]), ebmlUint(0xf1, clusterOffsets[i]))))));
    }
    return ebmlElement(0x1c53bb6b, concat(...points));
}
function findDurationPayloadOffset(segmentInfo) {
    for (let i = 0; i + 11 <= segmentInfo.length; i++) {
        if (segmentInfo[i] === 0x44 && segmentInfo[i + 1] === 0x89 && segmentInfo[i + 2] === 0x88) {
            return i + 3;
        }
    }
    return -1;
}
function buildOpusHead(channels, inputSampleRate, preSkip) {
    const head = new Uint8Array(19);
    head.set(textEncoder.encode('OpusHead'), 0);
    head[8] = 1;
    head[9] = channels & 0xff;
    new DataView(head.buffer).setUint16(10, preSkip & 0xffff, true);
    new DataView(head.buffer).setUint32(12, inputSampleRate >>> 0, true);
    new DataView(head.buffer).setInt16(16, 0, true);
    head[18] = 0;
    return head;
}
function parseOpusHead(config, fallbackChannels, fallbackRate) {
    if (config && config.length >= 19) {
        const magic = String.fromCharCode(...config.subarray(0, 8));
        if (magic === 'OpusHead') {
            const view = new DataView(config.buffer, config.byteOffset, config.byteLength);
            return {
                head: new Uint8Array(config),
                channels: Math.max(1, config[9] || fallbackChannels || 2),
                inputSampleRate: view.getUint32(12, true) || fallbackRate || 48000,
                preSkip: view.getUint16(10, true),
            };
        }
    }
    if (config && config.length >= 11 && config[0] === 0) {
        const view = new DataView(config.buffer, config.byteOffset, config.byteLength);
        const channels = Math.max(1, config[1] || fallbackChannels || 2);
        const family = config[10];
        const extensionLength = family === 0 ? 0 : 2 + channels;
        if (config.length >= 11 + extensionLength) {
            const preSkip = view.getUint16(2, false);
            const inputSampleRate = view.getUint32(4, false) || fallbackRate || 48000;
            const head = buildOpusHead(channels, inputSampleRate, preSkip);
            const expanded = extensionLength > 0 ? new Uint8Array(head.length + extensionLength) : head;
            if (expanded !== head)
                expanded.set(head);
            new DataView(expanded.buffer).setInt16(16, view.getInt16(8, false), true);
            expanded[18] = family;
            if (extensionLength > 0)
                expanded.set(config.subarray(11, 11 + extensionLength), 19);
            return { head: expanded, channels, inputSampleRate, preSkip };
        }
    }
    return {
        head: buildOpusHead(Math.max(1, fallbackChannels || 2), Math.max(1, fallbackRate || 48000), 312),
        channels: Math.max(1, fallbackChannels || 2),
        inputSampleRate: Math.max(1, fallbackRate || 48000),
        preSkip: 312,
    };
}
function hasAudioPresentationWindow(track) {
    return (track.primingSamples !== undefined ||
        track.validSamples !== undefined ||
        track.presentationTimestamps !== undefined ||
        track.discardLeadingSamples !== undefined ||
        track.codecDelaySamples !== undefined);
}
function validateAudioPresentationWindow(track, label) {
    if (track.primingSamples !== undefined &&
        (!Number.isSafeInteger(track.primingSamples) || track.primingSamples < 0)) {
        throw new MediaForgeError(`${label} has invalid primingSamples`, 'MUX');
    }
    if (track.validSamples !== undefined && (!Number.isSafeInteger(track.validSamples) || track.validSamples < 1)) {
        throw new MediaForgeError(`${label} has invalid validSamples`, 'MUX');
    }
    if (track.codecDelaySamples !== undefined &&
        (!Number.isSafeInteger(track.codecDelaySamples) || track.codecDelaySamples < 0)) {
        throw new MediaForgeError(`${label} has invalid codecDelaySamples`, 'MUX');
    }
    if (track.presentationTimestamps !== undefined && typeof track.presentationTimestamps !== 'boolean') {
        throw new MediaForgeError(`${label} has invalid presentationTimestamps`, 'MUX');
    }
    if (track.discardLeadingSamples !== undefined && typeof track.discardLeadingSamples !== 'boolean') {
        throw new MediaForgeError(`${label} has invalid discardLeadingSamples`, 'MUX');
    }
    const priming = track.primingSamples ?? 0;
    if (track.validSamples !== undefined && !Number.isSafeInteger(priming + track.validSamples)) {
        throw new MediaForgeError(`${label} presentation window exceeds the safe integer range`, 'MUX');
    }
}
function configuredCodecDelaySamples(track, primingSamples, codecConfig = track.codecConfig) {
    if (track.codec.startsWith('opus')) {
        const preSkip = parseOpusHead(codecConfig, track.channelCount || 2, track.sampleRate || 48000).preSkip;
        if (track.codecDelaySamples !== undefined && track.codecDelaySamples !== preSkip) {
            throw new MediaForgeError(`Opus codecDelaySamples ${track.codecDelaySamples} must equal OpusHead pre-skip ${preSkip}`, 'MUX');
        }
        return preSkip;
    }
    if (track.codecDelaySamples !== undefined)
        return track.codecDelaySamples;
    return track.codec.startsWith('mp4a') ? primingSamples : 0;
}
function validateChunkTiming(chunk) {
    const duration = chunk.duration ?? 0;
    const decodeTimestamp = chunk.decodeTimestamp ?? chunk.timestamp;
    if (!Number.isFinite(chunk.timestamp) ||
        !Number.isFinite(decodeTimestamp) ||
        !Number.isFinite(duration) ||
        duration < 0 ||
        !Number.isSafeInteger(Math.round(chunk.timestamp * 1000)) ||
        !Number.isSafeInteger(Math.round(decodeTimestamp * 1000)) ||
        !Number.isSafeInteger(Math.round(duration * 1000)) ||
        !Number.isSafeInteger(Math.round((chunk.timestamp + duration) * 1000))) {
        throw new MediaForgeError('Matroska chunk timing is outside the supported millisecond range', 'MUX');
    }
}
function snapshotChunk(chunk) {
    return {
        ...chunk,
        data: new Uint8Array(chunk.data),
        alphaData: chunk.alphaData ? new Uint8Array(chunk.alphaData) : undefined,
    };
}
export class WebMMuxer {
    trackUids;
    trackNumbers;
    subtitleNumbers = new Set();
    extraAudioIndices = new Map();
    titledTracks;
    pcmFormats = new Map();
    timeUnitsPerSecond;
    display;
    extraVideoDisplays = [];
    validAudioSamples = null;
    audioPrimingSamples = 0;
    audioCodecDelaySamples = 0;
    audioPrimingConfigured = false;
    audioPrimingPresentationTimestamps = false;
    audioLeadingDiscardEnabled = true;
    audioTimelineShiftSeconds = null;
    audioCodecDelayExplicit = false;
    setValidSamples(samples) {
        if (!Number.isSafeInteger(samples) || samples < 0) {
            throw new MediaForgeError('Matroska valid sample count must be a non-negative safe integer', 'MUX');
        }
        this.validAudioSamples = samples;
    }
    setAudioPriming(primingSamples, validSamples, presentationTimestamps = false, discardLeadingSamples = true, codecDelaySamples) {
        const delayTrack = this.cfg.audio && codecDelaySamples !== undefined
            ? { ...this.cfg.audio, codecDelaySamples }
            : this.cfg.audio;
        const resolvedCodecDelay = delayTrack
            ? configuredCodecDelaySamples(delayTrack, primingSamples, this.audioConfig)
            : 0;
        if (!Number.isSafeInteger(primingSamples) ||
            primingSamples < 0 ||
            !Number.isSafeInteger(validSamples) ||
            validSamples < 1 ||
            !Number.isSafeInteger(primingSamples + validSamples) ||
            !Number.isSafeInteger(resolvedCodecDelay) ||
            resolvedCodecDelay < 0 ||
            typeof presentationTimestamps !== 'boolean' ||
            typeof discardLeadingSamples !== 'boolean') {
            throw new MediaForgeError('Matroska priming/valid sample window is invalid', 'MUX');
        }
        const priming = primingSamples;
        const valid = validSamples;
        const codecDelay = resolvedCodecDelay;
        if (this.audioPrimingConfigured) {
            if (this.audioPrimingSamples === priming &&
                this.audioCodecDelaySamples === codecDelay &&
                this.validAudioSamples === valid &&
                this.audioPrimingPresentationTimestamps === presentationTimestamps &&
                this.audioLeadingDiscardEnabled === discardLeadingSamples)
                return;
            throw new MediaForgeError('Matroska audio window was configured more than once with different values', 'MUX');
        }
        if (this.sawAudioChunk || this.streamingHeaderWritten) {
            throw new MediaForgeError('Matroska audio window must be configured before the first audio chunk', 'MUX');
        }
        this.audioPrimingConfigured = true;
        this.audioPrimingSamples = priming;
        this.audioCodecDelaySamples = codecDelay;
        this.audioCodecDelayExplicit = codecDelaySamples !== undefined;
        this.validAudioSamples = valid;
        this.audioPrimingPresentationTimestamps = presentationTimestamps;
        this.audioLeadingDiscardEnabled = discardLeadingSamples;
    }
    finalizedFlag = false;
    sawVideoChunk = false;
    sawAudioChunk = false;
    sink;
    cfg;
    packets = [];
    videoConfig;
    audioConfig;
    extraAudioConfigs = [];
    extraVideoConfigs = [];
    seenExtraVideo = new Set();
    seenExtraAudio = new Set();
    extraEncodedAudioSamples = [];
    extraLeadingDiscardWritten = new Set();
    extraAudioTimelineShiftSeconds = [];
    passThrough = {};
    subtitlePackets = [];
    streamingHeaderWritten = false;
    pendingPackets = [];
    pendingStartTicks = 0;
    streamEncodedAudioSamples = 0;
    audioPacketCount = 0;
    leadingAudioDiscardWritten = false;
    lastBlockTimestamps = new Map();
    constructor(cfg, sink) {
        const { video: inputVideo, audio: inputAudio, subtitleTracks, extraAudioTracks, videoColour, videoLanguage, audioLanguage, format, mode, extraVideoTracks, ...rest } = cfg;
        const video = inputVideo ? snapshotTrackConfig(inputVideo) : undefined;
        const audio = inputAudio ? snapshotTrackConfig(inputAudio) : undefined;
        cfg = {
            ...rest,
            format,
            mode,
            video,
            audio,
            extraVideoTracks: extraVideoTracks?.map(snapshotTrackConfig),
            videoLanguage: trackLanguage(videoLanguage ?? video?.language),
            audioLanguage: trackLanguage(audioLanguage ?? audio?.language),
            videoColour: videoColour
                ? {
                    primaries: videoColour.primaries,
                    transfer: videoColour.transfer,
                    matrix: videoColour.matrix,
                    fullRange: videoColour.fullRange,
                }
                : undefined,
            extraAudioTracks: extraAudioTracks?.map(snapshotTrackConfig),
            subtitleTracks: subtitleTracks?.map(snapshotTrackConfig),
        };
        if (cfg.format !== 'mkv' && cfg.format !== 'webm') {
            throw new MediaForgeError('Matroska output format must be mkv or webm', 'FORMAT');
        }
        if (cfg.mode !== 'standard' && cfg.mode !== 'fragmented') {
            throw new MediaForgeError('Matroska mode must be standard or fragmented', 'FORMAT');
        }
        this.display = video ? normalizeMatroskaDisplay(video) : undefined;
        for (const track of [video, ...(cfg.extraVideoTracks ?? [])]) {
            if (!track)
                continue;
            if (isProResCodec(track.codec) && cfg.format !== 'mkv')
                throw new MediaForgeError('WebM cannot carry ProRes; use Matroska output', 'FORMAT');
            if (!Number.isFinite(track.framerate) || track.framerate < 0) {
                throw new MediaForgeError('Matroska framerate must be finite and non-negative', 'FORMAT');
            }
            if (track.rotation !== undefined && !Number.isFinite(track.rotation)) {
                throw new MediaForgeError('Matroska rotation must be finite', 'FORMAT');
            }
            if (track.alphaMode && !/^(?:vp8|vp9|vp09)(?:\.|$)/.test(track.codec)) {
                throw new MediaForgeError('Matroska alpha requires VP8/VP9 video', 'FORMAT');
            }
        }
        if (cfg.videoColour && typeof cfg.videoColour.fullRange !== 'boolean') {
            throw new MediaForgeError('Matroska colour fullRange must be a boolean', 'FORMAT');
        }
        for (const track of [audio, ...(cfg.extraAudioTracks ?? [])]) {
            if (!track)
                continue;
            if (!Number.isFinite(track.sampleRate) ||
                track.sampleRate <= 0 ||
                !Number.isSafeInteger(track.channelCount) ||
                track.channelCount <= 0) {
                throw new MediaForgeError('Matroska audio sampleRate must be positive and finite, and channelCount a positive safe integer', 'FORMAT');
            }
            validateAudioPresentationWindow(track, 'Matroska audio track');
        }
        this.cfg = cfg;
        this.sink = sink;
        const tracks = [
            ...(this.cfg.video ? [this.cfg.video] : []),
            ...(this.cfg.audio ? [this.cfg.audio] : []),
            ...(this.cfg.subtitleTracks ?? []),
            ...(this.cfg.extraAudioTracks ?? []),
            ...(this.cfg.extraVideoTracks ?? []),
        ];
        this.trackUids = trackUids(tracks);
        this.titledTracks = tracks.map((track, index) => ({
            matroskaTrackUid: this.trackUids[index],
            title: track.title,
        }));
        this.passThrough.tags = mergeMatroskaTrackTitles(undefined, this.titledTracks);
        const reserved = new Set(tracks.filter(track => track.id).map(track => track.id));
        const used = new Set();
        let next = 1;
        this.trackNumbers = tracks.map(track => {
            let number = track.id ?? 0;
            if (!number || used.has(number)) {
                while (reserved.has(next) || used.has(next))
                    next++;
                number = next++;
            }
            used.add(number);
            return number;
        });
        cfg.subtitleTracks?.forEach((_, index) => this.subtitleNumbers.add(this.subtitleTrackNumber(index)));
        cfg.extraAudioTracks?.forEach((_, index) => this.extraAudioIndices.set(this.extraAudioTrackNumber(index), index));
        for (const [index, track] of [cfg.audio, ...(cfg.extraAudioTracks ?? [])].entries()) {
            if (!track)
                continue;
            const pcm = describeMatroskaPcm(track);
            if (pcm) {
                if (cfg.format !== 'mkv')
                    throw new MediaForgeError('PCM requires Matroska output', 'FORMAT');
                this.pcmFormats.set(index === 0 ? this.primaryAudioTrackNumber() : this.extraAudioTrackNumber(index - 1), pcm);
            }
        }
        this.timeUnitsPerSecond = this.pcmFormats.size ? 1_000_000 : 1000;
        if (cfg.title !== undefined) {
            if (typeof cfg.title !== 'string')
                throw new MediaForgeError('Matroska title must be a string', 'FORMAT');
            this.passThrough.title = cfg.title;
        }
        if (cfg.video?.codecConfig)
            this.videoConfig = new Uint8Array(cfg.video.codecConfig);
        if (cfg.audio?.codecConfig)
            this.audioConfig = new Uint8Array(cfg.audio.codecConfig);
        if (cfg.audio?.codec.startsWith('opus')) {
            this.audioCodecDelaySamples = configuredCodecDelaySamples(cfg.audio, cfg.audio.primingSamples ?? 0, this.audioConfig);
            this.audioCodecDelayExplicit = cfg.audio.codecDelaySamples !== undefined;
        }
        if (cfg.audio && hasAudioPresentationWindow(cfg.audio)) {
            const priming = cfg.audio.primingSamples ?? 0;
            this.audioPrimingSamples = priming;
            this.audioCodecDelaySamples = configuredCodecDelaySamples(cfg.audio, priming, this.audioConfig);
            this.audioCodecDelayExplicit = cfg.audio.codecDelaySamples !== undefined;
            this.validAudioSamples = cfg.audio.validSamples ?? null;
            this.audioPrimingPresentationTimestamps = cfg.audio.presentationTimestamps === true;
            this.audioLeadingDiscardEnabled = cfg.audio.discardLeadingSamples !== false;
            this.audioPrimingConfigured = true;
        }
        for (const track of cfg.extraAudioTracks ?? []) {
            const config = track.codecConfig ? new Uint8Array(track.codecConfig) : undefined;
            if (track.codec.startsWith('opus')) {
                configuredCodecDelaySamples(track, track.primingSamples ?? 0, config);
            }
            this.extraAudioConfigs.push(config);
            this.extraAudioTimelineShiftSeconds.push(null);
            this.extraEncodedAudioSamples.push(0);
        }
        for (const track of cfg.extraVideoTracks ?? []) {
            this.extraVideoConfigs.push(track.codecConfig);
            this.extraVideoDisplays.push(normalizeMatroskaDisplay(track));
        }
        try {
            this.buildTracks(true);
        }
        catch (error) {
            if (error instanceof MediaForgeError && error.code === 'MUX') {
                throw new MediaForgeError(error.message, 'FORMAT');
            }
            throw error;
        }
    }
    setMatroskaPassThrough(pass) {
        if (this.streamingHeaderWritten || this.finalizedFlag) {
            throw new MediaForgeError('Matroska metadata must be configured before writing the header', 'MUX');
        }
        const { chapters, attachments, title, tags } = pass;
        if (title !== undefined && typeof title !== 'string') {
            throw new MediaForgeError('Matroska title must be a string', 'FORMAT');
        }
        for (const bytes of [chapters, attachments, tags]) {
            if (bytes !== undefined && !(bytes instanceof Uint8Array)) {
                throw new MediaForgeError('Matroska metadata elements must be Uint8Array values', 'FORMAT');
            }
        }
        if (this.cfg.format === 'webm' && (chapters !== undefined || attachments !== undefined)) {
            throw new MediaForgeError('Matroska chapters and attachments require mkv output', 'FORMAT');
        }
        const filtered = filterMatroskaTags({ chapters, attachments, tags }, this.cfg.format, this.trackUids.map(matroskaTrackUid => ({ matroskaTrackUid })));
        this.passThrough = {
            chapters: chapters ? new Uint8Array(chapters) : undefined,
            attachments: attachments ? new Uint8Array(attachments) : undefined,
            title: title ?? this.cfg.title,
            tags: mergeMatroskaTrackTitles(filtered.tags, this.titledTracks),
        };
    }
    setAudioCodecConfig(codecConfig) {
        if (this.streamingHeaderWritten || this.sawAudioChunk) {
            throw new MediaForgeError('audio codec configuration must be set before the first MKV/WebM audio chunk', 'MUX');
        }
        const next = new Uint8Array(codecConfig);
        if (this.cfg.audio)
            describeMatroskaPcm({ ...this.cfg.audio, codecConfig: next });
        if (this.cfg.audio?.codec.startsWith('opus')) {
            const preSkip = parseOpusHead(next, this.cfg.audio.channelCount || 2, this.cfg.audio.sampleRate || 48000).preSkip;
            if (this.audioCodecDelayExplicit && this.audioCodecDelaySamples !== preSkip) {
                throw new MediaForgeError(`Opus codecDelaySamples ${this.audioCodecDelaySamples} must equal OpusHead pre-skip ${preSkip}`, 'MUX');
            }
            this.audioCodecDelaySamples = preSkip;
        }
        this.audioConfig = next;
    }
    addSubtitleChunk(chunk, trackIndex = 0) {
        if (this.finalizedFlag)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        const subs = this.cfg.subtitleTracks ?? [];
        if (subs.length === 0)
            throw new MediaForgeError('addSubtitleChunk on a muxer configured without subtitle tracks', 'MUX');
        if (this.cfg.format !== 'mkv' && this.cfg.format !== 'webm') {
            throw new MediaForgeError('Subtitle tracks are written for mkv/webm output only', 'FORMAT');
        }
        if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= subs.length) {
            throw new MediaForgeError(`subtitle track ${trackIndex} is not configured`, 'MUX');
        }
        validateChunkTiming(chunk);
        this.subtitlePackets.push({ chunk: snapshotChunk(chunk), trackNum: this.subtitleTrackNumber(trackIndex) });
    }
    primaryAudioTrackNumber() {
        return this.trackNumbers[this.cfg.video ? 1 : 0];
    }
    isPrimaryAudio(packet) {
        return (this.cfg.audio !== undefined &&
            packet.chunk.trackType === 'audio' &&
            packet.trackNum === this.primaryAudioTrackNumber());
    }
    extraAudioTrackNumber(index) {
        return this.trackNumbers[(this.cfg.video ? 1 : 0) + (this.cfg.audio ? 1 : 0) + (this.cfg.subtitleTracks?.length ?? 0) + index];
    }
    subtitleTrackNumber(index) {
        return this.trackNumbers[(this.cfg.video ? 1 : 0) + (this.cfg.audio ? 1 : 0) + index];
    }
    extraVideoTrackNumber(index) {
        return this.trackNumbers[(this.cfg.video ? 1 : 0) +
            (this.cfg.audio ? 1 : 0) +
            (this.cfg.subtitleTracks?.length ?? 0) +
            (this.cfg.extraAudioTracks?.length ?? 0) +
            index];
    }
    get streaming() {
        return this.cfg.mode === 'fragmented';
    }
    addVideoChunk(chunk, codecConfig) {
        this.addVideoPacket(-1, chunk, codecConfig);
    }
    addExtraVideoChunk(index, chunk, codecConfig) {
        if (!Number.isInteger(index) || index < 0 || index >= (this.cfg.extraVideoTracks?.length ?? 0))
            throw new MediaForgeError(`addExtraVideoChunk index ${index} has no configured track`, 'MUX');
        this.addVideoPacket(index, chunk, codecConfig);
    }
    addVideoPacket(index, chunk, codecConfig) {
        const video = index < 0 ? this.cfg.video : this.cfg.extraVideoTracks?.[index];
        let config = index < 0 ? this.videoConfig : this.extraVideoConfigs[index];
        if (chunk.trackType === undefined) {
            throw new MediaForgeError(`${'addVideoChunk'} requires chunk.trackType (got a chunk without one)`, 'MUX');
        }
        if (chunk.trackType !== 'video') {
            throw new MediaForgeError(`addVideoChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        if (this.finalizedFlag)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (!video)
            throw new MediaForgeError('addVideoChunk on a muxer configured without video', 'MUX');
        validateChunkTiming(chunk);
        if (chunk.alphaData !== undefined &&
            (!video.alphaMode || !(chunk.alphaData instanceof Uint8Array) || chunk.alphaData.length === 0)) {
            throw new MediaForgeError('Alpha packet requires non-empty bytes and a video track with alphaMode', 'MUX');
        }
        const codec = video.codec;
        if (isProResCodec(codec)) {
            const error = proResFrameError(chunk.data, video);
            if (error)
                throw new MediaForgeError(error, 'MUX');
            if (codecConfig)
                validateCodecConfig(codec, codecConfig, false);
            chunk = { ...chunk, data: chunk.data.subarray(8) };
        }
        if ((codec.startsWith('vp8') || codec.startsWith('vp09') || codec.startsWith('vp9')) &&
            chunk.data.length >= 5) {
            const d = chunk.data;
            const annexB = d[0] === 0 && d[1] === 0 && (d[2] === 1 || (d[2] === 0 && d[3] === 1));
            const avccLen = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
            const looksAvcc = avccLen > 0 && avccLen === d.length - 4 && (d[4] & 0x1f) >= 1 && (d[4] & 0x1f) <= 23;
            if (annexB || looksAvcc) {
                throw new MediaForgeError(`Video payload looks like H.264 but the track is declared '${codec}'`, 'MUX');
            }
        }
        if (codecConfig && !config)
            config = new Uint8Array(codecConfig);
        const hevc = codec.startsWith('hev1') || codec.startsWith('hvc1');
        if (hevc || codec.startsWith('avc')) {
            const configByte = config?.[hevc ? 21 : 4];
            const width = (configByte === undefined ? 4 : (configByte & 3) + 1);
            const validWalk = hevc ? isValidHevcWalk : isValidAvccWalk;
            if (!validWalk(chunk.data, width) && isAnnexB(chunk.data)) {
                if (!config)
                    config = (hevc ? buildHevcCFromAnnexB : buildAvcCFromAnnexB)(chunk.data) ?? undefined;
                chunk = { ...chunk, data: annexBToAvcc(chunk.data, width) };
            }
        }
        if (index < 0) {
            this.sawVideoChunk = true;
            this.videoConfig = config;
        }
        else {
            this.seenExtraVideo.add(index);
            this.extraVideoConfigs[index] = config;
        }
        this.intake({ chunk, trackNum: index < 0 ? this.trackNumbers[0] : this.extraVideoTrackNumber(index) });
    }
    addExtraAudioChunk(index, chunk, codecCfg) {
        if (chunk.trackType === undefined) {
            throw new MediaForgeError('addExtraAudioChunk requires chunk.trackType (got a chunk without one)', 'MUX');
        }
        if (chunk.trackType !== 'audio') {
            throw new MediaForgeError(`addExtraAudioChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        if (this.finalizedFlag)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        const extras = this.cfg.extraAudioTracks ?? [];
        if (!Number.isInteger(index) || index < 0 || index >= extras.length) {
            throw new MediaForgeError(`addExtraAudioChunk index ${index} has no configured track`, 'MUX');
        }
        validateChunkTiming(chunk);
        this.validatePcmChunk(chunk, this.extraAudioTrackNumber(index));
        if (codecCfg && !this.extraAudioConfigs[index]) {
            const next = new Uint8Array(codecCfg);
            const track = extras[index];
            describeMatroskaPcm({ ...track, codecConfig: next });
            if (track.codec.startsWith('opus')) {
                configuredCodecDelaySamples(track, track.primingSamples ?? 0, next);
            }
            this.extraAudioConfigs[index] = next;
        }
        if (this.extraAudioTimelineShiftSeconds[index] === null) {
            const track = extras[index];
            const rate = this.audioTimingRateFor(track);
            const tolerance = 0.5 / rate;
            const priming = this.extraAudioPrimingSamples(index);
            const codecDelay = this.extraAudioCodecDelaySamples(index);
            const shiftSamples = track.codec.startsWith('opus')
                ? track.presentationTimestamps
                    ? Math.max(priming, codecDelay)
                    : codecDelay
                : track.presentationTimestamps
                    ? Math.max(priming, codecDelay)
                    : codecDelay > 0
                        ? codecDelay
                        : chunk.timestamp < -tolerance
                            ? priming
                            : 0;
            this.extraAudioTimelineShiftSeconds[index] = shiftSamples / rate;
        }
        this.seenExtraAudio.add(index);
        this.intake({ chunk, trackNum: this.extraAudioTrackNumber(index) });
    }
    addAudioChunk(chunk, codecConfig) {
        if (chunk.trackType === undefined) {
            throw new MediaForgeError(`${'addAudioChunk'} requires chunk.trackType (got a chunk without one)`, 'MUX');
        }
        if (chunk.trackType !== 'audio') {
            throw new MediaForgeError(`addAudioChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        if (this.finalizedFlag)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (!this.cfg.audio)
            throw new MediaForgeError('addAudioChunk on a muxer configured without audio', 'MUX');
        validateChunkTiming(chunk);
        this.validatePcmChunk(chunk, this.primaryAudioTrackNumber());
        const aCodec = this.cfg.audio.codec;
        if (aCodec.startsWith('opus') && chunk.data.length >= 2) {
            const d = chunk.data;
            const looksAdts = d[0] === 0xff && (d[1] & 0xf0) === 0xf0;
            const looksLoas = d[0] === 0x56 && (d[1] & 0xe0) === 0xe0;
            if (looksAdts || looksLoas) {
                throw new MediaForgeError(`Audio payload looks like AAC (${looksAdts ? 'ADTS' : 'LOAS'}) but the track is declared '${aCodec}'`, 'MUX');
            }
        }
        if (codecConfig && !this.audioConfig)
            this.setAudioCodecConfig(codecConfig);
        this.sawAudioChunk = true;
        if (this.audioTimelineShiftSeconds === null) {
            const tolerance = 0.5 / this.audioTimingRate();
            const shiftSamples = this.cfg.audio.codec.startsWith('opus')
                ? this.audioPrimingPresentationTimestamps
                    ? Math.max(this.audioPrimingSamples, this.audioCodecDelaySamples)
                    : this.audioCodecDelaySamples
                : this.audioPrimingPresentationTimestamps
                    ? Math.max(this.audioPrimingSamples, this.audioCodecDelaySamples)
                    : this.audioCodecDelaySamples > 0
                        ? this.audioCodecDelaySamples
                        : chunk.timestamp < -tolerance
                            ? this.audioPrimingSamples
                            : 0;
            this.audioTimelineShiftSeconds = shiftSamples / this.audioTimingRate();
        }
        this.intake({ chunk, trackNum: this.primaryAudioTrackNumber() });
    }
    validatePcmChunk(chunk, trackNum) {
        const pcm = this.pcmFormats.get(trackNum);
        if (!pcm)
            return;
        if (chunk.data.length === 0 || chunk.data.length % pcm.blockAlign !== 0)
            throw new MediaForgeError('Matroska PCM chunks must contain complete channel frames', 'MUX');
        if (Math.abs(chunk.duration * pcm.sampleRate - chunk.data.length / pcm.blockAlign) > 0.5)
            throw new MediaForgeError('Matroska PCM duration must match its complete channel frames', 'MUX');
    }
    audioTimingRate() {
        return this.audioTimingRateFor(this.cfg.audio);
    }
    audioTimingRateFor(track) {
        if (track?.codec.startsWith('opus'))
            return 48000;
        return Math.max(1, track?.sampleRate || 48000);
    }
    aacSamplesPerAccessUnit() {
        if (!this.cfg.audio?.codec.startsWith('mp4a'))
            return 0;
        return this.aacSamplesPerAccessUnitFor(this.cfg.audio, this.audioConfig);
    }
    aacSamplesPerAccessUnitFor(track, config) {
        if (!track.codec.startsWith('mp4a'))
            return 0;
        return (config ? parseAacAudioSpecificConfig(config)?.samplesPerAccessUnit : undefined) ?? 1024;
    }
    encodedAudioSamples() {
        if (this.cfg.audio?.codec.startsWith('mp4a')) {
            return this.audioPacketCount * this.aacSamplesPerAccessUnit();
        }
        return this.streamEncodedAudioSamples;
    }
    leadingDiscardPaddingNs() {
        if (!this.audioLeadingDiscardEnabled || this.audioPrimingSamples <= 0)
            return 0;
        if (this.cfg.audio?.codec.startsWith('opus')) {
            const preSkip = parseOpusHead(this.audioConfig, this.cfg.audio.channelCount || 2, this.cfg.audio.sampleRate || 48000).preSkip;
            const explicit = Math.max(0, this.audioPrimingSamples - preSkip);
            return -Math.round(explicit * (1_000_000_000 / 48000));
        }
        return -Math.round(this.audioPrimingSamples * (1_000_000_000 / this.audioTimingRate()));
    }
    extraAudioIndex(packet) {
        if (packet.chunk.trackType !== 'audio')
            return null;
        return this.extraAudioIndices.get(packet.trackNum) ?? null;
    }
    audioPacketStats(packets) {
        const result = new Map();
        for (const packet of packets) {
            if (packet.chunk.trackType !== 'audio')
                continue;
            let stats = result.get(packet.trackNum);
            if (!stats) {
                const index = this.extraAudioIndex(packet);
                const rate = index === null
                    ? this.audioTimingRate()
                    : this.audioTimingRateFor(this.cfg.extraAudioTracks[index]);
                stats = { first: packet, last: packet, count: 0, samples: 0, rate };
                result.set(packet.trackNum, stats);
            }
            stats.last = packet;
            stats.count++;
            stats.samples += Math.max(0, Math.round((packet.chunk.duration ?? 0) * stats.rate));
        }
        return result;
    }
    extraAudioPrimingSamples(index) {
        return Math.max(0, Math.round(this.cfg.extraAudioTracks?.[index]?.primingSamples ?? 0));
    }
    extraAudioCodecDelaySamples(index) {
        const track = this.cfg.extraAudioTracks?.[index];
        if (!track)
            return 0;
        return Math.max(0, Math.round(configuredCodecDelaySamples(track, this.extraAudioPrimingSamples(index), this.extraAudioConfigs[index])));
    }
    packetTimestamp(packet, decode = false) {
        const base = decode ? (packet.chunk.decodeTimestamp ?? packet.chunk.timestamp) : packet.chunk.timestamp;
        if (this.isPrimaryAudio(packet))
            return base + (this.audioTimelineShiftSeconds ?? 0);
        const extraIndex = this.extraAudioIndex(packet);
        if (extraIndex !== null)
            return base + (this.extraAudioTimelineShiftSeconds[extraIndex] ?? 0);
        return base;
    }
    intake(packet) {
        packet = { chunk: snapshotChunk(packet.chunk), trackNum: packet.trackNum };
        if (this.isPrimaryAudio(packet)) {
            this.audioPacketCount++;
            this.streamEncodedAudioSamples += Math.max(0, Math.round((packet.chunk.duration ?? 0) * this.audioTimingRate()));
        }
        const extraAudio = this.extraAudioIndex(packet);
        if (extraAudio !== null) {
            const track = this.cfg.extraAudioTracks[extraAudio];
            this.extraEncodedAudioSamples[extraAudio] += track.codec.startsWith('mp4a')
                ? this.aacSamplesPerAccessUnitFor(track, this.extraAudioConfigs[extraAudio])
                : Math.max(0, Math.round(packet.chunk.duration * this.audioTimingRateFor(track)));
        }
        if (!this.streaming) {
            this.packets.push(packet);
            return;
        }
        this.writeStreamingHeaderOnce();
        const dtsTicks = Math.round(this.packetTimestamp(packet, true) * this.timeUnitsPerSecond);
        if (this.pendingPackets.length === 0)
            this.pendingStartTicks = Math.max(0, dtsTicks);
        const canCut = (!this.cfg.video && !this.cfg.extraVideoTracks?.length) ||
            (packet.chunk.trackType === 'video' && packet.chunk.isKeyframe === true);
        const overLimit = dtsTicks - this.pendingStartTicks >= 2 * this.timeUnitsPerSecond;
        const wayOver = dtsTicks - this.pendingStartTicks >= 16000;
        if ((overLimit && canCut) || wayOver) {
            this.flushPendingCluster(false);
            this.pendingStartTicks = Math.max(0, dtsTicks);
        }
        this.pendingPackets.push(packet);
    }
    streamBytesWritten = 0;
    streamDurationPatchOffset = -1;
    streamEndSec = 0;
    streamWrite(data) {
        this.sink.write(data);
        this.streamBytesWritten += data.length;
    }
    writeStreamingHeaderOnce() {
        if (this.streamingHeaderWritten)
            return;
        const tracks = this.buildTracks();
        const segInfo = this.buildSegmentInfo(0, typeof this.sink.patchAt === 'function');
        this.streamingHeaderWritten = true;
        const patchable = typeof this.sink.patchAt === 'function';
        this.streamWrite(this.buildEbmlHeader());
        this.streamWrite(Uint8Array.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
        if (patchable) {
            const inSegInfo = findDurationPayloadOffset(segInfo);
            if (inSegInfo >= 0)
                this.streamDurationPatchOffset = this.streamBytesWritten + inSegInfo;
        }
        this.streamWrite(segInfo);
        this.streamWrite(tracks);
        if (this.passThrough.tags)
            this.streamWrite(this.passThrough.tags);
        if (this.passThrough.chapters)
            this.streamWrite(this.passThrough.chapters);
        if (this.passThrough.attachments)
            this.streamWrite(this.passThrough.attachments);
    }
    flushPendingCluster(isFinal) {
        if (this.pendingPackets.length === 0)
            return;
        let flushEnd = this.pendingPackets.length;
        if (!isFinal) {
            const last = new Map();
            this.pendingPackets.forEach((packet, index) => {
                if ((this.isPrimaryAudio(packet) && this.validAudioSamples !== null) ||
                    (this.extraAudioIndex(packet) !== null &&
                        this.cfg.extraAudioTracks[this.extraAudioIndex(packet)].validSamples !== undefined))
                    last.set(packet.trackNum, index);
            });
            for (const index of last.values())
                flushEnd = Math.min(flushEnd, index);
        }
        if (flushEnd === 0)
            return;
        const packets = this.pendingPackets.slice(0, flushEnd);
        const trailingPad = isFinal ? this.finalDiscardPaddingNs() : 0;
        const leadingPad = this.leadingAudioDiscardWritten ? 0 : this.leadingDiscardPaddingNs();
        const audioStats = this.audioPacketStats(packets);
        const primaryAudio = this.cfg.audio ? audioStats.get(this.primaryAudioTrackNumber()) : undefined;
        const firstAudio = primaryAudio?.first;
        const lastAudio = primaryAudio?.last;
        for (const p of packets) {
            const end = this.packetTimestamp(p) + (p.chunk.duration || 0);
            if (end > this.streamEndSec)
                this.streamEndSec = end;
        }
        const discardPadding = new Map();
        if (leadingPad < 0 && firstAudio) {
            this.setPacketDiscardPadding(discardPadding, firstAudio, leadingPad, 'primary audio');
        }
        if (trailingPad > 0 && lastAudio) {
            this.setPacketDiscardPadding(discardPadding, lastAudio, trailingPad, 'primary audio');
        }
        for (let index = 0; index < (this.cfg.extraAudioTracks?.length ?? 0); index++) {
            const selected = audioStats.get(this.extraAudioTrackNumber(index));
            if (!selected)
                continue;
            const leading = this.extraLeadingDiscardWritten.has(index) ? 0 : this.extraLeadingDiscardPaddingNs(index);
            const trailing = isFinal ? this.extraFinalDiscardPaddingNs(index) : 0;
            if (leading < 0)
                this.setPacketDiscardPadding(discardPadding, selected.first, leading, `extra audio track ${index}`);
            if (trailing > 0)
                this.setPacketDiscardPadding(discardPadding, selected.last, trailing, `extra audio track ${index}`);
            if (leading < 0)
                this.extraLeadingDiscardWritten.add(index);
        }
        const { clusters } = this.buildClustersWithTimes(packets, discardPadding);
        for (const cluster of clusters)
            this.streamWrite(cluster);
        if (leadingPad < 0 && firstAudio)
            this.leadingAudioDiscardWritten = true;
        this.pendingPackets = this.pendingPackets.slice(flushEnd);
    }
    extraLeadingDiscardPaddingNs(index) {
        const track = this.cfg.extraAudioTracks[index];
        const priming = this.extraAudioPrimingSamples(index);
        const explicit = track.codec.startsWith('opus')
            ? Math.max(0, priming - this.extraAudioCodecDelaySamples(index))
            : priming;
        return track.discardLeadingSamples === false
            ? 0
            : -Math.round(explicit * (1_000_000_000 / this.audioTimingRateFor(track)));
    }
    extraFinalDiscardPaddingNs(index) {
        const track = this.cfg.extraAudioTracks[index];
        if (track.validSamples === undefined)
            return 0;
        const required = this.extraAudioPrimingSamples(index) + track.validSamples;
        const encoded = this.extraEncodedAudioSamples[index];
        if (encoded + 1 < required)
            throw new MediaForgeError(`Extra audio track ${index} presentation window ${required} exceeds ${encoded} encoded samples`, 'MUX');
        return Math.max(0, Math.round((encoded - required) * (1_000_000_000 / this.audioTimingRateFor(track))));
    }
    finalDiscardPaddingNs() {
        if (this.validAudioSamples === null)
            return 0;
        const rate = this.audioTimingRate();
        const encoded = this.encodedAudioSamples();
        const required = this.audioPrimingSamples + this.validAudioSamples;
        if (encoded + 1 < required) {
            throw new MediaForgeError(`Primary audio presentation window ${required} exceeds ${encoded} encoded samples`, 'MUX');
        }
        return Math.max(0, Math.round((encoded - required) * (1_000_000_000 / rate)));
    }
    setPacketDiscardPadding(target, packet, paddingNs, trackLabel) {
        if (paddingNs === 0)
            return;
        if (paddingNs > 0) {
            const extraIndex = this.extraAudioIndex(packet);
            const track = extraIndex === null ? this.cfg.audio : this.cfg.extraAudioTracks?.[extraIndex];
            const config = extraIndex === null ? this.audioConfig : this.extraAudioConfigs[extraIndex];
            const rate = this.audioTimingRateFor(track);
            const lastPacketSamples = track?.codec.startsWith('mp4a')
                ? this.aacSamplesPerAccessUnitFor(track, config)
                : Math.max(0, Math.round((packet.chunk.duration ?? 0) * rate));
            const paddingSamples = Math.max(0, Math.round((paddingNs * rate) / 1_000_000_000));
            if (paddingSamples > lastPacketSamples) {
                throw new MediaForgeError(`Matroska ${trackLabel} trailing trim ${paddingSamples} samples exceeds the final packet's ${lastPacketSamples} decoded samples; a cross-block tail edit requires re-encoding`, 'MUX');
            }
        }
        if (target.has(packet)) {
            throw new MediaForgeError(`One Matroska ${trackLabel} block cannot carry both leading and trailing padding`, 'MUX');
        }
        target.set(packet, paddingNs);
    }
    buildStandardDiscardPadding(packets) {
        const result = new Map();
        const packetsByTrack = this.audioPacketStats(packets);
        const primary = this.cfg.audio ? packetsByTrack.get(this.primaryAudioTrackNumber()) : undefined;
        if (primary) {
            const leading = this.leadingDiscardPaddingNs();
            const trailing = this.finalDiscardPaddingNs();
            if (leading < 0)
                this.setPacketDiscardPadding(result, primary.first, leading, 'primary audio');
            if (trailing > 0) {
                this.setPacketDiscardPadding(result, primary.last, trailing, 'primary audio');
            }
        }
        const extras = this.cfg.extraAudioTracks ?? [];
        for (let index = 0; index < extras.length; index++) {
            const track = extras[index];
            const trackNum = this.extraAudioTrackNumber(index);
            const trackPackets = packetsByTrack.get(trackNum);
            if (!trackPackets)
                continue;
            const rate = this.audioTimingRateFor(track);
            const priming = this.extraAudioPrimingSamples(index);
            const opusCodecDelay = track.codec.startsWith('opus')
                ? parseOpusHead(this.extraAudioConfigs[index], track.channelCount || 2, track.sampleRate || 48000)
                    .preSkip
                : 0;
            const explicitLeading = track.codec.startsWith('opus') ? Math.max(0, priming - opusCodecDelay) : priming;
            if (track.discardLeadingSamples !== false && explicitLeading > 0) {
                const leading = -Math.round(explicitLeading * (1_000_000_000 / rate));
                this.setPacketDiscardPadding(result, trackPackets.first, leading, `extra audio track ${index}`);
            }
            if (track.validSamples === undefined)
                continue;
            const encoded = track.codec.startsWith('mp4a')
                ? trackPackets.count * this.aacSamplesPerAccessUnitFor(track, this.extraAudioConfigs[index])
                : trackPackets.samples;
            const valid = Math.max(0, Math.round(track.validSamples));
            if (encoded + 1 < priming + valid) {
                throw new MediaForgeError(`Extra audio track ${index} presentation window ${priming + valid} exceeds ${encoded} encoded samples`, 'MUX');
            }
            const trailing = Math.max(0, Math.round((encoded - priming - valid) * (1_000_000_000 / rate)));
            if (trailing > 0) {
                this.setPacketDiscardPadding(result, trackPackets.last, trailing, `extra audio track ${index}`);
            }
        }
        return result;
    }
    async finalize() {
        if (this.finalizedFlag)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        this.finalizedFlag = true;
        try {
            await this.finalizeContainer();
        }
        finally {
            this.packets.length = 0;
            this.pendingPackets.length = 0;
            this.subtitlePackets.length = 0;
        }
    }
    async finalizeContainer() {
        if (this.cfg.video && !this.sawVideoChunk) {
            throw new MediaForgeError('finalize with a declared video track but no video chunks', 'MUX');
        }
        if (this.cfg.audio && !this.sawAudioChunk) {
            throw new MediaForgeError('finalize with a declared audio track but no audio chunks', 'MUX');
        }
        if (this.seenExtraVideo.size !== (this.cfg.extraVideoTracks?.length ?? 0))
            throw new MediaForgeError('finalize with a declared extra video track but no video chunks', 'MUX');
        if (this.seenExtraAudio.size !== (this.cfg.extraAudioTracks?.length ?? 0))
            throw new MediaForgeError('finalize with a declared extra audio track but no audio chunks', 'MUX');
        if (this.streaming) {
            this.writeStreamingHeaderOnce();
            for (const sub of this.sortedSubtitlePackets())
                this.pendingPackets.push(sub);
            const dtsOf = (p) => this.packetTimestamp(p, true);
            this.pendingPackets.sort((a, b) => dtsOf(a) - dtsOf(b) || a.trackNum - b.trackNum);
            this.flushPendingCluster(true);
            if (this.streamDurationPatchOffset >= 0 && this.sink.patchAt) {
                const d = new Uint8Array(8);
                new DataView(d.buffer).setFloat64(0, this.streamEndSec * this.timeUnitsPerSecond, false);
                this.sink.patchAt(this.streamDurationPatchOffset, d);
            }
            await this.sink.close();
            return;
        }
        const dtsOfPacket = (p) => this.packetTimestamp(p, true);
        const orderedPackets = this.packets
            .concat(this.sortedSubtitlePackets())
            .sort((a, b) => dtsOfPacket(a) - dtsOfPacket(b) || a.trackNum - b.trackNum);
        const durationSeconds = orderedPackets.reduce((max, packet) => Math.max(max, this.packetTimestamp(packet) + packet.chunk.duration), 0);
        const preParts = [
            this.buildSegmentInfo(durationSeconds),
            this.buildTracks(),
            ...(this.passThrough.tags ? [this.passThrough.tags] : []),
            ...(this.passThrough.chapters ? [this.passThrough.chapters] : []),
            ...(this.passThrough.attachments ? [this.passThrough.attachments] : []),
        ];
        const { clusters, startTimesTicks, cueTracks } = this.buildClustersWithTimes(orderedPackets);
        const seekHeadLen = buildSeekHeadForCues(0).length;
        const preLen = preParts.reduce((n, x) => n + x.length, 0);
        const clusterOffsets = [];
        let running = seekHeadLen + preLen;
        for (const c of clusters) {
            clusterOffsets.push(running);
            running += c.length;
        }
        const cuesPos = running;
        const cues = buildCues(startTimesTicks, clusterOffsets, cueTracks);
        const total = cuesPos + cues.length;
        this.sink.write(this.buildEbmlHeader());
        this.sink.write(ebmlSizedHeader(0x18538067, total));
        this.sink.write(buildSeekHeadForCues(cuesPos));
        for (const p of preParts)
            this.sink.write(p);
        for (const c of clusters)
            this.sink.write(c);
        this.sink.write(cues);
        await this.sink.close();
    }
    sortedSubtitlePackets() {
        return this.subtitlePackets
            .slice()
            .sort((a, b) => a.chunk.timestamp - b.chunk.timestamp)
            .map(p => ({ chunk: p.chunk, trackNum: p.trackNum }));
    }
    buildEbmlHeader() {
        const docType = this.cfg.format === 'mkv' ? 'matroska' : 'webm';
        return ebmlElement(0x1a45dfa3, concat(ebmlUint(0x4286, 1), ebmlUint(0x42f7, 1), ebmlUint(0x42f2, 4), ebmlUint(0x42f3, 8), ebmlString(0x4282, docType), ebmlUint(0x4287, docType === 'matroska' ? 4 : 2), ebmlUint(0x4285, 2)));
    }
    buildSegmentInfo(durationSeconds, includeDuration = true) {
        return ebmlElement(0x1549a966, concat(ebmlUint(0x2ad7b1, 1_000_000_000 / this.timeUnitsPerSecond), ...(includeDuration ? [ebmlFloat(0x4489, durationSeconds * this.timeUnitsPerSecond)] : []), ebmlString(0x4d80, 'MediaForgeJS'), ebmlString(0x5741, 'MediaForgeJS'), ...(this.passThrough.title === undefined ? [] : [ebmlString(0x7ba9, this.passThrough.title)])));
    }
    buildTracks(allowMissingConfig = false) {
        const entries = [];
        if (this.cfg.video)
            entries.push(this.buildVideoTrackEntry(this.trackNumbers[0], allowMissingConfig));
        if (this.cfg.audio)
            entries.push(this.buildAudioTrackEntry(this.primaryAudioTrackNumber(), undefined, undefined, allowMissingConfig));
        const subs = this.cfg.subtitleTracks ?? [];
        for (let i = 0; i < subs.length; i++) {
            entries.push(this.buildSubtitleTrackEntry(this.subtitleTrackNumber(i), subs[i]));
        }
        const extras = this.cfg.extraAudioTracks ?? [];
        for (let i = 0; i < extras.length; i++) {
            entries.push(this.buildAudioTrackEntry(this.extraAudioTrackNumber(i), extras[i], this.extraAudioConfigs[i], allowMissingConfig));
        }
        for (let i = 0; i < (this.cfg.extraVideoTracks?.length ?? 0); i++) {
            entries.push(this.buildVideoTrackEntry(this.extraVideoTrackNumber(i), allowMissingConfig, i));
        }
        return ebmlElement(0x1654ae6b, concat(...entries));
    }
    buildSubtitleTrackEntry(trackNum, sub) {
        const SUB_IDS = {
            'text/utf8': 'S_TEXT/UTF8',
            'text/ass': 'S_TEXT/ASS',
            'text/ssa': 'S_TEXT/SSA',
            'text/webvtt': 'S_TEXT/WEBVTT',
        };
        if (this.cfg.format === 'webm' && sub.codec !== 'text/webvtt' && sub.codec !== 'text/utf8') {
            throw new MediaForgeError(`WebM cannot carry subtitle codec '${sub.codec}'`, 'FORMAT');
        }
        const codecId = sub.codec === 'text/webvtt' ? 'D_WEBVTT/SUBTITLES' : SUB_IDS[sub.codec];
        if (!codecId)
            throw new MediaForgeError(`Matroska output cannot label subtitle codec '${sub.codec}'`, 'FORMAT');
        const children = [
            ebmlUint(0xd7, trackNum),
            ebmlUid(this.trackUids[this.trackNumbers.indexOf(trackNum)]),
            ebmlUint(0x83, 17),
            ebmlString(0x86, codecId),
            ...languageElements(sub.language),
            ...trackMetadataElements(sub),
        ];
        if (sub.codecConfig && sub.codecConfig.length > 0) {
            children.push(ebmlBinary(0x63a2, sub.codecConfig));
        }
        return ebmlElement(0xae, concat(...children));
    }
    buildVideoTrackEntry(trackNum, allowMissingConfig = false, index = -1) {
        const video = index < 0 ? this.cfg.video : this.cfg.extraVideoTracks?.[index];
        if (!video)
            throw new Error('Missing video track config');
        const config = index < 0 ? this.videoConfig : this.extraVideoConfigs[index];
        validateCodecConfig(video.codec, config, allowMissingConfig);
        const codecId = (() => {
            const c = video.codec;
            if (typeof c !== 'string')
                throw new MediaForgeError('Matroska video codec must be a string', 'FORMAT');
            if (c.startsWith('vp8'))
                return 'V_VP8';
            if (c.startsWith('vp09') || c.startsWith('vp9'))
                return 'V_VP9';
            if (c.startsWith('av01'))
                return 'V_AV1';
            if (isProResCodec(c))
                return 'V_PRORES';
            if (c.startsWith('avc')) {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError("WebM cannot carry H.264; use format 'mkv'", 'FORMAT');
                }
                return 'V_MPEG4/ISO/AVC';
            }
            if (c.startsWith('hvc1') || c.startsWith('hev1')) {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError("WebM cannot carry H.265; use format 'mkv'", 'FORMAT');
                }
                return 'V_MPEGH/ISO/HEVC';
            }
            throw new MediaForgeError(`Matroska output cannot label video codec '${c}'`, 'FORMAT');
        })();
        const videoChildren = [
            ebmlUint(0xb0, video.width),
            ebmlUint(0xba, video.height),
            ...(video.alphaMode ? [ebmlUint(0x53c0, 1)] : []),
        ];
        const display = index < 0 ? this.display : this.extraVideoDisplays[index];
        if (display) {
            videoChildren.push(ebmlUint(0x54b0, display.width));
            videoChildren.push(ebmlUint(0x54ba, display.height));
            videoChildren.push(ebmlUint(0x54b2, display.unit));
        }
        const colour = index < 0 ? (this.cfg.videoColour ?? video.colour) : video.colour;
        if (colour) {
            if (typeof colour.fullRange !== 'boolean')
                throw new MediaForgeError('Matroska colour fullRange must be a boolean', 'FORMAT');
            videoChildren.push(ebmlElement(0x55b0, concat(ebmlUint(0x55b9, colour.fullRange ? 2 : 1), ebmlUint(0x55b1, colour.matrix), ebmlUint(0x55ba, colour.transfer), ebmlUint(0x55bb, colour.primaries))));
        }
        const rotation = (((video.rotation ?? 0) % 360) + 360) % 360;
        if (rotation !== 0) {
            videoChildren.push(ebmlElement(0x7670, concat(ebmlUint(0x7671, 0), ebmlFloat(0x7675, rotation > 180 ? rotation - 360 : rotation))));
        }
        const trackChildren = [
            ebmlUint(0xd7, trackNum),
            ebmlUid(this.trackUids[this.trackNumbers.indexOf(trackNum)]),
            ebmlUint(0x83, 1),
            ebmlString(0x86, codecId),
            ...languageElements(index < 0 ? this.cfg.videoLanguage : video.language),
            ...trackMetadataElements(video),
            ...(video.alphaMode ? [ebmlUint(0x55ee, 1)] : []),
        ];
        if (video.framerate > 0) {
            trackChildren.push(ebmlUint(0x23e383, Math.max(1, Math.round(1_000_000_000 / video.framerate))));
        }
        if (codecId === 'V_PRORES')
            trackChildren.push(ebmlBinary(0x63a2, textEncoder.encode(video.codec)));
        else if (config && config.length > 0)
            trackChildren.push(ebmlBinary(0x63a2, config));
        trackChildren.push(ebmlElement(0xe0, concat(...videoChildren)));
        return ebmlElement(0xae, concat(...trackChildren));
    }
    buildAudioTrackEntry(trackNum, audioOverride, configOverride, allowMissingConfig = false) {
        const audio = audioOverride ?? this.cfg.audio;
        if (!audio)
            throw new Error('Missing audio track config');
        const pcm = this.pcmFormats.get(trackNum);
        validateCodecConfig(audio.codec, audioOverride ? configOverride : this.audioConfig, allowMissingConfig);
        const codecId = (() => {
            const c = audio.codec;
            if (pcm)
                return pcm.codecId;
            if (typeof c !== 'string')
                throw new MediaForgeError('Matroska audio codec must be a string', 'FORMAT');
            if (c.startsWith('opus'))
                return 'A_OPUS';
            if (c.startsWith('vorbis'))
                return 'A_VORBIS';
            if (c.startsWith('mp4a')) {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError("WebM cannot carry AAC; use format 'mkv'", 'FORMAT');
                }
                return 'A_AAC';
            }
            if (c === 'mp1' || c === 'mp2' || c === 'mp3') {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError("WebM cannot carry MPEG Audio; use format 'mkv'", 'FORMAT');
                }
                return `A_MPEG/L${c[2]}`;
            }
            if (c === 'ac-3' || c === 'ec-3') {
                if (this.cfg.format !== 'mkv') {
                    throw new MediaForgeError(`WebM cannot carry ${c.toUpperCase()}; use format 'mkv'`, 'FORMAT');
                }
                return c === 'ac-3' ? 'A_AC3' : 'A_EAC3';
            }
            throw new MediaForgeError(`Matroska output cannot label audio codec '${c}'`, 'FORMAT');
        })();
        const trackChildren = [
            ebmlUint(0xd7, trackNum),
            ebmlUid(this.trackUids[this.trackNumbers.indexOf(trackNum)]),
            ebmlUint(0x83, 2),
            ebmlString(0x86, codecId),
            ...languageElements(audioOverride ? audio.language : this.cfg.audioLanguage),
            ...trackMetadataElements(audio),
        ];
        if (codecId === 'A_OPUS') {
            const activeConfig = audioOverride ? configOverride : this.audioConfig;
            const opus = parseOpusHead(activeConfig ?? new Uint8Array(0), audio.channelCount || 2, audio.sampleRate || 48000);
            trackChildren.push(ebmlBinary(0x63a2, opus.head));
            trackChildren.push(ebmlUint(0x56aa, Math.round((opus.preSkip * 1_000_000_000) / 48000)));
            trackChildren.push(ebmlUint(0x56bb, 80_000_000));
            trackChildren.push(ebmlElement(0xe1, concat(ebmlFloat(0xb5, 48000), ebmlUint(0x9f, opus.channels))));
        }
        else {
            const activeCfg = audioOverride ? configOverride : this.audioConfig;
            if (!pcm && activeCfg && activeCfg.length > 0)
                trackChildren.push(ebmlBinary(0x63a2, activeCfg));
            const codecDelaySamples = audioOverride
                ? Math.max(0, Math.round(configuredCodecDelaySamples(audio, Math.max(0, Math.round(audio.primingSamples ?? 0)), activeCfg)))
                : this.audioCodecDelaySamples;
            if (codecDelaySamples > 0) {
                trackChildren.push(ebmlUint(0x56aa, Math.round(codecDelaySamples * (1_000_000_000 / this.audioTimingRateFor(audio)))));
            }
            trackChildren.push(ebmlElement(0xe1, concat(ebmlFloat(0xb5, audio.sampleRate || 48000), ebmlUint(0x9f, audio.channelCount || 2), ...(pcm ? [ebmlUint(0x6264, pcm.bitsPerSample)] : []))));
        }
        return ebmlElement(0xae, concat(...trackChildren));
    }
    buildClustersWithTimes(packets, discardPadding = this.buildStandardDiscardPadding(packets)) {
        const startTimesTicks = [];
        const cueTracks = [];
        const clusters = [];
        const clusterDurationTicks = 2 * this.timeUnitsPerSecond;
        let clusterPackets = [];
        let clusterStartTicks = 0;
        const flush = () => {
            if (clusterPackets.length === 0)
                return;
            startTimesTicks.push(clusterStartTicks);
            cueTracks.push((clusterPackets.find(packet => packet.chunk.trackType === 'video' && packet.chunk.isKeyframe) ??
                clusterPackets[0]).trackNum);
            clusters.push(this.serializeCluster(clusterPackets, clusterStartTicks, discardPadding));
            clusterPackets = [];
        };
        const hasVideo = !!this.cfg.video || !!this.cfg.extraVideoTracks?.length;
        for (const packet of packets) {
            const timestampTicks = Math.round(this.packetTimestamp(packet) * this.timeUnitsPerSecond);
            if (clusterPackets.length === 0)
                clusterStartTicks = Math.max(0, timestampTicks);
            const canCut = !hasVideo || (packet.chunk.trackType === 'video' && packet.chunk.isKeyframe === true);
            const over = timestampTicks - clusterStartTicks >= clusterDurationTicks;
            const wayOver = timestampTicks - clusterStartTicks >= 16000;
            const beforeRange = timestampTicks - clusterStartTicks < -32768;
            if ((over && canCut) || wayOver || beforeRange) {
                flush();
                clusterStartTicks = Math.max(0, timestampTicks);
            }
            clusterPackets.push(packet);
        }
        flush();
        return { clusters, startTimesTicks, cueTracks };
    }
    serializeCluster(clusterPackets, clusterStartTicks, discardPadding) {
        const children = [ebmlUint(0xe7, clusterStartTicks)];
        for (const packet of clusterPackets) {
            const absoluteTicks = Math.round(this.packetTimestamp(packet) * this.timeUnitsPerSecond);
            const relTicks = absoluteTicks - clusterStartTicks;
            if (!Number.isSafeInteger(relTicks) || relTicks < -32768 || relTicks > 32767) {
                throw new MediaForgeError('Matroska block timestamp cannot fit its signed 16-bit field', 'MUX');
            }
            let trackBytes = 1;
            while (packet.trackNum >= 2 ** (trackBytes * 7))
                trackBytes++;
            const isSubtitle = this.subtitleNumbers.size !== 0 && this.subtitleNumbers.has(packet.trackNum);
            const simple = !packet.chunk.alphaData && !isSubtitle && !discardPadding.has(packet);
            const bodyBytes = trackBytes + 3 + packet.chunk.data.length;
            const headerBytes = simple ? 1 + ebmlSizeBytes(bodyBytes) : 0;
            const payload = new Uint8Array(headerBytes + bodyBytes);
            if (simple) {
                payload[0] = 0xa3;
                writeEbmlSize(payload, 1, bodyBytes);
            }
            if (trackBytes === 1)
                payload[headerBytes] = packet.trackNum | 0x80;
            else {
                writeUnsigned(payload, headerBytes, packet.trackNum, trackBytes);
                payload[headerBytes] = payload[headerBytes] | (0x80 >> (trackBytes - 1));
            }
            payload[headerBytes + trackBytes] = (relTicks >> 8) & 0xff;
            payload[headerBytes + trackBytes + 1] = relTicks & 0xff;
            payload[headerBytes + trackBytes + 2] =
                packet.chunk.isKeyframe || packet.chunk.trackType === 'audio' ? 0x80 : 0;
            payload.set(packet.chunk.data, headerBytes + trackBytes + 3);
            if (packet.chunk.alphaData) {
                payload[trackBytes + 2] = 0;
                children.push(ebmlElement(0xa0, concat(ebmlElement(0xa1, payload), ebmlUint(0x9b, Math.max(1, Math.round(packet.chunk.duration * this.timeUnitsPerSecond))), ...(!packet.chunk.isKeyframe
                    ? [ebmlSint(0xfb, (this.lastBlockTimestamps.get(packet.trackNum) ?? 0) - absoluteTicks)]
                    : []), ebmlElement(0x75a1, ebmlElement(0xa6, concat(ebmlUint(0xee, 1), ebmlBinary(0xa5, packet.chunk.alphaData)))))));
            }
            else if (isSubtitle) {
                payload[trackBytes + 2] = 0;
                children.push(ebmlElement(0xa0, concat(ebmlElement(0xa1, payload), ebmlUint(0x9b, Math.max(1, Math.round((packet.chunk.duration ?? 0) * this.timeUnitsPerSecond))))));
            }
            else if (discardPadding.has(packet)) {
                payload[trackBytes + 2] = 0;
                const paddingNs = discardPadding.get(packet);
                children.push(ebmlElement(0xa0, concat(ebmlElement(0xa1, payload), ebmlSint(0x75a2, paddingNs))));
            }
            else {
                children.push(payload);
            }
            this.lastBlockTimestamps.set(packet.trackNum, absoluteTicks);
        }
        const bodyBytes = children.reduce((sum, child) => sum + child.length, 0);
        const output = new Uint8Array(4 + ebmlSizeBytes(bodyBytes) + bodyBytes);
        let offset = writeEbmlId(output, 0, 0x1f43b675);
        offset = writeEbmlSize(output, offset, bodyBytes);
        for (const child of children) {
            output.set(child, offset);
            offset += child.length;
        }
        return output;
    }
}
