import { MediaForgeError } from '../core/errors.js';
import { validateSubtitleCue } from './subtitles.js';
export function editSubtitles(document, options = {}) {
    if (!document || typeof document !== 'object' || !Array.isArray(document.cues)) {
        throw new MediaForgeError('Expected a subtitle document', 'INPUT');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new MediaForgeError('Expected subtitle edit options', 'INPUT');
    }
    const { startTime: requestedStart, endTime: requestedEnd, offset: requestedOffset } = options;
    const start = requestedStart ?? 0;
    const offset = requestedOffset ?? 0;
    if (document.cues.length > 100000 || (document.blocks?.length ?? 0) > 200000) {
        throw new MediaForgeError('Subtitle edit exceeds cue or block limit', 'INPUT');
    }
    let extent = start;
    for (const cue of document.cues) {
        validateSubtitleCue(cue);
        extent = Math.max(extent, cue.endTime);
    }
    const end = requestedEnd ?? extent;
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end < start || !Number.isFinite(offset)) {
        throw new MediaForgeError('Invalid subtitle edit interval or offset', 'INPUT');
    }
    if (offset && (document.timestampMap || document.headers?.some(line => line.startsWith('X-TIMESTAMP-MAP=')))) {
        throw new MediaForgeError('Cannot offset a subtitle document with a timestamp map', 'INPUT');
    }
    const editing = requestedStart !== undefined || requestedEnd !== undefined || offset !== 0;
    if (editing && document.blocks?.some(block => block.type === 'unknown')) {
        throw new MediaForgeError('Cannot edit timing of an unknown raw subtitle block', 'INPUT');
    }
    const cues = [];
    const indices = new Map();
    for (let index = 0; index < document.cues.length; index++) {
        const cue = document.cues[index];
        if (start === end || cue.endTime <= start || cue.startTime >= end)
            continue;
        const clippedStart = Math.max(start, cue.startTime);
        const clippedEnd = Math.min(end, cue.endTime);
        const startTime = clippedStart + offset;
        const endTime = clippedEnd + offset;
        const edited = { ...cue, startTime, endTime };
        validateSubtitleCue(edited);
        if ((startTime !== cue.startTime || endTime !== cue.endTime) &&
            (document.format === 'webvtt' || document.format === 'srt') &&
            /<(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}>/.test(cue.text)) {
            throw new MediaForgeError('Cannot edit a cue containing an inline timestamp', 'INPUT');
        }
        if ((clippedStart !== cue.startTime || clippedEnd !== cue.endTime) && cue.ass) {
            const timedOverrides = cue.ass.text === cue.text &&
                /\{[^{}]*\\(?:[kK](?:[fot])?\s*[-+\d.]|(?:t|move|fad|fade)\s*\()/.test(cue.ass.rawText);
            const effect = Object.entries(cue.ass.fields).some(([key, value]) => key.toLowerCase() === 'effect' && value.trim());
            if (timedOverrides || effect)
                throw new MediaForgeError('Cannot clip a cue containing timed ASS overrides or effects', 'INPUT');
        }
        indices.set(index, cues.length);
        cues.push(edited);
    }
    const result = { ...document, cues };
    if (document.blocks) {
        const blocks = [];
        for (const block of document.blocks) {
            if (block.type !== 'cue') {
                blocks.push(block);
                continue;
            }
            if (!Number.isInteger(block.cueIndex) || block.cueIndex < 0 || block.cueIndex >= document.cues.length) {
                throw new MediaForgeError('Subtitle block references an absent cue', 'INPUT');
            }
            const cueIndex = indices.get(block.cueIndex);
            if (cueIndex !== undefined)
                blocks.push({ type: 'cue', cueIndex });
        }
        result.blocks = blocks;
    }
    return result;
}
