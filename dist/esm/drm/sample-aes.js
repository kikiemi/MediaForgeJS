import { awaitWithAbort } from '../core/abort.js';
import { MediaForgeError } from '../core/errors.js';
import { adtsFrameLength, decodeAacFrame, decodeAvcNal, SampleAesCrypto, sampleAesAbort, sampleAesBytes, sampleAesYield, } from './sample-aes-crypto.js';
import { decryptSampleAesTs } from './sample-aes-ts.js';
export async function decryptSampleAesAac(frame, key, iv, signal) {
    sampleAesAbort(signal);
    const data = sampleAesBytes(frame, 'AAC frame');
    const crypto = await SampleAesCrypto.create(key, iv, signal);
    await decodeAacFrame(data, crypto);
    sampleAesAbort(signal);
    return data;
}
export async function decryptSampleAesAvc(nal, key, iv, signal) {
    sampleAesAbort(signal);
    const data = sampleAesBytes(nal, 'AVC NAL');
    const crypto = await SampleAesCrypto.create(key, iv, signal);
    const result = await decodeAvcNal(data, crypto, signal);
    sampleAesAbort(signal);
    return result;
}
function supports(context) {
    return (context.key.method === 'SAMPLE-AES' &&
        (context.key.keyFormat === undefined || context.key.keyFormat === 'identity') &&
        context.kind === 'segment' &&
        context.map === undefined &&
        (context.key.keyFormatVersions === undefined || context.key.keyFormatVersions.split('/').includes('1')));
}
function requestIv(request) {
    if (!Number.isSafeInteger(request.sequence) || request.sequence < 0)
        throw new MediaForgeError('SAMPLE-AES requires a non-negative safe media sequence', 'FORMAT');
    const iv = new Uint8Array(16);
    const explicit = request.key.iv;
    if (explicit !== undefined) {
        if (typeof explicit !== 'string' || !/^0x[0-9a-f]{1,32}$/i.test(explicit))
            throw new MediaForgeError('SAMPLE-AES requires a 128-bit hexadecimal IV', 'FORMAT');
        const value = explicit.slice(2).padStart(32, '0');
        for (let i = 0; i < 16; i++)
            iv[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    else {
        let value = BigInt(request.sequence);
        for (let i = 15; i >= 0; i--) {
            iv[i] = Number(value & 255n);
            value >>= 8n;
        }
    }
    return iv;
}
async function skipId3(data, signal) {
    let offset = 0;
    let tags = 0;
    while (data[offset] === 0x49 && data[offset + 1] === 0x44 && data[offset + 2] === 0x33) {
        if (offset + 10 > data.length || ![3, 4].includes(data[offset + 3]) || data[offset + 4] === 0xff)
            throw new MediaForgeError('Invalid SAMPLE-AES packed audio ID3 tag', 'DEMUX');
        let length = 0;
        for (let i = 6; i < 10; i++) {
            const byte = data[offset + i];
            if (byte & 0x80)
                throw new MediaForgeError('Invalid SAMPLE-AES ID3 tag length', 'DEMUX');
            length = length * 128 + byte;
        }
        const footer = data[offset + 3] === 4 && (data[offset + 5] & 0x10) !== 0 ? 10 : 0;
        const end = offset + 10 + length;
        if (end + footer > data.length)
            throw new MediaForgeError('Incomplete SAMPLE-AES packed audio ID3 tag', 'DEMUX');
        if (footer) {
            if (data[end] !== 0x33 || data[end + 1] !== 0x44 || data[end + 2] !== 0x49)
                throw new MediaForgeError('Invalid SAMPLE-AES ID3 footer', 'DEMUX');
            for (let i = 3; i < 10; i++)
                if (data[end + i] !== data[offset + i])
                    throw new MediaForgeError('Mismatched SAMPLE-AES ID3 footer', 'DEMUX');
        }
        offset = end + footer;
        if (++tags > 100000)
            throw new MediaForgeError('SAMPLE-AES resource exceeds 100000 ID3 tags', 'FORMAT');
        if ((tags & 255) === 0)
            await sampleAesYield(signal);
    }
    return offset;
}
async function decryptResource(request) {
    sampleAesAbort(request.signal);
    if (!supports(request) || request.kind !== 'segment' || request.map !== undefined) {
        throw new MediaForgeError('Software SAMPLE-AES requires complete identity MPEG-TS or packed ADTS segments; fMP4 and parts require another handler', 'FORMAT');
    }
    const iv = requestIv(request);
    const data = sampleAesBytes(request.data, 'resource');
    if (data.length >= 8 && ['ftyp', 'styp', 'moof', 'moov'].includes(String.fromCharCode(...data.subarray(4, 8)))) {
        throw new MediaForgeError('SAMPLE-AES fMP4 cbcs requires a CDM handler', 'FORMAT');
    }
    const key = await awaitWithAbort(request.loadKey(), request.signal);
    sampleAesAbort(request.signal);
    const crypto = await SampleAesCrypto.create(key, iv, request.signal);
    if (data[0] === 0x47) {
        await decryptSampleAesTs(data, crypto, request.signal);
        sampleAesAbort(request.signal);
        return data;
    }
    let offset = await skipId3(data, request.signal);
    let frames = 0;
    while (offset < data.length) {
        const length = adtsFrameLength(data, offset);
        const frame = data.slice(offset, offset + length);
        await decodeAacFrame(frame, crypto);
        sampleAesAbort(request.signal);
        data.set(frame, offset);
        offset += length;
        if ((++frames & 255) === 0)
            await sampleAesYield(request.signal);
    }
    if (!frames)
        throw new MediaForgeError('SAMPLE-AES packed audio resource has no ADTS frames', 'DEMUX');
    sampleAesAbort(request.signal);
    return data;
}
export function createSampleAesHandler() {
    return { supports, decrypt: decryptResource };
}
