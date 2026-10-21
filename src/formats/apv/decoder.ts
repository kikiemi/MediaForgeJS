import type { VideoDecoderFactory } from '../../core/contracts/plugin';
import type { BuiltinVideoDecoder, BuiltinVideoDecoderConfig } from '../../core/contracts/decoder';
import type { PlanarVideoFrame } from '../../core/contracts/picture';
import type { EncodedPacket } from '../../core/model/media';
import { MediaForgeError } from '../../core/errors/errors';
import { colourSpaceOf, type ColourCodes } from '../../core/codec-config/video/colour-codes';
import { APV_PRIMARY_FRAME, apvUnits } from './access-unit';

/**
 * APV decoding (draft-lim-apv §§ 5–7): the primary frame of each access unit, tiles of 16×16
 * macroblocks whose 8×8 blocks carry adaptive Golomb-Rice coded coefficients, dequantized and
 * inverse transformed into 10- to 16-bit samples, which leave rounded to 8-bit pictures that state
 * their coded bit depth (the engine warns once, VIDEO_PRECISION_REDUCED). Every frame is
 * coded alone. Verified bit-exact at 10 bits against FFmpeg's decoder (FATE apv 422-10, 400-10).
 */

/** Raster position of each zig-zag scan position of an 8×8 block (§ 4.4.1). */
const SCAN = ((): Uint8Array => {
    const scan = new Uint8Array(64);
    let pos = 1;
    for (let line = 1; line < 15; line++) {
        const odd = line % 2 === 1;
        let x = odd ? Math.min(line, 7) : Math.max(0, line - 7);
        let y = odd ? Math.max(0, line - 7) : Math.min(line, 7);
        for (; x >= 0 && x < 8 && y >= 0 && y < 8; x += odd ? -1 : 1, y += odd ? 1 : -1)
            scan[pos++] = y * 8 + x;
    }
    return scan;
})();

/** The 8-point transform matrix (§ 6.3.2), row m holding basis function m. */
const TRANSFORM = Int32Array.of(
    ...[64, 64, 64, 64, 64, 64, 64, 64],
    ...[89, 75, 50, 18, -18, -50, -75, -89],
    ...[84, 35, -35, -84, -84, -35, 35, 84],
    ...[75, -18, -89, -50, 50, 89, 18, -75],
    ...[64, -64, -64, 64, 64, -64, -64, 64],
    ...[50, -89, 18, 75, -75, -18, 89, -50],
    ...[35, -84, 84, -35, -35, 84, -84, 35],
    ...[18, -50, 75, -89, 89, -75, 50, -18],
);

const LEVEL_SCALE = [40, 45, 51, 57, 64, 71];

/** Horizontal and vertical chroma subsampling and components by chroma_format_idc. */
const CHROMA: Readonly<Record<number, readonly [number, number, number]>> = {
    0: [1, 1, 1],
    2: [2, 1, 3],
    3: [1, 1, 3],
    4: [1, 1, 4],
};

/** Frames larger than this many samples are refused rather than allocated. */
const MAX_PIXELS = 8192 * 8192;

const fail = (message: string): never => {
    throw new MediaForgeError(`APV ${message}`, 'DECODE');
};

/** The bits of `bytes` from byte `start` to `end`, most significant first. */
class Bits {
    private bit: number;
    private readonly end: number;

    constructor(
        private readonly bytes: Uint8Array,
        start: number,
        end: number,
    ) {
        this.bit = start * 8;
        this.end = end * 8;
    }

    /** The next whole byte. */
    get byte(): number {
        return (this.bit + 7) >>> 3;
    }

    /** The next `count` bits, at most 24, as an unsigned number. */
    read(count: number): number {
        const bit = this.bit;
        if (bit + count > this.end) fail('data is cut short');
        const at = bit >>> 3;
        const bytes = this.bytes;
        const word =
            (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
        this.bit = bit + count;
        return count ? (word << (bit & 7)) >>> (32 - count) : 0;
    }

    /** A variable-length code with Rice parameter `k` (§ 7.1.4). */
    code(k: number): number {
        let value = 0;
        let golomb = false;
        if (!this.read(1)) {
            golomb = this.read(1) === 1;
            value = (golomb ? 2 : 1) << k;
        }
        while (golomb && !this.read(1)) {
            value += 1 << k;
            if (++k > 24) fail('code is too long');
        }
        return value + this.read(k);
    }
}

/** A decoded frame: its planes of samples, padded to whole macroblocks. */
interface ApvPicture {
    readonly width: number;
    readonly height: number;
    readonly paddedWidth: number;
    readonly paddedHeight: number;
    readonly chromaFormat: number;
    readonly bitDepth: number;
    readonly planes: readonly Uint16Array[];
    readonly colour?: ColourCodes;
}

/** The primary frame of an access unit (its bytes from the signature on), decoded. */
function decodeApvAccessUnit(unit: Uint8Array): ApvPicture {
    const units = apvUnits(unit) ?? fail('access unit is malformed');
    const primary = units.find(part => part.type === APV_PRIMARY_FRAME);
    return primary ? decodeFrame(unit, primary.start, primary.end) : fail('has no primary frame');
}

/** frame(): its header (§§ 5.3.5–5.3.8), then each tile after its size (§ 5.3.12). */
function decodeFrame(unit: Uint8Array, start: number, end: number): ApvPicture {
    const header = new Bits(unit, start, end);
    header.read(24);
    const width = header.read(24);
    const height = header.read(24);
    const chromaFormat = header.read(4);
    const bitDepth = header.read(4) + 8;
    header.read(24);
    const shape = CHROMA[chromaFormat];
    if (!shape || bitDepth < 10 || bitDepth > 16 || bitDepth % 2)
        fail(`chroma format ${chromaFormat} at ${bitDepth} bits is not supported`);
    if (!width || !height || width * height > MAX_PIXELS) fail('frame size is not supported');
    const [subX, subY, comps] = shape!;
    const colour = header.read(1)
        ? {
              primaries: header.read(8),
              transfer: header.read(8),
              matrix: header.read(8),
              fullRange: header.read(1) === 1,
          }
        : undefined;
    const qMatrix = new Uint8Array(comps * 64).fill(16);
    if (header.read(1))
        for (let index = 0; index < qMatrix.length; index++) qMatrix[index] = header.read(8);
    const paddedWidth = Math.ceil(width / 16) * 16;
    const paddedHeight = Math.ceil(height / 16) * 16;
    const tileWidth = header.read(20) * 16;
    const tileHeight = header.read(20) * 16;
    if (!tileWidth || !tileHeight) fail('tile size is zero');
    const tileColumns = Math.ceil(paddedWidth / tileWidth);
    const tiles = tileColumns * Math.ceil(paddedHeight / tileHeight);
    if (header.read(1)) for (let tile = 0; tile < tiles * 2; tile++) header.read(16);
    header.read(8);

    const planes: Uint16Array[] = [];
    for (let comp = 0; comp < comps; comp++) {
        const chroma = comp === 1 || comp === 2;
        planes.push(
            new Uint16Array(
                (chroma ? paddedWidth / subX : paddedWidth) *
                    (chroma ? paddedHeight / subY : paddedHeight),
            ),
        );
    }
    const view = new DataView(unit.buffer, unit.byteOffset, unit.byteLength);
    const block = new Int32Array(64);
    const scratch = new Int32Array(64);
    let at = header.byte;
    for (let tile = 0; tile < tiles; tile++) {
        if (at + 8 > end) fail('frame is cut short');
        const tileEnd = at + 4 + view.getUint32(at);
        // tile_header(): its size, index, each component's data size and qp (§ 5.3.13).
        const tileStart = at + 4;
        if (tileEnd > end || tileStart + 5 * comps + 5 > tileEnd) fail('tile is cut short');
        let data = tileStart + view.getUint16(tileStart);
        const x0 = (tile % tileColumns) * tileWidth;
        const y0 = Math.floor(tile / tileColumns) * tileHeight;
        const columns = Math.min(tileWidth, paddedWidth - x0) / 16;
        const rows = Math.min(tileHeight, paddedHeight - y0) / 16;
        for (let comp = 0; comp < comps; comp++) {
            const size = view.getUint32(tileStart + 4 + comp * 4);
            const qp = unit[tileStart + 4 + comps * 4 + comp]!;
            if (data + size > tileEnd) fail('tile data is cut short');
            const [stepX, stepY] = comp === 1 || comp === 2 ? [subX, subY] : [1, 1];
            const scale = new Float64Array(64);
            for (let index = 0; index < 64; index++)
                scale[index] =
                    qMatrix[comp * 64 + index]! * LEVEL_SCALE[qp % 6]! * 2 ** Math.floor(qp / 6);
            decodeTileComponent({
                bits: new Bits(unit, data, data + size),
                plane: planes[comp]!,
                stride: paddedWidth / stepX,
                x0: x0 / stepX,
                y0: y0 / stepY,
                columns,
                rows,
                blockColumns: 2 / stepX,
                blockRows: 2 / stepY,
                scale,
                bitDepth,
                block,
                scratch,
            });
            data += size;
        }
        at = tileEnd;
    }
    return {
        width,
        height,
        paddedWidth,
        paddedHeight,
        chromaFormat,
        bitDepth,
        planes,
        ...(colour ? { colour } : {}),
    };
}

interface TileComponent {
    readonly bits: Bits;
    readonly plane: Uint16Array;
    readonly stride: number;
    readonly x0: number;
    readonly y0: number;
    readonly columns: number;
    readonly rows: number;
    readonly blockColumns: number;
    readonly blockRows: number;
    readonly scale: Float64Array;
    readonly bitDepth: number;
    readonly block: Int32Array;
    readonly scratch: Int32Array;
}

/**
 * tile_data(): the macroblocks of one component of a tile in raster order, each block a DC
 * difference and runs of zeros before AC levels in zig-zag order (§§ 5.3.14–5.3.16, 7.1).
 */
function decodeTileComponent(tile: TileComponent): void {
    const { bits, block, blockColumns, blockRows } = tile;
    let previousDc = 0;
    let previousDcDiff = 20;
    let firstAcLevel = 0;
    for (let mb = 0; mb < tile.columns * tile.rows; mb++) {
        const mbX = tile.x0 + (mb % tile.columns) * blockColumns * 8;
        const mbY = tile.y0 + Math.floor(mb / tile.columns) * blockRows * 8;
        for (let by = 0; by < blockRows; by++) {
            for (let bx = 0; bx < blockColumns; bx++) {
                block.fill(0);
                const dcDiff = bits.code(Math.min(5, previousDcDiff >> 1));
                previousDc += dcDiff && bits.read(1) ? -dcDiff : dcDiff;
                previousDcDiff = dcDiff;
                block[0] = previousDc;
                let level = firstAcLevel;
                let run = 0;
                for (let pos = 1, first = true; pos < 64; first = false) {
                    run = bits.code(Math.min(2, run >> 2));
                    pos += run;
                    if (pos > 64) fail('coefficients overrun their block');
                    if (pos === 64) break;
                    level = bits.code(Math.min(4, level >> 2)) + 1;
                    block[SCAN[pos++]!] = bits.read(1) ? -level : level;
                    if (first) firstAcLevel = level;
                }
                reconstruct(tile, mbX + bx * 8, mbY + by * 8);
            }
        }
    }
}

/** Dequantizes, inverse transforms and stores the block at (x, y) of its plane (§ 6.3). */
function reconstruct(tile: TileComponent, x: number, y: number): void {
    const { block, scratch, scale, bitDepth } = tile;
    const shift = 2 ** (bitDepth - 2);
    for (let index = 0; index < 64; index++) {
        const coefficient = block[index]!;
        if (!coefficient) continue;
        const scaled = Math.floor((coefficient * scale[index]! + shift / 2) / shift);
        block[index] = scaled < -32768 ? -32768 : scaled > 32767 ? 32767 : scaled;
    }
    // Columns, then rows: each output is the sum over j of TRANSFORM[j][i] × input[j].
    for (let column = 0; column < 8; column++)
        for (let i = 0; i < 8; i++) {
            let sum = 0;
            for (let j = 0; j < 8; j++) sum += TRANSFORM[j * 8 + i]! * block[j * 8 + column]!;
            scratch[i * 8 + column] = (sum + 64) >> 7;
        }
    const outShift = 20 - bitDepth;
    const offset = 1 << (bitDepth - 1);
    const max = (1 << bitDepth) - 1;
    for (let row = 0; row < 8; row++) {
        const target = (y + row) * tile.stride + x;
        for (let i = 0; i < 8; i++) {
            let sum = 0;
            for (let j = 0; j < 8; j++) sum += TRANSFORM[j * 8 + i]! * scratch[row * 8 + j]!;
            const sample = ((sum + (1 << (outShift - 1))) >> outShift) + offset;
            tile.plane[target + i] = sample < 0 ? 0 : sample > max ? max : sample;
        }
    }
}

/**
 * The 8-bit picture of a decoded frame: Y, Cb and Cr rounded to 8 bits (I422 or I444; 4:0:0 as
 * I420 with neutral chroma, and 4:4:4:4 without its alpha plane).
 */
function planarFrame(picture: ApvPicture, packet: EncodedPacket): PlanarVideoFrame {
    const { paddedWidth: width, paddedHeight: height, bitDepth } = picture;
    const gray = picture.chromaFormat === 0;
    const [chromaWidth, chromaHeight] =
        picture.chromaFormat === 2
            ? [width / 2, height]
            : gray
              ? [width / 2, height / 2]
              : [width, height];
    const lumaSize = width * height;
    const chromaSize = chromaWidth * chromaHeight;
    const data = new Uint8Array(lumaSize + 2 * chromaSize).fill(128);
    const shift = bitDepth - 8;
    const half = 1 << (shift - 1);
    for (let plane = 0; plane < (gray ? 1 : 3); plane++) {
        const samples = picture.planes[plane]!;
        const base = plane ? lumaSize + (plane - 1) * chromaSize : 0;
        for (let index = 0; index < samples.length; index++)
            data[base + index] = Math.min(255, (samples[index]! + half) >> shift);
    }
    const hd = picture.width > 1024 || picture.height > 576;
    const standard = hd ? 'bt709' : 'smpte170m';
    return {
        format: picture.chromaFormat === 2 ? 'I422' : gray ? 'I420' : 'I444',
        data,
        layout: [
            { offset: 0, stride: width },
            { offset: lumaSize, stride: chromaWidth },
            { offset: lumaSize + chromaSize, stride: chromaWidth },
        ],
        codedWidth: width,
        codedHeight: height,
        visibleRect: { x: 0, y: 0, width: picture.width, height: picture.height },
        displayWidth: picture.width,
        displayHeight: picture.height,
        timestamp: packet.timestamp,
        duration: packet.duration,
        keyFrame: true,
        bitDepth,
        colorSpace: colourSpaceOf(picture.colour, {
            primaries: standard,
            transfer: standard,
            matrix: standard,
        }),
    };
}

/** Decodes each access unit into one picture; a damaged one is skipped with a diagnostic. */
class ApvDecoder implements BuiltinVideoDecoder {
    constructor(private readonly config: BuiltinVideoDecoderConfig) {}

    decode(packet: EncodedPacket): readonly PlanarVideoFrame[] {
        try {
            return [planarFrame(decodeApvAccessUnit(packet.data), packet)];
        } catch (error) {
            if (!(error instanceof MediaForgeError)) throw error;
            this.config.onWarning?.(`Skipped a frame: ${error.message}`);
            return [];
        }
    }

    flush(): readonly PlanarVideoFrame[] {
        return [];
    }

    reset(): void {}

    close(): void {}
}

export const createApvDecoder: VideoDecoderFactory = config => new ApvDecoder(config);
