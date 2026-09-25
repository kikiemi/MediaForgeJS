const builtins = new WeakSet();
export function builtinDemuxer(demuxer) {
    const registered = Object.freeze({
        formats: Object.freeze([...demuxer.formats]),
        demux: demuxer.demux.bind(demuxer),
    });
    builtins.add(registered);
    return registered;
}
export function isBuiltinDemuxer(demuxer) {
    return builtins.has(demuxer);
}
