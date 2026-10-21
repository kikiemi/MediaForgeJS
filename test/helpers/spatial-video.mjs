// Spatial video (iPhone and Vision Pro MV-HEVC) for the tests of MP4 writing and packaging: the
// HEVC fixture with the layer configuration, Apple's video extended usage and the field of view
// in its sample entry.
import { FIXTURES } from './new-format-fixtures.mjs';

const isoBox = (type, ...parts) => {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
};
const isoFullBox = (type, ...parts) => isoBox(type, Buffer.alloc(4), ...parts);
const int32 = (value, signed = false) => {
    const bytes = Buffer.alloc(4);
    if (signed) bytes.writeInt32BE(value);
    else bytes.writeUInt32BE(value);
    return bytes;
};

/** The boxes appended to the sample entry: lhvC, vexu (eyes, camera, projection) and hfov. */
export const SPATIAL_BOXES = Buffer.concat([
    isoBox('lhvC', Buffer.from('01f000fccb00', 'hex')),
    isoBox(
        'vexu',
        isoBox(
            'eyes',
            isoFullBox('stri', Buffer.of(3)),
            isoFullBox('hero', Buffer.of(1)),
            isoBox('cams', isoFullBox('blin', int32(19240))),
            isoBox('cmfy', isoFullBox('dadj', int32(-150, true))),
        ),
        isoBox('proj', isoFullBox('prji', Buffer.from('hequ', 'latin1'))),
    ),
    isoBox('hfov', int32(63400)),
]);

/** What inspect() reports of those boxes. */
export const SPATIAL = Object.freeze({
    eyes: ['left', 'right'],
    views: 'layer',
    heroEye: 'left',
    baseline: 19.24,
    disparityAdjustment: -0.015,
    projection: 'half-equirectangular',
    fieldOfView: 63.4,
});

/** The HEVC fixture with SPATIAL_BOXES appended to its 'hvc1' sample entry. */
export function spatialMp4() {
    const bytes = FIXTURES['hevc.mp4'].bytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parents = [];
    let start = 0;
    for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'hvc1']) {
        let at = start;
        while (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) !== type)
            at += view.getUint32(at);
        parents.push(at);
        start = at + 8 + (type === 'stsd' ? 8 : type === 'hvc1' ? 78 : 0);
    }
    const end = parents.at(-1) + view.getUint32(parents.at(-1));
    const output = Buffer.concat([bytes.subarray(0, end), SPATIAL_BOXES, bytes.subarray(end)]);
    for (const at of parents)
        output.writeUInt32BE(output.readUInt32BE(at) + SPATIAL_BOXES.length, at);
    return new Uint8Array(output);
}

/** Whether `output` holds SPATIAL_BOXES whole. */
export const holdsSpatialBoxes = output => Buffer.from(output).indexOf(SPATIAL_BOXES) >= 0;
