import type { Sink } from '../../core/model/types';
import type { AudioOutputMuxer } from '../../core/contracts/writer';
import { MediaForgeError } from '../../core/errors/errors';
import type { EncodedPacket } from '../../core/model/media';
import {
    declaredFlacHeader,
    flacCrc16,
    flacCrc16Update,
    parseFlacFrameHeader,
    readFlacStreamInfo,
    renumberFlacFrame,
} from '../../core/codec-config/audio/flac-frame';
import type { MediaTags } from '../../core/model/media';
import { flacHeaderWithTags } from './tags';
import { assertOpen } from '../shared/chunk-checks';
import { assertSink } from '../../core/io/sinks/sink-backpressure';
import { attachedView } from '../../core/bytes/typed-array';

function byteView(value: Uint8Array): Uint8Array {
    try {
        return attachedView(value);
    } catch {
        throw new MediaForgeError('FLAC data must be an attached Uint8Array', 'MUX');
    }
}

/** Native FLAC container writer (STREAMINFO + frames from the built-in encoder). */
export class FlacMuxer implements AudioOutputMuxer {
    private chunkCount = 0;
    private readonly sink: Sink;
    private readonly sampleRate: number;
    private readonly channels: number;
    private readonly bitsPerSample: number;
    private codecConfig: Uint8Array | undefined;
    private headerWritten = false;
    private finalized = false;
    private fallbackShortFrameSeen = false;
    /** Samples of the written frames, patched into a STREAMINFO that states an unknown total. */
    private totalSamples = 0;
    /** The sample total the STREAMINFO states; 0 when unknown. */
    private headerTotal = 0;
    private headerBitsNibble = 0;
    private busy = false;
    private failure?: { reason: unknown };

    /** `tags` go into VORBIS_COMMENT and PICTURE blocks when the stream header has none. */
    constructor(
        sink: Sink,
        sampleRate: number,
        channels: number,
        bitsPerSample = 16,
        codecConfig?: Uint8Array,
        private readonly tags?: MediaTags,
    ) {
        assertSink(sink);

        if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 655350) {
            throw new MediaForgeError(
                `FLAC output has an invalid sample rate: ${sampleRate}`,
                'FORMAT',
            );
        }

        if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
            throw new MediaForgeError(
                `FLAC output has an invalid channel count: ${channels}`,
                'FORMAT',
            );
        }

        if (!Number.isInteger(bitsPerSample) || bitsPerSample < 4 || bitsPerSample > 32) {
            throw new MediaForgeError(
                `FLAC output has an invalid bits-per-sample value: ${bitsPerSample}`,
                'FORMAT',
            );
        }

        this.sink = sink;
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.bitsPerSample = bitsPerSample;
        this.codecConfig =
            codecConfig === undefined ? undefined : this.validateCodecConfig(codecConfig);
    }

    /** Provide the encoder stream header; effective until the first chunk is written. */
    setAudioCodecConfig(codecConfig: Uint8Array): void {
        this.assertOpen();
        if (this.headerWritten) {
            throw new MediaForgeError(
                'FLAC codec configuration must precede the first audio chunk',
                'MUX',
            );
        }
        this.codecConfig = this.validateCodecConfig(codecConfig);
    }

    /**
     * Appends one encoded audio chunk; `codecConfig` on the first call carries decoder
     * configuration where the container stores it.
     */
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        this.assertOpen();
        this.busy = true;
        try {
            if (chunk?.trackType !== 'audio') {
                throw new MediaForgeError('addAudioChunk requires an audio chunk', 'MUX');
            }
            let data = byteView(chunk.data);
            if (data.byteLength === 0) {
                throw new MediaForgeError(
                    'FLAC audio chunk payload must be a non-empty Uint8Array',
                    'MUX',
                );
            }
            const timestamp = chunk.timestamp;
            const duration = chunk.duration ?? 0;
            if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration < 0) {
                throw new MediaForgeError('FLAC audio chunk has invalid timing', 'MUX');
            }
            if (codecConfig !== undefined) {
                if (this.headerWritten) {
                    throw new MediaForgeError(
                        'FLAC codec configuration must precede the first audio chunk',
                        'MUX',
                    );
                }
                this.codecConfig = this.validateCodecConfig(codecConfig);
            }

            // Readers time native FLAC frames by the number in their header: frames joined from
            // chained Ogg links or cut from a longer stream are numbered on this file's own count.
            // A STREAMINFO whose block sizes differ (bytes 8-11 of the stream header) declares
            // variable blocking, whose frames carry their first sample.
            const header = parseFlacFrameHeader(data, 0);
            if (header) {
                const config = this.codecConfig;
                const variable =
                    header.blockingStrategy === 1 ||
                    (config !== undefined &&
                        (config[8] !== config[10] || config[9] !== config[11]));
                data =
                    renumberFlacFrame(
                        data,
                        variable ? this.totalSamples : this.chunkCount,
                        variable ? 1 : 0,
                    ) ?? data;
            }
            const shortFrame = !this.codecConfig && this.validateFallbackFrame(data);
            try {
                if (!this.headerWritten) {
                    this.writeHeader();
                    this.headerWritten = true;
                }
                this.sink.write(data);
            } catch (reason) {
                this.failure = { reason };
                throw reason;
            }
            this.fallbackShortFrameSeen = shortFrame;
            this.chunkCount++;
            this.totalSamples +=
                parseFlacFrameHeader(data, 0)?.blockSize ?? Math.round(duration * this.sampleRate);
        } finally {
            this.busy = false;
        }
    }

    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    async finalize(): Promise<void> {
        this.assertOpen();
        if (this.chunkCount === 0) {
            throw new MediaForgeError('finalize with no audio chunks', 'MUX');
        }

        this.finalized = true;
        try {
            // STREAMINFO bytes 13-17 hold 4 bits per sample and the 36-bit sample total; 0 declares
            // it unknown. A stated total other than the frames written (a truncated source) is
            // corrected, and its MD5 (bytes 18-33), taken over other samples, cleared to unknown.
            if (
                this.headerTotal !== this.totalSamples &&
                this.sink.patchAt &&
                this.totalSamples < 2 ** 36
            ) {
                const total = this.totalSamples;
                if (this.headerTotal) this.sink.patchAt(8 + 18, new Uint8Array(16));
                const bytes = Uint8Array.of(
                    this.headerBitsNibble | Math.floor(total / 2 ** 32),
                    (total >>> 24) & 0xff,
                    (total >>> 16) & 0xff,
                    (total >>> 8) & 0xff,
                    total & 0xff,
                );
                this.sink.patchAt(8 + 13, bytes);
            }

            await this.sink.close();
        } catch (reason) {
            this.failure = { reason };
            throw reason;
        }
    }

    private assertOpen(): void {
        if (this.failure) throw this.failure.reason;
        assertOpen(this.finalized);
        if (this.busy) throw new MediaForgeError('FLAC muxer operation already in progress', 'MUX');
    }

    private validateCodecConfig(codecConfig: Uint8Array): Uint8Array {
        codecConfig = new Uint8Array(byteView(codecConfig));
        if (
            codecConfig.length < 42 ||
            codecConfig[0] !== 0x66 ||
            codecConfig[1] !== 0x4c ||
            codecConfig[2] !== 0x61 ||
            codecConfig[3] !== 0x43
        ) {
            throw new MediaForgeError(
                'FLAC codec configuration must contain fLaC + STREAMINFO',
                'MUX',
            );
        }

        let position = 4;
        let blocks = 0;
        let singletonBlocks = 0;
        let streamInfo: Uint8Array | null = null;
        for (;;) {
            if (position + 4 > codecConfig.length || ++blocks > 4096) {
                throw new MediaForgeError(
                    'FLAC codec configuration metadata chain is invalid',
                    'MUX',
                );
            }

            const header = codecConfig[position]!;
            const type = header & 0x7f;
            if (type === 127) {
                throw new MediaForgeError(
                    'FLAC codec configuration contains forbidden metadata type 127',
                    'MUX',
                );
            }
            if (type === 0 || type === 3 || type === 4) {
                const bit = 1 << type;
                if ((singletonBlocks & bit) !== 0) {
                    throw new MediaForgeError(
                        `FLAC codec configuration repeats metadata type ${type}`,
                        'MUX',
                    );
                }
                singletonBlocks |= bit;
            }

            const size =
                (codecConfig[position + 1]! << 16) |
                (codecConfig[position + 2]! << 8) |
                codecConfig[position + 3]!;
            const dataStart = position + 4;
            const dataEnd = dataStart + size;
            if (dataEnd > codecConfig.length) {
                throw new MediaForgeError(
                    'FLAC codec configuration metadata block is truncated',
                    'MUX',
                );
            }

            if (blocks === 1) {
                if (type !== 0 || size !== 34) {
                    throw new MediaForgeError(
                        'FLAC codec configuration must begin with a 34-byte STREAMINFO block',
                        'MUX',
                    );
                }
                streamInfo = codecConfig.subarray(dataStart, dataEnd);
            }

            position = dataEnd;
            if ((header & 0x80) !== 0) break;
        }

        if (position !== codecConfig.length || !streamInfo) {
            throw new MediaForgeError(
                'FLAC codec configuration contains bytes after its metadata chain',
                'MUX',
            );
        }

        const { minBlockSize, maxBlockSize, minFrameSize, maxFrameSize, ...shape } =
            readFlacStreamInfo(streamInfo);
        if (
            minBlockSize < 16 ||
            maxBlockSize < minBlockSize ||
            (minFrameSize !== 0 && maxFrameSize !== 0 && maxFrameSize < minFrameSize)
        ) {
            throw new MediaForgeError(
                'FLAC STREAMINFO has an invalid block or frame size range',
                'MUX',
            );
        }

        if (
            shape.sampleRate !== this.sampleRate ||
            shape.channels !== this.channels ||
            shape.bitsPerSample !== this.bitsPerSample
        ) {
            throw new MediaForgeError('FLAC STREAMINFO does not match the track', 'MUX');
        }
        return codecConfig;
    }

    private validateFallbackFrame(frame: Uint8Array): boolean {
        if (this.fallbackShortFrameSeen) {
            throw new MediaForgeError('FLAC frame follows a short final block', 'MUX');
        }
        if (frame.length > 4 * 1024 * 1024) {
            throw new MediaForgeError('FLAC frame is larger than 4 MiB', 'MUX', {
                hint: 'Pass codecConfig with the STREAMINFO.',
            });
        }

        const parsed = parseFlacFrameHeader(frame, 0);
        const givenCrc =
            frame.length >= 2 ? (frame[frame.length - 2]! << 8) | frame[frame.length - 1]! : -1;
        if (
            !parsed ||
            frame.length < parsed.headerLen + 2 ||
            flacCrc16(frame.subarray(0, frame.length - 2)) !== givenCrc
        ) {
            throw new MediaForgeError('FLAC chunk is not one complete, CRC-valid frame', 'MUX');
        }
        if (parsed.blockingStrategy !== 0) {
            throw new MediaForgeError('FLAC variable-block frames need their STREAMINFO', 'MUX', {
                hint: 'Pass codecConfig with the STREAMINFO.',
            });
        }
        if (parsed.codedNumber !== this.chunkCount) {
            throw new MediaForgeError(
                `FLAC frame number ${parsed.codedNumber} is out of sequence`,
                'MUX',
            );
        }
        if (
            (parsed.sampleRate !== undefined && parsed.sampleRate !== this.sampleRate) ||
            parsed.channelCount !== this.channels ||
            (parsed.bitsPerSample !== undefined && parsed.bitsPerSample !== this.bitsPerSample)
        ) {
            throw new MediaForgeError('FLAC frame does not match the track', 'MUX');
        }

        let candidates = 0;
        let prefixCrc = 0;
        let prefixEnd = 0;
        for (let offset = parsed.headerLen + 2; offset + 5 <= frame.length - 2; offset++) {
            if (frame[offset] !== 0xff || (frame[offset + 1]! & 0xfc) !== 0xf8) continue;
            if (!parseFlacFrameHeader(frame, offset)) continue;
            if (++candidates > 64) {
                throw new MediaForgeError('FLAC frame has too many sync codes to check', 'MUX', {
                    hint: 'Pass codecConfig with the STREAMINFO.',
                });
            }

            prefixCrc = flacCrc16Update(prefixCrc, frame, prefixEnd, offset - 2);
            prefixEnd = offset - 2;

            const precedingCrc = (frame[offset - 2]! << 8) | frame[offset - 1]!;
            if (prefixCrc === precedingCrc) {
                throw new MediaForgeError('FLAC chunk holds more than one frame', 'MUX', {
                    hint: 'Pass codecConfig with the STREAMINFO.',
                });
            }
        }

        if (parsed.blockSize > 4096) {
            throw new MediaForgeError(
                `FLAC frame of ${parsed.blockSize} samples is over 4096`,
                'MUX',
                { hint: 'Pass codecConfig with the STREAMINFO.' },
            );
        }
        return parsed.blockSize < 4096;
    }

    private writeHeader(): void {
        const provided = this.codecConfig;
        if (provided) {
            this.noteHeaderTotal(provided.subarray(8, 42));
            this.sink.write(flacHeaderWithTags(provided, this.tags));
            return;
        }

        const header = declaredFlacHeader(this.sampleRate, this.channels, this.bitsPerSample);
        this.noteHeaderTotal(header.subarray(8));
        this.sink.write(flacHeaderWithTags(header, this.tags));
    }

    private noteHeaderTotal(streamInfo: Uint8Array): void {
        this.headerBitsNibble = streamInfo[13]! & 0xf0;
        this.headerTotal = readFlacStreamInfo(streamInfo).totalSamples;
    }
}
