import { BlobSource } from '../io/sources.js';
import { ChunkReader } from '../io/chunk-reader.js';
import { demuxAssert, DEMUX_LIMITS, DemuxIndexBudget, resolveDemuxBudget, yieldEventLoop, } from '../core/demux-guard.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { parseWaveFormat, MAX_WAVE_FORMAT_BYTES } from '../core/wave-format.js';
import { AVIAVCReader, MAX_AVI_AVC_CONFIG_BYTES } from '../core/avi-avc.js';
import { DiagnosticContext } from '../core/diagnostics.js';
export class AVIDemuxer {
    limits;
    recoverPackets;
    diagnosticOptions;
    constructor(options = {}) {
        this.limits = resolveDemuxBudget(options);
        const { aviRecovery, validation, metadataPolicy, onWarning, maxWarnings } = options;
        if (aviRecovery !== undefined && aviRecovery !== 'complete-packets')
            throw new MediaForgeError('aviRecovery must be complete-packets when provided', 'INPUT');
        this.recoverPackets = aviRecovery === 'complete-packets';
        this.diagnosticOptions = { validation, metadataPolicy, onWarning, maxWarnings };
    }
    async demux(input, signal, diagnostics = new DiagnosticContext(this.diagnosticOptions, this.recoverPackets ? 'compatible' : 'strict')) {
        try {
            return await this.demuxImpl(input, signal, diagnostics);
        }
        catch (e) {
            if (e instanceof RangeError) {
                throw new DemuxError(`Malformed input: structure reads out of bounds (${e.message})`);
            }
            throw e;
        }
    }
    async demuxImpl(input, signal, diagnostics) {
        const budget = new DemuxIndexBudget(this.limits);
        const source = input instanceof Blob ? new BlobSource(input) : input;
        const reader = new ChunkReader(source);
        const size = reader.size;
        const recoverPackets = this.recoverPackets && diagnostics.validation !== 'strict';
        let incomplete = false;
        const truncated = (code, message, offset) => {
            demuxAssert(recoverPackets, message);
            incomplete = true;
            diagnostics.warn({ code, message, offset, format: 'avi' });
        };
        const truncatedHeader = (pos, end) => {
            if (pos + 8 <= Math.min(size, end))
                return false;
            demuxAssert(pos + 8 <= end, 'AVI chunk header overruns its parent');
            truncated('AVI_TRUNCATED_HEADER', 'Discarded an incomplete AVI tail chunk header', pos);
            return true;
        };
        const checkAbort = () => {
            if (signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
        };
        checkAbort();
        const head = await reader.bytes(0, Math.min(size, 12));
        if (head.length < 12 || this.fourcc(head, 0) !== 'RIFF' || this.fourcc(head, 8) !== 'AVI ') {
            throw new DemuxError('Not an AVI file');
        }
        let videoCodec = '';
        let width = 0, height = 0, videoTick = 1 / 30, videoStart = 0, videoUnits = 0, videoExpectedUnits = 0;
        let sampleRate = 44100, channelCount = 2;
        let audioTick = 0, audioStart = 0, audioSampleSize = 0, audioBlockAlign = 0, audioUnits = 0;
        let codecConfig;
        let avc;
        let audioCodecConfig;
        let videoStreamIdx = -1;
        let audioStreamIdx = -1;
        const videoSamples = [];
        const videoOrder = [];
        const audioSamples = [];
        const maxChunks = Math.floor(size / 8) + 1;
        let chunks = 0;
        let mappedVideoCodec = '';
        let mappedAudioCodec = '';
        let headerParsed = false;
        const readChunk = async (pos, end, allowTail = false) => {
            if ((chunks & 0x0fff) === 0)
                await yieldEventLoop();
            if ((chunks & 0x03ff) === 0)
                checkAbort();
            demuxAssert(++chunks <= maxChunks, `AVI chunk count implausible for a ${size}-byte file`);
            demuxAssert(pos + 8 <= end, 'AVI chunk header overruns its parent');
            const head = await reader.bytes(pos, 8);
            const id = this.fourcc(head, 0);
            const length = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true);
            const data = pos + 8;
            const chunkEnd = data + length;
            const next = chunkEnd + (length & 1);
            demuxAssert(next <= end, 'AVI chunk overruns its parent');
            if (next > size) {
                demuxAssert(allowTail, 'AVI header chunk is truncated');
                const container = id === 'LIST' || id === 'RIFF';
                truncated(container ? 'AVI_TRUNCATED_CONTAINER' : 'AVI_TRUNCATED_CHUNK', container
                    ? `AVI ${id} extends beyond the available source; inspecting complete child chunks`
                    : chunkEnd <= size
                        ? 'AVI tail chunk is missing its padding byte; retained its complete payload'
                        : 'Discarded an incomplete AVI tail chunk payload', pos);
            }
            let type = '';
            if (id === 'LIST' || id === 'RIFF') {
                demuxAssert(length >= 4, 'AVI list is missing its type');
                if (data + 4 <= size)
                    type = this.fourcc(await reader.bytes(data, 4), 0);
            }
            return { id, type, size: length, data, end: chunkEnd, next };
        };
        let riffPos = 0;
        while (riffPos + 12 <= size) {
            checkAbort();
            if (riffPos > 0) {
                const next = await reader.bytes(riffPos, 12);
                if (this.fourcc(next, 0) !== 'RIFF' || this.fourcc(next, 8) !== 'AVIX')
                    break;
            }
            const riff = await readChunk(riffPos, recoverPackets ? Number.MAX_SAFE_INTEGER : size, true);
            let pos = riff.data + 4;
            while (pos < Math.min(riff.end, size)) {
                if (truncatedHeader(pos, riff.end))
                    break;
                const ck = await readChunk(pos, riff.end, true);
                if (ck.id === 'LIST' && ck.type === 'hdrl') {
                    demuxAssert(ck.end <= size, 'AVI stream headers are truncated');
                    await this.parseHdrl(reader, readChunk, ck.data + 4, ck.end, info => {
                        if (info.type === 'video' && videoStreamIdx < 0) {
                            videoStreamIdx = info.streamIndex;
                            videoCodec = info.codec;
                            width = info.width;
                            height = info.height;
                            videoTick = info.scale / info.rate;
                            videoStart = info.start;
                            videoExpectedUnits = info.length;
                            codecConfig = info.codecConfig;
                        }
                        else if (info.type === 'audio' && audioStreamIdx < 0) {
                            audioStreamIdx = info.streamIndex;
                            mappedAudioCodec = info.codec || this.mapAudioFormat(info.audioFormat);
                            sampleRate = info.sampleRate;
                            channelCount = info.channelCount;
                            audioTick = info.scale / info.rate;
                            audioStart = info.start;
                            audioSampleSize = info.sampleSize;
                            audioBlockAlign = info.blockAlign ?? 0;
                            audioCodecConfig = info.codecConfig;
                        }
                    });
                    if (!headerParsed) {
                        headerParsed = true;
                        if (videoStreamIdx >= 0)
                            mappedVideoCodec = this.mapVideoCodec(videoCodec);
                        if (mappedVideoCodec.startsWith('avc'))
                            avc = new AVIAVCReader(codecConfig);
                    }
                }
                else if (ck.id === 'LIST' && ck.type === 'movi') {
                    let moviPos = ck.data + 4;
                    let moviEnd = ck.end;
                    const parents = [];
                    while (moviPos < Math.min(moviEnd, size) || parents.length > 0) {
                        if (moviPos >= Math.min(moviEnd, size)) {
                            const parent = parents.pop();
                            moviPos = parent.next;
                            moviEnd = parent.end;
                            continue;
                        }
                        if (truncatedHeader(moviPos, moviEnd))
                            break;
                        const ch = await readChunk(moviPos, moviEnd, true);
                        if (ch.end > size && !(ch.id === 'LIST' && ch.type === 'rec '))
                            break;
                        const stream = parseMoviChunkId(ch.id);
                        if (stream &&
                            stream.index === videoStreamIdx &&
                            (stream.kind === 'dc' || stream.kind === 'db')) {
                            const timestamp = (videoStart + videoUnits++) * videoTick;
                            if (ch.size === 0) {
                                const previous = videoSamples[videoSamples.length - 1];
                                if (previous)
                                    previous.duration = timestamp + videoTick - previous.timestamp;
                            }
                            else {
                                budget.reserveSamples(1, avc ? 384 : 256, 'AVI sample index');
                                const inspection = avc
                                    ? await avc.inspect(reader, ch.data, ch.size, checkAbort)
                                    : undefined;
                                const sample = {
                                    offset: ch.data,
                                    size: ch.size,
                                    timestamp,
                                    duration: videoTick,
                                    isKeyframe: inspection?.isKeyframe ?? stream.kind === 'db',
                                };
                                if (inspection) {
                                    sample.nalUnitFormat = inspection.annexB ? 'annexb' : 'avcc';
                                    sample.decodeTimestamp = timestamp;
                                    if (inspection.pictureOrder)
                                        videoOrder.push({ sample, order: inspection.pictureOrder });
                                }
                                videoSamples.push(sample);
                            }
                        }
                        else if (stream && stream.index === audioStreamIdx && stream.kind === 'wb') {
                            budget.reserveSamples(1, 256, 'AVI sample index');
                            if (audioBlockAlign > 0)
                                demuxAssert(ch.size > 0 && ch.size % audioBlockAlign === 0, 'AVI PCM chunks must contain complete channel frames');
                            const units = audioSampleSize > 0 ? ch.size / audioSampleSize : 1;
                            audioSamples.push({
                                offset: ch.data,
                                size: ch.size,
                                timestamp: (audioStart + audioUnits) * audioTick,
                                duration: units * audioTick,
                                isKeyframe: true,
                            });
                            audioUnits += units;
                        }
                        else if (ch.id === 'LIST' && ch.type === 'rec ') {
                            demuxAssert(parents.length < DEMUX_LIMITS.maxBoxDepth, 'AVI record nesting exceeds limit');
                            parents.push({ end: moviEnd, next: ch.next });
                            moviPos = ch.data + 4;
                            moviEnd = ch.end;
                            continue;
                        }
                        moviPos = ch.next;
                    }
                }
                pos = ck.next;
            }
            riffPos = riff.next;
        }
        checkAbort();
        demuxAssert(!incomplete || headerParsed, 'AVI recovery requires complete stream headers');
        if (recoverPackets && !incomplete && videoUnits < videoExpectedUnits)
            truncated('AVI_TRUNCATED_STREAM', `AVI contains ${videoUnits} of its ${videoExpectedUnits} declared video slots; retained available complete packets`, size);
        if (incomplete && avc) {
            demuxAssert(avc.codecConfig, 'AVI H.264 recovery requires complete SPS/PPS configuration');
            if (videoExpectedUnits === 0 || videoUnits !== videoExpectedUnits) {
                let lastIdr = 0;
                for (let index = 0; index < videoSamples.length; index++)
                    if (videoSamples[index].isKeyframe)
                        lastIdr = index;
                const offset = videoSamples[lastIdr]?.offset ?? 0;
                const tail = videoOrder.filter(({ sample }) => sample.offset >= offset);
                const noReordering = tail.length > 0 &&
                    tail.every(({ order }, index) => order.noReordering &&
                        (index === 0 ||
                            order.epoch !== tail[index - 1].order.epoch ||
                            order.poc > tail[index - 1].order.poc));
                if (!noReordering) {
                    const dropped = videoSamples.length - lastIdr;
                    videoSamples.length = lastIdr;
                    while (videoOrder.length && videoOrder[videoOrder.length - 1].sample.offset >= offset)
                        videoOrder.pop();
                    diagnostics.warn({
                        code: 'AVI_UNRESOLVED_TIMING',
                        message: `Discarded ${dropped} complete AVI H.264 tail packets because the final GOP has unresolved presentation timing`,
                        format: 'avi',
                        offset,
                    });
                    demuxAssert(videoSamples.length > 0, 'AVI H.264 truncated tail has no complete IDR-delimited GOP with reliable presentation timing');
                }
            }
        }
        await restoreAVCPresentation(videoOrder, checkAbort);
        let videoEnd = 0;
        for (const sample of videoSamples)
            videoEnd = Math.max(videoEnd, sample.timestamp + sample.duration);
        const audioEnd = audioSamples.length > 0
            ? audioSamples[audioSamples.length - 1].timestamp + audioSamples[audioSamples.length - 1].duration
            : 0;
        const result = { videoTracks: [], audioTracks: [] };
        demuxAssert(videoStreamIdx < 0 || videoSamples.length > 0, 'AVI declares a video stream but no video chunks were found');
        demuxAssert(audioStreamIdx < 0 || audioSamples.length > 0, 'AVI declares an audio stream but no audio chunks were found');
        if (videoSamples.length > 0) {
            if (avc) {
                codecConfig = avc.codecConfig;
                mappedVideoCodec = avc.codec ?? mappedVideoCodec;
            }
            result.videoTracks.push({
                codec: mappedVideoCodec,
                width: width || 1920,
                height: height || 1080,
                sampleRate: 0,
                channelCount: 0,
                duration: videoEnd,
                samples: videoSamples,
                codecConfig,
                ...(incomplete ? { incomplete: true } : {}),
            });
        }
        if (audioSamples.length > 0) {
            result.audioTracks.push({
                codec: mappedAudioCodec,
                width: 0,
                height: 0,
                sampleRate,
                channelCount,
                duration: audioEnd,
                samples: audioSamples,
                codecConfig: audioCodecConfig,
                ...(incomplete ? { incomplete: true } : {}),
            });
        }
        logger.info(`[AVIDemuxer] video=${videoSamples.length}, audio=${audioSamples.length}`);
        return result;
    }
    fourcc(buf, off) {
        return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
    }
    async parseHdrl(reader, readChunk, start, end, cb) {
        let pos = start;
        let strlIndex = 0;
        while (pos < end) {
            const ck = await readChunk(pos, end);
            if (ck.id === 'LIST' && ck.type === 'strl') {
                await this.parseStrl(reader, readChunk, ck.data + 4, ck.end, strlIndex++, cb);
            }
            pos = ck.next;
        }
    }
    async parseStrl(reader, readChunk, start, end, streamIndex, cb) {
        let pos = start;
        let strhType = '';
        let fccHandler = '';
        let rate = 0, scale = 0, streamStart = 0, streamLength = 0, sampleSize = 0;
        while (pos < end) {
            const ck = await readChunk(pos, end);
            if (ck.id === 'strh') {
                demuxAssert(ck.size >= 48, 'AVI stream header is truncated');
                const data = await reader.bytes(ck.data, 48);
                const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
                strhType = this.fourcc(data, 0);
                fccHandler = this.fourcc(data, 4);
                scale = dv.getUint32(20, true);
                rate = dv.getUint32(24, true);
                streamStart = dv.getUint32(28, true);
                streamLength = dv.getUint32(32, true);
                sampleSize = dv.getUint32(44, true);
            }
            else if (ck.id === 'strf' && (strhType === 'vids' || strhType === 'auds')) {
                demuxAssert(rate > 0 && scale > 0, 'AVI stream time base must be positive');
                demuxAssert(ck.size >= (strhType === 'vids' ? 40 : 14), 'AVI stream format is truncated');
                const data = await reader.bytes(ck.data, strhType === 'vids' ? 40 : 14);
                const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
                if (strhType === 'vids') {
                    const w = dv.getInt32(4, true);
                    const h = Math.abs(dv.getInt32(8, true));
                    const codec = this.fourcc(data, 16);
                    let videoConfig;
                    if (ck.size > 40 && isAvcFourcc(codec || fccHandler)) {
                        demuxAssert(ck.size - 40 <= MAX_AVI_AVC_CONFIG_BYTES, 'AVI H.264 configuration exceeds its size limit');
                        videoConfig = (await reader.bytes(ck.data + 40, ck.size - 40)).slice();
                    }
                    cb({
                        streamIndex,
                        type: 'video',
                        codec: codec || fccHandler,
                        width: w,
                        height: h,
                        rate,
                        scale,
                        start: streamStart,
                        length: streamLength,
                        sampleSize,
                        audioFormat: 0,
                        sampleRate: 0,
                        channelCount: 0,
                        codecConfig: videoConfig,
                    });
                }
                else {
                    const audioFmt = dv.getUint16(0, true);
                    const ch = dv.getUint16(2, true);
                    const sr = dv.getUint32(4, true);
                    demuxAssert(sr > 0, 'AVI audio sample rate must be positive');
                    demuxAssert(ch > 0, 'AVI audio channel count must be positive');
                    let audioConfig;
                    let pcmCodec = '';
                    let blockAlign;
                    if (audioFmt === 1 || audioFmt === 3 || audioFmt === 0xfffe) {
                        demuxAssert(ck.size >= 16, 'AVI PCM format is truncated');
                        demuxAssert(ck.size <= MAX_WAVE_FORMAT_BYTES, 'AVI PCM format exceeds its size limit');
                        let wave;
                        try {
                            wave = parseWaveFormat(await reader.bytes(ck.data, ck.size));
                        }
                        catch (error) {
                            throw new DemuxError(`Malformed AVI PCM format: ${error instanceof Error ? error.message : String(error)}`);
                        }
                        audioConfig = wave.codecConfig;
                        blockAlign = wave.blockAlign;
                        pcmCodec = wave.codec === 'pcm' ? 'pcm-s16le' : wave.codec;
                        demuxAssert(sampleSize === blockAlign && scale * sr === rate, 'AVI PCM stream sample size or time base is inconsistent');
                    }
                    cb({
                        streamIndex,
                        type: 'audio',
                        codec: pcmCodec,
                        width: 0,
                        height: 0,
                        rate,
                        scale,
                        start: streamStart,
                        length: streamLength,
                        sampleSize,
                        audioFormat: audioFmt,
                        sampleRate: sr,
                        channelCount: ch,
                        codecConfig: audioConfig,
                        blockAlign,
                    });
                }
            }
            pos = ck.next;
        }
    }
    mapVideoCodec(fourcc) {
        const uc = fourcc.toUpperCase().trim();
        if (isAvcFourcc(uc))
            return 'avc1.640028';
        if (uc === 'HEVC' || uc === 'H265' || uc === 'HVC1' || uc === 'X265')
            return 'hev1.1.6.L93.B0';
        if (uc === 'VP8\0' || uc === 'VP80')
            return 'vp8';
        if (uc === 'VP9\0' || uc === 'VP90')
            return 'vp9';
        if (uc === 'MJPG')
            return 'mjpeg';
        const legacy = new Set(['XVID', 'DIVX', 'DIV3', 'DIV4', 'DX50', 'MP42', 'MP43', 'MP4V', 'FMP4', '3IV2']);
        if (legacy.has(uc)) {
            throw new DemuxError(`AVI video codec '${uc}' (MPEG-4 Part 2 family) is not supported; supported: H.264, HEVC, VP8, VP9, MJPEG`);
        }
        throw new DemuxError(`AVI video codec '${uc}' is not supported; supported: H.264, HEVC, VP8, VP9, MJPEG`);
    }
    mapAudioFormat(tag) {
        switch (tag) {
            case 0x0055:
                return 'mp3';
            case 0x0050:
                return 'mp2';
            case 0x00ff:
                return 'mp4a.40.2';
            case 0x2000:
                return 'ac-3';
            default:
                throw new DemuxError(`AVI audio format 0x${tag.toString(16).padStart(4, '0')} is not supported ` +
                    '(supported: PCM 0x0001/0x0003/0xFFFE, MP3 0x0055, MP2 0x0050, AAC 0x00FF, AC-3 0x2000)');
        }
    }
}
async function restoreAVCPresentation(pictures, checkAbort) {
    for (let start = 0; start < pictures.length;) {
        let end = start + 1;
        while (end < pictures.length && pictures[end].order.epoch === pictures[start].order.epoch)
            end++;
        const ordered = pictures.slice(start, end).sort((a, b) => a.order.poc - b.order.poc);
        const slots = pictures.slice(start, end).map(({ sample }) => [sample.timestamp, sample.duration]);
        for (let index = 0; index < ordered.length; index++) {
            if ((index & 0x0fff) === 0) {
                await yieldEventLoop();
                checkAbort();
            }
            if (index > 0)
                demuxAssert(ordered[index - 1].order.poc !== ordered[index].order.poc, 'AVI H.264 pictures have ambiguous duplicate picture order');
            const sample = ordered[index].sample;
            sample.timestamp = slots[index][0];
            sample.duration = slots[index][1];
            sample.compositionTimeOffset = sample.timestamp - sample.decodeTimestamp;
        }
        start = end;
    }
}
function isAvcFourcc(value) {
    return /^(H264|X264|AVC1|DAVC|VSSH)$/.test(value.toUpperCase().trim());
}
function parseMoviChunkId(id) {
    const d0 = id.charCodeAt(0) - 0x30;
    const d1 = id.charCodeAt(1) - 0x30;
    if (d0 < 0 || d0 > 9 || d1 < 0 || d1 > 9)
        return null;
    const kind = id.slice(2);
    if (kind !== 'dc' && kind !== 'db' && kind !== 'wb')
        return null;
    return { index: d0 * 10 + d1, kind };
}
