import { MediaForgeError } from '../core/errors.js';
const groupFields = {
    AUDIO: 'audio',
    VIDEO: 'video',
    SUBTITLES: 'subtitles',
    'CLOSED-CAPTIONS': 'closedCaptions',
};
const languageRange = /^(?:\*|[a-z]{1,8}(?:-[a-z0-9]{1,8})*)$/i;
function invalid(message) {
    throw new MediaForgeError(`HLS rendition: ${message}`, 'INPUT');
}
function checkType(type) {
    if (typeof type !== 'string' || !Object.hasOwn(groupFields, type))
        invalid('invalid type');
}
function copyRendition(rendition) {
    return { ...rendition, ...(rendition.attributes ? { attributes: { ...rendition.attributes } } : {}) };
}
function candidates(master, variant, type) {
    checkType(type);
    if (!master ||
        master.type !== 'master' ||
        !Array.isArray(master.renditions) ||
        !variant ||
        typeof variant !== 'object')
        invalid('expected a master playlist and variant');
    if (master.renditions.length > 100000)
        invalid('too many renditions');
    const group = variant[groupFields[type]];
    if (group === undefined || (type === 'CLOSED-CAPTIONS' && group === 'NONE'))
        return [];
    if (typeof group !== 'string' || !group.length)
        invalid('invalid group reference');
    const result = [];
    for (const rendition of master.renditions) {
        if (!rendition || typeof rendition !== 'object')
            invalid('invalid rendition');
        if (rendition.type !== type || rendition.groupId !== group)
            continue;
        if (typeof rendition.name !== 'string' || !rendition.name.length)
            invalid('invalid rendition name');
        for (const value of [rendition.default, rendition.autoselect, rendition.forced]) {
            if (value !== undefined && typeof value !== 'boolean')
                invalid('invalid rendition flag');
        }
        if (rendition.language !== undefined && typeof rendition.language !== 'string')
            invalid('invalid language');
        result.push(rendition);
    }
    return result;
}
export function getHlsRenditions(master, variant, type) {
    return candidates(master, variant, type).map(copyRendition);
}
function preferred(renditions) {
    return renditions.find(rendition => rendition.default) ?? renditions[0];
}
export function selectHlsRendition(master, variant, options) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        invalid('expected selection options');
    const { type, name, forced, channels } = options;
    const requested = options.languages;
    if (name !== undefined && (typeof name !== 'string' || !name.length))
        invalid('invalid name');
    if (channels !== undefined && (typeof channels !== 'string' || !channels.length))
        invalid('invalid channels');
    if (forced !== undefined && typeof forced !== 'boolean')
        invalid('invalid forced flag');
    if (requested !== undefined && (!Array.isArray(requested) || requested.length > 64))
        invalid('invalid language preferences');
    const languages = Array.from(requested ?? [], value => {
        if (typeof value !== 'string' || value.length > 128 || !languageRange.test(value))
            invalid('invalid language range');
        return value.toLowerCase();
    });
    const available = candidates(master, variant, type).filter(rendition => (forced === undefined || (rendition.forced ?? false) === forced) &&
        (channels === undefined || rendition.channels === channels));
    if (name !== undefined) {
        const selected = available.find(rendition => rendition.name === name);
        return selected && copyRendition(selected);
    }
    const automatic = available.filter(rendition => rendition.default || rendition.autoselect);
    const tagged = automatic.map(rendition => ({ rendition, language: rendition.language?.toLowerCase() }));
    for (const language of languages) {
        if (language === '*')
            continue;
        let range = language;
        while (range) {
            let exact;
            let partial;
            const prefix = `${range}-`;
            for (const item of tagged) {
                if (item.language === range) {
                    if (!exact || (!exact.default && item.rendition.default))
                        exact = item.rendition;
                }
                else if (item.language?.startsWith(prefix)) {
                    if (!partial || (!partial.default && item.rendition.default))
                        partial = item.rendition;
                }
            }
            const match = exact ?? partial;
            if (match)
                return copyRendition(match);
            const parts = range.split('-');
            parts.pop();
            if (parts.at(-1)?.length === 1)
                parts.pop();
            range = parts.join('-');
        }
    }
    const selected = preferred(automatic);
    return selected && copyRendition(selected);
}
