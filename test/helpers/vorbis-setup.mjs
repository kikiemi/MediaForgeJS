// Vorbis setup header edits for the decoder and header-parsing tests.

/**
 * `setup` with one more codebook after the existing ones: one dimension, four entries that are
 * all unused (a sparse codebook marking no entry), no lookup. libvorbis and ffmpeg accept it; it
 * is valid until a packet reads from it.
 */
export function withUnusedCodebook(setup) {
    const bits = [];
    for (const byte of setup) for (let bit = 0; bit < 8; bit++) bits.push((byte >> bit) & 1);
    let at = 64;
    const take = count => {
        let value = 0;
        for (let bit = 0; bit < count; bit++) value += bits[at + bit] * 2 ** bit;
        at += count;
        return value;
    };
    const books = bits.slice(56, 64).reduce((sum, bit, index) => sum + bit * 2 ** index, 0) + 1;
    for (let book = 0; book < books; book++) {
        take(24);
        const dimensions = take(16);
        const entries = take(24);
        if (take(1)) {
            for (let done = 0, length = take(5) + 1; done < entries; length++)
                done += take(32 - Math.clz32(entries - done));
        } else {
            const sparse = take(1);
            for (let entry = 0; entry < entries; entry++) if (!sparse || take(1)) take(5);
        }
        const lookup = take(4);
        if (lookup) {
            take(32);
            take(32);
            const valueBits = take(4) + 1;
            take(1);
            let values = entries * dimensions;
            if (lookup === 1) {
                values = Math.floor(entries ** (1 / dimensions));
                while ((values + 1) ** dimensions <= entries) values++;
                while (values ** dimensions > entries) values--;
            }
            at += values * valueBits;
        }
    }
    const field = (value, count) =>
        Array.from({ length: count }, (_, bit) => Math.floor(value / 2 ** bit) % 2);
    const emptyBook = [
        ...field(0x564342, 24),
        ...field(1, 16),
        ...field(4, 24),
        0,
        1,
        0,
        0,
        0,
        0,
        ...field(0, 4),
    ];
    const extended = [
        ...bits.slice(0, 56),
        ...field(books, 8),
        ...bits.slice(64, at),
        ...emptyBook,
        ...bits.slice(at),
    ];
    const bytes = new Uint8Array(Math.ceil(extended.length / 8));
    extended.forEach((bit, index) => (bytes[index >> 3] |= bit << (index & 7)));
    return bytes;
}
