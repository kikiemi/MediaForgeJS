import type { TrackInfo } from '../../core/model/track';
import { sampleAt, sampleCount } from '../../core/model/sample-index';
import type { AudioOutputMuxer } from '../../core/contracts/writer';
import type { Sink } from '../../core/model/types';
import { MediaForgeError } from '../../core/errors/errors';
import { alacCookie } from '../../core/codec-config/audio/alac-packet';
import { outputByteLength } from '../../core/bytes/output-data';
import { RawMuxer } from './raw-writer';

function invalid(message: string): never {
    throw new MediaForgeError(message, 'FORMAT');
}

function tag(bytes: Uint8Array, at: number, value: string): void {
    for (let index = 0; index < 4; index++) bytes[at + index] = value.charCodeAt(index);
}

/**
 * CAF variable-length integer: seven bits per byte, most significant first, high bit set on all but
 * the last.
 */
function berLength(value: number): number {
    let bytes = 1;
    while (value >= 128 ** bytes) bytes++;
    return bytes;
}

/**
 * Copies ALAC packets into CAF: desc ('alac', source bit depth flag, frames per packet), the
 * 24-byte cookie in kuki, a pakt table of every packet size with the priming and remainder frames,
 * then the packets in one data chunk.
 */
export function createCafAlacCopyMuxer(track: TrackInfo, sink: Sink): AudioOutputMuxer {
    const cookie = track.codecConfig && alacCookie(track.codecConfig);
    if (!cookie) return invalid('CAF ALAC output requires the 24-byte magic cookie');
    const frameLength = new DataView(cookie.buffer, cookie.byteOffset).getUint32(0);
    const bitDepth = cookie[5]!;
    const rate = track.sampleRate;
    const count = sampleCount(track);
    if (!count) return invalid('CAF ALAC output requires packets');

    let dataBytes = 0;
    let tableBytes = 0;
    let frames = 0;
    for (let index = 0; index < count; index++) {
        const sample = sampleAt(track, index)!;
        if (!Number.isSafeInteger(sample.size) || sample.size < 1)
            return invalid('ALAC packets must be nonempty');
        dataBytes += sample.size;
        tableBytes += berLength(sample.size);
        frames += Math.round(sample.duration * rate);
    }

    const priming =
        Math.round((track.editMediaTimeSeconds ?? 0) * rate) || (track.audioPrimingSamples ?? 0);
    let valid = frames - priming - (track.audioTrailingPaddingSamples ?? 0);
    if (track.editPresentationDurationSeconds !== undefined)
        valid = Math.min(valid, Math.round(track.editPresentationDurationSeconds * rate));
    const remainder = count * frameLength - priming - valid;
    if (valid < 1 || priming < 0 || remainder < 0 || remainder > 0x7fffffff || priming > 0x7fffffff)
        return invalid('ALAC trim metadata exceeds the coded packets');

    const header = new Uint8Array(8 + 44 + 36 + 36 + tableBytes + 16);
    const view = new DataView(header.buffer);
    tag(header, 0, 'caff');
    view.setUint16(4, 1);
    tag(header, 8, 'desc');
    view.setBigInt64(12, 32n);
    view.setFloat64(20, rate);
    tag(header, 28, 'alac');
    view.setUint32(32, bitDepth === 16 ? 1 : bitDepth === 20 ? 2 : bitDepth === 24 ? 3 : 4);
    view.setUint32(40, frameLength);
    view.setUint32(44, track.channelCount);
    tag(header, 52, 'kuki');
    view.setBigInt64(56, 24n);
    header.set(cookie, 64);
    tag(header, 88, 'pakt');
    view.setBigInt64(92, BigInt(24 + tableBytes));
    view.setBigInt64(100, BigInt(count));
    view.setBigInt64(108, BigInt(valid));
    view.setInt32(116, priming);
    view.setInt32(120, remainder);

    let at = 124;
    for (let index = 0; index < count; index++) {
        const size = sampleAt(track, index)!.size;
        for (let shift = berLength(size) - 1; shift >= 0; shift--)
            header[at++] = (Math.floor(size / 128 ** shift) & 0x7f) | (shift ? 0x80 : 0);
    }

    tag(header, at, 'data');
    view.setBigInt64(at + 4, BigInt(dataBytes) + 4n);

    const writer = new RawMuxer(sink);
    let remaining = dataBytes;
    let started = false;
    return {
        addAudioChunk(chunk) {
            const size = outputByteLength(chunk.data);
            if (size > remaining) invalid('ALAC packets exceed the indexed sizes');
            if (!started) {
                started = true;
                writer.addAudioChunk({ ...chunk, data: header });
            }
            writer.addAudioChunk(chunk);
            remaining -= size;
        },
        async finalize() {
            if (remaining !== 0 || !started) invalid('CAF ALAC output is missing indexed packets');
            await writer.finalize();
        },
    };
}
