/**
 * LSb-first bit reader over one Vorbis packet (Vorbis I section 2.1); reads past the end return -1
 * and set `eop`.
 */
export class VorbisBits {
    private bytes: Uint8Array = new Uint8Array(0);
    private at = 0;
    private end = 0;
    eop = false;

    init(bytes: Uint8Array): void {
        this.bytes = bytes;
        this.at = 0;
        this.end = bytes.length * 8;
        this.eop = false;
    }

    get remaining(): number {
        return this.end - this.at;
    }

    /** Reads 0..32 bits. */
    read(count: number): number {
        if (this.eop || this.at + count > this.end) {
            this.eop = true;
            this.at = this.end;
            return -1;
        }
        const value = this.peek(count);
        this.at += count;
        return value;
    }

    /** The next `count` bits (0..32) without consuming them, or -1 when fewer remain. */
    look(count: number): number {
        if (this.eop || this.at + count > this.end) return -1;
        return this.peek(count);
    }

    advance(count: number): void {
        this.at += count;
    }

    private peek(count: number): number {
        const bytes = this.bytes;
        const index = this.at >>> 3;
        const offset = this.at & 7;
        if (count <= 25) {
            const word =
                (bytes[index]! |
                    (bytes[index + 1]! << 8) |
                    (bytes[index + 2]! << 16) |
                    (bytes[index + 3]! << 24)) >>>
                offset;
            return count === 32 ? word >>> 0 : word & ((1 << count) - 1);
        }
        let value = 0;
        let position = this.at;
        let shift = 0;
        let need = count;
        while (need > 0) {
            const byte = position >>> 3;
            const bit = position & 7;
            const take = Math.min(8 - bit, need);
            value += ((bytes[byte]! >>> bit) & ((1 << take) - 1)) * 2 ** shift;
            shift += take;
            position += take;
            need -= take;
        }
        return value;
    }
}

/** Bits needed to represent `value` (Vorbis I section 9.2.1 ilog). */
export function ilog(value: number): number {
    return value <= 0 ? 0 : 32 - Math.clz32(value);
}
