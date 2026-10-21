import assert from 'node:assert/strict';

export const join = (...parts) =>
    new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
const text = value => new TextEncoder().encode(value);
const integer = (value, width, little = false) => {
    const bytes = new Uint8Array(width);
    let n = BigInt(value);
    for (let index = 0; index < width; index++, n >>= 8n)
        bytes[little ? index : width - index - 1] = Number(n & 255n);
    return bytes;
};
const vint = value => {
    let width = 1;
    while (value >= 2 ** (width * 7) - 1) width++;
    return integer(BigInt(value) | (1n << BigInt(width * 7)), width);
};
export const element = (id, ...parts) => {
    const data = join(...parts);
    return join(integer(id, Math.ceil(Math.log2(id + 1) / 8)), vint(data.length), data);
};
export const uint = (id, value) =>
    element(id, integer(value, Math.max(1, Math.ceil(BigInt(value).toString(2).length / 8))));
export const string = (id, value) => element(id, text(value));
const float = (id, value) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value);
    return element(id, bytes);
};

export const trackSpecs = [
    {
        id: 7,
        uid: 700001n,
        type: 'video',
        codec: 'V_VP8',
        name: 'Main 視点',
        language: 'jpn',
        default: false,
        forced: true,
        width: 16,
        height: 16,
    },
    {
        id: 33,
        uid: 3300002n,
        type: 'audio',
        codec: 'A_OPUS',
        name: 'English',
        language: 'eng',
        default: true,
        forced: false,
        channels: 1,
    },
    {
        id: 129,
        uid: 12900003n,
        type: 'video',
        codec: 'V_VP8',
        name: '',
        language: 'fra',
        default: true,
        forced: false,
        width: 32,
        height: 24,
    },
    {
        id: 201,
        uid: 20100004n,
        type: 'audio',
        codec: 'A_OPUS',
        name: '日本語',
        language: 'jpn',
        default: false,
        forced: true,
        channels: 2,
    },
];
export const opusHead = channels =>
    join(text('OpusHead'), [1, channels, 0, 0], integer(48000, 4, true), [0, 0, 0]);
export const trackPackets = trackSpecs.flatMap((track, index) =>
    [0, 1, 2].map(frame => ({
        id: track.id,
        trackType: track.type,
        timestamp: frame * 0.02,
        duration: 0.02,
        isKeyframe: true,
        data:
            track.type === 'video'
                ? Uint8Array.of(0x10, 0, index, 0x9d, 1, 0x2a, track.width, 0, track.height, frame)
                : Uint8Array.of(0xf8, index, frame),
    })),
);
export function matroskaFixture({ pcm, packets = trackPackets } = {}) {
    const specs = pcm
        ? [
              {
                  id: 1,
                  uid: 1n,
                  type: 'audio',
                  codec: pcm.codec,
                  channels: pcm.channels,
                  bits: pcm.bits,
              },
          ]
        : trackSpecs;
    const tracks = specs.map(track =>
        element(
            0xae,
            uint(0xd7, track.id),
            uint(0x73c5, track.uid),
            uint(0x83, track.type === 'video' ? 1 : 2),
            string(0x86, track.codec),
            ...(track.name === undefined
                ? []
                : [
                      string(0x536e, track.name),
                      string(0x22b59c, track.language),
                      uint(0x88, +track.default),
                      uint(0x55aa, +track.forced),
                  ]),
            ...(track.type === 'video'
                ? [
                      uint(0x23e383, 20000000),
                      element(0xe0, uint(0xb0, track.width), uint(0xba, track.height)),
                  ]
                : [
                      ...(pcm ? [] : [element(0x63a2, opusHead(track.channels))]),
                      element(
                          0xe1,
                          float(0xb5, pcm?.sampleRate ?? 48000),
                          uint(0x9f, track.channels),
                          ...(pcm ? [uint(0x6264, track.bits)] : []),
                      ),
                  ]),
        ),
    );
    const blocks = [...packets]
        .sort((a, b) => a.timestamp - b.timestamp || b.id - a.id)
        .map(packet =>
            element(
                0xa3,
                vint(packet.id),
                integer(Math.round(packet.timestamp * 1000), 2),
                [0x80],
                packet.data,
            ),
        );
    return join(
        element(
            0x1a45dfa3,
            uint(0x4286, 1),
            uint(0x42f7, 1),
            uint(0x42f2, 4),
            uint(0x42f3, 8),
            string(0x4282, 'matroska'),
            uint(0x4287, 4),
            uint(0x4285, 2),
        ),
        element(
            0x18538067,
            element(0x1549a966, uint(0x2ad7b1, 1000000)),
            element(0x1654ae6b, ...tracks),
            element(0x1f43b675, uint(0xe7, 0), ...blocks),
        ),
    );
}

export function aviPcmFixture({
    bits = 16,
    channels = 2,
    float: floating = false,
    blockAlign = (channels * bits) / 8,
    byteRate,
    sampleSize = blockAlign,
    partial = false,
    extensible = false,
    validBits = bits,
    channelMask = 0,
} = {}) {
    const sampleRate = 8000;
    const values = floating
        ? [-1, 0.5, 0, -0.25, 0.75, 1, -0.5, 0.25]
        : bits === 8
          ? [0, 64, 128, 192, 255, 32, 160, 96]
          : [
                -(2 ** (bits - 1)),
                -(2 ** (bits - 2)),
                0,
                2 ** (bits - 2),
                2 ** (bits - 1) - 1,
                -1,
                1,
                256,
            ];
    const samples = new Uint8Array((values.length * bits) / 8);
    const view = new DataView(samples.buffer);
    values.forEach((value, index) => {
        const at = (index * bits) / 8;
        if (floating)
            bits === 64 ? view.setFloat64(at, value, true) : view.setFloat32(at, value, true);
        else
            for (let byte = 0; byte < bits / 8; byte++)
                samples[at + byte] = Number((BigInt(value) >> BigInt(byte * 8)) & 255n);
    });
    const fmt = join(
        integer(extensible ? 0xfffe : floating ? 3 : 1, 2, true),
        integer(channels, 2, true),
        integer(sampleRate, 4, true),
        integer(byteRate ?? sampleRate * blockAlign, 4, true),
        integer(blockAlign, 2, true),
        integer(bits, 2, true),
        ...(extensible
            ? [
                  integer(22, 2, true),
                  integer(validBits, 2, true),
                  integer(channelMask, 4, true),
                  integer(floating ? 3 : 1, 4, true),
                  [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113],
              ]
            : floating
              ? [[0, 0]]
              : []),
    );
    const header = new Uint8Array(56);
    header.set(text('auds'));
    const hv = new DataView(header.buffer);
    hv.setUint32(20, 1, true);
    hv.setUint32(24, sampleRate, true);
    hv.setUint32(32, values.length / Math.max(channels, 1), true);
    hv.setUint32(44, sampleSize, true);
    const riffChunk = (id, data) =>
        join(text(id), integer(data.length, 4, true), data, ...(data.length & 1 ? [[0]] : []));
    const list = (type, ...parts) => riffChunk('LIST', join(text(type), ...parts));
    const packets = [
        samples.slice(0, samples.length / 2),
        samples.slice(samples.length / 2, partial ? -1 : undefined),
    ];
    const body = join(
        text('AVI '),
        list('hdrl', list('strl', riffChunk('strh', header), riffChunk('strf', fmt))),
        list('movi', ...packets.map(data => riffChunk('00wb', data))),
    );
    return {
        bytes: riffChunk('RIFF', body),
        packets,
        values,
        sampleRate,
        bits,
        channels,
        floating,
        fmt,
    };
}

function readVint(bytes, at, id = false) {
    assert(at < bytes.length && bytes[at] !== 0, 'EBML integer must be present');
    let width = 1;
    while (!(bytes[at] & (128 >> (width - 1)))) width++;
    let value = BigInt(id ? bytes[at] : bytes[at] & ((128 >> (width - 1)) - 1));
    for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[at + i]);
    return {
        width,
        value: Number(value),
        unknown: !id && value === (1n << BigInt(7 * width)) - 1n,
    };
}
export function parseMatroska(bytes) {
    const walk = (start, end) => {
        const found = [];
        while (start < end) {
            const id = readVint(bytes, start, true);
            const size = readVint(bytes, start + id.width);
            const data = start + id.width + size.width;
            const next = size.unknown ? end : data + size.value;
            assert(next <= end && next >= data, 'EBML element must fit parent');
            found.push({ id: id.value, start, data, end: next, unknown: size.unknown });
            start = next;
        }
        return found;
    };
    const children = parent => walk(parent.data, parent.end);
    const number = item =>
        bytes.slice(item.data, item.end).reduce((value, byte) => value * 256n + BigInt(byte), 0n);
    const segment = walk(0, bytes.length).find(item => item.id === 0x18538067);
    assert(segment, 'Segment must exist');
    const top = children(segment);
    const tracks = children(top.find(item => item.id === 0x1654ae6b)).map(entry => {
        const fields = children(entry);
        const get = id => fields.find(item => item.id === id);
        const str = id =>
            get(id) ? new TextDecoder().decode(bytes.slice(get(id).data, get(id).end)) : undefined;
        const audio = get(0xe1) ? children(get(0xe1)) : [];
        const audioNum = id => audio.find(item => item.id === id);
        const video = get(0xe0) ? children(get(0xe0)) : [];
        const videoNum = id => video.find(item => item.id === id);
        const colour = videoNum(0x55b0) ? children(videoNum(0x55b0)) : [];
        return {
            id: Number(number(get(0xd7))),
            uid: number(get(0x73c5)),
            codec: str(0x86),
            name: str(0x536e),
            language: str(0x22b59c) ?? str(0x22b59d),
            default: get(0x88) ? number(get(0x88)) === 1n : true,
            forced: get(0x55aa) ? number(get(0x55aa)) === 1n : false,
            bits: audioNum(0x6264) ? Number(number(audioNum(0x6264))) : undefined,
            channels: audioNum(0x9f) ? Number(number(audioNum(0x9f))) : undefined,
            codecPrivate: get(0x63a2) ? bytes.slice(get(0x63a2).data, get(0x63a2).end) : undefined,
            width: videoNum(0xb0) ? Number(number(videoNum(0xb0))) : undefined,
            height: videoNum(0xba) ? Number(number(videoNum(0xba))) : undefined,
            colour: colour.map(item => [item.id, Number(number(item))]),
        };
    });
    const packets = [];
    const clusters = [];
    for (const cluster of top.filter(item => item.id === 0x1f43b675)) {
        const firstPacket = packets.length;
        const fields = children(cluster);
        const timestamp = Number(number(fields.find(item => item.id === 0xe7)));
        for (const field of fields) {
            const group = field.id === 0xa0 ? children(field) : [];
            const block = field.id === 0xa3 ? field : group.find(item => item.id === 0xa1);
            if (!block) continue;
            const track = readVint(bytes, block.data);
            const time = new DataView(bytes.buffer, bytes.byteOffset).getInt16(
                block.data + track.width,
            );
            const padding = group.find(item => item.id === 0x75a2);
            let discard = padding ? number(padding) : 0n;
            if (padding && bytes[padding.data] & 128)
                discard -= 1n << BigInt((padding.end - padding.data) * 8);
            packets.push({
                id: track.value,
                timestamp: (timestamp + time) / 1000,
                data: bytes.slice(block.data + track.width + 3, block.end),
                discard: Number(discard),
            });
        }
        clusters.push({
            offset: cluster.start - segment.data,
            tracks: packets.slice(firstPacket).map(packet => packet.id),
        });
    }
    const cuesElement = top.find(item => item.id === 0x1c53bb6b);
    const cuePoints = cuesElement
        ? children(cuesElement).map(point => {
              const positions = children(children(point).find(item => item.id === 0xb7));
              return {
                  track: Number(number(positions.find(item => item.id === 0xf7))),
                  offset: Number(number(positions.find(item => item.id === 0xf1))),
              };
          })
        : [];
    return {
        tracks,
        packets,
        fragmented: segment.unknown,
        cues: !!cuesElement,
        clusters,
        cuePoints,
    };
}
