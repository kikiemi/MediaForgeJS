// Writes the ClearKey fixture of the browser playback test from a clear fragmented MP4 of one
// Opus track (see README.md): init.mp4 and seg-N.m4s, each sample encrypted whole with
// AES-128-CTR ('cenc', 8-byte IVs), and clearkey.m3u8. Run once: node make-clearkey.mjs clear.mp4
import { createCipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = Buffer.from('fedcba9876543210fedcba9876543210', 'hex');
const KID = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
const CLEARKEY = Buffer.from('1077efecc0b24d02ace33c1e52e2fb4b', 'hex');
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf']);

/** The boxes of `data` as { type, body, children? }; stsd and sample entries keep a prefix. */
function parse(data) {
    const boxes = [];
    for (let at = 0; at < data.length;) {
        const size = data.readUInt32BE(at);
        const type = data.toString('latin1', at + 4, at + 8);
        const body = data.subarray(at + 8, at + size);
        const prefix = { stsd: 8, Opus: 28 }[type];
        if (CONTAINERS.has(type)) boxes.push({ type, children: parse(body) });
        else if (prefix)
            boxes.push({
                type,
                prefix: body.subarray(0, prefix),
                children: parse(body.subarray(prefix)),
            });
        else boxes.push({ type, body });
        at += size;
    }
    return boxes;
}

const box = (type, ...parts) => {
    const body = Buffer.concat(parts);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + body.length);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, body]);
};
const write = boxes =>
    Buffer.concat(
        boxes.map(b =>
            b.children
                ? box(b.type, b.prefix ?? Buffer.alloc(0), write(b.children))
                : box(b.type, b.body),
        ),
    );
const u32 = value => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
};
const find = (boxes, path) => {
    const [head, ...rest] = path.split('/');
    const found = boxes.find(b => b.type === head);
    return rest.length ? find(found.children, rest.join('/')) : found;
};

const [ftyp, moov, ...rest] = parse(readFileSync(process.argv[2]));
// The Opus entry becomes 'enca' with its scheme: cenc, protected, 8-byte IVs, the KID.
const entry = find(moov.children, 'trak/mdia/minf/stbl/stsd').children[0];
entry.type = 'enca';
const tenc = box('tenc', u32(0), Buffer.from([0, 0, 1, 8]), KID);
entry.children.push({
    type: 'sinf',
    children: [
        { type: 'frma', body: Buffer.from('Opus', 'latin1') },
        {
            type: 'schm',
            body: Buffer.concat([u32(0), Buffer.from('cenc', 'latin1'), u32(0x10000)]),
        },
        { type: 'schi', children: [{ type: 'tenc', body: tenc.subarray(8) }] },
    ],
});
const pssh = box('pssh', u32(0x01000000), CLEARKEY, u32(1), KID, u32(0));
moov.children.push({ type: 'pssh', body: pssh.subarray(8) });
const timescale = find(moov.children, 'trak/mdia/mdhd').body.readUInt32BE(12);
writeFileSync('init.mp4', Buffer.concat([write([ftyp]), write([moov])]));

const lines = [];
let number = 0;
let sample = 0;
for (let index = 0; index < rest.length; index += 2) {
    const [moof, mdat] = [rest[index], rest[index + 1]];
    if (moof.type !== 'moof' || mdat?.type !== 'mdat') continue;
    const traf = find(moof.children, 'traf');
    if (moof.children.at(-1) !== traf) throw new Error('a moof ends with something but its traf');
    const trun = find(traf.children, 'trun').body;
    const flags = trun.readUInt32BE(0) & 0xffffff;
    const count = trun.readUInt32BE(4);
    let at = 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
    const fields = [0x100, 0x200, 0x400, 0x800].filter(bit => flags & bit);
    // The defaults of tfhd: duration (flag 8) and size (flag 0x10), after the optional base data
    // offset (1) and sample description index (2).
    const tfhd = find(traf.children, 'tfhd').body;
    const tfhdFlags = tfhd.readUInt32BE(0) & 0xffffff;
    let field = 8 + (tfhdFlags & 1 ? 8 : 0) + (tfhdFlags & 2 ? 4 : 0);
    const defaultDuration = tfhdFlags & 8 ? tfhd.readUInt32BE(field) : undefined;
    if (tfhdFlags & 8) field += 4;
    const defaultSize = tfhdFlags & 0x10 ? tfhd.readUInt32BE(field) : undefined;
    const sizes = [];
    let duration = 0;
    for (let s = 0; s < count; s++) {
        let size = defaultSize;
        let length = defaultDuration;
        for (const bit of fields) {
            if (bit === 0x100) length = trun.readUInt32BE(at);
            if (bit === 0x200) size = trun.readUInt32BE(at);
            at += 4;
        }
        if (size === undefined || length === undefined)
            throw new Error(`fragment ${number + 1} states no size or duration of a sample`);
        sizes.push(size);
        duration += length;
    }
    // Each sample is encrypted whole from block 0 of its own IV.
    const ivs = [];
    let offset = 0;
    const data = Buffer.from(mdat.body);
    for (const size of sizes) {
        const iv = Buffer.alloc(8);
        iv.writeUInt32BE(++sample, 4);
        ivs.push(iv);
        const cipher = createCipheriv('aes-128-ctr', KEY, Buffer.concat([iv, Buffer.alloc(8)]));
        cipher.update(data.subarray(offset, offset + size)).copy(data, offset);
        offset += size;
    }
    const senc = box('senc', u32(0), u32(count), ...ivs);
    const saiz = box('saiz', u32(0), Buffer.from([8]), u32(count));
    // senc goes at the end of the traf, the last box of the moof: where the moof ended.
    const before = write([moof]).length;
    traf.children.push({ type: 'senc', body: senc.subarray(8) });
    traf.children.push({ type: 'saiz', body: saiz.subarray(8) });
    traf.children.push({ type: 'saio', body: Buffer.concat([u32(0), u32(1), u32(0)]) });
    const grown = write([moof]).length - before;
    // The data offset of trun counts from the moof, which grew; saio points at the first IV.
    if (flags & 1) trun.writeInt32BE(trun.readInt32BE(8) + grown, 8);
    traf.children.at(-1).body.writeUInt32BE(before + 16, 8);
    const name = `seg-${++number}.m4s`;
    writeFileSync(name, Buffer.concat([write([moof]), box('mdat', data)]));
    lines.push(`#EXTINF:${(duration / timescale).toFixed(3)},`, name);
}

const uri = `data:text/plain;base64,${pssh.toString('base64')}`;
writeFileSync(
    'clearkey.m3u8',
    [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:1',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="org.w3.clearkey",KEYFORMATVERSIONS="1",' +
            `URI="${uri}"`,
        '#EXT-X-MAP:URI="init.mp4"',
        ...lines,
        '#EXT-X-ENDLIST',
        '',
    ].join('\n'),
);
