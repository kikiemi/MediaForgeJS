import { MediaForgeError } from '../core/errors.js';
import { BinaryWriter } from '../core/binary-writer.js';
import { flacCrc16, parseFlacFrameHeader } from '../core/flac-frame.js';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length').get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedArrayValues = typedArrayPrototype.values;
function byteView(value) {
    try {
        if (typedArrayTag.call(value) !== 'Uint8Array')
            throw new TypeError('not Uint8Array');
        typedArrayValues.call(value);
        return new Uint8Array(typedArrayBuffer.call(value), typedArrayOffset.call(value), typedArrayLength.call(value));
    }
    catch {
        throw new MediaForgeError('FLAC data must be an attached Uint8Array', 'MUX');
    }
}
function updateFlacCrc16(crc, byte) {
    let next = crc ^ (byte << 8);
    for (let bit = 0; bit < 8; bit++) {
        next = next & 0x8000 ? ((next << 1) ^ 0x8005) & 0xffff : (next << 1) & 0xffff;
    }
    return next;
}
export class FLACMuxer {
    chunkCount = 0;
    sink;
    sampleRate;
    channels;
    bitsPerSample;
    codecConfig;
    headerWritten = false;
    finalized = false;
    fallbackShortFrameSeen = false;
    busy = false;
    failure;
    constructor(sink, sampleRate, channels, bitsPerSample = 16, codecConfig) {
        if (!sink || typeof sink.write !== 'function' || typeof sink.close !== 'function') {
            throw new MediaForgeError('FLAC output requires a sink with write() and close()', 'MUX');
        }
        if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 655350) {
            throw new MediaForgeError(`FLAC output has an invalid sample rate: ${sampleRate}`, 'MUX');
        }
        if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
            throw new MediaForgeError(`FLAC output has an invalid channel count: ${channels}`, 'MUX');
        }
        if (!Number.isInteger(bitsPerSample) || bitsPerSample < 4 || bitsPerSample > 32) {
            throw new MediaForgeError(`FLAC output has an invalid bits-per-sample value: ${bitsPerSample}`, 'MUX');
        }
        this.sink = sink;
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.bitsPerSample = bitsPerSample;
        this.codecConfig = codecConfig === undefined ? undefined : this.validateCodecConfig(codecConfig);
    }
    setCodecConfig(codecConfig) {
        this.assertOpen();
        if (this.headerWritten) {
            throw new MediaForgeError('FLAC codec configuration must precede the first audio chunk', 'MUX');
        }
        this.codecConfig = this.validateCodecConfig(codecConfig);
    }
    setAudioCodecConfig(codecConfig) {
        this.setCodecConfig(codecConfig);
    }
    addAudioChunk(chunk, codecConfig) {
        this.assertOpen();
        this.busy = true;
        try {
            if (chunk?.trackType !== 'audio') {
                throw new MediaForgeError('addAudioChunk requires an audio chunk', 'MUX');
            }
            const data = byteView(chunk.data);
            if (data.byteLength === 0) {
                throw new MediaForgeError('FLAC audio chunk payload must be a non-empty Uint8Array', 'MUX');
            }
            const timestamp = chunk.timestamp;
            const duration = chunk.duration ?? 0;
            if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration < 0) {
                throw new MediaForgeError('FLAC audio chunk has invalid timing', 'MUX');
            }
            if (codecConfig !== undefined) {
                if (this.headerWritten) {
                    throw new MediaForgeError('FLAC codec configuration must precede the first audio chunk', 'MUX');
                }
                this.codecConfig = this.validateCodecConfig(codecConfig);
            }
            const shortFrame = !this.codecConfig && this.validateFallbackFrame(data);
            try {
                if (!this.headerWritten) {
                    this.writeHeader();
                    this.headerWritten = true;
                }
                this.sink.write(data);
            }
            catch (reason) {
                this.failure = { reason };
                throw reason;
            }
            this.fallbackShortFrameSeen = shortFrame;
            this.chunkCount++;
        }
        finally {
            this.busy = false;
        }
    }
    async finalize() {
        this.assertOpen();
        if (this.chunkCount === 0) {
            throw new MediaForgeError('finalize with no audio chunks', 'MUX');
        }
        this.finalized = true;
        try {
            await this.sink.close();
        }
        catch (reason) {
            this.failure = { reason };
            throw reason;
        }
    }
    assertOpen() {
        if (this.failure)
            throw this.failure.reason;
        if (this.finalized)
            throw new MediaForgeError('Muxer already finalized', 'MUX');
        if (this.busy)
            throw new MediaForgeError('FLAC muxer operation already in progress', 'MUX');
    }
    validateCodecConfig(codecConfig) {
        codecConfig = new Uint8Array(byteView(codecConfig));
        if (codecConfig.length < 42 ||
            codecConfig[0] !== 0x66 ||
            codecConfig[1] !== 0x4c ||
            codecConfig[2] !== 0x61 ||
            codecConfig[3] !== 0x43) {
            throw new MediaForgeError('FLAC codec configuration must contain fLaC + STREAMINFO', 'MUX');
        }
        let position = 4;
        let blocks = 0;
        let singletonBlocks = 0;
        let streamInfo = null;
        for (;;) {
            if (position + 4 > codecConfig.length || ++blocks > 4096) {
                throw new MediaForgeError('FLAC codec configuration metadata chain is invalid', 'MUX');
            }
            const header = codecConfig[position];
            const type = header & 0x7f;
            if (type === 127) {
                throw new MediaForgeError('FLAC codec configuration contains forbidden metadata type 127', 'MUX');
            }
            if (type === 0 || type === 3 || type === 4) {
                const bit = 1 << type;
                if ((singletonBlocks & bit) !== 0) {
                    throw new MediaForgeError(`FLAC codec configuration repeats metadata type ${type}`, 'MUX');
                }
                singletonBlocks |= bit;
            }
            const size = (codecConfig[position + 1] << 16) | (codecConfig[position + 2] << 8) | codecConfig[position + 3];
            const dataStart = position + 4;
            const dataEnd = dataStart + size;
            if (dataEnd > codecConfig.length) {
                throw new MediaForgeError('FLAC codec configuration metadata block is truncated', 'MUX');
            }
            if (blocks === 1) {
                if (type !== 0 || size !== 34) {
                    throw new MediaForgeError('FLAC codec configuration must begin with a 34-byte STREAMINFO block', 'MUX');
                }
                streamInfo = codecConfig.subarray(dataStart, dataEnd);
            }
            position = dataEnd;
            if ((header & 0x80) !== 0)
                break;
        }
        if (position !== codecConfig.length || !streamInfo) {
            throw new MediaForgeError('FLAC codec configuration contains bytes after its metadata chain', 'MUX');
        }
        const minBlockSize = (streamInfo[0] << 8) | streamInfo[1];
        const maxBlockSize = (streamInfo[2] << 8) | streamInfo[3];
        const minFrameSize = (streamInfo[4] << 16) | (streamInfo[5] << 8) | streamInfo[6];
        const maxFrameSize = (streamInfo[7] << 16) | (streamInfo[8] << 8) | streamInfo[9];
        if (minBlockSize < 16 ||
            maxBlockSize < minBlockSize ||
            (minFrameSize !== 0 && maxFrameSize !== 0 && maxFrameSize < minFrameSize)) {
            throw new MediaForgeError('FLAC STREAMINFO has an invalid block or frame size range', 'MUX');
        }
        const sampleRate = (streamInfo[10] << 12) | (streamInfo[11] << 4) | (streamInfo[12] >> 4);
        const channels = ((streamInfo[12] >> 1) & 7) + 1;
        const bitsPerSample = (((streamInfo[12] & 1) << 4) | (streamInfo[13] >> 4)) + 1;
        if (sampleRate !== this.sampleRate || channels !== this.channels || bitsPerSample !== this.bitsPerSample) {
            throw new MediaForgeError(`FLAC STREAMINFO ${sampleRate}Hz/${channels}ch/${bitsPerSample}bit does not match ` +
                `${this.sampleRate}Hz/${this.channels}ch/${this.bitsPerSample}bit`, 'MUX');
        }
        return codecConfig;
    }
    validateFallbackFrame(frame) {
        if (this.fallbackShortFrameSeen) {
            throw new MediaForgeError('FLAC synthesized STREAMINFO cannot accept frames after a short final block', 'MUX');
        }
        if (frame.length > 4 * 1024 * 1024) {
            throw new MediaForgeError('FLAC synthesized STREAMINFO frame exceeds the 4 MiB validation limit; provide codecConfig', 'MUX');
        }
        const parsed = parseFlacFrameHeader(frame, 0);
        const givenCrc = frame.length >= 2 ? (frame[frame.length - 2] << 8) | frame[frame.length - 1] : -1;
        if (!parsed ||
            frame.length < parsed.headerLen + 2 ||
            flacCrc16(frame.subarray(0, frame.length - 2)) !== givenCrc) {
            throw new MediaForgeError('FLAC synthesized STREAMINFO requires exactly one complete CRC-valid frame per chunk', 'MUX');
        }
        if (parsed.blockingStrategy !== 0) {
            throw new MediaForgeError('FLAC synthesized STREAMINFO requires the built-in encoder fixed-block framing; provide codecConfig for variable-block frames', 'MUX');
        }
        if (parsed.codedNumber !== this.chunkCount) {
            throw new MediaForgeError(`FLAC synthesized STREAMINFO requires consecutive frame numbers from zero (expected ${this.chunkCount}, got ${parsed.codedNumber})`, 'MUX');
        }
        if ((parsed.sampleRate !== undefined && parsed.sampleRate !== this.sampleRate) ||
            parsed.channelCount !== this.channels ||
            (parsed.bitsPerSample !== undefined && parsed.bitsPerSample !== this.bitsPerSample)) {
            const parsedRate = parsed.sampleRate === undefined ? 'STREAMINFO' : `${parsed.sampleRate}Hz`;
            const parsedBits = parsed.bitsPerSample === undefined ? 'STREAMINFO' : `${parsed.bitsPerSample}bit`;
            throw new MediaForgeError(`FLAC frame ${parsedRate}/${parsed.channelCount}ch/${parsedBits} does not match synthesized ` +
                `STREAMINFO ${this.sampleRate}Hz/${this.channels}ch/${this.bitsPerSample}bit`, 'MUX');
        }
        let candidates = 0;
        let prefixCrc = 0;
        let prefixEnd = 0;
        for (let offset = parsed.headerLen + 2; offset + 5 <= frame.length - 2; offset++) {
            if (frame[offset] !== 0xff || (frame[offset + 1] & 0xfc) !== 0xf8)
                continue;
            if (!parseFlacFrameHeader(frame, offset))
                continue;
            if (++candidates > 64) {
                throw new MediaForgeError('FLAC synthesized STREAMINFO frame contains too many sync candidates; provide codecConfig', 'MUX');
            }
            while (prefixEnd < offset - 2) {
                prefixCrc = updateFlacCrc16(prefixCrc, frame[prefixEnd]);
                prefixEnd++;
            }
            const precedingCrc = (frame[offset - 2] << 8) | frame[offset - 1];
            if (prefixCrc === precedingCrc) {
                throw new MediaForgeError('FLAC synthesized STREAMINFO requires exactly one frame per chunk; provide codecConfig for combined frames', 'MUX');
            }
        }
        if (parsed.blockSize > 4096) {
            throw new MediaForgeError(`FLAC synthesized STREAMINFO supports at most 4096 samples per frame (got ${parsed.blockSize}); provide codecConfig`, 'MUX');
        }
        return parsed.blockSize < 4096;
    }
    writeHeader() {
        const provided = this.codecConfig;
        if (provided) {
            this.sink.write(provided);
            return;
        }
        const w = new BinaryWriter();
        w.writeASCII('fLaC');
        const si = new Uint8Array(34);
        const dv = new DataView(si.buffer);
        dv.setUint16(0, 4096, false);
        dv.setUint16(2, 4096, false);
        const sr = this.sampleRate;
        const ch = this.channels - 1;
        const bps = this.bitsPerSample - 1;
        si[10] = (sr >> 12) & 0xff;
        si[11] = (sr >> 4) & 0xff;
        si[12] = ((sr & 0xf) << 4) | ((ch & 7) << 1) | ((bps >> 4) & 1);
        si[13] = (bps & 0xf) << 4;
        const blockHeader = new Uint8Array(4);
        blockHeader[0] = 0x80;
        blockHeader[3] = 34;
        w.writeBytes(blockHeader);
        w.writeBytes(si);
        this.sink.write(w.toUint8Array());
    }
}
