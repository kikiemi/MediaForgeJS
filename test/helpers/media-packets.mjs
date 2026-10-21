// Packets of an opened Media by their place in decode order, which media.packets() gives.

/** Packet `index` (default the first) of track `trackId`, in decode order. */
export async function packetOf(media, trackId, index = 0) {
    let at = 0;
    for await (const packet of media.packets({ trackIds: [trackId] }))
        if (at++ === index) return packet;
    throw new Error(`Track ${trackId} has ${at} packets, not ${index + 1}`);
}

/** The packets of track `trackId` in decode order. */
export async function packetsOf(media, trackId) {
    const packets = [];
    for await (const packet of media.packets({ trackIds: [trackId] })) packets.push(packet);
    return packets;
}
