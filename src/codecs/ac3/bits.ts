/** Most significant bit first reads of one frame; past its end it reads zeros and says so. */
export class FrameBits {
    position: number;
    private readonly limit: number;

    constructor(
        private readonly data: Uint8Array,
        start: number,
        end: number,
    ) {
        this.position = start * 8;
        this.limit = end * 8;
    }

    /** The next `count` bits (at most 24), unsigned. */
    read(count: number): number {
        let value = 0;
        let position = this.position;
        let left = count;
        while (left > 0) {
            const byte = position >> 3;
            const free = 8 - (position & 7);
            const take = left < free ? left : free;
            const bits =
                position < this.limit ? (this.data[byte]! >> (free - take)) & ((1 << take) - 1) : 0;
            value = (value << take) | bits;
            position += take;
            left -= take;
        }
        this.position = position;
        return value;
    }

    /** The next `count` bits as a two's complement number. */
    signed(count: number): number {
        const value = this.read(count);
        return value >= 1 << (count - 1) ? value - (1 << count) : value;
    }

    flag(): boolean {
        return this.read(1) === 1;
    }

    skip(count: number): void {
        this.position += count;
    }

    /** True when the reads went past the frame. */
    get overrun(): boolean {
        return this.position > this.limit;
    }
}
