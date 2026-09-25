import { MediaForgeError } from '../core/errors.js';
import { parseAacAudioSpecificConfig } from '../audio/adts.js';
import { opusPacketFrames } from '../core/opus-packet.js';
import { isAnnexB, annexBToAvcc } from '../core/annexb.js';
function fail(message) {
    throw new MediaForgeError(message, 'MUX');
}
function ticks(seconds, scale) {
    const value = Math.round(seconds * scale);
    if (!Number.isSafeInteger(value))
        fail('fMP4 timing exceeds the exact integer range');
    return value;
}
export function cmafTrackConfig(track) {
    if (track.type === 'subtitle' && track.codec === 'text/webvtt') {
        fail("Matroska WebVTT block/text layout and overlapping cues require explicit conversion: use toSubtitleChunks(cues, 'wvtt') with CmafWriter");
    }
    let codecConfig = track.codecConfig?.slice();
    if (track.codec === 'opus' &&
        codecConfig &&
        codecConfig.length >= 19 &&
        String.fromCharCode(...codecConfig.subarray(0, 8)) === 'OpusHead') {
        if (codecConfig[8] !== 1)
            fail('Unsupported OpusHead version');
        const original = codecConfig;
        const input = new DataView(original.buffer, original.byteOffset, original.byteLength);
        const extra = original[18] === 0 ? 0 : 2 + original[9];
        if (original.length !== 19 + extra)
            fail('Invalid OpusHead channel mapping length');
        codecConfig = new Uint8Array(11 + extra);
        const output = new DataView(codecConfig.buffer);
        codecConfig[1] = original[9];
        output.setUint16(2, input.getUint16(10, true));
        output.setUint32(4, input.getUint32(12, true));
        output.setInt16(8, input.getInt16(16, true));
        codecConfig[10] = original[18];
        if (extra)
            codecConfig.set(original.subarray(19), 11);
    }
    if (track.codec === 'flac' &&
        codecConfig &&
        codecConfig.length >= 42 &&
        String.fromCharCode(...codecConfig.subarray(0, 4)) === 'fLaC') {
        if ((codecConfig[4] & 0x7f) !== 0 || codecConfig[5] !== 0 || codecConfig[6] !== 0 || codecConfig[7] !== 34) {
            fail('FLAC CodecPrivate must start with STREAMINFO');
        }
        codecConfig = codecConfig.slice(8, 42);
    }
    return {
        ...track,
        codecConfig,
        ...(track.codec === 'opus'
            ? { sampleRate: 48000, timescale: 48000 }
            : track.type === 'audio' && track.codec.startsWith('mp4a')
                ? { timescale: track.sampleRate }
                : {}),
    };
}
function lengthPrefixed(data, width) {
    let offset = 0;
    while (offset < data.length) {
        if (offset + width > data.length)
            return false;
        let length = 0;
        for (let index = 0; index < width; index++)
            length = length * 256 + data[offset++];
        if (length < 1 || length > data.length - offset)
            return false;
        offset += length;
    }
    return data.length > 0;
}
export class CmafPacketAdapter {
    track;
    timestampResolution;
    origin;
    warning;
    end;
    warned = false;
    quantizedAudio;
    constructor(track, format, timestampResolution, origin, warning) {
        this.track = track;
        this.timestampResolution = timestampResolution;
        this.origin = origin;
        this.warning = warning;
        this.quantizedAudio =
            ['mkv', 'webm'].includes(format) &&
                track.type === 'audio' &&
                (track.codec.startsWith('mp4a') || track.codec === 'opus');
        if (!Number.isFinite(timestampResolution) || timestampResolution <= 0)
            fail('Invalid source timestamp resolution');
    }
    prepare(packet) {
        const scale = this.track.timescale;
        let dts = ticks((packet.decodeTimestamp ?? packet.timestamp) - this.origin, scale);
        let duration = ticks(packet.duration, scale);
        const originalDts = dts;
        const originalDuration = duration;
        let discontinuity = false;
        if (this.quantizedAudio) {
            duration =
                this.track.codec === 'opus'
                    ? opusPacketFrames(packet.data, packet.data.length)
                    : parseAacAudioSpecificConfig(this.track.codecConfig).samplesPerAccessUnit;
        }
        if (this.end !== undefined) {
            const difference = dts - this.end;
            const tolerance = this.quantizedAudio ? Math.ceil(scale * this.timestampResolution) : 0;
            if (difference !== 0 && Math.abs(difference) <= tolerance)
                dts = this.end;
            else if (difference < 0)
                fail(`fMP4 track ${this.track.id} decode timestamps overlap`);
            else if (difference > 0)
                discontinuity = true;
        }
        if (this.quantizedAudio && !this.warned && (dts !== originalDts || duration !== originalDuration)) {
            this.warning();
            this.warned = true;
        }
        this.end = dts + duration;
        if (!Number.isSafeInteger(this.end))
            fail('fMP4 decode end exceeds the exact integer range');
        let data = packet.data;
        const kind = this.track.codec.split('.')[0];
        if (['avc1', 'avc3', 'hvc1', 'hev1'].includes(kind)) {
            const width = ((this.track.codecConfig[kind.startsWith('avc') ? 4 : 21] & 3) + 1);
            if (!lengthPrefixed(data, width) && isAnnexB(data))
                data = annexBToAvcc(data, width);
        }
        const compositionTimeOffset = ticks(packet.compositionTimeOffset ?? packet.timestamp - (packet.decodeTimestamp ?? packet.timestamp), scale);
        return {
            sample: {
                trackId: this.track.id,
                data,
                decodeTimestamp: dts,
                duration,
                compositionTimeOffset,
                isKeyframe: packet.isKeyframe,
            },
            discontinuity,
            time: dts / scale,
        };
    }
}
