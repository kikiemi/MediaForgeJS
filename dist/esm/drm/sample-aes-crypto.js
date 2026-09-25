import { awaitWithAbort } from '../core/abort.js';
import { MediaForgeError } from '../core/errors.js';
export const SAMPLE_AES_MAX_BYTES = 64 * 1024 * 1024;
const arrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const arrayLength = Object.getOwnPropertyDescriptor(arrayPrototype, 'byteLength').get;
const arrayBuffer = Object.getOwnPropertyDescriptor(arrayPrototype, 'buffer').get;
const arrayTag = Object.getOwnPropertyDescriptor(arrayPrototype, Symbol.toStringTag).get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const arrayValues = Uint8Array.prototype.values;
export function sampleAesBytes(value, name, exactLength) {
    let length;
    try {
        if (arrayTag.call(value) !== 'Uint8Array')
            throw new Error();
        arrayValues.call(value);
        length = arrayLength.call(value);
        bufferLength.call(arrayBuffer.call(value));
    }
    catch {
        throw new MediaForgeError(`SAMPLE-AES ${name} must be an attached Uint8Array backed by ArrayBuffer`, 'FORMAT');
    }
    if (length === 0 || length > SAMPLE_AES_MAX_BYTES || (exactLength !== undefined && length !== exactLength)) {
        throw new MediaForgeError(`SAMPLE-AES ${name} has an invalid byte length`, 'FORMAT');
    }
    return new Uint8Array(value);
}
export function sampleAesAbort(signal) {
    if (signal?.aborted)
        throw new MediaForgeError('SAMPLE-AES was aborted', 'ABORT');
}
export async function sampleAesYield(signal) {
    sampleAesAbort(signal);
    let timer;
    try {
        await awaitWithAbort(new Promise(resolve => {
            timer = setTimeout(resolve, 0);
        }), signal);
        sampleAesAbort(signal);
    }
    finally {
        clearTimeout(timer);
    }
}
export class SampleAesCrypto {
    subtle;
    key;
    iv;
    signal;
    samples = 0;
    constructor(subtle, key, iv, signal) {
        this.subtle = subtle;
        this.key = key;
        this.iv = iv;
        this.signal = signal;
    }
    static async create(keyBytes, ivBytes, signal) {
        sampleAesAbort(signal);
        const bytes = sampleAesBytes(keyBytes, 'key', 16);
        const iv = sampleAesBytes(ivBytes, 'IV', 16);
        const subtle = globalThis.crypto?.subtle;
        if (!subtle)
            throw new MediaForgeError('SAMPLE-AES requires WebCrypto AES-CBC', 'FORMAT');
        try {
            const key = await awaitWithAbort(subtle.importKey('raw', bytes, 'AES-CBC', false, ['encrypt', 'decrypt']), signal);
            sampleAesAbort(signal);
            return new SampleAesCrypto(subtle, key, iv, signal);
        }
        catch (error) {
            sampleAesAbort(signal);
            if (error instanceof MediaForgeError)
                throw error;
            throw new MediaForgeError('SAMPLE-AES could not import the AES-128 key', 'DECODE');
        }
        finally {
            bytes.fill(0);
        }
    }
    consumeSample() {
        if (++this.samples > 100000)
            throw new MediaForgeError('SAMPLE-AES resource exceeds 100000 samples', 'FORMAT');
    }
    async decrypt(blocks) {
        sampleAesAbort(this.signal);
        if (!blocks.length || blocks.length % 16)
            throw new MediaForgeError('Invalid SAMPLE-AES protected block', 'DEMUX');
        try {
            const padding = await awaitWithAbort(this.subtle.encrypt({ name: 'AES-CBC', iv: blocks.slice(-16) }, this.key, new Uint8Array(0)), this.signal);
            sampleAesAbort(this.signal);
            const padded = new Uint8Array(blocks.length + 16);
            padded.set(blocks);
            padded.set(new Uint8Array(padding), blocks.length);
            const clear = await awaitWithAbort(this.subtle.decrypt({ name: 'AES-CBC', iv: this.iv }, this.key, padded), this.signal);
            sampleAesAbort(this.signal);
            return new Uint8Array(clear);
        }
        catch (error) {
            sampleAesAbort(this.signal);
            if (error instanceof MediaForgeError)
                throw error;
            throw new MediaForgeError('SAMPLE-AES AES-CBC decryption failed', 'DECODE');
        }
    }
}
export function adtsFrameLength(data, offset) {
    if (offset + 7 > data.length || data[offset] !== 0xff || (data[offset + 1] & 0xf6) !== 0xf0) {
        throw new MediaForgeError('SAMPLE-AES requires complete ADTS AAC frames', 'DEMUX');
    }
    const header = data[offset + 1] & 1 ? 7 : 9;
    const length = ((data[offset + 3] & 3) << 11) | (data[offset + 4] << 3) | (data[offset + 5] >> 5);
    if (length < header || offset + length > data.length || ((data[offset + 2] >> 2) & 15) >= 13) {
        throw new MediaForgeError('SAMPLE-AES has an invalid or incomplete ADTS frame', 'DEMUX');
    }
    if ((data[offset + 6] & 3) !== 0)
        throw new MediaForgeError('SAMPLE-AES ADTS frames with multiple raw data blocks are unsupported', 'FORMAT');
    return length;
}
export async function decodeAacFrame(data, crypto) {
    if (adtsFrameLength(data, 0) !== data.length)
        throw new MediaForgeError('SAMPLE-AES AAC helper requires exactly one ADTS frame', 'DEMUX');
    crypto.consumeSample();
    const start = (data[1] & 1 ? 7 : 9) + 16;
    const length = Math.max(0, Math.floor((data.length - start) / 16)) * 16;
    if (length)
        data.set(await crypto.decrypt(data.slice(start, start + length)), start);
}
export async function decodeAvcNal(data, crypto, signal, removed) {
    const type = data[0] & 31;
    if (!data.length || (data[0] & 0x80) !== 0 || type === 0 || type > 23) {
        throw new MediaForgeError('SAMPLE-AES requires an AVC NAL unit without its start code', 'DEMUX');
    }
    crypto.consumeSample();
    if ((type !== 1 && type !== 5) || data.length <= 48)
        return data;
    const plain = new Uint8Array(data.length);
    let size = 0;
    let zeros = 0;
    for (let i = 0; i < data.length; i++) {
        const byte = data[i];
        if (zeros === 2 && byte === 3) {
            if (i + 1 === data.length || data[i + 1] > 3)
                throw new MediaForgeError('Invalid SAMPLE-AES AVC emulation prevention', 'DEMUX');
            removed?.(i);
            zeros = 0;
        }
        else {
            plain[size++] = byte;
            zeros = byte === 0 ? zeros + 1 : 0;
            if (zeros > 2)
                throw new MediaForgeError('Unescaped start code in SAMPLE-AES AVC NAL unit', 'DEMUX');
        }
        if ((i & 0x3ffff) === 0x3ffff)
            await sampleAesYield(signal);
    }
    if (size <= 48)
        throw new MediaForgeError('Invalid SAMPLE-AES AVC protected NAL length', 'DEMUX');
    const blocks = new Uint8Array(Math.ceil((size - 48) / 160) * 16);
    let position = 0;
    for (let offset = 32; offset + 16 < size; offset += 160) {
        blocks.set(plain.subarray(offset, offset + 16), position);
        position += 16;
    }
    const clear = await crypto.decrypt(blocks);
    position = 0;
    for (let offset = 32; offset + 16 < size; offset += 160) {
        plain.set(clear.subarray(position, position + 16), offset);
        position += 16;
    }
    return plain.slice(0, size);
}
