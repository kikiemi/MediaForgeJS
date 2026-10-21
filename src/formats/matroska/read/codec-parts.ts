import { DV_VIDEO, isDvFourcc } from '../../../core/codec-config/video/dv-video';
import { DemuxError, throwIfAborted } from '../../../core/errors/errors';
import { demuxAssert } from '../../../core/errors/demux-guard';
import type { Sample } from '../../../core/model/track';
import type { ByteReader } from '../../../core/io/sources/chunk-reader';
import { mpegVideoFamily } from '../../../core/model/codec-strings';
import { compressedWaveCodec, waveFormatTag } from '../../../core/codec-config/audio/wave-format';
import {
    isWindowsMediaVideo,
    normalizedWaveFormatEx,
    parseWaveFormatEx,
    windowsMediaAudioCodec,
    windowsMediaVideoCodec,
} from '../../../core/codec-config/windows-media';
import { windowsMediaPictureType } from '../../shared/windows-media-order';
import {
    PICTURE_B,
    PICTURE_P,
    isVfwAvcFourcc,
    parseMpegVideoConfig,
    scanMpeg4Packet,
    vfwVideoCodec,
} from '../../../core/codec-config/video/mpeg-video';
import type { AviAvcReader } from '../../shared/vfw/avc';
import type { AvcPictureOrder } from '../../shared/vfw/avc-picture-order';
import { matroskaAcmCodec } from '../pcm';
import { MatroskaSampleIndexBuilder } from './sample-index';
import type { WebMTrack } from './track-entry';
import { readsPastDamage, recoverDamage, type MatroskaReadContext } from './read-context';
import { dataView } from '../../../core/bytes/byte-fields';

/** A frame restored in memory, read like the source. */
const mpegVideo = () => import('../../shared/vfw/mpeg-video');

function memoryReader(data: Uint8Array): ByteReader {
    return {
        size: data.length,
        bytes: async (pos, len) => data.subarray(pos, Math.min(data.length, pos + len)),
    };
}

/**
 * V_MS/VFW/FOURCC stores a BITMAPINFOHEADER whose bytes after the first 40 are the codec extradata.
 */
export function readVfwTrack(t: WebMTrack): void {
    const header = t.codecConfig;
    demuxAssert(
        t.type === 1 && header && header.length >= 40,
        'Matroska VFW track requires a BITMAPINFOHEADER',
    );
    const fourcc = String.fromCharCode(...header.subarray(16, 20));
    const avc = isVfwAvcFourcc(fourcc);
    const codec = avc
        ? 'avc1.640028'
        : (windowsMediaVideoCodec(fourcc) ??
          vfwVideoCodec(fourcc) ??
          (isDvFourcc(fourcc) ? DV_VIDEO : undefined));

    if (!codec) throw new DemuxError(`Unsupported Matroska VFW video FourCC '${fourcc}'`);
    const view = dataView(header);
    t.width ||= Math.abs(view.getInt32(4, true));
    t.height ||= Math.abs(view.getInt32(8, true));
    t.codecConfig = header.length > 40 ? header.slice(40) : undefined;
    if (avc) {
        // The extradata, when present, is avcC or Annex B parameter sets; otherwise they arrive in
        // the frames.
        t.vfwAvc = { extradata: t.codecConfig };
        t.codecConfig = undefined;
        t.codec = codec;
        return;
    }

    if (codec.startsWith('msmpeg4')) t.codecTag = fourcc;
    const mpeg = mpegVideoFamily(codec);
    if (mpeg === 'mpeg4v' || isWindowsMediaVideo(codec)) t.codecTag = fourcc;
    if (codec === 'vc1' || codec === 'wmv3') t.vfwWindowsMedia = true;
    t.codec =
        (mpeg &&
            t.codecConfig &&
            parseMpegVideoConfig(mpeg === 'mpeg4v' ? 'mpeg4' : 'mpeg12', t.codecConfig)?.codec) ||
        codec;
}

/**
 * A_MS/ACM stores a WAVEFORMATEX; its format tag names G.711, MPEG audio or a Windows Media Audio
 * codec.
 */
export function readAcmTrack(t: WebMTrack): void {
    const g711 = matroskaAcmCodec('A_MS/ACM', t.codecConfig);
    const wave = t.codecConfig && parseWaveFormatEx(t.codecConfig);
    const windowsMedia = wave && windowsMediaAudioCodec(wave.tag);
    if (g711) t.codec = g711;
    else if (wave && windowsMedia) {
        t.codec = windowsMedia;
        t.codecConfig = normalizedWaveFormatEx(t.codecConfig!);
        if (wave.sampleRate > 0) t.sampleRate = wave.sampleRate;
        if (wave.channels > 0) t.channelCount = wave.channels;
    } else if (wave && (wave.tag === 0x55 || wave.tag === 0x50)) {
        t.codec = wave.tag === 0x55 ? 'mp3' : 'mp2';
        t.codecConfig = undefined;
    } else {
        // AC-3, E-AC-3 (IEC 61937 extensible GUID) and DTS frames; raw AAC has no configuration to
        // decode it.
        const tag = t.codecConfig && t.codecConfig.length >= 16 ? waveFormatTag(t.codecConfig) : 0;
        t.codec = (tag !== 0x00ff && compressedWaveCodec(tag)) || '';
        t.codecConfig = undefined;
    }
}

/**
 * MPEG audio blocks cut at byte counts, as some muxers wrote them from AVI: the frames are
 * reassembled across blocks, as FFmpeg's parser does, and timed on from the first block by their
 * sample counts.
 */
export async function reframeMpegAudio(context: MatroskaReadContext, t: WebMTrack): Promise<void> {
    const blocks = t.index;
    if (!blocks.length) return;
    const { AviMpegAudioReader } = await import('../../shared/vfw/mpeg-audio');
    const reader = new AviMpegAudioReader(0, t.sampleRate);
    const frames = new MatroskaSampleIndexBuilder(context.reader.size > 0xffffffff, bytes =>
        context.reserveIndexBytes(bytes),
    );
    const start = blocks.sampleAt(0).timestamp;
    let samples = 0;
    let rate = 0;
    let skipped = 0;
    for (let index = 0; index < blocks.length; index++) {
        if ((index & 0x3ff) === 0) throwIfAborted(context.signal);
        const block = blocks.sampleAt(index);
        const chunk = await reader.push(context.reader, block.offset, block.size);
        skipped += chunk.skipped;
        for (const frame of chunk.frames) {
            rate ||= frame.header.sampleRate;
            const duration = frame.header.samplesPerFrame / rate;
            frames.append(
                frame.offset,
                frame.size,
                start + samples / rate,
                duration,
                true,
                false,
                0,
                0,
                frame.data,
            );
            samples += frame.header.samplesPerFrame;
        }
    }

    if (skipped || reader.pending)
        context.diagnostics?.warn({
            code: 'MATROSKA_AUDIO_RESYNCHRONIZED',
            format: 'matroska',
            message:
                `Skipped ${skipped + reader.pending} bytes between or after MPEG audio frames ` +
                `of track ${t.number}`,
        });

    if (!frames.length) return;
    t.index = frames;
    if (rate) t.sampleRate = rate;
}

/**
 * VfW H.264 blocks carry decode times; presentation times follow the picture order of the slices,
 * as for AVI, and the configuration comes from the in-band parameter sets when the BITMAPINFOHEADER
 * has none.
 */
export async function presentVfwAvc(context: MatroskaReadContext, t: WebMTrack): Promise<void> {
    const [{ AviAvcReader }, { restoreAvcPresentation }] = await Promise.all([
        import('../../shared/vfw/avc'),
        import('../../shared/vfw/avc-picture-order'),
    ]);
    let reader: AviAvcReader | undefined;
    t.index.fillDurations();
    const samples: Sample[] = [];
    const pictures: { sample: Sample; order: AvcPictureOrder }[] = [];
    const checkAbort = (): void => {
        throwIfAborted(context.signal);
    };
    try {
        reader = new AviAvcReader(t.vfwAvc!.extradata);
        for (let index = 0; index < t.index.length; index++) {
            const sample = t.index.sampleAt(index);
            const inspection = await reader.inspect(
                sample.data ? memoryReader(sample.data) : context.reader,
                sample.data ? 0 : sample.offset,
                sample.size,
                checkAbort,
            );

            sample.decodeTimestamp = sample.timestamp;
            sample.nalUnitFormat = inspection.annexB ? 'annexb' : 'avcc';
            if (inspection.pictureOrder) pictures.push({ sample, order: inspection.pictureOrder });
            samples.push(sample);
        }

        // Compatible validation shows pictures repeating a picture order (a block repeated by
        // damage) in turn.
        let duplicateWarned = false;
        await restoreAvcPresentation(
            samples,
            pictures,
            checkAbort,
            readsPastDamage(context.diagnostics)
                ? () => {
                      if (duplicateWarned) return;
                      duplicateWarned = true;
                      recoverDamage(
                          context.diagnostics,
                          'MATROSKA_DUPLICATE_PICTURE',
                          `H.264 track ${t.number} repeats a picture order; shown in turn`,
                          0,
                      );
                  }
                : undefined,
        );
    } catch (error) {
        if (!(error instanceof DemuxError)) throw error;
        recoverDamage(
            context.diagnostics,
            'MATROSKA_VFW_TIMING',
            `H.264 track ${t.number} is shown in decode order`,
            0,
            error.message,
        );
        t.codecConfig = reader?.codecConfig;
        t.codec = reader?.codec ?? t.codec;
        return;
    }

    t.index.presentFromDecodeOrder(samples);
    t.codecConfig = reader.codecConfig;
    t.codec = reader.codec ?? t.codec;
}

/**
 * VfW WMV9 and VC-1 blocks carry decode times, as AVI chunks do: with B-pictures, presentation
 * follows the picture types in the MPEG reordering model (an anchor is shown when the next anchor
 * is decoded), as ffmpeg's decoder outputs them. False, leaving the blocks as timed, when they hold
 * no B-picture or already go back in time.
 */
export async function presentVfwWindowsMedia(
    context: MatroskaReadContext,
    t: WebMTrack,
): Promise<boolean> {
    if (goesBack(t)) return false;
    t.index.fillDurations();
    const samples: Sample[] = [];
    const types: number[] = [];
    for (let index = 0; index < t.index.length; index++) {
        if ((index & 0xfff) === 0) throwIfAborted(context.signal);
        const sample = t.index.sampleAt(index);
        const head =
            sample.data ?? (await context.reader.bytes(sample.offset, Math.min(sample.size, 256)));
        types.push(windowsMediaPictureType(t.codec, head, t.codecConfig) ?? PICTURE_P);
        samples.push({ ...sample, decodeTimestamp: sample.timestamp });
    }
    if (!types.includes(PICTURE_B)) return false;
    await presentInMpegOrder(t, samples, types);
    return true;
}

/**
 * Whether the block times of `t` go back somewhere: blocks that already carry presentation times
 * (they go back at B-frames) were timed by their muxer.
 */
function goesBack(t: WebMTrack): boolean {
    for (let index = 1; index < t.index.length; index++)
        if (t.index.timestampAt(index) < t.index.timestampAt(index - 1)) return true;
    return false;
}

/**
 * Presents the decode slots `samples` of `t`, of picture `types`, in the MPEG reordering model. The
 * last anchor is shown when the last slot ends: a frame rate the track states, else the last slot's
 * own duration, which a read of the end of the input gives as a read of the whole track does.
 */
async function presentInMpegOrder(t: WebMTrack, samples: Sample[], types: number[]): Promise<void> {
    const { presentMpegPictures } = await mpegVideo();
    const tick =
        t.defaultDurationNs > 0 ? t.defaultDurationNs / 1e9 : (samples.at(-1)?.duration ?? 0);
    presentMpegPictures(samples, types, tick);
    t.index.presentFromDecodeOrder(samples);
}

/**
 * Whether an MPEG-4 Part 2 track holds a DivX packed bitstream: its first block names it in user
 * data.
 */
export async function packedMpeg4(context: MatroskaReadContext, t: WebMTrack): Promise<boolean> {
    if (goesBack(t)) return false;
    const first = t.index.sampleAt(0);
    if (first.data) return false;
    const head = await context.reader.bytes(first.offset, Math.min(first.size, 1024));
    return scanMpeg4Packet(t.codecConfig?.length ? t.codecConfig : head).packedMarker >= 0;
}

/**
 * DivX packed MPEG-4 (an anchor and a B-VOP in one block, then a small placeholder block), as AVI
 * conversions stored it with increasing block times: the blocks are decode slots, unpacked like AVI
 * chunks so each holds one picture, and presented in the MPEG reordering model.
 */
export async function unpackMpeg4(context: MatroskaReadContext, t: WebMTrack): Promise<void> {
    const { AviMpegVideoReader } = await mpegVideo();
    t.index.fillDurations();
    const reader = new AviMpegVideoReader(t.codec, t.codecConfig, message =>
        recoverDamage(context.diagnostics, 'MATROSKA_PACKED_FRAME_LOST', message, 0),
    );
    const samples: Sample[] = [];
    const types: number[] = [];
    for (let index = 0; index < t.index.length; index++) {
        if ((index & 0xfff) === 0) throwIfAborted(context.signal);
        const sample = t.index.sampleAt(index);
        const picture = await reader.inspect(context.reader, sample.offset, sample.size);
        t.index.replaceFrame(index, picture.offset, picture.size, picture.keyframe, picture.data);
        types.push(picture.type);
        samples.push({
            ...sample,
            decodeTimestamp: sample.timestamp,
            isKeyframe: picture.keyframe,
        });
    }

    context.diagnostics?.warn({
        code: 'MATROSKA_PACKED_BFRAMES',
        format: 'matroska',
        message: `Unpacked the DivX packed B-frames of Matroska track ${t.number}`,
    });
    await presentInMpegOrder(t, samples, types);
    t.codecConfig = reader.codecConfig ?? t.codecConfig;
    t.codec = reader.codec;
}
