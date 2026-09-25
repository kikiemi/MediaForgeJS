import { MediaForgeError } from '../core/errors.js';
import { BinaryWriter } from '../core/binary-writer.js';
import { awaitWithAbort } from '../core/abort.js';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length').get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedArrayValues = typedArrayPrototype.values;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const PCM_CHUNK_FRAMES = 65536;
const yieldToEventLoop = () => new Promise(resolve => {
    setTimeout(resolve, 0);
});
function byteView(value) {
    try {
        if (typedArrayTag.call(value) !== 'Uint8Array')
            throw new TypeError('not Uint8Array');
        typedArrayValues.call(value);
        return new Uint8Array(typedArrayBuffer.call(value), typedArrayOffset.call(value), typedArrayLength.call(value));
    }
    catch {
        throw new MediaForgeError('Muxer data must be an attached Uint8Array', 'MUX');
    }
}
function validateWavFormat(sampleRate, channels) {
    if (!Number.isInteger(sampleRate) ||
        sampleRate <= 0 ||
        !Number.isInteger(channels) ||
        channels <= 0 ||
        channels > 0x7fff ||
        sampleRate * channels * 2 > 0xffffffff) {
        throw new MediaForgeError('WAV requires a positive integer rate and channels with representable PCM16 byte rate', 'MUX');
    }
}
function validateWavLength(length, channels) {
    if (!Number.isSafeInteger(length) ||
        length < 0 ||
        length % (channels * 2) !== 0 ||
        length > Number.MAX_SAFE_INTEGER - 80) {
        throw new MediaForgeError('WAV PCM size must contain complete frames within the safe integer range', 'MUX');
    }
}
class MuxerOutput {
    sink;
    signal;
    writeBytes;
    closeSink;
    drainSink;
    finalized = false;
    busy = false;
    failure;
    constructor(sink) {
        this.sink = sink;
        const write = sink?.write;
        const close = sink?.close;
        const drain = sink?.drain;
        const signal = sink?.signal;
        if (typeof write !== 'function' ||
            typeof close !== 'function' ||
            (drain !== undefined && typeof drain !== 'function') ||
            (signal !== undefined &&
                (!signal ||
                    typeof signal.aborted !== 'boolean' ||
                    typeof signal.addEventListener !== 'function' ||
                    typeof signal.removeEventListener !== 'function'))) {
            throw new MediaForgeError('Muxer sink requires write(), close() and valid optional drain() and signal', 'IO');
        }
        this.writeBytes = write;
        this.closeSink = close;
        this.drainSink = drain;
        this.signal = signal;
    }
    get canReleaseInput() {
        return !this.busy && (this.finalized || this.failure !== undefined || this.signal?.aborted === true);
    }
    check() {
        if (this.failure)
            throw this.failure.reason;
        if (this.signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    }
    begin() {
        this.check();
        if (this.finalized)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (this.busy)
            throw new MediaForgeError('Muxer operation already in progress', 'MUX');
        this.busy = true;
    }
    end() {
        this.busy = false;
    }
    invoke(action) {
        this.check();
        try {
            return action();
        }
        catch (reason) {
            this.failure ??= { reason };
            throw this.failure.reason;
        }
    }
    write(bytes) {
        this.invoke(() => this.writeBytes.call(this.sink, bytes));
        this.check();
    }
    async wait(action) {
        try {
            await awaitWithAbort(this.invoke(action), this.signal);
            this.check();
        }
        catch (reason) {
            this.failure ??= { reason };
            throw this.failure.reason;
        }
    }
    async drain() {
        if (this.drainSink)
            await this.wait(() => this.drainSink.call(this.sink));
        else
            this.check();
    }
    async finalize(write) {
        this.begin();
        this.finalized = true;
        try {
            if (write)
                await write();
            else
                await this.drain();
            await this.wait(() => this.closeSink.call(this.sink));
        }
        catch (reason) {
            this.failure ??= { reason };
            throw this.failure.reason;
        }
        finally {
            this.end();
        }
    }
}
export class RawMuxer {
    output;
    constructor(sink) {
        this.output = new MuxerOutput(sink);
    }
    addAudioChunk(chunk) {
        this.output.begin();
        try {
            if (chunk?.trackType !== 'audio') {
                throw new MediaForgeError('addAudioChunk requires an audio chunk', 'MUX');
            }
            this.output.write(byteView(chunk.data));
        }
        finally {
            this.output.end();
        }
    }
    finalize() {
        return this.output.finalize();
    }
}
export function createWavHeader(sampleRate, channels, totalBytes) {
    validateWavFormat(sampleRate, channels);
    validateWavLength(totalBytes, channels);
    const rf64 = 36 + totalBytes > 0xffffffff;
    const writer = new BinaryWriter(rf64 ? 80 : 44);
    if (rf64) {
        const riffSize = 72 + totalBytes;
        const sampleCount = totalBytes / (channels * 2);
        writer.writeASCII('RF64');
        writer.writeU32LE(0xffffffff);
        writer.writeASCII('WAVE');
        writer.writeASCII('ds64');
        writer.writeU32LE(28);
        for (const size of [riffSize, totalBytes, sampleCount]) {
            writer.writeU32LE(size >>> 0);
            writer.writeU32LE(Math.floor(size / 0x100000000));
        }
        writer.writeU32LE(0);
    }
    else {
        writer.writeASCII('RIFF');
        writer.writeU32LE(36 + totalBytes);
        writer.writeASCII('WAVE');
    }
    writer.writeASCII('fmt ');
    writer.writeU32LE(16);
    writer.writeU16LE(1);
    writer.writeU16LE(channels);
    writer.writeU32LE(sampleRate);
    writer.writeU32LE(sampleRate * channels * 2);
    writer.writeU16LE(channels * 2);
    writer.writeU16LE(16);
    writer.writeASCII('data');
    writer.writeU32LE(rf64 ? 0xffffffff : totalBytes);
    return writer.toUint8Array();
}
export class WAVMuxer {
    sampleRate;
    channels;
    output;
    pcmData = [];
    totalBytes = 0;
    constructor(sink, sampleRate, channels) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        validateWavFormat(sampleRate, channels);
        this.output = new MuxerOutput(sink);
    }
    addPCMData(data) {
        this.output.begin();
        try {
            const bytes = byteView(data);
            validateWavLength(bytes.length, this.channels);
            this.validateAdditionalBytes(bytes.length);
            if (!bytes.length)
                return;
            let copy;
            try {
                copy = new Uint8Array(bytes);
            }
            catch {
                throw new MediaForgeError('Unable to allocate WAV PCM bytes', 'OOM');
            }
            this.output.check();
            this.pcmData.push(copy);
            this.totalBytes += copy.length;
        }
        finally {
            this.output.end();
        }
    }
    addAudioBuffer(buffer) {
        this.output.begin();
        try {
            const { planes, frames } = this.readPlanes(buffer);
            const chunks = [];
            for (let start = 0; start < frames; start += PCM_CHUNK_FRAMES) {
                chunks.push(this.encodeFrames(planes, start, Math.min(frames, start + PCM_CHUNK_FRAMES)));
            }
            this.output.check();
            this.commit(chunks, frames);
        }
        finally {
            this.output.end();
        }
    }
    async addAudioBufferChunked(buffer, signal) {
        this.output.begin();
        try {
            signal?.throwIfAborted();
            const { planes, frames } = this.readPlanes(buffer);
            const chunks = [];
            for (let start = 0; start < frames; start += PCM_CHUNK_FRAMES) {
                signal?.throwIfAborted();
                this.output.check();
                this.validatePlanes(planes, frames);
                const end = Math.min(frames, start + PCM_CHUNK_FRAMES);
                chunks.push(this.encodeFrames(planes, start, end));
                if (end < frames) {
                    await awaitWithAbort(awaitWithAbort(yieldToEventLoop(), signal), this.output.signal);
                }
            }
            signal?.throwIfAborted();
            this.output.check();
            this.commit(chunks, frames);
        }
        finally {
            this.output.end();
        }
    }
    async finalize() {
        try {
            await this.output.finalize(async () => {
                this.output.write(createWavHeader(this.sampleRate, this.channels, this.totalBytes));
                await this.output.drain();
                for (let index = 0; index < this.pcmData.length; index++) {
                    const bytes = this.pcmData[index];
                    this.output.write(bytes);
                    await this.output.drain();
                    this.pcmData[index] = undefined;
                }
            });
        }
        finally {
            if (this.output.canReleaseInput) {
                this.pcmData = [];
                this.totalBytes = 0;
            }
        }
    }
    validateAdditionalBytes(bytes) {
        validateWavLength(this.totalBytes + bytes, this.channels);
    }
    readPlanes(buffer) {
        const rate = buffer?.sampleRate;
        const channels = buffer?.numberOfChannels;
        const frames = buffer?.length;
        const getChannelData = buffer?.getChannelData;
        if (rate !== this.sampleRate ||
            channels !== this.channels ||
            !Number.isSafeInteger(frames) ||
            frames < 0 ||
            typeof getChannelData !== 'function') {
            throw new MediaForgeError('PCM buffer must match WAV rate, channels and a valid frame count', 'MUX');
        }
        this.validateAdditionalBytes(frames * this.channels * 2);
        const planes = [];
        for (let channel = 0; channel < this.channels; channel++) {
            const plane = getChannelData.call(buffer, channel);
            try {
                if (typedArrayTag.call(plane) !== 'Float32Array')
                    throw new TypeError('not Float32 PCM');
                typedArrayValues.call(plane);
                if (typedArrayLength.call(plane) !== frames)
                    throw new TypeError('PCM plane length mismatch');
                planes.push(new Float32Array(typedArrayBuffer.call(plane), typedArrayOffset.call(plane), frames));
            }
            catch {
                throw new MediaForgeError('PCM channels must be attached Float32Array planes of the declared length', 'MUX');
            }
        }
        this.validatePlanes(planes, frames);
        this.output.check();
        return { planes, frames };
    }
    validatePlanes(planes, frames) {
        try {
            for (const plane of planes) {
                typedArrayValues.call(plane);
                if (typedArrayLength.call(plane) !== frames)
                    throw new TypeError('PCM plane length changed');
            }
        }
        catch {
            throw new MediaForgeError('PCM channels detached or resized during conversion', 'MUX');
        }
    }
    encodeFrames(planes, start, end) {
        let pcm;
        try {
            pcm = new Int16Array((end - start) * this.channels);
        }
        catch {
            throw new MediaForgeError('Unable to allocate WAV PCM bytes', 'OOM');
        }
        let offset = 0;
        for (let frame = start; frame < end; frame++) {
            for (let channel = 0; channel < this.channels; channel++) {
                const value = Math.max(-1, Math.min(1, planes[channel][frame]));
                pcm[offset++] = value < 0 ? value * 32768 : value * 32767;
            }
        }
        if (!littleEndian) {
            const view = new DataView(pcm.buffer);
            for (let index = 0; index < pcm.length; index++)
                view.setInt16(index * 2, pcm[index], true);
        }
        return new Uint8Array(pcm.buffer);
    }
    commit(chunks, frames) {
        for (const bytes of chunks)
            this.pcmData.push(bytes);
        this.totalBytes += frames * this.channels * 2;
    }
}
