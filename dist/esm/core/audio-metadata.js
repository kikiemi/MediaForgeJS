import { MediaForgeError } from './errors.js';
import { awaitWithAbort } from './abort.js';
import { assertSourceBytes } from '../io/source-read.js';
const METADATA_BUDGET = 16 * 1024 * 1024;
const MAX_METADATA_BLOCKS = 4096;
function checkAbort(signal) {
    if (signal?.aborted)
        throw new MediaForgeError('Aborted', 'ABORT');
}
async function readBytes(file, offset, length, signal) {
    checkAbort(signal);
    const bytes = new Uint8Array(await awaitWithAbort(file.slice(offset, offset + length).arrayBuffer(), signal));
    checkAbort(signal);
    if (bytes.byteLength !== length)
        throw new MediaForgeError('Metadata read returned an incomplete byte range', 'IO');
    return bytes;
}
async function scanFlacMetadata(file, signal, visit) {
    checkAbort(signal);
    if (!Number.isSafeInteger(file.size) || file.size < 42)
        return null;
    const head = await readBytes(file, 0, 4, signal);
    if (head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43)
        return null;
    let offset = 4;
    let singletons = 0;
    for (let count = 0; count < MAX_METADATA_BLOCKS; count++) {
        if (offset + 4 > file.size)
            return null;
        const header = await readBytes(file, offset, 4, signal);
        const type = header[0] & 0x7f;
        const length = (header[1] << 16) | (header[2] << 8) | header[3];
        if (length > file.size - offset - 4 || type === 127 || (count === 0 ? type !== 0 || length !== 34 : type === 0))
            return null;
        if (type === 3 || type === 4) {
            if (singletons & (1 << type))
                return null;
            singletons |= 1 << type;
        }
        const block = { offset, size: length + 4, type };
        visit?.(block);
        offset += block.size;
        if (header[0] & 0x80)
            return block;
    }
    return null;
}
export async function readFlacMetaBlocks(file, signal) {
    const selected = [];
    let total = 0;
    let full = false;
    const last = await scanFlacMetadata(file, signal, block => {
        if (full || (block.type !== 4 && block.type !== 6))
            return;
        if (block.size > METADATA_BUDGET - total) {
            full = true;
            return;
        }
        total += block.size;
        selected.push(block);
    });
    if (!last)
        return [];
    const blocks = [];
    for (const block of selected) {
        const bytes = await readBytes(file, block.offset, block.size, signal);
        bytes[0] = block.type;
        blocks.push(bytes);
    }
    checkAbort(signal);
    return blocks;
}
export async function injectFlacMetaBlocks(encoded, blocks, signal) {
    checkAbort(signal);
    let copies;
    let singletons = 0;
    try {
        const count = Array.isArray(blocks) ? blocks.length : -1;
        if (!Number.isInteger(count) || count < 0 || count >= MAX_METADATA_BLOCKS) {
            throw new MediaForgeError('FLAC metadata requires a bounded array of blocks', 'IO');
        }
        copies = [];
        let total = 0;
        for (let index = 0; index < count; index++) {
            const bytes = blocks[index];
            const size = bytes.byteLength;
            assertSourceBytes(bytes, size, 'FLAC metadata');
            if (size < 4 || size > METADATA_BUDGET - total) {
                throw new MediaForgeError('Invalid or excessive FLAC metadata block', 'IO');
            }
            const copy = new Uint8Array(bytes);
            const length = (copy[1] << 16) | (copy[2] << 8) | copy[3];
            const type = copy[0] & 0x7f;
            if (length !== copy.length - 4 || type === 0 || type === 127) {
                throw new MediaForgeError('Invalid or excessive FLAC metadata block', 'IO');
            }
            if (type === 3 || type === 4) {
                if (singletons & (1 << type))
                    throw new MediaForgeError('Duplicate singleton FLAC metadata', 'IO');
                singletons |= 1 << type;
            }
            total += copy.length;
            copy[0] = type | (index === count - 1 ? 0x80 : 0);
            copies.push(copy);
        }
    }
    catch (error) {
        if (error instanceof MediaForgeError)
            throw error;
        throw new MediaForgeError('FLAC metadata blocks could not be read', 'IO');
    }
    if (copies.length === 0)
        return encoded;
    const existing = [];
    const last = await scanFlacMetadata(encoded, signal, block => existing.push(block));
    if (!last)
        return encoded;
    const replacements = existing.filter(block => (block.type === 3 || block.type === 4) && singletons & (1 << block.type));
    if (existing.length - replacements.length + copies.length > MAX_METADATA_BLOCKS) {
        throw new MediaForgeError('FLAC metadata exceeds the total block limit', 'IO');
    }
    checkAbort(signal);
    const end = last.offset + last.size;
    const parts = [];
    let offset = 0;
    for (const block of replacements) {
        if (offset < block.offset)
            parts.push(encoded.slice(offset, block.offset));
        offset = block.offset + block.size;
    }
    if (offset <= last.offset) {
        if (offset < last.offset)
            parts.push(encoded.slice(offset, last.offset));
        parts.push(new Uint8Array([last.type]), encoded.slice(last.offset + 1, end));
    }
    parts.push(...copies, encoded.slice(end));
    return new Blob(parts, { type: 'audio/flac' });
}
export async function readId3v2Prefix(file, signal) {
    checkAbort(signal);
    if (!Number.isSafeInteger(file.size) || file.size < 10)
        return null;
    const head = await readBytes(file, 0, 10, signal);
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33)
        return null;
    const version = head[3];
    if (version < 2 || version > 4 || head[4] === 0xff)
        return null;
    const reserved = version === 2 ? 0x3f : version === 3 ? 0x1f : 0x0f;
    if ((head[5] & reserved) !== 0 || ((head[6] | head[7] | head[8] | head[9]) & 0x80) !== 0)
        return null;
    const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    const footer = version === 4 && (head[5] & 0x10) !== 0 ? 10 : 0;
    const total = 10 + size + footer;
    if (total > file.size || total > METADATA_BUDGET)
        return null;
    const bytes = await readBytes(file, 0, total, signal);
    if (footer) {
        const at = total - 10;
        if (bytes[at] !== 0x33 || bytes[at + 1] !== 0x44 || bytes[at + 2] !== 0x49)
            return null;
        for (let index = 3; index < 10; index++)
            if (bytes[at + index] !== head[index])
                return null;
    }
    return bytes;
}
