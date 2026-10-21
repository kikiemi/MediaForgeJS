// Writes small MPEG-2 video elementary streams (ISO/IEC 13818-2) with the prediction modes ffmpeg's
// encoder never emits: field pictures, field and 16x8 prediction in field pictures, dual prime in
// frame and field pictures and concealment motion vectors. Content is deterministic for a seed;
// every reference stays inside the picture.

const DC_LUMA = ['100', '00', '01', '101', '110', '1110', '11110', '111110', '1111110'];
const DC_CHROMA = ['00', '01', '10', '110', '1110', '11110', '111110', '1111110', '11111110'];
const MOTION_CODE = [
    '1',
    '01',
    '001',
    '0001',
    '000011',
    '0000101',
    '0000100',
    '0000011',
    '000001011',
    '000001010',
    '000001001',
    '0000010001',
    '0000010000',
    '0000001111',
    '0000001110',
    '0000001101',
    '0000001100',
];
/** coded_block_pattern codes (Table B.9) for the patterns the writer uses. */
const PATTERN_CODES = {
    60: '111',
    4: '1101',
    8: '1100',
    16: '1011',
    32: '1010',
    1: '01011',
    2: '01001',
    63: '001100',
};

class BitWriter {
    bytes = [];
    value = 0;
    count = 0;

    put(value, bits) {
        for (let bit = bits - 1; bit >= 0; bit--) {
            this.value = (this.value << 1) | ((value >>> bit) & 1);
            if (++this.count === 8) {
                this.bytes.push(this.value);
                this.value = 0;
                this.count = 0;
            }
        }
    }

    code(bits) {
        for (const bit of bits) this.put(bit === '1' ? 1 : 0, 1);
    }

    startCode(code) {
        while (this.count) this.put(0, 1);
        this.put(1, 24);
        this.put(code, 8);
    }

    finish() {
        while (this.count) this.put(0, 1);
        return Uint8Array.from(this.bytes);
    }
}

function random(seed) {
    let state = seed >>> 0 || 1;
    return () => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return state / 4294967296;
    };
}

/**
 * Picture list entries: { type: 'I' | 'P', structure: 'frame' | 'top' | 'bottom', modes: [...],
 * coded } where modes lists the kinds P macroblocks draw from ('frame', 'field', 'dual', 'skip',
 * 'intra', 'zero'; in field pictures 'frame' is field prediction and 'field' is 16x8) and `coded`
 * adds residual blocks to predicted macroblocks. `display` ({ width, height, colour? }) writes a
 * sequence_display_extension. The sequence is interlaced, so the coded height is a multiple of 32.
 */
export function writeMpeg2Stream({
    width,
    height,
    chroma = 420,
    pictures,
    seed = 1,
    concealment = false,
    fCode = 2,
    aspectRatio = 1,
    frameRateCode = 3,
    display,
}) {
    const next = random(seed);
    const pick = list => list[Math.floor(next() * list.length)];
    const range = (low, high) => low + Math.floor(next() * (high - low + 1));
    const writer = new BitWriter();
    const mbWidth = Math.ceil(width / 16);
    const codedHeight = Math.ceil(height / 32) * 32;
    const chromaFormat = chroma === 422 ? 2 : 1;
    const blockCount = chroma === 422 ? 8 : 6;

    writer.startCode(0xb3);
    writer.put(width, 12);
    writer.put(height, 12);
    writer.put(aspectRatio, 4);
    writer.put(frameRateCode, 4);
    writer.put(0x3ffff, 18);
    writer.put(1, 1);
    writer.put(112, 10);
    writer.put(0, 3);
    writer.startCode(0xb5);
    writer.put(1, 4);
    writer.put(chroma === 422 ? 0x85 : 0x48, 8);
    writer.put(0, 1);
    writer.put(chromaFormat, 2);
    writer.put(0, 4);
    writer.put(0, 12);
    writer.put(1, 1);
    writer.put(0, 8);
    writer.put(1, 1);
    writer.put(0, 7);
    if (display) {
        writer.startCode(0xb5);
        writer.put(2, 4);
        writer.put(5, 3);
        writer.put(display.colour ? 1 : 0, 1);
        for (const code of display.colour ?? []) writer.put(code, 8);
        writer.put(display.width, 14);
        writer.put(1, 1);
        writer.put(display.height, 14);
    }
    writer.startCode(0xb8);
    writer.put(1 << 12, 25);
    writer.put(1, 1);
    writer.put(0, 1);

    const writeVectorComponent = (delta, rSize) => {
        const f = 1 << rSize;
        const wrapped = ((((delta + 16 * f) % (32 * f)) + 32 * f) % (32 * f)) - 16 * f;
        if (wrapped === 0) {
            writer.code('1');
            return;
        }
        const magnitude = Math.abs(wrapped);
        writer.code(MOTION_CODE[((magnitude - 1) >> rSize) + 1]);
        writer.put(wrapped < 0 ? 1 : 0, 1);
        if (rSize) writer.put((magnitude - 1) & (f - 1), rSize);
    };
    const writeDualPrime = value => writer.code(value === 0 ? '0' : value > 0 ? '10' : '11');
    const writeLevel = (run, level, first) => {
        if (first && run === 0 && Math.abs(level) === 1) {
            writer.code(level > 0 ? '10' : '11');
            return;
        }
        writer.code('000001');
        writer.put(run, 6);
        writer.put(level & 0xfff, 12);
    };
    const writeAc = count => {
        for (let k = 0; k < count; k++) writeLevel(range(0, 3), range(-40, 40) || 3, false);
        writer.code('10');
    };

    let temporalReference = 0;
    let fieldPictureCount = 0;
    for (const picture of pictures) {
        const frame = picture.structure === 'frame';
        const structure = frame ? 3 : picture.structure === 'top' ? 1 : 2;
        const fieldHeight = frame ? codedHeight : codedHeight / 2;
        const mbRows = fieldHeight / 16;
        const secondField = !frame && fieldPictureCount % 2 === 1;
        writer.startCode(0x00);
        writer.put(temporalReference, 10);
        writer.put(picture.type === 'I' ? 1 : 2, 3);
        writer.put(0xffff, 16);
        if (picture.type === 'P') writer.put(7, 4);
        writer.put(0, 1);
        writer.startCode(0xb5);
        writer.put(8, 4);
        const code = picture.type === 'P' || concealment ? fCode : 15;
        writer.put(code, 4);
        writer.put(code, 4);
        writer.put(15, 4);
        writer.put(15, 4);
        writer.put(0, 2);
        writer.put(structure, 2);
        writer.put(frame ? 1 : 0, 1);
        writer.put(0, 1);
        writer.put(concealment && picture.type === 'I' ? 1 : 0, 1);
        writer.put(0, 5);
        writer.put(0, 1);
        writer.put(0, 1);

        for (let row = 0; row < mbRows; row++) {
            writer.startCode(row + 1);
            writer.put(picture.quantiser ?? 6, 5);
            writer.put(0, 1);
            const dcPrediction = [128, 128, 128];
            const pmv = [
                [0, 0],
                [0, 0],
            ];
            let column = 0;
            while (column < mbWidth) {
                const interior = column > 0 && column < mbWidth - 1 && row > 0 && row < mbRows - 1;
                const modes = picture.type === 'I' ? ['intra'] : picture.modes;
                let mode = pick(modes);
                if (
                    (mode === 'skip' && (column === 0 || column === mbWidth - 1)) ||
                    (!interior && mode !== 'intra')
                ) {
                    mode = column === 0 || column === mbWidth - 1 ? 'zero' : 'skip';
                }
                if (mode === 'skip') {
                    let run = 1;
                    while (column + run < mbWidth - 1 && run < 3 && next() < 0.5) run++;
                    column += run;
                    pmv[0] = [0, 0];
                    pmv[1] = [0, 0];
                    writer.code(['', '1', '011', '010', '0011'][run + 1]);
                    writeMacroblock('zero');
                    column++;
                    continue;
                }
                writer.code('1');
                writeMacroblock(mode);
                column++;
            }

            function writeMacroblock(kind) {
                const coded = picture.coded && kind !== 'intra' && next() < 0.6;
                if (kind === 'intra') {
                    writer.code(picture.type === 'I' ? '1' : '00011');
                    if (frame) writer.put(next() < 0.5 ? 1 : 0, 1);
                    if (concealment && picture.type === 'I') {
                        if (!frame) writer.put(pick([0, 1]), 1);
                        const x = range(-20, 20);
                        const y = range(-20, 20);
                        writeVectorComponent(x - pmv[0][0], fCode - 1);
                        writeVectorComponent(y - pmv[0][1], fCode - 1);
                        pmv[0] = [x, y];
                        pmv[1] = [x, y];
                        writer.put(1, 1);
                    } else {
                        pmv[0] = [0, 0];
                        pmv[1] = [0, 0];
                    }
                    for (let block = 0; block < blockCount; block++) {
                        const component = block < 4 ? 0 : (block & 1) + 1;
                        const target = range(40, 216);
                        const difference = target - dcPrediction[component];
                        dcPrediction[component] = target;
                        const size = difference === 0 ? 0 : 32 - Math.clz32(Math.abs(difference));
                        writer.code((component === 0 ? DC_LUMA : DC_CHROMA)[size]);
                        if (size)
                            writer.put(
                                difference > 0 ? difference : difference + (1 << size) - 1,
                                size,
                            );
                        writeAc(range(0, 4));
                    }
                    return;
                }
                dcPrediction.fill(128);
                const rSize = fCode - 1;
                if (kind === 'zero') {
                    writer.code(coded ? '01' : '001');
                    if (!coded) {
                        writer.code(frame ? '10' : '01');
                        if (!frame) writer.put(structure === 1 ? 0 : 1, 1);
                        writeVectorComponent(-pmv[0][0], rSize);
                        writeVectorComponent(-pmv[0][1], rSize);
                        pmv[0] = [0, 0];
                        pmv[1] = [0, 0];
                        return;
                    }
                    pmv[0] = [0, 0];
                    pmv[1] = [0, 0];
                    if (frame) writer.put(0, 1);
                } else {
                    writer.code(coded ? '1' : '001');
                    if (kind === 'frame') {
                        writer.code(frame ? '10' : '01');
                        if (frame) {
                            if (coded) writer.put(next() < 0.5 ? 1 : 0, 1);
                            const x = range(-9, 9);
                            const y = range(-9, 9);
                            writeVectorComponent(x - pmv[0][0], rSize);
                            writeVectorComponent(y - pmv[0][1], rSize);
                            pmv[0] = [x, y];
                            pmv[1] = [x, y];
                        } else {
                            writer.put(pick([0, 1]), 1);
                            const x = range(-9, 9);
                            const y = range(-9, 9);
                            writeVectorComponent(x - pmv[0][0], rSize);
                            writeVectorComponent(y - pmv[0][1], rSize);
                            pmv[0] = [x, y];
                            pmv[1] = [x, y];
                        }
                    } else if (kind === 'field') {
                        if (frame) {
                            writer.code('01');
                            if (coded) writer.put(next() < 0.5 ? 1 : 0, 1);
                            for (let r = 0; r < 2; r++) {
                                writer.put(pick([0, 1]), 1);
                                const x = range(-9, 9);
                                const y = range(-7, 7);
                                writeVectorComponent(x - pmv[r][0], rSize);
                                writeVectorComponent(y - (pmv[r][1] >> 1), rSize);
                                pmv[r] = [x, y * 2];
                            }
                        } else {
                            writer.code('10');
                            for (let r = 0; r < 2; r++) {
                                writer.put(pick([0, 1]), 1);
                                const x = range(-9, 9);
                                const y = range(-7, 7);
                                writeVectorComponent(x - pmv[r][0], rSize);
                                writeVectorComponent(y - pmv[r][1], rSize);
                                pmv[r] = [x, y];
                            }
                        }
                    } else if (kind === 'dual') {
                        writer.code('11');
                        if (frame && coded) writer.put(next() < 0.5 ? 1 : 0, 1);
                        const x = range(-6, 6);
                        const y = range(-4, 4);
                        const prediction = frame ? pmv[0][1] >> 1 : pmv[0][1];
                        writeVectorComponent(x - pmv[0][0], rSize);
                        writeDualPrime(range(-1, 1));
                        writeVectorComponent(y - prediction, rSize);
                        writeDualPrime(range(-1, 1));
                        pmv[0] = [x, frame ? y * 2 : y];
                        pmv[1] = [x, frame ? y * 2 : y];
                    }
                }
                if (!coded) return;
                const pattern = pick([60, 4, 8, 16, 32, 1, 2, 63]);
                writer.code(PATTERN_CODES[pattern]);
                const extra = range(0, 3);
                if (chroma === 422) writer.put(extra, 2);
                const patternBits = chroma === 422 ? (pattern << 2) | extra : pattern;
                for (let block = 0; block < blockCount; block++) {
                    if (!(patternBits & (1 << (blockCount - 1 - block)))) continue;
                    writeLevel(0, pick([1, -1, 5, -7]), true);
                    writeAc(range(0, 3));
                }
            }
        }
        if (!frame) fieldPictureCount++;
        if (frame || secondField) temporalReference++;
    }
    writer.startCode(0xb7);
    return writer.finish();
}
