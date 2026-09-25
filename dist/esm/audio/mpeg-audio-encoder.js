import { logger } from '../core/logger.js';
import { EncodeError, MediaForgeError, rethrowIfAbort, normalizeBitrateBps } from '../core/errors.js';
import { createPcmAudioBufferFromChannels } from './audio-buffer-tools.js';
import { interleaveAudioBuffer, renderAudioBuffer, yieldToEventLoop } from './audio-buffer-tools.js';
import { AudioWorkerClient } from './audio-worker-client.js';
import { encodeMP2Async, legalMp2Bitrates } from './mp2-encoder.js';
import { encodeMP3Async } from './mp3-encoder.js';
const MPEG_AUDIO_SAMPLE_RATES = [32000, 44100, 48000];
const MP3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP2_TARGET_PEAK = 1.0;
const MP3_TARGET_PEAK = 1.0;
function pickNearestInt(target, supportedValues, fallbackValue) {
    if (!Number.isFinite(target))
        return fallbackValue;
    let bestValue = supportedValues[0] ?? fallbackValue;
    let bestDistance = Math.abs(bestValue - target);
    for (const value of supportedValues) {
        const distance = Math.abs(value - target);
        if (distance < bestDistance) {
            bestValue = value;
            bestDistance = distance;
        }
    }
    return bestValue;
}
function resolveTargetSampleRate(config, audioBuffer) {
    if (config.audioSampleRate !== undefined) {
        if (!MPEG_AUDIO_SAMPLE_RATES.includes(config.audioSampleRate)) {
            throw new EncodeError(`MP3/MP2 encoder supports ${MPEG_AUDIO_SAMPLE_RATES.join('/')} Hz; requested ${config.audioSampleRate}` +
                ' (MPEG-2 half rates are not implemented)');
        }
        return config.audioSampleRate;
    }
    return pickNearestInt(audioBuffer.sampleRate, MPEG_AUDIO_SAMPLE_RATES, 44100);
}
function resolveTargetChannels(config, audioBuffer) {
    if (config.audioChannels) {
        if (config.audioChannels > 2) {
            throw new EncodeError(`MP3/MP2 carry 1-2 channels; requested ${config.audioChannels}`);
        }
        return Math.max(1, config.audioChannels);
    }
    return Math.max(1, Math.min(2, audioBuffer.numberOfChannels));
}
function measurePeak(audioBuffer) {
    let peak = 0;
    for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex++) {
        const channel = audioBuffer.getChannelData(channelIndex);
        for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex++) {
            const amplitude = Math.abs(channel[sampleIndex]);
            if (amplitude > peak)
                peak = amplitude;
        }
    }
    return peak;
}
export function resolveMpegAudioBitrate(format, audioBitrate, channels) {
    const legal = format === 'mp3' ? MP3_BITRATES : legalMp2Bitrates(channels);
    const bps = normalizeBitrateBps(audioBitrate, 'audio');
    if (audioBitrate !== undefined && bps) {
        const requestedKbps = bps / 1000;
        if (!legal.includes(requestedKbps)) {
            throw new EncodeError(`${format.toUpperCase()} has no ${requestedKbps} kbps mode (legal ${channels}ch bitrates: ${legal.join('/')} kbps)`);
        }
        return requestedKbps;
    }
    const preferredKbps = Math.max(32, Math.round((bps || 256000) / 1000));
    return pickNearestInt(preferredKbps, legal, format === 'mp3' ? 256 : channels === 1 ? 192 : 256);
}
export function applyMpegAudioPeakHeadroom(audioBuffer, targetPeak) {
    const sourcePeak = measurePeak(audioBuffer);
    if (!(sourcePeak > targetPeak) || sourcePeak <= 1e-9) {
        return {
            sourcePeak,
            preparedPeak: sourcePeak,
            appliedGain: 1,
            audioBuffer,
        };
    }
    const gain = targetPeak / sourcePeak;
    const channels = [];
    for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex++) {
        const source = audioBuffer.getChannelData(channelIndex);
        const scaled = new Float32Array(source.length);
        for (let sampleIndex = 0; sampleIndex < source.length; sampleIndex++) {
            scaled[sampleIndex] = source[sampleIndex] * gain;
        }
        channels.push(scaled);
    }
    const prepared = createPcmAudioBufferFromChannels(channels, audioBuffer.sampleRate);
    return {
        sourcePeak,
        preparedPeak: measurePeak(prepared),
        appliedGain: gain,
        audioBuffer: prepared,
    };
}
export async function prepareMpegAudioBuffer(audioBuffer, format, config = {}) {
    const targetRate = resolveTargetSampleRate(config, audioBuffer);
    const targetChannels = resolveTargetChannels(config, audioBuffer);
    const rendered = await renderAudioBuffer(audioBuffer, targetRate, targetChannels, config.signal);
    const headroom = applyMpegAudioPeakHeadroom(rendered, format === 'mp3' ? MP3_TARGET_PEAK : MP2_TARGET_PEAK);
    return {
        audioBuffer: headroom.audioBuffer,
        bitrate: resolveMpegAudioBitrate(format, config.audioBitrate, rendered.numberOfChannels),
        sourcePeak: headroom.sourcePeak,
        preparedPeak: headroom.preparedPeak,
        appliedGain: headroom.appliedGain,
    };
}
export class MpegAudioEncoder {
    config;
    constructor(config = {}) {
        this.config = config;
    }
    checkAbort() {
        if (this.config.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    }
    async encode(audioBuffer, format) {
        const upperFormat = format.toUpperCase();
        this.checkAbort();
        const targetRate = resolveTargetSampleRate(this.config, audioBuffer);
        const targetChannels = resolveTargetChannels(this.config, audioBuffer);
        const rendered = await renderAudioBuffer(audioBuffer, targetRate, targetChannels, this.config.signal);
        this.checkAbort();
        const sourcePeak = measurePeak(rendered);
        const targetPeak = format === 'mp3' ? MP3_TARGET_PEAK : MP2_TARGET_PEAK;
        const gain = sourcePeak > targetPeak && sourcePeak > 1e-9 ? targetPeak / sourcePeak : 1;
        const bitrate = resolveMpegAudioBitrate(format, this.config.audioBitrate, rendered.numberOfChannels);
        this.report(82, `Preparing ${upperFormat} audio...`);
        const pcm = await interleaveAudioBuffer(rendered, rendered.numberOfChannels, {
            chunkFrames: 16384,
            gain,
            signal: this.config.signal,
            onChunk: async (processedFrames, totalFrames) => {
                this.report(82 + Math.min(7, Math.round((processedFrames / Math.max(totalFrames, 1)) * 7)), `Preparing ${upperFormat} audio ${processedFrames}/${totalFrames}`);
                await yieldToEventLoop();
            },
        });
        const encodeRequest = {
            format,
            pcm,
            sampleRate: rendered.sampleRate,
            channels: rendered.numberOfChannels,
            bitrate,
            vbr: this.config.audioVbr === true,
        };
        this.report(90, `Encoding ${upperFormat}...`);
        let encodedBuffer;
        const workerClient = AudioWorkerClient.getShared();
        this.checkAbort();
        if (workerClient) {
            let progressFailure;
            let progressFailed = false;
            try {
                encodedBuffer = await workerClient.encode(encodeRequest, progress => {
                    try {
                        this.reportEncodingProgress(format, progress);
                    }
                    catch (error) {
                        if (!this.config.signal?.aborted) {
                            progressFailed = true;
                            progressFailure = error;
                        }
                        throw error;
                    }
                }, this.config.signal);
            }
            catch (error) {
                if (progressFailed)
                    throw progressFailure;
                rethrowIfAbort(error, this.config.signal);
                logger.warn('[MpegAudioEncoder] worker encode failed, falling back to local encode:', error);
                const localPcm = encodeRequest.pcm.buffer.byteLength === 0
                    ? await interleaveAudioBuffer(rendered, rendered.numberOfChannels, {
                        chunkFrames: 16384,
                        gain,
                    })
                    : encodeRequest.pcm;
                encodedBuffer = await this.encodeLocal({ ...encodeRequest, pcm: localPcm });
            }
        }
        else {
            encodedBuffer = await this.encodeLocal(encodeRequest);
        }
        this.report(100, 'Done');
        return new Blob([encodedBuffer], { type: format === 'mp2' ? 'audio/mp2' : 'audio/mpeg' });
    }
    async encodeLocal(request) {
        const { format } = request;
        if (format === 'flac' || format === 'aac') {
            throw new EncodeError('MpegAudioEncoder handles MPEG formats only');
        }
        const encodeOptions = {
            onProgress: progress => {
                this.reportEncodingProgress(format, progress);
            },
            signal: this.config.signal,
        };
        await yieldToEventLoop();
        const encoded = format === 'mp3'
            ? await encodeMP3Async(request.pcm, request.sampleRate, request.channels, request.bitrate, this.config.audioVbr === true ? { ...encodeOptions, vbr: true } : encodeOptions)
            : await encodeMP2Async(request.pcm, request.sampleRate, request.channels, request.bitrate, encodeOptions);
        return encoded.arrayBuffer();
    }
    reportEncodingProgress(format, progress) {
        const upperFormat = format.toUpperCase();
        const ratio = progress.completedFrames / Math.max(progress.totalFrames, 1);
        const progressPercent = 90 + Math.min(9, Math.round(ratio * 9));
        this.report(progressPercent, `Encoding ${upperFormat} ${progress.completedFrames}/${progress.totalFrames}`);
    }
    report(progress, message) {
        this.config.onProgress?.(progress, message);
    }
}
