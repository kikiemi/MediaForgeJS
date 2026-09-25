import { awaitWithAbort } from './abort.js';
import { MediaForgeError } from './errors.js';
export async function readMp4Udta(file, signal) {
    const checkAbort = () => {
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    };
    const readBytes = async (start, length) => {
        checkAbort();
        const buffer = await awaitWithAbort(file.slice(start, start + length).arrayBuffer(), signal);
        checkAbort();
        if (buffer.byteLength !== length)
            throw new MediaForgeError('MP4 metadata read was truncated', 'IO');
        return new Uint8Array(buffer);
    };
    checkAbort();
    if (!Number.isSafeInteger(file.size) || file.size < 8)
        return null;
    let boxesSeen = 0;
    let windowStart = -1;
    let window = new Uint8Array(0);
    const readHeader = async (start, to, prefetch) => {
        if (start < windowStart || start + 8 > windowStart + window.length) {
            windowStart = start;
            window = await readBytes(start, Math.min(prefetch ? 4096 : 8, to - start));
        }
        return window.subarray(start - windowStart, start - windowStart + 8);
    };
    const findBox = async (name, from, to) => {
        let start = from;
        let smallBoxes = 0;
        while (to - start >= 8) {
            checkAbort();
            if (++boxesSeen > 4096)
                return null;
            const header = await readHeader(start, to, smallBoxes >= 2);
            const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
            let size = view.getUint32(0);
            let headerLength = 8;
            if (size === 1) {
                if (to - start < 16)
                    return null;
                const extended = await readHeader(start + 8, to, false);
                const extendedView = new DataView(extended.buffer, extended.byteOffset, extended.byteLength);
                size = extendedView.getUint32(0) * 0x100000000 + extendedView.getUint32(4);
                headerLength = 16;
                if (!Number.isSafeInteger(size))
                    return null;
            }
            else if (size === 0) {
                size = file.size - start;
            }
            if (size < headerLength || size > to - start)
                return null;
            const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
            if (type === name)
                return { start, size, headerLength };
            smallBoxes = size <= 128 ? smallBoxes + 1 : 0;
            start += size;
        }
        return null;
    };
    const movie = await findBox('moov', 0, file.size);
    if (!movie)
        return null;
    const metadata = await findBox('udta', movie.start + movie.headerLength, movie.start + movie.size);
    if (!metadata || metadata.size > 16 * 1024 * 1024)
        return null;
    const bytes = await readBytes(metadata.start, metadata.size);
    const view = new DataView(bytes.buffer);
    if (view.getUint32(0) === 0)
        view.setUint32(0, metadata.size);
    return bytes;
}
