/** VP8 frame tag: bit 0 clear marks a key frame. */
export function isVp8Keyframe(head: Uint8Array): boolean {
    return head.length >= 1 && (head[0]! & 1) === 0;
}

/** VP9 uncompressed header: frame marker, profile, show_existing_frame and frame_type. */
export function isVp9Keyframe(head: Uint8Array): boolean {
    if (head.length < 1) return false;
    const first = head[0]!;
    if (first >> 6 !== 2) return false;
    const profile = ((first >> 5) & 1) | (((first >> 4) & 1) << 1);
    let bit = 4 + (profile === 3 ? 1 : 0);
    const flag = (): number => {
        const value = (head[bit >> 3]! >> (7 - (bit & 7))) & 1;
        bit++;
        return value;
    };
    if (head.length * 8 < bit + 2) return false;
    if (flag()) return false;
    return flag() === 0;
}
