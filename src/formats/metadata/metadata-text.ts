/** Largest text metadata payload read. */
export const MAX_TEXT_METADATA_BYTES = 1024 * 1024;
const utf8 = new TextDecoder('utf-8');

/** Decodes text metadata, dropping NUL padding; invalid UTF-8 is replaced rather than rejected. */
export function decodeMetadataText(bytes: Uint8Array): string | undefined {
    const text = utf8.decode(bytes).replace(/\0+$/, '').trim();
    return text.length ? text : undefined;
}
