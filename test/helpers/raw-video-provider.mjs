import { codecParts } from './parts.mjs';

/** A VP8 keyframe header (frame tag, start code, 14-bit sides) for a width × height picture. */
function vp8Header(width, height) {
    return Uint8Array.of(
        0x10,
        0,
        0,
        0x9d,
        0x01,
        0x2a,
        width & 0xff,
        width >> 8,
        height & 0xff,
        height >> 8,
    );
}

/** The packet of the test codec for straight RGBA `data` of a width × height picture. */
export function rawPacket(data, width, height, timestamp, duration) {
    const bytes = new Uint8Array(10 + data.length);
    bytes.set(vp8Header(width, height));
    bytes.set(data, 10);
    return { data: bytes, timestamp, duration, isKeyframe: true, trackType: 'video' };
}

/** The RGBA pictures of a test-codec video packet. */
export function rawPicture(packet) {
    return packet.data.subarray(10);
}

/**
 * A lossless application video codec for tests: it "encodes" straight RGBA behind a VP8 keyframe
 * header, under the VP8 name that Matroska carries, and decodes it back, so pictures written
 * through the pipeline can be compared byte for byte in Node. `encoded` records the timing of every
 * encoded picture.
 */
export function rawVideoProvider({ codec = 'vp8' } = {}) {
    const encoded = [];
    const provider = {
        id: 'raw-rgba',
        supportsDecode: name => name === codec,
        supportsEncode: name => name === codec,
        createEncoder: config => ({
            encode(frame) {
                encoded.push({ timestamp: frame.timestamp, duration: frame.duration });
                return rawPacket(
                    frame.data,
                    frame.width,
                    frame.height,
                    frame.timestamp,
                    frame.duration,
                );
            },
            close() {},
            config,
        }),
        createDecoder: config => ({
            decode(packet) {
                const { width, height } = config;
                if (packet.data.length !== 10 + width * height * 4)
                    throw new Error('raw packet size mismatch');
                const data = packet.data.slice(10);
                return {
                    data,
                    format: 'RGBA',
                    codedWidth: width,
                    codedHeight: height,
                    visibleWidth: width,
                    visibleHeight: height,
                    layout: [{ offset: 0, stride: width * 4 }],
                    bitDepth: 8,
                    colorPrimaries: 1,
                    colorTransfer: 1,
                    timestamp: packet.timestamp,
                    duration: packet.duration,
                    toRgba: () => ({ data, width, height }),
                    close() {},
                };
            },
            close() {},
        }),
    };
    return { provider, plugin: { name: 'raw-rgba', ...codecParts(provider) }, encoded };
}
