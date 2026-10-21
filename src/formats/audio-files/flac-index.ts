import { AudioFrameTable } from './index-context';

/**
 * The frames of a FLAC stream in typed arrays, 22 bytes each, instead of a record per frame: where
 * a frame starts in the input, its size, its first sample and its block size. `get` returns the
 * values the record form held.
 */
export class FlacFrameIndex extends AudioFrameTable {
    static readonly BYTES_PER_FRAME = 22;
    private starts = new Float64Array(1024);
    private blocks = new Uint16Array(1024);

    constructor(private readonly sampleRate: number) {
        super(new Uint32Array(1024), 1024);
    }

    get byteLength(): number {
        return this.length * FlacFrameIndex.BYTES_PER_FRAME;
    }

    /** Appends the frame at input byte `offset` that holds `blockSize` samples from `start`. */
    push(offset: number, size: number, start: number, blockSize: number): void {
        const index = this.append(offset, size);
        this.starts[index] = start;
        this.blocks[index] = blockSize;
    }

    /** Moves the input offsets of the frames by `bytes` (a tag in front of the stream). */
    moveOffsets(bytes: number): void {
        for (let index = 0; index < this.length; index++) this.offsets[index]! += bytes;
    }

    timestampAt(index: number): number {
        return this.starts[index]! / this.sampleRate;
    }

    durationAt(index: number): number {
        return this.blocks[index]! / this.sampleRate;
    }

    protected grow(capacity: number): void {
        super.grow(capacity);
        this.starts = this.resized(this.starts, capacity);
        this.blocks = this.resized(this.blocks, capacity);
    }
}
