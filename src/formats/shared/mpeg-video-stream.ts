import type { Sample, TrackInfo } from '../../core/model/track';
import type { DemuxIndexBudget } from './demux-budget';
import {
    EXTENSION,
    GROUP,
    PICTURE,
    PICTURE_B,
    PICTURE_I,
    PICTURE_P,
    SEQUENCE_END,
    SEQUENCE_HEADER,
    VOP,
    findStartCode,
    mpegVideoConfig,
    parseMpegVideoConfig,
    type MpegVideoSyntax,
} from '../../core/codec-config/video/mpeg-video';

interface MpegVideoPayload {
    readonly data: Uint8Array;
    /** 90 kHz times of the first picture whose start code begins in `data`. */
    readonly pts?: number;
    readonly dts?: number;
    /** Bytes before `data` were lost. */
    readonly discontinuity?: boolean;
    /** Bytes after `data` were lost. */
    readonly incomplete?: boolean;
}

export interface MpegFrameTiming {
    /**
     * Presentation and decode times in the caller's unit; completed where the stream omits them.
     */
    pts?: number;
    dts?: number;
    readonly type: number;
    /** Display duration in fields: 2 is one frame, repeat_first_field adds one or more. */
    readonly fields: number;
}

export interface MpegVideoFrame extends MpegFrameTiming {
    readonly data: Uint8Array;
    readonly keyframe: boolean;
}

interface TimestampMark {
    readonly position: number;
    readonly pts?: number;
    readonly dts?: number;
    used: boolean;
}

const LOOKAHEAD = 9;

/** Frames cut by lost data a stream keeps aside for when it holds no complete frame. */
const MAX_SALVAGED_FRAMES = 16;

/** Studio-profile slice start code, which continues the current VOP. */
const MPEG4_SLICE = 0xb7;

function isSlice(code: number): boolean {
    return code >= 0x01 && code <= 0xaf;
}

/**
 * Splits an elementary stream into access units of one coded frame, following ffmpeg's parsers: an
 * MPEG-1/2 frame ends at the first non-slice start code after its slices (two field pictures form
 * one frame, a sequence end code stays with the frame), an MPEG-4 frame ends at the first start
 * code after its VOP. A PES timestamp belongs to the first picture whose start code begins in that
 * PES.
 */
export class MpegVideoAccessUnits {
    readonly frames: MpegVideoFrame[] = [];
    private buffer = new Uint8Array(1 << 16);
    private length = 0;
    private base = 0;
    private scanned = 0;
    private unit = -1;
    private picture = -1;
    private type = 0;
    private headers = false;
    private coded = false;
    private fields = 2;
    private state = 0;
    private progressiveSequence = false;
    private pts?: number;
    private dts?: number;
    private marks: TimestampMark[] = [];
    /** A frame cut by lost data, with the slices that followed the loss, kept aside. */
    private salvage?: { frame: MpegVideoFrame; parts: Uint8Array[] };
    /** Frames cut by lost data, which a stream without a complete frame keeps. */
    private readonly salvaged: MpegVideoFrame[] = [];

    constructor(
        private readonly syntax: MpegVideoSyntax,
        private readonly onDamage: (message: string) => void,
    ) {}

    push(payload: MpegVideoPayload): void {
        if (payload.discontinuity)
            this.resynchronize('Discarded an MPEG video frame interrupted by lost data');
        this.append(payload);
        this.scan(!!payload.incomplete);
        if (payload.incomplete)
            this.resynchronize('Discarded an MPEG video frame cut by lost data');
    }

    /**
     * Completes the final frame at the end of the stream. A stream without a complete frame keeps
     * the frames lost data cut, as ffmpeg reads them, rather than leaving nothing to read.
     */
    end(): void {
        this.scan(true);
        if (this.unit >= 0) this.finish(this.base + this.length);
        this.reset();
        this.closeSalvage();
        if (this.frames.length || !this.salvaged.length) return;
        this.frames.push(...this.salvaged);
        this.onDamage(`Kept ${this.salvaged.length} damaged MPEG video frame(s): none is complete`);
    }

    /** Keeps the frame lost data cut with the slices that followed it, up to a few frames. */
    private closeSalvage(): void {
        const salvage = this.salvage;
        this.salvage = undefined;
        if (!salvage || this.salvaged.length >= MAX_SALVAGED_FRAMES) return;
        const length = salvage.parts.reduce((sum, part) => sum + part.length, 0);
        const data = new Uint8Array(length);
        let at = 0;
        for (const part of salvage.parts) {
            data.set(part, at);
            at += part.length;
        }
        this.salvaged.push({ ...salvage.frame, data });
    }

    private append(payload: MpegVideoPayload): void {
        const data = payload.data;
        const keep = this.unit >= 0 ? this.unit - this.base : Math.max(0, this.length - 3);
        if (keep > 0 && keep >= this.length >> 1) {
            this.buffer.copyWithin(0, keep, this.length);
            this.length -= keep;
            this.base += keep;
            this.scanned = Math.max(0, this.scanned - keep);
        }

        if (this.length + data.length > this.buffer.length) {
            let size = this.buffer.length;
            while (size < this.length + data.length) size *= 2;
            const grown = new Uint8Array(size);
            grown.set(this.buffer.subarray(0, this.length));
            this.buffer = grown;
        }

        this.marks.push({
            position: this.base + this.length,
            pts: payload.pts,
            dts: payload.dts,
            used: false,
        });
        this.buffer.set(data, this.length);
        this.length += data.length;
    }

    private scan(final: boolean): void {
        const buffer = this.buffer;
        for (;;) {
            const at = findStartCode(buffer, this.scanned, this.length);
            if (at < 0 || at + 3 >= this.length) {
                this.scanned = Math.max(this.scanned, this.length - 3);
                return;
            }
            if (!final && at + LOOKAHEAD > this.length) {
                this.scanned = at;
                return;
            }
            this.scanned = at + 4;
            if (this.syntax === 'mpeg12') this.mpeg12(at);
            else this.mpeg4(at);
        }
    }

    private byte(at: number): number {
        return at < this.length ? this.buffer[at]! : 0;
    }

    private mpeg12(at: number): void {
        const code = this.buffer[at + 3]!;
        if (this.unit < 0) this.unit = this.base + at;
        if (code === SEQUENCE_END) {
            this.finish(this.base + Math.min(at + 4, this.length));
            this.scanned = Math.min(at + 4, this.length);
            return;
        }

        if (this.state === 4 && !isSlice(code)) this.finish(this.base + at);
        if (isSlice(code)) {
            if (this.state === 0) this.state = 4;
            this.coded = true;
            return;
        }

        if (code === SEQUENCE_HEADER) {
            if (this.state === 2) this.state = 0;
            if (this.picture < 0) this.headers = true;
        } else if (code === GROUP) {
            if (this.picture < 0) this.headers = true;
        } else if (code === PICTURE) {
            if (this.picture < 0) this.openPicture(at, (this.byte(at + 5) >> 3) & 7);
        } else if (code === EXTENSION && this.state < 4) {
            const id = this.byte(at + 4) >> 4;
            if (id === 1) this.progressiveSequence = (this.byte(at + 5) & 8) !== 0;
            else if (id === 8) {
                const structure = this.byte(at + 6) & 3;
                const topFirst = (this.byte(at + 7) & 0x80) !== 0;
                const repeatFirst = (this.byte(at + 7) & 2) !== 0;
                const progressiveFrame = (this.byte(at + 8) & 0x80) !== 0;
                this.fields = !repeatFirst
                    ? 2
                    : this.progressiveSequence
                      ? topFirst
                          ? 6
                          : 4
                      : progressiveFrame
                        ? 3
                        : 2;
                this.state = structure !== 3 && this.state === 0 ? 2 : 0;
            }
        }
    }

    private mpeg4(at: number): void {
        const code = this.buffer[at + 3]!;
        if (this.unit < 0) this.unit = this.base + at;
        if (this.state === 4 && code !== MPEG4_SLICE) this.finish(this.base + at);
        if (code !== VOP) return;
        const coding = this.byte(at + 4) >> 6;
        this.openPicture(at, coding === 0 ? PICTURE_I : coding === 2 ? PICTURE_B : PICTURE_P);
        this.headers = true;
        this.coded = true;
        this.state = 4;
    }

    private openPicture(at: number, type: number): void {
        const position = this.base + at;
        this.picture = position;
        this.type = type;
        while (this.marks.length > 1 && this.marks[1]!.position <= position) this.marks.shift();
        const mark = this.marks[0];
        if (mark && mark.position <= position && !mark.used && mark.pts !== undefined) {
            mark.used = true;
            this.pts = mark.pts;
            this.dts = mark.dts ?? mark.pts;
        }
    }

    private finish(end: number): void {
        const start = this.unit;
        if (start >= 0 && end > start) {
            if (this.picture >= 0 && this.coded) {
                this.closeSalvage();
                this.frames.push({
                    data: this.buffer.slice(start - this.base, end - this.base),
                    pts: this.pts,
                    dts: this.dts,
                    type: this.type,
                    keyframe: this.type === PICTURE_I && this.headers,
                    fields: this.fields,
                });
            } else if (this.picture >= 0 || this.coded) {
                this.onDamage('Discarded MPEG video data that holds no complete picture');

                // Slices after lost data continue the picture the loss cut.
                if (this.salvage && this.picture < 0)
                    this.salvage.parts.push(this.buffer.slice(start - this.base, end - this.base));
                this.closeSalvage();
            }
        }

        this.unit = end;
        this.picture = -1;
        this.type = 0;
        this.headers = false;
        this.coded = false;
        this.fields = 2;
        this.state = 0;
        this.pts = undefined;
        this.dts = undefined;
    }

    private resynchronize(message: string): void {
        this.scan(true);
        if (this.unit >= 0 && (this.picture >= 0 || this.coded)) {
            this.onDamage(message);
            if (this.picture >= 0 && this.frames.length === 0) {
                this.closeSalvage();
                this.salvage = {
                    frame: {
                        data: new Uint8Array(0),
                        pts: this.pts,
                        dts: this.dts,
                        type: this.type,
                        keyframe: this.type === PICTURE_I && this.headers,
                        fields: this.fields,
                    },
                    parts: [this.buffer.slice(this.unit - this.base, this.length)],
                };
            }
        }
        this.reset();
    }

    private reset(): void {
        this.base += this.length;
        this.length = 0;
        this.scanned = 0;
        this.unit = -1;
        this.picture = -1;
        this.type = 0;
        this.headers = false;
        this.coded = false;
        this.fields = 2;
        this.state = 0;
        this.pts = undefined;
        this.dts = undefined;
        this.marks = [];
    }
}

/**
 * Fills the timestamps a stream leaves out with the MPEG decoding model: decode times advance by
 * each frame's duration, B-pictures are presented when decoded, and an anchor picture is presented
 * when the next anchor is decoded unless the stated anchors show no reordering delay (or, without
 * stated anchors, no B-pictures exist).
 */
export function completeMpegFrameTimes(frames: MpegFrameTiming[], frameDuration: number): void {
    let delayed: boolean | undefined;
    for (const frame of frames) {
        if (frame.type === PICTURE_B || frame.pts === undefined || frame.dts === undefined)
            continue;
        delayed = frame.pts > frame.dts;
        if (delayed) break;
    }
    delayed ??= frames.some(frame => frame.type === PICTURE_B);

    const duration = (frame: MpegFrameTiming): number => (frameDuration * frame.fields) / 2;
    for (const frame of frames)
        if (
            frame.dts === undefined &&
            frame.pts !== undefined &&
            (!delayed || frame.type === PICTURE_B)
        )
            frame.dts = frame.pts;

    let previous: MpegFrameTiming | undefined;
    for (const frame of frames) {
        if (frame.dts === undefined && previous?.dts !== undefined)
            frame.dts = previous.dts + duration(previous);
        previous = frame;
    }

    for (let index = frames.length - 2; index >= 0; index--) {
        const frame = frames[index]!;
        const next = frames[index + 1]!;
        if (frame.dts === undefined && next.dts !== undefined)
            frame.dts = next.dts - duration(frame);
    }

    let clock = 0;
    for (const frame of frames) {
        frame.dts ??= clock;
        clock = frame.dts + duration(frame);
    }

    for (let index = 0; index < frames.length; index++) {
        const frame = frames[index]!;
        if (frame.pts !== undefined) continue;
        if (!delayed || frame.type === PICTURE_B) {
            frame.pts = frame.dts;
            continue;
        }

        let next = index + 1;
        while (next < frames.length && frames[next]!.type === PICTURE_B) next++;
        const last = frames[next - 1]!;
        frame.pts = next < frames.length ? frames[next]!.dts! : last.dts! + duration(last);
    }
}

/**
 * Builds a demuxed track from complete frames; the configuration comes from the first sequence
 * header or VOL. Without one the stream cannot be decoded or copied: `onUnusable` receives the
 * reason and no track is built.
 */
export function buildMpegVideoTrack(
    syntax: MpegVideoSyntax,
    frames: MpegVideoFrame[],
    budget: DemuxIndexBudget,
    context: string,
    onUnusable: (message: string) => void,
): TrackInfo | undefined {
    let codecConfig: Uint8Array | undefined;
    for (const frame of frames) {
        codecConfig = mpegVideoConfig(syntax, frame.data);
        if (codecConfig) break;
    }

    const format = codecConfig && parseMpegVideoConfig(syntax, codecConfig);
    if (!format) {
        const header = syntax === 'mpeg12' ? 'sequence header' : 'video object layer';
        onUnusable(`${context} carries no valid ${header}, so it cannot be decoded or copied`);
        return undefined;
    }

    let frameTicks =
        format.frameRateNum > 0 ? (90000 * format.frameRateDen) / format.frameRateNum : 0;
    if (!(frameTicks > 0)) {
        const steps: number[] = [];
        for (let index = 1; index < frames.length; index++) {
            const step = (frames[index]!.dts ?? NaN) - (frames[index - 1]!.dts ?? NaN);
            if (step > 0 && step <= 900000) steps.push(step);
        }
        steps.sort((a, b) => a - b);
        frameTicks = steps[steps.length >> 1] ?? 3600;
    }

    completeMpegFrameTimes(frames, frameTicks);
    const samples: Sample[] = [];
    for (let index = 0; index < frames.length; index++) {
        const frame = frames[index]!;
        budget.reserveSamples(1, 256, `${context} sample index`);
        const step = index + 1 < frames.length ? frames[index + 1]!.dts! - frame.dts! : 0;
        const ticks = step > 0 && step <= 900000 ? step : (frameTicks * frame.fields) / 2;
        samples.push({
            offset: 0,
            size: frame.data.length,
            timestamp: frame.pts! / 90000,
            duration: ticks / 90000,
            isKeyframe: frame.keyframe,
            decodeTimestamp: frame.dts! / 90000,
            compositionTimeOffset: (frame.pts! - frame.dts!) / 90000,
            data: frame.data,
        });
    }

    const last = samples[samples.length - 1];
    return {
        codec: format.codec,
        width: format.width,
        height: format.height,
        displayWidth: format.displayWidth,
        displayHeight: format.displayHeight,
        pixelAspectRatioNum: format.pixelAspectRatioNum,
        pixelAspectRatioDen: format.pixelAspectRatioDen,
        colour: format.colour,
        sampleRate: 0,
        channelCount: 0,
        duration: last ? last.decodeTimestamp! + last.duration : 0,
        samples,
        codecConfig,
    };
}
