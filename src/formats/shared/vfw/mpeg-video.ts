import type { ByteReader } from '../../../core/io/sources/chunk-reader';
import type { Sample } from '../../../core/model/track';
import { completeMpegFrameTimes, type MpegFrameTiming } from '../mpeg-video-stream';
import { mpegVideoFamily } from '../../../core/model/codec-strings';
import {
    PICTURE_P,
    inspectMpegPicture,
    mpegVideoConfig,
    parseMpegVideoConfig,
    scanMpeg4Packet,
    type MpegVideoFormat,
    type MpegVideoSyntax,
} from '../../../core/codec-config/video/mpeg-video';

/** ffmpeg's size bound for the not-coded placeholder VOP that follows a packed chunk. */
const MAX_NVOP_BYTES = 19;

/** Bytes read to find the first MPEG-1/2 picture header of a chunk. */
const HEADER_SCAN_BYTES = 1 << 16;

export interface AviMpegPicture {
    /**
     * Source range of the coded picture; `data` replaces it when a DivX packed marker was cleared.
     */
    readonly offset: number;
    readonly size: number;
    readonly type: number;
    readonly keyframe: boolean;
    readonly data?: Uint8Array;
}

/**
 * Copy with the DivX user data 'p' (packed) marker replaced by NUL, as mpeg4_unpack_bframes does.
 */
function clearPackedMarker(data: Uint8Array, marker: number): Uint8Array {
    const copy = data.slice();
    copy[marker] = 0;
    return copy;
}

/**
 * Reads MPEG-1/2 and MPEG-4 Part 2 AVI chunks: one coded picture per chunk slot in decode order.
 * DivX packed bitstreams (an anchor VOP followed by a B-VOP in one chunk, then a small not-coded
 * placeholder) are unpacked like ffmpeg's mpeg4_unpack_bframes, so the B-VOP takes the following
 * slot and the placeholder is dropped.
 */
export class AviMpegVideoReader {
    codec: string;
    codecConfig: Uint8Array | undefined;
    format: MpegVideoFormat | undefined;
    private readonly syntax: MpegVideoSyntax;
    private stored: AviMpegPicture | undefined;

    constructor(
        codec: string,
        extradata: Uint8Array | undefined,
        private readonly onDamage: (message: string) => void,
    ) {
        this.codec = codec;
        this.syntax = mpegVideoFamily(codec) === 'mpeg4v' ? 'mpeg4' : 'mpeg12';
        if (extradata?.length) this.configure(extradata, true);
    }

    private configure(data: Uint8Array, extradata: boolean): void {
        let config = extradata ? data.slice() : mpegVideoConfig(this.syntax, data);
        if (!config) return;
        if (this.syntax === 'mpeg4') {
            const marker = scanMpeg4Packet(config).packedMarker;
            if (marker >= 0) config = clearPackedMarker(config, marker);
        }
        const format = parseMpegVideoConfig(this.syntax, config);
        if (!format) return;
        this.codecConfig = config;
        this.codec = format.codec;
        this.format = format;
    }

    /**
     * The picture presented in this chunk's slot; placeholders swapped out for a stored B-VOP are
     * not read again.
     */
    async inspect(reader: ByteReader, offset: number, size: number): Promise<AviMpegPicture> {
        if (this.syntax === 'mpeg12') {
            let data = await reader.bytes(offset, Math.min(size, HEADER_SCAN_BYTES));
            let picture = inspectMpegPicture('mpeg12', data);
            if (!picture && size > data.length) {
                data = await reader.bytes(offset, size);
                picture = inspectMpegPicture('mpeg12', data);
            }
            if (!this.codecConfig) this.configure(data, false);
            return {
                offset,
                size,
                type: picture?.type ?? PICTURE_P,
                keyframe: picture?.keyframe ?? false,
            };
        }

        const data = await reader.bytes(offset, size);
        if (!this.codecConfig) this.configure(data, false);
        const scan = scanMpeg4Packet(data);
        const first = inspectMpegPicture('mpeg4', data);

        if (scan.second >= 0) {
            if (this.stored)
                this.onDamage('A packed B-VOP has no placeholder slot left; it was discarded');
            const packed = inspectMpegPicture('mpeg4', data.subarray(scan.second));
            this.stored = {
                offset: offset + scan.second,
                size: size - scan.second,
                type: packed?.type ?? PICTURE_P,
                keyframe: packed?.keyframe ?? false,
            };
            return {
                offset,
                size: scan.second,
                type: first?.type ?? PICTURE_P,
                keyframe: first?.keyframe ?? false,
            };
        }

        const stored = this.stored;
        if (scan.vops === 1 && stored) {
            this.stored =
                size > MAX_NVOP_BYTES
                    ? { offset, size, type: first!.type, keyframe: first!.keyframe }
                    : undefined;
            return stored;
        }

        return {
            offset,
            size,
            type: first?.type ?? PICTURE_P,
            keyframe: first?.keyframe ?? false,
            data: scan.packedMarker >= 0 ? clearPackedMarker(data, scan.packedMarker) : undefined,
        };
    }
}

/**
 * AVI and OGM store decode order in fixed slots; presentation times follow the MPEG picture
 * reordering model.
 */
export function presentMpegPictures(
    samples: Sample[],
    types: readonly number[],
    tick: number,
): void {
    const frames: MpegFrameTiming[] = samples.map((sample, index) => ({
        type: types[index]!,
        fields: 2,
        dts: sample.decodeTimestamp,
    }));
    completeMpegFrameTimes(frames, tick);
    // Presentation follows the reordering model from the first decode slot, one picture behind
    // decode order when B-pictures are present, as ffmpeg and AVI players present it against the
    // audio.
    samples.forEach((sample, index) => {
        sample.timestamp = frames[index]!.pts!;
        sample.compositionTimeOffset = sample.timestamp - sample.decodeTimestamp!;
    });
}
