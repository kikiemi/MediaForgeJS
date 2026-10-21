import type { Sample } from '../../core/model/track';
import { SummarizedSampleIndex, type SampleIndex } from '../../core/model/sample-index';

/**
 * Packets per block of the table: blocks are filled in turn, so the table grows without copying.
 */
const BLOCK_SHIFT = 13;
const BLOCK_PACKETS = 1 << BLOCK_SHIFT;

/** Values per packet: file offset, size, time and duration. */
const FIELDS = 4;

/**
 * The packets of one Ogg audio stream in blocks of a typed array, 32 bytes each, instead of a
 * record per packet. A packet that spans pages keeps its reassembled bytes. Times are seconds,
 * adjusted in place as the reader settles the timeline, so `get` returns the values the record form
 * held.
 */
export class OggPacketIndex extends SummarizedSampleIndex implements SampleIndex {
    static readonly BYTES_PER_PACKET = FIELDS * 8;
    private readonly blocks: Float64Array[] = [];
    /** Reassembled bytes of the packets that span pages, by index. */
    private readonly data = new Map<number, Uint8Array>();

    get byteLength(): number {
        return this.length * OggPacketIndex.BYTES_PER_PACKET;
    }

    /**
     * Appends a packet at file offset `offset` (its first byte), with its bytes when it spans
     * pages.
     */
    push(
        offset: number,
        size: number,
        data: Uint8Array | undefined,
        time: number,
        duration: number,
    ): void {
        const index = this.length;
        const at = (index & (BLOCK_PACKETS - 1)) * FIELDS;
        const which = index >>> BLOCK_SHIFT;
        const block =
            which < this.blocks.length
                ? this.blocks[which]!
                : this.blocks[this.blocks.push(new Float64Array(BLOCK_PACKETS * FIELDS)) - 1]!;
        block[at] = offset;
        block[at + 1] = size;
        block[at + 2] = time;
        block[at + 3] = duration;
        if (data) this.data.set(index, data);
        this.length++;
    }

    private field(index: number, field: number): number {
        return this.blocks[index >>> BLOCK_SHIFT]![(index & (BLOCK_PACKETS - 1)) * FIELDS + field]!;
    }

    /** Adds `seconds` to the times of the packets from `from` on. */
    shift(from: number, seconds: number): void {
        for (let index = from; index < this.length; index++)
            this.blocks[index >>> BLOCK_SHIFT]![(index & (BLOCK_PACKETS - 1)) * FIELDS + 2]! +=
                seconds;
    }

    /**
     * Moves the file offsets of the packets read from the input by `bytes` (a tag in front of the
     * stream).
     */
    moveOffsets(bytes: number): void {
        for (let index = 0; index < this.length; index++)
            if (!this.data.has(index))
                this.blocks[index >>> BLOCK_SHIFT]![(index & (BLOCK_PACKETS - 1)) * FIELDS]! +=
                    bytes;
    }

    durationAt(index: number): number {
        return this.field(index, 3);
    }

    /** Takes the table summary and drops the unused part of the last block. */
    finish(): void {
        let previous = Number.NEGATIVE_INFINITY;
        for (let first = 0; first < this.length; first += BLOCK_PACKETS) {
            const block = this.blocks[first >>> BLOCK_SHIFT]!;
            const end = Math.min(this.length - first, BLOCK_PACKETS) * FIELDS;
            for (let at = 0; at < end; at += FIELDS) {
                const time = block[at + 2]!;
                if (time < previous) this.presentationSorted = this.decodeSorted = false;
                this.maxSampleSize = Math.max(this.maxSampleSize, block[at + 1]!);
                this.firstPresentation = Math.min(this.firstPresentation, time);
                this.lastPresentationEnd = Math.max(
                    this.lastPresentationEnd,
                    time + block[at + 3]!,
                );
                previous = time;
            }
        }

        const last = this.blocks.length - 1;
        const used = (this.length - last * BLOCK_PACKETS) * FIELDS;
        if (last >= 0 && used < this.blocks[last]!.length)
            this.blocks[last] = this.blocks[last]!.slice(0, used);
    }

    get(index: number): Sample {
        const block = this.blocks[index >>> BLOCK_SHIFT]!;
        const at = (index & (BLOCK_PACKETS - 1)) * FIELDS;
        const timestamp = block[at + 2]!;
        return {
            offset: block[at]!,
            size: block[at + 1]!,
            data: this.data.get(index),
            timestamp,
            decodeTimestamp: timestamp,
            duration: block[at + 3]!,
            isKeyframe: true,
        };
    }

    timestampAt(index: number): number {
        return this.field(index, 2);
    }

    decodeTimeAt(index: number): number {
        return this.field(index, 2);
    }

    isKeyframeAt(): boolean {
        return true;
    }
}
