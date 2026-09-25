export declare function isValidAvccWalk(data: Uint8Array, lengthSize?: 1 | 2 | 3 | 4): boolean;
/** Validates length-prefixed HEVC, including type 0 slices (valid in HEVC). */
export declare function isValidHevcWalk(data: Uint8Array, lengthSize?: 1 | 2 | 3 | 4): boolean;
export declare function isAnnexB(data: Uint8Array): boolean;
export declare function splitAnnexBNals(data: Uint8Array): Uint8Array[];
export declare function annexBToAvcc(data: Uint8Array, lengthSize?: 1 | 2 | 3 | 4): Uint8Array;
export declare function buildAvcCFromAnnexB(data: Uint8Array): Uint8Array | null;
export declare function avcConfigToSamplePrefix(avcC: Uint8Array): Uint8Array | null;
export declare function prependAvcConfigToSample(avcC: Uint8Array, sample: Uint8Array): Uint8Array | null;
/** Builds a four-byte-length HEVCDecoderConfigurationRecord for a base-layer stream.
 * Returns null when parameter sets are absent, malformed, or incompatible.
 */
export declare function buildHevcCFromAnnexB(data: Uint8Array): Uint8Array | null;
