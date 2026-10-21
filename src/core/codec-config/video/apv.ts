/**
 * APV (Advanced Professional Video, draft-lim-apv) in MP4: the 'apvC' decoder configuration record
 * (APVDecoderConfigurationRecord of the OpenAPV ISOBMFF binding, without its full box header) and
 * the codec string it gives.
 */

/** What the frame header of an APV frame states. */
export interface ApvFrameInfo {
    readonly profile: number;
    readonly level: number;
    readonly band: number;
    readonly width: number;
    readonly height: number;
    /** 0 4:0:0, 2 4:2:2, 3 4:4:4, 4 4:4:4:4. */
    readonly chromaFormat: number;
    readonly bitDepth: number;
}

/**
 * The frame info of an 'apvC' record, or undefined when it has none: the first entry's chroma
 * format and bit depth, with the largest profile, level, band and size of all entries, which the
 * codec string and the sample entry state.
 */
export function apvConfigInfo(record: Uint8Array | undefined): ApvFrameInfo | undefined {
    if (!record || record[0] !== 1) return undefined;
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    let info: ApvFrameInfo | undefined;
    let at = 2;
    for (let entry = 0; entry < record[1]! && at + 2 <= record.length; entry++) {
        const count = record[at + 1]!;
        at += 2;
        for (let frame = 0; frame < count && at + 14 <= record.length; frame++) {
            info = {
                profile: Math.max(info?.profile ?? 0, record[at + 1]!),
                level: Math.max(info?.level ?? 0, record[at + 2]!),
                band: Math.max(info?.band ?? 0, record[at + 3]!),
                width: Math.max(info?.width ?? 0, view.getUint32(at + 4)),
                height: Math.max(info?.height ?? 0, view.getUint32(at + 8)),
                chromaFormat: info?.chromaFormat ?? record[at + 12]! >> 4,
                bitDepth: info?.bitDepth ?? (record[at + 12]! & 15) + 8,
            };
            // The colour description follows when color_description_present_flag is set.
            at += record[at]! & 2 ? 18 : 14;
        }
    }
    return info;
}

/** apv1.apvf<profile>.apvl<level>.apvb<band> (the binding's codecs parameter), or 'apv1'. */
export function apvCodecString(info: ApvFrameInfo | undefined): string {
    return info ? `apv1.apvf${info.profile}.apvl${info.level}.apvb${info.band}` : 'apv1';
}
