import { demuxCompatible } from '../demux/compatible-demux.js';
import { MP4Demuxer } from '../demux/mp4-demuxer.js';
import { reportConversionMetadata } from '../conversion/metadata.js';
import { BlobSource } from '../io/sources.js';
import { WAVMuxer } from '../mux/raw-muxer.js';
import { MP4Muxer } from '../mux/mp4-muxer.js';
import { ADTSMuxer } from '../mux/adts-muxer.js';
import { MemorySink } from '../io/sinks.js';
import { MediaForgeError, rethrowIfAbort } from '../core/errors.js';
import { sliceAdtsFrames, buildAacAsc } from './adts.js';
import { codecFamily } from '../core/codec-strings.js';
import { logger } from '../core/logger.js';
import { assertAudioEncodeRequest } from '../core/format-plans.js';
import { readFlacMetaBlocks, injectFlacMetaBlocks, readId3v2Prefix } from '../core/audio-metadata.js';
import { collectChannelViews, interleaveAudioBuffer, renderAudioBuffer, yieldToEventLoop } from './audio-buffer-tools.js';
import { MpegAudioEncoder } from './mpeg-audio-encoder.js';
import { AudioWorkerClient } from './audio-worker-client.js';
import { encodeFlacAsync } from './flac-encoder.js';
import { encodeAacLcAsync, wrapAdts } from './aac-encoder.js';
import { AAC_SAMPLE_RATES } from './aac-tables.js';
import { tryEncodeBufferedAac } from './buffered-aac-encoder.js';
import { ConverterReplayableAudio } from './converter-replayable-audio.js';
import { encodeReplayablePcm } from './streaming-audio-output.js';
import { encodeReplayableOpusToSink } from './streaming-opus-output.js';
import { copiedAudioTrackConfig } from '../core/pipeline-track-config.js';
export class ConverterAudioEncoder {
    config;
    host;
    mpegAudioEncoder;
    replayableAudio;
    constructor(config, host) {
        this.config = config;
        this.host = host;
        this.mpegAudioEncoder = new MpegAudioEncoder(config);
        this.replayableAudio = new ConverterReplayableAudio(config, {
            getCarried: () => host.getCarried(),
            getDemuxed: file => host.getDemuxed?.(file),
            audioBitrateBps: () => host.audioBitrateBps(),
            requestedAacCodec: () => this.requestedAacCodec(),
        });
    }
    get carried() {
        return this.host.getCarried();
    }
    decodeAudioToBuffer(file, inputFormat) {
        return this.host.decodeAudioToBuffer(file, inputFormat);
    }
    tryDirectAudioRemux(file, inputFormat, outputFormat) {
        return this.host.tryDirectAudioRemux(file, inputFormat, outputFormat);
    }
    audioBitrateBps() {
        return this.host.audioBitrateBps();
    }
    async collectExtraAudioTracks(file, inputFmt) {
        this.carried.extraAudio = [];
        const MP4_META_FAMILY = ['mp4', 'm4a', 'mov', '3gp', 'm4v'];
        if (!inputFmt || !MP4_META_FAMILY.includes(inputFmt))
            return;
        if (this.config.audioTrackIndex !== undefined)
            return;
        const BUDGET = 64 * 1024 * 1024;
        try {
            const result = this.host.getDemuxed?.(file) ?? (await demuxCompatible(new MP4Demuxer(), file, this.config.signal));
            if (result.audioTracks.length <= 1)
                return;
            const source = new BlobSource(file);
            let spent = 0;
            for (let i = 1; i < result.audioTracks.length; i++) {
                const track = result.audioTracks[i];
                const codec = track.codec || '';
                if (!(codec.startsWith('mp4a') || codec === 'aac' || codec === 'ac-3' || codec === 'ec-3')) {
                    logger.warn(`[Converter] secondary audio track #${i} (codec '${codec}') cannot be copied into m4a; dropping it`);
                    continue;
                }
                const total = track.samples.reduce((n, sample) => n + sample.size, 0);
                if (spent + total > BUDGET) {
                    logger.warn(`[Converter] secondary audio track #${i} exceeds the copy budget; dropping it`);
                    continue;
                }
                reportConversionMetadata({}, 'm4a', [track], this.config.metadataPolicy, 'Converter');
                spent += total;
                const chunks = [];
                for (let index = 0; index < track.samples.length; index++) {
                    this.config.signal?.throwIfAborted();
                    const sample = track.samples[index];
                    const data = sample.data ?? (await source.read(sample.offset, sample.size));
                    chunks.push({
                        data,
                        timestamp: sample.timestamp,
                        duration: sample.duration,
                        isKeyframe: true,
                        trackType: 'audio',
                    });
                    if ((index & 63) === 0)
                        await yieldToEventLoop();
                }
                this.carried.extraAudio.push({
                    config: copiedAudioTrackConfig(track, 'm4a'),
                    chunks,
                });
            }
        }
        catch (error) {
            if (error?.name === 'AbortError')
                throw error;
            if (error instanceof MediaForgeError && error.code === 'FORMAT')
                throw error;
            logger.warn('[Converter] secondary audio inspection failed; continuing without them:', error);
            this.carried.extraAudio = [];
            this.carried.udta = null;
        }
    }
    async extractAudio(file, fmt, preDecodedBuf, inputFmt) {
        this.config.onProgress?.(10, 'Decoding audio...');
        let decoded;
        if (preDecodedBuf) {
            decoded = preDecodedBuf;
        }
        else {
            if (fmt === 'm4a') {
                await this.collectExtraAudioTracks(file, inputFmt);
                const remuxed = await this.tryDirectAudioRemux(file, inputFmt, 'm4a');
                if (remuxed)
                    return remuxed;
            }
            const streamed = await this.replayableAudio.tryEncode(file, fmt, inputFmt);
            if (streamed)
                return streamed;
            decoded = await this.decodeAudioToBuffer(file, inputFmt);
        }
        if (fmt === 'mp3') {
            const encoded = await this.encodeRealMP3(decoded);
            if (inputFmt === 'mp3') {
                const tag = await readId3v2Prefix(file, this.config.signal);
                if (tag)
                    return new Blob([tag, encoded], { type: 'audio/mpeg' });
            }
            return encoded;
        }
        if (fmt === 'mp2') {
            return this.encodeRealMP2(decoded);
        }
        const ensureNotAborted = () => {
            if (this.config.signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
        };
        ensureNotAborted();
        const targetCh = Math.max(1, Math.min(8, this.config.audioChannels || decoded.numberOfChannels));
        const targetRate = this.config.audioSampleRate || decoded.sampleRate;
        const resampled = fmt === 'ogg'
            ? await this.renderForOutput(decoded, 'opus')
            : decoded.sampleRate === targetRate && decoded.numberOfChannels === targetCh
                ? decoded
                : await renderAudioBuffer(decoded, targetRate, targetCh, this.config.signal);
        ensureNotAborted();
        this.config.onProgress?.(50, 'Encoding...');
        ensureNotAborted();
        if (fmt === 'aiff' || fmt === 'au' || fmt === 'caf') {
            const source = {
                sampleRate: resampled.sampleRate,
                channels: resampled.numberOfChannels,
                estimatedFrames: resampled.length,
                async *chunks(signal) {
                    for (let start = 0; start < resampled.length; start += 16384) {
                        signal?.throwIfAborted();
                        yield Array.from({ length: resampled.numberOfChannels }, (_, channel) => resampled.getChannelData(channel).subarray(start, start + 16384));
                        signal?.throwIfAborted();
                    }
                },
            };
            return (await encodeReplayablePcm(source, fmt, {
                signal: this.config.signal,
                onProgress: (fraction, message) => this.config.onProgress?.(50 + fraction * 50, message),
            })).blob;
        }
        if (fmt === 'wav') {
            const sink = new MemorySink();
            const wavMux = new WAVMuxer(sink, resampled.sampleRate, resampled.numberOfChannels);
            await wavMux.addAudioBufferChunked(resampled, this.config.signal);
            await wavMux.finalize();
            this.config.onProgress?.(100, 'Done');
            return sink.toBlob('audio/wav');
        }
        if (fmt === 'ogg') {
            const ogg = await this.encodeOggOpus(resampled);
            this.carried.oggComments = null;
            return ogg;
        }
        if (fmt === 'aac') {
            return this.encodeADTS(resampled);
        }
        if (fmt === 'flac') {
            const out = await this.encodeFLAC(resampled);
            if (inputFmt === 'flac') {
                const meta = await readFlacMetaBlocks(file, this.config.signal);
                if (meta.length > 0)
                    return injectFlacMetaBlocks(out, meta, this.config.signal);
            }
            return out;
        }
        if (fmt === 'm4a') {
            return this.encodeAacAudio(resampled, 'audio/mp4');
        }
        const sink = new MemorySink();
        const wavMux = new WAVMuxer(sink, resampled.sampleRate, resampled.numberOfChannels);
        await wavMux.addAudioBufferChunked(resampled, this.config.signal);
        await wavMux.finalize();
        this.config.onProgress?.(100, 'Done');
        return sink.toBlob('audio/wav');
    }
    extractAudioToSink(file, sink, fmt, inputFmt) {
        return this.replayableAudio.tryEncodeToSink(file, sink, fmt, inputFmt);
    }
    async encodeOggOpus(audio) {
        const source = {
            sampleRate: audio.sampleRate,
            channels: audio.numberOfChannels,
            estimatedFrames: audio.length,
            async *chunks(signal) {
                const planes = collectChannelViews(audio, audio.numberOfChannels);
                for (let offset = 0; offset < audio.length; offset += 16384) {
                    if (signal?.aborted)
                        throw new MediaForgeError('Aborted', 'ABORT');
                    const end = Math.min(audio.length, offset + 16384);
                    yield planes.map(plane => plane.subarray(offset, end));
                }
            },
        };
        const sink = new MemorySink();
        await encodeReplayableOpusToSink(source, sink, {
            bitrateBps: this.audioBitrateBps() || 128000,
            commentPayload: this.carried.oggComments ?? undefined,
            signal: this.config.signal,
            onProgress: (fraction, message) => this.config.onProgress?.(50 + Math.round(fraction * 49), message),
        });
        this.config.onProgress?.(100, 'Done');
        if (this.config.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
        return sink.toBlob('audio/ogg');
    }
    requestedAacCodec() {
        const requested = this.config.audioCodec;
        if (!requested)
            return 'mp4a.40.2';
        if (requested === 'aac' || (codecFamily(requested) === 'mp4a' && !requested.includes('.'))) {
            return 'mp4a.40.2';
        }
        assertAudioEncodeRequest(requested);
        return requested;
    }
    async renderForOutput(buf, codec) {
        const requestedRate = this.config.audioSampleRate;
        let rate = requestedRate || buf.sampleRate;
        if (codec === 'opus') {
            if (requestedRate && requestedRate !== 48000) {
                throw new MediaForgeError(`Opus encodes at 48000 Hz only; requested ${requestedRate}`, 'FORMAT');
            }
            rate = 48000;
        }
        if (codec === 'aac' && !AAC_SAMPLE_RATES.includes(rate)) {
            if (requestedRate) {
                throw new MediaForgeError(`AAC cannot encode at ${requestedRate} Hz (legal AAC rates: ${AAC_SAMPLE_RATES.join('/')})`, 'FORMAT');
            }
            rate = 48000;
        }
        const maxCh = codec === 'aac' || codec === 'flac' || codec === 'pcm' ? 8 : 2;
        const requestedCh = this.config.audioChannels;
        if (requestedCh && (requestedCh < 1 || requestedCh > maxCh)) {
            throw new MediaForgeError(`${codec} output supports 1-${maxCh} channels; requested ${requestedCh}`, 'FORMAT');
        }
        let channels = requestedCh || buf.numberOfChannels;
        channels = Math.max(1, Math.min(maxCh, channels));
        if (rate === buf.sampleRate && channels === buf.numberOfChannels)
            return buf;
        return renderAudioBuffer(buf, rate, channels, this.config.signal);
    }
    async collectAacFrames(buf, requestedCodec = 'mp4a.40.2') {
        assertAudioEncodeRequest(requestedCodec);
        const source = await this.renderForOutput(buf, 'aac');
        const sr = source.sampleRate;
        const ch = source.numberOfChannels;
        const bitrate = this.audioBitrateBps() || 128000;
        const viaWebCodecs = await this.tryWebCodecsAac(source, bitrate, requestedCodec);
        if (viaWebCodecs)
            return { ...viaWebCodecs, validSamples: source.length };
        if (ch > 2) {
            throw new MediaForgeError('AAC output beyond stereo requires WebCodecs support in this browser', 'ENCODE');
        }
        this.config.onProgress?.(60, 'Encoding AAC...');
        const pcm = await interleaveAudioBuffer(source, ch, { chunkFrames: 16384, signal: this.config.signal });
        const request = {
            format: 'aac',
            pcm,
            sampleRate: sr,
            channels: ch,
            bitrate: Math.round(bitrate / 1000),
        };
        const report = (progress) => {
            if ((progress.completedFrames & 63) === 0 || progress.completedFrames === progress.totalFrames) {
                const pct = 60 + Math.round((progress.completedFrames / Math.max(1, progress.totalFrames)) * 35);
                this.config.onProgress?.(Math.min(99, pct), `Encoding AAC ${progress.completedFrames}/${progress.totalFrames}`);
            }
        };
        let adts;
        const workerClient = AudioWorkerClient.getShared();
        if (workerClient) {
            let progressFailure;
            let progressFailed = false;
            try {
                adts = new Uint8Array(await workerClient.encode(request, progress => {
                    try {
                        report(progress);
                    }
                    catch (error) {
                        if (!this.config.signal?.aborted) {
                            progressFailed = true;
                            progressFailure = error;
                        }
                        throw error;
                    }
                }, this.config.signal));
            }
            catch (workerErr) {
                if (progressFailed)
                    throw progressFailure;
                rethrowIfAbort(workerErr, this.config.signal);
                logger.warn('[Converter] AAC worker encode failed, falling back to local encode:', workerErr);
                const localPcm = request.pcm.buffer.byteLength === 0
                    ? await interleaveAudioBuffer(source, ch, { chunkFrames: 16384, signal: this.config.signal })
                    : request.pcm;
                adts = wrapAdts(await encodeAacLcAsync(localPcm, sr, ch, request.bitrate, {
                    signal: this.config.signal,
                    onProgress: (completedFrames, totalFrames) => report({ completedFrames, totalFrames }),
                }));
            }
        }
        else {
            adts = wrapAdts(await encodeAacLcAsync(pcm, sr, ch, request.bitrate, {
                signal: this.config.signal,
                onProgress: (completedFrames, totalFrames) => report({ completedFrames, totalFrames }),
            }));
        }
        return {
            frames: sliceAdtsFrames(adts),
            asc: buildAacAsc(sr, ch),
            sampleRate: sr,
            channels: ch,
            validSamples: source.length,
        };
    }
    tryWebCodecsAac(buf, bitrate, requestedCodec) {
        return tryEncodeBufferedAac(buf, bitrate, requestedCodec, this.config.signal);
    }
    async encodeAacAudio(buf, mimeType) {
        const requestedCodec = this.requestedAacCodec();
        const { frames, asc, sampleRate, channels, validSamples } = await this.collectAacFrames(buf, requestedCodec);
        const sink = new MemorySink();
        const muxer = new MP4Muxer({
            title: this.carried.title,
            moovUserData: this.carried.udta ?? undefined,
            audioLanguage: this.carried.audioLanguage,
            extraAudioTracks: this.carried.extraAudio.length > 0 ? this.carried.extraAudio.map(t => t.config) : undefined,
            format: 'm4a',
            mode: 'standard',
            maxFragmentDuration: 2.0,
            autoSync: true,
            audio: {
                ...this.carried.audioTrack,
                id: 1,
                type: 'audio',
                codec: requestedCodec,
                sampleRate,
                channelCount: channels,
            },
        }, sink);
        muxer.setAudioCodecConfig(asc);
        for (let ti = 0; ti < this.carried.extraAudio.length; ti++) {
            const track = this.carried.extraAudio[ti];
            for (const chunk of track.chunks)
                muxer.addExtraAudioChunk(ti, chunk, track.config.codecConfig);
        }
        this.carried.extraAudio = [];
        muxer.setAudioPriming(1024, validSamples);
        const frameSeconds = 1024 / sampleRate;
        for (let i = 0; i < frames.length; i++) {
            muxer.addAudioChunk({
                data: frames[i],
                timestamp: i * frameSeconds,
                duration: frameSeconds,
                isKeyframe: true,
                trackType: 'audio',
            });
        }
        await muxer.finalize();
        this.config.onProgress?.(100, 'Done');
        return sink.toBlob(mimeType);
    }
    async encodeADTS(buf) {
        const requestedCodec = this.requestedAacCodec();
        const { frames, sampleRate, channels } = await this.collectAacFrames(buf, requestedCodec);
        const sink = new MemorySink();
        const mux = new ADTSMuxer(sink, sampleRate, channels);
        const frameSeconds = 1024 / sampleRate;
        for (let i = 0; i < frames.length; i++) {
            mux.addAudioChunk({
                data: frames[i],
                timestamp: i * frameSeconds,
                duration: frameSeconds,
                isKeyframe: true,
                trackType: 'audio',
            });
        }
        await mux.finalize();
        this.config.onProgress?.(100, 'Done');
        return sink.toBlob('audio/aac');
    }
    async encodeFLAC(rawBuf) {
        const buf = await this.renderForOutput(rawBuf, 'flac');
        const channels = buf.numberOfChannels;
        this.config.onProgress?.(70, 'Preparing FLAC...');
        const pcm = await interleaveAudioBuffer(buf, channels, { chunkFrames: 16384, signal: this.config.signal });
        const request = {
            format: 'flac',
            pcm,
            sampleRate: buf.sampleRate,
            channels,
            bitrate: 0,
        };
        const reportFlac = (progress) => {
            const pct = 75 + Math.round((progress.completedFrames / Math.max(1, progress.totalFrames)) * 24);
            this.config.onProgress?.(Math.min(99, pct), `Encoding FLAC ${progress.completedFrames}/${progress.totalFrames}`);
        };
        let encoded;
        const workerClient = AudioWorkerClient.getShared();
        if (workerClient) {
            let progressFailure;
            let progressFailed = false;
            try {
                encoded = new Uint8Array(await workerClient.encode(request, progress => {
                    try {
                        reportFlac(progress);
                    }
                    catch (error) {
                        if (!this.config.signal?.aborted) {
                            progressFailed = true;
                            progressFailure = error;
                        }
                        throw error;
                    }
                }, this.config.signal));
            }
            catch (workerErr) {
                if (progressFailed)
                    throw progressFailure;
                rethrowIfAbort(workerErr, this.config.signal);
                logger.warn('[Converter] FLAC worker encode failed, falling back to local encode:', workerErr);
                const localPcm = request.pcm.buffer.byteLength === 0
                    ? await interleaveAudioBuffer(buf, channels, { chunkFrames: 16384, signal: this.config.signal })
                    : request.pcm;
                await yieldToEventLoop();
                encoded = await encodeFlacAsync(localPcm, buf.sampleRate, channels, {
                    onProgress: (completedFrames, totalFrames) => reportFlac({ completedFrames, totalFrames }),
                    signal: this.config.signal,
                });
            }
        }
        else {
            await yieldToEventLoop();
            encoded = await encodeFlacAsync(pcm, buf.sampleRate, channels, {
                onProgress: (completedFrames, totalFrames) => reportFlac({ completedFrames, totalFrames }),
                signal: this.config.signal,
            });
        }
        this.config.onProgress?.(100, 'Done');
        return new Blob([encoded], { type: 'audio/flac' });
    }
    async encodeRealMP3(buf) {
        return this.mpegAudioEncoder.encode(buf, 'mp3');
    }
    async encodeRealMP2(buf) {
        return this.mpegAudioEncoder.encode(buf, 'mp2');
    }
}
