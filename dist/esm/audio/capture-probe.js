import { logger } from '../core/logger.js';
import { captureViaMediaElement } from './media-element-capture.js';
export async function probeAcceleratedCapture(signal) {
    if (typeof AudioWorkletNode === 'undefined')
        return false;
    const sr = 48000;
    const seconds = 1.2;
    const n = Math.round(sr * seconds);
    const wav = new Uint8Array(44 + n * 2);
    const dv = new DataView(wav.buffer);
    const writeTag = (off, tag) => {
        for (let i = 0; i < 4; i++)
            wav[off + i] = tag.charCodeAt(i);
    };
    writeTag(0, 'RIFF');
    dv.setUint32(4, 36 + n * 2, true);
    writeTag(8, 'WAVE');
    writeTag(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    writeTag(36, 'data');
    dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
        dv.setInt16(44 + i * 2, Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / sr)), true);
    }
    const result = await captureViaMediaElement(new Blob([wav], { type: 'audio/wav' }), sr, true, { signal: signal });
    if (result.effectiveSpeed < 2)
        return false;
    const buf = result.buffer;
    if (buf.length < n * 0.95)
        return false;
    const data = buf.getChannelData(0);
    const tailStart = Math.floor(buf.length * 0.8);
    let energy = 0;
    let crossings = 0;
    for (let i = tailStart; i < buf.length; i++) {
        energy += data[i] * data[i];
        if (i > tailStart && data[i - 1] <= 0 && data[i] > 0)
            crossings++;
    }
    const tailRms = Math.sqrt(energy / Math.max(1, buf.length - tailStart));
    const frequency = (crossings * buf.sampleRate) / Math.max(1, buf.length - tailStart);
    logger.info(`[Converter] accelerated capture probe: effective=${result.effectiveSpeed} tailRms=${tailRms.toFixed(3)} frequency=${frequency.toFixed(0)}`);
    return tailRms > 0.05 && Math.abs(frequency - 1000) < 50;
}
