// Wraps one HEVC picture (an Annex B stream, as `ffmpeg -c:v libx265 -f hevc` writes it) into a
// minimal HEIF still image (ISO/IEC 23008-12): ftyp heic/mif1; meta with hdlr pict, pitm, iloc,
// iinf of one hvc1 item, iprp (ipco with hvcC, ispe and an nclx colr; ipma); mdat with the
// picture's slices, length-prefixed. Node only, run once to make a fixture, not a test:
//
//     node test/helpers/make-heif.mjs <in.hevc> <out.heic> <primaries> <transfer> <matrix>
//
// The colour codes are those of the stream's VUI (ISO/IEC 23091-2), which colr repeats.
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, ...colour] = process.argv.slice(2);
const [primaries, transfer, matrix] = colour.map(Number);

/** The NAL units of an Annex B stream. */
function nalUnits(bytes) {
    const starts = [];
    for (let at = 0; at + 3 <= bytes.length; at++)
        if (bytes[at] === 0 && bytes[at + 1] === 0 && bytes[at + 2] === 1) starts.push(at + 3);
    return starts.map((start, index) => {
        let end = index + 1 < starts.length ? starts[index + 1] - 3 : bytes.length;
        while (end > start && bytes[end - 1] === 0) end--;
        return bytes.subarray(start, end);
    });
}

/** The RBSP of a NAL unit: its payload without the emulation prevention bytes. */
function rbsp(nal) {
    const out = [];
    for (let at = 2; at < nal.length; at++) {
        if (at >= 4 && nal[at] === 3 && nal[at - 1] === 0 && nal[at - 2] === 0) continue;
        out.push(nal[at]);
    }
    return Uint8Array.from(out);
}

/** Exp-Golomb and fixed-width reads from `bytes`, from bit `bit`. */
function bitReader(bytes, bit) {
    const read = count => {
        let value = 0;
        for (let index = 0; index < count; index++, bit++)
            value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
        return value;
    };
    const ue = () => {
        let zeros = 0;
        while (read(1) === 0) zeros++;
        return 2 ** zeros - 1 + read(zeros);
    };
    return { read, ue };
}

const u8 = value => [value & 255];
const u16 = value => [(value >> 8) & 255, value & 255];
const u32 = value => [value >>> 24, (value >> 16) & 255, (value >> 8) & 255, value & 255];
const ascii = text => [...text].map(char => char.charCodeAt(0));
const box = (type, ...parts) => {
    const body = parts.flat(Infinity);
    return [...u32(body.length + 8), ...ascii(type), ...body];
};
const fullBox = (type, version, flags, ...parts) =>
    box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...parts);

const units = nalUnits(readFileSync(input));
const type = nal => (nal[0] >> 1) & 63;
const [vps, sps, pps] = [32, 33, 34].map(kind => units.find(nal => type(nal) === kind));
const slices = units.filter(nal => type(nal) < 32);

// The SPS: its profile, tier and level (12 bytes after its first), then its picture.
const seq = rbsp(sps);
const subLayers = ((seq[0] >> 1) & 7) + 1;
if (subLayers !== 1) throw new Error('make-heif.mjs reads a stream of one temporal layer');
const bits = bitReader(seq, 13 * 8);
bits.ue();
const chroma = bits.ue();
if (chroma === 3) bits.read(1);
const [width, height] = [bits.ue(), bits.ue()];
if (bits.read(1)) throw new Error('make-heif.mjs reads a picture without a conformance window');
const [lumaDepth, chromaDepth] = [bits.ue(), bits.ue()];

const hvcC = box(
    'hvcC',
    u8(1),
    [...seq.subarray(1, 13)],
    u16(0xf000),
    u8(0xfc),
    u8(0xfc | chroma),
    u8(0xf8 | lumaDepth),
    u8(0xf8 | chromaDepth),
    u16(0),
    u8((subLayers << 3) | ((seq[0] & 1) << 2) | 3),
    u8(3),
    [vps, sps, pps].map(nal => [u8(0x80 | type(nal)), u16(1), u16(nal.length), [...nal]]),
);
const mdatBody = slices.flatMap(nal => [...u32(nal.length), ...nal]);

/** The meta box, its one extent at `offset`. */
const meta = offset =>
    fullBox(
        'meta',
        0,
        0,
        fullBox('hdlr', 0, 0, u32(0), ascii('pict'), u32(0), u32(0), u32(0), u8(0)),
        fullBox('pitm', 0, 0, u16(1)),
        fullBox('iloc', 0, 0, u8(0x44), u8(0), u16(1), u16(1), u16(0), u16(1), u32(offset), [
            ...u32(mdatBody.length),
        ]),
        fullBox('iinf', 0, 0, u16(1), fullBox('infe', 2, 0, u16(1), u16(0), ascii('hvc1'), u8(0))),
        box(
            'iprp',
            box(
                'ipco',
                hvcC,
                fullBox('ispe', 0, 0, u32(width), u32(height)),
                box('colr', ascii('nclx'), u16(primaries), u16(transfer), u16(matrix), u8(0)),
            ),
            fullBox('ipma', 0, 0, u32(1), u16(1), u8(3), u8(0x81), u8(0x02), u8(0x03)),
        ),
    );

const ftyp = box('ftyp', ascii('heic'), u32(0), ascii('mif1'), ascii('heic'));
const head = ftyp.length + meta(0).length;
const file = [...ftyp, ...meta(head + 8), ...box('mdat', mdatBody)];
writeFileSync(output, Uint8Array.from(file));
