import { reportDamage, type AudioIndexContext } from './index-context';
import { ChunkChain, type ChunkChainFormat } from './chunk-chain';
import { MAX_TEXT_METADATA_BYTES } from '../metadata/metadata-text';
import { riffInfoTags, riffInfoTitle } from '../metadata/riff-info';
import { id3MediaTags, id3Title } from '../metadata/id3';
import type { Source } from '../../core/model/types';
import type { DemuxResult, TrackInfo } from '../../core/model/track';
import { DemuxError, throwIfAborted } from '../../core/errors/errors';
import {
    EAC3_WAVE_TAG,
    MAX_WAVE_FORMAT_BYTES,
    parseWaveFormat,
    waveFormatTag,
    type WaveFormat,
} from '../../core/codec-config/audio/wave-format';
import { type SyncAudioKind } from './sync-frame';
import { indexAiff, indexAu, indexPcmAudio } from './pcm-reader';
import { dataView, fourcc } from '../../core/bytes/byte-fields';
import { audioResult, openAudioIndex } from './audio-open';
import type { StandaloneAudioDemuxOptions } from './demux-options';

/** The parts of the reader that FLAC, Ogg and CAF inputs run (see described-files). */
const describedFiles = () => import('./described-files');

/**
 * Indexes supported PCM containers, native FLAC, and Ogg files with Theora, Opus, Vorbis, FLAC and
 * Speex streams.
 */
export async function demuxStandaloneAudio(
    source: Source,
    options: StandaloneAudioDemuxOptions,
): Promise<DemuxResult> {
    const { format } = options;
    if (format === 'flac') return (await describedFiles()).demuxFlac(source, options);
    if (format === 'ogg' || format === 'ogv' || format === 'oga' || format === 'opus')
        return (await describedFiles()).demuxOgg(source, options);
    const { context, untag } = await openAudioIndex(source, options);
    const track =
        format === 'wav'
            ? await indexWav(context)
            : format === 'aiff' || format === 'aif' || format === 'aifc'
              ? await indexAiff(context)
              : format === 'au'
                ? await indexAu(context)
                : await (await describedFiles()).indexCaf(context);
    throwIfAborted(options.signal);
    untag([track]);
    return audioResult(context, track);
}

/** Compressed WAVE payloads indexed by their frame headers: MPEG audio, AC-3, E-AC-3 and DTS. */
const COMPRESSED_WAVE_KINDS: ReadonlyMap<number, SyncAudioKind> = new Map([
    [0x0050, 'mpeg'],
    [0x0055, 'mpeg'],
    [0x2000, 'ac3'],
    [EAC3_WAVE_TAG, 'eac3'],
    [0x2001, 'dts'],
]);

/** The chunk chain of a RIFF or RF64 WAVE file. */
const WAVE_CHAIN: ChunkChainFormat = {
    name: 'WAVE',
    code: 'WAV',
    header: 8,
    failure: 'WAVE chunk chain is truncated or too long',
};

async function indexWav(context: AudioIndexContext): Promise<TrackInfo> {
    const lenient = context.diagnostics.validation === 'compatible';
    const first = await context.read(0, 12);
    const kind = fourcc(first);
    if (kind === 'RIFX')
        throw new DemuxError('Big-endian RIFX requires conversion to little-endian WAVE');
    if ((kind !== 'RIFF' && kind !== 'RF64') || fourcc(first, 8) !== 'WAVE')
        throw new DemuxError('Invalid RIFF/RF64 WAVE header');
    const initialSize = new DataView(first.buffer, first.byteOffset).getUint32(4, true);
    let end = initialSize + 8;
    let dataSize64 = -1;
    let declaredFrames = 0;
    const extendedSizes = new Map<string, number[]>();
    let tableEntries = 0;
    let position = 12;

    // Streamed WAVE written to a pipe keeps the 0xffffffff RIFF/data placeholders; the audio runs
    // to the end.
    const unbounded = kind === 'RIFF' && initialSize === 0xffffffff;

    // A RIFF size beyond the input is read up to the input's end (lenient validation): a cut chunk
    // shows the file was truncated; whole chunks with a RIFF size past them show chunks after them
    // were lost.
    let overflow = false;
    if (kind === 'RF64') {
        const head = await context.read(position, 8);
        const length = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
        if (
            initialSize !== 0xffffffff ||
            fourcc(head) !== 'ds64' ||
            length < 28 ||
            length > context.size - 20
        ) {
            throw new DemuxError('RF64 requires a leading ds64 chunk and RIFF size sentinel');
        }
        const data = await context.read(20, 28);
        const view = new DataView(data.buffer, data.byteOffset);
        end = Number(view.getBigUint64(0, true)) + 8;
        dataSize64 = Number(view.getBigUint64(8, true));
        declaredFrames = Number(view.getBigUint64(16, true));
        tableEntries = view.getUint32(24, true);
        if (
            !Number.isSafeInteger(dataSize64) ||
            !Number.isSafeInteger(declaredFrames) ||
            tableEntries > 4096 ||
            tableEntries > Math.floor((length - 28) / 12)
        )
            throw new DemuxError('Invalid RF64 size table');
        const table = await context.read(48, tableEntries * 12);
        const sizes = dataView(table);
        for (let entry = 0; entry < tableEntries; entry++) {
            const id = fourcc(table, entry * 12);
            const size = Number(sizes.getBigUint64(entry * 12 + 4, true));
            if (!Number.isSafeInteger(size))
                throw new DemuxError('RF64 chunk size exceeds exact integer range');
            const queue = extendedSizes.get(id) ?? [];
            queue.push(size);
            extendedSizes.set(id, queue);
        }
        position = 20 + length + (length & 1);
    } else if (unbounded) {
        reportDamage(
            context,
            'recover',
            'wav',
            'WAV_UNBOUNDED_SIZE',
            4,
            'WAVE RIFF size is a streaming placeholder; reading to the end',
        );
        end = context.size;
    }
    if (!Number.isSafeInteger(end) || end < position)
        throw new DemuxError('WAVE RIFF size exceeds input');
    if (end > context.size) {
        if (!lenient) throw new DemuxError('WAVE RIFF size exceeds input');
        overflow = true;
        end = context.size;
    }
    let format: WaveFormat | undefined;
    let compressed: SyncAudioKind | undefined;
    let factFrames: number | undefined;
    let dataOffset = -1;
    let dataLength = 0;
    let id3Titled = false;
    const chain = new ChunkChain(context, WAVE_CHAIN, lenient, position, end);
    for (let head; (head = await chain.next(dataOffset >= 0));) {
        const id = fourcc(head);
        const body = chain.position + 8;
        let length = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
        if (length === 0xffffffff) {
            if (id === 'data' && dataSize64 >= 0) length = dataSize64;
            else if (id === 'data' && unbounded) length = chain.end - body;
            else {
                const extended = extendedSizes.get(id)?.shift();
                if (extended === undefined)
                    throw new DemuxError('RF64 chunk size sentinel has no ds64 table entry');
                length = extended;
                tableEntries--;
            }
        }
        if (
            id === 'data' &&
            !overflow &&
            length > chain.end - body &&
            length <= context.size - body
        ) {
            // A RIFF size that stops inside the data chunk the input holds whole is a writer's
            // miscount; the data chunk's own size bounds the audio, as ffmpeg reads it.
            reportDamage(
                context,
                'recover',
                'wav',
                'WAV_RIFF_SIZE',
                4,
                'WAVE RIFF size ends inside the data chunk; reading the whole chunk',
            );
            chain.end = Math.min(context.size, body + length + (length & 1));
        }
        length = chain.fit(
            id,
            body,
            length,
            id === 'data',
            dataOffset >= 0,
            'WAVE chunk exceeds RIFF boundary',
        );
        if (chain.clamped && id !== 'data') break;
        if (id === 'fmt ') {
            if (format || compressed || dataOffset >= 0 || length < 16)
                throw new DemuxError('WAVE requires one fmt chunk before data');
            if (length > MAX_WAVE_FORMAT_BYTES)
                throw new DemuxError('WAVE fmt exceeds the 65553-byte format limit');
            const bytes = await context.read(body, length);
            compressed = COMPRESSED_WAVE_KINDS.get(waveFormatTag(bytes));
            if (!compressed)
                format = parseWaveFormat(bytes, (declared, expected) =>
                    reportDamage(
                        context,
                        'recover',
                        'wav',
                        'WAV_BYTE_RATE',
                        body,
                        `WAVE byte rate ${declared} is wrong; using ${expected}`,
                    ),
                );
        } else if (id === 'data' && compressed) {
            if (dataOffset >= 0) throw new DemuxError('WAVE requires one data chunk after fmt');
            dataOffset = body;
            dataLength = length;
        } else if (id === 'data') {
            if (!format || dataOffset >= 0)
                throw new DemuxError('WAVE requires one data chunk after fmt');
            if (length % format.blockAlign !== 0) {
                reportDamage(
                    context,
                    'recover',
                    'wav',
                    'WAV_PARTIAL_FRAME',
                    body + length - (length % format.blockAlign),
                    'Ignoring a partial PCM frame at the end of the WAVE data chunk',
                );
                length -= length % format.blockAlign;
            }
            if (kind === 'RF64' && dataSize64 !== length && !chain.clamped)
                throw new DemuxError('RF64 data size disagrees with ds64');
            dataOffset = body;
            dataLength = length;
        } else if (id === 'fact') {
            if (factFrames !== undefined || length < 4)
                throw new DemuxError('WAVE fact chunk is repeated or truncated');
            const bytes = await context.read(body, 4);
            factFrames = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
        } else if (
            id === 'LIST' &&
            length <= MAX_TEXT_METADATA_BYTES &&
            !id3Titled &&
            context.metadata.title === undefined
        ) {
            const list = await context.read(body, length);
            context.metadata.title = riffInfoTitle(list);
            if (list.length >= 4 && String.fromCharCode(...list.subarray(0, 4)) === 'INFO')
                context.metadata.tags = riffInfoTags(list.subarray(4));
        } else if (
            (id === 'id3 ' || id === 'ID3 ') &&
            length <= MAX_TEXT_METADATA_BYTES &&
            !id3Titled
        ) {
            // An ID3v2 tag chunk takes precedence over RIFF INFO wherever it is stored, as ffmpeg
            // reads it.
            const bytes = await context.read(body, length);
            const title = id3Title(bytes);
            if (title !== undefined) {
                context.metadata.title = title;
                context.metadata.tags = id3MediaTags(bytes) ?? context.metadata.tags;
                id3Titled = true;
            }
        } else if (id === 'ds64') throw new DemuxError('Unexpected ds64 chunk in WAVE');
        chain.position = body + length + (length & 1);
        if (chain.clamped) break;
    }
    const { clamped } = chain;
    end = chain.end;
    if (end < context.size)
        reportDamage(
            context,
            'recover',
            'wav',
            'WAV_TRAILING_BYTES',
            end,
            'Ignoring bytes after the declared WAVE RIFF boundary',
        );
    if (compressed && dataOffset >= 0) {
        // Compressed WAVE data (AC-3, DTS, MPEG audio) is framed by the sync-word reader, loaded
        // for it.
        const { indexSyncAudio, syncAudioTrack } = await import('./sync-reader');
        const index = await indexSyncAudio(
            (offset, count) => context.read(offset, count),
            dataOffset,
            dataOffset + dataLength,
            compressed,
            context.budget,
            context.diagnostics,
        );
        const track = syncAudioTrack(index);
        return clamped ? { ...track, incomplete: true } : track;
    }
    if (!format || dataOffset < 0) throw new DemuxError('WAVE is missing PCM format or data');
    if (overflow && !clamped)
        reportDamage(
            context,
            'recover',
            'wav',
            'WAV_RIFF_SIZE',
            4,
            'WAVE RIFF size ends past the input; reading its whole chunks',
        );
    if (tableEntries && !clamped) throw new DemuxError('RF64 contains unused ds64 chunk sizes');
    const frames = dataLength / format.blockAlign;
    if (declaredFrames !== 0 && declaredFrames !== frames && !clamped)
        reportDamage(
            context,
            'recover',
            'wav',
            'WAV_FRAME_COUNT',
            20,
            `RF64 declares ${declaredFrames} sample frames but the data chunk holds ` + `${frames}`,
        );
    if (
        factFrames !== undefined &&
        factFrames !== 0 &&
        !(kind === 'RF64' && factFrames === 0xffffffff) &&
        factFrames !== frames &&
        !clamped
    )
        reportDamage(
            context,
            'recover',
            'wav',
            'WAV_FRAME_COUNT',
            dataOffset,
            `WAVE fact declares ${factFrames} sample frames but the data chunk holds ` +
                `${frames}`,
        );
    return indexPcmAudio(context, format, dataOffset, dataLength, clamped);
}
