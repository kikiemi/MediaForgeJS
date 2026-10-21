import { MediaForgeError } from '../../core/errors/errors';
import type { EncodedPacket } from '../../core/model/media';
import {
    type BuiltinVideoCodec,
    type BuiltinVideoDecoder,
    type BuiltinVideoDecoderConfig,
} from '../../core/contracts/decoder';
import { BitReader } from './bit-reader';
import { type H263Modes, NO_H263_MODES } from './h263-modes';
import {
    defaultVideoObjectLayer,
    parseGroupOfVop,
    parseUserData,
    parseVideoObjectLayer,
    parseVisualObject,
    SHORT_HEADER_FORMATS,
    SPRITE_GMC,
    unknownEncoder,
    VOP_B,
    VOP_I,
    VOP_P,
    VOP_S,
    type EncoderInfo,
    type VideoObjectLayer,
    type VideoSignalType,
} from './headers';
import { SPRITE_TRAJECTORY, SPRITE_TRAJECTORY_BITS } from './tables';
import {
    newVopCoding,
    roundedDivide,
    VopDecoder,
    type Picture,
    type SequenceCoding,
    type Workarounds,
} from './vop-decoder';
import { isMpeg4VisualCodec } from '../../core/model/decoder-codecs';
import { type PlanarVideoColorSpace, type PlanarVideoFrame } from '../../core/contracts/picture';
import { DecoderWarnings } from '../shared/decoder-warnings';
import { colourSpaceOf, unlabelledColour } from '../../core/codec-config/video/colour-codes';

const VOL_FIRST = 0x20;
const VOL_LAST = 0x2f;
const VOS_START = 0xb0;
const USER_DATA_START = 0xb2;
const GOV_START = 0xb3;
const VISUAL_OBJECT_START = 0xb5;
const VOP_START = 0xb6;

/** Reference or held picture with the metadata of the packet that carried it. */
interface Anchor {
    readonly picture: Picture;
    /**
     * vop_coded = 0 anchor repeating the previous one; every co-located macroblock counts as
     * skipped.
     */
    readonly notCoded: boolean;
    timestamp: number;
    duration: number;
    readonly keyFrame: boolean;
    readonly topFieldFirst: boolean;
}

/** The colour space the video signal type gives; unspecified, the unlabelled colour of the size. */
function colorSpaceOf(
    signal: VideoSignalType | undefined,
    width: number,
    height: number,
): PlanarVideoColorSpace {
    const fallback = unlabelledColour(width, height);
    return colourSpaceOf(signal, { primaries: fallback, transfer: fallback, matrix: fallback });
}

function workaroundsFor(info: EncoderInfo): Workarounds {
    const xvid = info.xvidBuild;
    const divx = xvid >= 0 ? -1 : info.divxVersion;
    const divxBuild = xvid >= 0 ? -1 : info.divxBuild;
    const lavc = info.lavcBuild;
    return {
        edgeAtVisibleSize:
            (xvid >= 0 && xvid <= 12) || (lavc >= 0 && lavc < 4670) || (divx >= 0 && divx < 500),
        unclippedDc: (xvid >= 0 && xvid <= 32) || (lavc >= 0 && lavc <= 4712),
        qpelChroma: (divx >= 500 && divxBuild < 1814) || (xvid >= 0 && xvid <= 1),
        qpelChroma2: divx > 502 && divxBuild < 1814,
        legacyQpel: lavc >= 0 && lavc < 4653,
        interlacedEdge:
            lavc > 3621476 &&
            lavc < 3752552 &&
            (lavc & 0xff) >= 100 &&
            (lavc < 3752037 || lavc > 3752191),
        fieldChromaRounding: divx >= 0,
        divx500Sprite: divx === 500 && divxBuild === 413,
        xvidIdct: xvid >= 0,
    };
}

/** Byte offsets just past each 00 00 01 start code prefix. */
function startCodes(data: Uint8Array): number[] {
    const found: number[] = [];
    const end = data.length - 3;
    for (let i = 0; i <= end;) {
        const third = data[i + 2];
        if (third > 1) i += 3;
        else if (third === 1 && data[i] === 0 && data[i + 1] === 0) {
            found.push(i + 3);
            i += 3;
        } else i++;
    }
    return found;
}

function isShortHeaderStart(data: Uint8Array, offset: number): boolean {
    return (
        data.length >= offset + 4 &&
        data[offset] === 0 &&
        data[offset + 1] === 0 &&
        (data[offset + 2] & 0xfc) === 0x80
    );
}

class Mpeg4VideoDecoder implements BuiltinVideoDecoder {
    private readonly br = new BitReader();
    private readonly vop = new VopDecoder();
    private readonly coding = newVopCoding();
    private readonly encoder = unknownEncoder();
    private readonly shortHeaderStream: boolean;
    private vol: VideoObjectLayer | undefined;
    private shortHeader: SequenceCoding | undefined;
    private signal: VideoSignalType | undefined;
    private profileLevel = -1;
    private configured = false;
    private lowDelay = true;
    private sawB = false;
    private pictures: Picture[] = [];
    private bPicture: Picture | undefined;
    private past: Anchor | undefined;
    private future: Anchor | undefined;
    private held = false;
    private packedPending = false;
    private lastOutput: Anchor | undefined;
    private needKeyframe = true;
    /**
     * Pixel aspect of short header pictures: 12:11, or what an H.263+ custom picture format states.
     */
    private shortHeaderAspect: readonly [number, number] = [12, 11];
    /**
     * The full extended picture type of the last H.263+ picture that stated it (UFEP 1), which
     * later ones keep.
     */
    private plusType: PlusType | undefined;
    /**
     * No picture was decoded since the decoder was made: a stream starting predicted begins from
     * grey.
     */
    private fresh = true;
    private timeBase = 0;
    private lastTimeBase = 0;
    private lastNonBTime = 0;
    private ppTime = 0;
    /**
     * The temporal reference of the last short header picture, counted on past 255 as ffmpeg counts
     * it.
     */
    private pictureNumber = 0;
    private frameTime = 0;
    private incrementBits = 1;
    private readonly warnings: DecoderWarnings;
    /** Picture size the container states, for a stream without layer headers. */
    private readonly containerWidth: number;
    private readonly containerHeight: number;
    private closed = false;

    constructor(config: BuiltinVideoDecoderConfig) {
        this.warnings = new DecoderWarnings(config.onWarning);
        this.containerWidth = config.codedWidth ?? 0;
        this.containerHeight = config.codedHeight ?? 0;
        this.shortHeaderStream = /^(s263|h263)$/i.test(config.codec);
        const profile = /^mp4v\.20\.(\d+)$/i.exec(config.codec);
        if (profile) this.profileLevel = Number(profile[1]);
        if (config.description?.length && !this.shortHeaderStream) {
            const reason = this.parseHeaders(config.description, []);
            if (reason)
                throw new MediaForgeError(
                    `MPEG-4 Visual configuration cannot be decoded: ${reason}`,
                    'DECODE',
                );
        }
    }

    decode(chunk: EncodedPacket): readonly PlanarVideoFrame[] {
        if (this.closed) throw new MediaForgeError('MPEG-4 Visual decoder is closed', 'DECODE');
        const out: PlanarVideoFrame[] = [];
        const data = chunk.data;
        if (this.shortHeaderStream || isShortHeaderStart(data, 0)) {
            this.decodeShortHeaderPicture(data, chunk, out);
            return out;
        }
        const reason = this.parseHeaders(data, out, chunk);
        if (reason)
            throw new MediaForgeError(
                `MPEG-4 Visual stream cannot be decoded: ${reason}`,
                'DECODE',
            );
        return out;
    }

    flush(): readonly PlanarVideoFrame[] {
        if (this.closed) throw new MediaForgeError('MPEG-4 Visual decoder is closed', 'DECODE');
        const out: PlanarVideoFrame[] = [];
        this.releaseHeld(out);
        this.packedPending = false;
        return out;
    }

    reset(): void {
        this.past = undefined;
        this.future = undefined;
        this.lastOutput = undefined;
        this.held = false;
        this.packedPending = false;
        this.needKeyframe = true;
        this.fresh = false;
    }

    close(): void {
        this.reset();
        this.pictures = [];
        this.bPicture = undefined;
        this.closed = true;
    }

    /**
     * Walks the start codes of `data` in stream order, applying headers and decoding VOPs when
     * `chunk` is given. Returns a reason when a video object layer cannot be decoded and no earlier
     * layer can stand in for it.
     */
    private parseHeaders(
        data: Uint8Array,
        out: PlanarVideoFrame[],
        chunk?: EncodedPacket,
    ): string | undefined {
        const br = this.br;
        const codes = startCodes(data);
        const vops: number[] = [];
        for (let index = 0; index < codes.length; index++) {
            if (data[codes[index]] === VOP_START)
                vops.push(
                    codes[index],
                    index + 1 < codes.length ? codes[index + 1] - 3 : data.length,
                );
        }

        if (chunk && !vops.length && isShortHeaderStart(data, 0)) {
            this.decodeShortHeaderPicture(data, chunk, out);
            return undefined;
        }

        let vop = 0;
        for (let index = 0; index < codes.length; index++) {
            const offset = codes[index];
            const end = index + 1 < codes.length ? codes[index + 1] - 3 : data.length;
            const code = data[offset];
            if (code === VOP_START) {
                vop += 2;
                if (chunk) this.decodeVopUnit(data, offset, end, chunk, vops.slice(vop), out);
                continue;
            }

            br.load(data, offset + 1, Math.max(0, end - offset - 1));
            if (code >= VOL_FIRST && code <= VOL_LAST) {
                const vol = parseVideoObjectLayer(br);
                if (typeof vol === 'string') {
                    if (!this.vol) return vol;
                    this.warnings.warn(`Skipped an undecodable video object layer: ${vol}`);
                    continue;
                }
                this.applyLayer(vol, out);
            } else if (code === USER_DATA_START) {
                parseUserData(br, this.encoder);
                this.configured = false;
            } else if (code === GOV_START) {
                const seconds = parseGroupOfVop(br);
                if (seconds !== undefined) this.timeBase = seconds;
            } else if (code === VISUAL_OBJECT_START) {
                this.signal = parseVisualObject(br) ?? this.signal;
            } else if (code === VOS_START && end > offset + 1) {
                this.profileLevel = data[offset + 1];
            }
        }

        return undefined;
    }

    private applyLayer(vol: VideoObjectLayer, out: PlanarVideoFrame[]): void {
        const previous = this.vol;
        if (previous && (previous.width !== vol.width || previous.height !== vol.height)) {
            this.releaseHeld(out);
            this.reset();
            this.pictures = [];
            this.bPicture = undefined;
        }
        this.vol = vol;
        this.incrementBits = vol.timeIncrementBits;
        this.frameTime = 0;
        this.configured = false;
    }

    /**
     * Applies the layer and encoder workarounds to the macroblock decoder and chooses the output
     * delay: B-VOPs need one anchor of reordering unless vol_control_parameters, Simple profile, or
     * an old DivX 4 or Xvid layer without an object type rules them out, and once seen they keep
     * it.
     */
    private configure(out: PlanarVideoFrame[]): void {
        if (this.configured) return;
        const vol = this.vol!;
        const info = this.encoder;
        let lowDelay: boolean;
        if (this.sawB) lowDelay = false;
        else if (vol.controlParameters) lowDelay = vol.lowDelay;
        else if (vol.objectType === 1 || (this.profileLevel >= 1 && this.profileLevel <= 8))
            lowDelay = true;
        else lowDelay = vol.objectType === 0 && (info.divxVersion < 0 || info.xvidBuild >= 0);
        if (lowDelay && !this.lowDelay) this.releaseHeld(out);
        this.lowDelay = lowDelay;
        this.vop.configure(
            { ...vol, shortHeader: false, timeIncrementBits: this.incrementBits },
            workaroundsFor(this.encoder),
        );
        this.configured = true;
    }

    /**
     * Parses vop() up to the macroblock data (ISO/IEC 14496-2 6.2.5) and updates the VOP time
     * bookkeeping. Returns whether the VOP is coded, or a reason when the header is damaged or
     * unsupported.
     */
    private readVopHeader(vol: VideoObjectLayer): boolean | string {
        const br = this.br;
        const coding = this.coding;
        const type = br.read(2);
        coding.type = type;
        let modulo = 0;
        while (br.read1()) if (++modulo > 60 || br.pos > br.end) return 'damaged modulo_time_base';
        br.skip(1);
        if (!(br.peek(this.incrementBits + 1) & 1)) this.guessIncrementBits(type, vol);
        const increment = br.read(this.incrementBits);
        br.skip(1);
        const coded = br.read1() === 1;
        if (br.pos > br.end) return 'truncated VOP header';
        if (!this.updateTime(type, modulo, increment, vol))
            return 'B-VOP time does not fall between its references';
        if (!coded) return false;
        if (vol.newPred) {
            const length = Math.min(this.incrementBits + 3, 15);
            br.skip(length);
            if (br.read1()) br.skip(length);
            br.skip(1);
        }

        const gmc = vol.spriteEnable === SPRITE_GMC;
        coding.rounding = type === VOP_P || (type === VOP_S && gmc) ? br.read1() : 0;
        br.skip(
            vol.estimationBitsAll +
                (type !== VOP_I ? vol.estimationBitsInter : 0) +
                (type === VOP_B ? vol.estimationBitsB : 0),
        );
        coding.intraDcThreshold = br.read(3);
        coding.topFieldFirst = true;
        coding.alternateScan = false;
        if (vol.interlaced) {
            coding.topFieldFirst = br.read1() === 1;
            coding.alternateScan = br.read1() === 1;
        }

        if (type === VOP_S) {
            if (!gmc) return 'S-VOP without global motion compensation';
            const divx413 =
                this.encoder.xvidBuild < 0 &&
                this.encoder.divxVersion === 500 &&
                this.encoder.divxBuild === 413;
            for (let i = 0; i < vol.spriteWarpingPoints; i++) {
                for (let axis = 0; axis < 2; axis++) {
                    const entry = SPRITE_TRAJECTORY[br.peek(SPRITE_TRAJECTORY_BITS)];
                    if (!(entry & 31)) return 'damaged sprite trajectory';
                    br.skip(entry & 31);
                    const length = entry >> 5;
                    coding.trajectory[i * 2 + axis] = length ? br.readDifferential(length) : 0;
                    if (axis === 1 || !divx413) br.skip(1);
                }
            }

            if (vol.spriteBrightnessChange) return 'sprite brightness change is not supported';
        }

        coding.quant = br.read(vol.quantPrecision);
        coding.fcode = type !== VOP_I ? br.read(3) : 1;
        coding.bcode = type === VOP_B ? br.read(3) : 1;
        coding.longVectors = false;
        coding.modes = NO_H263_MODES;
        if (!coding.quant || !coding.fcode || !coding.bcode) return 'damaged VOP header';
        if (br.pos > br.end) return 'truncated VOP header';
        return true;
    }

    /**
     * Picks the vop_time_increment width, for encoders that write it wider than their VOL declares,
     * as the width after which marker_bit, vop_coded and a zero intra_dc_vlc_thr follow (with
     * vop_rounding_type between them in P- and GMC S-VOPs).
     */
    private guessIncrementBits(type: number, vol: VideoObjectLayer): void {
        const br = this.br;
        const rounding = type === VOP_P || (type === VOP_S && vol.spriteEnable === SPRITE_GMC);
        for (let bits = 1; bits < 16; bits++) {
            if (
                rounding ? (br.peek(bits + 6) & 0x37) === 0x30 : (br.peek(bits + 5) & 0x1f) === 0x18
            ) {
                if (bits !== this.incrementBits)
                    this.warnings.warn(`vop_time_increment is ${bits} bits wide, not as declared`);
                this.incrementBits = bits;
                this.configured = false;
                return;
            }
        }
    }

    /**
     * Tracks modulo_time_base and vop_time_increment in ticks of vop_time_increment_resolution,
     * deriving the anchor distance and B-VOP distances used by direct mode (ISO/IEC 14496-2
     * 7.6.9.5). Returns false for B-VOPs whose time does not fall between their references.
     */
    private updateTime(
        type: number,
        modulo: number,
        increment: number,
        vol: VideoObjectLayer,
    ): boolean {
        const coding = this.coding;
        if (type !== VOP_B) {
            this.lastTimeBase = this.timeBase;
            this.timeBase += modulo;
            const time = this.timeBase * vol.timeResolution + increment;
            this.ppTime = time - this.lastNonBTime;
            this.lastNonBTime = time;
            coding.ppTime = this.ppTime;
            return true;
        }

        const time = (this.lastTimeBase + modulo) * vol.timeResolution + increment;
        const pp = this.ppTime;
        const pb = pp - (this.lastNonBTime - time);
        if (pp <= pb || pp <= pp - pb || pp <= 0) return false;
        coding.ppTime = pp;
        coding.pbTime = pb;
        if (this.frameTime === 0) this.frameTime = pb || 1;
        const t = this.frameTime;
        const start = roundedDivide(this.lastNonBTime - pp, t);
        coding.ppFieldTime = (roundedDivide(this.lastNonBTime, t) - start) * 2;
        coding.pbFieldTime = (roundedDivide(time, t) - start) * 2;
        if (coding.ppFieldTime <= coding.pbFieldTime || coding.pbFieldTime <= 1) {
            coding.pbFieldTime = 2;
            coding.ppFieldTime = 4;
            if (vol.interlaced) return false;
        }

        return true;
    }

    /**
     * Decodes the VOP whose start code value sits at `offset`, ending at `end`. `later` lists the
     * start code offset and end of VOPs that follow in the same packet: an anchor followed by a
     * B-VOP (packed B-frames) takes the time of the packet after this one.
     */
    private decodeVopUnit(
        data: Uint8Array,
        offset: number,
        end: number,
        chunk: EncodedPacket,
        later: readonly number[],
        out: PlanarVideoFrame[],
    ): void {
        if (!this.vol) {
            if (!this.containerWidth || !this.containerHeight) {
                this.warnings.warn('Dropped a VOP before any video object layer');
                return;
            }

            // As ffmpeg does, a stream without layer headers is decoded with default ones at the
            // container's size.
            this.warnings.warn('No video object layer header; using default parameters');
            this.applyLayer(
                defaultVideoObjectLayer(this.containerWidth, this.containerHeight),
                out,
            );
        }
        const vol = this.vol!;
        this.configure(out);
        const br = this.br;
        br.load(data, offset + 1, Math.max(0, end - offset - 1));
        const header = this.readVopHeader(vol);
        const type = this.coding.type;
        let timestamp = chunk.timestamp;
        const duration = chunk.duration;
        if (type !== VOP_B && header === true && this.laterPackedB(data, later)) {
            timestamp = chunk.timestamp + chunk.duration;
            this.packedPending = true;
        }
        if (type === VOP_B && (!this.past || !this.future || this.needKeyframe)) {
            this.warnings.warn('Dropped a B-VOP without both references');
            return;
        }
        if (typeof header === 'string') {
            this.warnings.warn(`${header}; VOP ${type === VOP_B ? 'dropped' : 'concealed'}`);
            if (type !== VOP_B) this.concealAnchor(timestamp, duration, out);
            return;
        }
        if (!header) {
            this.notCoded(type, timestamp, duration, out);
            return;
        }
        if (type === VOP_B) this.decodeB(timestamp, duration, out);
        else this.decodeAnchor(type, timestamp, duration, out);
    }

    private laterPackedB(data: Uint8Array, later: readonly number[]): boolean {
        for (let i = 0; i < later.length; i += 2) {
            const offset = later[i];
            if (offset + 1 >= later[i + 1]) continue;
            if (data[offset + 1] >> 6 === VOP_B) return true;
        }
        return false;
    }

    private freePicture(): Picture {
        for (const picture of this.pictures) {
            if (picture !== this.past?.picture && picture !== this.future?.picture) return picture;
        }
        const picture = this.vop.newPicture();
        this.pictures.push(picture);
        return picture;
    }

    private decodeAnchor(
        type: number,
        timestamp: number,
        duration: number,
        out: PlanarVideoFrame[],
    ): void {
        let reference = this.future;

        // A stream that starts with a predicted picture (a file cut without its I-VOP) is decoded
        // against a blank picture as ffmpeg does: mid-grey, with black luma for H.263. After a
        // reset or damage, predicted pictures wait for the next I-VOP instead.
        if (type !== VOP_I && !reference && this.fresh) {
            const picture = this.freePicture();
            this.vop.concealPicture(picture, null, this.shortHeaderStream ? 16 : 128);
            reference = {
                picture,
                notCoded: false,
                timestamp,
                duration: 0,
                keyFrame: false,
                topFieldFirst: true,
            };

            // As the current reference, the grey picture is not reused as the picture decoded from
            // it.
            this.future = reference;
            this.needKeyframe = false;
            this.warnings.warn('First picture is predicted from a blank picture');
        }
        this.fresh = false;
        if (type !== VOP_I && (!reference || this.needKeyframe)) {
            if (!this.needKeyframe || this.warnings.count === 0)
                this.warnings.warn('P- or S-VOP without a reference; waiting for an I-VOP');
            this.needKeyframe = true;
            return;
        }
        this.releaseHeld(out);
        const picture = this.freePicture();
        const concealed = this.vop.decodeVop(
            this.br,
            this.coding,
            picture,
            reference?.picture ?? null,
            null,
            false,
        );
        if (concealed) this.warnings.warn(`${concealed} damaged macroblocks concealed`);
        if (type === VOP_I) this.needKeyframe = false;
        this.pushAnchor(
            {
                picture,
                notCoded: false,
                timestamp,
                duration,
                keyFrame: type === VOP_I,
                topFieldFirst: this.coding.topFieldFirst,
            },
            out,
        );
    }

    private pushAnchor(anchor: Anchor, out: PlanarVideoFrame[]): void {
        this.past = this.future;
        this.future = anchor;
        if (this.lowDelay) this.emit(anchor, out);
        else this.held = true;
    }

    private decodeB(timestamp: number, duration: number, out: PlanarVideoFrame[]): void {
        const past = this.past!;
        const future = this.future!;
        this.sawB = true;
        if (this.lowDelay) {
            this.warnings.warn('Dropped a B-VOP in a low-delay stream');
            this.lowDelay = false;
            return;
        }

        if (!this.held) {
            // Its later reference was already shown (output switched to reordering after it).
            this.warnings.warn('Dropped a B picture shown after its later reference');
            return;
        }

        this.bPicture ??= this.vop.newPicture();
        const concealed = this.vop.decodeVop(
            this.br,
            this.coding,
            this.bPicture,
            past.picture,
            future.picture,
            future.notCoded,
        );

        if (concealed) this.warnings.warn(`${concealed} damaged macroblocks concealed`);
        if (this.packedPending) future.timestamp = Math.max(future.timestamp, timestamp + duration);
        this.emit(
            {
                picture: this.bPicture,
                notCoded: false,
                timestamp,
                duration,
                keyFrame: false,
                topFieldFirst: this.coding.topFieldFirst,
            },
            out,
        );
    }

    /**
     * vop_coded = 0: fills the packed B-frame slot, repeats the last frame, or becomes a repeated
     * anchor.
     */
    private notCoded(
        type: number,
        timestamp: number,
        duration: number,
        out: PlanarVideoFrame[],
    ): void {
        const future = this.future;
        if (this.packedPending && this.held && future) {
            future.timestamp = timestamp;
            future.duration = duration;
            this.packedPending = false;
            return;
        }
        if (!future) return;
        if (!this.lowDelay && type !== VOP_B) {
            this.releaseHeld(out);
            this.pushAnchor(
                { ...future, notCoded: true, timestamp, duration, keyFrame: false },
                out,
            );
            return;
        }
        const repeated = this.lastOutput ?? future;
        this.emit({ ...repeated, timestamp, duration, keyFrame: false }, out);
    }

    /**
     * Replaces an undecodable anchor by a copy of the previous one so later VOPs keep their
     * references.
     */
    private concealAnchor(timestamp: number, duration: number, out: PlanarVideoFrame[]): void {
        const future = this.future;
        if (!future || this.needKeyframe) return;
        this.releaseHeld(out);
        const picture = this.freePicture();
        this.vop.concealPicture(picture, future.picture);
        this.pushAnchor(
            {
                picture,
                notCoded: false,
                timestamp,
                duration,
                keyFrame: false,
                topFieldFirst: future.topFieldFirst,
            },
            out,
        );
    }

    private releaseHeld(out: PlanarVideoFrame[]): void {
        if (this.held && this.future) this.emit(this.future, out);
        this.held = false;
    }

    private emit(anchor: Anchor, out: PlanarVideoFrame[]): void {
        this.lastOutput = anchor;
        const vop = this.vop;
        const width = vop.width;
        const height = vop.height;
        const parNum = this.shortHeader ? this.shortHeaderAspect[0] : this.vol!.parNum;
        const parDen = this.shortHeader ? this.shortHeaderAspect[1] : this.vol!.parDen;
        const interlaced = !this.shortHeader && this.vol!.interlaced;
        const chromaPlane = vop.chromaStride * vop.mbHeight * 8;
        out.push({
            format: 'I420',
            data: anchor.picture.data.slice(),
            layout: [
                { offset: 0, stride: vop.lumaStride },
                { offset: vop.chromaBase, stride: vop.chromaStride },
                { offset: vop.chromaBase + chromaPlane, stride: vop.chromaStride },
            ],
            codedWidth: vop.lumaStride,
            codedHeight: vop.mbHeight * 16,
            visibleRect: { x: 0, y: 0, width, height },
            displayWidth: parNum > parDen ? Math.round((width * parNum) / parDen) : width,
            displayHeight: parNum < parDen ? Math.round((height * parDen) / parNum) : height,
            timestamp: anchor.timestamp,
            duration: anchor.duration,
            keyFrame: anchor.keyFrame,
            colorSpace: colorSpaceOf(this.shortHeader ? undefined : this.signal, width, height),
            interlaced: interlaced
                ? anchor.topFieldFirst
                    ? 'top-field-first'
                    : 'bottom-field-first'
                : undefined,
        });
    }

    /**
     * Decodes a short header picture (ISO/IEC 14496-2 6.2.7, H.263 baseline): source format, coding
     * type, unrestricted vectors and quantiser from the header, then the GOB layer.
     */
    private decodeShortHeaderPicture(
        data: Uint8Array,
        chunk: EncodedPacket,
        out: PlanarVideoFrame[],
    ): void {
        const br = this.br;
        let offset = 0;
        while (offset + 3 < data.length && !isShortHeaderStart(data, offset)) offset++;
        br.load(data, offset, data.length - offset);
        br.skip(22);
        const temporalReference = br.read(8);
        if (!br.read1() || br.read1()) {
            this.warnings.warn('Dropped a damaged short header picture');
            return;
        }
        br.skip(3);
        const format = br.read(3);
        let header: ShortHeaderPicture | undefined;
        if (format === 7) header = this.readPlusType();
        else if (format === 0 || format >= SHORT_HEADER_FORMATS.length)
            this.warnings.warn('Dropped a picture in an unsupported source format');
        else {
            const type = br.read1() ? VOP_P : VOP_I;
            const longVectors = br.read1() === 1;
            if (br.read1())
                this.warnings.warn('H.263 arithmetic coding is not supported; picture dropped');
            else {
                const advancedPrediction = br.read1() === 1;
                const pbFrames = br.read1() && type === VOP_P ? 1 : 0;
                const quant = br.read(5);
                if (br.read1()) br.skip(2);

                // TRB and DBQUANT of the B picture, which is not shown (as in ffmpeg).
                if (pbFrames) br.skip(5);
                const [width, height] = SHORT_HEADER_FORMATS[format];
                const modes =
                    pbFrames || advancedPrediction
                        ? { ...NO_H263_MODES, pbFrames, advancedPrediction }
                        : NO_H263_MODES;
                header = {
                    type,
                    width,
                    height,
                    aspect: [12, 11],
                    quant,
                    longVectors,
                    modes,
                    rounding: 0,
                };
            }
        }
        if (!header) return;
        while (br.read1()) {
            br.skip(8);
            if (br.pos > br.end) break;
        }
        const { type, width, height, quant, longVectors } = header;

        // Direct mode in B pictures scales by the temporal reference distances TRB and TRD.
        const time = (this.pictureNumber & ~0xff) + temporalReference;
        this.pictureNumber =
            time - ((temporalReference - (this.pictureNumber & 0xff) + 128) & ~0xff);
        if (type !== VOP_B) {
            this.ppTime = this.pictureNumber - this.lastNonBTime;
            this.lastNonBTime = this.pictureNumber;
        }
        this.shortHeaderAspect = header.aspect;
        if (
            !this.shortHeader ||
            this.shortHeader.width !== width ||
            this.shortHeader.height !== height
        ) {
            if (this.shortHeader) {
                this.releaseHeld(out);
                this.reset();
                this.pictures = [];
                this.bPicture = undefined;
            }

            // Short header pictures use the tools of the default layer: rectangular, H.263
            // quantisation, no sprites.
            this.shortHeader = { ...defaultVideoObjectLayer(width, height), shortHeader: true };
            this.lowDelay = true;
        }
        this.vop.configure(this.shortHeader, NO_SHORT_HEADER_WORKAROUNDS);
        const coding = this.coding;
        coding.type = type;
        coding.quant = quant;
        coding.fcode = 1;
        coding.bcode = 1;
        coding.rounding = header.rounding;
        coding.intraDcThreshold = 0;
        coding.topFieldFirst = true;
        coding.alternateScan = false;
        coding.longVectors = longVectors;
        coding.modes = header.modes;
        if (type === VOP_B) {
            if (!quant || !this.past || !this.future || this.needKeyframe) {
                this.warnings.warn(
                    quant
                        ? 'Dropped a B picture without both references'
                        : 'Dropped a damaged B picture',
                );
                return;
            }
            let pb = this.ppTime - (this.lastNonBTime - this.pictureNumber);

            // As in ffmpeg, distances that do not place the picture between its references count as
            // halfway.
            if (this.ppTime <= pb || pb <= 0) {
                this.ppTime = 2;
                pb = 1;
            }
            coding.ppTime = this.ppTime;
            coding.pbTime = pb;
            this.decodeB(chunk.timestamp, chunk.duration, out);
            return;
        }
        if (!quant) {
            this.warnings.warn('Concealed a damaged short header picture');
            if (type !== VOP_I) this.concealAnchor(chunk.timestamp, chunk.duration, out);
            return;
        }
        this.decodeAnchor(type, chunk.timestamp, chunk.duration, out);
    }

    /**
     * The PLUSPTYPE header of an H.263+ picture (ITU-T H.263 5.1.4 to 5.1.20), after the source
     * format code 7: the optional modes, the picture type and rounding, a custom picture format
     * with its pixel aspect and clock, and the quantiser. Arithmetic coding, reference picture
     * selection, independent segments, scalability (EI and EP) and resampled pictures drop the
     * picture. B pictures (Annex O) carry ELNUM and, with UFEP 1, RLNUM; as in ffmpeg, those are
     * read only with UFEP 1 (the standard also has ELNUM when UFEP is 0, and in the other pictures
     * of a stream using Annex O, which the bitstream does not signal).
     */
    private readPlusType(): ShortHeaderPicture | undefined {
        const br = this.br;
        const ufep = br.read(3);
        let plus = this.plusType;
        let format = 0;
        if (ufep === 1) {
            format = br.read(3);
            const flags = br.read(11);
            br.skip(4);
            const flag = (bit: number): boolean => ((flags >> (10 - bit)) & 1) === 1;
            const unsupported = PLUS_UNSUPPORTED.filter(([bit]) => flag(bit)).map(
                ([, name]) => name,
            );
            if (unsupported.length) {
                this.warnings.warn(
                    `H.263+ ${unsupported.join(', ')} is not supported; picture dropped`,
                );
                this.plusType = undefined;
                return undefined;
            }
            plus = {
                width: 0,
                height: 0,
                aspect: [12, 11],
                customClock: flag(0),
                modes: {
                    unlimitedVectors: flag(1),
                    advancedIntra: flag(4),
                    advancedPrediction: flag(3),
                    deblocking: flag(5),
                    slices: flag(6),
                    alternativeInterVlc: flag(9),
                    modifiedQuant: flag(10),
                    pbFrames: 0,
                },
            };
        } else if (ufep !== 0 || !plus) {
            this.warnings.warn('Dropped an H.263+ picture without its full picture type');
            return undefined;
        }
        const pictureType = br.read(3);
        const resampling = br.read(2);
        const rounding = br.read1();
        br.skip(3);
        if (br.read1()) br.skip(2);
        if ((pictureType > 3 && pictureType !== 7) || resampling) {
            this.warnings.warn('Dropped an H.263+ scalable or resampled picture');
            return undefined;
        }
        if (ufep === 1) {
            let width: number;
            let height: number;
            let aspect: readonly [number, number] = [12, 11];
            if (format === 6) {
                const code = br.read(4);
                width = (br.read(9) + 1) * 4;
                br.skip(1);
                height = br.read(9) * 4;
                aspect =
                    code === 15
                        ? [br.read(8) || 1, br.read(8) || 1]
                        : (PLUS_ASPECT[code] ?? [12, 11]);
            } else if (format > 0 && format < SHORT_HEADER_FORMATS.length)
                [width, height] = SHORT_HEADER_FORMATS[format];
            else {
                this.warnings.warn('Dropped a picture in an unsupported source format');
                return undefined;
            }
            if (!width || !height) {
                this.warnings.warn('Dropped a damaged short header picture');
                return undefined;
            }
            if (plus!.customClock) br.skip(8);
            plus = { ...plus!, width, height, aspect };
            this.plusType = plus;
        }
        const { customClock, modes } = plus!;
        if (customClock) br.skip(2);
        if (ufep === 1) {
            // Unlimited Unrestricted Motion Vectors Indicator: '1', or '01' for the limited range
            // of Table D.1.
            if (modes.unlimitedVectors && !br.read1()) br.skip(1);
            if (modes.slices && br.read(2)) {
                this.warnings.warn(
                    'Dropped an H.263+ picture with rectangular or arbitrary slices',
                );
                return undefined;
            }

            // ELNUM and RLNUM.
            if (pictureType === 3) br.skip(8);
        }
        const quant = br.read(5);

        // Improved PB-frames (Annex M): TRB, extended with the custom clock, and DBQUANT of the
        // hidden B picture.
        if (pictureType === 2) br.skip(customClock ? 7 : 5);
        return {
            type:
                pictureType === 3 ? VOP_B : pictureType === 1 || pictureType === 2 ? VOP_P : VOP_I,
            width: plus!.width,
            height: plus!.height,
            aspect: plus!.aspect,
            quant,
            longVectors: false,
            modes: pictureType === 2 ? { ...modes, pbFrames: 3 } : modes,
            rounding: pictureType === 1 || pictureType === 2 ? rounding : 0,
        };
    }
}

/** The OPPTYPE an H.263+ picture states with UFEP 1 and later pictures keep (ITU-T H.263 5.1.4). */
interface PlusType {
    readonly width: number;
    readonly height: number;
    readonly aspect: readonly [number, number];
    readonly customClock: boolean;
    readonly modes: H263Modes;
}

/**
 * What a short header (H.263 baseline or H.263+) picture header states for the macroblock layer.
 */
interface ShortHeaderPicture {
    readonly type: number;
    readonly width: number;
    readonly height: number;
    readonly aspect: readonly [number, number];
    readonly quant: number;
    readonly longVectors: boolean;
    readonly modes: H263Modes;
    readonly rounding: number;
}

/**
 * Pixel aspect ratio codes of an H.263+ custom picture format (Table 6): 1:1, 12:11, 10:11, 16:11
 * and 40:33.
 */
const PLUS_ASPECT: readonly (readonly [number, number])[] = [
    [12, 11],
    [1, 1],
    [12, 11],
    [10, 11],
    [16, 11],
    [40, 33],
];

/**
 * OPPTYPE flags after the source format (bit 0 is the custom clock) of modes the decoder does not
 * implement.
 */
const PLUS_UNSUPPORTED: readonly (readonly [number, string])[] = [
    [2, 'arithmetic coding'],
    [7, 'reference picture selection'],
    [8, 'independent segments'],
];

const NO_SHORT_HEADER_WORKAROUNDS: Workarounds = workaroundsFor(unknownEncoder());

/**
 * MPEG-4 Part 2 (Visual) Simple and Advanced Simple profile decoder, including H.263 baseline short
 * headers.
 */
export const mpeg4VideoCodec: BuiltinVideoCodec = {
    id: 'mpeg4-part2',
    supports: isMpeg4VisualCodec,
    create: config => new Mpeg4VideoDecoder(config),
};
