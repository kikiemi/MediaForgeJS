import { DecodeError } from '../../core/errors/errors';
import {
    BC,
    BL,
    BR,
    FC,
    FL,
    FLC,
    FR,
    FRC,
    LFE,
    LFE2,
    LSD,
    LW,
    RSD,
    RW,
    SL,
    SR,
    TBL,
    TBR,
    TC,
    TFC,
    TFL,
    TFR,
    maskSpeakers,
    speakerFold,
} from '../../core/model/channel-layout';
import type { AudioDecoderWarning } from '../../core/contracts/decoder';
import { FrameBits } from './bits';
import { readFrameHeader, type FrameHeader } from './header';
import { SubstreamDecoder } from './substream';

/**
 * AC-3 and E-AC-3 decoding of whole packets into the WAVE speaker order of the planes asked for.
 * An access unit is an independent frame (AC-3, or E-AC-3 substream 0) and the dependent E-AC-3
 * frames after it, whose channels replace or add speakers by their channel map (a 5.1 core and a
 * dependent substream make 7.1); other independent substreams (other programs) are skipped, as in
 * ffmpeg. Dynamic range compression applies as the stream states it (ffmpeg's default). A frame
 * whose speakers the output lacks (a broadcast switching from 2.0 to 5.1) is folded into it with
 * ffmpeg's default remix weights and one AUDIO_FORMAT_CHANGED warning.
 */

/** Speakers of the full-bandwidth channels of each acmod, in the stream's channel order. */
const ACMOD_SPEAKERS: readonly (readonly number[])[] = [
    [FL, FR],
    [FC],
    [FL, FR],
    [FL, FC, FR],
    [FL, FR, BC],
    [FL, FC, FR, BC],
    [FL, FR, SL, SR],
    [FL, FC, FR, SL, SR],
];

/**
 * Speakers of the E-AC-3 channel map locations 0 to 15 (E.1.3.1.8): L, C, R, Ls, Rs, Lc/Rc,
 * Lrs/Rrs, Cs, Ts, Lsd/Rsd, Lw/Rw, Vhl/Vhr, Vhc, Lts/Rts, LFE2 and LFE.
 */
const LOCATION_SPEAKERS: readonly (readonly number[])[] = [
    [FL],
    [FC],
    [FR],
    [SL],
    [SR],
    [FLC, FRC],
    [BL, BR],
    [BC],
    [TC],
    [LSD, RSD],
    [LW, RW],
    [TFL, TFR],
    [TFC],
    [TBL, TBR],
    [LFE2],
    [LFE],
];

/** A frame's channels by speaker as the access unit assembles them. */
interface Assembly {
    readonly samples: number;
    readonly channels: Map<number, Float32Array>;
}

export class Ac3Decoder {
    private readonly independent = new SubstreamDecoder();
    /** One decoder per dependent substream of the access unit, in order. */
    private readonly dependents: SubstreamDecoder[] = [];
    private readonly mask: number;
    private folded = false;

    /**
     * `speakers`: the WAVE speaker bits of the output planes, in order; `sampleRate` the rate every
     * frame must have.
     */
    constructor(
        private readonly speakers: readonly number[],
        private readonly sampleRate: number,
        private readonly warn?: AudioDecoderWarning,
    ) {
        this.mask = speakers.reduce((mask, bit) => mask | bit, 0);
    }

    /** The planes of every access unit in `packet`; bytes before a sync word are skipped. */
    *decode(packet: Uint8Array): Iterable<Float32Array[]> {
        let assembly: Assembly | undefined;
        let dependent = 0;
        let frames = 0;
        for (let offset = 0; offset + 7 <= packet.length;) {
            if (packet[offset] !== 0x0b || packet[offset + 1] !== 0x77) {
                offset++;
                continue;
            }

            const bits = new FrameBits(packet, offset, packet.length);
            const header = readFrameHeader(bits, packet.length - offset);
            const frameBits = new FrameBits(packet, offset, offset + header.frameBytes);
            frameBits.position = bits.position;
            offset += header.frameBytes;
            frames++;
            if (header.substreamId !== 0) continue;
            if (header.sampleRate !== this.sampleRate)
                throw new DecodeError(
                    `AC-3 frame at ${header.sampleRate} Hz in a ${this.sampleRate} Hz track`,
                );
            if (header.frameType !== 1) {
                if (assembly) yield this.output(assembly);
                assembly = { samples: header.blocks * 256, channels: new Map() };
                dependent = 0;
                this.addChannels(assembly, this.independent, header, frameBits, false);
            } else if (assembly) {
                if (header.blocks * 256 !== assembly.samples)
                    throw new DecodeError('E-AC-3 dependent frame differs in length');
                const decoder = (this.dependents[dependent++] ??= new SubstreamDecoder());
                this.addChannels(assembly, decoder, header, frameBits, true);
            }
        }

        if (assembly) yield this.output(assembly);
        if (!frames) throw new DecodeError('AC-3 packet holds no sync frame');
    }

    /** Decodes a frame's blocks and adds its channels to the access unit by speaker. */
    private addChannels(
        assembly: Assembly,
        decoder: SubstreamDecoder,
        header: FrameHeader,
        bits: FrameBits,
        dependent: boolean,
    ): void {
        const planes = Array.from(
            { length: header.fbw + (header.lfe ? 1 : 0) },
            () => new Float32Array(assembly.samples),
        );
        decoder.begin(header, bits);
        for (let block = 0; block < header.blocks; block++)
            decoder.decodeBlock(block, planes, block * 256);
        const speakers =
            dependent && header.channelMap !== undefined
                ? mappedSpeakers(header)
                : [...ACMOD_SPEAKERS[header.acmod]!, ...(header.lfe ? [LFE] : [])];
        speakers.forEach((speaker, channel) => assembly.channels.set(speaker, planes[channel]!));
    }

    /** The output planes of an access unit: its speakers, the others folded in. */
    private output(assembly: Assembly): Float32Array[] {
        const planes = this.speakers.map(
            speaker => assembly.channels.get(speaker) ?? new Float32Array(assembly.samples),
        );
        for (const [speaker, source] of assembly.channels)
            if (!(this.mask & speaker)) this.fold(speaker, source, planes);
        return planes;
    }

    /** Mixes a channel the output lacks into the speakers it folds to. */
    private fold(speaker: number, source: Float32Array, planes: Float32Array[]): void {
        if (!this.folded) {
            this.folded = true;
            this.warn?.(
                'AUDIO_FORMAT_CHANGED',
                `AC-3 frames have extra channels, mixed into the track's ${this.speakers.length}`,
            );
        }
        const [targets, weight] = speakerFold(speaker, this.mask) ?? [0, 0];
        for (const target of maskSpeakers(targets)) {
            const plane = planes[this.speakers.indexOf(target)]!;
            for (let index = 0; index < plane.length; index++)
                plane[index] = plane[index]! + source[index]! * weight;
        }
    }

    reset(): void {
        this.independent.reset();
        for (const decoder of this.dependents) decoder.reset();
    }
}

/**
 * The speakers of a dependent frame's coded channels from its channel map: the locations in
 * order, two speakers for a pair, taken by the coded channels in order (the LFE last), as ffmpeg
 * assigns them.
 */
function mappedSpeakers(header: FrameHeader): number[] {
    const located: number[] = [];
    for (let location = 0; location < 16; location++)
        if (header.channelMap! & (0x8000 >> location))
            located.push(...LOCATION_SPEAKERS[location]!);
    return Array.from({ length: header.fbw + (header.lfe ? 1 : 0) }, (_, at) => located[at] ?? 0);
}
