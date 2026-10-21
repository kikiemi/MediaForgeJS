import assert from 'node:assert/strict';
import { codecFamily } from './table.mjs';

// The case of each kind of cell, made from the registry's inputs (./cases/index.mjs): what the
// cell declares, done once through the public API on a small input. A cell whose kind has no
// generic case (operations, the host's codecs, playback) needs a case of its own.

/** The function and the expectations of an input of the registry. */
const inputOf = value =>
    typeof value === 'function'
        ? { make: value, format: undefined, aliases: [], structural: false }
        : { aliases: [], structural: false, ...value };

/** The input as a Blob. */
async function blobOf(input) {
    const value = await input.make();
    return value instanceof Blob ? value : new Blob([value]);
}

const api = () => import('mediaforgejs');

/**
 * The size and pixels of a BMP the library wrote (top-down, 24- or 32-bit): { width, height,
 * rgb(x, y) }.
 */
function bmpPicture(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const [start, width, rows, bits] = [
        view.getUint32(10, true),
        view.getInt32(18, true),
        view.getInt32(22, true),
        view.getUint16(28, true),
    ];
    const height = Math.abs(rows);
    const stride = Math.ceil((width * bits) / 32) * 4;
    const rgb = (x, y) => {
        const at = start + (rows < 0 ? y : height - 1 - y) * stride + (x * bits) / 8;
        return [bytes[at + 2], bytes[at + 1], bytes[at]];
    };
    return { width, height, rgb };
}

/** The first track of `info` whose codec belongs to `family` (or one of `aliases`). */
function trackOf(info, family, aliases = []) {
    const families = [family, ...aliases];
    return info.tracks.find(track => families.includes(codecFamily(track.codec)));
}

/** What the generic case of each kind needs from the registry, and the case itself. */
const GENERIC = {
    read: cell => [
        'containers',
        async input => {
            const info = await (await api()).inspect(await blobOf(input));
            assert.equal(info.format, input.format ?? cell.subject);
            assert(info.tracks.length > 0, 'the input has tracks');
        },
    ],
    write: cell => [
        'containers',
        async input => {
            const { convert, inspect } = await api();
            const output = await convert(await blobOf(input), cell.subject);
            assert.equal((await inspect(output.blob)).format, cell.subject);
        },
    ],
    copy: cell => [
        'streams',
        async input => {
            const { convert, inspect } = await api();
            const source = await blobOf(input);
            const track = trackOf(await inspect(source), cell.subject, input.aliases);
            assert(track, `the input has a ${cell.subject} track`);
            const output = await convert(source, cell.container, {
                copy: true,
                trackIds: [track.id],
            });
            const copied = trackOf(await inspect(output.blob), cell.subject, input.aliases);
            assert(copied, `the ${cell.container} output holds the ${cell.subject} track`);
        },
    ],
    decode: cell =>
        cell.media === 'audio'
            ? [
                  'streams',
                  async input => {
                      const { convert, inspect } = await api();
                      const source = await blobOf(input);
                      const track = trackOf(await inspect(source), cell.subject, input.aliases);
                      assert(track, `the input has a ${cell.subject} track`);
                      const output = await convert(source, 'wav', { trackIds: [track.id] });
                      const [decoded] = (await inspect(output.blob)).tracks;
                      assert(decoded?.duration > 0, 'the decoded audio lasts');
                  },
              ]
            : [
                  'decoderInputs',
                  async input => {
                      const { frames } = await api();
                      for await (const frame of frames(await blobOf(input))) {
                          assert(frame.width > 0 && frame.height > 0);
                          return;
                      }
                      assert.fail('frames() returned no picture');
                  },
              ],
    encode: cell => [
        'containers',
        async input => {
            const { convert, inspect } = await api();
            const output = await convert(await blobOf(input), cell.subject);
            const [track] = (await inspect(output.blob)).tracks;
            assert.equal(codecFamily(track.codec), cell.subject === 'aac' ? 'mp4a' : cell.subject);
        },
        'wav',
    ],
    'image-in': cell => [
        'images',
        async input => {
            const { capabilities, convert, inspect } = await api();
            const source = await blobOf(input);
            const info = await inspect(source);
            assert.equal(info.format, input.format ?? cell.subject);
            // Decoded to BMP: its size, and where the input's pixels are known, one of them. A
            // format only the host decodes is declared where it does; elsewhere it fails.
            const declared = (await capabilities()).imageRead.includes(cell.subject);
            const decoding = convert(source, 'bmp');
            if (!declared) return assert.rejects(decoding, error => error.code === 'DECODE');
            const decoded = bmpPicture(new Uint8Array(await (await decoding).blob.arrayBuffer()));
            const [{ width, height }] = info.tracks;
            assert.deepEqual([decoded.width, decoded.height], [width, height]);
            if (!input.picture) return;
            const picture = await input.picture();
            assert.deepEqual([width, height], [picture.width, picture.height]);
            const at = (5 * picture.width + 5) * 4;
            const expected = [...picture.data.subarray(at, at + 3)];
            const actual = decoded.rgb(5, 5);
            assert(
                actual.every(
                    (value, channel) => Math.abs(value - expected[channel]) <= input.tolerance,
                ),
                `pixel (5, 5) is ${actual}, the picture's ${expected}`,
            );
        },
    ],
    'image-out': cell => [
        'images',
        async input => {
            const { capabilities, convert, inspect } = await api();
            const declared = (await capabilities()).images.includes(cell.subject);
            const written = convert(await blobOf(input), cell.subject);
            // A format only the host's canvas writes is declared where it does; elsewhere it fails.
            if (!declared) return assert.rejects(written, error => error.code === 'ENCODE');
            assert.equal((await inspect((await written).blob)).format, cell.subject);
        },
        'tiff',
    ],
    package: cell => [
        'containers',
        async input => {
            const result = await (await api()).packageMedia(await blobOf(input), cell.subject);
            assert(
                result.files.size > 1 && result.files.has(result.entry),
                'a presentation is written',
            );
        },
        'mp4',
    ],
};

/**
 * The case of `cell` in `registry`: { run, browser, generic, structural } or undefined when it has
 * none; `structural` when its input is a stream built by its specification. Its own case comes
 * first; then the generic case of its kind, with the input it names (the cell's subject unless the
 * kind takes one input for every cell: WAV for encode/, TIFF for image-out/ (a picture the library
 * decodes on every host, where a PNG needs the host's decoder), MP4 for package/).
 */
export function caseOf(cell, registry) {
    const own = registry.cases[cell.id];
    if (own)
        return typeof own === 'function'
            ? { run: () => own(cell), browser: false, generic: false, structural: false }
            : {
                  run: () => own.run(cell),
                  browser: own.browser === true,
                  generic: false,
                  structural: false,
              };
    const generic = GENERIC[cell.kind]?.(cell);
    if (!generic) return undefined;
    const [field, check, key = cell.subject] = generic;
    const value = registry[field][key];
    if (!value) return undefined;
    const input = inputOf(value);
    return {
        run: () => check(input),
        browser: false,
        generic: true,
        structural: input.structural === true,
        field,
        key,
    };
}

/** The ids of `cells` whose case runs on a stream built by its specification. */
export const structuralCells = (cells, registry) =>
    new Set(cells.filter(cell => caseOf(cell, registry)?.structural).map(cell => cell.id));

/** The registry entries `cells` use: 'field/key', for finding the ones no cell uses. */
export function usedInputs(cells, registry) {
    const used = new Set();
    for (const cell of cells) {
        if (registry.cases[cell.id]) {
            used.add(`cases/${cell.id}`);
            continue;
        }
        const generic = GENERIC[cell.kind]?.(cell);
        if (generic) used.add(`${generic[0]}/${generic[2] ?? cell.subject}`);
    }
    return used;
}
