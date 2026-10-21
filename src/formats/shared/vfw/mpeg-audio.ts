import type { ByteReader } from '../../../core/io/sources/chunk-reader';
import { parseMpegAudioHeader } from '../../../core/codec-config/audio/mpeg-audio-header';
import { parseDolbyFrameHeader } from '../../../core/codec-config/audio/dolby-audio-header';

/** What frame reassembly needs from a sync frame header. */
interface AudioFrameHeader {
    readonly format: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly frameLength: number;
    readonly samplesPerFrame: number;
}

type AudioFrameParser = (data: Uint8Array, offset: number) => AudioFrameHeader | null;

/** AC-3 and E-AC-3 syncframes in the shape of MPEG audio frame headers. */
export function parseDolbyAudioFrame(data: Uint8Array, offset: number): AudioFrameHeader | null {
    const header = parseDolbyFrameHeader(data, offset);
    return header && header.frameBytes > 0
        ? {
              format: header.codec,
              sampleRate: header.sampleRate,
              channels: header.channels,
              frameLength: header.frameBytes,
              samplesPerFrame: header.samples,
          }
        : null;
}

interface AviMpegAudioFrame {
    /** Source range of the frame; `data` replaces it when the frame spans chunk boundaries. */
    readonly offset: number;
    readonly size: number;
    readonly data?: Uint8Array;
    readonly header: AudioFrameHeader;
    /** Bytes skipped as no frame since the previous frame, across chunks. */
    readonly skippedBefore: number;
}

interface AviMpegAudioChunk {
    readonly frames: readonly AviMpegAudioFrame[];
    /** Bytes skipped before a frame header was found. */
    readonly skipped: number;
}

/** Formats a WAVEFORMATEX tag declares: 0x0055 is Layer III, 0x0050 Layer I or II, 0x2000 AC-3. */
function declaredFormats(formatTag: number): readonly string[] | undefined {
    return formatTag === 0x55
        ? ['mp3']
        : formatTag === 0x50
          ? ['mp1', 'mp2']
          : formatTag === 0x2000
            ? ['ac-3', 'ec-3']
            : undefined;
}

/**
 * Reassembles MPEG audio frames (or the frames `parse` reads, such as AC-3) from AVI audio chunks,
 * which VfW writers cut at arbitrary byte counts: a frame that ends inside a later chunk is carried
 * over and returned as a copy, every other frame as a source range.
 *
 * The first frame is accepted when it matches the stream format's layer and sample rate, or when a
 * consistent frame header follows it; later frames must keep its layer and sample rate. Other sync
 * patterns are skipped as damage.
 */
export class AviMpegAudioReader {
    private carry: Uint8Array = new Uint8Array(0);
    private skippedSince = 0;
    private locked: AudioFrameHeader | undefined;
    private readonly formats: readonly string[] | undefined;

    constructor(
        formatTag = 0,
        private readonly declaredSampleRate = 0,
        private readonly parse: AudioFrameParser = parseMpegAudioHeader,
    ) {
        this.formats = declaredFormats(formatTag);
    }

    /** Bytes of an unfinished frame held after the last chunk. */
    get pending(): number {
        return this.carry.length;
    }

    async push(reader: ByteReader, offset: number, size: number): Promise<AviMpegAudioChunk> {
        const bytes = await reader.bytes(offset, size);
        const carried = this.carry.length;
        let joined = bytes;
        if (carried) {
            joined = new Uint8Array(carried + size);
            joined.set(this.carry);
            joined.set(bytes, carried);
        }

        const frames: AviMpegAudioFrame[] = [];
        let skipped = 0;
        let at = 0;
        while (at < joined.length) {
            const header = this.parse(joined, at);
            if (header === null) {
                // A header cut by the end of the chunk waits for the next one: an AC-3 header takes
                // seven bytes, an MPEG audio header four.
                if (joined.length - at < 7) break;
                at++;
                skipped++;
                this.skippedSince++;
                continue;
            }

            if (header.frameLength > joined.length - at) break;
            const verdict = this.accept(
                header,
                joined,
                at,
                at === carried && header.frameLength === size,
            );
            if (verdict === 'wait') break;
            if (verdict === 'reject') {
                at++;
                skipped++;
                this.skippedSince++;
                continue;
            }

            const skippedBefore = this.skippedSince;
            this.skippedSince = 0;
            frames.push(
                at < carried
                    ? {
                          offset: offset,
                          size: header.frameLength,
                          data: joined.slice(at, at + header.frameLength),
                          header,
                          skippedBefore,
                      }
                    : {
                          offset: offset + at - carried,
                          size: header.frameLength,
                          header,
                          skippedBefore,
                      },
            );

            at += header.frameLength;
        }

        this.carry = at < joined.length ? joined.slice(at) : new Uint8Array(0);
        return { frames, skipped };
    }

    /**
     * `fills` marks a frame that exactly spans its own chunk, which a container writer framed
     * deliberately.
     */
    private accept(
        header: AudioFrameHeader,
        joined: Uint8Array,
        at: number,
        fills: boolean,
    ): 'accept' | 'reject' | 'wait' {
        const locked = this.locked;
        if (this.formats && !this.formats.includes(header.format)) return 'reject';

        // A frame that exactly fills its chunk was framed by the writer, even where the stream
        // changes format.
        if (fills) {
            this.locked = header;
            return 'accept';
        }
        if (locked)
            return header.format === locked.format && header.sampleRate === locked.sampleRate
                ? 'accept'
                : 'reject';
        if (this.formats && header.sampleRate === this.declaredSampleRate) {
            this.locked = header;
            return 'accept';
        }
        const nextAt = at + header.frameLength;
        if (joined.length - nextAt < 4) return 'wait';
        const next = this.parse(joined, nextAt);

        // Zero padding after the frame (an encoder delay written as silence bytes) confirms it as
        // well.
        const padded = !next && joined.subarray(nextAt).every(byte => byte === 0);
        if (
            !padded &&
            (!next || next.format !== header.format || next.sampleRate !== header.sampleRate)
        )
            return 'reject';
        this.locked = header;
        return 'accept';
    }
}
