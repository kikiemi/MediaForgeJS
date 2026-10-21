import { isoBox, isoFullBox, uint32 } from '../shared/iso-box';
import { leb128Bytes } from '../../core/codec-config/video/av1-config';
import { readFlacStreamInfo, STREAMINFO_BYTES } from '../../core/codec-config/audio/flac-frame';

/**
 * Box writing of the ISO base media file format shared by every MP4 writer: the MP4 muxer (standard
 * and fragmented) and the fragmented MP4 (CMAF) writer of copies and packages. MP4 metadata, WebVTT
 * samples and the colour boxes of visual sample entries write theirs with the primitives of iso-box
 * alone, so the readers load none of these. The writers validate what they accept; these only lay
 * out bytes.
 */

/**
 * An MPEG-4 systems descriptor (ISO/IEC 14496-1 8.3.3): its tag, then its size as few 7-bit groups
 * as it needs, or always four with `fourByteSize` (as the MP4 muxer writes them).
 */
function mpegDescriptor(
    tag: number,
    fourByteSize: boolean,
    ...payloads: readonly Uint8Array[]
): Uint8Array {
    const size = payloads.reduce((total, payload) => total + payload.length, 0);
    const groups = [size & 0x7f];
    for (let rest = size >>> 7; rest || (fourByteSize && groups.length < 4); rest >>>= 7)
        groups.unshift((rest & 0x7f) | 0x80);
    const out = new Uint8Array(1 + groups.length + size);
    out[0] = tag;
    out.set(groups, 1);
    let at = 1 + groups.length;
    for (const payload of payloads) {
        out.set(payload, at);
        at += payload.length;
    }
    return out;
}

/**
 * esds: an ES_Descriptor whose DecoderConfigDescriptor states `objectType`, `streamType` (4 visual,
 * 5 audio), its maximum and average `bitrate`, and the decoder-specific `info` when there is any.
 */
export function esdsBox(
    objectType: number,
    streamType: number,
    bitrate: number,
    info: Uint8Array | undefined,
    fourByteSize: boolean,
): Uint8Array<ArrayBuffer> {
    const config = Uint8Array.of(
        objectType,
        (streamType << 2) | 1,
        0,
        0,
        0,
        ...uint32(bitrate),
        ...uint32(bitrate),
    );

    const decoder = info?.length
        ? mpegDescriptor(4, fourByteSize, config, mpegDescriptor(5, fourByteSize, info))
        : mpegDescriptor(4, fourByteSize, config);
    const layer = mpegDescriptor(6, fourByteSize, Uint8Array.of(2));
    return isoFullBox(
        'esds',
        0,
        0,
        mpegDescriptor(3, fourByteSize, Uint8Array.of(0, 1, 0), decoder, layer),
    );
}

/**
 * A visual sample entry of `type`: data reference 1, the coded size, 72 dpi, one frame per sample,
 * an empty compressor name and 24-bit depth, followed by its child boxes.
 */
export function visualSampleEntry(
    type: string,
    width: number,
    height: number,
    children: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
    const fields = new Uint8Array(78);
    const view = new DataView(fields.buffer);
    view.setUint16(6, 1);
    view.setUint16(24, width);
    view.setUint16(26, height);
    view.setUint32(28, 0x00480000);
    view.setUint32(32, 0x00480000);
    view.setUint16(40, 1);
    view.setUint16(74, 0x0018);
    view.setUint16(76, 0xffff);
    return isoBox(type, fields, ...children);
}

/**
 * An audio sample entry of `type`: data reference 1, the channel count, sample size and `rate`
 * (normally the sample rate in 16.16 fixed point) fields, followed by its child boxes.
 */
export function audioSampleEntry(
    type: string,
    channels: number,
    sampleSize: number,
    rate: number,
    children: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
    const fields = new Uint8Array(28);
    const view = new DataView(fields.buffer);
    view.setUint16(6, 1);
    view.setUint16(16, channels);
    view.setUint16(18, sampleSize);
    view.setUint32(24, rate);
    return isoBox(type, fields, ...children);
}

/**
 * The 'fLaC' sample entry of a 34-byte STREAMINFO `record` (xiph's FLAC in ISOBMFF, 3.3.1): the
 * record's channel count, sample size and sample rate, and a 'dfLa' box holding the record as the
 * last metadata block. A rate above 65535 Hz is stated as its greatest expressible regular division
 * (48000 for 96 and 192 kHz), or 65535 where it has none; readers take the rate from the record.
 */
export function flacSampleEntry(record: Uint8Array): Uint8Array<ArrayBuffer> {
    const { sampleRate, channels, bitsPerSample } = readFlacStreamInfo(record);
    let stated = sampleRate;
    while (stated > 0xffff && stated % 2 === 0) stated /= 2;
    return audioSampleEntry('fLaC', channels, bitsPerSample, Math.min(stated, 0xffff) * 0x10000, [
        isoFullBox('dfLa', 0, 0, Uint8Array.of(0x80, 0, 0, STREAMINFO_BYTES), record),
    ]);
}

/** The IAMF configuration box: version 1 and the descriptor OBUs after their leb128 size. */
export function iacbBox(descriptors: Uint8Array): Uint8Array<ArrayBuffer> {
    return isoBox('iacb', Uint8Array.of(1), leb128Bytes(descriptors.length), descriptors);
}

/**
 * Writes at `offset` the display matrix of a counter-clockwise `rotation` (a multiple of 90
 * degrees) of a picture `width` x `height` in 16.16 fixed point, which the rotation moves back into
 * view.
 */
function writeDisplayMatrix(
    view: DataView,
    offset: number,
    rotation = 0,
    width = 0,
    height = 0,
): void {
    const one = 0x00010000;
    const turn = ((rotation % 360) + 360) % 360;
    const cells =
        turn === 90
            ? [0, -one, 0, one, 0, 0, 0, width, 0x40000000]
            : turn === 180
              ? [-one, 0, 0, 0, -one, 0, width, height, 0x40000000]
              : turn === 270
                ? [0, one, 0, -one, 0, 0, height, 0, 0x40000000]
                : [one, 0, 0, 0, one, 0, 0, 0, 0x40000000];
    for (let index = 0; index < 9; index++) view.setInt32(offset + index * 4, cells[index]!);
}

/**
 * The movie header: version 1 when the duration needs 64 bits; rate 1, full volume and the identity
 * matrix.
 */
export function mvhdBox(
    timescale: number,
    duration: number,
    nextTrackId: number,
): Uint8Array<ArrayBuffer> {
    const wide = duration >= 0xffffffff;
    const fields = new Uint8Array(wide ? 108 : 96);
    const view = new DataView(fields.buffer);
    const at = wide ? 12 : 0;
    view.setUint32(wide ? 16 : 8, timescale);
    if (wide) view.setBigUint64(20, BigInt(Math.round(duration)));
    else view.setUint32(12, duration);
    view.setUint32(at + 16, 0x00010000);
    view.setUint16(at + 20, 0x0100);
    writeDisplayMatrix(view, at + 32);
    view.setUint32(at + 92, nextTrackId);
    return isoFullBox('mvhd', wide ? 1 : 0, 0, fields);
}

/**
 * A track header: version 1 when the duration needs 64 bits, full volume for `audio`, and the
 * display matrix and size (`width` x `height` in 16.16 fixed point) of a picture rotated
 * counter-clockwise by `rotation`.
 */
export function tkhdBox(
    id: number,
    flags: number,
    duration: number,
    audio: boolean,
    rotation: number,
    width: number,
    height: number,
): Uint8Array<ArrayBuffer> {
    const wide = duration >= 0xffffffff;
    const fields = new Uint8Array(wide ? 92 : 80);
    const view = new DataView(fields.buffer);
    const at = wide ? 12 : 0;
    view.setUint32(wide ? 16 : 8, id);
    if (wide) view.setBigUint64(24, BigInt(Math.round(duration)));
    else view.setUint32(16, duration);
    if (audio) view.setUint16(at + 32, 0x0100);
    writeDisplayMatrix(view, at + 36, rotation, width, height);
    view.setUint32(at + 72, width);
    view.setUint32(at + 76, height);
    return isoFullBox('tkhd', wide ? 1 : 0, flags, fields);
}

/** A media header with its ISO 639-2 `language` code: version 1 when the duration needs 64 bits. */
export function mdhdBox(
    timescale: number,
    duration: number,
    language: string,
): Uint8Array<ArrayBuffer> {
    const wide = duration >= 0xffffffff;
    const fields = new Uint8Array(wide ? 32 : 20);
    const view = new DataView(fields.buffer);
    const at = wide ? 12 : 0;
    view.setUint32(wide ? 16 : 8, timescale);
    if (wide) view.setBigUint64(20, BigInt(Math.round(duration)));
    else view.setUint32(12, duration);
    const code = (index: number): number => language.charCodeAt(index) - 0x60;
    view.setUint16(at + 16, (code(0) << 10) | (code(1) << 5) | code(2));
    return isoFullBox('mdhd', wide ? 1 : 0, 0, fields);
}

/**
 * An edit list in an edts box: each entry's presentation `duration` and `mediaTime` (-1 for an
 * empty edit) at rate 1; version 1 when asked for or when a value needs 64 bits.
 */
export function editListBox(
    edits: readonly { readonly duration: number; readonly mediaTime: number }[],
    version = 0,
): Uint8Array<ArrayBuffer> {
    const wide =
        version === 1 ||
        edits.some(edit => edit.duration > 0xffffffff || edit.mediaTime > 0x7fffffff);
    const size = wide ? 20 : 12;
    const fields = new Uint8Array(4 + edits.length * size);
    const view = new DataView(fields.buffer);
    view.setUint32(0, edits.length);
    edits.forEach((edit, index) => {
        const at = 4 + index * size;
        if (wide) {
            view.setBigUint64(at, BigInt(Math.round(edit.duration)));
            view.setBigInt64(at + 8, BigInt(Math.round(edit.mediaTime)));
        } else {
            view.setUint32(at, edit.duration);
            view.setInt32(at + 4, edit.mediaTime);
        }
        view.setUint32(at + size - 4, 0x00010000);
    });
    return isoBox('edts', isoFullBox('elst', wide ? 1 : 0, 0, fields));
}

/** A sample description box of `entries`. */
export function stsdBox(entries: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    return isoFullBox('stsd', 0, 0, uint32(entries.length), ...entries);
}

/** A pixel aspect ratio box. */
export function paspBox(horizontal: number, vertical: number): Uint8Array<ArrayBuffer> {
    return isoBox('pasp', uint32(horizontal), uint32(vertical));
}

/** The media information header of a track type: vmhd (graphics mode copy), smhd or nmhd. */
export function mediaHeaderBox(type: 'video' | 'audio' | 'subtitle'): Uint8Array<ArrayBuffer> {
    return type === 'video'
        ? isoFullBox('vmhd', 0, 1, new Uint8Array(8))
        : type === 'audio'
          ? isoFullBox('smhd', 0, 0, new Uint8Array(4))
          : isoFullBox('nmhd', 0, 0);
}

/** Data information: one self-contained 'url ' reference. */
export function dinfBox(): Uint8Array<ArrayBuffer> {
    return isoBox('dinf', isoFullBox('dref', 0, 0, uint32(1), isoFullBox('url ', 0, 1)));
}

/** The sample table of a fragmented track: its sample description and empty sample tables. */
export function fragmentedSampleTable(stsd: Uint8Array): Uint8Array<ArrayBuffer> {
    return isoBox(
        'stbl',
        stsd,
        isoFullBox('stts', 0, 0, uint32(0)),
        isoFullBox('stsc', 0, 0, uint32(0)),
        isoFullBox('stsz', 0, 0, uint32(0), uint32(0)),
        isoFullBox('stco', 0, 0, uint32(0)),
    );
}

/** Track extends defaults: sample description 1, no default duration, size or flags. */
export function trexBox(id: number): Uint8Array<ArrayBuffer> {
    return isoFullBox('trex', 0, 0, uint32(id), uint32(1), uint32(0), uint32(0), uint32(0));
}
