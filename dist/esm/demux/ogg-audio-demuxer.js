import { DemuxError, MediaForgeError } from '../core/errors.js';
import { oggCrc32 } from '../core/ogg-crc.js';
import { opusPacketFrames } from '../core/opus-packet.js';
import { vorbisCodecConfig, vorbisModes, vorbisPacketBlock } from './vorbis-headers.js';
function signature(bytes, value) {
    return (bytes.length >= value.length && [...value].every((character, index) => bytes[index] === character.charCodeAt(0)));
}
function u32(bytes, at) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
}
export function validateOggComments(packet, opus) {
    const start = opus ? 8 : 7;
    if (!signature(packet, opus ? 'OpusTags' : '\x03vorbis') || packet.length < start + 8)
        throw new DemuxError('Invalid Ogg audio comment header');
    let offset = start + 4;
    const vendorLength = u32(packet, start);
    if (vendorLength > packet.length - offset - 4)
        throw new DemuxError('Truncated Ogg comment vendor');
    offset += vendorLength;
    const count = u32(packet, offset);
    offset += 4;
    if (count > 100_000 || count > Math.floor((packet.length - offset) / 4))
        throw new DemuxError('Ogg comment count exceeds header bounds');
    for (let index = 0; index < count; index++) {
        if (offset > packet.length - 4)
            throw new DemuxError('Truncated Ogg comment length');
        const length = u32(packet, offset);
        offset += 4;
        if (length > packet.length - offset)
            throw new DemuxError('Truncated Ogg comment');
        offset += length;
    }
    if (!opus && (offset >= packet.length || (packet[offset] & 1) !== 1))
        throw new DemuxError('Missing Vorbis comment framing flag');
}
function combine(parts, bytes) {
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) {
        data.set(part.data, offset);
        offset += part.data.length;
    }
    return data;
}
export async function indexOggAudio(context, requireOpus) {
    let offset = 0;
    let serial;
    let sequence = 0;
    let eos = false;
    let packetIndex = 0;
    let packetSize = 0;
    let continued = false;
    let parts = [];
    let codec = '';
    let sampleRate = 0;
    let channels = 0;
    let preSkip = 0;
    let smallBlock = 0;
    let largeBlock = 0;
    let previousBlock = 0;
    let firstAudioPage = true;
    let vorbisPriming = 0;
    let modes = [];
    let frames = 0;
    let granule = 0;
    let bufferedBytes = 0;
    let pages = 0;
    const headers = [];
    const samples = [];
    while (offset < context.size) {
        if ((pages++ & 127) === 0)
            await context.checkpoint();
        if (eos)
            throw new DemuxError('Ogg chaining or bytes after EOS are unsupported; split each logical stream first');
        const header = await context.read(offset, 27);
        if (!signature(header, 'OggS') || header[4] !== 0 || (header[5] & 0xf8) !== 0)
            throw new DemuxError(`Invalid Ogg page header at ${offset}`);
        const flags = header[5];
        const pageSerial = u32(header, 14);
        const pageSequence = u32(header, 18);
        const firstPage = serial === undefined;
        if (firstPage) {
            if (flags !== 2 || pageSequence !== 0)
                throw new DemuxError('Ogg audio must start with a sequence-zero BOS page');
            serial = pageSerial;
        }
        else if (pageSerial !== serial)
            throw new DemuxError('Multiplexed Ogg logical streams are unsupported; select or split one audio stream first');
        else if (flags & 2)
            throw new DemuxError('Unexpected repeated Ogg BOS page');
        if (pageSequence !== sequence)
            throw new DemuxError(`Ogg page sequence discontinuity at ${offset}`);
        sequence = (sequence + 1) >>> 0;
        if (((flags & 1) !== 0) !== continued)
            throw new DemuxError('Ogg packet continuation flag is inconsistent');
        const lacing = await context.read(offset + 27, header[26]);
        let payloadSize = 0;
        for (const lace of lacing)
            payloadSize += lace;
        const pageSize = 27 + lacing.length + payloadSize;
        const page = (await context.read(offset, pageSize)).slice();
        const crc = u32(page, 22);
        page.fill(0, 22, 26);
        if (oggCrc32(page) !== crc)
            throw new DemuxError(`Ogg page CRC mismatch at ${offset}`);
        const lo = u32(page, 6);
        const hi = u32(page, 10);
        const pageGranule = lo === 0xffffffff && hi === 0xffffffff ? null : hi * 2 ** 32 + lo;
        if (pageGranule !== null && !Number.isSafeInteger(pageGranule))
            throw new DemuxError('Ogg granule exceeds exact integer range');
        let body = 27 + lacing.length;
        let completed = 0;
        let audioOnPage = 0;
        let pageFrames = 0;
        let emptyEos = false;
        for (let segment = 0; segment < lacing.length; segment++) {
            const lace = lacing[segment];
            packetSize += lace;
            if (packetSize > context.maxPacketBytes)
                throw new MediaForgeError('Ogg packet exceeds maxPacketBytes', 'OOM');
            if (lace) {
                const previous = parts[parts.length - 1];
                const data = page.subarray(body, body + lace);
                if (previous && previous.offset + previous.data.length === offset + body) {
                    parts[parts.length - 1] = {
                        offset: previous.offset,
                        data: page.subarray(previous.offset - offset, body + lace),
                    };
                }
                else {
                    if (parts.length >= 4096)
                        throw new DemuxError('Ogg packet spans more than 4096 pages');
                    parts.push({ offset: offset + body, data });
                }
            }
            body += lace;
            continued = lace === 255;
            if (continued)
                continue;
            completed++;
            const headerCount = codec === 'opus' ? 2 : 3;
            if (packetIndex === 0) {
                const packet = combine(parts, packetSize);
                if (signature(packet, 'OpusHead')) {
                    if (packet.length !== 19 ||
                        packet[8] !== 1 ||
                        packet[18] !== 0 ||
                        packet[9] < 1 ||
                        packet[9] > 2) {
                        throw new DemuxError('Ogg packet input supports version-one OpusHead mapping family zero (mono/stereo); convert other mappings first');
                    }
                    codec = 'opus';
                    sampleRate = 48000;
                    channels = packet[9];
                    preSkip = packet[10] + packet[11] * 256;
                }
                else if (!requireOpus && signature(packet, '\x01vorbis')) {
                    if (packet.length !== 30 || u32(packet, 7) !== 0 || (packet[29] & 1) !== 1)
                        throw new DemuxError('Invalid Vorbis identification header');
                    channels = packet[11];
                    sampleRate = u32(packet, 12);
                    smallBlock = 1 << (packet[28] & 15);
                    largeBlock = 1 << (packet[28] >> 4);
                    if (channels < 1 ||
                        channels > 8 ||
                        sampleRate < 1 ||
                        sampleRate > 768000 ||
                        smallBlock < 64 ||
                        largeBlock < smallBlock ||
                        largeBlock > 8192)
                        throw new DemuxError('Unsupported Vorbis audio shape');
                    codec = 'vorbis';
                }
                else
                    throw new DemuxError(requireOpus ? 'Expected Ogg Opus audio' : 'Ogg packet input supports Opus and Vorbis audio');
                headers.push(packet);
                if (!firstPage || segment !== lacing.length - 1)
                    throw new DemuxError('Ogg identification header must be alone on the BOS page');
            }
            else if (packetIndex < headerCount) {
                const packet = combine(parts, packetSize);
                if (packetIndex === 1)
                    validateOggComments(packet, codec === 'opus');
                else {
                    if (!signature(packet, '\x05vorbis'))
                        throw new DemuxError('Missing Vorbis setup header');
                    modes = vorbisModes(packet, channels);
                }
                headers.push(packet);
                if (packetIndex === headerCount - 1 && segment !== lacing.length - 1)
                    throw new DemuxError('Ogg audio packets must begin on a page after codec headers');
            }
            else {
                if (!packetSize) {
                    if (codec !== 'vorbis' ||
                        flags !== 4 ||
                        lacing.length !== 1 ||
                        !samples.length ||
                        pageGranule !== granule ||
                        granule !== frames)
                        throw new DemuxError('Empty Ogg audio packet');
                    context.diagnostics.recover({
                        code: 'OGG_VORBIS_EMPTY_EOS',
                        format: 'ogg',
                        offset,
                        message: 'Ignoring an empty Vorbis EOS marker at the unchanged final granule',
                    });
                    emptyEos = true;
                    packetIndex++;
                    packetSize = 0;
                    parts = [];
                    continue;
                }
                context.budget.reserveSamples(1, 256, 'Ogg sample index');
                let data;
                if (parts.length > 1) {
                    if (packetSize > 64 * 1024 * 1024 - bufferedBytes)
                        throw new MediaForgeError('Reassembled Ogg packet storage exceeds 64 MiB; split or remux the source', 'OOM');
                    data = combine(parts, packetSize);
                    bufferedBytes += packetSize;
                }
                const prefix = data ?? parts[0].data;
                let duration;
                let timestamp;
                if (codec === 'opus') {
                    duration = opusPacketFrames(prefix, packetSize, true);
                    timestamp = frames - preSkip;
                    frames += duration;
                    pageFrames += duration;
                }
                else {
                    const block = vorbisPacketBlock(prefix, modes, smallBlock, largeBlock);
                    duration = previousBlock === 0 ? block / 2 : (previousBlock + block) / 4;
                    timestamp = previousBlock === 0 ? -duration : frames;
                    if (previousBlock) {
                        frames += duration;
                        pageFrames += duration;
                    }
                    previousBlock = block;
                }
                if (!Number.isSafeInteger(frames))
                    throw new DemuxError('Ogg sample count exceeds exact integer range');
                samples.push({
                    offset: parts[0].offset,
                    size: packetSize,
                    data,
                    timestamp: timestamp / sampleRate,
                    decodeTimestamp: timestamp / sampleRate,
                    duration: duration / sampleRate,
                    isKeyframe: true,
                });
                audioOnPage++;
            }
            packetIndex++;
            packetSize = 0;
            parts = [];
        }
        if (firstPage && (packetIndex !== 1 || continued))
            throw new DemuxError('Ogg BOS page must contain one complete identification header');
        eos = (flags & 4) !== 0;
        if (eos && (continued || (!audioOnPage && !emptyEos)))
            throw new DemuxError('Ogg EOS must complete audio packets');
        if (!completed) {
            if (pageGranule !== null)
                throw new DemuxError('Ogg page without a completed packet must use an unknown granule');
        }
        else if (emptyEos) {
        }
        else if (!audioOnPage) {
            if (pageGranule !== 0)
                throw new DemuxError('Ogg header page must have granule zero');
        }
        else {
            if (firstAudioPage &&
                codec === 'vorbis' &&
                pageGranule !== null &&
                (samples.length >= 2 || pageGranule > 0)) {
                const priming = Math.round(samples[0].duration * sampleRate);
                const origin = eos ? priming : pageGranule - frames;
                const firstOverlap = Math.round((samples[1]?.duration ?? 0) * sampleRate);
                if (origin < -firstOverlap)
                    throw new DemuxError('Initial Vorbis granule trims beyond the first overlap-add span');
                vorbisPriming = priming + Math.max(0, -origin);
                if (origin) {
                    for (const sample of samples) {
                        sample.timestamp += origin / sampleRate;
                        sample.decodeTimestamp = sample.timestamp;
                    }
                    frames += origin;
                }
            }
            if (codec !== 'vorbis' || samples.length >= 2 || (pageGranule ?? 0) > 0)
                firstAudioPage = false;
            if (codec === 'vorbis' &&
                !eos &&
                pageGranule !== null &&
                pageGranule >= granule &&
                Math.abs(pageGranule - frames) === 1) {
                context.diagnostics.recover({
                    code: 'OGG_VORBIS_GRANULE_ROUNDING',
                    format: 'ogg',
                    offset,
                    message: 'Normalizing a one-sample Vorbis page granule rounding discrepancy',
                });
                granule = frames;
                offset += pageSize;
                continue;
            }
            if (pageGranule === null || pageGranule < granule || pageGranule > frames)
                throw new DemuxError('Ogg audio granule is missing, regresses, or exceeds coded duration');
            if (!eos && pageGranule !== frames)
                throw new DemuxError('Nonzero initial Ogg timeline offsets or audio holes require normalization before packet indexing');
            if (eos && frames - pageGranule > pageFrames)
                throw new DemuxError('Ogg EOS trims audio before the final page');
            granule = pageGranule;
        }
        offset += pageSize;
    }
    if (!eos || continued || !samples.length || granule <= preSkip)
        throw new DemuxError('Ogg audio is truncated or has no playable samples');
    return {
        id: 1,
        codec,
        codecConfig: codec === 'opus' ? headers[0] : vorbisCodecConfig(headers),
        sampleRate,
        channelCount: channels,
        timescale: sampleRate,
        width: 0,
        height: 0,
        duration: (granule - preSkip) / sampleRate,
        samples,
        ...(codec === 'opus'
            ? { matroskaCodecDelaySeconds: preSkip / sampleRate, opusTrailingPaddingSamples: frames - granule }
            : { audioTrailingPaddingSamples: frames - granule, audioPrimingSamples: vorbisPriming }),
    };
}
