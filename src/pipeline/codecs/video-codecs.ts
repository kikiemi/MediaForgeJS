import type { MissingParts } from '../plugins/missing-parts';
import type { CodecLifetime } from '../../codecs/shared/codec-lifetime';
import { micros } from '../../codecs/webcodecs/codec';
import { MediaForgeError, errorMessage } from '../../core/errors/errors';
import { sampleAt } from '../../core/model/sample-index';
import { prependAvcConfigToSample } from '../../core/codec-config/video/annexb';
import type { EncodedPacket } from '../../core/model/media';
import { defaultVideoBitrate } from './video-settings';
import type { TrackInfo } from '../../core/model/track';
import type { BuiltinVideoCodec, VideoCodecDecoder } from '../../core/contracts/decoder';
import {
    isConvertibleFormat,
    planarBitDepth,
    planarToRgba,
    yuvMatrix,
} from '../../codecs/shared/yuv-rgba';
import type { VideoCodecEncoder, VideoCodecProvider } from '../../core/contracts/encoder';
import {
    HostVideoEncoder,
    encodableFrame,
    hostVideoDecoderConfig,
    selectEncoderConfig,
    isHostFrame,
    type DecodeRecovery,
    type FrameTiming,
    type VideoPacketInput,
} from '../../codecs/webcodecs/video';
import type { HostVideoEncoderOptions } from '../../codecs/webcodecs/video-options';
import { openFrameDecoder } from './frame-codecs';
import type { CodecPreference } from '../api-types';
import type { FilePacket } from '../media-types';
import { Picture, canvasRgba, isHdrFrame, sdrReport, type PictureData } from '../../stages/picture';

/** Most pixels an application codec is configured for. */
const PROVIDER_MAX_PIXELS = 8192 * 8192;

/** Receives each decoded picture with its timing in seconds; the receiver owns the data. */
export type PictureDataOutput = (data: PictureData, timing: FrameTiming) => void;

/** A clip's decoder: packets in decode order in, pictures out through its output. */
export interface ClipDecoder {
    /** 'host' for the platform VideoDecoder, otherwise the built-in or application codec id. */
    readonly kind: string;
    decode(packet: FilePacket): Promise<void>;
    /** Outputs held pictures; `final` fails when the stream never produced one. */
    flush(final: boolean): Promise<void>;
    close(): void | Promise<void>;
}

/** How a video lane decodes and reports. */
export interface DecodeSettings {
    readonly decoders: readonly BuiltinVideoCodec[];
    readonly preference: CodecPreference;
    readonly missing?: MissingParts;
    readonly recovery: DecodeRecovery;
    readonly lifetime: CodecLifetime;
    /** Application codecs; the first that decodes a track's codec decodes it. */
    readonly providers?: readonly VideoCodecProvider[];
    /** false refuses pictures deeper than 8 bits that an application codec turns into RGBA8. */
    readonly allowPrecisionLoss?: boolean;
    readonly signal: AbortSignal;
}

const hostRgbaChecks = new Map<string, Promise<boolean>>();

/**
 * Whether the host's RGBA copy of frames in `space` is the plain matrix conversion, probed once per
 * colour space on a 16 × 16 luma ramp. Integer matrix approximations stay within 6 levels; a host
 * that also converts the transfer to sRGB moves mid-tones by about 11 and uses the library's
 * conversion instead.
 */
function hostRgbaMatches(space: VideoColorSpace | undefined): Promise<boolean> {
    const init: VideoColorSpaceInit = {
        primaries: space?.primaries ?? null,
        transfer: space?.transfer ?? null,
        matrix: space?.matrix ?? null,
        fullRange: space?.fullRange ?? null,
    };

    const key = JSON.stringify(init);
    let pending = hostRgbaChecks.get(key);
    if (!pending) {
        pending = (async () => {
            const side = 16;
            const data = new Uint8Array(side * side * 1.5);
            for (let row = 0; row < side; row++)
                data.fill(40 + row * 12, row * side, (row + 1) * side);
            data.fill(100, side * side, side * side * 1.25);
            data.fill(170, side * side * 1.25);

            const frame = new VideoFrame(data, {
                format: 'I420',
                codedWidth: side,
                codedHeight: side,
                timestamp: 0,
                colorSpace: init,
            });
            try {
                const host = new Uint8Array(side * side * 4);
                await frame.copyTo(host, { format: 'RGBA', colorSpace: 'srgb' });
                const expected = planarToRgba(
                    {
                        format: 'I420',
                        data,
                        layout: [
                            { offset: 0, stride: side },
                            { offset: side * side, stride: side / 2 },
                            { offset: side * side * 1.25, stride: side / 2 },
                        ],
                        codedWidth: side,
                        codedHeight: side,
                    },
                    { x: 0, y: 0, width: side, height: side },
                    yuvMatrix(frame.colorSpace.matrix, 1280, 720),
                    frame.colorSpace.fullRange === true,
                );
                return host.every((value, index) => Math.abs(value - expected[index]!) <= 6);
            } catch {
                // A host without RGBA copies answers no: the library converts instead.
                return false;
            } finally {
                frame.close();
            }
        })();

        hostRgbaChecks.set(key, pending);
    }
    return pending;
}

/**
 * The BT.709-labelled RGBA an application encoder takes from a host frame: converted by the frame's
 * own matrix, without changing its transfer, through the host's RGBA copy when that is this
 * conversion and the library's otherwise. Wide-gamut and high-dynamic-range frames are drawn on a
 * canvas, which maps them to sRGB, reported through `toSdr`; frames deeper than 8 bits are reduced,
 * reported once through `precision`.
 */
async function signalRgba(
    frame: VideoFrame,
    lifetime: CodecLifetime,
    precision: (depth: string) => void,
    toSdr?: () => void,
): Promise<PictureData> {
    const format = frame.format as string | null;
    const space = frame.colorSpace;
    const hdr = isHdrFrame(frame);
    if (hdr) toSdr?.();
    if (format && planarBitDepth(format) > 8) precision(`${planarBitDepth(format)}-bit`);
    const visible = frame.visibleRect ?? {
        x: 0,
        y: 0,
        width: frame.codedWidth,
        height: frame.codedHeight,
    };
    if (
        !Number.isSafeInteger(visible.width * visible.height) ||
        visible.width * visible.height > PROVIDER_MAX_PIXELS
    )
        throw new MediaForgeError('Native decoded frame exceeds the pixel budget', 'OOM');

    const colorSpace = {
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'rgb',
        fullRange: true,
    } as const;
    const drawn = hdr ? canvasRgba(frame, visible.width, visible.height) : undefined;
    if (drawn)
        return {
            kind: 'rgba',
            data: drawn,
            width: visible.width,
            height: visible.height,
            colorSpace,
        };
    if (
        !isConvertibleFormat(format) ||
        (planarBitDepth(format!) === 8 && (await lifetime.waitFor(hostRgbaMatches(space))))
    ) {
        const data = new Uint8Array(visible.width * visible.height * 4);
        await lifetime.waitFor(frame.copyTo(data, { format: 'RGBA', colorSpace: 'srgb' }));
        return { kind: 'rgba', data, width: visible.width, height: visible.height, colorSpace };
    }

    const data = new Uint8Array(frame.allocationSize());
    const layout = await lifetime.waitFor(frame.copyTo(data));
    const rgba = planarToRgba(
        {
            format: format!,
            data,
            layout,
            codedWidth: frame.codedWidth,
            codedHeight: frame.codedHeight,
        },
        visible,
        yuvMatrix(space?.matrix, visible.width, visible.height),
        space?.fullRange === true,
    );
    return {
        kind: 'rgba',
        data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        width: visible.width,
        height: visible.height,
        colorSpace,
    };
}

/**
 * Decoded pictures as an application encoder takes them: host frames become BT.709 RGBA before any
 * stage, as the library transforms RGBA itself; built-in planes and RGBA pass as they are.
 */
export function signalPictures(
    lifetime: CodecLifetime,
    warn: (code: string, message: string) => void,
    allowPrecisionLoss: boolean | undefined,
): (data: PictureData) => Promise<PictureData> {
    let reported = false;
    const precision = (depth: string): void => {
        if (allowPrecisionLoss === false)
            throw new MediaForgeError(
                `${depth} video becomes 8-bit RGBA here, and allowPrecisionLoss is false`,
                'FORMAT',
                {
                    hint: 'Allow the reduction, or copy the video track instead of re-encoding it.',
                },
            );
        if (reported) return;
        reported = true;
        warn(
            'VIDEO_PRECISION_REDUCED',
            `${depth} pictures are converted to 8-bit RGBA for the video codec`,
        );
    };

    return async data => {
        if (data.kind !== 'frame') return data;
        try {
            return await signalRgba(data.frame, lifetime, precision, data.toSdr);
        } finally {
            data.frame.close();
        }
    };
}

/** Releases what a decoder handed out. */
export function releaseData(data: PictureData): void {
    if (data.kind === 'frame') data.frame.close();
}

/**
 * The packets of a track for its decoder: a track that switches H.264 configurations re-sends the
 * new parameter sets in front of the first packet of each configuration.
 */
function decoderPackets(info: TrackInfo): (packet: FilePacket) => FilePacket {
    const configurations = info.codecConfigurations;
    if (!configurations || configurations.length < 2 || !info.codec.startsWith('avc'))
        return packet => packet;
    let previous: number | undefined;
    return packet => {
        const index = sampleAt(info, packet.sampleIndex)?.codecConfigIndex ?? 0;
        const first = previous === undefined;
        const switched = !first && index !== previous;
        previous = index;
        if (!switched && !(first && index !== 0)) return packet;
        const data = prependAvcConfigToSample(configurations[index]!.codecConfig, packet.data);
        if (!data)
            throw new MediaForgeError(
                `cannot serialize AVC codec configuration transition ${first ? 0 : previous} -> ` +
                    `${index}`,
                'FORMAT',
            );
        return { ...packet, data };
    };
}

/**
 * Opens the decoder of a track: an application codec that decodes its codec, else the host
 * VideoDecoder or a built-in decoder in the order of the preference. Packets go in in decode order.
 */
export async function openClipDecoder(
    info: TrackInfo,
    settings: DecodeSettings,
    output: PictureDataOutput,
): Promise<ClipDecoder> {
    const prepare = decoderPackets(info);
    const provider = settings.providers?.find(candidate => candidate.supportsDecode(info.codec));
    if (provider) {
        const decoder = new ProviderClipDecoder(provider, info, settings, output);
        return {
            kind: decoder.kind,
            decode: packet => decoder.decode(prepare(packet)),
            flush: () => decoder.flush(),
            close: () => decoder.close(),
        };
    }

    const decoder = await openFrameDecoder({
        config: hostVideoDecoderConfig(info),
        decoders: settings.decoders,
        preference: settings.preference,
        missing: settings.missing,
        lifetime: settings.lifetime,
        recovery: settings.recovery,
        output: (picture, timing) =>
            output(
                isHostFrame(picture)
                    ? { kind: 'frame', frame: picture, toSdr: sdrReport(settings.recovery) }
                    : { kind: 'planar', planar: picture },
                timing,
            ),
        toVideoFrame: typeof VideoFrame === 'function',
    });
    return {
        kind: decoder.kind,
        decode: packet => decoder.decode(prepare(packet) as VideoPacketInput),
        flush: final => decoder.flush(final),
        close: () => decoder.close(),
    };
}

function providerFailure(error: unknown, code: 'DECODE' | 'ENCODE'): Error {
    if (error instanceof MediaForgeError) return error;
    if (error instanceof DOMException && error.name === 'AbortError')
        return new MediaForgeError('Aborted', 'ABORT', { cause: error });
    return new MediaForgeError(
        `Video provider ${code === 'DECODE' ? 'decode' : 'encode'} failed: ${errorMessage(error)}`,
        code,
    );
}

/**
 * Runs an application codec call under the lifetime. A result that arrives after the run stopped is
 * handed to `release`, so a late decoder or frame is still closed.
 */
async function providerCall<T>(
    lifetime: CodecLifetime,
    code: 'DECODE' | 'ENCODE',
    operation: () => T | PromiseLike<T>,
    release?: (value: T) => void,
): Promise<T> {
    lifetime.check();
    const pending = Promise.resolve().then(operation);
    try {
        // The lifetime keeps the first failure, which the run then reports: the codec's own error
        // becomes a MediaForgeError before it is recorded.
        return await lifetime.waitFor(
            pending.then(undefined, error => Promise.reject(providerFailure(error, code))),
        );
    } catch (error) {
        if (release) void pending.then(release, () => undefined);
        throw providerFailure(error, code);
    }
}

/**
 * Closes an application codec resource; a failure is reported as CODEC_CLOSE_FAILED unless the run
 * was cancelled.
 */
async function closeResource(
    resource: { close(): void | Promise<void> } | undefined,
    signal: AbortSignal,
    warn: (code: string, message: string) => void,
): Promise<void> {
    try {
        await resource?.close();
    } catch (error) {
        if (!signal.aborted)
            warn('CODEC_CLOSE_FAILED', `Video codec cleanup failed: ${errorMessage(error)}`);
    }
}

/**
 * An application decoder: one picture per packet, each turned into straight RGBA. A track that
 * switches configurations gets a decoder per configuration. Interlaced pictures are processed as
 * progressive frames and pictures deeper than 8 bits are reduced, each reported once.
 */
class ProviderClipDecoder implements ClipDecoder {
    private decoder?: VideoCodecDecoder;
    private configuration = -1;
    private reported = new Set<string>();

    constructor(
        private readonly provider: VideoCodecProvider,
        private readonly info: TrackInfo,
        private readonly settings: DecodeSettings,
        private readonly output: PictureDataOutput,
    ) {}

    get kind(): string {
        return this.provider.id;
    }

    private once(code: string, message: string): void {
        if (this.reported.has(code)) return;
        this.reported.add(code);
        this.settings.recovery.warn(code, message);
    }

    private call<T>(operation: () => T | PromiseLike<T>, release?: (value: T) => void): Promise<T> {
        return providerCall(this.settings.lifetime, 'DECODE', operation, release);
    }

    async decode(packet: FilePacket): Promise<void> {
        const next = sampleAt(this.info, packet.sampleIndex)?.codecConfigIndex ?? 0;
        if (next !== this.configuration) {
            if (this.decoder) {
                const previous = this.decoder;
                this.decoder = undefined;
                await this.call(() => previous.flush?.());
                await closeResource(previous, this.settings.signal, this.settings.recovery.warn);
            }
            const config = this.info.codecConfigurations?.[next] ?? this.info;
            if (!this.provider.supportsDecode(config.codec))
                throw new MediaForgeError(
                    `The video provider cannot decode ${config.codec}`,
                    'DECODE',
                );
            const created = await this.call(
                () =>
                    this.provider.createDecoder({
                        codec: config.codec,
                        width: config.width ?? this.info.width,
                        height: config.height ?? this.info.height,
                        description: config.codecConfig?.slice(),
                        signal: this.settings.signal,
                        maxPixels: PROVIDER_MAX_PIXELS,
                    }),
                late => void closeResource(late, this.settings.signal, this.settings.recovery.warn),
            );
            if (
                !created ||
                typeof created.decode !== 'function' ||
                typeof created.close !== 'function'
            )
                throw new MediaForgeError(
                    'Video codec factory returned an invalid resource',
                    'FORMAT',
                );
            this.decoder = created;
            this.configuration = next;
        }
        const decoder = this.decoder!;
        const frame = await this.call(
            () => decoder.decode(packet),
            late => late?.close?.(),
        );
        if (!frame || typeof frame.close !== 'function' || typeof frame.toRgba !== 'function')
            throw new MediaForgeError('Provider decoder returned an invalid frame', 'DECODE');
        try {
            if (packet.decodeOnly) return;
            if (!Number.isSafeInteger(frame.bitDepth) || frame.bitDepth <= 0 || frame.bitDepth > 32)
                throw new MediaForgeError(
                    'Provider decoder must declare its frame bit depth',
                    'DECODE',
                );
            if (frame.timestamp !== packet.timestamp || frame.duration !== packet.duration)
                throw new MediaForgeError(
                    'Provider decoder must preserve packet timing in seconds',
                    'DECODE',
                );
            // The application decoder's RGBA of other colour is taken as SDR BT.709.
            if (
                (frame.colorPrimaries !== undefined && ![0, 1, 2].includes(frame.colorPrimaries)) ||
                (frame.colorTransfer !== undefined && ![0, 1, 2, 6].includes(frame.colorTransfer))
            )
                sdrReport(this.settings.recovery)();
            if (frame.scanType && frame.scanType !== 'progressive')
                this.once('VIDEO_INTERLACED', 'Interlaced pictures are not deinterlaced');
            const deep = frame.bitDepth > 8 || (frame.alphaBitDepth ?? 0) > 8;
            if (deep) this.precision(`${frame.bitDepth}-bit`);
            if (frame.colorSpaceAssumed)
                this.once(
                    'VIDEO_COLOUR_ASSUMED',
                    'Video provider interpreted unspecified source colour as BT.709 SDR',
                );
            const rgba = await this.call(() =>
                frame.toRgba({
                    allowPrecisionLoss: deep || undefined,
                    signal: this.settings.signal,
                }),
            );
            const data =
                rgba.data instanceof Uint8Array
                    ? rgba.data
                    : new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength);

            // Application codecs hand over BT.709 RGBA.
            const colorSpace = {
                primaries: 'bt709',
                transfer: 'bt709',
                matrix: 'rgb',
                fullRange: true,
            } as const;
            this.output(
                { kind: 'rgba', data, width: rgba.width, height: rgba.height, colorSpace },
                {
                    timestamp: frame.timestamp,
                    duration: frame.duration,
                },
            );
        } finally {
            frame.close();
        }
    }

    /**
     * Pictures deeper than 8 bits become RGBA8: reported once, refused when precision loss is not
     * allowed.
     */
    private precision(depth: string): void {
        if (this.settings.allowPrecisionLoss === false)
            throw new MediaForgeError(
                `${depth} video becomes 8-bit RGBA here, and allowPrecisionLoss is false`,
                'FORMAT',
                {
                    hint: 'Allow the reduction, or copy the video track instead of re-encoding it.',
                },
            );
        this.once(
            'VIDEO_PRECISION_REDUCED',
            `${depth} pictures are converted to 8-bit RGBA for the video codec`,
        );
    }

    async flush(): Promise<void> {
        const decoder = this.decoder;
        if (decoder) await this.call(() => decoder.flush?.());
    }

    close(): Promise<void> {
        const decoder = this.decoder;
        this.decoder = undefined;
        return closeResource(decoder, this.settings.signal, this.settings.recovery.warn);
    }
}

/** The encoder side of a video lane: pictures in order in, packets with their configuration out. */
export interface EncoderPort {
    /** Codec string written into the container. */
    readonly codec: string;
    readonly encoded: number;
    /** Waits until the encoder has room for another picture. */
    ready(): Promise<void>;
    /** Encodes a picture, which the port closes. */
    write(picture: Picture): Promise<void>;
    flush(): Promise<void>;
    close(): void | Promise<void>;
}

/** Drops pictures that do not follow the previous one, reporting the first. */
class Ordering {
    private last = Number.NEGATIVE_INFINITY;
    private reported = false;

    constructor(private readonly warn: (code: string, message: string) => void) {}

    accepts(picture: Picture): boolean {
        if (picture.timestamp > this.last) {
            this.last = picture.timestamp;
            return true;
        }
        if (!this.reported) {
            this.reported = true;
            this.warn(
                'VIDEO_FRAME_DROPPED',
                `Dropped an out-of-order video frame at ${picture.timestamp.toFixed(3)} s`,
            );
        }
        return false;
    }
}

/** The host VideoEncoder as a lane's encoder. */
export class HostEncoderPort implements EncoderPort {
    private readonly encoder: HostVideoEncoder;
    private readonly ordering: Ordering;

    constructor(
        private readonly config: VideoEncoderConfig,
        private readonly lifetime: CodecLifetime,
        keyframeInterval: number,
        output: (packet: EncodedPacket) => void,
        warn: (code: string, message: string) => void,
    ) {
        this.encoder = new HostVideoEncoder(config, lifetime, keyframeInterval, output);
        this.ordering = new Ordering(warn);
    }

    get codec(): string {
        return this.config.codec;
    }

    get encoded(): number {
        return this.encoder.encoded;
    }

    ready(): Promise<void> {
        return this.encoder.ready();
    }

    async write(picture: Picture): Promise<void> {
        try {
            if (!this.ordering.accepts(picture)) return;
            const own = picture.frame;
            const timed =
                own &&
                own.timestamp === micros(picture.timestamp) &&
                own.duration === micros(picture.duration)
                    ? own
                    : picture.toVideoFrame();
            let frame = timed;
            try {
                frame = await encodableFrame(timed, this.lifetime);
                this.encoder.submit(
                    frame,
                    { timestamp: picture.timestamp, duration: picture.duration },
                    picture.keyframe,
                );
            } finally {
                if (frame !== timed) frame.close();
                if (timed !== own) timed.close();
            }
        } finally {
            picture.close();
        }
    }

    flush(): Promise<void> {
        return this.encoder.flush();
    }

    close(): void {
        this.encoder.close();
    }
}

/** Codec strings whose encoders keep an alpha channel. */
const ALPHA_CODECS = /^ap4[hx]$/;

/** Straight RGBA `data` made opaque, a copy when a pixel is not; undefined when all are. */
function opaqueCopy(data: Uint8Array): Uint8Array | undefined {
    let at = 3;
    while (at < data.length && data[at] === 255) at += 4;
    if (at >= data.length) return undefined;
    const opaque = data.slice();
    for (; at < opaque.length; at += 4) opaque[at] = 255;
    return opaque;
}

/** An application encoder as a lane's encoder: straight BT.709 RGBA in, packets out. */
export class ProviderEncoderPort implements EncoderPort {
    private readonly ordering: Ordering;
    private packets = 0;
    private alphaDropped = false;

    private constructor(
        readonly codec: string,
        private readonly encoder: VideoCodecEncoder,
        private readonly lifetime: CodecLifetime,
        private readonly output: (packet: EncodedPacket) => void,
        private readonly warn: (code: string, message: string) => void,
        private readonly signal: AbortSignal,
        private readonly strict: boolean,
    ) {
        this.ordering = new Ordering(warn);
    }

    static async open(
        provider: VideoCodecProvider,
        config: {
            readonly codec: string;
            readonly width: number;
            readonly height: number;
            readonly bitrate?: number;
            readonly framerate?: number;
            readonly signal: AbortSignal;
        },
        lifetime: CodecLifetime,
        output: (packet: EncodedPacket) => void,
        warn: (code: string, message: string) => void,
        strict = false,
    ): Promise<ProviderEncoderPort> {
        if (config.width * config.height > PROVIDER_MAX_PIXELS)
            throw new MediaForgeError(
                'Provider video dimensions exceed the 8192 × 8192 pixel budget',
                'OOM',
            );
        const encoder = await providerCall(
            lifetime,
            'ENCODE',
            () => provider.createEncoder({ ...config, maxPixels: PROVIDER_MAX_PIXELS }),
            late => void closeResource(late, config.signal, warn),
        );
        if (!encoder || typeof encoder.encode !== 'function' || typeof encoder.close !== 'function')
            throw new MediaForgeError('Video codec factory returned an invalid resource', 'FORMAT');
        return new ProviderEncoderPort(
            config.codec,
            encoder,
            lifetime,
            output,
            warn,
            config.signal,
            strict,
        );
    }

    get encoded(): number {
        return this.packets;
    }

    async ready(): Promise<void> {
        this.lifetime.check();
    }

    private call<T>(operation: () => T | PromiseLike<T>): Promise<T> {
        return providerCall(this.lifetime, 'ENCODE', operation);
    }

    private emit(packets: unknown): void {
        for (const packet of (Array.isArray(packets) ? packets : [packets]) as EncodedPacket[]) {
            if (
                !(packet?.data instanceof Uint8Array) ||
                packet.trackType !== 'video' ||
                !Number.isFinite(packet.timestamp) ||
                !Number.isFinite(packet.duration) ||
                packet.duration < 0
            )
                throw new MediaForgeError('Video encoder returned an invalid packet', 'ENCODE');
            this.packets++;
            this.output(packet);
        }
    }

    async write(picture: Picture): Promise<void> {
        try {
            if (!this.ordering.accepts(picture)) return;
            let data = await picture.rgba();
            this.lifetime.check();

            // A codec without alpha takes the colour of the pictures, made opaque.
            const opaque = ALPHA_CODECS.test(this.codec) ? undefined : opaqueCopy(data);
            if (opaque) {
                const message = `${this.codec} cannot keep the alpha channel`;
                if (this.strict) throw new MediaForgeError(message, 'FORMAT');
                if (!this.alphaDropped) this.warn('ALPHA_DROPPED', message);
                this.alphaDropped = true;
                data = opaque;
            }

            this.emit(
                await this.call(() =>
                    this.encoder.encode({
                        data,
                        width: picture.width,
                        height: picture.height,
                        format: 'RGBA',
                        bitDepth: 8,
                        timestamp: picture.timestamp,
                        duration: picture.duration,
                        scanType: 'progressive',
                        colorPrimaries: 1,
                        colorTransfer: 1,
                        premultipliedAlpha: false,
                    }),
                ),
            );
        } finally {
            picture.close();
        }
    }

    async flush(): Promise<void> {
        this.emit((await this.call(() => this.encoder.flush?.())) ?? []);
    }

    close(): Promise<void> {
        return closeResource(this.encoder, this.signal, this.warn);
    }
}

/** What a video encoder is opened with. */
export interface VideoEncoderSettings extends HostVideoEncoderOptions {
    readonly codec: string;
    /**
     * The codec string is kept as given instead of the first profile and level the host takes for
     * the size.
     */
    readonly explicit?: boolean;
    readonly width: number;
    readonly height: number;
    readonly framerate: number;
    /** Bits per second; default the bitrate for the codec, size and frame rate. */
    readonly bitrate?: number;
    /** 10 for high-dynamic-range sources, which need a 10-bit profile. */
    readonly bitDepth?: 8 | 10;
    /** The container the packets go into, which decides the H.264 and HEVC bitstream format. */
    readonly container?: string;
    /** Seconds between keyframes. */
    readonly keyframeInterval: number;
    /** An application codec that encodes instead of the host VideoEncoder. */
    readonly provider?: VideoCodecProvider;
    /** Strict validation: pictures whose alpha the codec drops fail instead of being reported. */
    readonly strict?: boolean;
    readonly signal: AbortSignal;
}

/**
 * Opens a video encoder: the application codec of `settings.provider`, else the host VideoEncoder
 * with the first configuration it accepts for the codec and size. Packets reach `output` in decode
 * order.
 */
export async function openVideoEncoder(
    settings: VideoEncoderSettings,
    lifetime: CodecLifetime,
    output: (packet: EncodedPacket) => void,
    warn: (code: string, message: string) => void,
): Promise<EncoderPort> {
    const { codec, width, height, framerate, signal } = settings;
    if (settings.provider)
        return ProviderEncoderPort.open(
            settings.provider,
            { codec, width, height, bitrate: settings.bitrate, framerate, signal },
            lifetime,
            output,
            warn,
            settings.strict,
        );

    const config = await selectEncoderConfig(
        {
            codec,
            explicit: settings.explicit ?? false,
            width,
            height,
            framerate,
            bitrate: settings.bitrate ?? defaultVideoBitrate(codec, width, height, framerate),
            bitDepth: settings.bitDepth ?? 8,
            container: settings.container ?? '',
            hardwareAcceleration: settings.hardwareAcceleration,
            latencyMode: settings.latencyMode,
            bitrateMode: settings.bitrateMode,
        },
        lifetime,
    );
    return new HostEncoderPort(config, lifetime, settings.keyframeInterval, output, warn);
}
