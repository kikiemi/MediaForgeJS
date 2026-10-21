// FLV files as their tags: reading the tags of a file and writing a file of tags, to change, drop
// or move tags of a real file.

/** FLV tags ({ type, timestamp, data }) after the file header, which is returned as `head`. */
export function flvTags(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = view.getUint32(5) + 4;
    const tags = [];
    for (let at = start; at + 11 <= bytes.length;) {
        const size = (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
        const timestamp =
            ((bytes[at + 7] << 24) |
                (bytes[at + 4] << 16) |
                (bytes[at + 5] << 8) |
                bytes[at + 6]) >>>
            0;
        tags.push({ type: bytes[at], timestamp, data: bytes.slice(at + 11, at + 11 + size) });
        at += 15 + size;
    }
    return { head: bytes.slice(0, start), tags };
}

/** An FLV of `tags` with consistent PreviousTagSize fields; `offsets` holds where each starts. */
export function flvFile(head, tags) {
    const parts = [head];
    const offsets = [];
    let length = head.length;
    for (const { type, timestamp, data } of tags) {
        const tag = new Uint8Array(15 + data.length);
        const view = new DataView(tag.buffer);
        tag[0] = type;
        tag[1] = data.length >> 16;
        tag[2] = (data.length >> 8) & 255;
        tag[3] = data.length & 255;
        tag[4] = (timestamp >> 16) & 255;
        tag[5] = (timestamp >> 8) & 255;
        tag[6] = timestamp & 255;
        tag[7] = timestamp >>> 24;
        tag.set(data, 11);
        view.setUint32(11 + data.length, 11 + data.length);
        offsets.push(length);
        length += tag.length;
        parts.push(tag);
    }
    return { bytes: new Uint8Array(Buffer.concat(parts)), offsets };
}
