import { StreamingPcmTransformer } from '../codecs/pcm/streaming-pcm';
import type { AudioPlanes, AudioStage, AudioStreamInfo, EmitAudio } from '../core/contracts/stage';

/**
 * Maps channels (ITU-R BS.775 downmix by the input's speaker mask) and resamples to `target`. The
 * stream ends at the frame count nearest to the input length at the new rate.
 */
export function remixStage(target: AudioStreamInfo): AudioStage {
    let transformer: StreamingPcmTransformer | undefined;
    let output: EmitAudio | undefined;
    let ratio = 1;
    let input = 0;
    let emitted = 0;
    const pending: AudioPlanes[] = [];

    return {
        type: 'audio',
        name: 'remix',
        configure(source) {
            ratio = target.sampleRate / source.sampleRate;
            transformer = new StreamingPcmTransformer(
                source.sampleRate,
                source.channels,
                target.sampleRate,
                target.channels,
                planes => pending.push(planes),
                {},
                source.channelMask,
            );
            return target;
        },
        process(planes, emit) {
            output = emit;
            input += planes[0]?.length ?? 0;
            transformer!.push(planes);
            for (const ready of pending.splice(0)) {
                emitted += ready[0]!.length;
                emit(ready);
            }
        },
        flush(emit) {
            output = emit;
            transformer!.flush();

            let excess =
                emitted +
                pending.reduce((sum, planes) => sum + planes[0]!.length, 0) -
                Math.round(input * ratio);
            while (excess > 0 && pending.length) {
                const last = pending[pending.length - 1]!;
                const frames = last[0]!.length;
                if (frames <= excess) pending.pop();
                else
                    pending[pending.length - 1] = last.map(plane =>
                        plane.subarray(0, frames - excess),
                    );
                excess -= Math.min(frames, excess);
            }

            for (const ready of pending.splice(0)) output(ready);
        },
        close() {
            pending.length = 0;
            transformer = undefined;
        },
    };
}
