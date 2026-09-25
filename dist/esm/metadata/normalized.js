import { DiagnosticContext } from '../core/diagnostics.js';
import { MediaForgeError } from '../core/errors.js';
export function metadataLimit(value, fallback, name) {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1)
        throw new MediaForgeError(`Invalid ${name}`, 'INPUT');
    return result;
}
export function normalizeMetadata(input, options = {}) {
    const context = new DiagnosticContext(options, 'compatible');
    const maximum = metadataLimit(options.maxEntries, 100000, 'maxEntries');
    const maxBytes = metadataLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes');
    const encoder = new TextEncoder();
    let bytes = 0;
    let count = 0;
    const budget = (value) => {
        if (value.length > maxBytes - bytes)
            throw new MediaForgeError('Metadata exceeds maxBytes', 'INPUT');
        bytes += typeof value === 'string' ? encoder.encode(value).length : value.length;
        if (bytes > maxBytes)
            throw new MediaForgeError('Metadata exceeds maxBytes', 'INPUT');
    };
    const language = (value) => {
        if (value === undefined)
            return undefined;
        budget(value);
        try {
            return Intl.getCanonicalLocales(value)[0] ?? value;
        }
        catch {
            context.recover({
                code: 'METADATA_LANGUAGE',
                message: `Unrecognized language tag '${value}' was retained`,
                format: 'metadata',
            });
            return value;
        }
    };
    const entry = (item) => {
        if (++count > maximum || typeof item.key !== 'string' || !item.key) {
            throw new MediaForgeError('Invalid or excessive metadata entries', 'INPUT');
        }
        budget(item.key);
        if (item.source)
            budget(item.source);
        const value = item.value;
        switch (value.type) {
            case 'text':
            case 'date':
                if (typeof value.value !== 'string')
                    throw new MediaForgeError('Metadata text must be a string', 'INPUT');
                budget(value.value);
                break;
            case 'integer':
                if (typeof value.value !== 'bigint')
                    throw new MediaForgeError('Metadata integer must be a bigint', 'INPUT');
                break;
            case 'number':
                if (!Number.isFinite(value.value))
                    throw new MediaForgeError('Metadata number must be finite', 'INPUT');
                break;
            case 'boolean':
                if (typeof value.value !== 'boolean')
                    throw new MediaForgeError('Metadata boolean must be a boolean', 'INPUT');
                break;
            case 'binary':
                if (!(value.value instanceof Uint8Array))
                    throw new MediaForgeError('Metadata binary must be bytes', 'INPUT');
                budget(value.value);
                if (value.mimeType)
                    budget(value.mimeType);
                if (value.description)
                    budget(value.description);
                break;
            default:
                throw new MediaForgeError('Unknown metadata value type', 'INPUT');
        }
        const normalizedLanguage = language(item.language);
        return {
            key: item.key,
            value: value.type === 'binary' ? { ...value, value: new Uint8Array(value.value) } : { ...value },
            ...(normalizedLanguage !== undefined ? { language: normalizedLanguage } : {}),
            ...(item.source !== undefined ? { source: item.source } : {}),
        };
    };
    const entries = (input.entries ?? []).map(entry);
    const chapters = (input.chapters ?? []).map((chapter) => {
        if (++count > maximum ||
            !Number.isFinite(chapter.startTime) ||
            chapter.startTime < 0 ||
            (chapter.endTime !== undefined &&
                (!Number.isFinite(chapter.endTime) || chapter.endTime < chapter.startTime))) {
            throw new MediaForgeError('Invalid or excessive metadata chapters', 'INPUT');
        }
        if (chapter.id)
            budget(chapter.id);
        if (chapter.title)
            budget(chapter.title);
        const normalizedLanguage = language(chapter.language);
        return {
            ...chapter,
            ...(normalizedLanguage !== undefined ? { language: normalizedLanguage } : {}),
            ...(chapter.entries ? { entries: chapter.entries.map(entry) } : {}),
        };
    });
    const opaque = (input.opaque ?? []).map(item => {
        if (++count > maximum || typeof item.format !== 'string' || !(item.data instanceof Uint8Array)) {
            throw new MediaForgeError('Invalid or excessive opaque metadata', 'INPUT');
        }
        budget(item.format);
        budget(item.data);
        return { format: item.format, data: new Uint8Array(item.data) };
    });
    return { entries, chapters, opaque, diagnostics: context.warnings };
}
