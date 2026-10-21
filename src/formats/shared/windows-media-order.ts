import {
    PICTURE_B,
    PICTURE_I,
    PICTURE_P,
    findStartCode,
} from '../../core/codec-config/video/mpeg-video';
import { VC1_FRAME, VC1_SEQUENCE, parseVc1SequenceHeader } from '../../core/codec-config/video/vc1';
import { u32be } from '../../core/bytes/byte-fields';

/**
 * Picture type of an advanced profile frame (0x0000010D payload or bare frame data) for reordering:
 * PICTURE_I, PICTURE_P for P and skipped pictures, PICTURE_B for B and BI pictures (and B field
 * pairs), which no picture uses as a reference; undefined when the header is cut. A frame led by a
 * sequence header is an I picture.
 */
function vc1PictureType(data: Uint8Array, interlace: boolean): number | undefined {
    let at = 0;
    for (
        let code = findStartCode(data, 0);
        code >= 0 && code + 3 < data.length;
        code = findStartCode(data, code + 4)
    ) {
        if (data[code + 3] === VC1_FRAME) {
            at = code + 4;
            break;
        }
        if (data[code + 3] === VC1_SEQUENCE) return PICTURE_I;
    }
    if (at + 1 >= data.length) return undefined;
    let bit = at * 8;
    const read = (): number => (data[bit >> 3]! >> (7 - (bit++ & 7))) & 1;

    // FCM: 0 progressive, 10 frame interlace, 11 field interlace, whose FPTYPE names both fields
    // (4-7 are B or BI).
    if (interlace && read() && read()) {
        const fptype = read() * 4 + read() * 2 + read();
        return fptype >= 4 ? PICTURE_B : fptype === 0 ? PICTURE_I : PICTURE_P;
    }

    // PTYPE: 0 P, 10 B, 110 I, 1110 BI, 1111 skipped.
    if (!read()) return PICTURE_P;
    if (!read()) return PICTURE_B;
    if (!read()) return PICTURE_I;
    return read() ? PICTURE_P : PICTURE_B;
}

/**
 * Picture type of a WMV9 (VC-1 simple/main) or VC-1 advanced profile frame for reordering:
 * PICTURE_I, PICTURE_P or PICTURE_B, which no picture references; undefined for codecs without
 * B-pictures and unreadable headers.
 */
export function windowsMediaPictureType(
    codec: string,
    frame: Uint8Array,
    config: Uint8Array | undefined,
): number | undefined {
    if (codec === 'vc1') {
        const at = config ? findStartCode(config, 0) : -1;
        const sequence =
            at >= 0 && config![at + 3] === VC1_SEQUENCE
                ? parseVc1SequenceHeader(config!.subarray(at + 4))
                : undefined;
        return vc1PictureType(frame, sequence?.interlace ?? false);
    }
    if (codec !== 'wmv3' || !config || config.length < 4 || frame.length < 2) return undefined;
    const sequence = u32be(config, 0);
    const at = ((sequence >>> 1) & 1) + 2 + ((sequence >>> 7) & 1);
    const header = (frame[0]! << 8) | frame[1]!;
    // PTYPE after INTERPFRM, FRMCNT and RANGEREDFRM: 1 P; with B-frames enabled 01 I and 00 B (or
    // BI), else 0 I.
    if ((header >> (15 - at)) & 1) return PICTURE_P;
    if (((sequence >>> 4) & 7) === 0) return PICTURE_I;
    return (header >> (14 - at)) & 1 ? PICTURE_I : PICTURE_B;
}
