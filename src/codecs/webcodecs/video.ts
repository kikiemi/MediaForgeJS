import type { CodecLifetime } from '../shared/codec-lifetime';
import { MediaForgeError, errorMessage } from '../../core/errors/errors';
import type { EncodedPacket } from '../../core/model/media';
import type { PlanarVideoFrame } from '../../core/contracts/picture';
import { videoEncoderCodecs, type VideoEncodeShape } from '../../core/model/codec-level';
import { av1ConfigFromTemporalUnit } from '../../core/codec-config/video/av1-config';
import { QueueGate, bufferCopy, closeCodec, codecError, micros } from './codec';
import { hostCodecAvailable, queryHostCodec } from './support';
import type { HostVideoEncoderOptions } from './video-options';

/** Presentation time and duration in seconds. */
export interface FrameTiming {
    readonly timestamp: number;
    readonly duration: number;
}

export interface VideoPacketInput {
    readonly data: Uint8Array;
    readonly timestamp: number;
    readonly duration: number;
    readonly isKeyframe: boolean;
    /** Decoded as a reference for later pictures; its own picture is released, not output. */
    readonly decodeOnly?: boolean;
}

interface IsoColour {
    readonly primaries: number;
    readonly transfer: number;
    readonly matrix: number;
    /** Undefined when the container leaves the range unspecified. */
    readonly fullRange?: boolean;
}

/**
 * Where decode damage goes: strict validation fails on it, otherwise it is reported and skipped.
 */
export interface DecodeRecovery {
    readonly strict: boolean;
    warn(code: string, message: string): void;
}

/** A host frame, or a built-in decoder's planes where no host VideoFrame is wanted. */
export type DecodedPicture = VideoFrame | PlanarVideoFrame;

export function isHostFrame(picture: DecodedPicture): picture is VideoFrame {
    return typeof VideoFrame === 'function' && picture instanceof VideoFrame;
}

/** Closes a host frame; built-in planes need no release. */
export function releasePicture(picture: DecodedPicture): void {
    if (isHostFrame(picture)) picture.close();
}

/** Packets decoded ahead of the frame consumer, and frames queued ahead of the encoder. */
export const DECODE_AHEAD = 8;
export const ENCODE_AHEAD = 8;
/** Chunks after which a frame the encoder has not given back is taken as dropped. */
const REORDER_LIMIT = 16;

/** Consecutive decoder restarts without a decoded frame before the damage is treated as fatal. */
export const MAX_RECOVERIES = 16;
/** Bytes of decoded packets a host decoder keeps to decode their group again after a failure. */
const REPLAY_BYTES = 16 * 2 ** 20;

/** ISO/IEC 23091-2 code points and the WebCodecs registry names that describe them. */
const PRIMARIES: Readonly<Record<number, string>> = {
    1: 'bt709',
    5: 'bt470bg',
    6: 'smpte170m',
    9: 'bt2020',
    12: 'smpte432',
};
const TRANSFERS: Readonly<Record<number, string>> = {
    1: 'bt709',
    6: 'smpte170m',
    8: 'linear',
    13: 'iec61966-2-1',
    16: 'pq',
    18: 'hlg',
};
const MATRICES: Readonly<Record<number, string>> = {
    0: 'rgb',
    1: 'bt709',
    5: 'bt470bg',
    6: 'smpte170m',
    9: 'bt2020-ncl',
};
const codeOf = (
    table: Readonly<Record<number, string>>,
    name: string | null | undefined,
): number | undefined => {
    for (const [code, value] of Object.entries(table)) if (value === name) return Number(code);
    return undefined;
};

/** WebCodecs names for an ISO/IEC 23091-2 colour description; unknown entries are left out. */
function webCodecsColour(colour: IsoColour | undefined): VideoColorSpaceInit | undefined {
    if (!colour) return undefined;
    const space = {
        primaries: PRIMARIES[colour.primaries],
        transfer: TRANSFERS[colour.transfer],
        matrix: MATRICES[colour.matrix],
        fullRange: colour.fullRange,
    };
    return space.primaries || space.transfer || space.matrix
        ? (space as VideoColorSpaceInit)
        : undefined;
}

/** ISO/IEC 23091-2 codes for a complete WebCodecs colour space. */
function isoColour(space: VideoColorSpaceInit | null | undefined): IsoColour | undefined {
    const primaries = codeOf(PRIMARIES, space?.primaries);
    const transfer = codeOf(TRANSFERS, space?.transfer);
    const matrix = codeOf(MATRICES, space?.matrix);
    if (primaries === undefined || transfer === undefined || matrix === undefined) return undefined;
    return { primaries, transfer, matrix, fullRange: space?.fullRange === true };
}

export function isHdrTransfer(transfer: string | null | undefined): boolean {
    return transfer === 'pq' || transfer === 'hlg';
}

/** Whether a colour space is HDR or wide-gamut, which becomes SDR BT.709 as RGBA8. */
export function isHdrColour(space: VideoColorSpaceInit | null | undefined): boolean {
    return (
        isHdrTransfer(space?.transfer as string | null | undefined) ||
        (space?.primaries as string | null | undefined) === 'bt2020'
    );
}

const sdrReports = new WeakMap<DecodeRecovery, () => void>();

/**
 * The toSdr of the pictures a decoder with `recovery` makes: one HDR_TO_SDR warning, or a FORMAT
 * error under strict validation.
 */
export function sdrReport(recovery: DecodeRecovery): () => void {
    let report = sdrReports.get(recovery);
    if (!report) {
        let reported = false;
        report = () => {
            if (recovery.strict) throw new MediaForgeError('HDR video would become SDR', 'FORMAT');
            if (reported) return;
            reported = true;
            recovery.warn('HDR_TO_SDR', 'HDR video is converted to SDR');
        };
        sdrReports.set(recovery, report);
    }
    return report;
}

/**
 * Host decoder configuration of a demuxed video track: coded size, configuration record and colour
 * description.
 */
export function hostVideoDecoderConfig(track: {
    readonly codec: string;
    readonly width?: number;
    readonly height?: number;
    readonly codecConfig?: Uint8Array;
    readonly colour?: IsoColour;
}): VideoDecoderConfig {
    const colorSpace = webCodecsColour(track.colour);
    return {
        codec: track.codec,
        codedWidth: track.width,
        codedHeight: track.height,
        hardwareAcceleration: 'no-preference',
        ...(track.codecConfig ? { description: track.codecConfig } : {}),
        ...(colorSpace ? { colorSpace } : {}),
    };
}

export interface FrameDecoder {
    /** 'host' for the platform VideoDecoder, otherwise the built-in codec id. */
    readonly kind: string;
    /**
     * Submits one packet in decode order, waiting while the decoder is DECODE_AHEAD packets ahead.
     */
    decode(packet: VideoPacketInput): Promise<void>;
    /** Outputs every held picture. `final` also fails when no picture was ever decoded. */
    flush(final: boolean): Promise<void>;
    close(): void;
}

export type PictureOutput = (picture: DecodedPicture, timing: FrameTiming) => void;

/**
 * Packets lost to decode damage. Lenient decoding drops them and reports the count once decoding
 * resumes at a keyframe or the stream ends; strict decoding fails instead.
 */
export class DamageLog {
    private count = 0;
    private from = 0;

    constructor(
        private readonly recovery: DecodeRecovery,
        private readonly lifetime: CodecLifetime,
    ) {}

    /** Drops a packet decoding cannot start with; strict decoding fails instead. */
    skip(timestamp: number): void {
        if (this.recovery.strict)
            throw this.lifetime.record(
                new MediaForgeError('Video decoding needs a keyframe before this packet', 'DECODE'),
            );
        this.drop(timestamp);
    }

    drop(timestamp: number): void {
        this.from = this.count++ === 0 ? timestamp : Math.min(this.from, timestamp);
    }

    /**
     * Reports the dropped packets; `until` is the keyframe where decoding resumed, undefined at the
     * stream end.
     */
    report(until: number | undefined): void {
        if (!this.count) return;
        this.recovery.warn(
            'VIDEO_DECODE_RECOVERED',
            `Dropped ${this.count} video packet(s) from ${this.from.toFixed(3)} s to ` +
                (until === undefined ? 'the end' : `the keyframe at ${until.toFixed(3)} s`),
        );
        this.count = 0;
    }
}

/**
 * Host VideoDecoder with exact packet timing and keyframe recovery; output receives ownership of
 * each frame.
 */
export class HostVideoDecoder implements FrameDecoder {
    readonly kind = 'host';
    private decoder!: VideoDecoder;
    private gate!: QueueGate;
    private generation = 0;
    /**
     * Packets the decoder holds, in decode order and keyed by chunk timestamp, with their exact
     * timing; `hidden` for a packet decoded again whose picture was output before.
     */
    private readonly pending = new Map<
        number,
        FrameTiming & { readonly packet: VideoPacketInput; readonly hidden?: boolean }
    >();
    /**
     * The packets of this decoder from the keyframe the oldest held packet depends on, in decode
     * order, for decoding that group again after a failure; undefined past REPLAY_BYTES.
     */
    private group: VideoPacketInput[] | undefined = [];
    private groupBytes = 0;
    /** Whether a group was decoded again since the last picture. */
    private replayed = false;
    private readonly damage: DamageLog;
    private broken: MediaForgeError | undefined;
    private firstError: MediaForgeError | undefined;
    private awaitingKey = true;
    private restarts = 0;
    private submitted = 0;
    private outputs = 0;
    private closed = false;
    /** Whether the decoder was replaced by one preferring software after it failed at first. */
    private software = false;

    constructor(
        private config: VideoDecoderConfig,
        private readonly lifetime: CodecLifetime,
        private readonly output: PictureOutput,
        private readonly recovery: DecodeRecovery,
    ) {
        this.damage = new DamageLog(recovery, lifetime);
        this.start();
    }

    private start(): void {
        const generation = ++this.generation;
        this.decoder = new VideoDecoder({
            output: frame => this.onFrame(frame, generation),
            error: error => this.onError(error, generation),
        });
        this.gate = new QueueGate(this.decoder);
        try {
            this.decoder.configure(this.config);
        } catch (error) {
            throw codecError(
                error,
                'DECODE',
                `VideoDecoder configure failed for '${this.config.codec}'`,
            );
        }
    }

    private onFrame(frame: VideoFrame, generation: number): void {
        if (this.closed || generation !== this.generation || !this.lifetime.acceptingOutput) {
            frame.close();
            return;
        }
        const key = frame.timestamp;
        const held = this.pending.get(key);
        for (const pending of this.pending.keys()) if (pending <= key) this.pending.delete(pending);
        this.trimGroup();
        if (held?.hidden) {
            frame.close();
            return;
        }
        const timing: FrameTiming = held
            ? { timestamp: held.timestamp, duration: held.duration }
            : { timestamp: key / 1e6, duration: (frame.duration ?? 0) / 1e6 };
        this.outputs++;
        this.restarts = 0;
        this.replayed = false;
        try {
            // A host that ignores the configured colour (Safari) labels the pictures of an HDR
            // stream SDR, which nothing after can tell: that is their conversion to SDR.
            if (isHdrColour(this.config.colorSpace) && !isHdrColour(frame.colorSpace))
                sdrReport(this.recovery)();
            this.output(frame, timing);
        } catch (error) {
            frame.close();
            this.lifetime.record(error);
        }
    }

    /**
     * `usable` means the decoder rejected one packet and stays configured, so it is not replaced.
     */
    private onError(error: unknown, generation: number, usable = false): void {
        if (this.closed || generation !== this.generation) return;
        const failure = new MediaForgeError(
            `Native video decode failed: ${errorMessage(error)}`,
            'DECODE',
        );
        this.firstError ??= failure;
        if (this.recovery.strict) {
            this.lifetime.record(failure);
            return;
        }
        if (usable) return;
        this.broken ??= failure;
        this.gate.wake();
    }

    /**
     * Replaces a failed decoder. The packets it still held are dropped up to the first keyframe
     * after the oldest of them, which the failure may have come from; that keyframe and the packets
     * after it are decoded again.
     *
     * A decoder that outputs each picture late (Firefox's, one packet behind) loses the pictures
     * before a failing keyframe with it, so the oldest held packet need not be the failing one.
     * Where it is a delta packet held with a later keyframe, its group is first decoded again from
     * its keyframe up to that keyframe, the pictures output before hidden, and flushed out: only
     * when that fails again are its packets dropped.
     */
    private async restart(): Promise<void> {
        let held = this.heldPackets();
        // A decoder that fails before its first picture where it may use hardware (Safari's VP9
        // in a macOS virtual machine) is replaced by one that prefers software, which decodes the
        // packets again; only when that fails as well are packets dropped.
        if (
            !this.outputs &&
            !this.software &&
            (this.config.hardwareAcceleration ?? 'no-preference') === 'no-preference' &&
            held[0]?.isKeyframe
        ) {
            this.software = true;
            this.config = { ...this.config, hardwareAcceleration: 'prefer-software' };
            this.broken = undefined;
            this.reopen();
            for (const packet of held) if (!this.broken) this.submit(packet);
            return;
        }
        for (;;) {
            if (++this.restarts > MAX_RECOVERIES)
                throw this.lifetime.record(this.firstError ?? this.broken!);
            this.broken = undefined;
            const replay = this.replayable(held);
            this.reopen();
            if (!replay) break;
            this.replayed = true;
            const key = held.findIndex(packet => packet.isKeyframe);
            for (const packet of replay) if (!this.broken) this.submit(packet, true);
            for (const packet of held.slice(0, key)) if (!this.broken) this.submit(packet);
            await this.drain();
            if (this.broken) {
                held = [...this.heldPackets(), ...held.slice(key)];
                continue;
            }
            for (const packet of held.slice(key)) if (!this.broken) this.submit(packet);
            return;
        }
        const resume = held.findIndex((packet, index) => index > 0 && packet.isKeyframe);
        for (const packet of resume < 0 ? held : held.slice(0, resume))
            this.damage.drop(packet.timestamp);
        if (resume >= 0)
            for (const packet of held.slice(resume)) if (!this.broken) this.submit(packet);
    }

    /** The packets the decoder holds whose pictures were not output, in decode order. */
    private heldPackets(): VideoPacketInput[] {
        return [...this.pending.values()].filter(entry => !entry.hidden).map(entry => entry.packet);
    }

    /** A new decoder in place of the current one, holding nothing and waiting for a keyframe. */
    private reopen(): void {
        this.pending.clear();
        this.group = [];
        this.groupBytes = 0;
        this.gate.dispose();
        closeCodec(this.decoder);
        try {
            this.start();
        } catch (error) {
            throw this.lifetime.record(error);
        }
        this.awaitingKey = true;
    }

    /** Waits until the decoder output every packet it holds; a failure breaks it. */
    private async drain(): Promise<void> {
        let failed: unknown;
        await this.lifetime.waitFor(
            this.decoder.flush().then(
                () => undefined,
                error => {
                    failed = error;
                },
            ),
        );
        if (failed !== undefined && !this.broken) this.onError(failed, this.generation);
    }

    /**
     * The packets before the oldest of `held` in its group, from its keyframe, to decode again
     * before `held`: only where the oldest is a delta packet held with a later keyframe, this
     * decoder kept its group, and no group was decoded again since the last picture.
     */
    private replayable(held: readonly VideoPacketInput[]): VideoPacketInput[] | undefined {
        const first = held[0];
        if (!first || first.isKeyframe || this.replayed || !this.group) return undefined;
        if (!held.some(packet => packet.isKeyframe)) return undefined;
        const at = this.group.indexOf(first);
        let key = at - 1;
        while (key >= 0 && !this.group[key]!.isKeyframe) key--;
        return key < 0 ? undefined : this.group.slice(key, at);
    }

    /** Keeps `packet` in the group of the held packets, or gives the group up past REPLAY_BYTES. */
    private remember(packet: VideoPacketInput): void {
        if (packet.isKeyframe && (this.pending.size === 1 || !this.group)) {
            this.group = [];
            this.groupBytes = 0;
        }
        if (!this.group) return;
        this.group.push(packet);
        this.groupBytes += packet.data.byteLength;
        if (this.groupBytes > REPLAY_BYTES) this.group = undefined;
    }

    /** Lets go of the group's packets before the keyframe the oldest held packet depends on. */
    private trimGroup(): void {
        const group = this.group;
        if (!group?.length) return;
        const oldest = this.pending.values().next().value?.packet;
        const at = oldest ? group.indexOf(oldest) : -1;
        let key = at < 0 ? group.length - 1 : at;
        while (key > 0 && !group[key]!.isKeyframe) key--;
        if (key === 0) return;
        for (const packet of group.splice(0, key)) this.groupBytes -= packet.data.byteLength;
    }

    private submit(packet: VideoPacketInput, hidden = false): void {
        let key = micros(packet.timestamp);
        while (this.pending.has(key)) key++;
        this.pending.set(key, {
            timestamp: packet.timestamp,
            duration: packet.duration,
            packet,
            ...(hidden ? { hidden } : {}),
        });
        try {
            this.decoder.decode(
                new EncodedVideoChunk({
                    type: packet.isKeyframe ? 'key' : 'delta',
                    timestamp: key,
                    duration: micros(packet.duration),
                    data: packet.data,
                }),
            );
        } catch (error) {
            this.pending.delete(key);
            this.onError(error, this.generation, this.decoder.state === 'configured');
            if (!hidden) this.damage.drop(packet.timestamp);
            this.awaitingKey = true;
            return;
        }

        this.remember(packet);
        if (hidden) {
            this.awaitingKey = false;
            return;
        }
        this.submitted++;
        if (this.awaitingKey) this.damage.report(packet.timestamp);
        this.awaitingKey = false;
    }

    async decode(packet: VideoPacketInput): Promise<void> {
        this.lifetime.check();
        if (this.broken) await this.restart();
        if (this.awaitingKey && !packet.isKeyframe) return this.damage.skip(packet.timestamp);
        await this.gate.until(
            () => this.decoder.decodeQueueSize <= DECODE_AHEAD || !!this.broken,
            this.lifetime,
        );
        if (this.broken) {
            await this.restart();
            if (this.awaitingKey && !packet.isKeyframe) return this.damage.skip(packet.timestamp);
        }
        this.submit(packet);
    }

    async flush(final: boolean): Promise<void> {
        this.lifetime.check();
        for (;;) {
            if (!this.broken && this.submitted) await this.drain();

            this.lifetime.check();
            if (!this.broken) break;
            await this.restart();
            if (!this.pending.size) break;
        }

        this.pending.clear();
        this.group = [];
        this.groupBytes = 0;
        this.damage.report(undefined);
        this.awaitingKey = true;
        if (final && this.submitted && !this.outputs)
            throw this.lifetime.record(
                this.firstError ??
                    new MediaForgeError('The video decoder produced no frames', 'DECODE'),
            );
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.gate.dispose();
        this.pending.clear();
        this.group = undefined;
        closeCodec(this.decoder);
    }
}

/** Containers whose AVC and HEVC samples are length-prefixed; the others carry Annex B. */
const LENGTH_PREFIXED = ['mp4', 'mov', '3gp', 'm4v', 'flv'];

interface EncoderRequest extends VideoEncodeShape, HostVideoEncoderOptions {
    readonly codec: string;
    /** True when the caller named a codec string with a profile, which is kept. */
    readonly explicit: boolean;
    /**
     * Output container; AVC and HEVC use length-prefixed samples in MP4-family and FLV, Annex B
     * elsewhere.
     */
    readonly container: string;
}

/**
 * Host encoder configuration for one codec string and container framing; latency 'quality' and no
 * hardware preference unless the request names them.
 */
export function hostVideoEncoderConfig(
    codec: string,
    request: Omit<EncoderRequest, 'codec' | 'explicit'>,
): VideoEncoderConfig {
    const lengthPrefixed = LENGTH_PREFIXED.includes(request.container);
    return {
        codec,
        width: request.width,
        height: request.height,
        bitrate: request.bitrate,
        framerate: request.framerate,
        latencyMode: request.latencyMode ?? 'quality',
        hardwareAcceleration: request.hardwareAcceleration ?? 'no-preference',
        ...(request.bitrateMode ? { bitrateMode: request.bitrateMode } : {}),
        ...(codec.startsWith('avc') ? { avc: { format: lengthPrefixed ? 'avc' : 'annexb' } } : {}),
        ...(codec.startsWith('hvc1') || codec.startsWith('hev1')
            ? { hevc: { format: lengthPrefixed ? 'hevc' : 'annexb' } }
            : {}),
    } as VideoEncoderConfig;
}

/**
 * The first configuration the host VideoEncoder accepts among codec strings with a level valid for
 * the output. HDR sources that no 10-bit profile accepts fail with FORMAT, other refusals with
 * ENCODE.
 */
export async function selectEncoderConfig(
    request: EncoderRequest,
    lifetime: CodecLifetime,
): Promise<VideoEncoderConfig> {
    if (!hostCodecAvailable('VideoEncoder'))
        throw new MediaForgeError('This host has no WebCodecs VideoEncoder', 'ENCODE');
    const candidates = videoEncoderCodecs(request.codec, request, request.explicit);
    let reason = '';
    for (const codec of candidates) {
        const config = hostVideoEncoderConfig(codec, request);
        const support = await lifetime.waitFor(queryHostCodec('VideoEncoder', config));
        if (support.supported) return config;
        reason = support.error ?? (reason || 'unsupported');
    }

    if (request.bitDepth === 10)
        throw new MediaForgeError(
            `This host has no 10-bit encoder for HDR video at ${request.width}×${request.height}`,
            'FORMAT',
        );
    throw new MediaForgeError(
        `VideoEncoder does not support ${request.codec} at ${request.width}×${request.height}`,
        'ENCODE',
        { cause: reason },
    );
}

/** Whether the host's video encoders encode a frame's visible rectangle, by VideoEncoder class. */
const visibleRectChecks = new WeakMap<object, Promise<boolean>>();

/**
 * Whether the host's video encoders encode a frame's visible rectangle, probed once on VP8: the
 * white right half of a frame whose left half is black decodes white where they do. Firefox
 * encodes the whole coded picture into the rectangle's size instead. Without VP8 they are taken to.
 */
function encodesVisibleRect(): Promise<boolean> {
    const host = globalThis.VideoEncoder;
    let known = visibleRectChecks.get(host);
    if (!known) visibleRectChecks.set(host, (known = probeVisibleRect()));
    return known;
}

async function probeVisibleRect(): Promise<boolean> {
    const [width, height] = [64, 32];
    const planes = new Uint8Array(width * height * 1.5).fill(128);
    for (let y = 0; y < height; y++) {
        planes.fill(16, y * width, y * width + width / 2);
        planes.fill(235, y * width + width / 2, (y + 1) * width);
    }
    const chunks: EncodedVideoChunk[] = [];
    const pictures: VideoFrame[] = [];
    let frame: VideoFrame | undefined;
    let encoder: VideoEncoder | undefined;
    let decoder: VideoDecoder | undefined;
    try {
        frame = new VideoFrame(planes, {
            format: 'I420',
            codedWidth: width,
            codedHeight: height,
            timestamp: 0,
            visibleRect: { x: width / 2, y: 0, width: width / 2, height },
        });
        encoder = new VideoEncoder({ output: chunk => chunks.push(chunk), error: () => {} });
        encoder.configure({ codec: 'vp8', width: width / 2, height });
        encoder.encode(frame, { keyFrame: true });
        await encoder.flush();
        decoder = new VideoDecoder({ output: picture => pictures.push(picture), error: () => {} });
        decoder.configure({ codec: 'vp8' });
        for (const chunk of chunks) decoder.decode(chunk);
        await decoder.flush();
        const [picture] = pictures;
        if (!picture?.format) return true;
        const data = new Uint8Array(picture.allocationSize());
        const [plane] = await picture.copyTo(data);
        // The first byte of a pixel near the left edge: luma, or red of RGB.
        const bytes = /^(?:RGB|BGR)/.test(picture.format) ? 4 : 1;
        return data[plane!.offset + (height / 2) * plane!.stride + 2 * bytes]! > 128;
    } catch {
        return true;
    } finally {
        frame?.close();
        for (const picture of pictures) picture.close();
        closeCodec(encoder);
        closeCodec(decoder);
    }
}

/**
 * `frame` as the host's encoders take it: one showing part of its coded picture becomes a copy of
 * that part where they encode the whole picture (see encodesVisibleRect). The caller closes a
 * copy.
 */
export async function encodableFrame(
    frame: VideoFrame,
    lifetime: CodecLifetime,
): Promise<VideoFrame> {
    const rect = frame.visibleRect;
    if (
        !rect ||
        !frame.format ||
        (rect.x === 0 &&
            rect.y === 0 &&
            rect.width === frame.codedWidth &&
            rect.height === frame.codedHeight) ||
        (await lifetime.waitFor(encodesVisibleRect()))
    )
        return frame;
    return memoryFrame(frame, lifetime);
}

/**
 * A copy in memory of the visible part of `frame` (which has a pixel format), holding none of its
 * resources, such as a GPU decoder's frame; the caller closes the copy.
 */
export async function memoryFrame(frame: VideoFrame, lifetime: CodecLifetime): Promise<VideoFrame> {
    const rect = frame.visibleRect!;
    const data = new Uint8Array(frame.allocationSize());
    const layout = await lifetime.waitFor(frame.copyTo(data));
    return new VideoFrame(data, {
        format: frame.format!,
        codedWidth: rect.width,
        codedHeight: rect.height,
        layout,
        timestamp: frame.timestamp,
        duration: frame.duration ?? undefined,
        displayWidth: frame.displayWidth,
        displayHeight: frame.displayHeight,
        colorSpace: frame.colorSpace?.toJSON(),
    });
}

/**
 * Host VideoEncoder with keyframes by time, exact packet timing and the reported decoder
 * configuration.
 */
export class HostVideoEncoder {
    private readonly encoder: VideoEncoder;
    private readonly gate: QueueGate;
    /** The frames submitted and not given back, by microsecond timestamp, in submission order. */
    private readonly pending = new Map<
        number,
        { readonly timing: FrameTiming; readonly index: number }
    >();
    private submitted = 0;
    /** Microseconds the encoder stamps its chunks after their frames. */
    private late: number | undefined;
    private lastKey: number | undefined;
    private closed = false;
    private described = false;
    private readonly av1: boolean;
    encoded = 0;

    constructor(
        config: VideoEncoderConfig,
        private readonly lifetime: CodecLifetime,
        private readonly keyframeInterval: number,
        private readonly output: (packet: EncodedPacket) => void,
    ) {
        this.encoder = new VideoEncoder({
            output: (chunk, metadata) => this.onChunk(chunk, metadata),
            error: error => {
                if (!this.closed)
                    lifetime.record(codecError(error, 'ENCODE', 'Native video encode failed'));
            },
        });
        this.gate = new QueueGate(this.encoder);
        this.av1 = config.codec.startsWith('av01');
        try {
            this.encoder.configure(config);
        } catch (error) {
            this.close();
            throw codecError(
                error,
                'ENCODE',
                `VideoEncoder configure failed for '${config.codec}'`,
            );
        }
    }

    private onChunk(
        chunk: EncodedVideoChunk,
        metadata: EncodedVideoChunkMetadata | undefined,
    ): void {
        if (this.closed || !this.lifetime.acceptingOutput) return;
        try {
            // The first chunk is the first frame, a keyframe: an encoder that stamps its chunks
            // late (Firefox's reordering H.264, by its reorder delay) is as late for each.
            this.late ??= chunk.timestamp - (this.pending.keys().next().value ?? chunk.timestamp);
            const key = chunk.timestamp - this.late;
            const held = this.pending.get(key);
            this.pending.delete(key);
            const timing = held?.timing ?? {
                timestamp: key / 1e6,
                duration: (chunk.duration ?? 0) / 1e6,
            };
            // Chunks come in decode order: one decodes no later than each frame still to come
            // presents. A frame held past REORDER_LIMIT chunks was dropped.
            let decodeTimestamp = timing.timestamp;
            for (const [time, frame] of this.pending)
                if (frame.index < this.encoded - REORDER_LIMIT) this.pending.delete(time);
                else if (time < key)
                    decodeTimestamp = Math.min(decodeTimestamp, frame.timing.timestamp);
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            const description = metadata?.decoderConfig?.description;
            let codecConfig = description ? bufferCopy(description) : undefined;
            if (!codecConfig && this.av1 && !this.described && chunk.type === 'key')
                codecConfig = av1ConfigFromTemporalUnit(data);
            this.described ||= !!codecConfig;
            this.encoded++;
            const colour = metadata?.decoderConfig
                ? isoColour(metadata.decoderConfig.colorSpace)
                : undefined;
            this.output({
                data,
                timestamp: timing.timestamp,
                ...(decodeTimestamp < timing.timestamp ? { decodeTimestamp } : {}),
                duration: timing.duration,
                isKeyframe: chunk.type === 'key',
                trackType: 'video',
                codecConfig,
                ...(colour ? { colour } : {}),
            });
        } catch (error) {
            this.lifetime.record(error);
        }
    }

    /** Waits until the encoder has room for another frame. */
    ready(): Promise<void> {
        return this.gate.until(() => this.encoder.encodeQueueSize <= ENCODE_AHEAD, this.lifetime);
    }

    /**
     * Queues one frame without waiting, a keyframe when `key` asks for one; the caller keeps
     * ownership of `frame`.
     */
    submit(frame: VideoFrame, timing: FrameTiming, key = false): void {
        this.lifetime.check();
        const keyFrame =
            key ||
            this.lastKey === undefined ||
            timing.timestamp - this.lastKey >= this.keyframeInterval - timing.duration / 2;
        if (keyFrame) this.lastKey = timing.timestamp;
        this.pending.set(frame.timestamp, { timing, index: this.submitted++ });
        this.encoder.encode(frame, { keyFrame });
    }

    async flush(): Promise<void> {
        this.lifetime.check();
        await this.lifetime.waitFor(this.encoder.flush());
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.gate.dispose();
        this.pending.clear();
        closeCodec(this.encoder);
    }
}
