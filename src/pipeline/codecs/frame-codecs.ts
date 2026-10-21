import { NO_PLUGINS } from '../plugins/missing-parts';
import type { MissingParts } from '../plugins/missing-parts';
import type { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import type { CodecPreference } from '../api-types';
import { MediaForgeError, errorMessage } from '../../core/errors/errors';
import { yieldEventLoop } from '../../core/io/event-loop';
import type { BuiltinVideoCodec, BuiltinVideoDecoder } from '../../core/contracts/decoder';
import { assumedYuvColour } from '../../codecs/shared/yuv-rgba';
import { isDisposableAvcPicture, nalLengthSizeOf } from '../../core/codec-config/video/annexb';
import { bufferView, micros } from '../../codecs/webcodecs/codec';
import { hostCodecAvailable, queryHostCodec } from '../../codecs/webcodecs/support';
import { builtinFirst } from './router';
import {
    DamageLog,
    HostVideoDecoder,
    MAX_RECOVERIES,
    type DecodeRecovery,
    type DecodedPicture,
    type FrameDecoder,
    type PictureOutput,
    type VideoPacketInput,
    releasePicture,
} from '../../codecs/webcodecs/video';
import type { PlanarVideoFrame } from '../../core/contracts/picture';
import { h264ConfigFormat } from '../../core/codec-config/video/video-sps';

/**
 * Built-in software decoder; pictures become host VideoFrames when `toVideoFrame` is set. A failing
 * packet resets the decoder and decoding resumes at the next keyframe, as with the host decoder.
 */
class BuiltinFrameDecoder implements FrameDecoder {
    readonly kind: string;
    private readonly decoder: BuiltinVideoDecoder;
    private readonly damage: DamageLog;
    private firstError: MediaForgeError | undefined;
    private outputs = 0;
    private submitted = 0;
    private restarts = 0;
    private awaitingKey = true;
    private reportedInterlace = false;
    private reportedDepth = false;
    private closed = false;

    constructor(
        kind: string,
        decoder: BuiltinVideoDecoder,
        private readonly lifetime: CodecLifetime,
        private readonly output: PictureOutput,
        private readonly recovery: DecodeRecovery,
        private readonly toVideoFrame: boolean,
    ) {
        this.kind = kind;
        this.decoder = decoder;
        this.damage = new DamageLog(recovery, lifetime);
    }

    private emit(picture: PlanarVideoFrame): void {
        if (this.closed || !this.lifetime.acceptingOutput) return;
        if (picture.interlaced && !this.reportedInterlace) {
            this.reportedInterlace = true;
            this.recovery.warn('VIDEO_INTERLACED', 'Interlaced pictures are not deinterlaced');
        }
        if ((picture.bitDepth ?? 8) > 8 && !this.reportedDepth) {
            this.reportedDepth = true;
            this.recovery.warn(
                'VIDEO_PRECISION_REDUCED',
                `${picture.bitDepth}-bit pictures are decoded to 8 bits`,
            );
        }

        const timing = { timestamp: picture.timestamp, duration: picture.duration };
        this.outputs++;
        let result: DecodedPicture = picture;
        if (this.toVideoFrame) {
            const rect = picture.visibleRect;
            // The decoder handed over its copy: a buffer of its own is moved into the frame.
            const data = picture.data;
            const own = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
            result = new VideoFrame(data, {
                ...(own && data.buffer instanceof ArrayBuffer ? { transfer: [data.buffer] } : {}),
                format: picture.format,
                codedWidth: picture.codedWidth,
                codedHeight: picture.codedHeight,
                layout: picture.layout.map(plane => ({
                    offset: plane.offset,
                    stride: plane.stride,
                })),
                visibleRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                displayWidth: picture.displayWidth,
                displayHeight: picture.displayHeight,
                timestamp: micros(picture.timestamp),
                duration: micros(picture.duration),
                colorSpace:
                    picture.format.startsWith('I') && !picture.colorSpace?.matrix
                        ? { ...assumedYuvColour(rect.width, rect.height), ...picture.colorSpace }
                        : (picture.colorSpace as VideoColorSpaceInit | undefined),
            });
        }

        try {
            this.output(result, timing);
        } catch (error) {
            this.lifetime.record(error);
        }
    }

    /**
     * Runs one decoder call; a failure resets the decoder unless validation is strict and is
     * returned.
     */
    private run(step: () => readonly PlanarVideoFrame[]): MediaForgeError | undefined {
        let pictures: readonly PlanarVideoFrame[];
        try {
            pictures = step();
        } catch (error) {
            const failure =
                error instanceof MediaForgeError
                    ? error
                    : new MediaForgeError(
                          `Built-in ${this.kind} video decode failed: ${errorMessage(error)}`,
                          'DECODE',
                      );
            this.firstError ??= failure;
            if (this.recovery.strict || ++this.restarts > MAX_RECOVERIES)
                throw this.lifetime.record(this.firstError);
            try {
                this.decoder.reset();
            } catch (reset) {
                throw this.lifetime.record(
                    new MediaForgeError(
                        `Built-in ${this.kind} decoder reset failed: ${errorMessage(reset)}`,
                        'DECODE',
                    ),
                );
            }
            this.awaitingKey = true;
            return failure;
        }

        if (pictures.length) this.restarts = 0;
        for (const picture of pictures) this.emit(picture);
        return undefined;
    }

    async decode(packet: VideoPacketInput): Promise<void> {
        this.lifetime.check();
        if (this.awaitingKey && !packet.isKeyframe) return this.damage.skip(packet.timestamp);
        this.submitted++;
        const failure = this.run(() =>
            this.decoder.decode({
                data: packet.data,
                timestamp: packet.timestamp,
                duration: packet.duration,
                isKeyframe: packet.isKeyframe,
                trackType: 'video',
            }),
        );
        if (failure) this.damage.drop(packet.timestamp);
        else if (this.awaitingKey) {
            this.damage.report(packet.timestamp);
            this.awaitingKey = false;
        }
        await this.lifetime.waitFor(yieldEventLoop());
    }

    async flush(final: boolean): Promise<void> {
        this.lifetime.check();
        const failure = this.run(() => this.decoder.flush());
        if (failure)
            this.recovery.warn(
                'VIDEO_DECODE_RECOVERED',
                `Lost the pictures the built-in ${this.kind} decoder still held`,
            );
        this.damage.report(undefined);
        this.awaitingKey = true;
        if (final && this.submitted && !this.outputs)
            throw this.lifetime.record(
                this.firstError ??
                    new MediaForgeError(
                        `The built-in ${this.kind} decoder produced no frames`,
                        'DECODE',
                    ),
            );
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.decoder.close();
    }
}

/**
 * A test for the packets of `track` that decoding may skip without changing any other picture:
 * H.264 pictures no other picture refers to; undefined for other codecs. Length-prefixed packets
 * are read by the track's configuration, others as Annex B.
 */
export function disposablePictures(track: {
    readonly codec: string;
    readonly codecConfig?: Uint8Array;
}): ((data: Uint8Array) => boolean) | undefined {
    if (!/^avc[13]\b/.test(track.codec)) return undefined;
    const lengthSize =
        track.codecConfig && track.codecConfig.length > 4 ? nalLengthSizeOf(track) : 0;
    return data => isDisposableAvcPicture(data, lengthSize);
}

interface FrameDecoderOptions {
    readonly config: VideoDecoderConfig;
    readonly decoders: readonly BuiltinVideoCodec[];
    readonly preference: CodecPreference;
    /** Names the plugin that would decode a codec nothing in use decodes; default none. */
    readonly missing?: MissingParts;
    readonly lifetime: CodecLifetime;
    readonly recovery: DecodeRecovery;
    readonly output: PictureOutput;
    /** Built-in pictures become host VideoFrames; off where no VideoFrame exists. */
    readonly toVideoFrame: boolean;
}

/**
 * The first built-in decoder whose support check accepts `codec`; a throwing check counts as
 * unsupported.
 */
export function builtinDecoderFor(
    decoders: readonly BuiltinVideoCodec[],
    codec: string,
): BuiltinVideoCodec | undefined {
    return decoders.find(candidate => {
        try {
            return candidate.supports(codec) === true;
        } catch {
            return false;
        }
    });
}

/**
 * Chooses a decoder by preference: webcodecs tries the host VideoDecoder first and falls back to
 * the first built-in decoder that supports the codec; builtin reverses the order. The host is asked
 * with a cached isConfigSupported, so a plugin decoder is not loaded when the host decodes. Fails
 * naming the codec when neither can: PLUGIN when a plugin of this package decodes it, DECODE
 * otherwise. `wait` guards the host support check with the caller's cancellation.
 */
export async function chooseVideoDecoder(
    config: VideoDecoderConfig,
    decoders: readonly BuiltinVideoCodec[],
    preference: CodecPreference,
    wait: <T>(pending: Promise<T>) => Promise<T>,
    missing: MissingParts = NO_PLUGINS,
): Promise<BuiltinVideoCodec | 'host'> {
    const builtin = builtinDecoderFor(decoders, config.codec);
    if (builtinFirst(preference, builtin !== undefined)) return builtin!;
    if (hostCodecAvailable('VideoDecoder')) {
        const support = await wait(queryHostCodec('VideoDecoder', config));
        if (support.supported) return 'host';
    }
    if (builtin) return builtin;
    throw missing.videoDecoder(
        config.codec,
        `No video decoder for '${config.codec}'`,
        h264ConfigFormat(config.codec, config.description && bufferView(config.description)),
    );
}

/**
 * Opens a decoder chosen by `chooseVideoDecoder`. The pictures of decode-only packets are released
 * instead of output; they are told apart by their timestamps, which no presented picture shares.
 */
export async function openFrameDecoder(options: FrameDecoderOptions): Promise<FrameDecoder> {
    const hidden = new Set<number>();
    const decoder = await openDecoder({
        ...options,
        output: (picture, timing) => {
            if (hidden.delete(timing.timestamp)) releasePicture(picture);
            else options.output(picture, timing);
        },
    });
    return {
        kind: decoder.kind,
        decode: packet => {
            if (packet.decodeOnly) hidden.add(packet.timestamp);
            return decoder.decode(packet);
        },
        flush: final => decoder.flush(final),
        close: () => decoder.close(),
    };
}

async function openDecoder(options: FrameDecoderOptions): Promise<FrameDecoder> {
    const { config, lifetime } = options;
    const choice = await chooseVideoDecoder(
        config,
        options.decoders,
        options.preference,
        pending => lifetime.waitFor(pending),
        options.missing,
    );

    if (choice === 'host')
        return new HostVideoDecoder(config, lifetime, options.output, options.recovery);
    const { recovery } = options;
    const decoder = await lifetime.waitFor(
        Promise.resolve()
            .then(() =>
                choice.create({
                    codec: config.codec,
                    description: config.description && bufferView(config.description),
                    codedWidth: config.codedWidth,
                    codedHeight: config.codedHeight,
                    onWarning: message =>
                        recovery.warn(
                            'VIDEO_FRAME_CONCEALED',
                            `Built-in ${choice.id} decoder: ${message}`,
                        ),
                }),
            )
            .catch(error => {
                throw new MediaForgeError(
                    `Built-in ${choice.id} decoder rejected '${config.codec}': ` +
                        errorMessage(error),
                    'DECODE',
                    { cause: error },
                );
            }),
    );
    return new BuiltinFrameDecoder(
        choice.id,
        decoder,
        lifetime,
        options.output,
        recovery,
        options.toVideoFrame,
    );
}
