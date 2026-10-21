/**
 * Dolby Vision configuration (dvcC/dvvC payload, 24 bytes) carried next to an HEVC decoder
 * configuration.
 */
interface DolbyVisionConfig {
    readonly profile: number;
    readonly level: number;
    readonly rpuPresent: boolean;
    readonly elPresent: boolean;
    readonly blPresent: boolean;
    readonly compatibilityId: number;
}

export const DOLBY_VISION_CONFIG_BYTES = 24;

export function parseDolbyVisionConfig(
    bytes: Uint8Array | undefined,
): DolbyVisionConfig | undefined {
    if (!bytes || bytes.length < DOLBY_VISION_CONFIG_BYTES) return undefined;
    const profile = bytes[2]! >> 1;
    const level = ((bytes[2]! & 1) << 5) | (bytes[3]! >> 3);
    return {
        profile,
        level,
        rpuPresent: (bytes[3]! & 4) !== 0,
        elPresent: (bytes[3]! & 2) !== 0,
        blPresent: (bytes[3]! & 1) !== 0,
        compatibilityId: bytes[4]! >> 4,
    };
}

/** dvcC describes profiles up to 7; dvvC the later ones. */
export function dolbyVisionBoxType(config: DolbyVisionConfig): 'dvcC' | 'dvvC' {
    return config.profile > 7 ? 'dvvC' : 'dvcC';
}

/**
 * Sample entry type for HEVC with this configuration: profile 5 (and other base layers without
 * cross-compatibility) uses dvh1/dvhe; cross-compatible profiles keep hvc1/hev1 and add the
 * configuration box.
 */
export function dolbyVisionSampleEntry(
    config: DolbyVisionConfig,
    hevcEntry: 'hvc1' | 'hev1',
): string {
    if (config.compatibilityId === 0 && config.blPresent)
        return hevcEntry === 'hvc1' ? 'dvh1' : 'dvhe';
    return hevcEntry;
}

export function dolbyVisionCodecString(entry: string, config: DolbyVisionConfig): string {
    const twoDigits = (value: number): string => String(value).padStart(2, '0');
    return `${entry}.${twoDigits(config.profile)}.${twoDigits(config.level)}`;
}
