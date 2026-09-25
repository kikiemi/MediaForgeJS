const compactRequests = new WeakSet();
const compactTracks = new WeakMap();
export function enableCompactMP4Index(target) {
    compactRequests.add(target);
    return target;
}
export function usesCompactMP4Index(target) {
    return compactRequests.has(target);
}
export function getCompactSampleIndex(track) {
    return compactTracks.get(track);
}
export function bindCompactSampleIndex(track, index, reserve) {
    compactTracks.set(track, index);
    Object.defineProperty(track, 'samples', {
        enumerable: true,
        configurable: true,
        get() {
            reserve?.();
            const samples = Array.from({ length: index.length }, (_, position) => index.get(position));
            Object.defineProperty(track, 'samples', {
                value: samples,
                enumerable: true,
                configurable: true,
                writable: true,
            });
            compactTracks.delete(track);
            return samples;
        },
        set(samples) {
            Object.defineProperty(track, 'samples', {
                value: samples,
                enumerable: true,
                configurable: true,
                writable: true,
            });
            compactTracks.delete(track);
        },
    });
}
export function sampleCount(track) {
    return getCompactSampleIndex(track)?.length ?? track.samples.length;
}
export function sampleAt(track, position) {
    const index = getCompactSampleIndex(track);
    return index
        ? Number.isInteger(position) && position >= 0 && position < index.length
            ? index.get(position)
            : undefined
        : track.samples[position];
}
