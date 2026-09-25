import { MediaForgeError } from '../core/errors.js';
import { awaitWithAbort } from '../core/abort.js';
import { StreamingResampler } from './streaming-resampler.js';
import { downmixChannels, yieldToEventLoop } from './audio-buffer-tools.js';
function checkAbort(signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
function tagOf(bytes, at = 0) {
    return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}
async function parseWavLayout(size, read, signal) {
    checkAbort(signal);
    if (!Number.isSafeInteger(size) || size < 44)
        return null;
    const first = await read(0, 12);
    const riff = tagOf(first);
    if ((riff !== 'RIFF' && riff !== 'RF64') || tagOf(first, 8) !== 'WAVE')
        return null;
    const declared = new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(4, true);
    let end = declared + 8;
    let rf64DataSize = -1;
    let pos = 12;
    if (riff === 'RF64') {
        const header = await read(pos, 8);
        const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4, true);
        if (tagOf(header) !== 'ds64' || length < 28 || length > size - 20)
            return null;
        const bytes = await read(20, 28);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const riffSize = Number(view.getBigUint64(0, true));
        rf64DataSize = Number(view.getBigUint64(8, true));
        if (view.getUint32(24, true) > Math.floor((length - 28) / 12))
            return null;
        end = declared === 0xffffffff ? riffSize + 8 : declared + 8;
        pos = 20 + length + (length & 1);
    }
    else if (declared === 0xffffffff)
        return null;
    if (!Number.isSafeInteger(end) || end < pos || end > size + 1)
        return null;
    let format = null;
    let layout = null;
    let hops = 0;
    while (pos < end) {
        checkAbort(signal);
        if (++hops > 4096 || pos + 8 > Math.min(end, size))
            return null;
        const header = await read(pos, 8);
        const id = tagOf(header);
        let length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4, true);
        const body = pos + 8;
        if (length === 0xffffffff) {
            if (id !== 'data' || rf64DataSize < 0 || !Number.isSafeInteger(rf64DataSize))
                return null;
            length = rf64DataSize;
        }
        if (length > end - body || length > size - body)
            return null;
        if (id === 'fmt ') {
            if (format || layout || length < 16)
                return null;
            const bytes = await read(body, Math.min(length, 40));
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            let codec = view.getUint16(0, true);
            const channels = view.getUint16(2, true);
            const sampleRate = view.getUint32(4, true);
            const byteRate = view.getUint32(8, true);
            const blockAlign = view.getUint16(12, true);
            const bitsPerSample = view.getUint16(14, true);
            if (codec === 0xfffe) {
                if (length < 40 || view.getUint16(16, true) < 22 || view.getUint16(16, true) > length - 18)
                    return null;
                codec = view.getUint32(24, true);
                const validBits = view.getUint16(18, true);
                if (validBits > bitsPerSample ||
                    (codec === 1 && validBits === 0) ||
                    (codec === 3 && validBits !== 0 && validBits !== bitsPerSample) ||
                    view.getUint32(28, true) !== 0x00100000 ||
                    view.getUint32(32, true) !== 0xaa000080 ||
                    view.getUint32(36, true) !== 0x719b3800)
                    return null;
            }
            const float = codec === 3;
            if (channels < 1 ||
                channels > 32 ||
                sampleRate < 1 ||
                (codec !== 1 && !float) ||
                (float ? bitsPerSample !== 32 && bitsPerSample !== 64 : ![8, 16, 24, 32].includes(bitsPerSample)) ||
                blockAlign !== channels * (bitsPerSample / 8) ||
                byteRate !== sampleRate * blockAlign)
                return null;
            format = { channels, sampleRate, bitsPerSample, float };
        }
        else if (id === 'data') {
            if (!format || layout || length % (format.channels * (format.bitsPerSample / 8)) !== 0)
                return null;
            layout = { dataOffset: body, dataLength: length, ...format };
        }
        else if (id === 'ds64')
            return null;
        pos = body + length + (length & 1);
        if (pos > end)
            return null;
    }
    checkAbort(signal);
    return layout;
}
async function readBlobBytes(file, at, length, signal) {
    checkAbort(signal);
    const bytes = new Uint8Array(await awaitWithAbort(file.slice(at, at + length).arrayBuffer(), signal));
    checkAbort(signal);
    if (bytes.length !== length)
        throw new MediaForgeError('WAV read returned fewer bytes than requested', 'DECODE');
    return bytes;
}
export async function readWavLayout(file, signal) {
    signal?.throwIfAborted();
    return parseWavLayout(file.size, (at, length) => readBlobBytes(file, at, length, signal), signal);
}
export async function readWavLayoutFromBytes(bytes, signal) {
    return parseWavLayout(bytes.byteLength, async (at, length) => bytes.subarray(at, at + length), signal);
}
function validateLayout(layout) {
    const { channels, sampleRate, bitsPerSample, float, dataOffset, dataLength } = layout;
    if (!Number.isInteger(channels) ||
        channels < 1 ||
        channels > 32 ||
        !Number.isInteger(sampleRate) ||
        sampleRate < 1 ||
        sampleRate > 0xffffffff ||
        typeof float !== 'boolean' ||
        (float ? bitsPerSample !== 32 && bitsPerSample !== 64 : ![8, 16, 24, 32].includes(bitsPerSample)) ||
        !Number.isSafeInteger(dataOffset) ||
        dataOffset < 0 ||
        !Number.isSafeInteger(dataLength) ||
        dataLength < 0 ||
        !Number.isSafeInteger(dataOffset + dataLength)) {
        throw new MediaForgeError('Invalid WAV PCM layout', 'DECODE');
    }
    const stride = channels * (bitsPerSample / 8);
    if (dataLength % stride !== 0)
        throw new MediaForgeError('WAV data ends inside a PCM frame', 'DECODE');
    return stride;
}
export function toFloatChannels(bytes, layout, frames) {
    const stride = validateLayout(layout);
    if (!Number.isSafeInteger(frames) || frames < 0 || frames > Math.floor(bytes.byteLength / stride)) {
        throw new MediaForgeError('WAV PCM input does not contain the requested frames', 'DECODE');
    }
    const { channels, bitsPerSample, float } = layout;
    const bytesPerSample = bitsPerSample / 8;
    const out = [];
    for (let c = 0; c < channels; c++)
        out.push(new Float32Array(frames));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let f = 0; f < frames; f++) {
        const base = f * stride;
        for (let c = 0; c < channels; c++) {
            const at = base + c * bytesPerSample;
            let value;
            if (float)
                value = bitsPerSample === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true);
            else if (bitsPerSample === 8)
                value = (bytes[at] - 128) / 128;
            else if (bitsPerSample === 16)
                value = view.getInt16(at, true) / 32768;
            else if (bitsPerSample === 24) {
                const raw = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8;
                value = (raw >> 8) / 8388608;
            }
            else
                value = view.getInt32(at, true) / 2147483648;
            out[c][f] = value;
        }
    }
    return out;
}
export function createWavPcmSource(file, layout) {
    layout = { ...layout };
    const bytesPerFrame = validateLayout(layout);
    if (layout.dataOffset + layout.dataLength > file.size) {
        throw new MediaForgeError('WAV PCM layout extends beyond the input', 'DECODE');
    }
    const totalFrames = layout.dataLength / bytesPerFrame;
    return {
        sampleRate: layout.sampleRate,
        channels: layout.channels,
        estimatedFrames: totalFrames,
        async *chunks(signal) {
            checkAbort(signal);
            const segmentFrames = 1 << 16;
            for (let start = 0; start < totalFrames; start += segmentFrames) {
                checkAbort(signal);
                const frames = Math.min(segmentFrames, totalFrames - start);
                const from = layout.dataOffset + start * bytesPerFrame;
                const bytes = await readBlobBytes(file, from, frames * bytesPerFrame, signal);
                yield toFloatChannels(bytes, layout, frames);
            }
        },
    };
}
function mapChannels(input, target) {
    if (input.length === target)
        return input;
    const frames = input[0]?.length ?? 0;
    return downmixChannels(input, input.length, target, frames);
}
export async function convertWavStreaming(file, layout, targetRate, targetChannels, options = {}) {
    const signal = options.signal;
    checkAbort(signal);
    layout = { ...layout };
    const bytesPerFrame = validateLayout(layout);
    if (layout.dataOffset + layout.dataLength > file.size) {
        throw new MediaForgeError('WAV PCM layout extends beyond the input', 'DECODE');
    }
    if (!Number.isInteger(targetRate) ||
        targetRate < 1 ||
        targetRate > 768000 ||
        !Number.isInteger(targetChannels) ||
        targetChannels < 1 ||
        targetChannels > 8) {
        throw new MediaForgeError('WAV output requires a sample rate 1..768000 and 1..8 channels', 'ENCODE');
    }
    const totalFrames = layout.dataLength / bytesPerFrame;
    const resampler = layout.sampleRate === targetRate ? null : new StreamingResampler(layout.sampleRate, targetRate, targetChannels);
    const expectedFrames = layout.sampleRate === targetRate ? totalFrames : Math.ceil((totalFrames * targetRate) / layout.sampleRate);
    const segmentFrames = 1 << 18;
    const pieces = [];
    let outFrames = 0;
    const outBits = layout.float ? 24 : layout.bitsPerSample;
    const bytesPerSampleOut = outBits >> 3;
    const buildHeader = (frames) => {
        const dataBytes = frames * targetChannels * bytesPerSampleOut;
        if (!Number.isSafeInteger(dataBytes) || dataBytes + 36 + (dataBytes & 1) > 0xffffffff) {
            throw new MediaForgeError(`WAV output would be ${dataBytes} bytes, past the 4 GiB RIFF limit`, 'ENCODE');
        }
        const header = new Uint8Array(44);
        const hv = new DataView(header.buffer);
        const write = (at, text) => {
            for (let i = 0; i < text.length; i++)
                header[at + i] = text.charCodeAt(i);
        };
        write(0, 'RIFF');
        hv.setUint32(4, 36 + dataBytes + (dataBytes & 1), true);
        write(8, 'WAVE');
        write(12, 'fmt ');
        hv.setUint32(16, 16, true);
        hv.setUint16(20, 1, true);
        hv.setUint16(22, targetChannels, true);
        hv.setUint32(24, targetRate, true);
        hv.setUint32(28, targetRate * targetChannels * bytesPerSampleOut, true);
        hv.setUint16(32, targetChannels * bytesPerSampleOut, true);
        hv.setUint16(34, outBits, true);
        write(36, 'data');
        hv.setUint32(40, dataBytes, true);
        return header;
    };
    const expectedHeader = buildHeader(expectedFrames);
    const write = async (bytes) => {
        checkAbort(signal);
        await awaitWithAbort(Promise.resolve(options.sink.write(bytes)), signal);
        checkAbort(signal);
        const pending = options.sink.drain?.();
        if (pending)
            await awaitWithAbort(pending, signal);
        checkAbort(signal);
    };
    const emit = async (channels) => {
        const frames = channels[0]?.length ?? 0;
        if (frames === 0)
            return;
        const bytes = new Uint8Array(frames * targetChannels * bytesPerSampleOut);
        const view = new DataView(bytes.buffer);
        for (let f = 0; f < frames; f++) {
            for (let c = 0; c < targetChannels; c++) {
                const v = Math.max(-1, Math.min(1, channels[c][f]));
                const at = (f * targetChannels + c) * bytesPerSampleOut;
                if (outBits === 8)
                    bytes[at] = Math.max(0, Math.min(255, Math.round(v * 128) + 128));
                else if (outBits === 16)
                    view.setInt16(at, v < 0 ? v * 32768 : v * 32767, true);
                else if (outBits === 24) {
                    const q = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)));
                    bytes[at] = q & 0xff;
                    bytes[at + 1] = (q >> 8) & 0xff;
                    bytes[at + 2] = (q >> 16) & 0xff;
                }
                else
                    view.setInt32(at, Math.max(-2147483648, Math.min(2147483647, Math.round(v * 2147483647))), true);
            }
        }
        if (options.sink) {
            await write(bytes);
        }
        else {
            pieces.push(bytes);
        }
        outFrames += frames;
    };
    if (options.sink)
        await write(expectedHeader);
    for (let start = 0; start < totalFrames; start += segmentFrames) {
        checkAbort(signal);
        const frames = Math.min(segmentFrames, totalFrames - start);
        const from = layout.dataOffset + start * bytesPerFrame;
        const slice = await readBlobBytes(file, from, frames * bytesPerFrame, signal);
        const decoded = mapChannels(toFloatChannels(slice, layout, frames), targetChannels);
        await emit(resampler ? resampler.process(decoded) : decoded);
        checkAbort(signal);
        const progress = options.onProgress?.((start + frames) / totalFrames);
        if (progress)
            await awaitWithAbort(progress, signal);
        checkAbort(signal);
        await awaitWithAbort(yieldToEventLoop(), signal);
        checkAbort(signal);
    }
    if (resampler)
        await emit(resampler.flush());
    if (((outFrames * targetChannels * bytesPerSampleOut) & 1) !== 0) {
        const padding = new Uint8Array(1);
        if (options.sink)
            await write(padding);
        else
            pieces.push(padding);
    }
    if (outFrames !== expectedFrames) {
        throw new MediaForgeError(`streaming wav wrote ${outFrames} frames but its header declared ${expectedFrames}`, 'ENCODE');
    }
    checkAbort(signal);
    return {
        blob: options.sink
            ? new Blob([], { type: 'audio/wav' })
            : new Blob([expectedHeader, ...pieces], { type: 'audio/wav' }),
        frames: outFrames,
    };
}
