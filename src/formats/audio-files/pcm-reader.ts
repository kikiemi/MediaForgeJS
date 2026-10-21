import { demuxAssert } from '../../core/errors/demux-guard';
import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import type { PcmCodec } from '../../core/codec-config/audio/pcm-format';
import type { TrackInfo } from '../../core/model/track';
import { bindCompactSampleIndex, type SampleIndex } from '../../core/model/sample-index';
import { decodeMetadataText } from '../metadata/metadata-text';
import { audioFileTrack, reportDamage, type AudioIndexContext } from './index-context';
import { ChunkChain, type ChunkChainFormat } from './chunk-chain';
import { dataView, fourcc } from '../../core/bytes/byte-fields';

interface PcmIndexFormat {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
    /** Bytes of a frame, or of a coded block of `blockFrames` frames. */
    readonly blockAlign: number;
    /** Frames of a coded block (64 for IMA4), each block a packet; omitted for PCM frames. */
    readonly blockFrames?: number;
    readonly codecConfig?: Uint8Array;
}

/** The chunk chain of an AIFF or AIFC FORM. */
const AIFF_CHAIN: ChunkChainFormat = { name: 'AIFF', code: 'AIFF', header: 8 };

const utf8 = new TextDecoder('utf-8');

/** An Apple IMA4 block: 64 frames in 34 bytes per channel. */
const IMA4_BLOCK_BYTES = 34;
const IMA4_BLOCK_FRAMES = 64;

/**
 * Frames per packet of headerless PCM: the power of two nearest below a tenth of a second (as
 * ffmpeg's PCM demuxers size them), from 256 to 4096 frames, so packets stay short enough for
 * seeking and trimming at low rates.
 */
function pcmPacketFrames(sampleRate: number): number {
    return Math.min(4096, Math.max(256, 2 ** Math.floor(Math.log2(Math.max(1, sampleRate / 10)))));
}

/**
 * The track of PCM frames (or coded blocks) at `dataOffset`; `incomplete` marks a recovered
 * (clamped) input. PCM frames are grouped into packets; a coded block is one packet, as ffmpeg
 * reads it.
 */
export async function indexPcmAudio(
    context: AudioIndexContext,
    format: PcmIndexFormat,
    dataOffset: number,
    dataLength: number,
    incomplete = false,
): Promise<TrackInfo> {
    const { sampleRate, channels, blockAlign: stride, codec, codecConfig } = format;
    const blockFrames = format.blockFrames ?? 1;
    demuxAssert(dataLength % stride === 0, 'PCM data ends inside a sample frame');
    const units = dataLength / stride;
    const frames = units * blockFrames;
    const unitsPerPacket =
        blockFrames > 1
            ? 1
            : Math.min(pcmPacketFrames(sampleRate), Math.floor(context.maxPacketBytes / stride));
    if (unitsPerPacket < 1 || stride > context.maxPacketBytes)
        throw new MediaForgeError('One PCM frame exceeds maxPacketBytes', 'OOM');
    const index = pcmPacketIndex(
        dataOffset,
        stride,
        units,
        unitsPerPacket,
        blockFrames,
        sampleRate,
    );
    context.budget.reserveSamples(index.length, 0, 'PCM sample index');
    const track = audioFileTrack(
        codec,
        codecConfig,
        sampleRate,
        channels,
        frames,
        incomplete ? { incomplete } : undefined,
    );
    bindCompactSampleIndex(track, index);
    return track;
}

/** The memory of a PCM packet index: a few numbers, whatever the length of the track. */
const PCM_INDEX_BYTES = 64;

/**
 * The packets of PCM frames (or coded blocks) at evenly spaced offsets, computed from their
 * position: `per` frames or blocks of `stride` bytes each, the last packet holding the rest.
 */
function pcmPacketIndex(
    offset: number,
    stride: number,
    units: number,
    per: number,
    blockFrames: number,
    rate: number,
): SampleIndex {
    const length = Math.ceil(units / per);
    const count = (index: number): number => Math.min(per, units - index * per);
    const timestampAt = (index: number): number => (index * per * blockFrames) / rate;
    const durationAt = (index: number): number => (count(index) * blockFrames) / rate;
    const last = length - 1;
    return {
        length,
        byteLength: PCM_INDEX_BYTES,
        maxSampleSize: Math.min(per, units) * stride,
        allKeyframes: true,
        presentationSorted: true,
        decodeSorted: true,
        firstPresentation: length ? 0 : Infinity,
        lastPresentationEnd: length ? timestampAt(last) + durationAt(last) : -Infinity,
        get: index => ({
            offset: offset + index * per * stride,
            size: count(index) * stride,
            timestamp: timestampAt(index),
            decodeTimestamp: timestampAt(index),
            duration: durationAt(index),
            isKeyframe: true,
        }),
        timestampAt,
        decodeTimeAt: timestampAt,
        isKeyframeAt: () => true,
    };
}

function sampleRate80(bytes: Uint8Array, at: number): number {
    const view = dataView(bytes);
    const exponent = view.getUint16(at) - 16383;
    const mantissa = view.getBigUint64(at + 2);
    demuxAssert(
        exponent >= 0 && exponent <= 19 && mantissa >= 1n << 63n,
        'AIFF requires a finite positive normalized sample rate in 1..768000',
    );
    const shift = BigInt(63 - exponent);
    const rate = Number(mantissa >> shift);
    demuxAssert(
        (mantissa & ((1n << shift) - 1n)) === 0n && rate >= 1 && rate <= 768000,
        'AIFF requires an exact integer sample rate in 1..768000',
    );
    return rate;
}

function aiffCodec(compression: string, bits: number): PcmCodec | 'ulaw' | 'alaw' | 'ima4' {
    if (compression === 'ulaw' || compression === 'ULAW') return 'ulaw';
    if (compression === 'ima4') return 'ima4';
    if (compression === 'alaw' || compression === 'ALAW') return 'alaw';
    if (compression === 'NONE' || compression === 'twos') {
        demuxAssert([8, 16, 24, 32].includes(bits), 'AIFF supports signed integer8/16/24/32');
        return bits === 8 ? 'pcm-s8' : (`pcm-s${bits}be` as PcmCodec);
    }
    if (compression === 'sowt' && bits === 16) return 'pcm-s16le';
    if (compression === 'raw ' && bits === 8) return 'pcm-u8';
    if (compression === 'in24' && bits === 24) return 'pcm-s24be';
    if (compression === 'in32' && bits === 32) return 'pcm-s32be';
    if ((compression === 'fl32' || compression === 'FL32') && bits === 32) return 'pcm-f32be';
    if ((compression === 'fl64' || compression === 'FL64') && bits === 64) return 'pcm-f64be';
    throw new DemuxError(`Unsupported AIFC compression '${compression}' or sample width`);
}

/** Indexes supported AIFF/AIFC PCM without reading or converting its sample payload. */
export async function indexAiff(context: AudioIndexContext): Promise<TrackInfo> {
    const lenient = context.diagnostics.validation === 'compatible';
    const first = await context.read(0, 12);
    const kind = fourcc(first, 8);
    demuxAssert(
        fourcc(first) === 'FORM' && (kind === 'AIFF' || kind === 'AIFC'),
        'Invalid AIFF/AIFC FORM header',
    );
    let end = dataView(first).getUint32(4) + 8;
    demuxAssert(end >= 12 && (lenient || end <= context.size), 'AIFF FORM size exceeds input');

    // A FORM size beyond the input is recovered only when the sound chunk is cut too (a truncated
    // file).
    const overflow = end > context.size;
    if (overflow) end = context.size;
    if (end < context.size)
        reportDamage(
            context,
            'recover',
            'aiff',
            'AIFF_TRAILING_BYTES',
            end,
            'Ignoring bytes after the declared AIFF FORM boundary',
        );
    let format: PcmIndexFormat | undefined;
    let declaredFrames = 0;
    let dataOffset = -1;
    let dataLength = 0;
    let version = false;
    const chain = new ChunkChain(context, AIFF_CHAIN, lenient, 12, end);
    for (let head; (head = await chain.next(dataOffset >= 0));) {
        const id = fourcc(head);
        const body = chain.position + 8;
        const length = chain.fit(
            id,
            body,
            dataView(head).getUint32(4),
            id === 'SSND',
            dataOffset >= 0,
            'AIFF chunk exceeds its FORM boundary or padding',
        );
        if (chain.clamped && id !== 'SSND') break;
        if (id === 'FVER') {
            demuxAssert(
                kind === 'AIFC' && !version && length === 4,
                'Invalid or repeated AIFC FVER chunk',
            );
            const bytes = await context.read(body, 4);
            demuxAssert(
                new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) === 0xa2805140,
                'Unsupported AIFC version',
            );
            version = true;
        } else if (id === 'COMM') {
            demuxAssert(
                !format && (kind === 'AIFF' ? length === 18 : length >= 24 && length <= 278),
                'Invalid or repeated AIFF COMM chunk',
            );
            const bytes = await context.read(body, length);
            const view = dataView(bytes);
            const channels = view.getUint16(0);
            declaredFrames = view.getUint32(2);
            const bits = view.getUint16(6);
            const sampleRate = sampleRate80(bytes, 8);
            demuxAssert(
                channels >= 1 && channels <= 32,
                'AIFF packet input supports 1..32 channels',
            );
            if (kind === 'AIFC') {
                const nameBytes = bytes[22]! + 1;
                demuxAssert(
                    length === 22 + nameBytes + (nameBytes & 1),
                    'Invalid AIFC compression-name extent',
                );
            }
            const codec = aiffCodec(kind === 'AIFF' ? 'NONE' : fourcc(bytes, 18), bits);
            const g711 = codec === 'ulaw' || codec === 'alaw';
            // IMA4 counts its blocks of 64 frames (34 bytes per channel) as the sample frames.
            format =
                codec === 'ima4'
                    ? {
                          codec,
                          sampleRate,
                          channels,
                          blockAlign: channels * IMA4_BLOCK_BYTES,
                          blockFrames: IMA4_BLOCK_FRAMES,
                      }
                    : {
                          codec,
                          sampleRate,
                          channels,
                          blockAlign: g711 ? channels : channels * (bits / 8),
                      };
        } else if (id === 'SSND') {
            demuxAssert(dataOffset < 0 && length >= 8, 'Invalid or repeated AIFF SSND chunk');
            const bytes = await context.read(body, 8);
            const view = dataView(bytes);
            const offset = view.getUint32(0);
            demuxAssert(
                offset <= length - 8 && view.getUint32(4) === 0,
                'AIFF SSND offset exceeds its payload or uses unsupported block organization',
            );
            dataOffset = body + 8 + offset;
            dataLength = length - 8 - offset;
        } else if (id === 'NAME' && length <= 1024 * 1024 && context.metadata.title === undefined) {
            context.metadata.title = decodeMetadataText(await context.read(body, length));
        }
        chain.position = body + length + (length & 1);
    }
    const { clamped } = chain;
    demuxAssert(format && dataOffset >= 0, 'AIFF requires one COMM and one SSND chunk');
    demuxAssert(!overflow || clamped, 'AIFF FORM size exceeds input');
    demuxAssert(kind !== 'AIFC' || version, 'AIFC requires its FVER version chunk');
    if (dataLength % format.blockAlign !== 0) {
        reportDamage(
            context,
            'recover',
            'aiff',
            'AIFF_PARTIAL_FRAME',
            dataOffset + dataLength - (dataLength % format.blockAlign),
            'Ignoring a partial PCM frame at the end of the AIFF sound data',
        );
        dataLength -= dataLength % format.blockAlign;
    }
    if (declaredFrames * format.blockAlign !== dataLength && !clamped)
        reportDamage(
            context,
            'recover',
            'aiff',
            'AIFF_FRAME_COUNT',
            dataOffset,
            `AIFF COMM declares ${declaredFrames} sample frames but SSND ` +
                `holds ${dataLength / format.blockAlign}`,
        );
    return indexPcmAudio(context, format, dataOffset, dataLength, clamped);
}

/**
 * Indexes AU G.711 (encodings 1 and 27), signed integer and IEEE float PCM, including the
 * unknown-size sentinel.
 */
export async function indexAu(context: AudioIndexContext): Promise<TrackInfo> {
    const bytes = await context.read(0, 24);
    const view = dataView(bytes);
    demuxAssert(fourcc(bytes) === '.snd', 'Invalid AU header');
    const dataOffset = view.getUint32(4);
    const declared = view.getUint32(8);
    const encoding = view.getUint32(12);
    const sampleRate = view.getUint32(16);
    const channels = view.getUint32(20);
    demuxAssert(
        dataOffset >= 24 && dataOffset <= context.size,
        'AU data offset exceeds input or overlaps its header',
    );
    demuxAssert(
        declared < 0x80000000 || declared === 0xffffffff,
        'AU declared data size uses an unsupported signed extent',
    );
    demuxAssert(
        sampleRate >= 1 && sampleRate <= 768000 && channels >= 1 && channels <= 32,
        'AU packet input supports 1..32 channels and a sample rate in 1..768000',
    );
    const codecs: readonly PcmCodec[] = [
        'pcm-s8',
        'pcm-s16be',
        'pcm-s24be',
        'pcm-s32be',
        'pcm-f32be',
        'pcm-f64be',
    ];
    const g711 = encoding === 1 ? 'ulaw' : encoding === 27 ? 'alaw' : undefined;
    demuxAssert(
        g711 || (encoding >= 2 && encoding <= 7),
        'AU packet input supports G.711 encodings 1 and 27 and PCM 2..7',
    );

    // The header annotation holds NUL-terminated "key=value" lines in files written by ffmpeg and
    // sox.
    if (dataOffset > 24 && dataOffset - 24 <= 1024 * 1024) {
        const annotation = await context.read(24, dataOffset - 24);
        for (const line of utf8.decode(annotation).split(/[\0\n]/)) {
            const separator = line.indexOf('=');
            if (separator > 0 && line.slice(0, separator).trim().toLowerCase() === 'title') {
                context.metadata.title = decodeMetadataText(
                    new TextEncoder().encode(line.slice(separator + 1)),
                );
                break;
            }
        }
    }
    const bits = g711 ? 8 : [8, 16, 24, 32, 32, 64][encoding - 2]!;
    const blockAlign = channels * (bits / 8);
    let dataLength = declared === 0xffffffff ? context.size - dataOffset : declared;
    let clamped = false;
    if (dataLength > context.size - dataOffset) {
        demuxAssert(
            context.diagnostics.validation === 'compatible',
            'AU declared data size exceeds input',
        );
        reportDamage(
            context,
            'warn',
            'au',
            'AU_TRUNCATED_DATA',
            context.size,
            'AU audio is cut by the end of the input; keeping what remains',
        );
        dataLength = context.size - dataOffset;
        clamped = true;
    }
    if (dataLength % blockAlign !== 0) {
        reportDamage(
            context,
            'recover',
            'au',
            'AU_PARTIAL_FRAME',
            dataOffset + dataLength - (dataLength % blockAlign),
            'Ignoring a partial PCM frame at the end of the AU audio data',
        );
        dataLength -= dataLength % blockAlign;
    }
    const end = dataOffset + dataLength;
    if (end < context.size && !clamped)
        reportDamage(
            context,
            'recover',
            'au',
            'AU_TRAILING_BYTES',
            end,
            'Ignoring bytes after the declared AU audio extent',
        );
    return indexPcmAudio(
        context,
        { codec: g711 ?? codecs[encoding - 2]!, sampleRate, channels, blockAlign },
        dataOffset,
        dataLength,
        clamped,
    );
}
