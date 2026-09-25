import { BlobSource } from '../io/sources.js';
import { ChunkReader } from '../io/chunk-reader.js';
import { demuxAssert, DemuxIndexBudget, resolveDemuxBudget, yieldEventLoop, } from '../core/demux-guard.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { parseAacAudioSpecificConfig } from '../audio/adts.js';
import { parseH264Sps } from '../core/video-sps.js';
import { parseMpegAudioHeader } from '../core/mpeg-audio-header.js';
export class FLVDemuxer {
    limits;
    constructor(options = {}) {
        this.limits = resolveDemuxBudget(options);
    }
    async demux(input, signal) {
        try {
            return await this.demuxImpl(input, signal);
        }
        catch (e) {
            if (e instanceof RangeError) {
                throw new DemuxError(`Malformed input: structure reads out of bounds (${e.message})`);
            }
            throw e;
        }
    }
    async demuxImpl(input, signal) {
        const budget = new DemuxIndexBudget(this.limits);
        const source = input instanceof Blob ? new BlobSource(input) : input;
        const reader = new ChunkReader(source);
        const size = reader.size;
        const head = await reader.bytes(0, 9);
        if (head.length < 9 || head[0] !== 0x46 || head[1] !== 0x4c || head[2] !== 0x56) {
            throw new DemuxError('Not an FLV file');
        }
        const headerView = new DataView(head.buffer, head.byteOffset, head.byteLength);
        const dataOffset = headerView.getUint32(5, false);
        demuxAssert(dataOffset >= 9 && dataOffset <= size - 4, `invalid FLV data offset ${dataOffset} for ${size}-byte input`);
        const headerFlags = head[4];
        const declaresAudio = !!(headerFlags & 0x04);
        const declaresVideo = !!(headerFlags & 0x01);
        const videoSamples = [];
        const audioSamples = [];
        const videoConfigurations = [];
        const audioConfigurations = [];
        let currentVideoConfigIndex = -1;
        let currentAudioConfigIndex = -1;
        let videoCodec = '';
        let audioCodec = '';
        let width = 0;
        let height = 0;
        let displayWidth = 0;
        let displayHeight = 0;
        let pixelAspectRatioNum = 1;
        let pixelAspectRatioDen = 1;
        let sampleRate = 44100;
        let channelCount = 2;
        let videoCodecConfig;
        let audioCodecConfig;
        let metadataDuration = 0;
        let metadataFrameRate = 0;
        let observedEndTimestamp = 0;
        const maxTags = Math.floor(Math.max(0, size - dataOffset) / 15) + 1024;
        let tags = 0;
        let pos = dataOffset;
        let expectedPreviousTagSize = 0;
        while (true) {
            if ((tags & 0x03ff) === 0 && signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            if ((tags & 0x0fff) === 0)
                await yieldEventLoop();
            demuxAssert(pos + 4 <= size, 'truncated FLV PreviousTagSize at end of file');
            const previousBytes = await reader.bytes(pos, 4);
            const previousTagSize = new DataView(previousBytes.buffer, previousBytes.byteOffset, previousBytes.byteLength).getUint32(0, false);
            demuxAssert(previousTagSize === expectedPreviousTagSize, `FLV PreviousTagSize mismatch: expected ${expectedPreviousTagSize}, got ${previousTagSize}`);
            pos += 4;
            if (pos === size)
                break;
            demuxAssert(++tags <= maxTags, `FLV tag count implausible for a ${size}-byte file`);
            demuxAssert(pos + 11 <= size, 'truncated FLV tag header at end of file');
            const tagHeader = await reader.bytes(pos, 11);
            const tagType = tagHeader[0];
            const dataSize = (tagHeader[1] << 16) | (tagHeader[2] << 8) | tagHeader[3];
            const tsLow = (tagHeader[4] << 16) | (tagHeader[5] << 8) | tagHeader[6];
            const timestampMs = (((tagHeader[7] ?? 0) << 24) | tsLow) >>> 0;
            demuxAssert(tagHeader[8] === 0 && tagHeader[9] === 0 && tagHeader[10] === 0, 'FLV tag has a non-zero StreamID');
            const tagDataOffset = pos + 11;
            demuxAssert(tagDataOffset + dataSize <= size, `truncated FLV tag payload: need ${dataSize} byte(s), only ${Math.max(0, size - tagDataOffset)} remain`);
            observedEndTimestamp = Math.max(observedEndTimestamp, timestampMs / 1000);
            const prefixLength = Math.min(dataSize, 8);
            const pl = prefixLength > 0 ? await reader.bytes(tagDataOffset, prefixLength) : new Uint8Array(0);
            if (tagType === 18 && dataSize > 0) {
                if (dataSize <= 256 * 1024) {
                    const body = await reader.bytes(tagDataOffset, dataSize);
                    const metadata = parseFlvMetadata(body);
                    if (metadata.duration !== undefined &&
                        Number.isFinite(metadata.duration) &&
                        metadata.duration > 0 &&
                        metadata.duration <= 6 * 3600) {
                        metadataDuration = Math.max(metadataDuration, metadata.duration);
                    }
                    if (metadata.framerate !== undefined &&
                        Number.isFinite(metadata.framerate) &&
                        metadata.framerate > 0 &&
                        metadata.framerate <= 1000) {
                        metadataFrameRate = metadata.framerate;
                    }
                }
            }
            else if (tagType === 9 && dataSize > 0) {
                const frameType = (pl[0] >> 4) & 0x0f;
                const codecId = pl[0] & 0x0f;
                if (codecId === 7) {
                    demuxAssert(dataSize >= 5, 'truncated FLV AVC video packet');
                    const avcPacketType = pl[1];
                    if (avcPacketType === 0) {
                        demuxAssert(dataSize > 5, 'empty FLV AVC sequence header');
                        const cfgBytes = await reader.bytes(tagDataOffset + 5, dataSize - 5);
                        const nextConfig = new Uint8Array(cfgBytes);
                        const parsed = this.parseAvcC(nextConfig);
                        demuxAssert(!!parsed, 'invalid AVCDecoderConfigurationRecord in FLV sequence header');
                        if (videoConfigurations.length > 0) {
                            const firstLengthSize = ((videoConfigurations[0].codecConfig[4] ?? 0xff) & 0x03) + 1;
                            const nextLengthSize = ((nextConfig[4] ?? 0xff) & 0x03) + 1;
                            demuxAssert(firstLengthSize === nextLengthSize, `FLV AVC NAL length size changed from ${firstLengthSize} to ${nextLengthSize}`);
                        }
                        currentVideoConfigIndex = findOrAppendConfiguration(videoConfigurations, nextConfig, {
                            codec: parsed.codec,
                            codecConfig: nextConfig,
                            width: parsed.width,
                            height: parsed.height,
                            displayWidth: parsed.displayWidth,
                            displayHeight: parsed.displayHeight,
                            pixelAspectRatioNum: parsed.pixelAspectRatioNum,
                            pixelAspectRatioDen: parsed.pixelAspectRatioDen,
                        });
                        if (!videoCodecConfig) {
                            videoCodecConfig = nextConfig;
                            videoCodec = parsed.codec;
                            width = parsed.width;
                            height = parsed.height;
                            displayWidth = parsed.displayWidth;
                            displayHeight = parsed.displayHeight;
                            pixelAspectRatioNum = parsed.pixelAspectRatioNum;
                            pixelAspectRatioDen = parsed.pixelAspectRatioDen;
                        }
                    }
                    else if (avcPacketType === 1) {
                        demuxAssert(dataSize > 5, 'empty FLV AVC NALU packet');
                        demuxAssert(currentVideoConfigIndex >= 0 && !!videoCodecConfig && !!videoCodec, 'AVC NALU tag appears before a valid sequence header');
                        const cts = (((pl[2] << 16) | (pl[3] << 8) | pl[4]) << 8) >> 8;
                        const pts = (timestampMs + cts) / 1000;
                        budget.reserveSamples(1, 256, 'FLV sample index');
                        videoSamples.push({
                            offset: tagDataOffset + 5,
                            size: dataSize - 5,
                            timestamp: pts,
                            decodeTimestamp: timestampMs / 1000,
                            compositionTimeOffset: cts / 1000,
                            duration: 0,
                            isKeyframe: frameType === 1,
                            codecConfigIndex: currentVideoConfigIndex,
                        });
                    }
                    else if (avcPacketType !== 2) {
                        throw new DemuxError(`unsupported FLV AVC packet type ${avcPacketType}`);
                    }
                }
            }
            else if (tagType === 8 && dataSize > 0) {
                const soundFormat = (pl[0] >> 4) & 0x0f;
                if (soundFormat === 10) {
                    demuxAssert(dataSize >= 2, 'truncated FLV AAC packet');
                    const aacPacketType = pl[1];
                    if (aacPacketType === 0) {
                        demuxAssert(dataSize > 2, 'empty FLV AAC sequence header');
                        const cfgBytes = await reader.bytes(tagDataOffset + 2, dataSize - 2);
                        const nextConfig = new Uint8Array(cfgBytes);
                        const parsed = parseAacAudioSpecificConfig(nextConfig);
                        demuxAssert(!!parsed, 'invalid AAC AudioSpecificConfig in FLV sequence header');
                        demuxAssert(parsed.sampleRate > 0, 'AAC AudioSpecificConfig has no sampling rate');
                        demuxAssert(parsed.channelCount > 0, 'AAC AudioSpecificConfig has no channel configuration');
                        currentAudioConfigIndex = findOrAppendConfiguration(audioConfigurations, nextConfig, {
                            codec: `mp4a.40.${parsed.audioObjectType}`,
                            codecConfig: nextConfig,
                            sampleRate: parsed.sampleRate,
                            channelCount: parsed.channelCount,
                            samplesPerAccessUnit: parsed.samplesPerAccessUnit,
                        });
                        if (!audioCodecConfig) {
                            audioCodecConfig = nextConfig;
                            audioCodec = `mp4a.40.${parsed.audioObjectType}`;
                            sampleRate = parsed.sampleRate;
                            channelCount = parsed.channelCount;
                        }
                    }
                    else if (aacPacketType === 1) {
                        demuxAssert(dataSize > 2, 'empty FLV AAC raw packet');
                        demuxAssert(currentAudioConfigIndex >= 0 && !!audioCodecConfig && !!audioCodec, 'AAC raw tag appears before a valid sequence header');
                        const active = audioConfigurations[currentAudioConfigIndex];
                        const activeRate = active.sampleRate ?? sampleRate;
                        const samplesPerAccessUnit = active.samplesPerAccessUnit ?? 1024;
                        demuxAssert(activeRate > 0, 'AAC configuration has an invalid sample rate');
                        budget.reserveSamples(1, 256, 'FLV sample index');
                        audioSamples.push({
                            offset: tagDataOffset + 2,
                            size: dataSize - 2,
                            timestamp: timestampMs / 1000,
                            decodeTimestamp: timestampMs / 1000,
                            duration: samplesPerAccessUnit / activeRate,
                            isKeyframe: true,
                            codecConfigIndex: currentAudioConfigIndex,
                        });
                    }
                    else {
                        throw new DemuxError(`unsupported FLV AAC packet type ${aacPacketType}`);
                    }
                }
                else if (soundFormat === 2) {
                    demuxAssert(dataSize > 1, 'empty FLV MP3 packet');
                    const mp3Header = parseMpegAudioHeader(pl, 1);
                    demuxAssert(mp3Header?.format === 'mp3', 'invalid FLV MP3 frame header');
                    demuxAssert(mp3Header.frameLength <= dataSize - 1, 'truncated FLV MP3 frame');
                    audioCodec = 'mp3';
                    sampleRate = mp3Header.sampleRate;
                    channelCount = mp3Header.channels;
                    budget.reserveSamples(1, 256, 'FLV sample index');
                    audioSamples.push({
                        offset: tagDataOffset + 1,
                        size: dataSize - 1,
                        timestamp: timestampMs / 1000,
                        decodeTimestamp: timestampMs / 1000,
                        duration: mp3Header.samplesPerFrame / sampleRate,
                        isKeyframe: true,
                    });
                }
            }
            expectedPreviousTagSize = 11 + dataSize;
            pos = tagDataOffset + dataSize;
        }
        for (let i = 0; i < videoSamples.length - 1; i++) {
            const currentDts = videoSamples[i].decodeTimestamp ?? videoSamples[i].timestamp;
            const nextDts = videoSamples[i + 1].decodeTimestamp ?? videoSamples[i + 1].timestamp;
            const duration = nextDts - currentDts;
            demuxAssert(duration > 0, `FLV video DTS is not strictly increasing at sample ${i + 1}`);
            videoSamples[i].duration = duration;
        }
        if (videoSamples.length > 0) {
            const last = videoSamples[videoSamples.length - 1];
            const lastDts = last.decodeTimestamp ?? last.timestamp;
            const declaredTail = Math.max(metadataDuration, observedEndTimestamp) - lastDts;
            if (declaredTail > 0 && Number.isFinite(declaredTail)) {
                last.duration = declaredTail;
            }
            else if (videoSamples.length > 1) {
                last.duration = videoSamples[videoSamples.length - 2].duration;
            }
            else if (metadataFrameRate > 0) {
                last.duration = 1 / metadataFrameRate;
            }
            else {
                last.duration = 1 / 30;
            }
            demuxAssert(last.duration > 0 && Number.isFinite(last.duration), 'FLV final video sample has an invalid duration');
        }
        for (let i = 0; i < audioSamples.length - 1; i++) {
            const current = audioSamples[i];
            const next = audioSamples[i + 1];
            const delta = (next.decodeTimestamp ?? next.timestamp) - (current.decodeTimestamp ?? current.timestamp);
            demuxAssert(delta >= 0, `FLV audio timestamp moved backwards at sample ${i + 1}`);
            if (delta > 0 && current.codecConfigIndex !== next.codecConfigIndex) {
                current.duration = delta;
            }
        }
        if (audioSamples.length > 0) {
            const last = audioSamples[audioSamples.length - 1];
            const declaredTail = Math.max(metadataDuration, observedEndTimestamp) - last.timestamp;
            if (declaredTail > 0 && Number.isFinite(declaredTail)) {
                last.duration = Math.max(last.duration, declaredTail);
            }
        }
        let totalDuration = Math.max(metadataDuration, observedEndTimestamp);
        for (const sample of videoSamples) {
            totalDuration = Math.max(totalDuration, sample.timestamp + sample.duration, (sample.decodeTimestamp ?? sample.timestamp) + sample.duration);
        }
        for (const sample of audioSamples) {
            totalDuration = Math.max(totalDuration, sample.timestamp + sample.duration);
        }
        const result = { videoTracks: [], audioTracks: [] };
        demuxAssert(!declaresVideo || videoSamples.length > 0, 'FLV header declares video but no video tags were found');
        demuxAssert(!declaresAudio || audioSamples.length > 0, 'FLV header declares audio but no audio tags were found');
        if (videoSamples.length > 0) {
            demuxAssert(!!videoCodecConfig && videoConfigurations.length > 0, 'FLV video samples have no AVC sequence header');
            const outputCodec = videoConfigurations.length > 1 ? videoCodec.replace(/^avc1/i, 'avc3') : videoCodec;
            result.videoTracks.push({
                codec: outputCodec,
                width,
                height,
                displayWidth,
                displayHeight,
                pixelAspectRatioNum,
                pixelAspectRatioDen,
                sampleRate: 0,
                channelCount: 0,
                duration: totalDuration,
                samples: videoSamples,
                codecConfig: videoCodecConfig,
                codecConfigurations: videoConfigurations,
            });
        }
        if (audioSamples.length > 0) {
            result.audioTracks.push({
                codec: audioCodec,
                width: 0,
                height: 0,
                sampleRate,
                channelCount,
                duration: totalDuration,
                samples: audioSamples,
                codecConfig: audioCodecConfig,
                codecConfigurations: audioConfigurations.length > 0 ? audioConfigurations : undefined,
            });
        }
        logger.info(`[FLVDemuxer] video=${videoSamples.length} samples/${videoConfigurations.length} config(s), ` +
            `audio=${audioSamples.length} samples/${audioConfigurations.length} config(s)`);
        return result;
    }
    parseAvcC(avcC) {
        if (avcC.length < 8 || avcC[0] !== 1)
            return null;
        const codec = `avc1.${avcC[1].toString(16).padStart(2, '0')}` +
            `${avcC[2].toString(16).padStart(2, '0')}` +
            `${avcC[3].toString(16).padStart(2, '0')}`;
        const numSPS = avcC[5] & 0x1f;
        if (numSPS === 0)
            return null;
        let pos = 6;
        let firstSps = null;
        for (let i = 0; i < numSPS; i++) {
            if (pos + 2 > avcC.length)
                return null;
            const spsLen = (avcC[pos] << 8) | avcC[pos + 1];
            pos += 2;
            if (spsLen <= 0 || pos + spsLen > avcC.length)
                return null;
            if (!firstSps)
                firstSps = this.parseSPS(avcC.subarray(pos, pos + spsLen));
            pos += spsLen;
        }
        if (pos >= avcC.length)
            return null;
        const numPPS = avcC[pos++];
        for (let i = 0; i < numPPS; i++) {
            if (pos + 2 > avcC.length)
                return null;
            const ppsLen = (avcC[pos] << 8) | avcC[pos + 1];
            pos += 2;
            if (ppsLen <= 0 || pos + ppsLen > avcC.length)
                return null;
            pos += ppsLen;
        }
        return firstSps ? { ...firstSps, codec } : null;
    }
    parseSPS(sps) {
        return parseH264Sps(sps);
    }
}
function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
function findOrAppendConfiguration(configurations, bytes, entry) {
    for (let i = 0; i < configurations.length; i++) {
        if (bytesEqual(configurations[i].codecConfig, bytes))
            return i;
    }
    configurations.push(entry);
    return configurations.length - 1;
}
function parseFlvMetadata(data) {
    try {
        const reader = new Amf0Reader(data);
        const event = reader.readValue(0);
        if (event !== 'onMetaData')
            return {};
        const value = reader.readValue(0);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return {};
        const record = value;
        return {
            duration: typeof record.duration === 'number' ? record.duration : undefined,
            framerate: typeof record.framerate === 'number' ? record.framerate : undefined,
        };
    }
    catch {
        return {};
    }
}
class Amf0Reader {
    data;
    pos = 0;
    entries = 0;
    constructor(data) {
        this.data = data;
    }
    readValue(depth) {
        if (depth > 8)
            throw new RangeError('AMF nesting too deep');
        const type = this.u8();
        switch (type) {
            case 0:
                return this.f64();
            case 1:
                return this.u8() !== 0;
            case 2:
                return this.string16();
            case 3:
                return this.object(depth + 1, false);
            case 5:
            case 6:
                return null;
            case 7:
                this.skip(2);
                return null;
            case 8:
                this.skip(4);
                return this.object(depth + 1, true);
            case 10: {
                const count = this.u32();
                if (count > 4096)
                    throw new RangeError('AMF array too large');
                const values = [];
                for (let i = 0; i < count; i++)
                    values.push(this.readValue(depth + 1));
                return values;
            }
            case 11: {
                const value = this.f64();
                this.skip(2);
                return value;
            }
            case 12:
                return this.string32();
            default:
                throw new RangeError(`unsupported AMF0 type ${type}`);
        }
    }
    object(depth, _ecmaArray) {
        const result = {};
        while (true) {
            this.ensure(3);
            if (this.data[this.pos] === 0 && this.data[this.pos + 1] === 0 && this.data[this.pos + 2] === 9) {
                this.pos += 3;
                return result;
            }
            const key = this.string16();
            if (++this.entries > 4096)
                throw new RangeError('AMF object too large');
            result[key] = this.readValue(depth);
        }
    }
    string16() {
        const length = this.u16();
        return this.string(length);
    }
    string32() {
        const length = this.u32();
        if (length > 1024 * 1024)
            throw new RangeError('AMF string too large');
        return this.string(length);
    }
    string(length) {
        this.ensure(length);
        const value = new TextDecoder().decode(this.data.subarray(this.pos, this.pos + length));
        this.pos += length;
        return value;
    }
    f64() {
        this.ensure(8);
        const value = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 8).getFloat64(0, false);
        this.pos += 8;
        return value;
    }
    u8() {
        this.ensure(1);
        return this.data[this.pos++];
    }
    u16() {
        this.ensure(2);
        const value = (this.data[this.pos] << 8) | this.data[this.pos + 1];
        this.pos += 2;
        return value;
    }
    u32() {
        this.ensure(4);
        const value = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 4).getUint32(0, false);
        this.pos += 4;
        return value;
    }
    skip(length) {
        this.ensure(length);
        this.pos += length;
    }
    ensure(length) {
        if (length < 0 || this.pos + length > this.data.length)
            throw new RangeError('AMF data truncated');
    }
}
