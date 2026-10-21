import type { Sink } from '../../core/model/types';
import type { AudioOutputMuxer } from '../../core/contracts/writer';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import type { EncodedPacket, PcmAudioBuffer } from '../../core/model/media';
import { BinaryWriter } from '../../core/bytes/binary-writer';
import { awaitWithAbort } from '../../core/io/abort';
import { assertSink } from '../../core/io/sinks/sink-backpressure';
import { yieldEventLoop } from '../../core/io/event-loop';
import { assertOpen } from '../shared/chunk-checks';
import { attachedLength, attachedView } from '../../core/bytes/typed-array';
import { quantizeSample } from '../../core/model/pcm-quantize';

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const PCM_CHUNK_FRAMES = 65536;

function byteView(value: Uint8Array): Uint8Array {
    try {
        return attachedView(value);
    } catch {
        throw new MediaForgeError('Muxer data must be an attached Uint8Array', 'MUX');
    }
}

function validateWavFormat(sampleRate: number, channels: number): void {
    if (
        !Number.isInteger(sampleRate) ||
        sampleRate <= 0 ||
        !Number.isInteger(channels) ||
        channels <= 0 ||
        channels > 0x7fff ||
        sampleRate * channels * 2 > 0xffffffff
    ) {
        throw new MediaForgeError(
            'WAV needs a positive integer sample rate and channel count',
            'FORMAT',
        );
    }
}

function validateWavLength(length: number, channels: number): void {
    if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length % (channels * 2) !== 0 ||
        length > Number.MAX_SAFE_INTEGER - 80
    ) {
        throw new MediaForgeError(
            'WAV PCM size must contain complete frames within the safe integer range',
            'MUX',
        );
    }
}

class MuxerOutput {
    readonly signal?: AbortSignal;
    private readonly writeBytes: Sink['write'];
    private readonly closeSink: Sink['close'];
    private readonly drainSink?: Sink['drain'];
    private finalized = false;
    private busy = false;
    private failure?: { reason: unknown };

    constructor(private readonly sink: Sink) {
        assertSink(sink);
        this.writeBytes = sink.write;
        this.closeSink = sink.close;
        this.drainSink = sink.drain;
        this.signal = sink.signal;
    }

    get canReleaseInput(): boolean {
        return (
            !this.busy &&
            (this.finalized || this.failure !== undefined || this.signal?.aborted === true)
        );
    }

    check(): void {
        if (this.failure) throw this.failure.reason;
        throwIfAborted(this.signal);
    }

    begin(): void {
        this.check();
        assertOpen(this.finalized);
        if (this.busy) throw new MediaForgeError('Muxer operation already in progress', 'MUX');
        this.busy = true;
    }

    end(): void {
        this.busy = false;
    }

    private invoke<T>(action: () => T): T {
        this.check();
        try {
            return action();
        } catch (reason) {
            this.failure ??= { reason };
            throw this.failure.reason;
        }
    }

    write(bytes: Uint8Array): void {
        this.invoke(() => this.writeBytes.call(this.sink, bytes));
        this.check();
    }

    private async wait(action: () => Promise<void>): Promise<void> {
        try {
            await awaitWithAbort(this.invoke(action), this.signal);
            this.check();
        } catch (reason) {
            this.failure ??= { reason };
            throw this.failure.reason;
        }
    }

    async drain(): Promise<void> {
        if (this.drainSink) await this.wait(() => this.drainSink!.call(this.sink));
        else this.check();
    }

    async finalize(write?: () => Promise<void>): Promise<void> {
        this.begin();
        this.finalized = true;
        try {
            if (write) await write();
            else await this.drain();
            await this.wait(() => this.closeSink.call(this.sink));
        } catch (reason) {
            this.failure ??= { reason };
            throw this.failure.reason;
        } finally {
            this.end();
        }
    }
}

/** Writes encoded audio chunks verbatim (mp3/mp2 elementary streams). */
export class RawMuxer implements AudioOutputMuxer {
    private readonly output: MuxerOutput;

    /** `leading` bytes (an ID3v2 tag) are written before the first packet. */
    constructor(
        sink: Sink,
        private leading?: Uint8Array,
    ) {
        this.output = new MuxerOutput(sink);
    }

    addAudioChunk(chunk: EncodedPacket): void {
        this.output.begin();
        try {
            if (chunk?.trackType !== 'audio') {
                throw new MediaForgeError('addAudioChunk requires an audio chunk', 'MUX');
            }
            if (this.leading) this.output.write(this.leading);
            this.leading = undefined;
            this.output.write(byteView(chunk.data));
        } finally {
            this.output.end();
        }
    }

    finalize(): Promise<void> {
        return this.output.finalize();
    }
}

function createWavHeader(sampleRate: number, channels: number, totalBytes: number): Uint8Array {
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
    } else {
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

/** Buffers PCM16 WAV data; finalize writes the header and drains each retained block. */
export class WavMuxer {
    private readonly output: MuxerOutput;
    private pcmData: Array<Uint8Array | undefined> = [];
    private totalBytes = 0;

    constructor(
        sink: Sink,
        private readonly sampleRate: number,
        private readonly channels: number,
    ) {
        validateWavFormat(sampleRate, channels);
        this.output = new MuxerOutput(sink);
    }

    /** Copies complete interleaved signed PCM16 little-endian frames. */
    addPcmData(data: Uint8Array): void {
        this.output.begin();
        try {
            const bytes = byteView(data);
            validateWavLength(bytes.length, this.channels);
            this.validateAdditionalBytes(bytes.length);
            if (!bytes.length) return;
            let copy: Uint8Array;
            try {
                copy = new Uint8Array(bytes);
            } catch {
                throw new MediaForgeError('Unable to allocate WAV PCM bytes', 'OOM');
            }
            this.output.check();
            this.pcmData.push(copy);
            this.totalBytes += copy.length;
        } finally {
            this.output.end();
        }
    }

    addAudioBuffer(buffer: PcmAudioBuffer): void {
        this.output.begin();
        try {
            const { planes, frames } = this.readPlanes(buffer);
            const chunks: Uint8Array[] = [];
            for (let start = 0; start < frames; start += PCM_CHUNK_FRAMES) {
                chunks.push(
                    this.encodeFrames(planes, start, Math.min(frames, start + PCM_CHUNK_FRAMES)),
                );
            }
            this.output.check();
            this.commit(chunks, frames);
        } finally {
            this.output.end();
        }
    }

    /** Converts PCM cooperatively; rejected or cancelled input is never partially appended. */
    async addAudioBufferChunked(buffer: PcmAudioBuffer, signal?: AbortSignal): Promise<void> {
        this.output.begin();
        try {
            throwIfAborted(signal);
            const { planes, frames } = this.readPlanes(buffer);
            const chunks: Uint8Array[] = [];
            for (let start = 0; start < frames; start += PCM_CHUNK_FRAMES) {
                throwIfAborted(signal);
                this.output.check();
                this.validatePlanes(planes, frames);
                const end = Math.min(frames, start + PCM_CHUNK_FRAMES);
                chunks.push(this.encodeFrames(planes, start, end));
                if (end < frames) {
                    await awaitWithAbort(
                        awaitWithAbort(yieldEventLoop(), signal),
                        this.output.signal,
                    );
                }
            }

            throwIfAborted(signal);
            this.output.check();
            this.commit(chunks, frames);
        } finally {
            this.output.end();
        }
    }

    async finalize(): Promise<void> {
        try {
            await this.output.finalize(async () => {
                this.output.write(createWavHeader(this.sampleRate, this.channels, this.totalBytes));
                await this.output.drain();
                for (let index = 0; index < this.pcmData.length; index++) {
                    const bytes = this.pcmData[index]!;
                    this.output.write(bytes);
                    await this.output.drain();
                    this.pcmData[index] = undefined;
                }
            });
        } finally {
            if (this.output.canReleaseInput) {
                this.pcmData = [];
                this.totalBytes = 0;
            }
        }
    }

    private validateAdditionalBytes(bytes: number): void {
        validateWavLength(this.totalBytes + bytes, this.channels);
    }

    private readPlanes(buffer: PcmAudioBuffer): { planes: Float32Array[]; frames: number } {
        const rate = buffer?.sampleRate;
        const channels = buffer?.numberOfChannels;
        const frames = buffer?.length;
        const getChannelData = buffer?.getChannelData;
        if (
            rate !== this.sampleRate ||
            channels !== this.channels ||
            !Number.isSafeInteger(frames) ||
            frames < 0 ||
            typeof getChannelData !== 'function'
        ) {
            throw new MediaForgeError(
                'PCM buffer must match WAV rate, channels and a valid frame count',
                'INPUT',
            );
        }

        this.validateAdditionalBytes(frames * this.channels * 2);
        const planes: Float32Array[] = [];
        for (let channel = 0; channel < this.channels; channel++) {
            const plane = getChannelData.call(buffer, channel);
            try {
                const view = attachedView(plane, 'Float32Array');
                if (view.length !== frames) throw new TypeError('PCM plane length mismatch');
                planes.push(view);
            } catch {
                throw new MediaForgeError(
                    'PCM channels must be attached Float32Array planes of the declared length',
                    'INPUT',
                );
            }
        }

        this.validatePlanes(planes, frames);
        this.output.check();
        return { planes, frames };
    }

    private validatePlanes(planes: Float32Array[], frames: number): void {
        try {
            for (const plane of planes) {
                if (attachedLength(plane, 'Float32Array') !== frames)
                    throw new TypeError('PCM plane length changed');
            }
        } catch {
            throw new MediaForgeError('PCM channels detached or resized during conversion', 'MUX');
        }
    }

    private encodeFrames(planes: Float32Array[], start: number, end: number): Uint8Array {
        let pcm: Int16Array;
        try {
            pcm = new Int16Array((end - start) * this.channels);
        } catch {
            throw new MediaForgeError('Unable to allocate WAV PCM bytes', 'OOM');
        }

        let offset = 0;
        for (let frame = start; frame < end; frame++) {
            for (let channel = 0; channel < this.channels; channel++)
                pcm[offset++] = quantizeSample(planes[channel]![frame]!, 16);
        }

        if (!littleEndian) {
            const view = new DataView(pcm.buffer);
            for (let index = 0; index < pcm.length; index++)
                view.setInt16(index * 2, pcm[index]!, true);
        }

        return new Uint8Array(pcm.buffer);
    }

    private commit(chunks: Uint8Array[], frames: number): void {
        for (const bytes of chunks) this.pcmData.push(bytes);
        this.totalBytes += frames * this.channels * 2;
    }
}
