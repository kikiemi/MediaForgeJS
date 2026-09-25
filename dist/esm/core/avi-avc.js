import { buildAvcCFromAnnexB, isAnnexB } from './annexb.js';
import { demuxAssert, yieldEventLoop } from './demux-guard.js';
import { DemuxError } from './errors.js';
import { AVCPictureOrderReader } from './avc-picture-order.js';
export const MAX_AVI_AVC_CONFIG_BYTES = 1024 * 1024;
export class AVIAVCReader {
    codecConfig;
    lengthSize = 4;
    prefersLengths;
    parameters = [];
    parameterBytes = 0;
    order = new AVCPictureOrderReader();
    constructor(extra) {
        this.prefersLengths = extra?.[0] === 1;
        if (!extra?.length)
            return;
        demuxAssert(extra.length <= MAX_AVI_AVC_CONFIG_BYTES, 'AVI H.264 configuration exceeds its size limit');
        if (this.prefersLengths) {
            this.validateConfiguration(extra);
            this.codecConfig = extra.slice();
        }
        else {
            demuxAssert(isAnnexB(extra), 'AVI H.264 configuration must be avcC or Annex B');
            this.codecConfig = buildAvcCFromAnnexB(extra) ?? undefined;
            demuxAssert(this.codecConfig, 'AVI H.264 configuration has no valid SPS/PPS');
            this.validateConfiguration(this.codecConfig);
        }
        this.lengthSize = (this.codecConfig[4] & 3) + 1;
    }
    get codec() {
        const config = this.codecConfig;
        return config
            ? `avc1.${[config[1], config[2], config[3]].map(value => value.toString(16).padStart(2, '0')).join('')}`
            : undefined;
    }
    async inspect(reader, start, size, checkAbort) {
        demuxAssert(size > 0, 'AVI H.264 packet is empty');
        const prefix = await reader.bytes(start, Math.min(size, 32));
        const annexB = isAnnexB(prefix);
        this.order.beginPacket();
        let lengths = !annexB || this.prefersLengths;
        if (annexB && this.prefersLengths) {
            try {
                await this.inspectLengths(reader, start, size, checkAbort, false);
            }
            catch (error) {
                if (!(error instanceof DemuxError))
                    throw error;
                lengths = false;
            }
        }
        const result = lengths
            ? await this.inspectLengths(reader, start, size, checkAbort)
            : await this.inspectAnnexB(reader, start, size, checkAbort);
        if (!this.codecConfig) {
            for (const nal of result.parameters) {
                if (this.parameters.some(previous => previous.length === nal.length && previous.every((byte, index) => byte === nal[index])))
                    continue;
                demuxAssert(this.parameterBytes + nal.length + 4 <= MAX_AVI_AVC_CONFIG_BYTES, 'AVI H.264 parameter sets exceed their size limit');
                this.parameters.push(nal);
                this.parameterBytes += nal.length + 4;
            }
            if (this.parameters.length) {
                const bytes = new Uint8Array(this.parameterBytes);
                let offset = 0;
                for (const nal of this.parameters) {
                    bytes.set([0, 0, 0, 1], offset);
                    bytes.set(nal, offset + 4);
                    offset += nal.length + 4;
                }
                this.codecConfig = buildAvcCFromAnnexB(bytes) ?? undefined;
                if (this.codecConfig)
                    this.parameters = [];
            }
        }
        result.pictureOrder = this.order.finishPacket();
        return result;
    }
    validateConfiguration(bytes) {
        demuxAssert(bytes.length >= 7 && (bytes[4] & 0xfc) === 0xfc && (bytes[5] & 0xe0) === 0xe0, 'AVI avcC header is malformed');
        demuxAssert((bytes[4] & 3) !== 2, 'AVI avcC uses an invalid three-byte NAL length');
        let offset = 6;
        for (const type of [7, 8]) {
            demuxAssert(offset < bytes.length, 'AVI avcC parameter count is truncated');
            const count = type === 7 ? bytes[5] & 31 : bytes[offset++];
            demuxAssert(count > 0, 'AVI avcC is missing SPS/PPS');
            for (let index = 0; index < count; index++) {
                demuxAssert(offset + 2 <= bytes.length, 'AVI avcC parameter length is truncated');
                const length = bytes[offset] * 256 + bytes[offset + 1];
                offset += 2;
                demuxAssert(length >= (type === 7 ? 4 : 2) && offset + length <= bytes.length, 'AVI avcC parameter set is truncated');
                demuxAssert((bytes[offset] & 0x9f) === type, 'AVI avcC parameter type is invalid');
                this.order.parameter(bytes.subarray(offset, offset + length), true);
                offset += length;
            }
        }
    }
    async inspectLengths(reader, start, size, checkAbort, inspect = true) {
        let offset = start;
        const end = start + size;
        const result = { isKeyframe: false, annexB: false, parameters: [], parameterBytes: 0 };
        while (offset < end) {
            checkAbort();
            demuxAssert(end - offset > this.lengthSize, 'AVI H.264 NAL length is truncated');
            const head = await reader.bytes(offset, this.lengthSize + 1);
            let length = 0;
            for (let byte = 0; byte < this.lengthSize; byte++)
                length = length * 256 + head[byte];
            offset += this.lengthSize;
            demuxAssert(length > 0 && length <= end - offset, 'AVI H.264 NAL length exceeds its packet');
            const type = this.nalType(head[this.lengthSize]);
            if (inspect)
                await this.readNal(reader, offset, length, type, result);
            offset += length;
        }
        return result;
    }
    async inspectAnnexB(reader, start, size, checkAbort) {
        const end = start + size;
        const result = { isKeyframe: false, annexB: true, parameters: [], parameterBytes: 0 };
        let zeros = 0;
        let nalStart = -1;
        let type = -1;
        const finish = async (nalEnd) => {
            if (nalStart < 0)
                return;
            demuxAssert(type >= 0 && nalEnd > nalStart, 'AVI H.264 contains an empty NAL unit');
            await this.readNal(reader, nalStart, nalEnd - nalStart, type, result);
        };
        for (let offset = start; offset < end;) {
            if (offset > start && (offset - start) % (1024 * 1024) === 0)
                await yieldEventLoop();
            checkAbort();
            const bytes = await reader.bytes(offset, Math.min(65536, end - offset));
            for (let index = 0; index < bytes.length; index++) {
                const value = bytes[index];
                const position = offset + index;
                if (position === nalStart) {
                    type = this.nalType(value);
                }
                if (value === 1 && zeros >= 2) {
                    await finish(position - zeros);
                    nalStart = position + 1;
                    type = -1;
                }
                zeros = value === 0 ? zeros + 1 : 0;
            }
            offset += bytes.length;
        }
        await finish(end - zeros);
        demuxAssert(nalStart >= 0, 'AVI H.264 Annex B packet has no NAL unit');
        return result;
    }
    nalType(header) {
        const type = header & 31;
        demuxAssert((header & 0x80) === 0 && type > 0 && type < 24, 'AVI H.264 NAL header is invalid');
        return type;
    }
    async readNal(reader, start, length, type, result) {
        if (type === 7 || type === 8) {
            await this.readParameter(reader, start, length, type, result);
        }
        else if ((type >= 1 && type <= 5) || type === 19 || type === 20 || type === 21) {
            demuxAssert(length > 1, 'AVI H.264 slice is truncated');
            this.order.slice(await reader.bytes(start, Math.min(length, 65536)));
            if (type === 5)
                result.isKeyframe = true;
        }
    }
    async readParameter(reader, start, length, type, result) {
        demuxAssert(length >= (type === 7 ? 4 : 2) && length <= 65535, 'AVI H.264 parameter set has an invalid length');
        demuxAssert(result.parameterBytes + length + 4 <= MAX_AVI_AVC_CONFIG_BYTES, 'AVI H.264 parameter sets exceed their size limit');
        result.parameterBytes += length + 4;
        const nal = (await reader.bytes(start, length)).slice();
        this.order.parameter(nal);
        if (!this.codecConfig)
            result.parameters.push(nal);
    }
}
