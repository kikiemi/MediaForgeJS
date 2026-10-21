import type { Sink } from '../../core/model/types';
import { MediaForgeError } from '../../core/errors/errors';
import type { MuxerConfig, AudioOutputMuxer } from '../../core/contracts/writer';
import type { EncodedPacket } from '../../core/model/media';
import { BinaryWriter } from '../../core/bytes/binary-writer';
import { FLAC_BLOCK_SIZE, flacStreamInfoRecord } from '../../core/codec-config/audio/flac-frame';
import { copyOutputBytes, outputByteLength } from '../../core/bytes/output-data';
import { OggPager } from './page-writer';
import { assertOpen, checkChunk } from '../shared/chunk-checks';
import { assertSink } from '../../core/io/sinks/sink-backpressure';
import { hasMediaTags, mediaTag } from '../../core/model/media-tags';
import { vorbisCommentPayload } from '../metadata/vorbis-comment';
import { opusHeadPacket } from '../../core/codec-config/audio/opus-head';
import { sameBytes } from '../../core/bytes/bytes';

const OGG_BOS = 0x02;
const OGG_EOS = 0x04;
const OPUS_SAMPLE_RATE = 48000;
const OPUS_PRE_SKIP = 312;
const OPUS_DEFAULT_FRAME_SAMPLES = 960;
const MAX_GRANULE_POSITION = 0x7fffffffffffffffn;

type AudioPacket = Pick<EncodedPacket, 'data' | 'timestamp' | 'duration'>;

/**
 * The comments of an encoded stream: the output's title and tags, chapters and pictures, and the
 * track's language, as the copy writer gives a copied one.
 */
function writtenComments(cfg: MuxerConfig): Uint8Array | undefined {
    const { title, tags } = cfg;
    const entries = tags?.entries ?? [];
    const titled =
        title?.trim() && mediaTag(tags, 'title') === undefined
            ? { ...tags, entries: [{ key: 'title', value: title }, ...entries] }
            : tags;
    const language = cfg.audioLanguage ?? cfg.audio?.language;
    return hasMediaTags(titled) || (language && language !== 'und')
        ? vorbisCommentPayload('MediaForgeJS', titled, language)
        : undefined;
}

function copyBytes(value: Uint8Array, label: string): Uint8Array {
    try {
        outputByteLength(value);
    } catch {
        throw new MediaForgeError(`${label} must be an attached Uint8Array`, 'MUX');
    }
    return copyOutputBytes(value);
}

/** An OpusHead packet as it is, or from the dOps payload (version 0) of a copied MP4 track. */
export function oggOpusHead(config: Uint8Array): Uint8Array {
    return config[0] === 0 ? opusHeadPacket(config, 0) : config.slice();
}

/**
 * Ogg Opus and Ogg FLAC muxer. Opus granules count 48 kHz samples from the start of the pre-skip
 * the OpusHead states, with OpusTags; FLAC granules count samples at the stream's rate, after the
 * Ogg FLAC mapping header (the STREAMINFO) and a VORBIS_COMMENT block. setValidSamples trims the
 * last granule to the exact length.
 */
export class OggMuxer implements AudioOutputMuxer {
    private finalizedFlag = false;
    private failed = false;
    private failure: unknown;
    private writing = false;
    private validSamples: number | null = null;

    /** Exact source length in granule samples (48 kHz for Opus); the last granule clamps to it. */
    setValidSamples(samples: number): void {
        this.assertOpen();
        if (!Number.isSafeInteger(samples) || samples < 0)
            throw new MediaForgeError(
                'Ogg valid sample count must be a non-negative safe integer',
                'INPUT',
            );
        this.validSamples = samples;
    }

    private readonly sink: Sink;
    private readonly channelCount: number;
    private readonly inputSampleRate: number;
    /** FLAC rather than Opus, and the rate its granules count. */
    private readonly flac: boolean;
    private readonly granuleRate: number;
    private readonly commentPayload: Uint8Array | undefined;
    private codecConfig: Uint8Array | undefined;
    /** A FLAC mapping header given after the first page, for finalize to write there. */
    private finalHeader: Uint8Array | undefined;
    private readonly pager: OggPager;
    private pendingChunk: AudioPacket | null = null;
    private headersWritten = false;
    private samplePosition = 0n;
    private preSkip = OPUS_PRE_SKIP;
    /** Audio packets waiting for their page, its lacing values and its granule. */
    private queued: Uint8Array[] = [];
    private queuedSegments = 0;
    private queuedGranule = 0n;
    private writtenGranule = 0n;

    constructor(cfg: MuxerConfig, sink: Sink) {
        assertSink(sink);
        if (cfg.video) {
            throw new MediaForgeError('Ogg output takes audio only', 'FORMAT');
        }

        const audio = cfg.audio;
        const codec = audio?.codec;
        this.flac = codec === 'flac';
        if (typeof codec !== 'string' || !(this.flac || codec.startsWith('opus'))) {
            throw new MediaForgeError(
                `Ogg output cannot carry '${String(codec ?? '(none)')}' audio`,
                'FORMAT',
            );
        }

        this.channelCount = audio?.channelCount ?? 2;
        this.inputSampleRate = audio?.sampleRate ?? OPUS_SAMPLE_RATE;
        this.granuleRate = this.flac ? this.inputSampleRate : OPUS_SAMPLE_RATE;
        if (this.flac) this.preSkip = 0;
        const codecConfig = audio?.codecConfig,
            commentPayload = cfg.oggCommentPayload ?? writtenComments(cfg);
        this.codecConfig = codecConfig === undefined ? undefined : this.validateHeader(codecConfig);
        this.commentPayload =
            commentPayload === undefined
                ? undefined
                : copyBytes(commentPayload, 'Ogg comment payload');

        const { write, close, patchAt } = sink;
        this.sink = {
            write: bytes => write.call(sink, bytes),
            close: () => close.call(sink),
            ...(patchAt ? { patchAt: (at, bytes) => patchAt.call(sink, at, bytes) } : {}),
        };
        this.pager = new OggPager(((Date.now() & 0xffffffff) ^ 0x6f676753) >>> 0);
    }

    /**
     * Provide the encoder's OpusHead or FLAC STREAMINFO; used when building the identification
     * header. A FLAC encoder's STREAMINFO completed at the end (its frame sizes and MD5) is written
     * into the first page at finalize when the sink can patch, and otherwise left out.
     */
    setAudioCodecConfig(codecConfig: Uint8Array): void {
        this.assertOpen();
        const header = this.validateHeader(codecConfig);
        if (this.headersWritten && this.flac) {
            this.finalHeader = header;
            return;
        }
        if (this.headersWritten) {
            const current = this.codecConfig;
            if (
                !current ||
                current.length !== header.length ||
                current.some((value, index) => value !== header[index])
            ) {
                throw new MediaForgeError(
                    'Ogg codec configuration cannot change after the first audio chunk',
                    'MUX',
                );
            }
            return;
        }
        this.codecConfig = header;
    }

    /** Always throws: Ogg output is audio-only here. */
    addVideoChunk(): void {
        throw new MediaForgeError('Ogg output takes audio only', 'FORMAT');
    }

    /**
     * Appends one encoded audio chunk; `codecConfig` on the first call carries decoder
     * configuration where the container stores it.
     */
    addAudioChunk(chunk: EncodedPacket, codecConfig?: Uint8Array): void {
        this.assertOpen();
        checkChunk('addAudioChunk', chunk, 'audio');

        const timestamp = chunk.timestamp,
            duration = chunk.duration ?? 0;
        if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration < 0) {
            throw new MediaForgeError('Ogg audio chunk has invalid timing', 'MUX');
        }
        if (this.pendingChunk && timestamp < this.pendingChunk.timestamp) {
            throw new MediaForgeError('Ogg audio chunks must arrive in timestamp order', 'MUX');
        }

        const owned = {
            timestamp,
            duration,
            data: copyBytes(chunk.data, 'Ogg audio chunk payload'),
        };

        const supplied = codecConfig === undefined ? undefined : this.validateHeader(codecConfig);
        if (this.headersWritten && supplied) this.setAudioCodecConfig(supplied);
        const idHeader = this.headersWritten
            ? undefined
            : (supplied ?? this.resolveOpusIdHeader(this.channelCount, this.inputSampleRate));

        const pendingSamples = this.pendingChunk
            ? this.packetSamples(this.pendingChunk, owned.timestamp)
            : 0n;
        if (
            this.samplePosition + pendingSamples + this.packetSamples(owned) >
            MAX_GRANULE_POSITION
        ) {
            throw new MediaForgeError(
                'Ogg audio sample position exceeds the signed 64-bit granule range',
                'MUX',
            );
        }

        this.writeHeaders(idHeader);
        if (this.pendingChunk) this.writeAudioPacket(this.pendingChunk, false, pendingSamples);
        this.pendingChunk = owned;
    }

    /** Flushes trailing container structures and closes the sink; must be awaited exactly once. */
    async finalize(): Promise<void> {
        this.assertOpen();
        if (!this.pendingChunk) {
            throw new MediaForgeError('finalize with no audio packets', 'MUX');
        }
        const samples = this.packetSamples(this.pendingChunk);
        const finalGranule = this.audioGranule(this.samplePosition + samples, true);
        const pendingSegments = Math.floor(this.pendingChunk.data.length / 255) + 1;
        const minimumGranule =
            this.queuedSegments > 0 && this.queuedSegments + pendingSegments > 255
                ? this.queuedGranule
                : this.writtenGranule;
        if (finalGranule < minimumGranule) {
            throw new MediaForgeError(
                'Ogg valid sample count trims audio before the final page',
                'MUX',
            );
        }
        this.finalizedFlag = true;
        this.writeAudioPacket(this.pendingChunk, true, samples);
        this.pendingChunk = null;
        this.flushPage(0);

        try {
            // The first page again, numbered 0 and as long, with the STREAMINFO given since.
            const final = this.finalHeader;
            if (final && this.sink.patchAt && !sameBytes(final, this.codecConfig))
                this.sink.patchAt(
                    0,
                    new OggPager(this.pager.serial).pages([final], 0n, OGG_BOS)[0]!,
                );
            await this.sink.close();
        } catch (error) {
            this.fail(error);
        }
    }

    private assertOpen(): void {
        if (this.failed) throw this.failure;
        assertOpen(this.finalizedFlag);
        if (this.writing)
            throw new MediaForgeError(
                'Ogg muxer cannot be mutated from a sink write callback',
                'MUX',
            );
    }

    private fail(error: unknown): never {
        if (!this.failed) {
            this.failed = true;
            this.failure = error;
        }
        throw this.failure;
    }

    /** Writes packets on pages that end with `granule` (see OggPager.pages). */
    private writePages(packets: readonly Uint8Array[], granule: bigint, flags: number): void {
        this.writing = true;
        try {
            for (const page of this.pager.pages(packets, granule, flags)) this.sink.write(page);
            this.writtenGranule = granule;
        } catch (error) {
            this.fail(error);
        } finally {
            this.writing = false;
        }
    }

    private writeHeaders(idHeader?: Uint8Array): void {
        if (this.headersWritten) return;
        if (!idHeader) throw new MediaForgeError('Ogg identification header is missing', 'MUX');
        const commentHeader = this.flac
            ? this.buildFlacCommentBlock()
            : this.buildOpusCommentHeader();
        this.codecConfig = idHeader;
        this.headersWritten = true;
        if (!this.flac)
            this.preSkip =
                idHeader.length >= 12 ? idHeader[10]! | (idHeader[11]! << 8) : OPUS_PRE_SKIP;
        this.writePages([idHeader], 0n, OGG_BOS);
        this.writePages([commentHeader], 0n, 0);
    }

    private packetSamples(chunk: AudioPacket, nextTimestamp?: number): bigint {
        let durationSeconds = chunk.duration > 0 ? chunk.duration : 0;
        if (durationSeconds <= 0 && nextTimestamp !== undefined) {
            durationSeconds = Math.max(0, nextTimestamp - chunk.timestamp);
        }
        const samples =
            durationSeconds > 0
                ? Math.max(1, Math.round(durationSeconds * this.granuleRate))
                : this.flac
                  ? FLAC_BLOCK_SIZE
                  : OPUS_DEFAULT_FRAME_SAMPLES;
        if (!Number.isSafeInteger(samples)) {
            throw new MediaForgeError(
                'Ogg audio duration exceeds safe sample-count precision',
                'MUX',
            );
        }
        return BigInt(samples);
    }

    private audioGranule(position: bigint, isLast: boolean): bigint {
        const finalGranule =
            this.validSamples !== null ? BigInt(this.preSkip) + BigInt(this.validSamples) : null;
        return isLast && finalGranule !== null && finalGranule < position ? finalGranule : position;
    }

    private writeAudioPacket(chunk: AudioPacket, isLast: boolean, samples: bigint): void {
        this.samplePosition += samples;
        this.queuePacket(chunk.data, this.audioGranule(this.samplePosition, isLast), isLast);
    }

    private resolveOpusIdHeader(channelCount: number, inputSampleRate: number): Uint8Array {
        const provided = this.codecConfig;
        if (provided) return provided;
        if (this.flac)
            throw new MediaForgeError(
                'Ogg FLAC needs its STREAMINFO before the first frame',
                'FORMAT',
            );
        return this.buildOpusIdHeader(channelCount, inputSampleRate);
    }

    /** The identification header of the stream: an OpusHead, or the Ogg FLAC mapping header. */
    private validateHeader(value: Uint8Array): Uint8Array {
        return this.flac ? this.flacMappingHeader(value) : this.validateOpusIdHeader(value);
    }

    /**
     * The first packet of Ogg FLAC: 0x7F 'FLAC', mapping version 1.0, one header packet to follow
     * (the comments), then 'fLaC' and the STREAMINFO block.
     */
    private flacMappingHeader(value: Uint8Array): Uint8Array {
        const bytes = copyBytes(value, 'Ogg codec configuration');
        // A mapping header already made (or read from Ogg) holds 'fLaC' and STREAMINFO at 9.
        const record = flacStreamInfoRecord(bytes[0] === 0x7f ? bytes.subarray(9) : bytes);
        if (!record)
            throw new MediaForgeError('Ogg FLAC configuration requires a STREAMINFO record', 'MUX');
        const header = new Uint8Array(51);
        header.set([0x7f, 0x46, 0x4c, 0x41, 0x43, 1, 0, 0, 1, 0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 34]);
        header.set(record, 17);
        return header;
    }

    /** The VORBIS_COMMENT metadata block of Ogg FLAC, marked as the last block. */
    private buildFlacCommentBlock(): Uint8Array {
        const comments = this.buildOpusCommentHeader().subarray(8);
        const block = new Uint8Array(4 + comments.length);
        block.set([
            0x84,
            comments.length >> 16,
            (comments.length >> 8) & 0xff,
            comments.length & 0xff,
        ]);
        block.set(comments, 4);
        return block;
    }

    private validateOpusIdHeader(value: Uint8Array): Uint8Array {
        const raw = copyBytes(value, 'Ogg codec configuration');

        // A copied MP4 track carries a dOps payload (version 0) rather than an OpusHead.
        const header = oggOpusHead(raw);
        const magic = 'OpusHead';
        if (
            header.length < 19 ||
            [...magic].some((letter, index) => header[index] !== letter.charCodeAt(0)) ||
            header[8]! > 15 ||
            header[9] === 0
        ) {
            throw new MediaForgeError(
                'Ogg codec configuration requires a complete compatible OpusHead',
                'MUX',
            );
        }

        const channels = header[9]!,
            family = header[18]!;
        if (family === 0 && channels > 2) {
            throw new MediaForgeError(
                'Ogg OpusHead mapping family zero supports only mono or stereo',
                'MUX',
            );
        }

        if (family === 1 || family === 255) {
            const streams = header[19]!,
                coupled = header[20]!;
            if (
                header.length < 21 + channels ||
                streams === 0 ||
                coupled > streams ||
                streams + coupled > 255 ||
                (family === 1 && channels > 8) ||
                header
                    .subarray(21, 21 + channels)
                    .some(channel => channel !== 255 && channel >= streams + coupled)
            ) {
                throw new MediaForgeError(
                    'Ogg OpusHead has an invalid channel mapping table',
                    'MUX',
                );
            }
        }
        return header;
    }

    /** Queues a packet on the current page; a page fills at 255 lacing values. */
    private queuePacket(payload: Uint8Array, granulePosition: bigint, isLast: boolean): void {
        const segments = Math.floor(payload.length / 255) + 1;
        if (this.queuedSegments + segments > 255) this.flushPage(0);
        this.queued.push(payload);
        this.queuedSegments += segments;
        this.queuedGranule = granulePosition;
        if (isLast || this.queuedSegments >= 255) this.flushPage(isLast ? OGG_EOS : 0);
    }

    private flushPage(extraFlags: number): void {
        if (!this.queued.length) return;
        this.writePages(this.queued, this.queuedGranule, extraFlags);
        this.queued = [];
        this.queuedSegments = 0;
    }

    private buildOpusIdHeader(channelCount: number, inputSampleRate: number): Uint8Array {
        if (channelCount !== 1 && channelCount !== 2) {
            throw new MediaForgeError(
                'Ogg multichannel audio requires an OpusHead with channel mapping',
                'FORMAT',
            );
        }

        if (
            !Number.isInteger(inputSampleRate) ||
            inputSampleRate < 0 ||
            inputSampleRate > 0xffffffff
        ) {
            throw new MediaForgeError(
                'Ogg input sample rate must fit an unsigned 32-bit field',
                'FORMAT',
            );
        }

        const writer = new BinaryWriter();
        writer.writeASCII('OpusHead');
        writer.writeU8(1);
        writer.writeU8(channelCount);
        writer.writeU16LE(OPUS_PRE_SKIP);
        writer.writeU32LE(inputSampleRate);
        writer.writeU16LE(0);
        writer.writeU8(0);
        return writer.toUint8Array();
    }

    private buildOpusCommentHeader(): Uint8Array {
        const writer = new BinaryWriter();
        writer.writeASCII('OpusTags');
        const carried = this.commentPayload;
        if (carried && carried.length >= 8) {
            writer.writeBytes(carried);
        } else {
            const vendor = 'MediaForgeJS';
            writer.writeU32LE(vendor.length);
            writer.writeASCII(vendor);
            writer.writeU32LE(0);
        }
        return writer.toUint8Array();
    }
}
