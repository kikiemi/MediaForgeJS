import assert from 'node:assert/strict';
import { avcc, idr, lengthPrefixed } from './avi-h264-fixtures.mjs';

export const vp8Packet = Uint8Array.of(0x10, 0, 0, 0x9d, 0x01, 0x2a, 32, 0, 24, 0);

/**
 * Limited-range BT.601 Y'CbCr of the decoded doubles: red, which BT.709 would turn into R 255, G
 * 24, B 0.
 */
export const decodedYuv = Object.freeze({ y: 81, u: 90, v: 240 });

// Browser API doubles exercise bridge ordering/ownership. ProRes tests use real codec packets
// separately.
export function installWorkflowVideoCodecs({
    reorder = true,
    encodeFailure = false,
    lateFrame = false,
    colorSpace = {
        primaries: 'smpte170m',
        transfer: 'smpte170m',
        matrix: 'smpte170m',
        fullRange: false,
    },
} = {}) {
    const names = ['VideoFrame', 'EncodedVideoChunk', 'VideoDecoder', 'VideoEncoder'];
    const saved = new Map(
        names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
    );
    const frames = new Set();
    const codecs = [];
    const configurations = [];
    let peakFrames = 0;
    let rgbaConversions = 0;
    let planeCopies = 0;
    let flushes = 0;
    const keyFrames = [];
    class Frame {
        constructor(data, init) {
            this.timestamp = init.timestamp;
            this.duration = init.duration;
            this.codedWidth = init.codedWidth ?? 32;
            this.codedHeight = init.codedHeight ?? 24;
            this.visibleRect = { x: 0, y: 0, width: this.codedWidth, height: this.codedHeight };
            this.displayWidth = this.codedWidth;
            this.displayHeight = this.codedHeight;
            this.format = init.format ?? 'I420';
            this.colorSpace = init.colorSpace ?? colorSpace;
            this.data = data;
            this.closed = false;
            frames.add(this);
            peakFrames = Math.max(peakFrames, frames.size);
        }
        allocationSize() {
            return (this.codedWidth * this.codedHeight * 3) / 2;
        }
        async copyTo(output, options) {
            assert.equal(this.closed, false);
            if (options?.format === 'RGBA') {
                assert.equal(options.colorSpace, 'srgb');
                rgbaConversions++;
                for (let index = 0; index < output.length; index += 4)
                    output.set([80, 140, 200, 255], index);
                return [{ offset: 0, stride: this.codedWidth * 4 }];
            }
            assert.equal(this.format, 'I420');
            planeCopies++;
            const luma = this.codedWidth * this.codedHeight;
            output.fill(decodedYuv.y, 0, luma);
            output.fill(decodedYuv.u, luma, luma * 1.25);
            output.fill(decodedYuv.v, luma * 1.25, luma * 1.5);
            return [
                { offset: 0, stride: this.codedWidth },
                { offset: luma, stride: this.codedWidth / 2 },
                { offset: luma * 1.25, stride: this.codedWidth / 2 },
            ];
        }
        close() {
            assert.equal(this.closed, false, 'Every native frame is closed exactly once');
            this.closed = true;
            frames.delete(this);
        }
    }
    class Chunk {
        constructor(init) {
            Object.assign(this, init);
            this.byteLength = init.data.length;
        }
        copyTo(output) {
            output.set(this.data);
        }
    }
    class Decoder {
        state = 'unconfigured';
        decodeQueueSize = 0;
        held = [];
        static async isConfigSupported(config) {
            return { supported: true, config };
        }
        constructor(callbacks) {
            this.callbacks = callbacks;
            codecs.push(this);
        }
        configure(config) {
            this.config = config;
            configurations.push(config);
            this.state = 'configured';
        }
        decode(chunk) {
            assert.equal(this.state, 'configured');
            this.decodeQueueSize++;
            queueMicrotask(() => {
                this.decodeQueueSize--;
                if (this.state === 'closed') return;
                if (reorder) this.held.push(chunk);
                else this.callbacks.output(new Frame(undefined, chunk));
            });
        }
        async flush() {
            await Promise.resolve();
            for (const packet of this.held.sort((left, right) => left.timestamp - right.timestamp))
                this.callbacks.output(new Frame(undefined, packet));
            this.held.length = 0;
        }
        close() {
            assert.notEqual(this.state, 'closed');
            this.state = 'closed';
            this.held.length = 0;
            if (lateFrame)
                queueMicrotask(() =>
                    this.callbacks.output(new Frame(undefined, { timestamp: 0, duration: 40000 })),
                );
        }
    }
    class Encoder {
        state = 'unconfigured';
        encodeQueueSize = 0;
        static async isConfigSupported(config) {
            return { supported: true, config };
        }
        constructor(callbacks) {
            this.callbacks = callbacks;
            codecs.push(this);
        }
        configure(config) {
            this.config = config;
            configurations.push(config);
            this.state = 'configured';
        }
        encode(frame, options) {
            assert.equal(frame.closed, false);
            assert.equal(frame.colorSpace.transfer, 'bt709');
            keyFrames.push(options?.keyFrame === true);
            this.encodeQueueSize++;
            const chunk = new Chunk({
                timestamp: frame.timestamp,
                duration: frame.duration,
                type: 'key',
                data: this.config.codec.startsWith('avc') ? lengthPrefixed(4, idr) : vp8Packet,
            });
            queueMicrotask(() => {
                this.encodeQueueSize--;
                if (this.state === 'closed') return;
                if (encodeFailure)
                    this.callbacks.error(
                        new DOMException('Encoder fixture failure', 'EncodingError'),
                    );
                else
                    this.callbacks.output(
                        chunk,
                        this.config.codec.startsWith('avc')
                            ? { decoderConfig: { codec: 'avc1.42000a', description: avcc() } }
                            : undefined,
                    );
            });
        }
        async flush() {
            flushes++;
            await Promise.resolve();
        }
        close() {
            assert.notEqual(this.state, 'closed');
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
        configurations,
        get flushes() {
            return flushes;
        },
        get rgbaConversions() {
            return rgbaConversions;
        },
        get planeCopies() {
            return planeCopies;
        },
        keyFrames,
        assertClosed() {
            assert.equal(frames.size, 0);
            assert(codecs.every(codec => codec.state === 'closed'));
            assert(
                peakFrames <= 3,
                `Bridge retained ${peakFrames} native frames for a two-frame input`,
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
