import { DemuxError } from '../../../core/errors/errors';

/**
 * Decompresses one LZO1X block (the format of Matroska ContentCompAlgo 2) into at most `maxBytes`
 * bytes. Every read and back reference is bounds-checked; a stream that ends without its
 * end-of-stream marker is rejected.
 */
export function lzo1xDecompress(input: Uint8Array, maxBytes: number, what: string): Uint8Array {
    let out = new Uint8Array(Math.min(maxBytes, Math.max(256, input.length * 3)));
    let op = 0;
    let ip = 0;
    const fail = (reason: string): never => {
        throw new DemuxError(`${what} is not valid LZO1X data`, { cause: reason });
    };
    const byte = (): number => (ip < input.length ? input[ip++]! : fail('input ends early'));
    const reserve = (count: number): void => {
        if (count > maxBytes - op) fail(`output exceeds ${maxBytes} bytes`);
        if (op + count <= out.length) return;
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(op + count, out.length * 2)));
        grown.set(out.subarray(0, op));
        out = grown;
    };
    const literals = (count: number): void => {
        if (count > input.length - ip) fail('literal run exceeds the input');
        reserve(count);
        out.set(input.subarray(ip, ip + count), op);
        ip += count;
        op += count;
    };
    const match = (distance: number, count: number): void => {
        if (distance > op) fail('back reference precedes the output');
        reserve(count);
        // Overlapping references repeat the bytes just written, so the copy runs forward one byte
        // at a time.
        for (let from = op - distance, end = op + count; op < end;) out[op++] = out[from++]!;
    };
    /** Run length of `x & mask`, extended by zero bytes of 255 each and a final non-zero byte. */
    const length = (x: number, mask: number): number => {
        let count = x & mask;
        if (count) return count;
        for (let next = byte(); ; next = byte()) {
            if (next) return count + mask + next;
            count += 255;
            if (count > maxBytes) fail('run length exceeds the output limit');
        }
    };

    let x = byte();
    let state = 0;
    if (x > 17) {
        literals(x - 17);
        x = byte();
        if (x < 16) fail('invalid first instruction');
    }
    for (;;) {
        let count: number;
        let distance: number;
        if (x > 63) {
            count = (x >> 5) - 1;
            distance = (byte() << 3) + ((x >> 2) & 7) + 1;
        } else if (x > 31) {
            count = length(x, 31);
            x = byte();
            distance = (byte() << 6) + (x >> 2) + 1;
        } else if (x > 15) {
            count = length(x, 7);
            distance = (1 << 14) + ((x & 8) << 11);
            x = byte();
            distance += (byte() << 6) + (x >> 2);
            if (distance === 1 << 14) {
                if (count !== 1) fail('invalid end-of-stream marker');
                break;
            }
        } else if (!state) {
            literals(length(x, 15) + 3);
            x = byte();
            if (x > 15) continue;
            count = 1;
            distance = (1 << 11) + (byte() << 2) + (x >> 2) + 1;
        } else {
            count = 0;
            distance = (byte() << 2) + (x >> 2) + 1;
        }
        match(distance, count + 2);
        state = x & 3;
        literals(state);
        x = byte();
    }
    return out.slice(0, op);
}
