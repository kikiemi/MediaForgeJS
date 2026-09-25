import { MediaForgeError } from '../core/errors.js';
import { parseAacAudioSpecificConfig } from '../audio/adts.js';
import { mp4HandlerName, mp4TitleBox, mp4TrackFlags, mp4TrackMetadataBoxes } from '../core/mp4-metadata.js';
export function cmafAssert(condition, message) {
    if (!condition)
        throw new MediaForgeError(`fMP4: ${message}`, 'MUX');
}
export function integer(value, label, min = 0, max = 0xffffffff) {
    cmafAssert(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be an integer in [${min}, ${max}]`);
    return value;
}
export function ascii(value) {
    return Uint8Array.from(value, character => character.charCodeAt(0));
}
export function join(parts) {
    const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
    integer(size, 'box size', 0, 0x7fffffff);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}
export function u32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, integer(value, 'unsigned field'));
    return bytes;
}
export function box(type, ...parts) {
    const size = parts.reduce((sum, part) => sum + part.byteLength, 8);
    return join([u32(size), ascii(type), ...parts]);
}
export function fullBox(type, version, flags, ...parts) {
    return box(type, Uint8Array.of(version, flags >>> 16, flags >>> 8, flags), ...parts);
}
function descriptor(tag, payload) {
    integer(payload.length, 'descriptor size', 0, 0x0fffffff);
    const length = [payload.length & 0x7f];
    let remaining = payload.length >>> 7;
    while (remaining) {
        length.unshift((remaining & 0x7f) | 0x80);
        remaining >>>= 7;
    }
    return join([Uint8Array.of(tag, ...length), payload]);
}
function validateNalConfig(bytes, hevc) {
    cmafAssert(bytes.length >= (hevc ? 23 : 7) && bytes[0] === 1, 'invalid AVC/HEVC configuration record');
    const width = (bytes[hevc ? 21 : 4] & 3) + 1;
    cmafAssert(width !== 3, 'reserved NAL length width');
    let offset = hevc ? 23 : 6;
    const readUnits = (count) => {
        for (let index = 0; index < count; index++) {
            cmafAssert(offset + 2 <= bytes.length, 'truncated NAL configuration length');
            const length = bytes[offset] * 256 + bytes[offset + 1];
            offset += 2;
            cmafAssert(length > 0 && offset + length <= bytes.length, 'truncated NAL configuration');
            offset += length;
        }
    };
    if (hevc) {
        for (let index = 0; index < bytes[22]; index++) {
            cmafAssert(offset + 3 <= bytes.length, 'truncated HEVC array');
            offset++;
            const count = bytes[offset] * 256 + bytes[offset + 1];
            offset += 2;
            readUnits(count);
        }
        cmafAssert(offset === bytes.length, 'trailing HEVC configuration bytes');
    }
    else {
        cmafAssert((bytes[5] & 31) > 0, 'AVC configuration needs SPS');
        readUnits(bytes[5] & 31);
        cmafAssert(offset < bytes.length && bytes[offset] > 0, 'AVC configuration needs PPS');
        readUnits(bytes[offset++]);
    }
}
function videoEntry(track) {
    const kind = track.codec.split('.')[0];
    cmafAssert(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09'].includes(kind), `unsupported video codec ${track.codec}`);
    integer(track.width, 'width', 1, 0xffff);
    integer(track.height, 'height', 1, 0xffff);
    const config = track.codecConfig;
    cmafAssert(config && config.length > 0, `${kind} requires decoder configuration`);
    let configType;
    if (kind === 'avc1' || kind === 'avc3') {
        validateNalConfig(config, false);
        configType = 'avcC';
    }
    else if (kind === 'hvc1' || kind === 'hev1') {
        validateNalConfig(config, true);
        configType = 'hvcC';
    }
    else if (kind === 'av01') {
        cmafAssert(config.length >= 4 && config[0] === 0x81, 'invalid AV1 configuration record');
        configType = 'av1C';
    }
    else {
        cmafAssert(config.length === 12 &&
            config[0] === 1 &&
            config[1] === 0 &&
            config[2] === 0 &&
            config[3] === 0 &&
            config[4] <= 3 &&
            [8, 10, 12].includes(config[6] >>> 4) &&
            config[10] === 0 &&
            config[11] === 0, 'VP9 requires a version-1 vpcC payload including its four-byte full-box header');
        const profile = config[4];
        const depth = config[6] >>> 4;
        const chroma = (config[6] >>> 1) & 7;
        cmafAssert((profile < 2 ? depth === 8 : depth >= 10) &&
            (profile % 2 === 0 ? chroma <= 1 : chroma === 2 || chroma === 3) &&
            (config[9] !== 0 || chroma === 3), 'VP9 profile, bit depth, and chroma subsampling disagree');
        configType = 'vpcC';
    }
    const payload = new Uint8Array(78);
    const view = new DataView(payload.buffer);
    view.setUint16(6, 1);
    view.setUint16(24, track.width);
    view.setUint16(26, track.height);
    view.setUint32(28, 0x00480000);
    view.setUint32(32, 0x00480000);
    view.setUint16(40, 1);
    view.setUint16(74, 24);
    view.setUint16(76, 0xffff);
    const children = [box(configType, config)];
    if (track.pixelAspectRatioNum !== undefined || track.pixelAspectRatioDen !== undefined) {
        children.push(box('pasp', u32(integer(track.pixelAspectRatioNum, 'pixel aspect numerator', 1)), u32(integer(track.pixelAspectRatioDen, 'pixel aspect denominator', 1))));
    }
    return box(kind, payload, ...children);
}
function audioEntry(track) {
    const flac = track.codec === 'flac' || track.codec === 'fLaC';
    const rate = integer(track.sampleRate, 'sample rate', 1, flac ? 0xfffff : 0xffff);
    const channels = integer(track.channelCount, 'channel count', 1, 0xffff);
    const config = track.codecConfig;
    cmafAssert(config && config.length > 0, `${track.codec} requires decoder configuration`);
    let kind;
    let child;
    let sampleSize = 16;
    let entryRate = rate;
    if (track.codec === 'mp4a' || track.codec.startsWith('mp4a.40.')) {
        const parsed = parseAacAudioSpecificConfig(config);
        cmafAssert(parsed && parsed.sampleRate === rate && parsed.channelCount === channels, 'AAC ASC does not match sample rate/channel count');
        cmafAssert(track.codec === 'mp4a' || track.codec === `mp4a.40.${parsed.audioObjectType}`, 'AAC codec string does not match its AudioSpecificConfig');
        kind = 'mp4a';
        const decoder = descriptor(4, join([Uint8Array.of(0x40, 0x15, 0, 0, 0), u32(0), u32(0), descriptor(5, config)]));
        child = fullBox('esds', 0, 0, descriptor(3, join([Uint8Array.of(0, 1, 0), decoder, descriptor(6, Uint8Array.of(2))])));
    }
    else if (track.codec === 'opus' || track.codec === 'Opus') {
        cmafAssert(rate === 48000 && track.timescale === 48000, 'Opus requires a 48000 Hz sample rate and timescale');
        cmafAssert(config.length >= 11 && config[0] === 0 && config[1] === channels, 'Opus requires a big-endian dOps payload');
        cmafAssert(config[10] === 0 ? channels <= 2 && config.length === 11 : config.length === 13 + channels, 'invalid Opus channel mapping');
        if (config[10] !== 0) {
            const streams = config[11];
            const coupled = config[12];
            cmafAssert(streams > 0 &&
                coupled <= streams &&
                streams + coupled <= 255 &&
                config.subarray(13).every(channel => channel === 255 || channel < streams + coupled), 'invalid Opus stream counts or channel map');
        }
        kind = 'Opus';
        child = box('dOps', config);
    }
    else if (track.codec === 'ac-3' || track.codec === 'ec-3') {
        let frequency;
        let mode;
        let lfe;
        if (track.codec === 'ac-3') {
            cmafAssert(config.length === 3, 'AC-3 requires a three-byte dac3 payload');
            frequency = config[0] >>> 6;
            mode = (config[1] >>> 3) & 7;
            lfe = (config[1] >>> 2) & 1;
            const bitstreamId = (config[0] >>> 1) & 31;
            const bitrateCode = ((config[1] & 3) << 3) | (config[2] >>> 5);
            cmafAssert(bitstreamId <= 8 && bitrateCode <= 18 && (config[2] & 31) === 0, 'invalid AC-3 bitstream ID, bitrate code, or reserved bits');
        }
        else {
            cmafAssert((config.length === 5 || (config.length === 6 && config[5] === 0)) &&
                (config[1] & 7) === 0 &&
                config[4] === 0, 'E-AC-3 requires a dec3 payload with one independent substream and no dependent substreams or extensions');
            frequency = config[2] >>> 6;
            mode = (config[3] >>> 1) & 7;
            lfe = config[3] & 1;
            cmafAssert(config[0] * 32 + (config[1] >>> 3) > 0 && ((config[2] >>> 1) & 31) === 16 && (config[2] & 1) === 0, 'invalid E-AC-3 bitrate, bitstream ID, or reserved bits');
        }
        cmafAssert([48000, 44100, 32000][frequency] === rate && [2, 1, 2, 3, 3, 4, 4, 5][mode] + lfe === channels, 'Dolby configuration does not match sample rate/channel count');
        kind = track.codec;
        child = box(kind === 'ac-3' ? 'dac3' : 'dec3', config);
    }
    else if (track.codec === 'alac') {
        cmafAssert(config.length === 24, 'ALAC requires a raw 24-byte ALACSpecificConfig');
        const view = new DataView(config.buffer, config.byteOffset, config.byteLength);
        cmafAssert(view.getUint32(0) > 0 &&
            view.getUint32(0) <= 16 * 1024 * 1024 &&
            config[4] === 0 &&
            [16, 20, 24, 32].includes(config[5]) &&
            config[8] > 0 &&
            config[8] <= 31, 'invalid ALAC frame length, version, sample size, or Rice limit');
        cmafAssert(channels <= 8 && config[9] === channels && view.getUint32(20) === rate, 'ALAC configuration does not match sample rate/channel count');
        sampleSize = config[5];
        kind = 'alac';
        child = fullBox('alac', 0, 0, config);
    }
    else if (flac) {
        cmafAssert(config.length === 34, 'FLAC requires a raw 34-byte STREAMINFO record');
        const encodedRate = config[10] * 4096 + config[11] * 16 + (config[12] >>> 4);
        cmafAssert(encodedRate === rate && ((config[12] >>> 1) & 7) + 1 === channels, 'FLAC STREAMINFO does not match sample rate/channel count');
        sampleSize = (((config[12] & 1) << 4) | (config[13] >>> 4)) + 1;
        cmafAssert(sampleSize >= 4, 'FLAC STREAMINFO has an invalid sample size');
        if (rate > 0xffff) {
            entryRate = 1;
            for (let divisor = 1; divisor * divisor <= rate; divisor++) {
                if (rate % divisor !== 0)
                    continue;
                for (const candidate of [divisor, rate / divisor]) {
                    if (candidate <= 0xffff)
                        entryRate = Math.max(entryRate, candidate);
                }
            }
            if (entryRate === 1)
                entryRate = 0xffff;
        }
        kind = 'fLaC';
        child = fullBox('dfLa', 0, 0, Uint8Array.of(0x80, 0, 0, 34), config);
    }
    else {
        cmafAssert(false, `unsupported audio codec ${track.codec}`);
    }
    const payload = new Uint8Array(28);
    const view = new DataView(payload.buffer);
    view.setUint16(6, 1);
    view.setUint16(16, channels);
    view.setUint16(18, sampleSize);
    view.setUint32(24, entryRate * 65536);
    return box(kind, payload, child);
}
function subtitleEntry(track) {
    const payload = new Uint8Array(8);
    payload[7] = 1;
    if (track.codec === 'wvtt') {
        const config = track.codecConfig ?? ascii('WEBVTT\n');
        cmafAssert(new TextDecoder().decode(config).startsWith('WEBVTT'), 'wvtt configuration must begin with WEBVTT');
        return box('wvtt', payload, box('vttC', config));
    }
    cmafAssert(track.codec === 'stpp', `unsupported subtitle codec ${track.codec}`);
    const fields = [
        track.namespace ?? 'http://www.w3.org/ns/ttml',
        track.schemaLocation ?? '',
        track.auxiliaryMimeTypes ?? '',
    ];
    cmafAssert(fields.every(field => !field.includes('\0')), 'stpp entry strings cannot contain NUL');
    return box('stpp', payload, new TextEncoder().encode(fields.join('\0') + '\0'));
}
function matrix(view, offset) {
    view.setUint32(offset, 0x00010000);
    view.setUint32(offset + 16, 0x00010000);
    view.setUint32(offset + 32, 0x40000000);
}
function trackBox(track) {
    const tkhd = new Uint8Array(80);
    const tv = new DataView(tkhd.buffer);
    tv.setUint32(8, track.id);
    tv.setUint16(32, track.type === 'audio' ? 0x0100 : 0);
    matrix(tv, 36);
    if (track.type === 'video') {
        tv.setUint32(72, track.width * 65536);
        tv.setUint32(76, track.height * 65536);
    }
    const mdhd = new Uint8Array(20);
    const mv = new DataView(mdhd.buffer);
    mv.setUint32(8, track.timescale);
    const language = track.language ?? 'und';
    cmafAssert(/^[a-z]{3}$/.test(language), 'track language must be a three-letter ISO 639-2 code');
    mv.setUint16(16, ((language.charCodeAt(0) - 96) << 10) | ((language.charCodeAt(1) - 96) << 5) | (language.charCodeAt(2) - 96));
    const name = mp4HandlerName(track.name);
    const handler = new Uint8Array(20 + name.length);
    handler.set(name, 20);
    handler.set(ascii(track.type === 'video'
        ? 'vide'
        : track.type === 'audio'
            ? 'soun'
            : track.codec === 'wvtt'
                ? 'text'
                : 'subt'), 4);
    const entry = track.type === 'video' ? videoEntry(track) : track.type === 'audio' ? audioEntry(track) : subtitleEntry(track);
    const header = track.type === 'video'
        ? fullBox('vmhd', 0, 1, new Uint8Array(8))
        : track.type === 'audio'
            ? fullBox('smhd', 0, 0, new Uint8Array(4))
            : fullBox('nmhd', 0, 0);
    const stbl = box('stbl', fullBox('stsd', 0, 0, u32(1), entry), fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stco', 0, 0, u32(0)));
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const edits = [];
    if ((track.codec === 'opus' || track.codec === 'Opus') && track.codecConfig) {
        const skip = track.codecConfig[2] * 256 + track.codecConfig[3];
        if (skip)
            edits.push(box('edts', fullBox('elst', 0, 0, u32(1), u32(0), u32(skip), u32(65536))));
    }
    return box('trak', fullBox('tkhd', 0, mp4TrackFlags(track, 7), tkhd), ...edits, box('mdia', fullBox('mdhd', 0, 0, mdhd), fullBox('hdlr', 0, 0, handler), box('minf', header, dinf, stbl)), ...mp4TrackMetadataBoxes(track));
}
export function buildCmafInit(tracks, title) {
    const mvhd = new Uint8Array(96);
    const view = new DataView(mvhd.buffer);
    view.setUint32(8, 1000);
    view.setUint32(16, 65536);
    view.setUint16(20, 256);
    matrix(view, 32);
    view.setUint32(92, Math.max(...tracks.map(track => track.id)) + 1);
    const trexes = tracks.map(track => fullBox('trex', 0, 0, u32(track.id), u32(1), u32(0), u32(0), u32(0)));
    return join([
        box('ftyp', ascii('iso6'), u32(0), ascii('iso6'), ascii('mp41'), ascii('dash')),
        box('moov', fullBox('mvhd', 0, 0, mvhd), ...tracks.map(trackBox), box('mvex', ...trexes), mp4TitleBox(title)),
    ]);
}
