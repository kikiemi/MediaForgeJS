import type { TrackInfo } from '../../core/model/track';
import { u32, validateOggComments } from './comments';
import {
    vorbisCommentLanguage,
    vorbisCommentTags,
    vorbisCommentTitle,
} from '../metadata/vorbis-comment';
import type { AudioIndexContext } from '../audio-files/index-context';
import { DemuxError, MediaForgeError } from '../../core/errors/errors';
import { oggPageCrc32 } from './crc';
import { CHUNK_BYTES } from '../../core/io/sources/chunk-reader';
import { opusPacketFrames } from '../../core/codec-config/audio/opus-packet';
import { parseFlacFrameHeader, readFlacStreamInfo } from '../../core/codec-config/audio/flac-frame';
import {
    vorbisCodecConfig,
    vorbisModes,
    vorbisPacketBlockAt,
} from '../../core/codec-config/audio/vorbis-headers';
import { bindCompactSampleIndex } from '../../core/model/sample-index';
import { OggPacketIndex } from './packet-index';
import { checkPacketBytes } from '../shared/demux-budget';
import { asciiAt } from '../detection/head-bytes';

/**
 * A run of a packet's bytes on one page: file offsets `offset` to `end` of `page`, which starts at
 * `pageOffset`.
 */
interface Part {
    offset: number;
    end: number;
    page: Uint8Array;
    pageOffset: number;
}

function partBytes(part: Part): Uint8Array {
    return part.page.subarray(part.offset - part.pageOffset, part.end - part.pageOffset);
}

/** The runs of the packet being read, in records reused from packet to packet. */
class PacketParts {
    count = 0;
    private readonly runs: Part[] = [];

    get first(): Part {
        return this.runs[0]!;
    }

    clear(): void {
        this.count = 0;
    }

    /**
     * Adds the `lace` bytes at file offset `at` of `page`, continuing the last run when they follow
     * it.
     */
    add(at: number, lace: number, page: Uint8Array, pageOffset: number): void {
        const previous = this.count ? this.runs[this.count - 1]! : undefined;
        if (previous && previous.end === at) {
            previous.end += lace;
            return;
        }
        if (this.count >= 4096) throw new DemuxError('Ogg packet spans more than 4096 pages');
        if (this.count < this.runs.length) {
            const part = this.runs[this.count]!;
            part.offset = at;
            part.end = at + lace;
            part.page = page;
            part.pageOffset = pageOffset;
        } else this.runs.push({ offset: at, end: at + lace, page, pageOffset });
        this.count++;
    }

    /** The first byte of the packet, if it has one. */
    firstByte(): number | undefined {
        return this.count ? this.first.page[this.first.offset - this.first.pageOffset] : undefined;
    }

    /** The packet's `bytes` bytes in one array. */
    combine(bytes: number): Uint8Array {
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (let index = 0; index < this.count; index++) {
            const part = this.runs[index]!;
            data.set(partBytes(part), offset);
            offset += part.end - part.offset;
        }
        return data;
    }
}

/** Next 'OggS' capture pattern at or after `from`, scanning in bounded pages. */
export async function findOggPage(context: AudioIndexContext, from: number): Promise<number> {
    for (let base = from; base + 4 <= context.size;) {
        const bytes = await context.read(base, Math.min(65536, context.size - base));
        for (let index = 0; index + 4 <= bytes.length; index++) {
            if (
                bytes[index] === 0x4f &&
                bytes[index + 1] === 0x67 &&
                bytes[index + 2] === 0x67 &&
                bytes[index + 3] === 0x53
            )
                return base + index;
        }
        if (bytes.length < 4) break;
        base += bytes.length - 3;
        await context.checkpoint();
    }
    return -1;
}

/** Checks one Ogg FLAC header packet: a whole metadata block other than STREAMINFO. */
function validateFlacMetadataPacket(packet: Uint8Array): void {
    const type = packet[0]! & 0x7f;
    if (
        packet.length < 4 ||
        type === 0 ||
        type === 127 ||
        ((packet[1]! << 16) | (packet[2]! << 8) | packet[3]!) !== packet.length - 4
    )
        throw new DemuxError('Invalid Ogg FLAC metadata header packet');
}

/**
 * fLaC, STREAMINFO and the metadata blocks of the header packets, with the last-block flag on the
 * final one.
 */
function flacCodecConfig(headers: readonly Uint8Array[]): Uint8Array {
    const identification = headers[0]!;
    const blocks = [identification.subarray(13, 51), ...headers.slice(1)];
    const config = new Uint8Array(4 + blocks.reduce((sum, block) => sum + block.length, 0));
    config.set([0x66, 0x4c, 0x61, 0x43]);
    let at = 4;
    blocks.forEach((block, index) => {
        config.set(block, at);
        config[at] = (block[0]! & 0x7f) | (index === blocks.length - 1 ? 0x80 : 0);
        at += block.length;
    });
    return config;
}

function sameBytes(
    left: Uint8Array,
    right: Uint8Array,
    from = 0,
    to = Math.max(left.length, right.length),
): boolean {
    if (left.length < to || right.length < to) return false;
    for (let index = from; index < to; index++) if (left[index] !== right[index]) return false;
    return true;
}

/**
 * Whether a chained link's identification header decodes with the first link's configuration: Opus
 * may change only its pre-skip and informative input rate, Vorbis only its bitrate hints, FLAC its
 * block and frame bounds within the first link's maximum block size, and Speex nothing.
 */
function sameChainedIdentification(codec: string, first: Uint8Array, next: Uint8Array): boolean {
    if (first.length !== next.length) return false;
    if (codec === 'opus') return sameBytes(first, next, 0, 10) && sameBytes(first, next, 16);
    if (codec === 'vorbis') return sameBytes(first, next, 0, 16) && sameBytes(first, next, 28);
    if (codec !== 'flac') return sameBytes(first, next);
    const maxBlock = (packet: Uint8Array): number => (packet[19]! << 8) | packet[20]!;
    return (
        sameBytes(first, next, 0, 7) &&
        sameBytes(first, next, 9, 17) &&
        sameBytes(first, next, 27, 30) &&
        (first[30]! & 0xf0) === (next[30]! & 0xf0) &&
        maxBlock(next) <= maxBlock(first)
    );
}

/** Identification packets of the audio codecs read from Ogg. */
function audioIdentification(packet: Uint8Array): boolean {
    return (
        asciiAt(packet, 0, 'OpusHead') ||
        asciiAt(packet, 0, '\x01vorbis') ||
        asciiAt(packet, 0, '\x7fFLAC') ||
        asciiAt(packet, 0, 'fLaC') ||
        asciiAt(packet, 0, 'Speex   ')
    );
}

/** Speex identification header: 'Speex   ', version, then little-endian fields at fixed offsets. */
function speexHeader(packet: Uint8Array):
    | {
          rate: number;
          channels: number;
          frameSize: number;
          framesPerPacket: number;
          extraHeaders: number;
      }
    | undefined {
    if (packet.length < 80 || !asciiAt(packet, 0, 'Speex   ')) return undefined;
    return {
        rate: u32(packet, 36),
        channels: u32(packet, 48),
        frameSize: u32(packet, 56),
        framesPerPacket: u32(packet, 64),
        extraHeaders: u32(packet, 68),
    };
}

/** The identification headers of the codecs read from Ogg, in the order they are tried. */
const IDENTIFICATIONS: readonly {
    readonly codec: 'opus' | 'vorbis' | 'flac' | 'legacy-flac' | 'speex';
    matches(packet: Uint8Array): boolean;
}[] = [
    { codec: 'opus', matches: packet => asciiAt(packet, 0, 'OpusHead') },
    { codec: 'vorbis', matches: packet => asciiAt(packet, 0, '\x01vorbis') },
    { codec: 'flac', matches: packet => asciiAt(packet, 0, '\x7fFLAC') },
    { codec: 'legacy-flac', matches: packet => packet.length === 4 && asciiAt(packet, 0, 'fLaC') },
    { codec: 'speex', matches: packet => !!speexHeader(packet) },
];

/** The message of a chained link whose codec setup cannot continue the track. */
const CHAIN_CHANGES_CODEC = 'Chained Ogg streams change their codec or its parameters';

class OggAudioIndexer {
    // Fields the constructor or run assigns are declared, not defined: the output then holds no
    // placeholder definition for each.
    declare private readonly lenient: boolean;
    private offset = 0;
    declare private serial: number | undefined;
    private speexFrames = 0;
    private speexExtraHeaders = 0;
    private sequence = 0;
    private eos = false;
    private packetIndex = 0;
    private packetSize = 0;
    private continued = false;
    private readonly parts = new PacketParts();
    private codec = '';
    private sampleRate = 0;
    private channels = 0;
    private preSkip = 0;
    private opusStreams = 1;
    private smallBlock = 0;
    private largeBlock = 0;
    private previousBlock = 0;
    private firstAudioPage = true;
    private vorbisPriming = 0;
    /**
     * The first Vorbis page that anchored the timeline, until the next stamped page tells whether
     * the granules mark the end of each page's last packet (Vorbis I, A.2) or, as early muxers
     * wrote them, its start.
     */
    declare private anchor:
        | { readonly origin: number; readonly priming: number; readonly lastDuration: number }
        | undefined;
    private startStamped = false;
    private flacHeaderPackets = 0;
    private legacyFlac = false;
    private modes: readonly boolean[] = [];
    private frames = 0;
    private granule = 0;
    private bufferedBytes = 0;
    // Chained logical streams follow one another after an EOS page; they are read on one coded
    // timeline, so each later link maps its own granules onto it from linkBase.
    private link = 0;
    private linkBase = 0;
    private linkPreSkip = 0;
    private linkAudioPackets = 0;
    private linkEndGranule = 0;
    private joinedSamples = 0;
    private readonly headers: Uint8Array[] = [];
    private readonly packets = new OggPacketIndex();
    private ignoredGranule = false;
    private unstampedPage = false;
    private orphan = false;
    declare private language: string | undefined;
    private recovered = false;
    private skippedPage = false;
    private droppedPages = 0;
    /**
     * Logical streams other than the audio one, which compatible validation leaves out of a
     * multiplexed file.
     */
    private readonly omitted = new Set<number>();

    constructor(
        private readonly context: AudioIndexContext,
        private readonly requireOpus: boolean,
        private readonly wantedSerial?: number,
    ) {
        this.lenient = context.diagnostics.validation === 'compatible';
    }

    /** Damage read past in compatible validation, which leaves the track incomplete. */
    private damaged(code: string, message: string): void {
        this.note(code, message, true);
        this.recovered = true;
    }

    /** A warning, or with `recovered` a recovery, about the page at the offset. */
    private note(code: string, message: string, recovered = false): void {
        const diagnostic = { code, format: 'ogg', offset: this.offset, message };
        if (recovered) this.context.diagnostics.recover(diagnostic);
        else this.context.diagnostics.warn(diagnostic);
    }

    /** A damaged page is dropped; the packet it was continuing is abandoned. */
    private skipPage(size: number, code: string, message: string): void {
        this.damaged(code, message);
        this.parts.clear();
        this.packetSize = 0;
        this.continued = false;
        this.skippedPage = true;
        this.droppedPages++;
        this.offset += size;
    }

    private async chainStart(at: number): Promise<boolean> {
        const next = this.context.size - at >= 27 ? await this.context.read(at, 27) : undefined;
        return !!next && asciiAt(next, 0, 'OggS') && next[5] === 2 && u32(next, 18) === 0;
    }

    /** Offset where the current link began, and whether the link before it ended with EOS. */
    private linkOffset = 0;
    private linkAfterEos = false;
    private restoreLinkedCodec = (): void => {};
    private startLink(): void {
        const saved = [
            this.codec,
            this.sampleRate,
            this.channels,
            this.preSkip,
            this.opusStreams,
            this.smallBlock,
            this.largeBlock,
        ] as const;
        const savedFlac = [
            this.flacHeaderPackets,
            this.legacyFlac,
            this.speexFrames,
            this.speexExtraHeaders,
            this.modes,
        ] as const;
        this.restoreLinkedCodec = () => {
            [
                this.codec,
                this.sampleRate,
                this.channels,
                this.preSkip,
                this.opusStreams,
                this.smallBlock,
                this.largeBlock,
            ] = saved;
            [
                this.flacHeaderPackets,
                this.legacyFlac,
                this.speexFrames,
                this.speexExtraHeaders,
                this.modes,
            ] = savedFlac;
        };

        this.link++;
        this.linkOffset = this.offset;
        this.linkAfterEos = this.eos;
        this.serial = undefined;
        this.sequence = 0;
        this.eos = false;
        this.packetIndex = 0;
        this.linkAudioPackets = 0;
        this.linkEndGranule = this.granule;
        this.linkBase = this.frames;
        this.firstAudioPage = false;
        this.parts.clear();
        this.packetSize = 0;
        this.continued = false;
        this.orphan = false;
    }

    /**
     * Compatible reading keeps the links before one whose codec setup cannot continue the track,
     * and ends there (false).
     */
    private unchainable(message: string): false {
        if (!this.lenient || this.link === 0)
            throw new DemuxError(message, {
                hint: 'Split the chained links and convert them separately.',
            });
        this.eos = this.linkAfterEos;
        this.link--;
        this.restoreLinkedCodec();
        this.damaged(
            'OGG_CHAIN_OMITTED',
            `${message}; ignored the link at byte ${this.linkOffset} and after`,
        );
        return false;
    }

    // Pages come from windows that end where the input's read chunks do, so most need no read or
    // copy of their own.
    private window: Uint8Array = new Uint8Array(0);
    private windowStart = 0;
    /** The bytes when the window holds them, so a page read from it waits for nothing. */
    private windowed(at: number, length: number): Uint8Array | undefined {
        const from = at - this.windowStart;
        return from >= 0 && from + length <= this.window.length
            ? this.window.subarray(from, from + length)
            : undefined;
    }

    private async bytesAt(at: number, length: number): Promise<Uint8Array> {
        const from = at - this.windowStart;
        if (from >= 0 && from + length <= this.window.length)
            return this.window.subarray(from, from + length);
        const chunkEnd = Math.min(
            this.context.size,
            (Math.floor(at / CHUNK_BYTES) + 1) * CHUNK_BYTES,
        );
        this.window = await this.context.read(at, Math.max(length, chunkEnd - at));
        this.windowStart = at;
        return this.window.subarray(0, length);
    }

    /** The lacing values the input holds of the page at the offset, and the page size they give. */
    private async lacing(header: Uint8Array): Promise<[Uint8Array, number]> {
        const at = this.offset + 27;
        const laces = Math.min(header[26]!, this.context.size - at);
        const lacing = this.windowed(at, laces) ?? (await this.bytesAt(at, laces));
        let size = 27 + lacing.length;
        for (const lace of lacing) size += lace;
        return [lacing, size];
    }

    /** Whether the end of the input cuts the page at the offset, which is then reported. */
    private cut(header: Uint8Array, lacing: Uint8Array, size: number): boolean {
        if (lacing.length === header[26] && size <= this.context.size - this.offset) return false;
        this.damaged(
            'OGG_TRUNCATED',
            `Ogg page at byte ${this.offset} is cut by the end of the input; ignored`,
        );
        return true;
    }

    // Tallies of the page being read.
    private body = 0;
    private completed = 0;
    private audioOnPage = 0;
    private pageFrames = 0;
    private emptyEos = false;
    /**
     * A header packet of the link (identification, comments, setup or FLAC metadata) completed at
     * `segment` of the page; false when it ends the reading (a link that cannot be chained).
     */
    private headerPacket(
        segment: number,
        lacing: Uint8Array,
        firstPage: boolean,
        flacMetadata: boolean,
        headerCount: number,
    ): boolean {
        if (this.packetIndex === 0) {
            const packet = this.parts.combine(this.packetSize);
            const linkedCodec = this.codec;
            const linkedPreSkip = this.preSkip;
            this.legacyFlac = false;
            this.identify(packet);
            if (this.link === 0) {
                if (!this.legacyFlac) this.headers.push(packet);
            } else {
                this.linkPreSkip = this.preSkip;
                this.preSkip = linkedPreSkip;
                if (
                    this.codec !== linkedCodec ||
                    (!this.legacyFlac &&
                        !sameChainedIdentification(this.codec, this.headers[0]!, packet))
                )
                    return this.unchainable(CHAIN_CHANGES_CODEC);
            }
            if (!firstPage || segment !== lacing.length - 1)
                throw new DemuxError('Ogg identification header must be alone on the BOS page');
        } else if (flacMetadata && this.legacyFlac && this.packetIndex === 1) {
            const packet = this.parts.combine(this.packetSize);
            if (
                packet.length !== 38 ||
                (packet[0]! & 0x7f) !== 0 ||
                packet[1] !== 0 ||
                packet[2] !== 0
            )
                throw new DemuxError('Legacy Ogg FLAC must follow its fLaC marker with STREAMINFO');
            ({ sampleRate: this.sampleRate, channels: this.channels } = readFlacStreamInfo(
                packet.subarray(4),
            ));
            if (this.sampleRate < 1 || this.sampleRate > 768000)
                throw new DemuxError('Unsupported Ogg FLAC sample rate');

            // The identification packet of the current mapping, so both mappings share one
            // configuration.
            const identification = new Uint8Array(51);
            identification.set([0x7f, 0x46, 0x4c, 0x41, 0x43, 1, 0, 0, 0, 0x66, 0x4c, 0x61, 0x43]);
            identification.set(packet, 13);
            if (this.link === 0) this.headers.push(identification);
            else if (!sameChainedIdentification(this.codec, this.headers[0]!, identification))
                return this.unchainable(CHAIN_CHANGES_CODEC);
        } else if (flacMetadata) {
            const packet = this.parts.combine(this.packetSize);
            validateFlacMetadataPacket(packet);
            if ((packet[0]! & 0x7f) === 4 && this.context.metadata.title === undefined) {
                this.context.metadata.title = vorbisCommentTitle(packet.subarray(4));
                this.context.metadata.tags ??= vorbisCommentTags(packet.subarray(4));
            }
            // The comment block names the stream's language as Opus and Vorbis comments do.
            if ((packet[0]! & 0x7f) === 4 && this.link === 0)
                this.language = vorbisCommentLanguage(packet.subarray(4));
            if (this.link === 0) this.headers.push(packet);
            if (this.packetIndex === this.flacHeaderPackets && segment !== lacing.length - 1)
                throw new DemuxError('Ogg audio packets must begin on a page after codec headers');
        } else if (this.codec !== 'flac' && this.packetIndex < headerCount) {
            const packet = this.parts.combine(this.packetSize);
            if (this.codec === 'speex') {
                if (this.packetIndex === 1)
                    this.context.metadata.title ??= vorbisCommentTitle(packet);
            } else if (this.packetIndex === 1) {
                validateOggComments(packet, this.codec === 'opus');
                if (this.link === 0) {
                    // Another logical stream of the file may have named it; a stream without a
                    // title keeps that.
                    const comments = packet.subarray(this.codec === 'opus' ? 8 : 7);
                    const { metadata } = this.context;
                    const title = vorbisCommentTitle(comments);
                    if (title !== undefined) metadata.title = title;
                    metadata.tags = vorbisCommentTags(comments) ?? metadata.tags;
                    this.language = vorbisCommentLanguage(comments);
                }
            } else {
                if (!asciiAt(packet, 0, '\x05vorbis'))
                    throw new DemuxError('Missing Vorbis setup header');

                // Packets of a later link decode with the first link's codebooks only when the
                // setup is identical.
                if (this.link > 0 && !sameBytes(packet, this.headers[2]!))
                    return this.unchainable(
                        'Chained Ogg Vorbis streams use different setup headers',
                    );
                this.modes = vorbisModes(packet, this.channels);
            }
            if (this.link === 0) this.headers.push(packet);
            if (this.packetIndex === headerCount - 1 && segment !== lacing.length - 1)
                throw new DemuxError('Ogg audio packets must begin on a page after codec headers');
        }
        return true;
    }

    /** An audio packet completed on the page: its duration and time, appended to the packets. */
    private audioPacket(flags: number, lacing: Uint8Array, rawGranule: number | null): void {
        if (!this.packetSize) {
            if (
                this.codec !== 'vorbis' ||
                flags !== 4 ||
                lacing.length !== 1 ||
                !this.packets.length ||
                rawGranule === null ||
                rawGranule + this.linkBase !== this.granule ||
                this.granule !== this.frames
            )
                throw new DemuxError('Empty Ogg audio packet');
            this.note(
                'OGG_VORBIS_EMPTY_EOS',
                'Ignoring an empty Vorbis EOS marker at the unchanged final granule',
                true,
            );
            this.emptyEos = true;
            return;
        }
        this.context.budget.reserveSamples(1, 256, 'Ogg sample index');
        let data: Uint8Array | undefined;
        if (this.parts.count > 1) {
            if (this.packetSize > 64 * 1024 * 1024 - this.bufferedBytes)
                throw new MediaForgeError(
                    'Reassembled Ogg packet storage exceeds 64 MiB; split or remux the source',
                    'OOM',
                );
            data = this.parts.combine(this.packetSize);
            this.bufferedBytes += this.packetSize;
        }
        const first = this.parts.first;
        let duration: number;
        let timestamp = this.frames;

        // The first Vorbis packet only primes the overlap: it ends where the timeline starts.
        let priming = false;
        if (this.codec === 'opus') {
            duration = opusPacketFrames(
                data ?? partBytes(first),
                this.packetSize,
                this.opusStreams === 1,
            );
            timestamp -= this.preSkip;
        } else if (this.codec === 'flac') {
            const bytes = data ?? partBytes(first);
            const head =
                bytes.length >= 16 || this.parts.count < 2
                    ? bytes
                    : this.parts.combine(this.packetSize);
            const frame = parseFlacFrameHeader(head, 0);
            if (!frame)
                throw new DemuxError('Ogg FLAC packet does not start with a valid frame header');
            if (!this.headers.length)
                throw new DemuxError('Ogg FLAC audio precedes its STREAMINFO');
            duration = frame.blockSize;
        } else if (this.codec === 'speex') duration = this.speexFrames;
        else {
            const { modes, smallBlock, largeBlock, previousBlock } = this;
            const block = data
                ? vorbisPacketBlockAt(data, 0, data.length, modes, smallBlock, largeBlock)
                : vorbisPacketBlockAt(
                      first.page,
                      first.offset - first.pageOffset,
                      this.packetSize,
                      modes,
                      smallBlock,
                      largeBlock,
                  );
            priming = previousBlock === 0;
            duration = priming ? block / 2 : (previousBlock + block) / 4;
            if (priming) timestamp = -duration;
            this.previousBlock = block;
        }
        if (!priming) {
            this.frames += duration;
            this.pageFrames += duration;
        }

        // A later Vorbis link's first packet overlaps the previous link's last block and starts
        // its granules.
        if (this.codec === 'vorbis' && this.link > 0 && !this.linkAudioPackets)
            this.linkBase = this.frames;
        if (this.link > 0 && !this.linkAudioPackets)
            this.joinedSamples +=
                this.linkBase -
                this.linkEndGranule +
                (this.codec === 'opus' ? this.linkPreSkip : 0);
        this.linkAudioPackets++;
        if (!Number.isSafeInteger(this.frames))
            throw new DemuxError('Ogg sample count exceeds exact integer range');
        this.packets.push(
            first.offset,
            this.packetSize,
            data,
            timestamp / this.sampleRate,
            duration / this.sampleRate,
        );
        this.audioOnPage++;
    }

    /** Reads the segments of a page from `body`; false when a packet ends the reading. */
    private readSegments(
        page: Uint8Array,
        lacing: Uint8Array,
        flags: number,
        rawGranule: number | null,
        firstPage: boolean,
    ): boolean {
        for (let segment = 0; segment < lacing.length; segment++) {
            const lace = lacing[segment]!;
            this.packetSize += lace;
            checkPacketBytes(this.packetSize, this.context.maxPacketBytes, 'Ogg packet');
            if (lace) this.parts.add(this.offset + this.body, lace, page, this.offset);
            this.body += lace;
            this.continued = lace === 255;
            if (this.continued) continue;
            this.completed++;
            if (this.orphan) {
                this.orphan = false;
                this.parts.clear();
                this.packetSize = 0;
                continue;
            }
            const headerCount =
                this.codec === 'opus'
                    ? 2
                    : this.codec === 'flac'
                      ? 1 + this.flacHeaderPackets
                      : this.codec === 'speex'
                        ? 2 + this.speexExtraHeaders
                        : 3;

            // An Ogg FLAC header count of zero means unknown: metadata packets precede the first
            // frame (sync 0xFF).
            const flacMetadata =
                this.codec === 'flac' &&
                this.packetIndex > 0 &&
                (this.flacHeaderPackets
                    ? this.packetIndex < headerCount
                    : !this.linkAudioPackets && this.parts.firstByte() !== 0xff);
            if (
                this.packetIndex === 0 ||
                flacMetadata ||
                (this.codec !== 'flac' && this.packetIndex < headerCount)
            ) {
                if (!this.headerPacket(segment, lacing, firstPage, flacMetadata, headerCount))
                    return false;
            } else this.audioPacket(flags, lacing, rawGranule);
            this.packetIndex++;
            this.packetSize = 0;
            this.parts.clear();
        }
        return true;
    }

    /**
     * Checks the page's flags and granule once its segments are read and settles the timeline they
     * state.
     */
    private settlePage(flags: number, rawGranule: number | null, firstPage: boolean): void {
        if (firstPage && (this.packetIndex !== 1 || this.continued))
            throw new DemuxError('Ogg BOS page must contain one complete identification header');
        this.eos = (flags & 4) !== 0;
        if (this.eos && (this.continued || (!this.audioOnPage && !this.emptyEos)))
            throw new DemuxError('Ogg EOS must complete audio packets');
        if (!this.completed) {
            // Early Vorbis encoders stamp pages that complete no packet with the granule reached so
            // far; compatible reading ignores it, as nothing on the page ends there.
            if (rawGranule !== null && !this.lenient)
                throw new DemuxError(
                    'Ogg page without a completed packet must use an unknown granule',
                );
            if (rawGranule !== null && !this.ignoredGranule) {
                this.ignoredGranule = true;
                this.note(
                    'OGG_GRANULE_WITHOUT_PACKET',
                    'Ignoring granules of Ogg pages that complete no packet',
                    true,
                );
            }
        } else if (this.emptyEos) {
        } else if (!this.audioOnPage) {
            // A page that completes only the rest of a packet whose start was lost times nothing;
            // ogmtools stamped the header pages after the first with an unknown granule.
            if (this.linkAudioPackets > 0) {
                if (!this.lenient) throw new DemuxError('Ogg audio page completes no audio packet');
            } else if (rawGranule === null && this.lenient)
                this.note(
                    'OGG_HEADER_GRANULE',
                    `Ogg header page at byte ${this.offset} has an unknown granule; read as zero`,
                );
            else if (rawGranule !== 0)
                throw new DemuxError('Ogg header page must have granule zero');
        } else {
            let pageGranule = rawGranule === null ? null : rawGranule + this.linkBase;
            const lastOnPage = Math.round(
                this.packets.durationAt(this.packets.length - 1) * this.sampleRate,
            );
            const shiftSamples = (shift: number): void => {
                if (!shift) return;
                this.packets.shift(0, shift / this.sampleRate);
                this.frames += shift;
            };
            if (
                this.firstAudioPage &&
                this.droppedPages &&
                pageGranule !== null &&
                pageGranule > this.frames
            ) {
                // After missing pages (a stream recorded from its middle) the granules count from
                // an unseen start; the link's timeline starts at its first packet read.
                this.linkBase -= pageGranule - this.frames;
                pageGranule = this.frames;
            }
            if (
                this.firstAudioPage &&
                this.codec === 'vorbis' &&
                pageGranule !== null &&
                (this.packets.length >= 2 || pageGranule > 0)
            ) {
                const priming = Math.round(this.packets.durationAt(0) * this.sampleRate);

                // A first audio page carrying EOS has no earlier granule anchor.
                const origin = this.eos ? priming : pageGranule - this.frames;

                // Vorbis I, A.2 permits a positive stream origin or leading sample trim.
                // Negative origins cannot discard more than the first overlap-add span.
                const firstOverlap = Math.round(
                    (this.packets.length > 1 ? this.packets.durationAt(1) : 0) * this.sampleRate,
                );
                if (origin < -firstOverlap)
                    throw new DemuxError(
                        'Initial Vorbis granule trims beyond the first overlap-add span',
                    );
                this.vorbisPriming = priming + Math.max(0, -origin);
                shiftSamples(origin);
                if (!this.eos) this.anchor = { origin, priming, lastDuration: lastOnPage };
            } else if (
                this.firstAudioPage &&
                pageGranule !== null &&
                (this.codec === 'speex' || (this.codec === 'opus' && pageGranule > this.frames)) &&
                !this.eos &&
                !this.droppedPages
            ) {
                // The first audio page's granule places its packets: a stream that starts before
                // zero (an encoder's look-ahead) or later than zero keeps the timeline its granules
                // state. An Opus stream may start later than zero, as one FFmpeg joins from files
                // does.
                shiftSamples(pageGranule - this.frames);
            } else if (
                this.anchor &&
                pageGranule !== null &&
                lastOnPage !== this.anchor.lastDuration
            ) {
                // The first stamped page whose last packet lasts otherwise decides (before it, both
                // readings agree): granules one packet behind the decoded samples, consistently
                // from the anchor, mark packet starts, and the timeline then starts where the
                // anchor page's last packet does.
                const { origin, priming, lastDuration } = this.anchor;
                this.anchor = undefined;
                if (
                    pageGranule !== this.frames &&
                    pageGranule + lastOnPage === this.frames + lastDuration
                ) {
                    this.startStamped = true;
                    shiftSamples(lastDuration);
                    this.vorbisPriming = priming + Math.max(0, -origin - lastDuration);
                    this.note(
                        'OGG_VORBIS_START_GRANULES',
                        'Ogg Vorbis granules mark packet starts; kept the decoded timing',
                    );
                }
            }
            if (this.startStamped && pageGranule !== null) pageGranule += lastOnPage;
            if (this.codec !== 'vorbis' || this.packets.length >= 2 || (pageGranule ?? 0) > 0)
                this.firstAudioPage = false;
            if (
                this.codec === 'vorbis' &&
                !this.eos &&
                pageGranule !== null &&
                pageGranule >= this.granule &&
                Math.abs(pageGranule - this.frames) === 1
            ) {
                this.note(
                    'OGG_VORBIS_GRANULE_ROUNDING',
                    'Normalizing a one-sample Vorbis page granule rounding discrepancy',
                    true,
                );

                // Keep the block-derived timeline; do not accumulate page rounding errors.
                this.granule = this.frames;
                return;
            }
            if (
                pageGranule !== null &&
                pageGranule > this.frames &&
                this.lenient &&
                (this.packets.length > this.audioOnPage || this.droppedPages)
            ) {
                // Dropped pages leave a hole; the surviving page's granule places its packets on
                // the timeline.
                const hole = pageGranule - this.frames;
                this.damaged(
                    'OGG_AUDIO_HOLE',
                    `Ogg audio skips ${hole} samples before byte ${this.offset}`,
                );
                this.packets.shift(this.packets.length - this.audioOnPage, hole / this.sampleRate);
                this.frames += hole;
            }
            if (
                pageGranule !== null &&
                pageGranule >= this.granule &&
                pageGranule < this.frames &&
                this.lenient &&
                !this.eos
            ) {
                // Damaged packet headers change the coded frame count; the page granule is the
                // stated timeline.
                this.damaged(
                    'OGG_GRANULE_MISMATCH',
                    `Ogg page at byte ${this.offset} disagrees with its granule; following it`,
                );
                this.frames = pageGranule;
            }
            if (pageGranule === null && this.lenient && !this.eos) {
                // Early Vorbis encoders leave some audio pages unstamped; their packets keep the
                // coded timeline.
                if (!this.unstampedPage) {
                    this.unstampedPage = true;
                    this.note(
                        'OGG_GRANULE_MISSING',
                        'Ogg audio pages without a granule keep the timeline their packets code',
                        true,
                    );
                }
                return;
            }
            if (pageGranule === null || pageGranule < this.granule || pageGranule > this.frames)
                throw new DemuxError(
                    'Ogg audio granule is missing, regresses, or exceeds coded duration',
                );
            if (!this.eos && pageGranule !== this.frames)
                throw new DemuxError(
                    'Ogg audio with a start offset or holes is not supported here',
                );
            if (this.eos && this.frames - pageGranule > this.pageFrames)
                throw new DemuxError('Ogg EOS trims audio before the final page');
            this.granule = pageGranule;
        }
    }

    async run(): Promise<TrackInfo> {
        let pages = 0;
        while (this.offset < this.context.size) {
            if ((pages++ & 127) === 0) await this.context.checkpoint();
            if (!(await this.readPage())) break;
        }
        return this.finishTrack();
    }

    /** Reads the page at the offset, or skips the bytes in its place; false when reading ends. */
    private async readPage(): Promise<boolean> {
        if (this.eos && !(await this.continueChain())) return false;
        if (this.context.size - this.offset < 27) {
            this.damaged(
                'OGG_TRUNCATED',
                `Ignored ${this.context.size - this.offset} trailing bytes that do not hold an ` +
                    `Ogg page`,
            );
            return false;
        }
        const header = this.windowed(this.offset, 27) ?? (await this.bytesAt(this.offset, 27));
        if (!asciiAt(header, 0, 'OggS') || header[4] !== 0 || (header[5]! & 0xf8) !== 0) {
            if (!this.lenient || this.serial === undefined)
                throw new DemuxError(`Invalid Ogg page header at ${this.offset}`);
            const next = await findOggPage(this.context, this.offset + 1);
            if (next < 0) {
                this.damaged(
                    'OGG_TRUNCATED',
                    `Ignored ${this.context.size - this.offset} damaged bytes after byte ` +
                        `${this.offset}`,
                );
                return false;
            }
            this.skipPage(
                next - this.offset,
                'OGG_RESYNCHRONIZED',
                `Skipped ${next - this.offset} damaged bytes at byte ${this.offset}`,
            );
            return true;
        }
        const flags = header[5]!;
        const pageSerial = u32(header, 14);
        const pageSequence = u32(header, 18);
        if (this.wantedSerial !== undefined && pageSerial !== this.wantedSerial) {
            const [laces, skipped] = await this.lacing(header);
            if (this.cut(header, laces, skipped)) return false;
            this.offset += skipped;
            return true;
        } else if (
            this.wantedSerial === undefined &&
            this.lenient &&
            (this.omitted.has(pageSerial) ||
                (this.serial !== undefined && pageSerial !== this.serial) ||
                (this.serial === undefined && flags === 2))
        ) {
            const [segments, size] = await this.lacing(header);
            const audio =
                this.serial === undefined &&
                !this.omitted.has(pageSerial) &&
                audioIdentification(
                    await this.bytesAt(
                        this.offset + 27 + segments.length,
                        Math.min(8, size - 27 - segments.length),
                    ),
                );
            if (!audio) {
                if (!this.omitted.has(pageSerial)) {
                    this.omitted.add(pageSerial);
                    this.note(
                        'OGG_STREAM_OMITTED',
                        `Ogg logical stream ${pageSerial} is not the audio stream read; ` +
                            `its pages are skipped`,
                    );
                }
                if (size > this.context.size - this.offset) return false;
                this.offset += size;
                return true;
            }
        }
        const firstPage = this.serial === undefined;
        if (firstPage) {
            if (flags !== 2 || pageSequence !== 0)
                throw new DemuxError('Ogg audio must start with a sequence-zero BOS page');
            this.serial = pageSerial;
        } else if (pageSerial !== this.serial)
            throw new DemuxError('Multiplexed Ogg streams are not supported', {
                hint: 'Split out one audio stream first.',
            });
        else if (flags & 2) {
            if (!this.lenient || flags !== 2 || pageSequence !== 0 || this.packetIndex === 0)
                throw new DemuxError('Unexpected repeated Ogg BOS page');

            // A BOS page of the same serial starts a chained link whose preceding EOS page was
            // lost.
            this.damaged(
                'OGG_MISSING_EOS',
                `Ogg link ends without an EOS page before the BOS page at byte ${this.offset}`,
            );
            this.startLink();
            return true;
        }
        const behind = (this.sequence - pageSequence) >>> 0;
        if (this.lenient && behind > 0 && behind < 64) {
            // A page the stream already passed (a copy repeated, or moved, by damage) carries
            // nothing new.
            const [lacing, size] = await this.lacing(header);
            if (this.cut(header, lacing, size)) return false;
            this.damaged(
                'OGG_PAGE_REPEATED',
                `Ignored Ogg page ${pageSequence} repeated at byte ${this.offset}`,
            );
            this.offset += size;
            return true;
        }
        if (pageSequence !== this.sequence) {
            if (!this.skippedPage && !this.lenient)
                throw new DemuxError(`Ogg page sequence discontinuity at ${this.offset}`);

            // Pages missing from the input (a stream recorded from its middle) are a gap like
            // skipped damage.
            if (!this.skippedPage) {
                this.skippedPage = true;
                this.droppedPages++;
            }
            this.damaged(
                'OGG_PAGE_GAP',
                `Ogg page sequence jumps from ${this.sequence} to ${pageSequence} at byte ` +
                    `${this.offset}`,
            );
            this.sequence = pageSequence;
        }
        this.sequence = (this.sequence + 1) >>> 0;
        if (((flags & 1) !== 0) !== this.continued) {
            if (!this.skippedPage)
                throw new DemuxError('Ogg packet continuation flag is inconsistent');
            this.parts.clear();
            this.packetSize = 0;
            this.continued = (flags & 1) !== 0;

            // The rest of a packet whose start was lost is dropped once it completes.
            this.orphan = this.continued;
        }
        const [lacing, pageSize] = await this.lacing(header);
        if (this.cut(header, lacing, pageSize)) return false;
        const page =
            this.windowed(this.offset, pageSize) ?? (await this.bytesAt(this.offset, pageSize));
        if (
            !this.context.checkedOggPages?.has(this.offset) &&
            oggPageCrc32(page) !== u32(page, 22)
        ) {
            if (!this.lenient) throw new DemuxError(`Ogg page CRC mismatch at ${this.offset}`);
            this.skipPage(
                pageSize,
                'OGG_PAGE_CRC',
                `Ogg page CRC mismatch at byte ${this.offset}; the page is dropped`,
            );
            return true;
        }
        this.skippedPage = false;
        const lo = u32(page, 6);
        const hi = u32(page, 10);
        const rawGranule = lo === 0xffffffff && hi === 0xffffffff ? null : hi * 2 ** 32 + lo;
        if (rawGranule !== null && !Number.isSafeInteger(rawGranule + this.linkBase))
            throw new DemuxError('Ogg granule exceeds exact integer range');
        this.body = 27 + lacing.length;
        this.completed = 0;
        this.audioOnPage = 0;
        this.pageFrames = 0;
        this.emptyEos = false;
        if (!this.readSegments(page, lacing, flags, rawGranule, firstPage)) return false;
        this.settlePage(flags, rawGranule, firstPage);
        this.offset += pageSize;
        return true;
    }

    /**
     * After an EOS page: starts the chained link that follows, past sector padding in compatible
     * reading; false when nothing more is read.
     */
    private async continueChain(): Promise<boolean> {
        if (this.wantedSerial !== undefined) return false;
        if (!(await this.chainStart(this.offset))) {
            if (!this.lenient)
                throw new DemuxError(
                    'Bytes after the Ogg EOS page do not start a chained logical stream',
                );

            // Some game and disc rips pad each link to a sector boundary before the next BOS
            // page.
            const next = await findOggPage(this.context, this.offset + 1);
            if (next < 0 || !(await this.chainStart(next))) {
                this.damaged(
                    'OGG_TRAILING_BYTES',
                    `Ignored ${this.context.size - this.offset} bytes after the last Ogg EOS page`,
                );
                return false;
            }
            this.damaged(
                'OGG_CHAIN_PADDING',
                `Skipped ${next - this.offset} bytes between chained Ogg links at byte ` +
                    `${this.offset}`,
            );
            this.offset = next;
        }
        this.startLink();
        return true;
    }

    /** The track of the packets read, once the pages end. */
    private finishTrack(): TrackInfo {
        if (
            this.codec === 'speex' &&
            !this.eos &&
            this.packets.length &&
            this.frames > this.granule &&
            this.granule > 0
        )
            this.frames = this.granule;

        if (!this.packets.length || (!this.recovered && this.granule <= this.preSkip))
            throw new DemuxError('Ogg audio is truncated or has no playable samples');
        if (!this.eos || this.continued) {
            this.damaged(
                'OGG_MISSING_EOS',
                'Ogg stream ends without an EOS page; the complete packets are retained',
            );
            this.granule = this.frames;
        }

        if (this.granule <= this.preSkip)
            throw new DemuxError('Ogg audio has no playable samples after its pre-skip');
        if (this.link > 0)
            this.context.diagnostics.recover({
                code: 'OGG_CHAINED_STREAMS',
                format: 'ogg',
                message:
                    `Joined ${this.link + 1} chained Ogg streams, keeping ` +
                    `${this.joinedSamples} samples of padding`,
            });

        this.packets.finish();
        const track: TrackInfo = {
            id: 1,
            codec: this.codec,
            codecConfig:
                this.codec === 'opus' || this.codec === 'speex'
                    ? this.headers[0]
                    : this.codec === 'flac'
                      ? flacCodecConfig(this.headers)
                      : vorbisCodecConfig(this.headers),
            sampleRate: this.sampleRate,
            channelCount: this.channels,
            timescale: this.sampleRate,
            width: 0,
            height: 0,
            ...(this.language ? { language: this.language } : {}),
            duration: (this.granule - this.preSkip) / this.sampleRate,
            samples: [],
            ...(this.recovered ? { incomplete: true } : {}),
            ...(this.codec === 'opus'
                ? {
                      matroskaCodecDelaySeconds: this.preSkip / this.sampleRate,
                      opusTrailingPaddingSamples: this.frames - this.granule,
                  }
                : this.codec === 'flac' || this.codec === 'speex'
                  ? this.frames > this.granule
                      ? { audioTrailingPaddingSamples: this.frames - this.granule }
                      : {}
                  : {
                        audioTrailingPaddingSamples: this.frames - this.granule,
                        audioPrimingSamples: this.vorbisPriming,
                    }),
        };

        bindCompactSampleIndex(track, this.packets);
        return track;
    }

    /**
     * Sets up the codec an identification header names, by its signature: Opus, then (unless only
     * Opus is read) Vorbis, FLAC in both mappings, and Speex.
     */
    private identify(packet: Uint8Array): void {
        const reader = IDENTIFICATIONS.find(
            entry => (entry.codec === 'opus' || !this.requireOpus) && entry.matches(packet),
        );
        if (!reader)
            throw new DemuxError(
                this.requireOpus
                    ? 'Expected Ogg Opus audio'
                    : 'Ogg packet input supports Opus, Vorbis, FLAC and Speex audio',
            );
        if (reader.codec === 'opus') this.readOpusHead(packet);
        else if (reader.codec === 'vorbis') this.readVorbisIdentification(packet);
        else if (reader.codec === 'flac') this.readFlacIdentification(packet);
        else if (reader.codec === 'legacy-flac') this.readLegacyFlacMarker();
        else this.readSpeexHeader(packet);
    }

    /** OpusHead: channel count, pre-skip and the stream count of mapping family 1. */
    private readOpusHead(packet: Uint8Array): void {
        // Mapping family 0 is mono/stereo in 19 bytes; family 1 adds the stream counts and
        // a channel map.
        const family = packet[18];
        const count = packet[9]!;
        const valid =
            packet.length >= 19 &&
            packet[8]! >> 4 === 0 &&
            ((family === 0 && packet.length === 19 && count >= 1 && count <= 2) ||
                (family === 1 && count >= 1 && count <= 8 && packet.length === 21 + count));

        if (!valid) {
            throw new DemuxError('Ogg Opus channel mapping is not supported', {
                hint: 'Convert to mapping family 0 or 1 first.',
            });
        }

        this.codec = 'opus';
        this.sampleRate = 48000;
        this.channels = count;
        this.preSkip = packet[10]! + packet[11]! * 256;
        this.opusStreams = family === 1 ? packet[19]! : 1;
    }

    /** The Vorbis identification header: channels, rate and block sizes. */
    private readVorbisIdentification(packet: Uint8Array): void {
        if (packet.length !== 30 || u32(packet, 7) !== 0 || (packet[29]! & 1) !== 1)
            throw new DemuxError('Invalid Vorbis identification header');
        this.channels = packet[11]!;
        this.sampleRate = u32(packet, 12);
        this.smallBlock = 1 << (packet[28]! & 15);
        this.largeBlock = 1 << (packet[28]! >> 4);
        if (
            this.channels < 1 ||
            this.channels > 8 ||
            this.sampleRate < 1 ||
            this.sampleRate > 768000 ||
            this.smallBlock < 64 ||
            this.largeBlock < this.smallBlock ||
            this.largeBlock > 8192
        )
            throw new DemuxError('Unsupported Vorbis audio shape');
        this.codec = 'vorbis';
    }

    /** The Ogg FLAC mapping header, with STREAMINFO and its header packet count. */
    private readFlacIdentification(packet: Uint8Array): void {
        if (
            packet.length !== 51 ||
            packet[5] !== 1 ||
            !asciiAt(packet.subarray(9), 0, 'fLaC') ||
            (packet[13]! & 0x7f) !== 0 ||
            packet[14] !== 0 ||
            packet[15] !== 0 ||
            packet[16] !== 34
        )
            throw new DemuxError('Invalid Ogg FLAC identification header');
        ({ sampleRate: this.sampleRate, channels: this.channels } = readFlacStreamInfo(
            packet.subarray(17),
        ));
        if (this.sampleRate < 1 || this.sampleRate > 768000)
            throw new DemuxError('Unsupported Ogg FLAC sample rate');
        this.flacHeaderPackets = (packet[7]! << 8) | packet[8]!;
        this.codec = 'flac';
    }

    /** The pre-1.1.1 mapping: the marker, then one packet per metadata block, STREAMINFO first. */
    private readLegacyFlacMarker(): void {
        this.codec = 'flac';
        this.legacyFlac = true;
        this.flacHeaderPackets = 0;
    }

    /** The Speex header: rate, channels, frames per packet and extra headers. */
    private readSpeexHeader(packet: Uint8Array): void {
        const speex = speexHeader(packet)!;
        if (
            speex.rate < 1 ||
            speex.rate > 768000 ||
            speex.channels < 1 ||
            speex.channels > 2 ||
            speex.frameSize < 1 ||
            speex.framesPerPacket < 1 ||
            speex.extraHeaders > 64
        )
            throw new DemuxError('Unsupported Speex audio shape');
        this.codec = 'speex';
        this.sampleRate = speex.rate;
        this.channels = speex.channels;
        this.speexFrames = speex.frameSize * speex.framesPerPacket;
        this.speexExtraHeaders = speex.extraHeaders;
    }
}

/**
 * Indexes one logical Ogg audio stream. `wantedSerial` selects that stream of a multiplexed file
 * and skips the pages of the others; without it the file must hold a single stream.
 */
export async function indexOggAudio(
    context: AudioIndexContext,
    requireOpus: boolean,
    wantedSerial?: number,
): Promise<TrackInfo> {
    return new OggAudioIndexer(context, requireOpus, wantedSerial).run();
}
