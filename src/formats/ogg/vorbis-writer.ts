import type { Sink } from '../../core/model/types';
import type { EncodedPacket } from '../../core/model/media';
import type { AudioTrackConfig, AudioOutputMuxer } from '../../core/contracts/writer';
import { MediaForgeError, throwIfAborted } from '../../core/errors/errors';
import { OggPager } from './page-writer';
import { copyOutputBytes, outputByteLength } from '../../core/bytes/output-data';
import { assertSink, drainSink } from '../../core/io/sinks/sink-backpressure';
import { awaitWithAbort } from '../../core/io/abort';
import {
    vorbisModes,
    vorbisPacketBlock,
    xiphHeaders,
} from '../../core/codec-config/audio/vorbis-headers';
import { validateOggComments } from './comments';
import { dataView } from '../../core/bytes/byte-fields';

function requireValue(condition: unknown, message: string): asserts condition {
    if (!condition) throw new MediaForgeError(message, 'MUX');
}

/** The number of fields in a Vorbis comment header, or -1 when it is too short to say. */
function commentCount(header: Uint8Array): number {
    if (header.length < 15) return -1;
    const view = dataView(header);
    const at = 11 + view.getUint32(7, true);
    return at + 4 <= header.length ? view.getUint32(at, true) : -1;
}

/** Copies one continuous Vorbis stream; configuration is Matroska/Xiph-laced three-header data. */
export class VorbisMuxer implements AudioOutputMuxer {
    private readonly headers: readonly Uint8Array[];
    private readonly rate: number;
    private readonly modes: readonly boolean[];
    private readonly smallBlock: number;
    private readonly largeBlock: number;
    private readonly pager = new OggPager(0x4d46564f);
    /**
     * Packets not yet written with their granule and their end by their own timestamp and duration:
     * the last packet, and every packet reaching past the presented end, which all share the final
     * page.
     */
    private readonly held: { data: Uint8Array; end: number; timedEnd: number }[] = [];
    private previousEnd?: number;
    private previousBlock = 0;
    private granule = 0;
    private validSamples?: number;
    private started = false;
    private finished = false;
    private busy = false;
    private failure?: { error: unknown };

    /**
     * `comments`, a Vorbis comment payload, replace a comment header that names no field (one
     * copied from elsewhere).
     */
    constructor(
        private readonly sink: Sink,
        track: AudioTrackConfig,
        comments?: Uint8Array,
    ) {
        assertSink(sink);
        const { codec, codecConfig, sampleRate, channelCount } = track;
        requireValue(codec === 'vorbis', 'Vorbis output requires a Vorbis track');

        const configLength = outputByteLength(codecConfig!);
        requireValue(
            configLength >= 4 && configLength <= 4 * 1024 * 1024,
            'Invalid Vorbis header configuration',
        );
        const config = copyOutputBytes(codecConfig!);
        requireValue(config[0] === 2, 'Invalid Vorbis header configuration');

        const laced = xiphHeaders(config);
        requireValue(laced, 'Truncated Vorbis header lacing');
        this.headers = laced.map((header, index) => {
            requireValue(
                index === 0 ? header.length === 30 : header.length >= 8,
                'Invalid Vorbis header length',
            );
            requireValue(
                header[0] === index * 2 + 1 &&
                    String.fromCharCode(...header.subarray(1, 7)) === 'vorbis',
                'Invalid Vorbis header signature',
            );
            return header.slice();
        });

        const info = new DataView(this.headers[0]!.buffer);
        this.rate = info.getUint32(12, true);
        const blocks = this.headers[0]![28]!;
        requireValue(
            info.getUint32(7, true) === 0 &&
                this.rate === sampleRate &&
                this.rate > 0 &&
                this.headers[0]![11] === channelCount &&
                channelCount > 0 &&
                (blocks & 15) >= 6 &&
                blocks >>> 4 <= 13 &&
                (blocks & 15) <= blocks >>> 4 &&
                (this.headers[0]![29]! & 1) === 1,
            'Vorbis identification does not match the track',
        );

        if (comments && commentCount(this.headers[1]!) === 0) {
            const header = new Uint8Array(7 + comments.length + 1);
            header.set([3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]);
            header.set(comments, 7);
            header[header.length - 1] = 1;
            (this.headers as Uint8Array[])[1] = header;
        }

        this.smallBlock = 1 << (blocks & 15);
        this.largeBlock = 1 << (blocks >>> 4);

        try {
            validateOggComments(this.headers[1]!, false);
            this.modes = vorbisModes(this.headers[2]!, channelCount);
        } catch {
            throw new MediaForgeError('Invalid Vorbis comment or setup header', 'MUX');
        }
    }

    setValidSamples(samples: number): void {
        this.assertOpen();
        if (!Number.isSafeInteger(samples) || samples < 0)
            throw new MediaForgeError(
                'Vorbis valid sample count must be a non-negative safe integer',
                'INPUT',
            );
        this.validSamples = samples;
    }

    addAudioChunk(chunk: EncodedPacket): void {
        this.assertOpen();
        const { trackType, timestamp, duration, data: source } = chunk;
        this.assertOpen();
        requireValue(
            trackType === 'audio' &&
                Number.isFinite(timestamp) &&
                Number.isFinite(duration) &&
                duration >= 0,
            'Invalid Vorbis packet timing',
        );
        const length = outputByteLength(source);
        requireValue(length > 0 && length <= 64 * 1024 * 1024, 'Invalid Vorbis audio packet');
        const data = copyOutputBytes(source);
        let block: number;
        try {
            block = vorbisPacketBlock(data, this.modes, this.smallBlock, this.largeBlock);
        } catch {
            throw new MediaForgeError('Invalid Vorbis audio packet mode', 'MUX');
        }
        const start = Math.round(timestamp * this.rate);

        // Granules count decoded samples: after the first packet, each ends where its block's
        // centre lies. Packet times only anchor the first packet; they continue the stream when
        // they follow the previous packet's own end within a millisecond (Matroska's clock) or lie
        // within half a long block of the granule timeline.
        const continuous =
            this.previousEnd === undefined ||
            Math.abs(start - this.previousEnd) <= this.largeBlock / 2 ||
            Math.abs(start - this.held[this.held.length - 1]!.timedEnd) <=
                Math.max(1, this.rate / 1000);

        // A packet after a forward jump follows a hole in the source (pages lost to damage); its
        // granule skips the hole as the source's did. A packet timed back into the previous ones (a
        // source that followed a damaged page's granule backwards) continues the granule timeline,
        // whose samples the decoder produces anyway.
        const hole =
            !continuous &&
            start > this.previousEnd! &&
            start > this.held[this.held.length - 1]!.timedEnd;
        const end =
            this.previousEnd === undefined
                ? Math.round((timestamp + duration) * this.rate)
                : (hole ? start : this.previousEnd) + (this.previousBlock + block) / 4;
        requireValue(
            Number.isSafeInteger(start) &&
                Number.isSafeInteger(end) &&
                (end >= 0 || this.previousEnd === undefined),
            'Vorbis packet exceeds exact timing range',
        );
        this.previousBlock = block;
        this.busy = true;
        try {
            if (!this.started) {
                this.headers.forEach((header, index) =>
                    this.writePage([header], 0n, index === 0 ? 2 : 0),
                );
                this.started = true;
            }
            this.held.push({ data, end, timedEnd: Math.round((timestamp + duration) * this.rate) });
            while (
                this.held.length > 1 &&
                (this.validSamples === undefined || this.held[0]!.timedEnd <= this.validSamples)
            ) {
                const packet = this.held.shift()!;
                this.writePage([packet.data], BigInt(Math.max(0, packet.end)), 0);
                this.granule = packet.end;
            }
            this.previousEnd = end;
        } catch (error) {
            this.failure = { error };
            throw error;
        } finally {
            this.busy = false;
        }
    }

    async finalize(): Promise<void> {
        this.assertOpen();
        const last = this.held[this.held.length - 1];
        requireValue(last, 'Cannot finalize Vorbis without audio packets');

        // The presented end is stated on the packet timeline; the trim it makes applies to the
        // granule timeline.
        const end =
            this.validSamples === undefined
                ? last.end
                : last.end - Math.max(0, last.timedEnd - this.validSamples);
        requireValue(
            end >= this.granule && end <= last.end,
            'Vorbis trim must lie within the unwritten packets',
        );
        this.busy = true;
        try {
            this.writePage(
                this.held.map(packet => packet.data),
                BigInt(end),
                4,
            );
            this.held.length = 0;
            this.finished = true;
            await drainSink(this.sink, this.sink.signal);
            this.checkAbort();
            await awaitWithAbort(this.sink.close(), this.sink.signal);
            this.checkAbort();
        } catch (error) {
            this.failure = { error };
            throw error;
        } finally {
            this.busy = false;
        }
    }

    private assertOpen(): void {
        if (this.failure) throw this.failure.error;
        requireValue(!this.finished && !this.busy, 'Vorbis writer is closed or busy');
        this.checkAbort();
    }

    private checkAbort(): void {
        throwIfAborted(this.sink.signal);
    }

    /** Writes packets on pages; see OggPager.pages. */
    private writePage(packets: readonly Uint8Array[], granule: bigint, flags: number): void {
        for (const page of this.pager.pages(packets, granule, flags)) {
            this.checkAbort();
            this.sink.write(page);
        }
        this.checkAbort();
    }
}
