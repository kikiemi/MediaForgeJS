import { DiagnosticContext } from '../core/diagnostics.js';
import { MediaForgeError } from '../core/errors.js';
import { makeWebVttCodecConfig, subtitleLimit, validateSubtitleCue } from './subtitles.js';
import { escapeSubtitleMarkup } from './interchange-utils.js';
const encoder = new TextEncoder();
function textByteLength(value, maximum, markup = false) {
    if (value.length > maximum)
        throw new MediaForgeError('Subtitle sample bytes exceed maxBytes', 'INPUT');
    let length = 0;
    for (const character of value) {
        const point = character.codePointAt(0);
        length +=
            markup && point === 38
                ? 5
                : markup && (point === 60 || point === 62)
                    ? 4
                    : point < 128
                        ? 1
                        : point < 2048
                            ? 2
                            : point < 65536
                                ? 3
                                : 4;
        if (length > maximum)
            throw new MediaForgeError('Subtitle sample bytes exceed maxBytes', 'INPUT');
    }
    return length;
}
function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    if (length > 16 * 1024 * 1024)
        throw new MediaForgeError('WebVTT sample exceeds 16 MiB', 'INPUT');
    const data = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        data.set(part, offset);
        offset += part.length;
    }
    return data;
}
function box(type, data) {
    const result = new Uint8Array(data.length + 8);
    new DataView(result.buffer).setUint32(0, result.length);
    result.set(encoder.encode(type), 4);
    result.set(data, 8);
    return result;
}
function boxes(data, maximum) {
    const result = [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 0; offset < data.length;) {
        if (result.length >= maximum || data.length - offset < 8)
            throw new MediaForgeError('Malformed or excessive WebVTT sample boxes', 'DEMUX');
        let size = view.getUint32(offset);
        let header = 8;
        if (size === 1) {
            if (data.length - offset < 16)
                throw new MediaForgeError('Truncated WebVTT extended box header', 'DEMUX');
            size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
            header = 16;
        }
        else if (size === 0)
            size = data.length - offset;
        if (!Number.isSafeInteger(size) || size < header || size > data.length - offset) {
            throw new MediaForgeError('Invalid WebVTT sample box size', 'DEMUX');
        }
        const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
        result.push({
            type,
            data: data.subarray(offset + header, offset + size),
            raw: data.subarray(offset, offset + size),
        });
        offset += size;
    }
    return result;
}
function copyUnknown(parts, reserved) {
    if ((parts?.length ?? 0) > 100000)
        throw new MediaForgeError('Excessive WebVTT opaque box count', 'INPUT');
    let total = 0;
    return (parts ?? []).map(part => {
        total += part.length;
        if (total > 16 * 1024 * 1024)
            throw new MediaForgeError('WebVTT opaque boxes exceed 16 MiB', 'INPUT');
        const parsed = boxes(part, 1);
        if (parsed.length !== 1 || reserved.includes(parsed[0].type)) {
            throw new MediaForgeError('Unknown WebVTT boxes must contain one non-reserved box', 'INPUT');
        }
        const item = parsed[0];
        return box(item.type, item.data);
    });
}
export function encodeWebVttSample(cues, unknownBoxes) {
    if (cues.length > 100000)
        throw new MediaForgeError('Excessive WebVTT cue count', 'INPUT');
    let total = 0;
    const parts = cues.map(cue => {
        validateSubtitleCue({ ...cue, startTime: 0, endTime: 1 });
        if (cue.text.length + (cue.id?.length ?? 0) + (cue.settings?.length ?? 0) > 16 * 1024 * 1024) {
            throw new MediaForgeError('WebVTT cue exceeds 16 MiB', 'INPUT');
        }
        const children = [];
        if (cue.id !== undefined)
            children.push(box('iden', encoder.encode(cue.id)));
        if (cue.settings !== undefined)
            children.push(box('sttg', encoder.encode(cue.settings)));
        children.push(box('payl', encoder.encode(cue.text)));
        for (const opaque of copyUnknown(cue.unknownBoxes, []))
            children.push(opaque);
        const data = concat(children);
        total += data.length + 8;
        if (total > 16 * 1024 * 1024)
            throw new MediaForgeError('WebVTT sample exceeds 16 MiB', 'INPUT');
        return box('vttc', data);
    });
    if (!cues.length)
        parts.push(box('vtte', new Uint8Array()));
    for (const opaque of copyUnknown(unknownBoxes, ['vttc', 'vtte']))
        parts.push(opaque);
    return concat(parts);
}
export function decodeWebVttSample(data, options = {}) {
    const context = new DiagnosticContext(options, 'compatible');
    if (data.length > subtitleLimit(options.maxBytes, 16 * 1024 * 1024, 'maxBytes')) {
        throw new MediaForgeError('WebVTT sample exceeds maxBytes', 'INPUT');
    }
    const maximum = subtitleLimit(options.maxBlocks, 200000, 'maxBlocks');
    const maxCues = subtitleLimit(options.maxCues, 100000, 'maxCues');
    const result = { cues: [], empty: false, unknownBoxes: [], diagnostics: [] };
    const decode = (bytes) => {
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        catch {
            context.recover({
                code: 'VTT_SAMPLE_ENCODING',
                message: 'Invalid UTF-8 was replaced in a WebVTT sample',
                format: 'wvtt',
            });
            return new TextDecoder().decode(bytes);
        }
    };
    let boxCount = 0;
    for (const item of boxes(data, maximum)) {
        if (++boxCount > maximum)
            throw new MediaForgeError('WebVTT sample exceeds maxBlocks', 'INPUT');
        if (item.type === 'vtte') {
            if (item.data.length)
                context.recover({
                    code: 'VTT_EMPTY_PAYLOAD',
                    message: 'Empty cue box contains unexpected bytes',
                    format: 'wvtt',
                });
            result.empty = true;
        }
        else if (item.type === 'vttc') {
            if (result.cues.length >= maxCues)
                throw new MediaForgeError('WebVTT sample exceeds maxCues', 'INPUT');
            const cue = { text: '' };
            const seen = new Set();
            const opaque = [];
            for (const child of boxes(item.data, maximum - boxCount)) {
                boxCount++;
                if (['payl', 'iden', 'sttg'].includes(child.type) && !seen.has(child.type)) {
                    const value = decode(child.data);
                    if (child.type === 'payl')
                        cue.text = value;
                    else if (child.type === 'iden')
                        cue.id = value;
                    else
                        cue.settings = value;
                    seen.add(child.type);
                }
                else {
                    if (seen.has(child.type))
                        context.recover({
                            code: 'VTT_DUPLICATE_BOX',
                            message: `Duplicate ${child.type} retained as opaque bytes`,
                            format: 'wvtt',
                        });
                    opaque.push(new Uint8Array(child.raw));
                }
            }
            if (!seen.has('payl'))
                context.recover({ code: 'VTT_MISSING_PAYLOAD', message: 'Cue has no payload box', format: 'wvtt' });
            if (opaque.length)
                cue.unknownBoxes = opaque;
            result.cues.push(cue);
        }
        else
            result.unknownBoxes.push(new Uint8Array(item.raw));
    }
    if (result.empty && result.cues.length)
        context.recover({
            code: 'VTT_MIXED_EMPTY',
            message: 'WebVTT sample combines empty and nonempty cues',
            format: 'wvtt',
        });
    result.diagnostics = context.warnings;
    return result;
}
export function encodeWebVttBlock(cue) {
    validateSubtitleCue({ ...cue, startTime: 0, endTime: 1 });
    if (cue.text.length + (cue.id?.length ?? 0) + (cue.settings?.length ?? 0) + 2 > 16 * 1024 * 1024) {
        throw new MediaForgeError('WebVTT block exceeds 16 MiB', 'INPUT');
    }
    const bytes = encoder.encode(`${cue.id ?? ''}\n${cue.settings ?? ''}\n${cue.text}`);
    if (bytes.length > 16 * 1024 * 1024)
        throw new MediaForgeError('WebVTT block exceeds 16 MiB', 'INPUT');
    return bytes;
}
export function decodeWebVttBlock(data) {
    if (data.length > 16 * 1024 * 1024)
        throw new MediaForgeError('WebVTT block exceeds 16 MiB', 'INPUT');
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n?/g, '\n');
    }
    catch {
        throw new MediaForgeError('Invalid UTF-8 WebM WebVTT block', 'DEMUX');
    }
    const first = text.indexOf('\n');
    const second = text.indexOf('\n', first + 1);
    if (first < 0 || second < 0)
        throw new MediaForgeError('WebM WebVTT block is missing its identifier/settings lines', 'DEMUX');
    return { id: text.slice(0, first), settings: text.slice(first + 1, second), text: text.slice(second + 1) };
}
export function subtitleTrackConfig(document, options = { codec: 'wvtt' }) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('Expected subtitle track options', 'INPUT');
    const { codec, language, label, kind, default: isDefault } = options;
    if (!['wvtt', 'text/webvtt', 'text/utf8'].includes(codec) ||
        (language !== undefined && typeof language !== 'string') ||
        (label !== undefined && typeof label !== 'string') ||
        (kind !== undefined && !['subtitles', 'captions', 'descriptions', 'chapters', 'metadata'].includes(kind)) ||
        (isDefault !== undefined && typeof isDefault !== 'boolean')) {
        throw new MediaForgeError('Invalid subtitle track options', 'INPUT');
    }
    return {
        codec,
        ...(language !== undefined ? { language } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(isDefault !== undefined ? { default: isDefault } : {}),
        ...(codec !== 'text/utf8' ? { codecConfig: makeWebVttCodecConfig(document) } : {}),
    };
}
export function toSubtitleChunks(document, codec = 'wvtt', options = {}) {
    if (!['wvtt', 'text/webvtt', 'text/utf8'].includes(codec))
        throw new MediaForgeError('Unsupported subtitle codec', 'INPUT');
    if (!options || typeof options !== 'object' || Array.isArray(options))
        throw new MediaForgeError('Expected subtitle sample options', 'INPUT');
    const cues = Array.isArray(document) ? document : document.cues;
    const maximum = subtitleLimit(options.maxSamples, 200000, 'maxSamples');
    const maxBytes = subtitleLimit(options.maxBytes, 64 * 1024 * 1024, 'maxBytes');
    let totalBytes = 0;
    const bounded = (bytes) => {
        totalBytes += bytes.length;
        if (totalBytes > maxBytes)
            throw new MediaForgeError('Subtitle sample bytes exceed maxBytes', 'INPUT');
        return bytes;
    };
    if (cues.length > maximum)
        throw new MediaForgeError('Subtitle cues exceed maxSamples', 'INPUT');
    for (const cue of cues)
        validateSubtitleCue(cue);
    const start = options.startTime ?? 0;
    const end = options.endTime ?? cues.reduce((value, cue) => Math.max(value, cue.endTime), start);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end < start) {
        throw new MediaForgeError('Invalid subtitle sample interval', 'INPUT');
    }
    if (start === end)
        return [];
    const escapeMarkup = codec !== 'text/utf8' &&
        !Array.isArray(document) &&
        !['webvtt', 'srt'].includes(document.format);
    const escapedCue = (cue, maximum) => {
        let bytes = codec === 'wvtt' ? 16 + (cue.id !== undefined ? 8 : 0) + (cue.settings !== undefined ? 8 : 0) : 2;
        if (bytes > maximum)
            throw new MediaForgeError('Subtitle sample bytes exceed maxBytes', 'INPUT');
        bytes += textByteLength(cue.id ?? '', maximum - bytes);
        bytes += textByteLength(cue.settings ?? '', maximum - bytes);
        bytes += textByteLength(cue.text, maximum - bytes, true);
        return { cue: { ...cue, text: escapeSubtitleMarkup(cue.text) }, bytes };
    };
    if (codec !== 'wvtt')
        return cues
            .filter(cue => cue.endTime > start && cue.startTime < end)
            .map(cue => ({
            data: bounded(codec === 'text/webvtt'
                ? encodeWebVttBlock(escapeMarkup
                    ? escapedCue(cue, Math.min(maxBytes - totalBytes, 16 * 1024 * 1024)).cue
                    : cue)
                : encoder.encode(cue.text)),
            timestamp: Math.max(start, cue.startTime),
            duration: Math.min(end, cue.endTime) - Math.max(start, cue.startTime),
            isKeyframe: true,
            trackType: 'subtitle',
        }));
    const events = [];
    for (let index = 0; index < cues.length; index++) {
        const cue = cues[index];
        if (cue.endTime <= start || cue.startTime >= end)
            continue;
        events.push({ time: Math.max(start, cue.startTime), index, start: true });
        events.push({ time: Math.min(end, cue.endTime), index, start: false });
    }
    events.sort((a, b) => a.time - b.time || Number(a.start) - Number(b.start) || a.index - b.index);
    const active = new Set();
    const chunks = [];
    let time = start;
    const emit = (until) => {
        if (until <= time)
            return;
        if (chunks.length >= maximum)
            throw new MediaForgeError('Subtitle samples exceed maxSamples', 'INPUT');
        let remaining = Math.min(maxBytes - totalBytes, 16 * 1024 * 1024);
        const sampleCues = [...active]
            .sort((a, b) => a - b)
            .map(index => {
            const cue = cues[index];
            if (!escapeMarkup)
                return cue;
            const escaped = escapedCue(cue, remaining);
            remaining -= escaped.bytes;
            return escaped.cue;
        });
        chunks.push({
            data: bounded(encodeWebVttSample(sampleCues)),
            timestamp: time,
            duration: until - time,
            isKeyframe: true,
            trackType: 'subtitle',
        });
        time = until;
    };
    for (const event of events) {
        emit(event.time);
        if (event.start)
            active.add(event.index);
        else
            active.delete(event.index);
    }
    emit(end);
    return chunks;
}
