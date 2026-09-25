export class PacketHeap {
    values = [];
    push(cursor) {
        let index = this.values.length;
        this.values.push(cursor);
        while (index > 0) {
            const parent = (index - 1) >>> 1;
            if (!before(cursor, this.values[parent]))
                break;
            this.values[index] = this.values[parent];
            index = parent;
        }
        this.values[index] = cursor;
    }
    pop() {
        const first = this.values[0];
        const last = this.values.pop();
        if (!last || this.values.length === 0)
            return first;
        let index = 0;
        while (index * 2 + 1 < this.values.length) {
            let child = index * 2 + 1;
            if (child + 1 < this.values.length && before(this.values[child + 1], this.values[child]))
                child++;
            if (!before(this.values[child], last))
                break;
            this.values[index] = this.values[child];
            index = child;
        }
        this.values[index] = last;
        return first;
    }
}
function before(a, b) {
    return a.time < b.time || (a.time === b.time && a.track < b.track);
}
export function decodeTime(sample) {
    return sample.decodeTimestamp ?? sample.timestamp;
}
export function lowerBound(length, value, at) {
    let low = 0;
    let high = length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (at(middle) < value)
            low = middle + 1;
        else
            high = middle;
    }
    return low;
}
