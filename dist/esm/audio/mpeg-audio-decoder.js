import { logger } from '../core/logger.js';
import { awaitWithAbort } from '../core/abort.js';
import { CodecLifetime } from '../core/codec-lifetime.js';
import { MediaForgeError } from '../core/errors.js';
import { DEMUX_LIMITS } from '../core/demux-guard.js';
import { consumeAudioChunks, yieldToEventLoop } from './audio-buffer-tools.js';
import { StreamingMpegLayer12Decoder, skipId3v2, isMpegAudioTrailer } from './mpeg-layer12-decoder.js';
import { parseMpegAudioHeader } from '../core/mpeg-audio-header.js';
export { parseMpegAudioHeader } from '../core/mpeg-audio-header.js';
function checkAbort(signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
async function parseMpegAudioStream(data, expectedFormat, signal) {
    const frames = [];
    let offset = skipId3v2(data, 0);
    let sampleRate = 0;
    let channels = 0;
    let totalSamples = 0;
    let synchronized = false;
    let scanned = 0;
    while (offset + 4 <= data.length) {
        checkAbort(signal);
        if (++scanned % 4096 === 0) {
            await awaitWithAbort(yieldToEventLoop(), signal);
            checkAbort(signal);
        }
        if (isMpegAudioTrailer(data, offset))
            break;
        const header = parseMpegAudioHeader(data, offset);
        if (!header || header.format !== expectedFormat || offset + header.frameLength > data.length) {
            offset++;
            synchronized = false;
            continue;
        }
        const nextOffset = offset + header.frameLength;
        if (!synchronized && nextOffset + 4 <= data.length && !isMpegAudioTrailer(data, nextOffset)) {
            const nextHeader = parseMpegAudioHeader(data, nextOffset);
            if (!nextHeader || nextHeader.format !== expectedFormat) {
                offset++;
                continue;
            }
        }
        if (sampleRate === 0) {
            sampleRate = header.sampleRate;
            channels = header.channels;
        }
        else if (sampleRate !== header.sampleRate || channels !== header.channels) {
            throw new MediaForgeError(`${expectedFormat.toUpperCase()} audio shape changed ` +
                `(${sampleRate}Hz/${channels}ch -> ${header.sampleRate}Hz/${header.channels}ch)`, 'DECODE');
        }
        if (frames.length >= DEMUX_LIMITS.maxSamplesPerTrack) {
            throw new MediaForgeError(`${expectedFormat.toUpperCase()} sample count exceeds limit`, 'DEMUX');
        }
        const timestamp = Math.round((totalSamples / sampleRate) * 1e6);
        totalSamples += header.samplesPerFrame;
        frames.push({
            offset,
            size: header.frameLength,
            timestamp,
            duration: Math.round((totalSamples / sampleRate) * 1e6) - timestamp,
        });
        offset = nextOffset;
        synchronized = true;
    }
    if (frames.length === 0 || sampleRate === 0 || channels === 0)
        return null;
    return { sampleRate, channels, frames };
}
function codecCandidates(format) {
    return format === 'mp3' ? ['mp3'] : ['mp2', 'mp3'];
}
function nativeFailure(error) {
    if (error instanceof MediaForgeError || (error instanceof DOMException && error.name === 'AbortError'))
        return error;
    return new MediaForgeError(`MPEG audio decoding failed: ${error instanceof Error ? error.message : String(error)}`, 'DECODE');
}
export class MpegAudioDecoder {
    config;
    constructor(config = {}) {
        this.config = config;
    }
    async decode(file, format) {
        const signal = this.config.signal;
        checkAbort(signal);
        const bytes = new Uint8Array(await awaitWithAbort(file.arrayBuffer(), signal));
        checkAbort(signal);
        let effectiveFormat = format;
        let parsedStream = await parseMpegAudioStream(bytes, format, signal);
        if (!parsedStream) {
            for (const sibling of ['mp1', 'mp2', 'mp3']) {
                checkAbort(signal);
                if (sibling === format)
                    continue;
                parsedStream = await parseMpegAudioStream(bytes, sibling, signal);
                if (parsedStream) {
                    effectiveFormat = sibling;
                    break;
                }
            }
        }
        if (parsedStream && typeof AudioDecoder !== 'undefined') {
            for (const codec of codecCandidates(effectiveFormat)) {
                checkAbort(signal);
                const decoded = await this.tryDecodeWithCodec(bytes, parsedStream, codec, effectiveFormat);
                checkAbort(signal);
                if (decoded)
                    return decoded;
            }
        }
        checkAbort(signal);
        if (parsedStream && effectiveFormat !== 'mp3') {
            return this.decodeLayer12(bytes, parsedStream, effectiveFormat);
        }
        if (!parsedStream) {
            logger.warn(`[MpegAudioDecoder] could not parse raw ${format.toUpperCase()} frames`);
        }
        return null;
    }
    async decodeLayer12(bytes, stream, format) {
        const decoder = new StreamingMpegLayer12Decoder();
        const chunks = Array.from({ length: stream.channels }, () => []);
        let totalFrames = 0;
        for (let index = 0; index < stream.frames.length; index++) {
            checkAbort(this.config.signal);
            const frame = stream.frames[index];
            let planes;
            try {
                planes = decoder.pushFrame(bytes.subarray(frame.offset, frame.offset + frame.size));
            }
            catch {
                break;
            }
            for (let channel = 0; channel < planes.length; channel++)
                chunks[channel].push(planes[channel]);
            totalFrames += planes[0].length;
            if ((index & 31) === 31 || index === stream.frames.length - 1) {
                this.reportProgress(index, stream.frames.length, format);
                await awaitWithAbort(yieldToEventLoop(), this.config.signal);
            }
        }
        checkAbort(this.config.signal);
        return totalFrames > 0 ? consumeAudioChunks(chunks, totalFrames, stream.sampleRate) : null;
    }
    reportProgress(index, count, format) {
        this.config.onProgress?.(18 + Math.min(20, Math.round(((index + 1) / count) * 20)), `Decoding ${format.toUpperCase()} ${index + 1}/${count}`);
    }
    async tryDecodeWithCodec(bytes, stream, codec, format) {
        const config = {
            codec,
            sampleRate: stream.sampleRate,
            numberOfChannels: stream.channels,
        };
        const lifetime = new CodecLifetime(this.config.signal);
        let decoder = null;
        const channelChunks = Array.from({ length: stream.channels }, () => []);
        let totalFrames = 0;
        let failure = null;
        let progressFailed = false;
        const callNative = (action) => {
            lifetime.check();
            try {
                return action();
            }
            catch (error) {
                throw lifetime.record(nativeFailure(error));
            }
        };
        const waitNative = (action) => lifetime.waitFor(Promise.resolve(callNative(action)).catch(error => {
            throw nativeFailure(error);
        }));
        try {
            lifetime.check();
            if (typeof AudioDecoder.isConfigSupported === 'function') {
                const support = await waitNative(() => AudioDecoder.isConfigSupported(config));
                if (!support.supported)
                    return null;
            }
            decoder = callNative(() => new AudioDecoder({
                output: (audioData) => {
                    try {
                        if (!lifetime.acceptingOutput)
                            return;
                        if (audioData.sampleRate !== stream.sampleRate ||
                            audioData.numberOfChannels !== stream.channels ||
                            !Number.isInteger(audioData.numberOfFrames) ||
                            audioData.numberOfFrames <= 0) {
                            throw new MediaForgeError(`MPEG decoder returned ${audioData.sampleRate}Hz/${audioData.numberOfChannels}ch; ` +
                                `stream declares ${stream.sampleRate}Hz/${stream.channels}ch`, 'DECODE');
                        }
                        const planes = [];
                        for (let channel = 0; channel < stream.channels; channel++) {
                            const plane = new Float32Array(audioData.numberOfFrames);
                            audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
                            planes.push(plane);
                        }
                        lifetime.check();
                        for (let channel = 0; channel < planes.length; channel++)
                            channelChunks[channel].push(planes[channel]);
                        totalFrames += audioData.numberOfFrames;
                    }
                    catch (error) {
                        lifetime.record(nativeFailure(error));
                    }
                    finally {
                        try {
                            audioData.close();
                        }
                        catch (error) {
                            lifetime.record(nativeFailure(error));
                        }
                    }
                },
                error: (error) => {
                    lifetime.record(nativeFailure(error));
                },
            }));
            const activeDecoder = decoder;
            const checkDecoder = () => {
                lifetime.check();
                if (activeDecoder.state === 'closed') {
                    throw lifetime.record(new MediaForgeError('MPEG AudioDecoder closed before decoding completed', 'DECODE'));
                }
            };
            callNative(() => activeDecoder.configure(config));
            for (let index = 0; index < stream.frames.length; index++) {
                checkDecoder();
                while (activeDecoder.decodeQueueSize > 8) {
                    await lifetime.waitFor(yieldToEventLoop());
                    checkDecoder();
                }
                const frame = stream.frames[index];
                const frameData = bytes.subarray(frame.offset, frame.offset + frame.size);
                callNative(() => activeDecoder.decode(new EncodedAudioChunk({
                    type: 'key',
                    timestamp: frame.timestamp,
                    duration: frame.duration,
                    data: frameData,
                })));
                checkDecoder();
                if ((index & 31) === 0 || index === stream.frames.length - 1) {
                    try {
                        this.reportProgress(index, stream.frames.length, format);
                    }
                    catch (error) {
                        progressFailed = true;
                        throw lifetime.record(error);
                    }
                    await lifetime.waitFor(yieldToEventLoop());
                    checkDecoder();
                }
            }
            await waitNative(() => activeDecoder.flush());
            lifetime.check();
        }
        catch (error) {
            failure = lifetime.record(error);
        }
        finally {
            lifetime.stop();
            if (decoder && decoder.state !== 'closed') {
                try {
                    decoder.close();
                }
                catch { }
            }
        }
        if (failure) {
            if (progressFailed ||
                this.config.signal?.aborted ||
                !(failure instanceof MediaForgeError) ||
                failure.code !== 'DECODE')
                throw failure;
            logger.warn(`[MpegAudioDecoder] ${format.toUpperCase()} decode failed for codec '${codec}':`, failure);
            return null;
        }
        return totalFrames > 0 ? consumeAudioChunks(channelChunks, totalFrames, stream.sampleRate) : null;
    }
}
