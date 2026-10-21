const u32 = value => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
};
const words = values => Buffer.concat(values.map(u32));
const box = (type, ...parts) => {
    const payload = Buffer.concat(parts);
    return Buffer.concat([u32(payload.length + 8), Buffer.from(type), payload]);
};
const full = (type, payload, version = 0) => box(type, Buffer.from([version, 0, 0, 0]), payload);
const runs = (type, entries, version = 0) =>
    full(type, Buffer.concat([u32(entries.length), words(entries.flat())]), version);
const u64 = value => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt.asUintN(64, BigInt(value)));
    return bytes;
};
const aacSampleRates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

function editList(edits, version) {
    const entries = edits.map(([duration, media]) =>
        version === 1
            ? Buffer.concat([u64(duration), u64(media), u32(0x10000)])
            : Buffer.concat([u32(duration), u32(media), u32(0x10000)]),
    );
    return box('edts', full('elst', Buffer.concat([u32(edits.length), ...entries]), version));
}

export function classicMp4(options = {}) {
    const count = options.count ?? options.sizes?.length ?? options.payloads?.length ?? 6;
    const sizes =
        options.sizes ??
        options.payloads?.map(bytes => bytes.length) ??
        new Array(count).fill(options.constantSize ?? 4);
    const constantSize = options.constantSize ?? (options.sizes || options.payloads ? 0 : 4);
    const timescale = options.timescale ?? 1000;
    const movieTimescale = options.movieTimescale ?? timescale;
    const sampleRate = options.sampleRate ?? 48000;
    const rateIndex = aacSampleRates.indexOf(sampleRate);
    if (rateIndex < 0) throw new Error(`Unsupported AAC sample rate ${sampleRate}`);
    const asc = options.asc ?? [0x10 | (rateIndex >> 1), ((rateIndex & 1) << 7) | 0x08];
    const timing = options.timing ?? [[count, 40]];
    const chunkSamples = options.chunkSamples ?? [count];
    const gapBytes = options.gapBytes ?? 0;
    const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isommp42'));
    const payload = Buffer.alloc(
        sizes.reduce((sum, size) => sum + size, 0) +
            gapBytes * Math.max(0, chunkSamples.length - 1),
    );
    const chunkOffsets = [];
    const sampleOffsets = [];
    let sample = 0;
    let cursor = 0;
    for (let chunk = 0; chunk < chunkSamples.length; chunk++) {
        chunkOffsets.push(ftyp.length + 8 + cursor);
        for (let entry = 0; entry < chunkSamples[chunk] && sample < count; entry++, sample++) {
            sampleOffsets.push(ftyp.length + 8 + cursor);
            for (let byte = 0; byte < sizes[sample]; byte++)
                payload[cursor++] = options.payloads
                    ? options.payloads[sample][byte]
                    : (sample * 37 + byte * 11 + 7) & 255;
        }
        if (chunk + 1 < chunkSamples.length) cursor += gapBytes;
    }
    const layout =
        options.layout ??
        chunkSamples.flatMap((samples, chunk) =>
            chunk === 0 || samples !== chunkSamples[chunk - 1] ? [[chunk + 1, samples, 1]] : [],
        );
    const mvhd = Buffer.alloc(96);
    mvhd.writeUInt32BE(movieTimescale, 8);
    const mdhd = Buffer.alloc(20);
    mdhd.writeUInt32BE(timescale, 8);
    mdhd.writeUInt32BE(timing.reduce((sum, [length, delta]) => sum + length * delta, 0) >>> 0, 12);
    mdhd.writeUInt16BE(0x15c7, 16);
    const tkhd = Buffer.alloc(80);
    tkhd.writeUInt32BE(1, 8);
    tkhd.writeUInt32BE(0x10000, 36);
    tkhd.writeUInt32BE(0x10000, 52);
    tkhd.writeUInt32BE(0x40000000, 68);
    const audio = Buffer.alloc(28);
    audio.writeUInt16BE(1, 6);
    audio.writeUInt16BE(1, 16);
    audio.writeUInt16BE(16, 18);
    audio.writeUInt32BE(sampleRate * 65536, 24);
    const esds = full(
        'esds',
        Buffer.from([
            3,
            23 + asc.length,
            0,
            1,
            0,
            4,
            15 + asc.length,
            0x40,
            0x15,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            5,
            asc.length,
            ...asc,
            6,
            1,
            2,
        ]),
    );
    let sampleSizes;
    if (options.field) {
        const field = options.field;
        const packed = Buffer.alloc(Math.ceil((count * field) / 8));
        for (let index = 0; index < count; index++) {
            if (field === 16) packed.writeUInt16BE(sizes[index], index * 2);
            else if (field === 8) packed[index] = sizes[index];
            else packed[index >>> 1] |= sizes[index] << (index & 1 ? 0 : 4);
        }
        sampleSizes = full(
            'stz2',
            Buffer.concat([Buffer.from([0, 0, 0, field]), u32(count), packed]),
        );
    } else
        sampleSizes = full(
            'stsz',
            Buffer.concat([
                u32(constantSize),
                u32(count),
                constantSize ? Buffer.alloc(0) : words(sizes),
            ]),
        );
    const offsets = options.offsets ?? chunkOffsets;
    const chunkTable = options.co64
        ? full(
              'co64',
              Buffer.concat([
                  u32(offsets.length),
                  ...offsets.map(offset => {
                      const out = Buffer.alloc(8);
                      out.writeBigUInt64BE(BigInt(offset));
                      return out;
                  }),
              ]),
          )
        : full('stco', Buffer.concat([u32(offsets.length), words(offsets)]));
    const stbl = box(
        'stbl',
        full(
            'stsd',
            Buffer.concat([u32(1), box('mp4a', audio, ...(options.esds === false ? [] : [esds]))]),
        ),
        sampleSizes,
        chunkTable,
        runs('stsc', layout),
        runs('stts', timing),
        ...(options.composition
            ? [runs('ctts', options.composition, options.compositionVersion ?? 1)]
            : []),
        ...(options.sync
            ? [full('stss', Buffer.concat([u32(options.sync.length), words(options.sync)]))]
            : []),
        ...(options.extraTables ?? []),
    );
    const edits = options.edits
        ? editList(options.edits, options.editVersion ?? 0)
        : Buffer.alloc(0);
    const moov = box(
        'moov',
        full('mvhd', mvhd),
        box(
            'trak',
            full('tkhd', tkhd),
            edits,
            box(
                'mdia',
                full('mdhd', mdhd),
                full('hdlr', Buffer.concat([u32(0), Buffer.from('soun'), Buffer.alloc(12)])),
                box('minf', stbl),
            ),
        ),
    );
    const bytes = new Uint8Array(Buffer.concat([ftyp, box('mdat', payload), moov]));
    return { bytes, sampleOffsets, sizes, moovOffset: ftyp.length + payload.length + 8 };
}

export function patchTable(bytes, type, relativeOffset, value) {
    const output = bytes.slice();
    const at = Buffer.from(output.buffer, output.byteOffset, output.byteLength).indexOf(type);
    if (at < 4) throw new Error(`Missing ${type} fixture table`);
    new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(
        at - 4 + relativeOffset,
        value,
        false,
    );
    return output;
}

export function fixtureSource(bytes) {
    return {
        size: bytes.byteLength,
        read: async (offset, length) => bytes.slice(offset, offset + length),
    };
}
