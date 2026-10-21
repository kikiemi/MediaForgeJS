import type { Reader } from '../../core/contracts/reader';
import { HANDS_OVER, readerDiagnostics } from '../shared/contract';
import type { Source } from '../../core/model/types';
import type { DemuxResult, Sample, TrackInfo } from '../../core/model/track';
import { ChunkReader } from '../../core/io/sources/chunk-reader';
import { DiagnosticContext } from '../../core/errors/diagnostics';
import { throwIfAborted } from '../../core/errors/errors';
import { demuxAssert } from '../../core/errors/demux-guard';
import { PacketDemuxer } from '../shared/demux-budget';
import { yieldEventLoop } from '../../core/io/event-loop';
import {
    findStartCode,
    inspectMpegPicture,
    mpegVideoConfig,
    parseMpegVideoConfig,
} from '../../core/codec-config/video/mpeg-video';
import { completeMpegFrameTimes, type MpegFrameTiming } from '../shared/mpeg-video-stream';
import { isAnnexB, splitAnnexBNals } from '../../core/codec-config/video/annexb';
import { H264BitReader, nalToRbsp } from '../../core/codec-config/video/video-sps';
import { parseMpegAudioHeader } from '../../core/codec-config/audio/mpeg-audio-header';
import { parseAdtsFrameHeader } from '../../core/codec-config/audio/adts';
import { decodeTime } from '../../core/model/media-time';
import { u16be, u32be } from '../../core/bytes/byte-fields';

const KEY_BYTES = 16;

/** Run-in before the header partition may be at most 65535 bytes (SMPTE 377M 6.5). */
const MAX_RUN_IN = 65536;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 4_000_000;

/** Bytes of a video edit unit inspected for picture headers and NAL unit types. */
const VIDEO_INSPECT_BYTES = 8192;

const PARTITION_PREFIX = '060e2b34020501010d01020101';
const PRIMER_PREFIX = '060e2b34020501010d01020101050100';
const INDEX_PREFIX = '060e2b34025301010d0102010110';
const FILL_KEY = '060e2b34010101020301021001000000';
const LOCAL_SET_PREFIX = '060e2b34025301010d01010101';
const ESSENCE_PREFIX = '060e2b3401020101';

interface LocalSet {
    readonly kind: number;
    readonly tags: Map<number, Uint8Array>;
}

interface MxfTrack {
    readonly trackId: number;
    readonly trackNumber: number;
    readonly editRateNum: number;
    readonly editRateDen: number;
    readonly dataDefinition: 'picture' | 'sound' | 'other';
    readonly duration: number;
}

interface MxfDescriptor {
    readonly linkedTrackId: number;
    readonly kind: number;
    readonly essenceContainer?: Uint8Array;
    readonly codingUl?: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly displayWidth: number;
    readonly displayHeight: number;
    readonly aspectNum: number;
    readonly aspectDen: number;
    readonly frameLayout: number;
    readonly sampleRateNum: number;
    readonly sampleRateDen: number;
    readonly audioRate: number;
    readonly channels: number;
    readonly bits: number;
    readonly blockAlign: number;
}

interface IndexEntry {
    readonly temporalOffset: number;
    readonly keyFrameOffset: number;
    readonly flags: number;
    readonly streamOffset: number;
}

interface IndexSegment {
    readonly indexSid: number;
    readonly bodySid: number;
    readonly start: number;
    readonly duration: number;
    readonly editUnitByteCount: number;
    readonly entries: IndexEntry[];
    readonly editRateNum: number;
    readonly editRateDen: number;
}

interface EssenceUnit {
    readonly offset: number;
    readonly size: number;
    /** Leading bytes for picture inspection; undefined for sound. */
    readonly head?: Uint8Array;
}

interface EssenceStream {
    readonly trackNumber: number;
    readonly itemType: number;
    readonly units: EssenceUnit[];
    bytes: number;
}

function hex(bytes: Uint8Array, at: number, length: number): string {
    let out = '';
    for (let index = 0; index < length; index++)
        out += bytes[at + index]!.toString(16).padStart(2, '0');
    return out;
}

function i64(bytes: Uint8Array, at: number): number {
    return Number(new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigInt64(0, false));
}

/** BER length at `at`; undefined when truncated or longer than 8 bytes. */
function berLength(bytes: Uint8Array, at: number): { value: number; length: number } | undefined {
    if (at >= bytes.length) return undefined;
    const first = bytes[at]!;
    if (first < 0x80) return { value: first, length: 1 };
    const count = first & 0x7f;
    if (count === 0 || count > 8 || at + 1 + count > bytes.length) return undefined;
    let value = 0;
    for (let index = 0; index < count; index++) value = value * 256 + bytes[at + 1 + index]!;
    return Number.isSafeInteger(value) ? { value, length: 1 + count } : undefined;
}

function parseLocalSet(kind: number, value: Uint8Array): LocalSet {
    const tags = new Map<number, Uint8Array>();
    for (let at = 0; at + 4 <= value.length;) {
        const tag = u16be(value, at);
        const length = u16be(value, at + 2);
        if (at + 4 + length > value.length) break;
        tags.set(tag, value.subarray(at + 4, at + 4 + length));
        at += 4 + length;
    }
    return { kind, tags };
}

function refs(value: Uint8Array | undefined): string[] {
    if (!value || value.length < 8) return [];
    const count = u32be(value, 0);
    const size = u32be(value, 4);
    const out: string[] = [];
    for (
        let index = 0;
        index < count && 8 + (index + 1) * size <= value.length && size === 16;
        index++
    )
        out.push(hex(value, 8 + index * size, 16));
    return out;
}

function rational(value: Uint8Array | undefined): [number, number] {
    if (!value || value.length < 8) return [0, 0];
    return [u32be(value, 0), u32be(value, 4)];
}

function number(value: Uint8Array | undefined, fallback = 0): number {
    if (!value) return fallback;
    if (value.length === 1) return value[0]!;
    if (value.length === 2) return u16be(value, 0);
    if (value.length === 4) return u32be(value, 0);
    if (value.length === 8) return i64(value, 0);
    return fallback;
}

/**
 * First I slice of an H.264 access unit: an IDR NAL unit, or a non-IDR slice whose slice_type codes
 * I.
 */
function h264Intra(data: Uint8Array): boolean {
    for (const nal of splitAnnexBNals(data)) {
        const type = nal[0]! & 31;
        if (type === 5) return true;
        if (type !== 1) continue;
        try {
            const bits = new H264BitReader(nalToRbsp(nal.subarray(0, Math.min(nal.length, 16)), 1));
            bits.readUE();
            const sliceType = bits.readUE() % 5;
            return sliceType === 2 || sliceType === 4;
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * MPEG-2 and MPEG-4 picture start of a clip-wrapped elementary stream: the first header of a
 * frame's header run.
 */
function frameStarts(
    window: Uint8Array,
    base: number,
    starts: number[],
    lastHeaderRun: { at: number },
): void {
    for (
        let at = findStartCode(window, 0);
        at >= 0 && at + 3 < window.length;
        at = findStartCode(window, at + 3)
    ) {
        const code = window[at + 3]!;
        if (code === 0xb3 || code === 0xb8) {
            if (lastHeaderRun.at < 0) lastHeaderRun.at = base + at;
        } else if (code === 0x00) {
            starts.push(lastHeaderRun.at >= 0 ? lastHeaderRun.at : base + at);
            lastHeaderRun.at = -1;
        } else if (code !== 0xb5 && code !== 0xb2) lastHeaderRun.at = -1;
    }
}

/**
 * SMPTE 377M MXF demuxer: partitions, primer, header metadata, index tables and frame- or
 * clip-wrapped essence of MPEG-2, H.264, PCM/AES3, MPEG audio, AAC, DNxHD, JPEG 2000 and ProRes
 * tracks. Read only.
 */
export class MxfDemuxer extends PacketDemuxer {
    async demux(
        source: Source,
        diagnostics = new DiagnosticContext({}, 'compatible'),
    ): Promise<DemuxResult> {
        const reader = new ChunkReader(source);
        const size = reader.size;
        const check = (): void => {
            throwIfAborted(this.signal);
        };
        const head = await reader.bytes(0, Math.min(size, MAX_RUN_IN + KEY_BYTES));
        let pos = -1;
        for (let at = 0; at + 13 <= head.length && at < MAX_RUN_IN; at++) {
            if (hex(head, at, 13) === PARTITION_PREFIX) {
                pos = at;
                break;
            }
        }
        demuxAssert(pos >= 0, 'Not an MXF file: no partition pack found');
        if (pos > 0)
            diagnostics.note('warn', 'mxf', 'MXF_RUN_IN', `MXF run-in of ${pos} bytes skipped`);

        const sets = new Map<string, LocalSet>();
        const indexSegments: IndexSegment[] = [];
        const streams = new Map<number, EssenceStream>();
        let partitions = 0;
        let footerSeen = false;
        let truncated = false;
        let klvCount = 0;
        const essenceOrder: number[] = [];
        while (pos + KEY_BYTES + 1 <= size) {
            if ((klvCount++ & 255) === 0) {
                check();
                await yieldEventLoop();
            }
            const header = await reader.bytes(pos, Math.min(KEY_BYTES + 9, size - pos));
            const length = berLength(header, KEY_BYTES);
            if (!length) {
                diagnostics.recover(
                    {
                        code: 'MXF_TRUNCATED',
                        format: 'mxf',
                        offset: pos,
                        message: `Ignored the file from a malformed MXF KLV at byte ${pos}`,
                    },
                    'MXF KLV length is malformed',
                );
                truncated = true;
                break;
            }
            const valueStart = pos + KEY_BYTES + length.length;
            const valueEnd = valueStart + length.value;
            const key = hex(header, 0, 16);
            if (valueEnd > size) {
                diagnostics.recover(
                    {
                        code: 'MXF_TRUNCATED',
                        format: 'mxf',
                        offset: pos,
                        message: `Ignored an MXF KLV at byte ${pos}, cut by the end of the input`,
                    },
                    'MXF KLV extends past the end of the input',
                );
                truncated = true;
                break;
            }
            if (key.startsWith(PARTITION_PREFIX)) {
                partitions++;
                if (header[13] === 0x04) footerSeen = true;
            } else if (key.startsWith(LOCAL_SET_PREFIX)) {
                if (length.value <= MAX_METADATA_BYTES) {
                    const value = await reader.bytes(valueStart, length.value);
                    const set = parseLocalSet(header[14]!, value);
                    const uid = set.tags.get(0x3c0a);
                    if (uid && uid.length === 16) sets.set(hex(uid, 0, 16), set);
                }
            } else if (key.startsWith(INDEX_PREFIX)) {
                if (length.value <= MAX_METADATA_BYTES) {
                    const segment = this.parseIndexSegment(
                        await reader.bytes(valueStart, length.value),
                    );
                    if (segment) indexSegments.push(segment);
                }
            } else if (
                key.startsWith(ESSENCE_PREFIX) &&
                header[8] === 0x0d &&
                header[9] === 0x01 &&
                header[10] === 0x03 &&
                header[11] === 0x01
            ) {
                const itemType = header[12]!;
                if (
                    itemType === 0x05 ||
                    itemType === 0x06 ||
                    itemType === 0x07 ||
                    (itemType >= 0x15 && itemType <= 0x17)
                ) {
                    const trackNumber = u32be(header, 12);
                    let stream = streams.get(trackNumber);
                    if (!stream) {
                        demuxAssert(streams.size < 64, 'MXF holds too many essence streams');
                        stream = { trackNumber, itemType, units: [], bytes: 0 };
                        streams.set(trackNumber, stream);
                        essenceOrder.push(trackNumber);
                    }
                    const picture = itemType === 0x05 || itemType === 0x15;
                    this.budget.reserveSamples(1, picture ? 320 : 256, 'MXF essence index');
                    stream.units.push({
                        offset: valueStart,
                        size: length.value,
                        head: picture
                            ? await reader.bytes(
                                  valueStart,
                                  Math.min(length.value, VIDEO_INSPECT_BYTES),
                              )
                            : undefined,
                    });
                    stream.bytes += length.value;
                }
            } else if (
                key !== FILL_KEY &&
                !key.startsWith(PRIMER_PREFIX) &&
                header[4] === 0x02 &&
                header[5] === 0x05 &&
                header[13] === 0x11
            ) {
                footerSeen ||= true;
            }
            pos = valueEnd;
        }
        check();
        demuxAssert(partitions > 0, 'MXF holds no partition pack');
        if (!footerSeen && !truncated)
            diagnostics.note(
                'warn',
                'mxf',
                'MXF_NO_FOOTER',
                'MXF has no footer partition, as in an unfinished recording',
            );

        const tracks = this.resolveTracks(sets);
        demuxAssert(streams.size > 0, 'MXF holds no essence');
        const result: DemuxResult = { videoTracks: [], audioTracks: [] };
        const assigned = new Set<number>();
        for (const trackNumber of essenceOrder) {
            const stream = streams.get(trackNumber)!;
            const picture = stream.itemType === 0x05 || stream.itemType === 0x15;
            const sound = stream.itemType === 0x06 || stream.itemType === 0x16;
            if (!picture && !sound) continue;
            let track = tracks.find(
                entry =>
                    entry.track.trackNumber === trackNumber && !assigned.has(entry.track.trackId),
            );
            if (!track)
                track = tracks.find(
                    entry =>
                        !assigned.has(entry.track.trackId) &&
                        entry.track.dataDefinition === (picture ? 'picture' : 'sound') &&
                        (entry.track.trackNumber === 0 || !streams.has(entry.track.trackNumber)),
                );
            if (!track) {
                diagnostics.note(
                    'warn',
                    'mxf',
                    'MXF_UNDESCRIBED_ESSENCE',
                    `MXF essence track 0x${trackNumber.toString(16)} has no matching source ` +
                        `package track; ` +
                        'omitted',
                );
                continue;
            }
            assigned.add(track.track.trackId);
            const index = indexSegments.filter(
                segment => segment.entries.length > 0 || segment.editUnitByteCount > 0,
            );
            const built = picture
                ? await this.buildPictureTrack(
                      stream,
                      track.track,
                      track.descriptor,
                      index,
                      reader,
                      diagnostics,
                  )
                : await this.buildSoundTrack(
                      stream,
                      track.track,
                      track.descriptor,
                      tracks,
                      reader,
                      diagnostics,
                  );
            if (!built) continue;
            built.id = track.track.trackId;
            if (truncated) built.incomplete = true;
            (picture ? result.videoTracks : result.audioTracks).push(built);
        }
        demuxAssert(
            result.videoTracks.length + result.audioTracks.length > 0,
            'MXF holds no supported essence',
        );
        const total = Math.max(
            ...result.videoTracks.map(t => t.duration),
            ...result.audioTracks.map(t => t.duration),
        );
        for (const track of [...result.videoTracks, ...result.audioTracks])
            track.duration = Math.max(track.duration, total);
        return result;
    }

    private parseIndexSegment(value: Uint8Array): IndexSegment | undefined {
        const set = parseLocalSet(0x10, value);
        const [editRateNum, editRateDen] = rational(set.tags.get(0x3f0b));
        const sliceCount = number(set.tags.get(0x3f08));
        const posTableCount = number(set.tags.get(0x3f0e));

        const entries: IndexEntry[] = [];
        const array = set.tags.get(0x3f0a);
        if (array && array.length >= 8) {
            const count = u32be(array, 0);
            const entrySize = u32be(array, 4);
            demuxAssert(count <= MAX_INDEX_ENTRIES, 'MXF index table exceeds its entry limit');
            const expected = 11 + sliceCount * 4 + posTableCount * 8;
            if (entrySize >= expected)
                for (
                    let index = 0;
                    index < count && 8 + (index + 1) * entrySize <= array.length;
                    index++
                ) {
                    const at = 8 + index * entrySize;
                    entries.push({
                        temporalOffset: (array[at]! << 24) >> 24,
                        keyFrameOffset: (array[at + 1]! << 24) >> 24,
                        flags: array[at + 2]!,
                        streamOffset: i64(array, at + 3),
                    });
                }
        }

        return {
            indexSid: number(set.tags.get(0x3f06)),
            bodySid: number(set.tags.get(0x3f07)),
            start: number(set.tags.get(0x3f0c)),
            duration: number(set.tags.get(0x3f0d)),
            editUnitByteCount: number(set.tags.get(0x3f05)),
            entries,
            editRateNum,
            editRateDen,
        };
    }

    /** Timeline tracks of the top-level file source package(s) with their descriptors. */
    private resolveTracks(
        sets: Map<string, LocalSet>,
    ): { track: MxfTrack; descriptor?: MxfDescriptor }[] {
        const descriptorsOf = (uid: string | undefined): MxfDescriptor[] => {
            const set = uid ? sets.get(uid) : undefined;
            if (!set) return [];
            if (set.kind === 0x44)
                return refs(set.tags.get(0x3f01)).flatMap(sub => descriptorsOf(sub));

            const [sampleRateNum, sampleRateDen] = rational(set.tags.get(0x3001));
            const [aspectNum, aspectDen] = rational(set.tags.get(0x320e));
            const [audioRateNum, audioRateDen] = rational(set.tags.get(0x3d03));
            return [
                {
                    linkedTrackId: number(set.tags.get(0x3006)),
                    kind: set.kind,
                    essenceContainer: set.tags.get(0x3004),
                    codingUl: set.tags.get(0x3201) ?? set.tags.get(0x3d06),
                    width: number(set.tags.get(0x3203)),
                    height: number(set.tags.get(0x3202)),
                    displayWidth: number(set.tags.get(0x3209)),
                    displayHeight: number(set.tags.get(0x3208)),
                    aspectNum,
                    aspectDen,
                    frameLayout: number(set.tags.get(0x320c)),
                    sampleRateNum,
                    sampleRateDen,
                    audioRate: audioRateDen ? audioRateNum / audioRateDen : 0,
                    channels: number(set.tags.get(0x3d07)),
                    bits: number(set.tags.get(0x3d01)),
                    blockAlign: number(set.tags.get(0x3d0a)),
                },
            ];
        };

        const out: { track: MxfTrack; descriptor?: MxfDescriptor }[] = [];
        for (const set of sets.values()) {
            if (set.kind !== 0x37) continue;
            const descriptors = descriptorsOf(
                set.tags.get(0x4701) ? hex(set.tags.get(0x4701)!, 0, 16) : undefined,
            );
            if (descriptors.length === 0) continue;

            for (const trackUid of refs(set.tags.get(0x4403))) {
                const trackSet = sets.get(trackUid);
                if (!trackSet || trackSet.kind !== 0x3b) continue;
                const sequenceUid = trackSet.tags.get(0x4803);
                const sequence = sequenceUid ? sets.get(hex(sequenceUid, 0, 16)) : undefined;
                const definition = sequence?.tags.get(0x0201);
                const [editRateNum, editRateDen] = rational(trackSet.tags.get(0x4b01));

                const track: MxfTrack = {
                    trackId: number(trackSet.tags.get(0x4801)),
                    trackNumber: number(trackSet.tags.get(0x4804)),
                    editRateNum,
                    editRateDen,
                    dataDefinition: definition ? dataDefinitionOf(definition) : 'other',
                    duration: number(sequence?.tags.get(0x0202), -1),
                };

                if (track.dataDefinition === 'other') continue;
                const descriptor =
                    descriptors.find(entry => entry.linkedTrackId === track.trackId) ??
                    (descriptors.length === 1 ? descriptors[0] : undefined) ??
                    descriptors.find(
                        entry =>
                            (track.dataDefinition === 'picture') === isPictureDescriptor(entry),
                    );
                out.push({ track, descriptor });
            }
        }
        return out;
    }

    private async buildPictureTrack(
        stream: EssenceStream,
        track: MxfTrack,
        descriptor: MxfDescriptor | undefined,
        indexSegments: IndexSegment[],
        reader: ChunkReader,
        diagnostics: DiagnosticContext,
    ): Promise<TrackInfo | undefined> {
        const codec = pictureCodec(descriptor, stream.units[0]?.head);
        if (!codec) {
            diagnostics.note(
                'warn',
                'mxf',
                'MXF_UNSUPPORTED_ESSENCE',
                `MXF picture track ${track.trackId} uses an unrecognised essence ` +
                    `coding; omitted`,
            );
            return undefined;
        }

        const editRate = track.editRateDen > 0 ? track.editRateNum / track.editRateDen : 0;
        const frameDuration = editRate > 0 ? 1 / editRate : 1 / 25;
        let units = stream.units;
        const clipWrapped = units.length === 1 && track.duration !== 1 && track.duration !== 0;
        if (clipWrapped) {
            units = await this.splitClipWrappedPicture(
                units[0]!,
                codec,
                indexSegments,
                reader,
                diagnostics,
            );
            if (!units.length) return undefined;
        }

        const samples: Sample[] = [];
        const mpeg = codec.startsWith('mp4v');
        const timings: MpegFrameTiming[] = [];
        let codecConfig: Uint8Array | undefined;
        let width = descriptor?.displayWidth || descriptor?.width || 0;
        let height = descriptor?.displayHeight || descriptor?.height || 0;
        let pixelAspectRatioNum = 1;
        let pixelAspectRatioDen = 1;
        let resolvedCodec = codec;

        const index = indexSegments.filter(segment => segment.entries.length >= units.length);
        const entries = index.length ? index.flatMap(segment => segment.entries) : [];
        const reorderDelay = entries.reduce(
            (delay, entry) => Math.max(delay, entry.temporalOffset),
            0,
        );
        for (let position = 0; position < units.length; position++) {
            if ((position & 1023) === 0) throwIfAborted(this.signal);
            const unit = units[position]!;
            this.checkPacket(unit.size, 'MXF edit unit');

            const headBytes = unit.head ?? new Uint8Array(0);
            let keyframe = true;
            let type = 1;
            if (mpeg) {
                const picture = inspectMpegPicture('mpeg12', headBytes);
                keyframe = picture?.keyframe ?? false;
                type = picture?.type ?? 1;
                if (!codecConfig) {
                    const config = mpegVideoConfig('mpeg12', headBytes);
                    const format = config && parseMpegVideoConfig('mpeg12', config);
                    if (format) {
                        codecConfig = config;
                        resolvedCodec = format.codec;
                        width = format.width || width;
                        height = format.height || height;
                        pixelAspectRatioNum = format.pixelAspectRatioNum;
                        pixelAspectRatioDen = format.pixelAspectRatioDen;
                    }
                }
            } else if (codec === 'avc1') keyframe = h264Intra(headBytes);

            const entry = entries[position];
            if (entry && codec !== 'avc1' && !mpeg)
                keyframe = (entry.flags & 0x80) !== 0 || (entry.flags & 0x30) === 0;

            const dts = position * frameDuration;
            const sample: Sample = {
                offset: unit.offset,
                size: unit.size,
                timestamp: dts,
                duration: frameDuration,
                isKeyframe: keyframe,
            };

            if (codec === 'avc1' && headBytes.length && isAnnexB(headBytes))
                sample.nalUnitFormat = 'annexb';
            if (entry && !mpeg) {
                // Temporal offsets place each edit unit in display order; decoding runs the reorder
                // delay ahead.
                sample.decodeTimestamp = (position - reorderDelay) * frameDuration;
                sample.timestamp = (position + entry.temporalOffset) * frameDuration;
                sample.compositionTimeOffset = sample.timestamp - sample.decodeTimestamp;
            }

            timings.push({ type, fields: 2, dts: position * 90000 * frameDuration });
            samples.push(sample);
        }

        if (mpeg) {
            completeMpegFrameTimes(timings, 90000 * frameDuration);
            const firstShown = Math.min(...timings.map(timing => timing.pts!));
            samples.forEach((sample, position) => {
                const timing = timings[position]!;
                sample.decodeTimestamp = (timing.dts! - firstShown) / 90000;
                sample.timestamp = (timing.pts! - firstShown) / 90000;
                sample.compositionTimeOffset = sample.timestamp - sample.decodeTimestamp;
            });
            if (!codecConfig) {
                diagnostics.recover(
                    {
                        code: 'MXF_VIDEO_UNCONFIGURED',
                        format: 'mxf',
                        message:
                            `MXF MPEG-2 track ${track.trackId} carries no sequence header ` +
                            `in its inspected frames`,
                    },
                    'MXF MPEG-2 essence carries no sequence header',
                );
            }
        }

        if (
            codec === 'avc1' &&
            !entries.length &&
            samples.some((sample, at) => at > 0 && !sample.isKeyframe)
        ) {
            diagnostics.note(
                'warn',
                'mxf',
                'MXF_NO_INDEX',
                `MXF H.264 track ${track.trackId} has no index; shown in decode order`,
            );
        }

        if (!samples.length) return undefined;
        const aspect =
            descriptor &&
            descriptor.aspectNum > 0 &&
            descriptor.aspectDen > 0 &&
            width > 0 &&
            height > 0
                ? { num: descriptor.aspectNum * height, den: descriptor.aspectDen * width }
                : undefined;
        if (
            aspect &&
            pixelAspectRatioNum === 1 &&
            pixelAspectRatioDen === 1 &&
            aspect.num !== aspect.den
        ) {
            pixelAspectRatioNum = aspect.num;
            pixelAspectRatioDen = aspect.den;
        }

        const last = samples[samples.length - 1]!;
        return {
            codec: resolvedCodec,
            width,
            height,
            ...(pixelAspectRatioNum !== pixelAspectRatioDen
                ? {
                      pixelAspectRatioNum,
                      pixelAspectRatioDen,
                      displayWidth: Math.round((width * pixelAspectRatioNum) / pixelAspectRatioDen),
                      displayHeight: height,
                  }
                : {}),
            sampleRate: 0,
            channelCount: 0,
            duration: decodeTime(last) + last.duration,
            samples,
            codecConfig,
            timescale: track.editRateNum > 0 ? track.editRateNum : undefined,
        };
    }

    /**
     * Frames of a clip-wrapped picture essence, from the index table when present, else from MPEG
     * start codes.
     */
    private async splitClipWrappedPicture(
        unit: EssenceUnit,
        codec: string,
        indexSegments: IndexSegment[],
        reader: ChunkReader,
        diagnostics: DiagnosticContext,
    ): Promise<EssenceUnit[]> {
        const offsets: number[] = [];
        const cbr = indexSegments.find(segment => segment.editUnitByteCount > 0);
        const vbr = indexSegments.filter(segment => segment.entries.length > 0);

        if (cbr) {
            for (let at = 0; at + cbr.editUnitByteCount <= unit.size; at += cbr.editUnitByteCount)
                offsets.push(at);
        } else if (vbr.length) {
            for (const segment of vbr)
                for (const entry of segment.entries) offsets.push(entry.streamOffset);
        } else if (codec.startsWith('mp4v')) {
            const run = { at: -1 };
            for (let at = 0; at < unit.size;) {
                const chunkSize = Math.min(1 << 20, unit.size - at);
                const window = await reader.bytes(unit.offset + at, chunkSize);
                frameStarts(window, at, offsets, run);
                throwIfAborted(this.signal);
                at += Math.max(1, chunkSize - 8);
            }
        } else {
            diagnostics.note(
                'warn',
                'mxf',
                'MXF_CLIP_WRAPPED',
                'Omitted clip-wrapped MXF pictures that have no index',
            );
            return [];
        }

        const sorted = [...new Set(offsets)]
            .filter(at => at >= 0 && at < unit.size)
            .sort((a, b) => a - b);
        const units: EssenceUnit[] = [];
        for (let index = 0; index < sorted.length; index++) {
            const start = sorted[index]!;
            const end = index + 1 < sorted.length ? sorted[index + 1]! : unit.size;
            if (end <= start) continue;
            this.budget.reserveSamples(1, 320, 'MXF essence index');
            units.push({
                offset: unit.offset + start,
                size: end - start,
                head: await reader.bytes(
                    unit.offset + start,
                    Math.min(end - start, VIDEO_INSPECT_BYTES),
                ),
            });
        }
        return units;
    }

    private async buildSoundTrack(
        stream: EssenceStream,
        track: MxfTrack,
        descriptor: MxfDescriptor | undefined,
        tracks: { track: MxfTrack }[],
        reader: ChunkReader,
        diagnostics: DiagnosticContext,
    ): Promise<TrackInfo | undefined> {
        const first = stream.units[0];
        if (!first || !descriptor) return undefined;
        const sampleRate = descriptor.audioRate > 0 ? Math.round(descriptor.audioRate) : 48000;
        const coding = descriptor.codingUl ? hex(descriptor.codingUl, 0, 16) : '';
        const compressed =
            coding.startsWith('060e2b34040101') && coding.slice(16, 28) === '040202020302'
                ? 'mpeg'
                : coding.slice(16, 28) === '040202020303'
                  ? 'aac'
                  : undefined;
        if (compressed)
            return this.buildCompressedSoundTrack(
                stream,
                sampleRate,
                descriptor.channels,
                compressed,
                reader,
            );

        // SMPTE 331M subframes appear in D-10 content package sound elements only; 382M AES3/BWF
        // hold raw PCM.
        const aes3 = stream.itemType === 0x06;
        const bits =
            descriptor.bits === 24 ||
            descriptor.bits === 16 ||
            descriptor.bits === 32 ||
            descriptor.bits === 8
                ? descriptor.bits
                : 16;
        let channels = descriptor.channels > 0 ? descriptor.channels : 2;
        const bytesPerSample = bits / 8;
        const blockAlign =
            descriptor.blockAlign > 0 ? descriptor.blockAlign : channels * bytesPerSample;
        if (!aes3 && blockAlign !== channels * bytesPerSample) {
            diagnostics.note(
                'warn',
                'mxf',
                'MXF_UNSUPPORTED_ESSENCE',
                `MXF sound track ${track.trackId} declares an inconsistent block ` +
                    `alignment; omitted`,
            );
            return undefined;
        }
        if (aes3 && bits !== 16 && bits !== 24) return undefined;
        const codec = bits === 8 ? 'pcm-u8' : `pcm-s${bits}le`;
        const samples: Sample[] = [];
        let frames = 0;
        const pictureRate = tracks.find(entry => entry.track.dataDefinition === 'picture')?.track;
        const editRate = track.editRateDen > 0 ? track.editRateNum / track.editRateDen : 0;
        const unitRate =
            pictureRate && pictureRate.editRateDen > 0
                ? pictureRate.editRateNum / pictureRate.editRateDen
                : editRate;
        const clipWrapped =
            stream.units.length === 1 &&
            (!aes3
                ? first.size / blockAlign > 2 * Math.ceil(sampleRate / (unitRate || 25))
                : false);
        if (clipWrapped) {
            const chunkFrames =
                unitRate > 0 && unitRate <= 1000 ? Math.ceil(sampleRate / unitRate) : 1920;
            const chunkBytes = chunkFrames * blockAlign;
            for (let at = 0; at < first.size; at += chunkBytes) {
                const bytes = Math.min(chunkBytes, first.size - at);
                const count = Math.floor(bytes / blockAlign);
                if (count <= 0) break;
                this.budget.reserveSamples(1, 256, 'MXF sound index');
                samples.push({
                    offset: first.offset + at,
                    size: count * blockAlign,
                    timestamp: frames / sampleRate,
                    duration: count / sampleRate,
                    isKeyframe: true,
                });
                frames += count;
            }
        } else {
            for (const unit of stream.units) {
                this.checkPacket(unit.size, 'MXF edit unit');
                const payload = aes3 ? unit.size - 4 : unit.size;
                const count = aes3 ? Math.floor(payload / 32) : Math.floor(payload / blockAlign);
                if (count <= 0) continue;
                const sample: Sample = {
                    offset: unit.offset,
                    size: aes3 ? 4 + count * 32 : count * blockAlign,
                    timestamp: frames / sampleRate,
                    duration: count / sampleRate,
                    isKeyframe: true,
                };
                if (aes3) sample.aes3 = { channels, bytesPerSample: bits === 24 ? 3 : 2 };
                samples.push(sample);
                frames += count;
            }
        }
        if (!samples.length) return undefined;
        const last = samples[samples.length - 1]!;
        return {
            codec,
            width: 0,
            height: 0,
            sampleRate,
            channelCount: channels,
            duration: last.timestamp + last.duration,
            samples,
            timescale: sampleRate,
        };
    }

    private async buildCompressedSoundTrack(
        stream: EssenceStream,
        sampleRate: number,
        channels: number,
        kind: 'mpeg' | 'aac',
        reader: ChunkReader,
    ): Promise<TrackInfo | undefined> {
        const samples: Sample[] = [];
        let codec = kind === 'aac' ? 'mp4a.40.2' : 'mp2';
        let rate = sampleRate;
        let count = channels;
        let time = 0;

        for (const unit of stream.units) {
            this.checkPacket(unit.size, 'MXF edit unit');

            const head = await reader.bytes(unit.offset, Math.min(unit.size, 16));
            let duration = 0;
            if (kind === 'mpeg') {
                const header = parseMpegAudioHeader(head, 0);
                if (header) {
                    codec = header.format;
                    rate = header.sampleRate;
                    count = header.channels;
                    duration = header.samplesPerFrame / header.sampleRate;
                }
            } else {
                const header = parseAdtsFrameHeader(head, 0);
                if (header) {
                    rate = header.sampleRate;
                    count = header.channels;
                    duration = 1024 / header.sampleRate;
                }
            }

            if (!duration) duration = 1152 / rate;
            this.budget.reserveSamples(1, 256, 'MXF sound index');
            samples.push({
                offset: unit.offset,
                size: unit.size,
                timestamp: time,
                duration,
                isKeyframe: true,
            });
            time += duration;
        }

        if (!samples.length) return undefined;
        return {
            codec,
            width: 0,
            height: 0,
            sampleRate: rate,
            channelCount: count,
            duration: time,
            samples,
        };
    }
}

/**
 * Legacy AAF data definitions (Avid OP-Atom) stored as byte-swapped GUIDs: picture 6f3c8ce1, sound
 * 78e1ebe1.
 */
const LEGACY_PICTURE_DEFINITION = '807d006008143e6f6f3c8ce16cef11d2';
const LEGACY_SOUND_DEFINITION = '807d006008143e6f78e1ebe16cef11d2';

function dataDefinitionOf(ul: Uint8Array): MxfTrack['dataDefinition'] {
    if (ul.length < 16) return 'other';
    const value = hex(ul, 0, 16);
    if (value === LEGACY_PICTURE_DEFINITION) return 'picture';
    if (value === LEGACY_SOUND_DEFINITION) return 'sound';
    // SMPTE 335M data definitions: 06 0e 2b 34 04 01 01 xx 01 03 02 02 kk (picture 01, sound 02,
    // data 03).
    if (ul[8] !== 0x01 || ul[9] !== 0x03 || ul[10] !== 0x02 || ul[11] !== 0x02) return 'other';
    return ul[12] === 0x01 ? 'picture' : ul[12] === 0x02 ? 'sound' : 'other';
}

function isPictureDescriptor(descriptor: MxfDescriptor): boolean {
    return (
        descriptor.kind === 0x27 ||
        descriptor.kind === 0x28 ||
        descriptor.kind === 0x29 ||
        descriptor.kind === 0x51
    );
}

/**
 * Codec of a picture descriptor by its essence coding label, container label or the first frame's
 * syntax.
 */
function pictureCodec(
    descriptor: MxfDescriptor | undefined,
    head: Uint8Array | undefined,
): string | undefined {
    const coding = descriptor?.codingUl ? hex(descriptor.codingUl, 0, 16) : '';
    const container = descriptor?.essenceContainer ? hex(descriptor.essenceContainer, 0, 16) : '';
    const codingFamily = coding.slice(16, 24);
    const codingKind = coding.slice(24, 28);
    if (codingFamily === '04010202' && (codingKind === '0131' || codingKind === '0132'))
        return 'avc1';
    if (codingFamily === '04010202' && codingKind === '0120') return 'mp4v.20';
    if (codingFamily === '04010202' && coding.slice(24, 26) === '01')
        return codingKind.startsWith('011') ? 'mp4v.6a' : 'mp4v.61';
    if (
        codingFamily === '04010202' &&
        coding.slice(24, 26) === '03' &&
        coding.slice(26, 28) === '01'
    )
        return 'jpeg2000';
    if (
        codingFamily === '04010202' &&
        coding.slice(24, 26) === '03' &&
        coding.slice(26, 28) === '06'
    )
        return PRORES_PROFILES[Number.parseInt(coding.slice(28, 30), 16)] ?? 'apcn';
    if (coding.slice(16, 26) === '0401020271') return 'dnxhd';

    const containerFamily = container.slice(16, 28);
    if (containerFamily === '0d0103010204')
        return head && isAnnexB(head) && h264Sample(head) ? 'avc1' : 'mp4v.61';
    if (containerFamily === '0d0103010210') return 'avc1';
    if (containerFamily === '0d0103010211') return 'dnxhd';
    if (containerFamily === '0d010301020c') return 'jpeg2000';
    if (containerFamily === '0d010301021c') return 'apcn';
    if (containerFamily === '0d0103010201' || containerFamily === '0d0103010205') return 'mp4v.61';
    if (head && isAnnexB(head)) return h264Sample(head) ? 'avc1' : 'mp4v.61';
    return undefined;
}

const PRORES_PROFILES: Readonly<Record<number, string>> = {
    1: 'apco',
    2: 'apcs',
    3: 'apcn',
    4: 'apch',
    5: 'ap4h',
    6: 'ap4x',
};

function h264Sample(head: Uint8Array): boolean {
    for (const nal of splitAnnexBNals(head)) {
        const type = nal[0]! & 31;
        if (
            (nal[0]! & 0x80) === 0 &&
            (type === 7 || type === 9 || type === 5 || type === 1 || type === 6)
        )
            return true;
        return false;
    }
    return false;
}

/** The mxf plugin's 'mxf' reader, which its index loads on first use. */
export const mxfReader: Reader = {
    read: (source, options) => new MxfDemuxer(options).demux(source, readerDiagnostics(options)),
    capabilities: HANDS_OVER,
};
