export class MediaForgeError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.name = 'MediaForgeError';
        this.code = code;
    }
}
export class DemuxError extends MediaForgeError {
    constructor(msg) {
        super(msg, 'DEMUX');
        this.name = 'DemuxError';
    }
}
export class DecodeError extends MediaForgeError {
    constructor(msg) {
        super(msg, 'DECODE');
        this.name = 'DecodeError';
    }
}
export class EncodeError extends MediaForgeError {
    constructor(msg) {
        super(msg, 'ENCODE');
        this.name = 'EncodeError';
    }
}
export class MuxError extends MediaForgeError {
    constructor(msg) {
        super(msg, 'MUX');
        this.name = 'MuxError';
    }
}
export class IOError extends MediaForgeError {
    constructor(msg) {
        super(msg, 'IO');
        this.name = 'IOError';
    }
}
export function rethrowIfAbort(error, signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
    if (error instanceof MediaForgeError && error.code === 'ABORT')
        throw error;
    if (error instanceof DOMException && error.name === 'AbortError')
        throw error;
}
export function normalizeBitrateBps(value, kind) {
    if (!value || value <= 0)
        return 0;
    const kbpsMax = kind === 'audio' ? 1000 : 10000;
    const bpsMin = kind === 'audio' ? 8000 : 100000;
    if (value < kbpsMax)
        return Math.round(value * 1000);
    if (value >= bpsMin)
        return Math.round(value);
    throw new MediaForgeError(`ambiguous ${kind}Bitrate ${value}: pass ${Math.round(value / 1000)} for ${Math.round(value / 1000)} kbps ` +
        `or ${value * 1000} for ${value} kbps in bps`, 'FORMAT');
}
