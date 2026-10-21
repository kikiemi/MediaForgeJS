const PADDING_BYTES = 16;

/** MSB-first reader over a private zero-padded copy, so reads past the payload yield zero bits. */
export class BitReader {
    data = new Uint8Array(PADDING_BYTES);
    /** Current position in bits from the start of the loaded payload. */
    pos = 0;
    /** Payload length in bits. */
    end = 0;

    load(source: Uint8Array, start: number, length: number): void {
        if (this.data.length < length + PADDING_BYTES)
            this.data = new Uint8Array(length + PADDING_BYTES + (length >> 1));
        this.data.set(source.subarray(start, start + length));
        this.data.fill(0, length, length + PADDING_BYTES);
        this.pos = 0;
        this.end = length * 8;
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

    read1(): number {
        const value = (this.data[this.pos >>> 3] >> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return value;
    }

    skip(n: number): void {
        this.pos += n;
    }

    /** Two's-complement value of `n` bits, 1 <= n <= 25. */
    readSigned(n: number): number {
        return (this.read(n) << (32 - n)) >> (32 - n);
    }

    /**
     * Value of a `size`-bit differential whose leading zero bit marks a negative value (ISO/IEC
     * 14496-2 Table B-15).
     */
    readDifferential(size: number): number {
        const value = this.read(size);
        return value >>> (size - 1) ? value : value - (1 << size) + 1;
    }
}
