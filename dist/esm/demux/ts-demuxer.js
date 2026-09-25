import { BlobSource } from '../io/sources.js';
import { ChunkReader } from '../io/chunk-reader.js';
import { demuxAssert, DEMUX_LIMITS, DemuxIndexBudget, resolveDemuxBudget, yieldEventLoop, } from '../core/demux-guard.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { DiagnosticContext } from '../core/diagnostics.js';
import { splitAnnexBNals, buildAvcCFromAnnexB, buildHevcCFromAnnexB } from '../core/annexb.js';
import { parseH264Sps, parseHevcSps, avcCodecStringFromSps } from '../core/video-sps.js';
import { parseMpegAudioHeader } from '../core/mpeg-audio-header.js';
import { buildAacConfig, parseAdtsFrameHeader } from '../audio/adts.js';
import { probeTsLayout } from './ts-layout.js';
export { probeTsLayout } from './ts-layout.js';
const TS_PACKET = 188;
const DOLBY_SAMPLE_RATES = [48000, 44100, 32000];
const DOLBY_CHANNEL_COUNTS = [2, 1, 2, 3, 3, 4, 4, 5];
const AC3_BITRATES_KBPS = [
    32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640,
];
const EAC3_BLOCK_COUNTS = [1, 2, 3, 6];
const MAX_PES_BYTES = 64 * 1024 * 1024;
const MAX_PES_HEADER_BYTES = 264;
const PTS_WRAP = 2 ** 33;
const PTS_WRAP_GUARD = 2 * 90000;
function unwrapTimestamp(raw, previous) {
    return previous === null
        ? raw > PTS_WRAP - PTS_WRAP_GUARD
            ? raw - PTS_WRAP
            : raw
        : raw + Math.round((previous - raw) / PTS_WRAP) * PTS_WRAP;
}
function readPesTimestamp(bytes, offset, prefix) {
    if (bytes[offset] >> 4 !== prefix ||
        (bytes[offset] & 1) === 0 ||
        (bytes[offset + 2] & 1) === 0 ||
        (bytes[offset + 4] & 1) === 0)
        return null;
    return (((bytes[offset] >> 1) & 7) * 2 ** 30 +
        bytes[offset + 1] * 2 ** 22 +
        ((bytes[offset + 2] >> 1) & 127) * 2 ** 15 +
        bytes[offset + 3] * 128 +
        (bytes[offset + 4] >> 1));
}
class PESPacketReader {
    video;
    diagnostics;
    budget;
    onEntry;
    chunks = [];
    size = 0;
    started = false;
    lastCc = -1;
    lastPayload = null;
    lastPayloadStart = false;
    previousDecodeTime = null;
    discontinuity = false;
    entries = [];
    constructor(video, diagnostics, budget, onEntry) {
        this.video = video;
        this.diagnostics = diagnostics;
        this.budget = budget;
        this.onEntry = onEntry;
    }
    read(packet) {
        demuxAssert((packet[3] & 0xc0) === 0, 'TS PES packet is scrambled');
        if ((packet[1] & 0x80) !== 0) {
            this.diagnostics.recover({
                code: 'TS_PES_TRANSPORT_ERROR',
                format: 'ts',
                message: 'TS PES packet has its transport error indicator set; discarded the damaged PES',
            });
            this.discardPending((packet[3] & 15) !== this.lastCc);
            this.lastCc = -1;
            this.lastPayload = null;
            return;
        }
        const control = (packet[3] >> 4) & 3;
        demuxAssert(control !== 0, 'TS PES packet has no adaptation or payload control');
        const hasAdaptation = (control & 2) !== 0;
        const offset = hasAdaptation ? 5 + packet[4] : 4;
        demuxAssert(offset <= TS_PACKET, 'TS PES adaptation field exceeds its packet');
        if (hasAdaptation && packet[4] > 0 && (packet[5] & 0x80) !== 0) {
            this.lastCc = -1;
            this.lastPayload = null;
        }
        if ((control & 1) === 0)
            return;
        if (offset === TS_PACKET) {
            this.diagnostics.recover({
                code: 'TS_EMPTY_PAYLOAD',
                format: 'ts',
                message: 'TS packet declares payload but contains only an adaptation field; ignored empty payload',
            });
        }
        const payload = packet.subarray(offset);
        const start = (packet[1] & 0x40) !== 0;
        const cc = packet[3] & 15;
        if (cc === this.lastCc) {
            if (start !== this.lastPayloadStart ||
                this.lastPayload === null ||
                !bytesEqual(payload, this.lastPayload)) {
                this.diagnostics.recover({
                    code: 'TS_PES_CONTINUITY',
                    format: 'ts',
                    message: 'TS PES continuity counter repeats with different payload bytes; discarded the damaged PES',
                });
                this.discardPending();
                this.lastPayload = payload.slice();
                this.lastPayloadStart = start;
            }
            return;
        }
        if (this.lastCc >= 0 && cc !== ((this.lastCc + 1) & 15)) {
            this.diagnostics.recover({
                code: 'TS_PES_CONTINUITY',
                format: 'ts',
                message: `TS PES continuity counter jumps ${this.lastCc} -> ${cc}; discarded the damaged PES`,
            });
            this.discardPending(true);
        }
        this.lastCc = cc;
        this.lastPayload = payload.slice();
        this.lastPayloadStart = start;
        if (payload.length === 0)
            return;
        if (start) {
            this.flush();
            this.started = true;
        }
        if (!this.started)
            return;
        demuxAssert(this.size <= MAX_PES_BYTES + MAX_PES_HEADER_BYTES - payload.length, 'TS PES payload exceeds the 64 MiB sanity cap');
        this.chunks.push(this.lastPayload);
        this.size += payload.length;
    }
    discardPending(preserveCompleteAudio = false) {
        if (preserveCompleteAudio && !this.video && this.started && this.size >= 9) {
            const header = new Uint8Array(6);
            let offset = 0;
            for (const chunk of this.chunks) {
                const count = Math.min(chunk.length, header.length - offset);
                header.set(chunk.subarray(0, count), offset);
                offset += count;
                if (offset === header.length)
                    break;
            }
            const declaredLength = (header[4] << 8) | header[5];
            if (declaredLength > 0 && declaredLength + 6 === this.size) {
                this.flush();
                this.discontinuity = true;
                return;
            }
        }
        if (this.video && !this.discontinuity && this.entries.length > 0) {
            const prefix = new Uint8Array(Math.min(this.size, MAX_PES_HEADER_BYTES + 4));
            let offset = 0;
            for (const chunk of this.chunks) {
                const count = Math.min(chunk.length, prefix.length - offset);
                prefix.set(chunk.subarray(0, count), offset);
                offset += count;
                if (offset === prefix.length)
                    break;
            }
            const header = 9 + (prefix[8] ?? 0);
            const startsNal = prefix[0] === 0 &&
                prefix[1] === 0 &&
                prefix[2] === 1 &&
                prefix[header] === 0 &&
                prefix[header + 1] === 0 &&
                (prefix[header + 2] === 1 || (prefix[header + 2] === 0 && prefix[header + 3] === 1));
            if (!startsNal)
                this.entries[this.entries.length - 1].incomplete = true;
        }
        this.chunks = [];
        this.size = 0;
        this.started = false;
        this.discontinuity = true;
    }
    malformedPes(message) {
        this.diagnostics.recover({
            code: 'TS_MALFORMED_PES',
            format: 'ts',
            message: `${message}; discarded the damaged PES`,
        });
        this.discardPending();
    }
    flush(discardIncomplete = false) {
        if (!this.started)
            return;
        if (discardIncomplete) {
            this.diagnostics.recover({
                code: 'TS_TRUNCATED_PES',
                format: 'ts',
                message: 'Discarded the pending PES whose transport packet is truncated at end of input',
            });
            this.discardPending();
            return;
        }
        const bytes = this.chunks.length === 1 ? this.chunks[0] : new Uint8Array(this.size);
        if (this.chunks.length > 1) {
            let offset = 0;
            for (const chunk of this.chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
        }
        if (bytes.length < 9 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1) {
            return this.malformedPes('TS PES header is truncated or has an invalid start code');
        }
        if ((bytes[6] & 0xc0) !== 0x80)
            return this.malformedPes('TS PES header has invalid syntax flags');
        const headerLength = 9 + bytes[8];
        const declaredLength = (bytes[4] << 8) | bytes[5];
        if (headerLength > bytes.length)
            return this.malformedPes('TS PES optional header is truncated');
        if (declaredLength !== 0 && declaredLength < headerLength - 6) {
            return this.malformedPes('TS PES length is shorter than its optional header');
        }
        if (declaredLength !== 0 && declaredLength !== bytes.length - 6) {
            return this.malformedPes(`TS PES declares ${declaredLength - headerLength + 6} ES bytes but ${bytes.length - headerLength} arrived`);
        }
        demuxAssert(bytes.length - headerLength <= MAX_PES_BYTES, 'TS PES payload exceeds the 64 MiB sanity cap');
        const flags = bytes[7] >> 6;
        if (flags === 1)
            return this.malformedPes('TS PES timestamp flags are invalid');
        if (bytes[8] < (flags === 3 ? 10 : flags === 2 ? 5 : 0)) {
            return this.malformedPes('TS PES optional header is shorter than its timestamp fields');
        }
        if (headerLength === bytes.length) {
            this.diagnostics.recover({
                code: 'TS_EMPTY_PES',
                format: 'ts',
                message: 'Ignored PES packet containing no elementary stream payload',
            });
            this.chunks = [];
            this.size = 0;
            this.started = false;
            return;
        }
        let pts = 0;
        let dts = 0;
        if (flags >= 2) {
            const rawPts = readPesTimestamp(bytes, 9, flags);
            const rawDts = flags === 3 ? readPesTimestamp(bytes, 14, 1) : rawPts;
            if (rawPts === null || rawDts === null) {
                return this.malformedPes('TS PES timestamp has invalid prefix or marker bits');
            }
            dts = unwrapTimestamp(this.video ? rawDts : rawPts, this.previousDecodeTime);
            this.previousDecodeTime = dts;
            pts = this.video ? unwrapTimestamp(rawPts, dts) : dts;
        }
        this.chunks = [];
        this.size = 0;
        this.started = false;
        const entry = { pts, dts, data: bytes.subarray(headerLength), discontinuity: this.discontinuity };
        if (this.onEntry)
            this.onEntry(entry);
        else {
            this.budget.reserveBytes(256, 'TS PES index');
            this.entries.push(entry);
        }
        this.discontinuity = false;
    }
}
class PSISectionReader {
    data = new Uint8Array(1024);
    used = 0;
    length = 0;
    lastCc = -1;
    lastPayload = null;
    read(pkt) {
        demuxAssert((pkt[1] & 0x80) === 0, 'TS PSI packet has its transport error indicator set');
        demuxAssert((pkt[3] & 0xc0) === 0, 'TS PSI packet is scrambled');
        const control = (pkt[3] >> 4) & 3;
        demuxAssert(control !== 0, 'TS PSI packet has no adaptation or payload control');
        const hasAdapt = (control & 2) !== 0;
        const hasPayload = (control & 1) !== 0;
        const offset = hasAdapt ? 5 + pkt[4] : 4;
        demuxAssert(offset <= TS_PACKET, 'TS PSI adaptation field exceeds its packet');
        const discontinuity = hasAdapt && pkt[4] > 0 && (pkt[5] & 0x80) !== 0;
        if (discontinuity) {
            this.used = 0;
            this.length = 0;
            this.lastCc = -1;
            this.lastPayload = null;
        }
        if (!hasPayload)
            return [];
        demuxAssert(offset < TS_PACKET, 'TS PSI packet declares an empty payload');
        const payload = pkt.subarray(offset);
        const cc = pkt[3] & 15;
        if (cc === this.lastCc) {
            demuxAssert(this.lastPayload !== null && bytesEqual(payload, this.lastPayload), 'TS PSI continuity counter repeats with different payload bytes');
            return [];
        }
        demuxAssert(this.used === 0 || this.lastCc < 0 || cc === ((this.lastCc + 1) & 15), 'TS PSI continuity counter jumps inside a section');
        this.lastCc = cc;
        this.lastPayload = payload.slice();
        const sections = [];
        let start = 0;
        if (pkt[1] & 0x40) {
            start = 1 + payload[0];
            demuxAssert(start <= payload.length, 'TS PSI pointer exceeds its packet payload');
            if (this.used > 0) {
                this.append(payload.subarray(1, start), sections, false);
                demuxAssert(this.used === 0, 'TS PSI pointer interrupts an unfinished section');
            }
            this.append(payload.subarray(start), sections, true);
        }
        else if (this.used > 0) {
            this.append(payload, sections, false);
        }
        return sections;
    }
    append(bytes, sections, mayStart) {
        let offset = 0;
        while (offset < bytes.length) {
            if (this.used === 0 && (!mayStart || bytes[offset] === 0xff))
                return;
            const target = this.length || 3;
            const count = Math.min(target - this.used, bytes.length - offset);
            this.data.set(bytes.subarray(offset, offset + count), this.used);
            this.used += count;
            offset += count;
            if (this.used === 3 && this.length === 0) {
                this.length = 3 + (((this.data[1] & 15) << 8) | this.data[2]);
                demuxAssert(this.length >= 12 && this.length <= this.data.length, 'TS PSI section length is outside the PAT/PMT bounds');
            }
            if (this.used === this.length) {
                sections.push(this.data.slice(0, this.length));
                this.used = 0;
                this.length = 0;
            }
        }
    }
}
function validatePSISection(section) {
    demuxAssert((section[1] & 0xf0) === 0xb0, 'TS PSI section has invalid syntax flags');
    demuxAssert(section[6] <= section[7], 'TS PSI section number exceeds its last section');
    let crc = 0xffffffff;
    for (const byte of section) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit++)
            crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
    }
    demuxAssert(crc === 0, 'TS PSI section CRC is invalid');
}
function validatePSIDescriptors(section, start, end) {
    demuxAssert(end <= section.length - 4, 'TS PMT descriptor loop exceeds its section');
    while (start < end) {
        demuxAssert(start + 2 <= end, 'TS PMT descriptor header is truncated');
        start += 2 + section[start + 1];
        demuxAssert(start <= end, 'TS PMT descriptor exceeds its declared loop');
    }
}
export class TSDemuxer {
    limits;
    constructor(options = {}) {
        this.limits = resolveDemuxBudget(options, 2_000_000);
    }
    async demux(input, signal, diagnostics = new DiagnosticContext()) {
        return this.demuxImpl(input, signal, diagnostics);
    }
    async demuxImpl(input, signal, diagnostics) {
        const budget = new DemuxIndexBudget(this.limits);
        const checkAbort = () => {
            if (signal?.aborted)
                throw new MediaForgeError('Aborted', 'ABORT');
        };
        checkAbort();
        const source = input instanceof Blob ? new BlobSource(input) : input;
        const reader = new ChunkReader(source);
        const size = reader.size;
        const headBytes = await reader.bytes(0, Math.min(size, 2048));
        const layout = probeTsLayout(headBytes);
        if (!layout) {
            throw new DemuxError('MPEG-TS sync byte (0x47) not found in the first 1KB (packet sizes 188/192/204 probed)');
        }
        const stride = layout.stride;
        const payOff = stride === 192 ? 4 : 0;
        const syncOff = layout.off;
        const tailRemainder = (size - syncOff) % stride;
        if (tailRemainder !== 0) {
            diagnostics.recover({
                code: 'TS_TRUNCATED_PACKET',
                format: 'ts',
                offset: size - tailRemainder,
                message: `MPEG-TS length leaves ${tailRemainder} byte(s) past the last whole ${stride}-byte packet - ignored truncated transport tail`,
            });
        }
        let pmtPid = -1;
        let programNumber = -1;
        let pmtSeen = false;
        let videoPid = -1;
        let videoStreamType = 0;
        const audioStreams = new Map();
        const patReader = new PSISectionReader();
        const pmtReader = new PSISectionReader();
        let windowStart = 0;
        let window = new Uint8Array(0);
        let scanned = 0;
        for (let pos = syncOff; pos + stride <= size; pos += stride) {
            if ((scanned & 0x0fff) === 0) {
                await yieldEventLoop();
                checkAbort();
            }
            scanned++;
            if (pmtSeen)
                break;
            if (pos + stride > windowStart + window.length) {
                windowStart = pos;
                window = await reader.bytes(pos, Math.min(stride * 1024, size - pos));
            }
            const pkt = window.subarray(pos - windowStart + payOff, pos - windowStart + payOff + TS_PACKET);
            if (pkt[0] !== 0x47)
                continue;
            const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
            if (pid === 0 && pmtPid < 0) {
                for (const sect of patReader.read(pkt)) {
                    if (sect[0] !== 0 || !(sect[5] & 1))
                        continue;
                    validatePSISection(sect);
                    const end = sect.length - 4;
                    demuxAssert((end - 8) % 4 === 0, 'TS PAT program loop is truncated');
                    for (let off = 8; off < end; off += 4) {
                        const program = (sect[off] << 8) | sect[off + 1];
                        if (program === 0 || pmtPid >= 0)
                            continue;
                        programNumber = program;
                        pmtPid = ((sect[off + 2] & 0x1f) << 8) | sect[off + 3];
                    }
                }
            }
            else if (pid === pmtPid) {
                for (const sect of pmtReader.read(pkt)) {
                    if (sect[0] !== 2 || !(sect[5] & 1) || ((sect[3] << 8) | sect[4]) !== programNumber)
                        continue;
                    validatePSISection(sect);
                    demuxAssert(sect.length >= 16 && sect[6] === 0 && sect[7] === 0, 'TS PMT section header is malformed');
                    const progInfoLen = ((sect[10] & 0x0f) << 8) | sect[11];
                    let off = 12 + progInfoLen;
                    validatePSIDescriptors(sect, 12, off);
                    const endOff = sect.length - 4;
                    while (off < endOff) {
                        demuxAssert(off + 5 <= endOff, 'TS PMT elementary stream header is truncated');
                        const sType = sect[off];
                        const sPid = ((sect[off + 1] & 0x1f) << 8) | sect[off + 2];
                        const esInfoLen = ((sect[off + 3] & 0x0f) << 8) | sect[off + 4];
                        validatePSIDescriptors(sect, off + 5, off + 5 + esInfoLen);
                        const descriptors = sect.subarray(off + 5, off + 5 + esInfoLen);
                        const privateAudioType = sType === 0x06 ? this.resolvePrivateAudioStreamType(descriptors) : 0;
                        if ((sType === 0x1b || sType === 0x24) && videoPid < 0) {
                            videoPid = sPid;
                            videoStreamType = sType;
                        }
                        else if (sType === 0x0f ||
                            sType === 0x11 ||
                            sType === 0x03 ||
                            sType === 0x04 ||
                            sType === 0x81 ||
                            sType === 0x87 ||
                            privateAudioType !== 0) {
                            demuxAssert(!audioStreams.has(sPid), 'TS PMT repeats an audio PID');
                            demuxAssert(audioStreams.size + (videoPid >= 0 ? 1 : 0) < DEMUX_LIMITS.maxTracks, 'TS PMT exceeds the track limit');
                            let language;
                            for (let d = 0; d + 2 <= descriptors.length; d += 2 + descriptors[d + 1]) {
                                if (descriptors[d] === 10 && descriptors[d + 1] >= 4) {
                                    const code = String.fromCharCode(descriptors[d + 2], descriptors[d + 3], descriptors[d + 4]);
                                    if (/^[a-z]{3}$/i.test(code))
                                        language = code.toLowerCase();
                                    break;
                                }
                            }
                            const track = {
                                codec: '',
                                width: 0,
                                height: 0,
                                sampleRate: 0,
                                channelCount: 0,
                                samples: [],
                                duration: 0,
                                language,
                            };
                            const type = privateAudioType || (sType ?? 0);
                            audioStreams.set(sPid, {
                                track,
                                reader: new PESPacketReader(false, diagnostics, budget, entry => this.appendAudioEntry(track, entry, type, budget)),
                            });
                        }
                        off += 5 + esInfoLen;
                    }
                    pmtSeen = true;
                    break;
                }
            }
        }
        if (pmtPid < 0)
            throw new DemuxError('MPEG-TS contains no PAT');
        if (!pmtSeen)
            throw new DemuxError('MPEG-TS PAT points to a PMT that never appears');
        if (videoPid < 0 && audioStreams.size === 0) {
            throw new DemuxError('MPEG-TS PMT declares no supported video or audio stream');
        }
        const videoReader = new PESPacketReader(true, diagnostics, budget);
        demuxAssert(!audioStreams.has(videoPid), 'TS PMT assigns the same PID to video and audio');
        demuxAssert(audioStreams.size + (videoPid >= 0 ? 1 : 0) <= DEMUX_LIMITS.maxTracks, 'TS PMT exceeds the track limit');
        let walked = 0;
        for (let pos = syncOff; pos + stride <= size; pos += stride) {
            if ((walked & 0x0fff) === 0) {
                await yieldEventLoop();
                checkAbort();
            }
            walked++;
            if (pos < windowStart || pos + stride > windowStart + window.length) {
                windowStart = pos;
                window = await reader.bytes(pos, Math.min(stride * 1024, size - pos));
            }
            const packet = window.subarray(pos - windowStart + payOff, pos - windowStart + payOff + TS_PACKET);
            demuxAssert(packet[0] === 0x47, 'TS packet sync byte is invalid');
            const pid = ((packet[1] & 0x1f) << 8) | packet[2];
            if (pid === videoPid)
                videoReader.read(packet);
            else
                audioStreams.get(pid)?.reader.read(packet);
        }
        let truncatedPid = -1;
        let tailStartsPes = false;
        if (tailRemainder >= payOff + 4) {
            const tail = await reader.bytes(size - tailRemainder + payOff, 4);
            if (tail[0] === 0x47) {
                truncatedPid = ((tail[1] & 31) << 8) | tail[2];
                tailStartsPes = (tail[1] & 0x40) !== 0;
            }
        }
        videoReader.flush(tailRemainder > 0 && !tailStartsPes && (truncatedPid < 0 || truncatedPid === videoPid));
        for (const [pid, stream] of audioStreams)
            stream.reader.flush(tailRemainder > 0 && !tailStartsPes && (truncatedPid < 0 || truncatedPid === pid));
        checkAbort();
        const videoPES = this.joinVideoContinuations(videoReader.entries);
        demuxAssert(videoPid < 0 || videoPES.length > 0, 'PMT declares a video stream but no video packets were found');
        for (const stream of audioStreams.values())
            demuxAssert(stream.track.samples.length > 0, 'PMT declares an audio stream but no audio packets were found');
        const shiftTicks = 0;
        const result = { videoTracks: [], audioTracks: [] };
        if (videoPES.length > 0) {
            result.videoTracks.push(videoStreamType === 0x24
                ? this.buildH265Track(videoPES, shiftTicks, budget)
                : this.buildH264Track(videoPES, shiftTicks, budget));
        }
        for (const stream of audioStreams.values())
            result.audioTracks.push(stream.track);
        const totalDuration = Math.max(...result.videoTracks.map(t => t.duration), ...result.audioTracks.map(t => t.duration), 0);
        for (const t of result.videoTracks)
            t.duration = totalDuration;
        for (const t of result.audioTracks)
            t.duration = totalDuration;
        logger.info(`[TSDemuxer] video=${result.videoTracks[0]?.samples.length ?? 0}, audio=${result.audioTracks[0]?.samples.length ?? 0}`);
        return result;
    }
    joinVideoContinuations(entries) {
        const joined = [];
        let parts = [];
        let size = 0;
        let tail = new Uint8Array(0);
        const flush = () => {
            if (parts.length > 1) {
                const data = new Uint8Array(size);
                let offset = 0;
                for (const part of parts) {
                    data.set(part, offset);
                    offset += part.length;
                }
                joined[joined.length - 1].data = data;
            }
            else if (parts.length === 1) {
                joined[joined.length - 1].data = parts[0];
            }
            parts = [];
            size = 0;
        };
        for (const entry of entries) {
            if (entry.discontinuity) {
                flush();
                tail = new Uint8Array(0);
            }
            let trailingZeros = 0;
            while (trailingZeros < 3 && tail[tail.length - 1 - trailingZeros] === 0)
                trailingZeros++;
            const trailingStartCode = tail.length >= 3 &&
                tail[tail.length - 1] === 1 &&
                tail[tail.length - 2] === 0 &&
                tail[tail.length - 3] === 0
                ? tail.length === 4 && tail[0] === 0
                    ? 4
                    : 3
                : 0;
            let leadingZeros = 0;
            while (leadingZeros < 3 && entry.data[leadingZeros] === 0)
                leadingZeros++;
            const carry = trailingStartCode || trailingZeros;
            const crossesBoundary = trailingStartCode > 0 ||
                (trailingZeros > 0 && trailingZeros + leadingZeros >= 2 && entry.data[leadingZeros] === 1);
            let start = 0;
            while (!crossesBoundary && start + 3 <= entry.data.length) {
                if (entry.data[start] === 0 &&
                    entry.data[start + 1] === 0 &&
                    (entry.data[start + 2] === 1 || (entry.data[start + 2] === 0 && entry.data[start + 3] === 1)))
                    break;
                start++;
            }
            if (!crossesBoundary && start + 3 > entry.data.length)
                start = entry.data.length;
            if (crossesBoundary) {
                const pending = parts.length > 0;
                let trim = pending ? carry : 0;
                while (trim > 0) {
                    const part = parts.pop();
                    const count = Math.min(trim, part.length);
                    if (part.length > count)
                        parts.push(part.subarray(0, part.length - count));
                    trim -= count;
                    size -= count;
                }
                if (pending && size === 0)
                    joined.pop();
                flush();
                demuxAssert(entry.data.length <= MAX_PES_BYTES - carry, 'TS video access unit exceeds the 64 MiB sanity cap');
                joined.push({ ...entry });
                parts.push(tail.slice(tail.length - carry), entry.data);
                size = carry + entry.data.length;
            }
            else if (start > 0 && parts.length > 0) {
                demuxAssert(size <= MAX_PES_BYTES - start, 'TS video access unit exceeds the 64 MiB sanity cap');
                parts.push(entry.data.subarray(0, start));
                size += start;
            }
            if (!crossesBoundary && start < entry.data.length) {
                flush();
                const data = entry.data.subarray(start);
                joined.push({ ...entry, data });
                parts.push(data);
                size = data.length;
            }
            const nextTail = new Uint8Array(Math.min(4, tail.length + entry.data.length));
            const carried = Math.max(0, nextTail.length - entry.data.length);
            nextTail.set(tail.subarray(tail.length - carried));
            nextTail.set(entry.data.subarray(Math.max(0, entry.data.length - nextTail.length)), carried);
            tail = nextTail;
            if (entry.incomplete) {
                if (parts.length > 0)
                    joined.pop();
                parts = [];
                size = 0;
                tail = new Uint8Array(0);
            }
        }
        flush();
        return joined;
    }
    buildH264Track(pes, shiftTicks, budget) {
        let sps = null;
        let pps = null;
        for (const entry of pes) {
            for (const nal of splitAnnexBNals(entry.data)) {
                const type = nal[0] & 0x1f;
                if (type === 7 && !sps)
                    sps = nal;
                else if (type === 8 && !pps)
                    pps = nal;
            }
            if (sps && pps)
                break;
        }
        if (!sps || !pps) {
            throw new DemuxError('H.264 TS stream carries no SPS/PPS; it cannot be decoded or copied');
        }
        const paramBlob = new Uint8Array(4 + sps.length + 4 + pps.length);
        paramBlob[3] = 1;
        paramBlob.set(sps, 4);
        paramBlob[4 + sps.length + 3] = 1;
        paramBlob.set(pps, 4 + sps.length + 4);
        const avcC = buildAvcCFromAnnexB(paramBlob);
        if (!avcC)
            throw new DemuxError('H.264 TS stream: SPS/PPS could not be assembled into avcC');
        const dims = parseH264Sps(sps);
        if (!dims)
            throw new DemuxError('H.264 TS stream: SPS does not parse');
        const codec = avcCodecStringFromSps(sps);
        const durations = this.decodeDurations(pes);
        const samples = [];
        for (let i = 0; i < pes.length; i++) {
            const entry = pes[i];
            const nals = splitAnnexBNals(entry.data);
            let isKey = false;
            let hasVcl = false;
            const kept = [];
            for (const nal of nals) {
                const type = nal[0] & 0x1f;
                if (type === 9 || type === 12)
                    continue;
                if (type === 7 && sps && bytesEqual(nal, sps))
                    continue;
                if (type === 8 && pps && bytesEqual(nal, pps))
                    continue;
                if (type === 5)
                    isKey = true;
                if (type >= 1 && type <= 5)
                    hasVcl = true;
                kept.push(nal);
            }
            if (!hasVcl)
                continue;
            budget.reserveSamples(1, 256, 'TS video sample index');
            let total = 0;
            for (const nal of kept)
                total += 4 + nal.length;
            const avcc = new Uint8Array(total);
            let off = 0;
            for (const nal of kept) {
                avcc[off] = (nal.length >>> 24) & 0xff;
                avcc[off + 1] = (nal.length >>> 16) & 0xff;
                avcc[off + 2] = (nal.length >>> 8) & 0xff;
                avcc[off + 3] = nal.length & 0xff;
                avcc.set(nal, off + 4);
                off += 4 + nal.length;
            }
            const dts = (entry.dts - shiftTicks) / 90000;
            const ptsSec = (entry.pts - shiftTicks) / 90000;
            samples.push({
                offset: 0,
                size: avcc.length,
                timestamp: ptsSec,
                duration: durations[i],
                isKeyframe: isKey,
                decodeTimestamp: dts,
                compositionTimeOffset: ptsSec - dts,
                data: avcc,
            });
        }
        demuxAssert(samples.length > 0, 'H.264 TS stream contains no access units');
        const last = samples[samples.length - 1];
        return {
            codec,
            width: dims.width,
            height: dims.height,
            displayWidth: dims.displayWidth,
            displayHeight: dims.displayHeight,
            pixelAspectRatioNum: dims.pixelAspectRatioNum,
            pixelAspectRatioDen: dims.pixelAspectRatioDen,
            sampleRate: 0,
            channelCount: 0,
            duration: (last.decodeTimestamp ?? last.timestamp) + last.duration,
            samples,
            codecConfig: avcC,
        };
    }
    buildH265Track(pes, shiftTicks, budget) {
        let sps = null;
        const parameterSets = new Map();
        for (const entry of pes) {
            for (const nal of splitAnnexBNals(entry.data)) {
                const type = (nal[0] >> 1) & 0x3f;
                if (type >= 32 && type <= 34 && !parameterSets.has(type))
                    parameterSets.set(type, nal);
                if (type === 33 && !sps)
                    sps = nal;
            }
            if (parameterSets.size === 3)
                break;
        }
        if (!sps)
            throw new DemuxError('H.265 TS stream carries no SPS; it cannot be decoded');
        const parameterBytes = new Uint8Array([...parameterSets.values()].reduce((size, nal) => size + 4 + nal.length, 0));
        let parameterOffset = 0;
        for (const nal of parameterSets.values()) {
            parameterBytes[parameterOffset + 3] = 1;
            parameterBytes.set(nal, parameterOffset + 4);
            parameterOffset += 4 + nal.length;
        }
        const codecConfig = buildHevcCFromAnnexB(parameterBytes) ?? undefined;
        const parsed = parseHevcSps(sps);
        if (!parsed)
            throw new DemuxError('H.265 TS stream: SPS does not parse');
        const durations = this.decodeDurations(pes);
        const samples = [];
        for (let i = 0; i < pes.length; i++) {
            const entry = pes[i];
            let isKey = false;
            for (const nal of splitAnnexBNals(entry.data)) {
                const type = (nal[0] >> 1) & 0x3f;
                if (type === 19 || type === 20 || type === 21) {
                    isKey = true;
                    break;
                }
            }
            budget.reserveSamples(1, 256, 'TS video sample index');
            const dts = (entry.dts - shiftTicks) / 90000;
            const ptsSec = (entry.pts - shiftTicks) / 90000;
            samples.push({
                offset: 0,
                size: entry.data.length,
                timestamp: ptsSec,
                duration: durations[i],
                isKeyframe: isKey,
                decodeTimestamp: dts,
                compositionTimeOffset: ptsSec - dts,
                data: entry.data,
            });
        }
        const last = samples[samples.length - 1];
        return {
            codec: parsed.codec,
            codecConfig,
            width: parsed.width,
            height: parsed.height,
            sampleRate: 0,
            channelCount: 0,
            duration: (last.decodeTimestamp ?? last.timestamp) + last.duration,
            samples,
        };
    }
    decodeDurations(pes) {
        const deltas = [];
        for (let i = 1; i < pes.length; i++) {
            const d = (pes[i].dts - pes[i - 1].dts) / 90000;
            if (d > 0 && d <= 10)
                deltas.push(d);
        }
        const sorted = [...deltas].sort((a, b) => a - b);
        const median = sorted.length > 0 ? sorted[sorted.length >> 1] : 1 / 30;
        const out = new Array(pes.length);
        for (let i = 0; i < pes.length; i++) {
            const d = i + 1 < pes.length ? (pes[i + 1].dts - pes[i].dts) / 90000 : median;
            out[i] = d > 0 && d <= 10 ? d : median;
        }
        return out;
    }
    appendAudioEntry(track, entry, streamType, budget) {
        const parsed = this.splitAudioFrames(streamType, entry.data, budget);
        demuxAssert(track.samples.length === 0 ||
            (track.codec === parsed.codec &&
                track.sampleRate === parsed.sampleRate &&
                track.channelCount === parsed.channelCount), 'TS audio configuration changes between PES packets');
        track.codec = parsed.codec;
        track.sampleRate = parsed.sampleRate;
        track.channelCount = parsed.channelCount;
        track.codecConfig ??= parsed.codecConfig;
        let timestamp = entry.pts / 90000;
        for (const frame of parsed.frames) {
            track.samples.push({
                offset: 0,
                size: frame.data.length,
                timestamp,
                duration: frame.duration,
                isKeyframe: true,
                data: frame.data,
            });
            timestamp += frame.duration;
        }
        track.duration = timestamp;
    }
    resolvePrivateAudioStreamType(descriptors) {
        let offset = 0;
        while (offset + 2 <= descriptors.length) {
            const tag = descriptors[offset];
            const length = descriptors[offset + 1];
            const end = offset + 2 + length;
            if (end > descriptors.length)
                break;
            if (tag === 0x6a)
                return 0x81;
            if (tag === 0x7a)
                return 0x87;
            if (tag === 0x05 && length >= 4) {
                const registration = String.fromCharCode(descriptors[offset + 2], descriptors[offset + 3], descriptors[offset + 4], descriptors[offset + 5]);
                if (registration === 'AC-3')
                    return 0x81;
                if (registration === 'EAC3')
                    return 0x87;
            }
            offset = end;
        }
        return 0;
    }
    splitAudioFrames(streamType, data, budget) {
        if (streamType === 0x11)
            throw new DemuxError('TS AAC LATM framing is not supported');
        if (streamType === 0x0f)
            return this.splitAdtsFrames(data, budget);
        if (streamType === 0x81 || streamType === 0x87)
            return this.splitAc3Frames(streamType, data, budget);
        return this.splitMpegAudioFrames(data, budget);
    }
    splitAdtsFrames(data, budget) {
        const first = parseAdtsFrameHeader(data);
        demuxAssert(first !== null, 'TS AAC PES payload starts with an invalid ADTS header');
        demuxAssert(first.channels > 0, 'TS AAC program-config-element channel layouts are not supported');
        const { sampleRate, channels: channelCount, audioObjectType } = first;
        const frames = [];
        let offset = 0;
        while (offset < data.length) {
            const header = parseAdtsFrameHeader(data, offset);
            demuxAssert(header !== null, `ADTS header at PES offset ${offset} is truncated or invalid`);
            demuxAssert(header.rawDataBlocks === 0, 'TS ADTS frames with multiple raw data blocks are not supported');
            demuxAssert(header.sampleRate === sampleRate &&
                header.channels === channelCount &&
                header.audioObjectType === audioObjectType, 'TS AAC configuration changes inside a PES');
            demuxAssert(header.frameLength <= data.length - offset, `ADTS frame at PES offset ${offset} is truncated`);
            budget.reserveSamples(1, 256, 'TS audio sample index');
            frames.push({
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
    splitMpegAudioFrames(data, budget) {
        const first = parseMpegAudioHeader(data, 0);
        demuxAssert(first !== null, 'TS MPEG audio PES has an invalid frame header');
        const codec = first.format;
        const sampleRate = first.sampleRate;
        const channelCount = first.channels;
        const frames = [];
        let offset = 0;
        while (offset < data.length) {
            const header = parseMpegAudioHeader(data, offset);
            demuxAssert(header !== null, `TS MPEG audio header at PES offset ${offset} is truncated or invalid`);
            demuxAssert(header.format === codec && header.sampleRate === sampleRate && header.channels === channelCount, 'TS MPEG audio format changes inside a PES');
            demuxAssert(header.frameLength <= data.length - offset, `TS MPEG audio frame at PES offset ${offset} is truncated`);
            budget.reserveSamples(1, 256, 'TS audio sample index');
            frames.push({
                data: data.subarray(offset, offset + header.frameLength),
                duration: header.samplesPerFrame / sampleRate,
            });
            offset += header.frameLength;
        }
        return { codec, sampleRate, channelCount, frames };
    }
    splitAc3Frames(streamType, data, budget) {
        const frames = [];
        let sampleRate = 0;
        let channelCount = 0;
        let offset = 0;
        while (offset < data.length) {
            demuxAssert(data.length - offset >= 7 && data[offset] === 0x0b && data[offset + 1] === 0x77, 'TS Dolby audio frame header is truncated or invalid');
            const bitstreamId = data[offset + 5] >> 3;
            const rateCode = data[offset + 4] >> 6;
            let frameBytes;
            let rate;
            let channels;
            let samples = 1536;
            if (streamType === 0x87) {
                demuxAssert(bitstreamId > 10 && bitstreamId <= 16, 'TS EAC3 bitstream identifier is invalid');
                const streamTypeCode = data[offset + 2] >> 6;
                const substreamId = (data[offset + 2] >> 3) & 7;
                demuxAssert((streamTypeCode === 0 || streamTypeCode === 2) && substreamId === 0, 'TS EAC3 dependent or additional substreams are not supported');
                frameBytes = ((((data[offset + 2] & 7) << 8) | data[offset + 3]) + 1) * 2;
                const secondaryCode = (data[offset + 4] >> 4) & 3;
                if (rateCode === 3) {
                    demuxAssert(secondaryCode < 3, 'TS EAC3 reduced sample rate is invalid');
                    rate = DOLBY_SAMPLE_RATES[secondaryCode] / 2;
                }
                else {
                    rate = DOLBY_SAMPLE_RATES[rateCode];
                    samples = EAC3_BLOCK_COUNTS[secondaryCode] * 256;
                }
                channels = DOLBY_CHANNEL_COUNTS[(data[offset + 4] >> 1) & 7] + (data[offset + 4] & 1);
            }
            else {
                demuxAssert(bitstreamId <= 10 && rateCode < 3, 'TS AC3 bitstream identifier or sample rate is invalid');
                const sizeCode = data[offset + 4] & 63;
                demuxAssert(sizeCode <= 37, 'TS AC3 frame size code is invalid');
                const bitrate = AC3_BITRATES_KBPS[sizeCode >> 1];
                const words = rateCode === 0
                    ? bitrate * 2
                    : rateCode === 2
                        ? bitrate * 3
                        : Math.floor((bitrate * 320) / 147) + (sizeCode & 1);
                frameBytes = words * 2;
                rate = DOLBY_SAMPLE_RATES[rateCode] / 2 ** Math.max(0, bitstreamId - 8);
                const channelMode = data[offset + 6] >> 5;
                let lfeBit = 4;
                if ((channelMode & 1) !== 0 && channelMode !== 1)
                    lfeBit -= 2;
                if ((channelMode & 4) !== 0)
                    lfeBit -= 2;
                if (channelMode === 2)
                    lfeBit -= 2;
                channels = DOLBY_CHANNEL_COUNTS[channelMode] + ((data[offset + 6] >> lfeBit) & 1);
            }
            demuxAssert(frameBytes >= 7 && frameBytes <= data.length - offset, 'TS Dolby audio frame length is invalid or truncated');
            demuxAssert(frames.length === 0 || (sampleRate === rate && channelCount === channels), 'TS Dolby audio configuration changes inside a PES');
            sampleRate = rate;
            channelCount = channels;
            budget.reserveSamples(1, 256, 'TS audio sample index');
            frames.push({ data: data.subarray(offset, offset + frameBytes), duration: samples / sampleRate });
            offset += frameBytes;
        }
        return { codec: streamType === 0x87 ? 'ec-3' : 'ac-3', sampleRate, channelCount, frames };
    }
}
function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
