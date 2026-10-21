import { dataView } from '../../core/bytes/byte-fields'; /**

 * UTF-8 text of a 3GPP timed-text (tx3g, MP4 mov_text) sample: its 16-bit length and text, which is
 * UTF-16 when it starts with a byte-order mark. The style boxes after the text are dropped; an
 * empty result only ends a cue.
 */
export function tx3gText(sample: Uint8Array): Uint8Array {
    if (sample.length < 2) return new Uint8Array(0);
    const text = sample.subarray(
        2,
        2 + Math.min((sample[0]! << 8) | sample[1]!, sample.length - 2),
    );
    if (text.length >= 2 && text[0] === 0xfe && text[1] === 0xff)
        return new TextEncoder().encode(new TextDecoder('utf-16be').decode(text.subarray(2)));
    return text;
}

/** tx3g face style flags, which SubRip, WebVTT and ASS can all state. */
const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;
const TAGS: readonly (readonly [number, string])[] = [
    [BOLD, 'b'],
    [ITALIC, 'i'],
    [UNDERLINE, 'u'],
];

/** A run of cue text with one combination of the tx3g face styles. */
interface StyledRun {
    readonly text: string;
    readonly face: number;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The style records (styl box) of a tx3g sample after its text, as code point ranges and face
 * flags.
 */
function tx3gStyles(
    sample: Uint8Array,
    textEnd: number,
): { start: number; end: number; face: number }[] {
    const styles: { start: number; end: number; face: number }[] = [];
    const view = dataView(sample);
    for (let at = textEnd; at + 8 <= sample.length;) {
        const size = view.getUint32(at);
        if (size < 8 || at + size > sample.length) break;
        if (decoder.decode(sample.subarray(at + 4, at + 8)) === 'styl' && size >= 10) {
            const count = view.getUint16(at + 8);
            for (
                let index = 0, record = at + 10;
                index < count && record + 12 <= at + size;
                index++, record += 12
            )
                styles.push({
                    start: view.getUint16(record),
                    end: view.getUint16(record + 2),
                    face: sample[record + 6]!,
                });
        }

        at += size;
    }

    return styles;
}

/**
 * The text of a tx3g sample as SubRip text, its bold, italic and underline style records written as
 * <b>, <i> and <u> tags (as ffmpeg converts mov_text); other style fields (font, size, colour) have
 * no SubRip form.
 */
export function tx3gSubRip(sample: Uint8Array): string {
    const text = decoder.decode(tx3gText(sample));
    const length =
        sample.length >= 2 ? Math.min((sample[0]! << 8) | sample[1]!, sample.length - 2) : 0;
    const styles = tx3gStyles(sample, 2 + length).filter(
        style => style.face & (BOLD | ITALIC | UNDERLINE),
    );
    if (!styles.length) return text;

    const points = Array.from(text);
    const faces = new Array<number>(points.length).fill(0);
    for (const style of styles)
        for (let index = style.start; index < Math.min(style.end, points.length); index++)
            faces[index] |= style.face;

    let out = '';
    let open = 0;
    for (let index = 0; index <= points.length; index++) {
        const face = index < points.length ? faces[index]! : 0;
        if (face !== open) {
            for (const [flag, tag] of [...TAGS].reverse()) if (open & flag) out += `</${tag}>`;
            for (const [flag, tag] of TAGS) if (face & flag) out += `<${tag}>`;
            open = face;
        }
        if (index < points.length) out += points[index];
    }
    return out;
}

/**
 * Runs of SubRip or WebVTT cue text: <b>, <i> and <u> set the face, other tags (fonts, classes,
 * voices) are dropped.
 */
function markupRuns(text: string): { runs: StyledRun[]; dropped: boolean } {
    const runs: StyledRun[] = [];
    let face = 0;
    let dropped = false;
    for (const part of text.split(/(<[^>]*>)/)) {
        const tag = /^<(\/?)\s*([a-z]+)[^>]*>$/i.exec(part);
        if (!tag) {
            if (part)
                runs.push({
                    text: part.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
                    face,
                });
            continue;
        }
        const flag = TAGS.find(([, name]) => name === tag[2]!.toLowerCase())?.[0];
        if (flag === undefined) dropped = true;
        else face = tag[1] ? face & ~flag : face | flag;
    }
    return { runs, dropped };
}

/**
 * Runs of an ASS/SSA dialogue text: \b, \i and \u overrides set the face, \N and \n break lines,
 * others are dropped.
 */
function assRuns(text: string): { runs: StyledRun[]; dropped: boolean } {
    const runs: StyledRun[] = [];
    let face = 0;
    let dropped = false;
    for (const part of text.split(/(\{[^}]*\})/)) {
        if (!part.startsWith('{')) {
            if (part) runs.push({ text: part.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '), face });
            continue;
        }
        for (const override of part.slice(1, -1).split('\\').filter(Boolean)) {
            const style = /^([biu])(\d*)$/.exec(override);
            if (style) {
                const flag = style[1] === 'b' ? BOLD : style[1] === 'i' ? ITALIC : UNDERLINE;
                face = style[2] === '' || style[2] === '0' ? face & ~flag : face | flag;
            } else if (override === 'r') face = 0;
            else dropped = true;
        }
    }
    return { runs, dropped };
}

/**
 * The Matroska block text of an ASS/SSA event: ReadOrder, Layer (Marked), Style, Name, MarginL,
 * MarginR, MarginV and Effect come before the dialogue text, which may itself contain commas.
 */
function assEventText(block: string): { text: string; styled: boolean } {
    const fields = block.split(',');
    const text = fields.length > 8 ? fields.slice(8).join(',') : block;
    // An event with a style other than Default, or with an effect, has a look tx3g cannot state.
    return {
        text,
        styled: fields.length > 8 && ((fields[2] ?? '') !== 'Default' || (fields[7] ?? '') !== ''),
    };
}

/**
 * The cue of a WebVTT packet as Matroska and WebM blocks hold it (D_WEBVTT): the cue identifier
 * line, the cue settings line, then the cue text.
 */
export function webVttBlockCue(block: string): { id: string; settings: string; text: string } {
    const lines = block.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length < 3) return { id: '', settings: '', text: block };
    return { id: lines[0]!, settings: lines[1]!, text: lines.slice(2).join('\n') };
}

/**
 * A tx3g sample of a text subtitle packet: its UTF-8 text and a styl box for bold, italic and
 * underline. `lost` is true when the cue had styling tx3g cannot keep (fonts, colours, positions,
 * classes, ASS styles).
 */
export function tx3gSample(codec: string, data: Uint8Array): { sample: Uint8Array; lost: boolean } {
    const source = decoder.decode(data);
    let parsed: { runs: StyledRun[]; dropped: boolean };
    if (codec === 'text/ass' || codec === 'text/ssa') {
        const event = assEventText(source);
        parsed = assRuns(event.text);
        parsed.dropped ||= event.styled;
    } else if (codec === 'text/webvtt') {
        const cue = webVttBlockCue(source);
        parsed = markupRuns(cue.text);

        // Cue settings place the cue, which tx3g's default placement does not keep.
        parsed.dropped ||= cue.settings.trim() !== '';
    } else parsed = markupRuns(source.replace(/\r\n?/g, '\n'));
    const text = parsed.runs.map(run => run.text).join('');
    const bytes = encoder.encode(text).subarray(0, 0xffff);
    const records: number[][] = [];
    let at = 0;
    for (const run of parsed.runs) {
        const length = Array.from(run.text).length;
        if (run.face && length) records.push([at, at + length, run.face]);
        at += length;
    }
    const styl = records.length ? 10 + records.length * 12 : 0;
    const sample = new Uint8Array(2 + bytes.length + styl);
    const view = new DataView(sample.buffer);
    view.setUint16(0, bytes.length);
    sample.set(bytes, 2);
    if (styl) {
        let offset = 2 + bytes.length;
        view.setUint32(offset, styl);
        sample.set(encoder.encode('styl'), offset + 4);
        view.setUint16(offset + 8, records.length);
        offset += 10;
        for (const [start, end, face] of records) {
            view.setUint16(offset, Math.min(start!, 0xffff));
            view.setUint16(offset + 2, Math.min(end!, 0xffff));
            view.setUint16(offset + 4, 1);
            sample[offset + 6] = face!;
            sample[offset + 7] = 18;
            view.setUint32(offset + 8, 0xffffffff);
            offset += 12;
        }
    }
    return { sample, lost: parsed.dropped };
}

/**
 * The tx3g sample entry body after its reserved bytes and data reference index, as ffmpeg's
 * mov_text encoder writes it: no display flags, centred at the bottom, a transparent background,
 * white 18-point text and a one-font table.
 */
export function tx3gSampleEntryBody(): Uint8Array {
    const font = encoder.encode('Serif');
    const body = new Uint8Array(30 + 13 + font.length);
    const view = new DataView(body.buffer);
    body[4] = 1;
    body[5] = 0xff;
    view.setUint16(22, 1);
    body[25] = 18;
    view.setUint32(26, 0xffffffff);
    view.setUint32(30, 13 + font.length);
    body.set(encoder.encode('ftab'), 34);
    view.setUint16(38, 1);
    view.setUint16(40, 1);
    body[42] = font.length;
    body.set(font, 43);
    return body;
}
