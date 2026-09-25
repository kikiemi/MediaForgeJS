export function isPcmOutputMuxer(muxer) {
    const candidate = muxer;
    return typeof candidate.addPCMBuffer === 'function' && typeof candidate.addPCMPlanarChunk === 'function';
}
