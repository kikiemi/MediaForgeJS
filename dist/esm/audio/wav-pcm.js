import { MediaForgeError } from '../core/errors.js';
import { readWavLayoutFromBytes } from './streaming-wav.js';
import { createPcmAudioBufferFromChannels, yieldToEventLoop } from './audio-buffer-tools.js';
export async function decodeWavToAudioBuffer(bytes, signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
    const layout = await readWavLayoutFromBytes(bytes, signal);
    if (!layout)
        throw new MediaForgeError('Invalid or unsupported RIFF/RF64 PCM WAVE file', 'DECODE');
    const { dataOffset: dataAt, dataLength: dataSize, channels, sampleRate, bitsPerSample: bits, float } = layout;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bytesPer = bits / 8;
    const frames = dataSize / (bytesPer * channels);
    const out = [];
    for (let c = 0; c < channels; c++)
        out.push(new Float32Array(frames));
    for (let f = 0; f < frames; f++) {
        if ((f & 0xffff) === 0) {
            if (signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
            await yieldToEventLoop();
            if (signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
        }
        let at = dataAt + f * bytesPer * channels;
        for (let c = 0; c < channels; c++) {
            let v;
            if (float) {
                v = bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true);
            }
            else if (bits === 8) {
                v = (bytes[at] - 128) / 128;
            }
            else if (bits === 16) {
                v = view.getInt16(at, true) / 32768;
            }
            else if (bits === 24) {
                const u = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
                v = (u >= 0x800000 ? u - 0x1000000 : u) / 8388608;
            }
            else {
                v = view.getInt32(at, true) / 2147483648;
            }
            out[c][f] = v;
            at += bytesPer;
        }
    }
    return createPcmAudioBufferFromChannels(out, sampleRate);
}
