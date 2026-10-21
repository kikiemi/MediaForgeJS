import assert from 'node:assert/strict';
import { setImmediate as yieldTask } from 'node:timers/promises';

/**
 * WebCodecs video doubles. Timestamps in `failAt`, `throwAt` and `hidden` are microseconds: the
 * decoder reports an asynchronous error, throws from decode(), or outputs no frame for that chunk.
 * `evented` codecs dispatch dequeue events; `decodeSupport` and `encodeSupport` decide
 * isConfigSupported per configuration. With `pixels` the decoder outputs grey I420 frames whose
 * pixels can be copied out. With `pool` the decoder lends at most that many frames at once, as GPU
 * decoders do: its flush outputs the next picture only once a frame it lent (or a clone of one) is
 * closed.
 */
export function installVideoCodecs({
    requireDescription = false,
    reorder = false,
    failEncode = false,
    failDecode = false,
    failAt = new Set(),
    throwAt = new Set(),
    hidden = new Set(),
    evented = false,
    decodeSupport = () => true,
    encodeSupport = () => true,
    onEncode,
    pixels = false,
    pool,
} = {}) {
    const names = ['VideoFrame', 'EncodedVideoChunk', 'VideoDecoder', 'VideoEncoder'];
    const saved = new Map(
        names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
    );
    const frames = new Set();
    const codecs = [];
    const encoderConfigs = [];
    const supportChecks = [];
    const encoded = [];
    const bufferFrames = [];
    let peakFrames = 0;
    let peakDecodeQueue = 0;
    let peakEncodeQueue = 0;
    let decoderFlushes = 0;
    let encoderFlushes = 0;
    let listeners = 0;
    /** Ends the waits of decoders whose lent frames are all in use. */
    const closing = new Set();
    class Frame {
        constructor(source, init = {}) {
            if (ArrayBuffer.isView(source) || source instanceof ArrayBuffer) {
                Object.assign(this, init);
                this.data = source;
                this.visibleRect = init.visibleRect ?? {
                    x: 0,
                    y: 0,
                    width: init.codedWidth,
                    height: init.codedHeight,
                };
                this.displayWidth = init.displayWidth ?? this.visibleRect.width;
                this.displayHeight = init.displayHeight ?? this.visibleRect.height;
                bufferFrames.push(init);
            } else {
                assert(!source.closed, 'Cannot clone a closed frame');
                this.format = source.format ?? 'I420';
                this.codedWidth = source.codedWidth ?? 16;
                this.codedHeight = source.codedHeight ?? 16;
                this.visibleRect = init.visibleRect ??
                    source.visibleRect ?? {
                        x: 0,
                        y: 0,
                        width: this.codedWidth,
                        height: this.codedHeight,
                    };
                this.displayWidth =
                    init.displayWidth ?? source.displayWidth ?? this.visibleRect.width;
                this.displayHeight =
                    init.displayHeight ?? source.displayHeight ?? this.visibleRect.height;
                this.colorSpace = source.colorSpace;
                this.lender = source.lender;
                // A clone shares the pixels of a frame made from a buffer.
                if (source.data) [this.data, this.layout] = [source.data, source.layout];
            }
            this.timestamp = init.timestamp ?? source.timestamp;
            this.duration = init.duration ?? source.duration;
            this.closed = false;
            frames.add(this);
            peakFrames = Math.max(peakFrames, frames.size);
        }
        close() {
            this.closed = true;
            frames.delete(this);
            for (const wake of closing) wake();
            closing.clear();
        }
        /** Frames made from pixel buffers copy them out like WebCodecs frames. */
        allocationSize() {
            assert(this.data, 'Only frames made from pixel buffers can be copied');
            return this.data.byteLength;
        }
        async copyTo(destination) {
            const bytes = this.data instanceof ArrayBuffer ? new Uint8Array(this.data) : this.data;
            destination.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
            return this.layout ?? [{ offset: 0, stride: this.codedWidth * 4 }];
        }
    }
    class Chunk {
        constructor(init) {
            Object.assign(this, init);
            this.data = new Uint8Array(init.data);
            this.byteLength = this.data.length;
        }
        copyTo(destination) {
            destination.set(this.data);
        }
    }
    const Base = evented ? EventTarget : Object;
    class Codec extends Base {
        constructor() {
            super();
            if (evented) this.ondequeue = null;
        }
        addEventListener(...args) {
            listeners++;
            super.addEventListener(...args);
        }
        removeEventListener(...args) {
            listeners--;
            super.removeEventListener(...args);
        }
        dequeued() {
            if (evented) this.dispatchEvent(new Event('dequeue'));
        }
    }
    class Decoder extends Codec {
        state = 'unconfigured';
        decodeQueueSize = 0;
        pending = Promise.resolve();
        buffered = [];
        keyRequired = true;
        static async isConfigSupported(config) {
            return {
                supported:
                    (!requireDescription || !!config.description?.length) && decodeSupport(config),
                config,
            };
        }
        constructor(init) {
            super();
            this.init = init;
            codecs.push(this);
        }
        configure(config) {
            assert.notEqual(this.state, 'closed');
            if (requireDescription && !config.description?.length)
                throw new DOMException('Missing description', 'NotSupportedError');
            this.config = config;
            this.state = 'configured';
            this.keyRequired = true;
        }
        decode(chunk) {
            assert.equal(this.state, 'configured');
            if (this.keyRequired && chunk.type !== 'key')
                throw new DOMException('Key chunk required', 'DataError');
            if (throwAt.has(chunk.timestamp)) throw new DOMException('Invalid chunk', 'DataError');
            this.keyRequired = false;
            if (this.config.codec.startsWith('avc') && !this.config.description) {
                const d = chunk.data;
                assert(
                    d[0] === 0 && d[1] === 0 && (d[2] === 1 || (d[2] === 0 && d[3] === 1)),
                    'AVC without description requires Annex B chunks',
                );
            }
            this.decodeQueueSize++;
            peakDecodeQueue = Math.max(peakDecodeQueue, this.decodeQueueSize);
            this.pending = this.pending.then(async () => {
                await yieldTask();
                this.decodeQueueSize--;
                if (this.state === 'closed') return;
                this.dequeued();
                if (failDecode || failAt.has(chunk.timestamp)) {
                    this.state = 'closed';
                    this.init.error(new DOMException('Native decode failed', 'EncodingError'));
                    return;
                }
                if (hidden.has(chunk.timestamp)) return;
                if (reorder) this.buffered.push(chunk);
                else this.output(chunk);
            });
        }
        output(chunk) {
            const { codedWidth: width, codedHeight: height } = this.config;
            const init = {
                timestamp: chunk.timestamp,
                duration: chunk.duration,
                codedWidth: width,
                codedHeight: height,
            };
            if (!pixels) return this.init.output(Object.assign(new Frame(init), { lender: this }));
            const layout = [
                { offset: 0, stride: width },
                { offset: width * height, stride: width / 2 },
                { offset: width * height * 1.25, stride: width / 2 },
            ];
            const frame = new Frame(new Uint8Array(width * height * 1.5).fill(128), {
                ...init,
                format: 'I420',
                layout,
            });
            this.init.output(Object.assign(frame, { lender: this }));
        }
        async flush() {
            assert.equal(this.state, 'configured');
            decoderFlushes++;
            this.keyRequired = true;
            await this.pending;
            if (this.state === 'closed') throw new DOMException('Closed decoder', 'AbortError');
            const lent = () => [...frames].filter(frame => frame.lender === this).length;
            for (const chunk of this.buffered.sort((a, b) => a.timestamp - b.timestamp)) {
                while (pool !== undefined && lent() >= pool)
                    await new Promise(resolve => closing.add(resolve));
                if (this.state === 'closed') throw new DOMException('Closed decoder', 'AbortError');
                this.output(chunk);
            }
            this.buffered.length = 0;
        }
        close() {
            this.state = 'closed';
            this.buffered.length = 0;
            for (const wake of closing) wake();
            closing.clear();
        }
    }
    class Encoder extends Codec {
        state = 'unconfigured';
        encodeQueueSize = 0;
        pending = Promise.resolve();
        static async isConfigSupported(config) {
            supportChecks.push(config.codec);
            return { supported: encodeSupport(config), config };
        }
        constructor(init) {
            super();
            this.init = init;
            codecs.push(this);
        }
        configure(config) {
            this.config = config;
            encoderConfigs.push(config);
            this.state = 'configured';
        }
        encode(frame, options) {
            assert.equal(this.state, 'configured');
            assert(!frame.closed, 'Cannot encode a closed frame');
            onEncode?.();
            encoded.push({
                timestamp: frame.timestamp,
                format: frame.format,
                keyFrame: options.keyFrame === true,
                visibleRect: frame.visibleRect,
                displayWidth: frame.displayWidth,
                displayHeight: frame.displayHeight,
            });
            const chunk = new Chunk({
                timestamp: frame.timestamp,
                duration: frame.duration,
                type: options.keyFrame ? 'key' : 'delta',
                data: new Uint8Array([0x10, 0, 0, 0x9d, 0x01, 0x2a, 16, 0, 16, 0]),
            });
            this.encodeQueueSize++;
            peakEncodeQueue = Math.max(peakEncodeQueue, this.encodeQueueSize);
            this.pending = this.pending.then(async () => {
                await yieldTask();
                this.encodeQueueSize--;
                if (this.state === 'closed') return;
                this.dequeued();
                if (failEncode) {
                    this.state = 'closed';
                    this.init.error(new DOMException('Native encode failed', 'EncodingError'));
                } else this.init.output(chunk);
            });
        }
        async flush() {
            encoderFlushes++;
            await this.pending;
            if (this.state === 'closed') throw new DOMException('Closed encoder', 'AbortError');
        }
        close() {
            this.state = 'closed';
        }
    }
    Object.assign(globalThis, {
        VideoFrame: Frame,
        EncodedVideoChunk: Chunk,
        VideoDecoder: Decoder,
        VideoEncoder: Encoder,
    });
    return {
        encoderConfigs,
        supportChecks,
        encoded,
        bufferFrames,
        get decoders() {
            return codecs.filter(codec => codec instanceof Decoder).length;
        },
        get peakFrames() {
            return peakFrames;
        },
        get peakDecodeQueue() {
            return peakDecodeQueue;
        },
        get peakEncodeQueue() {
            return peakEncodeQueue;
        },
        get decoderFlushes() {
            return decoderFlushes;
        },
        get encoderFlushes() {
            return encoderFlushes;
        },
        get listeners() {
            return listeners;
        },
        assertClosed() {
            assert.equal(frames.size, 0, 'All decoded and restamped frames must be closed');
            assert(
                codecs.every(codec => codec.state === 'closed'),
                'All codec instances must be closed',
            );
        },
        restore() {
            for (const [name, descriptor] of saved) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            }
        },
    };
}
