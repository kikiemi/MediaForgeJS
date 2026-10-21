/**
 * The audio encoders of mediaforgejs/codecs. Each takes planar PCM, one Float32Array per channel,
 * with options naming its sample rate; loads its encoder with its first call; encodes in steps that
 * yield to the event loop; and stops with `options.signal`. The file encoders return the encoded
 * stream; encodeAacLc returns raw frames, which wrapAdts() makes a stream.
 */
import type { AacEncodeResult } from '../codecs/aac/encoder';
import { MediaForgeError, throwIfAborted } from '../core/errors/errors';
import { bitsPerSecond, type Bitrate } from '../core/errors/bitrate';
import { yieldEventLoop } from '../core/io/event-loop';

/** The options of every audio encoder of mediaforgejs/codecs. */
export interface AudioEncodeOptions {
    /** Samples per second of the planes. */
    readonly sampleRate: number;
    /**
     * Bits per second, or text with a unit (`'128k'`); a number below 1,000 reads as kilobits per
     * second. Each lossy encoder has its default; FLAC is lossless and has none.
     */
    readonly bitrate?: Bitrate;
    /** Called as frames are encoded, with the frames expected in all. */
    readonly onProgress?: (encodedFrames: number, totalFrames: number) => void;
    /** Stops the encode, which then rejects with ABORT. */
    readonly signal?: AbortSignal;
}

/** The options of encodeMp3(). */
export interface Mp3EncodeOptions extends AudioEncodeOptions {
    /** Variable bitrate around `bitrate`, with a seek table in the Info frame. */
    readonly vbr?: boolean;
}

/** Source frames handed to an encoder between yields. */
const BLOCK_FRAMES = 8192;

interface PlanarEncoder<T> {
    pushPlanar(planes: readonly Float32Array[]): void;
    finish(): T;
}

interface EncodeInput {
    readonly channels: number;
    readonly frames: number;
    readonly sampleRate: number;
    /** Kilobits per second, as the lossy encoders take it. */
    readonly kbps: number;
}

function readInput(
    name: string,
    planes: readonly Float32Array[],
    options: AudioEncodeOptions,
    defaultKbps?: number,
): EncodeInput {
    if (!Array.isArray(planes) || planes.length === 0)
        throw new MediaForgeError(`${name}: expected one Float32Array per channel`, 'INPUT');
    const frames = planes[0]?.length;
    for (const plane of planes) {
        if (!(plane instanceof Float32Array))
            throw new MediaForgeError(`${name}: expected one Float32Array per channel`, 'INPUT');
        if (plane.length !== frames)
            throw new MediaForgeError(`${name}: the planes differ in length`, 'INPUT');
    }
    if (typeof options !== 'object' || options === null)
        throw new MediaForgeError(`${name}: options with a sampleRate are required`, 'INPUT');
    const { bitrate } = options;
    const bits =
        defaultKbps !== undefined && (typeof bitrate === 'number' || typeof bitrate === 'string')
            ? bitsPerSecond(bitrate, 'audio')
            : undefined;
    return {
        channels: planes.length,
        frames: frames!,
        sampleRate: options.sampleRate,
        kbps: bits === undefined ? (defaultKbps ?? 0) : Math.max(1, Math.round(bits / 1000)),
    };
}

/** Feeds the planes to the encoder a block at a time, yielding between blocks. */
async function encodePlanes<T>(
    encoder: PlanarEncoder<T>,
    planes: readonly Float32Array[],
    signal: AbortSignal | undefined,
): Promise<T> {
    const frames = planes[0]!.length;
    for (let at = 0; at < frames; at += BLOCK_FRAMES) {
        throwIfAborted(signal);
        const end = Math.min(frames, at + BLOCK_FRAMES);
        encoder.pushPlanar(planes.map(plane => plane.subarray(at, end)));
        await yieldEventLoop();
    }
    throwIfAborted(signal);
    return encoder.finish();
}

/**
 * An MP3 (MPEG-1 Layer III: 32, 44.1 or 48 kHz) stream at 128 kbit/s by default, led by its
 * gapless Info frame.
 */
export async function encodeMp3(
    planes: readonly Float32Array[],
    options: Mp3EncodeOptions,
): Promise<Uint8Array<ArrayBuffer>> {
    const input = readInput('encodeMp3', planes, options, 128);
    const { StreamingMp3Encoder, mp3SlotEnergyMean } =
        await import('../codecs/mpeg-audio/mp3-encoder');
    // The whole input is at hand, so block switching weighs attacks against all of it.
    const encoder = new StreamingMp3Encoder(input.sampleRate, input.channels, input.kbps, {
        vbr: options.vbr === true,
        onProgress: options.onProgress,
        expectedInputFrames: input.frames,
        slotEnergyMean: mp3SlotEnergyMean(planes),
    });
    const { infoFrame, audio } = await encodePlanes(
        { pushPlanar: planes => encoder.pushPlanar(planes), finish: () => encoder.finishOutput() },
        planes,
        options.signal,
    );
    const stream = new Uint8Array(infoFrame.length + audio.length);
    stream.set(infoFrame);
    stream.set(audio, infoFrame.length);
    return stream;
}

/** An MP2 (MPEG-1 Layer II: 32, 44.1 or 48 kHz) stream at 192 kbit/s by default. */
export async function encodeMp2(
    planes: readonly Float32Array[],
    options: AudioEncodeOptions,
): Promise<Uint8Array<ArrayBuffer>> {
    const input = readInput('encodeMp2', planes, options, 192);
    const { StreamingMp2Encoder } = await import('../codecs/mpeg-audio/mp2-encoder');
    const encoder = new StreamingMp2Encoder(input.sampleRate, input.channels, input.kbps, {
        onProgress: options.onProgress,
        expectedInputFrames: input.frames,
    });
    return encodePlanes(encoder, planes, options.signal);
}

/** A FLAC stream of 16-bit samples; `bitrate` does not apply. */
export async function encodeFlac(
    planes: readonly Float32Array[],
    options: AudioEncodeOptions,
): Promise<Uint8Array<ArrayBuffer>> {
    const input = readInput('encodeFlac', planes, options);
    const { StreamingFlacEncoder } = await import('../codecs/flac/encoder');
    const encoder = new StreamingFlacEncoder(input.sampleRate, input.channels, {
        onProgress: options.onProgress,
        expectedInputFrames: input.frames,
    });
    return encodePlanes(encoder, planes, options.signal);
}

/**
 * Raw AAC-LC frames at 128 kbit/s by default, with their AudioSpecificConfig; wrapAdts() makes
 * them an ADTS stream.
 */
export async function encodeAacLc(
    planes: readonly Float32Array[],
    options: AudioEncodeOptions,
): Promise<AacEncodeResult> {
    const input = readInput('encodeAacLc', planes, options, 128);
    const { StreamingAacLcEncoder } = await import('../codecs/aac/encoder');
    const encoder = new StreamingAacLcEncoder(input.sampleRate, input.channels, input.kbps, {
        onProgress: options.onProgress,
        expectedInputFrames: input.frames,
    });
    return encodePlanes(encoder, planes, options.signal);
}
