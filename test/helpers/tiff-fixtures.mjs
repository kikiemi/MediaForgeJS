import { deflateSync } from 'node:zlib';

/**
 * Small baseline TIFF files built in the test: strips or tiles, chunky or planar, uncompressed,
 * PackBits, LZW or Deflate, with the horizontal predictor, in either byte order.
 */

/** PackBits: runs of three or more equal bytes as repeats, the rest as literals. */
export function packBits(data) {
    const out = [];
    let at = 0;
    while (at < data.length) {
        let run = 1;
        while (at + run < data.length && run < 128 && data[at + run] === data[at]) run++;
        if (run >= 3) {
            out.push((1 - run) & 0xff, data[at]);
            at += run;
            continue;
        }
        let end = at;
        while (
            end < data.length &&
            end - at < 128 &&
            !(data[end] === data[end + 1] && data[end] === data[end + 2])
        )
            end++;
        out.push(end - at - 1, ...data.subarray(at, end));
        at = end;
    }
    return Uint8Array.from(out);
}

/** TIFF LZW: 9- to 12-bit codes, most significant bit first, with the early width change. */
export function lzw(data) {
    const out = [];
    let buffer = 0;
    let count = 0;
    let width = 9;
    const put = code => {
        buffer = (buffer << width) | code;
        count += width;
        while (count >= 8) {
            out.push((buffer >>> (count - 8)) & 0xff);
            count -= 8;
        }
        buffer &= (1 << count) - 1;
    };
    let table = new Map();
    let next = 258;
    put(256);
    let current = '';
    for (const byte of data) {
        const extended = current + String.fromCharCode(byte);
        if (current === '' || table.has(extended)) {
            current = extended;
            continue;
        }
        put(current.length === 1 ? current.charCodeAt(0) : table.get(current));
        table.set(extended, next++);
        if (next >= 1 << width) width++;
        if (next >= 4094) {
            put(256);
            table = new Map();
            next = 258;
            width = 9;
        }
        current = String.fromCharCode(byte);
    }
    if (current) put(current.length === 1 ? current.charCodeAt(0) : table.get(current));
    put(257);
    if (count) out.push((buffer << (8 - count)) & 0xff);
    return Uint8Array.from(out);
}

/** Each compression of a tile or strip of rows of `rowBytes`; PackBits packs each row alone. */
const COMPRESS = {
    1: data => data,
    5: lzw,
    8: data => new Uint8Array(deflateSync(data)),
    32773: (data, rowBytes) => {
        const rows = [];
        for (let at = 0; at < data.length; at += rowBytes)
            rows.push(...packBits(data.subarray(at, at + rowBytes)));
        return Uint8Array.from(rows);
    },
};

/**
 * A TIFF of `values` (chunky, row-major samples of `bits` bits) and its shape. `tile` gives tile
 * width and height, `rows` the rows per strip; `planar` stores each sample as its own plane.
 */
export function tiff({
    width,
    height,
    samples,
    values,
    bits = 8,
    photometric = samples >= 3 ? 2 : 1,
    compression = 1,
    predictor = 1,
    tile,
    rows = height,
    planar = false,
    little = true,
    extra,
    palette,
}) {
    const planes = planar ? samples : 1;
    const perPixel = planar ? 1 : samples;
    const [tw, th] = tile ?? [width, rows];
    const across = Math.ceil(width / tw);
    const down = Math.ceil(height / th);
    const rowBytes = Math.ceil((tw * perPixel * bits) / 8);
    const chunks = [];
    for (let plane = 0; plane < planes; plane++)
        for (let ty = 0; ty < down; ty++)
            for (let tx = 0; tx < across; tx++) {
                // Tiles are whole even past the picture edge; strips stop at its last row.
                const tileRows = tile ? th : Math.min(th, height - ty * th);
                const raw = new Uint8Array(tileRows * rowBytes);
                const view = new DataView(raw.buffer);
                for (let y = 0; y < tileRows; y++)
                    for (let x = 0; x < tw; x++)
                        for (let s = 0; s < perPixel; s++) {
                            const px = tx * tw + x;
                            const py = ty * th + y;
                            if (px >= width || py >= height) continue;
                            const value =
                                values[(py * width + px) * samples + (planar ? plane : s)];
                            const index = x * perPixel + s;
                            const at = y * rowBytes;
                            if (bits < 8)
                                raw[at + ((index * bits) >> 3)] |=
                                    value << (8 - bits - ((index * bits) & 7));
                            else if (bits === 8) raw[at + index] = value;
                            else view.setUint16(at + index * 2, value, little);
                        }
                if (predictor === 2)
                    for (let y = 0; y < tileRows; y++)
                        for (let x = tw - 1; x > 0; x--)
                            for (let s = 0; s < perPixel; s++) {
                                const index = y * rowBytes + (x * perPixel + s) * (bits / 8);
                                const before = index - perPixel * (bits / 8);
                                if (bits === 8) raw[index] = (raw[index] - raw[before]) & 0xff;
                                else
                                    view.setUint16(
                                        index,
                                        (view.getUint16(index, little) -
                                            view.getUint16(before, little)) &
                                            0xffff,
                                        little,
                                    );
                            }
                chunks.push(COMPRESS[compression](raw, rowBytes));
            }

    // Header, the chunks, then the directory and the arrays it points to.
    const parts = [];
    let size = 8;
    const offsets = chunks.map(chunk => {
        const at = size;
        parts.push(chunk);
        size += chunk.length + (chunk.length & 1);
        if (chunk.length & 1) parts.push(new Uint8Array(1));
        return at;
    });
    const entries = [
        [256, 4, [width]],
        [257, 4, [height]],
        [258, 3, new Array(samples).fill(bits)],
        [259, 3, [compression]],
        [262, 3, [photometric]],
        [tile ? 324 : 273, 4, offsets],
        [277, 3, [samples]],
        ...(tile ? [] : [[278, 4, [th]]]),
        [tile ? 325 : 279, 4, chunks.map(chunk => chunk.length)],
        [284, 3, [planar ? 2 : 1]],
        ...(predictor === 2 ? [[317, 3, [2]]] : []),
        ...(palette ? [[320, 3, palette]] : []),
        ...(tile
            ? [
                  [322, 4, [tw]],
                  [323, 4, [th]],
              ]
            : []),
        ...(extra !== undefined ? [[338, 3, [extra]]] : []),
    ].sort((a, b) => a[0] - b[0]);
    const directory = size;
    const tableSize = 2 + entries.length * 12 + 4;
    let arrays = directory + tableSize;
    const table = new Uint8Array(tableSize);
    const tableView = new DataView(table.buffer);
    tableView.setUint16(0, entries.length, little);
    const extras = [];
    entries.forEach(([tag, type, list], index) => {
        const at = 2 + index * 12;
        const unit = type === 3 ? 2 : 4;
        tableView.setUint16(at, tag, little);
        tableView.setUint16(at + 2, type, little);
        tableView.setUint32(at + 4, list.length, little);
        const write = (view, offset) =>
            list.forEach((value, item) =>
                unit === 2
                    ? view.setUint16(offset + item * 2, value, little)
                    : view.setUint32(offset + item * 4, value, little),
            );
        if (list.length * unit <= 4) write(tableView, at + 8);
        else {
            const block = new Uint8Array(list.length * unit + ((list.length * unit) & 1));
            write(new DataView(block.buffer), 0);
            tableView.setUint32(at + 8, arrays, little);
            arrays += block.length;
            extras.push(block);
        }
    });
    const header = new Uint8Array(8);
    const headerView = new DataView(header.buffer);
    header[0] = header[1] = little ? 0x49 : 0x4d;
    headerView.setUint16(2, 42, little);
    headerView.setUint32(4, directory, little);
    const file = new Uint8Array(arrays);
    let at = 0;
    for (const part of [header, ...parts, table, ...extras]) {
        file.set(part, at);
        at += part.length;
    }
    return file;
}
