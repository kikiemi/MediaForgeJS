export declare class BinaryWriter {
    private buf;
    private view;
    private pos;
    constructor(initialCapacity?: number);
    /** Bytes written so far. */
    get size(): number;
    private ensureCapacity;
    writeU8(v: number): void;
    writeU16BE(v: number): void;
    writeU16LE(v: number): void;
    writeU32BE(v: number): void;
    writeU32LE(v: number): void;
    writeBytes(data: Uint8Array): void;
    /** Appends the string's ASCII bytes. */
    writeASCII(str: string): void;
    writeZeros(count: number): void;
    /** Returns an independent copy of the written bytes. */
    toUint8Array(): Uint8Array;
}
export declare class BitSink {
    private buf;
    private len;
    private acc;
    private accBits;
    writeBits(value: number, bits: number): void;
    writeUnary(value: number): void;
    alignByte(): void;
    get bytePosition(): number;
    bytes(): Uint8Array<ArrayBuffer>;
    toUint8Array(): Uint8Array<ArrayBuffer>;
    private ensureCapacity;
    private push;
}
