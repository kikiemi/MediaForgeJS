import {
    MP3_DECODER_DELAY,
    MPEG1_LAYER3_BITRATES,
    MPEG2_LAYER23_BITRATES,
    MPEG_SAMPLE_RATES,
} from '../../core/codec-config/audio/mpeg-audio-header';

/**
 * The Xing tag, its flags, counts and table of contents, and the LAME tag through the music length
 * and CRCs.
 */
const XING_INFO_SIZE = 156;

export interface Mp3Gapless {
    readonly sampleRate: number;
    readonly channels: number;
    /** Layer III frames written after the Info frame. */
    readonly frames: number;
    /** Bytes of those frames. */
    readonly bytes: number;
    /**
     * Leading decoded samples not presented, the decoder delay included
     * (TrackInfo.audioPrimingSamples).
     */
    readonly priming: number;
    /** Samples presented after the priming. */
    readonly valid: number;
    /** Frames of different sizes: a 'Xing' tag rather than 'Info'. */
    readonly variable: boolean;
}

/**
 * A Xing/Info frame with a LAME tag stating the encoder delay and padding of copied MP3 frames, so
 * decoders present the same samples as from the source; undefined when the shape cannot be stated.
 */
export function mp3GaplessFrame(stream: Mp3Gapless): Uint8Array | undefined {
    const version = [3, 2, 0].find(bits => MPEG_SAMPLE_RATES[bits]!.includes(stream.sampleRate));
    if (version === undefined || stream.channels < 1 || stream.channels > 2) return undefined;
    const mpeg1 = version === 3;
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    const delay = stream.priming - MP3_DECODER_DELAY;
    const padding =
        stream.frames * samplesPerFrame - stream.priming - stream.valid + MP3_DECODER_DELAY;
    if (!(delay >= 0 && delay < 4096 && padding >= 0 && padding < 4096)) return undefined;
    const side = mpeg1 ? (stream.channels === 1 ? 17 : 32) : stream.channels === 1 ? 9 : 17;
    const bitrates = mpeg1 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER23_BITRATES;
    const sizeOf = (index: number): number =>
        Math.floor(((mpeg1 ? 144000 : 72000) * bitrates[index]!) / stream.sampleRate);
    let bitrate = 1;
    while (bitrate < bitrates.length && sizeOf(bitrate) < 4 + side + XING_INFO_SIZE) bitrate++;
    if (bitrate >= bitrates.length) return undefined;

    const size = sizeOf(bitrate);
    const frame = new Uint8Array(size);
    const view = new DataView(frame.buffer);
    frame[0] = 0xff;
    frame[1] = 0xe0 | (version << 3) | (1 << 1) | 1;
    frame[2] = (bitrate << 4) | (MPEG_SAMPLE_RATES[version]!.indexOf(stream.sampleRate) << 2);
    frame[3] = (stream.channels === 1 ? 3 : 1) << 6;
    const tag = 4 + side;
    frame.set(new TextEncoder().encode(stream.variable ? 'Xing' : 'Info'), tag);
    view.setUint32(tag + 4, 0x0f);
    view.setUint32(tag + 8, stream.frames);
    view.setUint32(tag + 12, size + stream.bytes);
    for (let index = 0; index < 100; index++)
        frame[tag + 16 + index] = Math.floor((256 * index) / 100);

    // The LAME tag: an encoder name readers recognise, then the 12-bit delay and padding.
    frame.set(new TextEncoder().encode('LavfFlowC'), tag + 120);
    const packed = (delay << 12) | padding;
    frame[tag + 141] = (packed >>> 16) & 0xff;
    frame[tag + 142] = (packed >>> 8) & 0xff;
    frame[tag + 143] = packed & 0xff;
    view.setUint32(tag + 148, size + stream.bytes);
    return frame;
}
