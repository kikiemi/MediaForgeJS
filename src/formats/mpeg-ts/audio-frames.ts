import { demuxAssert, malformedInput } from '../../core/errors/demux-guard';
import { DemuxIndexBudget } from '../shared/demux-budget';
import { parseMpegAudioHeader } from '../../core/codec-config/audio/mpeg-audio-header';
import { buildAacConfig, parseAdtsFrameHeader } from '../../core/codec-config/audio/adts';
import {
    dolbyAccessUnitChannels,
    parseDolbyFrameHeader,
} from '../../core/codec-config/audio/dolby-audio-header';
import { parseDtsFrame } from '../../core/codec-config/audio/dts-header';
import { opusPacketFrames } from '../../core/codec-config/audio/opus-packet';
import { PesSampleIndex } from '../shared/pes-sample-index';
import {
    STREAM_TYPE_BLURAY_LPCM,
    OPUS_STREAM,
    opusUnit,
    opusHead,
    blurayLpcmHeader,
} from './stream-types';

/**
 * Audio frames split from a PES payload; `end` and `consumed` locate frames whose data are copies.
 */
export interface SplitAudio {
    codec: string;
    sampleRate: number;
    channelCount: number;
    codecConfig?: Uint8Array;
    consumed?: number;
    frames: { data: Uint8Array; duration: number; end?: number }[];
    /**
     * Bytes at the start of the payload that complete the previous access unit (E-AC-3 dependent
     * substreams).
     */
    continuation?: Uint8Array;
}

/** Appends one audio frame, counting it against the index budget. */
export function pushFrame(
    budget: DemuxIndexBudget,
    frames: SplitAudio['frames'],
    frame: SplitAudio['frames'][number],
): void {
    budget.reserveSamples(1, PesSampleIndex.AUDIO_BYTES, 'TS audio sample index');
    frames.push(frame);
}

/**
 * `partial` marks a PES cut by the end of the input: frames after the cut are dropped rather than
 * rejected.
 */
export function splitAudioFrames(
    streamType: number,
    data: Uint8Array,
    budget: DemuxIndexBudget,
    partial = false,
    channels = 2,
): {
    codec: string;
    sampleRate: number;
    channelCount: number;
    codecConfig?: Uint8Array;
    frames: { data: Uint8Array; duration: number }[];
} {
    if (streamType === 0x0f) return splitAdtsFrames(data, budget, partial);
    if (streamType === 0x81 || streamType === 0x87)
        return splitAc3Frames(streamType, data, budget, partial);
    if (streamType === OPUS_STREAM) return splitOpusPackets(data, budget, partial, channels);
    if (streamType === STREAM_TYPE_BLURAY_LPCM) return splitBlurayLpcm(data, budget, partial);
    return splitMpegAudioFrames(data, budget, partial);
}

/**
 * DTS access units. Blu-ray muxers carry the DTS-HD extension substream in a PES of its own after
 * the core's; with `extendsCore` (the previous unit is a core alone) an extension substream opening
 * the payload completes that unit and is returned as `continuation`.
 */
/**
 * Blu-ray LPCM: each header and its samples become one packet of interleaved big-endian samples. An
 * odd channel count is stored with one more (silent) channel, which is dropped.
 */
function splitBlurayLpcm(data: Uint8Array, budget: DemuxIndexBudget, partial: boolean): SplitAudio {
    const frames: SplitAudio['frames'] = [];
    let format: ReturnType<typeof blurayLpcmHeader> = null;

    for (let offset = 0; offset < data.length;) {
        const header = blurayLpcmHeader(data, offset);
        if (partial && (!header || 4 + header.bytes > data.length - offset)) break;
        if (!(header !== null))
            malformedInput(`TS Blu-ray LPCM header at PES offset ${offset} is invalid`);
        demuxAssert(
            4 + header.bytes <= data.length - offset,
            'TS Blu-ray LPCM samples are truncated',
        );
        if (
            partial &&
            format &&
            (header.channels !== format.channels || header.sampleRate !== format.sampleRate)
        )
            break;
        demuxAssert(
            !format ||
                (header.channels === format.channels && header.sampleRate === format.sampleRate),
            'TS Blu-ray LPCM format changes inside a PES',
        );

        format = header;
        const width = header.bits / 8;
        const stored = header.channels + (header.channels & 1);
        const frameCount = Math.floor(header.bytes / (stored * width));
        const samples = data.subarray(offset + 4, offset + 4 + frameCount * stored * width);
        let out = samples;
        if (stored !== header.channels) {
            out = new Uint8Array(frameCount * header.channels * width);
            for (let frame = 0; frame < frameCount; frame++)
                out.set(
                    samples.subarray(
                        frame * stored * width,
                        (frame * stored + header.channels) * width,
                    ),
                    frame * header.channels * width,
                );
        }

        pushFrame(budget, frames, {
            data: out,
            duration: frameCount / header.sampleRate,
            end: offset + 4 + header.bytes,
        });
        offset += 4 + header.bytes;
    }

    return {
        codec: format?.bits === 16 ? 'pcm-s16be' : 'pcm-s24be',
        sampleRate: format?.sampleRate ?? 0,
        channelCount: format?.channels ?? 0,
        consumed: frames.length ? frames[frames.length - 1]!.end : 0,
        frames,
    };
}

export function splitDtsFrames(
    data: Uint8Array,
    budget: DemuxIndexBudget,
    partial: boolean,
    extendsCore: boolean,
): SplitAudio {
    const first = parseDtsFrame(data, 0);
    demuxAssert(first !== null, 'TS DTS PES payload starts with an invalid frame header');

    const frames: SplitAudio['frames'] = [];
    let continuation: Uint8Array | undefined;
    for (let offset = 0; offset < data.length;) {
        const frame = parseDtsFrame(data, offset);
        if (partial && (frame === null || frame.frameBytes > data.length - offset)) break;
        if (!(frame !== null))
            malformedInput(`TS DTS frame header at PES offset ${offset} is invalid`);
        if (!(frame.frameBytes <= data.length - offset))
            malformedInput(`TS DTS frame at PES offset ${offset} is truncated`);
        if (offset === 0 && extendsCore && frame.coreBytes === 0) {
            continuation = data.subarray(0, frame.frameBytes);
            offset += frame.frameBytes;
            continue;
        }

        demuxAssert(
            frame.sampleRate === first.sampleRate,
            'TS DTS sample rate changes inside a PES',
        );
        pushFrame(budget, frames, {
            data: data.subarray(offset, offset + frame.frameBytes),
            duration: frame.samples / frame.sampleRate,
        });
        offset += frame.frameBytes;
    }

    const split: SplitAudio = {
        codec: first.codec,
        sampleRate: first.sampleRate,
        channelCount: first.channels,
        frames,
    };

    if (continuation) {
        split.continuation = continuation;
        if (!frames.length) split.consumed = continuation.length;
    }
    return split;
}

/**
 * Opus access units in MPEG-TS, each after its control header; a start trim on the first becomes
 * pre-skip.
 */
function splitOpusPackets(
    data: Uint8Array,
    budget: DemuxIndexBudget,
    partial: boolean,
    channels: number,
): {
    codec: string;
    sampleRate: number;
    channelCount: number;
    codecConfig?: Uint8Array;
    frames: { data: Uint8Array; duration: number }[];
} {
    const frames: { data: Uint8Array; duration: number }[] = [];
    let preSkip = 0;
    for (let offset = 0; offset < data.length;) {
        const unit = opusUnit(data, offset);
        const complete = unit !== null && unit.start + unit.size <= data.length;
        if (partial && !complete) break;
        if (!complete)
            malformedInput(`TS Opus access unit at PES offset ${offset} is invalid or truncated`);
        if (offset === 0 && unit.trim !== undefined) preSkip = unit.trim;
        const packet = data.subarray(unit.start, unit.start + unit.size);
        pushFrame(budget, frames, {
            data: packet,
            duration: opusPacketFrames(packet, packet.length) / 48000,
        });
        offset = unit.start + unit.size;
    }

    return {
        codec: 'opus',
        sampleRate: 48000,
        channelCount: channels,
        codecConfig: opusHead(channels, preSkip),
        frames,
    };
}

function splitAdtsFrames(
    data: Uint8Array,
    budget: DemuxIndexBudget,
    partial = false,
): {
    codec: string;
    sampleRate: number;
    channelCount: number;
    codecConfig?: Uint8Array;
    frames: { data: Uint8Array; duration: number }[];
} {
    const first = parseAdtsFrameHeader(data);
    demuxAssert(first !== null, 'TS AAC PES payload starts with an invalid ADTS header');
    demuxAssert(
        first.channels > 0,
        'TS AAC program-config-element channel layouts are not supported',
    );
    const { sampleRate, channels: channelCount, audioObjectType } = first;
    const frames: { data: Uint8Array; duration: number }[] = [];
    let offset = 0;
    while (offset < data.length) {
        const header = parseAdtsFrameHeader(data, offset);
        if (partial && (header === null || header.frameLength > data.length - offset)) break;
        if (!(header !== null))
            malformedInput(`ADTS header at PES offset ${offset} is truncated or invalid`);
        demuxAssert(
            header.rawDataBlocks === 0,
            'TS ADTS frames with multiple raw data blocks are not supported',
        );

        // Under compatible validation a new configuration starts the next split, where the track
        // compares it.
        if (
            partial &&
            offset > 0 &&
            (header.sampleRate !== sampleRate ||
                header.channels !== channelCount ||
                header.audioObjectType !== audioObjectType)
        )
            break;
        demuxAssert(
            header.sampleRate === sampleRate &&
                header.channels === channelCount &&
                header.audioObjectType === audioObjectType,
            'TS AAC configuration changes inside a PES',
        );
        if (!(header.frameLength <= data.length - offset))
            malformedInput(`ADTS frame at PES offset ${offset} is truncated`);
        pushFrame(budget, frames, {
            data: data.subarray(offset + header.headerLength, offset + header.frameLength),
            duration: 1024 / sampleRate,
        });
        offset += header.frameLength;
    }
    return {
        codec: `mp4a.40.${audioObjectType}`,
        sampleRate,
        channelCount,
        codecConfig: buildAacConfig(sampleRate, channelCount, audioObjectType),
        frames,
    };
}

function splitMpegAudioFrames(
    data: Uint8Array,
    budget: DemuxIndexBudget,
    partial = false,
): {
    codec: string;
    sampleRate: number;
    channelCount: number;
    frames: { data: Uint8Array; duration: number }[];
} {
    const first = parseMpegAudioHeader(data, 0);
    demuxAssert(first !== null, 'TS MPEG audio PES has an invalid frame header');
    const codec = first.format;
    const sampleRate = first.sampleRate;
    const channelCount = first.channels;

    const frames: { data: Uint8Array; duration: number }[] = [];
    let offset = 0;
    while (offset < data.length) {
        const header = parseMpegAudioHeader(data, offset);
        if (partial && (header === null || header.frameLength > data.length - offset)) break;
        if (!(header !== null))
            malformedInput(`TS MPEG audio header at PES offset ${offset} is truncated or invalid`);
        if (
            partial &&
            offset > 0 &&
            (header.format !== codec ||
                header.sampleRate !== sampleRate ||
                header.channels !== channelCount)
        )
            break;
        demuxAssert(
            header.format === codec &&
                header.sampleRate === sampleRate &&
                header.channels === channelCount,
            'TS MPEG audio format changes inside a PES',
        );
        if (!(header.frameLength <= data.length - offset))
            malformedInput(`TS MPEG audio frame at PES offset ${offset} is truncated`);

        pushFrame(budget, frames, {
            data: data.subarray(offset, offset + header.frameLength),
            duration: header.samplesPerFrame / sampleRate,
        });
        offset += header.frameLength;
    }

    return { codec, sampleRate, channelCount, frames };
}

/**
 * AC-3/E-AC-3 access units: an independent frame and the dependent substream frames after it.
 * Dependent frames at the start of the payload continue the access unit of the previous PES and are
 * returned as `continuation`. The channel mode may change between frames, as the bitstream signals
 * it per frame; the widest layout is reported.
 */
function splitAc3Frames(
    streamType: number,
    data: Uint8Array,
    budget: DemuxIndexBudget,
    partial = false,
): SplitAudio {
    const frames: SplitAudio['frames'] = [];
    let sampleRate = 0;
    let channelCount = 0;
    let continuation: Uint8Array | undefined;
    let eac3 = streamType === 0x87;
    let offset = 0;
    while (offset < data.length) {
        const header = parseDolbyFrameHeader(data, offset);
        if (partial && (header === null || header.frameBytes > data.length - offset)) break;
        demuxAssert(header !== null, 'TS Dolby audio frame header is truncated or invalid');
        const { frameBytes, sampleRate: rate, samples } = header;
        demuxAssert(
            frameBytes >= 7 && frameBytes <= data.length - offset,
            'TS Dolby audio frame length is invalid or truncated',
        );

        // Stream type 0x81 also carries E-AC-3 (Blu-ray), and an AC-3 core with E-AC-3 dependent
        // substreams is E-AC-3 as a whole.
        eac3 ||= header.codec === 'ec-3';

        // E-AC-3 dependent and additional substreams (7.1, multiple programs) belong to the
        // preceding access unit.
        if (header.streamType === 1 || header.substreamId > 0) {
            const previous = frames[frames.length - 1];
            if (previous)
                previous.data = data.subarray(offset - previous.data.length, offset + frameBytes);
            else continuation = data.subarray(0, offset + frameBytes);
            offset += frameBytes;
            continue;
        }
        demuxAssert(
            frames.length === 0 || sampleRate === rate,
            'TS Dolby audio sample rate changes inside a PES',
        );
        sampleRate = rate;
        pushFrame(budget, frames, {
            data: data.subarray(offset, offset + frameBytes),
            duration: samples / sampleRate,
        });
        offset += frameBytes;
    }
    for (const frame of frames)
        channelCount = Math.max(channelCount, dolbyAccessUnitChannels(frame.data));
    const split: SplitAudio = { codec: eac3 ? 'ec-3' : 'ac-3', sampleRate, channelCount, frames };
    if (continuation) {
        split.continuation = continuation;
        if (!frames.length) split.consumed = continuation.length;
    }
    return split;
}
