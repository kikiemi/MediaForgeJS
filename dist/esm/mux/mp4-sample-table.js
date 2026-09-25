const PAGE_BITS = 12;
const PAGE_SIZE = 1 << PAGE_BITS;
const PAGE_MASK = PAGE_SIZE - 1;
const FIRST_PAGE_SIZE = 32;
const KEYFRAME = 1;
const DECODE_TIMESTAMP = 2;
const COMPOSITION_OFFSET = 4;
function pageFor(index) {
    return index < FIRST_PAGE_SIZE ? 0 : ((index - FIRST_PAGE_SIZE) >>> PAGE_BITS) + 1;
}
function slotFor(index) {
    return index < FIRST_PAGE_SIZE ? index : (index - FIRST_PAGE_SIZE) & PAGE_MASK;
}
export class MP4SampleTable {
    pages = [];
    length = 0;
    add(chunk, offset, retainData) {
        const pageIndex = pageFor(this.length);
        const index = slotFor(this.length);
        let page = this.pages[pageIndex];
        if (!page) {
            const capacity = pageIndex === 0 ? FIRST_PAGE_SIZE : PAGE_SIZE;
            page = {
                timestamps: new Float64Array(capacity),
                durations: new Float64Array(capacity),
                sizes: new Uint32Array(capacity),
                offsets: new Float64Array(capacity),
                flags: new Uint8Array(capacity),
            };
            this.pages.push(page);
        }
        page.timestamps[index] = chunk.timestamp;
        page.durations[index] = chunk.duration ?? 0;
        page.sizes[index] = chunk.data.byteLength;
        page.offsets[index] = offset;
        let flags = chunk.isKeyframe ? KEYFRAME : 0;
        if (chunk.decodeTimestamp !== undefined) {
            page.decodeTimestamps ??= new Float64Array(page.timestamps.length);
            page.decodeTimestamps[index] = chunk.decodeTimestamp;
            flags |= DECODE_TIMESTAMP;
        }
        if (chunk.compositionTimeOffset !== undefined) {
            page.compositionOffsets ??= new Float64Array(page.timestamps.length);
            page.compositionOffsets[index] = chunk.compositionTimeOffset;
            flags |= COMPOSITION_OFFSET;
        }
        page.flags[index] = flags;
        if (retainData) {
            page.data ??= [];
            page.data[index] = new Uint8Array(chunk.data);
        }
        this.length++;
    }
    clear() {
        this.pages.length = 0;
        this.length = 0;
    }
    removeLast() {
        this.length--;
        if (slotFor(this.length) === 0)
            this.pages.pop();
        else
            this.pages[pageFor(this.length)].data?.pop();
    }
    timestamp(index) {
        return this.pages[pageFor(index)].timestamps[slotFor(index)];
    }
    duration(index) {
        return this.pages[pageFor(index)].durations[slotFor(index)];
    }
    decodeTimestamp(index) {
        const page = this.pages[pageFor(index)];
        const slot = slotFor(index);
        return page.flags[slot] & DECODE_TIMESTAMP ? page.decodeTimestamps[slot] : page.timestamps[slot];
    }
    compositionTimeOffset(index) {
        const page = this.pages[pageFor(index)];
        const slot = slotFor(index);
        return page.flags[slot] & COMPOSITION_OFFSET ? page.compositionOffsets[slot] : undefined;
    }
    byteLength(index) {
        return this.pages[pageFor(index)].sizes[slotFor(index)];
    }
    offset(index) {
        return this.pages[pageFor(index)].offsets[slotFor(index)];
    }
    setOffset(index, offset) {
        this.pages[pageFor(index)].offsets[slotFor(index)] = offset;
    }
    isKeyframe(index) {
        return (this.pages[pageFor(index)].flags[slotFor(index)] & KEYFRAME) !== 0;
    }
    data(index) {
        return this.pages[pageFor(index)].data?.[slotFor(index)];
    }
}
export class MP4SampleRuns {
    pages = [];
    length = 0;
    append(value) {
        const last = this.length - 1;
        if (last >= 0 && this.value(last) === value) {
            this.pages[pageFor(last)].counts[slotFor(last)]++;
            return;
        }
        const pageIndex = pageFor(this.length);
        let page = this.pages[pageIndex];
        if (!page) {
            const capacity = pageIndex === 0 ? FIRST_PAGE_SIZE : PAGE_SIZE;
            page = { values: new Float64Array(capacity), counts: new Uint32Array(capacity) };
            this.pages.push(page);
        }
        const index = slotFor(this.length);
        page.values[index] = value;
        page.counts[index] = 1;
        this.length++;
    }
    value(index) {
        return this.pages[pageFor(index)].values[slotFor(index)];
    }
    count(index) {
        return this.pages[pageFor(index)].counts[slotFor(index)];
    }
    get lastValue() {
        return this.length === 0 ? 0 : this.value(this.length - 1);
    }
    replaceLast(value) {
        const last = this.length - 1;
        const page = this.pages[pageFor(last)];
        const index = slotFor(last);
        if (--page.counts[index] === 0)
            this.length--;
        this.append(value);
    }
}
