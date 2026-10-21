import type { Sample } from '../../../core/model/track';
import { DemuxError, throwIfAborted } from '../../../core/errors/errors';
import { malformedInput } from '../../../core/errors/demux-guard';
import { yieldEventLoop } from '../../../core/io/event-loop';
import { parseMpegAudioHeader } from '../../../core/codec-config/audio/mpeg-audio-header';
import { readU32, type Box } from './boxes';
import { shiftedSeconds } from './sample-index';
import {
    chunkAudioPacketCount,
    chunkAudioUnitsPerPacket,
    type Mp4ReadContext,
} from './descriptions';
import type { ChunkAudioUnit } from './read-types';

/**
 * Sound whose sample tables count single samples (one stts run of duration 1) is read like ffmpeg
 * reads it: the chunk layout holds whole units (frames of uncompressed audio, packets of a
 * version-1 description), grouped into packets of chunkAudioUnitsPerPacket units within each chunk.
 * The stsz size of such tracks is a per-sample placeholder, so the unit size of the sample
 * description decides the byte ranges. `end` is the coded end in seconds; `recovered` is true when
 * units past the media were dropped. Undefined when the chunks do not hold whole units.
 */
export async function chunkAudioPackets(
    context: Mp4ReadContext,
    dv: DataView,
    stsz: Box,
    stsc: Box,
    stco: Box,
    unit: ChunkAudioUnit,
    timescale: number,
    shift: number,
): Promise<{ samples: Sample[]; end: number; recovered: boolean } | undefined> {
    const { budget, signal } = context;
    const packetCount = chunkAudioPacketCount(dv, stsc, stco, unit.samples);
    if (packetCount === undefined) return undefined;
    budget.checkSamples(packetCount, 'MP4 sample table');
    if (context.compactClassic) budget.reserveBytes(packetCount * 256, 'MP4 classic sample tables');
    const constant = readU32(dv, stsz.offset + 12);
    const chunkCount = readU32(dv, stco.offset + 12);
    const entries = readU32(dv, stsc.offset + 12);
    const wide = stco.type === 'co64';
    const unitsPerPacket = chunkAudioUnitsPerPacket(unit.samples);
    const samples: Sample[] = [];
    let entry = 0;
    let decodeTime = 0;
    let missingUnits = 0;
    let retainedUnits = 0;
    let firstMissing = 0;
    for (let chunk = 0; chunk < chunkCount; chunk++) {
        if ((chunk & 0xfff) === 0) {
            await yieldEventLoop();
            throwIfAborted(signal);
        }
        while (entry + 1 < entries && readU32(dv, stsc.offset + 28 + entry * 12) <= chunk + 1)
            entry++;
        let units = readU32(dv, stsc.offset + 20 + entry * 12) / unit.samples;
        let offset = wide
            ? readU32(dv, stco.offset + 16 + chunk * 8) * 0x100000000 +
              readU32(dv, stco.offset + 20 + chunk * 8)
            : readU32(dv, stco.offset + 16 + chunk * 4);
        if (!Number.isSafeInteger(offset + units * unit.bytes))
            malformedInput(`chunk ${chunk} has an invalid byte range`);
        while (units > 0) {
            const count = unit.mpegFrames ? units : Math.min(unitsPerPacket, units);
            let kept = count;
            if (!context.fitsMedia(offset, count * unit.bytes)) {
                if (context.validation === 'strict')
                    throw new DemuxError(
                        `sample ${samples.length} spans ${offset}+${count * unit.bytes} past EOF`,
                    );

                // The media ends inside this packet: keep the whole units before the cut.
                let low = 0;
                let high = count - 1;
                while (low < high) {
                    const middle = (low + high + 1) >>> 1;
                    if (context.fitsMedia(offset, middle * unit.bytes)) low = middle;
                    else high = middle - 1;
                }
                kept = low;
                if (!missingUnits) firstMissing = offset + kept * unit.bytes;
                missingUnits += count - kept;
            }
            if (kept > 0 && unit.mpegFrames) {
                await pushMpegAudioFrames(
                    context,
                    samples,
                    offset,
                    kept * unit.bytes,
                    shiftedSeconds(decodeTime, timescale, shift),
                    (kept * unit.samples) / timescale,
                );
                retainedUnits += kept;
            } else if (kept > 0) {
                samples.push({
                    offset,
                    size: kept * unit.bytes,
                    timestamp: shiftedSeconds(decodeTime, timescale, shift),
                    duration: (kept * unit.samples) / timescale,
                    isKeyframe: true,
                });
                retainedUnits += kept;
            }
            offset += count * unit.bytes;
            decodeTime += count * unit.samples;
            units -= count;
        }
    }
    if (unit.mpegFrames) budget.checkSamples(samples.length, 'MP4 sample table');
    if (constant !== unit.bytes && unit.samples === 1)
        context.note({
            code: 'MP4_PCM_FRAME_LAYOUT',
            format: 'mp4',
            message: 'Read uncompressed audio frames from the chunk layout, not the size table',
        });
    if (missingUnits > 0)
        context.recover({
            code: 'MP4_TRUNCATED_SAMPLES',
            message: `Dropped ${missingUnits} incomplete or missing audio units`,
            format: 'mp4',
            offset: firstMissing,
        });
    return { samples, end: decodeTime / timescale, recovered: missingUnits > 0 };
}

/**
 * Packets of the MPEG audio frames of one chunk (`size` bytes at `offset`, `duration` seconds from
 * `start`), timed by their headers. Bytes from the first that do not begin a complete frame stay
 * one packet that ends the chunk, which the decoder then conceals.
 */
async function pushMpegAudioFrames(
    context: Mp4ReadContext,
    samples: Sample[],
    offset: number,
    size: number,
    start: number,
    duration: number,
): Promise<void> {
    const bytes = await context.source.read(offset, size);
    let at = 0;
    let frames = 0;
    let rate = 0;

    while (at < bytes.length) {
        const header = parseMpegAudioHeader(bytes, at);
        const timestamp = rate ? start + frames / rate : start;
        if (
            !header ||
            header.frameLength > bytes.length - at ||
            (rate && header.sampleRate !== rate)
        ) {
            const rest = Math.max(0, start + duration - timestamp);
            samples.push({
                offset: offset + at,
                size: bytes.length - at,
                timestamp,
                duration: rest,
                isKeyframe: true,
            });
            return;
        }

        rate = header.sampleRate;
        samples.push({
            offset: offset + at,
            size: header.frameLength,
            timestamp,
            duration: header.samplesPerFrame / rate,
            isKeyframe: true,
        });
        at += header.frameLength;
        frames += header.samplesPerFrame;
    }
}
