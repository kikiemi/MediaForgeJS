import { EncodeError } from '../core/errors.js';
import { StreamingPcmTransformer } from './streaming-pcm.js';
export class WebCodecsAudioTranscoder {
    encoder;
    targetSampleRate;
    targetChannels;
    window;
    transformer = null;
    sourceRate = 0;
    encodedFrames = 0;
    sawInput = false;
    sealed = false;
    constructor(encoder, targetSampleRate, targetChannels, window) {
        this.encoder = encoder;
        this.targetSampleRate = targetSampleRate;
        this.targetChannels = targetChannels;
        this.window = window;
    }
    get framesEncoded() {
        return this.encodedFrames;
    }
    get peakWorkFrames() {
        return this.transformer?.peakWorkFrames ?? 0;
    }
    push(audioData) {
        if (this.sealed)
            throw new EncodeError('audio transcoder received data after flush');
        const frames = audioData.numberOfFrames;
        const channels = audioData.numberOfChannels;
        if (frames <= 0 || channels <= 0)
            return;
        if (!this.sawInput) {
            this.sawInput = true;
            this.sourceRate = audioData.sampleRate;
            this.transformer = new StreamingPcmTransformer(this.sourceRate, channels, this.targetSampleRate, this.targetChannels, planes => this.encode(planes), this.window);
        }
        else if (audioData.sampleRate !== this.sourceRate) {
            throw new EncodeError(`decoded audio sample rate changed mid-stream (${this.sourceRate} -> ${audioData.sampleRate})`);
        }
        const planar = [];
        for (let channel = 0; channel < channels; channel++) {
            const plane = new Float32Array(frames);
            audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
            planar.push(plane);
        }
        this.transformer.push(planar);
    }
    flush() {
        if (this.sealed)
            return;
        this.sealed = true;
        this.transformer?.flush();
    }
    encode(channels) {
        const frames = channels[0]?.length ?? 0;
        if (frames <= 0)
            return;
        const planar = new Float32Array(frames * this.targetChannels);
        for (let channel = 0; channel < this.targetChannels; channel++) {
            planar.set(channels[channel], channel * frames);
        }
        const timestamp = Math.round((this.window.startOffset + this.encodedFrames / this.targetSampleRate) * 1e6);
        const encoded = new AudioData({
            format: 'f32-planar',
            sampleRate: this.targetSampleRate,
            numberOfFrames: frames,
            numberOfChannels: this.targetChannels,
            timestamp,
            data: planar,
        });
        try {
            this.encoder.encode(encoded);
        }
        finally {
            encoded.close();
        }
        this.encodedFrames += frames;
    }
}
