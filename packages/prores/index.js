import { CodecQueue, checkAbort, positiveInteger, timing, validateSignal, yieldTask } from './lifetime.js';
import { inspectPacket, profileOf, profiles } from './packet.js';
import { ownedFrame } from './frame.js';

const maxPixels = 8192 * 8192;

export async function createProResDecoder(options = {}) {
    options = { ...options };
    profileOf(options.codec);
    validateSignal(options.signal);
    checkAbort(options.signal);
    const config = {
        ...options,
        maxPixels: positiveInteger(options.maxPixels ?? maxPixels, 'maxPixels', 16384 * 16384),
        maxPacketBytes: positiveInteger(options.maxPacketBytes ?? 256 * 1024 * 1024, 'maxPacketBytes', 0xffffffff),
        unspecifiedColorMatrix: options.unspecifiedColorMatrix ?? 1,
    };
    if (config.width !== undefined) positiveInteger(config.width, 'width', 16384);
    if (config.height !== undefined) positiveInteger(config.height, 'height', 16384);
    if (
        !Number.isInteger(options.concurrency ?? 0) ||
        (options.concurrency ?? 0) < 0 ||
        (options.concurrency ?? 0) > 64
    ) {
        throw new RangeError('concurrency must be an integer from 0 to 64');
    }
    positiveInteger(options.maxQueueSize ?? 4, 'maxQueueSize', 1024);
    const { Decoder, Frame } = await import('turbores');
    checkAbort(options.signal);
    const native = await Decoder.create({
        proresFourCc: options.codec,
        useSharedMemory: options.useSharedMemory ?? false,
        concurrency: options.concurrency ?? 0,
    });
    if (native instanceof Error) throw native;
    if (options.signal?.aborted) {
        await native.close();
        checkAbort(options.signal);
    }
    let queue;
    try {
        queue = new CodecQueue(options.signal, options.maxQueueSize, () => native.close());
    } catch (error) {
        await native.close();
        throw error;
    }
    return {
        get queueSize() {
            return queue.pending;
        },
        get desiredSize() {
            return queue.limit - queue.pending;
        },
        get closed() {
            return queue.closed;
        },
        decode(packet) {
            return queue.run(
                () => {
                    timing(packet);
                    if (!(packet.data instanceof Uint8Array) || packet.data.byteLength > config.maxPacketBytes) {
                        throw new RangeError('ProRes packet exceeds maxPacketBytes or is not Uint8Array');
                    }
                    const data = new Uint8Array(packet.data);
                    return {
                        data,
                        info: inspectPacket(data, config),
                        timestamp: packet.timestamp,
                        duration: packet.duration,
                    };
                },
                async input => {
                    await yieldTask();
                    queue.check();
                    const buffer = new Frame();
                    try {
                        const result = await native.decode(input.data, buffer);
                        queue.check();
                        if (result instanceof Error) throw result;
                        return ownedFrame(result, input.data, input.info, input, config);
                    } finally {
                        buffer.clear();
                    }
                },
            );
        },
        flush: () => queue.flush(),
        close: () => queue.close(),
    };
}

export async function createProResEncoder(options = {}) {
    options = { ...options };
    const profile = profileOf(options.codec);
    validateSignal(options.signal);
    checkAbort(options.signal);
    const width = positiveInteger(options.width, 'ProRes dimensions: width', 16384);
    const height = positiveInteger(options.height, 'ProRes dimensions: height', 16384);
    const pixelLimit = positiveInteger(options.maxPixels ?? maxPixels, 'maxPixels', maxPixels);
    if (width * height > pixelLimit) throw new RangeError('ProRes dimensions exceed maxPixels');
    if (options.bitrate !== undefined && options.bitrate !== 0)
        throw new TypeError('ProRes bitrate is profile-controlled; select a codec profile');
    if (options.framerate !== undefined && (!Number.isFinite(options.framerate) || options.framerate <= 0))
        throw new RangeError('ProRes framerate must be positive');
    positiveInteger(options.maxQueueSize ?? 4, 'maxQueueSize', 1024);
    const { createProResEncoder: createNative } = await import('prores-wasm-encoder');
    checkAbort(options.signal);
    let native = await createNative();
    let queue;
    try {
        checkAbort(options.signal);
        native.initialize({ width, height, profile, frameRate: options.framerate ?? 30, range: 'limited' });
        if (typeof native.encodePacketRgba !== 'function')
            throw new Error('Unsupported prores-wasm-encoder packet API');
        queue = new CodecQueue(options.signal, options.maxQueueSize, () => {
            try {
                native.destroy();
            } finally {
                // destroy() frees allocations but the module still owns its WASM memory.
                // A retained closed adapter must not keep that memory alive.
                native = null;
            }
        });
    } catch (error) {
        native.destroy();
        throw error;
    }
    return {
        get queueSize() {
            return queue.pending;
        },
        get desiredSize() {
            return queue.limit - queue.pending;
        },
        get closed() {
            return queue.closed;
        },
        encode(frame) {
            return queue.run(
                () => {
                    timing(frame);
                    if (
                        frame.format !== 'RGBA' ||
                        !(frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) ||
                        (frame.bitDepth !== undefined && frame.bitDepth !== 8)
                    )
                        throw new TypeError('ProRes encoder requires packed RGBA8 input');
                    if (frame.width !== width || frame.height !== height || frame.data.length !== width * height * 4)
                        throw new RangeError('ProRes RGBA dimensions or data length do not match the encoder');
                    if (frame.scanType && frame.scanType !== 'progressive')
                        throw new Error('ProRes encoder does not support interlaced input');
                    if (
                        (frame.colorPrimaries !== undefined && frame.colorPrimaries !== 1) ||
                        (frame.colorTransfer !== undefined && frame.colorTransfer !== 1) ||
                        frame.premultipliedAlpha === true
                    )
                        throw new Error('ProRes encoder requires straight-alpha BT.709 RGB color values');
                    if (profile < 4) {
                        for (let i = 3; i < frame.data.length; i += 4)
                            if (frame.data[i] !== 255)
                                throw new Error('ProRes 422 cannot preserve alpha; select ap4h or ap4x');
                    }
                    return { data: new Uint8Array(frame.data), timestamp: frame.timestamp, duration: frame.duration };
                },
                async input => {
                    await yieldTask();
                    queue.check();
                    const data = native.encodePacketRgba(input.data);
                    queue.check();
                    return {
                        data,
                        timestamp: input.timestamp,
                        duration: input.duration,
                        isKeyframe: true,
                        trackType: 'video',
                    };
                },
            );
        },
        flush: () => queue.flush(),
        close: () => queue.close(),
    };
}

export const proResVideoCodec = Object.freeze({
    id: 'prores-wasm',
    supportsDecode: codec => Object.hasOwn(profiles, codec),
    supportsEncode: codec => Object.hasOwn(profiles, codec),
    createDecoder: createProResDecoder,
    createEncoder: createProResEncoder,
});
