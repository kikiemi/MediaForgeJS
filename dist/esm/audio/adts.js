import { DemuxError, MediaForgeError } from '../core/errors.js';
import { AAC_SAMPLE_RATES } from './aac-tables.js';
const AAC_CHANNEL_COUNTS = [0, 1, 2, 3, 4, 5, 6, 8];
const AAC_GA_SPECIFIC_TYPES = new Set([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23]);
export function parseAdtsFrameHeader(adts, offset = 0) {
    if (!Number.isInteger(offset) ||
        offset < 0 ||
        offset + 7 > adts.length ||
        adts[offset] !== 0xff ||
        (adts[offset + 1] & 0xf6) !== 0xf0)
        return null;
    const sampleRate = AAC_SAMPLE_RATES[(adts[offset + 2] >> 2) & 0x0f];
    if (!sampleRate)
        return null;
    const channelConfiguration = ((adts[offset + 2] & 1) << 2) | (adts[offset + 3] >> 6);
    const headerLength = adts[offset + 1] & 1 ? 7 : 9;
    const frameLength = ((adts[offset + 3] & 3) << 11) | (adts[offset + 4] << 3) | (adts[offset + 5] >> 5);
    if (frameLength <= headerLength)
        return null;
    return {
        sampleRate,
        channels: AAC_CHANNEL_COUNTS[channelConfiguration],
        audioObjectType: (adts[offset + 2] >> 6) + 1,
        headerLength,
        frameLength,
        rawDataBlocks: adts[offset + 6] & 3,
    };
}
export function sliceAdtsFrames(adts) {
    const frames = [];
    let off = 0;
    while (off + 7 <= adts.length) {
        const header = parseAdtsFrameHeader(adts, off);
        if (!header) {
            off++;
            continue;
        }
        if (off + header.frameLength > adts.length)
            break;
        if (header.rawDataBlocks !== 0) {
            throw new DemuxError('ADTS frames with multiple raw_data_blocks are not supported');
        }
        frames.push(adts.subarray(off + header.headerLength, off + header.frameLength));
        off += header.frameLength;
    }
    return frames;
}
export function parseAdtsHeader(adts) {
    for (let off = 0; off + 7 <= adts.length; off++) {
        const header = parseAdtsFrameHeader(adts, off);
        if (header && header.channels > 0) {
            return { sampleRate: header.sampleRate, channels: header.channels };
        }
    }
    return null;
}
function aacChannelConfiguration(channels, code) {
    if (Number.isInteger(channels) && channels >= 1 && channels <= 6)
        return channels;
    if (channels === 8)
        return 7;
    throw new MediaForgeError(`AAC channel count ${channels} requires an unsupported channel layout`, code);
}
export function buildAacConfig(sampleRate, channels, audioObjectType) {
    if (!Number.isInteger(audioObjectType) || audioObjectType < 1 || audioObjectType > 4) {
        throw new MediaForgeError(`Unsupported AAC audio object type ${audioObjectType}`, 'FORMAT');
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0xffffff) {
        throw new MediaForgeError(`Invalid AAC sample rate ${sampleRate}`, 'FORMAT');
    }
    const channelConfiguration = aacChannelConfiguration(channels, 'FORMAT');
    const index = AAC_SAMPLE_RATES.indexOf(sampleRate);
    if (index >= 0) {
        return new Uint8Array([
            (audioObjectType << 3) | (index >> 1),
            ((index & 1) << 7) | (channelConfiguration << 3),
        ]);
    }
    return new Uint8Array([
        (audioObjectType << 3) | 7,
        0x80 | (sampleRate >> 17),
        (sampleRate >> 9) & 0xff,
        (sampleRate >> 1) & 0xff,
        ((sampleRate & 1) << 7) | (channelConfiguration << 3),
    ]);
}
export function buildAacAsc(sampleRate, channels) {
    return buildAacConfig(sampleRate, channels, 2);
}
export function getAdtsConfiguration(sampleRate, channels, code) {
    const frequencyIndex = AAC_SAMPLE_RATES.indexOf(sampleRate);
    if (frequencyIndex < 0) {
        throw new MediaForgeError(`ADTS cannot represent sample rate ${sampleRate}`, code);
    }
    return { frequencyIndex, channelConfiguration: aacChannelConfiguration(channels, code) };
}
export function getAdtsFrameLength(frame, code) {
    if (!ArrayBuffer.isView(frame) ||
        Object.prototype.toString.call(frame) !== '[object Uint8Array]' ||
        frame.length < 1 ||
        frame.length > 8184) {
        throw new MediaForgeError('ADTS payload must be a Uint8Array of 1 to 8184 bytes', code);
    }
    return frame.length + 7;
}
export function writeAdtsHeader(out, offset, frameLength, configuration) {
    const { frequencyIndex, channelConfiguration } = configuration;
    out[offset] = 0xff;
    out[offset + 1] = 0xf1;
    out[offset + 2] = (1 << 6) | (frequencyIndex << 2) | (channelConfiguration >> 2);
    out[offset + 3] = ((channelConfiguration & 3) << 6) | (frameLength >> 11);
    out[offset + 4] = (frameLength >> 3) & 0xff;
    out[offset + 5] = ((frameLength & 7) << 5) | 0x1f;
    out[offset + 6] = 0xfc;
}
export function parseAacAudioSpecificConfig(config) {
    if (config.length === 0)
        return null;
    let bitOffset = 0;
    const readBits = (count) => {
        if (count < 0 || bitOffset + count > config.length * 8)
            return null;
        let value = 0;
        for (let i = 0; i < count; i++) {
            const byteIndex = bitOffset >> 3;
            const bitIndex = 7 - (bitOffset & 7);
            value = value * 2 + ((config[byteIndex] >> bitIndex) & 1);
            bitOffset++;
        }
        return value;
    };
    const readObjectType = () => {
        let objectType = readBits(5);
        if (objectType === null)
            return null;
        if (objectType === 31) {
            const extension = readBits(6);
            if (extension === null)
                return null;
            objectType = 32 + extension;
        }
        return objectType > 0 ? objectType : null;
    };
    const readFrequency = () => {
        const index = readBits(4);
        if (index === null)
            return null;
        if (index === 15) {
            const explicit = readBits(24);
            return explicit !== null && explicit > 0 ? explicit : null;
        }
        const rate = AAC_SAMPLE_RATES[index];
        return rate && rate > 0 ? rate : null;
    };
    const audioObjectType = readObjectType();
    const initialSampleRate = readFrequency();
    const channelConfiguration = readBits(4);
    if (audioObjectType === null || initialSampleRate === null || channelConfiguration === null)
        return null;
    let coreAudioObjectType = audioObjectType;
    let coreSampleRate = initialSampleRate;
    let sampleRate = initialSampleRate;
    if (audioObjectType === 5 || audioObjectType === 29) {
        const extensionSampleRate = readFrequency();
        const extensionCoreType = readObjectType();
        if (extensionSampleRate === null || extensionCoreType === null)
            return null;
        sampleRate = extensionSampleRate;
        coreAudioObjectType = extensionCoreType;
    }
    let coreSamplesPerAccessUnit = 1024;
    if (AAC_GA_SPECIFIC_TYPES.has(coreAudioObjectType)) {
        const frameLengthFlag = readBits(1);
        if (frameLengthFlag !== null && frameLengthFlag === 1)
            coreSamplesPerAccessUnit = 960;
    }
    const channelCount = AAC_CHANNEL_COUNTS[channelConfiguration] ?? 0;
    const expansion = Math.max(1, Math.round(sampleRate / coreSampleRate));
    return {
        audioObjectType,
        coreAudioObjectType,
        sampleRate,
        coreSampleRate,
        channelCount,
        samplesPerAccessUnit: coreSamplesPerAccessUnit * expansion,
    };
}
export function readAacAudioObjectType(config) {
    return parseAacAudioSpecificConfig(config)?.audioObjectType ?? null;
}
