import { StreamingResampler } from './streaming-resampler.js';
import { awaitWithAbort } from '../core/abort.js';
import { EncodeError, MediaForgeError } from '../core/errors.js';
import { yieldEventLoop } from '../core/demux-guard.js';
export function yieldToEventLoop() {
    return yieldEventLoop();
}
function checkAbort(signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
export function collectChannelViews(audioBuffer, channelCount) {
    const views = new Array(channelCount);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
        views[channelIndex] = audioBuffer.getChannelData(channelIndex);
    }
    return views;
}
export function fillInterleavedBlock(channelViews, frameOffset, frameCount, scratch) {
    const channelCount = channelViews.length;
    let writeIndex = 0;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        const sampleIndex = frameOffset + frameIndex;
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
            scratch[writeIndex++] = channelViews[channelIndex][sampleIndex];
        }
    }
    return scratch.subarray(0, frameCount * channelCount);
}
export async function interleaveAudioBuffer(audioBuffer, channelCount, options = {}) {
    const chunkFrames = options.chunkFrames ?? 16384;
    if (!Number.isSafeInteger(chunkFrames) || chunkFrames <= 0)
        throw new EncodeError('chunkFrames must be a positive safe integer');
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > audioBuffer.numberOfChannels) {
        throw new EncodeError('channelCount is out of range');
    }
    const gain = options.gain ?? 1;
    if (!Number.isFinite(gain))
        throw new EncodeError('PCM gain must be finite');
    checkAbort(options.signal);
    const interleaved = new Float32Array(audioBuffer.length * channelCount);
    const channelViews = collectChannelViews(audioBuffer, channelCount);
    for (let frameOffset = 0; frameOffset < audioBuffer.length; frameOffset += chunkFrames) {
        const frameCount = Math.min(chunkFrames, audioBuffer.length - frameOffset);
        let writeIndex = frameOffset * channelCount;
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
            const sampleIndex = frameOffset + frameIndex;
            for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
                interleaved[writeIndex++] = channelViews[channelIndex][sampleIndex] * gain;
            }
        }
        checkAbort(options.signal);
        if (options.onChunk) {
            const pending = options.onChunk(frameOffset + frameCount, audioBuffer.length);
            await awaitWithAbort(Promise.resolve(pending), options.signal);
        }
        else if (options.signal) {
            await yieldToEventLoop();
        }
        checkAbort(options.signal);
    }
    return interleaved;
}
export async function renderAudioBuffer(audioBuffer, targetSampleRate, targetChannels, signal) {
    checkAbort(signal);
    if (!Number.isInteger(targetSampleRate) ||
        targetSampleRate < 8000 ||
        targetSampleRate > 192000 ||
        !Number.isInteger(targetChannels) ||
        targetChannels < 1 ||
        targetChannels > 8) {
        throw new EncodeError('target PCM requires an integer sample rate 8000..192000 and 1..8 channels');
    }
    if (audioBuffer.sampleRate === targetSampleRate && audioBuffer.numberOfChannels === targetChannels) {
        return audioBuffer;
    }
    const outputLength = Math.ceil((audioBuffer.length * targetSampleRate) / audioBuffer.sampleRate);
    if (typeof OfflineAudioContext === 'undefined' ||
        typeof AudioBuffer === 'undefined' ||
        !(audioBuffer instanceof AudioBuffer)) {
        const sourceChannels = Math.max(1, audioBuffer.numberOfChannels);
        const outputChannels = Math.max(1, targetChannels);
        const sourceRate = audioBuffer.sampleRate;
        const sourceLength = audioBuffer.length;
        const sourceViews = Array.from({ length: sourceChannels }, (_, channel) => audioBuffer.getChannelData(channel));
        const output = Array.from({ length: outputChannels }, () => new Float32Array(outputLength));
        const resampler = sourceRate === targetSampleRate
            ? null
            : new StreamingResampler(sourceRate, targetSampleRate, outputChannels);
        const WINDOW_FRAMES = 1 << 14;
        let written = 0;
        const append = (channels) => {
            const available = channels[0]?.length ?? 0;
            const count = Math.min(available, outputLength - written);
            if (count <= 0)
                return;
            for (let channel = 0; channel < outputChannels; channel++) {
                output[channel].set(channels[channel].subarray(0, count), written);
            }
            written += count;
        };
        checkAbort(signal);
        for (let start = 0; start < sourceLength; start += WINDOW_FRAMES) {
            const frameCount = Math.min(WINDOW_FRAMES, sourceLength - start);
            const sourceWindow = sourceViews.map(view => view.subarray(start, start + frameCount));
            const mappedWindow = sourceChannels === outputChannels
                ? sourceWindow
                : downmixChannels(sourceWindow, sourceChannels, outputChannels, frameCount);
            append(resampler ? resampler.process(mappedWindow) : mappedWindow);
            checkAbort(signal);
            if (start + frameCount < sourceLength) {
                await yieldToEventLoop();
                checkAbort(signal);
            }
        }
        if (resampler)
            append(resampler.flush());
        return createPcmAudioBufferFromChannels(output, targetSampleRate);
    }
    const offlineContext = new OfflineAudioContext(targetChannels, outputLength, targetSampleRate);
    const sourceNode = offlineContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(offlineContext.destination);
    sourceNode.start();
    const rendered = await awaitWithAbort(offlineContext.startRendering(), signal);
    checkAbort(signal);
    return rendered;
}
export async function encodeAudioBufferWithEncoder(audioBuffer, framesPerChunk, handleAudioData) {
    if (!Number.isSafeInteger(framesPerChunk) || framesPerChunk <= 0) {
        throw new EncodeError('framesPerChunk must be a positive safe integer');
    }
    const channelViews = collectChannelViews(audioBuffer, audioBuffer.numberOfChannels);
    const scratch = new Float32Array(framesPerChunk * audioBuffer.numberOfChannels);
    for (let frameOffset = 0, chunkIndex = 0; frameOffset < audioBuffer.length; frameOffset += framesPerChunk, chunkIndex++) {
        const frameCount = Math.min(framesPerChunk, audioBuffer.length - frameOffset);
        const interleaved = fillInterleavedBlock(channelViews, frameOffset, frameCount, scratch);
        const audioPayload = interleaved;
        const audioData = new AudioData({
            format: 'f32',
            sampleRate: audioBuffer.sampleRate,
            numberOfFrames: frameCount,
            numberOfChannels: audioBuffer.numberOfChannels,
            timestamp: Math.round((frameOffset / audioBuffer.sampleRate) * 1e6),
            data: audioPayload,
        });
        try {
            await handleAudioData(audioData);
        }
        finally {
            audioData.close();
        }
        if ((chunkIndex & 15) === 15) {
            await yieldToEventLoop();
        }
    }
}
export function createAudioBuffer(channelChunks, totalFrames, sampleRate) {
    const channelCount = channelChunks.length;
    if (typeof OfflineAudioContext === 'undefined') {
        const frames = Math.max(totalFrames, 1);
        const data = [];
        for (let c = 0; c < channelCount; c++) {
            const channel = new Float32Array(frames);
            let off = 0;
            for (const chunk of channelChunks[c] ?? []) {
                channel.set(chunk, off);
                off += chunk.length;
            }
            data.push(channel);
        }
        return createPcmAudioBufferFromChannels(data, sampleRate);
    }
    const offlineContext = new OfflineAudioContext(channelCount, Math.max(totalFrames, 1), sampleRate);
    const audioBuffer = offlineContext.createBuffer(channelCount, Math.max(totalFrames, 1), sampleRate);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
        const channelData = audioBuffer.getChannelData(channelIndex);
        let frameOffset = 0;
        for (const chunk of channelChunks[channelIndex] ?? []) {
            channelData.set(chunk, frameOffset);
            frameOffset += chunk.length;
        }
    }
    return audioBuffer;
}
export function createPcmAudioBufferFromChannels(channels, sampleRate) {
    const length = channels[0]?.length ?? 0;
    if (channels.length === 0 || channels.some(channel => channel.length !== length)) {
        throw new EncodeError('PCM buffer requires channel planes with matching lengths');
    }
    return {
        sampleRate,
        length,
        numberOfChannels: channels.length,
        duration: length / sampleRate,
        getChannelData: (index) => channels[index],
    };
}
export function consumeAudioChunks(channelChunks, totalFrames, sampleRate) {
    const frames = Math.max(totalFrames, 1);
    const data = [];
    for (let channelIndex = 0; channelIndex < channelChunks.length; channelIndex++) {
        const channel = new Float32Array(frames);
        let frameOffset = 0;
        const chunks = channelChunks[channelIndex] ?? [];
        for (const chunk of chunks) {
            const count = Math.min(chunk.length, frames - frameOffset);
            if (count <= 0)
                break;
            channel.set(chunk.subarray(0, count), frameOffset);
            frameOffset += count;
        }
        chunks.length = 0;
        data.push(channel);
    }
    return createPcmAudioBufferFromChannels(data, sampleRate);
}
export function downmixChannels(sources, sourceChannels, outputChannels, length) {
    const out = Array.from({ length: outputChannels }, () => new Float32Array(length));
    if (sourceChannels === outputChannels) {
        for (let c = 0; c < outputChannels; c++)
            out[c].set(sources[c].subarray(0, length));
        return out;
    }
    const C = Math.SQRT1_2;
    const L = sources[0];
    if (sourceChannels === 2 && outputChannels === 1) {
        const R = sources[1];
        const mono = out[0];
        for (let frame = 0; frame < length; frame++)
            mono[frame] = (0 + L[frame] + R[frame]) / 2;
        return out;
    }
    if (outputChannels <= 2 && sourceChannels > 1) {
        const left = new Float64Array(sourceChannels);
        const right = new Float64Array(sourceChannels);
        left[0] = 1;
        right[1] = 1;
        if (sourceChannels === 4) {
            left[2] = C;
            right[3] = C;
        }
        else if (sourceChannels >= 3) {
            left[2] = C;
            right[2] = C;
            if (sourceChannels === 5) {
                left[3] = C;
                right[4] = C;
            }
            else if (sourceChannels === 7) {
                left[4] = 0.5;
                right[4] = 0.5;
                left[5] = C;
                right[6] = C;
            }
            else if (sourceChannels >= 6) {
                left[4] = C;
                right[5] = C;
                if (sourceChannels === 8) {
                    left[6] = C;
                    right[7] = C;
                }
            }
        }
        const gainL = left.reduce((sum, weight) => sum + weight, 0);
        const gainR = right.reduce((sum, weight) => sum + weight, 0);
        for (let i = 0; i < length; i++) {
            let l = 0, r = 0;
            for (let c = 0; c < sourceChannels; c++) {
                l += sources[c][i] * left[c];
                r += sources[c][i] * right[c];
            }
            if (outputChannels === 1)
                out[0][i] = (l + r) / (gainL + gainR);
            else {
                out[0][i] = l / gainL;
                out[1][i] = r / gainR;
            }
        }
        return out;
    }
    if (sourceChannels === 1) {
        out[0].set(L.subarray(0, length));
        if (outputChannels > 1)
            out[1].set(L.subarray(0, length));
        return out;
    }
    for (let c = 0; c < outputChannels; c++) {
        if (c < sourceChannels)
            out[c].set(sources[c].subarray(0, length));
    }
    return out;
}
