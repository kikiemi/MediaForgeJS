import { mixWeights } from '../../core/model/channel-layout';

/**
 * Maps planes to another channel count, the one rule for decoded sound whose channels differ from
 * the track's or the target's. Fewer channels fold down by the weights of mixWeights (ITU-R BS.775
 * for stereo), each output scaled by the sum of its weights so that it cannot clip, and an output
 * plane no source speaker folds into stays silent; mono is the mean of the stereo fold. More
 * channels than the source keep its planes first, mono as both fronts.
 */
export function downmixChannels(
    sources: Float32Array[],
    sourceChannels: number,
    outputChannels: number,
    length: number,
    sourceMask?: number,
): Float32Array[] {
    const out: Float32Array[] = Array.from(
        { length: outputChannels },
        () => new Float32Array(length),
    );
    if (sourceChannels === outputChannels) {
        for (let c = 0; c < outputChannels; c++) out[c]!.set(sources[c]!.subarray(0, length));
        return out;
    }
    if (outputChannels < sourceChannels) {
        const rows = mixWeights(sourceChannels, sourceMask, Math.max(2, outputChannels), undefined);
        const totals = rows.map(row => row.reduce((sum, weight) => sum + weight, 0));
        if (outputChannels === 1) {
            const [left, right] = rows as [Float64Array, Float64Array];
            const gain = totals[0]! + totals[1]!;
            for (let i = 0; i < length; i++) {
                let l = 0,
                    r = 0;
                for (let c = 0; c < sourceChannels; c++) {
                    l += sources[c]![i]! * left[c]!;
                    r += sources[c]![i]! * right[c]!;
                }
                out[0]![i] = (l + r) / gain;
            }
            return out;
        }
        rows.forEach((row, plane) => {
            const total = totals[plane]!;
            if (!total) return;
            const target = out[plane]!;
            for (let i = 0; i < length; i++) {
                let value = 0;
                for (let c = 0; c < sourceChannels; c++) value += sources[c]![i]! * row[c]!;
                target[i] = value / total;
            }
        });
        return out;
    }
    if (sourceChannels === 1) {
        out[0]!.set(sources[0]!.subarray(0, length));
        if (outputChannels > 1) out[1]!.set(sources[0]!.subarray(0, length));
        return out;
    }
    for (let c = 0; c < sourceChannels; c++) out[c]!.set(sources[c]!.subarray(0, length));
    return out;
}
