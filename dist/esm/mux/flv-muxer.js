import { MediaForgeError } from '../core/errors.js';
import { buildAacAsc, parseAacAudioSpecificConfig } from '../audio/adts.js';
import { isValidAvccWalk } from '../core/annexb.js';
export class FLVMuxer {
    videoChunkCount = 0;
    audioChunkCount = 0;
    sink;
    cfg;
    headerWritten = false;
    prevTagSize = 0;
    lastVideoConfig;
    lastAudioConfig;
    timelineOffsetSeconds;
    lastVideoDtsMs = -1;
    lastAudioDtsMs = -1;
    bytesWritten = 0;
    durationPatchOffset = -1;
    presentationEndSec = 0;
    finalized = false;
    constructor(cfg, sink) {
        this.cfg = cfg;
        this.sink = sink;
        const configuredOffset = cfg.timestampOffsetSeconds;
        if (configuredOffset !== undefined && (!Number.isFinite(configuredOffset) || configuredOffset < 0)) {
            throw new MediaForgeError('FLV timestamp offset must be a finite non-negative number', 'MUX');
        }
        this.timelineOffsetSeconds = configuredOffset ?? null;
    }
    addVideoChunk(chunk, codecCfg) {
        this.assertOpen();
        if (chunk.trackType === undefined) {
            throw new MediaForgeError(`${'addVideoChunk'} requires chunk.trackType (got a chunk without one)`, 'MUX');
        }
        if (chunk.trackType !== 'video') {
            throw new MediaForgeError(`addVideoChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        assertChunkTiming(chunk);
        assertBytes(chunk.data, 'video payload');
        const activeVideoConfig = codecCfg ?? this.lastVideoConfig ?? this.cfg.video?.codecConfig;
        assertTagPayloadSize(5 + chunk.data.length);
        if (activeVideoConfig) {
            assertBytes(activeVideoConfig, 'AVC configuration');
            assertTagPayloadSize(5 + activeVideoConfig.length);
            if (!bytesEqual(activeVideoConfig, this.lastVideoConfig))
                assertAvcConfig(activeVideoConfig);
        }
        const lengthSize = activeVideoConfig ? (activeVideoConfig[4] & 3) + 1 : 4;
        if (!isValidAvccWalk(chunk.data, lengthSize)) {
            throw new MediaForgeError(`FLV AVC sample does not match its ${lengthSize}-byte NAL lengths`, 'MUX');
        }
        const decodeTimestamp = this.videoDecodeTimestamp(chunk);
        const timelineOffset = this.timelineOffsetSeconds ?? Math.max(0, -decodeTimestamp);
        const dtsMs = this.shiftedTimestampMs(decodeTimestamp, timelineOffset);
        const ctsMs = Math.round((chunk.timestamp - decodeTimestamp) * 1000);
        if (!Number.isSafeInteger(ctsMs) || ctsMs < -0x800000 || ctsMs > 0x7fffff) {
            throw new MediaForgeError(`FLV AVC composition offset ${ctsMs}ms is outside signed 24-bit range`, 'MUX');
        }
        if (dtsMs < this.lastVideoDtsMs) {
            throw new MediaForgeError(`FLV video DTS moved backwards (${dtsMs}ms after ${this.lastVideoDtsMs}ms)`, 'MUX');
        }
        const end = presentationEnd(chunk, timelineOffset);
        this.timelineOffsetSeconds = timelineOffset;
        this.lastVideoDtsMs = dtsMs;
        this.videoChunkCount++;
        this.ensureHeader();
        if (activeVideoConfig && activeVideoConfig.length > 0 && !bytesEqual(activeVideoConfig, this.lastVideoConfig)) {
            const seq = new Uint8Array(5 + activeVideoConfig.length);
            seq[0] = 0x17;
            seq.set(activeVideoConfig, 5);
            this.writeTag(9, dtsMs, seq);
            this.lastVideoConfig = new Uint8Array(activeVideoConfig);
        }
        const payload = new Uint8Array(5 + chunk.data.length);
        payload[0] = (chunk.isKeyframe ? 0x10 : 0x20) | 0x07;
        payload[1] = 1;
        const encodedCts = ctsMs & 0xffffff;
        payload[2] = (encodedCts >> 16) & 0xff;
        payload[3] = (encodedCts >> 8) & 0xff;
        payload[4] = encodedCts & 0xff;
        payload.set(chunk.data, 5);
        this.writeTag(9, dtsMs, payload);
        if (end > this.presentationEndSec)
            this.presentationEndSec = end;
    }
    addAudioChunk(chunk, codecConfig) {
        this.assertOpen();
        if (chunk.trackType === undefined) {
            throw new MediaForgeError(`${'addAudioChunk'} requires chunk.trackType (got a chunk without one)`, 'MUX');
        }
        if (chunk.trackType !== 'audio') {
            throw new MediaForgeError(`addAudioChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        assertChunkTiming(chunk);
        assertBytes(chunk.data, 'audio payload');
        const asc = codecConfig ?? this.lastAudioConfig ?? this.cfg.audio?.codecConfig ?? this.defaultAudioConfig();
        assertTagPayloadSize(2 + chunk.data.length);
        assertBytes(asc, 'AAC configuration');
        assertTagPayloadSize(2 + asc.length);
        const soundHeader = this.aacSoundHeader(asc);
        const timelineOffset = this.timelineOffsetSeconds ?? Math.max(0, -chunk.timestamp);
        const dtsMs = this.shiftedTimestampMs(chunk.timestamp, timelineOffset);
        if (dtsMs < this.lastAudioDtsMs) {
            throw new MediaForgeError(`FLV audio timestamp moved backwards (${dtsMs}ms after ${this.lastAudioDtsMs}ms)`, 'MUX');
        }
        const end = presentationEnd(chunk, timelineOffset);
        this.timelineOffsetSeconds = timelineOffset;
        this.lastAudioDtsMs = dtsMs;
        this.audioChunkCount++;
        this.ensureHeader();
        if (!bytesEqual(asc, this.lastAudioConfig)) {
            const seq = new Uint8Array(2 + asc.length);
            seq[0] = soundHeader;
            seq.set(asc, 2);
            this.writeTag(8, dtsMs, seq);
            this.lastAudioConfig = new Uint8Array(asc);
        }
        const payload = new Uint8Array(2 + chunk.data.length);
        payload[0] = soundHeader;
        payload[1] = 1;
        payload.set(chunk.data, 2);
        this.writeTag(8, dtsMs, payload);
        if (end > this.presentationEndSec)
            this.presentationEndSec = end;
    }
    async finalize() {
        this.assertOpen();
        if (this.cfg.video && this.videoChunkCount === 0) {
            throw new MediaForgeError('finalize with a declared video track but no video chunks', 'MUX');
        }
        if (this.cfg.audio && this.audioChunkCount === 0) {
            throw new MediaForgeError('finalize with a declared audio track but no audio chunks', 'MUX');
        }
        this.finalized = true;
        this.ensureHeader();
        const buf = new Uint8Array(4);
        new DataView(buf.buffer).setUint32(0, this.prevTagSize, false);
        this.write(buf);
        if (this.durationPatchOffset >= 0 && this.sink.patchAt) {
            const d = new Uint8Array(8);
            new DataView(d.buffer).setFloat64(0, this.presentationEndSec, false);
            this.sink.patchAt(this.durationPatchOffset, d);
        }
        await this.sink.close();
    }
    assertOpen() {
        if (this.finalized)
            throw new MediaForgeError('FLV muxer is finalizing or finalized', 'MUX');
    }
    ensureHeader() {
        if (this.headerWritten)
            return;
        this.headerWritten = true;
        const hasV = !!this.cfg.video;
        const hasA = !!this.cfg.audio;
        const hdr = new Uint8Array(9);
        hdr[0] = 0x46;
        hdr[1] = 0x4c;
        hdr[2] = 0x56;
        hdr[3] = 1;
        hdr[4] = (hasV ? 1 : 0) | (hasA ? 4 : 0);
        new DataView(hdr.buffer).setUint32(5, 9, false);
        this.write(hdr);
        this.writeMetaDataTag();
    }
    write(data) {
        this.sink.write(data);
        this.bytesWritten += data.length;
    }
    writeMetaDataTag() {
        const patchable = typeof this.sink.patchAt === 'function';
        const entries = [];
        if (patchable)
            entries.push(['duration', 0]);
        if (this.cfg.video?.width)
            entries.push(['width', this.cfg.video.width]);
        if (this.cfg.video?.height)
            entries.push(['height', this.cfg.video.height]);
        if (this.cfg.video)
            entries.push(['videocodecid', 7]);
        if (this.cfg.audio) {
            entries.push(['audiocodecid', 10]);
            if (this.cfg.audio.sampleRate)
                entries.push(['audiosamplerate', this.cfg.audio.sampleRate]);
        }
        if (entries.length === 0)
            return;
        let size = 1 + 2 + 10;
        size += 1 + 4;
        for (const [key] of entries)
            size += 2 + key.length + 1 + 8;
        size += 2 + 1;
        const data = new Uint8Array(size);
        const dv = new DataView(data.buffer);
        let p = 0;
        data[p++] = 0x02;
        dv.setUint16(p, 10, false);
        p += 2;
        for (const c of 'onMetaData')
            data[p++] = c.charCodeAt(0);
        data[p++] = 0x08;
        dv.setUint32(p, entries.length, false);
        p += 4;
        const payloadAbsStart = this.bytesWritten + 15;
        for (const [key, value] of entries) {
            dv.setUint16(p, key.length, false);
            p += 2;
            for (const c of key)
                data[p++] = c.charCodeAt(0);
            data[p++] = 0x00;
            if (key === 'duration')
                this.durationPatchOffset = payloadAbsStart + p;
            dv.setFloat64(p, value, false);
            p += 8;
        }
        data[p++] = 0x00;
        data[p++] = 0x00;
        data[p++] = 0x09;
        this.writeTag(18, 0, data);
    }
    defaultAudioConfig() {
        try {
            return buildAacAsc(this.cfg.audio?.sampleRate ?? 44100, this.cfg.audio?.channelCount ?? 2);
        }
        catch {
            throw new MediaForgeError('FLV cannot build AAC configuration from the audio track settings', 'MUX');
        }
    }
    aacSoundHeader(codecConfig) {
        const parsed = parseAacAudioSpecificConfig(codecConfig);
        if (!parsed)
            throw new MediaForgeError('FLV AAC AudioSpecificConfig is malformed', 'MUX');
        const stereo = parsed.channelCount > 1 ? 1 : 0;
        return 0xa0 | 0x0c | 0x02 | stereo;
    }
    videoDecodeTimestamp(chunk) {
        const decodeTimestamp = chunk.decodeTimestamp ??
            (chunk.compositionTimeOffset !== undefined
                ? chunk.timestamp - chunk.compositionTimeOffset
                : chunk.timestamp);
        if (!Number.isFinite(decodeTimestamp)) {
            throw new MediaForgeError(`FLV video DTS is not finite (${decodeTimestamp})`, 'MUX');
        }
        return decodeTimestamp;
    }
    shiftedTimestampMs(timestampSeconds, timelineOffset) {
        if (!Number.isFinite(timestampSeconds)) {
            throw new MediaForgeError(`FLV media timestamp is not finite (${timestampSeconds})`, 'MUX');
        }
        const timestamp = Math.round((timestampSeconds + timelineOffset) * 1000);
        if (timestamp < 0) {
            throw new MediaForgeError(`FLV packet timestamp ${timestampSeconds}s remains negative after the configured timeline shift`, 'MUX');
        }
        assertTimestampMs(timestamp);
        return timestamp;
    }
    writeTag(type, ts, data) {
        assertTimestampMs(ts);
        const tagHeader = new Uint8Array(15);
        const dv = new DataView(tagHeader.buffer);
        dv.setUint32(0, this.prevTagSize, false);
        tagHeader[4] = type;
        tagHeader[5] = (data.length >> 16) & 0xff;
        tagHeader[6] = (data.length >> 8) & 0xff;
        tagHeader[7] = data.length & 0xff;
        tagHeader[8] = (ts >> 16) & 0xff;
        tagHeader[9] = (ts >> 8) & 0xff;
        tagHeader[10] = ts & 0xff;
        tagHeader[11] = (ts >> 24) & 0xff;
        this.write(tagHeader);
        this.write(data);
        this.prevTagSize = 11 + data.length;
    }
}
function assertChunkTiming(chunk) {
    if (!Number.isFinite(chunk.timestamp)) {
        throw new MediaForgeError('FLV presentation timestamp must be a finite number', 'MUX');
    }
    if (!Number.isFinite(chunk.duration) || chunk.duration < 0) {
        throw new MediaForgeError('FLV chunk duration must be a finite non-negative number', 'MUX');
    }
    if ((chunk.decodeTimestamp !== undefined && !Number.isFinite(chunk.decodeTimestamp)) ||
        (chunk.compositionTimeOffset !== undefined && !Number.isFinite(chunk.compositionTimeOffset))) {
        throw new MediaForgeError('FLV DTS and composition offset must be finite numbers', 'MUX');
    }
}
function assertBytes(data, label) {
    if (!ArrayBuffer.isView(data) ||
        Object.prototype.toString.call(data) !== '[object Uint8Array]' ||
        data.length === 0) {
        throw new MediaForgeError(`FLV ${label} must be a non-empty Uint8Array`, 'MUX');
    }
}
function presentationEnd(chunk, timelineOffset) {
    const end = chunk.timestamp + timelineOffset + chunk.duration;
    if (!Number.isFinite(end))
        throw new MediaForgeError('FLV presentation end is not finite', 'MUX');
    return end;
}
function assertTimestampMs(timestamp) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
        throw new MediaForgeError(`FLV timestamp must be an unsigned 32-bit millisecond value (got ${timestamp})`, 'MUX');
    }
}
function assertAvcConfig(record) {
    const malformed = () => new MediaForgeError('FLV AVCDecoderConfigurationRecord is malformed', 'MUX');
    if (record.length < 7 || record[0] !== 1)
        throw malformed();
    let pos = 6;
    for (let group = 0; group < 2; group++) {
        if (group === 1 && pos >= record.length)
            throw malformed();
        const count = group === 0 ? record[5] & 0x1f : record[pos++];
        for (let i = 0; i < count; i++) {
            if (pos + 2 > record.length)
                throw malformed();
            const length = record[pos] * 256 + record[pos + 1];
            if (length === 0 || pos + 2 + length > record.length)
                throw malformed();
            if (!isValidAvccWalk(record.subarray(pos, pos + 2 + length), 2))
                throw malformed();
            pos += 2 + length;
        }
    }
}
function assertTagPayloadSize(size) {
    if (size > 0xffffff) {
        throw new MediaForgeError(`FLV tag payload size ${size} exceeds the unsigned 24-bit range`, 'MUX');
    }
}
function bytesEqual(a, b) {
    if (!b || a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
