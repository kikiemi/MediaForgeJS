const PADDING_BYTES = 32;

/**
 * MSB-first reader over the RBSP of one NAL unit: `load` copies the payload with emulation
 * prevention bytes removed (7.4.1) into a private buffer that is zero past it, so reads past the
 * end yield zero bits however far they go.
 */
export class BitReader {
    data = new Uint8Array(PADDING_BYTES);
    /** Every byte of `data` from here on is zero. */
    private zeroFrom = 0;
    /** Position in bits from the start of the RBSP. */
    pos = 0;
    /** Bits before rbsp_stop_one_bit; trailing cabac_zero_words are excluded. */
    end = 0;
    /** Bytes of RBSP stored in `data`, including the stop bit and any cabac_zero_words. */
    byteLength = 0;

    /** Loads `source[start, stop)` (the NAL payload after its header byte). */
    load(source: Uint8Array, start: number, stop: number): void {
        const length = stop - start;
        if (this.data.length < length + PADDING_BYTES) {
            this.data = new Uint8Array(length + PADDING_BYTES + (length >> 1));
            this.zeroFrom = 0;
        }
        const d = this.data;
        let out = 0;
        let zeros = 0;
        for (let i = start; i < stop; i++) {
            const byte = source[i];
            if (zeros >= 2 && byte === 3) {
                zeros = 0;
                continue;
            }
            d[out++] = byte;
            zeros = byte === 0 ? zeros + 1 : 0;
        }
        d.fill(0, out, Math.max(this.zeroFrom, out));
        this.zeroFrom = out;
        this.pos = 0;
        this.byteLength = out;
        while (out > 0 && d[out - 1] === 0) out--;
        this.end = out ? out * 8 - 32 + Math.clz32(d[out - 1] & -d[out - 1]) : 0;
    }

    /** Next `n` bits without consuming them, 1 <= n <= 25. */
    peek(n: number): number {
        const d = this.data;
        const p = this.pos >>> 3;
        return (
            (((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) << (this.pos & 7)) >>>
            (32 - n)
        );
    }

    /** Consumes `n` bits, 1 <= n <= 25. */
    read(n: number): number {
        const value = this.peek(n);
        this.pos += n;
        return value;
    }

    /** Consumes `n` bits, 0 <= n <= 32; results of 32 bits are unsigned. */
    readLong(n: number): number {
        if (n === 0) return 0;
        if (n <= 25) return this.read(n);
        const high = this.read(n - 16);
        return high * 65536 + this.read(16);
    }

    read1(): number {
        const value = (this.data[this.pos >>> 3] >> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return value;
    }

    skip(n: number): void {
        this.pos += n;
    }

    /**
     * ue(v) Exp-Golomb code (9.1); values with more than 31 leading zeros read as 2^32 - 1 with the
     * bits consumed.
     */
    ue(): number {
        let zeros = 0;
        let bits = this.peek(16);
        if (bits === 0) {
            this.pos += 16;
            zeros = 16;
            bits = this.peek(16);
            if (bits === 0) {
                this.pos += 16;
                return 0xffffffff;
            }
        }
        const lead = Math.clz32(bits) - 16;
        zeros += lead;
        this.pos += lead + 1;
        if (zeros === 0) return 0;
        return 2 ** zeros - 1 + this.readLong(zeros);
    }

    se(): number {
        const code = this.ue();
        return code & 1 ? (code + 1) >>> 1 : -(code >>> 1);
    }

    /** te(v) with the given range (9.1). */
    te(range: number): number {
        if (range > 1) return this.ue();
        return this.read1() ^ 1;
    }

    bitsLeft(): number {
        return this.end - this.pos;
    }

    /** Whether data other than the rbsp_trailing_bits remains (7.2 more_rbsp_data()). */
    moreRbspData(): boolean {
        return this.pos < this.end;
    }

    /** Skips to the next byte boundary. */
    align(): void {
        this.pos = (this.pos + 7) & ~7;
    }
}
