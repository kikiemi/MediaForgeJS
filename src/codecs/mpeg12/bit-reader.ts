const PADDING_WORDS = 64;

/**
 * MSB-first reader over one packet converted to big-endian 32-bit words. Positions are absolute bit
 * offsets; reads past the packet see zero padding, which no variable-length code in the syntax
 * accepts.
 */
export class BitReader {
    words = new Int32Array(8192);
    pos = 0;
    private staging = new Uint8Array(0);
    private stagingView = new DataView(this.staging.buffer);

    load(data: Uint8Array): void {
        const count = data.length;
        const wordCount = (count + 3) >> 2;
        if (this.staging.length < wordCount * 4) {
            this.staging = new Uint8Array(wordCount * 8);
            this.stagingView = new DataView(this.staging.buffer);
        }
        if (this.words.length < wordCount + PADDING_WORDS)
            this.words = new Int32Array((wordCount + PADDING_WORDS) * 2);
        this.staging.set(data);
        this.staging.fill(0, count, wordCount * 4);
        const words = this.words;
        const view = this.stagingView;
        for (let k = 0; k < wordCount; k++) words[k] = view.getInt32(k << 2);
        words.fill(0, wordCount, wordCount + PADDING_WORDS);
        this.pos = 0;
    }

    /** The next 32 bits as a signed integer. */
    peek32(): number {
        const pos = this.pos;
        const index = pos >>> 5;
        const shift = pos & 31;
        return (this.words[index] << shift) | ((this.words[index + 1] >>> 1) >>> (31 - shift));
    }

    /** The next `count` (1-32) bits, unsigned. */
    peek(count: number): number {
        return this.peek32() >>> (32 - count);
    }

    read(count: number): number {
        const value = this.peek32() >>> (32 - count);
        this.pos += count;
        return value;
    }

    skip(count: number): void {
        this.pos += count;
    }
}
