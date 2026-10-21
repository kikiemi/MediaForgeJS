import type { Sample, TrackInfo } from '../../core/model/track';
import type { AudioIndexContext } from '../audio-files/index-context';
import type { ByteReader } from '../../core/io/sources/chunk-reader';
import { DemuxError } from '../../core/errors/errors';
import { oggStreamPages, type OggPacket } from './pages';
import { vfwVideoCodec } from '../../core/codec-config/video/mpeg-video';
import { mpegVideoFamily } from '../../core/model/codec-strings';
import { AviMpegVideoReader, presentMpegPictures } from '../shared/vfw/mpeg-video';
import { AviMpegAudioReader, parseDolbyAudioFrame } from '../shared/vfw/mpeg-audio';
import { compressedWaveCodec } from '../../core/codec-config/audio/wave-format';
import { vorbisCommentTitle } from '../metadata/vorbis-comment';
import { dataView } from '../../core/bytes/byte-fields';

/** A logical Ogg stream read by this module, and the list of the demux result it belongs to. */
interface OggExtraTrack {
    readonly kind: 'video' | 'audio' | 'subtitle';
    readonly track: TrackInfo;
}

/** The stream header of an OGM (DirectShow) logical stream, in its later or its original layout. */
interface OgmHeader {
    readonly kind: 'video' | 'audio' | 'text';
    readonly fourcc: string;
    readonly formatTag: number;
    /** Seconds per granule unit. */
    readonly unit: number;
    /** Granule units of a packet that states no duration. */
    readonly defaultDuration: number;
    readonly width: number;
    readonly height: number;
}

const OLD_OGM_SIGNATURE = '\x01Direct Show Samples embedded in Ogg';

function ascii(bytes: Uint8Array, at: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(at, at + length));
}

function parseOgmHeader(packet: Uint8Array): OgmHeader {
    const view = dataView(packet);
    const u64 = (at: number): number =>
        view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
    if (ascii(packet, 0, OLD_OGM_SIGNATURE.length) === OLD_OGM_SIGNATURE) {
        const type = packet.length >= 136 ? view.getUint32(96, true) : 0;

        // Video gives the frame period in REFERENCE_TIME units (100 ns), audio its sample rate.
        if (type === 0x05589f80 && packet.length >= 184 && u64(164) > 0)
            return {
                kind: 'video',
                fourcc: ascii(packet, 68, 4),
                formatTag: 0,
                unit: u64(164) / 1e7,
                defaultDuration: 1,
                width: view.getUint32(176, true),
                height: view.getUint32(180, true),
            };
        if (type === 0x05589f81 && view.getUint32(128, true) > 0)
            return {
                kind: 'audio',
                fourcc: '',
                formatTag: view.getUint16(124, true),
                unit: 1 / view.getUint32(128, true),
                defaultDuration: 0,
                width: 0,
                height: 0,
            };
        throw new DemuxError('Invalid OGM DirectShow stream header');
    }
    const kind = ascii(packet, 1, 8).replace(/\0+$/, '');

    // time_unit REFERENCE_TIME units span samples_per_unit granule units.
    const timeUnit = packet.length >= 52 ? u64(17) : 0;
    const perUnit = packet.length >= 52 ? u64(25) : 0;
    if ((kind !== 'video' && kind !== 'audio' && kind !== 'text') || !(timeUnit > 0 && perUnit > 0))
        throw new DemuxError('Invalid OGM stream header');
    return {
        kind,
        fourcc: kind === 'video' ? ascii(packet, 9, 4) : '',
        formatTag: kind === 'audio' ? Number.parseInt(ascii(packet, 9, 4), 16) || 0 : 0,
        unit: timeUnit / (perUnit * 1e7),
        defaultDuration: view.getUint32(33, true),
        width: kind === 'video' ? view.getUint32(45, true) : 0,
        height: kind === 'video' ? view.getUint32(49, true) : 0,
    };
}

/**
 * One OGM data packet: its first byte flags a keyframe and counts the little-endian duration bytes
 * after it.
 */
interface OgmPacket {
    readonly offset: number;
    readonly payload: Uint8Array;
    readonly duration: number;
    readonly keyframe: boolean;
}

function ogmPacket(packet: OggPacket): OgmPacket | undefined {
    const { data } = packet;
    const head = data[0]!;
    const lengthBytes = ((head & 2) << 1) | ((head >> 6) & 3);
    if (data.length < lengthBytes + 1) return undefined;
    let duration = 0;
    for (let index = lengthBytes; index >= 1; index--) duration = duration * 256 + data[index]!;
    return {
        offset: packet.offset < 0 ? -1 : packet.offset + 1 + lengthBytes,
        payload: data.subarray(1 + lengthBytes),
        duration,
        keyframe: (head & 8) !== 0,
    };
}

/**
 * The latest packets for the frame readers: a packet within one page reads at its file offset, one
 * spanning pages at a place past the end of the input, whose frames then keep copies.
 */
class PacketBytes implements ByteReader {
    readonly size = Number.MAX_SAFE_INTEGER;
    private readonly held: { base: number; payload: Uint8Array }[] = [];
    private next: number;

    constructor(private readonly inputSize: number) {
        this.next = inputSize;
    }

    /** Holds a packet's payload and returns the offset it reads at. */
    add(packet: OgmPacket): number {
        const base = packet.offset >= 0 ? packet.offset : this.next;
        if (packet.offset < 0) this.next += packet.payload.length;
        this.held.push({ base, payload: packet.payload });
        // A packed B-VOP or an audio frame carried over refers back one packet.
        if (this.held.length > 2) this.held.shift();
        return base;
    }

    async bytes(pos: number, len: number): Promise<Uint8Array> {
        for (const { base, payload } of this.held)
            if (pos >= base && pos + len <= base + payload.length)
                return payload.subarray(pos - base, pos - base + len);
        throw new DemuxError('OGM packet bytes are no longer held');
    }

    /**
     * The sample fields of `size` bytes at `offset`: a file range, or a copy of bytes past the
     * input.
     */
    async locate(
        offset: number,
        size: number,
        data?: Uint8Array,
    ): Promise<Pick<Sample, 'offset' | 'data'>> {
        if (data) return { offset: 0, data };
        return offset < this.inputSize
            ? { offset, data: undefined }
            : { offset: 0, data: (await this.bytes(offset, size)).slice() };
    }
}

/** Codec of an OGM stream, or a DemuxError that leaves the stream out. */
function ogmCodec(header: OgmHeader): string {
    if (header.kind === 'text') return 'text/utf8';
    if (header.kind === 'video') {
        const codec = vfwVideoCodec(header.fourcc);
        if (!codec) throw new DemuxError(`OGM video FourCC '${header.fourcc}' is not supported`);
        return codec;
    }
    const codec = compressedWaveCodec(header.formatTag);
    if (codec !== 'mp2' && codec !== 'mp3' && codec !== 'ac-3' && codec !== 'ec-3')
        throw new DemuxError(
            `OGM audio format 0x${header.formatTag.toString(16).padStart(4, '0')} is not supported`,
        );
    return codec;
}

/**
 * Indexes an OGM logical stream (Ogg with DirectShow stream headers): VfW video, MPEG and Dolby
 * audio, and text. A page's granule is the start of the last packet it completes; video keeps one
 * packet per decode slot with DivX packed B-VOPs unpacked, and audio is split into its codec
 * frames, which OGM packets cut at byte counts.
 */
export async function indexOgmStream(
    context: AudioIndexContext,
    serial: number,
): Promise<OggExtraTrack> {
    const state = { recovered: false };
    const samples: Sample[] = [];
    const pictureTypes: number[] = [];
    let header: OgmHeader | undefined;
    let codec = '';
    let bytes: PacketBytes | undefined;
    let video: AviMpegVideoReader | undefined;
    let audio: AviMpegAudioReader | undefined;
    let audioStart: number | undefined;
    let audioFrames = 0;
    let channels = 0;
    let sampleRate = 0;
    let next = 0;
    let eos = false;

    for await (const page of oggStreamPages(context, serial, state)) {
        eos = page.eos;
        const packets: OgmPacket[] = [];
        for (const packet of page.packets) {
            if (!header) {
                header = parseOgmHeader(packet.data);
                codec = ogmCodec(header);
                bytes = new PacketBytes(context.size);
                const damage = (message: string): void =>
                    context.diagnostics.recover({
                        code: 'OGM_PACKED_FRAME_LOST',
                        format: 'ogg',
                        message,
                    });
                if (header.kind === 'video' && mpegVideoFamily(codec))
                    video = new AviMpegVideoReader(codec, undefined, damage);
                if (header.kind === 'audio')
                    audio = new AviMpegAudioReader(
                        header.formatTag,
                        0,
                        codec === 'mp2' || codec === 'mp3' ? undefined : parseDolbyAudioFrame,
                    );
                continue;
            }

            if (packet.data[0]! & 1) {
                if (packet.data[0] === 3)
                    context.metadata.title ??= vorbisCommentTitle(packet.data.subarray(7));
                continue;
            }

            const parsed = ogmPacket(packet);
            if (parsed) packets.push(parsed);
            else {
                context.diagnostics.recover({
                    code: 'OGM_PACKET_DAMAGED',
                    format: 'ogg',
                    offset: page.offset,
                    message:
                        `Dropped an OGM packet shorter than its duration field at byte ` +
                        `${page.offset}`,
                });
                state.recovered = true;
            }
        }
        if (!packets.length || !header || !bytes) continue;

        const durations = packets.map(packet => packet.duration || header!.defaultDuration || 1);
        let start = next;
        if (page.granule !== null) {
            start = page.granule;
            for (let index = 0; index < packets.length - 1; index++) start -= durations[index]!;
        }

        let time = start;
        for (let index = 0; index < packets.length; index++) {
            const packet = packets[index]!;
            const duration = durations[index]!;
            const timestamp = time * header.unit;
            time += duration;
            const size = packet.payload.length;

            if (audio) {
                const base = bytes.add(packet);
                audioStart ??= timestamp;
                for (const frame of (await audio.push(bytes, base, size)).frames) {
                    context.budget.reserveSamples(1, 256, 'OGM sample index');
                    const rate = frame.header.sampleRate;
                    if (!sampleRate) {
                        sampleRate = rate;
                        channels = frame.header.channels;
                        codec = frame.header.format;
                    }
                    samples.push({
                        ...(await bytes.locate(frame.offset, frame.size, frame.data)),
                        size: frame.size,
                        timestamp: audioStart + audioFrames / rate,
                        duration: frame.header.samplesPerFrame / rate,
                        isKeyframe: true,
                    });
                    audioFrames += frame.header.samplesPerFrame;
                }
                continue;
            }

            if (!size) {
                // A packet without payload stands for dropped frames: the previous picture lasts
                // over them.
                const previous = samples[samples.length - 1];
                if (previous)
                    previous.duration = timestamp + duration * header.unit - previous.timestamp;
                continue;
            }

            context.budget.reserveSamples(1, 256, 'OGM sample index');
            if (video) {
                const picture = await video.inspect(bytes, bytes.add(packet), size);
                pictureTypes.push(picture.type);
                samples.push({
                    ...(await bytes.locate(picture.offset, picture.size, picture.data)),
                    size: picture.size,
                    timestamp,
                    decodeTimestamp: timestamp,
                    duration: duration * header.unit,
                    isKeyframe: picture.keyframe,
                });
                continue;
            }
            samples.push({
                offset: Math.max(0, packet.offset),
                data: packet.offset < 0 ? packet.payload : undefined,
                size,
                timestamp,
                duration: duration * header.unit,
                isKeyframe: header.kind === 'text' || packet.keyframe,
            });
        }

        next = time;
    }

    if (!header) throw new DemuxError('OGM stream lacks its stream header');
    if (!samples.length) throw new DemuxError('OGM stream holds no packets');
    if (video) presentMpegPictures(samples, pictureTypes, header.unit);
    if (!eos) {
        context.diagnostics.recover({
            code: 'OGG_MISSING_EOS',
            format: 'ogg',
            message: 'OGM stream ends without an EOS page; the complete packets are retained',
        });
        state.recovered = true;
    }

    let end = 0;
    for (const sample of samples) end = Math.max(end, sample.timestamp + sample.duration);

    const track: TrackInfo = {
        id: 0,
        codec: video?.codec ?? codec,
        codecConfig: video?.codecConfig,
        ...(header.kind === 'video' &&
        (mpegVideoFamily(codec) === 'mpeg4v' || codec.startsWith('msmpeg4'))
            ? { codecTag: header.fourcc }
            : {}),
        width: header.width || (video?.format?.width ?? 0),
        height: header.height || (video?.format?.height ?? 0),
        sampleRate,
        channelCount: channels,
        duration: end,
        samples,
        ...(state.recovered ? { incomplete: true } : {}),
    };
    return { kind: header.kind === 'text' ? 'subtitle' : header.kind, track };
}

/**
 * Indexes an Ogg VP8 logical stream: a 26-byte stream header, an optional comment header, then one
 * frame per packet. The upper 32 bits of a page granule count the frames up to the end of the page.
 */
export async function indexOggVp8(
    context: AudioIndexContext,
    serial: number,
): Promise<OggExtraTrack> {
    const state = { recovered: false };
    const samples: Sample[] = [];
    let info:
        | { width: number; height: number; fpsNum: number; fpsDen: number; aspect: number[] }
        | undefined;
    let pending: OggPacket[] = [];
    let next = 0;
    let eos = false;

    const flush = (end: number): void => {
        let index = Math.max(next, end - pending.length);
        for (const { offset, data } of pending) {
            context.budget.reserveSamples(1, 256, 'Ogg VP8 sample index');
            samples.push({
                offset: Math.max(0, offset),
                data: offset < 0 ? data : undefined,
                size: data.length,
                timestamp: (index * info!.fpsDen) / info!.fpsNum,
                duration: info!.fpsDen / info!.fpsNum,
                isKeyframe: (data[0]! & 1) === 0,
            });
            index++;
        }
        pending = [];
        next = index;
    };

    for await (const page of oggStreamPages(context, serial, state)) {
        eos = page.eos;
        for (const packet of page.packets) {
            const { data } = packet;
            if (!info) {
                if (ascii(data, 0, 6) !== 'OVP80\x01' || data.length < 26)
                    throw new DemuxError('Invalid Ogg VP8 stream header');
                const view = dataView(data);
                const u24 = (at: number): number =>
                    (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!;
                info = {
                    width: view.getUint16(8),
                    height: view.getUint16(10),
                    aspect: [u24(12), u24(15)],
                    fpsNum: view.getUint32(18),
                    fpsDen: view.getUint32(22),
                };
                if (!info.width || !info.height || !info.fpsNum || !info.fpsDen)
                    throw new DemuxError(
                        'Ogg VP8 stream header declares no picture size or frame rate',
                    );
                continue;
            }

            if (ascii(data, 0, 5) === 'OVP80') {
                if (data[5] === 2) context.metadata.title ??= vorbisCommentTitle(data.subarray(7));
                continue;
            }

            pending.push(packet);
        }
        if (page.granule !== null && pending.length) flush(Math.floor(page.granule / 2 ** 32));
    }

    if (!info) throw new DemuxError('Ogg VP8 stream lacks its stream header');
    if (pending.length) flush(next + pending.length);
    if (!samples.length) throw new DemuxError('Ogg VP8 stream holds no frames');
    if (!eos) {
        context.diagnostics.recover({
            code: 'OGG_MISSING_EOS',
            format: 'ogg',
            message: 'Ogg VP8 stream ends without an EOS page; the complete frames are retained',
        });
        state.recovered = true;
    }

    const last = samples[samples.length - 1]!;
    const [aspectNum, aspectDen] = info.aspect as [number, number];
    const track: TrackInfo = {
        id: 0,
        codec: 'vp8',
        width: info.width,
        height: info.height,
        ...(aspectNum > 0 && aspectDen > 0 && aspectNum !== aspectDen
            ? {
                  pixelAspectRatioNum: aspectNum,
                  pixelAspectRatioDen: aspectDen,
                  displayWidth: Math.round((info.width * aspectNum) / aspectDen),
                  displayHeight: info.height,
              }
            : {}),
        sampleRate: 0,
        channelCount: 0,
        duration: last.timestamp + last.duration,
        samples,
        timescale: info.fpsNum,
        ...(state.recovered ? { incomplete: true } : {}),
    };
    return { kind: 'video', track };
}
