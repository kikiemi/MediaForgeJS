import type { FieldOrder, MasteringDisplay, VideoColour } from '../../core/model/media';
import { MediaForgeError } from '../../core/errors/errors';
import { isoBox } from './iso-box';

const FIELD_ORDERS: ReadonlySet<string> = new Set(['progressive', 'tt', 'bb', 'tb', 'bt']);

function code(value: unknown, name: string): number {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255)
        throw new MediaForgeError(
            `video colour ${name} must be an integer code point from 0 to 255`,
            'FORMAT',
        );
    return value as number;
}

function chromaticity(value: unknown, name: string): readonly [number, number] {
    const pair = value as readonly unknown[];
    if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !pair.every(item => Number.isFinite(item) && item >= 0 && item <= 1)
    )
        throw new MediaForgeError(
            `mastering display ${name} must be an x/y chromaticity pair from 0 to 1`,
            'FORMAT',
        );
    return [pair[0] as number, pair[1] as number];
}

function luminance(value: unknown, name: string): number {
    if (!Number.isFinite(value) || (value as number) < 0 || (value as number) > 429496)
        throw new MediaForgeError(
            `mastering display ${name} must be from 0 to 429496 cd/m²`,
            'FORMAT',
        );
    return value as number;
}

function mastering(value: MasteringDisplay): MasteringDisplay {
    if (!value || typeof value !== 'object')
        throw new MediaForgeError('mastering display must be an object', 'FORMAT');
    return {
        red: chromaticity(value.red, 'red'),
        green: chromaticity(value.green, 'green'),
        blue: chromaticity(value.blue, 'blue'),
        whitePoint: chromaticity(value.whitePoint, 'white point'),
        maxLuminance: luminance(value.maxLuminance, 'maximum luminance'),
        minLuminance: luminance(value.minLuminance, 'minimum luminance'),
    };
}

/** A validated copy of a video colour description and its HDR metadata for a muxer to keep. */
export function snapshotVideoColour(colour: VideoColour | undefined): VideoColour | undefined {
    if (colour === undefined) return undefined;
    if (!colour || typeof colour !== 'object')
        throw new MediaForgeError('video colour must be an object', 'FORMAT');
    if (colour.fullRange !== undefined && typeof colour.fullRange !== 'boolean')
        throw new MediaForgeError('video colour fullRange must be a boolean', 'FORMAT');
    const light = colour.contentLight;
    if (
        light !== undefined &&
        (!light ||
            ![light.maxContent, light.maxAverage].every(
                level => Number.isInteger(level) && level >= 0 && level <= 0xffff,
            ))
    )
        throw new MediaForgeError(
            'content light levels must be integers from 0 to 65535 cd/m²',
            'FORMAT',
        );
    return {
        primaries: code(colour.primaries, 'primaries'),
        transfer: code(colour.transfer, 'transfer'),
        matrix: code(colour.matrix, 'matrix'),
        ...(colour.fullRange === undefined ? {} : { fullRange: colour.fullRange }),
        ...(colour.mastering === undefined ? {} : { mastering: mastering(colour.mastering) }),
        ...(light === undefined
            ? {}
            : { contentLight: { maxContent: light.maxContent, maxAverage: light.maxAverage } }),
    };
}

/** A validated field order. */
export function checkedFieldOrder(value: FieldOrder | undefined): FieldOrder | undefined {
    if (value !== undefined && !FIELD_ORDERS.has(value))
        throw new MediaForgeError('field order must be progressive, tt, bb, tb or bt', 'FORMAT');
    return value;
}

/**
 * ISO/IEC 14496-12 mdcv payload: G, B, R and white point x/y in 0.00002 units, luminance in 0.0001
 * cd/m².
 */
function mdcvPayload(value: MasteringDisplay): Uint8Array {
    const payload = new Uint8Array(24);
    const view = new DataView(payload.buffer);
    [value.green, value.blue, value.red, value.whitePoint].forEach(([x, y], index) => {
        view.setUint16(index * 4, Math.min(0xffff, Math.round(x * 50000)));
        view.setUint16(index * 4 + 2, Math.min(0xffff, Math.round(y * 50000)));
    });
    view.setUint32(16, Math.min(0xffffffff, Math.round(value.maxLuminance * 10000)));
    view.setUint32(20, Math.min(0xffffffff, Math.round(value.minLuminance * 10000)));
    return payload;
}

/**
 * The mastering display of an mdcv (or VP9 SmDm, which uses the same fixed-point units) payload.
 */
export function readMdcv(bytes: Uint8Array, offset: number): MasteringDisplay {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 24);
    const pair = (index: number): [number, number] => [
        view.getUint16(index * 4) / 50000,
        view.getUint16(index * 4 + 2) / 50000,
    ];
    return {
        green: pair(0),
        blue: pair(1),
        red: pair(2),
        whitePoint: pair(3),
        maxLuminance: view.getUint32(16) / 10000,
        minLuminance: view.getUint32(20) / 10000,
    };
}

/**
 * QuickTime/ISO fiel payload: field count, then 1/6 for top/bottom first and 9/14 for the
 * interleaved orders.
 */
const FIEL_DETAIL: Readonly<Record<string, number>> = { tt: 1, bb: 6, tb: 9, bt: 14 };

export function fielPayload(order: FieldOrder): Uint8Array {
    return order === 'progressive' ? Uint8Array.of(1, 0) : Uint8Array.of(2, FIEL_DETAIL[order]!);
}

export function readFiel(fields: number, detail: number): FieldOrder | undefined {
    if (fields === 1) return 'progressive';
    if (fields !== 2) return undefined;
    return (Object.keys(FIEL_DETAIL) as FieldOrder[]).find(order => FIEL_DETAIL[order] === detail);
}

/**
 * The colour boxes of a visual sample entry: colr (nclx; QuickTime's nclc when the range is
 * unknown, which nclx cannot leave open), mdcv and clli for HDR metadata, and fiel for the field
 * order.
 */
export function visualSampleEntryBoxes(
    colour: VideoColour | undefined,
    fieldOrder: FieldOrder | undefined,
    quickTime: boolean,
): Uint8Array[] {
    const boxes: Uint8Array[] = [];
    if (colour) {
        const nclc = quickTime && colour.fullRange === undefined;
        const colr = new Uint8Array(nclc ? 10 : 11);
        const view = new DataView(colr.buffer);
        for (let index = 0; index < 4; index++)
            colr[index] = (nclc ? 'nclc' : 'nclx').charCodeAt(index);
        view.setUint16(4, colour.primaries);
        view.setUint16(6, colour.transfer);
        view.setUint16(8, colour.matrix);
        if (!nclc) colr[10] = colour.fullRange ? 0x80 : 0;
        boxes.push(isoBox('colr', colr));
        if (colour.mastering) boxes.push(isoBox('mdcv', mdcvPayload(colour.mastering)));
        const light = colour.contentLight;
        if (light) {
            const clli = new Uint8Array(4);
            new DataView(clli.buffer).setUint16(0, light.maxContent);
            new DataView(clli.buffer).setUint16(2, light.maxAverage);
            boxes.push(isoBox('clli', clli));
        }
    }

    if (fieldOrder) boxes.push(isoBox('fiel', fielPayload(fieldOrder)));
    return boxes;
}
