import { MediaForgeError, normalizeBitrateBps } from './errors.js';
import { prependAvcConfigToSample } from './annexb.js';
import { normalizeVideoPacket } from './video-packet.js';
import { CONTAINER_CODEC_PLANS, resolveSupportedCodec } from './format-plans.js';
export class PipelinePlanner {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
    }
    videoBitrateFor() {
        return normalizeBitrateBps(this.cfg.videoBitrate, 'video') || 2_000_000;
    }
    audioBitrateFor() {
        return normalizeBitrateBps(this.cfg.audioBitrate, 'audio') || 128_000;
    }
    resolveRunCodecs(format, video, audio) {
        const plan = CONTAINER_CODEC_PLANS[format];
        const resolve = (configured, source, supported, fallback, label) => {
            if (configured)
                return configured;
            return resolveSupportedCodec(source, supported, fallback, label) ?? fallback ?? source ?? '';
        };
        return {
            video: resolve(this.cfg.videoCodec, video?.codec, plan?.video, plan?.defaultVideo, `${format} video`),
            audio: resolve(this.cfg.audioCodec, audio?.codec, plan?.audio, plan?.defaultAudio, `${format} audio`),
        };
    }
    targetAudioParams(srcRate, srcChannels, outCodec) {
        const rate = outCodec === 'opus' ? 48000 : this.cfg.audioSampleRate || srcRate || 48000;
        const channels = this.cfg.audioChannels || srcChannels || 2;
        return { rate, channels };
    }
    hasDynamicCodecConfiguration(track) {
        return (track.codecConfigurations?.length ?? 0) > 1;
    }
    sourceAudioShape(track) {
        let rate = track.sampleRate || 0;
        let channels = track.channelCount || 0;
        for (const config of track.codecConfigurations ?? []) {
            rate = Math.max(rate, config.sampleRate ?? 0);
            channels = Math.max(channels, config.channelCount ?? 0);
        }
        return { rate: rate || 48000, channels: channels || 2 };
    }
    configurationForSample(track, sample) {
        const configurations = track.codecConfigurations;
        if (!configurations || configurations.length === 0)
            return undefined;
        const index = sample.codecConfigIndex ?? 0;
        const config = configurations[index];
        if (!config) {
            throw new MediaForgeError(`sample references missing codec configuration ${index}`, 'FORMAT');
        }
        return config;
    }
    videoPayloadForSample(track, sample, payload, previousConfigIndex) {
        const configIndex = sample.codecConfigIndex ?? 0;
        const configuration = this.configurationForSample(track, sample);
        const codecConfig = configuration?.codecConfig ?? track.codecConfig;
        payload = normalizeVideoPacket(payload, configuration?.codec ?? track.codec, codecConfig, sample.nalUnitFormat, sample.proResHeaderless);
        const firstSampleUsesTrackConfig = previousConfigIndex === null && configIndex === 0;
        if (!track.codec.startsWith('avc') ||
            !configuration ||
            firstSampleUsesTrackConfig ||
            previousConfigIndex === configIndex) {
            return { data: payload, codecConfig, configIndex };
        }
        const withParameters = prependAvcConfigToSample(configuration.codecConfig, payload);
        if (!withParameters) {
            throw new MediaForgeError(`cannot serialize AVC codec configuration transition ${previousConfigIndex} -> ${configIndex}`, 'FORMAT');
        }
        return { data: withParameters, codecConfig, configIndex };
    }
    estimateFps(samples) {
        if (!samples || samples.length < 2)
            return 0;
        const deltas = [];
        for (let i = 1; i < Math.min(samples.length, 121); i++) {
            const d = samples[i].timestamp - samples[i - 1].timestamp;
            if (d > 0)
                deltas.push(d);
        }
        if (deltas.length === 0)
            return 0;
        deltas.sort((a, b) => a - b);
        return 1 / deltas[deltas.length >> 1];
    }
    encoderFps(samples) {
        return this.cfg.fps || Math.round(this.estimateFps(samples)) || 30;
    }
    estimateFpsFromDurations(samples) {
        if (!samples || samples.length === 0)
            return 0;
        const maxProbes = 4096;
        const step = Math.max(1, Math.ceil(samples.length / maxProbes));
        const durations = [];
        for (let i = 0; i < samples.length && durations.length < maxProbes; i += step) {
            const duration = samples[i]?.duration ?? 0;
            if (duration > 0 && Number.isFinite(duration))
                durations.push(duration);
        }
        if (durations.length === 0)
            return 0;
        durations.sort((a, b) => a - b);
        return Math.round(1 / durations[durations.length >> 1]);
    }
    targetVideoDimensions(srcW, srcH) {
        const even = (v) => Math.max(2, Math.round(v / 2) * 2);
        const requireEven = (v, side) => {
            const r = Math.round(v);
            if (r < 2) {
                throw new MediaForgeError(`${side} must be at least 2 (requested ${v})`, 'FORMAT');
            }
            if (r % 2 !== 0) {
                throw new MediaForgeError(`video encoding needs even dimensions; ${side} ${r} is odd (use ${r - 1} or ${r + 1})`, 'FORMAT');
            }
            return r;
        };
        const cw = this.cfg.width || 0;
        const ch = this.cfg.height || 0;
        const sw = srcW || cw || 1920;
        const sh = srcH || ch || 1080;
        const validated = (w, h) => {
            if (w > 16384 || h > 16384 || w * h > 8192 * 4320) {
                throw new MediaForgeError(`computed output size ${w}×${h} exceeds the supported budget ` +
                    '(each side <= 16384, total pixels <= 8192×4320); ' +
                    'specify both width and height to control the result', 'FORMAT');
            }
            return { w, h };
        };
        if (cw && ch)
            return validated(requireEven(cw, 'width'), requireEven(ch, 'height'));
        if (cw)
            return validated(requireEven(cw, 'width'), even((cw * sh) / sw));
        if (ch)
            return validated(even((ch * sw) / sh), requireEven(ch, 'height'));
        return validated(even(sw), even(sh));
    }
}
