import type { MediaFile } from '../read/media-file';
import type { FilePacket, RemuxTrack } from '../media-types';
import { sampleAt } from '../../core/model/sample-index';
import { mediaFileState } from '../read/file-state';
import { holdBytes, releaseBytes } from '../../core/bytes/byte-holds';
import { isPooledBytes } from '../../core/bytes/buffer-pool';
import { copyOutputBytes } from '../../core/bytes/output-data';
import { pictureIsIntra, readsPictureType } from '../../core/codec-config/video/mpeg-video';
import { decodeTime } from '../../core/model/media-time';

/** The times of a sample that frame extraction seeks to. */
interface FrameSample {
    readonly timestamp: number;
    readonly decodeTimestamp?: number;
}

/**
 * The samples of a video track as frame extraction finds and reads them: the searches by
 * presentation time of MediaFile.findSample and the packets from a sample on in decode order.
 */
interface FrameIndex {
    /** The first sample shown, or the first keyframe shown. */
    first(keyframe: boolean): Promise<number | undefined>;
    /** The keyframe shown at `time`, else the last one shown before it. */
    keyframeBefore(time: number): Promise<number | undefined>;
    /**
     * The start of the picture shown at `time` (the last one starting at or before it), when the
     * index knows it without reading on.
     */
    shownAt(time: number): number | undefined;
    /** A sample a search returned, or the first sample. */
    sample(index: number): FrameSample | undefined;
    /**
     * Whether the picture of keyframe `index` is intra by its own header; true where the header
     * cannot tell.
     */
    intra(index: number): Promise<boolean>;
    /** The packets from the decode time of sample `index` on, in decode order. */
    packets(index: number): AsyncGenerator<FilePacket>;
    close(): Promise<void>;
}

/** The frame index of a track of an indexed file. */
export function indexedFrames(file: MediaFile, track: RemuxTrack, signal: AbortSignal): FrameIndex {
    const id = track.description.id;
    const intra = new Map<number, boolean>();
    return {
        first: async keyframe =>
            file.findSample(id, -Number.MAX_VALUE, { mode: 'after', keyframe }),
        keyframeBefore: async time => file.findSample(id, time, { keyframe: true, mode: 'before' }),
        shownAt: time => {
            const index = file.findSample(id, time, { mode: 'before' });
            const sample = index === undefined ? undefined : sampleAt(track.info, index);
            return sample && sample.timestamp <= time ? sample.timestamp : undefined;
        },
        sample: index => sampleAt(track.info, index),
        intra: async index => {
            if (!readsPictureType(track.info.codec)) return true;
            let known = intra.get(index);
            if (known === undefined) {
                const packet = await file.readPacket(id, index, signal);
                known = pictureIsIntra(track.info.codec, packet.data) ?? true;
                intra.set(index, known);
            }
            return known;
        },
        packets: index => {
            const sample = sampleAt(track.info, index);
            return file.packets({
                trackIds: [id],
                start: sample ? decodeTime(sample) : undefined,
                signal,
            });
        },
        close: async () => undefined,
    };
}

/** Bytes of read-ahead packets past which those before the keyframe a search finds are let go. */
const READ_AHEAD_BYTES = 16 * 1024 * 1024;

interface ReadSample extends FrameSample {
    readonly decodeTimestamp: number;
    /** A borrowed packet, and whether its data (1) and alpha bytes (2) are kept with holds. */
    readonly packet: FilePacket;
    readonly held: number;
}

/**
 * A sample by its number and times; a keyframe tells whether its picture is intra by its header.
 */
interface Numbered extends FrameSample {
    readonly index: number;
    readonly intra?: boolean;
}

/**
 * The frame index of a track of an input read in one pass (MediaFile.streamed), without an index of
 * it: samples are numbered in the order read, as an index numbers them, and found by reading ahead.
 * Decode times rise in that order and no sample is shown before it is decoded, so once a sample
 * decoded after `time` is read, no later one is shown at or before it: a search past that point
 * gives what a search of the whole track gives. The packets read ahead are borrowed and kept with
 * holds, and the decoder gets copies; past READ_AHEAD_BYTES those before the keyframe a search
 * finds are let go, and a read of them (the decoder carrying on instead of seeking) or of earlier
 * packets starts a new pass through the input.
 */
export class StreamedFrames implements FrameIndex {
    private pass: AsyncGenerator<FilePacket> | undefined;
    /** Number of the next sample the pass yields, and whether it yielded the last. */
    private passIndex = 0;
    private ended = false;
    /**
     * The samples read and kept, numbered from `start`; `head` is the position of `start` in
     * `kept`.
     */
    private kept: (ReadSample | undefined)[] = [];
    private head = 0;
    private start = 0;
    private keptBytes = 0;
    /**
     * Samples read in any pass, the decode time of the latest, and the keyframes among them by
     * (time, number).
     */
    private read = 0;
    private latestDecode = Number.NEGATIVE_INFINITY;
    private readonly keyframes: Numbered[] = [];
    /** The sample shown first of those read, the earliest number on ties. */
    private earliest: Numbered | undefined;
    private readonly found = new Map<number, Numbered>();

    constructor(
        private readonly file: MediaFile,
        private readonly track: RemuxTrack,
        private readonly signal: AbortSignal,
    ) {}

    async first(keyframe: boolean): Promise<number | undefined> {
        // A sample shown before the first found would be decoded before that one is shown.
        for (;;) {
            const candidate = keyframe ? this.keyframes[0] : this.earliest;
            if (this.ended || (candidate && this.latestDecode > candidate.timestamp))
                return this.result(candidate);
            await this.readNext();
        }
    }

    async keyframeBefore(time: number): Promise<number | undefined> {
        while (!this.ended && !(this.latestDecode > time)) {
            await this.readNext();
            if (this.keptBytes > READ_AHEAD_BYTES) this.letGoBefore(this.searchBefore(time));
        }
        return this.result(this.searchBefore(time));
    }

    shownAt(): number | undefined {
        return undefined;
    }

    sample(index: number): FrameSample | undefined {
        return this.found.get(index) ?? this.at(index);
    }

    async intra(index: number): Promise<boolean> {
        return this.found.get(index)?.intra ?? true;
    }

    async *packets(index: number): AsyncGenerator<FilePacket> {
        if (!this.sample(index) && index < this.start) await this.restart(index);
        while (index >= this.passIndex && !this.ended) await this.readNext();
        const from = this.sample(index);
        if (!from) return;

        // The packets from that decode time on: samples before it decoded at the same time come
        // first.
        const decode = decodeTime(from);
        let next = index;
        while (next > this.start && (this.at(next - 1)?.decodeTimestamp ?? -Infinity) >= decode)
            next--;
        for (;;) {
            if (next < this.start) await this.restart(next);
            while (next >= this.passIndex && !this.ended) await this.readNext();
            const sample = this.at(next);
            if (!sample) return;
            const { packet } = sample;
            const owned = {
                ...packet,
                data: isPooledBytes(packet.data) ? copyOutputBytes(packet.data) : packet.data,
                alphaData:
                    packet.alphaData && isPooledBytes(packet.alphaData)
                        ? copyOutputBytes(packet.alphaData)
                        : packet.alphaData,
            };

            // What the decoder took is let go.
            this.letGoBefore(next + 1);
            next++;
            yield owned;
        }
    }

    async close(): Promise<void> {
        this.letGoBefore(this.passIndex);
        const pass = this.pass;
        this.pass = undefined;
        await pass?.return(undefined);
    }

    /** The keyframe findSample(time, before) gives among those read. */
    private searchBefore(time: number): Numbered | undefined {
        const keyframes = this.keyframes;
        let low = 0;
        let high = keyframes.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (keyframes[middle]!.timestamp < time) low = middle + 1;
            else high = middle;
        }
        return low < keyframes.length && keyframes[low]!.timestamp === time
            ? keyframes[low]
            : keyframes[low - 1];
    }

    private result(sample: Numbered | undefined): number | undefined {
        if (!sample) return undefined;
        this.found.set(sample.index, sample);
        return sample.index;
    }

    private at(index: number): ReadSample | undefined {
        return index < this.start ? undefined : this.kept[this.head + index - this.start];
    }

    /**
     * Lets go of the kept samples before `index` (a sample number, or the keyframe that number is
     * of).
     */
    private letGoBefore(until: number | Numbered | undefined): void {
        const index = typeof until === 'number' ? until : until?.index;
        if (index === undefined || index <= this.start) return;
        while (this.start < index && this.start < this.passIndex) {
            const sample = this.kept[this.head]!;
            this.keptBytes -= sample.packet.data.length;
            if (sample.held & 1) releaseBytes(sample.packet.data);
            if (sample.held & 2) releaseBytes(sample.packet.alphaData!);
            this.kept[this.head++] = undefined;
            this.start++;
        }
        if (this.head === this.kept.length) {
            this.kept = [];
            this.head = 0;
        } else if (this.head > 1024) {
            this.kept = this.kept.slice(this.head);
            this.head = 0;
        }
    }

    /**
     * Starts a new pass through the input and reads up to sample `index`, keeping it and those
     * after.
     */
    private async restart(index: number): Promise<void> {
        await this.close();
        this.passIndex = 0;
        this.ended = false;
        this.start = 0;
        while (this.passIndex < index && !this.ended) {
            await this.readNext();
            this.letGoBefore(index);
        }
    }

    private async readNext(): Promise<void> {
        this.pass ??= mediaFileState(this.file).borrowedPackets({
            trackIds: [this.track.description.id],
            signal: this.signal,
        });
        const step = await this.pass.next();
        if (step.done) {
            this.ended = true;
            return;
        }

        const packet = step.value;
        const index = this.passIndex++;
        const alpha = packet.alphaData !== undefined && holdBytes(packet.alphaData);
        const sample: ReadSample = {
            timestamp: packet.timestamp,
            decodeTimestamp: decodeTime(packet),
            packet,
            held: (holdBytes(packet.data) ? 1 : 0) | (alpha ? 2 : 0),
        };

        this.kept.push(sample);
        this.keptBytes += packet.data.length;

        if (index < this.read) return;
        this.read = index + 1;
        this.latestDecode = sample.decodeTimestamp;
        const shown = {
            index,
            timestamp: packet.timestamp,
            decodeTimestamp: sample.decodeTimestamp,
        };
        if (!this.earliest || shown.timestamp < this.earliest.timestamp) this.earliest = shown;
        if (packet.isKeyframe) {
            const keyframe = {
                ...shown,
                intra: pictureIsIntra(this.track.info.codec, packet.data) ?? true,
            };
            let at = this.keyframes.length;
            while (at > 0 && this.keyframes[at - 1]!.timestamp > shown.timestamp) at--;
            this.keyframes.splice(at, 0, keyframe);
        }
    }
}
