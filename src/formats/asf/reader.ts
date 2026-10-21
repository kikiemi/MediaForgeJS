import type { Reader } from '../../core/contracts/reader';
import { HANDS_OVER, readerDiagnostics } from '../shared/contract';
import type { Source } from '../../core/model/types';
import type { DemuxResult, Sample, TrackInfo } from '../../core/model/track';
import { ChunkReader } from '../../core/io/sources/chunk-reader';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { DemuxError, throwIfAborted } from '../../core/errors/errors';
import { demuxAssert } from '../../core/errors/demux-guard';
import { DemuxIndexBudget, PacketDemuxer } from '../shared/demux-budget';
import { yieldEventLoop } from '../../core/io/event-loop';
import { parseAacAudioSpecificConfig } from '../../core/codec-config/audio/adts';
import {
    EAC3_WAVE_TAG,
    compressedWaveCodec,
    parseWaveFormat,
    waveFormatTag,
    MAX_WAVE_FORMAT_BYTES,
} from '../../core/codec-config/audio/wave-format';
import { parseMpegVideoConfig, vfwVideoCodec } from '../../core/codec-config/video/mpeg-video';
import { mpegVideoFamily } from '../../core/model/codec-strings';
import { buildAvcCFromAnnexB, isAnnexB } from '../../core/codec-config/video/annexb';
import { avcCodecString } from '../../core/codec-config/video/video-sps';
import { buildHevcCFromAnnexB } from '../../core/codec-config/video/hevc-config';
import { hevcCodecString } from '../../core/codec-config/video/hevc-codec';
import { iso639Language } from '../shared/language';
import {
    normalizedWaveFormatEx,
    parseBitmapInfoHeader,
    parseWaveFormatEx,
    windowsMediaAudioCodec,
    windowsMediaVideoCodec,
} from '../../core/codec-config/windows-media';
import { parseVc1SequenceHeader, VC1_SEQUENCE } from '../../core/codec-config/video/vc1';
import { u32le, dataView } from '../../core/bytes/byte-fields';
import { checkPacketBytes } from '../shared/demux-budget';

const GUID = {
    header: '3026b2758e66cf11a6d900aa0062ce6c',
    data: '3626b2758e66cf11a6d900aa0062ce6c',
    simpleIndex: '90080033b1e5cf1189f400a0c90349cb',
    fileProperties: 'a1dcab8c47a9cf118ee400c00c205365',
    streamProperties: '9107dcb7b7a9cf118ee600c00c205365',
    headerExtension: 'b503bf5f2ea9cf118ee300c00c205365',
    codecList: '4052d1861d31d011a3a400a0c90348f6',
    contentDescription: '3326b2758e66cf11a6d900aa0062ce6c',
    extendedStreamProperties: 'cba5e61472c632438399a96952065b5a',
    metadata: 'eacbf8c5af5b77488467aa8c44fa4cca',
    languageList: 'a946437ce0effc4bb229393ede415c85',
    contentEncryption: '2211b3fbbd2311d2b4b700a0c955fc6e',
    extendedContentEncryption: '14e68a292226174cb935dae07ee9289c',
    audioMedia: '409e69f84d5bcf11a8fd00805f5c442b',
    videoMedia: 'c0ef19bc4d5bcf11a8fd00805f5c442b',
} as const;

const HEADER_OBJECT_BYTES = 30;
const DATA_OBJECT_BYTES = 50;
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const MAX_STREAMS = 127;

/** Bytes after a damaged packet searched for the start of the next one. */
const RESYNC_SEARCH_BYTES = 32 * 1024;

/**
 * Packet header fields: flags, property flags, up to three 4-byte lengths, send time and duration.
 */
const MIN_PACKET_BYTES = 12;

interface AsfStream {
    readonly number: number;
    readonly type: 'video' | 'audio';
    codec: string;
    codecTag?: string;
    width: number;
    height: number;
    sampleRate: number;
    channelCount: number;
    codecConfig?: Uint8Array;
    /** The audio block (nBlockAlign): a decoder reads whole blocks only. */
    blockAlign?: number;
    language?: string;
    languageIndex?: number;
    pixelAspectRatioNum?: number;
    pixelAspectRatioDen?: number;
    /** Average time per frame from the extended stream properties, in seconds. */
    frameDuration?: number;
    annexB?: boolean;
    encrypted: boolean;
    /**
     * Byte lengths of payload extension data following the 8 fixed replicated bytes; 0xffff means
     * variable.
     */
    payloadExtensions: number[];
    samples: Sample[];
    pending?: PendingObject;
    dropped: number;
    /** Objects assembled from fragments out of order. */
    reordered: number;
}

interface PendingObject {
    readonly number: number;
    readonly size: number;
    readonly presentationTime: number;
    readonly keyframe: boolean;
    /** Fragments: their input offset, bytes and offset in the object (`at`). */
    readonly parts: { offset: number; data: Uint8Array; at: number }[];
    /** Bytes received. */
    received: number;
    /** The object offset after the last fragment, where the next one starts in order. */
    next: number;
    /** Whether a fragment arrived out of order (packets swapped). */
    unordered: boolean;
}

/** The first `size` bytes of the fragments `parts`, in object order. */
function leadingBytes(
    parts: readonly { offset: number; data: Uint8Array; at: number }[],
    size: number,
): { offset: number; data: Uint8Array; at: number }[] {
    const kept = [];
    for (const part of parts) {
        if (part.at >= size) break;
        kept.push(
            part.at + part.data.length <= size
                ? part
                : { ...part, data: part.data.subarray(0, size - part.at) },
        );
    }
    return kept;
}

function guidOf(bytes: Uint8Array, at: number): string {
    let hex = '';
    for (let index = 0; index < 16; index++)
        hex += bytes[at + index]!.toString(16).padStart(2, '0');
    return hex;
}

function utf16(bytes: Uint8Array, start: number, length: number): string | undefined {
    if (length < 2 || start + length > bytes.length) return undefined;
    const text = new TextDecoder('utf-16le')
        .decode(bytes.subarray(start, start + length))
        .replace(/\0+$/, '');
    return text.length ? text : undefined;
}

class AsfDemuxRun {
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private readonly signal: AbortSignal | undefined;
    declare private readonly budget: DemuxIndexBudget;
    declare private readonly maxPacketBytes: number;
    declare private readonly source: Source;
    declare private readonly diagnostics: DiagnosticContext;
    declare private reader: ChunkReader;
    declare private lenient: boolean;
    private readonly streams = new Map<number, AsfStream>();
    private readonly languages: string[] = [];
    /**
     * Extended stream properties by stream number; the header extension may precede the stream
     * properties.
     */
    declare private extended: Map<
        number,
        { languageIndex: number; extensions: number[]; frameDuration: number }
    >;
    declare private title: string | undefined;
    private preroll = 0;
    private playDuration = 0;
    private minPacketSize = 0;
    private maxPacketSize = 0;
    private declaredPackets = 0;
    private broadcast = false;
    private encrypted = false;

    /** Reports `code` with `message`, placed in the file or the stream by `at`. */
    private note(
        kind: 'warn' | 'recover',
        code: string,
        message: string,
        at?: { offset: number } | { trackId: number },
    ): void {
        this.diagnostics.note(kind, 'asf', code, message, at);
    }

    private check(): void {
        throwIfAborted(this.signal);
    }

    declare private aspect: { stream: number; name: string; value: number }[];
    private readStreamProperties(bytes: Uint8Array, start: number, end: number): void {
        demuxAssert(end - start >= 54, 'ASF stream properties object is truncated');
        const view = dataView(bytes);
        const mediaType = guidOf(bytes, start);
        const typeLength = view.getUint32(start + 40, true);
        const ecLength = view.getUint32(start + 44, true);
        const flags = view.getUint16(start + 48, true);
        const number = flags & 0x7f;
        demuxAssert(
            number > 0 && start + 54 + typeLength + ecLength <= end,
            'ASF stream properties are invalid',
        );
        if (this.streams.has(number)) return;
        demuxAssert(this.streams.size < MAX_STREAMS, 'ASF declares too many streams');

        const specific = bytes.subarray(start + 54, start + 54 + typeLength);
        const streamEncrypted = (flags & 0x8000) !== 0;
        if (mediaType === GUID.videoMedia) {
            demuxAssert(specific.length >= 11 + 40, 'ASF video stream lacks its BITMAPINFOHEADER');
            const width = new DataView(specific.buffer, specific.byteOffset, 4).getUint32(0, true);
            const height = new DataView(specific.buffer, specific.byteOffset + 4, 4).getUint32(
                0,
                true,
            );
            const formatSize = specific[9]! | (specific[10]! << 8);
            const bitmap = parseBitmapInfoHeader(
                specific.subarray(11, 11 + Math.max(40, formatSize)),
            );
            demuxAssert(bitmap, 'ASF video stream has a malformed BITMAPINFOHEADER');

            const stream: AsfStream = {
                number,
                type: 'video',
                codec: '',
                codecTag: bitmap.fourcc,
                width: width || bitmap.width,
                height: height || bitmap.height,
                sampleRate: 0,
                channelCount: 0,
                encrypted: streamEncrypted,
                payloadExtensions: [],
                samples: [],
                dropped: 0,
                reordered: 0,
            };

            this.identifyVideo(stream, bitmap.fourcc, bitmap.extradata);
            this.streams.set(number, stream);
        } else if (mediaType === GUID.audioMedia) {
            demuxAssert(specific.length >= 16, 'ASF audio stream lacks its WAVEFORMATEX');
            const stream: AsfStream = {
                number,
                type: 'audio',
                codec: '',
                width: 0,
                height: 0,
                sampleRate: 0,
                channelCount: 0,
                encrypted: streamEncrypted,
                payloadExtensions: [],
                samples: [],
                dropped: 0,
                reordered: 0,
            };
            this.identifyAudio(stream, specific);
            this.streams.set(number, stream);
        }
    }

    private readExtendedStreamProperties(bytes: Uint8Array, start: number, end: number): void {
        demuxAssert(end - start >= 64, 'ASF extended stream properties object is truncated');
        const view = dataView(bytes);
        const number = view.getUint16(start + 48, true);
        const languageIndex = view.getUint16(start + 50, true);
        const timePerFrame = Number(view.getBigUint64(start + 52, true));
        const nameCount = view.getUint16(start + 60, true);
        const extensionCount = view.getUint16(start + 62, true);

        let at = start + 64;
        for (let index = 0; index < nameCount; index++) {
            demuxAssert(at + 4 <= end, 'ASF stream name is truncated');
            at += 4 + view.getUint16(at + 2, true);
        }

        const extensions: number[] = [];
        for (let index = 0; index < extensionCount; index++) {
            demuxAssert(at + 22 <= end, 'ASF payload extension system is truncated');
            extensions.push(view.getUint16(at + 16, true));
            at += 22 + view.getUint32(at + 18, true);
        }

        demuxAssert(at <= end, 'ASF extended stream properties overrun their object');
        if (at + 24 <= end && guidOf(bytes, at) === GUID.streamProperties) {
            const embeddedSize = Number(view.getBigUint64(at + 16, true));
            demuxAssert(
                embeddedSize >= 24 && at + embeddedSize <= end,
                'ASF embedded stream properties invalid',
            );
            this.readStreamProperties(bytes, at + 24, at + embeddedSize);
        }
        this.extended.set(number, { languageIndex, extensions, frameDuration: timePerFrame / 1e7 });
    }

    private readObjects(bytes: Uint8Array, start: number, end: number, depth: number): void {
        const view = dataView(bytes);
        let at = start;
        let objects = 0;
        while (at + 24 <= end) {
            demuxAssert(++objects <= 4096, 'ASF header holds too many objects');
            const guid = guidOf(bytes, at);
            const objectSize = Number(view.getBigUint64(at + 16, true));
            demuxAssert(
                objectSize >= 24 && at + objectSize <= end,
                'ASF header object overruns the header',
            );
            const body = at + 24;
            const bodyEnd = at + objectSize;

            if (guid === GUID.fileProperties) {
                demuxAssert(objectSize >= 104, 'ASF file properties object is truncated');
                this.declaredPackets = Number(view.getBigUint64(body + 32, true));
                this.playDuration = Number(view.getBigUint64(body + 40, true)) / 1e7;
                this.preroll = Number(view.getBigUint64(body + 56, true)) / 1000;
                const flags = view.getUint32(body + 64, true);
                this.broadcast = (flags & 1) !== 0;
                this.minPacketSize = view.getUint32(body + 68, true);
                this.maxPacketSize = view.getUint32(body + 72, true);
            } else if (guid === GUID.streamProperties)
                this.readStreamProperties(bytes, body, bodyEnd);
            else if (guid === GUID.headerExtension && depth === 0) {
                demuxAssert(objectSize >= 46, 'ASF header extension object is truncated');
                this.readObjects(bytes, body + 22, bodyEnd, 1);
            } else if (guid === GUID.extendedStreamProperties)
                this.readExtendedStreamProperties(bytes, body, bodyEnd);
            else if (guid === GUID.contentDescription) {
                demuxAssert(objectSize >= 34, 'ASF content description object is truncated');
                this.title ??= utf16(bytes, body + 10, view.getUint16(body, true));
            } else if (guid === GUID.languageList) {
                const count = view.getUint16(body, true);
                let cursor = body + 2;
                for (let index = 0; index < count && cursor < bodyEnd; index++) {
                    const length = bytes[cursor]!;
                    this.languages.push(utf16(bytes, cursor + 1, length) ?? '');
                    cursor += 1 + length;
                }
            } else if (guid === GUID.metadata) {
                const count = view.getUint16(body, true);
                let cursor = body + 2;
                for (let index = 0; index < count && cursor + 12 <= bodyEnd; index++) {
                    const stream = view.getUint16(cursor + 2, true);
                    const nameLength = view.getUint16(cursor + 4, true);
                    const dataType = view.getUint16(cursor + 6, true);
                    const dataLength = view.getUint32(cursor + 8, true);
                    const name = utf16(bytes, cursor + 12, nameLength);
                    const dataAt = cursor + 12 + nameLength;
                    if (
                        (name === 'AspectRatioX' || name === 'AspectRatioY') &&
                        (dataType === 3 || dataType === 4 || dataType === 5) &&
                        dataAt + dataLength <= bodyEnd
                    ) {
                        const value =
                            dataType === 5
                                ? view.getUint16(dataAt, true)
                                : dataType === 3
                                  ? view.getUint32(dataAt, true)
                                  : Number(view.getBigUint64(dataAt, true));
                        this.aspect.push({ stream, name, value });
                    }
                    cursor = dataAt + dataLength;
                }
            } else if (guid === GUID.contentEncryption || guid === GUID.extendedContentEncryption)
                this.encrypted = true;

            at = bodyEnd;
        }
    }

    declare private fixedPacketSize: number;
    declare private packetsEnd: number;
    declare private damaged: number;
    declare private incomplete: boolean;
    // Packets that start with the standard error correction data (0x82 0 0) let a reader
    // find the next packet after damage that moved the packets, as ffmpeg finds it.
    private readonly signature = (bytes: Uint8Array, at: number): boolean =>
        bytes[at] === 0x82 && bytes[at + 1] === 0 && bytes[at + 2] === 0;
    declare private signed: boolean;
    /**
     * Where the packet after the damaged one at `offset` starts: where the packet size puts
     * it, or else the next error correction signature. Objects being assembled stay pending:
     * their fragments in later packets may still complete them.
     */
    private async damagedPacket(offset: number, message: string): Promise<number> {
        if (!this.lenient) throw new DemuxError(message);
        this.damaged++;
        if (this.damaged <= 8)
            this.note(
                'warn',
                'ASF_PACKET_DAMAGED',
                `${message}; resynchronized at the next packet`,
                { offset },
            );

        this.incomplete = true;
        const aligned = this.fixedPacketSize ? offset + this.fixedPacketSize : this.packetsEnd;
        if (!this.signed) return aligned;
        if (
            aligned + 3 <= this.packetsEnd &&
            this.signature(await this.reader.bytes(aligned, 3), 0)
        )
            return aligned;
        const from = offset + 1;
        const bytes = await this.reader.bytes(
            from,
            Math.max(0, Math.min(this.packetsEnd, from + RESYNC_SEARCH_BYTES) - from),
        );
        for (let at = 0; at + 3 <= bytes.length; at++)
            if (this.signature(bytes, at)) return from + at;
        return aligned;
    }

    constructor(
        signal: AbortSignal | undefined,
        budget: DemuxIndexBudget,
        maxPacketBytes: number,
        source: Source,
        diagnostics?: DiagnosticContext,
    ) {
        this.signal = signal;
        this.budget = budget;
        this.maxPacketBytes = maxPacketBytes;
        this.source = source;
        this.diagnostics = diagnostics ?? new DiagnosticContext({}, 'compatible');
    }

    async run(): Promise<DemuxResult> {
        this.reader = new ChunkReader(this.source);
        const size = this.reader.size;
        this.lenient = this.diagnostics.validation === 'compatible';
        demuxAssert(size >= HEADER_OBJECT_BYTES, 'ASF file is shorter than its header object');
        const head = await this.reader.bytes(0, HEADER_OBJECT_BYTES);
        const headView = dataView(head);
        demuxAssert(guidOf(head, 0) === GUID.header, 'Not an ASF file');
        const headerSize = Number(headView.getBigUint64(16, true));
        demuxAssert(
            headerSize >= HEADER_OBJECT_BYTES &&
                headerSize <= MAX_HEADER_BYTES &&
                headerSize <= size,
            'ASF header object size is invalid',
        );
        const header = await this.reader.bytes(0, headerSize);
        this.extended = new Map<
            number,
            { languageIndex: number; extensions: number[]; frameDuration: number }
        >();
        this.aspect = [];
        this.readObjects(header, HEADER_OBJECT_BYTES, headerSize, 0);
        demuxAssert(this.streams.size > 0, 'ASF header declares no audio or video stream');
        this.settleStreams();
        demuxAssert(headerSize + DATA_OBJECT_BYTES <= size, 'ASF data object is missing');
        const dataHead = await this.reader.bytes(headerSize, DATA_OBJECT_BYTES);
        const dataFields = dataView(dataHead);
        demuxAssert(
            guidOf(dataHead, 0) === GUID.data,
            'ASF header is not followed by its data object',
        );
        let dataSize = Number(dataFields.getBigUint64(16, true));
        const dataPackets = Number(dataFields.getBigUint64(40, true));
        const cut = dataSize >= DATA_OBJECT_BYTES && headerSize + dataSize > size;
        if (dataSize < DATA_OBJECT_BYTES || headerSize + dataSize > size) {
            this.note(
                'recover',
                'ASF_DATA_SIZE',
                dataSize < DATA_OBJECT_BYTES
                    ? 'ASF data object declares no size; reading packets to the end'
                    : 'ASF data object is cut by the end of the input; reading what remains',
            );
            dataSize = size - headerSize;
        }

        this.fixedPacketSize =
            this.minPacketSize === this.maxPacketSize && this.minPacketSize >= MIN_PACKET_BYTES
                ? this.minPacketSize
                : 0;
        demuxAssert(
            this.maxPacketSize >= MIN_PACKET_BYTES && this.maxPacketSize <= 16 * 1024 * 1024,
            'ASF maximum packet size is invalid',
        );
        this.packetsEnd = headerSize + dataSize;
        const readEnd = this.lenient ? size : this.packetsEnd;
        let pos = headerSize + DATA_OBJECT_BYTES;
        let packetCount = 0;
        this.damaged = 0;
        this.incomplete = false;
        this.signed =
            pos + 3 <= this.packetsEnd && this.signature(await this.reader.bytes(pos, 3), 0);
        while (pos + MIN_PACKET_BYTES <= this.packetsEnd) {
            if ((packetCount++ & 255) === 0) {
                this.check();
                await yieldEventLoop();
            }

            const next = await this.readPacket(pos, readEnd, size);
            if (next === undefined) break;
            pos = next;
        }

        this.check();
        if (this.damaged > 8)
            this.note(
                'warn',
                'ASF_PACKET_DAMAGED',
                `${this.damaged} damaged ASF packets were skipped in total`,
            );

        if (
            this.declaredPackets &&
            dataPackets &&
            !this.broadcast &&
            packetCount < Math.min(this.declaredPackets, dataPackets)
        )
            this.note(
                'warn',
                'ASF_PACKET_COUNT',
                `ASF declares ${dataPackets} data packets but ${packetCount} were read`,
            );

        const result: DemuxResult = {
            ...(this.title !== undefined ? { title: this.title } : {}),
            videoTracks: [],
            audioTracks: [],
        };

        const duration = cut ? 0 : Math.max(0, this.playDuration - this.preroll);
        for (const stream of this.streams.values()) {
            if (stream.pending) {
                this.abandon(stream, stream.pending, this.preroll);
                stream.pending = undefined;
            }

            if (stream.dropped) {
                this.note(
                    'recover',
                    'ASF_INCOMPLETE_OBJECT',
                    `${stream.dropped} incomplete media object(s) of ASF stream ` +
                        `${stream.number} were ` +
                        (stream.codec === 'wmalossless'
                            ? 'cut at their first missing fragment'
                            : 'dropped'),
                    { trackId: stream.number },
                );
                this.incomplete = true;
            }

            if (stream.reordered)
                this.note(
                    'recover',
                    'ASF_FRAGMENTS_REORDERED',
                    `Assembled ${stream.reordered} ASF media objects from fragments out of order`,
                    { trackId: stream.number },
                );

            if (stream.samples.length === 0) {
                if (this.streams.size === 1)
                    throw new DemuxError(
                        `ASF stream ${stream.number} holds no complete media objects`,
                    );
                this.note(
                    'warn',
                    'ASF_EMPTY_STREAM',
                    `ASF stream ${stream.number} holds no complete media objects; it is ` +
                        `omitted`,
                );
                continue;
            }

            this.finishTimes(stream, duration);
            const last = stream.samples[stream.samples.length - 1]!;
            const track: TrackInfo = {
                id: stream.number,
                codec: stream.codec,
                ...(stream.codecTag ? { codecTag: stream.codecTag } : {}),
                language: stream.language,
                width: stream.width,
                height: stream.height,
                ...(stream.pixelAspectRatioNum && stream.pixelAspectRatioDen
                    ? {
                          pixelAspectRatioNum: stream.pixelAspectRatioNum,
                          pixelAspectRatioDen: stream.pixelAspectRatioDen,
                          displayWidth: Math.round(
                              (stream.width * stream.pixelAspectRatioNum) /
                                  stream.pixelAspectRatioDen,
                          ),
                          displayHeight: stream.height,
                      }
                    : {}),
                sampleRate: stream.sampleRate,
                channelCount: stream.channelCount,
                duration: Math.max(duration, last.timestamp + last.duration),
                samples: stream.samples,
                codecConfig: stream.codecConfig,
                timescale: 1000,
                ...(this.incomplete ? { incomplete: true } : {}),
            };

            (stream.type === 'video' ? result.videoTracks : result.audioTracks).push(track);
        }

        demuxAssert(
            result.videoTracks.length + result.audioTracks.length > 0,
            'ASF holds no playable streams',
        );
        return result;
    }

    /**
     * Gives each stream what the header extension and metadata state about it, and leaves out
     * streams of unsupported codecs.
     */
    private settleStreams(): void {
        for (const stream of this.streams.values()) {
            const properties = this.extended.get(stream.number);
            if (properties) {
                stream.languageIndex = properties.languageIndex;
                stream.payloadExtensions = properties.extensions;
                if (properties.frameDuration > 0) stream.frameDuration = properties.frameDuration;
            }

            // The language list holds RFC 1766 tags; tracks state ISO 639-2 codes where one exists,
            // as MP4 does.
            if (stream.languageIndex !== undefined && this.languages[stream.languageIndex]) {
                const tag = this.languages[stream.languageIndex]!;
                stream.language = iso639Language(tag) ?? tag;
            }
            if (stream.type === 'video') {
                const x = this.aspect.find(
                    entry => entry.name === 'AspectRatioX' && entry.stream === stream.number,
                )?.value;
                const y = this.aspect.find(
                    entry => entry.name === 'AspectRatioY' && entry.stream === stream.number,
                )?.value;
                if (x && y) {
                    stream.pixelAspectRatioNum = x;
                    stream.pixelAspectRatioDen = y;
                }
            }
            if (stream.encrypted || this.encrypted)
                this.note(
                    'warn',
                    'ASF_ENCRYPTED',
                    `ASF stream ${stream.number} is DRM-protected and cannot be decoded`,
                    { trackId: stream.number },
                );
        }
        for (const [number, stream] of [...this.streams]) {
            if (stream.codec) continue;
            const codec = `${stream.type} codec ${stream.codecTag ?? ''}`.trim();
            const message = `ASF stream ${number} uses an unsupported ${codec}`;
            if (!this.lenient || this.streams.size === 1) throw new DemuxError(message);
            this.note('warn', 'ASF_UNSUPPORTED_STREAM', `${message}; it is omitted`);
            this.streams.delete(number);
        }
    }

    /**
     * Reads the packet at `packetStart` and the payloads it carries; returns where the next packet
     * starts, or undefined when reading ends (a packet cut by the end of the input).
     */
    private async readPacket(
        packetStart: number,
        readEnd: number,
        size: number,
    ): Promise<number | undefined> {
        const window = await this.reader.bytes(
            packetStart,
            Math.min(this.maxPacketSize + 4, readEnd - packetStart),
        );
        let at = 0;
        let flags = window[at++]!;
        if (flags & 0x80) {
            const ecLength = flags & 0x0f;
            if ((flags >> 5) & 3 || ecLength > window.length - 2) {
                return await this.damagedPacket(
                    packetStart,
                    `ASF packet at byte ${packetStart} has invalid error correction`,
                );
            }

            at += ecLength;
            flags = window[at++]!;
        }

        const property = window[at++]!;
        const field = (type: number): number => {
            if (type === 0) return 0;
            const width = type === 1 ? 1 : type === 2 ? 2 : 4;
            if (at + width > window.length) throw new RangeError('packet header truncated');
            const value =
                width === 1
                    ? window[at]!
                    : width === 2
                      ? window[at]! | (window[at + 1]! << 8)
                      : (window[at]! |
                            (window[at + 1]! << 8) |
                            (window[at + 2]! << 16) |
                            (window[at + 3]! << 24)) >>>
                        0;

            at += width;
            return value;
        };

        let packetLength: number;
        let padding: number;
        let multiple: boolean;
        let payloadLengthType = 0;
        let payloadCount = 1;
        try {
            packetLength = field((flags >> 5) & 3) || this.maxPacketSize;
            field((flags >> 1) & 3);
            padding = field((flags >> 3) & 3);
            at += 6;
            multiple = (flags & 1) !== 0;
            if (multiple) {
                const payloadFlags = window[at++]!;
                payloadCount = payloadFlags & 0x3f;
                payloadLengthType = payloadFlags >> 6;
            }

            if (at > window.length) throw new RangeError('packet header truncated');
        } catch {
            return await this.damagedPacket(
                packetStart,
                `ASF packet header at byte ${packetStart} is truncated`,
            );
        }

        // A packet cut by the end of the input with a sound header: its payloads are read up to
        // the cut, and the object the cut fragment belongs to keeps the bytes before the cut,
        // as ffmpeg reads it.
        const cutPacket =
            this.lenient &&
            packetStart + packetLength > size &&
            packetLength <= this.maxPacketSize &&
            property >> 6 === 1 &&
            packetLength >= at + padding &&
            payloadCount > 0;

        if (
            !cutPacket &&
            (property >> 6 !== 1 ||
                packetLength < at + padding ||
                packetLength > this.maxPacketSize ||
                packetStart + packetLength > readEnd ||
                payloadCount === 0)
        ) {
            if (
                packetStart + Math.min(packetLength, this.maxPacketSize) > readEnd &&
                packetLength <= this.maxPacketSize
            ) {
                if (this.lenient) {
                    this.note(
                        'warn',
                        'ASF_TRUNCATED',
                        `ASF packet at byte ${packetStart} is cut by the end of the ` +
                            `input; dropped`,
                        { offset: packetStart },
                    );
                    this.incomplete = true;
                    return undefined;
                }
                throw new DemuxError('ASF data packets are truncated');
            }
            return await this.damagedPacket(
                packetStart,
                `ASF packet at byte ${packetStart} has invalid length fields`,
            );
        }

        const payloadEnd = packetLength - padding;
        /** Where the payload bytes read end: the end of the payloads, or the cut. */
        const end = Math.min(payloadEnd, window.length);
        let broken = false;
        for (let payload = 0; payload < payloadCount && !broken; payload++) {
            if (at >= end) {
                broken = true;
                break;
            }

            const streamByte = window[at++]!;
            const keyframe = (streamByte & 0x80) !== 0;
            const stream = this.streams.get(streamByte & 0x7f);
            let objectNumber: number;
            let objectOffset: number;
            let replicated: number;
            try {
                objectNumber = field((property >> 4) & 3);
                objectOffset = field((property >> 2) & 3);
                replicated = field(property & 3);
            } catch {
                broken = true;
                break;
            }

            if (replicated === 1) {
                const timeDelta = window[at++]!;
                let length: number;
                try {
                    length = multiple ? field(payloadLengthType) : payloadEnd - at;
                } catch {
                    broken = true;
                    break;
                }

                if (at + length > end) {
                    broken = true;
                    break;
                }

                let presentation = objectOffset;
                let cursor = at;
                let subPayloads = 0;
                while (cursor < at + length) {
                    const subLength = window[cursor]!;
                    cursor++;
                    if (cursor + subLength > at + length) {
                        broken = true;
                        break;
                    }

                    if (stream && subLength > 0)
                        this.completeObject(
                            stream,
                            presentation,
                            keyframe,
                            [
                                {
                                    offset: packetStart + cursor,
                                    data: window.subarray(cursor, cursor + subLength),
                                },
                            ],
                            subLength,
                            this.preroll,
                        );

                    cursor += subLength;
                    presentation += timeDelta;
                    subPayloads++;
                }

                at += length;
                continue;
            }

            let objectSize = 0;
            let presentationTime = 0;
            if (replicated >= 8) {
                if (at + replicated > end) {
                    broken = true;
                    break;
                }

                objectSize = u32le(window, at);
                presentationTime =
                    (window[at + 4]! |
                        (window[at + 5]! << 8) |
                        (window[at + 6]! << 16) |
                        (window[at + 7]! << 24)) >>>
                    0;
                at += replicated;
            } else if (replicated !== 0) {
                broken = true;
                break;
            }

            let length: number;
            try {
                length = multiple ? field(payloadLengthType) : payloadEnd - at;
            } catch {
                broken = true;
                break;
            }

            if (length <= 0 || at + length > payloadEnd) {
                broken = true;
                break;
            }

            const data = window.subarray(at, Math.min(at + length, end));
            if (stream) {
                if (replicated === 0) objectSize = objectOffset + length;
                this.addFragment(
                    stream,
                    objectNumber,
                    objectOffset,
                    objectSize,
                    presentationTime,
                    keyframe,
                    packetStart + at,
                    data,
                    this.preroll,
                    this.lenient,
                    data.length < length,
                );
            }

            if (data.length < length) break;
            at += length;
        }

        if (cutPacket) {
            this.note(
                'warn',
                'ASF_TRUNCATED',
                `ASF packet at byte ${packetStart} is cut by the end of the input`,
                { offset: packetStart },
            );
            this.incomplete = true;
            return undefined;
        }

        if (broken) {
            return await this.damagedPacket(
                packetStart,
                `ASF packet at byte ${packetStart} has an inconsistent payload layout`,
            );
        }

        return packetStart + Math.max(packetLength, this.fixedPacketSize);
    }

    private identifyVideo(stream: AsfStream, fourcc: string, extradata: Uint8Array): void {
        const upper = fourcc.toUpperCase();
        const windowsMedia = windowsMediaVideoCodec(upper);
        if (windowsMedia) {
            stream.codec = windowsMedia;
            stream.codecConfig = extradata.length ? extradata : undefined;
            if (windowsMedia === 'vc1' && extradata.length >= 5 && extradata[3] === VC1_SEQUENCE) {
                const sequence = parseVc1SequenceHeader(extradata.subarray(4));
                if (sequence && (!stream.width || !stream.height)) {
                    stream.width = sequence.width;
                    stream.height = sequence.height;
                }
            }
            return;
        }

        if (/^(H264|X264|AVC1|DAVC)$/.test(upper)) {
            const record =
                extradata[0] === 1 && extradata.length >= 7
                    ? extradata
                    : isAnnexB(extradata)
                      ? (buildAvcCFromAnnexB(extradata) ?? undefined)
                      : undefined;
            stream.codec = record ? avcCodecString(record) : 'avc1';
            stream.codecConfig = record;
            stream.annexB = true;
            return;
        }

        if (/^(HEVC|H265|HVC1|HEV1|X265)$/.test(upper)) {
            const record =
                extradata[0] === 1 && extradata.length >= 23
                    ? extradata
                    : isAnnexB(extradata)
                      ? (buildHevcCFromAnnexB(extradata) ?? undefined)
                      : undefined;
            stream.codec = hevcCodecString('hev1', record);
            stream.codecConfig = record;
            stream.annexB = true;
            return;
        }

        if (upper === 'MJPG') {
            stream.codec = 'mjpeg';
            return;
        }

        if (/^(MP43|DIV3|DIV4|DIV5|DIV6|MPG3|AP41|COL1)$/.test(upper)) {
            stream.codec = 'msmpeg4v3';
            return;
        }

        if (/^(MP42|DIV2)$/.test(upper)) {
            stream.codec = 'msmpeg4v2';
            return;
        }

        if (/^(MPG4|MP41)$/.test(upper)) {
            stream.codec = 'msmpeg4v1';
            return;
        }

        const mpeg = vfwVideoCodec(upper);
        if (mpeg) {
            const family = mpegVideoFamily(mpeg);
            const config = extradata.length ? extradata : undefined;
            stream.codec =
                (family &&
                    config &&
                    parseMpegVideoConfig(family === 'mpeg4v' ? 'mpeg4' : 'mpeg12', config)
                        ?.codec) ||
                mpeg;
            stream.codecConfig = config;
        }
    }

    private identifyAudio(stream: AsfStream, format: Uint8Array): void {
        const wave = parseWaveFormatEx(format);
        if (!wave) return;
        stream.sampleRate = wave.sampleRate;
        stream.channelCount = wave.channels;
        stream.blockAlign = wave.blockAlign;
        stream.codecTag = `0x${wave.tag.toString(16).padStart(4, '0')}`;
        const windowsMedia = windowsMediaAudioCodec(wave.tag);
        if (windowsMedia) {
            stream.codec = windowsMedia;
            stream.codecConfig = normalizedWaveFormatEx(format);
            return;
        }

        // WAVE_FORMAT_EXTENSIBLE names multichannel AAC, AC-3 and E-AC-3 by its subformat GUID.
        const tag = waveFormatTag(format);
        if (tag === 0x55 || tag === 0x50) {
            stream.codec = tag === 0x55 ? 'mp3' : 'mp2';
            return;
        }
        if (tag === 0x2000 || tag === 0x2001 || tag === EAC3_WAVE_TAG) {
            stream.codec = compressedWaveCodec(tag)!;
            return;
        }
        if (tag === 0xff) {
            const extra = wave.tag === 0xfffe ? format.subarray(40) : wave.extra;
            const asc = extra.length ? parseAacAudioSpecificConfig(extra) : null;
            stream.codec = asc ? `mp4a.40.${asc.audioObjectType}` : 'mp4a.40.2';
            stream.codecConfig = asc ? extra.slice() : undefined;
            if (asc?.sampleRate) stream.sampleRate = asc.sampleRate;
            if (asc?.channelCount) stream.channelCount = asc.channelCount;
            return;
        }
        if (
            (wave.tag === 1 ||
                wave.tag === 3 ||
                wave.tag === 0xfffe ||
                wave.tag === 6 ||
                wave.tag === 7) &&
            format.length <= MAX_WAVE_FORMAT_BYTES
        ) {
            try {
                const pcm = parseWaveFormat(format);
                stream.codec = pcm.codec;
                stream.codecConfig = pcm.codecConfig;
            } catch {
                stream.codec = '';
            }
        }
    }

    private addFragment(
        stream: AsfStream,
        objectNumber: number,
        objectOffset: number,
        objectSize: number,
        presentationTime: number,
        keyframe: boolean,
        offset: number,
        data: Uint8Array,
        preroll: number,
        lenient: boolean,
        cut: boolean,
    ): void {
        checkPacketBytes(objectSize, this.maxPacketBytes, 'ASF media object');

        let pending = stream.pending;
        if (pending && (pending.number !== objectNumber || pending.next !== objectOffset)) {
            if (!lenient)
                throw new DemuxError(
                    `ASF stream ${stream.number} has a discontinuous media object`,
                );

            // A fragment of the same object out of order, as swapped packets leave it, takes its
            // place in the object, as ffmpeg places it; a repeated one is ignored.
            const end = objectOffset + data.length;
            const parts = pending.number === objectNumber ? pending.parts : [];
            if (parts.some(part => part.at === objectOffset && part.data.length === data.length))
                return;
            if (
                parts.length &&
                end <= pending.size &&
                parts.every(part => end <= part.at || objectOffset >= part.at + part.data.length)
            )
                pending.unordered = true;
            else {
                this.abandon(stream, pending, preroll);
                pending = undefined;
            }
        }

        if (!pending) {
            if (objectOffset !== 0) {
                stream.dropped++;
                return;
            }
            pending = {
                number: objectNumber,
                size: objectSize,
                presentationTime,
                keyframe,
                parts: [],
                received: 0,
                next: 0,
                unordered: false,
            };
        }

        if (objectOffset + data.length > pending.size) {
            if (!lenient)
                throw new DemuxError(`ASF stream ${stream.number} media object overflows its size`);
            this.abandon(stream, pending, preroll);
            stream.pending = undefined;
            return;
        }

        if (data.length) pending.parts.push({ offset, data, at: objectOffset });
        pending.received += data.length;
        pending.next = objectOffset + data.length;

        // The object a fragment cut by the end of the input belongs to keeps the bytes before the
        // cut when none is missing, as ffmpeg returns it; audio keeps its whole blocks, since no
        // decoder (nor a copy into AVI) takes part of one.
        const size =
            cut && this.contiguous(pending)
                ? this.wholeBlocks(stream, pending.received)
                : pending.size;
        if (pending.received < size || !pending.parts.length || !size) {
            stream.pending = pending;
            return;
        }

        stream.pending = undefined;
        if (pending.unordered) {
            pending.parts.sort((a, b) => a.at - b.at);
            stream.reordered++;
        }
        this.completeObject(
            stream,
            pending.presentationTime,
            pending.keyframe,
            size < pending.received ? leadingBytes(pending.parts, size) : pending.parts,
            size,
            preroll,
        );
    }

    /**
     * The bytes of `stream` that make whole blocks of `bytes`; all of them for video and WMA
     * Lossless, whose decoder reads frames across its packets and so decodes part of one.
     */
    private wholeBlocks(stream: AsfStream, bytes: number): number {
        const block =
            stream.type === 'audio' && stream.codec !== 'wmalossless'
                ? (stream.blockAlign ?? 1)
                : 1;
        return block > 1 ? bytes - (bytes % block) : bytes;
    }

    /**
     * Drops the incomplete object `pending` of `stream`; WMA Lossless keeps the bytes before its
     * first missing fragment, which its decoder reads in part, as ffmpeg's does.
     */
    private abandon(stream: AsfStream, pending: PendingObject, preroll: number): void {
        stream.dropped++;
        if (stream.codec !== 'wmalossless') return;
        const parts = [...pending.parts].sort((a, b) => a.at - b.at);
        let size = 0;
        for (const part of parts) if (part.at === size) size += part.data.length;
        if (size)
            this.completeObject(
                stream,
                pending.presentationTime,
                pending.keyframe,
                leadingBytes(parts, size),
                size,
                preroll,
            );
    }

    /** Whether the fragments of `pending` hold every byte of the object before the last one. */
    private contiguous(pending: PendingObject): boolean {
        const ends = pending.parts.map(part => part.at + part.data.length);
        return Math.max(...ends) === pending.received;
    }

    private completeObject(
        stream: AsfStream,
        presentationTime: number,
        keyframe: boolean,
        parts: { offset: number; data: Uint8Array }[],
        size: number,
        preroll: number,
    ): void {
        const timestamp = presentationTime / 1000 - preroll;
        const sample: Sample = {
            offset: parts[0]!.offset,
            size,
            timestamp,
            duration: 0,
            isKeyframe: stream.type === 'audio' ? true : keyframe,
        };

        if (parts.length > 1) {
            const data = new Uint8Array(size);
            let at = 0;
            for (const part of parts) {
                data.set(part.data, at);
                at += part.data.length;
            }
            sample.data = data;
            this.budget.reserveSamples(1, 256 + size, 'ASF sample index');
        } else this.budget.reserveSamples(1, 256, 'ASF sample index');

        if (stream.annexB) {
            const head = sample.data ?? parts[0]!.data;
            if (isAnnexB(head)) sample.nalUnitFormat = 'annexb';
        }

        stream.samples.push(sample);
    }

    /**
     * Durations follow the next presentation time of the stream; decode times restore order where
     * B-frames precede.
     */
    private finishTimes(stream: AsfStream, duration: number): void {
        const samples = stream.samples;
        const steps: number[] = [];
        for (let index = 1; index < samples.length; index++) {
            const step = samples[index]!.timestamp - samples[index - 1]!.timestamp;
            if (step > 0) steps.push(step);
        }
        steps.sort((a, b) => a - b);
        const typical =
            steps[steps.length >> 1] ??
            stream.frameDuration ??
            (stream.type === 'video' ? 1 / 25 : 0.02);

        let reordered = false;
        for (let index = 0; index < samples.length; index++) {
            const sample = samples[index]!;
            const next = samples[index + 1];
            const step = next ? next.timestamp - sample.timestamp : 0;
            sample.duration =
                step > 0
                    ? step
                    : next
                      ? typical
                      : Math.max(typical, Math.min(duration - sample.timestamp, typical * 2));
            if (index > 0 && sample.timestamp < samples[index - 1]!.timestamp) reordered = true;
        }

        if (!reordered) return;
        let clock = samples[0]!.timestamp;
        for (const sample of samples) {
            sample.decodeTimestamp = clock;
            sample.compositionTimeOffset = sample.timestamp - clock;
            sample.duration = typical;
            clock += typical;
        }
    }
}

/**
 * Microsoft Advanced Systems Format (.asf/.wmv/.wma) demuxer: header objects, data packets and
 * payload reassembly.
 */
export class AsfDemuxer extends PacketDemuxer {
    async demux(
        source: Source,
        diagnostics = new DiagnosticContext({}, 'compatible'),
    ): Promise<DemuxResult> {
        return new AsfDemuxRun(
            this.signal,
            this.budget,
            this.maxPacketBytes,
            source,
            diagnostics,
        ).run();
    }
}

/** The asf plugin's 'asf' reader, which its index loads on first use. */
export const asfReader: Reader = {
    read: (source, options) => new AsfDemuxer(options).demux(source, readerDiagnostics(options)),
    capabilities: HANDS_OVER,
};
