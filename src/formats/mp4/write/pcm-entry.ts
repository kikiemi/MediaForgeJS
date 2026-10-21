import { isoBox, isoFullBox, latin1 } from '../../shared/iso-box';
import { MediaForgeError } from '../../../core/errors/errors';

/**
 * Uncompressed audio in MP4 and MOV, as ffmpeg writes it: one sample per PCM frame (constant sample
 * size, one duration unit at the sample rate) and a sample entry naming the storage. MOV uses
 * QuickTime's entries ('sowt', 'twos', 'raw ' as version 0; 'in24', 'in32', 'fl32', 'fl64' as
 * version 1 with a 'wave' atom stating the byte order; version-2 'lpcm' above 65535 Hz), MP4 those
 * of ISO/IEC 23003-5 ('ipcm' and 'fpcm' with a 'pcmC' box).
 */

/** The stored samples of a PCM track. */
export interface PcmShape {
    readonly bits: number;
    readonly float: boolean;
    readonly signed: boolean;
    readonly littleEndian: boolean;
    readonly channels: number;
    readonly sampleRate: number;
    /** Bytes of one frame (a sample of every channel). */
    readonly blockAlign: number;
}

/**
 * The stored samples of a PCM track from its codec id: 'pcm-' with u, s or f, the bits and the byte
 * order, or the historical 'pcm', which is 16-bit little-endian (copied with its WAVE description,
 * or encoded).
 */
export function pcmShape(track: {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channelCount: number;
}): PcmShape {
    const parts =
        track.codec === 'pcm'
            ? ['s', '16', 'le']
            : /^pcm-([usf])(8|16|24|32|64)(le|be)?$/.exec(track.codec)?.slice(1);
    const bits = Number(parts?.[1]);
    const float = parts?.[0] === 'f';
    const { channelCount: channels, sampleRate } = track;
    if (
        !parts ||
        (float ? bits < 32 : bits > 32 || (parts[0] === 'u' && bits !== 8)) ||
        (bits === 8) === (parts[2] !== undefined) ||
        !Number.isInteger(channels) ||
        channels < 1 ||
        channels > 0xffff ||
        !Number.isInteger(sampleRate) ||
        sampleRate < 1
    )
        throw new MediaForgeError(
            `MP4 cannot store PCM '${track.codec}' of ${channels} channels`,
            'FORMAT',
        );
    return {
        bits,
        float,
        signed: parts[0] !== 'u',
        littleEndian: parts[2] === 'le',
        channels,
        sampleRate,
        blockAlign: (channels * bits) / 8,
    };
}

/**
 * The audio sample entry fields shared by every version: reserved, data reference 1, version and
 * the rest.
 */
function soundFields(
    version: number,
    channels: number,
    bits: number,
    rate: number,
    extra = 0,
): Uint8Array {
    const fields = new Uint8Array(28 + extra);
    const view = new DataView(fields.buffer);
    view.setUint16(6, 1);
    view.setUint16(8, version);
    view.setUint16(16, channels);
    view.setUint16(18, bits);
    view.setUint32(24, rate);
    return fields;
}

/**
 * The QuickTime 'wave' atom of a version-1 entry: the format, its byte order ('enda') and the
 * terminator.
 */
function waveAtom(type: string, littleEndian: boolean): Uint8Array {
    const enda = new Uint8Array(2);
    enda[1] = littleEndian ? 1 : 0;
    return isoBox('wave', isoBox('frma', latin1(type)), isoBox('enda', enda), new Uint8Array(8));
}

/** A MOV sound description of `format`. */
export function quickTimePcmEntry(format: PcmShape): Uint8Array {
    const { bits, channels, sampleRate, blockAlign } = format;
    if (sampleRate > 0xffff) {
        // Sound description version 2: the rate as a double and the format as LPCM flags.
        const fields = soundFields(2, 3, 16, 0x00010000, 36);
        const view = new DataView(fields.buffer);
        view.setUint16(20, 0xfffe);
        view.setUint32(28, 72);
        view.setFloat64(32, sampleRate);
        view.setUint32(40, channels);
        view.setUint32(44, 0x7f000000);
        view.setUint32(48, bits);
        const flags =
            (format.float ? 1 : 0) |
            (format.littleEndian || bits === 8 ? 0 : 2) |
            (format.signed && !format.float ? 4 : 0) |
            8;

        view.setUint32(52, flags);
        view.setUint32(56, blockAlign);
        view.setUint32(60, 1);
        return isoBox('lpcm', fields);
    }

    if (bits <= 16 && !format.float) {
        // Version 0: 16-bit little-endian 'sowt', big-endian or signed 8-bit 'twos', unsigned 8-bit
        // 'raw '.
        const type = !format.signed ? 'raw ' : bits === 16 && format.littleEndian ? 'sowt' : 'twos';
        return isoBox(type, soundFields(0, channels, bits, sampleRate * 0x10000));
    }

    const type = format.float ? `fl${bits}` : `in${bits}`;
    const fields = soundFields(1, channels, 16, sampleRate * 0x10000, 16);
    const view = new DataView(fields.buffer);
    view.setUint32(28, 1);
    view.setUint32(32, bits / 8);
    view.setUint32(36, blockAlign);
    view.setUint32(40, 2);
    return isoBox(type, fields, waveAtom(type, format.littleEndian));
}

/**
 * An MP4 sample entry of `format` (ISO/IEC 23003-5), with a channel layout box for mono and stereo.
 */
export function isoPcmEntry(format: PcmShape): Uint8Array {
    const { bits, channels, sampleRate } = format;
    if (bits === 8)
        throw new MediaForgeError(
            'MP4 stores 16-, 24- and 32-bit integer PCM and float PCM, not 8-bit',
            'FORMAT',
        );
    const children: Uint8Array[] = [];
    if (channels <= 2) {
        // ChannelLayout: channel-structured, the defined layout of one or two channels, none
        // omitted.
        const layout = new Uint8Array(10);
        layout[0] = 1;
        layout[1] = channels;
        children.push(isoFullBox('chnl', 0, 0, layout));
    }

    children.push(isoFullBox('pcmC', 0, 0, Uint8Array.of(format.littleEndian ? 1 : 0, bits)));

    // Rates above 65535 Hz leave the 16.16 field zero; the media timescale states them, as ffmpeg
    // writes them.
    const rate = sampleRate > 0xffff ? 0 : sampleRate * 0x10000;
    return isoBox(
        format.float ? 'fpcm' : 'ipcm',
        soundFields(0, channels, bits, rate),
        ...children,
    );
}
