import { MediaForgeError } from '../core/errors.js';
import { yieldEventLoop } from '../core/demux-guard.js';
const MAX_PENDING_FRAMES = 32;
const to709 = Uint8Array.from({ length: 256 }, (_, value) => {
    const signal = value / 255;
    const linear = signal <= 0.04045 ? signal / 12.92 : ((signal + 0.055) / 1.055) ** 2.4;
    return Math.max(0, Math.min(255, Math.round(255 * (linear < 0.018 ? 4.5 * linear : 1.099 * linear ** 0.45 - 0.099))));
});
function micros(seconds) {
    const value = Math.round(seconds * 1e6);
    if (!Number.isSafeInteger(value))
        throw new MediaForgeError('Video timing exceeds the safe microsecond range', 'FORMAT');
    return value;
}
export class NativeVideoDecoderBridge {
    lifetime;
    consume;
    allowPrecisionLoss;
    decoder;
    frames = [];
    timing = new Map();
    closed = false;
    constructor(lifetime, consume, allowPrecisionLoss) {
        this.lifetime = lifetime;
        this.consume = consume;
        this.allowPrecisionLoss = allowPrecisionLoss;
        this.decoder = new VideoDecoder({
            output: frame => {
                if (this.closed || !lifetime.acceptingOutput) {
                    frame.close();
                    return;
                }
                if (this.frames.length >= MAX_PENDING_FRAMES) {
                    frame.close();
                    lifetime.record(new MediaForgeError('Native video decoder exceeded the frame queue budget', 'OOM'));
                    return;
                }
                this.frames.push(frame);
            },
            error: error => lifetime.record(new MediaForgeError(`Native video decode failed: ${error.message}`, 'DECODE')),
        });
    }
    async configure(config) {
        const native = {
            codec: config.codec,
            codedWidth: config.width,
            codedHeight: config.height,
            ...(config.description ? { description: config.description } : {}),
        };
        const support = await this.lifetime.waitFor(VideoDecoder.isConfigSupported(native));
        if (!support.supported)
            throw new MediaForgeError(`VideoDecoder does not support '${config.codec}'`, 'DECODE');
        this.lifetime.check();
        this.decoder.configure(native);
    }
    async decode(packet) {
        this.lifetime.check();
        const timestamp = micros(packet.timestamp);
        if (this.timing.has(timestamp))
            throw new MediaForgeError('Native video input has duplicate pending timestamps', 'FORMAT');
        if (this.timing.size >= MAX_PENDING_FRAMES)
            throw new MediaForgeError('Native video decoder exceeded the reorder budget', 'OOM');
        this.timing.set(timestamp, { timestamp: packet.timestamp, duration: packet.duration });
        this.decoder.decode(new EncodedVideoChunk({
            type: packet.isKeyframe ? 'key' : 'delta',
            data: packet.data,
            timestamp,
            duration: micros(packet.duration),
        }));
        while (this.decoder.decodeQueueSize > 0) {
            await this.lifetime.waitFor(yieldEventLoop());
            await this.drain();
        }
        await this.drain();
    }
    async flush() {
        await this.lifetime.waitFor(this.decoder.flush());
        await this.drain();
        if (this.timing.size)
            throw new MediaForgeError('Native decoder did not produce all submitted video frames', 'DECODE');
    }
    async drain() {
        while (this.frames.length) {
            const frame = this.frames.shift();
            try {
                this.lifetime.check();
                const timing = this.timing.get(frame.timestamp);
                if (!timing)
                    throw new MediaForgeError('Native decoder returned an unknown frame timestamp', 'DECODE');
                this.timing.delete(frame.timestamp);
                const format = frame.format;
                if (!format)
                    throw new MediaForgeError('Native decoder did not expose a verifiable pixel format', 'DECODE');
                if (/(10|12|16)/.test(format) && !this.allowPrecisionLoss)
                    throw new MediaForgeError('High-depth native video requires allowPrecisionLoss for RGBA8 conversion', 'FORMAT');
                const color = frame.colorSpace;
                if ((color?.primaries && color.primaries !== 'bt709') ||
                    (color?.transfer && !['bt709', 'iec61966-2-1'].includes(color.transfer)))
                    throw new MediaForgeError('Native video bridge supports BT.709 SDR colour; HDR is unsupported', 'FORMAT');
                const width = frame.visibleRect?.width ?? frame.codedWidth;
                const height = frame.visibleRect?.height ?? frame.codedHeight;
                if (!Number.isSafeInteger(width * height) || width * height > 8192 * 8192)
                    throw new MediaForgeError('Native decoded frame exceeds the pixel budget', 'OOM');
                const data = new Uint8Array(width * height * 4);
                await this.lifetime.waitFor(frame.copyTo(data, { format: 'RGBA', colorSpace: 'srgb' }));
                for (let at = 0; at < data.length; at += 4) {
                    data[at] = to709[data[at]];
                    data[at + 1] = to709[data[at + 1]];
                    data[at + 2] = to709[data[at + 2]];
                }
                await this.consume({
                    data,
                    width,
                    height,
                    format: 'RGBA',
                    bitDepth: 8,
                    ...timing,
                    scanType: 'progressive',
                    colorPrimaries: 1,
                    colorTransfer: 1,
                    premultipliedAlpha: false,
                });
            }
            finally {
                frame.close();
            }
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const frame of this.frames.splice(0))
            frame.close();
        this.timing.clear();
        if (this.decoder.state !== 'closed')
            this.decoder.close();
    }
}
export class NativeVideoEncoderBridge {
    lifetime;
    encoder;
    packets = [];
    timing = new Map();
    submitted = 0;
    closed = false;
    constructor(lifetime) {
        this.lifetime = lifetime;
        this.encoder = new VideoEncoder({
            output: (chunk, metadata) => {
                if (this.closed || !lifetime.acceptingOutput)
                    return;
                const timing = this.timing.get(chunk.timestamp);
                if (!timing) {
                    lifetime.record(new MediaForgeError('Native encoder returned an unknown frame timestamp', 'ENCODE'));
                    return;
                }
                this.timing.delete(chunk.timestamp);
                if (this.packets.length >= 4) {
                    lifetime.record(new MediaForgeError('Native encoder exceeded the packet queue budget', 'OOM'));
                    return;
                }
                const data = new Uint8Array(chunk.byteLength);
                chunk.copyTo(data);
                const description = metadata?.decoderConfig?.description;
                const codecConfig = description
                    ? new Uint8Array(ArrayBuffer.isView(description)
                        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
                        : new Uint8Array(description))
                    : undefined;
                this.packets.push({
                    data,
                    timestamp: timing.timestamp,
                    duration: (chunk.duration ?? 0) / 1e6 || timing.duration,
                    isKeyframe: chunk.type === 'key',
                    trackType: 'video',
                    codecConfig,
                });
            },
            error: error => lifetime.record(new MediaForgeError(`Native video encode failed: ${error.message}`, 'ENCODE')),
        });
    }
    async configure(config) {
        const native = {
            codec: config.codec,
            width: config.width,
            height: config.height,
            bitrate: config.bitrate ?? 4_000_000,
            framerate: config.framerate ?? 30,
            latencyMode: 'realtime',
            ...(config.codec.startsWith('avc') ? { avc: { format: 'avc' } } : {}),
        };
        const support = await this.lifetime.waitFor(VideoEncoder.isConfigSupported(native));
        if (!support.supported)
            throw new MediaForgeError(`VideoEncoder does not support '${config.codec}'`, 'ENCODE');
        this.lifetime.check();
        this.encoder.configure(native);
    }
    async encode(frame) {
        this.lifetime.check();
        const timestamp = micros(frame.timestamp);
        if (this.timing.has(timestamp))
            throw new MediaForgeError('Native video encoding requires distinct frame timestamps', 'FORMAT');
        this.timing.set(timestamp, { timestamp: frame.timestamp, duration: frame.duration });
        const native = new VideoFrame(frame.data, {
            format: 'RGBA',
            codedWidth: frame.width,
            codedHeight: frame.height,
            timestamp,
            duration: micros(frame.duration),
            colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true },
        });
        try {
            this.encoder.encode(native, { keyFrame: this.submitted++ % 60 === 0 });
        }
        finally {
            native.close();
        }
        if (this.submitted % 4 === 0)
            return this.flush();
        return this.packets.splice(0);
    }
    async flush() {
        await this.lifetime.waitFor(this.encoder.flush());
        if (this.timing.size)
            throw new MediaForgeError('Native encoder did not return all submitted video frames', 'ENCODE');
        return this.packets.splice(0);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.packets.length = 0;
        this.timing.clear();
        if (this.encoder.state !== 'closed')
            this.encoder.close();
    }
}
