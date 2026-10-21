import { oggStreamPages, readPageHeader } from './pages';
import type { DemuxResult, Sample, TrackInfo } from '../../core/model/track';
import type { AudioIndexContext } from '../audio-files/index-context';
import { DemuxError } from '../../core/errors/errors';
import { findOggPage, indexOggAudio } from './audio-index';
import { vorbisCodecConfig } from '../../core/codec-config/audio/vorbis-headers';
import { vorbisCommentTitle } from '../metadata/vorbis-comment';
import { dataView } from '../../core/bytes/byte-fields';
import { asciiAt } from '../detection/head-bytes';

type OggKind =
    'opus' | 'vorbis' | 'flac' | 'speex' | 'theora' | 'skeleton' | 'ogm' | 'vp8' | 'unknown';

/** Logical streams read by the multi-stream path even when they are alone in the file. */
const VIDEO_KINDS: ReadonlySet<OggKind> = new Set(['theora', 'ogm', 'vp8']);

interface OggStream {
    readonly serial: number;
    readonly kind: OggKind;
}

function kindOf(packet: Uint8Array): OggKind {
    if (asciiAt(packet, 0, 'OpusHead')) return 'opus';
    if (asciiAt(packet, 0, '\x01vorbis')) return 'vorbis';
    // FLAC 1.0.x wrote the bare 'fLaC' marker as its first packet, before the 0x7F 'FLAC' mapping
    // of FLAC 1.1.1.
    if (asciiAt(packet, 0, '\x7fFLAC') || (packet.length === 4 && asciiAt(packet, 0, 'fLaC')))
        return 'flac';
    if (asciiAt(packet, 0, 'Speex   ')) return 'speex';
    if (asciiAt(packet, 0, '\x80theora')) return 'theora';
    if (asciiAt(packet, 0, 'fishead')) return 'skeleton';
    // OGM: DirectShow stream headers, in the later layout or the original one.
    if (
        packet[0] === 1 &&
        (['video\0', 'audio\0', 'text\0'].some(type => asciiAt(packet, 1, type)) ||
            asciiAt(packet, 0, '\x01Direct Show Samples embedded in Ogg'))
    )
        return 'ogm';
    if (asciiAt(packet, 0, 'OVP80\x01')) return 'vp8';
    return 'unknown';
}

/** The logical streams announced by the leading BOS pages, in order. */
async function discoverStreams(context: AudioIndexContext): Promise<OggStream[]> {
    const streams: OggStream[] = [];
    let offset = 0;
    for (let pages = 0; offset < context.size && pages < 256; pages++) {
        const page = await readPageHeader(context, offset);
        if (!page) break;
        if ((page.flags & 2) === 0) {
            if (streams.length) break;
            throw new DemuxError('Ogg input must start with a BOS page');
        }
        if (streams.some(stream => stream.serial === page.serial)) break;
        const first = page.laces[0] ?? 0;
        const packet = await context.read(offset + 27 + page.laces.length, Math.min(first, 64));
        streams.push({ serial: page.serial, kind: kindOf(packet) });
        offset += page.size;
    }
    if (!streams.length) throw new DemuxError('Ogg input holds no logical stream');
    return streams;
}

interface TheoraInfo {
    readonly version: number;
    readonly width: number;
    readonly height: number;
    readonly fpsNum: number;
    readonly fpsDen: number;
    readonly aspectNum: number;
    readonly aspectDen: number;
    readonly granuleShift: number;
}

function parseTheoraHeader(packet: Uint8Array): TheoraInfo {
    if (packet.length < 42 || !asciiAt(packet, 0, '\x80theora'))
        throw new DemuxError('Invalid Theora identification header');
    const view = dataView(packet);
    const u24 = (at: number): number =>
        (packet[at]! << 16) | (packet[at + 1]! << 8) | packet[at + 2]!;
    const info: TheoraInfo = {
        version: (packet[7]! << 16) | (packet[8]! << 8) | packet[9]!,
        width: u24(14),
        height: u24(17),
        fpsNum: view.getUint32(22, false),
        fpsDen: view.getUint32(26, false),
        aspectNum: u24(30),
        aspectDen: u24(33),
        granuleShift: ((packet[40]! & 3) << 3) | (packet[41]! >> 5),
    };
    if (info.width < 1 || info.height < 1 || info.fpsNum < 1 || info.fpsDen < 1)
        throw new DemuxError('Theora header declares no picture size or frame rate');
    return info;
}

async function indexTheora(context: AudioIndexContext, serial: number): Promise<TrackInfo> {
    const headers: Uint8Array[] = [];
    const samples: Sample[] = [];
    const state = { recovered: false };
    let info: TheoraInfo | undefined;
    let pending: { offset: number; data: Uint8Array; keyframe: boolean }[] = [];
    let nextIndex = 0;
    let eos = false;

    const frameOf = (granule: number): number => {
        const shift = info!.granuleShift;
        const key = Math.floor(granule / 2 ** shift);
        return key + (granule - key * 2 ** shift) - (info!.version >= 0x030201 ? 1 : 0);
    };

    const flushPending = (lastIndex: number): void => {
        let index = lastIndex - pending.length + 1;
        for (const frame of pending) {
            if (!frame.data.length) {
                const previous = samples[samples.length - 1];
                if (previous) previous.duration += info!.fpsDen / info!.fpsNum;
                index++;
                continue;
            }

            context.budget.reserveSamples(1, 256, 'Ogg Theora sample index');
            samples.push({
                offset: Math.max(0, frame.offset),
                size: frame.data.length,
                data: frame.offset < 0 ? frame.data : undefined,
                timestamp: (index * info!.fpsDen) / info!.fpsNum,
                duration: info!.fpsDen / info!.fpsNum,
                isKeyframe: frame.keyframe,
            });
            index++;
        }
        pending = [];
        nextIndex = lastIndex + 1;
    };

    for await (const page of oggStreamPages(context, serial, state, true)) {
        let completedFrames = 0;
        for (const { offset, data } of page.packets) {
            if (!data.length) {
                if (headers.length === 3) {
                    pending.push({ offset, data, keyframe: false });
                    completedFrames++;
                }
                continue;
            }
            if (headers.length < 3) {
                if ((data[0]! & 0x80) === 0)
                    throw new DemuxError('Theora data packet precedes its three header packets');
                if (headers.length === 0) info = parseTheoraHeader(data);
                else if (headers.length === 1)
                    context.metadata.title ??= vorbisCommentTitle(data.subarray(7));
                headers.push(data.slice());
            } else if ((data[0]! & 0x80) !== 0) {
                context.diagnostics.recover({
                    code: 'OGG_THEORA_EXTRA_HEADER',
                    format: 'ogg',
                    offset: page.offset,
                    message: 'Ignored a Theora header packet among coded frames',
                });
            } else {
                pending.push({ offset, data, keyframe: (data[0]! & 0x40) === 0 });
                completedFrames++;
            }
        }

        if (page.granule !== null && info && completedFrames > 0 && pending.length) {
            const last = frameOf(page.granule);
            if (last < nextIndex + pending.length - 1) {
                context.diagnostics.recover({
                    code: 'OGG_THEORA_GRANULE',
                    format: 'ogg',
                    offset: page.offset,
                    message:
                        `Theora granule position regresses at byte ${page.offset}; frames ` +
                        `keep their order`,
                });
                flushPending(nextIndex + pending.length - 1);
            } else flushPending(last);
        }

        eos = page.eos;
    }

    let recovered = state.recovered;
    if (!info || headers.length < 3)
        throw new DemuxError('Ogg Theora stream lacks its three header packets');
    if (pending.length) flushPending(nextIndex + pending.length - 1);
    if (!samples.length) throw new DemuxError('Ogg Theora stream holds no coded frames');
    if (!eos) {
        context.diagnostics.recover({
            code: 'OGG_MISSING_EOS',
            format: 'ogg',
            message: 'Ogg Theora stream ends without an EOS page; the complete frames are retained',
        });
        recovered = true;
    }

    const last = samples[samples.length - 1]!;
    const display =
        info.aspectNum > 0 && info.aspectDen > 0 && info.aspectNum !== info.aspectDen
            ? {
                  pixelAspectRatioNum: info.aspectNum,
                  pixelAspectRatioDen: info.aspectDen,
                  displayWidth: Math.round((info.width * info.aspectNum) / info.aspectDen),
                  displayHeight: info.height,
              }
            : {};
    return {
        codec: 'theora',
        codecConfig: vorbisCodecConfig(headers),
        width: info.width,
        height: info.height,
        ...display,
        sampleRate: 0,
        channelCount: 0,
        duration: last.timestamp + last.duration,
        samples,
        timescale: info.fpsNum,
        ...(recovered ? { incomplete: true } : {}),
    };
}

/**
 * Indexes every supported logical stream of an Ogg file: Theora, VP8 and OGM (DirectShow) streams
 * plus Opus, Vorbis, FLAC and Speex audio. A single audio stream keeps the strict single-stream
 * checks; `requireOpus` (the .opus format) takes the first Opus stream.
 */
export async function indexOggStreams(
    context: AudioIndexContext,
    requireOpus: boolean,
): Promise<DemuxResult> {
    const streams = await discoverStreams(context);
    const result: DemuxResult = { videoTracks: [], audioTracks: [] };

    if (streams.length === 1 && streams[0]!.kind === 'unknown')
        throw new DemuxError('Ogg stream codec is not supported');

    if (streams.length === 1 && !VIDEO_KINDS.has(streams[0]!.kind)) {
        result.audioTracks.push(await indexOggAudio(context, requireOpus));
        return result;
    }

    const usable = streams.filter(
        stream => stream.kind !== 'skeleton' && stream.kind !== 'unknown',
    );
    if (requireOpus) {
        const opus = usable.find(stream => stream.kind === 'opus');
        if (!opus) throw new DemuxError('Expected Ogg Opus audio');
        const track = await indexOggAudio(context, true, opus.serial);
        track.id = streams.indexOf(opus) + 1;
        result.audioTracks.push(track);
        return result;
    }

    for (const stream of streams) {
        const id = streams.indexOf(stream) + 1;
        if (stream.kind === 'skeleton') continue;
        if (stream.kind === 'unknown') {
            context.diagnostics.warn({
                code: 'OGG_STREAM_UNSUPPORTED',
                format: 'ogg',
                message:
                    `Ogg logical stream ${stream.serial} uses an unrecognised codec; it is ` +
                    `omitted`,
            });
            continue;
        }

        try {
            let kind: 'video' | 'audio' | 'subtitle' = stream.kind === 'theora' ? 'video' : 'audio';
            let track: TrackInfo;
            if (stream.kind === 'ogm' || stream.kind === 'vp8') {
                // The OGM and VP8 mappings are rare; their reader loads only for files that use
                // them.
                const extra = await import('./extra-streams');
                ({ kind, track } =
                    stream.kind === 'ogm'
                        ? await extra.indexOgmStream(context, stream.serial)
                        : await extra.indexOggVp8(context, stream.serial));
            } else
                track =
                    stream.kind === 'theora'
                        ? await indexTheora(context, stream.serial)
                        : await indexOggAudio(context, false, stream.serial);

            track.id = id;
            (kind === 'video'
                ? result.videoTracks
                : kind === 'audio'
                  ? result.audioTracks
                  : (result.subtitleTracks ??= [])
            ).push(track);
        } catch (error) {
            if (
                !(error instanceof DemuxError) ||
                usable.length === 1 ||
                context.diagnostics.validation === 'strict'
            )
                throw error;
            context.diagnostics.warn({
                code: 'OGG_STREAM_UNUSABLE',
                format: 'ogg',
                message: `Omitted Ogg stream ${stream.serial}, which could not be indexed`,
            });
        }
    }

    if (!result.videoTracks.length && !result.audioTracks.length && !result.subtitleTracks?.length)
        throw new DemuxError('Ogg input holds no supported logical stream');

    const link = await laterLink(context, new Set(streams.map(stream => stream.serial)));
    if (link >= 0)
        context.diagnostics.warn({
            code: 'OGG_CHAIN_IGNORED',
            format: 'ogg',
            offset: link,
            message: `Ignored the chained Ogg links from byte ${link}`,
        });
    return result;
}

/**
 * Offset of the first BOS page of a logical stream outside `serials` (a later chain link); -1 when
 * none follows.
 */
async function laterLink(
    context: AudioIndexContext,
    serials: ReadonlySet<number>,
): Promise<number> {
    let offset = 0;
    for (let pages = 0; offset < context.size; pages++) {
        if ((pages & 127) === 0) await context.checkpoint();
        const page = await readPageHeader(context, offset);
        if (!page) {
            const next = await findOggPage(context, offset + 1);
            if (next < 0) return -1;
            offset = next;
            continue;
        }
        if ((page.flags & 2) !== 0 && !serials.has(page.serial)) return offset;
        offset += page.size;
    }
    return -1;
}
