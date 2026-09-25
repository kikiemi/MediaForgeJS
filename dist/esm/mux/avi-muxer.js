import { assertMuxCodec } from '../core/mux-codecs.js';
import { BinaryWriter } from '../core/binary-writer.js';
import { isAnnexB, isValidAvccWalk } from '../core/annexb.js';
import { MediaForgeError } from '../core/errors.js';
import { describePcmTrack } from '../core/pcm-format.js';
class AviIndexLedger {
    static ENTRIES_PER_PAGE = 4096;
    pages = [];
    entries = 0;
    get length() {
        return this.entries;
    }
    push(fourcc, flags, offset, size) {
        const pageIndex = Math.floor(this.entries / AviIndexLedger.ENTRIES_PER_PAGE);
        const entryIndex = this.entries % AviIndexLedger.ENTRIES_PER_PAGE;
        let page = this.pages[pageIndex];
        if (!page) {
            page = new Uint32Array(AviIndexLedger.ENTRIES_PER_PAGE * 4);
            this.pages.push(page);
        }
        page[entryIndex * 4] =
            fourcc.charCodeAt(0) |
                (fourcc.charCodeAt(1) << 8) |
                (fourcc.charCodeAt(2) << 16) |
                (fourcc.charCodeAt(3) << 24);
        page[entryIndex * 4 + 1] = flags >>> 0;
        page[entryIndex * 4 + 2] = offset >>> 0;
        page[entryIndex * 4 + 3] = size >>> 0;
        this.entries++;
    }
    *encodedPages() {
        let remaining = this.entries;
        for (const page of this.pages) {
            const count = Math.min(remaining, AviIndexLedger.ENTRIES_PER_PAGE);
            const bytes = new Uint8Array(count * 16);
            const view = new DataView(bytes.buffer);
            for (let index = 0; index < count; index++) {
                const source = index * 4;
                const target = index * 16;
                view.setUint32(target, page[source], true);
                view.setUint32(target + 4, page[source + 1], true);
                view.setUint32(target + 8, page[source + 2], true);
                view.setUint32(target + 12, page[source + 3], true);
            }
            remaining -= count;
            yield bytes;
        }
    }
}
export class AVIMuxer {
    static START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
    sink;
    cfg;
    finalized = false;
    videoChunks = [];
    payloadBytes = 0;
    audioChunks = [];
    codecConfig;
    annexBCodecConfig;
    nalLengthSize;
    observedAudioSampleRate;
    observedAudioChannels;
    streaming;
    streamingStarted = false;
    streamingHdrlOffset = 0;
    streamingHdrlLength = 0;
    streamingMoviSizeOffset = 0;
    streamingMoviBytes = 0;
    streamingIndex = new AviIndexLedger();
    streamingVideoFrames = 0;
    streamingAudioFrames = 0;
    streamingMaxChunk = 0;
    streamingMaxVideoChunk = 0;
    streamingMaxAudioChunk = 0;
    streamingMediaBytes = 0;
    streamingFirstVideo = Number.POSITIVE_INFINITY;
    streamingFirstAudio = Number.POSITIVE_INFINITY;
    streamingVideoEnd = Number.NEGATIVE_INFINITY;
    streamingAudioEnd = Number.NEGATIVE_INFINITY;
    streamingNextVideoTs = 0;
    streamingNextAudioTs = 0;
    constructor(cfg, sink) {
        this.cfg = {
            ...cfg,
            video: cfg.video
                ? {
                    ...cfg.video,
                    codecConfig: cfg.video.codecConfig ? new Uint8Array(cfg.video.codecConfig) : undefined,
                }
                : undefined,
            audio: cfg.audio ? { ...cfg.audio } : undefined,
        };
        this.sink = sink;
        if (this.cfg.video)
            assertMuxCodec('avi', 'video', this.cfg.video.codec);
        if (this.cfg.audio) {
            assertMuxCodec('avi', 'audio', this.cfg.audio.codec);
            if (this.cfg.audio.codecConfig || this.cfg.audio.codec === 'pcm-s16le') {
                const pcm = describePcmTrack(this.cfg.audio);
                if (pcm.float ||
                    !pcm.littleEndian ||
                    pcm.bitsPerSample !== 16 ||
                    pcm.validBitsPerSample !== 16 ||
                    (pcm.channelMask !== undefined &&
                        pcm.channelMask !== 0 &&
                        pcm.channelMask !== (pcm.channels === 1 ? 4 : pcm.channels === 2 ? 3 : -1)))
                    throw new MediaForgeError('AVI copying requires full-width PCM16LE with an unspecified or canonical channel layout', 'FORMAT');
            }
        }
        if (cfg.extraVideoTracks?.length || cfg.extraAudioTracks?.length || cfg.subtitleTracks?.length) {
            throw new MediaForgeError('AVI writer supports one video and one PCM audio track', 'FORMAT');
        }
        this.streaming = typeof sink.patchAt === 'function';
        this.validateTrackConfig();
    }
    addVideoChunk(c, cfg) {
        this.assertOpen();
        this.validateBytes(c.data);
        if (this.streaming && !this.cfg.video)
            throw new MediaForgeError('AVI video track is not configured', 'MUX');
        const record = this.codecConfig ? undefined : (cfg ?? this.cfg.video?.codecConfig);
        const info = record ? this.prepareCodecConfig(record) : undefined;
        const tb = this.getVideoRateScale();
        const duration = this.isFinitePositive(c.duration) ? c.duration : tb.scale / tb.rate;
        const timestamp = this.isFiniteNonNegative(c.timestamp) ? c.timestamp : this.streamingNextVideoTs;
        this.validateEnd(timestamp, duration);
        const data = this.normalizeH264Chunk(c.data, c.isKeyframe, info);
        this.checkPayloadSize(data.length);
        if (this.streaming) {
            this.appendStreamingChunk({
                fourcc: '00dc',
                data,
                ts: timestamp,
                durationSec: duration,
                isKey: !!c.isKeyframe,
                sampleFrames: 0,
            });
        }
        else {
            this.videoChunks.push({ ...c, data: new Uint8Array(data) });
            this.payloadBytes += data.length + 8 + (data.length & 1);
        }
        this.streamingNextVideoTs = timestamp + duration;
        if (record && info) {
            this.codecConfig = new Uint8Array(record);
            this.nalLengthSize = info.nalLengthSize;
            this.annexBCodecConfig = info.annexBConfig;
        }
    }
    addAudioChunk(c) {
        this.assertOpen();
        this.validateBytes(c.data);
        if (this.streaming && !this.cfg.audio)
            throw new MediaForgeError('AVI audio track is not configured', 'MUX');
        if (c.data.length % this.getAudioBlockAlign() !== 0) {
            throw new MediaForgeError('AVI PCM bytes do not contain complete sample frames', 'MUX');
        }
        const sampleFrames = this.getAudioChunkSampleFrames(c);
        const duration = this.isFinitePositive(c.duration) ? c.duration : sampleFrames / this.getAudioSampleRate();
        const timestamp = this.isFiniteNonNegative(c.timestamp) ? c.timestamp : this.streamingNextAudioTs;
        this.validateEnd(timestamp, duration);
        this.checkPayloadSize(c.data.length);
        if (this.streaming) {
            this.appendStreamingChunk({
                fourcc: this.cfg.video ? '01wb' : '00wb',
                data: c.data,
                ts: timestamp,
                durationSec: duration,
                isKey: true,
                sampleFrames,
            });
        }
        else {
            this.audioChunks.push({ ...c, data: new Uint8Array(c.data) });
            this.payloadBytes += c.data.length + 8 + (c.data.length & 1);
        }
        this.streamingNextAudioTs = timestamp + duration;
    }
    checkPayloadSize(bytes) {
        const payloadBytes = this.payloadBytes + bytes + 8 + (bytes & 1);
        const entries = (this.streaming ? this.streamingIndex.length : this.videoChunks.length + this.audioChunks.length) + 1;
        const headerBytes = 76 +
            (this.cfg.video || this.videoChunks.length ? 124 : 0) +
            (this.cfg.audio || this.audioChunks.length ? 100 : 0);
        const fileBytes = 12 + headerBytes + 12 + payloadBytes + 8 + entries * 16;
        if (!Number.isSafeInteger(payloadBytes) ||
            payloadBytes > 0xf0000000 ||
            !Number.isSafeInteger(fileBytes) ||
            fileBytes > 0xffffffff) {
            throw new MediaForgeError('AVI output has passed the 4 GiB ceiling of classic RIFF/idx1 ' +
                '(OpenDML/AVIX is not implemented). Use MP4, MKV or a lower bitrate/resolution.', 'MUX');
        }
    }
    assertOpen() {
        if (this.finalized)
            throw new MediaForgeError('AVI muxer is finalizing or finalized', 'MUX');
    }
    validateBytes(data) {
        if (!ArrayBuffer.isView(data) ||
            Object.prototype.toString.call(data) !== '[object Uint8Array]' ||
            data.length === 0) {
            throw new MediaForgeError('AVI chunk must contain Uint8Array bytes', 'MUX');
        }
    }
    validateEnd(timestamp, duration) {
        if (!Number.isFinite(timestamp + duration)) {
            throw new MediaForgeError('AVI chunk end time exceeds the supported range', 'MUX');
        }
    }
    u32(value, label) {
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
            throw new MediaForgeError(`AVI ${label} exceeds its uint32 field`, 'MUX');
        }
    }
    validateTrackConfig() {
        if (this.cfg.video) {
            for (const dimension of [this.getVideoWidth(), this.getVideoHeight()]) {
                if (!Number.isInteger(dimension) || dimension < 1 || dimension > 65535) {
                    throw new MediaForgeError('AVI video dimensions exceed the stream header range', 'MUX');
                }
            }
            this.getVideoRateScale();
        }
        if (this.cfg.audio) {
            this.validateAudioShape(this.getAudioSampleRate(), this.getAudioChannelCount());
        }
    }
    validateAudioShape(sampleRate, channels) {
        if (!Number.isInteger(sampleRate) ||
            sampleRate < 1 ||
            sampleRate > 0xffffffff ||
            !Number.isInteger(channels) ||
            channels < 1 ||
            channels > 32767) {
            throw new MediaForgeError('AVI PCM sample rate or channel count is invalid', 'MUX');
        }
        this.u32(sampleRate * channels * 2, 'PCM byte rate');
    }
    validatePCMShape(planes, sampleRate, allowEmpty = false) {
        const channels = planes.length;
        const frames = planes[0]?.length ?? 0;
        this.validateAudioShape(sampleRate, channels);
        if ((!allowEmpty && frames < 1) ||
            planes.some(plane => !ArrayBuffer.isView(plane) ||
                Object.prototype.toString.call(plane) !== '[object Float32Array]' ||
                plane.length !== frames)) {
            throw new MediaForgeError('AVI PCM chunk has an invalid shape', 'MUX');
        }
        if (this.streaming && !this.cfg.audio)
            throw new MediaForgeError('AVI audio track is not configured', 'MUX');
        if ((this.cfg.audio?.sampleRate !== undefined && this.cfg.audio.sampleRate !== sampleRate) ||
            (this.cfg.audio?.channelCount !== undefined && this.cfg.audio.channelCount !== channels)) {
            throw new MediaForgeError('AVI PCM shape does not match the configured audio track', 'MUX');
        }
    }
    writeSink(bytes) {
        try {
            this.sink.write(bytes);
        }
        catch (error) {
            this.finalized = true;
            throw error;
        }
    }
    u32le(value) {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        return bytes;
    }
    startStreaming() {
        if (this.streamingStarted)
            return;
        const hasV = !!this.cfg.video;
        const hasA = !!this.cfg.audio;
        if (!hasV && !hasA)
            throw new MediaForgeError('AVI has no configured tracks', 'MUX');
        const hdrl = this.buildHdrl(hasV, hasA, 0, 0, 0, 0, 0, 0, 0, 0);
        const riff = new BinaryWriter();
        riff.writeASCII('RIFF');
        riff.writeU32LE(0);
        riff.writeASCII('AVI ');
        this.writeSink(riff.toUint8Array());
        this.streamingHdrlOffset = 12;
        this.streamingHdrlLength = hdrl.length;
        this.writeSink(hdrl);
        const movi = new BinaryWriter();
        movi.writeASCII('LIST');
        movi.writeU32LE(0);
        movi.writeASCII('movi');
        this.streamingMoviSizeOffset = 12 + hdrl.length + 4;
        this.writeSink(movi.toUint8Array());
        this.streamingStarted = true;
    }
    checkStreamingCounters(video, sampleFrames) {
        this.u32(this.streamingMoviBytes + 4, 'index offset');
        this.u32(this.streamingIndex.length * 16 + 16, 'index size');
        this.u32(video ? this.streamingVideoFrames + 1 : this.streamingAudioFrames + sampleFrames, 'stream length');
    }
    appendStreamingChunk(chunk) {
        this.checkStreamingCounters(chunk.fourcc.endsWith('dc'), chunk.sampleFrames);
        this.startStreaming();
        const header = new BinaryWriter();
        header.writeASCII(chunk.fourcc);
        header.writeU32LE(chunk.data.length);
        this.writeSink(header.toUint8Array());
        this.writeSink(chunk.data);
        if ((chunk.data.length & 1) !== 0)
            this.writeSink(new Uint8Array(1));
        this.streamingIndex.push(chunk.fourcc, chunk.isKey ? 0x10 : 0, this.streamingMoviBytes + 4, chunk.data.length);
        this.streamingMoviBytes += 8 + chunk.data.length + (chunk.data.length & 1);
        this.payloadBytes += 8 + chunk.data.length + (chunk.data.length & 1);
        this.streamingMediaBytes += chunk.data.length;
        this.streamingMaxChunk = Math.max(this.streamingMaxChunk, chunk.data.length);
        if (chunk.fourcc.endsWith('dc')) {
            this.streamingVideoFrames++;
            this.streamingMaxVideoChunk = Math.max(this.streamingMaxVideoChunk, chunk.data.length);
            this.streamingFirstVideo = Math.min(this.streamingFirstVideo, chunk.ts);
            this.streamingVideoEnd = Math.max(this.streamingVideoEnd, chunk.ts + chunk.durationSec);
        }
        else {
            this.streamingAudioFrames += chunk.sampleFrames;
            this.streamingMaxAudioChunk = Math.max(this.streamingMaxAudioChunk, chunk.data.length);
            this.streamingFirstAudio = Math.min(this.streamingFirstAudio, chunk.ts);
            this.streamingAudioEnd = Math.max(this.streamingAudioEnd, chunk.ts + chunk.durationSec);
        }
    }
    addPCMBuffer(buf) {
        this.assertOpen();
        const ch = buf.numberOfChannels;
        const len = buf.length;
        const blockSize = 4096;
        const channels = [];
        if (!Number.isSafeInteger(len) || len < 0 || !Number.isInteger(ch) || ch < 1 || ch > 32767) {
            throw new MediaForgeError('AVI PCM buffer has an invalid shape', 'MUX');
        }
        for (let c = 0; c < ch; c++) {
            const plane = buf.getChannelData(c);
            if (!ArrayBuffer.isView(plane) ||
                Object.prototype.toString.call(plane) !== '[object Float32Array]' ||
                plane.length !== len) {
                throw new MediaForgeError('AVI PCM buffer channel length does not match its frame count', 'MUX');
            }
            channels.push(plane);
        }
        this.validatePCMShape(channels, buf.sampleRate, true);
        for (let off = 0; off < len; off += blockSize) {
            const end = Math.min(off + blockSize, len);
            this.addPCMPlanarChunk(channels.map(channel => channel.subarray(off, end)), buf.sampleRate, off / buf.sampleRate);
        }
    }
    addPCMPlanarChunk(planes, sampleRate, timestamp = 0) {
        this.assertOpen();
        this.validatePCMShape(planes, sampleRate);
        const channels = planes.length;
        const frames = planes[0]?.length ?? 0;
        if (this.observedAudioSampleRate !== undefined && this.observedAudioSampleRate !== sampleRate) {
            throw new MediaForgeError('AVI PCM sample rate changed mid-stream', 'MUX');
        }
        if (this.observedAudioChannels !== undefined && this.observedAudioChannels !== channels) {
            throw new MediaForgeError('AVI PCM channel count changed mid-stream', 'MUX');
        }
        const safeTimestamp = this.isFiniteNonNegative(timestamp) ? timestamp : this.streamingNextAudioTs;
        this.validateEnd(safeTimestamp, frames / sampleRate);
        this.checkPayloadSize(frames * channels * 2);
        if (this.streaming)
            this.checkStreamingCounters(false, frames);
        const pcm = new Int16Array(frames * channels);
        for (let frame = 0; frame < frames; frame++) {
            for (let channel = 0; channel < channels; channel++) {
                const sample = Math.max(-1, Math.min(1, planes[channel][frame]));
                pcm[frame * channels + channel] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
            }
        }
        const data = new Uint8Array(pcm.buffer);
        this.observedAudioSampleRate = sampleRate;
        this.observedAudioChannels = channels;
        if (this.streaming) {
            const duration = frames / sampleRate;
            this.appendStreamingChunk({
                fourcc: this.cfg.video ? '01wb' : '00wb',
                data,
                ts: safeTimestamp,
                durationSec: duration,
                isKey: true,
                sampleFrames: frames,
            });
            this.streamingNextAudioTs = safeTimestamp + duration;
            return;
        }
        this.payloadBytes += data.length + 8;
        this.streamingNextAudioTs = safeTimestamp + frames / sampleRate;
        this.audioChunks.push({
            data,
            timestamp,
            duration: frames / sampleRate,
            isKeyframe: true,
            trackType: 'audio',
        });
    }
    async finalize() {
        this.assertOpen();
        if (this.streaming) {
            await this.finalizeStreaming();
            return;
        }
        const hasV = this.videoChunks.length > 0;
        const hasA = this.audioChunks.length > 0;
        if (!hasV && !hasA) {
            throw new MediaForgeError('Nothing to mux', 'MUX');
        }
        const moviResult = this.buildMovi(hasV, hasA);
        const hdrl = this.buildHdrl(hasV, hasA, moviResult.videoFrames, moviResult.audioSampleFrames, moviResult.maxChunkSize, moviResult.maxVideoChunkSize, moviResult.maxAudioChunkSize, moviResult.avgBytesPerSec, moviResult.videoStartSec, moviResult.audioStartSec);
        const movi = this.wrapList('movi', moviResult.data);
        const idx1 = this.buildIdx1(moviResult.index);
        const riffPayloadSize = 4 + hdrl.length + movi.length + idx1.length;
        const AVI_MAX_RIFF = 0xffffffff;
        if (riffPayloadSize + 8 > AVI_MAX_RIFF) {
            throw new MediaForgeError(`AVI output would be ${riffPayloadSize + 8} bytes; classic AVI stops at 4 GiB ` +
                '(OpenDML/AVIX is not implemented). Use MP4, MKV or a lower bitrate/resolution.', 'MUX');
        }
        const w = new BinaryWriter();
        w.writeASCII('RIFF');
        w.writeU32LE(riffPayloadSize);
        w.writeASCII('AVI ');
        w.writeBytes(hdrl);
        w.writeBytes(movi);
        w.writeBytes(idx1);
        const bytes = w.toUint8Array();
        this.finalized = true;
        this.writeSink(bytes);
        await this.sink.close();
    }
    async finalizeStreaming() {
        const hasV = this.streamingVideoFrames > 0;
        const hasA = this.streamingAudioFrames > 0;
        if (!hasV && !hasA)
            throw new MediaForgeError('Nothing to mux', 'MUX');
        if (!!this.cfg.video !== hasV || !!this.cfg.audio !== hasA) {
            throw new MediaForgeError('AVI finalized without all configured streams', 'MUX');
        }
        const baseStart = Math.min(hasV ? this.streamingFirstVideo : Number.POSITIVE_INFINITY, hasA ? this.streamingFirstAudio : Number.POSITIVE_INFINITY);
        const end = Math.max(hasV ? this.streamingVideoEnd : baseStart, hasA ? this.streamingAudioEnd : baseStart);
        const duration = Math.max(0.001, end - baseStart);
        const hdrl = this.buildHdrl(hasV, hasA, this.streamingVideoFrames, this.streamingAudioFrames, this.streamingMaxChunk, this.streamingMaxVideoChunk, this.streamingMaxAudioChunk, Math.ceil(this.streamingMediaBytes / duration), hasV ? Math.max(0, this.streamingFirstVideo - baseStart) : 0, hasA ? Math.max(0, this.streamingFirstAudio - baseStart) : 0);
        if (hdrl.length !== this.streamingHdrlLength) {
            throw new MediaForgeError(`AVI header layout changed while streaming (${this.streamingHdrlLength} -> ${hdrl.length})`, 'MUX');
        }
        const indexBytes = this.streamingIndex.length * 16;
        const fileSize = 12 + hdrl.length + 12 + this.streamingMoviBytes + 8 + indexBytes;
        if (fileSize > 0xffffffff) {
            throw new MediaForgeError(`AVI output would be ${fileSize} bytes; classic AVI stops at 4 GiB ` +
                '(OpenDML/AVIX is not implemented). Use MP4, MKV or a lower bitrate/resolution.', 'MUX');
        }
        this.finalized = true;
        this.sink.patchAt(this.streamingHdrlOffset, hdrl);
        this.sink.patchAt(this.streamingMoviSizeOffset, this.u32le(4 + this.streamingMoviBytes));
        this.sink.patchAt(4, this.u32le(fileSize - 8));
        const idxHeader = new BinaryWriter();
        idxHeader.writeASCII('idx1');
        idxHeader.writeU32LE(indexBytes);
        this.writeSink(idxHeader.toUint8Array());
        for (const page of this.streamingIndex.encodedPages())
            this.writeSink(page);
        await this.sink.close();
    }
    buildMovi(hasV, hasA) {
        const videoFourCC = '00dc';
        const audioFourCC = hasV ? '01wb' : '00wb';
        const preparedVideo = hasV ? this.prepareVideoChunks(videoFourCC) : [];
        const preparedAudio = hasA ? this.prepareAudioChunks(audioFourCC) : [];
        const firstVideoTs = preparedVideo.length > 0 ? preparedVideo[0].ts : Number.POSITIVE_INFINITY;
        const firstAudioTs = preparedAudio.length > 0 ? preparedAudio[0].ts : Number.POSITIVE_INFINITY;
        const baseStartSec = Number.isFinite(Math.min(firstVideoTs, firstAudioTs))
            ? Math.min(firstVideoTs, firstAudioTs)
            : 0;
        const videoStartSec = preparedVideo.length > 0 ? Math.max(0, preparedVideo[0].ts - baseStartSec) : 0;
        const audioStartSec = preparedAudio.length > 0 ? Math.max(0, preparedAudio[0].ts - baseStartSec) : 0;
        const merged = this.mergePreparedChunks(preparedVideo, preparedAudio);
        const payloadBytes = merged.reduce((total, chunk) => total + 8 + chunk.data.length + (chunk.data.length & 1), 0);
        const headerBytes = 76 + (hasV ? 124 : 0) + (hasA ? 100 : 0);
        this.u32(12 + headerBytes + 12 + payloadBytes + 8 + merged.length * 16, 'file size');
        const w = new BinaryWriter();
        const index = [];
        let maxChunkSize = 0;
        let maxVideoChunkSize = 0;
        let maxAudioChunkSize = 0;
        let videoFrames = 0;
        let audioSampleFrames = 0;
        let totalMediaBytes = 0;
        let videoEndSec = baseStartSec;
        for (const chunk of preparedVideo) {
            videoEndSec = Math.max(videoEndSec, chunk.ts + chunk.durationSec);
        }
        let audioEndSec = baseStartSec;
        for (const chunk of preparedAudio) {
            audioEndSec = Math.max(audioEndSec, chunk.ts + chunk.durationSec);
        }
        for (const m of merged) {
            const offset = w.size;
            w.writeASCII(m.fourcc);
            w.writeU32LE(m.data.length);
            w.writeBytes(m.data);
            if ((m.data.length & 1) !== 0) {
                w.writeU8(0);
            }
            index.push({
                fourcc: m.fourcc,
                flags: m.isKey ? 0x10 : 0,
                offset,
                size: m.data.length,
            });
            totalMediaBytes += m.data.length;
            if (m.data.length > maxChunkSize)
                maxChunkSize = m.data.length;
            if (m.fourcc.endsWith('dc')) {
                videoFrames++;
                if (m.data.length > maxVideoChunkSize)
                    maxVideoChunkSize = m.data.length;
            }
            else if (m.fourcc.endsWith('wb')) {
                audioSampleFrames += m.sampleFrames;
                if (m.data.length > maxAudioChunkSize)
                    maxAudioChunkSize = m.data.length;
            }
        }
        const overallDuration = Math.max(0.001, Math.max(videoEndSec, audioEndSec) - baseStartSec);
        const avgBytesPerSec = Math.ceil(totalMediaBytes / overallDuration);
        return {
            data: w.toUint8Array(),
            videoFrames,
            audioSampleFrames,
            index,
            maxChunkSize,
            maxVideoChunkSize,
            maxAudioChunkSize,
            avgBytesPerSec,
            videoStartSec,
            audioStartSec,
        };
    }
    mergePreparedChunks(video, audio) {
        const merged = [];
        let vi = 0;
        let ai = 0;
        while (vi < video.length || ai < audio.length) {
            if (vi >= video.length) {
                merged.push(audio[ai++]);
                continue;
            }
            if (ai >= audio.length) {
                merged.push(video[vi++]);
                continue;
            }
            const v = video[vi];
            const a = audio[ai];
            if (v.ts <= a.ts) {
                merged.push(v);
                vi++;
            }
            else {
                merged.push(a);
                ai++;
            }
        }
        return merged;
    }
    prepareVideoChunks(fourcc) {
        const tb = this.getVideoRateScale();
        const defaultFrameDur = tb.scale / tb.rate;
        const out = [];
        let nextFallbackTs = 0;
        for (let i = 0; i < this.videoChunks.length; i++) {
            const c = this.videoChunks[i];
            const ts = this.isFiniteNonNegative(c.timestamp) ? c.timestamp : nextFallbackTs;
            const durationSec = this.isFinitePositive(c.duration) ? c.duration : defaultFrameDur;
            const data = this.normalizeH264Chunk(c.data, c.isKeyframe);
            out.push({
                fourcc,
                data,
                ts,
                durationSec,
                isKey: !!c.isKeyframe,
                sampleFrames: 0,
            });
            nextFallbackTs = ts + durationSec;
        }
        return out;
    }
    prepareAudioChunks(fourcc) {
        const sr = this.getAudioSampleRate();
        const out = [];
        let nextFallbackTs = 0;
        for (let i = 0; i < this.audioChunks.length; i++) {
            const c = this.audioChunks[i];
            const sampleFrames = this.getAudioChunkSampleFrames(c);
            const fallbackDur = sampleFrames > 0 ? sampleFrames / sr : 0;
            const ts = this.isFiniteNonNegative(c.timestamp) ? c.timestamp : nextFallbackTs;
            const durationSec = this.isFinitePositive(c.duration) ? c.duration : fallbackDur;
            out.push({
                fourcc,
                data: c.data,
                ts,
                durationSec,
                isKey: true,
                sampleFrames,
            });
            nextFallbackTs = ts + durationSec;
        }
        return out;
    }
    buildIdx1(entries) {
        const w = new BinaryWriter();
        w.writeASCII('idx1');
        w.writeU32LE(entries.length * 16);
        for (const e of entries) {
            w.writeASCII(e.fourcc);
            w.writeU32LE(e.flags);
            w.writeU32LE(e.offset + 4);
            w.writeU32LE(e.size);
        }
        return w.toUint8Array();
    }
    buildHdrl(hasV, hasA, videoFrames, audioSampleFrames, maxChunkSize, maxVideoChunkSize, maxAudioChunkSize, avgBytesPerSec, videoStartSec, audioStartSec) {
        const avih = this.buildAvih(hasV, hasA, videoFrames, maxChunkSize, avgBytesPerSec);
        const content = new BinaryWriter();
        content.writeBytes(avih);
        if (hasV) {
            content.writeBytes(this.buildVideoStream(videoFrames, maxVideoChunkSize, videoStartSec));
        }
        if (hasA) {
            content.writeBytes(this.buildAudioStream(audioSampleFrames, maxAudioChunkSize, audioStartSec));
        }
        return this.wrapList('hdrl', content.toUint8Array());
    }
    buildAvih(hasV, hasA, videoFrames, maxChunkSize, avgBytesPerSec) {
        const tb = this.getVideoRateScale();
        const streamCount = (hasV ? 1 : 0) + (hasA ? 1 : 0);
        const width = hasV ? this.getVideoWidth() : 0;
        const height = hasV ? this.getVideoHeight() : 0;
        this.u32(videoFrames, 'video frame count');
        this.u32(avgBytesPerSec, 'average byte rate');
        const w = new BinaryWriter();
        w.writeU32LE(hasV ? Math.round((1_000_000 * tb.scale) / tb.rate) : 0);
        w.writeU32LE(avgBytesPerSec);
        w.writeU32LE(0);
        w.writeU32LE(0x10 | (hasV && hasA && !this.streaming ? 0x100 : 0));
        w.writeU32LE(hasV ? videoFrames : 0);
        w.writeU32LE(0);
        w.writeU32LE(streamCount);
        w.writeU32LE(maxChunkSize);
        w.writeU32LE(width);
        w.writeU32LE(height);
        w.writeZeros(16);
        return this.wrapChunk('avih', w.toUint8Array());
    }
    buildVideoStream(frameCount, maxVideoChunkSize, videoStartSec) {
        const tb = this.getVideoRateScale();
        const vw = this.getVideoWidth();
        const vh = this.getVideoHeight();
        const videoStartUnits = Math.max(0, Math.round((videoStartSec * tb.rate) / tb.scale));
        this.u32(videoStartUnits, 'video start');
        this.u32(frameCount, 'video frame count');
        const strh = new BinaryWriter();
        strh.writeASCII('vids');
        strh.writeASCII('H264');
        strh.writeU32LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        strh.writeU32LE(0);
        strh.writeU32LE(tb.scale);
        strh.writeU32LE(tb.rate);
        strh.writeU32LE(videoStartUnits);
        strh.writeU32LE(frameCount);
        strh.writeU32LE(maxVideoChunkSize);
        strh.writeU32LE(0xffffffff);
        strh.writeU32LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(vw);
        strh.writeU16LE(vh);
        const strf = new BinaryWriter();
        strf.writeU32LE(40);
        strf.writeU32LE(vw);
        strf.writeU32LE(vh);
        strf.writeU16LE(1);
        strf.writeU16LE(24);
        strf.writeASCII('H264');
        strf.writeU32LE(0);
        strf.writeU32LE(0);
        strf.writeU32LE(0);
        strf.writeU32LE(0);
        strf.writeU32LE(0);
        const content = new BinaryWriter();
        content.writeBytes(this.wrapChunk('strh', strh.toUint8Array()));
        content.writeBytes(this.wrapChunk('strf', strf.toUint8Array()));
        return this.wrapList('strl', content.toUint8Array());
    }
    buildAudioStream(sampleFrames, maxAudioChunkSize, audioStartSec) {
        const sr = this.getAudioSampleRate();
        const ch = this.getAudioChannelCount();
        const blockAlign = this.getAudioBlockAlign();
        const bytesPerSec = this.getAudioBytesPerSec();
        const audioStartUnits = Math.max(0, Math.round(audioStartSec * sr));
        this.u32(audioStartUnits, 'audio start');
        this.u32(sampleFrames, 'audio sample count');
        const strh = new BinaryWriter();
        strh.writeASCII('auds');
        strh.writeU32LE(0);
        strh.writeU32LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        strh.writeU32LE(0);
        strh.writeU32LE(blockAlign);
        strh.writeU32LE(bytesPerSec);
        strh.writeU32LE(audioStartUnits);
        strh.writeU32LE(sampleFrames);
        strh.writeU32LE(maxAudioChunkSize);
        strh.writeU32LE(0xffffffff);
        strh.writeU32LE(blockAlign);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        strh.writeU16LE(0);
        const strf = new BinaryWriter();
        strf.writeU16LE(0x0001);
        strf.writeU16LE(ch);
        strf.writeU32LE(sr);
        strf.writeU32LE(bytesPerSec);
        strf.writeU16LE(blockAlign);
        strf.writeU16LE(16);
        const content = new BinaryWriter();
        content.writeBytes(this.wrapChunk('strh', strh.toUint8Array()));
        content.writeBytes(this.wrapChunk('strf', strf.toUint8Array()));
        return this.wrapList('strl', content.toUint8Array());
    }
    wrapChunk(fourcc, data) {
        const w = new BinaryWriter();
        w.writeASCII(fourcc);
        w.writeU32LE(data.length);
        w.writeBytes(data);
        if ((data.length & 1) !== 0) {
            w.writeU8(0);
        }
        return w.toUint8Array();
    }
    wrapList(fourcc, data) {
        const w = new BinaryWriter();
        const listSize = data.length + 4;
        w.writeASCII('LIST');
        w.writeU32LE(listSize);
        w.writeASCII(fourcc);
        w.writeBytes(data);
        if ((listSize & 1) !== 0) {
            w.writeU8(0);
        }
        return w.toUint8Array();
    }
    getVideoRateScale() {
        const fps = this.getConfiguredOrEstimatedVideoFps();
        const result = this.fpsToAviRateScale(fps);
        this.u32(result.rate, 'video rate');
        this.u32(result.scale, 'video scale');
        this.u32(Math.round((1_000_000 * result.scale) / result.rate), 'frame duration');
        return result;
    }
    getConfiguredOrEstimatedVideoFps() {
        const cfgFps = this.cfg.video?.framerate;
        if (typeof cfgFps === 'number' && Number.isFinite(cfgFps) && cfgFps > 0) {
            return cfgFps;
        }
        const estimated = this.estimateVideoFpsFromChunks();
        if (estimated && Number.isFinite(estimated) && estimated > 0) {
            return estimated;
        }
        return 30;
    }
    estimateVideoFpsFromChunks() {
        if (this.videoChunks.length >= 2) {
            const deltas = [];
            for (let i = 1; i < this.videoChunks.length; i++) {
                const dt = this.videoChunks[i].timestamp - this.videoChunks[i - 1].timestamp;
                if (Number.isFinite(dt) && dt > 0 && dt < 10) {
                    deltas.push(dt);
                }
            }
            if (deltas.length > 0) {
                deltas.sort((a, b) => a - b);
                const median = deltas[deltas.length >> 1];
                if (median > 0)
                    return 1 / median;
            }
        }
        const durations = [];
        for (const c of this.videoChunks) {
            if (Number.isFinite(c.duration) && c.duration > 0 && c.duration < 10) {
                durations.push(c.duration);
            }
        }
        if (durations.length > 0) {
            durations.sort((a, b) => a - b);
            const median = durations[durations.length >> 1];
            if (median > 0)
                return 1 / median;
        }
        return undefined;
    }
    fpsToAviRateScale(fps) {
        if (!Number.isFinite(fps) || fps <= 0) {
            return { rate: 30, scale: 1 };
        }
        const common = [
            { fps: 24000 / 1001, rate: 24000, scale: 1001 },
            { fps: 30000 / 1001, rate: 30000, scale: 1001 },
            { fps: 60000 / 1001, rate: 60000, scale: 1001 },
            { fps: 120000 / 1001, rate: 120000, scale: 1001 },
            { fps: 24, rate: 24, scale: 1 },
            { fps: 25, rate: 25, scale: 1 },
            { fps: 30, rate: 30, scale: 1 },
            { fps: 50, rate: 50, scale: 1 },
            { fps: 60, rate: 60, scale: 1 },
        ];
        for (const c of common) {
            if (Math.abs(fps - c.fps) < 0.01) {
                return { rate: c.rate, scale: c.scale };
            }
        }
        const scale = 1_000_000;
        const rate = Math.max(1, Math.round(fps * scale));
        if (!Number.isSafeInteger(rate))
            throw new MediaForgeError('AVI frame rate exceeds the supported range', 'MUX');
        const g = this.gcd(rate, scale);
        return {
            rate: Math.floor(rate / g),
            scale: Math.floor(scale / g),
        };
    }
    gcd(a, b) {
        a = Math.abs(Math.trunc(a));
        b = Math.abs(Math.trunc(b));
        while (b !== 0) {
            const t = a % b;
            a = b;
            b = t;
        }
        return a || 1;
    }
    getVideoWidth() {
        return this.cfg.video?.width ?? 1920;
    }
    getVideoHeight() {
        return this.cfg.video?.height ?? 1080;
    }
    getAudioSampleRate() {
        return this.cfg.audio?.sampleRate ?? this.observedAudioSampleRate ?? 48000;
    }
    getAudioChannelCount() {
        return this.cfg.audio?.channelCount ?? this.observedAudioChannels ?? 2;
    }
    getAudioBlockAlign() {
        return this.getAudioChannelCount() * 2;
    }
    getAudioBytesPerSec() {
        return this.getAudioSampleRate() * this.getAudioBlockAlign();
    }
    getAudioChunkSampleFrames(c) {
        const blockAlign = this.getAudioBlockAlign();
        if (blockAlign > 0 && c.data.length >= blockAlign) {
            return Math.floor(c.data.length / blockAlign);
        }
        const sr = this.getAudioSampleRate();
        if (this.isFinitePositive(c.duration)) {
            return Math.max(0, Math.round(c.duration * sr));
        }
        return 0;
    }
    prepareCodecConfig(cfg) {
        this.validateBytes(cfg);
        const parsed = cfg[0] === 1 ? this.parseAvcDecoderConfigurationRecord(cfg) : null;
        if (parsed)
            return parsed;
        if (isAnnexB(cfg) && this.chunkHasSpsPps(cfg)) {
            return { nalLengthSize: 0, annexBConfig: new Uint8Array(cfg) };
        }
        throw new MediaForgeError('AVI AVC decoder configuration is malformed', 'MUX');
    }
    normalizeH264Chunk(data, isKeyframe, config) {
        let out = data;
        const nalLengthSize = (config?.nalLengthSize ?? this.nalLengthSize) || this.guessAvccNalLengthSize(out) || 0;
        if (nalLengthSize >= 1 && nalLengthSize <= 4 && isValidAvccWalk(out, nalLengthSize)) {
            const converted = this.convertAvccSampleToAnnexB(out, nalLengthSize);
            if (!converted) {
                throw new MediaForgeError('Failed to convert H.264 sample from AVCC to Annex B.', 'MUX');
            }
            out = converted;
        }
        else if (!isAnnexB(out)) {
            throw new MediaForgeError('H.264 chunk is neither a coherent AVCC sequence nor Annex-B framed. ' +
                'Pass codec config to addVideoChunk(), or configure encoder for Annex B output.', 'MUX');
        }
        const annexBConfig = config?.annexBConfig ?? this.annexBCodecConfig;
        if (isKeyframe && annexBConfig && !this.chunkHasSpsPps(out)) {
            out = this.concatBytes(annexBConfig, out);
        }
        return out;
    }
    parseAvcDecoderConfigurationRecord(data) {
        if (data.length < 7)
            return null;
        if (data[0] !== 1)
            return null;
        const nalLengthSize = (data[4] & 0x03) + 1;
        let pos = 5;
        const spsCount = data[pos++] & 0x1f;
        if (spsCount === 0)
            return null;
        const parts = [];
        for (let i = 0; i < spsCount; i++) {
            if (pos + 2 > data.length)
                return null;
            const len = (data[pos] << 8) | data[pos + 1];
            pos += 2;
            if (len === 0 || pos + len > data.length || (data[pos] & 0x9f) !== 7)
                return null;
            parts.push(AVIMuxer.START_CODE, data.subarray(pos, pos + len));
            pos += len;
        }
        if (pos + 1 > data.length)
            return null;
        const ppsCount = data[pos++];
        if (ppsCount === 0)
            return null;
        for (let i = 0; i < ppsCount; i++) {
            if (pos + 2 > data.length)
                return null;
            const len = (data[pos] << 8) | data[pos + 1];
            pos += 2;
            if (len === 0 || pos + len > data.length || (data[pos] & 0x9f) !== 8)
                return null;
            parts.push(AVIMuxer.START_CODE, data.subarray(pos, pos + len));
            pos += len;
        }
        if (parts.length === 0)
            return null;
        return {
            nalLengthSize,
            annexBConfig: this.concatMany(parts),
        };
    }
    guessAvccNalLengthSize(data) {
        for (const n of [4, 2, 1]) {
            if (this.looksLikeAvccSample(data, n))
                return n;
        }
        return undefined;
    }
    looksLikeAvccSample(data, nalLengthSize) {
        let pos = 0;
        let sawNal = false;
        while (pos + nalLengthSize <= data.length) {
            let len = 0;
            for (let i = 0; i < nalLengthSize; i++) {
                len = (len << 8) | data[pos + i];
            }
            pos += nalLengthSize;
            if (len <= 0 || pos + len > data.length)
                return false;
            const nalType = data[pos] & 0x1f;
            if (nalType === 0 || nalType > 31)
                return false;
            pos += len;
            sawNal = true;
        }
        return sawNal && pos === data.length;
    }
    convertAvccSampleToAnnexB(data, nalLengthSize) {
        let pos = 0;
        const parts = [];
        while (pos + nalLengthSize <= data.length) {
            let len = 0;
            for (let i = 0; i < nalLengthSize; i++) {
                len = (len << 8) | data[pos + i];
            }
            pos += nalLengthSize;
            if (len <= 0 || pos + len > data.length)
                return null;
            parts.push(AVIMuxer.START_CODE, data.subarray(pos, pos + len));
            pos += len;
        }
        if (pos !== data.length)
            return null;
        return this.concatMany(parts);
    }
    chunkHasSpsPps(data) {
        let foundSps = false;
        let foundPps = false;
        let pos = 0;
        while (true) {
            const cur = this.findStartCode(data, pos);
            if (!cur)
                break;
            const nalStart = cur.index + cur.length;
            const next = this.findStartCode(data, nalStart);
            const nalEnd = next ? next.index : data.length;
            if (nalStart < nalEnd) {
                const nalType = data[nalStart] & 0x1f;
                if (nalType === 7)
                    foundSps = true;
                if (nalType === 8)
                    foundPps = true;
                if (foundSps && foundPps)
                    return true;
            }
            pos = nalEnd;
        }
        return false;
    }
    findStartCode(data, from) {
        for (let i = from; i + 3 < data.length; i++) {
            if (data[i] === 0x00 && data[i + 1] === 0x00) {
                if (data[i + 2] === 0x01) {
                    return { index: i, length: 3 };
                }
                if (data[i + 2] === 0x00 && data[i + 3] === 0x01) {
                    return { index: i, length: 4 };
                }
            }
        }
        return null;
    }
    concatBytes(a, b) {
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    }
    concatMany(parts) {
        let total = 0;
        for (const p of parts)
            total += p.length;
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of parts) {
            out.set(p, off);
            off += p.length;
        }
        return out;
    }
    isFinitePositive(v) {
        return typeof v === 'number' && Number.isFinite(v) && v > 0;
    }
    isFiniteNonNegative(v) {
        return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    }
}
