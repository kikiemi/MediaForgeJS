import { demuxCompatible } from '../demux/compatible-demux.js';
import { DemuxerRegistry } from '../demux/registry.js';
import { MP4Demuxer } from '../demux/mp4-demuxer.js';
import { BlobSource } from '../io/sources.js';
import { ChunkReader } from '../io/chunk-reader.js';
import { MediaForgeError, rethrowIfAbort } from '../core/errors.js';
import { awaitWithAbort } from '../core/abort.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { buildAacConfig, parseAdtsFrameHeader, sliceAdtsFrames } from './adts.js';
import { decodeAacFrames } from './aac-decoder.js';
import { decodeConfiguredAacTrack } from './aac-track-decoder.js';
import { webCodecsAudioCodec, mp4aAudioObjectType } from '../core/codec-strings.js';
import { logger } from '../core/logger.js';
import { captureViaMediaElement } from './media-element-capture.js';
import { probeAcceleratedCapture } from './capture-probe.js';
import { consumeAudioChunks, createPcmAudioBufferFromChannels, renderAudioBuffer, yieldToEventLoop, } from './audio-buffer-tools.js';
import { decodeWavToAudioBuffer } from './wav-pcm.js';
import { MpegAudioDecoder } from './mpeg-audio-decoder.js';
function checkAudioAbort(signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
function rethrowAudioFailure(error, signal) {
    if (signal?.aborted || (error instanceof MediaForgeError && error.code !== 'DECODE'))
        throw error;
    rethrowIfAbort(error);
}
function audioDecodeLifetime(signal) {
    const lifetime = new CodecLifetime(signal, new MediaForgeError('AudioDecoder closed before decoding completed', 'DECODE'));
    return {
        record: (caught) => lifetime.record(caught),
        check(decoder) {
            lifetime.check();
            if (decoder?.state === 'closed') {
                throw lifetime.record(new MediaForgeError('AudioDecoder closed before decoding completed', 'DECODE'));
            }
        },
        create(init) {
            try {
                lifetime.check();
                return new AudioDecoder(init);
            }
            catch (error) {
                const failure = lifetime.record(error);
                lifetime.stop();
                throw nativeAudioFailure(failure);
            }
        },
        get acceptingOutput() {
            return lifetime.acceptingOutput;
        },
        waitFor: (pending) => lifetime.waitFor(pending),
        close(decoder) {
            lifetime.stop();
            if (decoder.state !== 'closed') {
                try {
                    decoder.close();
                }
                catch { }
            }
        },
    };
}
function nativeAudioFailure(error) {
    if (error instanceof MediaForgeError || (error instanceof DOMException && error.name === 'AbortError'))
        return error;
    return new MediaForgeError(`Audio decoding failed: ${error instanceof Error ? error.message : String(error)}`, 'DECODE');
}
function adtsStreamHeader(bytes) {
    let first = null;
    for (let offset = 0; offset + 7 <= bytes.length;) {
        const header = parseAdtsFrameHeader(bytes, offset);
        if (!header) {
            offset++;
            continue;
        }
        if (offset + header.frameLength > bytes.length)
            break;
        if (first &&
            (header.sampleRate !== first.sampleRate ||
                header.channels !== first.channels ||
                header.audioObjectType !== first.audioObjectType)) {
            throw new MediaForgeError('ADTS configuration changes are not supported by this decoder', 'DECODE');
        }
        first ??= header;
        offset += header.frameLength;
    }
    return first;
}
export class ConverterAudioDecoder {
    config;
    mpegAudioDecoder;
    constructor(config) {
        this.config = config;
        this.mpegAudioDecoder = new MpegAudioDecoder(config);
    }
    selectAudioTrack(result) {
        const index = this.config.audioTrackIndex ?? 0;
        if (this.config.audioTrackIndex !== undefined &&
            (!Number.isInteger(index) || index < 0 || index >= result.audioTracks.length)) {
            throw new MediaForgeError(`audioTrackIndex ${index} is out of range (input has ${result.audioTracks.length} audio track(s))`, 'FORMAT');
        }
        if (result.audioTracks.length > 1) {
            logger.warn(`[Converter] input has ${result.audioTracks.length} audio tracks; using #${index} (set audioTrackIndex to choose)`);
        }
        const track = result.audioTracks[index];
        if (!track || track.samples.length === 0)
            throw new MediaForgeError('No audio track found', 'DECODE');
        return track;
    }
    async decodeDemuxedAudioTrack(file, srcA) {
        checkAudioAbort(this.config.signal);
        if ((srcA.codecConfigurations?.length ?? 0) > 1 && (srcA.codec.startsWith('mp4a') || srcA.codec === 'aac')) {
            let sourceRate = srcA.sampleRate || 0;
            let sourceChannels = srcA.channelCount || 0;
            for (const config of srcA.codecConfigurations ?? []) {
                sourceRate = Math.max(sourceRate, config.sampleRate ?? 0);
                sourceChannels = Math.max(sourceChannels, config.channelCount ?? 0);
            }
            const sourceReader = new ChunkReader(new BlobSource(file));
            return decodeConfiguredAacTrack(srcA, async (sample) => sample.data ?? sourceReader.bytes(sample.offset, sample.size), {
                targetSampleRate: this.config.audioSampleRate || sourceRate || 48000,
                targetChannels: Math.max(1, Math.min(2, this.config.audioChannels || sourceChannels || 2)),
                signal: this.config.signal,
                onProgress: (done, total) => {
                    this.config.onProgress?.(20 + Math.round((done / Math.max(total, 1)) * 30), `Audio ${done}/${total}`);
                },
            });
        }
        const wcCodec = webCodecsAudioCodec(srcA.codec);
        if (wcCodec.startsWith('mp4a')) {
            let unusable = typeof AudioDecoder === 'undefined';
            if (!unusable) {
                try {
                    const probe = await awaitWithAbort(AudioDecoder.isConfigSupported({
                        codec: wcCodec,
                        sampleRate: srcA.sampleRate || 44100,
                        numberOfChannels: srcA.channelCount || 2,
                        ...(srcA.codecConfig ? { description: srcA.codecConfig } : {}),
                    }), this.config.signal);
                    checkAudioAbort(this.config.signal);
                    unusable = probe?.supported === false;
                }
                catch (error) {
                    rethrowIfAbort(error, this.config.signal);
                    unusable = true;
                }
            }
            if (unusable) {
                const selfDecoded = await this.decodeAacTrackSelfHosted(srcA, file);
                if (selfDecoded)
                    return selfDecoded;
                throw new MediaForgeError(`AAC decoder support is unavailable for '${srcA.codec}'`, 'DECODE');
            }
        }
        if (typeof AudioDecoder === 'undefined') {
            throw new MediaForgeError(`WebCodecs AudioDecoder is unavailable for '${srcA.codec}' in this environment`, 'DECODE');
        }
        const lifetime = audioDecodeLifetime(this.config.signal);
        const source = new BlobSource(file);
        const sourceReader = new ChunkReader({
            size: source.size,
            read(offset, length) {
                lifetime.check();
                return source.read(offset, length);
            },
        });
        const channelChunks = [];
        const outputPlacements = [];
        let decodedSR = srcA.sampleRate || 44100;
        let decodedCh = 0;
        const decoder = lifetime.create({
            output: (ad) => {
                try {
                    if (!lifetime.acceptingOutput)
                        return;
                    if (decodedCh !== 0 && (decodedCh !== ad.numberOfChannels || decodedSR !== ad.sampleRate)) {
                        throw new MediaForgeError('Decoded audio channel count or sample rate changed', 'DECODE');
                    }
                    decodedSR = ad.sampleRate;
                    decodedCh = ad.numberOfChannels;
                    outputPlacements.push({ timestamp: ad.timestamp / 1e6, frames: ad.numberOfFrames });
                    while (channelChunks.length < decodedCh)
                        channelChunks.push([]);
                    for (let ch = 0; ch < decodedCh; ch++) {
                        const chData = new Float32Array(ad.numberOfFrames);
                        ad.copyTo(chData, { planeIndex: ch, format: 'f32-planar' });
                        channelChunks[ch].push(chData);
                    }
                }
                catch (e) {
                    lifetime.record(e);
                }
                finally {
                    try {
                        ad.close();
                    }
                    catch (error) {
                        lifetime.record(error);
                    }
                }
            },
            error: (e) => {
                lifetime.record(e);
            },
        });
        const decCfg = {
            codec: wcCodec,
            sampleRate: srcA.sampleRate || 44100,
            numberOfChannels: srcA.channelCount || 2,
        };
        if (srcA.codecConfig)
            decCfg.description = srcA.codecConfig;
        let failure = null;
        try {
            lifetime.check();
            decoder.configure(decCfg);
            for (let i = 0; i < srcA.samples.length; i++) {
                lifetime.check(decoder);
                while (decoder.decodeQueueSize > 8) {
                    await lifetime.waitFor(yieldToEventLoop());
                    lifetime.check(decoder);
                }
                const sample = srcA.samples[i];
                const sampleData = sample.data ?? (await lifetime.waitFor(sourceReader.bytes(sample.offset, sample.size)));
                lifetime.check(decoder);
                decoder.decode(new EncodedAudioChunk({
                    type: 'key',
                    timestamp: Math.round(sample.timestamp * 1e6),
                    duration: Math.round(sample.duration * 1e6),
                    data: sampleData,
                }));
                lifetime.check(decoder);
                if (i % 100 === 0) {
                    this.config.onProgress?.(20 + Math.round((i / srcA.samples.length) * 30), `Audio ${i}/${srcA.samples.length}`);
                }
            }
            lifetime.check(decoder);
            await lifetime.waitFor(decoder.flush());
            lifetime.check(decoder);
        }
        catch (error) {
            failure = nativeAudioFailure(lifetime.record(error));
        }
        finally {
            lifetime.close(decoder);
        }
        if (failure &&
            (this.config.signal?.aborted || !(failure instanceof MediaForgeError) || failure.code !== 'DECODE'))
            throw failure;
        if (failure && wcCodec.startsWith('mp4a')) {
            logger.warn('[Converter] WebCodecs AAC decode failed, using built-in decoder:', failure);
            const selfDecoded = await this.decodeAacTrackSelfHosted(srcA, file);
            if (selfDecoded)
                return selfDecoded;
        }
        if (failure)
            throw failure;
        if (decodedCh === 0 || channelChunks.length === 0) {
            throw new MediaForgeError('AudioDecoder produced no output', 'DECODE');
        }
        const totalFrames = channelChunks[0].reduce((sum, chunk) => sum + chunk.length, 0);
        const decoded = consumeAudioChunks(channelChunks, totalFrames, decodedSR);
        return this.applySourceAudioWindow(decoded, outputPlacements, srcA);
    }
    async decodeAudioToBuffer(file, inputFmt) {
        checkAudioAbort(this.config.signal);
        const decodeInput = this.ensureMediaInputMime(file, inputFmt);
        const isMp4Family = !!inputFmt && ['m4a', 'mp4', 'mov', '3gp', 'm4v'].includes(inputFmt);
        if (isMp4Family) {
            try {
                const demuxed = await demuxCompatible(new MP4Demuxer(), decodeInput, this.config.signal);
                return await this.decodeDemuxedAudioTrack(decodeInput, this.selectAudioTrack(demuxed));
            }
            catch (earlyErr) {
                rethrowAudioFailure(earlyErr, this.config.signal);
                if (this.config.allowDomFallback) {
                    logger.warn('[Converter] bounded MP4 audio route failed, using opted-in media-element fallback:', earlyErr);
                    return this.decodeAudioViaMediaElement(decodeInput, this.config.audioSampleRate || 48000);
                }
                throw new MediaForgeError(`Cannot decode audio (${inputFmt}) through the bounded MP4 path: ${earlyErr instanceof Error ? earlyErr.message : String(earlyErr)}`, 'DECODE');
            }
        }
        let mpegDecoderTried = false;
        if (inputFmt === 'mp2' || inputFmt === 'mp1' || inputFmt === 'mp3') {
            mpegDecoderTried = true;
            try {
                const decodedMpeg = await awaitWithAbort(this.mpegAudioDecoder.decode(decodeInput, inputFmt), this.config.signal);
                checkAudioAbort(this.config.signal);
                if (decodedMpeg)
                    return decodedMpeg;
            }
            catch (mpegDecodeErr) {
                rethrowAudioFailure(mpegDecodeErr, this.config.signal);
                logger.warn(`[Converter] early ${inputFmt.toUpperCase()} decoder failed:`, mpegDecodeErr);
            }
        }
        if (inputFmt === 'wav') {
            const wavBytes = new Uint8Array(await awaitWithAbort(decodeInput.arrayBuffer(), this.config.signal));
            checkAudioAbort(this.config.signal);
            const wavBuf = await awaitWithAbort(decodeWavToAudioBuffer(wavBytes, this.config.signal), this.config.signal);
            checkAudioAbort(this.config.signal);
            const target = this.config.audioSampleRate;
            return target && target !== wavBuf.sampleRate
                ? await renderAudioBuffer(wavBuf, target, wavBuf.numberOfChannels, this.config.signal)
                : wavBuf;
        }
        const ab = await awaitWithAbort(decodeInput.arrayBuffer(), this.config.signal);
        checkAudioAbort(this.config.signal);
        const sniffedRate = sniffAudioSampleRate(new Uint8Array(ab, 0, Math.min(ab.byteLength, 8192)), inputFmt);
        const preferredRate = this.config.audioSampleRate || sniffedRate || 48000;
        if (typeof AudioContext === 'undefined') {
            throw new MediaForgeError(`No native audio decoder is available for ${inputFmt ?? 'this input'} in the current environment`, 'DECODE');
        }
        const ctx = new AudioContext({ sampleRate: preferredRate });
        let succeeded = false;
        try {
            checkAudioAbort(this.config.signal);
            const nativeInput = inputFmt === 'aac' ? ab.slice(0) : ab;
            const decoded = await awaitWithAbort(ctx.decodeAudioData(nativeInput), this.config.signal);
            checkAudioAbort(this.config.signal);
            succeeded = true;
            return decoded;
        }
        catch (decodeErr) {
            rethrowAudioFailure(decodeErr, this.config.signal);
            logger.warn('[Converter] decodeAudioData failed, trying next decoder:', decodeErr);
            if ((inputFmt === 'mp2' || inputFmt === 'mp1' || inputFmt === 'mp3') && !mpegDecoderTried) {
                try {
                    const decodedMpeg = await awaitWithAbort(this.mpegAudioDecoder.decode(decodeInput, inputFmt), this.config.signal);
                    checkAudioAbort(this.config.signal);
                    if (decodedMpeg) {
                        succeeded = true;
                        return decodedMpeg;
                    }
                }
                catch (mpegDecodeErr) {
                    rethrowAudioFailure(mpegDecodeErr, this.config.signal);
                    logger.warn(`[Converter] ${inputFmt.toUpperCase()} AudioDecoder fallback failed:`, mpegDecodeErr);
                }
            }
            if (inputFmt === 'aac') {
                try {
                    const decodedAdts = await this.decodeAdtsViaWebCodecs(new Uint8Array(ab));
                    checkAudioAbort(this.config.signal);
                    if (decodedAdts) {
                        succeeded = true;
                        return decodedAdts;
                    }
                }
                catch (adtsErr) {
                    rethrowAudioFailure(adtsErr, this.config.signal);
                    logger.warn('[Converter] ADTS WebCodecs fallback failed:', adtsErr);
                }
            }
            if (this.config.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            try {
                if (!this.config.allowDomFallback) {
                    throw new MediaForgeError('All native decoders failed for this input and the media-element fallback is disabled. ' +
                        'Pass allowDomFallback: true to opt in to the slow realtime capture path.', 'DECODE');
                }
                const decoded = await this.decodeAudioViaMediaElement(decodeInput, preferredRate);
                checkAudioAbort(this.config.signal);
                succeeded = true;
                return decoded;
            }
            catch (fallbackErr) {
                if (fallbackErr instanceof MediaForgeError)
                    throw fallbackErr;
                rethrowAudioFailure(fallbackErr, this.config.signal);
                throw new MediaForgeError(`Cannot decode audio${inputFmt ? ` (${inputFmt})` : ''}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`, 'DECODE');
            }
        }
        finally {
            try {
                const closing = ctx.close();
                if (succeeded)
                    await awaitWithAbort(closing, this.config.signal);
                else
                    void Promise.resolve(closing).catch(() => undefined);
            }
            catch { }
            if (succeeded)
                checkAudioAbort(this.config.signal);
        }
    }
    ensureMediaInputMime(file, inputFmt) {
        if (!inputFmt)
            return file;
        const mimeType = DemuxerRegistry.getMimeType(inputFmt);
        if (!mimeType)
            return file;
        if (file.type === mimeType)
            return file;
        return file.slice(0, file.size, mimeType);
    }
    async decodeAacUnitsSelfHosted(frames, sampleRate, channels, label) {
        if (channels < 1 || channels > 2)
            return null;
        try {
            const result = await decodeAacFrames(frames, sampleRate, channels, {
                yieldEvery: 16,
                signal: this.config.signal,
                onProgress: (done, total) => {
                    this.config.onProgress?.(20 + Math.round((done / Math.max(total, 1)) * 40), `${label} ${done}/${total}`);
                },
            });
            return createPcmAudioBufferFromChannels(result.channelData, result.sampleRate);
        }
        catch (e) {
            rethrowIfAbort(e, this.config.signal);
            logger.warn('[Converter] built-in AAC decode failed:', e);
            return null;
        }
    }
    placeDecodedByTimestamps(decoded, placements, rate) {
        if (placements.length === 0)
            return decoded;
        const first = placements[0].timestamp;
        let totalFrames = 0;
        let spanEnd = 0;
        for (const p of placements) {
            totalFrames += p.frames;
            spanEnd = Math.max(spanEnd, p.timestamp - first + p.frames / rate);
        }
        const spanFrames = Math.round(spanEnd * rate);
        if (spanFrames <= totalFrames + rate * 0.02)
            return decoded;
        const decodedSeconds = totalFrames / rate;
        const gapSeconds = (spanFrames - totalFrames) / rate;
        const maxGap = Math.max(3, decodedSeconds * 4);
        if (gapSeconds > maxGap) {
            throw new MediaForgeError(`audio timeline is implausibly sparse: ${decodedSeconds.toFixed(2)} s of coded audio spread over ${(spanFrames / rate).toFixed(1)} s (${gapSeconds.toFixed(1)} s of gaps; cap ${maxGap.toFixed(0)} s)`, 'FORMAT');
        }
        const length = Math.max(1, spanFrames);
        const channels = [];
        for (let ch = 0; ch < decoded.numberOfChannels; ch++)
            channels.push(new Float32Array(length));
        const out = {
            numberOfChannels: decoded.numberOfChannels,
            length,
            sampleRate: decoded.sampleRate,
            duration: length / decoded.sampleRate,
            getChannelData: (ch) => channels[ch],
        };
        let cursor = 0;
        for (const p of placements) {
            const dst = Math.max(0, Math.min(out.length - 1, Math.round((p.timestamp - first) * rate)));
            const n = Math.min(p.frames, decoded.length - cursor, out.length - dst);
            if (n > 0) {
                for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
                    out.getChannelData(ch).set(decoded.getChannelData(ch).subarray(cursor, cursor + n), dst);
                }
            }
            cursor += p.frames;
        }
        return out;
    }
    sourceAudioPriming(src, rate) {
        const first = src.samples[0]?.timestamp ?? 0;
        const skipSeconds = Math.max(0, src.editMediaTimeSeconds ?? (src.matroskaCodecDelaySeconds ? 0 : Math.max(0, -first)));
        return Math.max(0, Math.round(skipSeconds * rate));
    }
    applySourceAudioWindow(decoded, placements, src) {
        const placed = this.placeDecodedByTimestamps(decoded, placements, decoded.sampleRate);
        const declaredHead = this.sourceAudioPriming(src, placed.sampleRate);
        const head = Math.min(declaredHead, placed.length);
        const available = placed.length - head;
        if (available <= 0) {
            throw new MediaForgeError(`audio edit skips ${declaredHead} samples but the decoder produced only ${placed.length}`, 'DECODE');
        }
        const usable = available;
        if (head === 0 && usable === placed.length)
            return placed;
        const chunks = [];
        for (let ch = 0; ch < placed.numberOfChannels; ch++) {
            chunks.push([placed.getChannelData(ch).subarray(head, head + usable)]);
        }
        return consumeAudioChunks(chunks, usable, placed.sampleRate);
    }
    async decodeAacTrackSelfHosted(srcA, src) {
        const objectType = mp4aAudioObjectType(srcA.codec);
        if (objectType !== null && objectType !== 2) {
            return null;
        }
        const frames = [];
        if (src instanceof Uint8Array) {
            for (const s of srcA.samples) {
                frames.push(s.data ?? src.subarray(s.offset, s.offset + s.size));
            }
        }
        else {
            const reader = new ChunkReader(new BlobSource(src));
            for (const s of srcA.samples) {
                if (s.data) {
                    frames.push(s.data);
                    continue;
                }
                frames.push(new Uint8Array(await reader.bytes(s.offset, s.size)));
            }
        }
        const decoded = await this.decodeAacUnitsSelfHosted(frames, srcA.sampleRate || 44100, Math.max(1, Math.min(2, srcA.channelCount || 2)), 'AAC decode');
        if (!decoded)
            return decoded;
        const packetCount = srcA.samples.length;
        const baseFrames = Math.floor(decoded.length / packetCount);
        const extraFrames = decoded.length % packetCount;
        const placements = srcA.samples.map((sample, index) => ({
            timestamp: sample.timestamp,
            frames: baseFrames + (index < extraFrames ? 1 : 0),
        }));
        return this.applySourceAudioWindow(decoded, placements, srcA);
    }
    async decodeAdtsSelfHosted(bytes) {
        checkAudioAbort(this.config.signal);
        const header = adtsStreamHeader(bytes);
        const frames = sliceAdtsFrames(bytes);
        if (!header || header.audioObjectType !== 2 || frames.length === 0)
            return null;
        return this.decodeAacUnitsSelfHosted(frames, header.sampleRate, header.channels, 'AAC decode');
    }
    async decodeAdtsViaWebCodecs(bytes) {
        checkAudioAbort(this.config.signal);
        if (typeof AudioDecoder === 'undefined')
            return this.decodeAdtsSelfHosted(bytes);
        const frames = sliceAdtsFrames(bytes);
        const header = adtsStreamHeader(bytes);
        if (frames.length === 0 || !header || header.channels === 0)
            return null;
        const adtsCfg = {
            codec: `mp4a.40.${header.audioObjectType}`,
            sampleRate: header.sampleRate,
            numberOfChannels: header.channels,
            description: buildAacConfig(header.sampleRate, header.channels, header.audioObjectType),
        };
        try {
            const probe = await awaitWithAbort(AudioDecoder.isConfigSupported(adtsCfg), this.config.signal);
            checkAudioAbort(this.config.signal);
            if (probe?.supported === false)
                return this.decodeAdtsSelfHosted(bytes);
        }
        catch (error) {
            rethrowIfAbort(error, this.config.signal);
        }
        const lifetime = audioDecodeLifetime(this.config.signal);
        const channelChunks = [];
        let decodedSR = 0;
        let decodedCh = 0;
        const decoder = lifetime.create({
            output: (ad) => {
                try {
                    if (!lifetime.acceptingOutput)
                        return;
                    if (decodedCh !== 0 && (decodedCh !== ad.numberOfChannels || decodedSR !== ad.sampleRate)) {
                        throw new MediaForgeError('Decoded audio channel count or sample rate changed', 'DECODE');
                    }
                    decodedSR = ad.sampleRate;
                    decodedCh = ad.numberOfChannels;
                    while (channelChunks.length < decodedCh)
                        channelChunks.push([]);
                    for (let ch = 0; ch < decodedCh; ch++) {
                        const chData = new Float32Array(ad.numberOfFrames);
                        ad.copyTo(chData, { planeIndex: ch, format: 'f32-planar' });
                        channelChunks[ch].push(chData);
                    }
                }
                catch (error) {
                    lifetime.record(error);
                }
                finally {
                    try {
                        ad.close();
                    }
                    catch (error) {
                        lifetime.record(error);
                    }
                }
            },
            error: (error) => {
                lifetime.record(error);
            },
        });
        const frameSeconds = 1024 / header.sampleRate;
        let failure = null;
        try {
            lifetime.check();
            decoder.configure(adtsCfg);
            for (let i = 0; i < frames.length; i++) {
                lifetime.check(decoder);
                while (decoder.decodeQueueSize > 8) {
                    await lifetime.waitFor(yieldToEventLoop());
                    lifetime.check(decoder);
                }
                decoder.decode(new EncodedAudioChunk({
                    type: 'key',
                    timestamp: Math.round(i * frameSeconds * 1e6),
                    duration: Math.round(frameSeconds * 1e6),
                    data: frames[i],
                }));
            }
            lifetime.check(decoder);
            await lifetime.waitFor(decoder.flush());
            lifetime.check(decoder);
        }
        catch (error) {
            failure = nativeAudioFailure(lifetime.record(error));
        }
        finally {
            lifetime.close(decoder);
        }
        if (failure &&
            (this.config.signal?.aborted || !(failure instanceof MediaForgeError) || failure.code !== 'DECODE'))
            throw failure;
        if (failure || channelChunks.length === 0 || decodedCh === 0) {
            logger.warn('[Converter] ADTS decode incomplete, using built-in decoder:', failure);
            const selfDecoded = await this.decodeAdtsSelfHosted(bytes);
            if (selfDecoded)
                return selfDecoded;
            if (failure)
                throw failure;
            return null;
        }
        const totalFrames = channelChunks[0].reduce((sum, chunk) => sum + chunk.length, 0);
        return consumeAudioChunks(channelChunks, totalFrames, decodedSR);
    }
    static acceleratedCaptureVerdict = null;
    async acceleratedCaptureSupported() {
        checkAudioAbort(this.config.signal);
        if (ConverterAudioDecoder.acceleratedCaptureVerdict !== null) {
            return ConverterAudioDecoder.acceleratedCaptureVerdict;
        }
        try {
            const verdict = await probeAcceleratedCapture(this.config.signal);
            checkAudioAbort(this.config.signal);
            ConverterAudioDecoder.acceleratedCaptureVerdict = verdict;
            return verdict;
        }
        catch (error) {
            rethrowIfAbort(error, this.config.signal);
            return false;
        }
    }
    async decodeAudioViaMediaElement(file, preferredRate) {
        const accelOk = await this.acceleratedCaptureSupported();
        const result = await captureViaMediaElement(file, preferredRate, accelOk, {
            onProgress: this.config.onProgress,
            signal: this.config.signal,
        });
        return result.buffer;
    }
}
function sniffAudioSampleRate(head, fmt) {
    const mpegRate = () => {
        let scanStart = 0;
        if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
            const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
            scanStart = Math.min(head.length, 10 + size);
        }
        for (let i = scanStart; i + 3 < head.length; i++) {
            if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0)
                continue;
            const versionBits = (head[i + 1] >> 3) & 3;
            const srBits = (head[i + 2] >> 2) & 3;
            if (srBits === 3)
                continue;
            const mpeg1 = [44100, 48000, 32000][srBits];
            if (versionBits === 3)
                return mpeg1;
            if (versionBits === 2)
                return mpeg1 / 2;
            if (versionBits === 0)
                return mpeg1 / 4;
        }
        return null;
    };
    switch (fmt) {
        case 'wav': {
            for (let i = 12; i + 16 < head.length; i++) {
                if (head[i] === 0x66 && head[i + 1] === 0x6d && head[i + 2] === 0x74 && head[i + 3] === 0x20) {
                    return head[i + 12] | (head[i + 13] << 8) | (head[i + 14] << 16) | (head[i + 15] << 24);
                }
            }
            return null;
        }
        case 'flac': {
            if (head.length > 20 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
                return (head[18] << 12) | (head[19] << 4) | (head[20] >> 4);
            }
            return null;
        }
        case 'ogg': {
            for (let i = 0; i + 12 < head.length; i++) {
                if (head[i] === 0x4f &&
                    head[i + 1] === 0x70 &&
                    head[i + 2] === 0x75 &&
                    head[i + 3] === 0x73 &&
                    head[i + 4] === 0x48)
                    return 48000;
                if (head[i] === 0x01 &&
                    head[i + 1] === 0x76 &&
                    head[i + 2] === 0x6f &&
                    head[i + 3] === 0x72 &&
                    head[i + 4] === 0x62 &&
                    head[i + 5] === 0x69 &&
                    head[i + 6] === 0x73) {
                    return head[i + 12] | (head[i + 13] << 8) | (head[i + 14] << 16) | (head[i + 15] << 24);
                }
            }
            return null;
        }
        case 'aac': {
            for (let i = 0; i + 2 < head.length; i++) {
                if (head[i] === 0xff && (head[i + 1] & 0xf6) === 0xf0) {
                    const rates = [
                        96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
                    ];
                    const idx = (head[i + 2] >> 2) & 0xf;
                    return rates[idx] ?? null;
                }
            }
            return null;
        }
        case 'mp3':
        case 'mp2':
            return mpegRate();
        default:
            return null;
    }
}
