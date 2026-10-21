import type { OutputMuxer } from '../../core/contracts/writer';
import type { StreamingAacLcEncoder } from '../../codecs/aac/encoder';
import { buildAacAsc } from '../../core/codec-config/audio/adts';

/** Incremental AAC-LC encoder wired directly to a container muxer. */
export class AacTrackEncoder {
    private readonly encoder: StreamingAacLcEncoder;
    private readonly declaredValidSamples: number | null;
    private sealed = false;

    constructor(
        Encoder: typeof StreamingAacLcEncoder,
        readonly sampleRate: number,
        readonly channels: number,
        bitrateKbps: number,
        private readonly muxer: OutputMuxer,
        startOffsetSeconds: number,
        expectedInputFrames?: number,
    ) {
        const frameSeconds = 1024 / sampleRate;
        muxer.setAudioCodecConfig?.(buildAacAsc(sampleRate, channels));
        this.declaredValidSamples =
            expectedInputFrames === undefined ? null : Math.max(1, Math.round(expectedInputFrames));
        // The encoder delay is known now; the length of a live source only when it ends (finish()).
        muxer.setAudioPriming?.(1024, this.declaredValidSamples ?? undefined);
        if (this.declaredValidSamples !== null) muxer.setValidSamples?.(this.declaredValidSamples);

        this.encoder = new Encoder(sampleRate, channels, bitrateKbps, {
            expectedInputFrames,
            collectFrames: false,
            onFrame: (frame, index) =>
                muxer.addAudioChunk({
                    data: frame,
                    timestamp: startOffsetSeconds + index * frameSeconds,
                    duration: frameSeconds,
                    isKeyframe: true,
                    trackType: 'audio',
                }),
        });
    }

    push(planes: readonly Float32Array[]): void {
        this.encoder.pushPlanar(planes);
    }

    finish(validSamples: number): void {
        if (this.sealed) return;
        this.sealed = true;
        this.encoder.finish();
        const actual = Math.max(1, Math.round(validSamples));
        if (this.declaredValidSamples === null) {
            this.muxer.setAudioPriming?.(1024, actual);
            this.muxer.setValidSamples?.(actual);
        } else {
            this.muxer.setValidSamples?.(actual);
        }
    }
}
