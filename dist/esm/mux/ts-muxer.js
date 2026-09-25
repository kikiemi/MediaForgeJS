import { assertMuxCodec } from '../core/mux-codecs.js';
import { MediaForgeError } from '../core/errors.js';
import { getAdtsFrameLength, parseAacAudioSpecificConfig, parseAdtsFrameHeader } from '../audio/adts.js';
import { isAnnexB, isValidAvccWalk } from '../core/annexb.js';
const PAT_PID = 0x0000;
const PMT_PID = 0x1000;
const VIDEO_PID = 0x0100;
const AUDIO_PID = 0x0101;
const TS = 188;
export class TSMuxer {
    videoChunkCount = 0;
    audioStreams;
    pat;
    pmt;
    sink;
    cfg;
    headerWritten = false;
    cc = {};
    videoConfigCache = null;
    constructor(cfg, sink) {
        const { video, audio, extraVideoTracks, extraAudioTracks, subtitleTracks } = cfg;
        this.cfg = {
            ...cfg,
            video: video
                ? { ...video, codecConfig: video.codecConfig ? new Uint8Array(video.codecConfig) : undefined }
                : undefined,
            audio: audio
                ? { ...audio, codecConfig: audio.codecConfig ? new Uint8Array(audio.codecConfig) : undefined }
                : undefined,
        };
        if (this.cfg.video)
            assertMuxCodec('ts', 'video', this.cfg.video.codec);
        if (extraVideoTracks?.length || subtitleTracks?.length) {
            throw new MediaForgeError('TS writer supports one video and multiple audio tracks', 'FORMAT');
        }
        if (!audio && extraAudioTracks?.length)
            throw new MediaForgeError('Extra TS audio tracks require a primary audio track', 'FORMAT');
        const tracks = audio ? [audio, ...(extraAudioTracks ?? [])] : [];
        if (tracks.length + (video ? 1 : 0) > 64)
            throw new MediaForgeError('TS writer supports at most 64 tracks', 'FORMAT');
        this.audioStreams = tracks.map((track, index) => {
            assertMuxCodec('ts', 'audio', track.codec);
            const config = { ...track, codecConfig: track.codecConfig ? new Uint8Array(track.codecConfig) : undefined };
            if (index === 0 && config.language === undefined)
                config.language = cfg.audioLanguage;
            return {
                config,
                pid: AUDIO_PID + index,
                streamId: track.codec === 'ac-3' || track.codec === 'ec-3' ? 0xbd : 0xc0 + (index & 31),
                count: 0,
            };
        });
        this.pat = this.buildPAT();
        this.pmt = this.buildPMT();
        this.sink = sink;
    }
    addVideoChunk(chunk, codecConfig) {
        if (chunk.trackType === undefined) {
            throw new MediaForgeError(`${'addVideoChunk'} requires chunk.trackType (got a chunk without one)`, 'MUX');
        }
        if (chunk.trackType !== 'video') {
            throw new MediaForgeError(`addVideoChunk received a '${chunk.trackType}' chunk`, 'MUX');
        }
        const timestamp = chunk.timestamp;
        const pts = timestamp90k(timestamp);
        const dts = timestamp90k(chunk.decodeTimestamp ?? timestamp);
        const record = codecConfig ?? this.videoConfigCache?.record ?? this.cfg.video?.codecConfig;
        const parsed = record ? this.videoConfigFor(record) : null;
        const payload = this.normalizeVideoPayload(chunk, parsed);
        const pes = buildPES(0xe0, payload, pts, dts !== pts ? dts : undefined);
        this.videoConfigCache = parsed;
        this.videoChunkCount++;
        this.ensureHeader();
        this.packetize(VIDEO_PID, pes, chunk.isKeyframe, dts);
    }
    addAudioChunk(chunk, codecConfig) {
        this.addAudio(0, chunk, codecConfig);
    }
    addExtraAudioChunk(index, chunk, codecConfig) {
        if (!Number.isInteger(index) || index < 0)
            throw new MediaForgeError('Invalid extra TS audio track index', 'MUX');
        this.addAudio(index + 1, chunk, codecConfig);
    }
    addAudio(index, chunk, codecConfig) {
        const stream = this.audioStreams[index];
        if (!stream)
            throw new MediaForgeError('TS audio track is not declared', 'MUX');
        if (chunk.trackType !== 'audio')
            throw new MediaForgeError('TS audio chunks require trackType audio', 'MUX');
        const pts = timestamp90k(chunk.timestamp);
        const isAac = stream.config.codec.startsWith('mp4a');
        const asc = codecConfig ?? stream.codecConfig ?? stream.config.codecConfig;
        const payload = isAac ? this.normalizeAacPayload(chunk.data, asc) : chunk.data;
        const pes = buildPES(stream.streamId, payload, pts);
        if (isAac && asc && asc !== stream.codecConfig)
            stream.codecConfig = new Uint8Array(asc);
        stream.count++;
        this.ensureHeader();
        this.packetize(stream.pid, pes, false, pts);
    }
    async finalize() {
        if (this.cfg.video && this.videoChunkCount === 0) {
            throw new MediaForgeError('finalize with a declared video track but no video chunks', 'MUX');
        }
        if (this.audioStreams.some(stream => stream.count === 0)) {
            throw new MediaForgeError('finalize with a declared audio track but no audio chunks', 'MUX');
        }
        this.ensureHeader();
        await this.sink.close();
    }
    normalizeVideoPayload(chunk, parsed) {
        const data = chunk.data;
        if (parsed) {
            if (isValidAvccWalk(data, parsed.lengthSize)) {
                const annexb = lengthPrefixedToAnnexB(data, parsed.lengthSize);
                if (annexb)
                    return this.withParamSets(chunk, parsed, annexb);
            }
            if (isAnnexB(data))
                return data;
            throw new MediaForgeError(`length-prefixed video sample does not match the configured NAL length size (${parsed.lengthSize})`, 'MUX');
        }
        if (isAnnexB(data))
            return data;
        throw new MediaForgeError('TS video expects Annex-B; got a length-prefixed sample without a decoder configuration record', 'MUX');
    }
    withParamSets(chunk, parsed, annexb) {
        if (chunk.isKeyframe && parsed.paramSets.length > 0) {
            const out = new Uint8Array(parsed.paramSets.length + annexb.length);
            out.set(parsed.paramSets, 0);
            out.set(annexb, parsed.paramSets.length);
            return out;
        }
        return annexb;
    }
    videoConfigFor(record) {
        if (this.videoConfigCache && bytesEqual(this.videoConfigCache.record, record))
            return this.videoConfigCache;
        const snapshot = new Uint8Array(record);
        const codec = this.cfg.video?.codec ?? '';
        const parsed = codec.startsWith('hvc1') || codec.startsWith('hev1') ? parseHvcC(snapshot) : parseAvcC(snapshot);
        if (!parsed) {
            throw new MediaForgeError('video decoder configuration record is malformed', 'MUX');
        }
        return { record: snapshot, ...parsed };
    }
    lastPsiTicks = null;
    lastPcrTicks = null;
    ensureHeader() {
        if (this.headerWritten)
            return;
        this.headerWritten = true;
        this.writeTable(PAT_PID, this.pat);
        this.writeTable(PMT_PID, this.pmt);
    }
    maybeRepeatTables(ticks) {
        if (this.lastPsiTicks === null) {
            this.lastPsiTicks = ticks;
            return;
        }
        if (ticks - this.lastPsiTicks >= 0.4 * 90000) {
            this.writeTable(PAT_PID, this.pat);
            this.writeTable(PMT_PID, this.pmt);
            this.lastPsiTicks = ticks;
        }
    }
    pcrPid() {
        return this.cfg.video ? VIDEO_PID : AUDIO_PID;
    }
    nextCC(pid) {
        const c = (this.cc[pid] ?? 0) & 0xf;
        this.cc[pid] = c + 1;
        return c;
    }
    videoStreamType() {
        const codec = this.cfg.video?.codec ?? 'avc1.640028';
        if (codec.startsWith('hvc1') || codec.startsWith('hev1'))
            return 0x24;
        return 0x1b;
    }
    audioStreamType(codec) {
        if (codec === 'ac-3')
            return 0x81;
        if (codec === 'ec-3')
            return 0x87;
        if (codec === 'mp3' || codec === 'mp2' || codec === 'mp1')
            return 0x03;
        return 0x0f;
    }
    normalizeAacPayload(data, codecConfig) {
        if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xf0) === 0xf0) {
            if (!adtsChainCovers(data)) {
                throw new MediaForgeError('TS AAC payload contains malformed or truncated ADTS framing', 'MUX');
            }
            return data;
        }
        const parsed = codecConfig ? parseAacAudioSpecificConfig(codecConfig) : null;
        if (!parsed) {
            throw new MediaForgeError('TS AAC payload is not ADTS-framed and no AudioSpecificConfig is available to build ADTS headers', 'MUX');
        }
        if (parsed.samplesPerAccessUnit !== 1024) {
            throw new MediaForgeError('ADTS requires 1024-sample AAC access units', 'MUX');
        }
        return wrapADTS(data, parsed.sampleRate, parsed.channelCount, parsed.audioObjectType);
    }
    buildPAT() {
        const d = new Uint8Array(12);
        d[0] = 0x00;
        d[1] = 0xb0;
        d[2] = 0x0d;
        d[3] = 0x00;
        d[4] = 0x01;
        d[5] = 0xc1;
        d[6] = 0x00;
        d[7] = 0x00;
        d[8] = 0x00;
        d[9] = 0x01;
        d[10] = 0xe0 | ((PMT_PID >> 8) & 0x1f);
        d[11] = PMT_PID & 0xff;
        return appendCRC(d);
    }
    buildPMT() {
        const streams = [];
        if (this.cfg.video)
            streams.push({ type: this.videoStreamType(), pid: VIDEO_PID });
        for (const { config, pid } of this.audioStreams)
            streams.push({ type: this.audioStreamType(config.codec), pid, language: config.language });
        const infoLen = streams.reduce((sum, stream) => sum + 5 + (/^[a-z]{3}$/i.test(stream.language ?? '') ? 6 : 0), 0);
        const sectionLen = 9 + infoLen + 4;
        if (sectionLen > 1021)
            throw new MediaForgeError('TS PMT exceeds its section length limit', 'FORMAT');
        const data = new Uint8Array(3 + sectionLen - 4);
        data.set([
            2,
            0xb0 | (sectionLen >> 8),
            sectionLen & 255,
            0,
            1,
            0xc1,
            0,
            0,
            0xe0 | (this.pcrPid() >> 8),
            this.pcrPid() & 255,
            0xf0,
            0,
        ]);
        let offset = 12;
        for (const { type, pid, language } of streams) {
            const name = /^[a-z]{3}$/i.test(language ?? '') ? language.toLowerCase() : undefined;
            data.set([type, 0xe0 | (pid >> 8), pid & 255, 0xf0, name ? 6 : 0], offset);
            offset += 5;
            if (name) {
                data.set([10, 4, name.charCodeAt(0), name.charCodeAt(1), name.charCodeAt(2), 0], offset);
                offset += 6;
            }
        }
        return appendCRC(data);
    }
    writeTable(pid, section) {
        let offset = 0;
        while (offset < section.length) {
            const first = offset === 0;
            const packet = new Uint8Array(TS);
            packet.fill(0xff);
            packet.set([0x47, (first ? 0x40 : 0) | (pid >> 8), pid & 255, 0x10 | this.nextCC(pid)]);
            if (first)
                packet[4] = 0;
            const header = first ? 5 : 4;
            const length = Math.min(TS - header, section.length - offset);
            packet.set(section.subarray(offset, offset + length), header);
            this.sink.write(packet);
            offset += length;
        }
    }
    writePcrOnly(pcrTicks) {
        const pkt = new Uint8Array(TS);
        pkt[0] = 0x47;
        const pid = this.pcrPid();
        pkt[1] = (pid >> 8) & 0x1f;
        pkt[2] = pid & 0xff;
        const lastCc = ((this.cc[pid] ?? 0) - 1) & 0xf;
        pkt[3] = 0x20 | lastCc;
        pkt[4] = 183;
        pkt[5] = 0x10;
        const pcrBase = BigInt(Math.round(pcrTicks)) & 0x1ffffffffn;
        pkt[6] = Number((pcrBase >> 25n) & 0xffn);
        pkt[7] = Number((pcrBase >> 17n) & 0xffn);
        pkt[8] = Number((pcrBase >> 9n) & 0xffn);
        pkt[9] = Number((pcrBase >> 1n) & 0xffn);
        pkt[10] = (Number(pcrBase & 1n) << 7) | 0x7e;
        pkt[11] = 0x00;
        pkt.fill(0xff, 12);
        this.sink.write(pkt);
        this.lastPcrTicks = pcrTicks;
    }
    bridgeCadence(pcrTicks) {
        if (this.lastPsiTicks !== null) {
            while (pcrTicks - this.lastPsiTicks >= 0.4 * 90000) {
                this.lastPsiTicks += 0.4 * 90000;
                this.writeTable(PAT_PID, this.pat);
                this.writeTable(PMT_PID, this.pmt);
            }
        }
        if (this.lastPcrTicks !== null) {
            while (pcrTicks - this.lastPcrTicks >= 0.08 * 90000) {
                this.writePcrOnly(Math.min(this.lastPcrTicks + 0.08 * 90000, pcrTicks));
            }
        }
    }
    packetize(pid, pes, addPCR, pcrTicks) {
        if (this.lastPcrTicks === null && pid !== this.pcrPid())
            this.writePcrOnly(pcrTicks);
        this.bridgeCadence(pcrTicks);
        this.maybeRepeatTables(pcrTicks);
        if (pid === this.pcrPid() && (this.lastPcrTicks === null || pcrTicks - this.lastPcrTicks >= 0.08 * 90000)) {
            addPCR = true;
        }
        if (addPCR)
            this.lastPcrTicks = pcrTicks;
        let off = 0, first = true;
        while (off < pes.length) {
            const pkt = new Uint8Array(TS);
            pkt[0] = 0x47;
            pkt[1] = (first ? 0x40 : 0) | ((pid >> 8) & 0x1f);
            pkt[2] = pid & 0xff;
            pkt[3] = 0x10 | this.nextCC(pid);
            let hdr = 4;
            if (first && addPCR) {
                pkt[3] |= 0x20;
                pkt[4] = 7;
                pkt[5] = 0x10;
                const pcrBase = BigInt(Math.round(pcrTicks)) & 0x1ffffffffn;
                pkt[6] = Number((pcrBase >> 25n) & 0xffn);
                pkt[7] = Number((pcrBase >> 17n) & 0xffn);
                pkt[8] = Number((pcrBase >> 9n) & 0xffn);
                pkt[9] = Number((pcrBase >> 1n) & 0xffn);
                pkt[10] = (Number(pcrBase & 1n) << 7) | 0x7e;
                pkt[11] = 0x00;
                hdr = 12;
            }
            const rem = pes.length - off;
            const room = TS - hdr;
            if (rem >= room) {
                pkt.set(pes.subarray(off, off + room), hdr);
                off += room;
            }
            else {
                const stuff = room - rem;
                pkt[3] |= 0x20;
                if (hdr === 4) {
                    pkt[4] = stuff - 1;
                    if (stuff > 1)
                        pkt[5] = 0x00;
                    if (stuff > 2)
                        pkt.fill(0xff, 6, 4 + stuff);
                }
                else {
                    const oldLen = pkt[4];
                    pkt[4] = oldLen + stuff;
                    pkt.fill(0xff, hdr, hdr + stuff);
                }
                pkt.set(pes.subarray(off, off + rem), TS - rem);
                off += rem;
            }
            first = false;
            this.sink.write(pkt);
        }
    }
}
function bytesEqual(a, b) {
    if (a === b)
        return true;
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
function timestamp90k(seconds) {
    const ticks = Number.isFinite(seconds) ? Math.round(seconds * 90000) : NaN;
    if (!Number.isSafeInteger(ticks)) {
        throw new MediaForgeError('TS timestamp must be finite and safely representable at 90 kHz', 'MUX');
    }
    return ticks;
}
function buildPES(streamId, data, pts, dts) {
    const withDts = dts !== undefined;
    const headerDataLen = withDts ? 10 : 5;
    const hdrLen = 9 + headerDataLen;
    const pesPacketLen = 3 + headerDataLen + data.length;
    if (pesPacketLen > 0xffff && (streamId < 0xe0 || streamId > 0xef)) {
        throw new MediaForgeError('TS audio payload exceeds the 65527-byte PES limit', 'MUX');
    }
    const buf = new Uint8Array(hdrLen + data.length);
    buf[0] = 0x00;
    buf[1] = 0x00;
    buf[2] = 0x01;
    buf[3] = streamId;
    if (pesPacketLen <= 0xffff) {
        buf[4] = (pesPacketLen >> 8) & 0xff;
        buf[5] = pesPacketLen & 0xff;
    }
    buf[6] = 0x80;
    buf[7] = withDts ? 0xc0 : 0x80;
    buf[8] = headerDataLen;
    writeTs90k(buf, 9, pts, withDts ? 0x3 : 0x2);
    if (withDts)
        writeTs90k(buf, 14, dts, 0x1);
    buf.set(data, hdrLen);
    return buf;
}
function writeTs90k(buf, off, ticks, marker) {
    const v = BigInt(Math.round(ticks)) & 0x1ffffffffn;
    buf[off] = (marker << 4) | 0x01 | (Number((v >> 30n) & 0x07n) << 1);
    buf[off + 1] = Number((v >> 22n) & 0xffn);
    buf[off + 2] = (Number((v >> 15n) & 0x7fn) << 1) | 1;
    buf[off + 3] = Number((v >> 7n) & 0xffn);
    buf[off + 4] = (Number(v & 0x7fn) << 1) | 1;
}
function appendCRC(section) {
    const out = new Uint8Array(section.length + 4);
    out.set(section);
    const crc = crc32mpeg(section);
    out[section.length] = (crc >> 24) & 0xff;
    out[section.length + 1] = (crc >> 16) & 0xff;
    out[section.length + 2] = (crc >> 8) & 0xff;
    out[section.length + 3] = crc & 0xff;
    return out;
}
function crc32mpeg(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i] << 24;
        for (let b = 0; b < 8; b++) {
            crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
        }
    }
    return crc >>> 0;
}
const FREQ_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function adtsChainCovers(data) {
    let pos = 0;
    while (pos < data.length) {
        const header = parseAdtsFrameHeader(data, pos);
        if (!header || pos + header.frameLength > data.length)
            return false;
        pos += header.frameLength;
    }
    return pos === data.length && pos > 0;
}
function wrapADTS(aac, sampleRate, channels, audioObjectType = 2) {
    if (audioObjectType < 1 || audioObjectType > 4) {
        throw new MediaForgeError(`ADTS cannot signal AAC audio object type ${audioObjectType} (only 1-4 fit the profile field)`, 'MUX');
    }
    const freqIdx = FREQ_TABLE.indexOf(sampleRate);
    if (freqIdx < 0) {
        throw new MediaForgeError(`ADTS cannot signal a ${sampleRate} Hz sample rate (legal AAC rates: ${FREQ_TABLE.join('/')})`, 'MUX');
    }
    const chanCfg = channels >= 1 && channels <= 6 ? channels : channels === 8 ? 7 : -1;
    if (chanCfg < 0) {
        throw new MediaForgeError(`ADTS channel_configuration cannot express ${channels} channel(s) (supported: 1-6, 8)`, 'MUX');
    }
    const frameLen = getAdtsFrameLength(aac, 'MUX');
    const out = new Uint8Array(frameLen);
    out[0] = 0xff;
    out[1] = 0xf1;
    out[2] = ((audioObjectType - 1) << 6) | (freqIdx << 2) | ((chanCfg >> 2) & 1);
    out[3] = ((chanCfg & 3) << 6) | ((frameLen >> 11) & 3);
    out[4] = (frameLen >> 3) & 0xff;
    out[5] = ((frameLen & 7) << 5) | 0x1f;
    out[6] = 0xfc;
    out.set(aac, 7);
    return out;
}
function lengthPrefixedToAnnexB(data, lengthSize) {
    const nals = [];
    let pos = 0;
    let total = 0;
    while (pos < data.length) {
        if (pos + lengthSize > data.length)
            return null;
        let len = 0;
        for (let i = 0; i < lengthSize; i++)
            len = len * 256 + data[pos + i];
        pos += lengthSize;
        if (len === 0)
            continue;
        if (pos + len > data.length)
            return null;
        nals.push(data.subarray(pos, pos + len));
        total += 4 + len;
        pos += len;
    }
    if (nals.length === 0)
        return null;
    const out = new Uint8Array(total);
    let off = 0;
    for (const nal of nals) {
        out[off + 3] = 1;
        out.set(nal, off + 4);
        off += 4 + nal.length;
    }
    return out;
}
function annexBFrame(nals) {
    let total = 0;
    for (const nal of nals)
        total += 4 + nal.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const nal of nals) {
        out[off + 3] = 1;
        out.set(nal, off + 4);
        off += 4 + nal.length;
    }
    return out;
}
function parseAvcC(record) {
    if (record.length < 7 || record[0] !== 1)
        return null;
    const lengthSize = (record[4] & 0x03) + 1;
    const sets = [];
    let pos = 5;
    const spsCount = record[pos] & 0x1f;
    pos++;
    for (let i = 0; i < spsCount; i++) {
        if (pos + 2 > record.length)
            return null;
        const len = (record[pos] << 8) | record[pos + 1];
        pos += 2;
        if (pos + len > record.length)
            return null;
        sets.push(record.subarray(pos, pos + len));
        pos += len;
    }
    if (pos >= record.length)
        return null;
    const ppsCount = record[pos];
    pos++;
    for (let i = 0; i < ppsCount; i++) {
        if (pos + 2 > record.length)
            return null;
        const len = (record[pos] << 8) | record[pos + 1];
        pos += 2;
        if (pos + len > record.length)
            return null;
        sets.push(record.subarray(pos, pos + len));
        pos += len;
    }
    if (sets.length === 0)
        return null;
    return { lengthSize, paramSets: annexBFrame(sets) };
}
function parseHvcC(record) {
    if (record.length < 23 || record[0] !== 1)
        return null;
    const lengthSize = (record[21] & 0x03) + 1;
    const numArrays = record[22];
    const sets = [];
    let pos = 23;
    for (let a = 0; a < numArrays; a++) {
        if (pos + 3 > record.length)
            return null;
        const numNalus = (record[pos + 1] << 8) | record[pos + 2];
        pos += 3;
        for (let n = 0; n < numNalus; n++) {
            if (pos + 2 > record.length)
                return null;
            const len = (record[pos] << 8) | record[pos + 1];
            pos += 2;
            if (pos + len > record.length)
                return null;
            sets.push(record.subarray(pos, pos + len));
            pos += len;
        }
    }
    if (sets.length === 0)
        return null;
    return { lengthSize, paramSets: annexBFrame(sets) };
}
