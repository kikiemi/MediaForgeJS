import { DemuxError, MediaForgeError } from './errors.js';
export const DEMUX_LIMITS = {
    maxSamplesPerTrack: 1_000_000,
    maxSamplesTotal: 1_000_000,
    maxTracks: 64,
    maxTableEntries: 1_000_000,
    maxBoxesPerRange: 16_384,
    maxBoxDepth: 32,
};
export function resolveDemuxBudget(options = {}, defaultMaxSamples = DEMUX_LIMITS.maxSamplesTotal) {
    if (!options || typeof options !== 'object')
        throw new MediaForgeError('Expected demux budget options', 'FORMAT');
    const { maxSamples: requestedSamples, maxIndexBytes: requestedBytes } = options;
    const maxSamples = requestedSamples === undefined ? defaultMaxSamples : requestedSamples;
    const maxIndexBytes = requestedBytes === undefined ? 128 * 1024 * 1024 : requestedBytes;
    for (const [name, value] of [
        ['maxSamples', maxSamples],
        ['maxIndexBytes', maxIndexBytes],
    ]) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new MediaForgeError(`${name} must be a positive safe integer`, 'FORMAT');
        }
    }
    return { maxSamples, maxIndexBytes };
}
export class DemuxIndexBudget {
    limits;
    samples = 0;
    bytes = 0;
    constructor(limits) {
        this.limits = limits;
    }
    checkSamples(count, context = 'sample index') {
        demuxAssert(Number.isSafeInteger(count) && count >= 0, `${context} has an invalid sample count`);
        if (count > this.limits.maxSamples) {
            throw new MediaForgeError(`${context} exceeds maxSamples (${count}/${this.limits.maxSamples})`, 'OOM');
        }
    }
    reserveSamples(count, estimatedBytesPerSample = 256, context = 'sample index') {
        this.checkSamples(count, context);
        if (count > this.limits.maxSamples - this.samples) {
            throw new MediaForgeError(`${context} exceeds maxSamples (${this.samples} + ${count}/${this.limits.maxSamples})`, 'OOM');
        }
        this.reserveBytes(count * estimatedBytesPerSample, context);
        this.samples += count;
    }
    reserveBytes(bytes, context = 'sample index') {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.maxIndexBytes - this.bytes) {
            throw new MediaForgeError(`${context} exceeds maxIndexBytes (${this.bytes} + ${bytes}/${this.limits.maxIndexBytes} estimated bytes)`, 'OOM');
        }
        this.bytes += bytes;
    }
}
export function objectSampleLedgerEntryLimit(_inputBytes) {
    const limits = resolveDemuxBudget();
    return Math.min(limits.maxSamples, Math.floor(limits.maxIndexBytes / 640));
}
export function demuxAssert(condition, message) {
    if (!condition)
        throw new DemuxError(`Malformed input: ${message}`);
}
export async function readExact(source, offset, length) {
    demuxAssert(Number.isFinite(offset) && offset >= 0, `negative read offset (${offset})`);
    demuxAssert(Number.isFinite(length) && length >= 0, `negative read length (${length})`);
    demuxAssert(offset + length <= source.size, `read past EOF (${offset}+${length} > ${source.size})`);
    const bytes = await source.read(offset, length);
    demuxAssert(bytes.length === length, `short read (${bytes.length}/${length} at ${offset})`);
    return bytes;
}
const yieldWaiters = [];
let yieldChannel = null;
export function yieldEventLoop() {
    const g = globalThis;
    if (g.scheduler?.yield)
        return g.scheduler.yield();
    if (typeof g.setImmediate === 'function') {
        return new Promise(resolve => g.setImmediate(resolve));
    }
    if (typeof MessageChannel !== 'undefined') {
        if (!yieldChannel) {
            yieldChannel = new MessageChannel();
            yieldChannel.port1.onmessage = () => {
                yieldWaiters.shift()?.();
            };
        }
        return new Promise(resolve => {
            yieldWaiters.push(resolve);
            yieldChannel.port2.postMessage(0);
        });
    }
    return new Promise(resolve => setTimeout(resolve, 0));
}
