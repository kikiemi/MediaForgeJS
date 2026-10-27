import * as api from './api.mjs';
import * as codecs from './codecs.mjs';
import * as formats from './formats.mjs';

/**
 * The registry of the support matrix (test/support/matrix.test.mjs): what the owners of the
 * features supply, one module per area, each exporting any of
 *
 * - `containers`: { [format]: input } — a small file of the container, for read/<format> (inspect()
 *   reports the format) and write/<format> (a conversion of it to the format reads back as one);
 * - `streams`: { [codec]: input } — a small file whose track of that codec family is copied into
 *   every container that declares the codec (copy/<container>/<codec>) and, for an audio codec,
 *   decoded by the library (decode/<codec>);
 * - `decoderInputs`: { [decoder id]: input } — a file the library's video decoder decodes
 *   (decode/<id>), whose first picture frames() returns;
 * - `images`: { [format]: input } — a picture of the format (image-in/<format>); the TIFF one is
 *   also converted to every written image format (image-out/<format>);
 * - `cases`: { [cell id]: case } — a case of its own for a cell the inputs do not cover:
 *   operations, the host's codecs, playback, or anything a generic case gets wrong.
 *
 * An input is a function returning a Uint8Array or a Blob, or { make, format?, aliases?,
 * structural? } with the format inspect() reports when it is not the cell's (an '.opus' file is
 * 'ogg'), the codec families a copy may report instead ('avc3' copied as 'avc1'), and `structural:
 * true` for a stream built by its specification where no encoder exists, whose payload does not
 * decode: its cells check carriage, not decoding (`npm run support` shows them as such). A case
 * is an async function, or { browser: true, run } for one that needs the browser; it is given its
 * cell (test/support/table.mjs), whose `formats` an operation's case of a target class may pick
 * from, and the test context, whose skip() a host case calls with its reason where the host
 * declares what it cannot do at all. An operation taking targets has a cell per class,
 * 'operation/<name>/<class>'; one without, 'operation/<name>'.
 * Import helpers inside the functions, so the registry loads in the browser test page.
 */
const AREAS = { codecs, formats, api };
const FIELDS = ['containers', 'streams', 'decoderInputs', 'images', 'cases'];

/** The registry of every area; a key two areas define is an error. */
export function registry() {
    const merged = Object.fromEntries(FIELDS.map(field => [field, {}]));
    for (const [area, module] of Object.entries(AREAS))
        for (const field of FIELDS)
            for (const [key, value] of Object.entries(module[field] ?? {})) {
                if (key in merged[field])
                    throw new Error(
                        `test/support/cases: ${field}.${key} is in two areas (${area})`,
                    );
                merged[field][key] = value;
            }
    return merged;
}
