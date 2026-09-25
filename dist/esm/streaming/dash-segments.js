import { dashAdd, dashCeil, dashCompare, dashError, dashExpand, dashFloor, dashLimit, dashNumberTime, dashSeconds, dashSubtract, dashUrl, } from './dash-common.js';
const plans = new WeakMap();
export function registerDashRepresentation(representation, plan) {
    Object.freeze(representation);
    plans.set(representation, plan);
    return representation;
}
export function iterateDashSegments(representation, options = {}) {
    const plan = plans.get(representation);
    if (!plan)
        dashError('representation must come from parseDashManifest or resolveDashManifest');
    if (!options || typeof options !== 'object' || Array.isArray(options))
        dashError('invalid segment options');
    const { start, end, maxSegments } = options;
    const lower = start === undefined ? { value: 0n, scale: 1n } : dashNumberTime(start, 'start');
    const upper = end === undefined ? undefined : dashNumberTime(end, 'end');
    if (upper && dashCompare(upper, lower) <= 0n)
        dashError('end must be greater than start');
    const limit = dashLimit(maxSegments, plan.maxSegments, 'maxSegments', 1_000_000_000);
    return generate(representation, plan, lower, upper, limit);
}
function* generate(representation, plan, lower, upper, limit) {
    const info = representation.segmentInfo;
    const scale = BigInt(info.timescale);
    const periodEnd = plan.duration ? dashAdd(plan.start, plan.duration) : undefined;
    const lowerBound = dashCompare(lower, plan.start) < 0n ? plan.start : lower;
    const upperBound = periodEnd && (!upper || dashCompare(periodEnd, upper) < 0n) ? periodEnd : upper;
    if (upperBound && dashCompare(upperBound, lowerBound) <= 0n)
        return;
    const relativeLower = dashSubtract(lowerBound, plan.start);
    const relativeUpper = upperBound ? dashSubtract(upperBound, plan.start) : undefined;
    const selections = [];
    let selected = 0n, index = 0n;
    for (let run = 0; run < info.timeline.length; run++) {
        const entry = info.timeline[run];
        const total = entry.repeat + 1n;
        const origin = entry.time - info.presentationTimeOffset;
        let first = dashFloor(relativeLower.value * scale - origin * relativeLower.scale, entry.duration * relativeLower.scale);
        if (first < 0n)
            first = 0n;
        let last = relativeUpper
            ? dashCeil(relativeUpper.value * scale - origin * relativeUpper.scale, entry.duration * relativeUpper.scale)
            : total;
        if (last > total)
            last = total;
        if (first < last) {
            selected += last - first;
            if (selected > BigInt(limit))
                dashError('selected segment count exceeds maxSegments');
            selections.push({ run, first, count: last - first, index });
        }
        index += total;
    }
    for (const selection of selections) {
        const entry = info.timeline[selection.run];
        for (let offset = 0n; offset < selection.count; offset++) {
            const ordinal = selection.first + offset;
            const number = info.startNumber + selection.index + ordinal;
            const time = entry.time + ordinal * entry.duration;
            const resource = info.type === 'list'
                ? info.resources[Number(selection.index + ordinal)]
                : { url: dashUrl(dashExpand(plan.media, number, time), representation.baseUrl) };
            const presentationOffset = time - info.presentationTimeOffset;
            yield {
                ...resource,
                number,
                time,
                duration: entry.duration,
                timescale: info.timescale,
                presentationTime: dashSeconds(plan.start) + Number(presentationOffset) / info.timescale,
                presentationDuration: Number(entry.duration) / info.timescale,
                periodIndex: representation.periodIndex,
            };
        }
    }
}
