import type { Mp4EditListEntry, Mp4EditSplice, Sample } from '../../../core/model/track';
import { decodeTime } from '../../../core/model/media-time';

/** The media edits of an edit list, after its optional leading empty edit. */
function mediaEdits(entries: readonly Mp4EditListEntry[]): readonly Mp4EditListEntry[] {
    return entries[0]?.mediaTime === -1 ? entries.slice(1) : entries;
}

/** Exclusive end of a media edit in whole media units: the first unit at or after where it ends. */
function mediaEnd(entry: Mp4EditListEntry, mediaTimescale: number, movieTimescale: number): number {
    const movie = BigInt(movieTimescale);
    const scaled =
        BigInt(entry.mediaTime) * movie + BigInt(entry.segmentDuration) * BigInt(mediaTimescale);
    return Number((scaled + movie - 1n) / movie);
}

/** Movie units rounded to the nearest media unit. */
function mediaUnits(movieUnits: number, mediaTimescale: number, movieTimescale: number): number {
    const movie = BigInt(movieTimescale);
    return Number((2n * BigInt(movieUnits) * BigInt(mediaTimescale) + movie) / (2n * movie));
}

/**
 * True for an edit list that presents several media ranges one after another in media order, each
 * starting after the previous one ends: the media between them is skipped, never replayed. A
 * leading empty edit may delay it.
 */
export function isSplicedEditList(
    entries: readonly Mp4EditListEntry[],
    mediaTimescale: number,
    movieTimescale: number,
): boolean {
    const edits = mediaEdits(entries);
    if (edits.length < 2 || edits.some(edit => edit.mediaTime < 0 || edit.segmentDuration <= 0))
        return false;
    for (let index = 1; index < edits.length; index++)
        if (edits[index]!.mediaTime < mediaEnd(edits[index - 1]!, mediaTimescale, movieTimescale))
            return false;
    return true;
}

/**
 * Where a sample lies against the edits: presented by edit `edit`, or between `edit - 1` and `edit`
 * (a gap).
 */
interface Placement {
    readonly edit: number;
    readonly presented: boolean;
}

/**
 * Lays the samples of a spliced edit list on its presentation. `samples` are in decode order and
 * timed with the first edit's shift (`shift` seconds after media time). Samples each edit presents
 * keep their time in the movie; the ones between two edits that decoding still needs (references of
 * the pictures before the splice, and the keyframe and pictures the next edit decodes from) are
 * marked `decodeOnly` and placed one media unit apart just before the next edit, in media order;
 * the ones nothing needs are left out. Decode times follow the media's, lowered where needed to
 * stay increasing and at or before each sample's presentation. Returns undefined when the samples
 * between two edits do not fit before it in whole media units, or no keyframe starts an edit.
 */
export function spliceEditSamples(
    samples: readonly Sample[],
    entries: readonly Mp4EditListEntry[],
    mediaTimescale: number,
    movieTimescale: number,
    shift: number,
    lead: number,
): { readonly samples: Sample[]; readonly splices: Mp4EditSplice[] } | undefined {
    const edits = mediaEdits(entries);
    const count = edits.length;
    const ends = edits.map(edit => mediaEnd(edit, mediaTimescale, movieTimescale));

    // Presentation start of each edit in media units from the first, and of the end of the last.
    const starts: number[] = [0];
    let movieUnits = 0;
    for (const edit of edits) {
        movieUnits += edit.segmentDuration;
        starts.push(mediaUnits(movieUnits, mediaTimescale, movieTimescale));
    }
    const pts = samples.map(sample => Math.round((sample.timestamp - shift) * mediaTimescale));
    const dts = samples.map(sample => Math.round((decodeTime(sample) - shift) * mediaTimescale));
    const placements: Placement[] = pts.map(time => {
        let edit = 0;
        while (edit < count && time >= ends[edit]!) edit++;
        return { edit, presented: edit < count && time >= edits[edit]!.mediaTime };
    });
    const presentation = (index: number, edit: number): number =>
        pts[index]! - edits[edit]!.mediaTime + starts[edit]!;

    // Decode positions of the last picture each edit presents and of the first, and the keyframe
    // each edit after the first decodes from.
    const last = new Array<number>(count).fill(-1);
    const first = new Array<number>(count).fill(samples.length);
    placements.forEach((placement, index) => {
        if (!placement.presented) return;
        last[placement.edit] = Math.max(last[placement.edit]!, index);
        first[placement.edit] = Math.min(first[placement.edit]!, index);
    });
    if (first.some(index => index === samples.length)) return undefined;
    const keyframes: number[] = [0];
    for (let edit = 1; edit < count; edit++) {
        let key = -1;
        for (let index = first[edit]!; index >= 0 && key < 0; index--)
            if (samples[index]!.isKeyframe && pts[index]! <= edits[edit]!.mediaTime) key = index;
        for (let index = first[edit]!; index >= 0 && key < 0; index--)
            if (samples[index]!.isKeyframe) key = index;
        if (key < 0) return undefined;
        keyframes.push(key);
    }

    // A sample between edit - 1 and edit is needed before the last picture the edits up to edit - 1
    // present (a reference) or from the keyframe edit decodes from.
    const lastBefore = [-1];
    for (const index of last) lastBefore.push(Math.max(lastBefore[lastBefore.length - 1]!, index));
    const kept = placements.map(
        (placement, index) =>
            placement.presented ||
            placement.edit === 0 ||
            placement.edit === count ||
            index < lastBefore[placement.edit]! ||
            index >= keyframes[placement.edit]!,
    );

    // The samples kept between two edits, in media order, take the media units just before the
    // later edit.
    const times = new Float64Array(samples.length);
    const durations = new Float64Array(samples.length);
    const gaps: number[][] = Array.from({ length: count + 1 }, () => []);
    const presentedEnds = new Array<number>(count).fill(Number.NEGATIVE_INFINITY);
    placements.forEach((placement, index) => {
        if (!kept[index]) return;
        const { edit } = placement;
        if (placement.presented || edit === 0 || edit === count) {
            times[index] = presentation(
                index,
                placement.presented || edit === 0 ? edit : count - 1,
            );
            durations[index] = samples[index]!.duration;
            if (placement.presented)
                presentedEnds[edit] = Math.max(presentedEnds[edit]!, times[index]!);
        } else gaps[edit]!.push(index);
    });
    const splices: Mp4EditSplice[] = [];
    for (let edit = 1; edit < count; edit++) {
        const gap = gaps[edit]!.sort((a, b) => pts[a]! - pts[b]!);
        const from = starts[edit]! - gap.length;
        if (presentedEnds[edit - 1]! >= from) return undefined;
        gap.forEach((index, position) => {
            times[index] = from + position;
            durations[index] = 1 / mediaTimescale;
        });
        splices.push({
            start: lead + from / mediaTimescale,
            shift: (edits[edit]!.mediaTime - starts[edit]! - edits[0]!.mediaTime) / mediaTimescale,
        });
    }

    // Each sample's decode time in the edit whose pictures it serves, lowered to stay increasing
    // and not after its presentation.
    const decodeEdit = (index: number): number => {
        const placement = placements[index]!;
        if (placement.presented || placement.edit === 0) return Math.min(placement.edit, count - 1);
        if (placement.edit === count) return count - 1;
        return index >= keyframes[placement.edit]! ? placement.edit : placement.edit - 1;
    };
    const decodes = new Float64Array(samples.length);
    let next = Number.POSITIVE_INFINITY;
    for (let index = samples.length - 1; index >= 0; index--) {
        if (!kept[index]) continue;
        const edit = decodeEdit(index);
        next = Math.min(
            dts[index]! - edits[edit]!.mediaTime + starts[edit]!,
            times[index]!,
            next - 1,
        );
        decodes[index] = next;
    }

    const result: Sample[] = [];
    samples.forEach((sample, index) => {
        if (!kept[index]) return;
        const placement = placements[index]!;
        result.push({
            ...sample,
            timestamp: lead + times[index]! / mediaTimescale,
            decodeTimestamp: lead + decodes[index]! / mediaTimescale,
            compositionTimeOffset: (times[index]! - decodes[index]!) / mediaTimescale,
            duration: durations[index]!,
            ...(!placement.presented && placement.edit > 0 && placement.edit < count
                ? { decodeOnly: true }
                : {}),
        });
    });
    return { samples: result, splices };
}
