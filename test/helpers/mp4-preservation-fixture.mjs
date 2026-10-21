import assert from 'node:assert/strict';

const bytes = text => Buffer.from(text, 'utf8');
const code = text => Buffer.from(text, 'latin1');
const u32 = value => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0);
    return out;
};
const u16 = value => {
    const out = Buffer.alloc(2);
    out.writeUInt16BE(value);
    return out;
};
const cat = (...parts) => Buffer.concat(parts);
export const atom = (type, ...parts) => {
    const payload = cat(...parts);
    return cat(u32(payload.length + 8), typeof type === 'number' ? u32(type) : code(type), payload);
};
const full = (type, flags, ...parts) => atom(type, u32(flags), ...parts);
const table = (type, rows) => full(type, 0, u32(rows.length), ...rows.flat().map(u32));
export const avcc = Uint8Array.from([
    1, 66, 0, 30, 255, 225, 0, 4, 103, 66, 0, 30, 1, 0, 2, 104, 128,
]);
export const asc = Uint8Array.from([0x11, 0x90]);

function titleAtom(title, mode = 'mdta') {
    if (title === undefined) return Buffer.alloc(0);
    if (mode === 'legacy')
        return atom('udta', atom('©nam', u16(bytes(title).length), u16(0x55c4), bytes(title)));
    const data = atom('data', u32(1), u32(0), bytes(title));
    const handler = full(
        'hdlr',
        0,
        u32(0),
        code(mode === 'ilst' ? 'mdir' : 'mdta'),
        Buffer.alloc(12),
        u32(0),
    );
    if (mode === 'ilst')
        return atom('udta', full('meta', 0, handler, atom('ilst', atom('©nam', data))));
    const key = atom('mdta', bytes('com.apple.quicktime.title'));
    return atom('meta', handler, full('keys', 0, u32(1), key), atom('ilst', atom(1, data)));
}

function userData(track) {
    const children = [];
    if (track.name !== undefined && track.nameMode !== 'hdlr') {
        let text = cat(bytes(track.name), Buffer.of(0));
        if (track.nameMode === 'utf16') {
            const little = Buffer.from(`${track.name}\0`, 'utf16le');
            little.swap16();
            text = cat(Buffer.of(0xfe, 0xff), little);
        }
        children.push(atom('tnam', u32(0), u16(0x55c4), text));
    }
    if (track.forced && track.codec !== 'tx3g') {
        children.push(full('kind', 0, bytes('urn:mpeg:dash:role:2011\0forced-subtitle\0')));
    }
    if (track.commentary)
        children.push(full('kind', 0, bytes('urn:mpeg:dash:role:2011\0commentary\0')));
    children.push(...(track.userBoxes ?? []));
    return children.length ? atom('udta', ...children) : Buffer.alloc(0);
}

function sampleEntry(track) {
    if (track.type === 'video') {
        const base = Buffer.alloc(78);
        base.writeUInt16BE(1, 6);
        base.writeUInt16BE(track.width ?? 32, 24);
        base.writeUInt16BE(track.height ?? 24, 26);
        base.writeUInt32BE(72 * 65536, 28);
        base.writeUInt32BE(72 * 65536, 32);
        base.writeUInt16BE(1, 40);
        base.writeUInt16BE(24, 74);
        base.writeUInt16BE(65535, 76);
        return atom(
            track.codec ?? 'avc1',
            base,
            ...(track.codec?.startsWith('ap') ? [] : [atom('avcC', track.codecConfig ?? avcc)]),
            ...(track.entryBoxes ?? []),
        );
    }
    if (track.type === 'subtitle') {
        const base = Buffer.alloc(8);
        base.writeUInt16BE(1, 6);
        if (track.codec === 'tx3g') {
            const config = Buffer.alloc(30);
            config.writeUInt32BE(track.forced ? 0x40000000 : 0);
            return atom('tx3g', base, config);
        }
        return atom('wvtt', base, atom('vttC', bytes('WEBVTT\n')));
    }
    if (track.audioEntry) return track.audioEntry;
    const base = Buffer.alloc(28);
    base.writeUInt16BE(1, 6);
    base.writeUInt16BE(2, 16);
    base.writeUInt16BE(16, 18);
    base.writeUInt32BE(48000 * 65536, 24);
    return atom(
        'mp4a',
        base,
        full(
            'esds',
            0,
            Buffer.from([
                3,
                25,
                0,
                1,
                0,
                4,
                17,
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
                2,
                ...asc,
                6,
                1,
                2,
            ]),
        ),
    );
}

function trackAtom(track, offsets) {
    const ticks = track.type === 'audio' ? 1024 : 40;
    const scale = track.type === 'audio' ? 48000 : 1000;
    const head = Buffer.alloc(track.version1 ? 92 : 80);
    const shift = track.version1 ? 12 : 0;
    head.writeUInt32BE(track.id, track.version1 ? 16 : 8);
    // The display matrix: a, b, c and d in 16.16 (identity unless the track states one), w in 2.30.
    const [a, b, c, d] = track.matrix ?? [1, 0, 0, 1];
    for (const [value, at] of [
        [a, 36],
        [b, 40],
        [c, 48],
        [d, 52],
    ])
        head.writeInt32BE(Math.round(value * 65536), at + shift);
    head.writeUInt32BE(0x40000000, 68 + shift);
    if (track.type === 'video') {
        head.writeUInt32BE((track.width ?? 32) * 65536, 72 + shift);
        head.writeUInt32BE((track.height ?? 24) * 65536, 76 + shift);
    }
    const media = Buffer.alloc(20);
    media.writeUInt32BE(scale, 8);
    media.writeUInt32BE(track.packets.length * ticks, 12);
    media.writeUInt16BE(track.languageCode ?? 0x55c4, 16);
    const name = track.nameMode === 'hdlr' ? track.name : (track.handlerName ?? '');
    const encodedName = track.handlerBytes ?? bytes(name);
    const handlerName =
        track.handlerField ??
        (track.pascalHandler
            ? cat(Buffer.of(encodedName.length), encodedName)
            : cat(encodedName, Buffer.of(0)));
    const handler = full(
        'hdlr',
        (track.handlerVersion ?? 0) << 24,
        track.handlerComponent
            ? code(track.handlerComponent)
            : track.pascalHandler
              ? code('mhlr')
              : u32(0),
        code(track.type === 'video' ? 'vide' : track.type === 'audio' ? 'soun' : 'text'),
        ...(track.shortHandler ? [] : [Buffer.alloc(12), handlerName]),
    );
    const stbl = atom(
        'stbl',
        full('stsd', 0, u32(1), sampleEntry(track)),
        table('stts', [[track.packets.length, ticks]]),
        table('stsc', [[1, 1, 1]]),
        full(
            'stsz',
            0,
            u32(0),
            u32(track.packets.length),
            ...track.packets.map(p => u32(p.length)),
        ),
        table(
            'stco',
            offsets.map(offset => [offset]),
        ),
        // Composition offsets in track ticks, one per sample.
        ...(track.compositionOffsets
            ? [
                  table(
                      'ctts',
                      track.compositionOffsets.map(offset => [1, offset]),
                  ),
              ]
            : []),
        ...(track.sync
            ? [
                  table(
                      'stss',
                      track.sync.map(number => [number]),
                  ),
              ]
            : []),
    );
    return atom(
        'trak',
        full(
            'tkhd',
            (track.version1 ? 0x1000000 : 0) | (track.flags ?? (track.default === false ? 2 : 3)),
            head,
        ),
        ...(track.chapters ? [atom('tref', atom('chap', ...track.chapters.map(u32)))] : []),
        // Edits of `duration` in the movie timescale (ms) from `mediaTime` in the track timescale.
        ...(track.edit || track.edits
            ? [
                  atom(
                      'edts',
                      table(
                          'elst',
                          (track.edits ?? [track.edit]).map(edit => [
                              edit.duration,
                              edit.mediaTime,
                              0x10000,
                          ]),
                      ),
                  ),
              ]
            : []),
        atom('mdia', full('mdhd', 0, media), handler, atom('minf', stbl)),
        userData(track),
        titleAtom(track.title, track.titleMode),
    );
}

export function preservationFixture(options = {}) {
    const sourceTracks = options.tracks ?? [
        { type: 'video', name: 'Camera α', title: 'Opening / 主映像', default: false },
        { type: 'audio', name: 'Main é', title: 'Mix A', default: true },
        { type: 'video', name: '', title: '', default: true, version1: true },
        {
            type: 'audio',
            name: 'Commentary 日本語',
            title: 'Notes',
            default: true,
            commentary: true,
        },
    ];
    const tracks = sourceTracks.map((track, index) => ({
        ...track,
        id: track.id ?? index + 11,
        codec:
            track.codec ??
            (track.type === 'video' ? 'avc1' : track.type === 'audio' ? 'mp4a' : 'wvtt'),
        packets:
            track.packets ??
            Array.from({ length: 3 }, (_, sample) =>
                track.type === 'subtitle'
                    ? atom('vtte')
                    : track.type === 'video' && !track.codec?.startsWith('ap')
                      ? Buffer.of(0, 0, 0, 2, 0x65, 0x80 | sample)
                      : Buffer.of(0x21, index + 1, sample + 1, 0x7f),
            ),
    }));
    const ftyp = atom(
        'ftyp',
        code(options.mov ? 'qt  ' : 'isom'),
        u32(512),
        code(options.mov ? 'qt  ' : 'isommp42'),
    );
    const packets = [];
    const offsets = tracks.map(() => []);
    let offset = ftyp.length + 8;
    for (
        let sample = 0;
        sample < Math.max(...tracks.map(track => track.packets.length));
        sample++
    ) {
        tracks.forEach((track, index) => {
            if (!track.packets[sample]) return;
            offsets[index].push(offset);
            packets.push(track.packets[sample]);
            offset += track.packets[sample].length;
        });
    }
    const movie = Buffer.alloc(96);
    movie.writeUInt32BE(1000, 8);
    movie.writeUInt32BE(120, 12);
    if (options.movieMatrix) {
        const [a, b, c, d] = options.movieMatrix;
        for (const [value, at] of [
            [a, 32],
            [b, 36],
            [c, 44],
            [d, 48],
        ])
            movie.writeInt32BE(Math.round(value * 65536), at);
        movie.writeUInt32BE(0x40000000, 64);
    }
    const moov = atom(
        'moov',
        full('mvhd', 0, movie),
        ...tracks.map((track, index) => trackAtom(track, offsets[index])),
        titleAtom(options.title, options.titleMode),
        ...(options.movieBoxes ?? []),
    );
    return { bytes: new Uint8Array(cat(ftyp, atom('mdat', ...packets), moov)), tracks };
}

export function atomList(input, start = 0, end = input.length) {
    const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const result = [];
    for (let position = start; position < end;) {
        assert.ok(position + 8 <= end, 'incomplete atom header');
        let size = data.readUInt32BE(position);
        let header = 8;
        if (size === 1) {
            assert.ok(position + 16 <= end);
            size = Number(data.readBigUInt64BE(position + 8));
            header = 16;
        }
        if (size === 0) size = end - position;
        assert.ok(
            Number.isSafeInteger(size) && size >= header && position + size <= end,
            'invalid atom boundary',
        );
        result.push({
            type: data.toString('latin1', position + 4, position + 8),
            offset: position,
            payload: position + header,
            end: position + size,
        });
        position += size;
    }
    return result;
}

export function inspectMovie(input) {
    const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const children = parent => atomList(data, parent.payload, parent.end);
    const child = (parent, type) => children(parent).find(entry => entry.type === type);
    const cstring = (start, end) => {
        const zero = data.indexOf(0, start);
        return data.toString('utf8', start, zero < 0 || zero >= end ? end : zero);
    };
    const title = parent => {
        const candidates = [
            ...children(parent),
            ...children(parent)
                .filter(entry => entry.type === 'udta')
                .flatMap(children),
        ];
        for (const meta of candidates.filter(entry => entry.type === 'meta')) {
            const start = data.readUInt32BE(meta.payload) === 0 ? meta.payload + 4 : meta.payload;
            const contents = atomList(data, start, meta.end);
            const keys = contents.find(entry => entry.type === 'keys');
            const names = keys
                ? atomList(data, keys.payload + 8, keys.end).map(entry =>
                      data.toString('utf8', entry.payload, entry.end),
                  )
                : [];
            const ilst = contents.find(entry => entry.type === 'ilst');
            if (!ilst) continue;
            for (const item of children(ilst)) {
                if (
                    item.type !== '©nam' &&
                    names[data.readUInt32BE(item.offset + 4) - 1] !== 'com.apple.quicktime.title'
                )
                    continue;
                const value = child(item, 'data');
                if (value && data.readUInt32BE(value.payload) === 1)
                    return data.toString('utf8', value.payload + 8, value.end);
            }
        }
        const legacy = candidates.find(entry => entry.type === '©nam');
        return legacy
            ? data.toString(
                  'utf8',
                  legacy.payload + 4,
                  legacy.payload + 4 + data.readUInt16BE(legacy.payload),
              )
            : undefined;
    };
    const moov = atomList(data).find(entry => entry.type === 'moov');
    assert.ok(moov, 'missing moov');
    const tracks = children(moov)
        .filter(entry => entry.type === 'trak')
        .map(trak => {
            const tkhd = child(trak, 'tkhd');
            const mdia = child(trak, 'mdia');
            const handler = child(mdia, 'hdlr');
            const kind = data.toString('ascii', handler.payload + 8, handler.payload + 12);
            const user = children(trak)
                .filter(entry => entry.type === 'udta')
                .flatMap(children);
            const tnam = user.find(entry => entry.type === 'tnam');
            let name;
            if (tnam) {
                const text = data.subarray(tnam.payload + 6, tnam.end);
                if (text[0] === 254 && text[1] === 255) {
                    const copy = Buffer.from(text.subarray(2));
                    copy.swap16();
                    name = copy.toString('utf16le').replace(/\0$/, '');
                } else name = cstring(tnam.payload + 6, tnam.end);
            } else if (data.toString('ascii', handler.payload + 4, handler.payload + 8) === 'mhlr')
                name = data.toString(
                    'utf8',
                    handler.payload + 25,
                    handler.payload + 25 + data[handler.payload + 24],
                );
            else name = cstring(handler.payload + 24, handler.end) || undefined;
            const roles = user
                .filter(entry => entry.type === 'kind')
                .map(entry => data.toString('utf8', entry.payload + 4, entry.end).split('\0'));
            const stbl = child(child(mdia, 'minf'), 'stbl');
            const stsd = child(stbl, 'stsd');
            const entry = atomList(data, stsd.payload + 8, stsd.end)[0];
            const sizes = child(stbl, 'stsz');
            const stco = child(stbl, 'stco') ?? child(stbl, 'co64');
            const count = sizes ? data.readUInt32BE(sizes.payload + 8) : 0;
            const packetBytes = [];
            const stsc = child(stbl, 'stsc');
            const runs = Array.from(
                { length: stsc ? data.readUInt32BE(stsc.payload + 4) : 0 },
                (_, i) => ({
                    first: data.readUInt32BE(stsc.payload + 8 + i * 12),
                    samples: data.readUInt32BE(stsc.payload + 12 + i * 12),
                }),
            );
            let sample = 0;
            let run = 0;
            const chunks = stco ? data.readUInt32BE(stco.payload + 4) : 0;
            for (let index = 0; index < chunks; index++) {
                while (run + 1 < runs.length && runs[run + 1].first <= index + 1) run++;
                let offset =
                    stco.type === 'co64'
                        ? Number(data.readBigUInt64BE(stco.payload + 8 + index * 8))
                        : data.readUInt32BE(stco.payload + 8 + index * 4);
                for (let inChunk = 0; inChunk < runs[run].samples; inChunk++) {
                    assert(sample < count, 'chunk table contains too many samples');
                    const size =
                        data.readUInt32BE(sizes.payload + 4) ||
                        data.readUInt32BE(sizes.payload + 12 + sample * 4);
                    assert(offset + size <= data.length, 'sample points outside output');
                    packetBytes.push([...data.subarray(offset, offset + size)]);
                    offset += size;
                    sample++;
                }
            }
            assert.equal(sample, count, 'chunk table must account for every sample');
            return {
                id: data.readUInt32BE(tkhd.payload + (data[tkhd.payload] === 1 ? 20 : 12)),
                type: kind === 'vide' ? 'video' : kind === 'soun' ? 'audio' : 'subtitle',
                default: !!(data.readUInt32BE(tkhd.payload) & 1),
                forced:
                    roles.some(
                        ([scheme, role]) =>
                            scheme === 'urn:mpeg:dash:role:2011' && role === 'forced-subtitle',
                    ) ||
                    (entry.type === 'tx3g' &&
                        !!(data.readUInt32BE(entry.payload + 8) & 0x40000000)),
                commentary: roles.some(
                    ([scheme, role]) =>
                        scheme === 'urn:mpeg:dash:role:2011' && role === 'commentary',
                ),
                name,
                title: title(trak),
                codec: entry.type,
                packets: packetBytes,
                sampleEntryChildren:
                    kind === 'vide'
                        ? atomList(data, entry.offset + 86, entry.end).map(value => value.type)
                        : [],
            };
        });
    return { title: title(moov), tracks };
}

export const preservationSource = data => ({
    size: data.length,
    read: async (offset, length) => data.slice(offset, offset + length),
});
