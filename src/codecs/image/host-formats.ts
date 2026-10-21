/**
 * The formats a host canvas encodes, with their MIME types. The encoders declare the same names as
 * their HostImageFormat type, which indexes this table, so the public declarations do not reach
 * this module.
 */
export const HOST_TYPES = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    avif: 'image/avif',
    heif: 'image/heif',
    jxl: 'image/jxl',
} as const;

type HostImageFormat = keyof typeof HOST_TYPES;

/** Formats only a host canvas writes: the library has no encoder of its own for them. */
export const HOST_ONLY_IMAGE_FORMATS: readonly HostImageFormat[] = [
    'jpeg',
    'webp',
    'avif',
    'heif',
    'jxl',
];

/**
 * Formats only a host decodes, with their MIME types: the library reads their headers alone. (It
 * decodes PNG, APNG, GIF, baseline TIFF and lossless WebP itself.)
 */
export const HOST_DECODED_TYPES = {
    jpeg: 'image/jpeg',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
    heif: 'image/heif',
    jxl: 'image/jxl',
} as const;

type HostDecodedFormat = keyof typeof HOST_DECODED_TYPES;

/** The formats of HOST_DECODED_TYPES. */
export const HOST_DECODED_FORMATS = Object.keys(HOST_DECODED_TYPES) as readonly HostDecodedFormat[];

/** What this host does of the image formats the library leaves to it. */
export interface HostImageFormats {
    /** Of HOST_ONLY_IMAGE_FORMATS, those its canvas encodes. */
    readonly encode: readonly string[];
    /** Of HOST_DECODED_FORMATS, those it decodes. */
    readonly decode: readonly string[];
}

let probed: Promise<HostImageFormats> | undefined;

/** A small file of a format only the host decodes, or undefined where the caller has none. */
export type ImageSample = (
    format: HostDecodedFormat,
) => Promise<Uint8Array<ArrayBuffer> | undefined>;

/**
 * The image formats this host encodes and decodes for the library, asked once. An output is
 * encoded when a 1×1 canvas converted to its type gives that type (a canvas without the encoder
 * answers with a PNG). An input is decoded when createImageBitmap decodes a small file of it, the
 * canvas's own or the one `sample` gives (the library's BMP and ICO, a few bytes of AVIF, HEIF and
 * JPEG XL), or when ImageDecoder takes its type. None without a canvas or createImageBitmap.
 */
export function probedHostImageFormats(sample: ImageSample): Promise<HostImageFormats> {
    probed ??= (async () => {
        const encoded = new Map<string, Blob>();
        if (typeof OffscreenCanvas === 'function')
            for (const format of HOST_ONLY_IMAGE_FORMATS) {
                try {
                    const canvas = new OffscreenCanvas(1, 1);
                    canvas.getContext('2d');
                    const blob = await canvas.convertToBlob({ type: HOST_TYPES[format] });
                    if (blob.type === HOST_TYPES[format]) encoded.set(format, blob);
                } catch {
                    // A host that throws for a type encodes none of it.
                }
            }
        const decoded: HostDecodedFormat[] = [];
        if (typeof createImageBitmap === 'function')
            for (const format of HOST_DECODED_FORMATS)
                if (await hostDecodes(format, encoded.get(format), sample)) decoded.push(format);
        return { encode: [...encoded.keys()], decode: decoded };
    })();
    return probed;
}

/** Whether the host decodes `format`: a file of it through createImageBitmap, or ImageDecoder. */
async function hostDecodes(
    format: HostDecodedFormat,
    own: Blob | undefined,
    sample: ImageSample,
): Promise<boolean> {
    const type = HOST_DECODED_TYPES[format];
    try {
        const bytes = own ? undefined : await sample(format);
        const file = own ?? (bytes && new Blob([bytes], { type }));
        if (file) {
            (await createImageBitmap(file)).close();
            return true;
        }
    } catch {
        // The file did not decode: ImageDecoder may still take the type.
    }
    try {
        const decoder = (
            globalThis as { ImageDecoder?: { isTypeSupported(type: string): Promise<boolean> } }
        ).ImageDecoder;
        return (await decoder?.isTypeSupported(type)) === true;
    } catch {
        return false;
    }
}
