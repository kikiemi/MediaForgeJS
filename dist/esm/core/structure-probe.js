import { inflateBounded } from './inflate.js';
import { BlobSource } from '../io/sources.js';
import { demuxStandaloneAudio } from '../demux/standalone-audio-demuxer.js';
import { ChunkReader } from '../io/chunk-reader.js';
import { decodeAacFrameForProbe } from '../audio/aac-decoder.js';
import { DemuxError, MediaForgeError } from '../core/errors.js';
import { flacCrc16, MAX_FLAC_FRAME_HEADER_BYTES, parseFlacFrameHeader } from './flac-frame.js';
import { oggCrc32 } from './ogg-crc.js';
import { yieldEventLoop } from './demux-guard.js';
import { isMpegAudioTrailerHeader, parseMpegAudioHeader } from './mpeg-audio-header.js';
const PROBE_YIELD = 4096;
export async function probeStructure(input, fmt, signal) {
    const source = input instanceof Blob ? new BlobSource(input) : input;
    const reader = new ChunkReader(source);
    const checkAbort = () => {
        if (signal?.aborted)
            throw new MediaForgeError('Aborted', 'ABORT');
    };
    switch (fmt) {
        case 'wav':
            return probeWav(reader, checkAbort);
        case 'aiff':
        case 'au':
        case 'caf':
            await demuxStandaloneAudio(source, { format: fmt, signal });
            return;
        case 'flac':
            return probeFlac(reader, checkAbort);
        case 'ogg':
            return probeOgg(reader, checkAbort);
        case 'mp3':
        case 'mp2':
            return probeMpegAudio(reader, fmt);
        case 'aac':
            return probeAdts(reader, checkAbort);
        case 'png':
        case 'apng':
            return probePng(reader, checkAbort);
        case 'jpeg':
            return probeJpeg(reader);
        case 'gif':
            return probeGif(reader, checkAbort);
        case 'webp':
            return probeWebp(reader);
        case 'bmp':
            return probeBmp(reader);
        case 'tiff':
            return probeTiff(reader);
        case 'ico':
            return probeIco(reader, checkAbort);
        default:
            return;
    }
}
function fail(fmt, detail) {
    throw new DemuxError(`${fmt} structure invalid: ${detail}`);
}
async function u32be(reader, off) {
    const b = await reader.bytes(off, 4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}
async function u32le(reader, off) {
    const b = await reader.bytes(off, 4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}
function tag(b, off) {
    return String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
}
async function probeWav(reader, checkAbort) {
    checkAbort();
    const size = reader.size;
    if (size < 44)
        fail('WAV', `file is ${size} bytes, smaller than any RIFF/WAVE header`);
    const head = await reader.bytes(0, 12);
    const isRf64 = tag(head, 0) === 'RF64';
    if ((tag(head, 0) !== 'RIFF' && !isRf64) || tag(head, 8) !== 'WAVE') {
        fail('WAV', 'missing RIFF/WAVE header');
    }
    const declared = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true);
    let end = declared + 8;
    let pos = 12;
    let rf64DataSize = -1;
    if (isRf64) {
        const dsHdr = await reader.bytes(12, 8);
        if (tag(dsHdr, 0) !== 'ds64')
            fail('WAV', 'RF64 file without a leading ds64 chunk');
        const dsLen = new DataView(dsHdr.buffer, dsHdr.byteOffset, dsHdr.byteLength).getUint32(4, true);
        if (dsLen < 28 || 20 + dsLen > size)
            fail('WAV', 'ds64 chunk truncated');
        const ds = await reader.bytes(20, 28);
        const view = new DataView(ds.buffer, ds.byteOffset, ds.byteLength);
        if (view.getUint32(24, true) > Math.floor((dsLen - 28) / 12)) {
            fail('WAV', 'ds64 table extends beyond its chunk');
        }
        rf64DataSize = Number(view.getBigUint64(8, true));
        if (declared === 0xffffffff)
            end = Number(view.getBigUint64(0, true)) + 8;
        pos = 20 + dsLen + (dsLen & 1);
    }
    else if (declared === 0xffffffff) {
        fail('WAV', 'RIFF size sentinel requires RF64 ds64 metadata');
    }
    if (!Number.isSafeInteger(end) || end < pos || end > size + 1) {
        const field = isRf64 && declared === 0xffffffff ? 'ds64' : 'RIFF';
        fail('WAV', `${field} declares ${end} bytes but the file has ${size}`);
    }
    let chunkCount = 0;
    let sawFmt = false;
    let wavBlockAlign = 0;
    let linearPcm = false;
    let wavDataLen = -1;
    let sawData = false;
    while (pos < end) {
        checkAbort();
        if (pos + 8 > Math.min(end, size))
            fail('WAV', `chunk header at ${pos} is truncated`);
        if (++chunkCount > 4096) {
            fail('WAV', `more than 4096 RIFF chunks scanned - chunk flood or corrupt sizes`);
        }
        if ((chunkCount & 255) === 0) {
            await new Promise(resolve => {
                setTimeout(resolve, 0);
            });
            checkAbort();
        }
        const hdr = await reader.bytes(pos, 8);
        const id = tag(hdr, 0);
        let len = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength).getUint32(4, true);
        if (len === 0xffffffff) {
            if (id !== 'data' || rf64DataSize < 0 || !Number.isSafeInteger(rf64DataSize)) {
                fail('WAV', `chunk '${id}' has no supported RF64 size declaration`);
            }
            len = rf64DataSize;
        }
        if (len > end - pos - 8 || len > size - pos - 8) {
            fail('WAV', `chunk '${id}' declares ${len} bytes at ${pos} beyond the RIFF container or file`);
        }
        if (id === 'fmt ') {
            if (sawFmt)
                fail('WAV', 'multiple fmt chunks are not supported');
            if (len < 16)
                fail('WAV', `fmt chunk is ${len} bytes (need at least 16)`);
            const fmt = await reader.bytes(pos + 8, Math.min(len, 40));
            let formatTag = fmt[0] | (fmt[1] << 8);
            const channels = fmt[2] | (fmt[3] << 8);
            const rate = (fmt[4] | (fmt[5] << 8) | (fmt[6] << 16) | (fmt[7] << 24)) >>> 0;
            const byteRate = (fmt[8] | (fmt[9] << 8) | (fmt[10] << 16) | (fmt[11] << 24)) >>> 0;
            const blockAlign = fmt[12] | (fmt[13] << 8);
            const bits = fmt[14] | (fmt[15] << 8);
            if (formatTag === 0xfffe) {
                if (len < 40)
                    fail('WAV', `WAVE_FORMAT_EXTENSIBLE fmt chunk is ${len} bytes (need 40)`);
                const cbSize = fmt[16] | (fmt[17] << 8);
                if (cbSize < 22)
                    fail('WAV', `WAVE_FORMAT_EXTENSIBLE cbSize ${cbSize} (need 22)`);
                if (cbSize > len - 18)
                    fail('WAV', 'WAVE_FORMAT_EXTENSIBLE cbSize exceeds the fmt chunk');
                const view = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
                formatTag = view.getUint32(24, true);
                if (view.getUint32(28, true) !== 0x00100000 ||
                    view.getUint32(32, true) !== 0xaa000080 ||
                    view.getUint32(36, true) !== 0x719b3800) {
                    fail('WAV', 'unsupported WAVE_FORMAT_EXTENSIBLE subformat GUID');
                }
                const validBits = view.getUint16(18, true);
                if (((formatTag === 1 || formatTag === 3) && validBits > bits) ||
                    (formatTag === 1 && validBits === 0) ||
                    (formatTag === 3 && validBits !== 0 && validBits !== bits)) {
                    fail('WAV', 'WAVE_FORMAT_EXTENSIBLE valid bits contradict the sample container');
                }
            }
            const KNOWN_TAGS = [1, 2, 3, 6, 7, 0x11, 0x55];
            if (!KNOWN_TAGS.includes(formatTag)) {
                fail('WAV', `unknown format tag 0x${formatTag.toString(16)} - cannot verify this codec`);
            }
            if (channels < 1 || channels > 64)
                fail('WAV', `fmt chunk declares ${channels} channels`);
            if (rate < 1 || rate > 3000000)
                fail('WAV', `fmt chunk declares ${rate} Hz`);
            if (blockAlign === 0)
                fail('WAV', 'fmt chunk declares blockAlign 0');
            if (formatTag === 1 || formatTag === 3) {
                if (bits === 0 || bits > 64 || bits % 8 !== 0) {
                    fail('WAV', `fmt chunk declares ${bits} bits per sample`);
                }
                const expectAlign = (bits >> 3) * channels;
                if (blockAlign !== expectAlign) {
                    fail('WAV', `blockAlign ${blockAlign} does not match ${channels}ch x ${bits}-bit (${expectAlign})`);
                }
                if (byteRate !== rate * expectAlign) {
                    fail('WAV', `byteRate ${byteRate} does not match ${rate} Hz x blockAlign ${expectAlign}`);
                }
            }
            linearPcm = formatTag === 1 || formatTag === 3;
            wavBlockAlign = blockAlign;
            sawFmt = true;
        }
        if (id === 'data') {
            if (sawData)
                fail('WAV', 'multiple data chunks are not supported');
            if (wavBlockAlign > 0 && len % wavBlockAlign !== 0) {
                fail('WAV', `data chunk is ${len} bytes, not a multiple of blockAlign ${wavBlockAlign}`);
            }
            wavDataLen = len;
            sawData = true;
        }
        pos += 8 + len + (len & 1);
        if (pos > end)
            fail('WAV', 'chunk padding extends beyond the RIFF container');
    }
    checkAbort();
    if (!sawFmt)
        fail('WAV', 'no fmt chunk');
    if (!sawData)
        fail('WAV', 'no data chunk');
    if (wavDataLen === 0 && !linearPcm)
        fail('WAV', 'compressed data chunk is empty');
    if (wavBlockAlign > 0 && wavDataLen >= 0 && wavDataLen % wavBlockAlign !== 0) {
        fail('WAV', `data chunk is ${wavDataLen} bytes, not a multiple of blockAlign ${wavBlockAlign}`);
    }
}
async function probeFlac(reader, checkAbort) {
    checkAbort();
    const size = reader.size;
    if (size < 42)
        fail('FLAC', 'too small for a STREAMINFO block');
    const head = await reader.bytes(0, 4);
    if (tag(head, 0) !== 'fLaC')
        fail('FLAC', 'missing fLaC marker');
    let pos = 4;
    let first = true;
    let last = false;
    let declaredSamples = 0;
    let sampleRate = 0;
    let minBlock = 0;
    let maxBlock = 0;
    let metadataBlocks = 0;
    while (!last) {
        if (++metadataBlocks > 4096) {
            fail('FLAC', 'metadata chain exceeds the 4096-block safety limit');
        }
        if ((metadataBlocks & 0x3f) === 0) {
            checkAbort();
            await yieldEventLoop();
        }
        if (pos + 4 > size)
            fail('FLAC', 'metadata block header runs past end of file');
        const hdr = await reader.bytes(pos, 4);
        last = (hdr[0] & 0x80) !== 0;
        const type = hdr[0] & 0x7f;
        const len = (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
        if (first) {
            if (type !== 0 || len !== 34)
                fail('FLAC', 'first metadata block is not a 34-byte STREAMINFO');
            const si = await reader.bytes(pos + 4, 34);
            minBlock = (si[0] << 8) | si[1];
            maxBlock = (si[2] << 8) | si[3];
            sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
            const channels = ((si[12] >> 1) & 0x07) + 1;
            const bits = (((si[12] & 0x01) << 4) | (si[13] >> 4)) + 1;
            declaredSamples =
                (si[13] & 0x0f) * 2 ** 32 + ((si[14] << 24) >>> 0) + (si[15] << 16) + (si[16] << 8) + si[17];
            if (sampleRate < 1 || sampleRate > 655350)
                fail('FLAC', `STREAMINFO sample rate ${sampleRate}`);
            if (channels < 1 || channels > 8)
                fail('FLAC', `STREAMINFO channel count ${channels}`);
            if (bits < 4 || bits > 32)
                fail('FLAC', `STREAMINFO bit depth ${bits}`);
            if (minBlock < 16 || maxBlock < minBlock || maxBlock > 65535) {
                fail('FLAC', `STREAMINFO block sizes ${minBlock}..${maxBlock}`);
            }
            first = false;
        }
        if (pos + 4 + len > size)
            fail('FLAC', `metadata block (type ${type}) truncated`);
        pos += 4 + len;
    }
    if (pos + 2 > size)
        fail('FLAC', 'no audio frames after metadata');
    const MAX_FRAME_BYTES = 4 * 1024 * 1024;
    const WINDOW = MAX_FRAME_BYTES + MAX_FLAC_FRAME_HEADER_BYTES;
    let winStart = pos;
    let window = await reader.bytes(winStart, Math.min(WINDOW, size - winStart));
    const slideTo = async (absOff) => {
        winStart = absOff;
        window = await reader.bytes(winStart, Math.min(WINDOW, size - winStart));
    };
    if (!parseFlacFrameHeader(window, 0)) {
        fail('FLAC', 'audio does not start with a valid frame header (CRC-8 mismatch)');
    }
    let off = pos;
    let samples = 0;
    let frames = 0;
    while (off < size) {
        checkAbort();
        if (off > winStart + window.length - MAX_FLAC_FRAME_HEADER_BYTES || off < winStart)
            await slideTo(off);
        const rel = off - winStart;
        const fh = parseFlacFrameHeader(window, rel);
        if (!fh)
            fail('FLAC', `frame ${frames} header is invalid at offset ${off}`);
        let cursor = rel + fh.headerLen;
        let nextStartAbs = -1;
        let candidates = 0;
        while (winStart + cursor + 6 <= size && winStart + cursor - off <= MAX_FRAME_BYTES && candidates < 64) {
            if (cursor + MAX_FLAC_FRAME_HEADER_BYTES > window.length && winStart + window.length < size) {
                if (off === winStart) {
                    fail('FLAC', `no coherent frame boundary within 4 MiB after offset ${off} - stream is damaged or a frame exceeds the verification window`);
                }
                const shift = off - winStart;
                await slideTo(off);
                cursor -= shift;
                continue;
            }
            if (window[cursor] === 0xff &&
                (window[cursor + 1] & 0xfc) === 0xf8 &&
                winStart + cursor - off >= fh.headerLen + 2 &&
                parseFlacFrameHeader(window, cursor)) {
                candidates++;
                const given = (window[cursor - 2] << 8) | window[cursor - 1];
                if (flacCrc16(window.subarray(off - winStart, cursor - 2)) === given) {
                    nextStartAbs = winStart + cursor;
                    break;
                }
            }
            cursor++;
        }
        if (nextStartAbs < 0) {
            if (size - off < fh.headerLen + 2) {
                fail('FLAC', `frame ${frames} is cut off mid-header`);
            }
            if (winStart + window.length < size)
                await slideTo(off);
            const endRel = size - winStart;
            const startRel = off - winStart;
            if (endRel - startRel > MAX_FRAME_BYTES || endRel > window.length)
                fail('FLAC', `no coherent frame boundary within 4 MiB after offset ${off} - stream is damaged or a frame exceeds the verification window`);
            const given = (window[endRel - 2] << 8) | window[endRel - 1];
            if (flacCrc16(window.subarray(startRel, endRel - 2)) !== given) {
                fail('FLAC', `frame ${frames} (final) fails its CRC-16 - the stream is cut short or damaged`);
            }
            samples += fh.blockSize;
            frames++;
            break;
        }
        samples += fh.blockSize;
        frames++;
        off = nextStartAbs;
    }
    if (frames === 0)
        fail('FLAC', 'no decodable audio frames');
    if (declaredSamples > 0 && samples !== declaredSamples) {
        fail('FLAC', `frames code ${samples} samples but STREAMINFO declares ${declaredSamples} - stream is truncated or damaged`);
    }
    void sampleRate;
}
function validateOpusProbePacket(index, length, toc) {
    if (length < 2) {
        fail('OGG', `Opus packet ${index} is ${length} byte(s) - too short to carry any frame data`);
    }
    if (toc < 0)
        fail('OGG', `Opus packet ${index} has no TOC byte`);
    const code = toc & 0x03;
    const minimum = code === 0 ? 2 : code === 1 ? 3 : code === 2 ? 4 : 3;
    if (length < minimum) {
        fail('OGG', `Opus packet ${index} is ${length} byte(s) but its frame-count code ${code} needs at least ${minimum}`);
    }
    if (code === 3 && length === 3) {
        fail('OGG', `Opus packet ${index} declares a frame count but carries no frame data`);
    }
}
async function probeOgg(reader, checkAbort) {
    const size = reader.size;
    let pos = 0;
    let pages = 0;
    const seenBos = new Set();
    const seenEos = new Set();
    const lastSeq = new Map();
    const streams = new Map();
    let primarySerial = null;
    while (pos < size) {
        if ((pages & 0xff) === 0) {
            checkAbort();
            if (pages > 0)
                await yieldEventLoop();
        }
        if (pos + 27 > size)
            fail('OGG', `page header at ${pos} runs past end of file`);
        const hdr = await reader.bytes(pos, 27);
        if (tag(hdr, 0) !== 'OggS')
            fail('OGG', `page ${pages} does not start with OggS at ${pos}`);
        if (hdr[4] !== 0)
            fail('OGG', `unknown stream structure version ${hdr[4]}`);
        const flags = hdr[5];
        if ((flags & 0xf8) !== 0)
            fail('OGG', `page ${pages} sets reserved header-type bits`);
        const serial = (hdr[14] | (hdr[15] << 8) | (hdr[16] << 16) | (hdr[17] << 24)) >>> 0;
        const seq = (hdr[18] | (hdr[19] << 8) | (hdr[20] << 16) | (hdr[21] << 24)) >>> 0;
        const nsegs = hdr[26];
        if (pos + 27 + nsegs > size)
            fail('OGG', 'segment table truncated');
        const lacing = await reader.bytes(pos + 27, nsegs);
        let body = 0;
        for (let i = 0; i < nsegs; i++)
            body += lacing[i];
        const pageLen = 27 + nsegs + body;
        if (pos + pageLen > size)
            fail('OGG', `page ${pages} body truncated`);
        const page = await reader.bytes(pos, pageLen);
        const declaredCrc = (page[22] | (page[23] << 8) | (page[24] << 16) | (page[25] << 24)) >>> 0;
        const zeroed = page.slice();
        zeroed[22] = 0;
        zeroed[23] = 0;
        zeroed[24] = 0;
        zeroed[25] = 0;
        if (oggCrc32(zeroed) !== declaredCrc)
            fail('OGG', `page ${pages} CRC mismatch (corrupt or fabricated)`);
        let state = streams.get(serial);
        if ((flags & 0x02) !== 0) {
            if (seenBos.has(serial))
                fail('OGG', `stream ${serial} has more than one beginning-of-stream page`);
            if (streams.size >= 64)
                fail('OGG', 'contains more than 64 logical streams');
            seenBos.add(serial);
            state = {
                completedPackets: 0,
                currentPacketBytes: 0,
                currentPacketFirstByte: -1,
                openPacket: false,
                firstPacketPrefix: [],
                isOpus: null,
                sawPositiveGranule: false,
            };
            streams.set(serial, state);
            primarySerial ??= serial;
        }
        else if (!seenBos.has(serial)) {
            fail('OGG', `page ${pages} belongs to stream ${serial}, which never began (no BOS page)`);
        }
        if (!state)
            fail('OGG', `stream ${serial} has no parser state`);
        if (((flags & 0x01) !== 0) !== state.openPacket) {
            fail('OGG', `stream ${serial} has an inconsistent continued-packet flag on page ${pages}`);
        }
        if ((flags & 0x04) !== 0)
            seenEos.add(serial);
        {
            const lo = (hdr[6] | (hdr[7] << 8) | (hdr[8] << 16) | (hdr[9] << 24)) >>> 0;
            const hi = (hdr[10] | (hdr[11] << 8) | (hdr[12] << 16) | (hdr[13] << 24)) >>> 0;
            const isMinusOne = lo === 0xffffffff && hi === 0xffffffff;
            if (!isMinusOne && (hi > 0 || lo > 0))
                state.sawPositiveGranule = true;
        }
        const prev = lastSeq.get(serial);
        if (prev !== undefined && seq !== prev + 1) {
            fail('OGG', `stream ${serial} page sequence jumps ${prev} -> ${seq} - pages are missing`);
        }
        lastSeq.set(serial, seq);
        const payloadStart = 27 + nsegs;
        let bodyOffset = 0;
        for (let i = 0; i < nsegs; i++) {
            const lace = lacing[i];
            if (state.currentPacketFirstByte < 0 && lace > 0) {
                state.currentPacketFirstByte = page[payloadStart + bodyOffset];
            }
            if (state.completedPackets === 0 && state.firstPacketPrefix.length < 8 && lace > 0) {
                const count = Math.min(lace, 8 - state.firstPacketPrefix.length);
                for (let j = 0; j < count; j++) {
                    state.firstPacketPrefix.push(page[payloadStart + bodyOffset + j]);
                }
            }
            state.currentPacketBytes += lace;
            bodyOffset += lace;
            state.openPacket = lace === 255;
            if (state.openPacket)
                continue;
            const packetIndex = state.completedPackets;
            if (packetIndex === 0) {
                const prefix = state.firstPacketPrefix;
                state.isOpus =
                    prefix.length >= 8 &&
                        prefix[0] === 0x4f &&
                        prefix[1] === 0x70 &&
                        prefix[2] === 0x75 &&
                        prefix[3] === 0x73 &&
                        prefix[4] === 0x48 &&
                        prefix[5] === 0x65 &&
                        prefix[6] === 0x61 &&
                        prefix[7] === 0x64;
            }
            else if (state.isOpus && packetIndex >= 2) {
                validateOpusProbePacket(packetIndex, state.currentPacketBytes, state.currentPacketFirstByte);
            }
            state.completedPackets++;
            state.currentPacketBytes = 0;
            state.currentPacketFirstByte = -1;
        }
        pos += pageLen;
        pages++;
    }
    if (pages === 0)
        fail('OGG', 'contains no pages');
    if (pos !== size)
        fail('OGG', 'trailing bytes after the final page');
    if (seenBos.size === 0)
        fail('OGG', 'no beginning-of-stream page');
    for (const serial of seenBos) {
        if (!seenEos.has(serial)) {
            fail('OGG', `stream ${serial} has no end-of-stream page - file is truncated`);
        }
        if (streams.get(serial)?.openPacket) {
            fail('OGG', `stream ${serial} ends inside a continued packet`);
        }
    }
    const primary = primarySerial === null ? null : streams.get(primarySerial);
    if (!primary?.sawPositiveGranule) {
        fail('OGG', 'no page carries a positive granule position - the stream contains no audio samples');
    }
    const headerPackets = primary.isOpus ? 2 : 3;
    if (primary.completedPackets <= headerPackets) {
        fail('OGG', `only ${primary.completedPackets} packet(s) - the codec headers alone leave no audio packets`);
    }
    if (primary.firstPacketPrefix.length > 0) {
        const asText = primary.firstPacketPrefix.map(c => String.fromCharCode(c)).join('');
        const known = /vorbis|OpusHead|FLAC|theora|Speex|\x7fFLAC/.test(asText) || primary.firstPacketPrefix[0] === 0x7f;
        if (!known)
            fail('OGG', 'first page does not carry a recognizable codec header');
    }
}
async function id3v2Size(reader) {
    if (reader.size < 10)
        return 0;
    const head = await reader.bytes(0, 10);
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33)
        return 0;
    return 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
}
async function probeMpegAudio(reader, fmt) {
    const size = reader.size;
    const start = await id3v2Size(reader);
    if (start >= size)
        fail(fmt.toUpperCase(), 'ID3v2 tag covers the whole file; no audio frames');
    const windowLen = Math.min(size - start, 64 * 1024 + 4);
    const window = await reader.bytes(start, windowLen);
    const WANT_CHAIN = 4;
    for (let i = 0; i + 4 <= window.length; i++) {
        const first = parseMpegAudioHeader(window, i);
        if (!first)
            continue;
        let pos = i;
        let chained = 0;
        let head = first;
        while (head.frameLength <= size - start - pos) {
            chained++;
            if (chained >= WANT_CHAIN)
                return;
            const next = pos + head.frameLength;
            const remaining = size - start - next;
            if (remaining === 0 && chained >= 2)
                return;
            const nextBytes = next + Math.min(10, remaining) <= window.length
                ? window.subarray(next, next + Math.min(10, remaining))
                : await reader.bytes(start + next, Math.min(10, remaining));
            if (chained >= 2) {
                if (isMpegAudioTrailerHeader(nextBytes, remaining))
                    return;
                if (remaining >= 138 && isMpegAudioTrailerHeader(nextBytes, remaining - 128)) {
                    const lastBytes = await reader.bytes(size - 128, 3);
                    if (isMpegAudioTrailerHeader(lastBytes, 128))
                        return;
                }
            }
            const nextHead = parseMpegAudioHeader(nextBytes, 0);
            if (!nextHead || nextHead.format !== first.format || nextHead.sampleRate !== first.sampleRate)
                break;
            pos = next;
            head = nextHead;
        }
    }
    fail(fmt.toUpperCase(), 'no valid MPEG audio frame chain in the first 64 KB');
}
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
async function probeAdts(reader, checkAbort) {
    const size = reader.size;
    let pos = await id3v2Size(reader);
    if (pos + 7 > size)
        fail('ADTS', 'no room for a frame header');
    let frames = 0;
    const probeFrames = [];
    let lastFrame = null;
    let sampleRateHz = 44100;
    let channelCount = 2;
    while (pos < size) {
        if ((frames & PROBE_YIELD) === 0)
            checkAbort();
        if (size - pos === 128) {
            const t = await reader.bytes(pos, 3);
            if (t[0] === 0x54 && t[1] === 0x41 && t[2] === 0x47)
                return;
        }
        if (pos + 7 > size)
            fail('ADTS', `trailing ${size - pos} bytes are not a frame`);
        const h = await reader.bytes(pos, 7);
        if (h[0] !== 0xff || (h[1] & 0xf6) !== 0xf0) {
            fail('ADTS', frames === 0 ? 'first bytes are not an ADTS header' : `frame ${frames} has no sync`);
        }
        const frameLen = ((h[3] & 0x03) << 11) | (h[4] << 3) | (h[5] >> 5);
        const headerLen = (h[1] & 0x01) === 0 ? 9 : 7;
        if (frameLen <= headerLen) {
            fail('ADTS', `frame ${frames} declares length ${frameLen} - header is ${headerLen} bytes, leaving no AAC payload`);
        }
        if (pos + headerLen < size) {
            probeFrames.push(await reader.bytes(pos + headerLen, frameLen - headerLen));
            sampleRateHz = ADTS_RATES[(h[2] >> 2) & 0xf] ?? 44100;
            channelCount = Math.max(1, ((h[2] & 0x01) << 2) | ((h[3] >> 6) & 0x03));
        }
        if (pos + frameLen > size)
            fail('ADTS', `frame ${frames} truncated (needs ${frameLen} bytes, ${size - pos} left)`);
        if (frameLen > headerLen) {
            lastFrame = await reader.bytes(pos + headerLen, frameLen - headerLen);
        }
        pos += frameLen;
        frames++;
    }
    if (frames === 0)
        fail('ADTS', 'contains no frames');
    if (lastFrame && probeFrames.length > 0 && lastFrame !== probeFrames[probeFrames.length - 1]) {
        probeFrames.push(lastFrame);
    }
    const decoded = [];
    for (let fi = 0; fi < probeFrames.length; fi++) {
        const frame = probeFrames[fi];
        if ((fi & 0x1f) === 0)
            checkAbort();
        try {
            const result = decodeAacFrameForProbe(frame, sampleRateHz, channelCount);
            decoded.push(result);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            fail('ADTS', `a frame does not decode (${detail.slice(0, 80)})`);
        }
    }
    const lastIndex = decoded.length - 1;
    for (let i = 0; i < decoded.length; i++) {
        const result = decoded[i];
        const isFinalFrame = i === lastIndex && probeFrames.length < frames;
        if (result.bitsAvailable - result.bitsConsumed > 64 || result.bitsConsumed * 4 < result.bitsAvailable * 3) {
            fail('ADTS', `a frame declares ${result.bitsAvailable >> 3} bytes but only ${Math.ceil(result.bitsConsumed / 8)} carry data`);
        }
        const frameBytes = probeFrames[i];
        if (frameBytes && frameBytes.length > 0 && frameBytes.every(byte => byte === 0)) {
            fail('ADTS', `a frame's ${frameBytes.length}-byte payload is entirely zero - no encoder emits that`);
        }
        void isFinalFrame;
    }
}
let pngCrcTable = null;
function pngCrc32(data, seed = 0xffffffff) {
    if (!pngCrcTable) {
        pngCrcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++)
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            pngCrcTable[n] = c >>> 0;
        }
    }
    let crc = seed;
    for (let i = 0; i < data.length; i++)
        crc = pngCrcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return crc >>> 0;
}
function pngSamplesPerPixel(colorType) {
    switch (colorType) {
        case 0:
            return 1;
        case 2:
            return 3;
        case 3:
            return 1;
        case 4:
            return 2;
        case 6:
            return 4;
        default:
            return 0;
    }
}
function pngExpectedRawBytes(w, h, spp, depth, interlace) {
    const rows = (pw, ph) => ph === 0 || pw === 0 ? 0 : (Math.ceil((pw * spp * depth) / 8) + 1) * ph;
    if (interlace === 0)
        return rows(w, h);
    const passes = [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
    ];
    let total = 0;
    for (const [x0, y0, dx, dy] of passes) {
        const pw = Math.ceil(Math.max(0, w - x0) / dx);
        const ph = Math.ceil(Math.max(0, h - y0) / dy);
        total += rows(pw, ph);
    }
    return total;
}
async function probePng(reader, checkAbort) {
    const size = reader.size;
    const sig = await reader.bytes(0, Math.min(8, size));
    const expect = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (sig.length < 8 || expect.some((v, i) => sig[i] !== v))
        fail('PNG', 'missing signature');
    let pos = 8;
    let first = true;
    let chunks = 0;
    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idatParts = [];
    let sawIend = false;
    let sawPlte = false;
    let plteEntries = 0;
    while (!sawIend) {
        if ((chunks & 0x3f) === 0)
            checkAbort();
        if (pos + 8 > size)
            fail('PNG', 'chunk header runs past end of file (no IEND)');
        const len = await u32be(reader, pos);
        if (pos + 12 + len > size) {
            const typeBytes0 = await reader.bytes(pos + 4, 4);
            fail('PNG', `chunk '${tag(typeBytes0, 0)}' truncated`);
        }
        const typeAndData = await reader.bytes(pos + 4, 4 + len);
        const type = tag(typeAndData, 0);
        const declaredCrc = await u32be(reader, pos + 8 + len);
        const actualCrc = (pngCrc32(typeAndData) ^ 0xffffffff) >>> 0;
        if (actualCrc !== declaredCrc) {
            fail('PNG', `chunk '${type}' CRC mismatch (data is corrupted)`);
        }
        if (first) {
            if (type !== 'IHDR')
                fail('PNG', `first chunk is '${type}', not IHDR`);
            if (len !== 13)
                fail('PNG', `IHDR is ${len} bytes, not 13`);
            const d = typeAndData.subarray(4);
            width = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
            height = ((d[4] << 24) | (d[5] << 16) | (d[6] << 8) | d[7]) >>> 0;
            bitDepth = d[8];
            colorType = d[9];
            interlace = d[12];
            if (width === 0 || height === 0)
                fail('PNG', 'zero image dimensions');
            if (pngSamplesPerPixel(colorType) === 0)
                fail('PNG', `invalid color type ${colorType}`);
            if (![1, 2, 4, 8, 16].includes(bitDepth))
                fail('PNG', `invalid bit depth ${bitDepth}`);
            if ((colorType === 2 || colorType === 4 || colorType === 6) && bitDepth < 8) {
                fail('PNG', `color type ${colorType} cannot use bit depth ${bitDepth}`);
            }
            if (colorType === 3 && bitDepth === 16)
                fail('PNG', 'palette images cannot be 16-bit');
            if (d[10] !== 0)
                fail('PNG', `unknown compression method ${d[10]}`);
            if (d[11] !== 0)
                fail('PNG', `unknown filter method ${d[11]}`);
            if (interlace !== 0 && interlace !== 1)
                fail('PNG', `unknown interlace method ${interlace}`);
            first = false;
        }
        else if (type === 'PLTE') {
            if (len === 0 || len % 3 !== 0)
                fail('PNG', `PLTE holds ${len} bytes (not whole RGB triples)`);
            if (len / 3 > 256)
                fail('PNG', `PLTE declares ${len / 3} entries (max 256)`);
            plteEntries = len / 3;
            sawPlte = true;
        }
        else if (type === 'IDAT') {
            idatParts.push(typeAndData.slice(4));
        }
        else if (type === 'IEND') {
            sawIend = true;
        }
        pos += 12 + len;
        chunks++;
    }
    if (pos !== size)
        fail('PNG', `${size - pos} byte(s) of trailing data after IEND`);
    if (idatParts.length === 0)
        fail('PNG', 'no IDAT chunk');
    if (colorType === 3 && !sawPlte)
        fail('PNG', 'indexed-color PNG has no PLTE chunk');
    if (colorType === 3 && plteEntries > 1 << bitDepth) {
        fail('PNG', `PLTE has ${plteEntries} entries, more than ${bitDepth}-bit indices can address`);
    }
    const PROBE_INFLATE_CAP = 64 * 1024 * 1024;
    const expectedRaw = pngExpectedRawBytes(width, height, pngSamplesPerPixel(colorType), bitDepth, interlace);
    const ceiling = Math.min(expectedRaw, PROBE_INFLATE_CAP);
    let raw = null;
    try {
        raw = await inflateBounded(idatParts, ceiling, 'PNG IDAT');
    }
    catch (e) {
        const msg = (e instanceof Error && e.message) || '';
        if (/decompresses past/.test(msg) && ceiling < expectedRaw) {
            return;
        }
        if (/decompresses past/.test(msg)) {
            fail('PNG', `IDAT inflates past the ${expectedRaw} bytes ${width}x${height} requires`);
        }
        fail('PNG', `IDAT does not inflate (${msg || 'corrupt zlib stream'})`);
    }
    if (raw && raw.length !== ceiling) {
        fail('PNG', `IDAT inflates to ${raw.length} bytes; ${width}x${height} geometry requires ${expectedRaw}`);
    }
}
async function probeJpeg(reader) {
    const size = reader.size;
    if (size < 4)
        fail('JPEG', 'too small');
    const head = await reader.bytes(0, 2);
    if (head[0] !== 0xff || head[1] !== 0xd8)
        fail('JPEG', 'missing SOI');
    let pos = 2;
    let sawFrame = false;
    let sawSos = false;
    while (pos + 4 <= size) {
        const m = await reader.bytes(pos, 4);
        if (m[0] !== 0xff)
            fail('JPEG', `expected a marker at ${pos}`);
        const marker = m[1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
            pos += 2;
            continue;
        }
        if (marker === 0xda) {
            sawSos = true;
            break;
        }
        const segLen = (m[2] << 8) | m[3];
        if (segLen < 2 || pos + 2 + segLen > size)
            fail('JPEG', `segment FF${marker.toString(16)} truncated`);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
            const seg = await reader.bytes(pos + 2, Math.min(segLen, 7));
            const h = (seg[3] << 8) | seg[4];
            const w = (seg[5] << 8) | seg[6];
            if (w === 0 || h === 0)
                fail('JPEG', `frame header declares ${w}x${h}`);
            sawFrame = true;
        }
        pos += 2 + segLen;
    }
    if (!sawFrame)
        fail('JPEG', 'no frame header (SOFn) - not a real image');
    if (!sawSos)
        fail('JPEG', 'no scan (SOS) - image has no pixel data');
    {
        const sosLenBytes = await reader.bytes(pos + 2, 2);
        const sosHdrLen = (sosLenBytes[0] << 8) | sosLenBytes[1];
        const entropyStart = pos + 2 + sosHdrLen;
        const entropyBytes = size - entropyStart - 2;
        if (entropyBytes < 8) {
            fail('JPEG', `scan carries ${Math.max(0, entropyBytes)} bytes of entropy data`);
        }
    }
    let end = size;
    while (end > 2) {
        const b = await reader.bytes(end - 1, 1);
        if (b[0] !== 0x00)
            break;
        end--;
    }
    const tail = await reader.bytes(Math.max(0, end - 2), 2);
    if (tail[0] !== 0xff || tail[1] !== 0xd9)
        fail('JPEG', 'missing EOI; file is truncated');
}
async function probeGif(reader, checkAbort) {
    const size = reader.size;
    if (size < 14)
        fail('GIF', 'too small');
    const head = await reader.bytes(0, 13);
    const sigTag = String.fromCharCode(...head.subarray(0, 6));
    if (sigTag !== 'GIF87a' && sigTag !== 'GIF89a')
        fail('GIF', 'missing signature');
    let pos = 13;
    if (head[10] & 0x80)
        pos += 3 * 2 ** ((head[10] & 0x07) + 1);
    let blocks = 0;
    const subBlocks = async (p) => {
        while (true) {
            if (p >= size)
                fail('GIF', 'sub-block chain truncated');
            const n = (await reader.bytes(p, 1))[0];
            p += 1;
            if (n === 0)
                return p;
            if (p + n > size)
                fail('GIF', 'sub-block data truncated');
            p += n;
        }
    };
    while (true) {
        if ((blocks & 0xff) === 0)
            checkAbort();
        if (pos >= size)
            fail('GIF', 'no trailer (0x3B); file is truncated');
        const introducer = (await reader.bytes(pos, 1))[0];
        pos += 1;
        blocks++;
        if (introducer === 0x3b)
            return;
        if (introducer === 0x21) {
            if (pos + 1 > size)
                fail('GIF', 'extension truncated');
            pos = await subBlocks(pos + 1);
        }
        else if (introducer === 0x2c) {
            if (pos + 9 > size)
                fail('GIF', 'image descriptor truncated');
            const desc = await reader.bytes(pos, 9);
            pos += 9;
            if (desc[8] & 0x80)
                pos += 3 * 2 ** ((desc[8] & 0x07) + 1);
            if (pos + 1 > size)
                fail('GIF', 'LZW code size missing');
            pos = await subBlocks(pos + 1);
        }
        else {
            fail('GIF', `unknown block introducer 0x${introducer.toString(16)} at ${pos - 1}`);
        }
    }
}
async function probeWebp(reader) {
    const size = reader.size;
    if (size < 20)
        fail('WebP', 'too small');
    const head = await reader.bytes(0, 12);
    if (tag(head, 0) !== 'RIFF' || tag(head, 8) !== 'WEBP')
        fail('WebP', 'missing RIFF/WEBP header');
    const riffSize = await u32le(reader, 4);
    if (riffSize + 8 > size + 1)
        fail('WebP', `RIFF declares ${riffSize + 8} bytes but the file has ${size}`);
    let pos = 12;
    let sawImage = false;
    let sawVp8x = false;
    while (pos + 8 <= size) {
        const hdr = await reader.bytes(pos, 8);
        const id = tag(hdr, 0);
        const len = hdr[4] | (hdr[5] << 8) | (hdr[6] << 16) | (hdr[7] << 24);
        if (len < 0 || pos + 8 + len > size)
            fail('WebP', `chunk '${id}' truncated`);
        if (id === 'VP8 ') {
            if (len < 10)
                fail('WebP', `'VP8 ' chunk is ${len} bytes (header alone needs 10)`);
            const h = await reader.bytes(pos + 8, Math.min(len, 32));
            const tag = h[0] | (h[1] << 8) | (h[2] << 16);
            const keyFrame = (tag & 1) === 0;
            const version = (tag >> 1) & 0x07;
            const showFrame = (tag >> 4) & 1;
            const firstPartSize = (tag >> 5) & 0x7ffff;
            if (!keyFrame)
                fail('WebP', "'VP8 ' chunk is not a keyframe - a still image cannot reference another frame");
            if (version > 3)
                fail('WebP', `'VP8 ' declares profile ${version} (only 0-3 exist)`);
            if (showFrame !== 1)
                fail('WebP', "'VP8 ' keyframe is marked not-to-be-shown");
            if (h[3] !== 0x9d || h[4] !== 0x01 || h[5] !== 0x2a) {
                fail('WebP', "'VP8 ' chunk is missing its 9D 01 2A start code");
            }
            const w = (h[6] | (h[7] << 8)) & 0x3fff;
            const ht = (h[8] | (h[9] << 8)) & 0x3fff;
            if (w === 0 || ht === 0)
                fail('WebP', `'VP8 ' declares ${w}x${ht}`);
            if (firstPartSize === 0)
                fail('WebP', "'VP8 ' declares a zero-length first partition");
            if (10 + firstPartSize >= len) {
                fail('WebP', `'VP8 ' first partition (${firstPartSize} bytes) leaves no token data in a ${len}-byte chunk`);
            }
            const partition = await reader.bytes(pos + 8 + 10, Math.min(firstPartSize, 65536));
            const reason = vp8FirstPartitionFault(partition);
            if (reason)
                fail('WebP', `'VP8 ' first partition does not decode (${reason})`);
            if (w === 0 || ht === 0)
                fail('WebP', `'VP8 ' declares ${w}x${ht}`);
            sawImage = true;
        }
        else if (id === 'VP8L') {
            if (len < 5)
                fail('WebP', `'VP8L' chunk is ${len} bytes (header alone needs 5)`);
            const lossless = await reader.bytes(pos + 8, Math.min(len, 64));
            const bits = lossless[1] | (lossless[2] << 8) | (lossless[3] << 16) | (lossless[4] << 24);
            const lw = (bits & 0x3fff) + 1;
            const lh = ((bits >>> 14) & 0x3fff) + 1;
            const lversion = (bits >>> 29) & 0x07;
            if (lversion !== 0)
                fail('WebP', `'VP8L' declares version ${lversion} (only 0 is defined)`);
            if (lw <= 0 || lh <= 0)
                fail('WebP', `'VP8L' declares ${lw}x${lh}`);
            if (len <= 5)
                fail('WebP', "'VP8L' chunk carries no image data after its header");
            const lbody = await reader.bytes(pos + 8 + 5, Math.min(len - 5, 4096));
            const lreason = vp8lStreamFault(lbody, lw, lh);
            if (lreason)
                fail('WebP', `'VP8L' bitstream does not decode (${lreason})`);
            const h = await reader.bytes(pos + 8, 5);
            if (h[0] !== 0x2f)
                fail('WebP', "'VP8L' chunk is missing its 0x2F signature");
            sawImage = true;
        }
        else if (id === 'VP8X')
            sawVp8x = true;
        pos += 8 + len + (len & 1);
    }
    if (!sawImage && !sawVp8x)
        fail('WebP', 'no VP8/VP8L/VP8X chunk');
    if (sawVp8x && !sawImage) {
        let anmf = false;
        let p2 = 12;
        while (p2 + 8 <= size) {
            const h2 = await reader.bytes(p2, 8);
            const id2 = tag(h2, 0);
            const l2 = h2[4] | (h2[5] << 8) | (h2[6] << 16) | (h2[7] << 24);
            if (id2 === 'ANMF') {
                if (l2 < 16 + 8)
                    fail('WebP', `ANMF frame is ${l2} bytes - too small to hold an image chunk`);
                let sp = p2 + 8 + 16;
                const frameEnd = p2 + 8 + l2;
                let sawFrameImage = false;
                while (sp + 8 <= frameEnd && sp + 8 <= size) {
                    const sub = await reader.bytes(sp, 8);
                    const subId = tag(sub, 0);
                    const subLen = sub[4] | (sub[5] << 8) | (sub[6] << 16) | (sub[7] << 24);
                    if (subLen === 0)
                        fail('WebP', `ANMF frame's '${subId}' chunk is empty`);
                    if (subId === 'VP8 ' || subId === 'VP8L') {
                        sawFrameImage = true;
                        break;
                    }
                    if (subId !== 'ALPH') {
                        fail('WebP', `ANMF frame carries '${subId}' instead of an image chunk`);
                    }
                    sp += 8 + subLen + (subLen & 1);
                }
                if (!sawFrameImage)
                    fail('WebP', 'ANMF frame contains no VP8/VP8L image chunk');
                anmf = true;
            }
            p2 += 8 + l2 + (l2 & 1);
        }
        if (!anmf)
            fail('WebP', 'VP8X header has no VP8/VP8L image or ANMF frames');
    }
}
async function probeBmp(reader) {
    const size = reader.size;
    if (size < 26)
        fail('BMP', 'too small');
    const head = await reader.bytes(0, 14);
    if (head[0] !== 0x42 || head[1] !== 0x4d)
        fail('BMP', 'missing BM signature');
    const pixelOffset = await u32le(reader, 10);
    if (pixelOffset < 26 || pixelOffset >= size)
        fail('BMP', `pixel data offset ${pixelOffset} outside the file`);
    const dibSize = await u32le(reader, 14);
    if (14 + dibSize > size)
        fail('BMP', 'DIB header truncated');
    if (pixelOffset < 14 + dibSize)
        fail('BMP', 'pixel data offset overlaps the DIB header');
    let width = 0, height = 0, bpp = 0, compression = 0, sizeImage = 0;
    if (dibSize === 12) {
        const d = await reader.bytes(18, 8);
        width = d[0] | (d[1] << 8);
        height = d[2] | (d[3] << 8);
        bpp = d[6] | (d[7] << 8);
    }
    else if (dibSize >= 40) {
        width = (await u32le(reader, 18)) | 0;
        const rawH = (await u32le(reader, 22)) | 0;
        height = Math.abs(rawH);
        const d = await reader.bytes(26, 4);
        bpp = d[2] | (d[3] << 8);
        compression = await u32le(reader, 30);
        sizeImage = await u32le(reader, 34);
    }
    else {
        fail('BMP', `unsupported DIB header size ${dibSize}`);
    }
    if (width <= 0 || height <= 0)
        fail('BMP', `invalid dimensions ${width}x${height}`);
    if (![1, 4, 8, 16, 24, 32].includes(bpp))
        fail('BMP', `invalid bit depth ${bpp}`);
    if (width > 0x20000 || height > 0x20000)
        fail('BMP', `implausible dimensions ${width}x${height}`);
    if (compression === 1 || compression === 2) {
        if (sizeImage === 0)
            fail('BMP', 'RLE bitmap without a biSizeImage');
        if (pixelOffset + sizeImage > size) {
            fail('BMP', `RLE data needs ${sizeImage} bytes at ${pixelOffset}; file has ${size}`);
        }
        const minRle = height * 2 + 2;
        if (sizeImage < minRle) {
            fail('BMP', `RLE data is ${sizeImage} bytes; ${width}x${height} needs at least ${minRle}`);
        }
        return;
    }
    if (compression !== 0 && compression !== 3)
        fail('BMP', `unsupported compression ${compression}`);
    const rowBytes = Math.floor((width * bpp + 31) / 32) * 4;
    if (width > 0x20000 || height > 0x20000)
        fail('BMP', `implausible dimensions ${width}x${height}`);
    const need = rowBytes * height;
    if (pixelOffset + need > size) {
        fail('BMP', `pixel array needs ${need} bytes at offset ${pixelOffset}; file has ${size}`);
    }
}
async function probeTiff(reader) {
    const size = reader.size;
    if (size < 8)
        fail('TIFF', 'too small');
    const head = await reader.bytes(0, 8);
    const le = head[0] === 0x49 && head[1] === 0x49;
    const be = head[0] === 0x4d && head[1] === 0x4d;
    if (!le && !be)
        fail('TIFF', 'missing byte-order mark');
    const magic = le ? head[2] | (head[3] << 8) : (head[2] << 8) | head[3];
    if (magic !== 42)
        fail('TIFF', 'magic is not 42');
    const ifdOff = le
        ? head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24)
        : (head[4] << 24) | (head[5] << 16) | (head[6] << 8) | head[7];
    if (ifdOff < 8 || ifdOff + 2 > size)
        fail('TIFF', `first IFD offset ${ifdOff} outside the file`);
    const cntBytes = await reader.bytes(ifdOff, 2);
    const entries = le ? cntBytes[0] | (cntBytes[1] << 8) : (cntBytes[0] << 8) | cntBytes[1];
    if (entries === 0)
        fail('TIFF', 'first IFD has no entries');
    if (ifdOff + 2 + entries * 12 > size)
        fail('TIFF', 'first IFD runs past end of file');
    const dir = await reader.bytes(ifdOff + 2, entries * 12);
    const u16 = (o) => (le ? dir[o] | (dir[o + 1] << 8) : (dir[o] << 8) | dir[o + 1]);
    const u32 = (o) => le
        ? (dir[o] | (dir[o + 1] << 8) | (dir[o + 2] << 16) | (dir[o + 3] << 24)) >>> 0
        : ((dir[o] << 24) | (dir[o + 1] << 16) | (dir[o + 2] << 8) | dir[o + 3]) >>> 0;
    let width = 0;
    let height = 0;
    let sawPixelData = false;
    const pixelOffsets = [];
    const pixelCounts = [];
    const readArray = async (type, count, valueOrOffset, entryOffset) => {
        const width2 = type === 3 ? 2 : 4;
        if (count === 1) {
            return [
                type === 3
                    ? le
                        ? dir[entryOffset + 8] | (dir[entryOffset + 9] << 8)
                        : (dir[entryOffset + 8] << 8) | dir[entryOffset + 9]
                    : valueOrOffset,
            ];
        }
        if (count > 65536 || valueOrOffset + count * width2 > size)
            return [];
        const raw = await reader.bytes(valueOrOffset, count * width2);
        const out = [];
        for (let i = 0; i < count; i++) {
            const o = i * width2;
            out.push(width2 === 2
                ? le
                    ? raw[o] | (raw[o + 1] << 8)
                    : (raw[o] << 8) | raw[o + 1]
                : le
                    ? (raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16) | (raw[o + 3] << 24)) >>> 0
                    : ((raw[o] << 24) | (raw[o + 1] << 16) | (raw[o + 2] << 8) | raw[o + 3]) >>> 0);
        }
        return out;
    };
    for (let i = 0; i < entries; i++) {
        const o = i * 12;
        const tag2 = u16(o);
        const type = u16(o + 2);
        const count = u32(o + 4);
        const valueOrOffset = u32(o + 8);
        const short = type === 3 ? (le ? dir[o + 8] | (dir[o + 9] << 8) : (dir[o + 8] << 8) | dir[o + 9]) : valueOrOffset;
        if (tag2 === 256)
            width = short;
        else if (tag2 === 257)
            height = short;
        else if (tag2 === 279 || tag2 === 325) {
            pixelCounts.push(...(await readArray(type, count, valueOrOffset, o)));
        }
        else if (tag2 === 273 || tag2 === 324) {
            sawPixelData = true;
            pixelOffsets.push(...(await readArray(type, count, valueOrOffset, o)));
            const inlineOffset = type === 3 ? (le ? dir[o + 8] | (dir[o + 9] << 8) : (dir[o + 8] << 8) | dir[o + 9]) : valueOrOffset;
            if (count === 1 && inlineOffset >= size) {
                fail('TIFF', `pixel data offset ${inlineOffset} outside the file`);
            }
            if (count > 1) {
                const arrayBytes = count * (type === 3 ? 2 : 4);
                if (valueOrOffset + arrayBytes > size)
                    fail('TIFF', 'offset array outside the file');
            }
        }
    }
    if (width === 0 || height === 0)
        fail('TIFF', `IFD declares ${width}x${height}`);
    if (!sawPixelData)
        fail('TIFF', 'IFD has no StripOffsets/TileOffsets - no pixel data');
    if (pixelOffsets.length > 0 && pixelCounts.length > 0) {
        const pairs = Math.min(pixelOffsets.length, pixelCounts.length);
        let declared = 0;
        for (let i = 0; i < pairs; i++) {
            const start = pixelOffsets[i];
            const length = pixelCounts[i];
            declared += length;
            if (start + length > size) {
                fail('TIFF', `pixel strip ${i} runs to ${start + length} in a ${size}-byte file`);
            }
        }
        if (declared > size)
            fail('TIFF', `strips declare ${declared} bytes of pixels in a ${size}-byte file`);
    }
    if (ifdOff + 2 + entries * 12 + 4 > size)
        fail('TIFF', 'first IFD truncated');
}
function subReader(parent, offset, length) {
    return {
        size: length,
        bytes: (pos, len) => parent.bytes(offset + pos, Math.min(len, Math.max(0, length - pos))),
    };
}
async function probeIco(reader, checkAbort) {
    const size = reader.size;
    if (size < 22)
        fail('ICO', 'too small');
    const head = await reader.bytes(0, 6);
    const type = head[2] | (head[3] << 8);
    if (head[0] !== 0 || head[1] !== 0 || (type !== 1 && type !== 2))
        fail('ICO', 'bad header');
    const count = head[4] | (head[5] << 8);
    if (count === 0)
        fail('ICO', 'no images');
    if (6 + count * 16 > size)
        fail('ICO', 'directory truncated');
    for (let i = 0; i < count; i++) {
        const e = await reader.bytes(6 + i * 16, 16);
        const bytes = e[8] | (e[9] << 8) | (e[10] << 16) | (e[11] << 24);
        const off = e[12] | (e[13] << 8) | (e[14] << 16) | (e[15] << 24);
        if (off + bytes > size)
            fail('ICO', `image ${i} data outside the file`);
        if (bytes < 40)
            fail('ICO', `image ${i} is ${bytes} bytes - too small for PNG or DIB`);
        const magic = await reader.bytes(off, 8);
        const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47;
        const dibSize = (magic[0] | (magic[1] << 8) | (magic[2] << 16) | (magic[3] << 24)) >>> 0;
        const isDib = dibSize >= 40 && dibSize <= 128;
        if (!isPng && !isDib)
            fail('ICO', `image ${i} payload is neither PNG nor a DIB header`);
        if (isPng) {
            try {
                await probePng(subReader(reader, off, bytes), checkAbort);
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                fail('ICO', `image ${i} is not a valid PNG (${detail.replace(/^PNG structure invalid: /, '')})`);
            }
        }
        if (isDib) {
            const dib = await reader.bytes(off, Math.min(40, bytes));
            const w = dib[4] | (dib[5] << 8) | (dib[6] << 16) | (dib[7] << 24) | 0;
            const h2 = dib[8] | (dib[9] << 8) | (dib[10] << 16) | (dib[11] << 24) | 0;
            const bpp = dib[14] | (dib[15] << 8);
            const compression = (dib[16] | (dib[17] << 8) | (dib[18] << 16) | (dib[19] << 24)) >>> 0;
            const rows = Math.abs(h2) >> 1;
            if (w <= 0 || rows <= 0 || w > 1024 || rows > 1024)
                fail('ICO', `image ${i} DIB dimensions ${w}x${h2} are invalid`);
            if (compression === 0) {
                const palette = bpp <= 8 ? (1 << bpp) * 4 : 0;
                const xorRow = Math.floor((w * bpp + 31) / 32) * 4;
                const andRow = Math.floor((w + 31) / 32) * 4;
                const needed = dibSize + palette + xorRow * rows;
                if (bytes < needed) {
                    fail('ICO', `image ${i} holds ${bytes} bytes but its ${w}x${rows}@${bpp}bpp pixels need ${needed}`);
                }
                if (andRow > 0 && bytes < needed + 1 && rows > 1) {
                    fail('ICO', `image ${i} has no mask bytes at all after its pixels`);
                }
            }
        }
    }
}
function vp8FirstPartitionFault(data) {
    if (data.length < 4)
        return `first partition is ${data.length} bytes`;
    let value = ((data[0] << 8) | data[1]) >>> 0;
    let range = 255;
    let bitCount = 0;
    let pos = 2;
    let ranOut = false;
    const bit = (probability) => {
        const split = 1 + (((range - 1) * probability) >> 8);
        const bigSplit = split << 8;
        let result;
        if (value >= bigSplit) {
            result = 1;
            range -= split;
            value -= bigSplit;
        }
        else {
            result = 0;
            range = split;
        }
        while (range < 128) {
            value <<= 1;
            range <<= 1;
            if (++bitCount === 8) {
                bitCount = 0;
                if (pos < data.length) {
                    value |= data[pos++];
                }
                else {
                    ranOut = true;
                }
            }
        }
        return result;
    };
    const literal = (bits) => {
        let v = 0;
        for (let i = 0; i < bits; i++)
            v = (v << 1) | bit(128);
        return v;
    };
    const signedLiteral = (bits) => {
        const v = literal(bits);
        return bit(128) ? -v : v;
    };
    const colourSpace = bit(128);
    bit(128);
    if (colourSpace !== 0)
        return 'reserved colour space';
    if (bit(128)) {
        const updateMap = bit(128);
        const updateData = bit(128);
        if (updateData) {
            bit(128);
            for (let i = 0; i < 4; i++)
                if (bit(128))
                    signedLiteral(7);
            for (let i = 0; i < 4; i++)
                if (bit(128))
                    signedLiteral(6);
        }
        if (updateMap)
            for (let i = 0; i < 3; i++)
                if (bit(128))
                    literal(8);
    }
    bit(128);
    literal(6);
    literal(3);
    if (bit(128)) {
        if (bit(128)) {
            for (let i = 0; i < 4; i++)
                if (bit(128))
                    signedLiteral(6);
            for (let i = 0; i < 4; i++)
                if (bit(128))
                    signedLiteral(6);
        }
    }
    const partitionCount = 1 << literal(2);
    if (partitionCount > 8)
        return 'implausible token partition count';
    literal(7);
    for (let i = 0; i < 5; i++)
        if (bit(128))
            signedLiteral(4);
    bit(128);
    if (ranOut)
        return 'partition ends before its header does';
    return null;
}
function vp8lStreamFault(data, width, height) {
    if (data.length === 0)
        return 'no bitstream after the header';
    let pos = 0;
    let bitPos = 0;
    let ranOut = false;
    const read = (bits) => {
        let v = 0;
        for (let i = 0; i < bits; i++) {
            if (pos >= data.length) {
                ranOut = true;
                return v;
            }
            v |= ((data[pos] >> bitPos) & 1) << i;
            if (++bitPos === 8) {
                bitPos = 0;
                pos++;
            }
        }
        return v;
    };
    const seen = new Set();
    let guard = 0;
    while (read(1) === 1) {
        if (++guard > 4)
            return 'more transforms than the format allows';
        const type = read(2);
        if (seen.has(type))
            return `transform ${type} declared twice`;
        seen.add(type);
        if (type === 0 || type === 1) {
            read(3);
        }
        else if (type === 3) {
            const colours = read(8) + 1;
            if (colours === 0)
                return 'empty colour table';
        }
        if (ranOut)
            return 'stream ends inside its transform list';
    }
    if (ranOut)
        return 'stream ends before the transform list';
    read(4);
    if (ranOut)
        return 'stream ends at the colour cache descriptor';
    if (width <= 0 || height <= 0)
        return `implausible dimensions ${width}x${height}`;
    if (pos >= data.length)
        return 'stream ends immediately after its header';
    return null;
}
