export const join = (...parts) =>
    new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
export const text = value => new TextEncoder().encode(value);
const le32 = value => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
};
export const chunk = (id, data) =>
    join(text(id), le32(data.length), data, data.length & 1 ? [0] : []);
export const list = (type, ...parts) => chunk('LIST', join(text(type), ...parts));

export class Bits {
    bits = '';
    uint(value, width) {
        this.bits += value.toString(2).padStart(width, '0');
        return this;
    }
    ue(value) {
        const binary = (value + 1).toString(2);
        this.bits += '0'.repeat(binary.length - 1) + binary;
        return this;
    }
    se(value) {
        return this.ue(value > 0 ? value * 2 - 1 : -value * 2);
    }
    align() {
        this.bits = this.bits.padEnd(Math.ceil(this.bits.length / 8) * 8, '0');
        return this;
    }
    bytes() {
        this.uint(1, 1).align();
        return Uint8Array.from(this.bits.match(/.{8}/g), byte => parseInt(byte, 2));
    }
}
export const nal = (header, rbsp) => {
    const output = [header];
    let zeros = 0;
    for (const byte of rbsp) {
        if (zeros === 2 && byte <= 3) {
            output.push(3);
            zeros = 0;
        }
        output.push(byte);
        zeros = byte === 0 ? zeros + 1 : 0;
    }
    return Uint8Array.from(output);
};

export const sps = nal(
    0x67,
    join(
        [66, 0, 10],
        new Bits()
            .ue(0)
            .ue(0)
            .ue(2)
            .ue(1)
            .uint(0, 1)
            .ue(1)
            .ue(0)
            .uint(1, 1)
            .uint(1, 1)
            .uint(0, 2)
            .bytes(),
    ),
);
export const pps = nal(
    0x68,
    new Bits()
        .ue(0)
        .ue(0)
        .uint(0, 2)
        .ue(0)
        .ue(0)
        .ue(0)
        .uint(0, 3)
        .ue(0)
        .ue(0)
        .ue(0)
        .uint(1, 1)
        .uint(0, 2)
        .bytes(),
);
const picture = new Bits().ue(0).ue(2).ue(0).uint(0, 4).ue(0).uint(0, 2).ue(0).ue(1);
for (let macroblock = 0; macroblock < 2; macroblock++) {
    picture.ue(25).align();
    for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) picture.uint(32 + ((x + macroblock * 16 + y) % 192), 8);
    for (let plane = 0; plane < 2; plane++)
        for (let sample = 0; sample < 64; sample++) picture.uint(plane === 0 ? 96 : 160, 8);
}
export const idr = nal(0x65, picture.bytes());
export const predicted = nal(
    0x41,
    new Bits().ue(0).ue(0).ue(0).uint(1, 4).uint(0, 3).ue(0).ue(1).ue(2).bytes(),
);
export const aud = Uint8Array.of(9, 0x10);
export const filler = length => join([12], new Uint8Array(length - 2).fill(0xff), [0x80]);
export const annexB = (...nals) =>
    join(...nals.map((data, index) => join(index % 2 ? [0, 0, 1] : [0, 0, 0, 1], data)));
export const lengthPrefixed = (width, ...nals) =>
    join(
        ...nals.map(data => {
            const length = new Uint8Array(width);
            let value = data.length;
            for (let index = width - 1; index >= 0; index--, value = Math.floor(value / 256))
                length[index] = value & 255;
            if (value) throw new Error('Fixture NAL is too long for its length prefix');
            return join(length, data);
        }),
    );
export const avcc = (width = 4) =>
    join([1, 66, 0, 10, 0xfc | (width - 1), 0xe1, 0, sps.length], sps, [1, 0, pps.length], pps);

/**
 * An AVI with one video stream; `fourcc` is also the bitmap compression, and 'BI_RGB' writes
 * compression 0. `audioFormat` adds a mono 8 kHz WAVEFORMATEX stream with that format tag and the
 * '01wb' chunks `audioChunks`; `audioSampleSize` 0 declares variable-size audio frames;
 * `audioChannels` and `audioBits` describe PCM frames.
 */
export function aviH264({
    extra = avcc(),
    packets = [lengthPrefixed(4, idr)],
    fourcc = 'H264',
    bitmapSize = 40,
    audioFormat,
    audioChunks = [new Uint8Array(8).fill(0x7f)],
    audioSampleSize = 1,
    audioScale = 1,
    audioRate = 8000,
    audioBlockAlign = 1,
    audioChannels = 1,
    audioBits = 8,
    width = 32,
    height = 16,
    bitCount = 24,
} = {}) {
    const stream = new Uint8Array(56);
    stream.set(text('vids'), 0);
    if (fourcc !== 'BI_RGB') stream.set(text(fourcc), 4);
    const sh = new DataView(stream.buffer);
    sh.setUint32(20, 1, true);
    sh.setUint32(24, 25, true);
    sh.setUint32(32, packets.length, true);
    const bitmap = new Uint8Array(40);
    const bi = new DataView(bitmap.buffer);
    bi.setUint32(0, bitmapSize, true);
    bi.setInt32(4, width, true);
    bi.setInt32(8, height, true);
    bi.setUint16(12, 1, true);
    bi.setUint16(14, bitCount, true);
    if (fourcc !== 'BI_RGB') bitmap.set(text(fourcc), 16);
    const main = new Uint8Array(56);
    const mh = new DataView(main.buffer);
    mh.setUint32(0, 40000, true);
    mh.setUint32(16, packets.length, true);
    mh.setUint32(24, 1, true);
    mh.setUint32(32, width, true);
    mh.setUint32(36, Math.abs(height), true);
    const audio = [];
    if (audioFormat !== undefined) {
        const header = new Uint8Array(56);
        header.set(text('auds'), 0);
        const ah = new DataView(header.buffer);
        ah.setUint32(20, audioScale, true);
        ah.setUint32(24, audioRate, true);
        ah.setUint32(
            32,
            audioChunks.reduce((sum, data) => sum + (audioSampleSize ? data.length : 1), 0),
            true,
        );
        ah.setUint32(44, audioSampleSize, true);
        const format = new Uint8Array(18);
        const af = new DataView(format.buffer);
        af.setUint16(0, audioFormat, true);
        af.setUint16(2, audioChannels, true);
        af.setUint32(4, 8000, true);
        af.setUint32(8, 8000 * audioBlockAlign, true);
        af.setUint16(12, audioBlockAlign, true);
        af.setUint16(14, audioBits, true);
        audio.push(list('strl', chunk('strh', header), chunk('strf', format)));
        mh.setUint32(24, 2, true);
    }
    const body = join(
        text('AVI '),
        list(
            'hdrl',
            chunk('avih', main),
            list('strl', chunk('strh', stream), chunk('strf', join(bitmap, extra))),
            ...audio,
        ),
        list(
            'movi',
            ...packets.map(data => chunk('00dc', data)),
            ...(audioFormat === undefined ? [] : audioChunks.map(data => chunk('01wb', data))),
        ),
    );
    return chunk('RIFF', body);
}

export function readNals(data, width) {
    const nals = [];
    let offset = 0;
    while (offset < data.length) {
        if (offset + width > data.length) throw new Error('Truncated output NAL length');
        let length = 0;
        for (let index = 0; index < width; index++) length = length * 256 + data[offset++];
        if (!length || offset + length > data.length) throw new Error('Invalid output NAL range');
        nals.push(data.slice(offset, offset + length));
        offset += length;
    }
    return nals;
}

export function aviChunks(bytes, start = 0, end = bytes.length) {
    const chunks = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = start; offset < end;) {
        if (offset + 8 > end) throw new Error('Invalid fixture chunk header');
        const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
        const size = view.getUint32(offset + 4, true);
        const data = offset + 8;
        const payloadEnd = data + size;
        const next = payloadEnd + (size & 1);
        if (next > end) throw new Error('Invalid fixture chunk range');
        const container = id === 'RIFF' || id === 'LIST';
        const type = container ? String.fromCharCode(...bytes.subarray(data, data + 4)) : '';
        const children = container ? aviChunks(bytes, data + 4, payloadEnd) : [];
        chunks.push({ id, type, offset, data, size, end: payloadEnd, next, children });
        offset = next;
    }
    return chunks;
}

export function aviRecordLists(bytes) {
    const [riff] = aviChunks(bytes);
    const movie = riff.children.find(chunk => chunk.type === 'movi');
    const records = list('rec ', list('rec ', bytes.subarray(movie.data + 4, movie.end)));
    const output = join(bytes.subarray(0, movie.data + 4), records, bytes.subarray(movie.end));
    const view = new DataView(output.buffer);
    const delta = records.length - (movie.size - 4);
    view.setUint32(4, riff.size + delta, true);
    view.setUint32(movie.offset + 4, movie.size + delta, true);
    return output;
}

export function aviAvix(bytes, packetCount) {
    const [riff] = aviChunks(bytes);
    const movie = riff.children.find(chunk => chunk.type === 'movi');
    const cut = movie.children[packetCount - 1].next;
    const first = bytes.slice(0, cut);
    const view = new DataView(first.buffer);
    view.setUint32(4, first.length - 8, true);
    view.setUint32(movie.offset + 4, first.length - movie.data, true);
    return join(
        first,
        chunk('RIFF', join(text('AVIX'), list('movi', bytes.subarray(cut, movie.end)))),
    );
}
