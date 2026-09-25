import { MediaForgeError } from '../core/errors.js';
import { audioFormats } from './requests.js';
export function snapshotAudio(module) {
    if (module === undefined)
        return undefined;
    if (!module || typeof module !== 'object')
        throw new MediaForgeError('Expected a workflow audio module', 'INPUT');
    const { formats, check, encode } = module;
    if (!Array.isArray(formats) ||
        !formats.length ||
        new Set(formats).size !== formats.length ||
        formats.some(format => !audioFormats.includes(format)) ||
        typeof check !== 'function' ||
        typeof encode !== 'function')
        throw new MediaForgeError('Workflow audio requires output formats, check() and encode()', 'INPUT');
    return Object.freeze({
        formats: Object.freeze(formats.slice()),
        check: check.bind(module),
        encode: encode.bind(module),
    });
}
export function snapshotDecoder(module) {
    if (module === undefined)
        return undefined;
    if (!module || typeof module !== 'object')
        throw new MediaForgeError('Expected a workflow audio decoder', 'INPUT');
    const { codecs, createSource } = module;
    if (!Array.isArray(codecs) ||
        !codecs.length ||
        new Set(codecs).size !== codecs.length ||
        codecs.some(codec => typeof codec !== 'string' || !codec) ||
        typeof createSource !== 'function')
        throw new MediaForgeError('Workflow decoder requires codecs and createSource()', 'INPUT');
    return Object.freeze({ codecs: Object.freeze(codecs.slice()), createSource: createSource.bind(module) });
}
export function snapshotTransform(module) {
    if (module === undefined)
        return undefined;
    if (!module || typeof module !== 'object')
        throw new MediaForgeError('Expected a workflow transform', 'INPUT');
    const { probe, write } = module;
    if (typeof probe !== 'function' || typeof write !== 'function')
        throw new MediaForgeError('Workflow transform requires probe() and write()', 'INPUT');
    return Object.freeze({ probe: probe.bind(module), write: write.bind(module) });
}
