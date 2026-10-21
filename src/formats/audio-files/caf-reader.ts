import { demuxAssert } from '../../core/errors/demux-guard';
import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import type { PcmCodec } from '../../core/codec-config/audio/pcm-format';
import { alacCookie, alacPacketFrames } from '../../core/codec-config/audio/alac-packet';
import type { Sample, TrackInfo } from '../../core/model/track';
import { decodeMetadataText } from '../metadata/metadata-text';
import { audioFileTrack, reportDamage, type AudioIndexContext } from './index-context';
import { ChunkChain, type ChunkChainFormat } from './chunk-chain';
import { indexPcmAudio } from './pcm-reader';
import { dataView, fourcc } from '../../core/bytes/byte-fields';
import { checkPacketBytes } from '../shared/demux-budget';

/** The chunk chain of a CAF file. */
const CAF_CHAIN: ChunkChainFormat = { name: 'CAF', code: 'CAF', header: 12 };

/**
 * Reads the title from a CAF info chunk: a count followed by NUL-terminated key/value string pairs.
 */
function cafInfoTitle(bytes: Uint8Array): string | undefined {
    if (bytes.length < 4) return undefined;
    const count = dataView(bytes).getUint32(0);
    let offset = 4;
    for (let index = 0; index < count && offset < bytes.length; index++) {
        const keyEnd = bytes.indexOf(0, offset);
        if (keyEnd < 0) return undefined;
        const valueEnd = bytes.indexOf(0, keyEnd + 1);
        if (valueEnd < 0) return undefined;
        if (decodeMetadataText(bytes.subarray(offset, keyEnd))?.toLowerCase() === 'title')
            return decodeMetadataText(bytes.subarray(keyEnd + 1, valueEnd));
        offset = valueEnd + 1;
    }
    return undefined;
}

interface CafPacketTable {
    readonly packets: number;
    readonly validFrames: number;
    readonly priming: number;
    readonly remainder: number;
    /** Byte size of each packet (variable-size formats only). */
    readonly sizes?: readonly number[];
}

/**
 * Reads a pakt chunk: counts, priming and remainder, then one BER-coded byte size per packet when
 * `variable`.
 */
function parsePacketTable(
    context: AudioIndexContext,
    data: Uint8Array,
    variable: boolean,
): CafPacketTable {
    const view = dataView(data);
    const packets = view.getBigInt64(0);
    const validFrames = view.getBigInt64(8);
    const priming = view.getInt32(16);
    const remainder = view.getInt32(20);

    demuxAssert(
        packets >= 0n &&
            packets <= BigInt(Number.MAX_SAFE_INTEGER) &&
            validFrames >= 0n &&
            validFrames <= BigInt(Number.MAX_SAFE_INTEGER) &&
            priming >= 0 &&
            remainder >= 0,
        'CAF packet table has negative or oversized counts',
    );

    const table = {
        packets: Number(packets),
        validFrames: Number(validFrames),
        priming,
        remainder,
    };

    if (!variable) return table;
    context.budget.reserveSamples(table.packets, 256, 'CAF packet table');
    const sizes: number[] = new Array(table.packets);
    let at = 24;
    for (let index = 0; index < table.packets; index++) {
        let value = 0;
        for (let bytes = 0; ; bytes++) {
            demuxAssert(
                at < data.length && bytes < 5,
                'CAF packet table ends inside a packet size',
            );
            const byte = data[at++]!;
            value = value * 128 + (byte & 0x7f);
            if (!(byte & 0x80)) break;
        }

        demuxAssert(value > 0, 'CAF packet size is zero');
        checkPacketBytes(value, context.maxPacketBytes, 'CAF packet');
        sizes[index] = value;
    }
    return { ...table, sizes };
}

/**
 * Indexes CAF with LPCM (packed, full width), G.711 ('ulaw', 'alaw'), Apple IMA4 ('ima4', whose
 * 'pakt' trims priming and remainder frames) or ALAC ('alac' with its 'kuki' cookie and a
 * variable-size 'pakt' packet table), with known or terminal unknown data size.
 */
export async function indexCaf(context: AudioIndexContext): Promise<TrackInfo> {
    const lenient = context.diagnostics.validation === 'compatible';
    const first = await context.read(0, 8);
    const header = dataView(first);
    demuxAssert(
        fourcc(first) === 'caff' && header.getUint16(4) === 1,
        'CAF requires a caff version 1 header',
    );

    if (header.getUint16(6) !== 0)
        reportDamage(
            context,
            'warn',
            'caf',
            'CAF_HEADER_FLAGS',
            6,
            'Ignoring reserved CAF file-header flags',
        );

    let format:
        | {
              codec: PcmCodec | 'ulaw' | 'alaw' | 'alac' | 'ima4';
              sampleRate: number;
              channels: number;
              blockAlign: number;
              blockFrames?: number;
          }
        | undefined;
    let framesPerPacket = 1;
    let cookie: Uint8Array | undefined;
    let table: CafPacketTable | undefined;
    let dataOffset = -1;
    let dataLength = 0;
    const chain = new ChunkChain(context, CAF_CHAIN, lenient, 8, context.size);
    for (let bytes; (bytes = await chain.next(dataOffset >= 0));) {
        const type = fourcc(bytes);
        const declared = dataView(bytes).getBigInt64(4);
        const body = chain.position + 12;
        const available = context.size - body;
        demuxAssert(
            chain.chunks !== 1 || type === 'desc',
            'CAF requires desc immediately after its file header',
        );

        let length: number;
        if (declared === -1n && type === 'data') length = available;
        else if (declared >= 0n && declared <= BigInt(available)) length = Number(declared);
        else if (lenient && dataOffset >= 0 && type !== 'data') {
            // Bytes after a whole data chunk that do not form a chunk (damage, or data written past
            // its declared size) are ignored: the audio is read as the data chunk declares it.
            reportDamage(
                context,
                'warn',
                'caf',
                'CAF_TRAILING_BYTES',
                chain.position,
                `Ignoring ${context.size - chain.position} bytes after the CAF data chunk ` +
                    `that do not form a chunk`,
            );
            break;
        } else {
            // Only a cut data chunk is recovered; other chunk extents are structural and stay
            // rejected.
            demuxAssert(
                lenient &&
                    type === 'data' &&
                    declared > 0n &&
                    declared <= BigInt(Number.MAX_SAFE_INTEGER),
                'CAF chunk has an invalid signed extent or exceeds input',
            );
            chain.cut('CAF data chunk is cut by the end of the input; keeping what remains');
            length = available;
        }

        if (type === 'desc') {
            demuxAssert(
                !format && chain.chunks === 1 && length === 32,
                'CAF requires one leading 32-byte desc chunk',
            );
            const data = await context.read(body, 32);
            const view = dataView(data);
            const sampleRate = view.getFloat64(0);
            const formatId = fourcc(data, 8);
            const flags = view.getUint32(12);
            const blockAlign = view.getUint32(16);
            const channels = view.getUint32(24);
            const bits = view.getUint32(28);
            const float = !!(flags & 1);

            demuxAssert(
                Number.isInteger(sampleRate) &&
                    sampleRate >= 1 &&
                    sampleRate <= 768000 &&
                    channels >= 1 &&
                    channels <= 32,
                'CAF audio requires 1..32 channels and an integer rate in 1..768000',
            );

            if (formatId === 'ulaw' || formatId === 'alaw') {
                demuxAssert(
                    blockAlign === channels && view.getUint32(20) === 1,
                    'CAF G.711 requires one byte per sample and one frame per packet',
                );
                format = { codec: formatId, sampleRate, channels, blockAlign };
                chain.position = body + length;
                continue;
            }

            if (formatId === 'ima4') {
                demuxAssert(
                    blockAlign === channels * 34 && view.getUint32(20) === 64,
                    'CAF IMA4 needs 64 frames in 34 bytes per channel',
                );
                format = { codec: 'ima4', sampleRate, channels, blockAlign, blockFrames: 64 };
                chain.position = body + length;
                continue;
            }

            if (formatId === 'alac') {
                framesPerPacket = view.getUint32(20);
                demuxAssert(
                    blockAlign === 0 &&
                        framesPerPacket >= 1 &&
                        framesPerPacket <= 65536 &&
                        channels <= 8,
                    'CAF ALAC packet size or channel count is not supported',
                );
                format = { codec: 'alac', sampleRate, channels, blockAlign: 0 };
                chain.position = body + length;
                continue;
            }

            demuxAssert(
                formatId === 'lpcm' && (flags & ~3) === 0,
                'CAF input supports LPCM with float/little-endian flags, G.711, IMA4 and ALAC',
            );
            demuxAssert(
                (float ? [32, 64] : [8, 16, 24, 32]).includes(bits) &&
                    view.getUint32(20) === 1 &&
                    blockAlign === channels * (bits / 8),
                'CAF PCM requires full-width packed samples and one frame per packet',
            );

            const codec =
                bits === 8
                    ? 'pcm-s8'
                    : (`pcm-${float ? 'f' : 's'}${bits}${flags & 2 ? 'le' : 'be'}` as PcmCodec);
            format = { codec, sampleRate, channels, blockAlign };
        } else if (type === 'data') {
            demuxAssert(
                format && dataOffset < 0 && length >= 4,
                'CAF requires one data chunk with its edit count',
            );
            dataOffset = body + 4;
            dataLength = length - 4;
        } else if (type === 'pakt') {
            demuxAssert(
                format && !table && length >= 24,
                'CAF requires one packet table after desc',
            );
            const variable = format.codec === 'alac';
            demuxAssert(
                variable ? length <= 64 * 1024 * 1024 : length === 24,
                'CAF packet table size does not match the format',
            );
            table = parsePacketTable(context, await context.read(body, length), variable);
            demuxAssert(
                variable ||
                    format.codec === 'ima4' ||
                    (table.validFrames === table.packets &&
                        table.priming === 0 &&
                        table.remainder === 0),
                'CAF LPCM packet table must have matching counts and no priming or remainder',
            );
        } else if (type === 'kuki' && format?.codec === 'alac') {
            demuxAssert(
                !cookie && length <= 4096,
                'CAF ALAC requires one magic cookie of at most 4096 bytes',
            );
            cookie = alacCookie(await context.read(body, length));
            demuxAssert(cookie, 'CAF ALAC magic cookie is shorter than 24 bytes');
        } else if (
            type === 'info' &&
            length <= 1024 * 1024 &&
            context.metadata.title === undefined
        ) {
            context.metadata.title = cafInfoTitle(await context.read(body, length));
        }

        chain.position = body + length;
    }

    const { clamped } = chain;
    demuxAssert(format && dataOffset >= 0, 'CAF requires desc and data chunks');
    if (format.codec === 'alac')
        return indexCafAlac(
            context,
            format,
            framesPerPacket,
            cookie,
            table,
            dataOffset,
            dataLength,
            clamped,
        );

    if (dataLength % format.blockAlign !== 0) {
        reportDamage(
            context,
            'recover',
            'caf',
            'CAF_PARTIAL_FRAME',
            dataOffset + dataLength - (dataLength % format.blockAlign),
            'Ignoring a partial PCM frame at the end of the CAF audio data',
        );
        dataLength -= dataLength % format.blockAlign;
    }

    if (format.codec === 'ima4')
        return indexCafIma4(context, format, table, dataOffset, dataLength, clamped);

    if (table && table.packets !== dataLength / format.blockAlign && !clamped)
        reportDamage(
            context,
            'recover',
            'caf',
            'CAF_FRAME_COUNT',
            dataOffset,
            `CAF packet table declares ${table.packets} frames but the data ` +
                `holds ${dataLength / format.blockAlign}`,
        );

    return indexPcmAudio(context, format, dataOffset, dataLength, clamped);
}

/**
 * IMA4 blocks, one packet each, presented without the priming and remainder frames the packet
 * table states when its counts add up to the coded frames (its packet count may be zero, as some
 * writers leave it); other counts are reported and the coded frames kept.
 */
async function indexCafIma4(
    context: AudioIndexContext,
    format: { sampleRate: number; channels: number; blockAlign: number; blockFrames?: number },
    table: CafPacketTable | undefined,
    dataOffset: number,
    dataLength: number,
    clamped: boolean,
): Promise<TrackInfo> {
    const track = await indexPcmAudio(
        context,
        { ...format, codec: 'ima4' },
        dataOffset,
        dataLength,
        clamped,
    );
    if (!table || clamped) return track;
    const packets = dataLength / format.blockAlign;
    const coded = packets * format.blockFrames!;
    const { validFrames, priming, remainder } = table;
    if (
        (table.packets !== 0 && table.packets !== packets) ||
        validFrames < 1 ||
        validFrames + priming + remainder !== coded
    ) {
        reportDamage(
            context,
            'recover',
            'caf',
            'CAF_FRAME_COUNT',
            dataOffset,
            `CAF packet table counts do not match ${packets} IMA4 packets; keeping every frame`,
        );
        return track;
    }
    // The track keeps its packet index: its fields change in place.
    track.duration = validFrames / format.sampleRate;
    if (priming) track.audioPrimingSamples = priming;
    if (remainder) track.audioTrailingPaddingSamples = remainder;
    return track;
}

/**
 * ALAC packets at the byte sizes of the packet table. Packets hold the desc frame count except a
 * final partial one, whose length its own header states; pakt priming frames become the track's
 * priming samples.
 */
async function indexCafAlac(
    context: AudioIndexContext,
    format: { sampleRate: number; channels: number },
    framesPerPacket: number,
    cookie: Uint8Array | undefined,
    table: CafPacketTable | undefined,
    dataOffset: number,
    dataLength: number,
    clamped: boolean,
): Promise<TrackInfo> {
    demuxAssert(cookie && table?.sizes, 'CAF ALAC requires a magic cookie and a packet table');
    const frameLength = new DataView(cookie.buffer, cookie.byteOffset).getUint32(0);
    demuxAssert(
        frameLength === framesPerPacket && cookie[9] === format.channels,
        'CAF ALAC magic cookie disagrees with desc on frames per packet or channels',
    );

    const { sampleRate } = format;
    const samples: Sample[] = [];
    let offset = dataOffset;
    let frames = 0;
    let incomplete = clamped;

    for (let index = 0; index < table.sizes.length; index++) {
        if ((index & 4095) === 0) await context.checkpoint();
        const size = table.sizes[index]!;
        if (offset + size > dataOffset + dataLength) {
            if (context.diagnostics.validation !== 'compatible')
                throw new DemuxError('CAF ALAC packet table exceeds the data chunk');
            reportDamage(
                context,
                'recover',
                'caf',
                'CAF_TRUNCATED_CHUNK',
                offset,
                `CAF ALAC data ends inside packet ${index}; keeping the earlier ones`,
            );
            incomplete = true;
            break;
        }

        let duration = framesPerPacket;
        if (index === table.sizes.length - 1) {
            const header = await context.read(offset, Math.min(size, 7));
            const partial = alacPacketFrames(header, framesPerPacket);
            demuxAssert(
                partial && partial <= framesPerPacket,
                'CAF ALAC final packet has an invalid frame count',
            );
            duration = partial;
        }

        samples.push({
            offset,
            size,
            timestamp: frames / sampleRate,
            decodeTimestamp: frames / sampleRate,
            duration: duration / sampleRate,
            isKeyframe: true,
        });

        offset += size;
        frames += duration;
    }
    if (!samples.length) throw new MediaForgeError('CAF ALAC holds no complete packets', 'FORMAT');
    return audioFileTrack('alac', cookie, sampleRate, format.channels, frames, {
        samples,
        ...(table.priming > 0 && table.priming < frames
            ? { audioPrimingSamples: table.priming }
            : {}),
        ...(incomplete ? { incomplete: true } : {}),
    });
}
