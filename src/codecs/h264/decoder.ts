import { sameBytes } from '../../core/bytes/bytes';
import { isValidAvccWalk } from '../../core/codec-config/video/annexb';
import { MediaForgeError } from '../../core/errors/errors';
import type { EncodedPacket } from '../../core/model/media';
import type { BuiltinVideoDecoder, BuiltinVideoDecoderConfig } from '../../core/contracts/decoder';
import { BitReader } from './bit-reader';
import type { DeblockInput } from './deblock';
import { ReferenceManager } from './dpb';
import {
    isIntraSlice,
    NAL_AUX_SLICE,
    NAL_DPA,
    NAL_END_SEQUENCE,
    NAL_IDR,
    NAL_PPS,
    NAL_SEI,
    NAL_SLICE,
    NAL_SPS,
    parsePps,
    parseSei,
    parseSliceHeader,
    parseSps,
    peekSliceIds,
    resolveScalingLists,
    type Pps,
    type SliceHeader,
    type Sps,
} from './headers';
import type { EntryJob, PictureSlot, SliceJob } from './frame-job';
import {
    FrameThreads,
    keptKernelArena,
    threadedSize,
    threadsAvailable,
    threadWarmup,
} from './frame-threads';
import { createKernelArena, type KernelArena } from './kernels';
import {
    MB_DECODED,
    MB_FIELD,
    MB_INTRA,
    Picture,
    PROGRESS_DONE,
    REF_NONE,
    refEntry,
    type RefEntry,
} from './picture';
import {
    buildDistScale,
    buildImplicitWeights,
    buildScalingTables,
    fieldListsOf,
    type ScalingTables,
    type SliceContext,
} from './slice-context';
import { SliceDecoder } from './slice-decoder';
import { levelDpbFrames, PICT_BOTTOM, PICT_FRAME, PICT_TOP, SLICE_B } from './tables';
import { type PlanarVideoColorSpace, type PlanarVideoFrame } from '../../core/contracts/picture';
import { DecoderWarnings } from '../shared/decoder-warnings';
import { colourSpaceOf, unlabelledColour } from '../../core/codec-config/video/colour-codes';

const MAX_GAP_FRAMES = 16;

interface PendingPicture {
    readonly picture: Picture;
    readonly sps: Sps;
    readonly pps: Pps;
    readonly header: SliceHeader;
    readonly structure: number;
    readonly mbaff: boolean;
    readonly scaling: ScalingTables;
    /** Slices waiting for the picture's frame job when threads decode it. */
    readonly jobs: SliceJob[];
    readonly poc: number;
    sliceCount: number;
    lastFirstMb: number;
    lastList0: RefEntry | undefined;
    /** Pictures the slices read, for the frame job. */
    readonly references: Set<Picture>;
    mmco5: boolean;
    /** Whether a frame job decodes the picture; otherwise the calling thread does. */
    readonly threaded: boolean;
}

function isAnnexBPacket(data: Uint8Array): boolean {
    if (data.length < 4 || data[0] !== 0 || data[1] !== 0) return false;
    return data[2] === 1 || (data[2] === 0 && data[3] === 1);
}

class H264VideoDecoder implements BuiltinVideoDecoder {
    private readonly spsMap = new Map<number, Sps>();
    private readonly ppsMap = new Map<number, Pps>();
    private readonly refs = new ReferenceManager();
    private readonly slices = new SliceDecoder();
    /**
     * WebAssembly SIMD kernels and the memory holding the pictures, or null to decode in
     * JavaScript.
     */
    private readonly arena: KernelArena | null;
    private arenaGeneration = 0;
    /** Kernel memory in use before the first picture: the scratch of every thread. */
    private arenaMark = 0;
    /** Frame threads, once pictures are large enough, and whether the active sequence uses them. */
    private threads: FrameThreads | null = null;
    private threaded = false;
    /**
     * Pictures still to decode on the calling thread before frame jobs take over (threadWarmup).
     */
    private warmup = 0;
    /** Whether a frame job decodes the open field (its second field is decoded the same way). */
    private openFieldThreaded = false;
    /**
     * Output pictures waiting for their frame jobs, with the frame fields known when they were
     * output.
     */
    private readonly outputs: {
        readonly picture: Picture;
        readonly frame: Omit<PlanarVideoFrame, 'data'>;
    }[] = [];
    private scalingKey = 0;
    private scalingLists: Uint8Array[] | null = null;
    private readonly br = new BitReader();
    private readonly pool: Picture[] = [];
    private readonly dpb: Picture[] = [];
    private lengthSize = 4;
    /** Configured from an avcC: packets are length-prefixed unless they only parse as Annex B. */
    private avcC = false;
    private activeSps: Sps | null = null;
    private dpbSize = 1;
    private maxReorder = 0;
    private pictureIds = 0;
    private serials = 0;
    private pending: PendingPicture | null = null;
    private openField: Picture | null = null;
    private openFieldStructure = 0;
    private openFieldHeader: SliceHeader | null = null;
    /** Consecutive fields left without their complementary field. */
    private missingFields = 0;
    /** The open field is output alone when unpaired: it follows at least two unpaired fields. */
    private openFieldShown = false;
    private prevPocMsb = 0;
    private prevPocLsb = 0;
    private prevFrameNumOffset = 0;
    private prevFrameNum = 0;
    private prevRefFrameNum = 0;
    private prevRefHadMmco5 = false;
    private prevRefBottomMmco5 = false;
    private needKeyframe = true;
    private recoveryPending = false;
    private lastOutput: Picture | null = null;
    private readonly warnings: DecoderWarnings;
    private closed = false;
    private greyPicture: Picture | null = null;
    private scaling: ScalingTables | null = null;
    private scalingSps: Sps | null = null;
    private scalingPps: Pps | null = null;
    /**
     * Container picture size that crops a sequence parameter set without a top or left crop, as
     * FFmpeg applies it (cameras code 1920x1088 without cropping and store 1920x1080); cleared once
     * a parameter set rules it out.
     */
    private containerWidth: number;
    private containerHeight: number;
    private visibleRect = { x: 0, y: 0, width: 0, height: 0 };
    /** The configuration applied last; a chunk carrying different bytes reconfigures. */
    private description: Uint8Array | undefined;

    /** A decoder whose kernels run in `arena`, or in JavaScript without one (createH264Decoder). */
    constructor(config: BuiltinVideoDecoderConfig, arena: KernelArena | null) {
        this.warnings = new DecoderWarnings(config.onWarning);
        this.arena = arena;
        this.arenaMark = this.arena ? this.arena.mark : 0;
        this.slices.useKernels(this.arena);
        const { codedWidth, codedHeight } = config;
        const known = Number.isSafeInteger(codedWidth) && Number.isSafeInteger(codedHeight);
        this.containerWidth = known && codedWidth! > 0 && codedHeight! > 0 ? codedWidth! : 0;
        this.containerHeight = this.containerWidth ? codedHeight! : 0;
        this.configure(config.description);
    }

    /** Applies an out-of-band configuration: its parameter sets replace those of the same ids. */
    private configure(description: Uint8Array | undefined): void {
        this.description = description;
        if (description?.length) {
            if (description[0] === 1 && description.length >= 7) this.parseAvcC(description);
            else if (isAnnexBPacket(description)) this.parseNals(description, undefined);
            else
                throw new MediaForgeError(
                    'H.264 configuration is neither avcC nor Annex B',
                    'DECODE',
                );
        }

        for (const sps of this.spsMap.values()) {
            const reason = unsupportedSps(sps);
            if (reason)
                throw new MediaForgeError(
                    `H.264 configuration cannot be decoded: ${reason}`,
                    'DECODE',
                );
        }

        for (const pps of this.ppsMap.values()) {
            if (pps.numSliceGroups > 1)
                throw new MediaForgeError('H.264 slice groups (FMO) are not supported', 'DECODE');
        }
    }

    /**
     * How pictures decode: with the WebAssembly SIMD kernels, also on frame threads, or in
     * JavaScript alone.
     */
    get acceleration(): 'simd+threads' | 'simd' | 'js' {
        return this.threaded ? 'simd+threads' : this.arena ? 'simd' : 'js';
    }

    private parseAvcC(avcC: Uint8Array): void {
        this.lengthSize = (avcC[4] & 3) + 1;
        this.avcC = true;
        let pos = 6;
        const spsCount = avcC[5] & 31;
        for (let i = 0; i < spsCount; i++) {
            if (pos + 2 > avcC.length) throw new MediaForgeError('truncated avcC', 'DECODE');
            const length = (avcC[pos] << 8) | avcC[pos + 1];
            pos += 2;
            this.handleNal(avcC, pos, Math.min(avcC.length, pos + length), undefined);
            pos += length;
        }

        if (pos >= avcC.length) return;
        const ppsCount = avcC[pos++];
        for (let i = 0; i < ppsCount; i++) {
            if (pos + 2 > avcC.length) throw new MediaForgeError('truncated avcC', 'DECODE');
            const length = (avcC[pos] << 8) | avcC[pos + 1];
            pos += 2;
            this.handleNal(avcC, pos, Math.min(avcC.length, pos + length), undefined);
            pos += length;
        }
    }

    decode(chunk: EncodedPacket): readonly PlanarVideoFrame[] {
        if (this.closed) throw new MediaForgeError('H.264 decoder is closed', 'DECODE');
        const config = chunk.codecConfig;
        if (config && config !== this.description && !sameBytes(config, this.description))
            this.configure(config);
        const out: PlanarVideoFrame[] = [];
        this.parseNals(chunk.data, { chunk, out });
        if (this.pending) this.finishPicture(out);
        this.emitOutputs(out, false);
        return out;
    }

    flush(): readonly PlanarVideoFrame[] {
        if (this.closed) throw new MediaForgeError('H.264 decoder is closed', 'DECODE');
        const out: PlanarVideoFrame[] = [];
        if (this.pending) this.finishPicture(out);
        this.closeOpenField(out);
        while (this.bump(out));
        this.emitOutputs(out, true);
        return out;
    }

    private readonly warn = (message: string): void => this.warnings.warn(message);

    /**
     * Moves output pictures to `out` in output order once more wait than frame jobs may run (all of
     * them with `all`), after their jobs finish: frames leave a fixed number of pictures late,
     * however fast the workers are.
     */
    private emitOutputs(out: PlanarVideoFrame[], all: boolean): void {
        const threads = this.threads;
        if (!threads) return;
        threads.collect(this.warn);
        // Pictures decoded on the calling thread leave at once, after those of frame jobs before
        // them.
        while (this.outputs.length > (all || this.warmup > 0 ? 0 : threads.limit)) {
            const next = this.outputs.shift()!;
            threads.awaitWrites(next.picture, this.warn);
            out.push({ ...next.frame, data: next.picture.data.slice() });
        }
        if (all) threads.drain(this.warn);
    }

    reset(): void {
        this.pending = null;
        this.openField = null;
        this.missingFields = 0;
        this.refs.clear();
        for (const pic of this.dpb) pic.needsOutput = false;
        this.dpb.length = 0;
        this.lastOutput = null;
        this.needKeyframe = true;
        this.recoveryPending = false;
        this.prevRefHadMmco5 = false;
        this.warmup = threadWarmup();
    }

    close(): void {
        this.reset();
        this.pool.length = 0;
        this.threads?.close();
        this.threads = null;
        this.closed = true;
    }

    /** Walks the NAL units of an AVCC or Annex B packet. */
    private parseNals(
        data: Uint8Array,
        io: { chunk: EncodedPacket; out: PlanarVideoFrame[] } | undefined,
    ): void {
        if (
            isAnnexBPacket(data) &&
            !(this.avcC && isValidAvccWalk(data, this.lengthSize as 1 | 2 | 3 | 4))
        ) {
            let i = 0;
            let start = -1;
            const length = data.length;
            while (i + 2 < length) {
                if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
                    if (start >= 0) {
                        let end = i;
                        while (end > start && data[end - 1] === 0) end--;
                        this.handleNal(data, start, end, io);
                    }
                    i += 3;
                    start = i;
                } else i++;
            }

            if (start >= 0 && start < length) this.handleNal(data, start, length, io);
            return;
        }

        let pos = 0;
        const size = this.lengthSize;
        while (pos + size <= data.length) {
            let length = 0;
            for (let i = 0; i < size; i++) length = length * 256 + data[pos + i];
            pos += size;
            if (length === 0) continue;
            if (pos + length > data.length) {
                this.warnings.warn('NAL unit length exceeds the packet; truncated');
                length = data.length - pos;
            }

            this.handleNal(data, pos, pos + length, io);
            pos += length;
        }
    }

    private handleNal(
        data: Uint8Array,
        start: number,
        end: number,
        io: { chunk: EncodedPacket; out: PlanarVideoFrame[] } | undefined,
    ): void {
        if (end - start < 2) return;
        const header = data[start];
        if (header & 0x80) return;
        const type = header & 31;
        const refIdc = (header >> 5) & 3;
        const br = this.br;
        switch (type) {
            case NAL_SPS: {
                br.load(data, start + 1, end);
                const sps = parseSps(br);
                if (typeof sps === 'string') {
                    this.warnings.warn(`ignoring a sequence parameter set: ${sps}`);
                    return;
                }

                const previous = this.spsMap.get(sps.id);
                if (previous && !unsupportedSps(previous) && unsupportedSps(sps)) {
                    this.warnings.warn(
                        `Skipped an undecodable sequence parameter set: ` +
                            `${unsupportedSps(sps)}`,
                    );
                    return;
                }

                this.spsMap.set(sps.id, sps);
                return;
            }
            case NAL_PPS: {
                br.load(data, start + 1, end);
                const pps = parsePps(br, id => this.spsMap.get(id)?.chromaFormatIdc ?? 1);
                if (typeof pps === 'string') {
                    this.warnings.warn(`ignoring a picture parameter set: ${pps}`);
                    return;
                }

                const previousPps = this.ppsMap.get(pps.id);
                const sps = this.spsMap.get(pps.spsId);
                const sliceGroupsAllowed =
                    sps !== undefined &&
                    (sps.profileIdc === 66 || sps.profileIdc === 88) &&
                    !sps.constraintSet1;
                if (
                    previousPps &&
                    previousPps.numSliceGroups === 1 &&
                    pps.numSliceGroups > 1 &&
                    !sliceGroupsAllowed
                ) {
                    this.warnings.warn('Skipped a picture parameter set that uses slice groups');
                    return;
                }

                this.ppsMap.set(pps.id, pps);
                return;
            }
            case NAL_SEI: {
                br.load(data, start + 1, end);
                if (parseSei(br)) this.recoveryPending = true;
                return;
            }
            case NAL_END_SEQUENCE:
                if (io && this.pending) this.finishPicture(io.out);
                return;
            case NAL_SLICE:
            case NAL_IDR:
                if (io) this.handleSlice(data, start, end, type, refIdc, io.chunk, io.out);
                return;
            case NAL_DPA:
                if (io && this.activeSps?.profileIdc === 88)
                    throw new MediaForgeError('H.264 data partitioning is not supported', 'DECODE');
                return;
            case NAL_AUX_SLICE:
            default:
                return;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Slices and pictures

    private handleSlice(
        data: Uint8Array,
        start: number,
        end: number,
        nalType: number,
        refIdc: number,
        chunk: EncodedPacket,
        out: PlanarVideoFrame[],
    ): void {
        const br = this.br;
        br.load(data, start + 1, end);
        const ids = peekSliceIds(br);
        const pps = this.ppsMap.get(ids.ppsId);
        if (!pps) {
            this.warnings.warn(`Dropped a slice: picture parameter set ${ids.ppsId} is missing`);
            return;
        }

        const sps = this.spsMap.get(pps.spsId);
        if (!sps) {
            this.warnings.warn(`Dropped a slice: sequence parameter set ${pps.spsId} is missing`);
            return;
        }

        if (pps.numSliceGroups > 1)
            throw new MediaForgeError('H.264 slice groups (FMO) are not supported', 'DECODE');
        const reason = unsupportedSps(sps);
        if (reason)
            throw new MediaForgeError(`H.264 stream cannot be decoded: ${reason}`, 'DECODE');
        const header = parseSliceHeader(br, nalType, refIdc, sps, pps);
        if (typeof header === 'string') {
            this.warnings.warn(`damaged slice header: ${header}; slice dropped`);
            return;
        }

        if (header.redundantPicCnt > 0) return;
        const pending = this.pending;
        const newPicture = !pending || this.isNewPicture(pending, header, sps, pps);
        if (newPicture) {
            if (pending) this.finishPicture(out);
            if (!this.startPicture(header, sps, pps, chunk, out)) return;
        }

        const current = this.pending;
        if (!current) return;
        if (header.firstMb < current.lastFirstMb) {
            if (sps.profileIdc === 66 || sps.profileIdc === 88)
                throw new MediaForgeError('H.264 arbitrary slice order is not supported', 'DECODE');
            this.warnings.warn('Dropped a slice out of macroblock order');
            return;
        }

        current.lastFirstMb = header.firstMb;
        this.decodeSliceData(current, header);
    }

    /** First slice of a new primary coded picture (7.4.1.2.4). */
    private isNewPicture(
        pending: PendingPicture,
        header: SliceHeader,
        sps: Sps,
        pps: Pps,
    ): boolean {
        const prev = pending.header;
        if (pending.sps !== sps || pending.pps !== pps) return true;
        if (prev.frameNum !== header.frameNum) return true;
        if (prev.fieldPic !== header.fieldPic || prev.bottomField !== header.bottomField)
            return true;
        if ((prev.nalRefIdc === 0) !== (header.nalRefIdc === 0)) return true;
        if ((prev.nalType === NAL_IDR) !== (header.nalType === NAL_IDR)) return true;
        if (header.nalType === NAL_IDR && prev.idrPicId !== header.idrPicId) return true;
        if (
            sps.pocType === 0 &&
            (prev.pocLsb !== header.pocLsb || prev.deltaPocBottom !== header.deltaPocBottom)
        )
            return true;
        if (
            sps.pocType === 1 &&
            (prev.deltaPoc0 !== header.deltaPoc0 || prev.deltaPoc1 !== header.deltaPoc1)
        )
            return true;
        return (
            header.firstMb === 0 && pending.sliceCount > 0 && header.firstMb <= pending.lastFirstMb
        );
    }

    private activateSps(sps: Sps, out: PlanarVideoFrame[]): void {
        const previous = this.activeSps;
        if (
            previous &&
            (previous.mbWidth !== sps.mbWidth ||
                previous.mbHeight !== sps.mbHeight ||
                previous.chromaFormatIdc !== sps.chromaFormatIdc)
        ) {
            while (this.bump(out));
            this.emitOutputs(out, true);
            for (const pic of this.pool) this.threads?.forget(pic);
            if (this.greyPicture) this.threads?.forget(this.greyPicture);
            this.refs.clear();
            this.dpb.length = 0;
            this.openField = null;
            this.pool.length = 0;
            this.greyPicture = null;
            this.lastOutput = null;
            this.arena?.releaseTo(this.arenaMark);
        }

        const arena = this.arena;
        this.threaded = false;
        if (arena && arena.shared && threadedSize(sps.mbWidth * sps.mbHeight)) {
            if (!this.threads && this.pool.length === 0) {
                this.threads = FrameThreads.create(arena, this.slices);
                this.arenaMark = arena.mark;
                this.warmup = threadWarmup();
            }
            this.threaded = this.threads !== null;
        }

        if (previous !== sps) {
            this.slices.configure(sps.mbWidth, sps.mbHeight, sps.chromaFormatIdc);
            this.visibleRect = this.visibleRectOf(sps);
            const level = levelDpbFrames(
                sps.levelIdc,
                sps.constraintSet3,
                sps.mbWidth * sps.mbHeight,
            );

            const vui = sps.vui;
            let dpbSize = vui && vui.maxDecFrameBuffering >= 0 ? vui.maxDecFrameBuffering : level;
            dpbSize = Math.max(dpbSize, sps.numRefFrames, 1);
            this.dpbSize = Math.min(16, dpbSize);
            this.maxReorder =
                vui && vui.numReorderFrames >= 0
                    ? Math.min(vui.numReorderFrames, this.dpbSize)
                    : this.dpbSize;
            if (
                vui &&
                vui.numReorderFrames < 0 &&
                vui.maxDecFrameBuffering < 0 &&
                !sps.frameMbsOnly
            ) {
                this.maxReorder = this.dpbSize;
            }
        }

        this.activeSps = sps;
    }

    private visibleRectOf(sps: Sps): { x: number; y: number; width: number; height: number } {
        const width = sps.mbWidth * 16 - sps.cropLeft - sps.cropRight;
        const height = sps.mbHeight * 16 - sps.cropTop - sps.cropBottom;
        const align = (value: number): number => (value + 15) & ~15;
        const container = { x: 0, y: 0, width: this.containerWidth, height: this.containerHeight };
        if (
            container.width > 0 &&
            sps.cropLeft === 0 &&
            sps.cropTop === 0 &&
            align(container.width) === align(width) &&
            align(container.height) === align(height) &&
            container.width <= width &&
            container.height <= height
        )
            return container;
        this.containerWidth = this.containerHeight = 0;
        return { x: sps.cropLeft, y: sps.cropTop, width, height };
    }

    private allocatePicture(sps: Sps): Picture {
        const threads = this.threads;
        for (const pic of this.pool) {
            // The last output picture stays intact: it conceals damage when no reference is left.
            if (
                this.dpb.includes(pic) ||
                pic === this.openField ||
                pic === this.lastOutput ||
                pic.isReference()
            )
                continue;
            if (
                threads &&
                (threads.busy(pic) || this.outputs.some(output => output.picture === pic))
            )
                continue;
            pic.reset();
            pic.serial = this.nextSerial();
            Atomics.store(pic.progress, 0, PROGRESS_DONE);
            return pic;
        }

        const pic = this.newPicture(sps);
        this.pool.push(pic);
        return pic;
    }

    /**
     * A picture in the kernel memory when there is one; views of that memory are re-created if it
     * had to grow.
     */
    private newPicture(sps: Sps): Picture {
        const arena = this.arena;
        const pic = new Picture(
            this.pictureIds++,
            sps.mbWidth,
            sps.mbHeight,
            sps.chromaFormatIdc,
            arena,
        );
        pic.progress[0] = PROGRESS_DONE;
        pic.serial = this.nextSerial();
        if (arena && arena.generation !== this.arenaGeneration) {
            this.arenaGeneration = arena.generation;
            for (const other of this.pool) other.bind(arena.buffer);
            this.greyPicture?.bind(arena.buffer);
            this.slices.rebind();
        }
        return pic;
    }

    private nextSerial(): number {
        return (this.serials = (this.serials + 1) & 0x1fffffff);
    }

    private grey(sps: Sps): Picture {
        if (!this.greyPicture) {
            this.greyPicture = this.newPicture(sps);
            this.greyPicture.fillGrey();
            clearMotion(this.greyPicture, 0, this.greyPicture.mbCount, MB_DECODED | MB_INTRA);
        }
        return this.greyPicture;
    }

    /** Starts decoding a picture; returns false when it must wait for a keyframe. */
    private startPicture(
        header: SliceHeader,
        sps: Sps,
        pps: Pps,
        chunk: EncodedPacket,
        out: PlanarVideoFrame[],
    ): boolean {
        const idr = header.nalType === NAL_IDR;
        if (this.needKeyframe) {
            const intra = isIntraSlice(header.sliceType);
            if (!idr && !this.recoveryPending && !intra) {
                if (this.warnings.count === 0)
                    this.warnings.warn('waiting for an IDR picture or recovery point');
                return false;
            }
            this.needKeyframe = false;
        }

        this.recoveryPending = false;
        this.activateSps(sps, out);
        this.threads?.throttle(this.warn);
        const structure = header.fieldPic
            ? header.bottomField
                ? PICT_BOTTOM
                : PICT_TOP
            : PICT_FRAME;

        const mbaff = sps.mbaff && !header.fieldPic;
        const maxFrameNum = 1 << sps.log2MaxFrameNum;
        let picture: Picture;
        let secondField = false;
        const open = this.openField;
        if (
            open &&
            this.openFieldHeader &&
            structure !== PICT_FRAME &&
            structure !== this.openFieldStructure &&
            header.frameNum === this.openFieldHeader.frameNum &&
            !idr &&
            (header.nalRefIdc === 0) === (this.openFieldHeader.nalRefIdc === 0)
        ) {
            picture = open;
            secondField = true;
            this.openField = null;
            this.missingFields = 0;
        } else {
            if (open) {
                this.missingFields =
                    structure === PICT_FRAME || structure === this.openFieldStructure
                        ? this.missingFields + 1
                        : 0;
            }

            this.closeOpenField(out);
            this.openFieldShown = structure !== PICT_FRAME && this.missingFields > 1;
            if (idr) {
                this.prevRefFrameNum = 0;
            } else {
                this.fillFrameNumGap(header, sps, maxFrameNum, out);
            }

            picture = this.allocatePicture(sps);
            picture.frameNum = header.frameNum;
            picture.idr = idr;
            picture.keyFrame = idr;
            picture.mbaff = mbaff;
            picture.fieldPicture = header.fieldPic;
            picture.timestamp = chunk.timestamp;
            picture.duration = chunk.duration;
            picture.reference = header.nalRefIdc !== 0;
        }

        let threaded = this.openFieldThreaded;
        if (!secondField) {
            threaded = this.threaded && this.warmup === 0;
            if (this.threaded && this.warmup > 0) this.warmup--;
        }

        if (secondField) picture.duration += chunk.duration;
        this.computePoc(picture, header, sps, structure, secondField);
        this.refs.computeFrameNumWrap(header.frameNum, maxFrameNum);
        if (threaded) Atomics.store(picture.progress, 0, 0);
        else {
            const deblock: DeblockInput = {
                picture,
                mbaff,
                structure,
                kernels: this.arena ? this.arena.kernels : null,
            };
            this.slices.startPicture(picture, deblock);
        }

        this.pending = {
            picture,
            sps,
            pps,
            header,
            structure,
            mbaff,
            scaling: this.scalingFor(sps, pps),
            jobs: [],
            poc: picture.pocOf(structure),
            sliceCount: 0,
            lastFirstMb: -1,
            lastList0: undefined,
            references: new Set(),
            mmco5: false,
            threaded,
        };
        return true;
    }

    /**
     * Scaling tables of a parameter set pair, kept while consecutive pictures use the same pair.
     */
    private scalingFor(sps: Sps, pps: Pps): ScalingTables {
        if (this.scaling && this.scalingSps === sps && this.scalingPps === pps) return this.scaling;
        this.scalingSps = sps;
        this.scalingPps = pps;
        this.scalingKey++;
        this.scalingLists = resolveScalingLists(sps, pps);
        return (this.scaling = buildScalingTables(this.scalingLists));
    }

    /**
     * Inserts non-existing frames for gaps in frame_num (8.2.5.2), concealing them from the latest
     * reference.
     */
    private fillFrameNumGap(
        header: SliceHeader,
        sps: Sps,
        maxFrameNum: number,
        out: PlanarVideoFrame[],
    ): void {
        const frameNum = header.frameNum;
        if (this.refs.references.length === 0) {
            this.prevRefFrameNum = frameNum;
            return;
        }
        if (
            frameNum === this.prevRefFrameNum ||
            frameNum === (this.prevRefFrameNum + 1) % maxFrameNum
        )
            return;
        let gap = (frameNum - this.prevRefFrameNum - 1 + maxFrameNum) % maxFrameNum;
        if (!sps.gapsInFrameNumAllowed)
            this.warnings.warn(`${gap} reference frames are missing; concealing`);

        // FrameNumWrap of the latest reference is not derived before a picture that follows it.
        this.refs.computeFrameNumWrap(frameNum, maxFrameNum);
        const source = this.latestReference();
        let missing = (this.prevRefFrameNum + 1) % maxFrameNum;
        if (gap > MAX_GAP_FRAMES) {
            missing = (frameNum - MAX_GAP_FRAMES + maxFrameNum) % maxFrameNum;
            gap = MAX_GAP_FRAMES;
        }
        for (let i = 0; i < gap; i++) {
            const pic = this.allocatePicture(sps);
            pic.frameNum = missing;
            pic.nonExisting = true;
            pic.needsOutput = false;
            pic.concealed = true;
            if (source) {
                this.threads?.awaitWrites(source, this.warn);
                pic.data.set(source.data);
                pic.poc = source.poc;
                pic.topPoc = source.topPoc;
                pic.bottomPoc = source.bottomPoc;
            } else {
                pic.fillGrey();

                // A reused picture would otherwise keep the order count of its previous use.
                pic.poc = pic.topPoc = pic.bottomPoc = 0;
            }
            clearMotion(pic, 0, pic.mbCount, MB_DECODED | MB_INTRA);
            this.refs.computeFrameNumWrap(missing, maxFrameNum);
            this.refs.slidingWindow(pic, sps);
            pic.refTop = pic.refBottom = 1;
            this.refs.references.push(pic);
            this.storeInDpb(pic, out);
            this.prevRefFrameNum = missing;
            missing = (missing + 1) % maxFrameNum;
        }
    }

    private latestReference(): Picture | null {
        let best: Picture | null = null;
        for (const pic of this.refs.references) {
            if (pic.nonExisting) continue;
            if (!best || pic.frameNumWrap > best.frameNumWrap) best = pic;
        }
        return best ?? this.lastOutput;
    }

    /** Picture order count derivation (8.2.1). */
    private computePoc(
        picture: Picture,
        header: SliceHeader,
        sps: Sps,
        structure: number,
        secondField: boolean,
    ): void {
        const idr = header.nalType === NAL_IDR;
        const maxFrameNum = 1 << sps.log2MaxFrameNum;
        let top = 0;
        let bottom = 0;
        if (sps.pocType === 0) {
            const maxLsb = 1 << sps.log2MaxPocLsb;
            let prevMsb = this.prevPocMsb;
            let prevLsb = this.prevPocLsb;
            if (idr) {
                prevMsb = 0;
                prevLsb = 0;
            } else if (this.prevRefHadMmco5) {
                prevMsb = 0;
                prevLsb = this.prevRefBottomMmco5 ? 0 : this.prevPocLsb;
            }

            let msb: number;
            const lsb = header.pocLsb;
            if (lsb < prevLsb && prevLsb - lsb >= maxLsb / 2) msb = prevMsb + maxLsb;
            else if (lsb > prevLsb && lsb - prevLsb > maxLsb / 2) msb = prevMsb - maxLsb;
            else msb = prevMsb;

            if (structure !== PICT_BOTTOM) top = msb + lsb;
            if (structure === PICT_FRAME) bottom = top + header.deltaPocBottom;
            else if (structure === PICT_BOTTOM) bottom = msb + lsb;
            if (header.nalRefIdc) {
                this.prevPocMsb = msb;
                this.prevPocLsb = lsb;
            }
        } else {
            let frameNumOffset: number;
            if (idr) frameNumOffset = 0;
            else {
                const prevOffset = this.prevRefHadMmco5 ? 0 : this.prevFrameNumOffset;
                frameNumOffset =
                    this.prevFrameNum > header.frameNum ? prevOffset + maxFrameNum : prevOffset;
            }

            if (sps.pocType === 1) {
                const cycle = sps.offsetForRefFrame.length;
                let absFrameNum = cycle !== 0 ? frameNumOffset + header.frameNum : 0;
                if (header.nalRefIdc === 0 && absFrameNum > 0) absFrameNum--;
                let expected = 0;
                if (absFrameNum > 0) {
                    const pocCycleCnt = Math.floor((absFrameNum - 1) / cycle);
                    const frameNumInCycle = (absFrameNum - 1) % cycle;
                    let deltaPerCycle = 0;
                    for (let i = 0; i < cycle; i++) deltaPerCycle += sps.offsetForRefFrame[i];
                    expected = pocCycleCnt * deltaPerCycle;
                    for (let i = 0; i <= frameNumInCycle; i++) expected += sps.offsetForRefFrame[i];
                }

                if (header.nalRefIdc === 0) expected += sps.offsetForNonRefPic;
                if (structure === PICT_FRAME) {
                    top = expected + header.deltaPoc0;
                    bottom = top + sps.offsetForTopToBottomField + header.deltaPoc1;
                } else if (structure === PICT_TOP) top = expected + header.deltaPoc0;
                else bottom = expected + sps.offsetForTopToBottomField + header.deltaPoc0;
            } else {
                const temp = idr
                    ? 0
                    : header.nalRefIdc === 0
                      ? 2 * (frameNumOffset + header.frameNum) - 1
                      : 2 * (frameNumOffset + header.frameNum);
                top = bottom = temp;
            }

            this.prevFrameNumOffset = frameNumOffset;
            this.prevFrameNum = header.frameNum;
        }

        if (structure === PICT_FRAME) {
            picture.topPoc = top;
            picture.bottomPoc = bottom;
        } else if (structure === PICT_TOP) {
            picture.topPoc = top;
            if (!secondField) picture.bottomPoc = top;
        } else {
            picture.bottomPoc = bottom;
            if (!secondField) picture.topPoc = bottom;
        }

        picture.poc = Math.min(picture.topPoc, picture.bottomPoc);
        picture.topFieldFirst = picture.topPoc <= picture.bottomPoc;
    }

    private decodeSliceData(current: PendingPicture, header: SliceHeader): void {
        const sps = current.sps;
        const pps = current.pps;
        const picture = current.picture;
        const structure = current.structure;
        const maxFrameNum = 1 << sps.log2MaxFrameNum;
        let list0: RefEntry[] = [];
        let list1: RefEntry[] = [];
        if (!isIntraSlice(header.sliceType)) {
            const initial = this.refs.initialLists(header, picture, structure, current.poc);
            list0 = this.refs.modifyList(
                initial[0],
                header.refListModifications[0],
                header.numRefIdxActive[0],
                picture,
                structure,
                maxFrameNum,
            );
            list1 = this.refs.modifyList(
                initial[1],
                header.refListModifications[1],
                header.numRefIdxActive[1],
                picture,
                structure,
                maxFrameNum,
            );
            this.padList(list0, header.numRefIdxActive[0], current, list1);
            if (header.sliceType === SLICE_B)
                this.padList(list1, header.numRefIdxActive[1], current, list0);
        }

        const mbaff = current.mbaff;
        let fieldRefList: SliceContext['fieldRefList'] = null;
        if (mbaff && !isIntraSlice(header.sliceType)) {
            const build = (parity: number): [RefEntry[], RefEntry[]] => [
                fieldListsOf(list0, parity, refEntry),
                fieldListsOf(list1, parity, refEntry),
            ];
            fieldRefList = [build(PICT_TOP), build(PICT_BOTTOM)];
        }

        let implicitWeights: Int8Array | null = null;
        let implicitWeightsField: [Int8Array, Int8Array] | null = null;
        let distScale: Int32Array = new Int32Array(1);
        let distScaleField: [Int32Array, Int32Array] | null = null;
        let colParity = 0;
        let colFieldOffset = 0;
        if (header.sliceType === SLICE_B) {
            if (pps.weightedBipredIdc === 2) {
                implicitWeights = buildImplicitWeights(current.poc, list0, list1);
                if (fieldRefList) {
                    implicitWeightsField = [
                        buildImplicitWeights(
                            picture.topPoc,
                            fieldRefList[0][0],
                            fieldRefList[0][1],
                        ),
                        buildImplicitWeights(
                            picture.bottomPoc,
                            fieldRefList[1][0],
                            fieldRefList[1][1],
                        ),
                    ];
                }
            }

            const ref1 = list1[0];
            distScale = buildDistScale(current.poc, list0, ref1);
            if (fieldRefList) {
                distScaleField = [
                    buildDistScale(picture.topPoc, fieldRefList[0][0], fieldRefList[0][1][0]),
                    buildDistScale(picture.bottomPoc, fieldRefList[1][0], fieldRefList[1][1][0]),
                ];
            }

            if (ref1) {
                if (structure === PICT_FRAME) {
                    const colPic = ref1.pic;
                    colParity =
                        Math.abs(colPic.topPoc - current.poc) >=
                        Math.abs(colPic.bottomPoc - current.poc)
                            ? 1
                            : 0;
                } else if (ref1.parity !== structure && !ref1.pic.mbaff) {
                    colFieldOffset = ref1.parity === PICT_BOTTOM ? 1 : -1;
                }
            }
        }

        const sliceNum = current.sliceCount++;
        current.lastList0 = list0[0] ?? current.lastList0;
        const ctx: SliceContext = {
            header,
            sps,
            pps,
            sliceNum,
            picture,
            structure,
            mbaff,
            refList: [list0, list1],
            fieldRefList,
            scaling: current.scaling,
            implicitWeights,
            implicitWeightsField,
            distScale,
            distScaleField,
            colParity,
            colFieldOffset,
        };

        if (current.threaded) {
            const entries = (list: readonly RefEntry[]): EntryJob[] =>
                list.map(entry => ({
                    picture: entry.pic.id,
                    id: entry.id,
                    parity: entry.parity,
                    poc: entry.poc,
                    longTerm: entry.longTerm,
                }));

            const br = this.br;
            current.jobs.push({
                header,
                sps,
                pps,
                sliceNum,
                refList: [entries(list0), entries(list1)],
                fieldRefList: fieldRefList
                    ? [
                          [entries(fieldRefList[0][0]), entries(fieldRefList[0][1])],
                          [entries(fieldRefList[1][0]), entries(fieldRefList[1][1])],
                      ]
                    : null,
                scalingKey: this.scalingKey,
                scalingLists: this.scalingLists,
                implicitWeights,
                implicitWeightsField,
                distScale,
                distScaleField,
                colParity,
                colFieldOffset,
                rbsp: br.data.slice(0, br.byteLength + 32),
                pos: br.pos,
                end: br.end,
                byteLength: br.byteLength,
            });
            for (const list of [list0, list1])
                for (const entry of list) current.references.add(entry.pic);
            return;
        }

        const result = this.slices.decodeSlice(ctx, this.br);
        if (result.error)
            this.warnings.warn(
                `${result.error}; ${result.decoded} macroblocks decoded before concealment`,
            );
    }

    /** Fills missing reference list entries so every index resolves to a picture. */
    private padList(
        list: RefEntry[],
        active: number,
        current: PendingPicture,
        other: RefEntry[],
    ): void {
        if (list.length >= active) return;
        let fallback: RefEntry | undefined = list[list.length - 1] ?? other[0];
        if (!fallback) {
            const source = this.latestReference();
            const parity = current.structure === PICT_FRAME ? PICT_FRAME : current.structure;
            fallback = refEntry(
                source && source !== current.picture ? source : this.grey(current.sps),
                parity,
                false,
            );
            current.picture.concealed = true;
        }
        while (list.length < active) list.push(fallback);
    }

    /** Conceals undecoded macroblocks, filters, marks and stores the finished picture. */
    private finishPicture(out: PlanarVideoFrame[]): void {
        const current = this.pending;
        if (!current) return;
        this.pending = null;
        const picture = current.picture;
        const structure = current.structure;
        const header = current.header;
        const sps = current.sps;
        let source: Picture | null = current.lastList0?.pic ?? this.latestReference();
        if (source === picture) source = null;
        if (current.threaded) {
            const threads = this.threads!;
            if (source) current.references.add(source);
            current.references.delete(picture);
            const references = [...current.references];
            threads.submit(
                {
                    picture: slotOf(picture),
                    references: references.map(slotOf),
                    structure,
                    mbaff: current.mbaff,
                    slices: current.jobs,
                    concealSource: source ? source.id : -1,
                    after: threads.lastJobOf(picture),
                    completes:
                        structure === PICT_FRAME ||
                        (picture.decodedFields | (structure === PICT_TOP ? 1 : 2)) === 3,
                },
                [picture, ...references],
            );
        } else {
            const missing = this.slices.concealMissing(structure, source);
            if (missing) {
                picture.concealed = true;
                this.warnings.warn(`${missing} macroblocks were missing and have been concealed`);
            }
            this.slices.finishPicture();
        }

        if (structure === PICT_FRAME) picture.decodedFields = 3;
        else picture.decodedFields |= structure === PICT_TOP ? 1 : 2;
        const idr = header.nalType === NAL_IDR;
        let mmco5 = false;
        if (header.nalRefIdc) {
            if (idr) this.refs.markIdr(header, picture, structure);
            else mmco5 = this.refs.mark(header, picture, structure, sps);
            this.prevRefFrameNum = mmco5 ? 0 : header.frameNum;
            this.prevRefHadMmco5 = mmco5;
            this.prevRefBottomMmco5 = mmco5 && structure === PICT_BOTTOM;
            if (mmco5) {
                const temp =
                    structure === PICT_FRAME
                        ? Math.min(picture.topPoc, picture.bottomPoc)
                        : picture.pocOf(structure);
                picture.topPoc -= temp;
                picture.bottomPoc -= temp;
                picture.poc = Math.min(picture.topPoc, picture.bottomPoc);
                this.prevPocMsb = 0;
                this.prevPocLsb = structure === PICT_BOTTOM ? 0 : picture.topPoc;
                this.prevFrameNumOffset = 0;
                this.prevFrameNum = 0;
                picture.frameNum = 0;
                picture.pocReset = true;
            }
        }

        if (structure !== PICT_FRAME && picture.decodedFields !== 3) {
            this.openField = picture;
            this.openFieldThreaded = current.threaded;
            this.openFieldStructure = structure;
            this.openFieldHeader = header;
            return;
        }

        this.completePicture(picture, idr && header.noOutputOfPriorPics, out);
    }

    /**
     * Completes an unpaired field as a frame, doubling its lines. As in FFmpeg, it stays a
     * reference but is output only in a run of unpaired fields: a field whose pair was lost, as at
     * the end of a cut stream, is not shown.
     */
    private closeOpenField(out: PlanarVideoFrame[]): void {
        const open = this.openField;
        if (!open) return;
        this.openField = null;
        this.threads?.awaitUsers(open, this.warn);
        const stride = open.lumaStride;
        const parity = this.openFieldStructure === PICT_TOP ? 0 : 1;
        const copyLines = (base: number, lineStride: number, lines: number) => {
            for (let y = 0; y < lines; y += 2) {
                const src = base + (y + parity) * lineStride;
                const dst = base + (y + 1 - parity) * lineStride;
                open.data.copyWithin(dst, src, src + lineStride);
            }
        };
        copyLines(0, stride, open.lumaHeight);
        copyLines(open.chromaOffset, open.chromaStride, open.chromaHeight);
        copyLines(open.crOffset, open.chromaStride, open.chromaHeight);

        // The missing field's macroblocks, which direct prediction may read, become intra field
        // macroblocks.
        for (let row = 1 - parity; row < open.mbHeight; row += 2)
            clearMotion(
                open,
                row * open.mbWidth,
                (row + 1) * open.mbWidth,
                MB_DECODED | MB_INTRA | MB_FIELD,
            );
        open.decodedFields = 3;
        Atomics.store(open.progress, 0, PROGRESS_DONE);
        open.concealed = true;
        this.completePicture(open, false, out, this.openFieldShown);
    }

    private completePicture(
        picture: Picture,
        noOutputOfPriorPics: boolean,
        out: PlanarVideoFrame[],
        shown = true,
    ): void {
        picture.needsOutput = shown;
        if (picture.idr || picture.pocReset) {
            if (noOutputOfPriorPics) {
                for (const pic of this.dpb) pic.needsOutput = false;
                this.dpb.length = 0;
            } else while (this.bump(out));
            for (let i = this.dpb.length - 1; i >= 0; i--)
                if (!this.dpb[i].isReference()) this.dpb.splice(i, 1);
        }
        if (shown || picture.isReference()) this.storeInDpb(picture, out);
    }

    /**
     * C.4.5 bumping: makes room, stores the picture and outputs what exceeds the reordering depth.
     */
    private storeInDpb(picture: Picture, out: PlanarVideoFrame[]): void {
        for (let i = this.dpb.length - 1; i >= 0; i--) {
            const pic = this.dpb[i];
            if (!pic.isReference() && !pic.needsOutput) this.dpb.splice(i, 1);
        }

        const direct = !picture.isReference() && picture.needsOutput;
        if (direct && this.waitingCount() >= this.maxReorder && this.precedesWaiting(picture)) {
            this.output(picture, out);
            return;
        }

        while (this.dpb.length >= this.dpbSize) {
            // C.4.5.3: without an empty frame buffer, a non-reference picture that precedes every
            // waiting one is output directly; checked after each bump, as reference pictures stay
            // in the buffer once output.
            if (direct && this.precedesWaiting(picture)) {
                this.output(picture, out);
                return;
            }
            if (!this.bump(out)) {
                const victim = this.dpb.shift()!;
                victim.refTop = victim.refBottom = REF_NONE;
                const index = this.refs.references.indexOf(victim);
                if (index >= 0) this.refs.references.splice(index, 1);
                victim.needsOutput = false;
            }
        }

        this.dpb.push(picture);
        while (this.waitingCount() > this.maxReorder) if (!this.bump(out)) break;
    }

    private precedesWaiting(picture: Picture): boolean {
        for (const pic of this.dpb) if (pic.needsOutput && pic.poc < picture.poc) return false;
        return true;
    }

    private waitingCount(): number {
        let count = 0;
        for (const pic of this.dpb) if (pic.needsOutput) count++;
        return count;
    }

    /** Outputs the waiting picture with the smallest POC; returns false when none waits. */
    private bump(out: PlanarVideoFrame[]): boolean {
        let best: Picture | null = null;
        for (const pic of this.dpb)
            if (pic.needsOutput && (!best || pic.poc < best.poc)) best = pic;
        if (!best) return false;
        this.output(best, out);
        if (!best.isReference()) this.dpb.splice(this.dpb.indexOf(best), 1);
        return true;
    }

    /**
     * Outputs `picture` to `out`, or with frame threads to the pictures leaving once their jobs
     * finish.
     */
    private output(picture: Picture, out: PlanarVideoFrame[]): void {
        picture.needsOutput = false;
        this.lastOutput = picture;
        const frame = this.frameOf(picture);
        if (this.threads) this.outputs.push({ picture, frame });
        else out.push({ ...frame, data: picture.data.slice() });
    }

    /** The fields of the frame output for `picture`, all but its samples. */
    private frameOf(picture: Picture): Omit<PlanarVideoFrame, 'data'> {
        const sps = this.activeSps!;
        const visibleRect = this.visibleRect;
        const { width, height } = visibleRect;
        const vui = sps.vui;
        const sarNum = vui?.sarNum ?? 1;
        const sarDen = vui?.sarDen ?? 1;
        const interlaced = sps.frameMbsOnly
            ? undefined
            : picture.topFieldFirst
              ? 'top-field-first'
              : 'bottom-field-first';

        return {
            format: sps.chromaFormatIdc === 2 ? 'I422' : 'I420',
            layout: [
                { offset: 0, stride: picture.lumaStride },
                { offset: picture.chromaOffset, stride: picture.chromaStride },
                { offset: picture.crOffset, stride: picture.chromaStride },
            ],
            codedWidth: picture.lumaStride,
            codedHeight: picture.lumaHeight,
            visibleRect: { ...visibleRect },
            displayWidth: sarNum > sarDen ? Math.round((width * sarNum) / sarDen) : width,
            displayHeight: sarNum < sarDen ? Math.round((height * sarDen) / sarNum) : height,
            timestamp: picture.timestamp,
            duration: picture.duration,
            keyFrame: picture.keyFrame,
            colorSpace: colorSpaceOf(sps),
            interlaced,
        };
    }
}

function unsupportedSps(sps: Sps): string | null {
    if (sps.chromaFormatIdc === 3) return '4:4:4 chroma is not supported';
    if (sps.bitDepthLuma !== 8 || sps.bitDepthChroma !== 8)
        return `${sps.bitDepthLuma}-bit samples are not supported`;
    if (sps.transformBypass) return 'lossless transform bypass is not supported';
    return null;
}

/** The colour space the VUI signals; unspecified, the unlabelled colour of the coded size. */
function colorSpaceOf(sps: Sps): PlanarVideoColorSpace {
    const vui = sps.vui;
    const fallback = unlabelledColour(sps.mbWidth * 16, sps.mbHeight * 16);
    const codes = vui && {
        primaries: vui.colourPrimaries,
        transfer: vui.transferCharacteristics,
        matrix: vui.matrixCoefficients,
        fullRange: vui.fullRange,
    };
    return colourSpaceOf(codes ?? undefined, {
        primaries: fallback,
        transfer: fallback,
        matrix: fallback,
    });
}

/** Macroblocks [first, end) of `picture` without motion and with `flags`. */
function clearMotion(picture: Picture, first: number, end: number, flags: number): void {
    picture.mbFlags.fill(flags, first, end);
    for (const list of [0, 1]) {
        picture.ref[list].fill(-1, first * 4, end * 4);
        picture.refId[list].fill(-1, first * 4, end * 4);
        picture.mv[list].fill(0, first * 32, end * 32);
    }
}

function slotOf(picture: Picture): PictureSlot {
    return {
        id: picture.id,
        base: picture.base,
        mbWidth: picture.mbWidth,
        mbHeight: picture.mbHeight,
        chromaFormat: picture.chromaFormat,
    };
}

/**
 * An ITU-T H.264 decoder for the Constrained Baseline, Baseline, Main and High profiles at 8 bits,
 * 4:2:0 and 4:2:2. Its SIMD kernels are compiled and instantiated asynchronously, as browsers
 * require for modules of their size on the main thread; frame threads use a shared memory where
 * the host offers one.
 */
export async function createH264Decoder(
    config: BuiltinVideoDecoderConfig,
): Promise<BuiltinVideoDecoder> {
    const shared = threadsAvailable() && (keptKernelArena() ?? (await createKernelArena(true)));
    return new H264VideoDecoder(config, shared || (await createKernelArena(false)));
}
