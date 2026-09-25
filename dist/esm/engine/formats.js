import { MediaForgeError } from '../core/errors.js';
export function createWriters(modules) {
    const container = new Map();
    const audio = new Map();
    let segments;
    function add(target, writer) {
        if (!writer || typeof writer !== 'object')
            throw new MediaForgeError('Expected a muxer', 'INPUT');
        const { formats, create } = writer;
        if (!Array.isArray(formats) || !formats.length || typeof create !== 'function') {
            throw new MediaForgeError('Muxer requires formats and create()', 'INPUT');
        }
        const factory = Function.prototype.bind.call(create, writer);
        for (const value of formats) {
            if (typeof value !== 'string' || !value.trim())
                throw new MediaForgeError('Invalid muxer format', 'INPUT');
            const format = value.trim().toLowerCase();
            if (container.has(format) || audio.has(format)) {
                throw new MediaForgeError(`Muxer already registered for ${format}`, 'INPUT');
            }
            target.set(format, factory);
        }
    }
    for (const module of modules) {
        if (!module || typeof module !== 'object')
            throw new MediaForgeError('Expected a format module', 'INPUT');
        const { muxers = [], audioMuxers = [], createSegmentWriter } = module;
        if (!Array.isArray(muxers) || !Array.isArray(audioMuxers))
            throw new MediaForgeError('Expected muxer arrays', 'INPUT');
        for (const writer of muxers)
            add(container, writer);
        for (const writer of audioMuxers)
            add(audio, writer);
        if (createSegmentWriter !== undefined) {
            if (typeof createSegmentWriter !== 'function' || segments)
                throw new MediaForgeError('Expected one segment writer', 'INPUT');
            segments = Function.prototype.bind.call(createSegmentWriter, module);
        }
    }
    return { container, audio, segments };
}
